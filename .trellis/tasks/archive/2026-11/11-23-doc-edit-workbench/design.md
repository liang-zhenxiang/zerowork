# 设计：修订工作台（#457）

## 1. 视图入口与模式

`ReviewView` 顶部加一组两个按钮（沿用 `.rv-*` 语言）：

- 「待修订 N」：`window.kami.listDocEdits()`
- 「已变更」：现有 `listReviewChanges()`

- 打开时并行拉两者；**建议数 > 0 时默认停在「待修订」**，否则保持「已变更」。
- 计数来自接口返回值；接受/拒绝后重拉两者，并让 `onPendingChange` 继续只反映「已变更」的待审数（不混入建议数）。
- 建议数用 `role="status" aria-live="polite"` 播报「有 N 条待修订建议」。

## 2. 左栏：按文件分组的建议列表

- `groupProposalsByPath(entries)`（纯函数，放 `src/renderer/src/doc-edit-core.js`）：
  按 `path` 分组，组内按 `createdAt` 倒序；组头显示文件名与目录，组内每行显示时间、`hunkCount`、`+added / -removed`。
- 每行是按钮（`.rv-row` 同款），选中项高亮；键盘 Tab + Enter。
- 与现有「已变更」列表共享左栏位置，切换模式不重置右栏状态（各自记住 selected id）。

## 3. 右栏：建议详情

`readDocEdit(id)` 返回 `before/after/ops/hunks/stale/currentSha256/missing`：

- 头部：文件名、来源会话（可点「回到来源会话」→ `onResumeSession(path)`）、创建时间。
- **过期条**：`stale === true` 时显示 `.rv-boundary` 风格提示：
  「原文已变化（或文件已不在），这条建议不能直接接受。请重新生成一次改动。」接受按钮禁用。
- **hunk 列表**：每段一张卡：
  - 勾选框（`input type=checkbox`，`aria-label="应用第 N 段：+X / -Y 行"`）；
  - 行渲染：`" "` 上下文、`"-"` 删除、`"+"` 新增（复用 diff 行样式）；
  - 默认全选；「全选 / 全不选」按钮；至少选一段才能接受。
- **动作**：
  - 「接受选中（N 段）」：`applyDocEdit(id, selectedIds)`；成功后 toast（应用 N/M 段，+X/-Y 行），重拉列表，清空选中；失败按错误消息展示（哈希守卫的文案原样）。
  - 「拒绝整条」：二次确认按钮（参考移除能力包），确认后 `rejectDocEdit(id)`；文件不变；toast。
- 读屏：勾选变化不播报整段；接受成功后用 `aria-live` 播报结果。

## 4. 纯逻辑 `src/renderer/src/doc-edit-core.js`（可单测）

```js
groupProposalsByPath(entries)          // 分组 + 倒序
defaultSelectedHunks(proposal)         // 所有 hunk id
mergeSelectAll(selected, all, on)      // 全选/全不选
summarizeSelection(proposal, selected) // { count, added, removed, canAccept }
```

- 不碰 DOM；对坏数据（缺 hunks/path）宽容处理，不抛。

## 5. 样式

- 复用 `.rv-index/.rv-list/.rv-row/.rv-detail/.rv-diff/.rv-boundary`；只新增：
  `.rv-tabs`（模式切换）、`.rv-proposal-group`（文件分组头）、`.rv-hunk`（勾选 + 行）、`.rv-hunk-line.add/del/ctx`。
- 不新增颜色档：删除行沿用 diff 的 danger 淡底，新增行沿用 ok 淡底，勾选框用原生控件。

## 6. 测试

- 单测 `tests/unit/doc-edit-core.test.mjs`：分组顺序、默认全选、全选/全不选、选中汇总、坏数据。
- e2e 扩展 `tests/e2e/gui-doc-edit-base.mjs`（#459 在此基础上继续）：
  生成两条建议 → 打开审阅台「待修订」→ 取消第二段 → 接受 → 文件只含第一段；
  再生成一条 → 手动改文件 → 打开工作台断言过期条与接受禁用 → 拒绝整条 → 文件不变。
- 回归 `review-desk`、`gui-smoke`、`file-history`。

## 7. 取舍

- **默认全选**：建议本身就是 AI 提出的完整改动，逐个勾选太慢；「接受选中」按钮始终显式，误触成本由过期守卫与二次确认兜住。
- **不做逐段「拒绝」状态持久化**：取消勾选就是拒绝该段；整条拒绝才是丢弃。
- **不把建议数混进侧栏角标**：角标语义是「有变更待审阅」，修订建议是另一条队列；用页内计数。
