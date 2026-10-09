/**
 * 工作轨迹纯逻辑的单测（trace-core.js，零依赖直测）。
 *
 * ── 反向验证（已真跑并还原）──────────────────────────────────────────
 * 把 buildTurnTrace 里「prev.status === status 才并段」改成只比 kind（同类无脑并），
 * 「bad 独立成段」变红 —— 含失败的串被并进大段后，「这步出过错」在轨迹上就看不见了，
 * 那正是本模块要守住的东西。
 */
import { describe, expect, it } from "vitest";
import { TRACE_KIND_ICON_TOOL, TRACE_KIND_LABELS, buildTurnTrace } from "../../src/renderer/src/trace-core.js";

// outcome 传 "running" 表示「未落定」（entry 上 outcome 字段缺省）；直接传 undefined
// 会被默认参数吞掉变成 "ok"，所以用哨兵值区分。
const tool = (id, toolName, outcome = "ok", extra = {}) => ({
	id,
	role: "tool",
	toolName,
	...(outcome === "running" ? {} : { outcome }),
	label: `工具 ${id}`,
	summary: `${toolName} 的摘要`,
	...extra
});
const deliver = (id) => ({ id, role: "artifacts_presented" });

describe("buildTurnTrace：不出场条件", () => {
	it("没有任何工具动作的回合 → empty（纯文本回合零变化）", () => {
		const trace = buildTurnTrace([
			{ id: "u1", role: "user", text: "你好" },
			{ id: "a1", role: "assistant", text: "你好！" }
		]);
		expect(trace.empty).toBe(true);
		expect(trace.segments).toEqual([]);
		expect(trace.totals).toEqual({ calls: 0, bad: 0 });
	});

	it("空数组 / undefined 入参不抛错，返回 empty", () => {
		expect(buildTurnTrace([]).empty).toBe(true);
		expect(buildTurnTrace(undefined).empty).toBe(true);
	});
});

describe("buildTurnTrace：分类表", () => {
	it("常见工具命中预期类别（读 / 写 / 命令 / 检索 / 子代理）", () => {
		const trace = buildTurnTrace([
			tool("1", "read"),
			tool("2", "edit"),
			tool("3", "bash"),
			tool("4", "grep"),
			tool("5", "task")
		]);
		expect(trace.segments.map((s) => s.kind)).toEqual(["read", "write", "command", "search", "subagent"]);
		expect(trace.segments.map((s) => s.label)).toEqual(["读", "写", "命令", "检索", "子代理"]);
	});

	it("normalize 后命中：web_search 带下划线也能归检索", () => {
		const trace = buildTurnTrace([tool("1", "web_search")]);
		expect(trace.segments[0].kind).toBe("search");
	});

	it("team_* 前缀归子代理（逐名登记会漂移）", () => {
		const trace = buildTurnTrace([tool("1", "team_send"), tool("2", "team_create")]);
		expect(trace.segments).toHaveLength(1);
		expect(trace.segments[0].kind).toBe("subagent");
		expect(trace.segments[0].count).toBe(2);
	});

	it("未知工具落 other，label 不静默丢", () => {
		const trace = buildTurnTrace([tool("1", "some_future_tool")]);
		expect(trace.segments[0].kind).toBe("other");
		expect(trace.segments[0].label).toBe("其他");
		expect(trace.segments[0].title).toContain("工具 1");
	});

	it("artifacts_presented 事件归交付段（正文渲染为 null，轨迹补位）", () => {
		const trace = buildTurnTrace([tool("1", "read"), deliver("d1")]);
		expect(trace.segments.map((s) => s.kind)).toEqual(["read", "deliver"]);
		expect(trace.segments[1].label).toBe("交付");
	});
});

describe("buildTurnTrace：相邻合并与顺序", () => {
	it("相邻同类合并并计数；隔开的同类不跨段合并（保序）", () => {
		const trace = buildTurnTrace([
			tool("1", "read"),
			tool("2", "read"),
			tool("3", "write"),
			tool("4", "read")
		]);
		expect(trace.segments.map((s) => s.kind)).toEqual(["read", "write", "read"]);
		expect(trace.segments[0].count).toBe(2);
		expect(trace.segments[0].entryIds).toEqual(["1", "2"]);
		expect(trace.segments[2].entryIds).toEqual(["4"]);
		expect(trace.totals.calls).toBe(4);
	});

	it("entryIds 全程保序（点击定位按第一个 id 找目标行）", () => {
		const trace = buildTurnTrace([
			tool("a", "write"),
			tool("b", "write"),
			tool("c", "write")
		]);
		expect(trace.segments[0].entryIds).toEqual(["a", "b", "c"]);
	});
});

describe("buildTurnTrace：状态聚合", () => {
	it("outcome 未定 → running，且只可能出现在最后一段", () => {
		const trace = buildTurnTrace([tool("1", "read", "ok"), tool("2", "bash", "running")]);
		expect(trace.segments[1].status).toBe("running");
		expect(trace.segments[0].status).toBe("ok");
	});

	it("含 error 的同类串拆出独立 bad 段（失败不被成功稀释）", () => {
		const trace = buildTurnTrace([
			tool("1", "read", "ok"),
			tool("2", "read", "error"),
			tool("3", "read", "ok")
		]);
		expect(trace.segments.map((s) => [s.kind, s.status])).toEqual([
			["read", "ok"],
			["read", "bad"],
			["read", "ok"]
		]);
		expect(trace.totals.bad).toBe(1);
	});

	it("blocked（沙箱拦截）也算 bad", () => {
		const trace = buildTurnTrace([tool("1", "powershell", "blocked")]);
		expect(trace.segments[0].status).toBe("bad");
		expect(trace.totals.bad).toBe(1);
	});

	it("非末段的 running 防御性收敛为 ok（不猜失败）", () => {
		// 正常流不会出现「running 段后面还有段」（后面的动作落定意味着前面的也该落定了）；
		// 这里构造该中间态验证防御分支不会把陈旧的 running 泄漏成失败态。
		const trace = buildTurnTrace([tool("1", "read", "running"), tool("2", "write", "ok")]);
		expect(trace.segments.map((s) => [s.kind, s.status])).toEqual([
			["read", "ok"],
			["write", "ok"]
		]);
	});
});

describe("buildTurnTrace：tooltip 可诊断", () => {
	it("title 首行是类别与计数，随后逐行列摘要", () => {
		const trace = buildTurnTrace([
			tool("1", "read"),
			tool("2", "read")
		]);
		const lines = trace.segments[0].title.split("\n");
		expect(lines[0]).toBe("读 ×2");
		expect(lines[1]).toContain("工具 1");
		expect(lines[2]).toContain("工具 2");
	});

	it("超过 6 条以「…还有 N 步」收尾，不无限堆", () => {
		const entries = Array.from({ length: 9 }, (_, i) => tool(`e${i}`, "grep"));
		const trace = buildTurnTrace(entries);
		const lines = trace.segments[0].title.split("\n");
		expect(lines).toHaveLength(1 + 6 + 1);
		expect(lines[lines.length - 1]).toBe("…还有 3 步");
	});

	it("单行超长截断（原生 tooltip 不可交互，过长比截断更糟）", () => {
		const trace = buildTurnTrace([
			tool("1", "read", "ok", { summary: "x".repeat(200) })
		]);
		const summaryLine = trace.segments[0].title.split("\n")[1];
		expect(summaryLine.length).toBeLessThanOrEqual(80);
	});
});

describe("类别常量", () => {
	it("每个类别都有标签与代表工具（渲染层图标查表用）", () => {
		for (const kind of Object.keys(TRACE_KIND_LABELS)) {
			expect(typeof TRACE_KIND_LABELS[kind]).toBe("string");
			expect(TRACE_KIND_ICON_TOOL).toHaveProperty(kind);
		}
	});
});
