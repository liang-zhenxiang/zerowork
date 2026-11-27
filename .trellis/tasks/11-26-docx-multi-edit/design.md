# 设计：#499 一次多处 docx 替换

## 一、工具接口

```jsonc
// 新：批量
{ "path": "报告.docx", "edits": [ {"find": "本季度营收", "replace": "本季度净收入"},
                                 {"find": "未经审计", "replace": "已经审计"} ] }
// 旧：单条（保持可用，内部归一化为一条 edits）
{ "path": "报告.docx", "find": "本季度营收", "replace": "本季度净收入" }
```

- `edits` 与 `find/replace` 同时出现 → 拒绝（避免两种语义打架）。
- 每条 `find` / `replace` 都要求非空字符串，`find !== replace`；`find` 不许 NUL；
- 条数上限 50：一次改太多说明模型在猜，逐条更可控。

## 二、建议结构

```jsonc
{
  "kind": "docx",
  "path": "...",
  "baseSha256": "...",
  "part": "word/document.xml",
  "edits": [ { "find": "...", "replace": "..." } ],   // 新
  "find": "...", "replace": "...",                     // 旧结构保留（读取时归一化）
  ...
}
```

- `parseProposal`：`kind:"docx"` 时优先校验 `edits`（数组、至少 1 条、每条合法）；缺失时回落到旧 `find/replace` 并归一化。两者都没有 → 损坏。
- `summarize`：`hunkCount = edits.length`，`added = removed = edits.length`。
- `buildDocxProposal` 接受 `edits`（内部仍可接受 find/replace）。

## 三、应用（全有或全无）

`applyDocxProposal(id, { selectedEdits, python, engineDir, ... })`：

1. 读建议 → 归一化 `edits`；`selectedEdits` 是下标数组（缺省 = 全部）。
2. 读出当前字节 → 哈希守卫（与 `baseSha256` 比对）。
3. `recordBinaryVersion` 记录**当前原文件**（一次）。
4. 复制当前字节到同目录临时文件 `.<name>.<rand>.tmp`。
5. 按顺序对临时文件执行 `patchDocx({inputPath: temp, outputPath: temp, ...})`：
   - 任意一条抛错 → 删除临时文件、审计失败（含第几条）、抛可读错误；原文件未动。
6. 全部成功 → `fs.rename(temp, target)`（同目录原子替换），保留权限位（沿用源文件 mode）。
7. 审计成功一条：`替换 N 处`；返回 `{ path, replaced: N, proposalDeleted: true }`。

为什么用临时副本而不是引擎批量接口：Node 侧循环即可复用现有「单条 patch + 写后自检」，
且天然满足「中途失败原文件不动」；不需要为批量扩大引擎 CLI 面。

- 顺序执行，不并发：多条可能命中同一段落，并发会让各自的输入快照失效。
- 每条仍要求唯一命中；若第 2 条在应用时变成多条命中（第 1 条改动了同段），按失败处理并说明。

## 四、工作台

- `DocEditDetail` 的 docx 分支从「一处」扩展为列表：每条一个块（替换前 / 替换后），
  带独立勾选框（默认全选）；顶部说明「勾选的条目会写回，未勾选的按拒绝处理」。
- 左栏统计：「N 处替换」；`rowStats` 用 `edits.length`。
- 接受按钮文案：「接受替换（N 处）」→ 选中 M 条时显示「接受替换（M/N 处）」。
- 过期时全部禁用，理由不变。

## 五、兼容与迁移

- 旧建议（只有 `find/replace`）：读取时归一化为 `edits:[{find,replace}]`，UI 与写回无差别。
- 无需迁移现有落盘文件：归一化发生在读取层。

## 六、测试

- 单测（doc-edits / docx-replace / doc-edit-core）：
  - 参数归一化与互斥、条数上限；
  - 建议含 edits、summarize 条数；
  - 应用：只写选中项、全有或全无（第 2 条失败 → 原文件字节不变、错误含序号）；
  - 旧结构读取兼容；
  - 工作台统计与选择逻辑（doc-edit-core）。
- 真跑引擎：一次两条成功（字节与段落文本）、第二条失败时原文件不变。
- e2e 与 USAGE 留给 #501。

## 七、回滚

- 建议结构向后兼容；回滚 PR 后旧建议仍可读。应用层改动集中在 `applyDocxProposal`，
  可单独 revert。
