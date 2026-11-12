# pi 生命周期事件核实（2026-11-12）

来源：`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`

## 可用的相关事件

| pi 事件 | 类型要点 | 能否改变行为 | 结论 |
| --- | --- | --- | --- |
| `session_start` | `{ reason: "startup" \| "reload" \| "new" \| "resume" \| "fork"; previousSessionFile? }` | `ExtensionHandler<SessionStartEvent>`（无返回结果） | 映射 `SessionStart` |
| `before_agent_start` | `BeforeAgentStartUserEvent { messageType: "user"; prompt: string; images? }`；`Custom { messageType: "custom"; message }` | 可返回 `{ message?, systemPrompt? }` | 只取 `messageType === "user"` 映射 `UserPromptSubmit`；**不返回任何值** |
| `agent_end` | `{ messages }` —— **没有 `willRetry`** | 无结果 | 不用 |
| `agent_settled` | `{ aborted: boolean }`，注释：`Fired after an agent run has fully settled and no automatic retry, compaction, or queued continuation will run` | 无结果 | 映射 `Stop` |

## 派发语义

- `ExtensionHandler<E,R> = (event, ctx) => Promise<R|void> | R | void`；
  `runner.emit()` **按扩展注册顺序、逐 handler `await`** —— 生命周期 hook 会占用事件派发的等待时间。
- handler 抛错会被 runner `catch` 并 `emitError`，不会中断会话；本模块仍自行兜底，
  以便留下可读的 `hook` 审计。
- `session_start` 由 `AgentSession` 在会话装载完成后 emit（`agent-session.js` 约 2680 行，
  `this._extensionRunner.emit(this._sessionStartEvent)`），晚于扩展注册。
- `agent_settled` 由 `_emitAgentSettled()` 发出，位于「无重试 / 压缩 / 续跑」判定之后。

## 与实现直接相关的两点

1. `session_start` 没有返回值通道 → 三个事件里只有 `UserPromptSubmit` 理论上能注入；
   只做它会行为分叉，因此 MVP 统一**不做上下文注入**。
2. `before_agent_start` 在用户消息提交后的等待路径上；最坏延迟 = 命中条数 × 超时。
