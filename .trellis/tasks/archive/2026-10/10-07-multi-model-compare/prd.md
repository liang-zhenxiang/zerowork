# 一问多答：多模型并排对比

> 可行性依据见 `research/feasibility.md`（逐条 `file:line`，含成本与三个坑）。
> 视觉规范见 `research/design-spec.md`（设计师产出）。
> 本文件只保留**结论、范围与验收标准**。

## Goal

**同一个问题，并行问 2–4 个模型，在同一屏里并排看它们怎么答 —— 各自计时、各自算用量。**

这是同类产品里**最有「第一眼说服力」**的一条（Msty 的多模型分栏、Cherry Studio 的「一问多答」），
而本项目的定位（**支持任意 OpenAI 兼容端点、不被单一供应商绑定**）让它天然成立 ——
别的产品是在自己的模型列表里挑，我们是在**用户自己配的那些端点**里挑。

**默认路径一字不改**：单模型对话完全不受影响，这个功能是**纯增量**。

## 背景：已核实的事实（全部来自 `research/feasibility.md`）

### 事实 1：并行的执行骨架**已经是既成事实**

- `activeHosts: Set`（`src/main/daemon/command-exec.js:1975`）；团队 8 成员、子代理并发 4 已在跑
- 起一个临时会话、跑一轮、收结果的**全套零件**就在 `createSubagentRunner(deps)` 里
  （`command-exec.js:1960-2085`）：并发闸 + 队列、每模型一个宿主、从 `assistant_done` 收文本、
  超时、abort 接线、`finally { host.dispose() }`
- 把它做成对比只需要换装配：**modelKey 列表** + **事件按列打 tag**

→ 若照 `createSubagentRunner` 的骨架新写一个编排模块（250–400 行），
**`session-host.js` 几乎不用动**（最多加一个 `markCompareRun(...)`，照 `markSubagentRun` 的 10 行）。
这对「默认路径一字不改」是非常有利的形状。

### 事实 2【红线】不能复用 `emitSessionEvent` —— 它有三处会伤到默认路径

看起来最省事的路是「把对比会话接进 `PUSH.sessionEvent`，事件/归约/渲染全都白拿」。**这条路必须拒绝**：

1. **用量统计是单槽**：`ObservabilityStore.currentRun` 是一个字段（`observability.js:162`），
   `run_started` 无条件覆写、`assistant_done` 归属「最后一个 run_started 的会话」、`finishRun` 无条件清空。
   N 列并行时后起的列抢走先起列的归属，**先收尾的列会把别的列永远留在 `status: "running"`**
   —— 而这正好出现在「比较用量」这个功能自己的面板上。
2. **全局副作用会对每列各跑一次**：`pushTaskListChanged()`、`evictIdleHosts()`
   （`session-files.js:1883-1886`）、`teamRegistry.settleRunningMembers`、`emitSessionStats`。
   其中 **`evictIdleHosts` 会真的 dispose 掉别的桶的宿主**（`session-files.js:1716-1724`）。
3. **渲染层不会重渲染**：后台会话的事件被折进 `viewCacheRef`（**ref**，`app.js:68491/68572`），
   症状是「跑完了、屏幕上一动不动」。

→ **做法：对比列的事件走一条专用 PUSH 通道；耗时与用量在渲染层按列自算**
（数据本就在事件里：`assistant_done.message.usage`、`turnTimings`）。
代价是明说的：对比列**没有** `session_stats` / 上下文用量 / 诊断面板 —— v1 接受。

### 事实 3：渲染层必须新加一个 state 容器

今天只有 `App` 里那一个 `useReducer` 是响应式的（`app.js:68487-68490`），
其余会话存在 `viewCacheRef`。N 列**同时**跳字 ⇒ 必须为新视图加一个 state 容器。
这是渲染层最主要的真实工作量。

### 事实 4：不能把对比会话塞进 `bucketsById`，也不能塞进 teams

- 桶的生命周期带着一整套副作用（`evictIdleHosts` / `disbandTeamOf` / `backgroundJobs.killAllForSession` /
  `pushTaskListChanged` / `listSessions` 的 pending 分支）—— 为了「让 snapshot 能查到」付这些代价不划算，
  还会让对比会话出现在侧栏与资料库里
- `TeamRegistry` 是完整状态机（建团/解散、成员名唯一性、计划审批、任务板、落盘恢复），
  对比一个都用不上；硬塞等于为一屏对比背上「成员名冲突」「计划待审」这些语义
- **对比宿主必须像子代理那样在 `finally` 里显式 `dispose()`** —— 它不在 `bucketsById` 里，
  `pickEvictions` 不会回收它

### 事实 5：额度（spawnBudget）是按桶计的，对比必须另立

`SPAWN_BUDGET_PER_SESSION = 20`（`session-state.js:703`），子代理与团队成员从同一份扣。
对比若不另立预算，会与委派/建团抢额度 —— 用户跑几轮对比就建不了团。

## Requirements

### R1 对比编排（daemon 侧新模块）

新增 `src/main/daemon/compare.js`（名字待定），导出：

- `createCompareRunner(deps)`：照 `createSubagentRunner` 的骨架，但
  - 输入是**模型列表**（2–4 个 `modelKey`）+ 一条问题文本
  - 每个模型一个宿主，**并发**跑（并发上限 = 列数上限，另立额度，**不占 spawnBudget**）
  - 事件**按列打 tag** 后经 `deps.onEvent` 交给调用方 —— **不调用 `emitSessionEvent`**
  - 每列独立 `abort`；整体取消要能同时收掉所有列
  - **无论成功失败，`finally` 里显式 `dispose()` 每一个宿主**
- **纯逻辑部分必须可单测**：列状态归约（queued → running → done/failed/cancelled）、
  并发闸、`assistant_done` 文本与用量提取、耗时计算的口径

### R2 不做工具调用（v1 明确）

对比列**只回答，不跑工具**：

- 理由一：比的是「回答本身」，工具会把它搅浑
- 理由二：N 列并行跑工具 = N 份沙箱与文件写入副作用，**安全面直接放大**
- 实现上要如实做到：**不能只是「没给工具提示词」**，必须在装配层就不装扩展；
  若做不到干净地关掉，就在报告里说明并改用「只读」档（并在 UI 上写明）

### R3 一条专用 PUSH 通道 + 三条 INVOKE

- `PUSH.compareEvent` —— 形状要与 `sessionEvent` **区分开**（列 id + 列内事件），
  在 `src/shared/ipc.js` 里写清「为什么不复用 sessionEvent」（把事实 2 的三条理由写进注释）
- `INVOKE.compareStart` / `compareAbort` /（可选）`compareSnapshot`
- 命名与注释照既有约定（`/^[a-z-]+:[a-z-]+$/`、注释即契约）

### R4 渲染层：新的全屏「模型对比」视图

- 新文件 `src/renderer/src/compare-view.js`（**不要往 7 万行的 `app.js` 里堆**，
  `app.js` 只留挂载点 —— 照 `command-palette-core.js` / `session-pin.js` 的既有做法）
- 视图自备输入区：**一个问题 + 参与模型的多选**（2–4 个，下限 2、上限 4，超出要明确拒绝并说明）
- N 列并排：每列一个**独立的 conversation 状态**，逐列复用既有的消息渲染投影
  （`buildTurnViews` 是对单个 conversation 的纯投影，无需改动它）
- 每列**自算**耗时与用量（token / 输出长度），并在列头显示
- 三态互斥可辨（`docs/DESIGN.md` §4）：每列各自的 等待 / 流式中 / 失败 / 已取消
- **一列失败不影响其它列**（这是并行最容易被做错的地方，必须有断言）
- ⌘K 增加一条动作「打开模型对比」
- 输入卡的模型菜单里增加一条入口（「对比多个模型…」）——**不改它原有的单选语义**

### R5 默认路径零影响

- 单模型对话的**行为、事件、用量统计、侧栏、资料库**都不受影响
- `session-host.js` 最多加一个标记方法；**不改** `prompt` / `translate` / `ablate`
- 对比会话**不进** `bucketsById`、不进侧栏、不进资料库、不计入「统计」页
  （v1 如实说明；「把对比结果收进会话」是第二批）

## Acceptance Criteria

### 功能

- [ ] 真实启动应用：从 ⌘K 打开「模型对比」→ 选 2 个模型 → 提一条问题 →
      **两列同时开始流式**，各自的回复内容正确（不是同一列的内容复制了两份）
- [ ] 每列显示各自的**耗时**与**用量**，且**不串台**（两列数字各自独立）
- [ ] **一列失败（或超时）不影响另一列**：另一列照常流完并显示结果
- [ ] 取消（整体）能同时收掉所有列，界面回到可再次发问的状态
- [ ] 3 列也能正常工作；第 5 个模型被明确拒绝（不是静默忽略）
- [ ] 对比会话**不出现在侧栏、不进资料库、不计入统计页**（逐条断言）。
      口径说明：`SessionHost.create` 本来就会落一个会话文件（子代理与团队成员也是），
      「隐藏」靠的是文件头部的 custom 标记 —— 既有的
      `CHILD_SESSION_CUSTOM_TYPES = {subagent_run, team_member}`（`session-files.js:1321`）
      在 `readSessionHeadMarkers` 里把它们挡在列表之外（`:1366`）。
      对比要照着加一个 `compare_run`，**不是**「不落文件」

### 默认路径不许被影响（逐条断言）

- [ ] 单模型对话仍正常（既有 GUI 用例全绿）
- [ ] **跑完一轮对比之后**，`usageStats` 的总量与跑之前一致（对比不计入）
- [ ] **跑完一轮对比之后**，单模型对话仍能正常发消息（宿主体没被对比回收掉 —— 这条盯的是 `evictIdleHosts`）

### 测试

- [ ] **单元**：列状态归约全状态机、并发闸、事件 tag 路由（某一列的事件不会进另一列）、
      用量提取、耗时口径、2–4 的边界校验（0/1/5 个模型）、模型 key 解析失败
- [ ] **GUI（真实启动 + 截图）**：两台 mock（端口不同、回复不同）→ 断言两列各自收到自己的回复
      （判据是 mock 侧收到的请求体里的 `model` 与各自收到的回复文本，**不是「界面没报错」**）
- [ ] GUI：浅色 + 深色各一张截图（含像素断言）
- [ ] GUI：**一列失败另一列成功**的场景（一台 mock 返回 500）
- [ ] GUI：对比跑完后单模型对话仍可用（默认路径回归）
- [ ] 新用例挂进 `package.json` 的 `test:gui` 链条（= CI 的调用链）
- [ ] **反向验证**逐条执行：至少做三条（列间串台 / 一列失败拖垮全部 / 用量串台），
      每条都要**恰好**相关用例变红

### 工程

- [ ] `npm run lint:all`、`npm test`、`npm run test:gui` 全绿，**既有用例一条不少**
- [ ] `npm run check:daemon-graph`、`check:theme-tokens`、`check:docs`、`check:design-exceptions` 通过
- [ ] 全仓 U+FFFD 扫描 OK
- [ ] 界面改动全部走既有 token 与既有类名；**不新增视觉档位、不新增布局属性过渡例外**
- [ ] `CHANGELOG.md` 的 `[Unreleased]` 记「新增」；`docs/USAGE.md` 补一节

## 约束（不许违反）

- **不引入任何运行时依赖**
- **不改 `resources/**`**
- **不放宽任何权限或沙箱约束**；对比列**不执行命令、不写文件**
- 不为 lint 通过而大规模重排 `app.js` / `app.css`（红线 6）
- **不把对比塞进 `bucketsById` / teams / `emitSessionEvent`**（事实 2、4）

## 明确的后续项（本任务不做）

| 项 | 为什么不做 |
| --- | --- |
| 「把满意的那一列收进会话」 | 它建立在「并排跑通」之上，是薄增量（既有 `extractBranchFile` 原语），留第二批 |
| 对比列跑工具 / 带工作空间上下文 | 会把 N 份沙箱与文件写入副作用叠在一起，安全面直接放大 |
| 对比结果计入统计页 | 需要先解决 `ObservabilityStore.currentRun` 单槽的问题（那是独立的一处重构） |
| 保存 / 命名 / 导出对比记录 | 没有真实需求证据前不做 |