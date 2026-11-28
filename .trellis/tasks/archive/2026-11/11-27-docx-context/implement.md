# 执行清单：#500

- [x] 引擎：`--inspect`（只读）与 `_paragraph_context`（段落序号 / 标题 / 窗口 / 偏移）
- [x] 引擎：inspect 复用现有定位，拒绝面与 patch 一致且不写文件
- [x] `docx-patch.js`：`inspectDocx` + context 契约校验
- [x] `doc-edits.js`：`buildDocxProposal` 接受 context；`parseProposal` 校验并保留
- [x] 工具层：单条 + 运行时 ready 时补全 context；未就绪/失败降级为无 context
- [x] `session-files.js`：注入 `getPythonStatus`（collectRuntimeInventory）
- [x] `doc-edit-core.js`：`splitDocxContext` 纯函数
- [x] `app.js`：徽标 + 高亮上下文 + 无 context 说明
- [x] 单测：引擎 inspect、契约、工具层补全/降级、splitDocxContext
- [x] 反向验证：把标题判定改成恒真 → 无标题用例红
- [x] `npm test`、`lint:all`、`check:unicode`
- [x] PR（Closes #500）
