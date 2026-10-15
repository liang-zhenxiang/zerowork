/**
 * 文件时光机（File History）视图的纯逻辑（零依赖，vitest 毫秒级直测——
 * 与 trace-core.js / projects-core.js 同分工）。
 *
 * 渲染层这一页要做三类判断，全是「文案与顺序」而不是 DOM：
 *   · 清单按最后改动时间倒序（daemon 已经排过一遍，这里仍是**纯函数**，
 *     因为「界面最终看到的顺序」是界面自己的不变量，不能靠上游顺手保证）；
 *   · 每个版本节点的三行文案：绝对时间 / 「被 +X −Y 的改动替换」/ 相对时间；
 *   · 契约里那些**不许静默**的边界：`truncated` / `skipped` / `exists:false` / `broken`。
 *
 * 为什么措辞要集中在这里而不是散在视图里：本仓库要求「同一件事同一句话」
 * （资料库的截断说明与文件历史逐字一致），而 JSX 里的字符串没有任何东西守得住。
 * 抽到这里之后，单测可以把每一句钉死，视图只负责摆位置。
 *
 * 数据契约（design.md §3.1，逐字段照抄）：
 *   FileEntry    { key, path, name, dir, count, skipped, lastAt, lastSessionId?, lastTool?, exists }
 *   VersionEntry { id, at, size, sessionId?, tool?, added?, removed?, broken? }
 *
 * 一处与 ux-proposal 的口径修正：方案 §3.3 写「相对时间由既有相对时间工具产出」，
 * 但 `app.js` 里**并不存在**这样一个可复用的相对时间函数（`formatMessageTime`
 * 给的是 `HH:mm` / `昨天 HH:mm` / `M月D日 HH:mm`，不是「N 小时前」）。
 * 按本任务的要求，相对时间在这里实现（可被单测直测），视图直接调用。
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 清单上限（与 daemon 的 `VERSION_LIST_MAX_FILES` 同值）。界面照它的值说「200 个」。 */
export const FILE_HISTORY_LIST_MAX = 200;

/** 空态文案（ux-proposal §5.2 原文，单测钉死——改这句要连着改测试）。 */
export const FILE_HISTORY_EMPTY_TITLE = "还没有文件历史";
export const FILE_HISTORY_EMPTY_DESC =
	"Agent 用写入 / 编辑工具改过文件之后，这里会留下每次改动前的版本，随时能退回去。";

/** 时间轴下方的方向说明（ux-proposal §3.1 原文）。 */
export const FILE_HISTORY_DIRECTION_NOTE =
	"这里每一版都是某次改动之前的内容；当前磁盘上的内容不在其中，还原之后它会作为一条新版本出现在末尾。";

function pad2(n) {
	return n < 10 ? `0${n}` : `${n}`;
}

/** 绝对时间 `MM-DD HH:mm` —— 节点身份行、预览头与确认句共用同一格式。 */
export function formatVersionTime(at) {
	const d = new Date(at);
	return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 相对时间：刚刚 / N 分钟前 / N 小时前 / 昨天 / N 天前 / MM-DD。
 * 超过一个月就不再「N 天前」（那个数字读起来已经失去意义），落到绝对日期。
 */
export function formatRelativeTime(at, now = Date.now()) {
	const diff = Math.max(0, now - at);
	if (diff < MINUTE) return "刚刚";
	if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
	if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
	if (diff < 2 * DAY) return "昨天";
	if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天前`;
	return formatVersionTime(at).slice(0, 5);
}

/** 清单排序：最后改动时间倒序；并列时按文件名升序（同刻改两个文件时顺序仍是确定的）。 */
export function sortFileEntries(files) {
	return [...(files ?? [])].sort(
		(a, b) => (b?.lastAt ?? 0) - (a?.lastAt ?? 0) || String(a?.name ?? "").localeCompare(String(b?.name ?? ""))
	);
}

/** 默认选中的版本 = 数组末位（`versions` 旧→新，最新在最后）。空数组返回 -1。 */
export function defaultVersionIndex(versions) {
	return Array.isArray(versions) ? versions.length - 1 : -1;
}

/** 时间轴上「内容已不在」的版本数（说明行要用）。 */
export function countBroken(versions) {
	let n = 0;
	for (const v of versions ?? []) {
		if (v?.broken === true) n += 1;
	}
	return n;
}

/** 清单行右端的版本数标签。 */
export function versionCountLabel(count) {
	return `${count ?? 0} 版`;
}

/**
 * 清单 / 卡片里显示的所在目录。
 *
 * 契约给的 `dir` 是**绝对路径的父目录**（design.md §3.1）——直接铺在界面上就是一条
 * `/var/folders/.../zerowork-ws-xxx`，读不出「这是哪个位置」。ux-proposal §2.2 定的
 * 口径是「相对工作区或末两段」，这里取**末两段**（渲染层拿不到每个文件所属工作区的
 * 可靠映射：版本跨会话、跨工作区）。完整路径仍在 title 里，鼠标悬停可查。
 */
export function formatDirLabel(dir) {
	const text = typeof dir === "string" ? dir : "";
	const trimmed = text.replace(/[\\/]+$/, "");
	if (trimmed === "") return text;
	const segments = trimmed.split(/[\\/]+/);
	if (segments.length <= 2) return trimmed;
	return segments.slice(-2).join("/");
}

/**
 * 版本节点的「变化行」（ux-proposal §3.3）。
 *
 * 契约里 `added` / `removed` 是「**替换掉这一版的那次改动**」的增删行数（design.md
 * §3.1），所以最新一版之后没有已记录的改动，它不显示数字、显示一句说明——
 * 不给一个不存在的 `+0 −0`。
 */
export function versionChangeText(version, { isLatest = false } = {}) {
	if (version?.broken === true) return "内容已不在，这一版不能还原";
	if (isLatest) return "这是最近一次改动之前的样子";
	const { added, removed } = version ?? {};
	if (typeof added !== "number" || typeof removed !== "number") return "被一次改动替换";
	return `被一次 +${added} −${removed} 的改动替换`;
}

/** 版本节点的来源（右端「工具 · 会话标题」）。会话解析不到时如实说，不显示裸 id。 */
export function versionSourceText(version, sessionTitle) {
	const tool = typeof version?.tool === "string" ? version.tool : "";
	const title = typeof sessionTitle === "string" ? sessionTitle : "";
	if (title === "") return tool === "" ? "来源会话已不在" : `${tool} · 来源会话已不在`;
	return tool === "" ? title : `${tool} · ${title}`;
}

/**
 * 清单第三行：`2 小时前 · 市场部周报 · 文件已不在 · 2 次未记录`（按需追加）。
 * 缺一段就少一段，不摆占位符。
 */
export function fileRowNote(entry, { now = Date.now(), sessionTitle } = {}) {
	const parts = [];
	if (typeof entry?.lastAt === "number" && entry.lastAt > 0) parts.push(formatRelativeTime(entry.lastAt, now));
	parts.push(typeof sessionTitle === "string" && sessionTitle !== "" ? sessionTitle : "来源会话已不在");
	if (entry?.exists === false) parts.push("文件已不在");
	if (typeof entry?.skipped === "number" && entry.skipped > 0) parts.push(`${entry.skipped} 次未记录`);
	return parts.join(" · ");
}

/** 清单被截断时的说明（逐字照资料库的句式）。 */
export function formatTruncatedNote() {
	return `文件较多，这里只显示最近改动的 ${FILE_HISTORY_LIST_MAX} 个。`;
}

/**
 * 时间轴上方的说明行（ux-proposal §3.8）。返回字符串数组，一条一行。
 *
 * `broken` 那一句在 proposal 的表里只列了「`skipped > 0` 且存在 broken」的组合；
 * 但「这一版的内容没了」本身就必须说出来（§6「一律不许静默」），所以
 * `skipped === 0` 但确实有 broken 时也照说，只是去掉「其中」二字。
 */
export function timelineNotes({ skipped = 0, brokenCount = 0 } = {}) {
	const lines = [];
	if (skipped > 0) lines.push(`另有 ${skipped} 次改动没有留下版本：文件超过 1 MiB，或不是文本文件。`);
	if (brokenCount > 0) {
		lines.push(
			skipped > 0
				? `其中 ${brokenCount} 版的内容已不在，不能还原，但时间点仍在。`
				: `${brokenCount} 版的内容已不在，不能还原，但时间点仍在。`
		);
	}
	return lines;
}

/**
 * 还原确认句（ux-proposal §4.3 原文）。三个事实按顺序落进一句：
 * 哪个文件 → 退到哪个时间点 → 当前内容会先存成一条新版本。
 */
export function restoreConfirmText({ name, at, exists = true }) {
	const base = `把「${name}」还原到 ${formatVersionTime(at)} 的样子？现在的内容会先存成一条新版本，之后还能再退回来。`;
	return exists === false ? `${base}文件已不在，还原会重新创建它。` : base;
}

/** 还原成功后的 toast 文案。 */
export function restoreSuccessText(at) {
	return `已还原到 ${formatVersionTime(at)}`;
}

/**
 * 还原失败的文案（ux-proposal §4.4 表，逐条）。daemon 的 `message` 只在
 * `write-failed` / `unknown` 里带原始摘要 —— 其余几条是固定的用户话术。
 */
export function restoreFailureText(reason, message) {
	const detail = typeof message === "string" ? message : "";
	switch (reason) {
		case "running":
			return "这个文件所属的会话正在运行，等它跑完再还原。";
		case "missing":
			return "这一版的内容已不在（存储缺失或损坏），无法还原。其余版本仍然可用。";
		case "no-such-version":
			return "这一版已经不在了，时间轴已刷新。";
		case "write-failed":
			return `写入失败：${detail}。文件未被改动。`;
		case "unknown":
			return `还原失败：${detail}。`;
		default:
			return detail === "" ? "还原失败。" : detail;
	}
}

/** 哪些失败给「重试」：可恢复的（还要等一会、写盘抖了、原因不明）才给。 */
export function restoreFailureRetryable(reason) {
	return reason === "running" || reason === "write-failed" || reason === "unknown";
}
