/**
 * 值守报告的纯逻辑（`src/renderer/src/watch-report-core.js`）单元测试。
 *
 * 这一层守的是**界面上不报错、只表现为「一句话说得不对」**的缺陷：
 * `run.success` 是个布尔值，「越界停」与「模型报错」在它眼里是同一件事，
 * 于是「规矩按设计生效了」被读成「功能坏了」。GUI 断言只看得到最终像素，
 * 单测却能逐条钉在状态的转移上。
 *
 * 另有一组是**镜像契约测试**：本文件与 `src/main/daemon/watch-policy.js` 的
 * `summarizeRun` 是两份手工同步的镜像（理由见源文件头）。两边判定的**顺序**
 * 必须逐条一致 —— 顺序错了不会报错，只会让状态读反。
 *
 * 反向验证（本轮写完后逐条执行过，注入 → 跑 → 还原 → 再跑）：
 *
 *   ① 把 `summarizeRun` 里「越界停」那段挪到 `run.success !== true` **之后** →
 *      恰好 3 条变红：「stopped 不报 failed」（`expected 'failed' to be 'stopped'`）、
 *      「stopped 的文案是「当场停下了」」（`expected '这次没跑起来。' to contain '越界即停'`）、
 *      「stopped → 被叫停 / bad」（`expected '失败' to be '被叫停'`）。
 *      这正是本文件最想钉住的那条顺序 —— 三条断言从三个角度覆盖同一个转移。
 *   ② 把 `boundary` 缺失时改成返回 `{known:true, state:"ok"}` → **4 条**变红：
 *      「返回 known:false」、`boundary` 是数组 / 字符串 / null 那条，以及
 *      经由 `reportLine` / `runBadge` 的两条回落到 success 的用例。
 *
 * 一条**没测出东西**的注入，如实记在这里（不假装它有效）：
 *
 *   ③ 把 `reportLine` 里 `exceededCount > 0 && entry.withCount !== void 0`
 *      改成只看 `exceededCount > 0` → **22 条全绿**。原因是当前六态里凡可能
 *      出现 `exceededCount > 0` 的状态（`exceeded` / `stopped`）都定义了
 *      `withCount`，所以那个守卫**眼下不可达**。它留着是为了防「以后有人加一个
 *      不带 `withCount` 的状态」—— 那时它会生效，但现在没有用例能证明它。
 *      这是已知的覆盖缺口，不是通过。
 */
import { describe, expect, it } from "vitest";
import {
	WATCH_STATES,
	automationToastText,
	automationToastTone,
	onExceedAction,
	reportLine,
	runBadge,
	summarizeRun
} from "../../src/renderer/src/watch-report-core.js";

/* ══ 一、判定顺序（本文件的核心）══════════════════════════════════ */

describe("summarizeRun —— 越界停在失败之前", () => {
	it("stopped 不报 failed（规矩按设计生效了，不是功能坏了）", () => {
		const summary = summarizeRun({
			success: false,
			boundary: {
				exceeded: [{ at: 1, tool: "write", detail: "d" }],
				stoppedByBoundary: true
			}
		});
		expect(summary.state).toBe("stopped");
		expect(summary.exceededCount).toBe(1);
	});

	it("超时优先于「越界停」", () => {
		const summary = summarizeRun({
			success: false,
			boundary: { timedOut: true, stoppedByBoundary: true }
		});
		expect(summary.state).toBe("timedOut");
	});

	it("没标 stoppedByBoundary 的失败仍然是 failed", () => {
		expect(summarizeRun({ success: false, boundary: {} }).state).toBe("failed");
	});

	it("只拒单次、整轮跑完 → exceeded", () => {
		const summary = summarizeRun({
			success: true,
			boundary: { exceeded: [{ at: 1, tool: "write", detail: "d" }] }
		});
		expect(summary.state).toBe("exceeded");
	});

	it("干干净净跑完 → ok，次数为 0", () => {
		const summary = summarizeRun({ success: true, boundary: {} });
		expect(summary.state).toBe("ok");
		expect(summary.exceededCount).toBe(0);
	});
});

/* ══ 二、老记录不编造 ════════════════════════════════════════════ */

describe("summarizeRun —— 没有 boundary 的老记录", () => {
	it("返回 known:false，而不是判成 ok", () => {
		const summary = summarizeRun({ success: true });
		expect(summary.known).toBe(false);
		expect(summary.state).toBe("unknown");
	});

	it("boundary 是数组 / 字符串 / null 时同样 unknown（不炸）", () => {
		expect(summarizeRun({ success: true, boundary: [] }).known).toBe(false);
		expect(summarizeRun({ success: true, boundary: "x" }).known).toBe(false);
		expect(summarizeRun({ success: true, boundary: null }).known).toBe(false);
	});

	it("run 本身不是对象时也 unknown（不炸）", () => {
		expect(summarizeRun(void 0).known).toBe(false);
		expect(summarizeRun(null).known).toBe(false);
		expect(summarizeRun("x").known).toBe(false);
	});
});

/* ══ 三、越界次数的口径 ══════════════════════════════════════════ */

describe("summarizeRun —— 越界次数是「证人条数 + overflow」", () => {
	it("overflow 计入总数（超出记录上限的那部分不能凭空消失）", () => {
		const summary = summarizeRun({
			success: true,
			boundary: { exceeded: [{ at: 1, tool: "write", detail: "d" }], overflow: 4 }
		});
		expect(summary.exceededCount).toBe(5);
	});

	it("exceeded 不是数组时按 0 条算（不炸）", () => {
		const summary = summarizeRun({ success: true, boundary: { exceeded: "x" } });
		expect(summary.exceededCount).toBe(0);
		expect(summary.state).toBe("ok");
	});
});

/* ══ 四、文案 ════════════════════════════════════════════════════ */

describe("reportLine —— ok 绝不像错误、stopped 绝不像失败", () => {
	it("ok 说成一件完成的事（不是「暂无记录」那种语感）", () => {
		expect(reportLine(summarizeRun({ success: true, boundary: {} }))).toBe(
			"跑完了，一次都没越界。"
		);
	});

	it("exceeded 带次数", () => {
		const line = reportLine(
			summarizeRun({
				success: true,
				boundary: { exceeded: [{ at: 1, tool: "w", detail: "d" }] }
			})
		);
		expect(line).toBe("跑完了，但越界 1 次。");
	});

	it("stopped 的文案是「当场停下了」，不是「失败」", () => {
		const line = reportLine(
			summarizeRun({ success: false, boundary: { stoppedByBoundary: true } })
		);
		expect(line).toContain("越界即停");
		expect(line).not.toContain("失败");
	});

	it("老记录没有文案（调用方据此不渲染报告体）", () => {
		expect(reportLine(summarizeRun({ success: true }))).toBe(void 0);
	});

	it("unknown 状态即使 known 也不给文案", () => {
		expect(reportLine({ known: true, state: "unknown", exceededCount: 0 })).toBe(void 0);
	});
});

/* ══ 五、徽标 ════════════════════════════════════════════════════ */

describe("runBadge —— stopped 的文字是「被叫停」不是「失败」", () => {
	it("stopped → 被叫停 / bad", () => {
		const badge = runBadge(
			summarizeRun({ success: false, boundary: { stoppedByBoundary: true } }),
			false
		);
		expect(badge.text).toBe("被叫停");
		expect(badge.tone).toBe("bad");
	});

	it("timedOut → 超时中止", () => {
		expect(runBadge(summarizeRun({ success: false, boundary: { timedOut: true } }), false).text).toBe(
			"超时中止"
		);
	});

	it("老记录回落到 success（那时没有 boundary 可读）", () => {
		expect(runBadge(summarizeRun({ success: true }), true).text).toBe("成功");
		expect(runBadge(summarizeRun({ success: false }), false).text).toBe("失败");
	});
});

/* ══ 六、越界之后停哪一步（与 daemon 侧同口径）══════════════════════ */

describe("onExceedAction —— 与 daemon 侧 onExceedAction 镜像", () => {
	it("缺省 / true 是停整轮", () => {
		expect(onExceedAction(void 0)).toBe("abort");
		expect(onExceedAction({})).toBe("abort");
		expect(onExceedAction({ stopOnExceed: true })).toBe("abort");
	});

	it("显式 false 是只拒这一次调用", () => {
		expect(onExceedAction({ stopOnExceed: false })).toBe("block");
	});

	it("不是对象时按缺省（停整轮）—— 宁可严一点", () => {
		expect(onExceedAction(null)).toBe("abort");
		expect(onExceedAction("x")).toBe("abort");
	});
});

/* ══ 七、与 daemon 侧的镜像契约 ══════════════════════════════════ */

describe("WATCH_STATES —— 状态清单与 daemon 侧一致", () => {
	it("六种状态齐全且顺序即判定优先级", () => {
		expect(WATCH_STATES).toEqual([
			"timedOut",
			"stopped",
			"failed",
			"exceeded",
			"ok",
			"unknown"
		]);
	});
});

/* ══ 二、跑完的 toast：结论由 daemon 给，渲染层只措辞 ══════════════ */

describe("automationToastText —— 「被叫停」不能说成「运行失败」", () => {
	const base = { taskName: "值班日报", success: false };

	it("stopped：说被规矩叫停，不是失败", () => {
		const text = automationToastText({ ...base, outcome: "stopped" });
		expect(text).toBe("任务「值班日报」被值守规矩叫停");
		expect(text).not.toContain("失败");
	});

	it("timedOut：说到时限被叫停，不是失败", () => {
		const text = automationToastText({ ...base, outcome: "timedOut" });
		expect(text).toBe("任务「值班日报」到时限被叫停");
		expect(text).not.toContain("失败");
	});

	it("exceeded：说已完成但越了界（这一次确实跑完了）", () => {
		const text = automationToastText({ success: false, taskName: "值班日报", outcome: "exceeded" });
		expect(text).toContain("已完成");
		expect(text).toContain("越了界");
		expect(text).not.toContain("失败");
	});

	it("failed / ok：各自的措辞", () => {
		expect(automationToastText({ ...base, outcome: "failed" })).toBe("任务「值班日报」运行失败");
		expect(automationToastText({ taskName: "值班日报", success: true, outcome: "ok" })).toBe(
			"任务「值班日报」已完成"
		);
	});

	it("老 daemon（没有 outcome）退回 success 的旧口径", () => {
		expect(automationToastText({ taskName: "值班日报", success: true })).toBe("任务「值班日报」已完成");
		expect(automationToastText({ taskName: "值班日报", success: false })).toBe("任务「值班日报」运行失败");
	});
});

describe("automationToastTone —— 只有真失败才用 error", () => {
	it("被叫停 / 越界是「规矩生效」，用 info 而不是 error", () => {
		expect(automationToastTone({ outcome: "stopped", success: false })).toBe("info");
		expect(automationToastTone({ outcome: "timedOut", success: false })).toBe("info");
		expect(automationToastTone({ outcome: "exceeded", success: false })).toBe("info");
	});

	it("failed 用 error，ok 用 success", () => {
		expect(automationToastTone({ outcome: "failed" })).toBe("error");
		expect(automationToastTone({ outcome: "ok", success: true })).toBe("success");
	});

	it("老 daemon（没有 outcome）退回 success 的旧口径", () => {
		expect(automationToastTone({ success: true })).toBe("success");
		expect(automationToastTone({ success: false })).toBe("error");
	});
});
