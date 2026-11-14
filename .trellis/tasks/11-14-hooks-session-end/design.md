# 技术设计：SessionEnd 与退出预算

> 前置：#373 的生命周期 hooks 契约（配置、合并、审计、三处装配）全部复用。

## 一、事件映射（已核实）

| hook 事件 | pi 事件 | 载荷 | 可阻断 |
| --- | --- | --- | --- |
| `SessionEnd` | `session_shutdown`（`reason: quit / reload / new / resume / fork`） | `reason` | 否 |

pi 侧的事实（`dist/core/agent-session-runtime.js`）：

- `session_shutdown` 只在 `AgentSessionRuntime.teardownCurrent()` / `dispose()` 里发出；
- 发出后紧接着 `session.dispose()`；
- daemon 直嵌 `AgentSession`、不经 runtime —— **不自己发就永远收不到**（与 `session_start`
  缺 `bindExtensions()` 同一类缺口）。

`AgentSession.extensionRunner` 是公开 getter（`agent-session.d.ts:932`），
所以我们直接 `await session.extensionRunner.emit({ type:"session_shutdown", reason })`，
不依赖未从包根导出的 `emitSessionShutdownEvent`。

## 二、预算（核心）

```
HOOK_SHUTDOWN_BUDGET_MS = 2000
```

- **每个会话** 2s，逐条 hook 的有效超时 = `min(hook.timeoutMs, 剩余预算)`
- 剩余预算 ≤0 时**不再 spawn**，直接记一条 `failed`，stderr 写「超出关闭等待预算」
- 多个会话同时收尾时**并行**（`Promise.allSettled`），所以总时长仍是 ~2s，不是 N×2s
- 预算只用于 `SessionEnd`；其它事件不受影响（单条 1–30s 照旧）

实现：在 `hooks.js` 增加

```js
runHooksWithinBudget(hooks, payload, event, deadlineAt, deps)
```

它按顺序跑，但把每条 hook 的 `timeoutMs` 压到剩余预算；预算耗尽的条目返回合成结果
（`verdict:"fail", timedOut:true, stderr:"超出关闭等待预算（2s），已跳过"`），
审计文案沿用既有 `stderrSummary`，因此显示为「超时」。

`createLifecycleHookExtension` 的通用 `run(event, buildPayload, ctx, options)` 增加
`budgetMs`：只有 `session_shutdown` 传 `HOOK_SHUTDOWN_BUDGET_MS`。

## 三、SessionHost：两种释放语义

```js
dispose()                 // 立即释放（保持现状；定时器清理 + session.dispose）
async shutdown(reason)    // 先 emit session_shutdown（带 2s 预算），再 dispose
```

- `shutdown` 里 emit 的异常一律吞掉（收尾不能改变关闭结果）
- **不改** `dispose()` 的行为：很多路径在瞬态清理里调用它，改成异步会扩大改动面
- 需要收尾的调用点改用 `shutdown`：

| 位置（`session-files.js`） | 场景 | reason |
| --- | --- | --- |
| 自动会话 `finally`（约 1166） | 定时任务结束 | `quit` |
| 会话驱逐（约 2126） | 容量上限淘汰 | `quit` |
| 团队解散 / 成员关闭（约 2870 / 3631 / 3797） | 成员会话 | `quit` |
| 会话重启 / 分支切换（约 4295） | 重建宿主 | `resume` |
| 删除会话（约 5232） | 用户删除 | `quit` |

调用点本来就是 async 的 `await`；同步上下文（如 3631 的成员回调）用
`void handle.shutdown("quit")`（daemon 仍活着，后台完成即可）。

## 四、应用退出（main ↔ daemon）

现状：`before-quit` 同步 `daemon?.kill()`，daemon 来不及跑任何收尾。

新流程：

```
before-quit（第一次）
  event.preventDefault()
  callDaemon("daemon:shutdown")            ← daemon 并行 shutdown 所有会话
  ├─ 完成 或 2.5s 兜底
  daemon.kill()
  writeCleanExitMarker()
  app.quit()                               ← 第二次进入，quitStarted 守卫直接放行
```

- daemon 侧新增 `INVOKE.daemonShutdown = "daemon:shutdown"`：
  收集 `bucketsById` 的 `hostPromise` 与 `memberHandlesBySession`，`Promise.allSettled`
  地对每个 host `await host.shutdown("quit")`，返回 `{ closed }`
- `daemon:shutdown` **不进渲染层**（不暴露到 preload），只由 main 调用
- 2.5s 兜底计时器保证「daemon 卡住也一定能退出」；收到第一个结果后清掉计时器
- 重入守卫：`quitStarted` 为 true 时不再 `preventDefault`

## 五、压缩路径：刻意不做

`session_before_compact` 的返回值可以 `cancel` 压缩、改写摘要 —— 那是**改变会话结果**的
通道，而本轮所有生命周期事件的硬约束是「只观测、不改变」。专家应该在
`session_compact`（已完成）上做，但那个事件与 hooks 的「动作总是发生」诉求重叠很小。
**结论：不做**，理由写进 `SECURITY.md` 与 spec §七。

## 六、载荷与试运行

```js
payloadForSessionEnd({ sessionId, cwd, reason, now })
// { event:"SessionEnd", session:{id,cwd}, reason:"quit", timestamp }
```

- `reason` 只接受 `quit / reload / new / resume / fork`，其余折成 `"quit"`（如实但保守）
- `hooks:test` 按事件生成示例载荷：`reason: "quit"`

## 七、UI

- `HOOK_EVENT_OPTIONS` 追加 `会话结束（SessionEnd）`；`HOOK_EVENT_LABELS.SessionEnd = "会话结束"`
- 生命周期 matcher 禁用逻辑已按事件集合判断，把 `SessionEnd` 加进集合即可
- 设置页脚注补「会话结束事件在退出时最多等 2 秒」
- 试运行弹窗对非阻断事件的「未阻断」文案已通用

## 八、测试

### 单元（`tests/unit/hooks.test.mjs`）

- `HOOK_EVENTS` 含 `SessionEnd`；`LIFECYCLE_EVENTS` 含之；`BLOCKING_EVENTS` 不含
- `payloadForSessionEnd` 的形状与 reason 归一
- `runHooksWithinBudget`（或扩展工厂等价路径）：
  - 预算充足时按配置超时跑
  - 第一条耗掉预算后，第二条**不 spawn**、记 failed「超出预算」
  - 单条配置 30s，有效超时被压到 ≤2s（注入假 spawn，断言收到的 timeout）
- 扩展工厂：`session_shutdown` 触发 SessionEnd；结果不返回任何值

### daemon 集成（`tests/e2e/hooks-session-end.mjs`）

- 用户级 SessionEnd hook：把 stdin 追加到文件
- 场景 A：删除一个已创建的会话 → 文件里出现一条 `event: "SessionEnd"`、`reason: "quit"`
- 场景 B：切换 / 重启会话 → 出现 `reason: "resume"`
- 场景 C（退出）：`electronApp.evaluate(({ app }) => app.quit())` → 等待文件出现；
  这条用例同时验证「退出不会被 hook 拖住」：配一条 `timeoutMs: 30000` 的 hook，
  退出仍在 3s 内完成（用进程退出时间或文件时间断言）

### GUI（`tests/e2e/gui-hooks.mjs` 扩展）

- 事件下拉出现 `会话结束（SessionEnd）`；选中后 matcher 禁用
- 最近运行不回归（已有）
- 截图：设置页含新选项（浅色即可，暗色沿用既有）

## 九、文档

- `SECURITY.md`：SessionEnd 的预算、退出流程、与 Stop 的区别、不做 compact 的理由
- `.trellis/spec/daemon/index.md` §七：补「收尾事件在退出路径上，预算是硬上限」
- `CHANGELOG.md` `[Unreleased]` → 新增

## 十、回滚

- 删除 SessionEnd 配置即可关闭；代码层面只是新增事件与两个方法，
  `dispose()` 与其它事件路径不变
- 若退出流程出问题：`before-quit` 的兜底计时器保证仍会 kill 并退出
