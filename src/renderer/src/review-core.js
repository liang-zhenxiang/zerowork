/**
 * 变更审阅台（侧栏「变更审阅」）的纯逻辑（零依赖，vitest 毫秒级直测 ——
 * 与 file-history-core.js / session-search-core.js 同分工）。
 *
 * 这一页要做三类判断，全是「文案、筛选与配对」而不是 DOM：
 *   · 筛选（全部 / 待审阅）与计数 —— 它决定左列看到什么、右区选谁；
 *   · 并排 diff 的行配对 —— daemon 只给 unified diff 文本，把 `-` / `+` 两列
 *     配成一行是这一页唯一的展示算法；
 *   · 契约里那些**不许静默**的边界：二进制 / 超大 / 文件已不在 / 符号链接 /
 *     改动过大（truncated）/ 版本过期（stale）。
 *
 * 为什么措辞集中在这里：本仓库要求「同一件事同一句话」，而 JSX 里的字符串
 * 没有任何东西守得住。抽出来之后单测可以把每一句钉死，视图只负责摆位置。
 *
 * 数据契约（design.md §2，逐字段照抄）：
 *   ReviewEntry { key, path, name, dir, versionId, at, tool?, sessionId?,
 *                 added?, removed?, exists, reviewed }
 *   review:list → { entries, pending, reviewed, truncated, skippedTotal }
 *   review:read → { ok:true, hunks, before, after, added, removed, truncated }
 *               | { ok:false, reason }
 */

import { FILE_HISTORY_LIST_MAX, formatToolName } from "./file-history-core.js";

/**
 * 空态文案（prd 验收口径：空态要说清「还没有需要审阅的变更」）。
 *
 * **必须与实现同口径**：版本存储只保留每个文件最后一条版本，`buildReviewEntries`
 * 也是一文件一条 —— 所以不能说「每次改动都会列成一条」（同一文件改 5 次只看到 1 条，
 * 用户会以为漏列，或误以为审 1 条等于审了全部 5 次）。这是审阅队列的信任基础。
 */
export const REVIEW_EMPTY_TITLE = "还没有需要审阅的变更";
export const REVIEW_EMPTY_DESC =
	"每个文件最近一次改动会在这里列成一条待审阅的变更；更早的改动会被新的覆盖。命令改的文件没有旧内容可留，不会出现在这里。";

/** 筛选后没有待审阅项时的文案（数据有，只是这一档筛空了 —— 与真空态分开）。 */
export const REVIEW_PENDING_EMPTY_TITLE = "待审阅的都处理完了";
export const REVIEW_PENDING_EMPTY_DESC = "切到「全部」可以回看已经审阅过的改动。";

/** 左列区头的口径：`变更 · N 条`。 */
export function reviewIndexTitle(count) {
	return `变更 · ${count ?? 0} 条`;
}

/** 顶部计数：`待审阅 N · 已审阅 M`。 */
export function formatReviewCounts(pending, reviewed) {
	return `待审阅 ${pending ?? 0} · 已审阅 ${reviewed ?? 0}`;
}

/** 一条变更的状态文字（**文字与颜色双通道**，DESIGN §7.6）。 */
export function reviewStateLabel(reviewed) {
	return reviewed === true ? "已审阅" : "待审阅";
}

/**
 * 一条变更的 `+N −M`。
 *
 * 版本条目里 `added/removed` 描述的是**替换它的那次改动**；还原动作留下的
 * 快照没有这两个数字（`restoreVersion` 记录时不带它们），此时如实说
 * 「行数未记录」，不摆一个不存在的 `+0 −0`。
 */
export function formatChangeStats(entry) {
	const { added, removed } = entry ?? {};
	if (typeof added === "number" && Number.isFinite(added) && typeof removed === "number" && Number.isFinite(removed)) {
		return `+${added} −${removed}`;
	}
	return "行数未记录";
}

/** 筛选：`all` 原样返回，`pending` 只留未审阅的。返回新数组，不改入参。 */
export function filterReviewEntries(entries, filter) {
	const list = Array.isArray(entries) ? entries : [];
	if (filter === "pending") return list.filter((entry) => entry?.reviewed !== true);
	return [...list];
}

/**
 * 「只看待审阅」下要显示的条目（**纯函数**）。
 *
 * 刚被标记为已审阅的 `keptKey` 临时留在列表里 —— 否则点完按钮右区会立刻跳到
 * 下一条，用户看不到自己那条变成了什么状态。它只在「这条已经不在筛选结果里」
 * 时补回最前面；用户点了别的条目（调用方清掉 keptKey）或刷新后就不再保留。
 */
export function visibleReviewEntries(entries, filter, keptKey) {
	const list = Array.isArray(entries) ? entries : [];
	const filtered = filterReviewEntries(list, filter);
	if (filter !== "pending" || typeof keptKey !== "string" || keptKey === "") return filtered;
	if (filtered.some((entry) => entry?.key === keptKey)) return filtered;
	const kept = list.find((entry) => entry?.key === keptKey);
	return kept === undefined ? filtered : [kept, ...filtered];
}

/** 清单被截断时的说明（与文件历史的句式一致）。 */
export function formatReviewTruncatedNote() {
	return `文件较多，这里只显示最近改动的 ${FILE_HISTORY_LIST_MAX} 个。`;
}

/**
 * 被跳过的改动（二进制 / 超 1 MiB）没有旧内容可审，不成卡 ——
 * 但要如实计数，否则用户会以为「这个文件从来没被改过」。
 */
export function reviewSkippedNote(skippedTotal) {
	if (typeof skippedTotal !== "number" || !Number.isFinite(skippedTotal) || skippedTotal <= 0) return "";
	return `另有 ${skippedTotal} 次改动没有留下版本：文件超过 1 MiB，或不是文本文件。`;
}

/** 改动过大时的降级说明（truncated：只有增删行数，没有逐行 diff）。 */
export function reviewTruncatedDiffNote(added, removed) {
	const stats =
		typeof added === "number" && Number.isFinite(added) && typeof removed === "number" && Number.isFinite(removed)
			? `（+${added} −${removed}）`
			: "";
	return `改动过大，这里只给增删行数${stats}，不逐行对照。`;
}

/** 来源（工具 · 会话标题）。工具名与文件历史共用同一份映射，不露 `write`。 */
export function reviewSourceText(entry, sessionTitle) {
	const tool = formatToolName(entry?.tool);
	const title = typeof sessionTitle === "string" ? sessionTitle : "";
	if (title === "") return tool === "" ? "来源会话已不在" : `${tool} · 来源会话已不在`;
	return tool === "" ? title : `${tool} · ${title}`;
}

/**
 * unified diff 的 hunk 头 → 用户能读的一句（P0-2）。
 *
 * `@@ -1,6 +1,6 @@` 是 git 的坐标语言，办公用户不该看到它（读屏还会念成
 * 「at at minus one comma six…」）。规则：
 *   · 只有一个 hunk、且两侧都从第 1 行开始 → 返回 `""`（整行不渲染，diff 就是全文件）；
 *   · 两侧起点相同 → 「第 N 行起」；
 *   · 起点不同 → 「改前第 N 行起 / 现在第 M 行起」。
 * 原始 `@@` 由视图放进 `title` / `aria-label`，排查时仍查得到。
 */
export function formatHunkHeader(header, { total = 1 } = {}) {
	if (typeof header !== "string") return "";
	const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
	if (match === null) return "";
	const oldStart = Number(match[1]);
	const newStart = Number(match[2]);
	if (total <= 1 && oldStart === 1 && newStart === 1) return "";
	if (oldStart === newStart) return `第 ${oldStart} 行起`;
	return `改前第 ${oldStart} 行起 / 现在第 ${newStart} 行起`;
}

/**
 * `review:read` 失败原因的用户话术（design.md §2 的闭集 + session-files 的补充）。
 *
 * `unknown` / `missing` / `no-such-version` 是可恢复的（刷新后可能变好）；
 * `binary` / `too-large` / `symlink` / `no-after` 是文件当前的事实，不是错误 ——
 * 界面据此把「重试」与「如实说明」分开，不把事实当故障。
 */
export function reviewReasonText(reason, message) {
	const detail = typeof message === "string" ? message : "";
	switch (reason) {
		case "unknown":
			return "这个文件的版本记录不在（可能已被清理）。";
		case "no-such-version":
			return "这一版已经不在了，刷新后再看。";
		case "missing":
			return "这一版的内容已不在（存储缺失或损坏），无法对照。";
		case "binary":
			return "这是二进制文件，不能以文本方式对照。";
		case "too-large":
			return "文件现在超过 256 KiB，为避免拖垮页面，这里不读取正文。";
		case "no-after":
			return "文件已被删除或移走，没有「现在」可以对照。";
		case "symlink":
			return "这个路径现在是符号链接，审阅页不跟随链接。";
		case "stale":
			return "这个文件又有了新的改动，请先刷新，再重新审阅这一版。";
		case "write-failed":
			return detail === "" ? "审阅状态没能写入，请重试。" : `审阅状态没能写入：${detail}`;
		default:
			return detail === "" ? "读取失败。" : detail;
	}
}

/** 哪些失败给「刷新」：版本/存储侧的状态，刷新后可能变好。 */
export function reviewReasonRetryable(reason) {
	return reason === "unknown" || reason === "no-such-version" || reason === "missing" || reason === "stale";
}

/**
 * unified diff（`buildHunks` 的输出）→ 并排两列的行。
 *
 * 返回：`[{ kind:"hunk", header }]` 与
 *       `[{ kind:"row", left: Cell, right: Cell }]`，
 * Cell = `{ text, kind: "same" | "del" | "add" | "empty" }`。
 *
 * 配对规则：一段连续的 `-` / `+` 行按**出现顺序**一一配对（第 i 条删行与第
 * i 条增行同一行），多出来的一侧补 `empty`。这样「改了一行」在界面上是一条
 * 左右并列的行，而不是先读完所有删行再读所有增行 —— 后者要自己在脑子里配对。
 *
 * 只解析 `buildHunks` 产出的形态（无 `\ No newline` 标记）；空字符串（两版逐行
 * 相同或 diff 触顶）返回空数组。
 */
export function parseSideBySideDiff(hunks) {
	if (typeof hunks !== "string" || hunks === "") return [];
	const lines = hunks.split("\n");
	const rows = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		if (line.startsWith("@@")) {
			rows.push({ kind: "hunk", header: line });
			i += 1;
			continue;
		}
		if (line.startsWith("-") || line.startsWith("+")) {
			const dels = [];
			const adds = [];
			while (i < lines.length) {
				const current = lines[i] ?? "";
				if (current.startsWith("-")) {
					dels.push(current.slice(1));
				} else if (current.startsWith("+")) {
					adds.push(current.slice(1));
				} else {
					break;
				}
				i += 1;
			}
			const pairs = Math.max(dels.length, adds.length);
			for (let k = 0; k < pairs; k += 1) {
				rows.push({
					kind: "row",
					left: k < dels.length ? { text: dels[k], kind: "del" } : { text: "", kind: "empty" },
					right: k < adds.length ? { text: adds[k], kind: "add" } : { text: "", kind: "empty" }
				});
			}
			continue;
		}
		// 上下文行以恰好一个空格开头（内容本身可以再以空格开头）。
		if (line.startsWith(" ")) {
			const text = line.slice(1);
			rows.push({ kind: "row", left: { text, kind: "same" }, right: { text, kind: "same" } });
		}
		i += 1;
	}
	return rows;
}

/** 侧栏角标文字：0 不渲染（调用方判）；超过 99 显示 99+。 */
export function reviewBadgeText(pending) {
	if (typeof pending !== "number" || !Number.isFinite(pending) || pending <= 0) return "";
	return pending > 99 ? "99+" : String(pending);
}
