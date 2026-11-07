/**
 * 诊断页「健康评分」的纯逻辑（零依赖，vitest 毫秒级直测 —— trace-core.js 同模式）。
 *
 * ## 为什么把这四项放在一个环里
 *
 * 诊断页原本是一列纯文本状态：模型可用性在首页、运行时在设置、最近任务在中段、
 * 全局快捷键在最上面一行。四项都读得到，但要**逐项读**才知道「这应用现在到底
 * 能不能用」。评分环做的是把它们合成一个可扫读的数字，并把「最该先处理的那一项」
 * 用一句话指出来 —— 环只是外壳，真正有价值的是那句建议。
 *
 * ## 口径（与 PRD / design.md 一致）
 *
 * 每项 0–25 分，通常按「就绪比例」折算；总分 0–100。
 * **读不到不等于 0 分就完事**：读失败的项目单独标成 `unknown`（UI 显示「无法判断」），
 * 而不是混进「扣分」里 —— 前者是「不知道」，后者是「知道它有问题」，处置方式不同
 * （前者点刷新重试，后者去修）。这与项目原则「宁可拒绝，也不静默降级」同一条：
 * 悄悄按 0 计而不说明来源，等于把一次读失败伪装成一个确定结论。
 *
 * ## 输入为什么是这种形状
 *
 * 渲染层从四个 IPC 各拿一份快照，任一项可能失败。调用方把失败折成 `null`，
 * 本模块只认「拿到了什么」：
 *
 * ```js
 * computeHealth({
 *   model: { kind: "ready" | "model-not-usable" | "no-model-at-all" } | null,
 *   runtimes: { master: boolean, items: [{ enabled, status: { kind } }] } | null,
 *   runs: [{ status: "ok" | "error" | "running" }] | null,
 *   shortcut: { kind: "registered" | "failed" } | null
 * })
 * ```
 *
 * 全部判断都是纯函数，不碰 DOM / window —— 这一屏最容易错的不是画环，
 * 而是「哪一项该扣多少、建议指向谁」。
 */

/** 单项满分。四项各 25 → 总分 100。 */
export const HEALTH_MAX_PER_ITEM = 25;

/** 分项的固定顺序：并列时按这个顺序取建议，保证同一状态永远给同一句话。 */
export const HEALTH_ITEM_ORDER = ["model", "runtimes", "tasks", "shortcut"];

const ITEM_LABELS = {
	model: "模型可用",
	runtimes: "内置运行时",
	tasks: "最近任务成功率",
	shortcut: "全局快捷键",
};

/** 状态的三档文案。颜色只是增强，屏幕阅读器与色觉障碍用户读的是这三个词。 */
const STATE_TEXT = {
	ok: "正常",
	deduct: "扣分",
	unknown: "无法判断",
};

/** 「最近任务」只看已结束的前 N 条 —— 更早的历史与当前健康度关系不大。 */
const TASKS_WINDOW = 20;

/**
 * 各分项的改进建议。`note` 由对应的评分函数给出，用来区分同一种扣分下的不同成因
 * （例如运行时「总开关关着」是用户的明确选择，不该说成故障）。
 */
const ADVICE = {
	model: (item) =>
		item.note === "no-model-at-all"
			? "去「设置 → 服务商」填一个 API Key，接入可用的模型。"
			: "去首页输入框左侧的模型菜单，选一个可用的模型。",
	runtimes: (item) =>
		item.note === "master-off"
			? "内置运行时总开关是关着的 —— 这是你的选择；要用时去「设置 → 内置运行时」打开。"
			: "去「设置 → 内置运行时」安装或修复未就绪的运行时。",
	tasks: () => "最近有任务失败 —— 在下方「最近任务」里点开失败行看原因。",
	shortcut: () => "全局快捷键注册失败（可能被其他程序占用）—— 关掉占用它的程序，或换一个组合键。",
};

/**
 * 模型可用性。判据来自 app.js 的 judgeModelReadiness（三种 kind），这里只负责折算分数。
 * `null` = 这次没读成（IPC 失败），与「一个模型都没配」是两件事。
 */
function scoreModel(model) {
	if (model === null || model === void 0 || typeof model.kind !== "string") {
		return { score: 0, status: "unknown" };
	}
	switch (model.kind) {
		case "ready":
			return { score: HEALTH_MAX_PER_ITEM, status: "ok" };
		case "model-not-usable":
			return { score: 10, status: "deduct", note: "model-not-usable" };
		case "no-model-at-all":
			return { score: 0, status: "deduct", note: "no-model-at-all" };
		default:
			return { score: 0, status: "unknown" };
	}
}

/**
 * 内置运行时。总开关关闭时给 10 分而不是 0：那是用户主动关掉的，不是坏了。
 * 开关打开时按「就绪数 / 启用数」折算；一个都没启用视为 25（没有可坏的东西）。
 */
function scoreRuntimes(inventory) {
	if (inventory === null || inventory === void 0 || typeof inventory !== "object") {
		return { score: 0, status: "unknown" };
	}
	if (inventory.master === false) {
		return { score: 10, status: "deduct", note: "master-off" };
	}
	const items = Array.isArray(inventory.items) ? inventory.items : [];
	// 与 daemon 的判法一致：只有显式 false 才算被禁用（entryOf 的注释同款）。
	const enabled = items.filter((item) => item?.enabled !== false);
	if (enabled.length === 0) {
		return { score: HEALTH_MAX_PER_ITEM, status: "ok" };
	}
	const ready = enabled.filter((item) => item?.status?.kind === "ready").length;
	const score = Math.round((HEALTH_MAX_PER_ITEM * ready) / enabled.length);
	return { score, status: score === HEALTH_MAX_PER_ITEM ? "ok" : "deduct", note: "not-ready" };
}

/**
 * 最近任务成功率。只算已结束的（running 既不是成功也不是失败）；
 * 一条已结束记录都没有时给满分 —— 没有失败可扣，文案里也会说明「还没有任务记录」。
 */
function scoreTasks(runs) {
	if (!Array.isArray(runs)) {
		return { score: 0, status: "unknown" };
	}
	const ended = runs.filter((run) => run?.status !== "running").slice(0, TASKS_WINDOW);
	if (ended.length === 0) {
		return { score: HEALTH_MAX_PER_ITEM, status: "ok", note: "no-records" };
	}
	const ok = ended.filter((run) => run?.status === "ok").length;
	const score = Math.round((HEALTH_MAX_PER_ITEM * ok) / ended.length);
	return { score, status: score === HEALTH_MAX_PER_ITEM ? "ok" : "deduct", note: "failures" };
}

/** 全局唤起热键：注册失败给 0（很可能被别的程序占了，是可行动的）。 */
function scoreShortcut(shortcut) {
	if (shortcut === null || shortcut === void 0 || typeof shortcut.kind !== "string") {
		return { score: 0, status: "unknown" };
	}
	if (shortcut.kind === "registered") return { score: HEALTH_MAX_PER_ITEM, status: "ok" };
	if (shortcut.kind === "failed") return { score: 0, status: "deduct", note: "failed" };
	return { score: 0, status: "unknown" };
}

/**
 * 取「扣分最多」的那一项，给一句可执行的话。
 *
 * 并列时取固定顺序里的第一项（`items` 已按 model → runtimes → tasks → shortcut 排好），
 * 不取「最后一个最小值」之类依赖遍历顺序的写法 —— 那会让同一状态在不同实现下
 * 给出不同建议，测试也就无从钉住。
 *
 * 最低分那一项读不到时，建议改成「无法读取 X，点刷新重试」：此时用户能做的
 * 不是「去修 X」，而是先确认这次读取本身。
 */
function buildAdvice(items) {
	const full = items.every((item) => item.score === HEALTH_MAX_PER_ITEM);
	if (full) {
		return { text: "四项都正常，没有需要处理的项。", target: void 0, unknown: false };
	}
	let target = items[0];
	for (const item of items) {
		if (item.score < target.score) target = item;
	}
	if (target.status === "unknown") {
		return {
			text: `无法读取${target.label}，点右上角「刷新」重试。`,
			target: target.key,
			unknown: true,
		};
	}
	return { text: ADVICE[target.key](target), target: target.key, unknown: false };
}

/**
 * 计算健康评分。
 *
 * @returns {{
 *   total: number,
 *   items: Array<{ key: string, label: string, score: number, status: "ok"|"deduct"|"unknown", stateText: string, note?: string }>,
 *   advice: string,
 *   adviceTarget: string | undefined,
 *   adviceUnknown: boolean
 * }}
 */
export function computeHealth(input) {
	const source = input ?? {};
	const scored = {
		model: scoreModel(source.model),
		runtimes: scoreRuntimes(source.runtimes),
		tasks: scoreTasks(source.runs),
		shortcut: scoreShortcut(source.shortcut),
	};
	const items = HEALTH_ITEM_ORDER.map((key) => ({
		key,
		label: ITEM_LABELS[key],
		score: scored[key].score,
		status: scored[key].status,
		stateText: STATE_TEXT[scored[key].status],
		...(scored[key].note === void 0 ? {} : { note: scored[key].note }),
	}));
	const total = items.reduce((sum, item) => sum + item.score, 0);
	const advice = buildAdvice(items);
	return {
		total,
		items,
		advice: advice.text,
		adviceTarget: advice.target,
		adviceUnknown: advice.unknown,
	};
}

/**
 * 总分 → 档位。阈值写在 PRD 里（≥90 / ≥70 / ≥50 / 其余），
 * 颜色由渲染层按 key 映射到 token，本模块不产生色值。
 */
export function healthBand(score) {
	const value = Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : 0;
	if (value >= 90) return { key: "ok", label: "状态良好" };
	if (value >= 70) return { key: "accent", label: "基本可用" };
	if (value >= 50) return { key: "warning", label: "需要处理" };
	return { key: "danger", label: "存在问题" };
}
