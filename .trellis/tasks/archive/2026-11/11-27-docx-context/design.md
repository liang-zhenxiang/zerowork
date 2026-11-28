# 设计：#500 docx 建议的上下文预览

## 一、引擎：`--inspect` 只读模式

`patch_docx.py` 新增参数 `--inspect`（与 `--out` 互斥）：

```bash
python3 patch_docx.py --inspect --in report.docx --find "本季度营收" [--part word/document.xml]
```

成功（退出 0，stdout 一行 JSON）：

```json
{"ok": true, "part": "word/document.xml",
 "context": {"paragraph": 2, "heading": "季度报告",
             "text": "…前文【本季度营收】后文…", "offset": 3, "length": 6}}
```

- `paragraph`：该段落在**真实段落**（`w:p`）中的序号，从 1 开始；游离 `w:t` 不计。
- `text`：命中前后各 60 字的窗口，截断处加 `…`；`offset` 是命中在 `text` 内的起点，`length` 是命中长度 —— UI 据此高亮，不需要再猜。
- `heading`：向前找最近的标题段落（`pStyle` 匹配 `Heading[1-9]` / 含「标题」/ `outlineLvl ≤ 8`），取其拼接文本（截断 80 字）；找不到为 `null`。
- 复用现有定位逻辑（段落拼接、跨 run）：inspect 与 patch 必须对「命中在哪」给出一致答案，否则用户看到的位置与实际改动不符。

拒绝面与 patch 一致：`not-found` / `multiple-matches` / `cross-run` / `bad-xml`，且**绝不写文件**。

## 二、Node 契约

`docx-patch.js` 新增 `inspectDocx(req, run = defaultRun)`：

- 参数：`{ python, engineDir, inputPath, part?, find }`；
- 返回 `{ part, context }`；
- 错误映射复用 `DocxPatchError` 与 `ENGINE_FAILURE_HINTS`；
- `context` 字段类型严格校验（paragraph 正整数、offset/length 非负整数、text 字符串、heading 字符串或 null）。

## 三、工具层补全（不阻塞建议生成）

`createDocxReplaceTool` 新增可选依赖：

- `inspect`（测试注入，默认 `inspectDocx`）；
- `getPythonStatus`（宿主注入，返回 `{ ready, python }`；缺省视为未就绪）。

修订模式分支：

```js
const context = await maybeContext(...); // 单条 + 运行时 ready 时尝试；任何失败返回 undefined
proposal = buildDocxProposal({ ..., context });
```

`maybeContext` 的纪律：

1. **只有单条**才尝试（批量要 N 次引擎调用，收益低）；
2. 运行时未就绪 → 直接跳过（不 ensure，避免工具调用卡几分钟）；
3. inspect 抛错 → 吞掉并跳过（上下文是锦上添花，不能让它否决一条能生成的建议）。

直接写回路径不额外调用 inspect（接受时文件可能变；上下文只服务于「审阅时的判断」）。

## 四、建议结构与兼容

`buildDocxProposal` 新增可选 `context`，写进建议；`parseProposal` 校验并保留（字段不合法 → 丢弃 context，不影响建议本身）。旧建议没有该字段照常工作。

## 五、UI

`doc-edit-core.js` 新增纯函数：

```js
export function splitDocxContext(context) // → { before, match, after } | undefined
```

按 `offset` / `length` 切 `context.text`；字段不合法返回 `undefined`（UI 显示「位置信息不可用」）。

`DocEditDetail` 的 docx 分支在单条时：

- 徽标：`第 2 段 · 标题：季度报告`（无标题只显示段落序号）；
- 上下文行：`…前文…` + `<mark>` 旧文字 + `…后文…`（`mark` 用现有的 diff-del 底色，不新增颜色档）；
- 无 context：一行「位置信息不可用」的说明（`data-docx-context-missing`），不占大块空间。

## 六、测试

- 引擎：夹具 A 的 inspect 成功（段落号、标题、offset/length、原文在窗口内）；找不到 → not-found 且不产生输出文件；多条命中 → multiple-matches。
- 契约：成功字段校验、非法 context → engine-output-invalid、错误映射。
- 工具层：ready 时建议带 context；未就绪 / inspect 抛错时建议仍生成且无 context；批量不调用 inspect。
- core：`splitDocxContext` 的正常 / 越界 / 非法输入。
- e2e：展示徽标与高亮；无上下文时的说明（可与 #501 合并跑）。

## 七、回滚

纯新增：引擎参数、契约函数、可选字段、可选 UI。回滚 PR 后旧建议与旧工具调用行为不变。
