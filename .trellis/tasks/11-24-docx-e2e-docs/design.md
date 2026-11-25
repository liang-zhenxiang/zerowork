# 设计：#483 docx 修订端到端与文档

## 一、真实工具调用链路

现有 `tests/e2e/gui-doc-edit-base.mjs` 的 mock 服务已经支持「按用户消息决定是否返回
tool_calls」：`wantsNormalWrite` 分支在最后一条 user 之后还没有 tool 结果时发一次
`write` 调用。docx 复用同一形状，新增两条：

| 用户消息包含 | 工具 | 参数 | 预期 |
| --- | --- | --- | --- |
| `docx 替换` | `docx_replace` | 工作区内的 `季度报告工具链.docx`，find=本季度营收，replace=本季度净收入 | 修订模式下生成建议，文件字节不变 |
| `docx 跨 run` | `docx_replace` | 工作区内的 `跨run.docx`，find=跨 run 的文本 | 直接写回路径被引擎拒绝，文件字节不变 |

分支顺序放在 `wantsNormalWrite` 之前，且都用「最后一条 user 之后没有 tool」作为
「只发一次」的守卫 —— 与 `wantsNormalWrite` 同一判据，避免同一轮无限调用。

夹具：`tests/fixtures/docx-revision/a-styles.docx` 的副本（含样式 / 编号 / 超链接 /
表格 / 页眉页脚，正是保真清单要核对的那些特征）。跨 run 的那份用同一个副本即可：
夹具里「跨 run 的文本」被拆在多个 run 中（单元测试已经钉住）。

## 二、保真断言：inspect_docx.py

`tests/fixtures/docx-revision/inspect_docx.py --json` 输出一份可比较的清单。e2e 在
接受前后各跑一次，断言：

- `text`：替换前文字消失、替换后文字出现；
- `short_sha` / 条目 sha：**除 `word/document.xml` 外**每个条目逐字节一致；
- 结构特征（styles / numbering / hyperlinks / tables / headers / footers）与接受前一致。

不手写第二套解析 —— 清单脚本与单元测试共用同一份事实来源。

## 三、跨 run 拒绝

需要**关闭修订模式**才能走到直接写回（修订模式只生成建议，不调引擎）。流程：

1. `kami.setDocEditMode(false)`，等 snapshot 不再带该字段（已有用例的判据）；
2. 发送「docx 跨 run 试试」；
3. mock 收到第 2 轮请求后，断言 `role:"tool"` 的内容含 `cross-run` / 「多个 run」/
   「Word 中手动修改」；
4. 文件字节哈希与发送前一致。

运行时未就绪时显式 `h.skip`，并在 skip 文案里写明原因（与现有接受用例同一写法）。

## 四、截图

- 真实链路生成的建议：`docx-tool-proposal-light` / `docx-tool-proposal-dark`；
- 复核现有 `docx-workbench-light` / `docx-workbench-dark` 仍覆盖。

## 五、文档

`docs/USAGE.md` 修订模式一节：

- 范围扩为「`.md` / `.markdown` / `.txt` / `.docx`」；
- 新增 docx 子段：v1 只改**正文部件 `word/document.xml`** 里**唯一命中**的纯文本，
  跨 run / 多处命中 / 找不到会被拒绝并说明；需要内置 Python 运行时（设置 → 内置运行时）；
  不做 Word 原生修订痕迹；接受前会留二进制版本，可还原；
- 删除「docx 尚未支持」的旧注，改成明确指向 v1 边界与后续评估（xlsx/pptx 仍未支持）。

## 六、验证

- `node tests/e2e/gui-doc-edit-base.mjs`（含新增用例）本地全绿；
- `npm run test`、`npm run lint:all`、`npm run check:unicode`；
- 反向验证：把 `patch_docx.py` 的 `cross-run` 分支改成 `not-found`（或去掉跨 run 判定）
  → 跨 run e2e / 单测变红，还原后全绿。

## 七、回滚

纯测试与文档改动，无产品代码变更；回滚即 revert 单个 PR。
