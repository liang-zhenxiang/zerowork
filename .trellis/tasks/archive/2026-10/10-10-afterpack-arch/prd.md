# afterPack 的 @esbuild 裁剪对 x64 目标静默失效（#183）

## 背景：守卫只在「蒙对的那一半」有效

做 #168 的真打包验证时（`npm run dist:dir`，目标 darwin/**x64**），afterPack 打出：

```
[afterPack] 未知的平台组合 darwin/ia32：@esbuild 全部保留（请补 ESBUILD_PLATFORM 表）
```

目标是 x64，却被认成了 ia32，落进了「未知平台组合」的兜底分支。

## 根因

`scripts/after-pack.cjs` 手抄了一份 arch 数字映射，注释里写着自己的来源：

```js
// context.arch 是 electron-builder 的 Arch 枚举（数字：ia32=1、x64=2、arm64=3）
const archNumber = { 1: 'ia32', 2: 'x64', 3: 'arm64' };
```

而装着的 `builder-util`（electron-builder 26.17.0 的依赖）
`node_modules/builder-util/out/arch.js` 里是：

```js
Arch[Arch["ia32"] = 0] = "ia32";
Arch[Arch["x64"] = 1] = "x64";
Arch[Arch["armv7l"] = 2] = "armv7l";
Arch[Arch["arm64"] = 3] = "arm64";
Arch[Arch["universal"] = 4] = "universal";
```

**整份映射差一位。** 结果：

| 实际目标 | `context.arch` | 映射得到 | 后果 |
| --- | --- | --- | --- |
| ia32 | 0 | `"0"` | 兜底：全留 |
| **x64** | **1** | **`"ia32"`** | **兜底：全留** |
| armv7l | 2 | `"x64"` | 兜底：全留 |
| arm64 | 3 | `"arm64"` | **恰好蒙对** |

受影响的是 `darwin-x64`（Intel Mac 包）、`win32-x64`、`linux-x64` —— 最常打的几个；
`arm64` 反而一直正常。**「一半对一半错」是这类缺陷最难被发现的地方。**

## 为什么体积检查没报警

本机 `npm` 只装了 `@esbuild/darwin-x64`（optionalDependencies 按平台过滤），产物里
只有这一个目录，**没东西可删**，所以除了那条警告看不出后果。裁剪真正起作用是在依赖树里
存在多个平台目录时 —— `after-pack.cjs` 的注释里记的「实测多出 262 MB」就是那种情况。

也就是说：**这条守卫声称守全部平台，实际只在 arm64 上有效。**

## 期望

- [x] 修正 arch 映射，并把「为什么是这几个数字」写清楚（来源是 builder-util 的 `Arch` 枚举）
- [x] 加一条单测**对着装着的 `builder-util` 反查**：本地映射与上游枚举不一致就红 ——
      这样上游改枚举时是 CI 红，而不是又一次静默失效
- [x] 把映射抽成**纯函数**（`esbuildDirFor(platform, arch)`）与**可测的裁剪函数**
      （`trimEsbuildDir(dir, keep)`），不再只能靠真打包才发现
- [x] **反向验证**：造一个含多个 `@esbuild/<platform>` 目录的夹具，断言裁剪真的删到只剩目标那一个
      —— 现在的环境（只有一个目录）无法证伪，这正是它藏了这么久的原因
- [x] 顺手清掉**不可达条目**：`linux.arm` 应是 `linux.armv7l`（枚举名），
      `linux.ppc64` / `linux.riscv64` 根本不是 `Arch` 的枚举值、`context.arch` 永远取不到

## 设计决策

**为什么不在运行时 `require('builder-util')` 反查枚举。**
它确实是单一事实源，但 `builder-util` 是 electron-builder 的**传递依赖**：一旦 npm 的
提升方式变化，`require` 就会失败 —— 而这条路径只在打包时执行，等于把守卫换成另一个
可能静默崩掉的依赖。更稳的组合是「本地显式映射（零依赖）+ 单测对着装着的枚举反查」：
上游漂移时**由测试报警**，而不是由打包失败或静默失效报警。

**为什么把「全删」写成 `null` 而不是 `undefined`。**
（**实现时改掉了这条设计**，见下。）

**实现时改了主意：不给「全删」加第三种状态，而是删掉不可达条目。**
prd 初稿的设想是保留 `linux.riscv64` 并把它的 `undefined` 改成 `null`，好让
「明确全删」有一条显式的表达。写测试时看清了两件事：

1. `ppc64` / `riscv64` **不在 `Arch` 枚举里**，`context.arch` 永远取不到它们 ——
   这是**不可达配置**，不是「未来可能用到」。而正是这类条目制造了「已经考虑过」的错觉
   （本次缺陷的同源问题）。
2. 没有任何平台需要「一个都不留」。为它引入一个 `null` 分支，等于养一段**没有调用方
   的代码**，还要为它写测试。

所以最终做法是：表键与 `Arch` 枚举名**严格一一对应**（`armv7l` 而不是 `arm`），
不可达条目直接删；状态回到两态（字符串 = 保留它 / `undefined` = 表里没有 → 保守全留）。
单测里那条「枚举里的值一个都不能漏、表里不能有枚举之外的名」把这条纪律钉住了 ——
其中 `arm` vs `armv7l` 就是测试当场抓出来的**第二处**同类问题。

## 不做

- 不动 `ESBUILD_PLATFORM` 的平台集合（darwin 只有 x64/arm64 是事实，esbuild 也没有别的）
- 不改 ad-hoc 签名那一段（与本 Issue 无关）
- 不把 `builder-util` 提升成直接依赖（见上面的设计决策）

## 难度

改映射是**低**；难的是**证明它真的会删** —— 本机只有 native 平台那一个目录，
必须造夹具。夹具同时把「`null` = 全删」这条语义也钉住了。
