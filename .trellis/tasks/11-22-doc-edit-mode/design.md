# 设计：修订模式底座（#456）

## 1. 新模块 `src/main/daemon/doc-edits.js`

**不 import Electron**（只 node:fs / crypto / path + 本目录 config-paths、session-view 的纯函数），
便于 vitest 直测。两部分：

### 纯逻辑

```js
isTextEditPath(filePath)                 // .md/.markdown/.txt（大小写不敏感）
resolveInsideWorkspace(cwd, rawPath)     // 返回绝对路径；越界/非法返回 undefined
applyToolInput(toolName, input, before) // write → content；edit → applyEdits；不匹配返回 undefined
buildProposal({ absPath, before, after, sessionId, at }) // 抛错或返回 proposal
lineOps(before, after)                   // 复用 LCS，产出 [{type:" "|"-"|"+", text}]
groupHunks(ops, context = 3)             // 结构化 hunk：{id, opsStart, opsEnd, oldStart, newStart, added, removed, lines}
summarize(proposal)                      // 列表用：id/path/sessionId/createdAt/hunkCount/added/removed
```

- 哈希：`sha256(before)`（UTF-8）；空文件也合法。
- 上限：`DOC_EDIT_MAX_BYTES = 1 MiB`（before 与 after 各自），
  `oldLines.length * newLines.length > DIFF_CELL_BUDGET` 时拒绝（复用常量，避免二次定义）。
- `groupHunks` 的分组与 `session-view.buildHunks` 同口径（改动块 + 前后 3 行上下文），
  但保留 **ops 区间** 供 #458 按 hunk 应用；`buildHunks` 继续负责 unified diff 文本。

### 存储

```text
<config>/doc-edits/
  <id>.json        # { id, path, baseSha256, before, after, ops, hunks, sessionId, createdAt, toolName }
```

- `id = <base36 时间戳>-<6 位随机 hex>`，不接收调用方给的 id。
- 写入走「临时文件 + rename」原子落盘；坏 JSON 在 list 时跳过并计数（不炸整页）。
- `listProposals({ dir })` 返回按 createdAt 倒序的元数据（不返回 before/after）；
  `readProposal(id, { dir })` 返回完整内容；`deleteProposal(id, { dir })` 删除。
- 上限：最多保留 `DOC_EDIT_MAX_ENTRIES = 100` 条，超出删最旧（与 version-store 同纪律）。
- id 校验：`/^[a-z0-9]+-[a-f0-9]{6}$/`，拒绝路径穿越。

## 2. 拦截扩展 `createDocEditExtension(options)`

```js
(pi) => pi.on("tool_call", async (event) => { ... })
```

选项：`cwd`、`isEnabled()`、`getSessionId()`、`dir?`（测试注入）、`now?`。

流程（只在 `write` / `edit` 且 `isEnabled()` 为真时介入）：

1. 取 `event.input` 的 `path`；`resolveInsideWorkspace(cwd, path)` 失败 →
   `{block:true, reason:"修订模式只支持工作区内的文本文件…"}`。
2. `isTextEditPath` 失败 → 拒绝并说明当前支持 `.md/.markdown/.txt`，给出「关闭修订模式再试」的指引。
3. 读 before（不存在按空串；读取错误 → 拒绝并说明）。
4. `applyToolInput` 生成 after；`edit` 的 `oldText` 不匹配 → 拒绝（不生成半截建议）。
5. `buildProposal`；超限/无实际改动（before === after）→ 拒绝并说明。
6. 落盘建议；返回：
   ```js
   { block: true, reason: "修订模式已开启：本次改动已保存为待审建议（id …，新增 N 行 / 删除 M 行），文件尚未修改。请让用户到审阅台逐条接受；不要原样重试写入。" }
   ```

**注册位置**：`session-files.js` 的 `extensions` 数组中，排在 `createPermissionGate` **之后**、
`spillExtensionFactory` 之前（权限/hook 先拒绝；被拒的调用不产生建议）。

## 3. 会话状态与 IPC

- `SessionHost`：`docEditMode` 字段 + `setDocEditMode(enabled)`（仿 `setDelegateMode`：改字段 +
  `emitState`，不动提示词/工具面）；`get state()` 在开启时带 `docEditMode: true`（常态不占字段）。
- `createHost`：`docEditMode: bucket.conversation.state.docEditMode === true`。
- IPC（`src/shared/ipc.js` + preload）：
  - `session:set-doc-edit-mode` `[enabled]` → 更新桶状态（hostless 直接 `updateStateLocally`；
    有宿主调 `setDocEditMode`），返回 `{ docEditMode }`。
  - `session:list-doc-edits` → 元数据数组。
  - `session:read-doc-edit` `[id]` → 完整建议。
  - `session:delete-doc-edit` `[id]` → `{ deleted: true }`。
- 校验：enabled 必须是布尔；id 必须符合存储 id 规则；不存在的 id 报可读错误。

## 4. 界面（本 Issue 只加开关）

- 会话头部「更多操作 ▸」或输入栏工具区加「修订模式」开关（`role="switch"` / `aria-checked`），
  状态读 `conversation.state.docEditMode`；开启时给一行说明「AI 的写入会先变成待审建议」。
- 不改审阅台（#457 加队列）。

## 5. 测试

### 单测 `tests/unit/doc-edits.test.mjs`

- 白名单扩展名 / 大小写 / 越界路径（`..`、绝对路径在外部、符号链接不跟随）；
- write 与 edit 的 after 生成；oldText 不匹配；
- 哈希、hunk 分组（纯新增 / 纯删除 / 混合 / 无改动）、超限拒绝；
- 存储 list/read/delete 往返、坏 JSON 跳过、条目上限裁剪、id 穿越拒绝。

### 扩展接线（e2e 由 #459 覆盖；本 Issue 可加一条最小验证）

- 用 `createDocEditExtension` 的 fake `pi.on` 直接调用 handler，断言：
  - 关闭时返回 undefined；
  - 开启时返回 `{block:true}` 且落盘建议、目标文件未变。

## 6. 取舍

- **用 `block` 而不是伪造工具成功回执**：pi 的 tool_call 只支持 block；把原因写清楚让模型
  告诉用户「去审阅台」，比假装写入成功更诚实（也避免模型继续 edit 一个「已改」的文件）。
- **只支持工作区内**：v1 不让修订模式成为「跨目录读文件」的新入口；工作区外的写入仍走
  原有权限路径（但修订模式下会被拒绝——宁可拒绝，不静默直写）。
- **存前后全文**：1 MiB 上限下换来实现简单与可回放；hunk 只是视图，不是唯一真相。
- **不做持久化开关**：会话级 UI 状态，重启后默认关；避免「上次开了修订模式，这次忘了」。
