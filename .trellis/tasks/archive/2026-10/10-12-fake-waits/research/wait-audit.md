# 全仓等待谓词审计（#150）

## 方法：机械判定 + 人工核实判不了的那些

「逐个读调用点」我用 AST 判定器做的（`tools/check-wait-predicates.mjs`，本轮新增）：
对每个 `waitUntil(...)` 取谓词，收集**所有**返回路径，问「有没有任何一条**可能**交出假值」。
一条都没有 → 假等待。

- 常量真值（对象/数组字面量、`true`、非空字符串、非零数字……）→ 算「不可能为假」
- 比较、`!x`、成员访问、变量、函数调用、条件/逻辑表达式的一侧 → 算「可能为假」
- `win.evaluate(cb)` → 钻进回调再算一遍（最常见的写法）
- **判不出来的一律不报**，列成「需人工确认」，由人打开看

为什么先机械判定再人工核实：这个形态的关键不是「读没读过」，而是「未就绪时返回什么」——
而这件事在 247 个调用点里靠肉眼扫，正是过去三次漏掉它的原因。判定器把「所有返回路径」摆出来后，
人只需要看**它判不了的那几条**。

## 结果

```
$ npm run check:wait-predicates
  ✓ 247 个 waitUntil 调用点：没有「每一条返回路径都是常量真值」的谓词
```

（判定器落地时的第一轮输出是：247 个调用点、**1 处假等待**、5 处「需人工确认」。
5 处是同一个形态：谓词写成**具名引用**，判定器当时解析不了 —— 补上「顶层 `const 名字 = 函数`」
的解析之后归零。那 5 处逐个核实过，见下表。）

### 人工核实：判不了的 5 处（都不是假等待）

| 位置 | 谓词 | 指向的定义 | 未就绪时返回 |
| --- | --- | --- | --- |
| `tests/e2e/command-palette.mjs:83` | `paletteOpen` | `() => win.evaluate(() => document.querySelector(".command-palette") !== null)` | `false` |
| `tests/e2e/compare-keep.mjs:175` | `compareViewMounted` | `() => win.evaluate(() => document.querySelector(".compare-grid") !== null)` | `false` |
| `tests/e2e/modal-backdrop.mjs:129` | `paletteOpen` | 同上 | `false` |
| `tests/e2e/multi-model-compare.mjs:284` | `compareViewMounted` | 同上 | `false` |
| `tests/e2e/palette-memory.mjs:106` | `paletteOpen` | 同上 | `false` |

五处都是布尔比较 —— **一处都不动**（Issue 明确警告过：不要因为机械替换把好写法改坏）。

### 真阳性：1 处（Issue 点名的那个）

`tests/e2e/gui-space-pin.mjs:94`（原第 96 行的 `return { found: false, count }`）：

```js
// ✗ 未就绪时返回对象 → 恒真 → 30 秒超时一次都没参与
const r = await waitUntil(
  async () => await win.evaluate(() => {
    const headers = [...document.querySelectorAll(".space-group-header")];
    if (headers.length < 2) return { found: false, count: headers.length };
    return { found: true, ... };
  }),
  { timeout: 30_000, interval: 500, desc: "空间区出现两组" },
);
assert.ok(r.found, `空间区组数不足：${r.count}`);
```

改成：未就绪返回 `null`（继续轮询），就绪才交出对象；闸门字段 `ready` 与断言载荷分开命名；
`catch` 里把「等的时候到底探到几组」补进超时信息（**修等待不能把失败现场弄丢**）。

## 反向验证（三份证据，都是真跑）

### ① 两种谓词形态的语义（确定性实验，与具体用例无关）

同一台机器、同一个「永远不到来的元素」：

```
旧形态：{"found":false} —— 耗时 8ms（timeout=3000 完全没参与）
新形态：等待超时 3000ms：永不到来的元素 —— 耗时 3056ms（真的等了）
```

### ② 断言没有被削弱：把应用侧弄坏，它照旧红

临时改掉 `src/renderer/src/app.js` 里「当前空间」那段（不再加 `space-group-current`）后重跑：

```
[FAIL] 当前工作空间（项目B）置顶且带「当前」徽标
  —— 第一组没有 space-group-current（置顶的应是当前空间，读到 项目B）
通过 3/4
```

红的是**原来那条断言、文案一字未变** —— 等待改了，断言没有变松。

### ③ 门禁自己也有门禁

`tests/unit/wait-predicates.test.mjs`（14 条）钉住判定器的两个方向：真阳性（5 种形态）与
**不误报**（就绪才交出对象、布尔比较、成员访问、嵌套函数里的 return、具名 helper），
以及「判不出来时如实说判不了」。

## 判定器的盲区（诚实记录）

| 盲区 | 后果 |
| --- | --- |
| 判不出来的一律不报（导入的标识符、没有任何 `return`） | 输出里列成「需人工确认」；绿 ≠ 它们没问题 |
| 只认「常量真值」 | **真等待但预算不够**不在此列 |
| 静态判不了太绕的数据流 | 常见形态（if / 块 / 循环 / try / switch）已覆盖，绕几圈可能漏判 |

这三条同时写进了 `.trellis/spec/testing/index.md` §三.1 —— 免得后人以为门禁绿了就万事大吉。

## 不同族的一类（记录，不处理）

2026-10-09 PR #171 的 `compare-keep` ⑨/⑩：谓词是对的，报的是「等待超时 15000ms」——
CI 抖动时 15 秒不够。**本轮不顺手放宽任何 `timeout`**：放宽必须有证据，
而「偶尔红一次、重跑就绿」还不构成证据。正确方向是把就绪条件换强（等 mock 收到请求、
等列进终态），已在 Issue 里作为第 2 类单列。

## 附：判定器的适用范围

扫 `tests/e2e/**/*.mjs` 与 `tools/**/*.mjs`（两处都 import 同一个 harness 的 `waitUntil`），
文件清单来自 `git ls-files`（与 `check-line-endings.mjs` / `check-unicode.mjs` 同口径，
不会被 `out/` 之类的构建产物干扰）。
