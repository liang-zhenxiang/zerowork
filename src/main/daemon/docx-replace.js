/**
 * docx_replace（#481）：在**已有** .docx 的正文里做一次唯一命中的文本替换。
 *
 * 与 `docx_convert`（重新生成整份文档、丢原版式）互补：这里走 #479 的 OOXML 修补
 * 引擎（`docx-patch.js` → `resources/docx-engine/patch_docx.py`），只替换命中的那段
 * 文字，其余条目逐字节保留。引擎的拒绝面（找不到 / 多处命中 / 跨 run / 非 docx /
 * 非法 XML）原样作为**可读错误**带给模型 —— 这些是产品语义上的拒绝（让用户给出
 * 更长上下文，或在 Word 里手改），不是「重试一下就好」的故障。
 *
 * ## 两条路径
 *
 * - **修订模式开启**（`getDocEditMode()` 为真）：不写盘，生成 `kind:"docx"` 的
 *   待审建议（`doc-edits.js` 的 `buildDocxProposal` + `saveProposal`）。
 *   **不启动 Python 运行时** —— 生成建议只需要文件字节与哈希，环境坏掉时仍然能
 *   把用户的改动意图记下来。
 * - **修订模式关闭**：直接写回，顺序固定且每一步失败都**不改原文件**：
 *   1. 哈希守卫：ensure 之后**重读**文件，字节哈希必须与首次校验时一致 ——
 *      ensure 可能装几分钟运行时，期间用户手改过就不能悄悄覆盖（PRD #481）；
 *   2. `recordBinaryVersion` 留一版旧字节（失败即中止：没有回滚兜底的改动不该发生）；
 *   3. 引擎原子修补（写临时文件 + 写后自检，见 patch_docx.py）；
 *   4. 审计 `file/allowed`，detail 只记文件名与字节数，**不记文档正文**。
 *
 * ## 为什么路径校验复用 `doc-edits.js`
 *
 * `resolveInsideWorkspace` 已经是「工作区内 + realpath 不逃逸 + 拒绝 NUL / 空路径」
 * 的唯一实现（#456 起）。这里另写一份只会多一个会漂移的判据。
 *
 * 模块不 import Electron，可直接单测；运行时与引擎都可由 options 注入。
 */
import { readFileSync, statSync } from "node:fs";
import { basename, extname } from "node:path";
import { Type } from "typebox";
import { clipAuditDetail, writeAuditRecord } from "./audit.js";
import {
	applyDocxEditsToFile,
	buildDocxProposal,
	DOCX_MAX_BYTES,
	DOCX_MAX_EDITS,
	resolveInsideWorkspace,
	saveProposal,
	sha256Bytes,
	versionFailureText,
} from "./doc-edits.js";
import { DEFAULT_PATCH_PART, DocxPatchError, patchDocx } from "./docx-patch.js";
import { defaultPythonRuntimeOptions, defaultSpawn, ensurePythonRuntime } from "./runtimes.js";
import { recordBinaryVersion } from "./version-store.js";

/** 工具名；MUTATING 判定与 craft 白名单都靠它（改一处要同步三处）。 */
const DOCX_REPLACE_TOOL_NAME = "docx_replace";

/** 只接受这一种扩展名（大小写不敏感）。 */
const DOCX_EXTENSION = ".docx";

/**
 * 单文件上限 20 MiB（与版本存储的二进制上限一致）：docx 是压缩包，正文通常远小于它；这个数只用来挡住
 * 「把整个附件流当文本文件替换」这类误用，不是引擎的硬边界。
 *
 * 与 doc-edits.js 的 `DOCX_MAX_BYTES` 是**同一个数**（那边读校验也用它），
 * 这里只是给工具层一个可导出的名字。
 */
const DOCX_REPLACE_MAX_BYTES = DOCX_MAX_BYTES;

/** 引擎错误码 → 收尾引导。**语义拒绝**（改个说法就能过）与**故障**（可重试）分开说。 */
const SEMANTIC_ENGINE_CODES = new Set(["bad-input", "not-docx", "missing-part", "not-found", "multiple-matches", "cross-run"]);

function nowOf(options) {
	const value = options.now?.();
	return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
}

/**
 * 审计出口：宿主传 `onAudit`（与 docx_convert / docx_extract 同一个写入函数），
 * 单测传 `auditDir` 写到临时目录。两者都没有时走 `writeAuditRecord` 的默认目录。
 */
function audit(options, category, outcome, detail) {
	const record = { category, outcome, detail: clipAuditDetail(detail) };
	if (typeof options.onAudit === "function") {
		options.onAudit(record);
		return;
	}
	writeAuditRecord(record, options.auditDir);
}

function requireNonEmptyString(value, name) {
	if (typeof value !== "string" || value === "") {
		throw new Error(`docx_replace 缺少必填参数 ${name}（必须是非空字符串）`);
	}
	if (value.includes("\0")) {
		throw new Error(`docx_replace 的参数 ${name} 含 NUL 字符`);
	}
	return value;
}

/**
 * 入参校验。两种形状二选一：
 *
 * - 单条：`path + find + replace`（#481 起的旧形状，保留）；
 * - 多条：`path + edits: [{ find, replace }]`（#499）。两者同时出现直接拒绝 ——
 *   否则「到底以哪个为准」就是一个要猜的语义。
 *
 * `replace` 要求非空：不支持「把原文删成空」（那会让 Word 里的段落标记/空格归属
 * 变复杂，且与本工具的「替换一段文字」定位不符）。要删文字请在 Word 里手动删，
 * 或换成等价的改写。条数上限见 `DOCX_MAX_EDITS`。
 */
function normalizeParams(params) {
	if (typeof params !== "object" || params === null) {
		throw new Error("docx_replace 的参数必须是对象（path 与 edits，或 path + find + replace）");
	}
	const path = requireNonEmptyString(params.path, "path");
	const hasEdits = params.edits !== void 0;
	const hasSingle = params.find !== void 0 || params.replace !== void 0;
	if (hasEdits && hasSingle) {
		throw new Error("docx_replace 的 edits 与 find/replace 不能同时给出：多条修改用 edits，单条用 find/replace");
	}
	if (hasEdits) {
		if (!Array.isArray(params.edits) || params.edits.length === 0) {
			throw new Error("docx_replace 的 edits 必须是非空数组（至少一条 { find, replace }）");
		}
		if (params.edits.length > DOCX_MAX_EDITS) {
			throw new Error(`docx_replace 一次最多 ${DOCX_MAX_EDITS} 条替换（收到 ${params.edits.length} 条）；请拆成几次调用`);
		}
		const edits = params.edits.map((edit, index) => {
			if (typeof edit !== "object" || edit === null || Array.isArray(edit)) {
				throw new Error(`docx_replace 的 edits[${index}] 必须是对象 { find, replace }`);
			}
			const find = requireNonEmptyString(edit.find, `edits[${index}].find`);
			const replace = requireNonEmptyString(edit.replace, `edits[${index}].replace`);
			if (find === replace) {
				throw new Error(`docx_replace 的 edits[${index}] 前后完全相同，不会产生改动`);
			}
			return { find, replace };
		});
		return { path, edits };
	}
	const find = requireNonEmptyString(params.find, "find");
	const replace = requireNonEmptyString(params.replace, "replace");
	if (find === replace) {
		throw new Error("docx_replace 的 find 与 replace 完全相同，这次调用不会产生任何改动");
	}
	return { path, edits: [{ find, replace }] };
}

/** 目标路径 → 工作区内的绝对路径；越界/逃逸一律给出可读拒绝，不静默降级。 */
function resolveTarget(cwd, rawPath) {
	const absPath = resolveInsideWorkspace(cwd, rawPath);
	if (absPath === undefined) {
		throw new Error(
			"docx_replace 只能修改工作区内的文件：这次的目标路径不在工作区内，或经符号链接指向了工作区外（空路径与含 NUL 的路径同样拒绝）。文件未修改。请改用工作区内的路径。",
		);
	}
	return absPath;
}

/** 扩展名 / 存在性 / 普通文件 / 体积四道检查；返回 stat 结果。 */
function statTarget(absPath) {
	if (extname(absPath).toLowerCase() !== DOCX_EXTENSION) {
		throw new Error(
			`docx_replace 只接受 .docx 文件（收到 ${extname(absPath) || "无扩展名"}）。其它格式请在 Word 里另存为 .docx 后再试；文件未修改。`,
		);
	}
	let stats;
	try {
		stats = statSync(absPath);
	} catch (error) {
		const code = error !== null && typeof error === "object" ? error.code : undefined;
		if (code === "ENOENT") {
			throw new Error(`目标文件不存在：${absPath}。请确认路径来自工作区内的真实文件（不要凭记忆拼写）；文件未修改。`);
		}
		throw new Error(`读取目标文件信息失败（${error instanceof Error ? error.message : String(error)}）；文件未修改。`);
	}
	if (!stats.isFile()) {
		throw new Error(`目标路径不是普通文件（可能是目录）：${absPath}；文件未修改。`);
	}
	if (stats.size > DOCX_REPLACE_MAX_BYTES) {
		throw new Error(
			`目标文件超过 docx_replace 的 ${Math.round(DOCX_REPLACE_MAX_BYTES / (1024 * 1024))} MiB 上限（${stats.size} 字节）。这类文件请在 Word 里手动修改；文件未修改。`,
		);
	}
	return stats;
}

function readTargetBytes(absPath) {
	try {
		return readFileSync(absPath);
	} catch (error) {
		throw new Error(`读取目标文件失败（${error instanceof Error ? error.message : String(error)}）；文件未修改。`);
	}
}

/** ensure 失败 → 审计 runtime + 可读引导。修复前不要在原文上改。 */
async function ensureRuntime(options) {
	const ensure = options.ensure ?? ensurePythonRuntime;
	const runtimeOptions = defaultPythonRuntimeOptions({
		engineDir: options.engineDir,
		homeDir: options.homeDir,
		platform: options.platform ?? process.platform,
	});
	const env = await ensure(runtimeOptions, defaultSpawn);
	if (env?.status !== "ready") {
		audit(
			options,
			"runtime",
			"failed",
			`docx 替换运行时未就绪（${env?.phase ?? "unknown"}）：${env?.error ?? "未知原因"}`,
		);
		throw new Error(
			`docx 替换环境未就绪（${env?.phase ?? "unknown"}）：${env?.error ?? "未知原因"}\n请到「设置 → 内置运行时」安装后再试；修复前可以在 Word 里手动修改这份文档。文件未修改。`,
		);
	}
	return env;
}

/** 引擎错误 → 面向模型的完整文案（原消息 + v1 边界引导）。 */
function describePatchFailure(error, name) {
	const message = error instanceof Error ? error.message : String(error);
	const code = error instanceof DocxPatchError ? error.code : "unknown";
	const edit =
		typeof error?.editIndex === "number" ? ` 第 ${error.editIndex + 1} 条替换` : "";
	const where = `${name}${edit}${code === "unknown" ? "" : `（${code}）`}`;
	if (SEMANTIC_ENGINE_CODES.has(code)) {
		return `${message}\n只处理正文部件 word/document.xml 里**唯一命中**的纯文本（可以跨同格式的相邻 run）；找不到原文、多处命中、跨格式不同的 run，或中间夹着制表符/换行，请在 Word 里手动修改（${where}）。文件未修改。`;
	}
	return `${message}\n文件未修改（${where}）。可重试一次；反复失败请检查目标文件是否被占用、运行时是否正常。`;
}

function toolResult(payload) {
	return {
		content: [{ type: "text", text: JSON.stringify(payload) }],
		details: payload,
	};
}

/**
 * 注册 docx_replace 工具。
 *
 * @param {object} options
 * @param {string} options.cwd 工作区根（路径判定的锚点）
 * @param {string} options.engineDir docx 引擎目录（`patch_docx.py` 所在处）
 * @param {string} [options.homeDir] 运行时选项用
 * @param {() => boolean} [options.getDocEditMode] 修订模式**现读**（按桶状态）
 * @param {() => string} [options.getSessionId] 版本 / 建议归属的会话 id
 * @param {string} [options.docsDir] 建议存储目录（测试注入；缺省走配置目录）
 * @param {string} [options.versionsDir] 版本存储目录（测试注入）
 * @param {string} [options.auditDir] 审计目录（测试注入）
 * @param {Function} [options.ensure] 运行时 ensure（同 doc-extract，测试注入）
 * @param {Function} [options.patch] 引擎调用（同 docx-patch.patchDocx，测试注入）
 * @param {Function} [options.recordBinaryVersion] 版本记录（测试注入）
 * @param {Function} [options.run] 传给 patchDocx 的进程执行器（测试注入）
 * @param {Function} [options.onAudit] 审计写入函数（宿主注入 writeAuditRecord）
 * @param {() => number} [options.now] 固定时钟（测试注入）
 */
function createDocxReplaceTool(options) {
	const { cwd } = options;
	return (pi) => {
		pi.registerTool({
			name: DOCX_REPLACE_TOOL_NAME,
			label: "在原 docx 上替换文本",
			description:
				"在已有的 .docx 文件正文里做一次文本替换（find → replace），保留原文档版式。只处理正文部件 word/document.xml，且原文必须在正文里**唯一命中**；原文可以跨**同格式**的相邻 run（Word 常把一句话拆开，这是正常情况），但跨格式不同的 run、中间夹制表符或换行仍会拒绝。找不到、多处命中、跨格式的 run 都会说明原因 —— 这类情况请在 Word 里手动修改，不要改用 powershell 直接改压缩包。修改前先用 read_document 确认原文与文档里逐字一致（含标点与空格）。修订模式开启时不会写盘，而是保存为待审建议，由用户在审阅台接受或拒绝。Python 环境按需安装、不会自动下载。",
			promptSnippet:
				"docx_replace: 在 .docx 正文里替换唯一命中的一段原文（path + find + replace），保留版式；可跨同格式 run，跨格式 run / 多处命中会被拒绝",
			promptGuidelines: [
				"只在用户明确要求修改**已有** docx 时使用；要重新生成整份文档用 docx_convert（那会丢原版式）。",
				"find 必须与文档正文逐字一致且唯一命中；一句话被 Word 拆成同格式的多个 run 时可以正常替换，但跨格式不同 run 或夹着制表符/换行会被拒绝。被拒绝时把原因如实转述给用户，不要原样重试、也不要绕过本工具直接改 zip。",
				"修订模式开启时这一步不会写盘：告诉用户改动已存为待审建议，需要到审阅台接受后才生效。",
			],
			parameters: Type.Object({
				path: Type.String({ description: "要修改的 .docx 文件路径（必须位于工作区内）。" }),
				edits: Type.Optional(
					Type.Array(
						Type.Object({
							find: Type.String({ description: "要替换的原文；必须与文档正文逐字一致，且在正文里只出现一次。" }),
							replace: Type.String({ description: "替换后的文本（非空）。" }),
						}),
						{
							description:
								"一次提交多条替换（最多 50 条）；每条独立要求唯一命中。与 find/replace 二选一。",
						},
					),
				),
				find: Type.Optional(
					Type.String({ description: "单条替换的原文；与 edits 二选一。" }),
				),
				replace: Type.Optional(
					Type.String({ description: "单条替换后的文本（非空）；与 edits 二选一。" }),
				),
			}),
			async execute(_toolCallId, params) {
				const input = normalizeParams(params);
				const absPath = resolveTarget(cwd, input.path);
				statTarget(absPath);
				const bytes = readTargetBytes(absPath);
				const baseSha256 = sha256Bytes(bytes);
				const sessionId = options.getSessionId?.() ?? "";
				const name = basename(absPath);

				/* ── 修订模式：只生成建议，不碰 Python、不碰原文件 ─────────────── */
				if (options.getDocEditMode?.() === true) {
					let proposal;
					let saved;
					try {
						proposal = buildDocxProposal({
							absPath,
							baseSha256,
							edits: input.edits,
							part: DEFAULT_PATCH_PART,
							sessionId,
							toolName: DOCX_REPLACE_TOOL_NAME,
							at: nowOf(options),
						});
						saved = saveProposal(proposal, { dir: options.docsDir });
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						throw new Error(`生成待审建议失败（${message}）；文件未修改。如需直接改动，请让用户先关闭修订模式。`);
					}
					return toolResult({
						type: "docx_replace_suggestion",
						id: saved.id,
						path: absPath,
						part: proposal.part,
						edits: proposal.edits,
						message:
							proposal.edits.length === 1
								? "修订模式已开启：这次替换已保存为待审建议，**文件尚未修改**。请告知用户到审阅台接受或拒绝，不要原样重试。"
								: `修订模式已开启：这 ${proposal.edits.length} 处替换已保存为一条待审建议，**文件尚未修改**。请告知用户到审阅台逐条勾选后接受或拒绝，不要原样重试。`,
					});
				}

				/* ── 直接写回：哈希守卫 → 版本 → 引擎 → 审计 ─────────────────── */
				const env = await ensureRuntime(options);

				/*
				 * ensure 可能耗时数分钟（首次安装运行时）。期间用户手改过文件的话，
				 * 记下的「旧版本」与引擎实际读到的字节就不是同一份 —— 这里重读并复算
				 * 哈希，不一致直接拒绝（这是直接写回路径上的哈希守卫）。
				 */
				const currentBytes = readTargetBytes(absPath);
				if (sha256Bytes(currentBytes) !== baseSha256) {
					audit(options, "file", "failed", `docx_replace 中止：原文在准备运行时期间发生变化（${name}），未写入`);
					throw new Error(
						"原文已变化：在准备 docx 运行时的过程中，这份文件被改动过。为避免覆盖这些改动，本次没有修改文件。请重新读取文件、确认要替换的原文后再调用一次。",
					);
				}

				const recordVersionFn = options.recordBinaryVersion ?? recordBinaryVersion;
				const recorded = recordVersionFn(
					{
						path: absPath,
						bytes: currentBytes,
						at: nowOf(options),
						sessionId,
						tool: DOCX_REPLACE_TOOL_NAME,
					},
					{ dir: options.versionsDir },
				);
				if (recorded?.recorded !== true) {
					const reason = versionFailureText(recorded, true);
					audit(options, "file", "failed", `docx_replace 中止：写回前无法保存旧版本（${name}）：${reason}`);
					throw new Error(
						`无法在写回前保存旧版本（${reason}），为避免改坏之后退不回去，本次没有修改文件。可以改用修订模式（不写盘，先存为建议），或在 Word 里手动修改。`,
					);
				}

				let result;
				try {
					result = await applyDocxEditsToFile({
						path: absPath,
						bytes: currentBytes,
						edits: input.edits,
						python: env.python,
						engineDir: options.engineDir,
						part: DEFAULT_PATCH_PART,
						patch: options.patch,
						run: options.run,
					});
				} catch (error) {
					const detail = error instanceof Error ? error.message : String(error);
					const code = error instanceof DocxPatchError ? error.code : "unknown";
					audit(options, "file", "failed", `docx_replace 失败（${name}，${code}）：${detail}`);
					throw new Error(describePatchFailure(error, name));
				}

				audit(
					options,
					"file",
					"allowed",
					`docx_replace：替换 ${name} 正文中的 ${result.replaced} 处（共 ${result.bytesBefore} → ${result.bytesAfter} 字节${result.crossRunMerged === true ? "，跨 run 合并" : ""}）`,
				);
				return toolResult({
					type: "docx_replace_result",
					path: absPath,
					part: DEFAULT_PATCH_PART,
					replaced: result.replaced,
					mergedRuns: result.crossRunMerged === true,
					bytesBefore: result.bytesBefore,
					bytesAfter: result.bytesAfter,
					message:
						result.replaced === 1
							? "已在原文件上完成替换；改动前的旧版本已保存在文件历史里，可以回退。"
							: `已在原文件上完成 ${result.replaced} 处替换；改动前的旧版本已保存在文件历史里，可以回退。`,
				});
			},
		});
	};
}

export {
	DOCX_EXTENSION,
	DOCX_REPLACE_MAX_BYTES,
	DOCX_REPLACE_TOOL_NAME,
	createDocxReplaceTool,
	normalizeParams,
};
