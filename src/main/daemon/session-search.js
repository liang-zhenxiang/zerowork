/**
 * 会话全文检索的**扫描层**：只做文件遍历与命中收集，不碰 Electron、不碰 IPC。
 *
 * 为什么单独一个模块：`session-files.js` import 了 pi 与会话管理器，单测里起不来；
 * 而「按 mtime 倒序、只扫最近 N 个、每会话几条命中、扫到上限要如实上报」
 * 这些行为恰恰最需要被钉住 —— 抽到只依赖 `node:fs` 的这一层，就能拿临时目录真跑。
 *
 * 语义与 Agent 工具 `conversation_search` 保持同一套：空格分词、所有词都要命中。
 * 区别只在「给人看」：返回多条命中 + `entryId` + 会话文件 `path`，供界面跳回原消息。
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { SCAN_LIMIT, searchFileHits } from "./session-state.js";

/**
 * 列出会话目录里的 `.jsonl`，按修改时间倒序。
 * 目录不存在时返回空数组（首启、或用户配了一个还没建过的目录），与既有
 * `searchSessionFiles` 的行为一致；其它错误继续抛。
 */
async function listSessionCandidates(sessionsDir) {
	let fileNames;
	try {
		fileNames = await readdir(sessionsDir);
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
	const candidates = [];
	for (const name of fileNames) {
		if (!name.toLowerCase().endsWith(".jsonl")) continue;
		const path = join(sessionsDir, name);
		try {
			candidates.push({ path, mtimeMs: (await stat(path)).mtimeMs });
		} catch {
			// 并发删除 / 权限变化：跳过这一个文件，不让整次检索失败
		}
	}
	candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return candidates;
}

function clampInt(value, min, max, fallback) {
	if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
	return Math.min(max, Math.max(min, value));
}

/**
 * 检索会话消息，按会话分组返回命中。
 *
 * @param {string} query 空格分词；空串 / 纯空白直接返回空结果（不扫盘）
 * @param {object} options
 * @param {string} options.sessionsDir 会话目录
 * @param {number} [options.limit] 最多返回几个会话（1..50，默认 20）
 * @param {number} [options.hitsPerSession] 每个会话最多几条命中（1..5，默认 3）
 * @param {string} [options.excludeSessionId] 要排除的会话（与 Agent 工具一致）
 */
async function searchSessionMessages(query, options) {
	const text = typeof query === "string" ? query.trim() : "";
	const terms = text.toLowerCase().split(/\s+/).filter((term) => term !== "");
	const empty = {
		query: text,
		scanned: 0,
		scannedLimit: SCAN_LIMIT,
		truncated: false,
		capped: false,
		sessions: [],
	};
	if (terms.length === 0) return empty;
	const candidates = await listSessionCandidates(options.sessionsDir);
	const sessionLimit = clampInt(options.limit, 1, 50, 20);
	const hitsPerSession = clampInt(options.hitsPerSession, 1, 5, 3);
	const sessions = [];
	let scanned = 0;
	for (const candidate of candidates.slice(0, SCAN_LIMIT)) {
		if (sessions.length >= sessionLimit) break;
		let content;
		try {
			content = await readFile(candidate.path, "utf8");
		} catch {
			continue;
		}
		scanned += 1;
		const found = searchFileHits(content, terms, { limit: hitsPerSession });
		if (found === null) continue;
		if (
			options.excludeSessionId !== void 0 &&
			found.sessionId === options.excludeSessionId
		) {
			continue;
		}
		sessions.push({
			sessionId: found.sessionId,
			title: found.title,
			path: candidate.path,
			modifiedAt: candidate.mtimeMs,
			totalHits: found.totalHits,
			hits: found.hits,
		});
	}
	return {
		query: text,
		scanned,
		scannedLimit: SCAN_LIMIT,
		// 「还有会话没扫到 / 没展示全」都要说出来：界面据此如实说明上限，
		// 而不是让使用者以为搜遍了全库
		truncated: candidates.length > scanned,
		// 与 truncated 不同的截断：命中会话数到了 limit 就停，后面的文件**根本没读**。
		// 这两种「没搜全」在界面上要分开说，否则会把「显示上限」误报成「扫描上限」。
		capped: sessions.length >= sessionLimit && scanned < Math.min(candidates.length, SCAN_LIMIT),
		sessions,
	};
}

export { listSessionCandidates, searchSessionMessages };
