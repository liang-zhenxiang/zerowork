# 设计：OOXML 修补引擎（#479）

## 1. Python 契约

```bash
python3 patch_docx.py --in a.docx --out b.docx \
  [--part word/document.xml] --find "本季度营收" --replace "本季度营业收入"
```

成功（stdout 一行 JSON，退出码 0）：

```json
{"ok":true,"part":"word/document.xml","entries":8,"changed":1,
 "bytes_before":15,"bytes_after":21,"other_entries_unchanged":true}
```

失败（stderr 一行 JSON，退出码 1；不创建/不覆盖输出文件）：

```json
{"ok":false,"code":"cross-run","error":"目标文字被拆在多个 w:t 中……"}
```

错误码：`bad-input`、`not-docx`、`missing-part`、`not-found`、`multiple-matches`、
`cross-run`、`bad-xml`、`io-error`、`self-check-failed`。

## 2. 匹配与替换算法

1. 用 `zipfile` 读 `[Content_Types].xml` 与目标部件；解析 XML（`xml.etree.ElementTree`，注册 `w` 命名空间）。
2. 收集目标部件内所有 `w:t` 的文本：
   - 某个 `w:t` 文本**包含** `find` → 候选；
   - 若没有候选，但把同一段落（`w:p`）内相邻 `w:t` 拼接后包含 `find` → 判定 `cross-run`，拒绝；
   - 候选数 0 → `not-found`；>1 → `multiple-matches`。
3. 只改该元素 `text`，保留标签、属性、`xml:space`；**不做 run 合并**。
4. 不重新序列化整个 XML？ElementTree 保存会重写目标部件（这是预期：目标部件本来就变了）；
   其余条目完全不经过解析。目标部件之外的条目必须逐字节复制原数据。

## 3. zip 保真

- 遍历 `infolist()`；对每个条目用**原 `ZipInfo`**（时间戳、压缩方式、external_attr、
  create_system）写入原数据；目标条目用新数据、其余属性不变。
- 输出先写同目录临时文件，`os.replace` 原子替换；任何异常清理临时文件。
- 自检：重新打开输出，逐个条目 sha256 比对（目标条目除外）；XML 重新解析；目标部件文本含 `replace`。

## 4. Node 封装 `src/main/daemon/docx-patch.js`

```js
patchDocx(req, run) -> { part, entries, changed, bytesBefore, bytesAfter, otherEntriesUnchanged }
```

- `req`: `{ python, engineDir, inputPath, outputPath, part?, find, replace, timeoutMs?, maxOutputBytes? }`；
- `run` 注入（与 `doc-extract.js` 的 `defaultRun` 同形态），便于单测；
- 成功：stdout 必须是一行合法 JSON 且 `ok:true`，否则按「引擎输出不符合契约」报错；
- 失败：解析 stderr JSON 的 `code/error`，映射成带代码的错误消息；
- 超时 / 输出截断 / 进程未启动分别给出可诊断消息；
- 路径与参数的基本校验（非空、find≠replace 允许、output 不得等于 input？允许原地但引擎用临时文件；
  v1 由调用方决定输出路径）。

## 5. 测试

`tests/unit/docx-patch.test.mjs`：

- fake `run`：成功 JSON、stderr 错误码、超时、截断、非 JSON、进程未启动；
- 真跑引擎（`spawnSync("python3", ...)`，若 `python3` 不存在则跳过并在报告里说明）：
  - 夹具 A 正文替换：退出 0、其余条目 sha256 不变、XML 可解析；
  - 夹具 B 表格单元格 / 页眉替换；
  - 跨 run、找不到、多处命中：退出非零、输出文件不存在；
  - 自检失败注入（用测试专用脚本参数或临时篡改）→ 原文件不变（可选，若成本高则在引擎层单测覆盖）。

## 6. 取舍

- **Python 实现**：现有 docx 工具链就是 Python 引擎（`resources/docx-engine`），复用其运行环境与
  「一行 JSON」契约；Node 侧不引 zip 库，避免元数据保真风险。
- **只允许唯一命中**：真实文档同名文字很常见（「合计」），多命中就拒绝并让用户给出更长的上下文，
  比猜哪一处安全。
- **目标部件会重序列化**：这是唯一被改的部件；rPr/pPr/超链接等节点由 ElementTree 保留，
  但属性顺序可能变化。其余条目字节不变是本 Issue 的强承诺。
