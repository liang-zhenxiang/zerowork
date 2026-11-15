# 上下文注入通道与可见性核实（2026-11-15）

## 注入通道

- `BeforeAgentStartEventResult.message = Pick<CustomMessage, "customType"|"content"|"display"|"details">`
- `agent-session.js` 的 `_prepareRun`：先放用户消息，再把每条结果转成
  `{ role:"custom", customType, content, display, details, timestamp }` 追加进本轮起始消息
- `pi-agent-core/agent-loop.js` 的 `runAgentLoop`：对每条起始消息发 `message_start` +
  `message_end` —— 所以 **live 路径也能看到注入消息**
- `display:false` 的消息不会出现在 TUI 视图，但仍在上下文里；本项目**不允许**用它

## 本仓库的可见性缺口

- `session-view.js` 的 `buildConversationEntries` 只处理 `user` / `assistant`，
  `role:"custom"` 被忽略 → 重新打开会话看不到
- `session-host.js` 的 `translate` 在 `message_start` 只处理 user / assistant
  → live 也看不到
- 渲染层默认分支会把未知 role 当 assistant 渲染（样式会错），必须新增独立分支

## 结论

注入要「可见」必须同时改三处：视图投影、live translate、渲染层卡片；
只改 `hooks.js` 会得到「模型收到了、用户看不到」的静默注入，违反 PRD 硬约束。
