# 设计：修订写回（#458）

## 1. `src/main/daemon/doc-edits.js` 新增

### 合并算法（纯函数）

```js
mergeSelectedHunks(proposal, hunkIds) -> { text, appliedHunks }
```

- 校验 `hunkIds`：非空数组、全部存在于 `proposal.hunks`、无重复；
- 遍历 `proposal.ops`，按下标判断是否落在**被选 hunk 的 `opsStart..opsEnd`**：
  - 上下文行（`" "`）永远保留；
  - 增删行：选中 → 应用（`+` 追加、`-` 丢弃）；未选中 → 保留原侧（`-` 保留、`+` 丢弃）；
- 返回合并后的全文与规范化后的 hunk 列表；不允许产生空文本以外的异常状态。

### 读/写

```js
checkFreshness(proposal, { readText }) -> { stale, currentSha256 }
applyProposal(id, hunkIds, { dir, versionsDir, auditDir, now }) -> result
rejectProposal(id, { dir, auditDir, now }) -> result
```

`applyProposal` 顺序（**每一步失败都不写盘**）：

1. 读建议（不存在/损坏 → 可读错误）；`mergeSelectedHunks`；
2. 读当前文件；`sha256(current)` 必须等于 `baseSha256`，否则审计 `file/failed`（detail 记 id/路径/hunk 数，不记正文）并抛「原文已变化，请重新生成」；
3. `recordVersion({ path, content: current, sessionId, tool: "doc-edit", added, removed }, { dir: versionsDir })`；
   - `recorded === false && reason === "io-error"` → **中止写回**（没有版本兜底就不写）；
   - binary / too-large 在这一层不可能（建议本身是文本且 ≤1 MiB），若出现如实报错；
4. 原子写：同目录临时文件 + rename；保留原文件 mode（存在时 `stat.mode`）；
5. 审计 `file/allowed`（detail：接受修订建议 id、N/M 段、路径名，不落正文）；
6. 删除建议文件；返回 `{ path, appliedHunks, added, removed }`。

`rejectProposal`：读建议 → 审计 `file/blocked`（「拒绝修订建议」）→ 删除建议；**不读写目标文件**。

### 新鲜度

`checkFreshness` 只读目标文件并计算哈希；文件不存在时 `stale: true` 且给出原因。
IPC 读取建议时附带 `stale` / `currentSha256`，UI 据此禁用「接受」。

## 2. IPC

- `session:apply-doc-edit` `[id, hunkIds]` → `applyProposal`；
- `session:reject-doc-edit` `[id]` → `rejectProposal`；
- `session:read-doc-edit` 返回体加 `stale` / `currentSha256`（#457 用）；
- 校验沿用 #456：id 格式、hunkIds 类型；错误消息可操作。

## 3. 审计与版本

- 审计：`category: "file"`，outcome：接受 `allowed`、拒绝 `blocked`、过期 `failed`；detail ≤240 字符，**不含正文**。
- 版本：复用 `version-store.recordVersion`（20 版/文件、1 MiB 上限）；写回前记录，文件历史可还原。

## 4. 测试

`tests/unit/doc-edits-apply.test.mjs`（临时目录）：

- 全部接受 = `after`；部分接受只含选中 hunk（含相邻上下文）；
- 原文改动 → 抛错、文件不变、审计有过期记录；
- 拒绝 → 文件不变、建议删除、审计有拒绝记录；
- 版本记录存在且可读回旧内容；
- 非法 hunkIds、重复 id、不存在 id、损坏建议；
- 建议文件在成功后删除；
- 注入 `auditDir` / `versionsDir` 隔离。

## 5. 取舍

- **不做逐 hunk 的「保留建议」**：未选中的 hunk 在写回时一并丢弃；UI 需在确认文案里说清（#457）。
- **版本记录失败即中止**：没有旧版本的写回不可回滚，违反「可回退」承诺。
- **拒绝即删除**：拒绝的是整条建议，不是单个 hunk；单条 hunk 的取舍用「不选」表达。
