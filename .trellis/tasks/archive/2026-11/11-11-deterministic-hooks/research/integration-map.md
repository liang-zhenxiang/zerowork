# Research: 确定性 hooks 集成点地图

- **Query**: 为「确定性 hooks」产出集成点地图（PreToolUse / PostToolUse / SessionStart / UserPromptSubmit / Stop、配置、审计、UI、测试、风险）
- **Scope**: internal（仓库代码 + pi SDK 事件契约）
- **Date**: 2026-11-11
- **任务**: `.trellis/tasks/11-11-deterministic-hooks/prd.md`（Issue #368）
- **约束**: 只做调研，不改代码。本文所有行号以调研时的 `main`（`9df41cb`）为准。

---

## 0. 结论速览

1. **工具执行链路的唯一汇聚点有两处，都在 pi 扩展事件上**：
   - 调用前：`pi.on("tool_call")`，拿到 `toolName` / `toolCallId` / `input`；返回 `{ block: true, reason }` 即终止本次调用（第一个 block 生效）。
   - 执行后：`pi.on("tool_result")`，拿到 `toolName` / `input` / `content` / `isError`；**只有真正执行过的工具才会触发**（被 block 的不会）。
2. **`PreToolUse` 的推荐挂载点是「每个会话装配的 extensions 数组最前面」**，必须排在 `createPermissionGate` 之前。pi 按注册顺序执行 `tool_call` 监听器，第一条 block 即终止，因此 hook 拒绝天然是终局，且不会被后续权限/沙箱逻辑放行。
3. **`command-exec.js` 是「工具 + 权限门 + 沙箱执行器」的合体；`session-files.js` 是「daemon 装配层 + IPC handler + 会话/桶管理」**。新增 hooks 模块应仿照 `watch-policy.js`：独立文件、不 import `session-files.js`、不 import electron，纯逻辑可单测。
4. **五个事件都有现成事件源**：`session_start`、`input`、`tool_call`、`tool_result`、`agent_end`。但 `Stop` 有一个坑：扩展的 `agent_end` 不带 `willRetry`，而 `session-host.js` 的 translate 分支知道；要避免重试时重复触发，建议接在 `SessionHost.translate` 的 `agent_end` 分支。
5. **配置**：用户级沿用 `preferences.json`（读侧白名单必须加 `hooks` 键，历史上漏加过 `updateChannel` 造成静默失效）；工作区级 `.zerowork/hooks.json` 是**本仓库第一次**在 `.zerowork/` 下放可执行配置（现有只有 `memory/` 与 `spills/`），安全上等价于「克隆仓库即执行代码」，必须在 MVP 里处理信任边界。
6. **审计**：`writeAuditRecord` 是同步写 JSONL；类别/结果枚举是**双份手工副本**（daemon + renderer），新增类别必须两处同步。`detail` 上限 240 字符，完整 stderr 不能只靠审计承载。
7. **UI**：设置页没有「安全」一级导航；权限区在「通用」页 `GeneralSection` 里。Hooks 最自然的落点是「通用 → 权限」之后。`StarterTemplatesSection` 是现成的「列表 + 内联编辑 + 二次确认删除」模板。
8. **测试**：单测在 ubuntu + windows 跑（`.github/workflows/ci.yml:136-144`），GUI 只在 macOS 跑（`:244`）。hook runner 的单测必须跨平台（用 `process.execPath` 或注入假 runner，不要依赖 bash/PowerShell 存在）。

---

## 1. 工具执行链路

### 1.1 一次工具调用经过哪些层

```
模型返回 tool_call
  → pi-agent-core: prepareToolCall（参数校验）
  → ExtensionRunner.emitToolCall（按扩展注册顺序跑 tool_call 监听器）
        ├─ 值守边界（可选，自动化会话）
        ├─ ★ 权限门 createPermissionGate
        └─ 任一 {block:true} 立即返回（后面的监听器不再跑）
  → 工具 execute()
        └─ powershell 工具内部：危险命令检查器 → createSandboxedRunner → 沙箱/spawn
  → pi-agent-core: finalizeExecutedToolCall
  → ExtensionRunner.emitToolResult（按注册顺序跑 tool_result 监听器）
        ├─ spill（超长结果落盘）
        ├─ 团队产出挂载（仅领导会话）
        └─ ★ 可直接改 content / isError
  → 结果回给模型
```

锚点：

| 环节 | 文件:行 |
| --- | --- |
| `tool_call` 事件分发、第一个 block 即停 | `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:957-971` |
| `tool_result` 事件分发 | 同上 `:900-949` |
| 被 block 的调用返回 `kind:"immediate"`，不执行工具 | `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:487-538` |
| 执行过的工具（含抛错）都会走 `afterToolCall` / `tool_result` | `agent-loop.js:570-645` |
| 工具抛错统一转成 `isError:true` 的结果 | `agent-loop.js:595-600` |
| `tool_call` / `tool_result` 事件类型与返回值契约 | `types.d.ts:931-984`（ToolCallEvent）、`:985-1039`（ToolResultEvent）、`:1089`（ToolCallEventResult）、`:1114`（ToolResultEventResult） |

### 1.2 `command-exec.js` 与 `session-files.js` 的分工

| 文件 | 职责 | 关键锚点 |
| --- | --- | --- |
| `src/main/daemon/command-exec.js`（2531 行） | 工具工厂（`powershell`、`task`、`team_*`）、权限判定入口 `createPermissionGate`、危险命令检查器、沙箱执行器、子代理/团队成员装配、web 工具 | `createPermissionGate` `:400`；`powershellExtensionFactory` `:809`；`createSandboxedRunner` `:1258`；`buildSubagentExtensions` `:2104`；`spawnMember` `:2274` |
| `src/main/daemon/session-files.js`（6323 行） | daemon 装配层：会话桶、`createHost`、IPC handlers、主会话 extensions 数组、定时任务执行器、审计快照、ACL | `SessionHost.create` 调用 `:2973`；主会话 extensions `:3058`；`buildRunExtensions` `:1239`；`handlers` `:4303` |
| `src/main/daemon/session-host.js`（1511 行） | pi `AgentSession` 的适配层：事件翻译、状态、台账、hidden context、`prompt()` | `SessionHost.create` `:222`；`prompt` `:308`；`translate` `:754`；`agent_end` 分支 `:822` |
| `src/main/daemon/session-view.js` | `DEFAULT_TOOLS` 与视图投影 | `DEFAULT_TOOLS = ["read","write","edit","find","grep","ls"]` `:840` |
| `src/main/daemon/watch-policy.js` | 「只收不放」边界求值的独立模块（hooks 模块的最好样板） | `effectivePolicy` `:188`；文件头 `:1-60` |

**结论**：hooks 的「注册表 + 匹配 + 子进程执行 + 退出码判定 + 合并」应放进新模块 `src/main/daemon/hooks.js`（仿 `watch-policy.js`），由 `session-files.js` / `command-exec.js` 在装配点注入扩展。不要让 hooks 模块 import `session-files.js` —— 它顶层就 `requireParentPort()`、`loadResources()`，在 vitest 里根本 import 不了（`watch-policy.js:1-20` 的注释写明了这一点）。

### 1.3 `PreToolUse` 推荐挂载点（覆盖所有工具）

**唯一能覆盖所有工具的位置就是 `tool_call` 扩展监听器**。不要接在 `powershellExtensionFactory` 里 —— 那只覆盖 shell，漏掉 read/write/edit/MCP/docx/team 等。

三个装配数组都要插入，否则存在旁路：

| 会话类型 | 装配点 | 当前第一个 `tool_call` 监听器 | 推荐插入点 |
| --- | --- | --- | --- |
| 用户主会话 | `session-files.js:3058` `extensions: [` | `createPermissionGate` `:3067` | 数组**最前面**（`:3058` 之后、`:3067` 之前） |
| 定时任务 run 会话 | `session-files.js:1250` `const extensions = []` / `:1288` return | 值守边界 `:1252`（可选）→ 权限门 `:1267` | `extensions` 数组最前面（值守边界之前或之后均可，但不能在权限门之后） |
| 子代理 | `command-exec.js:2104` `buildSubagentExtensions` | `createPermissionGate` `:2106` | 数组最前面（`:2105`） |
| 团队成员 | `command-exec.js:2331` 复用 `buildSubagentExtensions` | 同上 | 同子代理 |
| 对比列 | `compare.js:800` `extensions: []` | 无工具、无权限门 | **本轮可不接**（它刻意不跑工具，见 `compare.js:586` 注释） |

> 为什么子代理/团队也必须接：`command-exec.js:2168-2176` 的注释明确写了「委派是模型可自主发起的，若这边走缺省就形成旁路」。同理，只给主会话装 PreToolUse，模型可以把被拒的动作委派给子代理完成。

### 1.4 `PostToolUse` 推荐挂载点

接 `pi.on("tool_result", ...)`，新增一个扩展工厂，注册在各数组的 `tool_result` 链**最后**：

- 主会话：`session-files.js` 里 `createTeamOutputHook`（`:3128`，实现在 `session-state.js:372-379`）之后。
- 定时任务：`buildRunExtensions` 的 spill（`:1319`）之后。
- 子代理/成员：`buildSubagentExtensions` 的 spill（`:2167`）之后。

理由：`tool_result` handler 是逐扩展链式的，后一个能看到前一个改过的 `content`；排在 spill / 团队产出之后，hook 收到的就是**模型最终看到的内容**。若排在前面，会看到未截断的长文本（且可能被 spill 改掉）。

**重要语义边界**：

- `PostToolUse` **不会**对被 `PreToolUse` block 的调用触发（`agent-loop.js:487-538` 直接返回 immediate，不走 `afterToolCall`）。
- 工具抛错会触发，`event.isError === true`（`agent-loop.js:595-600`、`625-633`）。
- `tool_result` handler 抛错不会中断 run，pi 会把结果改写成错误文本（`agent-loop.js:634-638`）—— 所以 PostToolUse 应自己吞错并记审计，不要依赖抛错。

---

## 2. 权限与沙箱的顺序

### 2.1 现有顺序（从外到内）

```
① 值守边界（仅自动化会话）   session-files.js:1169 createWatchBoundary → pi.on("tool_call") :1171
② 权限门                     command-exec.js:400 createPermissionGate → pi.on("tool_call") :403
③ 工具层危险命令检查器         command-exec.js:616 checkCommand（powershell 工具 execute 内）
④ 沙箱/提权                  command-exec.js:1258 createSandboxedRunner
                              → planExecution :1237 → resolveEscalation :1125
                              → sandbox.probe / prepare / run
```

`pi.on("tool_call")` 的注册顺序就是执行顺序（`runner.js:960-968`）。现有数组里权限门就是最靠前的之一，所以：

- `PreToolUse` 扩展插入到权限门**之前**即可满足 PRD 的「权限检查之前」。
- 拒绝是终局：返回 `{ block: true, reason }` 后，`emitToolCall` 立即 `return`，权限门、检查器、沙箱都不会运行。

### 2.2 权限档/审批/沙箱各自的函数

| 关注点 | 函数 | 锚点 |
| --- | --- | --- |
| 权限判定主入口 | `decide(facts, paths, cwd, settings, rules)` | `command-exec.js:180` |
| 按档位判定 | `decideUnderMode(...)` | `command-exec.js:190-341` |
| 从工具入参提取事实 | `extractFacts(toolName, input)` | `command-exec.js:375-398` |
| 权限门扩展 | `createPermissionGate({paths,cwd,getSettings,getRules,requestApproval})` | `command-exec.js:400-443` |
| 审批策略 | `willAskUser(settings, unattended)` | `permissions.js:114-117` |
| 提权申请校验 | `validateEscalationArgs` | `permissions.js:97-107` |
| 沙箱执行计划 | `planExecution` | `command-exec.js:1237-1256` |
| 沙箱不可用拒绝 | `refuseCommand` | `command-exec.js:1211-1225` |
| 权限当前值 | `activePermissions`（模块级，getter 读取） | `session-files.js:1714`、`:3082` |
| 权限规则文件 | `permissionRulesPath()`（用户级 `~/.zerowork/permissions.rules.json`） | `permissions.js:239-241` |

### 2.3 现有「拒绝对象」长什么样

| 场景 | 形状 | 模型看到什么 |
| --- | --- | --- |
| `tool_call` block（权限/值守） | `{ block: true, reason: string }` | `reason` 成为一条 `isError:true` 的工具结果文本 |
| 权限拒绝原因 | 见 `APPROVAL_REFUSAL` / `UNATTENDED_REFUSAL` | `command-exec.js:358-373` |
| 沙箱不可用 | 工具 execute 返回 `{ blocked:true, category:"sandbox-unavailable", reason }` | `command-exec.js:1220-1224` |
| 危险命令检查器 | `{ blocked:true, reason, category? }` | `command-exec.js:616-637`、`isBlocked` `:627` |

**hook 拒绝应复用 `{ block: true, reason }`**，`reason` 里写清：哪个 hook、什么原因（stderr）、退出码/超时、下一步怎么办（「不要原样重试」）。这与现有拒绝文案的纪律一致（`command-exec.js:358-373` 的注释）。

### 2.4 「用户级不能放宽工作区级」在结构上如何成立

推荐让 hook 的返回值**只有两种**：`放行（无意见）` 或 `拒绝`。没有「允许」返回值。于是：

- 同一事件的所有 hook 按顺序跑，任一拒绝即停；
- 用户级配置无论怎么加，都只能**增加**拒绝，不能撤销工作区级的拒绝。

这与 `watch-policy.js` 的「只收不放」是同一条性质，但 hooks 更简单：不需要像档位那样取 min，因为根本没有「放宽」这个值。调研结论：这条验收项可以靠**类型设计**而不是合并算法保证，单测直接钉住「任一来源 deny 即 deny」。

---

## 3. 会话生命周期

### 3.1 五个事件的现成事件源

| PRD 事件 | pi 事件 | 事件载荷 | 可否阻断 | 锚点 |
| --- | --- | --- | --- | --- |
| `SessionStart` | `session_start` | `{ reason: "startup"\|"reload"\|"new"\|"resume"\|"fork", previousSessionFile? }` | 否 | `types.d.ts:575-583`；`on` `:1189`；发射 `agent-session.js:2680` |
| `UserPromptSubmit` | `input`（pi 侧）或 daemon 的 `[INVOKE.prompt]` | pi：`{ text, images, source, streamingBehavior }`；daemon：`{ text, whileStreaming, images }` | pi 只能 `handled`（静默吞掉）或 `transform`，**没有带原因的拒绝** | `types.d.ts:910-925`；`on` `:1227`；发射 `agent-session.js:1594/1652`；daemon handler `session-files.js:4629` |
| `PreToolUse` | `tool_call` | `{ toolName, toolCallId, input }` | 是 | `types.d.ts:931-984`；`on` `:1224` |
| `PostToolUse` | `tool_result` | `{ toolName, toolCallId, input, content, isError, details }` | 否（可改结果） | `types.d.ts:985-1039`；`on` `:1225` |
| `Stop` | `agent_end`（pi 扩展）或 `session-host.js` translate | 扩展：`{ messages }`；translate：带 `willRetry` | 否 | `types.d.ts:748-751`；`on` `:1209`；translate `session-host.js:822-856` |

### 3.2 各事件的推荐触发点

**SessionStart**

- 最省事：注册一个 `pi.on("session_start")` 扩展，在 `SessionHost.create` 的 `createAgentSession` 内部触发（`agent-session.js:2680`，`bindExtensions` 里）。
- 注意：daemon 没有传 `sessionStartEvent`，所以 `reason` 恒为缺省 `"startup"`（`agent-session.js:199`），无法区分 new/resume/fork。如果需要区分，得在 daemon 侧 `SessionHost.create` 的调用点（`session-files.js:2973`、`3904` resume 路径、`4038` newTask、`command-exec.js:2018/2312`、`session-files.js:1076` 定时任务）自己触发，代价是 5 个调用点。
- 非阻断：handler 里必须 try/catch，绝不能让 SessionStart hook 失败导致建会话失败。

**UserPromptSubmit**

- 推荐 daemon 层：`session-files.js:4629` 的 `[INVOKE.prompt]` handler，在做 `parseBuiltinCommand` / 入队 / `host.prompt` 之前跑 hook。拒绝时直接 `throw new Error(可诊断原因)`，IPC 会把错误回给渲染层，用户看到 toast/错误，且**不会起这一轮**。
- 这条路径覆盖「空闲起一轮」与「运行中 steer/followUp」两条分支（`:4658-4661`），因为检查放在分支之前即可。
- pi 的 `input` 事件能力不足：`InputEventResult` 只有 `continue` / `transform` / `handled`（`types.d.ts:922-934`），`handled` 是**静默吞掉**，没有任何「告诉用户/模型为什么」的通道，不符合「错误要可诊断」。
- 边界：`[INVOKE.prompt]` 不覆盖自动化 run（`session-files.js:1076` 一带）与子代理/团队成员的 prompt。按事件名「UserPromptSubmit」的字面语义，本轮只覆盖用户输入即可；如果以后要覆盖全部来源，再用 `input` 扩展。

**Stop**

- 推荐 `session-host.js:822` 的 `translate` `case "agent_end"` 分支：这里能拿到 `event.willRetry`（`:824`），只在 `willRetry === false` 时触发一次，避免自动重试导致 Stop 重复执行。
- 备选：`pi.on("agent_end")` 扩展。它的类型只有 `{ messages }`（`types.d.ts:748-751`），**不带 `willRetry`**，会在每次重试尝试时都触发。若采用它，必须在 handler 里自己判断（拿不到），所以不推荐。
- 非阻断，失败只记审计。

### 3.3 子 agent / 团队会话的界定

| 会话 | 是否会被 hooks 覆盖（按装配点） | 建议 |
| --- | --- | --- |
| 用户主会话 | 是（`session-files.js:3058`） | 五个事件全开 |
| 定时任务 run | 是（`buildRunExtensions` `:1239`） | 至少开 `PreToolUse`（无人值守更需要确定性拒绝）；其余事件可只审计 |
| 子代理 `task` | 是（`command-exec.js:2104`） | **必须**开 `PreToolUse`，否则委派成旁路 |
| 团队成员 | 是（复用 `buildSubagentExtensions`） | 同上 |
| 对比列 | 否（`compare.js:800 extensions: []`） | 不跑工具，本轮不接 |

建议给 hooks 扩展加一个 `lifecycle` 开关：主会话为 `true`（跑 SessionStart/UserPromptSubmit/Stop），子代理/成员/定时任务为 `false`（只跑 Pre/PostToolUse）。理由是生命周期语义按「用户会话」定义，而工具门按「所有工具调用」定义。

---

## 4. 配置存储

### 4.1 用户级：`preferences.json`

- 读：`preferences.js:227 readPreferences()`；返回对象是**白名单**，逐个键显式列出（`:284-309`）。
- 写：`preferences.js:377 writePreferences()`，整份覆盖；所有 handler 都是「读改写」（`writePreferences({ ...readPreferences(), xxx })`），避免清掉其他键。
- **必须同时改读侧白名单**：历史事故 `updateChannel` 只在写侧加了、读侧漏了，导致「写进去永远读不回」（`preferences.js:62-71` 的注释）。
- handler 模板（照抄现有设置项）：`session-files.js:5548-5564`（权限）、`:5618-5640`（代理）、`:5660-5670`（提示词模板）。
- 读写共用判据的样板：`src/shared/starter-prompts.js` 的 `normalizeStarters`（读侧宽容）与 `assertStarters`（写侧抛错）；`preferences.js:270` 用前者，`session-files.js:5667` 用后者。hooks 也应有一份 `normalizeHooks` / `assertHooks`。
- 写侧校验错误要能指导用户（见 `validateProxyInput` `preferences.js:118-149`）。

### 4.2 工作区级：`.zerowork/hooks.json` —— 没有直接先例

现有 `.zerowork/` 下的内容：

| 路径 | 用途 | 读取点 |
| --- | --- | --- |
| `<cwd>/.zerowork/memory/MEMORY.md`、`YYYY-MM-DD.md` | 项目记忆 | `memory.js:51 workspaceMemoryDir`、`:63 buildMemorySection` |
| `<cwd>/.zerowork/spills/` | 超长工具结果落盘 | `config-paths.js:75 getSpillsDir`、`command-exec.js:3108/2167` |

**没有** `.zerowork/*.json` 配置文件先例；项目常驻指令存在**配置目录**的 `projects.json`（`projects.js:225 instructionsFor`），不是工作区文件。所以 `.zerowork/hooks.json` 是本仓库第一次在工作区放「可执行语义」的配置，安全评估见第 8 节。

### 4.3 用户级 + 工作区级合并的现成模式

| 模式 | 位置 | 与 hooks 的关系 |
| --- | --- | --- |
| 记忆：用户级 + 项目级**拼接** | `memory.js:63-94` | 语义是「累加」，不是安全边界 |
| 值守：**只收不放**的档位合并 | `watch-policy.js:188 effectivePolicy`、`TIER_RANK` `:82-100` | 性质最接近；但 hooks 更简单（只能 deny） |
| 项目指令：按会话反向索引读取 | `projects.js:225 instructionsFor(sessionPath)` | 展示「配置跟着项目走」的另一种实现 |
| 权限规则：用户级单文件 | `permissions.js:239` | 说明现有「安全规则」只有用户级，工作区级是新面 |

### 4.4 工作区路径怎么取

- 普通会话：`currentBucket.cwd`（`session-files.js` 多处），即用户选的工作空间。
- 临时任务：cwd 是 `<工作空间>/临时任务/<时间戳>`（`tempTasksDir()` `:1926-1928`、`isTempCwd` `:1957`）。如果只在 `<cwd>/.zerowork/hooks.json` 找，临时任务会读不到工作区配置。
- 建议：workspace hooks 的查找根用「会话的 workspace 根」而不是「会话 cwd」；实现上对普通会话用 `cwd`，对 `isTempCwd(cwd)` 回退 `getEffectiveWorkspaceRoot()`（`preferences.js:384`）。这个取舍需要主 agent 明确，否则会出现「换个任务目录 hook 就失效」。

---

## 5. 审计

### 5.1 写入函数与存储

| 项 | 锚点 |
| --- | --- |
| 写入 | `audit.js:98 writeAuditRecord(input, dir)` → `appendFileSync` 到 `<configDir>/logs/audit/audit-YYYY-MM-DD.jsonl` |
| 记录形状 | `{ ts, category, outcome, detail }`（`audit.js:99`、`:123-136`） |
| detail 截断 | `clipAuditDetail`，上限 240 字符（`audit.js:57-62`） |
| 读 | `readAuditRecords({dir, category, limit})`（`audit.js:138-160`） |
| 清空 | `clearAuditRecords`（`audit.js:162-182`，会留一条 `audit/cleared`） |
| 导出 | `exportAuditRecords`（`audit.js:184-192`） |
| IPC | `[INVOKE.auditList]` `session-files.js:4545` → `auditSnapshot` `:6000-6009` |

### 5.2 现有类别与结果

- 类别：`command`、`sandbox`、`runtime`、`audit`、`file`（`audit.js:34-40`、`:51`）。
- 结果：`blocked`、`allowed`、`failed`、`disabled`、`cleared`、`restored`（`audit.js:42-49`）。
- **frontmatter 校验会丢弃未知类别**：`parseRecord` 里 `category in AUDIT_CATEGORY_LABELS`（`audit.js:130`），不在表里的记录读不回来。

### 5.3 新增 `hook` / `hook-blocked` 的两条路

**方案 A（推荐）：新增类别 `hook`，复用 outcome `blocked` / `allowed` / `failed`。**

- `audit/{hook,blocked,detail}` 表达 `audit/hook-blocked`；超时、启动失败、非 0/2 退出记 `hook/failed`，不会把「失败」误标成「拦截」。
- 要改的位置：
  1. `audit.js:51` `AUDIT_CATEGORIES`
  2. `audit.js:34-40` `AUDIT_CATEGORY_LABELS`
  3. `src/renderer/src/app.js:69661` 同名的 `AUDIT_CATEGORIES`
  4. `src/renderer/src/app.js:69646` 同名的 `AUDIT_CATEGORY_LABELS`
- 注意：类别/标签是 **daemon 与 renderer 两份手工副本**，没有任何静态检查同步它们。新增时漏改渲染层，表现是「审计里写了、面板筛不到」（`auditSnapshot` 校验会认可，但 UI 没有那个按钮）。

**方案 B：复用现有 `command` 类别 + `blocked` outcome，detail 前缀写 `hooks 拦下 ...`。**

- 先例：值守边界就是这么做的（`session-files.js:1177-1181`，注释明确「复用既有类别，不新开」）。
- 优点：零改动 UI，立刻可见；缺点：PRD 要求「可在审计中心按类别筛到」，复用 `command` 后无法只看 hooks。

**detail 的 240 字符上限是硬约束**：`clipAuditDetail` 会把长 stderr 截断。完整 stderr 只能：
- 放进工具拒绝的 `reason`（模型看到，但有输出上限）；
- 或另写 `eventLog` / 专用 hook 日志（`eventLog.append` 的用法见 `session-files.js:6098-6108`）。
- 不要把完整 stdin 载荷写进审计（可能含路径、命令、用户文本；红线 3/8）。

### 5.4 审计中心 UI 的筛选机制

- `AuditSection`（`app.js:69675-69827`）用 `AUDIT_CATEGORIES`（`app.js:69661`）渲染筛选按钮（`:69740`），点击调 `window.kami.auditList(category)`（`:69686`）；daemon 侧 `auditSnapshot(category)` 再用 `readAuditRecords({category})` 过滤。
- 所以「新增类别后自动多一个筛选 chip」的前提是同时改 `app.js` 的两个常量。

---

## 6. 渲染层设置页

### 6.1 放哪里

- 设置页一级导航只有：通用 / 个性化 / 记忆与进化 / 模型 / 内置运行时 / 数据管理 / 审计中心 / 提示词预览 / 关于（`app.js:70089-70099`）。**没有「安全」这一级**。
- 权限在「通用」页：`GeneralSection`（`app.js:67212-67227`）里依次是 外观 / 开局模板 / 更新 / 网络代理 / 推理强度 / 联网搜索 / 默认工作区 / 权限 / 团队协作。
- **最自然的位置：`PermissionSection` 之后、`TeamSection` 之前**（`app.js:67224-67225` 之间）。它与权限同属「边界」心智模型，且不新开一级导航。
- 备选：新开一级「Hooks」。代价是导航变长，且设置页已经有 9 项；除非还要放很多 hook 相关配置，否则不建议。

### 6.2 现成组件

| 需要的东西 | 现成样板 | 锚点 |
| --- | --- | --- |
| 分组容器 | `section.settings-section` + `header.settings-section-head` + `h2` | `app.js:66470`、`:67132` |
| 列表行 | `.provider-list` / `.provider-row` / `.provider-main` / `.provider-tag` / `.provider-meta` | `AuditSection` `app.js:69809-69824`；MCP 列表 `:68787` 一带 |
| 列表 + 新增 + 内联编辑 + 二次确认删除 | `StarterTemplatesSection` 全套：`.starter-list` / `.starter-item` / `.starter-row` / `.starter-editor` / `.starter-add` / `.starter-confirm` | `app.js:66390-66508` |
| 开关 | `.mcp-switch`（`label > input[type=checkbox]` + `.mcp-switch-track`） | `TeamSection` `app.js:67194-67206` |
| 下拉选择 | 自定义 `SelectField`，触发器有 `aria-label`，选项是 `[role="option"]` | `ProxySection` `app.js:66675` 一带；测试用法见 `tests/e2e/gui-proxy.mjs:51-67` |
| 文本输入 | `input.starter-input` / `textarea.starter-textarea` | `app.js:66425-66449` |
| 弹窗 | `.modal-backdrop` + 卡片 `role="dialog" aria-modal="true"`；有 focus trap 逻辑 | 设置卡 `app.js:70173-70178`；`add-model-card` `:68787-68791`；MCP 表单 `:70512` |
| 加载/错误/空态 | `LoadingState` / `ErrorState` / `EmptyState` | `app.js:69760-69766`（AuditSection 内） |
| toast | `window.dispatchEvent(new CustomEvent("zw:toast", { detail: [{type,text}] }))` | `app.js:14164` |

「试运行」弹窗建议复用 `.modal-backdrop` + 一个卡片，展示：载荷 JSON（`<pre>`）、退出码、stdout、stderr、耗时。现有审计行的 `.audit-detail` 也可以复用样式。

### 6.3 UI 编辑的是哪一层

PRD 说「设置页可编辑与试运行」，但没说编辑用户级还是工作区级。两个选择：

| 选择 | 写入 | 优点 | 缺点 |
| --- | --- | --- | --- |
| 只编辑用户级 | `preferences.json` 的 `hooks` | 与现有所有设置项一致；信任边界简单 | 工作区 hooks 只能手写 `.zerowork/hooks.json` |
| 用户级 + 工作区级切换 | 两个文件 | 完整 | UI 要能显示当前会话 workspace；写入工作区文件等于让 UI 替用户写可执行配置，需二次确认 |

建议 MVP 先做「设置页只编辑用户级」，工作区文件在设置页里**只读展示 + 打开文件**（`window.kami.openArtifact` 已有）。这样第 8 节的「工作区 = 可执行配置」风险不用在 UI 层再处理一遍。

---

## 7. 测试

### 7.1 daemon 单测

- 位置：`tests/unit/hooks.test.mjs`（vitest 自动收集 `tests/unit/**/*.test.mjs`）。
- 原则：把可测逻辑从装配层剥离到独立模块 `src/main/daemon/hooks.js`，**不 import `session-files.js`、不 import electron**（`watch-policy.js:1-20` 是样板）。
- 建议导出的纯函数：
  - `normalizeHooks(raw)`（读侧宽容：丢坏条，不整块失效）
  - `assertHooks(raw)`（写侧抛错，错误可指导）
  - `mergeHooks(userHooks, workspaceHooks)`（顺序 + 去重 + 「任一 deny 即 deny」）
  - `matchesEvent(hook, event, toolName)`（matcher 正则，含非法正则的兜底）
  - `decideFromOutcome({exitCode, timedOut, spawnError, event})`（0 放行、2 拒绝、其他失败；不可阻断事件一律不阻断）
  - `runHook({command, timeoutMs, payload}, deps)`（`deps.spawn` / `deps.now` / `deps.platform` 可注入）
- 子进程测试的两种写法（都在仓库里有先例）：
  1. **注入假 runner**：`doc-extract.js` 的 `convertHtmlToDocx(config, run)` 把 `run` 作为参数传入（`:522-541`），单测用假的 `run` 断言「超时/退出码/输出」被正确翻译。hooks 也应把「真实 spawn」与「判定」分开。
  2. **真实子进程但用 `process.execPath`**：不要写 `bash -c` / `powershell`（单测在 ubuntu + windows 跑，`ci.yml:136-144`）。例如 `hook command = '"<node>" -e "process.exit(2)"'`，跨平台都在。超时用 `-e "setTimeout(()=>{}, 5000)"` 配 1s 超时。
- 必须覆盖的用例：
  - matcher 只对 Pre/PostToolUse 生效；
  - 多个 hook 顺序执行、任一 deny 即停；
  - exit 0 / 2 / 其他非零 / 启动失败 / 超时；
  - 不可阻断事件（SessionStart/Post/Stop）遇到 exit 2 也只记审计、不阻断；
  - 合并：工作区 deny + 用户 allow（无意见）仍是 deny；
  - 配置损坏：单条坏数据只丢该条，不整块失效（照 `readSkillOverrides` / `readPaletteMemory` 的口径）。
- 反向验证：按 `.trellis/spec/testing/index.md` 第四节，注入缺陷确认对应用例变红，并留下输出。

### 7.2 daemon 集成测试（e2e）

- 样板：`tests/e2e/watch-policy.mjs`（真实 Electron + 本地 mock 模型 + 真实 daemon，覆盖 tool_call 边界）；`tests/e2e/tool-loop.mjs`（两轮 mock，第一轮请求工具、第二轮收结果）。
- 做法：mock 模型请求一个工具（如 `ls` 或 `powershell`），在 `h.WORKSPACE_DIR/.zerowork/hooks.json` 或 `h.CONFIG_DIR/preferences.json` 写一条 PreToolUse deny hook，断言：
  1. 第二轮请求里出现 hook 的拒绝原因（证明工具没执行、模型收到了原因）；
  2. 审计 JSONL 里出现 `hook/blocked`；
  3. 目标文件/目录没有被工具副作用改动（更强的断言）。
- harness 隔离：`createHarness()` 提供 `CONFIG_DIR` / `WORKSPACE_DIR`（`tests/e2e/lib/harness.mjs:236-237`），并注入 `ZEROWORK_CONFIG_DIR` / `ZEROWORK_WORKSPACE_DIR`（`:409-413`）。工作区 hooks 的测试文件直接写到 `h.WORKSPACE_DIR` 下即可。

### 7.3 GUI 设置页测试

- 样板：`tests/e2e/gui-proxy.mjs`（设置表单 + IPC + 落盘断言）、`tests/e2e/prompt-templates.mjs`（列表 + 编辑器 + 删除 + 持久化）。
- 写法要点（都是踩过的坑，见 `.trellis/spec/testing/index.md`）：
  - 打开设置后**等具体内容元素**，不要只等 `h2`（异步区块两段式渲染；`prompt-templates.mjs:57-70`、`gui-proxy.mjs:40-47`）。
  - 按钮要等**可点**，不只是存在（`gui-proxy.mjs:81-89`）。
  - 截图放在断言之前（`h.shoot`），试运行弹窗还要等入场动画结束（`testing/index.md` 五·9）。
  - 断言文件落盘：`JSON.parse(readFileSync(join(h.CONFIG_DIR,"preferences.json")))`（`gui-proxy.mjs:69-71`）。
  - 谓词必须能返回假值（`waitUntil` 的硬约束，`testing/index.md` 三·1）。
- 新增脚本要加进 `package.json` 的 `test:gui` 链条（`package.json:57`），否则等于没有测试（`testing/index.md` 三·10）。
- 平台：GUI 只在 macOS 跑（`ci.yml:244`），所以 hook runner 的 macOS 分支（`/bin/sh -lc` 或 `/bin/bash -lc`）会被 CI 覆盖；Windows 分支只被单元测试的 windows job 覆盖。

---

## 8. 风险

### 8.1 跨平台命令

| 风险 | 事实 | 建议的处理方向（供主 agent 决策） |
| --- | --- | --- |
| Windows 没有 bash | 本项目的 shell 工具是 `powershell.exe`（`command-exec.js:664/716`），不是 bash | PRD 写的是 `cmd /c`；`cmd /c` 启动快，但引号/`%`/`^` 规则与 bash 不同，需要在文档里写清 |
| PowerShell 启动开销 | 每次 PreToolUse 都要起子进程；PowerShell 冷启动约百毫秒级 | 用 `cmd /c` / `/bin/sh -lc`，不要用 PowerShell；`timeoutMs` 默认 5000 会放大延迟 |
| macOS/Linux 的 shell | `bash` 在新 macOS 仍存在（`/bin/bash`），但更稳的是 `/bin/sh` | 统一 `/bin/sh -lc`；PRD 的 `bash -lc` 可写成「POSIX shell」 |
| 输出编码 | PowerShell 工具有 `[Console]::OutputEncoding=[Text.Encoding]::UTF8;` 前缀（`command-exec.js:445-449`）；`cmd /c` 没有等价物 | hook 输出统一按 UTF-8 解码；Windows 上可能得到本地代码页字节，需要在文档里声明或强制 `chcp 65001` |
| `windowsHide` | daemon 是不可见后台进程，子进程弹控制台会吓到用户（`runtimes.js:1321-1330` 的注释） | hook spawn 必须带 `windowsHide: true` |
| `shell: false` | 现有 spawn 一律 `shell: false`，显式传命令与参数（`doc-extract.js:323`、`runtimes.js:1321`） | hook 需要 shell 语义（用户写的是命令行），所以要么显式 `shell: true`，要么按平台拼 `["/bin/sh","-lc",command]` / `["cmd","/c",command]`。后者更可控 |

### 8.2 stdin 载荷格式

- PRD：stdin 收 JSON。实现要点：
  - `spawn(..., { stdio: ["pipe","pipe","pipe"] })`，`child.stdin.end(JSON.stringify(payload), "utf8")`。
  - 子进程可能不读 stdin → 写入会 `EPIPE`。必须监听 `child.stdin.on("error", () => {})`，**不能让 EPIPE 把 daemon 变成未捕获异常**（`daemon/index.js:55-63` 会把 unhandledRejection 记为 fatal）。
  - 载荷要自包含：事件名、工具名、工具参数、会话/工作区路径（脱敏后再决定是否给）、时间。不要指望 hook 自己去读环境。
  - 不要在 shell 命令里插值载荷（避免注入）；载荷只走 stdin。

### 8.3 超时与僵尸进程

- 现有 `runCommand` 的超时只 `killTree`（`command-exec.js:639-658`）：Windows 用 `taskkill /T /F`，POSIX 分支是 `child.kill()`。`killTree` **没有导出**（`command-exec.js:2409-2525` 的 export 列表里没有），hooks 模块要用得自己实现或导出它。
- `doc-extract.js:323-350` 的 `defaultRun` 超时用 `child.kill()`，**不杀孙进程** —— hook 如果自己起了子进程，超时后可能留下僵尸。
- 建议：
  - Windows：复用 `taskkill /pid <pid> /T /F`。
  - POSIX：`detached: true` + `process.kill(-child.pid, "SIGKILL")`（需要自己实现；现有代码没有）。
  - 超时后仍要 `await` 到 `close`/`exit`，避免「超时返回了但进程还在写审计」。
- 并发：pi 的多个工具调用可能并行（`agent-loop.js:executeToolCallsParallel`），PreToolUse 可能并发执行多个 hook。要保证审计写入顺序不混乱（`appendFileSync` 单行原子性足够）、且单个 hook 超时不拖垮整批（各自独立计时）。

### 8.4 路径注入与配置安全

| 风险 | 说明 |
| --- | --- |
| 工作区 hooks = 克隆即执行 | `.zerowork/hooks.json` 随仓库分发，内容会在会话启动/每次工具调用时执行。现有 `createProjectTrust`（`command-exec.js:1569-1588`）只处理 pi 自己的项目资源，**不认识** `.zerowork/hooks.json`；pi 的 trust store 是内部实现（`project-trust.js`），daemon 扩展拿不到。必须自己定信任策略：例如工作区 hooks 默认**不执行**，需要用户在设置页显式「信任此工作区的 hooks」；或只允许读、不允许改。 |
| 路径穿越 | 配置文件路径必须 `resolve` + 限定在 workspace 根内；`hooks.json` 可能是符号链接，读取时要 `realpath` 并判断仍在 workspace 内。 |
| 配置大小 | 限制文件字节数、hook 条数、命令长度、matcher 长度；照 `watch-policy.js` 的 `WATCH_MAX_*` 常量写法。 |
| 非法正则 | matcher 是用户输入的正则，`new RegExp` 放在 try/catch 里；配置损坏时「丢这一条」而不是整块失效（但 PreToolUse 的安全语义要单独定：见下）。 |
| **配置损坏时是否 fail-closed** | 这是必须明确的产品决策。`.zerowork/hooks.json` 存在但解析失败：若「静默跳过」= 用户以为有约束、实际没有（违反「宁可拒绝，也不静默降级」）；若「所有工具都拒」= 一个手滑的 JSON 就能让应用不可用。折中：解析失败时在 UI 与审计里响亮报错，并**拒绝执行所有 PreToolUse 可阻断事件**（fail-closed），但提供「本次忽略 hooks」的显式逃生开关。 |
| 用户级放宽工作区级 | 结构上不成立（hook 只能 deny）；但要防止「用户级 hook 通过 exit 0 表达允许」这种未来扩展 —— 一旦引入 allow 语义，这条性质就会破。PRD 应写明「hook 不提供 allow」。 |

### 8.5 其他工程风险

- **daemon 顶层求值**：新模块顶层只做声明；跨模块使用放进函数体（`.trellis/spec/daemon/index.md` 一）。新增 import 后跑 `npm run check:daemon-graph`，并真实启动一次。
- **IPC 通道四处同步**：`src/shared/ipc.js`（定义）、`src/preload/index.js`（INVOKE 副本 + 暴露方法）、`src/main/index.js`（`registerIpc` 自动转发，`MAIN_HANDLED` 里的不转发，`:574-577`）、daemon `handlers`（`session-files.js:4303`）。通道名必须匹配 `/^[a-z-]+:[a-z-]+$/`（`tests/unit/ipc.test.mjs:20-24`），且 shared 与 preload 逐条一致（`:61-81`）。建议名：`hooks:list` / `hooks:save` / `hooks:test`。
- **零新依赖**；`daemon` 不 import electron（PRD 硬约束）。
- **审计 detail 上限 240**：完整输出不能只靠审计。
- **渲染层是打包产物**：改 `src/renderer/src/app.js` 后 e2e 必须 `npm run build`（`testing/index.md` 四·1 的教训）。
- **中文编辑后**跑 `npm run check:unicode`。
- **不要大规模重排** `app.js` / `session-files.js`（`AGENTS.md` 红线 6）。

---

## 9. MVP 收敛建议

前提：PRD 的完整范围（五个事件 + 工作区/用户级合并 + 设置页编辑与试运行 + 全量测试）在一个 PR 里偏大，尤其是「工作区可执行配置的信任边界」是新增的安全面。建议按「安全收益 / 实现成本 / 不可逆程度」收敛：

### 9.1 本轮必须做（缺了就失去这个功能的意义）

| 项 | 理由 |
| --- | --- |
| 配置读取/校验/合并（用户级 + 工作区级） | 没有配置就没有功能；合并的「只收不放」是本 PRD 的核心验收 |
| `PreToolUse`（matcher、超时、退出码、可诊断拒绝） | 唯一的**真阻断**能力，也是竞品差异化的核心；接在权限门之前是可验证的安全性质 |
| 审计 `hook` 类别（blocked / failed） | 「确定性」必须可审计；否则用户无法证明 hook 真的跑过 |
| 设置页列表 + 新增/编辑/删除 + 试运行 | PRD 验收项；`StarterTemplatesSection` 可直接照抄，成本可控 |
| 单测（匹配/判定/超时/合并）+ 一条 daemon 集成测试 | 安全关键逻辑；纯函数可秒级覆盖 |
| 工作区 hooks 的信任策略（至少做到「默认不执行/显式确认」） | 不做就是把「克隆仓库 = 执行代码」悄悄引入；这是不可逆的安全债 |
| 子代理/团队成员也装 `PreToolUse` | 否则委派是旁路（`command-exec.js:2168-2176` 的既有纪律） |

### 9.2 可以延后（有明显成本，但删掉不影响核心闭环）

| 项 | 延后理由 | 替代 |
| --- | --- | --- |
| `SessionStart` / `Stop` | 非阻断，价值主要是「记录」；每个会话/每轮起子进程有固定开销；SessionStart 的 new/resume/fork 语义还要在 5 个建会话点分别接线 | 本轮先只写审计「事件已到达」，不执行用户脚本；下一轮再接 |
| `UserPromptSubmit` | 需要改 `[INVOKE.prompt]` 的拒绝路径（多一层错误传播），且与 PreToolUse 的安全收益重叠较小 | 先不做；或在 daemon 层做「只记录不阻断」 |
| `PostToolUse` | 非阻断；每个工具结果都起子进程，长会话噪音/延迟明显 | 先不做；或做成默认关闭的开关 |
| matcher 的完整正则语义 | 正则 ReDoS / 非法正则的边界处理成本 | MVP 只支持「工具名前缀」或「精确名 + `*`」，正则留到下一轮 |
| 工作区 hooks 的 UI 编辑 | 让 UI 写可执行配置需要额外的二次确认与审计 | 工作区文件手写 + 设置页只读展示 |
| 试运行弹窗的富展示（格式化、折叠、复制） | 不影响功能 | 先给 `<pre>` + 退出码 + stdout/stderr 文本 |

### 9.3 建议的 MVP 事件集合

如果只能保留一个事件：**`PreToolUse`**。
如果保留两个：**`PreToolUse` + `PostToolUse`**（共享 runner 与 matcher，边际成本最低）。
如果五个都保留：**事件接线成本不高，真正的成本在「配置/信任/UI/审计/测试」**，所以不建议通过砍事件来缩范围，而应该砍「工作区 UI 编辑」和「matcher 正则」这类边缘项。

> 一句话：**先把「用户能写一条拒绝规则、工具真的被拦住、审计里看得到、设置页能试运行」这条闭环做扎实**，生命周期事件与 PostToolUse 可以按同一套 runner 增量补齐。

---

## 10. 需要主 agent 决策的开放问题

1. 审计用新类别 `hook` 还是复用 `command`？（第 5.3 节给了两条路）
2. 工作区 hooks 的信任策略：默认不执行 + 显式确认？还是要求 `.zerowork/hooks.json` 在 `.gitignore` 里？
3. 配置损坏时 PreToolUse 是否 fail-closed？（第 8.4 节）
4. `UserPromptSubmit` 是 daemon 层拒绝还是 pi `input` 事件？（推荐 daemon 层）
5. `Stop` 用 `session-host.js` 的 `agent_end`（能拿到 `willRetry`）还是扩展 `agent_end`（每轮重试都触发）？（推荐前者）
6. 设置页编辑用户级还是也编辑工作区级？（建议 MVP 只编辑用户级）
7. 子代理/团队/定时任务是否也跑生命周期事件，还是只跑工具门？（建议只跑工具门）

---

## 11. 关键文件清单（供实现时按图索骥）

```
src/main/daemon/
  audit.js                 审计类别/写入/读取（新增类别改这里）
  command-exec.js          权限门、工具工厂、沙箱执行器、子代理/成员装配
  session-files.js         daemon 装配层、IPC handlers、主会话 extensions、审计快照
  session-host.js          pi 适配层；agent_end(willRetry) 在这里
  session-state.js         createTeamOutputHook（tool_result 链的现有样板）
  session-view.js          DEFAULT_TOOLS
  preferences.js           用户级配置读/写白名单
  permissions.js           权限档/审批/规则文件
  permission-rules.js      路径/命令判定纯函数
  watch-policy.js          「只收不放」的独立模块样板
  memory.js                `.zerowork/memory` 的用户级+项目级合并先例
  config-paths.js          配置目录、spills 路径
  projects.js              项目常驻指令（配置目录 projects.json）
  runtimes.js / doc-extract.js  子进程 spawn + 超时的现有写法
src/shared/
  ipc.js                   INVOKE/PUSH 契约（新增通道）
  starter-prompts.js       读侧 normalize / 写侧 assert 的共用判据样板
src/preload/index.js       INVOKE 手工副本 + contextBridge 暴露
src/main/index.js          registerIpc 自动转发 + MAIN_HANDLED
src/renderer/src/app.js    设置页、审计中心、组件与样式（打包后的单一源文件）
tests/unit/                纯函数单测（permission-rules / watch-policy / tools 样板）
tests/e2e/                 harness + gui-proxy / prompt-templates / watch-policy / tool-loop 样板
tests/e2e/lib/harness.mjs  CONFIG_DIR / WORKSPACE_DIR / 启动隔离
.github/workflows/ci.yml   单测 ubuntu+windows；GUI macOS
```

---

## 12. 外部参考

- Claude Code hooks（竞品事实来源，已在竞品调研中引用）：<https://code.claude.com/docs/en/hooks-guide.md> —— 生命周期事件、stdin JSON、exit code 2 = block 的语义。
- Cursor hooks：<https://cursor.com/docs/hooks> —— stdio JSON、约 30 个事件。
- pi SDK 事件契约（本仓库 `node_modules`）：
  - `@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:1187-1227`（`on(...)` 全量事件）
  - `.../core/extensions/runner.js:957-971`（tool_call 顺序与 block 终止）
  - `@earendil-works/pi-agent-core/dist/agent-loop.js:487-645`（blocked vs executed 的分界）
