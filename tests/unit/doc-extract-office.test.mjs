/**
 * src/main/daemon/doc-extract.js 的 Office 提取路径单元测试。
 *
 * 为什么需要这份测试：这条路径此前**没有任何自动化覆盖** ——
 * CI 的 `test:gui` 链里有 `test:gui:preview`（覆盖 react-pdf），
 * 却没有 `test:gui:doc` / `test:gui:docx`，而那三个脚本又依赖
 * `~/.claude/settings.json` 里的模型凭据、在 CI 上会整轮跳过。
 *
 * 后果是实测到的：officeparser 从 4.x 升到 8.x 时，`parseOfficeAsync`
 * 导出消失、`tempFilesLocation` 配置被移除、返回值从字符串变成 AST ——
 * 三处都会让 Office 解析整体失效，而 CI 全绿。
 *
 * 所以这里不依赖模型、不依赖 GUI：自己生成一个最小 .docx 夹具，
 * 直接调用导出的 `extractOffice` / `extractDocument`。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import JSZip from "jszip";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	extractOffice,
	extractDocument,
	DocExtractError,
	MAX_CHARS,
} from "../../src/main/daemon/doc-extract.js";

/** 唯一标记。挑「可发音的词 + 数字」，理由见 tests/e2e/doc-parsing.mjs 的同类注释。 */
const MARK = "LOTUS8532";
const XLSX_MARK = "ORCHID5731";

/**
 * 生成一个最小可用的 .docx（OOXML 包）。
 *
 * 三件套即可：`[Content_Types].xml` + `_rels/.rels` + `word/document.xml`。
 * 段落用 `<w:t xml:space="preserve">`，保证首尾空格不被解析器吃掉 ——
 * 否则按字符切片的行为没法精确断言。
 */
async function buildDocx(paragraphs) {
	const zip = new JSZip();

	zip.file(
		"[Content_Types].xml",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
	);

	zip.file(
		"_rels/.rels",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
	);

	const body = paragraphs
		.map(
			(text) =>
				`<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`,
		)
		.join("\n  ");

	zip.file(
		"word/document.xml",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
  ${body}
  </w:body>
</w:document>`,
	);

	return zip.generateAsync({ type: "nodebuffer" });
}

let dir;
let docxPath;
let xlsxPath;

/**
 * 生成一个最小可用的 .xlsx（OOXML 包）。
 *
 * 单元格用 `t="inlineStr"`，省掉 sharedStrings.xml 这一层 —— 它只影响体积，
 * 不影响解析器要走的路径。Excel 与 docx 在 officeparser 里是**两个独立解析器**，
 * 只测 docx 会让 xlsx 这条同样吃用户文件的路径重新变成盲区。
 */
async function buildXlsx(cellText) {
	const zip = new JSZip();

	zip.file(
		"[Content_Types].xml",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>`,
	);

	zip.file(
		"_rels/.rels",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
	);

	zip.file(
		"xl/workbook.xml",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`,
	);

	zip.file(
		"xl/_rels/workbook.xml.rels",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`,
	);

	zip.file(
		"xl/worksheets/sheet1.xml",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1"><c r="A1" t="inlineStr"><is><t>${cellText}</t></is></c></row>
  </sheetData>
</worksheet>`,
	);

	return zip.generateAsync({ type: "nodebuffer" });
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "zerowork-doc-extract-test-"));
	docxPath = join(dir, "marker.docx");
	xlsxPath = join(dir, "marker.xlsx");
	writeFileSync(
		docxPath,
		await buildDocx([
			`ZeroWork office marker ${MARK}`,
			"第二段：用于验证多段落与切片行为",
		]),
	);
	writeFileSync(xlsxPath, await buildXlsx(`ZeroWork xlsx marker ${XLSX_MARK}`));
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("extractOffice（officeparser 路径）", () => {
	it("能从 .docx 里提取出正文，且标记逐字保留", async () => {
		const result = await extractOffice(docxPath);
		expect(result.text).toContain(MARK);
		expect(result.text).toContain("第二段");
		// 正文长度必须落在实际正文量级 —— 防止「返回了 AST 对象」
		// 这类错误悄悄通过（对象上没有 length 时切片会得到空串）。
		expect(result.text.length).toBeGreaterThan(MARK.length);
	});

	it("短文档不做截断，也不带续读提示", async () => {
		const result = await extractOffice(docxPath);
		expect(result.truncated).toBe(false);
		expect(result.nextOffset).toBeUndefined();
		expect(result.text).not.toContain("继续读请用 offset=");
	});

	it("能从 .xlsx 里提取出单元格文本（走的是另一个解析器）", async () => {
		const result = await extractOffice(xlsxPath);
		expect(result.text).toContain(XLSX_MARK);
	});

	it("offset/limit 按字符切片，并在截断时给出续读提示", async () => {
		const full = await extractOffice(docxPath);
		const head = await extractOffice(docxPath, 1, 5);

		expect(head.text.startsWith(full.text.slice(0, 5))).toBe(true);
		expect(head.truncated).toBe(true);
		expect(head.nextOffset).toBe(6);
		expect(head.text).toContain("继续读请用 offset=6");

		// 从续读位置接着读，内容应当与原文对应区间一致
		const next = await extractOffice(docxPath, 6, 5);
		expect(next.text.startsWith(full.text.slice(5, 10))).toBe(true);
	});

	it("offset 越界时返回可读提示而不是抛错", async () => {
		const full = await extractOffice(docxPath);
		const result = await extractOffice(docxPath, full.text.length + 1);
		expect(result.text).toContain("超出范围");
		expect(result.truncated).toBe(false);
	});

	it("limit 上限被 MAX_CHARS 夹住", async () => {
		const result = await extractOffice(docxPath, 1, MAX_CHARS * 10);
		expect(result.text.length).toBeLessThanOrEqual(MAX_CHARS);
	});
});

describe("extractDocument 的格式分派", () => {
	it(".docx 走 office 路径而不是 PDF 路径", async () => {
		const result = await extractDocument(docxPath);
		expect(result.text).toContain(MARK);
	});

	it("老格式 .doc 给出「另存为」引导", async () => {
		await expect(extractDocument(join(dir, "old.doc"))).rejects.toThrow(
			/另存为/,
		);
	});

	it("不支持的扩展名列出支持范围", async () => {
		await expect(extractDocument(join(dir, "note.txt"))).rejects.toThrow(
			/不支持的文件格式/,
		);
	});

	it("文件不存在时报 not-found", async () => {
		const err = await extractDocument(join(dir, "missing.docx")).catch(
			(e) => e,
		);
		expect(err).toBeInstanceOf(DocExtractError);
		expect(err.code).toBe("not-found");
	});
});
