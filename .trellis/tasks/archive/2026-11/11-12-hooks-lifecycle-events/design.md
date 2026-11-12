# 技术设计：hooks 生命周期事件（非阻断）

> 前置：`.trellis/tasks/archive/2026-11/11-11-deterministic-hooks/design.md` 的配置形状、
> 信任模型、runner 与审计口径全部复用。本文只写**新增面**与**刻意不做的取舍**。

## 一、事件映射（已在 pi 类型定义中核实）

| hook 事件 | pi 事件 | 载荷新增字段 | 说明 |
| --- | --- | --- | --- |
| `SessionStart` | `session_start` | `reason` | 值为 `startup / reload / new / resume / fork` |
| `UserPromptSubmit` | `before_agent_start`，且 `messageType === "user"` | `prompt` | 只认用户提交；`custom`（`sendMessage({triggerTurn})` 唤醒）不触发 |
| `Stop` | `agent_settled` | `aborted` | 只在「无自动重试 / 压缩 / 排队续跑」之后触发 |

**为什么 Stop 不用 `agent_end`**：当前 pi 的 `AgentEndEvent` 只有 `messages`，没有
`willRetry`；一次模型失败的重试也会先发 `agent_end`。`agent_settled` 的注释与实现
（`_emitAgentSettled`）明确表示「彻底结束」，并带 `aborted` —— 这才是「Stop」。
Issue #373 原文里的 `willRetry` 前提不成立，已在 Issue 下留言更正。

## 二、不做上下文注入（刻意决定）

`before_agent_start` 可以返回 `message`（自定义消息）或 `systemPrompt`（整段替换），
`session_start` 则没有可返回的结果。两种做法都不做：

1. **安全**：hook 是本地代码，stdout 静默进入提示词 = 新增一条提示注入面，
   且与「用户以为 hook 只是跑了个脚本」的心智不符。要做必须是**可见**的自定义消息，
   需要单独设计展示与长度策略。
2. **一致性**：`session_start` 没有注入通道，只给 `UserPromptSubmit` 做会让三个事件
   的行为分叉；用户会以为 SessionStart 的输出也生效了。
3. **可预测**：PRD 的硬约束是「非阻断事件永远不能改变消息或会话结论」。

写入 `SECURITY.md` 与设置页文案（「输出只进审计与试运行，不会进入提示词」）。

## 三、校验（`hooks.js`）

```js
HOOK_EVENTS         = ["PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit", "Stop"]
TOOL_EVENTS         = new Set(["PreToolUse", "PostToolUse"])
LIFECYCLE_EVENTS    = new Set(["SessionStart", "UserPromptSubmit", "Stop"])
BLOCKING_EVENTS     = new Set(["PreToolUse"])            // 不变
```

`normalizeHook` 增加一条：生命周期事件的 `matcher` 只接受缺省 / `""` / `"*"`，
其他值**保存时抛错**：

```
hook 的事件 UserPromptSubmit 没有工具名，matcher 只能留空或写 *（实际是 "write*"）
```

理由与 `watch-policy` 同姿态：接受一个永不生效的字段比报错更坏。`matchesEvent` 已按
「非工具事件忽略 matcher」实现，无需改。

## 四、载荷（`hooks.js` 新导出）

```js
payloadForSessionStart({ sessionId, cwd, reason, now })   // { event, session, reason, timestamp }
payloadForUserPromptSubmit({ sessionId, cwd, prompt, now }) // { event, session, prompt, timestamp }
payloadForStop({ sessionId, cwd, aborted, now })          // { event, session, aborted, timestamp }
```

- `prompt` **不截断**：hook 的常见用法就是看用户到底说了什么；截断会造成「只检查了
  前半段就放行」。它由用户本地代码消费，不上传。
- 三个载荷都不含密钥；`session` 形状与工具事件一致。

## 五、执行（`hooks.js` 新工厂 `createLifecycleHookExtension`）

```js
createLifecycleHookExtension({ cwd, hookSet, getSessionId, onAudit, deps })
```

- 注册 `session_start` / `before_agent_start`（过滤 `messageType === "user"`）/ `agent_settled`
- 通用 `run(event, payload)`：
  1. `hookSet.fatal.length > 0` → **直接返回，不写审计**。工具事件已被 fail-closed 拦下并
     每条调用留证；生命周期事件每条消息都记同一条错误只会淹没审计。
  2. 无命中 → 不启动任何进程（零成本）。
  3. `runHooks(hooks, payload, event, deps)`（`BLOCKING_EVENTS` 不含这三类，天然全部跑完）。
  4. 每条结果写审计：`allowed` / `failed`，`blockable: false`。
  5. 整体 try/catch：异常写一条 `failed` 审计后吞掉。
- **永不返回** `{ block }` / `{ message }` / `{ systemPrompt }` —— 即使手滑改了，调用方
  也不消费。

### 审计文案

`auditDetail` 的 `toolName` 改为可选；非阻断事件失败的措辞：

- `SessionStart 放行（hook h-1，12ms）`
- `UserPromptSubmit 失败（未阻断）（hook h-1，5001ms，超时）`
- `Stop 拒绝（未阻断）（hook h-2，8ms，…）`

## 六、装配点（三处，同一个 root）

| 位置 | 文件 | 插入方式 |
| --- | --- | --- |
| 主会话 | `session-files.js` 主会话 extensions | 紧邻 `createPreToolUseHookExtension` |
| 自动会话 / 定时任务 | `session-files.js` `buildRunExtensions` | 同一 `hookSet` |
| 子代理 / 团队成员 | `command-exec.js` `buildSubagentExtensions` | 并入 `hookExtensions` 对象 |

- 三处共用同一个 `hookSet`（worktree → 源仓库），生命周期事件不改变安全边界，但仍遵守
  「配置只有一个根」。
- 子代理**会**触发这三个事件：一致性优先。代价是 `SessionStart`/`Stop` 每个子代理各一次；
  设置页文案与文档写明，用户可用 matcher 无法区分，因此需要「不想要就别配全局 hook」。
- 未信任工作区的 `skipped` 审计仍只由 `PreToolUse` 扩展在会话创建时记**一条**，
  生命周期扩展不重复记。

## 七、试运行（`hooks:test` 仍只认已保存 id）

`session-files.js` 的 `testHook` 按 `hook.event` 选示例载荷：

| 事件 | 示例载荷 |
| --- | --- |
| `PreToolUse` | 现有 write 示例（不变） |
| `PostToolUse` | 现有形状 + `ok: true` |
| `SessionStart` | `reason: "startup"` |
| `UserPromptSubmit` | `prompt: "这是试运行载荷"` |
| `Stop` | `aborted: false` |

弹窗文案按 `hook.event` 判断是否可阻断：非阻断事件显示「失败（未阻断）」，不写
「按 fail-closed 阻止」。审计行为不变（仍写一条「试运行 …」）。

## 八、设置页（`src/renderer/src/app.js` + `app.css` §46）

- 事件下拉追加：`会话开始（SessionStart）`、`发送消息前（UserPromptSubmit）`、`一轮结束（Stop）`
- 选中生命周期事件时 matcher 输入框 `disabled`，下方提示「该事件没有工具名，匹配留空（*）」
- 保存时按事件组织对象：生命周期事件不写 `matcher`（或写 `""`，写侧规范化为缺省）
- 「最近运行」：`hooks:get` 返回 `recentRuns`（审计最近 20 条中 `category === "hook"` 的
  后 5 条，字段 `{ ts, outcome, detail }`），分组底部列出时间 / 结论 / detail；
  空态写明「还没有运行记录」
- 试运行中的 verdict 文案按事件区分（见 §七）
- 只追加样式，复用 `settings-*` / `starter-*`；不新增大色块

## 九、`hooks:get` 契约扩展

```js
{
  user, userErrors, userFatal?,
  workspace: { root, path, exists, trusted, hooks, errors, fatalMessage? },
  activeCount,
  recentRuns: [{ ts, outcome: "allowed"|"failed"|"skipped", detail }]   // 新增，最多 5
}
```

读取用 `audit.js` 的 `readAuditRecords({ category: "hook", limit: 20 })` 再过滤/截断；
不新增审计格式。

## 十、测试

### 单元（`tests/unit/hooks.test.mjs` 追加）

- `HOOK_EVENTS` 含三个新事件；`BLOCKING_EVENTS` 不含它们
- `normalizeHook`：生命周期事件 + `matcher: "write*"` → 抛错；`"*"` / 缺省 → 通过
- 三个 payload builder 的字段形状
- 扩展工厂（假 `pi` + 注入假 spawn）：
  - 无命中不 spawn
  - 顺序执行、全部跑完（第一个 exit 1，第二个仍跑）
  - exit 2 / exit 1 / 超时 → 审计 `failed`，且 handler 不返回任何值
  - `fatal` 配置 → 不 spawn、不写审计
  - `before_agent_start` 的 `messageType: "custom"` → 不触发

### daemon 集成（`tests/e2e/hooks-lifecycle.mjs`，真实子进程 + mock 模型）

- 用户级三条 hook（分别 SessionStart / UserPromptSubmit / Stop），每条向固定文件追加一行
- 发一条消息 → 三个文件各有一行；`Stop` 的行在消息完成后才出现
- 其中一条 exit 1 → 消息仍正常完成（非阻断），审计有 `failed`
- 未信任工作区：工作区 hook 不执行

### GUI（`tests/e2e/gui-hooks.mjs` 扩展）

- 事件下拉出现三个新选项
- 新增 `SessionStart` hook：matcher 输入框禁用；保存后列表显示事件
- 试运行后「最近运行」出现一条 `试运行 放行`
- 浅色 / 暗色截图各一张（已有截图流程）

### 反向验证

逐条做「删掉实现 → 应红的用例必须红」：事件映射、非阻断、matcher 校验、最近运行。

## 十一、文档

- `SECURITY.md`「确定性 hooks」段：补三个事件、不做上下文注入、`UserPromptSubmit` 在
  用户等待路径上（最坏延迟）
- `.trellis/spec/daemon/index.md` §七：补一条「非阻断事件也在事件派发的等待路径上」
- `CHANGELOG.md` `[Unreleased]` → 新增
- 设置页文案（`hookEventHint` / `recentRuns` 空态）

## 十二、回滚

- 空配置 = 零行为变化；删掉对应事件条目即可逐条关闭
- 代码回滚只涉及新增工厂与三处装配；`PreToolUse` / `PostToolUse` 路径不受影响
