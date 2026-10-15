/**
 * 「值守」边界模块（`src/main/daemon/watch-policy.js`）的单测。
 *
 * 为什么值得单独测：这条链路上没有编译期检查，写错一处不会崩，只会让用户
 *「以为给任务划了界、其实没划」—— 收敛取反（把「只能更严」写成「取更宽」）、
 * 范围前缀比较写宽（`reports-old` 被 `reports` 放行）、只读意图被误判成都读、
 * 老记录缺 boundary 时编一个空的出来（用户以为「有边界只是没用上」）都属这类
 * **静默失效**。这些正是单测该钉住的东西，且全是纯函数，毫秒级。
 *
 * 不 import Electron、不碰文件系统：这个模块只 import node:path。
 *
 * ── 反向验证（任务记录里留了完整日志）──────────────────────────────
 * 1) 把 `stricterTier` 改成取更宽的那个（`>=` 而不是 `<=`）→
 *    「只能更严」那三条用例变红，其余不受影响。
 * 2) 把 `summarizeRun` 里 `boundary` 缺失时改成返回 `{known:true, state:"ok"}` →
 *    「老记录」那两条用例变红。
 */
import { describe, expect, it } from "vitest";
import {
	DEFAULT_GLOBAL_TIER,
	WATCH_MAX_EXCEEDED,
	WATCH_MAX_MINUTES,
	WATCH_MAX_SCOPE,
	appendExceed,
	boundaryFor,
	effectivePolicy,
	emptyBoundary,
	evaluateWatchBoundary,
	isInsideScope,
	onExceedAction,
	parseWatchPolicy,
	summarizeRun,
} from "../../src/main/daemon/watch-policy.js";

/* ══ 一、只能更严（本功能的核心不变量）══════════════════════════════ */

describe("effectivePolicy —— 只能更严，不能更宽", () => {
	it("规矩声明「可写」而全局是「只读」时，收严成只读并给出告警", () => {
		const policy = effectivePolicy({ tier: "workspace-write" }, "read-only");
		expect(policy.tier).toBe("read-only");
		// 告警必须真的说「不会放宽」—— 静默失效比报错更危险
		expect(policy.warnings.join("\n")).toContain("不会放宽它");
		expect(policy.warnings.join("\n")).toContain("全局档位");
	});

	it("规矩声明「可写」而全局是全权时，收严成可写（规矩本身生效）", () => {
		const policy = effectivePolicy({ tier: "workspace-write" }, "danger-full-access");
		expect(policy.tier).toBe("workspace-write");
		expect(policy.warnings).toHaveLength(0);
	});

	it("规矩声明「只读」而全局是全权时，只读生效（收严是允许的方向）", () => {
		const policy = effectivePolicy({ tier: "read-only" }, "danger-full-access");
		expect(policy.tier).toBe("read-only");
		expect(policy.warnings).toHaveLength(0);
	});

	it("全权全局档位下，时限与可写范围照常生效（收紧的是任务，不是全局）", () => {
		const policy = effectivePolicy(
			{ tier: "workspace-write", minutes: 15, scope: ["reports/"] },
			"danger-full-access",
		);
		expect(policy.minutes).toBe(15);
		expect(policy.scoped).toEqual(["reports"]);
	});

	it("没有任何一条路径能把档位调得比全局更宽", () => {
		// 穷举：规矩三档 × 全局三档，结果永远不宽于全局
		const rank = { "read-only": 0, "workspace-write": 1, "danger-full-access": 2 };
		for (const declared of ["read-only", "workspace-write", "follow"]) {
			for (const global of ["read-only", "workspace-write", "danger-full-access"]) {
				const policy = effectivePolicy({ tier: declared }, global);
				expect(rank[policy.tier], `${declared} @ ${global}`).toBeLessThanOrEqual(rank[global]);
			}
		}
	});
});

describe("effectivePolicy —— 缺省即今天的行为（回归保护）", () => {
	it("不给规矩时，档位等于全局、无范围、无时限、无告警", () => {
		const policy = effectivePolicy(undefined, "workspace-write");
		expect(policy.tier).toBe("workspace-write");
		expect(policy.scoped).toEqual([]);
		expect(policy.minutes).toBeUndefined();
		expect(policy.warnings).toHaveLength(0);
		expect(policy.notes).toHaveLength(0);
	});

	it("tier 为 follow 时跟随全局", () => {
		expect(effectivePolicy({ tier: "follow" }, "read-only").tier).toBe("read-only");
		expect(effectivePolicy({ tier: "follow" }, "danger-full-access").tier).toBe(
			"danger-full-access",
		);
	});

	it("全局档位缺失时按缺省档（workspace-write）处理，不崩", () => {
		expect(effectivePolicy(undefined, undefined).tier).toBe(DEFAULT_GLOBAL_TIER);
		expect(effectivePolicy(undefined, "乱写的档位").tier).toBe(DEFAULT_GLOBAL_TIER);
	});

	it("只读档位下声明的可写范围不生效，且如实记一条 note", () => {
		const policy = effectivePolicy({ tier: "read-only", scope: ["reports/"] }, "read-only");
		expect(policy.scoped).toEqual([]);
		expect(policy.notes.join("\n")).toContain("不生效");
	});
});

/* ══ 二、规矩的校验（非法值抛错，不静默修正）════════════════════════ */

describe("parseWatchPolicy —— 非法值响亮地抛错", () => {
	it("空规矩规范化成缺省值", () => {
		expect(parseWatchPolicy(undefined)).toEqual({
			tier: "follow",
			scope: [],
			stopOnExceed: true,
		});
	});

	it("时限：非整数、小于 1、超过上限都抛错", () => {
		expect(() => parseWatchPolicy({ minutes: 1.5 })).toThrow(/整数/);
		expect(() => parseWatchPolicy({ minutes: 0 })).toThrow(/至少 1 分钟/);
		expect(() => parseWatchPolicy({ minutes: -5 })).toThrow(/至少 1 分钟/);
		expect(() => parseWatchPolicy({ minutes: WATCH_MAX_MINUTES + 1 })).toThrow(/最长/);
		expect(() => parseWatchPolicy({ minutes: "30" })).toThrow(/整数/);
	});

	it("能力：非法取值抛错", () => {
		expect(() => parseWatchPolicy({ tier: "read-write" })).toThrow(/只能是/);
		expect(() => parseWatchPolicy({ tier: 1 })).toThrow(/只能是/);
	});

	it("可写范围：绝对路径、跑出工作区、空串、超条数都抛错", () => {
		expect(() => parseWatchPolicy({ scope: ["/etc"] })).toThrow(/相对路径/);
		expect(() => parseWatchPolicy({ scope: ["../secrets"] })).toThrow(/工作区之外/);
		expect(() => parseWatchPolicy({ scope: ["  "] })).toThrow(/空路径/);
		expect(() => parseWatchPolicy({ scope: [123] })).toThrow(/路径字符串/);
		expect(() => parseWatchPolicy({ scope: Array(WATCH_MAX_SCOPE + 1).fill("a") })).toThrow(
			/最多/,
		);
		expect(() => parseWatchPolicy({ scope: ["a".repeat(201)] })).toThrow(/最长/);
	});

	it("可写范围去重但保序", () => {
		expect(parseWatchPolicy({ scope: ["b/", "a/", "b/"] }).scope).toEqual(["b", "a"]);
	});

	it("越界即停必须是布尔值", () => {
		expect(() => parseWatchPolicy({ stopOnExceed: "yes" })).toThrow(/开关值/);
		expect(parseWatchPolicy({ stopOnExceed: false }).stopOnExceed).toBe(false);
	});
});

/* ══ 三、边界求值的四条判定顺序 ════════════════════════════════════ */

describe("evaluateWatchBoundary —— 四条判定顺序", () => {
	const readOnly = effectivePolicy({ tier: "read-only" }, "workspace-write");
	const scoped = effectivePolicy(
		{ tier: "workspace-write", scope: ["reports/"] },
		"workspace-write",
	);

	it("① 只读意图一律放行（连只读档位下也放行）", () => {
		expect(evaluateWatchBoundary({ kind: "read", path: "任意" }, readOnly).allowed).toBe(true);
		expect(evaluateWatchBoundary({ kind: "read", path: "/etc/passwd" }, readOnly).allowed).toBe(
			true,
		);
	});

	it("② 只读档位下写操作被拒，rule = tier", () => {
		const verdict = evaluateWatchBoundary({ kind: "write", path: "a.txt" }, readOnly);
		expect(verdict.allowed).toBe(false);
		expect(verdict.rule).toBe("tier");
		// 理由要给人话的下一步，不能只说「被拒」
		expect(verdict.reason).toContain("可写");
	});

	it("③ 范围外的写操作被拒，rule = scope，且理由里带范围原文", () => {
		const verdict = evaluateWatchBoundary({ kind: "write", path: "data/x.csv" }, scoped);
		expect(verdict.allowed).toBe(false);
		expect(verdict.rule).toBe("scope");
		expect(verdict.reason).toContain("reports");
		expect(verdict.reason).toContain("data/x.csv");
	});

	it("③ 范围内的写操作放行", () => {
		expect(evaluateWatchBoundary({ kind: "write", path: "reports/x.md" }, scoped).allowed).toBe(
			true,
		);
		expect(evaluateWatchBoundary({ kind: "write", path: "reports" }, scoped).allowed).toBe(true);
	});

	it("③ 范围按路径段比，前缀相同但不是子目录的不放行", () => {
		// reports-old 不是 reports 的子目录 —— 字符串前缀比较会误放行
		expect(evaluateWatchBoundary({ kind: "write", path: "reports-old/x.md" }, scoped).allowed).toBe(
			false,
		);
	});

	it("④ 没声明范围时，工作区之外的写操作仍然被拒，rule = outside", () => {
		const plain = effectivePolicy(undefined, "workspace-write");
		const verdict = evaluateWatchBoundary(
			{ kind: "write", path: "../escape.txt" },
			plain,
			"/home/u/project",
		);
		expect(verdict.allowed).toBe(false);
		expect(verdict.rule).toBe("outside");
	});

	it("④ 工作区之内的写操作放行", () => {
		const plain = effectivePolicy(undefined, "workspace-write");
		expect(
			evaluateWatchBoundary({ kind: "write", path: "sub/a.txt" }, plain, "/home/u/project")
				.allowed,
		).toBe(true);
	});

	it("意图缺失或畸形时放行（本模块只做额外拒绝，不接管既有判定）", () => {
		expect(evaluateWatchBoundary(undefined, readOnly).allowed).toBe(true);
		expect(evaluateWatchBoundary(null, readOnly).allowed).toBe(true);
		expect(evaluateWatchBoundary({ kind: "write" }, readOnly).allowed).toBe(false);
	});
});

describe("isInsideScope", () => {
	it("空范围 = 整个工作目录", () => {
		expect(isInsideScope("anything/x.txt", [])).toBe(true);
	});

	it("通配条目等价于该目录本身及其下所有内容", () => {
		expect(isInsideScope("reports/a/b.txt", ["reports/*"])).toBe(true);
		expect(isInsideScope("reports", ["reports/*"])).toBe(false);
	});

	it("反斜杠路径与正斜杠条目可互认", () => {
		expect(isInsideScope("reports\\a\\b.txt", ["reports/"])).toBe(true);
	});
});

/* ══ 四、运行记账 ══════════════════════════════════════════════════ */

describe("appendExceed / boundaryFor", () => {
	it("越界证人超过上限时记计数而不是静默丢", () => {
		let boundary = emptyBoundary();
		for (let i = 0; i < WATCH_MAX_EXCEEDED + 3; i += 1) {
			boundary = appendExceed(boundary, { at: i, tool: "write", detail: `d${i}` });
		}
		expect(boundary.exceeded).toHaveLength(WATCH_MAX_EXCEEDED);
		expect(boundary.overflow).toBe(3);
	});

	it("boundaryFor 把只读执行与告警带进运行记录", () => {
		const policy = effectivePolicy({ tier: "workspace-write" }, "read-only");
		const boundary = boundaryFor(policy);
		expect(boundary.readOnlyEnforced).toBe(true);
		expect(boundary.notes.join("\n")).toContain("不会放宽它");
		expect(boundary.timedOut).toBe(false);
	});

	it("boundaryFor 不会与 policy 共享数组引用", () => {
		const policy = effectivePolicy({ scope: ["reports/"] }, "workspace-write");
		const boundary = boundaryFor(policy);
		boundary.scoped.push("其他/");
		expect(policy.scoped).toEqual(["reports"]);
	});
});

describe("summarizeRun —— 五态互斥", () => {
	it("老记录没有 boundary 时如实说不知道，不编一个空的出来", () => {
		expect(summarizeRun({ success: true })).toEqual({ known: false, state: "unknown" });
		expect(summarizeRun(undefined)).toEqual({ known: false, state: "unknown" });
		expect(summarizeRun({ success: false, boundary: null })).toEqual({
			known: false,
			state: "unknown",
		});
	});

	it("超时中止不是失败（两者对用户的含义不同）", () => {
		const summary = summarizeRun({
			success: false,
			boundary: { ...emptyBoundary(), timedOut: true },
		});
		expect(summary.state).toBe("timedOut");
	});

	it("跑完了但越了界", () => {
		const summary = summarizeRun({
			success: true,
			boundary: {
				...emptyBoundary(),
				exceeded: [{ at: 1, tool: "write", detail: "d" }],
			},
		});
		expect(summary.state).toBe("exceeded");
		expect(summary.exceededCount).toBe(1);
	});

	it("溢出计数也算进越界次数", () => {
		const summary = summarizeRun({
			success: true,
			boundary: {
				...emptyBoundary(),
				exceeded: [{ at: 1, tool: "write", detail: "d" }],
				overflow: 4,
			},
		});
		expect(summary.exceededCount).toBe(5);
	});

	it("没跑起来是 failed", () => {
		expect(summarizeRun({ success: false, boundary: emptyBoundary() }).state).toBe("failed");
	});

	it("跑完了是 ok", () => {
		expect(summarizeRun({ success: true, boundary: emptyBoundary() }).state).toBe("ok");
	});

	it("超时优先于「越界」与「失败」判定（状态互斥且顺序稳定）", () => {
		const summary = summarizeRun({
			success: false,
			boundary: {
				...emptyBoundary(),
				timedOut: true,
				exceeded: [{ at: 1, tool: "write", detail: "d" }],
			},
		});
		expect(summary.state).toBe("timedOut");
		expect(summary.exceededCount).toBe(1);
	});
});

/* ══ 六、越界之后停不停（stopOnExceed）══════════════════════════════ */

/*
 * 这一段是**补上一条真实缺陷**后加的。
 *
 * `stopOnExceed` 此前被 `parseWatchPolicy` 接受、被 `effectivePolicy` 原样
 * 带出来，却**没有任何一处消费它** —— 也就是说界面上那个「越界即停」开关
 * 是个摆设：打开关上都一样。这正是本项目立过的那条规矩要防的东西
 * （「参数被接受却不生效必须告警」，见 maintain-loop skill 的设计原则），
 * 所以修掉它，并用下面这几条把语义钉死。
 */
describe("onExceedAction —— 越界之后停哪一步（唯一判据）", () => {
	it("缺省（true）是停整轮", () => {
		expect(onExceedAction(effectivePolicy(undefined, "workspace-write"))).toBe("abort");
	});

	it("显式 true 也是停整轮", () => {
		expect(onExceedAction(effectivePolicy({ stopOnExceed: true }, "workspace-write"))).toBe(
			"abort",
		);
	});

	it("显式 false 是只拒这一次调用", () => {
		expect(onExceedAction(effectivePolicy({ stopOnExceed: false }, "workspace-write"))).toBe(
			"block",
		);
	});

	it("判据取自收敛后的 policy，不受档位与范围影响", () => {
		const readOnly = effectivePolicy({ tier: "read-only", stopOnExceed: false }, "workspace-write");
		expect(onExceedAction(readOnly)).toBe("block");
		const scoped = effectivePolicy({ scope: ["reports"], stopOnExceed: true }, "workspace-write");
		expect(onExceedAction(scoped)).toBe("abort");
	});
});

describe("summarizeRun —— 「越界停在失败之前」", () => {
	it("stoppedByBoundary 报 stopped，不报 failed", () => {
		const summary = summarizeRun({
			success: false,
			boundary: {
				...emptyBoundary(),
				stoppedByBoundary: true,
				exceeded: [{ at: 1, tool: "write", detail: "d" }],
			},
		});
		expect(summary.state).toBe("stopped");
		expect(summary.exceededCount).toBe(1);
	});

	it("超时优先于「越界停」", () => {
		const summary = summarizeRun({
			success: false,
			boundary: {
				...emptyBoundary(),
				timedOut: true,
				stoppedByBoundary: true,
			},
		});
		expect(summary.state).toBe("timedOut");
	});

	it("没标 stoppedByBoundary 的失败仍然是 failed（不误判成「规矩生效了」）", () => {
		expect(summarizeRun({ success: false, boundary: emptyBoundary() }).state).toBe("failed");
	});

	it("只拒单次、整轮跑完 → exceeded 而不是 stopped", () => {
		const summary = summarizeRun({
			success: true,
			boundary: {
				...emptyBoundary(),
				exceeded: [{ at: 1, tool: "write", detail: "d" }],
			},
		});
		expect(summary.state).toBe("exceeded");
	});
});
