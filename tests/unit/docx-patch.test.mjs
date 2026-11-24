/**
 * OOXML run 级文本替换引擎（#479）的单元测试。
 *
 * 两层：
 * - **Node 封装**（`src/main/daemon/docx-patch.js`）用注入的 `run` 覆盖契约解析与
 *   错误映射 —— 成功 JSON、引擎错误码、超时、输出截断、进程未启动、非契约输出；
 * - **真跑引擎**（`resources/docx-engine/patch_docx.py`）用 `tests/fixtures/docx-revision/`
 *   的夹具验证：正文 / 表格单元格 / 页眉替换成功，其余条目逐字节一致；跨 run /
 *   找不到 / 多处命中 / 非法包一律拒绝且**不产出输出文件**；写后自检能抓出
 *   「其余条目被改动」。
 *
 * 引擎只用 Python 标准库，不需要托管 venv。本机没有解释器时整组显式跳过
 * （describe 名字里写明原因），而不是静默变绿。
 *
 * ── 反向验证（已真跑并还原，见交付报告）──────────────────────────────────
 * 1) 把「唯一命中」放宽成「取第一处」→ 多处命中用例变红；
 * 2) 去掉 `_verify_temp` 里其余条目的 sha256 比对 → 自检用例变红。
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
	DEFAULT_MAX_OUTPUT_BYTES,
	DEFAULT_PATCH_PART,
	DEFAULT_PATCH_TIMEOUT_MS,
	DocxPatchError,
	patchDocx,
} from "../../src/main/daemon/docx-patch.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENGINE = join(ROOT, "resources", "docx-engine", "patch_docx.py");
const FIXTURES = join(ROOT, "tests", "fixtures", "docx-revision");
const DOCX_A = join(FIXTURES, "a-styles.docx");
const DOCX_B = join(FIXTURES, "b-table-header-footer.docx");

let dirs = [];

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), "zerowork-docx-patch-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs = [];
});

function sha256File(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function makeReq(overrides = {}) {
	return {
		python: "python3",
		engineDir: join(ROOT, "resources", "docx-engine"),
		inputPath: "/tmp/in.docx",
		outputPath: "/tmp/out.docx",
		find: "本季度营收",
		replace: "本季度营业收入",
		...overrides,
	};
}

const OK_REPORT = {
	ok: true,
	part: "word/document.xml",
	entries: 8,
	changed: 1,
	bytes_before: 15,
	bytes_after: 21,
	other_entries_unchanged: true,
};

function successOutcome(report = OK_REPORT) {
	return { code: 0, stdout: `${JSON.stringify(report)}\n`, stderr: "" };
}

function failureOutcome(code, error, exitCode = 1) {
	return { code: exitCode, stdout: "", stderr: `${JSON.stringify({ ok: false, code, error })}\n` };
}

function fakeRun(outcome) {
	const calls = [];
	const run = async (req) => {
		calls.push(req);
		return outcome;
	};
	return { run, calls };
}

async function capture(promise) {
	try {
		await promise;
		return null;
	} catch (error) {
		return error;
	}
}

describe("patchDocx：请求与参数", () => {
	it("把请求翻译成引擎 CLI 参数，并带默认超时与输出上限", async () => {
		const { run, calls } = fakeRun(successOutcome());
		const result = await patchDocx(makeReq(), run);

		expect(result).toEqual({
			part: "word/document.xml",
			entries: 8,
			changed: 1,
			bytesBefore: 15,
			bytesAfter: 21,
			otherEntriesUnchanged: true,
		});
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			command: "python3",
			cwd: join(ROOT, "resources", "docx-engine"),
			env: { PYTHONPATH: join(ROOT, "resources", "docx-engine") },
			timeoutMs: DEFAULT_PATCH_TIMEOUT_MS,
			maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
		});
		expect(calls[0].args).toEqual([
			join(ROOT, "resources", "docx-engine", "patch_docx.py"),
			"--in=/tmp/in.docx",
			"--out=/tmp/out.docx",
			`--part=${DEFAULT_PATCH_PART}`,
			"--find=本季度营收",
			"--replace=本季度营业收入",
		]);
	});

	it("允许指定部件、自定义超时，且不改变 replace 为空字符串的语义", async () => {
		const { run, calls } = fakeRun(successOutcome({ ...OK_REPORT, part: "word/header1.xml" }));
		await patchDocx(
			makeReq({ part: "word/header1.xml", replace: "", timeoutMs: 1234, maxOutputBytes: 2048 }),
			run,
		);
		expect(calls[0].args).toContain("--part=word/header1.xml");
		expect(calls[0].args).toContain("--replace=");
		expect(calls[0].timeoutMs).toBe(1234);
		expect(calls[0].maxOutputBytes).toBe(2048);
	});

	it("原文以 - 开头时用 --find= 形式，避免被 argparse 当成选项", async () => {
		const { run, calls } = fakeRun(successOutcome());
		await patchDocx(makeReq({ find: "-待删除" }), run);
		expect(calls[0].args).toContain("--find=-待删除");
	});

	it.each([
		["缺 python", { python: "" }],
		["缺 engineDir", { engineDir: "" }],
		["缺 inputPath", { inputPath: "" }],
		["缺 outputPath", { outputPath: "" }],
		["find 为空", { find: "" }],
		["replace 不是字符串", { replace: void 0 }],
		["part 为空", { part: "" }],
		["timeoutMs 非正数", { timeoutMs: 0 }],
	])("参数不合法（%s）→ bad-request，且不启动进程", async (_label, overrides) => {
		const { run, calls } = fakeRun(successOutcome());
		const error = await capture(patchDocx(makeReq(overrides), run));
		expect(error).toBeInstanceOf(DocxPatchError);
		expect(error.code).toBe("bad-request");
		expect(calls).toHaveLength(0);
	});

	it("请求不是对象、run 不是函数也拒绝", async () => {
		expect((await capture(patchDocx(null, fakeRun(successOutcome()).run))).code).toBe("bad-request");
		expect((await capture(patchDocx(makeReq(), null))).code).toBe("bad-request");
	});
});

describe("patchDocx：契约解析与错误映射", () => {
	it.each([
		["not-found", "找不到"],
		["multiple-matches", "多处命中"],
		["cross-run", "多个 run"],
		["missing-part", "部件不存在"],
		["not-docx", "不是有效的 .docx"],
		["bad-xml", "不是合法 XML"],
		["io-error", "读写文件失败"],
		["self-check-failed", "写后自检失败"],
	])("引擎错误码 %s → 可读错误并保留原因", async (code, hint) => {
		const { run } = fakeRun(failureOutcome(code, "引擎给出的原始说明"));
		const error = await capture(patchDocx(makeReq(), run));
		expect(error).toBeInstanceOf(DocxPatchError);
		expect(error.code).toBe(code);
		expect(error.message).toContain(hint);
		expect(error.message).toContain("引擎给出的原始说明");
	});

	it("未知错误码也原样带出，不吞掉", async () => {
		const { run } = fakeRun(failureOutcome("future-code", "新引擎的错误"));
		const error = await capture(patchDocx(makeReq(), run));
		expect(error.code).toBe("future-code");
		expect(error.message).toContain("future-code");
		expect(error.message).toContain("新引擎的错误");
	});

	it("超时 → timeout（优先于 code:null 的未启动判定）", async () => {
		const { run } = fakeRun({ code: null, stdout: "", stderr: "", timedOut: true });
		const error = await capture(patchDocx(makeReq({ timeoutMs: 500 }), run));
		expect(error.code).toBe("timeout");
		expect(error.message).toContain("500ms");
	});

	it("输出截断 → output-too-large", async () => {
		const { run } = fakeRun({ code: 0, stdout: "", stderr: "", outputTruncated: true });
		const error = await capture(patchDocx(makeReq({ maxOutputBytes: 64 }), run));
		expect(error.code).toBe("output-too-large");
		expect(error.message).toContain("64");
	});

	it("进程未启动 → spawn-failed，带 python 路径与原因", async () => {
		const { run } = fakeRun({ code: null, stdout: "", stderr: "", error: "spawn python3 ENOENT" });
		const error = await capture(patchDocx(makeReq(), run));
		expect(error.code).toBe("spawn-failed");
		expect(error.message).toContain("spawn python3 ENOENT");
		expect(error.message).toContain("python3");
	});

	it("成功退出但 stdout 非 JSON / ok 不为 true → engine-output-invalid", async () => {
		const notJson = await capture(patchDocx(makeReq(), fakeRun({ code: 0, stdout: "not json", stderr: "" }).run));
		expect(notJson.code).toBe("engine-output-invalid");
		expect(notJson.message).toContain("stdout 不是 JSON");

		const notOk = await capture(
			patchDocx(makeReq(), fakeRun(successOutcome({ ...OK_REPORT, ok: false })).run),
		);
		expect(notOk.code).toBe("engine-output-invalid");
	});

	it.each([
		["entries 不是整数", { entries: "8" }],
		["changed 为负", { changed: -1 }],
		["bytes_before 缺失", { bytes_before: void 0 }],
		["bytes_after 不是整数", { bytes_after: 1.5 }],
		["part 为空", { part: "" }],
		["other_entries_unchanged 不为 true", { other_entries_unchanged: false }],
	])("成功 JSON 字段不合约（%s）→ engine-output-invalid", async (_label, patch) => {
		const error = await capture(
			patchDocx(makeReq(), fakeRun(successOutcome({ ...OK_REPORT, ...patch })).run),
		);
		expect(error.code).toBe("engine-output-invalid");
	});

	it("非零退出且 stderr 非契约 JSON → engine-output-invalid", async () => {
		const { run } = fakeRun({ code: 1, stdout: "", stderr: "Traceback ..." });
		const error = await capture(patchDocx(makeReq(), run));
		expect(error.code).toBe("engine-output-invalid");
		expect(error.message).toContain("退出码 1");
	});

	it("失败 JSON 漏了 ok 但带 error 时仍然按错误码映射", async () => {
		const { run } = fakeRun({
			code: 1,
			stdout: "",
			stderr: `${JSON.stringify({ code: "not-found", error: "还是找不到" })}\n`,
		});
		const error = await capture(patchDocx(makeReq(), run));
		expect(error.code).toBe("not-found");
		expect(error.message).toContain("还是找不到");
	});

	it("非零退出却声称 ok:true → engine-output-invalid", async () => {
		const { run } = fakeRun({
			code: 1,
			stdout: "",
			stderr: `${JSON.stringify({ ok: true, code: "not-found", error: "自相矛盾" })}\n`,
		});
		const error = await capture(patchDocx(makeReq(), run));
		expect(error.code).toBe("engine-output-invalid");
	});

	it("run 返回非对象 → engine-output-invalid", async () => {
		const error = await capture(patchDocx(makeReq(), async () => void 0));
		expect(error.code).toBe("engine-output-invalid");
	});

	it("run 抛出异常 → spawn-failed（带原因与 python 路径）", async () => {
		const error = await capture(
			patchDocx(makeReq(), async () => {
				throw new Error("EACCES cwd");
			}),
		);
		expect(error.code).toBe("spawn-failed");
		expect(error.message).toContain("EACCES cwd");
		expect(error.message).toContain("python3");
	});

	it("run 返回的 code 不是数字 → engine-output-invalid", async () => {
		const error = await capture(
			patchDocx(makeReq(), async () => ({ code: "0", stdout: "", stderr: "" })),
		);
		expect(error.code).toBe("engine-output-invalid");
	});
});

function detectPython() {
	const candidates = [];
	if (process.env.ZW_PYTHON) candidates.push([process.env.ZW_PYTHON, []]);
	candidates.push(["python3", []], ["python", []], ["py", ["-3"]]);
	for (const [command, prefix] of candidates) {
		const probe = spawnSync(command, [...prefix, "--version"], {
			encoding: "utf8",
			windowsHide: true,
			timeout: 10_000,
		});
		if (probe.status === 0) {
			return { command, prefix, version: (probe.stdout || probe.stderr || "").trim() };
		}
	}
	return null;
}

const PYTHON = detectPython();

/** 真跑引擎。返回值与 `spawnSync` 相同。 */
function runEngine(args) {
	return spawnSync(PYTHON.command, [...PYTHON.prefix, ENGINE, ...args], {
		encoding: "utf8",
		windowsHide: true,
		timeout: 60_000,
	});
}

/** 引擎不该写输出时，用这个确认「连半成品都没有」。 */
function expectNoOutput(path) {
	expect(existsSync(path)).toBe(false);
}

/** 用 Python 标准库读出 zip 的条目顺序、元数据与每个条目的 sha256。 */
function inspectZip(path) {
	const script = [
		"import hashlib, json, sys, zipfile",
		"with zipfile.ZipFile(sys.argv[1]) as z:",
		"    entries = []",
		"    for info in z.infolist():",
		"        entries.append({",
		"            'name': info.filename,",
		"            'date_time': list(info.date_time),",
		"            'compress_type': info.compress_type,",
		"            'external_attr': info.external_attr,",
		"            'create_system': info.create_system,",
		"            'sha256': hashlib.sha256(z.read(info)).hexdigest(),",
		"        })",
		"    print(json.dumps({'entries': entries, 'comment': z.comment.hex()}))",
	].join("\n");
	const result = spawnSync(PYTHON.command, [...PYTHON.prefix, "-c", script, path], {
		encoding: "utf8",
		windowsHide: true,
		timeout: 30_000,
	});
	expect(result.status, result.stderr).toBe(0);
	return JSON.parse(result.stdout);
}

function zipEntryText(path, name) {
	const script = [
		"import sys, zipfile",
		"with zipfile.ZipFile(sys.argv[1]) as z:",
		"    sys.stdout.buffer.write(z.read(sys.argv[2]))",
	].join("\n");
	const result = spawnSync(PYTHON.command, [...PYTHON.prefix, "-c", script, path, name], {
		encoding: "buffer",
		windowsHide: true,
		timeout: 30_000,
	});
	expect(result.status, String(result.stderr)).toBe(0);
	return result.stdout.toString("utf8");
}

const describeEngine = PYTHON === null ? describe.skip : describe;

describeEngine("真跑引擎（需要 python3 / python / py -3；本机没有解释器时整组跳过）", () => {
	it("正文替换：退出 0、目标条目变化、其余条目逐字节一致", () => {
		const dir = tempDir();
		const out = join(dir, "a-patched.docx");
		const sourceBefore = sha256File(DOCX_A);

		const result = runEngine([
			`--in=${DOCX_A}`,
			`--out=${out}`,
			"--find=本季度营收",
			"--replace=本季度营业收入",
		]);
		expect(result.status, result.stderr).toBe(0);
		const report = JSON.parse(result.stdout.trim());
		expect(report).toEqual({
			ok: true,
			part: "word/document.xml",
			entries: 8,
			changed: 1,
			bytes_before: 15,
			bytes_after: 21,
			other_entries_unchanged: true,
		});
		expect(sha256File(DOCX_A)).toBe(sourceBefore);

		const before = inspectZip(DOCX_A);
		const after = inspectZip(out);
		expect(after.entries.map((entry) => entry.name)).toEqual(
			before.entries.map((entry) => entry.name),
		);
		expect(
			after.entries.map((entry) => [
				entry.date_time,
				entry.compress_type,
				entry.external_attr,
				entry.create_system,
			]),
		).toEqual(
			before.entries.map((entry) => [
				entry.date_time,
				entry.compress_type,
				entry.external_attr,
				entry.create_system,
			]),
		);
		expect(after.comment).toBe(before.comment);
		const changed = after.entries
			.filter((entry, index) => entry.sha256 !== before.entries[index].sha256)
			.map((entry) => entry.name);
		expect(changed).toEqual(["word/document.xml"]);

		const xml = zipEntryText(out, "word/document.xml");
		expect(xml).toContain('<w:t xml:space="preserve">本季度营业收入</w:t>');
		expect(xml).toContain("<w:hyperlink");
		expect(xml).toContain('<w:numId w:val="1"/>');
	});

	it("表格单元格替换：只改 document.xml", () => {
		const dir = tempDir();
		const out = join(dir, "b-table.docx");
		const result = runEngine([
			`--in=${DOCX_B}`,
			`--out=${out}`,
			"--find=营业收入",
			"--replace=营业收入（调整后）",
		]);
		expect(result.status, result.stderr).toBe(0);
		const report = JSON.parse(result.stdout.trim());
		expect(report).toMatchObject({ ok: true, part: "word/document.xml", entries: 9, changed: 1 });
		expect(report.other_entries_unchanged).toBe(true);

		const before = inspectZip(DOCX_B);
		const after = inspectZip(out);
		const changed = after.entries
			.filter((entry, index) => entry.sha256 !== before.entries[index].sha256)
			.map((entry) => entry.name);
		expect(changed).toEqual(["word/document.xml"]);
		expect(zipEntryText(out, "word/document.xml")).toContain(
			"<w:t>营业收入（调整后）</w:t>",
		);
	});

	it("页眉部件替换：只改 word/header1.xml", () => {
		const dir = tempDir();
		const out = join(dir, "b-header.docx");
		const result = runEngine([
			`--in=${DOCX_B}`,
			`--out=${out}`,
			"--part=word/header1.xml",
			"--find=内部资料 · 仅供评审",
			"--replace=内部资料（已修订）",
		]);
		expect(result.status, result.stderr).toBe(0);
		const report = JSON.parse(result.stdout.trim());
		expect(report).toMatchObject({
			ok: true,
			part: "word/header1.xml",
			entries: 9,
			changed: 1,
			other_entries_unchanged: true,
		});

		const before = inspectZip(DOCX_B);
		const after = inspectZip(out);
		const changed = after.entries
			.filter((entry, index) => entry.sha256 !== before.entries[index].sha256)
			.map((entry) => entry.name);
		expect(changed).toEqual(["word/header1.xml"]);
		expect(zipEntryText(out, "word/header1.xml")).toContain("<w:t>内部资料（已修订）</w:t>");
	});

	it("输出沿用源文件的权限位（POSIX）", () => {
		if (process.platform === "win32") return;
		const dir = tempDir();
		const src = join(dir, "mode.docx");
		const out = join(dir, "mode-out.docx");
		copyFileSync(DOCX_A, src);
		chmodSync(src, 0o640);
		const result = runEngine([
			`--in=${src}`,
			`--out=${out}`,
			"--find=本季度营收",
			"--replace=本季度营业收入",
		]);
		expect(result.status).toBe(0);
		expect(statSync(out).mode & 0o777).toBe(0o640);
	});

	it("跨 run → cross-run，退出非零且不产出输出文件", () => {
		const dir = tempDir();
		const out = join(dir, "never.docx");
		const sourceBefore = sha256File(DOCX_A);
		const result = runEngine([
			`--in=${DOCX_A}`,
			`--out=${out}`,
			"--find=跨 run 的文本",
			"--replace=改掉",
		]);
		expect(result.status).toBe(1);
		const error = JSON.parse(result.stderr.trim());
		expect(error.ok).toBe(false);
		expect(error.code).toBe("cross-run");
		expect(error.error).toContain("run");
		expectNoOutput(out);
		expect(sha256File(DOCX_A)).toBe(sourceBefore);
	});

	it("找不到 → not-found，不产出输出文件", () => {
		const dir = tempDir();
		const out = join(dir, "never.docx");
		const result = runEngine([
			`--in=${DOCX_A}`,
			`--out=${out}`,
			"--find=不存在的文本",
			"--replace=x",
		]);
		expect(result.status).toBe(1);
		expect(JSON.parse(result.stderr.trim())).toMatchObject({
			ok: false,
			code: "not-found",
		});
		expectNoOutput(out);
	});

	it("多处命中 → multiple-matches，不产出输出文件", () => {
		const dir = tempDir();
		const out = join(dir, "never.docx");
		// 「第」在夹具 A 的「第一条要点」「第二条要点」里各出现一次。
		const result = runEngine([`--in=${DOCX_A}`, `--out=${out}`, "--find=第", "--replace=第X"]);
		expect(result.status).toBe(1);
		expect(JSON.parse(result.stderr.trim())).toMatchObject({
			ok: false,
			code: "multiple-matches",
		});
		expectNoOutput(out);
	});

	it("非法 zip → not-docx", () => {
		const dir = tempDir();
		const bad = join(dir, "bad.docx");
		const out = join(dir, "never.docx");
		// 写一个不是 zip 的文件；引擎必须先拒绝，而不是尝试「尽力解析」。
		writeFileSync(bad, "this is not a zip");
		const result = runEngine([`--in=${bad}`, `--out=${out}`, "--find=a", "--replace=b"]);
		expect(result.status).toBe(1);
		expect(JSON.parse(result.stderr.trim()).code).toBe("not-docx");
		expectNoOutput(out);
	});

	it("缺 [Content_Types].xml → not-docx", async () => {
		const dir = tempDir();
		const bad = join(dir, "no-content-types.docx");
		const out = join(dir, "never.docx");
		const zip = new JSZip();
		zip.file(
			"word/document.xml",
			'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>',
		);
		writeFileSync(bad, await zip.generateAsync({ type: "nodebuffer" }));

		const result = runEngine([`--in=${bad}`, `--out=${out}`, "--find=a", "--replace=b"]);
		expect(result.status).toBe(1);
		const error = JSON.parse(result.stderr.trim());
		expect(error.code).toBe("not-docx");
		expect(error.error).toContain("[Content_Types].xml");
		expectNoOutput(out);
	});

	it("目标部件不存在 → missing-part", () => {
		const dir = tempDir();
		const out = join(dir, "never.docx");
		const result = runEngine([
			`--in=${DOCX_A}`,
			`--out=${out}`,
			"--part=word/nope.xml",
			"--find=a",
			"--replace=b",
		]);
		expect(result.status).toBe(1);
		expect(JSON.parse(result.stderr.trim()).code).toBe("missing-part");
		expectNoOutput(out);
	});

	it("输入文件不存在 → io-error，不产出输出文件", () => {
		const dir = tempDir();
		const out = join(dir, "never.docx");
		const result = runEngine([
			`--in=${join(dir, "no-such.docx")}`,
			`--out=${out}`,
			"--find=a",
			"--replace=b",
		]);
		expect(result.status).toBe(1);
		expect(JSON.parse(result.stderr.trim()).code).toBe("io-error");
		expectNoOutput(out);
	});

	it("目标部件不是合法 XML → bad-xml，不产出输出文件", async () => {
		const dir = tempDir();
		const bad = join(dir, "bad-xml.docx");
		const out = join(dir, "never.docx");
		const zip = new JSZip();
		zip.file("[Content_Types].xml", "<Types/>");
		zip.file("word/document.xml", "<w:document");
		writeFileSync(bad, await zip.generateAsync({ type: "nodebuffer" }));

		const result = runEngine([`--in=${bad}`, `--out=${out}`, "--find=a", "--replace=b"]);
		expect(result.status).toBe(1);
		expect(JSON.parse(result.stderr.trim()).code).toBe("bad-xml");
		expectNoOutput(out);
	});

	it("写后自检失败时原文件不变、输出文件不出现（注入自检失败）", () => {
		const dir = tempDir();
		const driver = join(dir, "fail-self-check.py");
		const out = join(dir, "never.docx");
		const source = [
			"import hashlib, json, sys",
			"from pathlib import Path",
			"sys.path.insert(0, sys.argv[1])",
			"import patch_docx",
			"def always_fail(*args, **kwargs):",
			"    raise patch_docx.PatchError('self-check-failed', '注入的自检失败')",
			"patch_docx._verify_temp = always_fail",
			"origin = Path(sys.argv[2])",
			"target = Path(sys.argv[3])",
			"before = hashlib.sha256(origin.read_bytes()).hexdigest()",
			"code = patch_docx.main([",
			"    f'--in={origin}', f'--out={target}',",
			"    '--find=本季度营收', '--replace=本季度营业收入',",
			"])",
			"after = hashlib.sha256(origin.read_bytes()).hexdigest()",
			"print(json.dumps({",
			"    'code': code,",
			"    'source_unchanged': before == after,",
			"    'output_exists': target.exists(),",
			"}))",
		].join("\n");
		writeFileSync(driver, source);

		const result = spawnSync(
			PYTHON.command,
			[...PYTHON.prefix, "-I", driver, join(ROOT, "resources", "docx-engine"), DOCX_A, out],
			{ encoding: "utf8", windowsHide: true, timeout: 30_000 },
		);
		expect(result.status, result.stderr).toBe(0);
		const report = JSON.parse(result.stdout.trim());
		expect(report).toEqual({ code: 1, source_unchanged: true, output_exists: false });
		expect(result.stderr.trim()).not.toBe("");
		expect(JSON.parse(result.stderr.trim()).code).toBe("self-check-failed");
	});

	it("写后自检能抓出「其余条目被改动」", () => {
		const dir = tempDir();
		const driver = join(dir, "self-check-driver.py");
		const source = [
			"import hashlib, json, sys, zipfile",
			"from pathlib import Path",
			"sys.path.insert(0, sys.argv[1])",
			"import patch_docx",
			"work = Path(sys.argv[2])",
			"part_name = 'word/document.xml'",
			"part_bytes = (",
			"    b'<?xml version=\"1.0\" encoding=\"UTF-8\"?>'",
			"    b'<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">'",
			"    b'<w:body><w:p><w:r><w:t>ok</w:t></w:r></w:p></w:body></w:document>'",
			")",
			"out = work / 'candidate.docx'",
			"with zipfile.ZipFile(out, 'w') as archive:",
			"    archive.writestr(part_name, part_bytes)",
			"    archive.writestr('other.xml', b'tampered')",
			"with zipfile.ZipFile(out) as archive:",
			"    metadata = [patch_docx._entry_metadata(info) for info in archive.infolist()]",
			"wrong_sha = hashlib.sha256(b'original').hexdigest()",
			"try:",
			"    patch_docx._verify_temp(",
			"        out, part_name, part_bytes, ['ok'], metadata,",
			"        {'other.xml': wrong_sha}, b'',",
			"    )",
			"except patch_docx.PatchError as exc:",
			"    print(json.dumps({'code': exc.code}))",
			"    sys.exit(0)",
			"print(json.dumps({'code': 'self-check-did-not-fire'}))",
			"sys.exit(1)",
		].join("\n");
		writeFileSync(driver, source);

		const result = spawnSync(
			PYTHON.command,
			[...PYTHON.prefix, "-I", driver, join(ROOT, "resources", "docx-engine"), dir],
			{ encoding: "utf8", windowsHide: true, timeout: 30_000 },
		);
		expect(result.status, result.stderr).toBe(0);
		expect(JSON.parse(result.stdout.trim()).code).toBe("self-check-failed");
	});
});
