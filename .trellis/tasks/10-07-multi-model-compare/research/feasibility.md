# Research: 「一问多答」多模型并排对比 —— 可行性调研

- **Query**: 同问题并行发 2–4 个模型、同屏并排流式呈现、比较耗时与用量、把满意的那条「收进会话」；硬约束是默认路径一字不改、不引新依赖、不新增出网目标
- **Scope**: internal（纯代码调研，无外部检索）
- **Date**: 2026-10-07
- **工作副本**: `/Users/liangyuxiang/Documents/work/yu-project/zerowork`，`main` @ `cb7bb9d`

> 说明：本文件只陈述**现状事实**（附 `file:line` 与代码片段），最后一节按任务要求给出成本/风险判断。
> 所有行号取自 `main` @ `cb7bb9d`；`src/renderer/src/app.js` 是**未压缩的构建源**（`electron.vite.config.mjs` 里 `NO_MINIFY = false`），可直接按行号定位。

---

## A. 现在「一轮对话」是怎么跑起来的

### A1. 一次 run 的入口函数与绑定对象

**入口**：`SessionHost.prompt()` —— `src/main/daemon/session-host.js:307`

```js
async prompt(text, whileStreaming, images) {
  const piImages = toPiImages(images);
  if (this.session.isStreaming) {
    if (whileStreaming === "steer") await this.session.steer(text, piImages);
    else await this.session.followUp(text, piImages);
    return { queued: true };
  }
  ...
  this.freezeHiddenContext();
  await this.session.prompt(text, piImages === void 0 ? void 0 : { piImages });
  return { queued: false };
}
```

**绑定对象**：`SessionHost` 实例持有**一个** pi `AgentSession`（`session-host.js:78-88`），
由 `SessionHost.create(options)` 造出（`session-host.js:221-284`）。事件在构造末尾订阅：

```js
// session-host.js:282
session.subscribe((event) => host.translate(event));
```

事件出口是**构造时注入的 `options.emit`**（`session-host.js:686`）：

```js
emitState() {
  this.options.emit({ type: "session_state", state: this.state });
}
```

**`currentBucket` 是什么**：daemon 侧「当前 IPC 目标会话」的指针，与「会话实体」是两件事。

```js
// src/main/daemon/session-files.js:1691-1697
const bucketsById = /* @__PURE__ */ new Map();

let currentBucket = createBucket({
  cwd: defaultWorkspaceDir,
  conversation: freshConversation(defaultWorkspaceDir, "work", "craft"),
  spawnBudget: readPreferences().spawnBudget
});
```

```js
// src/main/daemon/session-files.js:1709-1713
function setCurrentBucket(bucket) {
  currentBucket = bucket;
  bucket.lastUsedAt = Date.now();
  evictIdleHosts();
}
```

**一个会话一个 host**：host 是**桶的字段**，不是全局单例：

```js
// src/main/daemon/session-state.js:705-728（createBucket）
function createBucket(options) {
  return {
    hostPromise: void 0,       // ← 每个桶一个（懒建的）宿主
    sessionId: "",
    sessionFilePath: void 0,
    ...
```

```js
// src/main/daemon/session-files.js:2419-2431
function getHost(bucket) {
  if (bucket.hostPromise === void 0) {
    const attempt = createHost(bucket).then((host) => {
      adoptHost(bucket, host);
      return host;
    });
    bucket.hostPromise = attempt;
    attempt.catch(() => {
      if (bucket.hostPromise === attempt) bucket.hostPromise = void 0;
    });
  }
  return bucket.hostPromise;
}
```

`bucket.hostPromise` 全项目共 **22 处**引用，全部形如「先判空、再 `await`」，见
`grep -n hostPromise src/main/daemon/session-files.js`（1720、2201、2212、2223、2420、
2425、2427、2430、2434、2781、3221、3312、3492、3565、3624、3626、3662、3678、3988、
4061、4073、4088、4150、4185、4202、4244、4249、4290、4296、4300、4311、4369、4384、4905、5018）。

### A2. 能不能同时存在多个活跃 host —— **能，今天已经能**

三个既有证据：

**① 桶是一个 Map，可以有多个，各自持有活宿主。**

```js
// session-files.js:1715-1725
function evictIdleHosts() {
  for (const bucket of pickEvictions(bucketsById.values(), currentBucket)) {
    void disbandTeamOf(bucket.sessionId);
    bucketsById.delete(bucket.sessionId);
    ...
    void hostPromise.then((host) => host.dispose());
  }
}
```

淘汰判定明确承认「多个 host 同时活着」，只回收**空闲**的：

```js
// session-state.js:739-751（pickEvictions）
function pickEvictions(buckets, current, maxIdle = MAX_IDLE_HOSTS) {
  const idle = [];
  for (const bucket of buckets) {
    if (bucket === current) continue;
    if (bucket.hostPromise === void 0) continue;
    if (bucket.hasTeam) continue;
    if (bucket.running || bucket.pendingApprovals > 0 || bucket.pendingOps > 0) continue;  // ← 正在跑的桶绝不淘汰
    idle.push(bucket);
  }
  ...
}
```

`MAX_IDLE_HOSTS = 5`（`session-state.js:701`）。

**② 子代理 runner 就是「并行 N 个独立宿主」的现成实现**，并发上限 4：

```js
// src/main/daemon/command-exec.js:1958 / 1975 / 2036 / 2066
const MAX_CONCURRENT = 4;
...
const activeHosts = /* @__PURE__ */ new Set();
...
      host.markSubagentRun(agent.name);
      activeHosts.add(host);
...
    } finally {
      if (host !== void 0) activeHosts.delete(host);
      host?.dispose();
    }
```

`activeHosts` 是 `Set<SessionHost>` —— 同时活着的宿主本就是一个集合。

**③ 团队最多 8 名成员，各自一个独立宿主**（`teams.js:87` 的 1–8 人上限；
`spawnMember` 在 `command-exec.js:2312` 调 `SessionHost.create`）。
注意 `spawnMember` **不 await** 那一轮就返回句柄：

```js
// command-exec.js:2382-2387
void host.prompt(input.task).then(() => settleRound(false)).catch(async (error) => {
  try {
    await hooks.onFailed(memberName, error instanceof Error ? error.message : String(error));
  } catch {
  }
});
```

所以「多个成员同时流式」今天就在发生。
自动化 run 会话同理，也是独立宿主（`session-files.js:966`）。

**关键区别（这条决定了对比功能的架构）**：这些并行宿主**不走 `emitSessionEvent`**。
它们各自带一个本地 `emit` 闭包 —— 见 `command-exec.js:2003`（子代理）与
`command-exec.js:2293`（成员）。只有 `currentBucket` 的宿主经 `createHost` 接到
`emit: (event) => emitSessionEvent(bucket, event)`（`session-files.js:2613`）。

### A3. 事件怎么推回渲染层

**信封形状**：

```js
// src/main/daemon/session-files.js:1881-1882
  const envelope = { sessionId: bucket.sessionId, event };
  post({ kind: "push", channel: PUSH.sessionEvent, payload: envelope });
```

通道常量：`PUSH.sessionEvent === "session:event"`（`src/shared/ipc.js:582`；
preload 侧手工副本 `src/preload/index.js:537`，订阅口 `index.js:713` 的
`onSessionEvent: (listener) => subscribe(PUSH.sessionEvent, listener)`）。

**`kind` 取值清单**（`event.type`，全部在 `src/main/daemon/session-state.js:455-689` 的 reducer 里）：

`history_reset` / `run_started` / `run_finished` / `run_error` / `user_message` /
`assistant_started` / `assistant_text_delta` / `assistant_thinking_delta` /
`assistant_done` / `tool_stream_started` / `tool_started` / `tool_stream_progress` /
`tool_progress` / `subagent_progress` / `team_member_progress` / `tool_finished` /
`session_state` / `context_usage` / `session_stats` / `artifacts_presented` /
`run_retry` / `queue_changed` / `compaction_started` / `compaction_finished`

另有三个只推给渲染层、不进 reducer 的（在 `session-files.js` 里直接 emit）：
`team_member_progress`（2305）、`context_usage`（1916）、`session_stats`（1922）。

**渲染层如何归约**：渲染层有**自己的一份 reducer 副本**（`src/renderer/src/app.js:12650`
`function conversationReducer(view, action)`），与 daemon 的 `session-state.js:453`
是两份手工同步的镜像（渲染层不 import `src/shared/`，`grep -n "shared/" app.js` 无命中）。
**任何新事件类型要改两处。**

可见会话直接 dispatch，后台会话进 `viewCacheRef`（**ref，不是 state**）：

```js
// src/renderer/src/app.js:68555-68582
const offEvent = window.kami.onSessionEvent(({ sessionId, event }) => {
  if (sessionId !== visibleSessionIdRef.current) {
    ...
    const base = viewCacheRef.current.get(sessionId) ?? { ...initialConversation, ... };
    viewCacheRef.current.set(sessionId, conversationReducer(base, { type: "event", event }));
    if (event.type === "run_finished" && event.outcome === "completed") { ...toast... }
    return;
  }
  dispatch({ type: "event", event });
  ...
});
```

`viewCacheRef` 的定义见 `app.js:68491`；「切到某会话」= 把缓存项 dispatch 成当前 state
（`restoreFromBucket`，`app.js:69006-69016`）。

**时间线投影**：`buildTurnViews(entries, { streaming, cancelledTurns })` ——
**只在渲染层**，`src/renderer/src/app.js:30674`，调用点 `app.js:32597-32600`。
daemon 侧对应的是 `session-view.js` 的 `buildConversationEntries`（`session-view.js:724`），
把落盘条目投影成 `{id, role, text, thinking, usage, at}` 之类的 UI 条目。

### A4. 用量 / 费用 / 耗时分别在哪算

**三套独立账本，各有归属键，问题只出在第三套。**

**① RunLedger —— 按 sessionId 落文件，天然不串台。**

```js
// src/main/daemon/session-host.js:86
this.ledger = options.createLedger?.(session.sessionId);
```
```js
// src/main/daemon/session-files.js:2615-2617
// 运行台账按真值 sessionId 建（工厂语义见 SessionHostOptions.createLedger）。
createLedger: (sessionId) => new RunLedger(...
```

**② 逐回合耗时 —— 在会话 view 里，按 `user 消息 id` 起键。**

```js
// src/main/daemon/session-state.js:441-451（recordTurnTiming）
// session-state.js:532-534
        turnTimings: recordTurnTiming(view.turnTimings, event.message.id, {
          startedAt: event.message.at
        }),
```
渲染层消费：`app.js:32611` `const metricsTurn = ... conversation.turnTimings?.[lastUserId]`。
**每份 conversation 各有一份 `turnTimings`，N 列并排时不会互相覆盖。**

**③ `ObservabilityStore` —— 进程级单例，`currentRun` 是单槽。这是唯一的串台点。**

```js
// src/main/daemon/session-files.js:1729
const observability = new ObservabilityStore();
```
```js
// src/main/daemon/observability.js:162
  /** runId → 进行中的 run，run_finished / run_error 时回填终态。 */
  currentRun;
```
```js
// src/main/daemon/observability.js:392-412（record → run_started）
      case "run_started": {
        const axes = this.axesBySession.get(sessionId);
        const run = { runId: event.runId, sessionId, ... };
        this.currentRun = run;          // ← 覆盖上一个尚未闭合的 run
        this.pushRunCard(run);
        this.totalRuns += 1;
        return;
      }
```
```js
// src/main/daemon/observability.js:414-424（record → assistant_done）
      case "assistant_done": {
        const usage = event.message.usage;
        if (usage === void 0) return;
        addUsage(this.totalUsage, usage);
        const run = this.currentRun;    // ← 归属到「最后一个 run_started」的会话
        if (run !== void 0) { ... addUsage(run.usage, usage); }
        return;
      }
```
```js
// src/main/daemon/observability.js:475-483
  finishRun(status, error) {
    const run = this.currentRun;
    if (run === void 0) return;
    ...
    this.currentRun = void 0;          // ← 先结束的那个 run 会把另一个也关掉
  }
```

`observability.record` 的唯一生产调用点是 `emitSessionEvent`：

```js
// src/main/daemon/session-files.js:1873-1875
  bucket.conversation = conversationReducer(bucket.conversation, { event });
  bucket.running = bucket.conversation.state.isStreaming;
  observability.record(bucket.sessionId, event);
```

而成员事件走的 `emitMemberEvent` **不调它**：

```js
// src/main/daemon/session-files.js:2380-2383
function emitMemberEvent(memberSessionId, event) {
  const envelope = { sessionId: memberSessionId, event };
  post({ kind: "push", channel: PUSH.sessionEvent, payload: envelope });
}
```

**结论**：今天多个 host 并行**不触发**这个串台，是因为并行宿主都绕开了 `emitSessionEvent`。
「一问多答」如果走 `emitSessionEvent`（看起来最省事：复用现成事件通道），
就会踩上它 —— 详见「结论」的坑 ①。

另：`emitSessionEvent` 的 `run_finished` 分支还会 `evictIdleHosts()`：

```js
// src/main/daemon/session-files.js:1883-1886
  if (event.type === "run_started" || event.type === "run_finished" || event.type === "run_error") {
    pushTaskListChanged();
    if (event.type !== "run_started") evictIdleHosts();   // ← 每一列的收尾都会触发一次全局淘汰
  }
```

---

## B. 已有的「多会话并行」基础设施

### B5. 起独立会话 + 跑一轮 + 收结果的现成函数

**有两份同族实现，都不是「通用导出函数」，但骨架可直接照搬。**

**① `createSubagentRunner(deps)` —— `src/main/daemon/command-exec.js:1960-2085`。**
这是**最接近「起一个临时会话、发一条消息、收集结果」**的现成代码：

```js
// command-exec.js:1960-1975
function createSubagentRunner(deps) {
  let running = 0;
  const queue = [];
  const acquire = async () => {
    if (running < MAX_CONCURRENT) { running += 1; return; }
    await new Promise((resolve2) => queue.push(resolve2));
  };
  ...
  const activeHosts = /* @__PURE__ */ new Set();
```

核心是 `runOne(input)`（`1960-2069`）：取 catalog → 解析 modelKey（`agent.model` 优先，
回落 `deps.getModelKey()`，`1979-1995`）→ `SessionHost.create` → `host.prompt(task)` →
从 `assistant_done` 里累积 `lastText` → `finally { host?.dispose() }`：

```js
// command-exec.js:2003-2017
      const emit = (event) => {
        if (event.type === "run_error" && runError === void 0) runError = event.message;
        if (event.type === "run_finished" && event.outcome === "cancelled") cancelled = true;
        if (event.type === "assistant_done") {
          turns += 1;
          lastText = event.message.text;
          input.onProgress?.(`${agent.name}：已完成 ${turns} 轮`);
        }
        ...
```

它还带超时（`SUBAGENT_TIMEOUT_MS = 10 * 6e4`，`1954`）、abort 信号接线（`2040-2043`）、
并发排队（`2070-2080`）。**「每个模型各起一个宿主、各收一条回复」需要的零件这里全套都有。**

**② `spawnMember(deps, input, hooks)` —— `command-exec.js:2274-2407`。**
比子代理多：`onEvent` 把成员事件转发给 UI（`2310`）、`settleRound` 的轮级收尾
（`2360-2381`）、以及返回一个可唤醒的句柄（`2388-2406`）。

两者共用同一份工具装配 `buildSubagentExtensions`（`command-exec.js:2331`，定义在同文件）。

**③ 自动化 run 执行器 —— `createAutomationRunExecutor`，`session-files.js:943-1011`。**
形态最简：建宿主 → `host.prompt(task.prompt)` → `finally { host?.dispose() }`。

**没有**一个被 export 的、名字就叫「跑一轮临时会话」的通用函数
（`grep -rn "runOne\|runEphemeral\|askOnce" src/main/daemon/` 无对应导出）。

### B6. 这些会话是可见的还是隐藏的

**隐藏**（不进侧栏），判据是会话文件头部的 custom 条目：

```js
// src/main/daemon/session-files.js:1321
const CHILD_SESSION_CUSTOM_TYPES = /* @__PURE__ */ new Set(["subagent_run", "team_member"]);
```

标记由宿主在**建好后、prompt 前**写下：

```js
// src/main/daemon/session-host.js:473-483
  markSubagentRun(agentName) {
    this.session.sessionManager.appendCustomEntry("subagent_run", { agent: agentName });
  }
  ...
  markTeamMemberRun(memberName) {
    this.session.sessionManager.appendCustomEntry("team_member", { member: memberName });
  }
```

**顺序是硬约束**：扫描只看文件头、遇到第一条 `message` 就停：

```js
// session-files.js:1352-1376
    const buffer = Buffer.alloc(Math.min(SESSION_HEAD_BYTES, size));   // SESSION_HEAD_BYTES = 64*1024 (1325)
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    for (const line of buffer.toString("utf8", 0, bytes).split("\n")) {
      ...
      if (record.type === "custom") { ... markers.childSession = true; ... continue; }
      if (record.type === "message") break;
    }
```

过滤点在 `isInternalSessionFile`（`session-files.js:1385-1389`）→ `listSessions`（`3343-3345`）
与资料库（`4115`）都用它。

**但「隐藏」≠「看不见」**：渲染层靠事件缓存能把成员会话**显示在主聊天区**：

```js
// src/renderer/src/app.js:69017-69027
const focusMember = reactExports.useCallback(
  (memberSessionId, memberName) => {
    const returnTo = visibleSessionIdRef.current;
    if (!restoreFromBucket(memberSessionId)) {
      showToast(`成员「${memberName}」还没有产生消息，稍后再看`);
      return;
    }
    setMemberFocus({ sessionId: memberSessionId, name: memberName, returnTo });
  },
  [restoreFromBucket, showToast]
);
```

成员视图的入口在 `ChatView` 的 `memberView` 分支（`app.js:32957-32965` 的
`.member-focus-bar`「返回主会话」），事件来源是 `emitMemberEvent`。
**注意 `restoreFromBucket` 只认 `viewCacheRef`**；走 `INVOKE.snapshot(sessionId)` 是**查不到的**：

```js
// session-files.js:3727-3734
  [INVOKE.snapshot]: async ([sessionId]) => {
    if (sessionId === void 0) return currentBucket.conversation;
    const bucket = bucketsById.get(sessionId);
    if (bucket === void 0) {
      throw new Error(`会话未在 daemon 打开（可能已被空闲回收）：${sessionId}`);
    }
    return bucket.conversation;
  },
```

**产物如何回到主会话**：**推模式已整体删除**，现在是拉模式（产出写进成员自己的会话文件即算交付）：

```js
// src/main/daemon/session-files.js:3056-3075（节选注释）
                   * **这里不再回投产出**。推模式的那套（markPendingDelivery →
                   * await 回投 → markDeliveryPending → queue_changed 销账）
                   * 已整体删除 … 拉模式把这件事从根上绕开了：产出写进
                   * 成员会话 JSONL 的那一刻**交付就已经完成**…
                   * 因此这里只剩下「如实记账 + 刷界面」：
                   *   ① recordCompletion  ② markStatus  ③ emitTeamProgress
```

`mailbox.js` 仍在，但只剩 `deliverSessionMessage`（`session-files.js:2194-2231`）这条
「往某个会话发消息」的入口；`teams.js:8` 的 `composePendingTeamOutput` 是拉模式下的
提示词拼装。

### B7. 判断：复用 teams/subagent 链 vs 新写并行编排

**判断：新写一个编排模块（约 250–400 行），复用它俩的 `SessionHost.create` + 事件闭包骨架，
但不要塞进 teams。**

依据：

- **可复用的部分**（子代理 runner 里，`command-exec.js:1960-2085`）：
  并发闸 + 队列、每个模型一个宿主、`assistant_done` 收文本、超时、abort、`finally dispose`。
  这些是「并行发 N 次请求」的全部骨架，与团队语义无关。
- **不该复用的部分**：`TeamRegistry`（`teams.js:74-430`）是完整状态机 —— 建团/解散、
  成员名唯一性与 `@` 寻址、计划审批（`reviewPlan`）、任务板、落盘恢复
  （`restoreTeam` 的三种终态派生）。对比功能一个都用不上，硬塞进去等于为一屏对比
  背上「成员名冲突」「计划待审」「进程重启后成员需重建」这些状态语义。
- **`spawnMember` 的额外复杂度也大多用不上**：`settleRound` + `deliveredOutput` 的轮级
  收尾是为「可唤醒的长会话」设计的（`command-exec.js:2360-2381`）；对比是**一问一答即弃**。
- **成本对比**：子代理 runner 本体约 125 行（1960–2085）就覆盖了对比所需的执行骨架；
  而把它改造成「可被对比复用」所需的抽参数（modelKey 列表、事件 tag）与其新写量同阶。
  子代理 runner 本身也不是通用导出（它是 `createSubagentRunner(deps)` 的闭包），
  复用它意味着要么改它的签名、要么复制它的骨架。

---

## C. 界面上放哪儿

### C8. 现有视图清单与侧栏导航

`view` 的全部取值（`useState` 初值 + 全部 `setView` 调用点）：
`"home"`（初值，`app.js:68496`）、`"chat"`、`"skills"`、`"settings"`、`"diagnostics"`、
`"stats"`、`"automations"`、`"library"`。
渲染分支集中在 `app.js:69703-69735`；另有 `returnView` 用于「返回上一视图」
（`app.js:68497`）。`settingsPage` 是设置页内的二级页（`app.js:68498`，取值见
`NAV_ITEMS`，`app.js:65312`）。

侧栏主导航（**只有 3 项可用**）：

```js
// src/renderer/src/app.js:13260-13267
const NAV_ITEMS$1 = [
  { icon: IconAssistant, label: "助理", ready: false },
  { icon: IconProject, label: "项目", ready: false },
  { icon: IconSkill, label: "专家·技能·连接器", ready: true },
  { icon: IconAutomation, label: "自动化", ready: true },
  { icon: IconLibrary, label: "资料库", ready: true },
  { icon: IconMore, label: "更多", ready: false }
];
```
（`ready: false` 的项 `onClick` 走 `onTodo` 弹「待做」toast；见 `app.js:69359` 附近注释。）

**三个候选位置，事实层面的差异：**

| 位置 | 落点 | 代价 |
| --- | --- | --- |
| 新视图 `view === "compare"` | 加一个 `NAV_ITEMS$1` 项 + 一个渲染分支（`app.js:69735` 后） | 与 `chat` 平级，**不能用会话的输入卡/侧栏上下文**；需要自己一块输入区 |
| **会话内的一种模式**（输入卡上一个入口，展开成右侧让位栏或全宽列阵） | `Composer` 的 `children`/`trailing`（`app.js:16309-16357` 与 `33120-33145`） | 复用现成的会话上下文（cwd / 模型菜单 / @ 引用）；但要决定「面板 vs 全宽」 |
| 新面板内容 `panelContent === "compare"` | `app.js:68792-68801` + `69742-69782` | 复用 .panel-slot 的宽度机制（已有受控例外 ③），但栏宽默认可容纳的列数有限（需全屏才够 3–4 列） |

### C9. 输入卡的模型选择菜单

**`ModelMenu` —— `src/renderer/src/app.js:14980`。** 是**单选**：菜单项点击直接
`setModel(key)` 并关闭菜单：

```js
// app.js:15014-15022
  const pick = reactExports.useCallback(
    (key) => {
      setOpen(false);
      window.kami.setModel(key).catch((error2) => {
        onError(error2 instanceof Error ? error2.message : String(error2));
      });
    },
    [onError]
  );
```

菜单项列表（可改成多选的落点）：

```js
// app.js:15086-15090
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "model-menu-list", children: available.map((model) => {
          const key = `${model.providerId}/${model.id}`;
          const active = key === modelId;
          return /* @__PURE__ */ jsxRuntimeExports.jsxs(
```

可用性过滤：`const available = (snapshot?.models ?? []).filter((m) => m.available);`（`app.js:15034`），
数据源 `window.kami.settingsSnapshot()`（`15004`）→ daemon `ModelCatalog.snapshot`
（`model-catalog.js:64-81`），其中 `available` 由 `configuredProviders` 决定
（`model-catalog.js:207`）。

**挂载点两处**：`HomeView`（`app.js:16322`）与 `ChatView`（`app.js:33130`），
都以 `trailing` 传入 `Composer`（`Composer` 接受 `trailing` 的位置见 `app.js:14678-14695`）。
设置页另有独立组件 `ModelPicker`（`app.js:63973`，用于自定义 provider 的模型表单）。

`ModelMenu` 还有推理档位子菜单（`pickThinkingLevel`，`app.js:15023-15032`）与
`THINKING_LEVEL_LABELS`（`15035-15037`）—— **多选改造要顺带决定档位怎么办**
（各列不同档位 / 统一档位）。

### C10. 右侧面板的三种内容与宽度机制

```js
// app.js:68788-68801
  const [panelOpen, setPanelOpen] = reactExports.useState(false);
  const [taskDiagOpen, setTaskDiagOpen] = reactExports.useState(false);
  const [sourcesOpen, setSourcesOpen] = reactExports.useState(false);
  const panelOccupied = taskDiagOpen || panelOpen;
  const panelKind = taskDiagOpen ? "diag" : sourcesOpen ? "sources" : "artifact";
  const [panelContent, setPanelContent] = reactExports.useState(void 0);
  reactExports.useEffect(() => {
    if (panelOccupied) { setPanelContent(panelKind); return; }
    const timer = window.setTimeout(() => setPanelContent(void 0), PANEL_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [panelOccupied, panelKind]);
```

`panelContent` 是 `"diag" | "sources" | "artifact" | undefined` 的**三值联合**
（渲染：`app.js:69742-69782`）；`revealPanel` 保证互斥（`app.js:68952-68956`）。

宽度由 TSX 内联 style 驱动，元素是 `.panel-slot`：

```js
// app.js:69736-69741
    view === "chat" && /* @__PURE__ */ jsxRuntimeExports.jsx(
      "div",
      {
        className: "panel-slot",
        "data-collapsed": !panelOccupied,
        style: { width: panelOccupied ? `calc(${panelWidth}px + var(--space-2))` : 0 },
```

**受控例外 ③ 是按「元素 + 属性」登记的，不是按内容**：

> | ③ | `width` 过渡 —— 右侧栏开合与全屏（`.panel-slot`、`.preview-panel`） | … `.panel-slot` 是常驻的动画载体（面板本体条件挂载，挂载即终态、没有起点可跑），宽度由 TSX 内联 style 驱动 … |
> —— `docs/DESIGN.md:215`

所以**在 `.panel-slot` 里放第 4 种内容是加一个三元分支，不需要新例外**；
而**新造一个会过渡 `width`/`height` 的布局元素（例如可收起的 N 列栅格）会需要新编号**，
且要过机械校验：`scripts/check-design-exceptions.mjs`（`package.json` 的
`check:design-exceptions`）。

### C11. 消息流的渲染入口 —— 并排展示要改到哪一层

`ChatView` 的投影链（`app.js:32594-32600`）：

```js
  const entries = reactExports.useMemo(() => projectTodoList(conversation.entries), [conversation.entries]);
  const sources = reactExports.useMemo(() => collectSources(entries), [entries]);
  const changeCount = reactExports.useMemo(() => collectChanges(entries).length, [entries]);
  const turnViews = reactExports.useMemo(
    () => buildTurnViews(entries, { streaming, cancelledTurns: conversation.cancelledTurns }),
    [entries, streaming, conversation.cancelledTurns]
  );
```

渲染时逐 turn 出一块（`app.js:32969-33013`），并给最后一个 turn 挂流式尾巴
（`turnViews.length === 0 && streamTail`，`app.js:33013`）。

**结论**：`buildTurnViews`（`app.js:30674`）与它下游的 turn 渲染组件都是
**对单个 `conversation` 对象的纯投影** —— 只要能把「第 i 列的那份 conversation」
喂进去，无需改动这一层。**要改的是「谁持有 conversation」这一层**：
今天只有 `App` 里那一个 `useReducer` 是响应式的（`app.js:68487-68490`），
其余会话存在 `viewCacheRef`（**ref，不触发重渲染**，`app.js:68491`、`68572`）。
N 列同时流式 ⇒ **必须新加一个 state 容器**（例如 `Map<columnId, ConversationView>`
的 state，或 N 个独立 reducer），否则并排的第二列不会随事件重渲染 ——
这一条是本功能在渲染层最主要的真实工作量。

---

## D. 数据与持久化

### D12. 会话 `.jsonl` 的条目形状

**消息条目**：`{ type: "message", id, parentId, timestamp, message: { role, content, usage? } }`，
`role ∈ user | assistant | toolResult`：

```js
// src/main/daemon/session-view.js:724-762（节选）
function buildConversationEntries(entries, resolveToolLabel) {
  const results = /* @__PURE__ */ new Map();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    if (entry.message.role === "toolResult") results.set(entry.message.toolCallId, entry.message);
  }
  ...
    if (message.role === "assistant") {
      const thinking = thinkingOf$1(message.content);
      const assistant = {
        id: entry.id, role: "assistant", text: textOf$1(message.content),
        ...thinking === "" ? {} : { thinking },
        ...message.usage === void 0 ? {} : { usage: toTokenUsage(message.usage) },
        at
      };
```

**custom 条目**：`{ type: "custom", customType, data }`（`library.js:66`、
`session-files.js:677`、`session-view.js:791`）。项目已用的 customType：
`subagent_run`、`team_member`、`automation_run`、`artifacts_presented`；
另有 `type === "custom_message"`（参与 LLM 上下文、带 `display` 标志，
见 `command-exec.js:1593` 与 `session-host.js` 的 hidden context 通道）。

**把「同一轮的 N 个答案」落盘的三条路，现状能力：**

| 方案 | 现状支持 | 依据 |
| --- | --- | --- |
| **(a) 每列本来就是一个真会话**（各自 `SessionManager.create(cwd, getSessionsDir())`，文件落在 sessions 目录） | **开箱即用，零新增** | `session-host.js:252` |
| **(b) 往当前会话追加一条 assistant 条目** | pi 有公开 API：`SessionManager.appendMessage(message): string` | `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts:256`（另有 `appendCustomEntry` :266、`appendCustomMessageEntry`） |
| **(c) 把某列会话文件抽枝成新会话** | 现成的文件级原语 | `extractBranchFile(motherPath, entryId)` —— `session-files.js:3594`；`materializeBranch` :3615；`createEmptySessionFile` :482 |

**(b) 有两处要留意（研究结论，不是实现建议）：**

1. **单写者纪律**（既有注释）：

```js
// src/main/daemon/session-host.js:449-452
   * 必须走本实例持有的活 SessionManager：pi 的 SessionManager 各自缓存
   * entries，同一文件出现两个活写者会互相覆盖。非当前会话的重命名
   * 由 daemon 临时 open 一个实例完成（用完即弃，不注册到任何地方）。
```

2. **追加的 assistant 条目没有配对的 user 条目**：轮切分以 `user` 消息 id 为键
   （`session-state.js:436-439` 的 `lastTurnId`、`app.js:30674` 的 `buildTurnViews`），
   一条孤儿 assistant 条目在时间线上的归属需要单独确认。
   **未实测**：`appendMessage` 之后**下一轮 LLM 请求是否包含该条目**（取决于 pi
   的 agent-session 是否每轮重读 `buildContextEntries()`）—— 本次调研只读了类型定义，
   没有跑验证。

### D13. 「收进会话」可复用的既有能力

| 能力 | 位置 | 语义 / 前置条件 |
| --- | --- | --- |
| `restartSession(path, userIndex, options)` | `session-files.js:3635` | 「回退到这一轮之前」，会先抽枝再截断母文件。**要求 `findBucketByFile` 命中且 `!bucket.running`**（3638-3639），且进 `enqueue(bucket, ...)` 串行链 |
| `forkSession(path, userIndex, options)` | `session-files.js:3684` | 「从锚点派生新会话」（`options.includeTurn` 控制含不含该轮）。同样要求桶且不忙（3687-3688） |
| `extractBranchFile(motherPath, entryId)` | `session-files.js:3594` | **纯文件级**：从 `motherPath` 抽出到 `entryId` 的前缀，造一个新的会话文件（含 `parentSession` 回写，3612）。**不要求 bucket** |
| `createEmptySessionFile(cwd, parentSession)` | `session-files.js:482` | 只写头部 |
| IPC 出口 | `INVOKE.sessionRestart` / `INVOKE.sessionBranch` —— `session-files.js:4167-4168`；preload `restartSessionFrom` / `branchSessionFrom`，`src/preload/index.js:602-603` | 渲染层已有调用面（`onRestartFrom` / `onBranchFrom` / `onBranchFromAnswer`，`app.js:32469-32471`） |

**分支的渲染层入口已经存在**（每个 turn 上的「从这里分支 / 重新开始」），
`ChatView` 收 `branchAvailable` / `onRestartFrom` / `onBranchFrom` / `onBranchFromAnswer`
（`app.js:32468-32471`），可用性由 `branchReady = branchAvailable && !streaming`
（`app.js:32607`）统一闸住。

---

## E. 测试可行性

### E14. e2e 怎么同时起两个不同端口的 mock 模型服务

**参数与返回契约**（`tests/e2e/mock-model-server.mjs:44`、`138-150`）：

```js
export function startMockModelServer({
	reply = "这是 mock 模型的回复。",
	toolCall = false,
	port = 0,                      // ← 0 = 随机端口
	models = ["mock-model"],
	modelsEmpty = false,
	modelsAuthRequired = false,
} = {}) {
	/** 收到的所有「非 /models」请求，供测试断言。语义与本次改动前一致 */
	const requests = [];
	/** 只收 `GET …/models` 的探测请求。… 请求账本两本，分开记 */
	const probeRequests = [];
```
```js
	return new Promise((resolve) => {
		server.listen(port, "127.0.0.1", () => {
			resolve({
				port: server.address().port,
				baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
				requests,
				probeRequests,
				modelIds,
				close: () => new Promise((r) => server.close(r)),
			});
		});
	});
```

**结论**：`startMockModelServer({ reply: "A" })` 与 `startMockModelServer({ reply: "B" })`
两次调用各自 `port: 0` → 两个不同随机端口、**两本独立的 `requests`**，
所以「哪一列收到了自己的回复」可以用「各自 mock 的 `requests` 有请求 + 时间线上两个不同文本」
双向断言。**今天没有任何用例同时起两个 mock**（`grep -rn "startMockModelServer(" tests/e2e/*.mjs`
每条用例最多一次），但这只是没人写过，机制上没有障碍。

**注册两个 provider 的现成写法**（`tests/e2e/model-roundtrip.mjs:99-131`）：

```js
await h.check("注册自定义 provider 指向 mock 服务", async () => {
	const r = await win.evaluate(
		async ({ id, baseUrl, apiKey }) => {
			const k = globalThis.kami;
			try {
				await k.saveCustomProvider(
					{ id, name: "E2E Mock", baseUrl, api: "openai-completions",
					  models: [{ id: "mock-model", name: "Mock Model", reasoning: false, vision: false,
					             contextWindow: 128000, maxTokens: 4096 }] },
					apiKey,
				);
				return { ok: true };
			} catch (e) { return { ok: false, err: String(e?.message ?? e).slice(0, 200) }; }
		},
		{ id: PROVIDER_ID, baseUrl: mock.baseUrl, apiKey: "sk-e2e-dummy" },
	);
```
（同一个 provider 的多模型走 `models: [...]` 数组；两个**不同回复**需要两台 mock、两个 provider id。
`apiKey` 还要经 `setApiKey`（`model-roundtrip.mjs:141-154`），否则
`catalog.isUsable()` 为 false，`setModel` / 建宿主会报「已不可用」。）

### E15. 有没有「并行/流式同时进行」的断言先例

**没有找到「同时等两个条件成立」的现成先例**（`grep -n "Promise.all" tests/e2e/*.mjs` 无命中，
`team-create.mjs` 是**串行**多条 `waitUntil`：先等成员那一轮 `:330`，再等注入 `:416`，
再等领导读到产出 `:449`）。

**但机制上完全支持**：`waitUntil(fn)` 返回谓词的真值，且超时会带上描述：

```js
// tests/e2e/lib/harness.mjs:157-171
export async function waitUntil(fn, { timeout = 30_000, interval = 250, desc = '条件' } = {}) {
	const deadline = Date.now() + timeout;
	let lastError = null;
	while (Date.now() < deadline) {
		try { const value = await fn(); if (value) return value; } catch (error) { lastError = error; }
		await new Promise((r) => setTimeout(r, interval));
	}
	throw new Error(`等待超时 ${timeout}ms：${desc}${lastError ? `（最后一次尝试抛出：${lastError.message}）` : ''}`);
}
```

因此「两列同时在流式」可以写成组合谓词 `() => colA.requests.length > 0 && colB.requests.length > 0`
（**注意规范要求谓词必须能返回假值**，`.trellis/spec/testing/index.md:90`），
或用 `await Promise.all([waitUntil(a), waitUntil(b)])`。

---

## 相关 Spec / 文档

| 文档 | 与本功能相关的内容 |
| --- | --- |
| `.trellis/spec/daemon/index.md:71-91` | 「数据流与顺序契约」：**界面数据是投影**、**落盘先于界面更新** |
| `.trellis/spec/daemon/index.md:31-44` | 初始化顺序 / TDZ：新增顶层跨模块引用要跑 `npm run check:daemon-graph` |
| `.trellis/spec/guides/index.md:29-42` | **改一个 IPC 通道要动四处**（shared / preload / main 路由 / 消费方），preload 是手工副本 |
| `.trellis/spec/guides/index.md:62-73` | 三条不得破坏的契约（同上两条 + 权限判定在 daemon 侧） |
| `.trellis/spec/guides/index.md:104-121` | **警惕重复：先搜再写**（`startMockModelServer` 曾被内联重写 6 遍） |
| `.trellis/spec/renderer/index.md:20-42` | chunk 粒度、产物命名契约（改渲染层不能大范围重排） |
| `.trellis/spec/renderer/index.md:53-83` | 设计 Token 档位纪律 |
| `.trellis/spec/testing/index.md:24-67` | e2e 骨架一律来自 `tests/e2e/lib/harness.mjs` |
| `.trellis/spec/testing/index.md:70-120` | **用信号等待不用 sleep；谓词必须能返回假值** |
| `.trellis/spec/testing/index.md:144-179` | 等到条件 A 之后不要立刻断言副作用 B |
| `.trellis/spec/testing/index.md:280-289` | **不在 CI 里跑的测试等于没有测试**（`package.json` 的 `test:gui` 汇总要加新用例） |
| `docs/DESIGN.md:193-225` | §5 受控例外 ③（`.panel-slot` 的 `width`）+ §5.1 禁止过渡布局属性 |
| `AGENTS.md` 红线 1/4/5/6/8 | 表达式注入、不放宽沙箱、`resources/**` 不套工具链、不大规模重排、凭据不进代码 |
| `docs/ARCHITECTURE.md` | 进程模型与「一条消息的生命周期」（本次未逐节核对） |

---

## Caveats / 没找到的东西

**明确「没找到」的（附检索词）：**

1. **没有任何既有的多模型 / 对比 / 并排实现**。检索词：`多模型`、`一问多答`、
   `multiModel`、`multi-model`、`compare`（在 `src/` 与 `docs/`、`.trellis/spec/`、`CHANGELOG.md`、
   `README.md` 中）；`src/` 内 `compare` 的命中全部是 React 调度器的排序函数
   （`app.js:447/558/573`）与 CSS 注释，**零业务命中**。这是全新功能。
2. **没有一个被 export 的「跑一轮临时会话」通用函数**（见 B5）。检索词：
   `runOne`、`runEphemeral`、`askOnce`、`createSubagentRunner`、`spawnMember`。
3. **没有「等待 N 个条件同时成立」的 e2e 先例**（见 E15）。
4. **没有针对多会话并行的用量归属测试**。检索词：`currentRun`、`observability.record`
   在 `tests/` 下的引用 —— 无。

**未实测、需要动手前验证的：**

- `SessionManager.appendMessage()` 之后，**下一轮 LLM 请求是否包含该条目**
  （本次只读了 `session-manager.d.ts:256` 的类型与注释，没有跑验证）。
- 一条**没有配对 user 消息**的 assistant 条目，在 `buildTurnViews`
  （`app.js:30674`）里会落到哪个 turn（只确认了轮切分以 user 消息 id 为键，
  没有实测孤儿条目的渲染结果）。
- **N 个模型并发建宿主的实际耗时**：`SessionHost.create` 每个都要
  `await import(pi)` + `DefaultResourceLoader.reload()` + `createAgentSession`
  （`session-host.js:221-267`）。没有实测 4 个并发的首字延迟代价
  （子代理 runner 的 `MAX_CONCURRENT = 4` 只说明这是被允许的上限，不含耗时数据）。
- 本次**未读**的模块（如确实需要可再调研）：`runtimes.js`（2195 行，托管运行时）、
  `session-files.js` 的其余大段（5309 行，只读了 A/B/D 相关约 400 行）、
  `src/main/index.js`（IPC 路由细节只看了 `push` 分支 `194-196`）。

**已知的口径细节（不是问题，是纪律）：**

- `src/renderer/src/app.js` 与 daemon 侧的 `session-state.js` 是**两份手工同步的
  reducer 镜像**（`app.js:12650` vs `session-state.js:453`）。新增事件类型必须两处都改。
- preload 的 `INVOKE` / `PUSH` 表是**手工副本**（`.trellis/spec/guides/index.md:38-42`），
  由 `tests/unit/ipc.test.mjs` 的「逐条一致」断言兜住。
- **`push` 帧不需要在 `src/main/index.js` 注册**：

```js
// src/main/index.js:194-196
      case "push":
        send(frame.channel, frame.payload);
        return;
```
  即 daemon 可以往任意通道推 —— 新增一条 PUSH 通道的成本是
  `shared/ipc.js` + `preload/index.js` 两处常量 + 一条 `onXxx` 暴露 + 单测的通道唯一性。

---

## 结论：成本与风险

### 可行吗？

**可行，且有前提。** 前提三条：

1. **并行的执行骨架已经是既成事实**（`activeHosts: Set`，`command-exec.js:1975`；
   团队 8 成员、子代理并发 4），所以「同时跑 N 个模型」在 daemon 侧不是新能力，
   只是把现有零件换个装配。
2. **但必须绕开 `emitSessionEvent`**（理由见坑 ①）。绕开之后本功能对默认路径
   是**纯增量**：不碰 `currentBucket`、不碰 `bucket.hostPromise`、
   不需要动 `SessionHost.prompt` / `translate` 的任何一行。
3. **渲染层要新加一个 state 容器**（理由见 C11）：今天只有一份 conversation 是
   响应式的，`viewCacheRef` 是 ref。这是本功能**唯一无法靠「复用」解决**的部分。

### 最小可用形态

**先做「A 半：一屏 N 列并行流式 + 各自耗时/用量」，不做「收进会话」。**

理由：A 独立成立（探索同一问题的模型差异本身就是价值），而 B 在 A 之上才是可用的
（没有 A，「收进」没有对象）。B 的最省做法已存在现成原语（`extractBranchFile`，
`session-files.js:3594` —— 把选中那一列的会话文件抽枝成新会话并 `setCurrentBucket`），
所以 B 是 A 之后的薄增量，适合放第二批。

具体落点（成本从低到高）：

- **最小切片**：daemon 侧新编排模块（照 `createSubagentRunner` 骨架）+ 一条新 PUSH 通道
  （不走 `sessionEvent`）+ 渲染层一个新面板内容 `panelContent === "compare"`
  （复用 `.panel-slot` 的宽度机制与受控例外 ③，**零新设计例外**）。
  列数受栏宽限制，需要全屏（`panelFullscreen`，`app.js:69773/69775`）才能舒服地放 3–4 列。
- **稍大一点**：独立 `view === "compare"` 全屏视图 —— 列宽不受限，但要自备输入区
  （拿不到 `ChatView` 的 cwd/@ 引用上下文）。

### 估计改动面

| 文件 | 改什么 | 估计行数 | 风险 |
| --- | --- | --- | --- |
| **新** `src/main/daemon/*.js`（对比编排） | 建 N 宿主、并发闸、按列 tag 事件、收尾 dispose | **250–400** | 低（新文件，不碰默认路径） |
| `src/main/daemon/session-files.js`（**5309 行，daemon 的枢纽**） | 注册 2–3 条 INVOKE handler + 把 deps（catalog / getModelKey / permissions / extensions / resources）喂给编排模块；`CHILD_SESSION_CUSTOM_TYPES`（:1321）加一个标记类型 | **60–120** | **中**——这是 daemon 唯一的大枢纽文件，且顶层求值顺序敏感（`spec/daemon/index.md:31-44`） |
| `src/main/daemon/session-host.js`（**1462 行，核心运行循环**） | 最可能只加一个 `markCompareRun(...)` 式的标记方法（照 `markSubagentRun`，:473）；**不必改 `prompt` / `translate` / `ablate` 的任何逻辑** | **0–10** | **低**，前提是坚持「用 `options.emit` 闭包」而不是「复用 `emitSessionEvent`」 |
| `src/shared/ipc.js` | 2–3 条 INVOKE + 1 条 PUSH 常量（带文档注释，本文件注释密度高） | **20–40** | 低（有单测兜底） |
| `src/preload/index.js` | 手工副本两表 + `onCompareEvent` 暴露 | **10–20** | 低 |
| `src/renderer/src/app.js`（**69943 行，单文件渲染层**） | ① N 列 conversation 的 state 容器 + `onCompareEvent` 订阅；② 对比视图组件（逐列复用 `buildTurnViews`，:30674）；③ `ModelMenu` 多选改造（:14980-15090）；④ 输入卡入口；⑤ 视图/面板路由（:68792-68801、:69735） | **400–800** | **中高**——文件巨大，且有「不得大规模重排」的红线（`AGENTS.md` 红线 6）；新代码应尽量落在**新文件**（如 `src/renderer/src/compare-view.js`），app.js 只留挂载点 |
| `src/renderer/src/compare-view.js`（**建议新建**） | 面板/视图本体、逐列渲染、耗时与用量的本地累计 | **250–450** | 低 |
| `tests/e2e/<new>.mjs` | 两台 mock（不同 `reply`）+ 两个 provider + 断言两列各自收到自己的回复 | **250–350** | 低（骨架现成） |
| `package.json` | `test:gui` / `test:gui:xxx` 加一条（否则等于没有测试，`spec/testing/index.md:280`） | **2** | 低 |
| `CHANGELOG.md` | 「新增」一条 | **3–6** | 低 |
| 可能：`docs/DESIGN.md` §5 | **仅当**新造了会过渡 `width`/`height` 的布局元素 | **0 或 +1 条例外** | 低，但**绕开更划算** |

**总量级：约 1000–1600 行、6–10 个文件**，其中 `session-host.js` 基本不动 ——
这对「默认路径一字不改」是很有利的形状。

**动核心的风险写明**：`session-host.js` 是「一轮对话」的唯一适配层，
它的注释反复强调「pi 升级只塌这一个文件」。**唯一会真正伤到默认路径的做法是**
把对比会话接到 `emitSessionEvent(bucket, event)`（看起来最省事：事件、归约、
渲染全都白拿）。这条路会同时触发坑 ①②③，见下。

### 三个最容易踩的坑

**坑 ①（最危险）用量统计串台 —— `ObservabilityStore.currentRun` 是单槽。**

`observability.js:162` 是**一个字段**，`run_started` 无条件覆写（:409）、
`assistant_done` 归属「最后一个 run_started 的会话」（:418）、
`finishRun` 无条件清空（:482）。N 列并行时：后起的列会抢走先起列的用量归属；
**先收尾的那一列会把另一列的 run 卡永远留在 `status: "running"`**
（`endedAt` 永远 undefined）—— 而这正好出现在「比较用量」这个功能自己的面板上。
今天的并行宿主不触发它，**只因为成员/子代理都绕开了 `emitSessionEvent`**（:2380）。

**规避不是「加锁」，而是不走那条路**：对比列的事件走**专用 PUSH 通道**，
耗时与用量在**渲染层的每列 conversation 内自算** —— 数据源头本来就在事件里：
`assistant_done.message.usage`（`session-host.js:988` 的 `toTokenUsage`）
与 `turnTimings`（`session-state.js:441/532`，按列各自一份）。
代价：对比列没有 `session_stats` / `context_usage` / 诊断面板。

**坑 ②流式事件串台 + 全局副作用** —— 若复用 `PUSH.sessionEvent` 且信封里塞
「对比会话的真 sessionId」，渲染层的 `onSessionEvent` 会把它当**后台会话**
折进 `viewCacheRef`（`app.js:68555-68572`，**ref，不重渲染**）→ 症状是「跑完了、
屏幕上一动不动」；同时 `emitSessionEvent` 里那几处全局副作用会对每一列各跑一次：
`pushTaskListChanged()` 与 `evictIdleHosts()`（`session-files.js:1883-1886`）、
`teamRegistry.settleRunningMembers`（:1889）、`emitSessionStats`（:1902）。
`evictIdleHosts` 会真的 `dispose` 掉别的桶的宿主（:1716-1724）——
这是「看起来只是多发了几次请求」的改动最容易伤到默认路径的地方。

**坑 ③渲染层的响应式容器** —— 见 C11：`viewCacheRef` 是 `useRef`，
后台会话的事件**不会重渲染**。N 列要同时跳字，必须新增 state 容器。
若图省事「只显示最后一列/轮询切换」，那等于没实现「并排流式」这条验收标准。

**（补充）坑 ④ 资源与预算**：`SessionHost.create` 建宿主是重活
（`await import(pi)` + `DefaultResourceLoader.reload()` + `createAgentSession`，
`session-host.js:221-267`）；`spawnBudget` 是**按桶计**的（`SPAWN_BUDGET_PER_SESSION = 20`，
`session-state.js:703`），子代理与团队成员都从同一份扣（`session-files.js:3012/3040`）。
对比若不另立预算，会与委派/建团**抢同一份额度**；若复用那份额度，
用户跑几轮对比就再也建不了团。且对比宿主**不在 `bucketsById` 里**
⇒ `pickEvictions`（`session-state.js:739`）不会回收它 ⇒ **必须像子代理那样在
`finally` 里显式 `dispose`**（`command-exec.js:2065-2068`）。

**（补充）坑 ⑤ 权限审批的归属**：对比会话是**有人在看**的，与无人值守不同。
`spawnMember` 把成员 sessionId 包进 `requestApproval`（`command-exec.js:2344`：
`requestApproval: (request) => deps.requestApproval(request, sessionIdRef.current)`），
而自动化 run 会话是 `unattended: true` 直接拒绝（`session-files.js:1027-1032`）。
对比列若忘了这层归属，审批弹窗会指向错误或缺失的会话。

### 明确「不建议做」的部分

1. **不要把对比会话注册进 `bucketsById`**。理由：桶的生命周期带着一整套副作用
   ——`evictIdleHosts`、`disbandTeamOf`、`backgroundJobs.killAllForSession`、
   `pushTaskListChanged`、`listSessions` 的 pending 分支（`session-files.js:1715-1725`、
   3347-3376）。为了「让 `INVOKE.snapshot(sessionId)` 能查到」而付这些代价不划算，
   而且会让对比会话出现在侧栏/资料库里。
2. **不要在对比列上复用 `PUSH.sessionEvent`**。理由见坑 ①②；
   新 PUSH 通道的成本只有两处常量 + 一个 `onXxx`（`src/main/index.js:194-196`
   对 push 是通配转发，无需注册）。
3. **不要把「多选模型」做进全局的 `setModel` 语义里**。`ModelMenu.pick`
   （`app.js:15014-15022`）直连 `window.kami.setModel(key)`，那是**会话级单模型**
   的权威写入点（`session-host.js:526-531`）。多选应当是一个**独立的对比入参**，
   否则会污染默认路径的模型状态。
4. **不要为对比视图新造带 `width`/`height` 过渡的布局元素**。`docs/DESIGN.md:215`
   的例外 ③ 已经覆盖 `.panel-slot`；新造一个可收起的多列栅格会需要新编号，
   并触发 `scripts/check-design-exceptions.mjs` 的机械校验。
5. **不要走 `restartSession` / `forkSession` 来「收进会话」**（作为第一版）。
   二者都要求 `findBucketByFile(path)` 命中且 `!bucket.running`
   （`session-files.js:3638-3639`、3687-3688），还要进 `enqueue` 串行链 ——
   对「把某个对比列收进当前会话」这个意图，`extractBranchFile`（纯文件级、
   不要求桶、:3594）是更小的原语。