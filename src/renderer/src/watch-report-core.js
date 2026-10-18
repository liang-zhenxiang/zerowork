/**
 * 「值守报告」的纯逻辑内核：把一次运行的 `boundary` 读数归约成界面上的一句话。
 *
 * ## 为什么这些判断要抽成一个不碰 React 的模块
 *
 * 这一块最容易出、也最难在截图里说清的缺陷是「状态被压平」：`run.success` 是
 * 一个布尔值，而「越界停」与「模型报错」在它眼里是同一件事。界面上不报错，
 * 只表现为**一句话说得不对**——把「规矩按设计生效了」读成「功能坏了」。
 * GUI 断言只看得到最终像素，而单测能逐条钉在状态的转移上。
 * 抽法与理由同 `compare-view.js` / `case-cover.js`。
 *
 * ## 与 daemon 侧那份归约器的关系：镜像，不是复用
 *
 * `src/main/daemon/watch-policy.js` 里有同名的 `summarizeRun` 与
 * `onExceedAction`，本文件是它的**渲染层镜像**，口径与它逐条一致。不复用有两条硬理由：
 *
 *   1. 那个模块 import `node:path`，且属于 daemon 的模块图 —— 渲染层不可能
 *      （也不该）import 它；
 *   2. 渲染层本来就有自己的一份副本 —— `app.js` 的 `conversationReducer` 与
 *      daemon 的 `session-state.js` 同样是两份手工同步的镜像。
 *
 * 所以**改其中一份时另一份要一起改**，这条纪律与上面那对镜像同源。
 *
 * ## 判定的顺序是这份文件的核心
 *
 * 超时 → 越界停 → 失败 → 越界 → 好。**「越界停」必须排在「失败」之前**：
 * 那条运行的 `success` 也是 false（那一轮确实没跑完），但它和「环境炸了」
 * 是两件完全不同的事。先说成「失败」会让用户以为功能坏了。
 */

/** daemon 侧 `summarizeRun` 返回的全部状态，顺序即判定优先级。 */
export const WATCH_STATES = ["timedOut", "stopped", "failed", "exceeded", "ok", "unknown"];

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把一次运行读成一个状态 + 越界次数。
 *
 * **老记录（没有 `boundary`）返回 `known: false`**，而不是编一个空 boundary
 * 出来判成 `ok` —— 那会让用户以为「这次有边界、只是没用上」，是凭空捏造。
 *
 * @returns {{known: boolean, state: string, exceededCount: number}}
 */
export function summarizeRun(run) {
	if (!isPlainObject(run)) return { known: false, state: "unknown", exceededCount: 0 };
	const boundary = run.boundary;
	if (!isPlainObject(boundary)) return { known: false, state: "unknown", exceededCount: 0 };

	const exceededList = Array.isArray(boundary.exceeded) ? boundary.exceeded : [];
	const overflow = typeof boundary.overflow === "number" ? boundary.overflow : 0;
	const exceededCount = exceededList.length + overflow;

	if (boundary.timedOut === true) return { known: true, state: "timedOut", exceededCount };
	if (boundary.stoppedByBoundary === true) {
		return { known: true, state: "stopped", exceededCount };
	}
	if (run.success !== true) return { known: true, state: "failed", exceededCount };
	if (exceededCount > 0) return { known: true, state: "exceeded", exceededCount };
	return { known: true, state: "ok", exceededCount };
}

/**
 * 越界之后停哪一步。**与 daemon 侧 `onExceedAction` 同口径**：
 * `stopOnExceed === false` → `"block"`（只拒这一次调用），其余 → `"abort"`（停整轮）。
 *
 * 界面文案与执行层读的是同一条判据；两份判定必然漂移，所以这里只做镜像、
 * 不做第二套判断。
 */
export function onExceedAction(watch) {
	if (!isPlainObject(watch)) return "abort";
	return watch.stopOnExceed === false ? "block" : "abort";
}

/**
 * 报告体那一句话。`ok` 与 `failed` 两种状态用不上次数（零次越界是常态、
 * 失败的原因在 `run.error` 里），所以只有 `exceeded` / `stopped` 有 `withCount`。
 *
 * 文案纪律见 `RunReport` 的注释：`ok` 要像一件完成的事，`stopped` 不能说成失败。
 */
const STATE_TEXT = {
	ok: { plain: "跑完了，一次都没越界。" },
	exceeded: {
		plain: "跑完了，但碰到过值守规矩。",
		withCount: (n) => `跑完了，但越界 ${n} 次。`
	},
	stopped: {
		plain: "越界即停：碰到值守规矩，当场停下了。",
		withCount: (n) => `越界即停：碰到值守规矩 ${n} 次，当场停下了。`
	},
	timedOut: { plain: "被叫停：运行超过了设定的时限。" },
	failed: { plain: "这次没跑起来。" }
};

/** 报告体的那一句话；未知状态返回 `undefined`（调用方据此不渲染报告体）。 */
export function reportLine(summary) {
	if (!isPlainObject(summary) || summary.known !== true) return void 0;
	const entry = STATE_TEXT[summary.state];
	if (entry === void 0) return void 0;
	if (summary.exceededCount > 0 && entry.withCount !== void 0) {
		return entry.withCount(summary.exceededCount);
	}
	return entry.plain;
}

/**
 * 徽标文案与色调。
 *
 * **`stopped` 的文字是「被叫停」不是「失败」** —— 红底由 `.bad` 提供
 * （`success: false` 客观上成立），文字负责说清是规矩按设计生效了。
 */
const BADGE = {
	timedOut: { text: "超时中止", tone: "bad" },
	stopped: { text: "被叫停", tone: "bad" },
	failed: { text: "失败", tone: "bad" },
	exceeded: { text: "越界", tone: "bad" },
	ok: { text: "成功", tone: "ok" }
};

/**
 * 这一行显示的徽标。**老记录（`known: false`）回落到 `success`** ——
 * 那时没有 boundary 可读，旧的「成功 / 失败」是当时能说的全部。
 */
export function runBadge(summary, success) {
	if (isPlainObject(summary) && summary.known === true) {
		const hit = BADGE[summary.state];
		if (hit !== void 0) return hit;
	}
	return success === true ? BADGE.ok : BADGE.failed;
}

/**
 * 跑完之后那条 toast 的**文案**。
 *
 * 为什么不直接看 `success`：越界即停与超时中止的 `success` 也是 false（那一轮确实
 * 没跑完），但它们与「模型报错 / 环境炸了」是两件事 —— 前者是规矩**按设计生效**了。
 * 只说「运行失败」会和报告里的「被叫停」互相打架（2026-10-18 在 mock e2e 的截图里
 * 第一次被看见）。
 *
 * `outcome` 由 daemon 算好随事件推来（与报告共用同一份 summarizeRun），
 * 这里只做**措辞**，不重新判定。老 renderer / 老 daemon 的兼容：没有 `outcome`
 * 时退回 `success` 的旧口径。
 */
export function automationToastText(event) {
	const name = typeof event?.taskName === "string" ? event.taskName : "";
	const task = name === "" ? "任务" : `任务「${name}」`;
	const outcome = event?.outcome;
	if (outcome === "timedOut") return `${task}到时限被叫停`;
	if (outcome === "stopped") return `${task}被值守规矩叫停`;
	if (outcome === "exceeded") return `${task}已完成，但越了界`;
	if (outcome === "failed") return `${task}运行失败`;
	if (outcome === "ok") return `${task}已完成`;
	return event?.success === true ? `${task}已完成` : `${task}运行失败`;
}

/** toast 的色调：只有真失败才用 error。被叫停与越界是「规矩生效」，不是错误。 */
export function automationToastTone(event) {
	const outcome = event?.outcome;
	if (outcome === "timedOut" || outcome === "stopped" || outcome === "exceeded") return "info";
	if (outcome === "failed") return "error";
	if (outcome === "ok") return "success";
	return event?.success === true ? "success" : "error";
}
