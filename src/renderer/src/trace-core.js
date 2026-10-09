/**
 * 工作轨迹（Turn Trace）的纯逻辑（零依赖，vitest 毫秒级直测——projects-core.js 同模式）。
 *
 * 一个 assistant 回合里，Agent 可能读了三个文件、改了两个、跑了命令、交付了产物。
 * 这些动作现在以逐条折叠行呈现，跑得越久列表越长，「这一轮到底做了什么」没有
 * 一眼答案；把「过程」整个折叠起来后又什么都看不见了。
 *
 * 本模块把回合的 entries 聚合成一条**按发生顺序排列的动作轨迹**：
 *  · 相邻同类调用合并成一个段（`读 读 写 读` → `读×2 / 写 / 读`，两段读不合并——
 *    跨段合并会毁掉顺序叙事，也让「点击定位到哪一条」语义含糊）；
 *  · 段带聚合状态：含 error/blocked 的段标 bad，最后一个 outcome 未定的段是
 *    running（回合还在跑）——**不猜**，状态只来自 entries 已有的 outcome 字段；
 *  · `artifacts_presented`（present_files 的交付事件）在正文里渲染为 null，
 *    在轨迹里正好补位为「交付」段——正文与轨迹看同一份 entries，不会分歧。
 *
 * 渲染层（app.js 的 TurnTraceBar）只做展示与点击定位，不做任何再聚合。
 */

/**
 * 工具名 → 轨迹类别的映射表。**数据不是逻辑**：新增工具只改这张表。
 * 键是 normalize 后的名字（小写、去掉 `_` 和 `-`，与 app.js 的 toolIconOf 同规则；
 * 所以表里没有 `web_search` 这种带下划线的写法——normalize 后查得到）。
 * 未知工具落到 "other"——tooltip 仍显示其真实 label/summary，宁可信息糙，不静默丢。
 *
 * 取类依据（为什么 ls 归读、web_search 归检索）：
 * 类别回答的是「它在干什么样的事」，不是「它叫什么」。ls 是「看一眼目录」，
 * 与 read 同属输入侧；grep/glob/web 是「找东西」；edit/write 都是「改文件」。
 */
const KIND_BY_TOOL = {
	// 读（输入侧：看内容、看目录）
	read: "read",
	readfile: "read",
	readdocument: "read",
	readme: "read",
	ls: "read",
	listfiles: "read",
	listdir: "read",
	// 写（输出侧：改文件）
	write: "write",
	edit: "write",
	multiedit: "write",
	writetofile: "write",
	replaceinfile: "write",
	appendtofile: "write",
	// 命令（执行侧）
	bash: "command",
	powershell: "command",
	executecommand: "command",
	runterminalcmd: "command",
	killshell: "command",
	bashoutput: "command",
	// 检索（找东西：本地代码库 / 网络）
	grep: "search",
	find: "search",
	glob: "search",
	searchfiles: "search",
	codebasesearch: "search",
	ragsearch: "search",
	websearch: "search",
	webfetch: "search"
};

/** 类别 → 中文标签（渲染直接用，不另建一份文案）。 */
export const TRACE_KIND_LABELS = {
	read: "读",
	write: "写",
	command: "命令",
	search: "检索",
	deliver: "交付",
	subagent: "子代理",
	other: "其他"
};

/** 类别 → 代表工具名（渲染层拿它查 toolIconOf 取图标，保持图标与工具行同一套）。 */
export const TRACE_KIND_ICON_TOOL = {
	read: "read",
	write: "edit",
	command: "bash",
	search: "grep",
	deliver: "present_files",
	subagent: "task",
	other: ""
};

/** normalize 规则与 app.js 的 normalizeName 一致：小写、去掉 `_` 与 `-`。 */
function normalizeToolName(name) {
	return String(name ?? "").toLowerCase().replace(/[_-]/g, "");
}

function classifyTool(toolName) {
	const normalized = normalizeToolName(toolName);
	const exact = KIND_BY_TOOL[normalized];
	if (exact !== undefined) return exact;
	// 子代理是一组前缀（team_create / team_send / …），逐名登记会漂移，用前缀匹配。
	if (normalized.startsWith("team") || normalized.startsWith("subagent") || normalized === "task" || normalized === "dispatchspecialist") {
		return "subagent";
	}
	return "other";
}

/**
 * 单个 entry 的轨迹类别。交付不是工具而是事件（role === "artifacts_presented"），
 * 单独判——它没有 toolName，走表永远落不到。
 */
function kindOfEntry(entry) {
	if (entry.role === "artifacts_presented") return "deliver";
	if (entry.role === "tool") return classifyTool(entry.toolName);
	return undefined;
}

function entryStatus(entry) {
	// outcome 未定 = 还在跑（与 ToolEntry 的 running 判定同口径）。
	if (entry.outcome === undefined) return "running";
	return entry.outcome === "ok" ? "ok" : "bad";
}

function entryTooltipLine(entry) {
	const label = entry.label ?? entry.toolName ?? "";
	const summary = entry.summary ?? "";
	if (label === "" ) return summary;
	if (summary === "") return label;
	return `${label}：${summary}`;
}

function clip(text, max) {
	if (text.length <= max) return text;
	return `${text.slice(0, max - 1)}…`;
}

/** tooltip 单行上限：title 属性没有滚动条，过长比截断更糟（原生 tooltip 不可交互）。 */
const TOOLTIP_LINE_MAX = 80;
/** tooltip 最多列几条：超过的以「…还有 N 步」收尾，完整清单在工具行里。 */
const TOOLTIP_MAX_ITEMS = 6;

/**
 * 构建一个回合的轨迹视图模型。
 *
 * @param {Array<object>} entries 该回合的 entry 列表（user 之后到下一个 user 之前，
 *   与 buildFoldPlan 的输入同源）。元素含 role / toolName / outcome / label /
 *   summary / id 等字段——与渲染层消费的是同一批对象。
 * @returns {{empty: boolean, segments: Array<object>, totals: {calls: number, bad: number}}}
 *   empty 为 true 时调用方不渲染任何 DOM（纯文本回合零变化）。
 */
export function buildTurnTrace(entries) {
	const segments = [];
	let calls = 0;
	let bad = 0;
	for (const entry of entries ?? []) {
		const kind = kindOfEntry(entry);
		if (kind === undefined) continue;
		calls += 1;
		const status = entryStatus(entry);
		if (status === "bad") bad += 1;
		// 相邻**同类且同态**才合并（见文件头）：含失败的同类串拆成独立的 bad 段——
		// 失败不该被并进大段里稀释，「这步出过错」在轨迹上必须看得见。
		const prev = segments[segments.length - 1];
		if (prev !== undefined && prev.kind === kind && prev.status === status) {
			prev.count += 1;
			prev.entryIds.push(entry.id);
			prev.tooltipLines.push(entryTooltipLine(entry));
			continue;
		}
		segments.push({
			kind,
			label: TRACE_KIND_LABELS[kind],
			count: 1,
			entryIds: [entry.id],
			status,
			tooltipLines: [entryTooltipLine(entry)]
		});
	}
	return finalizeSegments(segments, calls, bad);
}

function finalizeSegments(segments, calls, bad) {
	// 最后一段若仍是 running（最后一个动作 outcome 未定），保留 running；
	// 其余段的 running 在构建期只可能出现在末段（工具按顺序落定 outcome），
	// 防御性地把非末段的 running 视作 ok 处理（不猜失败）。
	for (const seg of segments) {
		if (seg.status === "running" && seg !== segments[segments.length - 1]) {
			seg.status = "ok";
		}
		seg.title = buildTooltip(seg);
	}
	return { empty: segments.length === 0, segments, totals: { calls, bad } };
}

function buildTooltip(seg) {
	const shown = seg.tooltipLines.slice(0, TOOLTIP_MAX_ITEMS).map((line) => clip(line, TOOLTIP_LINE_MAX));
	const rest = seg.tooltipLines.length - shown.length;
	const head = `${seg.label}${seg.count > 1 ? ` ×${seg.count}` : ""}`;
	if (rest > 0) shown.push(`…还有 ${rest} 步`);
	return [head, ...shown].join("\n");
}

export { KIND_BY_TOOL };
