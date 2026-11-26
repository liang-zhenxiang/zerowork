/**
 * OOXML run 级文本替换引擎的 Node 端封装（#479）。
 *
 * 引擎是 `resources/docx-engine/patch_docx.py`（Python 标准库，契约见
 * `docs/adr/ADR-0001-docx-revision.md` 与脚本头注释）。这里只做三件事：
 *
 * 1. 把请求翻译成 CLI 参数（脚本路径、`--in/--out/--part/--find/--replace`）；
 * 2. 解析「单行 JSON + 退出码 0/1」契约；
 * 3. 把超时、输出截断、进程未启动、非契约输出与引擎错误码映射成**可诊断**的错误。
 *
 * 不做的事：不做路径/哈希校验（那是 #458 写回闸与 #481 工具层的事），
 * 不引入 npm 依赖，不解析 docx（全部交给引擎）。
 *
 * ## 为什么错误信息里要带错误码
 *
 * `multiple-matches` / `cross-run` 是**产品语义上的拒绝**（让用户给出更长上下文、
 * 或在 Word 里手改），不是运行故障。调用方要能把它们与「环境坏了」区分开，
 * 才能给出不同的引导，而不是一律「重试」。
 */
import { join } from "node:path";
import { defaultRun } from "./doc-extract.js";

/** 引擎脚本名（相对 `engineDir`）。 */
const DEFAULT_PATCH_SCRIPT = "patch_docx.py";

/** 默认修补正文部件；页眉页脚由调用方传入 `part`。 */
const DEFAULT_PATCH_PART = "word/document.xml";

/** 单次替换是纯内存操作，30s 对超大文档也足够；超时说明环境异常。 */
const DEFAULT_PATCH_TIMEOUT_MS = 30_000;

/** 成功输出只有一行 JSON，64 KiB 已远超正常体积。 */
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

/** 引擎错误码 → 一句人能看懂的归类。原始 `error` 仍然原样附在后面。 */
const ENGINE_FAILURE_HINTS = {
	"bad-input": "请求参数不合法",
	"not-docx": "目标不是有效的 .docx 包",
	"missing-part": "目标部件不存在",
	"not-found": "在目标部件中找不到要替换的原文",
	"multiple-matches": "原文在目标部件中多处命中，无法确定改哪一处",
	"cross-run": "原文被 Word 拆在多个 run 中，v1 不支持直接写回",
	"bad-xml": "目标部件不是合法 XML",
	"io-error": "读写文件失败",
	"self-check-failed": "写后自检失败，原文件未被修改",
};

class DocxPatchError extends Error {
	constructor(code, message) {
		super(message);
		this.name = "DocxPatchError";
		this.code = code;
	}
}

function excerpt(text, max = 400) {
	const trimmed = text.trim();
	return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

function requireNonEmptyString(value, name) {
	if (typeof value !== "string" || value === "") {
		throw new DocxPatchError("bad-request", `patchDocx 缺少必填参数 ${name}（必须是非空字符串）`);
	}
	if (value.includes("\0")) {
		throw new DocxPatchError("bad-request", `patchDocx 的参数 ${name} 含 NUL 字符`);
	}
	return value;
}

function optionalPositiveNumber(value, name, fallback) {
	if (value === void 0) return fallback;
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new DocxPatchError("bad-request", `patchDocx 的参数 ${name} 必须是正数（收到 ${String(value)}）`);
	}
	return value;
}

function normalizeRequest(req) {
	if (typeof req !== "object" || req === null) {
		throw new DocxPatchError("bad-request", "patchDocx 的请求必须是对象");
	}
	const python = requireNonEmptyString(req.python, "python");
	const engineDir = requireNonEmptyString(req.engineDir, "engineDir");
	const inputPath = requireNonEmptyString(req.inputPath, "inputPath");
	const outputPath = requireNonEmptyString(req.outputPath, "outputPath");
	const find = requireNonEmptyString(req.find, "find");
	if (typeof req.replace !== "string") {
		throw new DocxPatchError("bad-request", "patchDocx 缺少必填参数 replace（必须是字符串，允许为空）");
	}
	if (req.replace.includes("\0")) {
		throw new DocxPatchError("bad-request", "patchDocx 的参数 replace 含 NUL 字符");
	}
	const part = req.part === void 0 ? DEFAULT_PATCH_PART : requireNonEmptyString(req.part, "part");
	return {
		python,
		engineDir,
		scriptPath: join(engineDir, DEFAULT_PATCH_SCRIPT),
		inputPath,
		outputPath,
		part,
		find,
		replace: req.replace,
		timeoutMs: optionalPositiveNumber(req.timeoutMs, "timeoutMs", DEFAULT_PATCH_TIMEOUT_MS),
		maxOutputBytes: optionalPositiveNumber(
			req.maxOutputBytes,
			"maxOutputBytes",
			DEFAULT_MAX_OUTPUT_BYTES,
		),
	};
}

/**
 * `--find` / `--replace` 用 `=` 形式传入：原文以 `-` 开头时，
 * `--find -x` 会被 argparse 当成另一个选项而报「缺少参数」。
 */
function buildPatchArgs(options) {
	return [
		options.scriptPath,
		`--in=${options.inputPath}`,
		`--out=${options.outputPath}`,
		`--part=${options.part}`,
		`--find=${options.find}`,
		`--replace=${options.replace}`,
	];
}

function contractError(detail) {
	return new DocxPatchError("engine-output-invalid", `引擎输出不符合契约：${detail}`);
}

function parsePatchSuccess(stdout) {
	let parsed;
	try {
		parsed = JSON.parse(stdout.trim());
	} catch {
		throw contractError(`stdout 不是 JSON：${excerpt(stdout)}`);
	}
	if (typeof parsed !== "object" || parsed === null || parsed.ok !== true) {
		throw contractError(`stdout 缺少 ok:true：${excerpt(stdout)}`);
	}
	const { part, entries, changed, bytes_before: bytesBefore, bytes_after: bytesAfter } = parsed;
	if (typeof part !== "string" || part === "") {
		throw contractError("part 字段缺失或不是非空字符串");
	}
	if (!Number.isInteger(entries) || entries < 1) {
		throw contractError(`entries 字段不是正整数（收到 ${String(entries)}）`);
	}
	if (!Number.isInteger(changed) || changed < 0) {
		throw contractError(`changed 字段不是非负整数（收到 ${String(changed)}）`);
	}
	if (!Number.isInteger(bytesBefore) || bytesBefore < 0) {
		throw contractError(`bytes_before 字段不是非负整数（收到 ${String(bytesBefore)}）`);
	}
	if (!Number.isInteger(bytesAfter) || bytesAfter < 0) {
		throw contractError(`bytes_after 字段不是非负整数（收到 ${String(bytesAfter)}）`);
	}
	if (parsed.other_entries_unchanged !== true) {
		throw contractError("other_entries_unchanged 不为 true（其余条目可能被改动）");
	}
	/*
	 * 可选字段：v1 引擎没有它（单 w:t 路径），v2 起为布尔。
	 * 缺省按 false —— 旧引擎的响应仍可用；给了却不是布尔则是契约错误。
	 */
	const merged = parsed.cross_run_merged;
	if (merged !== void 0 && typeof merged !== "boolean") {
		throw contractError(`cross_run_merged 不是布尔值（收到 ${String(merged)}）`);
	}
	return {
		part,
		entries,
		changed,
		bytesBefore,
		bytesAfter,
		otherEntriesUnchanged: true,
		crossRunMerged: merged === true,
	};
}

function parsePatchFailure(stderr, exitCode) {
	let parsed;
	try {
		parsed = JSON.parse(stderr.trim());
	} catch {
		parsed = void 0;
	}
	// 契约要求 ok:false；这里对「漏了 ok 但有 error」宽容一点 —— 但那与
	// 「非零退出却声称 ok:true」不同，后者是自相矛盾的输出，按契约错误处理。
	if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
		if (parsed.ok === true) {
			return contractError(`引擎以退出码 ${String(exitCode)} 失败却声称 ok:true：${excerpt(stderr)}`);
		}
		const code = typeof parsed.code === "string" && parsed.code !== "" ? parsed.code : "unknown";
		const detail = typeof parsed.error === "string" && parsed.error !== "" ? parsed.error : "引擎未给出原因";
		const hint = ENGINE_FAILURE_HINTS[code];
		return new DocxPatchError(
			code,
			hint === void 0
				? `docx 文本替换失败（${code}）：${detail}`
				: `docx 文本替换失败（${hint}）：${detail}`,
		);
	}
	return contractError(
		`引擎以退出码 ${String(exitCode)} 失败且 stderr 不是契约 JSON：${excerpt(stderr)}`,
	);
}

/**
 * 调引擎做一次唯一命中替换。
 *
 * @param {object} req `{ python, engineDir, inputPath, outputPath, part?, find, replace, timeoutMs?, maxOutputBytes? }`
 * @param {Function} [run] 与 `doc-extract.js` 的 `defaultRun` 同形态，测试可注入。
 * @returns {Promise<{part:string, entries:number, changed:number, bytesBefore:number, bytesAfter:number, otherEntriesUnchanged:true, crossRunMerged:boolean}>}
 */
async function patchDocx(req, run = defaultRun) {
	const options = normalizeRequest(req);
	if (typeof run !== "function") {
		throw new DocxPatchError("bad-request", "patchDocx 的 run 参数必须是函数");
	}

	const outcome = await run({
		command: options.python,
		args: buildPatchArgs(options),
		cwd: options.engineDir,
		env: { PYTHONPATH: options.engineDir },
		timeoutMs: options.timeoutMs,
		maxOutputBytes: options.maxOutputBytes,
	}).catch((error) => {
		const detail = error instanceof Error ? error.message : String(error);
		throw new DocxPatchError(
			"spawn-failed",
			`Python 调用失败：${detail}（${options.python}）。环境可能在 ensure 之后被破坏，请重试（会先重新 ensure）。`,
		);
	});

	if (typeof outcome !== "object" || outcome === null) {
		throw contractError("run 没有返回 { code, stdout, stderr } 形态的结果");
	}
	if (outcome.timedOut === true) {
		throw new DocxPatchError(
			"timeout",
			`docx 文本替换超时（>${options.timeoutMs}ms）。可重试一次；反复超时请检查文档是否过大或磁盘是否异常。`,
		);
	}
	if (outcome.outputTruncated === true) {
		throw new DocxPatchError(
			"output-too-large",
			`引擎输出超过上限（${options.maxOutputBytes} 字节），不符合一行 JSON 的契约，按引擎行为异常处理。`,
		);
	}
	if (outcome.code === null) {
		throw new DocxPatchError(
			"spawn-failed",
			`Python 未能启动：${outcome.error ?? "未知原因"}（${options.python}）。环境可能在 ensure 之后被破坏，请重试（会先重新 ensure）。`,
		);
	}
	if (typeof outcome.code !== "number") {
		throw contractError(`run 返回的 code 不是数字（收到 ${String(outcome.code)}）`);
	}
	const stdout = typeof outcome.stdout === "string" ? outcome.stdout : "";
	const stderr = typeof outcome.stderr === "string" ? outcome.stderr : "";
	if (outcome.code === 0) return parsePatchSuccess(stdout);
	throw parsePatchFailure(stderr, outcome.code);
}

export {
	DEFAULT_MAX_OUTPUT_BYTES,
	DEFAULT_PATCH_PART,
	DEFAULT_PATCH_SCRIPT,
	DEFAULT_PATCH_TIMEOUT_MS,
	DocxPatchError,
	ENGINE_FAILURE_HINTS,
	buildPatchArgs,
	normalizeRequest,
	parsePatchFailure,
	parsePatchSuccess,
	patchDocx,
};
