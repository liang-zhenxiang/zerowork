/*
 * desktop-behavior.js —— 托盘值守的**纯决策**（#422）
 *
 * 全部是不碰 Electron / 文件系统的纯函数，单测在
 * `tests/unit/desktop-behavior.test.mjs` 直接 import 本文件。
 * 把它们从 `index.js` 里分出来的理由只有一个：这些判断（关窗要不要隐藏、
 * 什么时候该发通知）是**界面之外最容易悄悄错掉**的部分 —— 混在 800 行的
 * 主进程接线里，既写不了单测，也没人会去读。
 */

/**
 * 关窗时是否只隐藏到托盘（而不是真的关闭）。
 *
 * `quitting` 必须能压过 `closeToTray`：托盘菜单的「退出」与系统退出都走
 * `app.quit()`，退出途中窗口收到的 close 不能再被拦下 —— 否则应用永远退不出去。
 * 这条判断是「退出链路一字不改」的落点，改它之前先想清楚退出路径。
 */
function shouldHideOnClose({ closeToTray, quitting }) {
	return closeToTray === true && quitting !== true;
}

/**
 * 一轮结束时要不要发系统通知；返回 `"completed"` / `"failed"` / `null`。
 *
 * 三条同时成立才发：
 *   · 用户开着「完成任务时通知」；
 *   · 窗口**不在前台**（在前台时用户自己看得到，系统通知只是打扰）；
 *   · 终态值得通知 —— `run_finished` 只认 `completed`，用户主动取消的
 *     `cancelled` 不发（那是他自己停的）；`run_error` 一律算失败。
 *
 * 通知内容不在这里拼：本函数只给「哪一种」，文案与会话 id 由主进程决定，
 * 避免把会话标题之类的信息带进通知（见 index.js 的 notifyCompletion）。
 */
function shouldNotifyCompletion({ enabled, focused, eventType, outcome, quietHours }) {
	if (enabled !== true || focused === true) return null;
	/* #439 第二十六轮 F2：免打扰时段内不发系统通知（应用内反馈不受影响）。 */
	if (quietHours === true) return null;
	if (eventType === "run_finished") return outcome === "completed" ? "completed" : null;
	if (eventType === "run_error") return "failed";
	return null;
}

/** #439 F2：免打扰判定。24h 制 HH:MM，start>end 表示跨零点（22:00-08:00）。
    nowMinutes 由调用方传（可测）。 */
function isQuietHours({ quietStart, quietEnd }, nowMinutes) {
	if (typeof quietStart !== "string" || typeof quietEnd !== "string") return false;
	const parse = (s) => {
		const m = /^(\d{2}):(\d{2})$/.exec(s);
		if (m === null) return null;
		const h = Number(m[1]);
		const min = Number(m[2]);
		if (h > 23 || min > 59) return null;
		return h * 60 + min;
	};
	const start = parse(quietStart);
	const end = parse(quietEnd);
	if (start === null || end === null || start === end) return false;
	const now = typeof nowMinutes === "number" ? nowMinutes : new Date().getHours() * 60 + new Date().getMinutes();
	return start < end ? now >= start && now < end : now >= start || now < end;
}

/** runId 是会话内生成的字符串；缺 id 的事件不计入（否则计数会被空串污染）。 */
function isValidRunId(runId) {
	return typeof runId === "string" && runId !== "";
}

/** 加入「运行中」集合；返回是否真的新增（调用方据此决定要不要重建托盘菜单）。 */
function addRunning(runs, runId) {
	if (!isValidRunId(runId)) return false;
	if (runs.has(runId)) return false;
	runs.add(runId);
	return true;
}

/** 移出「运行中」集合；返回是否真的移出。 */
function removeRunning(runs, runId) {
	if (!isValidRunId(runId)) return false;
	return runs.delete(runId);
}

/** 运行中的任务数（托盘菜单那一行）。 */
function runningCount(runs) {
	return runs.size;
}

export { shouldHideOnClose, shouldNotifyCompletion, isQuietHours, addRunning, removeRunning, runningCount };
