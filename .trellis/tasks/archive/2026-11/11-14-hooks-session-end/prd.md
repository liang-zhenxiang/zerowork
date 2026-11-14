# PRD：hooks SessionEnd（会话收尾事件与退出预算）

- Issue：#386（v0.23.0）
- 分支：`feat/hooks-session-end`
- 日期：2026-11-14
- 前序：#373 / PR #377（生命周期事件）、#387 / PR #388（导入导出）

## 背景

hooks 现在覆盖「会话开始 / 每条消息 / 一轮结束」，但没有**会话收尾**：

- 关掉应用、切换会话、删除会话时，没有确定性的清理点（停本地服务、删临时文件、flush 日志）；
- `Stop` 是「一轮结束」，同一会话里会触发很多次，语义上不等于「会话结束」；
- 用户级 hook 想做退出前归档，只能靠猜时机。

pi 的 `session_shutdown` 正好是这个语义点（`reason: quit / reload / new / resume / fork`），
但它只由 pi 自己的 runtime 层在 dispose 前发出 —— daemon 直嵌 SDK，需要自己补发射点
（与 `session_start` 缺 `bindExtensions()` 同一类缺口）。

难点不在事件，而在**关闭路径的等待预算**：hook 是子进程，等太久会把退出拖住。

## 需求

### 事件

- 新增 `SessionEnd` → `session_shutdown`，载荷带 `reason`
- **不可阻断**：任何结果都不改变关闭行为，只写 `hook` 审计（`allowed` / `failed`）
- 关闭路径的**总等待预算 ≤ 2s**：逐条 hook 用「剩余预算」作超时；预算耗尽后不再启动新 hook，
  记一条 `failed`（detail 写明「超出关闭等待预算」），不重试
- 正常事件（SessionStart / UserPromptSubmit / Stop）仍沿用 1–30s 的单条超时

### 发射点（reason 映射）

| 路径 | reason |
| --- | --- |
| 应用退出（daemon 统一收尾） | `quit` |
| 删除会话 / 自动会话结束 / 子代理与团队成员关闭 | `quit` |
| 会话重启 / 分支切换（重建宿主） | `resume` |

- 多个会话同时收尾时**并行**执行，避免「会话数 × 2s」累积
- `SessionHost.dispose()` 保持**立即释放**的语义不变；新增 `shutdown(reason)`：
  先发 `session_shutdown`（带预算），再 dispose。只有需要收尾的调用点改用它

### 应用退出

- `before-quit` 改为**可等待**：先请 daemon 收尾（2s），最多再等 2.5s，然后 kill daemon 并真正退出
- daemon 未运行 / 已退出时立即继续，不阻塞退出
- 退出过程只做一次（防重入）

### 压缩路径

- **不做** `session_before_compact`：它可取消压缩、可改写摘要，属于能改变会话结果的通道；
  与「非阻断事件只观测」的原则冲突，且压缩是高频路径。理由写进 design 与 spec

### UI 与文档

- 设置页事件下拉新增 `会话结束（SessionEnd）`；说明「退出时最多等 2 秒」
- 试运行按事件生成示例载荷（`reason: "quit"`）
- `SECURITY.md` 补：关闭路径的预算、退出流程、SessionEnd 与 Stop 的区别
- `.trellis/spec/daemon/index.md` §七 补一条「收尾事件在退出路径上」
- `CHANGELOG.md` 记「新增」

## 验收

- [ ] `SessionEnd` 在会话切换 / 删除 / 应用退出时各触发一次，载荷 `reason` 正确
- [ ] 总等待 ≤2s：一条 hook 的配置超时是 30s，也不会把退出拖过 2s
- [ ] 预算耗尽后的剩余 hook 不启动，审计里能看到「超出预算」
- [ ] 任一 hook 失败 / 超时都不改变关闭行为
- [ ] 主会话 / 自动会话 / 子代理三处装配点一致
- [ ] 单测（预算分配 / 耗尽跳过 / 不阻断）、集成（真实退出后日志有行）、GUI（下拉 + 截图）
- [ ] `lint:all`、`npm test`、`npm run test:gui`（相关套件 + CI 全量）通过
- [ ] `SECURITY.md` 与 spec 更新；CHANGELOG 记「新增」

## 不在本轮

- `session_before_compact` / `session_compact`（见上）
- 退出时的 UI 提示（「正在收尾…」）—— 预算是 2s，先不引入新的退出态
- hook 之间的依赖 / 顺序保证之外的编排

## 硬约束

- 收尾事件**永远不能**改变关闭结果；超时杀进程组，不留孤儿
- 退出路径不能被 hooks 卡住：2s 预算是**硬上限**，另加 2.5s 兜底
- 不新增依赖；daemon 不 import electron
