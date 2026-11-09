/**
 * 计划书（Plan Book）的纯逻辑（零依赖，vitest 毫秒级直测 —— 与
 * trace-core.js / file-history-core.js 同分工）。
 *
 * 这一份管三件事：
 *   1. **把模型输出的计划文本解析成结构化步骤**。plan 模式的提示词要求模型以
 *      「计划：」为标题、下面给编号步骤，但模型不总是照做 —— 编号、加粗、
 *      空行分段都出现过。解析不出来时**不丢内容**：按空行切段，整段作为一步。
 *   2. **步骤操作**。增删改移勾选都是纯数据变换，界面只负责摆位置 ——
 *      这些操作有一条硬性质：失败时不能悄悄改坏数据（空文本不新增、越界不移动）。
 *   3. **版本对比**。LCS 行级差异，用来回答「改过哪几版、这一版跟现在差在哪」。
 *
 * 数据形状（与 design.md §二 的落盘格式一致）：
 *   Step { id, text, done }
 *
 * 上限与 daemon 的 `plans-store.js` **同名常量必须同值**（`PLAN_STEP_MAX` /
 * `PLAN_STEP_TEXT_MAX` / `PLAN_TITLE_MAX`）：这边管住正常输入，那边管住手改过的
 * 文件。两边不一致的后果是「界面上还能加一步，保存却被拒」。
 */

/** 单份计划最多 50 步（超出截断；daemon 同样拒收）。 */
export const PLAN_STEP_MAX = 50;

/** 单步正文上限 500 字。 */
export const PLAN_STEP_TEXT_MAX = 500;

/** 标题上限 80 字。 */
export const PLAN_TITLE_MAX = 80;

/** 标题缺省值：没有「计划：」标题时用它。 */
export const PLAN_DEFAULT_TITLE = "计划书";

/** 编号步骤行：`1. xxx` / `1、xxx` / `1) xxx` / `1）xxx`。 */
const STEP_LINE_RE = /^\s*\d+\s*[.、)）．]\s+(.+)$/u;

/** 标题行：可带 `#`，`计划:` 或 `计划：` 之后是标题正文。 */
const TITLE_LINE_RE = /^\s*#{0,6}\s*计划\s*[:：]\s*(.+)$/u;

/** 段落回退时剥掉行首的列表 / 标题标记。 */
const LEADING_MARKER_RE = /^(?:[-*•]|#{1,6}|\d+\s*[.、)）．])\s+/u;

let stepSeq = 0;

/** 生成一个步骤 id。形状与 daemon 的缺省生成器同族（`s-<时间>-<序号>`）。 */
export function newStepId() {
	stepSeq += 1;
	return `s-${Date.now().toString(36)}-${stepSeq}`;
}

/** 单行化 + 去加粗 + 去行首标记 + 截断。 */
function cleanStepText(value) {
	return String(value ?? "")
		.replace(/\*\*/gu, "")
		.replace(/\r?\n/gu, " ")
		.replace(/^[\s　]+/u, "")
		.replace(LEADING_MARKER_RE, "")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, PLAN_STEP_TEXT_MAX);
}

/** 标题清理：去 `#` / 加粗 / 空白，超长截断（daemon 侧是拒收，解析侧先截断保内容）。 */
function cleanTitle(value) {
	return String(value ?? "")
		.replace(/\*\*/gu, "")
		.replace(/^#{1,6}\s*/u, "")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, PLAN_TITLE_MAX);
}

/** 取步骤文本（接受 Step 对象或裸字符串）。 */
function textOf(step) {
	if (typeof step === "string") return step;
	if (step !== null && typeof step === "object" && typeof step.text === "string") return step.text;
	return "";
}

/**
 * 解析一段计划文本。
 *
 * 返回 `{ title, steps: string[] }`。`steps` 是**文本**数组（不是 Step 对象）——
 * 解析只负责「读出计划」，id 与完成态由调用方在落盘前补上（见 usePlanBook）。
 *
 * 规则：
 *   - 标题：第一行匹配 `计划[:：]`（可带 `#`），否则「计划书」；
 *   - 步骤：匹配编号行 `1. xxx` / `1、xxx` / `1）xxx`，去掉行内 `**`；
 *   - **一条编号步骤都解析不到时**：按空行切段，整段作为一步 —— 不丢内容；
 *   - 上限 50 步，超出截断（界面另行说明）。
 */
export function parsePlanText(text) {
	const source = typeof text === "string" ? text : "";
	const lines = source.split(/\r?\n/u);

	let title = PLAN_DEFAULT_TITLE;
	let titleLine = -1;
	for (let i = 0; i < lines.length; i += 1) {
		const matched = TITLE_LINE_RE.exec(lines[i]);
		if (matched === null) continue;
		const cleaned = cleanTitle(matched[1]);
		if (cleaned !== "") {
			title = cleaned;
			titleLine = i;
		}
		break;
	}

	const steps = [];
	for (let i = 0; i < lines.length && steps.length < PLAN_STEP_MAX; i += 1) {
		if (i === titleLine) continue;
		const matched = STEP_LINE_RE.exec(lines[i]);
		if (matched === null) continue;
		const cleaned = cleanStepText(matched[1]);
		if (cleaned !== "") steps.push(cleaned);
	}

	if (steps.length === 0) {
		// 回退：按空行切段，整段作为一步。标题行不参与（它已经进了 title）。
		let buffer = [];
		const blocks = [];
		const flush = () => {
			if (buffer.length === 0) return;
			blocks.push(buffer.join(" "));
			buffer = [];
		};
		for (let i = 0; i < lines.length; i += 1) {
			if (i === titleLine) {
				flush();
				continue;
			}
			const line = lines[i].trim();
			if (line === "") {
				flush();
				continue;
			}
			buffer.push(line);
		}
		flush();
		for (const block of blocks) {
			if (steps.length >= PLAN_STEP_MAX) break;
			const cleaned = cleanStepText(block);
			if (cleaned !== "") steps.push(cleaned);
		}
	}

	return { title, steps };
}

/** 末尾追加一步；空文本 / 超上限时原样返回（不悄悄造出半条数据）。 */
export function addStep(steps, text, id = newStepId()) {
	const list = Array.isArray(steps) ? steps : [];
	const cleaned = cleanStepText(text);
	if (cleaned === "" || list.length >= PLAN_STEP_MAX) return list;
	return [...list, { id, text: cleaned, done: false }];
}

/** 改一步正文；空文本 / 找不到时原样返回。 */
export function updateStep(steps, id, text) {
	const list = Array.isArray(steps) ? steps : [];
	const cleaned = cleanStepText(text);
	if (cleaned === "" || !list.some((step) => step.id === id)) return list;
	return list.map((step) => (step.id === id ? { ...step, text: cleaned } : step));
}

/** 删一步；找不到时原样返回。 */
export function removeStep(steps, id) {
	const list = Array.isArray(steps) ? steps : [];
	if (!list.some((step) => step.id === id)) return list;
	return list.filter((step) => step.id !== id);
}

/** 上移 `-1` / 下移 `+1`；越界时原样返回（界面据此把按钮置灰）。 */
export function moveStep(steps, id, delta) {
	const list = Array.isArray(steps) ? steps : [];
	const index = list.findIndex((step) => step.id === id);
	if (index === -1) return list;
	const target = index + delta;
	if (target < 0 || target >= list.length) return list;
	const next = list.slice();
	const [moved] = next.splice(index, 1);
	next.splice(target, 0, moved);
	return next;
}

/** 勾选 / 取消勾选；找不到时原样返回。 */
export function toggleStep(steps, id) {
	const list = Array.isArray(steps) ? steps : [];
	if (!list.some((step) => step.id === id)) return list;
	return list.map((step) => (step.id === id ? { ...step, done: step.done !== true } : step));
}

/** 进度：`{ done, total, percent }`。总数为 0 时 percent 为 0（不返回 NaN）。 */
export function stepStats(steps) {
	const list = Array.isArray(steps) ? steps : [];
	const total = list.length;
	const done = list.filter((step) => step.done === true).length;
	return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/**
 * 导出为 Markdown：`# 标题` + 编号列表。执行全部与「复制 Markdown」共用这一份，
 * 保证「复制出去的」与「发给模型的」逐字一致。
 */
export function planToMarkdown(title, steps) {
	const heading = typeof title === "string" && title.trim() !== "" ? title.trim() : PLAN_DEFAULT_TITLE;
	const list = Array.isArray(steps) ? steps : [];
	const lines = [`# ${heading}`];
	if (list.length > 0) lines.push("");
	list.forEach((step, index) => {
		const text = textOf(step).trim();
		if (text !== "") lines.push(`${index + 1}. ${text}`);
	});
	return lines.join("\n");
}

/**
 * 版本差异（LCS 行级）：把 `a`（旧）变成 `b`（现在）要删什么、加什么、什么没变。
 *
 * 返回 `[{ kind: "same" | "add" | "del", text }]`：
 *   - `del` 只在 `a` 里出现（界面上标红）；
 *   - `add` 只在 `b` 里出现（标绿）；
 *   - `same` 两边都有（灰）。
 *
 * 步骤最多 50 条，O(n·m) 的 DP 足够，不必上 Myers。
 */
export function diffStepLists(a, b) {
	const left = (Array.isArray(a) ? a : []).map(textOf);
	const right = (Array.isArray(b) ? b : []).map(textOf);
	const n = left.length;
	const m = right.length;
	const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
	for (let i = n - 1; i >= 0; i -= 1) {
		for (let j = m - 1; j >= 0; j -= 1) {
			dp[i][j] = left[i] === right[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	const out = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (left[i] === right[j]) {
			out.push({ kind: "same", text: left[i] });
			i += 1;
			j += 1;
		} else if (dp[i + 1][j] >= dp[i][j + 1]) {
			out.push({ kind: "del", text: left[i] });
			i += 1;
		} else {
			out.push({ kind: "add", text: right[j] });
			j += 1;
		}
	}
	while (i < n) {
		out.push({ kind: "del", text: left[i] });
		i += 1;
	}
	while (j < m) {
		out.push({ kind: "add", text: right[j] });
		j += 1;
	}
	return out;
}
