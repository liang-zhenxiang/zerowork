# shared（跨进程共享契约）编码规范

> `src/shared/` —— 体量小、被依赖广、**契约价值最高**的一层。
> 目前只有一个文件 `ipc.js`（约 530 行），但它是主进程与 preload 的**共同事实来源**。

---

## 一、这一层放什么

**只放跨进程的契约**：通道常量、文档类型判定这类「两边必须理解一致」的东西。

- `INVOKE` —— 渲染层 → 主进程/daemon 的请求通道
- `PUSH` —— daemon → 渲染层的推送通道
- `docKindOf()` / `extensionOf()` —— 文档类型判定（PDF / Office / 旧格式）
- `DEFAULT_GLOBAL_SHORTCUT` —— 全局快捷键默认值

**不放业务逻辑。** 任何只有一侧需要的东西都不属于这一层。

---

## 二、为什么这一层值得优先投入

1. **改动的影响面最大**：一个通道常量改错，主进程、preload、daemon、渲染层**四处**同时失效
2. **它是类型补全的起点**：`docs/ARCHITECTURE.md` 的「渐进补类型」路径把这一层列为第一步
   （体量小、被依赖广、契约价值最高）
3. **它是跨层 bug 的高发区** —— 见 `../guides/cross-layer-thinking-guide.md`

---

## 三、硬约束

### 通道常量的改动必须四处同步

一个通道的生命周期涉及四个位置：

| 位置 | 做什么 |
| --- | --- |
| `src/shared/ipc.js` | 定义常量（**唯一的字符串字面量来源**） |
| `src/preload/index.js` | 通过 contextBridge 暴露给渲染层 |
| `src/main/index.js` | `registerIpc()` 里路由 |
| 消费方（daemon / renderer） | 使用 |

**任何一处用了裸字符串而不是常量引用，都是一颗定时炸弹** —— 改名时不会报错，只会静默失效。

### 补类型的路径

从本层开始：补完一个目录，就把对应路径从 `tsconfig.json` 的 `exclude` 里移出。
工具函数与纯逻辑优先（易验证），React 组件次之。

> **现状是 `checkJs` 关闭**，原因见 `docs/ARCHITECTURE.md`：
> 直接开启会产出数以万计的 `noImplicitAny`，那些报错反映「类型还没补」而非「代码有问题」。
> **这个限制无法绕过** —— 编译期类型信息没有随代码保留下来，只能靠人补。

---

## 四、禁止事项

- **不放只有一侧需要的东西**（那属于那一侧的目录）
- **不在本层引入运行时依赖**：它被主进程与 preload 同时打包，
  引入依赖会让两侧的包都变大
- **不删除 `$1` `$2` 这类变量名后缀**（`AGENTS.md` 红线 7）

---

## 相关

- `docs/ARCHITECTURE.md` —— 「一条消息的生命周期」展示了通道的实际流转
- `.trellis/spec/main/index.md`、`.trellis/spec/renderer/index.md`
