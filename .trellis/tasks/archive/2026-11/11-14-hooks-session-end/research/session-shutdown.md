# pi `session_shutdown` 与退出链路核实（2026-11-14）

## pi 侧

- 类型：`{ type:"session_shutdown"; reason:"quit"|"reload"|"new"|"resume"|"fork"; targetSessionFile? }`
- 发射点只在 `AgentSessionRuntime`：
  - `teardownCurrent(reason, target)`：先 `session.abort()`，再 emit，再 `session.dispose()`
  - `dispose()`：emit `{reason:"quit"}`，再 `session.dispose()`
- `AgentSession.reload()` 另发 `{reason:"reload"}`（需要 bindings 才发）
- `AgentSession.extensionRunner` 是公开 getter（`agent-session.d.ts:932`）；
  `emitSessionShutdownEvent` 未从包根导出 —— 直接用 `runner.emit(...)` 即可
- **daemon 直嵌 `AgentSession`、不经 runtime → 必须自己 emit**（同 `session_start` 缺
  `bindExtensions()` 的缺口）

## 本仓库现状

- `SessionHost.dispose()` 是同步的：清定时器 + `session.dispose()`；无处 emit shutdown
- `main/index.js` 的 `before-quit` 直接 `daemon?.kill()`，daemon 没有收尾机会
- `callDaemon(channel, args)` 已有请求/响应机制（`pending` + `utilityProcess.postMessage`）
- `daemon/index.js` 把主进程帧交给 `session-files.js` 的 `dispatch`
- dispose 调用点：session-files 1166 / 2126 / 2870 / 3631 / 3797 / 4295 / 5232

## 结论

- 新增 `SessionHost.shutdown(reason)`（异步、带预算），调用点按 reason 映射替换；
- `dispose()` 保持立即释放语义（瞬态清理路径多）；
- 退出：`before-quit` preventDefault → `daemon:shutdown`（并行、每会话 2s）→ 2.5s 兜底 →
  kill → 再 `app.quit()`（重入守卫）；daemon 不暴露该通道给渲染层。
