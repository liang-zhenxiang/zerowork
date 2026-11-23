/**
 * 修订模式（#456）：开启时把 Agent 的 write / edit 变成**待审建议**，不落盘。
 *
 * ## 为什么是独立模块
 *
 * 与 version-store.js / review.js 同一套理由：`session-files.js` 在模块顶层
 * `requireParentPort()` 并 `loadResources()`，在 Electron utilityProcess 之外
 * 根本 import 不了。把「建议的生成与存储」放那里等于放弃单测。
 * 这里**不 import Electron**（只碰 node:fs / node:crypto / node:path 与本目录的
 * config-paths、session-view、audit、version-store —— 后两者同样不碰 Electron），
 * vitest 可以直接 import。
 *
 * ## 语义（与 PRD #456 一一对应）
 *
 * - 只处理**工作区内**的 `.md` / `.markdown` / `.txt`；其它路径与扩展名**明确拒绝**，
 *   绝不静默退化成「直接写」——「宁可拒绝，也不静默降级」。
 * - 建议存 `<config>/doc-edits/<id>.json`，含前后全文与结构化 hunk：
 *   `{ id, path, baseSha256, before, after, ops, hunks, sessionId, createdAt, toolName }`。
 * - 前后全文各限 1 MiB；diff 矩阵沿用 `session-view.js` 的 `DIFF_CELL_BUDGET`，
 *   超限同样拒绝（与整文件 diff 同一口径，不另定一个数）。
 * - 最多保留 `DOC_EDIT_MAX_ENTRIES` 条，超出丢最旧的（与 version-store 同纪律）。
 *
 * hunk 只是**视图**：`before` / `after` 才是唯一真相，写回（#458）按 hunk 的
 * `opsStart` / `opsEnd` 在原 ops 区间上应用即可，不需要重新做一次 diff。
 *
 * ## 写回（#458）
 *
 * 接受一条建议要同时成立三件事，缺一不可（顺序见 `applyProposal`）：
 * 只应用**选中的 hunk**、当前文件哈希仍等于 `baseSha256`（否则拒绝并让用户重新生成）、
 * 写盘前把当前内容交给 `version-store`（没有旧版本就不写）。
 * 拒绝只丢建议、**不碰目标文件**；接受 / 拒绝 / 过期都写一条 `file` 类审计，
 * detail 只记 id、文件名与段数 —— **不记文档正文**。
 */
import { createHash, randomBytes } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { clipAuditDetail, writeAuditRecord } from "./audit.js";
import { getConfigDir } from "./config-paths.js";
import { recordVersion } from "./version-store.js";
import { DIFF_CELL_BUDGET, DIFF_CONTEXT, applyEdits } from "./session-view.js";
import { DOC_EDIT_BLOCK_PREFIX } from "../../shared/doc-edit.js";

/** 单侧（前后各算一次）体积上限：1 MiB。 */
const DOC_EDIT_MAX_BYTES = 1024 * 1024;

/** 同时保留的待审建议条数；超出丢最旧的。 */
const DOC_EDIT_MAX_ENTRIES = 100;

/** 允许进入修订模式的扩展名（大小写不敏感）。 */
const DOC_EDIT_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

/** 储存 id：`<base36 时间戳>-<6 位随机 hex>`。不接受调用方传入 id。 */
const DOC_EDIT_ID_RE = /^[a-z0-9]+-[a-f0-9]{6}$/;

const PROPOSAL_EXT = ".json";
const TMP_SUFFIX = ".tmp";

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 是否是修订模式支持的文本文件（只按扩展名判定，不读内容）。 */
function isTextEditPath(filePath) {
	if (typeof filePath !== "string" || filePath === "") return false;
	return DOC_EDIT_EXTENSIONS.has(extname(filePath).toLowerCase());
}

function inside(root, target) {
	const rel = relative(root, target);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * 真实路径的包含判定，**允许相等**：目标还不存在时最近已存在祖先可能就是
 * 工作区根本身（`/ws/new-dir/new.md` → 祖先 `/ws`），此时它不越界。
 * 词法侧的 `inside` 仍然要求严格在根之内，两道一起用。
 */
function insideOrSelf(root, target) {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** 路径存在就 realpath，不存在按 resolve 的写法返回（macOS /tmp 与 /private/tmp 同源）。 */
function realPathOrSelf(path) {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/**
 * 目标不存在时，向上找到最近的已存在祖先再 realpath。
 *
 * 用途：写新文件时目标本身还没有 inode，但它所在的目录可能是一条**指向工作区外**
 * 的符号链接。只比 `resolve` 的文本会让「工作区内的链接 → 区外目录 → 新文件」
 * 绕过 containment 判定；跟着祖先展开一次就挡住了。
 */
function nearestExistingReal(path) {
	let current = resolve(path);
	for (;;) {
		try {
			return realpathSync(current);
		} catch {
			const parent = dirname(current);
			if (parent === current) return current;
			current = parent;
		}
	}
}

function caseFold(path) {
	return process.platform === "win32" ? path.toLowerCase() : path;
}

/**
 * 把工具入参里的路径解析成工作区内的绝对路径。
 *
 * 越界（`..`、绝对路径在工作区外）、空路径、含 NUL 的路径、以及**经符号链接
 * 逃出工作区**的路径一律返回 `undefined`。v1 只用它做「写建议」的入口 ——
 * 不让修订模式成为跨目录读文件的新通道，所以 realpath 检查是必需的。
 */
function resolveInsideWorkspace(cwd, rawPath) {
	if (typeof cwd !== "string" || cwd === "") return undefined;
	if (typeof rawPath !== "string" || rawPath.trim() === "" || rawPath.includes("\0")) return undefined;
	const root = resolve(cwd);
	const target = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
	if (!inside(root, target)) return undefined;
	if (!insideOrSelf(caseFold(realPathOrSelf(root)), caseFold(nearestExistingReal(target)))) return undefined;
	return target;
}

/**
 * 按工具名把入参折成「改后全文」。无法生成时返回 `undefined`：
 * - `write`：`content` 必须是字符串；
 * - `edit`：`edits` 必须是非空数组，且每条 `oldText` 都能在 `before` 里找到
 *   （找不到就返回 undefined —— 不产出半截建议，也不允许静默跳过那一条）。
 */
function applyToolInput(toolName, input, before) {
	if (!isPlainObject(input)) return undefined;
	if (toolName === "write") {
		return typeof input.content === "string" ? input.content : undefined;
	}
	if (toolName !== "edit") return undefined;
	const { edits } = input;
	if (!Array.isArray(edits) || edits.length === 0) return undefined;
	const pairs = [];
	for (const edit of edits) {
		if (!isPlainObject(edit)) return undefined;
		const { oldText, newText } = edit;
		if (typeof oldText !== "string" || oldText === "") return undefined;
		if (typeof newText !== "string") return undefined;
		pairs.push({ oldText, newText });
	}
	return applyEdits(before, pairs);
}

/**
 * 逐行 diff（与 `session-view.js` 的 `buildHunks` 同一个 LCS 口径，但保留 ops 区间）。
 * 矩阵超过 `DIFF_CELL_BUDGET` 时返回 `undefined`，由调用方给出「规模超限」的拒绝。
 */
function lineOps(before, after) {
	const oldLines = before === "" ? [] : before.split("\n");
	const newLines = after === "" ? [] : after.split("\n");
	const m = oldLines.length;
	const n = newLines.length;
	if (m * n > DIFF_CELL_BUDGET) return undefined;
	const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
	for (let i = m - 1; i >= 0; i -= 1) {
		for (let j = n - 1; j >= 0; j -= 1) {
			const skipOld = dp[i + 1]?.[j] ?? 0;
			const skipNew = dp[i]?.[j + 1] ?? 0;
			const both = dp[i + 1]?.[j + 1] ?? 0;
			const row = dp[i];
			if (row !== void 0) {
				row[j] = oldLines[i] === newLines[j] ? both + 1 : Math.max(skipOld, skipNew);
			}
		}
	}
	const ops = [];
	let i = 0;
	let j = 0;
	while (i < m && j < n) {
		if (oldLines[i] === newLines[j]) {
			ops.push({ type: " ", text: oldLines[i] ?? "" });
			i += 1;
			j += 1;
		} else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) {
			ops.push({ type: "-", text: oldLines[i] ?? "" });
			i += 1;
		} else {
			ops.push({ type: "+", text: newLines[j] ?? "" });
			j += 1;
		}
	}
	while (i < m) {
		ops.push({ type: "-", text: oldLines[i] ?? "" });
		i += 1;
	}
	while (j < n) {
		ops.push({ type: "+", text: newLines[j] ?? "" });
		j += 1;
	}
	return ops;
}

/**
 * 把 ops 分组成结构化 hunk（改动块 + 前后 `DIFF_CONTEXT` 行上下文）。
 *
 * 与 `session-view.buildHunks` 的分组判据一致（间距 > context*2 就断开），
 * 但输出的是**区间 + 行**而不是 unified diff 文本：`opsStart` / `opsEnd`
 * 是原 ops 的闭区间下标，写回时按它应用即可（#458）。
 */
function groupHunks(ops, context = DIFF_CONTEXT) {
	const changeIdx = [];
	for (let k = 0; k < ops.length; k += 1) {
		if (ops[k]?.type !== " ") changeIdx.push(k);
	}
	if (changeIdx.length === 0) return [];
	const blocks = [];
	let blockStart = changeIdx[0] ?? 0;
	let previous = blockStart;
	for (const idx of changeIdx) {
		if (idx - previous > context * 2) {
			blocks.push([blockStart, previous]);
			blockStart = idx;
		}
		previous = idx;
	}
	blocks.push([blockStart, previous]);
	return blocks.map(([changeStart, changeEnd], index) => {
		const opsStart = Math.max(0, changeStart - context);
		const opsEnd = Math.min(ops.length - 1, changeEnd + context);
		const slice = ops.slice(opsStart, opsEnd + 1);
		let added = 0;
		let removed = 0;
		for (const op of slice) {
			if (op.type === "+") added += 1;
			else if (op.type === "-") removed += 1;
		}
		const oldStart = ops.slice(0, opsStart).filter((op) => op.type !== "+").length + 1;
		const newStart = ops.slice(0, opsStart).filter((op) => op.type !== "-").length + 1;
		return {
			id: `h${index + 1}`,
			opsStart,
			opsEnd,
			oldStart,
			newStart,
			added,
			removed,
			lines: slice.map((op) => ({ type: op.type, text: op.text })),
		};
	});
}

function sha256(text) {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function byteLength(text) {
	return Buffer.byteLength(text, "utf8");
}

function makeId(at) {
	return `${Math.trunc(at).toString(36)}-${randomBytes(3).toString("hex")}`;
}

function isDocEditId(id) {
	return typeof id === "string" && DOC_EDIT_ID_RE.test(id);
}

function countOps(ops) {
	let added = 0;
	let removed = 0;
	for (const op of ops) {
		if (op.type === "+") added += 1;
		else if (op.type === "-") removed += 1;
	}
	return { added, removed };
}

/**
 * 生成一条待审建议（**纯计算**，不碰磁盘）。
 *
 * 拒绝的四种情形都抛 `Error`（消息直接给模型 / 用户看）：
 * 输入不完整、前后无实际改动、单侧超过 1 MiB、diff 矩阵超过 `DIFF_CELL_BUDGET`。
 * id 在这里生成，**不接受调用方传入** —— 存储层的路径由它决定，外部可控的 id
 * 就是一条路径穿越的入口。
 */
function buildProposal({ absPath, before, after, sessionId, toolName, at } = {}) {
	if (typeof absPath !== "string" || absPath === "") throw new Error("缺少目标文件的绝对路径，无法生成待审建议");
	if (typeof before !== "string" || typeof after !== "string") throw new Error("缺少改动前后的内容，无法生成待审建议");
	if (before === after) throw new Error("这次写入没有产生任何实际改动（改后内容与原文逐字相同）");
	const beforeBytes = byteLength(before);
	const afterBytes = byteLength(after);
	if (beforeBytes > DOC_EDIT_MAX_BYTES || afterBytes > DOC_EDIT_MAX_BYTES) {
		throw new Error(`文件超过修订模式的 1 MiB 上限（改前 ${beforeBytes} 字节 / 改后 ${afterBytes} 字节）`);
	}
	const ops = lineOps(before, after);
	if (ops === undefined) {
		throw new Error("改动规模超出修订模式的处理上限（逐行 diff 超过 4,000,000 格）");
	}
	const createdAt = typeof at === "number" && Number.isFinite(at) ? at : Date.now();
	return {
		id: makeId(createdAt),
		path: absPath,
		baseSha256: sha256(before),
		before,
		after,
		ops,
		hunks: groupHunks(ops),
		sessionId: typeof sessionId === "string" ? sessionId : "",
		createdAt,
		toolName: typeof toolName === "string" ? toolName : "",
	};
}

/** 列表用的元数据：不带前后全文（列表可能一次列 100 条）。 */
function summarize(proposal) {
	const { added, removed } = countOps(proposal.ops);
	return {
		id: proposal.id,
		path: proposal.path,
		name: basename(proposal.path),
		sessionId: proposal.sessionId,
		createdAt: proposal.createdAt,
		hunkCount: proposal.hunks.length,
		added,
		removed,
		toolName: proposal.toolName,
	};
}

/**
 * 读回并校验一条建议。结构不对返回 `undefined`（调用方按「已损坏 / 不存在」处理），
 * 不抛 —— 单条坏记录不该让整个列表或某个读取入口炸掉。
 */
function parseProposal(raw) {
	if (!isPlainObject(raw)) return undefined;
	if (!isDocEditId(raw.id)) return undefined;
	if (typeof raw.path !== "string" || raw.path === "") return undefined;
	if (typeof raw.baseSha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.baseSha256)) return undefined;
	if (typeof raw.before !== "string" || typeof raw.after !== "string") return undefined;
	if (typeof raw.createdAt !== "number" || !Number.isFinite(raw.createdAt)) return undefined;
	if (!Array.isArray(raw.ops) || !Array.isArray(raw.hunks)) return undefined;
	for (const op of raw.ops) {
		if (!isPlainObject(op) || ![" ", "-", "+"].includes(op.type) || typeof op.text !== "string") return undefined;
	}
	return {
		id: raw.id,
		path: raw.path,
		baseSha256: raw.baseSha256,
		before: raw.before,
		after: raw.after,
		ops: raw.ops.map((op) => ({ type: op.type, text: op.text })),
		hunks: raw.hunks,
		sessionId: typeof raw.sessionId === "string" ? raw.sessionId : "",
		createdAt: raw.createdAt,
		toolName: typeof raw.toolName === "string" ? raw.toolName : "",
	};
}

function docEditsDir(dir) {
	return dir ?? join(getConfigDir(), "doc-edits");
}

function proposalPath(id, dir) {
	return join(docEditsDir(dir), `${id}${PROPOSAL_EXT}`);
}

function readProposalFile(path) {
	let raw;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	try {
		return parseProposal(JSON.parse(raw));
	} catch {
		return undefined;
	}
}

/**
 * 扫一遍目录，返回 `{ entries, skipped, files }`：
 * `entries` 是**已解析成功**的元数据（按 createdAt 倒序），`skipped` 是坏 JSON
 * 的条数（计数而不是静默吞掉）。`files` 供裁剪时定位最旧的那几条。
 */
function scan(dir) {
	const root = docEditsDir(dir);
	let names;
	try {
		names = readdirSync(root);
	} catch {
		return { entries: [], skipped: 0, files: [] };
	}
	const entries = [];
	const files = [];
	let skipped = 0;
	for (const name of names) {
		if (!name.endsWith(PROPOSAL_EXT)) continue;
		const id = name.slice(0, -PROPOSAL_EXT.length);
		if (!isDocEditId(id)) continue;
		const proposal = readProposalFile(join(root, name));
		if (proposal === undefined) {
			skipped += 1;
			continue;
		}
		entries.push(summarize(proposal));
		files.push({ id, createdAt: proposal.createdAt, origin: join(root, name) });
	}
	entries.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
	files.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
	return { entries, skipped, files };
}

/**
 * 落盘一条建议（**临时文件 + rename**，与 pin.js / version-store 同款）。
 *
 * 写完后按 `DOC_EDIT_MAX_ENTRIES` 裁剪最旧的条目。返回 `{ id, path }`；
 * IO 错误向上抛 —— 调用方（拦截扩展）会把它翻成「建议没存下来，本次写入未执行」
 * 的拒绝，**不能**在这种情况下放行写入。
 */
function saveProposal(proposal, options = {}) {
	if (!isPlainObject(proposal)) throw new Error("待审建议的形态不正确");
	if (!isDocEditId(proposal.id)) throw new Error("待审建议的 id 不合法");
	const dir = docEditsDir(options.dir);
	mkdirSync(dir, { recursive: true });
	const target = proposalPath(proposal.id, dir);
	const tmp = `${target}${TMP_SUFFIX}`;
	writeFileSync(tmp, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
	renameSync(tmp, target);
	prune(dir);
	return { id: proposal.id, path: target };
}

/** 条目超过上限时删最旧的（坏 JSON 不计入、也不删 —— 不知道它是什么就别动它）。 */
function prune(dir) {
	let names;
	try {
		names = readdirSync(dir);
	} catch {
		return 0;
	}
	// 常见的保存路径不该为了一条新建议把 100 份全文都读一遍：先数文件名。
	const count = names.filter((name) => name.endsWith(PROPOSAL_EXT)).length;
	if (count <= DOC_EDIT_MAX_ENTRIES) return 0;
	const { files } = scan(dir);
	if (files.length <= DOC_EDIT_MAX_ENTRIES) return 0;
	let dropped = 0;
	for (const file of files.slice(DOC_EDIT_MAX_ENTRIES)) {
		try {
			rmSync(file.origin, { force: true });
			dropped += 1;
		} catch {
			// 删不掉不影响新建议已成立；下一次保存会再试。
		}
	}
	return dropped;
}

/** 列表：只回元数据，按创建时间倒序；坏 JSON 跳过并计数。 */
function listProposals(options = {}) {
	const { entries, skipped } = scan(options.dir);
	return { entries, skipped };
}

/** 读一条完整建议；不存在或记录已损坏返回 `undefined`，id 格式非法抛错。 */
function readProposal(id, options = {}) {
	if (!isDocEditId(id)) throw new Error(`修订建议 id 格式不正确：${String(id)}`);
	const path = proposalPath(id, options.dir);
	if (!existsSync(path)) return undefined;
	return readProposalFile(path);
}

/** 删一条建议；不存在返回 `{ deleted: false }`（不抛，id 格式非法才抛）。 */
function deleteProposal(id, options = {}) {
	if (!isDocEditId(id)) throw new Error(`修订建议 id 格式不正确：${String(id)}`);
	const path = proposalPath(id, options.dir);
	if (!existsSync(path)) return { deleted: false };
	rmSync(path, { force: true });
	return { deleted: true };
}

/**
 * 读目标文件的当前状态（**写回与新鲜度共用同一个口径**）。
 *
 * 不存在按空串（与生成建议时 `readBefore` 的口径一致：新建文件时 baseSha256
 * 就是空串的哈希），`exists` 单独给出 —— 新建文件的建议在写回时不该被当成
 * 「文件丢了」，也不该留下一条空内容的旧版本。
 * 目录与超过 1 MiB 抛错（与生成侧同一个上限）。
 */
function readCurrentState(absPath) {
	let stats;
	try {
		stats = statSync(absPath);
	} catch (error) {
		if (error !== null && typeof error === "object" && error.code === "ENOENT") {
			return { exists: false, text: "" };
		}
		throw error;
	}
	if (stats.isDirectory()) throw new Error("目标路径是一个目录，不是文件");
	if (stats.size > DOC_EDIT_MAX_BYTES) {
		throw new Error(`文件超过修订模式的 1 MiB 上限（${stats.size} 字节）`);
	}
	return { exists: true, text: readFileSync(absPath, "utf8"), mode: stats.mode & 0o777 };
}

/** 读目标文件：不存在按空串（write 新建 / edit 必然失败），超过 1 MiB 抛错。 */
function readBefore(absPath) {
	return readCurrentState(absPath).text;
}

/* ──────────────────────────────────────────────────────────────────────────
 * 写回（#458）：选中 hunk 合并 → 哈希守卫 → 版本快照 → 原子写 → 审计
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * 把建议的逐行 ops 按**选中的 hunk** 合并成一份全文（**纯函数**，不碰磁盘）。
 *
 * 判据只有一条：一个增删行**是否落在某个被选中的 hunk 的 `opsStart..opsEnd` 内**。
 * - 上下文行永远保留（它两侧同文，保留哪一个都是原文）；
 * - 选中的增删行按 diff 语义应用（`+` 追加、`-` 丢弃）；
 * - 未选中的增删行**回到原侧**（`-` 保留、`+` 丢弃）—— 未选中的 hunk 在写回时
 *   一并丢弃，「保留这条建议」这件事本身不用单独表达（design.md §5）。
 *
 * `hunkIds` 必须非空、每个都存在、无重复：静默忽略拼错的 id 会让用户以为
 * 「我选了它」而实际没选，那是一次不可见的丢改动。
 *
 * 返回 `{ text, appliedHunks }`，`appliedHunks` 按建议里的原顺序排列，每项带
 * `{ id, opsStart, opsEnd, added, removed }`（增删数**从 ops 现算**，不信坏数据里的字段）。
 */
function mergeSelectedHunks(proposal, hunkIds) {
	if (!isPlainObject(proposal)) throw new Error("缺少修订建议，无法合并改动");
	const ops = Array.isArray(proposal.ops) ? proposal.ops : [];
	const hunks = Array.isArray(proposal.hunks) ? proposal.hunks : [];
	if (!Array.isArray(hunkIds) || hunkIds.length === 0) {
		throw new Error("请至少选择一段要应用的改动");
	}
	const known = new Map();
	for (const hunk of hunks) {
		if (!isPlainObject(hunk) || typeof hunk.id !== "string" || hunk.id === "") continue;
		known.set(hunk.id, hunk);
	}
	const selected = new Set();
	for (const id of hunkIds) {
		if (typeof id !== "string" || !known.has(id)) {
			throw new Error(`这条建议里没有这一段改动：${String(id)}；文件没有被修改。`);
		}
		if (selected.has(id)) {
			throw new Error(`同一段改动的 id 重复了：${id}；文件没有被修改。`);
		}
		selected.add(id);
	}
	const marked = new Uint8Array(ops.length);
	const appliedHunks = [];
	for (const hunk of hunks) {
		if (!isPlainObject(hunk) || !selected.has(hunk.id)) continue;
		const start = hunk.opsStart;
		const end = hunk.opsEnd;
		if (
			!Number.isInteger(start) ||
			!Number.isInteger(end) ||
			start < 0 ||
			end < start ||
			end >= ops.length
		) {
			throw new Error("这条建议的结构已损坏（改动段的位置越界），请重新生成一次改动");
		}
		let added = 0;
		let removed = 0;
		for (let k = start; k <= end; k += 1) {
			marked[k] = 1;
			if (ops[k]?.type === "+") added += 1;
			else if (ops[k]?.type === "-") removed += 1;
		}
		appliedHunks.push({ id: hunk.id, opsStart: start, opsEnd: end, added, removed });
	}
	const lines = [];
	for (let k = 0; k < ops.length; k += 1) {
		const op = ops[k];
		if (op?.type === " ") {
			lines.push(typeof op.text === "string" ? op.text : "");
			continue;
		}
		const applied = marked[k] === 1;
		if (op?.type === "-") {
			if (!applied) lines.push(typeof op.text === "string" ? op.text : "");
		} else if (op?.type === "+") {
			if (applied) lines.push(typeof op.text === "string" ? op.text : "");
		}
	}
	return { text: lines.join("\n"), appliedHunks };
}

/**
 * 当前文件是否仍与建议的基准一致（**只读目标文件**）。
 *
 * 返回 `{ stale, currentSha256, missing, reason? }`：
 * - 哈希相等 → `stale: false`；
 * - 文件不存在但基准是空串哈希 → 仍是 `stale: false`（那是「新建文件」的建议，
 *   与生成侧 `readBefore` 对不存在的口径一致）；
 * - 其余 → `stale: true`，`reason` ∈ `"missing" | "changed" | "unreadable"`。
 *
 * IPC 读取建议时附带这两个字段（#457 据此禁用「接受」），所以本函数**不抛**：
 * 读不了目标文件也是一种「不能接受」的状态，不是一次异常。
 */
function checkFreshness(proposal, options = {}) {
	if (
		!isPlainObject(proposal) ||
		typeof proposal.path !== "string" ||
		proposal.path === "" ||
		typeof proposal.baseSha256 !== "string"
	) {
		return { stale: true, currentSha256: null, missing: false, reason: "invalid" };
	}
	let text = "";
	let missing = false;
	try {
		if (typeof options.readText === "function") {
			text = options.readText(proposal.path);
		} else {
			const state = readCurrentState(proposal.path);
			text = state.text;
			missing = !state.exists;
		}
	} catch (error) {
		return {
			stale: true,
			currentSha256: null,
			missing: false,
			reason: "unreadable",
			message: error instanceof Error ? error.message : String(error),
		};
	}
	const currentSha256 = sha256(typeof text === "string" ? text : "");
	if (currentSha256 === proposal.baseSha256) return { stale: false, currentSha256, missing };
	return { stale: true, currentSha256, missing, reason: missing ? "missing" : "changed" };
}

/**
 * 原子写：同目录临时文件 + rename（与 saveProposal / version-store 同款）。
 *
 * 临时文件必须与目标**同目录** —— 跨目录 rename 在多数文件系统上会退化成
 * 复制 + 删除，不再是原子的。`mode` 来自原文件的权限位，存在时保留。
 */
function writeAtomically(absPath, text, mode) {
	const dir = dirname(absPath);
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `.${basename(absPath)}.${randomBytes(6).toString("hex")}${TMP_SUFFIX}`);
	try {
		writeFileSync(tmp, text, mode === undefined ? { encoding: "utf8" } : { encoding: "utf8", mode });
		renameSync(tmp, absPath);
	} catch (error) {
		try {
			rmSync(tmp, { force: true });
		} catch {
			// 临时文件删不掉不影响「目标文件没被改」这个事实；下次写入用自己的临时名。
		}
		throw error;
	}
}

/** 写一条 file 类审计；detail 走 clipAuditDetail（≤240 字符），**不含文档正文**。 */
function writeFileAudit(outcome, detail, auditDir) {
	writeAuditRecord(
		{ category: "file", outcome, detail: clipAuditDetail(detail) },
		typeof auditDir === "string" && auditDir !== "" ? auditDir : undefined,
	);
}

/** `options.now` 既接受函数也接受数字（注入固定时钟，单测才可复现）。 */
function resolveNow(now) {
	if (typeof now === "function") {
		const value = now();
		return typeof value === "number" && Number.isFinite(value) ? value : Date.now();
	}
	if (typeof now === "number" && Number.isFinite(now)) return now;
	return Date.now();
}

/** 版本记录失败时的可读原因（错误要可诊断，不是一句「失败了」）。 */
function versionFailureText(recorded) {
	if (recorded?.reason === "io-error") {
		return `写入版本目录失败（${recorded.message ?? "未知 IO 错误"}）`;
	}
	if (recorded?.reason === "too-large") return "目标文件超过 1 MiB，无法留旧版本";
	if (recorded?.reason === "binary") return "目标文件看起来是二进制，无法留文本旧版本";
	if (recorded?.reason === "no-content" || recorded?.reason === "no-path") return "拿不到目标文件的当前内容";
	return `无法保存旧版本（${recorded?.reason ?? "未知原因"}）`;
}

/**
 * 接受一条建议：**只应用选中的 hunk**，并把结果写回目标文件。
 *
 * 顺序是契约，每一步失败都**不写盘**：
 *
 * 1. 读建议（不存在 / 损坏 → 可读错误）→ `mergeSelectedHunks`；
 * 2. 读当前文件并比对 `baseSha256` —— 不一致就拒绝（审计 `file/failed`，
 *    detail 只记 id / 文件名 / 段数，不记正文）。这是「建议不是依据最新原文
 *    生成的」的唯一判据，也是避免把用户之后的改动覆盖掉的那道闸；
 * 3. 写前 `version-store.recordVersion` 留一版旧内容 —— 失败（尤其是
 *    `io-error`）就**中止**：没有旧版本的写回不可回滚，违背「可回退」承诺；
 *    文件本来不存在（新建建议）时没有旧内容可留，跳过这一步；
 * 4. 原子写（同目录临时文件 + rename，保留原 mode）；
 * 5. 审计 `file/allowed`；
 * 6. 删除建议（删不掉不改变「已写入」这个事实，结果里如实给出 `proposalDeleted`）。
 *
 * 返回 `{ path, appliedHunks, added, removed, totalHunks, proposalDeleted }`。
 */
function applyProposal(id, hunkIds, options = {}) {
	if (!isDocEditId(id)) throw new Error(`修订建议 id 格式不正确：${String(id)}`);
	const proposal = readProposal(id, { dir: options.dir });
	if (proposal === undefined) {
		throw new Error(
			`找不到修订建议（或它的记录已损坏）：${id}；目标文件没有被修改。可以在审阅台重新生成一次改动。`,
		);
	}
	const name = basename(proposal.path);
	const { text, appliedHunks } = mergeSelectedHunks(proposal, hunkIds);
	const totalHunks = proposal.hunks.length;
	const appliedNote = `${appliedHunks.length}/${totalHunks} 段`;
	let added = 0;
	let removed = 0;
	for (const hunk of appliedHunks) {
		added += hunk.added;
		removed += hunk.removed;
	}

	let state;
	try {
		state = readCurrentState(proposal.path);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		writeFileAudit("failed", `接受修订建议 ${id} 中止：读取目标文件失败（${name}，${appliedNote}）：${message}`, options.auditDir);
		throw new Error(`读取目标文件失败（${message}），原文没有被修改。确认文件可读后重试。`);
	}

	const currentSha256 = sha256(state.text);
	if (currentSha256 !== proposal.baseSha256) {
		// 「原文已变化」是 PRD 指定的说法：#457 的按钮与提示文案都按它对齐。
		const why = state.exists ? "原文已变化" : "原文已变化（目标文件已不在）";
		writeFileAudit(
			"failed",
			`拒绝接受修订建议 ${id}：${why}（${name}，${appliedNote}），未写入`,
			options.auditDir,
		);
		throw new Error(
			"原文已变化，请重新生成：这条建议是依据更早的版本生成的，直接写回会覆盖掉之后的改动。目标文件没有被修改。",
		);
	}

	if (state.exists) {
		const recorded = recordVersion(
			{
				path: proposal.path,
				content: state.text,
				at: resolveNow(options.now),
				sessionId: proposal.sessionId,
				tool: "doc-edit",
				added,
				removed,
			},
			{ dir: options.versionsDir },
		);
		if (recorded.recorded !== true) {
			const reason = versionFailureText(recorded);
			writeFileAudit(
				"failed",
				`接受修订建议 ${id} 中止：写回前无法保存旧版本（${name}，${appliedNote}）：${reason}`,
				options.auditDir,
			);
			throw new Error(
				`无法在写回前保存旧版本（${reason}），为避免改坏之后退不回去，本次没有修改文件。清理磁盘空间或检查目标位置的写权限后重试。`,
			);
		}
	}

	try {
		writeAtomically(proposal.path, text, state.mode);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		writeFileAudit("failed", `接受修订建议 ${id} 中止：写入失败（${name}，${appliedNote}）：${message}`, options.auditDir);
		const escape = state.exists ? "旧内容已保存在文件历史里，可以从那里还原。" : "目标文件没有被创建。";
		throw new Error(`写入失败（${message}）。${escape}`);
	}

	writeFileAudit(
		"allowed",
		`接受修订建议 ${id}：应用 ${appliedNote}（+${added} / -${removed} 行），写入 ${name}`,
		options.auditDir,
	);

	let proposalDeleted = false;
	try {
		proposalDeleted = deleteProposal(id, { dir: options.dir }).deleted;
	} catch (error) {
		/*
		 * 文件已经写成功了，这里不能再抛（那会让用户以为写回失败）。
		 * 删不掉建议也不致命：UI 再点一次「接受」会被哈希守卫拦住，
		 * 因为原文已经变了。
		 */
		console.error(
			`[doc-edits] 建议文件删除失败（${id}）：${error instanceof Error ? error.message : String(error)}`,
		);
	}

	return { path: proposal.path, appliedHunks: appliedHunks.map((hunk) => hunk.id), added, removed, totalHunks, proposalDeleted };
}

/**
 * 拒绝一条建议：读建议 → 审计 `file/blocked` → 删除建议。**不读写目标文件。**
 *
 * 拒绝的是**整条建议**，不是单个 hunk —— 单条 hunk 的取舍用「不选」表达
 * （design.md §5）。返回 `{ rejected: true, deleted }`。
 */
function rejectProposal(id, options = {}) {
	if (!isDocEditId(id)) throw new Error(`修订建议 id 格式不正确：${String(id)}`);
	const proposal = readProposal(id, { dir: options.dir });
	if (proposal === undefined) {
		throw new Error(`找不到修订建议（或它的记录已损坏）：${id}；没有任何文件被改动。`);
	}
	writeFileAudit(
		"blocked",
		`用户拒绝修订建议 ${id}（${basename(proposal.path)}，${proposal.hunks.length} 段），目标文件未修改`,
		options.auditDir,
	);
	const { deleted } = deleteProposal(id, { dir: options.dir });
	return { rejected: true, deleted };
}

/**
 * tool_call 拦截扩展：修订模式开启时，把 write / edit 变成「生成建议 + block」。
 *
 * **注册位置是语义的一部分**：必须排在权限门（与 PreToolUse hook）**之后** ——
 * 权限 / hook 拒绝是终局，被拒的调用不该留下一条「看起来可以接受」的建议。
 *
 * 为什么用 `block` 而不是伪造成功回执：pi 的 tool_call 只支持 block；把原因写清楚
 * 让模型告诉用户「去审阅台」，比假装写入成功更诚实（也避免模型继续 edit 一个
 * 「它以为已经改了」的文件）。
 *
 * `options.isEnabled` 由 daemon 注入为**按桶状态现读**，所以开关一改，下一次工具
 * 调用立即生效，不需要重建宿主。
 */
function createDocEditExtension(options) {
	const { cwd, isEnabled, getSessionId, dir, now, onBlocked } = options;
	return (pi) => {
		pi.on("tool_call", async (event) => {
			if (isEnabled?.() !== true) return undefined;
			const toolName = event.toolName;
			if (toolName !== "write" && toolName !== "edit") return undefined;
			const input = event.input;
			if (!isPlainObject(input)) {
				return {
					block: true,
					reason: `${DOC_EDIT_BLOCK_PREFIX} 这次写入的参数不完整，无法生成待审建议，文件未修改。请按 write（path + content）或 edit（path + edits）的格式重新调用。`,
				};
			}
			const absPath = resolveInsideWorkspace(cwd, input.path);
			if (absPath === undefined) {
				return {
					block: true,
					reason: `${DOC_EDIT_BLOCK_PREFIX} 只能把工作区内的 .md / .markdown / .txt 写入保存为待审建议。这次的目标路径不在工作区内（或经符号链接指向了工作区外），文件未修改。请改用工作区内的路径；确实要写工作区外，请让用户先关闭修订模式。`,
				};
			}
			if (!isTextEditPath(absPath)) {
				return {
					block: true,
					reason: `${DOC_EDIT_BLOCK_PREFIX} 当前只支持 .md / .markdown / .txt 的文本修订。这次的目标不是这三类文件，文件未修改。请在回复里说明需要改动的内容，或让用户关闭修订模式后再写入。`,
				};
			}
			let before;
			try {
				before = readBefore(absPath);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					block: true,
					reason: `${DOC_EDIT_BLOCK_PREFIX} 读取目标文件失败（${message}），无法生成待审建议，文件未修改。请确认路径可读后重试。`,
				};
			}
			const after = applyToolInput(toolName, input, before);
			if (after === undefined) {
				return {
					block: true,
					reason: `${DOC_EDIT_BLOCK_PREFIX} 这次 edit 的 oldText 在目标文件里找不到（或参数不完整），无法生成待审建议，文件未修改。请先重新读取文件，确认要替换的原文与当前内容逐字一致；不要原样重试。`,
				};
			}
			let proposal;
			try {
				proposal = buildProposal({
					absPath,
					before,
					after,
					sessionId: getSessionId?.() ?? "",
					toolName,
					at: now?.(),
				});
				saveProposal(proposal, { dir });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					block: true,
					reason: `${DOC_EDIT_BLOCK_PREFIX} ${message}；本次写入未执行，文件未修改。如需直接改动，请让用户先关闭修订模式。`,
				};
			}
			const { added, removed } = countOps(proposal.ops);
			/*
			 * 给宿主留一张回执：pi 的 block 结果在 live 事件里拿不到可靠文本，
			 * 宿主按同一个 toolCallId 认领「这不是失败，是待审建议」（#456）。
			 */
			onBlocked?.({ toolCallId: typeof event.toolCallId === "string" ? event.toolCallId : "", proposalId: proposal.id, path: absPath });
			return {
				block: true,
				reason: `${DOC_EDIT_BLOCK_PREFIX} 本次改动已保存为待审建议（id ${proposal.id}，新增 ${added} 行 / 删除 ${removed} 行），文件尚未修改。请告知用户这条改动尚未生效，不要原样重试写入。`,
			};
		});
	};
}

export {
	DOC_EDIT_BLOCK_PREFIX,
	DOC_EDIT_EXTENSIONS,
	DOC_EDIT_ID_RE,
	DOC_EDIT_MAX_BYTES,
	DOC_EDIT_MAX_ENTRIES,
	applyProposal,
	applyToolInput,
	buildProposal,
	checkFreshness,
	createDocEditExtension,
	deleteProposal,
	docEditsDir,
	groupHunks,
	isDocEditId,
	isTextEditPath,
	lineOps,
	listProposals,
	mergeSelectedHunks,
	readProposal,
	rejectProposal,
	resolveInsideWorkspace,
	saveProposal,
	sha256,
	summarize,
};
