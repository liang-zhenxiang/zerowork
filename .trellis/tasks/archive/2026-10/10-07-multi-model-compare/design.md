# 技术设计：一问多答（多模型并排对比）

> 事实依据来自 `research/feasibility.md`（逐条 `file:line`）。
> 视觉规范见 `research/design-spec.md`。本文件记录**边界、契约、数据流、被否掉的方案**。

---

## 一、边界

### 做什么

1. **对比编排**：一个 daemon 侧模块，把一条问题**并行**发给 2–4 个模型，每列独立宿主、独立收尾
2. **一条专用 PUSH 通道** 把列事件送回渲染层（**不复用 `sessionEvent`**）
3. **一个全屏视图**（`view === "compare"`）：自带输入区 + N 列并排流式 + 每列耗时与用量
4. 两个入口：⌘K 动作、输入卡模型菜单里的一条

### 不做什么

- 不跑工具、不碰工作空间、不写文件
- 不把对比会话注册进 `bucketsById`、不进 teams
- 不计入统计页、不进侧栏与资料库
- 不做「把满意的那列收进会话」（第二批）

---

## 二、最关键的一条：**为什么必须有一条专用通道**

最省事的做法是「把对比会话接进 `PUSH.sessionEvent`」——事件、状态归约、渲染全都白拿。
**这条路必须拒绝**，三条理由都有 `file:line` 支撑：

| # | 后果 | 证据 |
| --- | --- | --- |
| ① | **用量统计串台**：`ObservabilityStore.currentRun` 是**单槽**，`run_started` 无条件覆写、`assistant_done` 归属「最后一个 `run_started` 的会话」、`finishRun` 无条件清空 —— N 列并行时后起的列抢走先起列的归属，**先收尾的列会把别的列永远留在 `status: "running"`** | `observability.js:162` / `:409` / `:418` / `:482` |
| ② | **全局副作用对每列各跑一次**：`pushTaskListChanged()`、**`evictIdleHosts()`**（会真的 dispose 掉别的桶的宿主）、`teamRegistry.settleRunningMembers`、`emitSessionStats` | `session-files.js:1883-1886` / `:1716-1724` / `:1889` / `:1902` |
| ③ | **渲染层不会重渲染**：后台会话的事件被折进 `viewCacheRef`（**ref**），症状是「跑完了、屏幕上一动不动」 | `app.js:68491` / `:68572` |

**做法**：对比列的事件经 `deps.onEvent` 闭包交给编排模块，由它打上**列 id** 后走
`PUSH.compareEvent`。耗时与用量**在渲染层按列自算**（数据本就在事件里：
`assistant_done.message.usage`、`turnTimings`）。

**如实说明代价**：对比列**没有** `session_stats` / 上下文用量 / 诊断面板。v1 接受。

> 这条也解释了「为什么今天的并行宿主没踩坑」：成员与子代理都绕开了 `emitSessionEvent`。

---

## 三、模块与契约

### 3.1 新模块 `src/main/daemon/compare.js`

照 `createSubagentRunner(deps)`（`command-exec.js:1960-2085`）的骨架写 —— 那份代码已经覆盖了
「并发闸 + 队列、每列一个宿主、从 `assistant_done` 收文本、超时、abort、`finally dispose`」全套零件。

```js
createCompareRunner(deps) → {
  run({ columns, prompt, onEvent, signal }) → Promise<{ columns: [...] }>
  abort()
}
```

**纯逻辑必须单独可测**（抽成不碰宿主的函数）：

- `normalizeColumns(models)` —— 2–4 的边界校验（0/1/5 个要**明确拒绝**并给出原因）
- `createColumnStates(columns)` —— 初始状态
- `reduceColumn(state, event)` —— 列状态归约（`queued → running → done | failed | cancelled`）
- `extractUsage(assistantDoneEvent)` —— 从 `assistant_done.message.usage` 取 token，缺失时如实为 `undefined`
- `accumulateTiming(state, event, now)` —— 耗时口径（**从该列自己开始跑那一刻起算**，不是整体开始）

**额度**：另立一份（**不占 `SPAWN_BUDGET_PER_SESSION`**，`session-state.js:703`），
理由见 PRD 事实 5：不另立的话用户跑几轮对比就建不了团。

**收尾**：每一列**无论成功失败**都在 `finally` 里 `host.dispose()`。
对比宿主不在 `bucketsById` 里 ⇒ `pickEvictions`（`session-state.js:739`）不会回收它 ⇒ 必须显式释放。

**标记**：每列建好宿主后、`prompt` 前调用 `markCompareRun(...)`（照 `markSubagentRun`，
`session-host.js:473-483`，**只加方法、不改 `prompt` / `translate` / `ablate`**），
并把 `compare_run` 加进 `CHILD_SESSION_CUSTOM_TYPES`（`session-files.js:1321`）——
这样它们不会出现在侧栏与资料库里。

### 3.2 不跑工具（v1）

比的是「回答本身」；且 N 列并行跑工具 = N 份沙箱与文件写入副作用，安全面直接放大。

**要求**：装配层就**不装扩展**，不是「没给工具提示词」。若 `SessionHost.create` 无法在无扩展下
干净工作，才回落到「只读」档，并**在界面上写明**（不许静默放宽）。

**顺带消掉一个坑**：无工具 ⇒ 不会产生权限审批 ⇒ 不需要处理「审批归属于哪一列」
（`requestApproval(request, sessionId)` 的归属问题不存在了）。

### 3.3 IPC

| 常量 | 值 | 入参 | 返回 |
| --- | --- | --- | --- |
| `INVOKE.compareStart` | `compare:start` | `[models: string[], prompt: string]` | `{ ok:true, runId } \| { ok:false, error }` |
| `INVOKE.compareAbort` | `compare:abort` | `[runId]` | `{ ok:true }` |
| `PUSH.compareEvent` | `compare:event` | —— | `{ runId, columnId, kind, ... }` |

`kind` 的取值清单必须在 `src/shared/ipc.js` 的注释里钉死（渲染层靠它归约）：

```
column_queued | column_started | text_delta | thinking_delta | assistant_done
| column_failed | column_cancelled | run_finished
```

**恪守既有约定**：可预期的失败用返回值表达（同 `testModel` 上方的成文理由）。

### 3.4 渲染层

- **新文件** `src/renderer/src/compare-view.js`（照 `command-palette-core.js` / `session-pin.js`
  的既有做法：独立源码文件，被 `app.js` 静态 import）。`app.js` 只留：
  挂载点（`view === "compare"`）、⌘K 动作、模型菜单入口、`view` 状态取值
- **新 state 容器**：`Map<columnId, ConversationView>` 的 state ——
  今天只有 `App` 那一个 `useReducer` 是响应式的，N 列同时跳字**必须**有新容器
- 逐列复用既有的 `buildTurnViews`（`app.js:30674`，对单个 conversation 的纯投影）+ 既有的消息渲染组件
- 每列**自算**耗时与用量；列与列之间**不共享任何可变状态**（这是「不串台」的实现基础）

---

## 四、要改的文件清单

| 文件 | 改动 | 风险 |
| --- | --- | --- |
| `src/main/daemon/compare.js` | **新增**（编排 + 纯逻辑） | 低（新文件，不碰默认路径） |
| `src/main/daemon/session-files.js` | 注册 3 条通道 + 把 deps 喂给编排模块 + `CHILD_SESSION_CUSTOM_TYPES` 加一项 | **中**（daemon 唯一的大枢纽，顶层求值顺序敏感） |
| `src/main/daemon/session-host.js` | 只加 `markCompareRun(...)`（照 `markSubagentRun`） | 低（**不改运行循环任何一行**） |
| `src/shared/ipc.js` | 2 INVOKE + 1 PUSH 常量 + 契约注释（写明为什么不复用 `sessionEvent`） | 低 |
| `src/preload/index.js` | 手工副本两表 + 3 个方法 | 低 |
| `src/renderer/src/compare-view.js` | **新增**（视图本体、列渲染、自算耗时用量） | 低 |
| `src/renderer/src/app.js` | 挂载点 + ⌘K 动作 + 模型菜单入口 + `view` 取值（**定点改，不重排**） | **中**（7 万行大文件） |
| `src/renderer/src/app.css` | 新视图的样式（**只用既有 token 与既有类名**；尽量不新造类名） | 中 |
| `tests/unit/compare-*.test.mjs` | 纯逻辑单测 | 低 |
| `tests/e2e/multi-model-compare.mjs` | 两台 mock + 两 provider + 断言两列各收各的 | 低 |
| `package.json` | 新脚本挂进 `test:gui` | 低 |
| `CHANGELOG.md` / `docs/USAGE.md` | 新增 + 使用说明 | 低 |

---

## 五、风险与对策

| 风险 | 对策 |
| --- | --- |
| **列间串台**（A 列显示 B 列的内容/用量） | 列 id 进事件；渲染层每列独立 state；**单测直接断言「A 列的事件不会进 B 列」** |
| **一列失败拖垮全部** | 每列独立 try/finally；`Promise.allSettled` 语义；e2e 专门造「一列 500 另一列正常」 |
| **用量串台到全局统计** | 不走 `emitSessionEvent`；e2e 断言「跑完对比后 `usageStats` 总量不变」 |
| **默认路径被回收**（`evictIdleHosts`） | 不进 `bucketsById`；e2e 断言「跑完对比后单模型对话仍可用」 |
| **宿主泄漏** | 每列 `finally` 里 `dispose()`；单测断言「异常路径也调了 dispose」 |
| **额度被抢** | 另立预算，不占 `SPAWN_BUDGET_PER_SESSION` |
| **大文件重排** | 新代码落新文件；`app.js` 定点改，`git diff --stat` 复核 |
| **动 `session-host.js` 伤到默认路径** | 只加一个标记方法；**判据**：`git diff session-host.js` 里不得出现 `prompt(` / `translate` / `ablate` |

---

## 六、被否掉的方案（照 `docs/ARCHITECTURE.md` 的规矩记下来）

| 被否掉的方案 | 理由 |
| --- | --- |
| 复用 `PUSH.sessionEvent` 把对比接进默认会话流 | 三条硬后果（用量单槽串台 / `evictIdleHosts` 会 dispose 别的桶 / 渲染层不重渲染），见 §二 |
| 把对比会话注册进 `bucketsById` | 桶的生命周期带着 `evictIdleHosts` / `disbandTeamOf` / `backgroundJobs.killAllForSession` / 侧栏 pending 分支一整套副作用；为了让 `snapshot` 能查到而付这些代价不划算，还会让对比出现在侧栏与资料库 |
| 把对比做成 `TeamRegistry` 的一种 | 团队是完整状态机（建团/解散、成员名唯一、计划审批、任务板、落盘恢复），对比一个都用不上；硬塞等于为一屏对比背上「成员名冲突」「计划待审」这些语义 |
| 把「多选模型」做进全局 `setModel` 语义 | `ModelMenu.pick` 直连 `window.setModel(key)`，那是**会话级单模型**的权威写入点；多选必须是**独立的对比入参**，否则污染默认路径 |
| 做成右侧面板（`panelContent === "compare"`）而不是全屏视图 | 面板宽度放不下 3–4 列（要靠全屏才舒服），而全屏后它就不再「让位」了；且面板是「当前会话的附属物」，而对比是一块独立的地方。**保留**：面板方案不新开设计例外，全屏方案要自备输入区 —— 已权衡后选自备输入区（v1 不需要 cwd/@ 上下文） |
| 让对比列跑工具 | 会把 N 份沙箱与文件写入副作用叠在一起，安全面直接放大；且比的是「回答本身」 |
| 对比结果计入统计页 | 需要先解决 `ObservabilityStore.currentRun` 单槽的问题，那是独立的一处重构 |

---

## 七、与其他文档的同步

- `CHANGELOG.md` → 「新增」
- `docs/USAGE.md` → 补一节「模型对比」（说清**它不跑工具、不产生文件、不计入统计**）
- `docs/ARCHITECTURE.md` → 若「专用通道」这条成为长期决策，补一行到「设计决策与已否决方案」表
- `docs/DESIGN.md` → **仅当**确实引入新档位或新例外才动；否则不动