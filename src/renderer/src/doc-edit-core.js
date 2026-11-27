/**
 * 修订工作台（#457）的纯逻辑：按文件分组、默认全选、段选择汇总与全部文案。
 *
 * 与 review-core.js / file-history-core.js 同一分工：这一页真正容易错的不是布局，
 * 而是「分组与排序对不对」「接受时到底选了哪几段」「过期时说哪一句话」——
 * 这些在界面上只表现为一个数字或一句话，GUI 断言说不清，所以放进纯函数直测。
 *
 * 数据契约（doc-edits.js 的 summarize / readProposal）：
 *   列表项 { id, kind, path, name, sessionId, createdAt, hunkCount, added, removed,
 *            toolName, part? }
 *   详情   { ...列表字段, baseSha256, before, after, ops,
 *            hunks:[{ id, opsStart, opsEnd, oldStart, newStart, added, removed,
 *                     lines:[{ type:" "|"-"|"+", text }] }],
 *            stale, currentSha256, missing }
 *   docx 详情 { id, kind:"docx", path, baseSha256, part, find, replace, ... }
 *
 * 本模块不碰 DOM、不读磁盘，对坏数据宽容处理（缺 path / 缺 hunks 不抛）。
 */
import { formatDirLabel, formatToolName } from "./file-history-core.js";
import { formatHunkHeader, reviewSourceText } from "./review-core.js";

/** 空态一：一条建议都还没有（用户还没在修订模式下让 AI 改过文件）。 */
export const DOC_EDIT_EMPTY_TITLE = "还没有待修订的建议";
export const DOC_EDIT_EMPTY_DESC =
	"开启修订模式后，AI 的写入会先记录成待修订建议，出现在这里；在你确认之前，目标文件不会被修改。";

/** 空态二：有过建议，但都已接受或拒绝（与「一条都没有」分开说）。 */
export const DOC_EDIT_DONE_TITLE = "待修订的建议都处理完了";
export const DOC_EDIT_DONE_DESC = "接受或拒绝之后，这条队列就空了。切到「已变更」可以回看已经发生的改动。";

/** 过期条：PRD 指定的说法（「原文已变化」要原样出现，接受按钮据此禁用）。 */
export const DOC_EDIT_STALE_TEXT =
	"原文已变化（或文件已不在），这条建议不能直接接受。可以拒绝整条后，在对话里让 AI 重新生成；或手动对照下方内容修改。";

function finiteNumber(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pathText(value) {
	return typeof value === "string" ? value : "";
}

/** 路径里的文件名（列表项缺 name 时的兜底）。空路径返回空串。 */
export function proposalNameOf(path) {
	const trimmed = pathText(path).replace(/[\\/]+$/, "");
	const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	return cut >= 0 ? trimmed.slice(cut + 1) : trimmed;
}

/** 路径的父目录（跨平台：`/` 与 `\` 都认）。根目录或空路径返回空串。 */
export function proposalDirOf(path) {
	const trimmed = pathText(path).replace(/[\\/]+$/, "");
	const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	return cut <= 0 ? "" : trimmed.slice(0, cut);
}

function createdAtOf(entry) {
	return finiteNumber(entry?.createdAt) ?? 0;
}

function idOf(entry) {
	return typeof entry?.id === "string" ? entry.id : "";
}

/**
 * 按文件分组，组内与组间都按创建时间倒序（最新的建议最先看到）。
 *
 * 并列时用 id 做次键，保证同一批数据每次渲染的顺序都一样 —— 否则两次读取
 * 可能把同一文件的两条建议对调，用户刚取消的勾选看起来像「自己变了」。
 * 坏记录（null / 非对象）直接跳过；缺 path 的归到空路径那一组，不丢信息也不抛。
 */
export function groupProposalsByPath(entries) {
	const list = Array.isArray(entries) ? entries : [];
	const groups = new Map();
	for (const entry of list) {
		if (entry === null || typeof entry !== "object") continue;
		const path = pathText(entry.path);
		if (!groups.has(path)) {
			const name = typeof entry.name === "string" && entry.name !== "" ? entry.name : proposalNameOf(path);
			groups.set(path, { path, name: name === "" ? "未知文件" : name, dir: proposalDirOf(path), entries: [] });
		}
		groups.get(path)?.entries.push(entry);
	}
	const result = [...groups.values()];
	for (const group of result) {
		group.entries.sort(
			(a, b) => createdAtOf(b) - createdAtOf(a) || (idOf(a) < idOf(b) ? 1 : idOf(a) > idOf(b) ? -1 : 0),
		);
	}
	result.sort((a, b) => {
		const newestA = createdAtOf(a.entries[0]);
		const newestB = createdAtOf(b.entries[0]);
		return newestB - newestA || a.path.localeCompare(b.path);
	});
	return result;
}

/** 一条建议的全部 hunk id（按建议里的原顺序、去重）。坏数据返回空数组。 */
export function defaultSelectedHunks(proposal) {
	const hunks = Array.isArray(proposal?.hunks) ? proposal.hunks : [];
	const ids = [];
	for (const hunk of hunks) {
		if (typeof hunk?.id !== "string" || hunk.id === "") continue;
		if (!ids.includes(hunk.id)) ids.push(hunk.id);
	}
	return ids;
}

/**
 * 「全选 / 全不选」：`on === true` 返回全部（去重），否则返回空数组。
 *
 * 第一次参数（当前选中）刻意不参与计算 —— 全选就是全选，不做「保留已取消的」；
 * 保留参数是为了调用点读起来是「在什么基础上」切换，签名由 design.md §4 定。
 */
export function mergeSelectAll(_selected, all, on) {
	if (on !== true) return [];
	const ids = [];
	for (const id of Array.isArray(all) ? all : []) {
		if (typeof id !== "string" || id === "") continue;
		if (!ids.includes(id)) ids.push(id);
	}
	return ids;
}

function hunkLineCount(hunk, type) {
	const field = finiteNumber(type === "+" ? hunk?.added : hunk?.removed);
	if (field !== undefined && field >= 0) return field;
	const lines = Array.isArray(hunk?.lines) ? hunk.lines : [];
	let count = 0;
	for (const line of lines) {
		if (line?.type === type) count += 1;
	}
	return count;
}

/** 一段改动的 `+X −Y 行`（统计只从选中段的增删行算）。 */
export function formatHunkStats(hunk) {
	return `+${hunkLineCount(hunk, "+")} −${hunkLineCount(hunk, "-")} 行`;
}

/**
 * 选中汇总：`{ count, added, removed, canAccept }`。
 *
 * `canAccept` 同时要求「至少一段」与「建议没过期」—— 过期建议的接受按钮必须在
 * 这里是灰的，而把判断放在视图里会让两条路径（按钮 disabled 与点击时再判）分叉。
 */
export function summarizeSelection(proposal, selected) {
	const hunks = Array.isArray(proposal?.hunks) ? proposal.hunks : [];
	const ids = new Set(Array.isArray(selected) ? selected : []);
	let count = 0;
	let added = 0;
	let removed = 0;
	for (const hunk of hunks) {
		if (typeof hunk?.id !== "string" || !ids.has(hunk.id)) continue;
		count += 1;
		added += hunkLineCount(hunk, "+");
		removed += hunkLineCount(hunk, "-");
	}
	return { count, added, removed, canAccept: count > 0 && proposal?.stale !== true };
}

/**
 * 一段改动的区间人话（复用 review-core 的同一句话，不另立口径）。
 *
 * 结构化 hunk 没有 `@@` 文本，这里按 oldStart / newStart 拼一个等价头再交给
 * `formatHunkHeader` —— 「第 N 行起」与并排对照页逐字一致。
 */
export function hunkRangeText(hunk, { total = 1 } = {}) {
	const oldStart = finiteNumber(hunk?.oldStart);
	const newStart = finiteNumber(hunk?.newStart);
	if (oldStart === undefined || newStart === undefined || oldStart < 0 || newStart < 0) return "";
	return formatHunkHeader(`@@ -${oldStart} +${newStart} @@`, { total });
}

/** 勾选框的可访问名：`应用第 N 段：+X / -Y 行`（PRD 指定口径）。 */
export function hunkApplyLabel(hunk, index) {
	return `应用第 ${index + 1} 段：+${hunkLineCount(hunk, "+")} / -${hunkLineCount(hunk, "-")} 行`;
}

/**
 * 这条建议是不是 docx 文本替换（#481 生成的 `kind:"docx"`）。
 *
 * 视图据此走两套完全不同的主体：docx 的条目是 `edits`（v2 起可多条），
 * 没有逐段 hunk。多条时可以逐条勾选；单条时与 v1 一样只展示一处替换。
 */
export function isDocxProposal(proposal) {
	return proposal?.kind === "docx";
}

/** 列表项的 `+N −M`；没有记录时如实说，不摆一个不存在的 +0 −0。 */
export function formatProposalStats(entry) {
	// docx 报真实的替换条数，而不是伪造的 +N −M 行。
	if (isDocxProposal(entry)) {
		const count = Array.isArray(entry?.edits) && entry.edits.length > 0 ? entry.edits.length : 1;
		return `${count} 处替换`;
	}
	const added = finiteNumber(entry?.added);
	const removed = finiteNumber(entry?.removed);
	if (added === undefined || removed === undefined) return "行数未记录";
	return `+${added} −${removed}`;
}

/** 模式按钮文字：`待修订 N`。 */
export function proposalModeLabel(count) {
	return `待修订 ${finiteNumber(count) ?? 0}`;
}

/** 读屏播报：建议数变化时只说数量，不读整张列表。 */
export function proposalPendingAnnouncement(count) {
	return `有 ${finiteNumber(count) ?? 0} 条待修订建议`;
}

/** 来源（工具 · 会话标题）—— 与变更审阅共用同一句，不露 `write`。 */
export function proposalSourceText(proposal, sessionTitle, { sessionsLoaded = true } = {}) {
	const tool = formatToolName(typeof proposal?.toolName === "string" ? proposal.toolName : "");
	const title = typeof sessionTitle === "string" ? sessionTitle : "";
	/*
	 * 「不在当前列表」不等于「已删除」：会话清单可能还没加载（undefined）、
	 * 或该会话已归档 / 不在当前筛选里。三种状态分开说，别谎报删除。
	 */
	if (sessionsLoaded !== true) return tool === "" ? "来源会话读取中…" : `${tool} · 来源会话读取中…`;
	if (title === "") {
		const text = "来源会话不在列表中（可能已归档或删除）";
		return tool === "" ? text : `${tool} · ${text}`;
	}
	return reviewSourceText({ tool: typeof proposal?.toolName === "string" ? proposal.toolName : "" }, sessionTitle);
}

/** 组头目录：末两段足够区分；被截断时加 `…/` 前缀，读作「路径被截断」而不是怪路径。 */
export function proposalDirLabel(dir) {
	const text = typeof dir === "string" ? dir : "";
	const trimmed = text.replace(/[\\/]+$/, "");
	if (trimmed === "") return "";
	const segments = trimmed.split(/[\\/]+/).filter((part) => part !== "");
	const label = formatDirLabel(text);
	return segments.length > 2 ? `…/${label}` : label;
}

/** 接受成功后的 toast / 播报：段数与行数都要说。 */
export function acceptSuccessText(name, applied, total, added, removed) {
	const file = typeof name === "string" && name !== "" ? name : "这条建议";
	const appliedCount = finiteNumber(applied) ?? 0;
	const totalCount = finiteNumber(total) ?? 0;
	const base = `已应用「${file}」的 ${appliedCount} / ${totalCount} 段（+${finiteNumber(added) ?? 0} −${finiteNumber(removed) ?? 0} 行）`;
	// 部分接受会丢弃未勾选的段落（写回后整条建议删除）：结果必须把这件事说出来。
	const discarded = totalCount - appliedCount;
	return discarded > 0 ? `${base}；其余 ${discarded} 段已丢弃` : base;
}

/**
 * docx 建议接受成功后的 toast / 播报：v1 只有一处替换，说件数与位置就够。
 *
 * 与 `acceptSuccessText` 分开而不是复用：那条文案围绕「段 / 行 / 未勾选丢弃」，
 * 而 docx 没有段也不存在丢弃 —— 硬套会说出「1 / 1 段（+1 −1 行）」这种
 * 在文档里并不存在的东西。
 */
export function acceptDocxSuccessText(name, count = 1) {
	const file = typeof name === "string" && name !== "" ? name : "这份文档";
	const total = Number.isInteger(count) && count > 0 ? count : 1;
	return `已替换「${file}」正文中的 ${total} 处文字`;
}

/** 拒绝成功后的 toast / 播报：必须说清「文件没有被改动」。 */
export function rejectSuccessText(name) {
	const file = typeof name === "string" && name !== "" ? name : "这条建议";
	return `已拒绝「${file}」的修订建议，目标文件没有被改动`;
}

/** 拒绝的二次确认句（与文件历史的就地确认条同一形态）。 */
export function rejectConfirmText(name) {
	const file = typeof name === "string" && name !== "" ? name : "这条建议";
	return `拒绝「${file}」的这条修订建议？目标文件不会被改动。`;
}
