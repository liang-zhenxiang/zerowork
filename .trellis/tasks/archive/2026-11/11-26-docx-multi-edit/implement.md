# 执行清单：#499

- [x] `docx-replace.js`：`edits` 参数（与 `find/replace` 互斥、每条校验、上限 50）
- [x] `doc-edits.js`：`buildDocxProposal` 支持 edits；`parseProposal` 归一化旧结构；`summarize` 条数
- [x] `applyDocxProposal`：选择下标、哈希守卫、一次版本、临时副本顺序应用、全有或全无、原子替换、审计条数
- [x] `session-files.js`：`applyDocEdit` 透传选中的下标；docx 与文本建议的选择语义一致
- [x] `doc-edit-core.js` / `app.js`：docx 多条渲染、逐条勾选、统计与按钮文案、过期禁用
- [x] 单测：参数、结构、选择、全有或全无、旧结构兼容、统计
- [x] 真跑引擎单测：两条成功；第 2 条失败原文件不变
- [x] 反向验证：把「全有或全无」改成「边做边写」→ 部分写入用例红
- [x] `npm test`、`lint:all`、`check:unicode`
- [x] PR（Closes #499）
