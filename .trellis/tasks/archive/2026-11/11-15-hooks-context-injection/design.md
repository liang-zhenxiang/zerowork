# 技术设计：hooks 上下文注入

## 一、注入通道（已核实）

`before_agent_start` 的 handler 可以返回：

```js
{ message: { customType, content, display, details } }
```

pi 的处理（`agent-session.js` 的 `_prepareRun`）：把每条结果转成
`{ role:"custom", customType, content, display, details, timestamp }`，**放在本轮用户消息之后**
作为起始消息；`pi-agent-core` 的 `runAgentLoop` 会为这些起始消息发 `message_start` /
`message_end`，因此 **live 路径也看得见**。

- `customType = "hook_context"`
- `display = true`（可见；`false` 只能进模型，不可见 —— 本任务不允许）
- `details = { hooks: [{ id, event, bytes, truncated }] }`
- `content = <拼接后的纯文本>`

## 二、hooks.js

```js
HOOK_INJECT_PER_HOOK_BYTES = 4096
HOOK_INJECT_TOTAL_BYTES    = 8192
clipUtf8(text, maxBytes)                 // 按码点边界截断，追加 "\n…（已截断）"
buildHookInjection(entries)              // entries: [{hook, event, text}] → {text, hooks[]} | undefined
```

- `buildHookInjection` 跳过空文本；逐条截到 4KB，再整体截到 8KB；
  每条前加 `[hook ${id}]` 一行，便于读的人知道来源
- 返回的 `hooks[]` 记 id / event / bytes / truncated，供 details 与审计使用

扩展工厂（`createLifecycleHookExtension`）改动：

1. 闭包内 `let sessionStartBuffer = undefined`
2. `session_start` 的 run：除审计外，收集**allow 且非空**的 stdout → 暂存 `sessionStartBuffer`
   （多条拼接，仍受 8KB 上限）
3. `before_agent_start`（仅 user）的 run：把 `sessionStartBuffer` 与本轮的
   `UserPromptSubmit` 输出合并 → 组成注入；投递后清空 buffer（同会话只投递一次）
4. handler 返回 `{ message }`；没有内容时返回 `undefined`
5. **失败隔离**：只有 `verdict === "allow"` 的结果参与注入；deny/fail 的 stdout 丢弃
   （但仍按既有规则写审计）
6. 审计 detail 在原有基础上追加「，注入 N 字节」与「（已截断）」；不写正文

`SessionEnd` / `Stop` 不注入（没有「下一条请求」的语义）。

## 三、可见性（两个投影都要改）

### 1. 历史 / 重开：`session-view.js` 的 `buildConversationEntries`

当前只认 `user` / `assistant`。新增：

```js
if (message.role === "custom") {
  if (message.display !== true || message.customType !== "hook_context") continue;
  out.push({ id: entry.id, role: "hook_context", text: contentText(message.content),
             hooks: details?.hooks ?? [], at });
  continue;
}
```

### 2. live：`session-host.js` 的 `translate` → `message_start`

当前只处理 user / assistant。新增分支：`role === "custom"` 且
`display === true && customType === "hook_context"` →

```js
emit({ type: "hook_context", message: { id: nextId("hook"), role: "hook_context",
       text, hooks: details?.hooks ?? [], at: message.timestamp } })
```

`message_end` 不需要额外处理（内容在 start 时已完整）。

### 3. 渲染层（`app.js`）

- 事件 reducer 增加 `case "hook_context"`：`entries: [...entries, taggedWithRun(event.message, activeRunId)]`
- 渲染分支：`entry.role === "hook_context"` → `HookContextCard`
  - 卡片标题「hooks 注入的上下文」+ 每条 hook 的 id / 事件胶囊
  - 正文放在 `<details>` 里（默认折叠），`white-space: pre-wrap`，不用 Markdown
    （hook 输出是纯文本，套 Markdown 会产生用户没预期的格式）
  - 说明行：「由本地 hook 生成，不改写用户消息」
- `classify(entry)` 增加 `case "hook_context": return "foldable";`
- `app.css` 追加 **§49**，只用既有 token；窄窗、暗色、无动画

## 四、上限与截断

- 单条 4KB：从 UTF-8 字节截断到**码点边界**（不能切出半个字符）
- 合计 8KB：按顺序累加，超出时截断当前条目并标记 `truncated`
- 截断标记 `…（已截断）` 计入上限内（先截到 `max - 标记字节数`）
- 审计只写字节数；设置页试运行展示完整 stdout（已有）

## 五、安全

- 注入内容来自**用户自己的本地脚本**，且默认不配置；不是网络内容
- 仍是一条新的提示注入面：写进 `SECURITY.md`（谁能写、默认可控、可见性、如何关闭）
- 不覆盖 systemPrompt、不改写用户消息；`display:false` 的注入路径不允许存在
- 失败 / 非零退出的输出不注入：不可信的输出不能进上下文

## 六、测试

### 单元（`tests/unit/hooks.test.mjs`）

- `clipUtf8`：ASCII / 中文 / emoji 边界；不切出半个码点；标记计入上限
- `buildHookInjection`：跳过空、顺序拼接、单条与合计截断、details 正确
- 扩展工厂（假 pi + 假 spawn）：
  - allow 输出 → `before_agent_start` 返回 `{message}`，customType/display/details 正确
  - exit 1 / exit 2 / 超时输出 → 不注入；审计仍 failed
  - SessionStart 输出只投递一次（第二个用户消息不再带）
  - 空输出 → 返回 undefined；fatal 配置 → 不注入

### daemon 集成（`tests/e2e/hooks-inject.mjs`）

- mock 端点记录请求体：SessionStart + UserPromptSubmit 各输出一段文本
- 第一条请求的 messages 里能找到两段文本（role custom），且带 hook 标签
- 失败 hook 的输出不在请求体里；审计有「注入 N 字节」

### GUI（同文件）

- 发送消息后时间线出现 `.hook-context-card`；折叠可展开；截图（浅/暗）
- 重开会话后卡片仍在（走历史投影）

## 七、文档

- `SECURITY.md`：新增「上下文注入」小节
- `.trellis/spec/daemon/index.md` §七：补一条「注入必须可见且失败输出不注入」
- `CHANGELOG.md` `[Unreleased]` → 新增

## 八、回滚

- 删掉配置即无注入；代码回滚只影响 SessionStart / UserPromptSubmit 的返回值
  与视图新增的 role，既有事件路径不变
