/**
 * 模型对比（「一问多答」）**纯逻辑**的单元测试。
 *
 * 被测对象是 `src/main/daemon/compare.js`。它被刻意拆成两半：编排（起 N 个
 * `SessionHost` 并行发问）要跑在 Electron utilityProcess 里，单测起不来；
 * 而「列状态怎么走、事件怎么按列分派、用量怎么读、耗时从哪一刻起算」这些判断
 * 既不碰宿主、又恰恰是最容易错的部分 —— 抽出来就能用毫秒级的单测钉死
 * （同 `library.js` 的抽法，见该文件头部的理由）。
 *
 * 这里最重的一条是**列间隔离**：A 列的事件绝不能进 B 列。它在界面上表现为
 * 「一列显示了另一列的内容」或「两列用着同一个耗时」，是并行功能最经典的一类
 * 缺陷；GUI 断言很难说清「这次串了没有」，而在这里它就是一句
 * `expect(b).toBe(before)`（**同一引用**，比「等值」更强）。
 *
 * ## 归约的硬约定（实现与渲染层共享的口径）
 *
 * 1. **只吃自己那一列的事件**：`event.columnId !== state.columnId` ⇒ 原样返回同一引用。
 * 2. **不适应的事件一律原样返回同一引用**：非法转移（终态后再来 delta）、未知 kind、
 *    畸形事件，都不改变状态、也不记标记。理由：终态是终态，一条迟到的 delta
 *    不能把一列「复活」；返回同一引用还能让上层用 `Object.is` 做快速路径。
 *    诊断靠编排层的事件流，不靠往 UI 状态里塞计数。
 * 3. **耗时只认自己的起点**：`startedAt` 是该列 `column_started` 的那一刻，
 *    不是整轮对比的开始时刻 —— 两列先后启动，耗时就该不同。
 *
 * ## 反向验证（已真跑并还原，实际结果如下）
 *
 * 1) 去掉 `reduceColumn` 里 `event.columnId !== state.columnId` 的判据 ⇒
 *    **4 条变红**，全部是「串台」这一类断言：「列间隔离」那三条
 *    （列 id 不匹配原样返回 / A 的喂给 B / 两列交错跑）与末尾的
 *    「一次完整的一问多答」；其余 48 条不受影响。
 * 2) 把 `accumulateTiming` 的耗时改成「从整轮对比开始那一刻起算」⇒
 *    **2 条变红**，都是「各自耗时」这一类：「两列先后启动，各自的耗时不同」
 *    与「一次完整的一问多答」；其余 50 条不受影响（单列计时那几条注不出来 ——
 *    只有一列时两个口径恰好等值）。
 *
 * 两次都备份后还原并重跑全绿（判据：与备份 `diff -q` 为空、文件里无注入残留）。
 */

import { describe, expect, it } from "vitest";
import {
	COMPARE_MAX_COLUMNS,
	COMPARE_MIN_COLUMNS,
	accumulateTiming,
	createColumnStates,
	extractUsage,
	normalizeColumns,
	reduceColumn,
} from "../../src/main/daemon/compare.js";

/** 两个可用模型 key（`服务商/模型`，与 `auth.js` 的 `toModelKey` 同形）。 */
const MODELS = ["openai/gpt-4o", "anthropic/claude-sonnet-4-5"];
/** 时间基准取一个固定的整点毫秒，避免读系统时钟。 */
const T0 = 1_700_000_000_000;

/** 造一个列事件。`columnId` 必给 —— 它决定了这条事件归哪一列。 */
function ev(columnId, kind, extra = {}) {
	return { columnId, kind, ...extra };
}

/** 归约一串事件（只走状态机，不碰计时）。 */
function fold(state, events) {
	return events.reduce((current, event) => reduceColumn(current, event), state);
}

/** 造一条 `assistant_done` 事件，`message` 形状对齐 `session-host.js` 的产出。 */
function doneEvent(columnId, message) {
	return ev(columnId, "assistant_done", { message });
}

// ── 列参数校验 ──────────────────────────────────────────────

describe("normalizeColumns", () => {
	it("2 个与 4 个之间通过，且保持调用方给的顺序", () => {
		const two = normalizeColumns(MODELS);
		expect(two.ok).toBe(true);
		expect(two.models).toEqual(MODELS);

		const four = normalizeColumns(["a/1", "b/2", "c/3", "d/4"]);
		expect(four.ok).toBe(true);
		expect(four.models).toEqual(["a/1", "b/2", "c/3", "d/4"]);
	});

	it("下限与上限的常量是 2 与 4（渲染层的多选也照着它拦）", () => {
		expect(COMPARE_MIN_COLUMNS).toBe(2);
		expect(COMPARE_MAX_COLUMNS).toBe(4);
	});

	it("0 个与 1 个明确拒绝，并说清下限", () => {
		for (const models of [[], ["openai/gpt-4o"]]) {
			const result = normalizeColumns(models);
			expect(result.ok).toBe(false);
			expect(result.error).toContain(String(COMPARE_MIN_COLUMNS));
			expect(result.models).toBeUndefined();
		}
	});

	it("超过 4 个明确拒绝，并说清上限（不是静默截断到 4 个）", () => {
		const result = normalizeColumns(["a/1", "b/2", "c/3", "d/4", "e/5"]);
		expect(result.ok).toBe(false);
		expect(result.error).toContain(String(COMPARE_MAX_COLUMNS));
		expect(result.error).toContain("5");
	});

	it("不是数组时拒绝", () => {
		for (const models of [undefined, null, "openai/gpt-4o", 42, { 0: "a/1" }]) {
			const result = normalizeColumns(models);
			expect(result.ok, `${String(models)} 不该通过`).toBe(false);
			expect(typeof result.error).toBe("string");
			expect(result.error.length).toBeGreaterThan(0);
		}
	});

	it("非字符串与空串的条目拒绝", () => {
		expect(normalizeColumns(["openai/gpt-4o", 42]).ok).toBe(false);
		expect(normalizeColumns(["openai/gpt-4o", ""]).ok).toBe(false);
		expect(normalizeColumns(["openai/gpt-4o", "   "]).ok).toBe(false);
	});

	it("两侧取空白的 key 会被 trim 掉（用户从别处粘进来的多半带空格）", () => {
		const result = normalizeColumns(["  openai/gpt-4o ", "anthropic/claude-sonnet-4-5\n"]);
		expect(result.ok).toBe(true);
		expect(result.models).toEqual(MODELS);
	});

	it("不符合「服务商/模型」形状的 key 拒绝 —— 口径与 auth.js 的 parseModelKey 一致", () => {
		// parseModelKey 在**第一个** `/` 处切分，两侧都必须非空。
		for (const bad of ["gpt-4o", "/gpt-4o", "openai/", "x"]) {
			const result = normalizeColumns(["openai/gpt-4o", bad]);
			expect(result.ok, `${bad} 不该通过`).toBe(false);
			expect(result.error).toContain(bad);
		}
		// 模型 id 里带 `/` 是合法的：只切第一个。
		expect(normalizeColumns(["openrouter/meta-llama/llama-3", "openai/gpt-4o"]).ok).toBe(true);
	});

	it("同一个模型选两次 → 拒绝，而不是静默去重", () => {
		// 静默去重会让「选了 2 个」变成「屏幕上 1 列」，用户不知道少的那列去哪了。
		const result = normalizeColumns(["openai/gpt-4o", "openai/gpt-4o"]);
		expect(result.ok).toBe(false);
		expect(result.error).toContain("openai/gpt-4o");
	});

	it("超长的模型名不做截断（截断是渲染层展示的事）", () => {
		const long = `vendor/${"m".repeat(400)}`;
		const result = normalizeColumns(["openai/gpt-4o", long]);
		expect(result.ok).toBe(true);
		expect(result.models[1]).toBe(long);
	});
});

// ── 初始列状态 ──────────────────────────────────────────────

describe("createColumnStates", () => {
	it("每列一个稳定且唯一的 id，初始都是 queued", () => {
		const states = createColumnStates(MODELS);
		expect(states.map((s) => s.columnId)).toEqual(["col-0", "col-1"]);
		expect(new Set(states.map((s) => s.columnId)).size).toBe(MODELS.length);
		for (const [index, state] of states.entries()) {
			expect(state.modelKey).toBe(MODELS[index]);
			expect(state.status).toBe("queued");
			expect(state.text).toBe("");
			expect(state.thinking).toBe("");
			// 还没跑：用量、错误、耗时都必须缺席，而不是编一个 0 出来。
			expect(state.usage).toBeUndefined();
			expect(state.error).toBeUndefined();
			expect(state.startedAt).toBeUndefined();
			expect(state.endedAt).toBeUndefined();
			expect(state.elapsedMs).toBeUndefined();
		}
	});

	it("列与列之间不共享对象（改一列不会带上另一列）", () => {
		const [a, b] = createColumnStates(MODELS);
		expect(a).not.toBe(b);
		expect(a.modelKey).not.toBe(b.modelKey);
	});

	it("不改动入参", () => {
		const models = [...MODELS];
		createColumnStates(models);
		expect(models).toEqual(MODELS);
	});

	it("不是数组时给空列表（内部函数，不把一次 run 炸掉）", () => {
		expect(createColumnStates(undefined)).toEqual([]);
	});
});

// ── 列间隔离（本任务最重要的一条）────────────────────────────

describe("列间隔离", () => {
	it("列 id 不匹配的事件原样返回（同一引用）", () => {
		const [a] = createColumnStates(MODELS);
		const before = a;
		for (const event of [
			ev("col-1", "column_started"),
			ev("col-1", "text_delta", { delta: "别人的话" }),
			doneEvent("col-1", { id: "m1", text: "别人的回复" }),
			ev("col-1", "column_failed", { error: "别人的错" }),
		]) {
			expect(reduceColumn(before, event), `${event.kind} 不该落到 col-0`).toBe(before);
		}
		expect(before.text).toBe("");
		expect(before.status).toBe("queued");
	});

	it("把 A 列的事件喂给 B 列：B 列一字不变", () => {
		const [a, b] = createColumnStates(MODELS);
		const bBefore = b;
		const aAfter = fold(a, [
			ev("col-0", "column_started"),
			ev("col-0", "text_delta", { delta: "A 的第一段" }),
			doneEvent("col-0", { id: "m0", text: "A 的完整回复" }),
		]);
		// 逐条把 A 列的事件「误投」给 B 列，一条都不该被接受。
		let bAfter = b;
		for (const event of [
			ev("col-0", "column_started"),
			ev("col-0", "text_delta", { delta: "A 的第一段" }),
			doneEvent("col-0", { id: "m0", text: "A 的完整回复" }),
		]) {
			bAfter = reduceColumn(bAfter, event);
		}
		expect(bAfter).toBe(bBefore);
		expect(aAfter.text).toBe("A 的完整回复");
		expect(aAfter.status).toBe("done");
	});

	it("两列交错跑：各自的文本是自己那串 delta，没有互相掺进去", () => {
		let [a, b] = createColumnStates(MODELS);
		a = fold(a, [ev("col-0", "column_started")]);
		b = fold(b, [ev("col-1", "column_started")]);
		const interleaved = [
			ev("col-0", "text_delta", { delta: "阿" }),
			ev("col-1", "text_delta", { delta: "必" }),
			ev("col-0", "text_delta", { delta: "拉" }),
			ev("col-1", "text_delta", { delta: "西" }),
		];
		for (const event of interleaved) {
			a = reduceColumn(a, event);
			b = reduceColumn(b, event);
		}
		expect(a.text).toBe("阿拉");
		expect(b.text).toBe("必西");
	});
});

// ── 列状态机 ────────────────────────────────────────────────

describe("reduceColumn 的合法转移", () => {
	it("queued → running → done", () => {
		const [a] = createColumnStates(MODELS);
		const queued = reduceColumn(a, ev("col-0", "column_queued"));
		expect(queued.status).toBe("queued");
		const running = reduceColumn(queued, ev("col-0", "column_started"));
		expect(running.status).toBe("running");
		const done = reduceColumn(running, doneEvent("col-0", { id: "m0", text: "回复" }));
		expect(done.status).toBe("done");
	});

	it("queued → running → failed（带原因）", () => {
		const [a] = createColumnStates(MODELS);
		const running = reduceColumn(a, ev("col-0", "column_started"));
		const failed = reduceColumn(running, ev("col-0", "column_failed", { error: "服务商返回 500" }));
		expect(failed.status).toBe("failed");
		expect(failed.error).toBe("服务商返回 500");
	});

	it("queued → failed（还没轮到就失败了，例如模型 key 解析不通过）", () => {
		const [a] = createColumnStates(MODELS);
		const failed = reduceColumn(a, ev("col-0", "column_failed", { error: "模型不可用" }));
		expect(failed.status).toBe("failed");
		expect(failed.error).toBe("模型不可用");
	});

	it("queued → running → cancelled", () => {
		const [a] = createColumnStates(MODELS);
		const running = reduceColumn(a, ev("col-0", "column_started"));
		const cancelled = reduceColumn(running, ev("col-0", "column_cancelled"));
		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.error).toBeUndefined();
	});

	it("queued → cancelled（还没轮到就被整体取消）", () => {
		const [a] = createColumnStates(MODELS);
		const cancelled = reduceColumn(a, ev("col-0", "column_cancelled"));
		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.text).toBe("");
	});

	it("文本按到达顺序累积", () => {
		const [a] = createColumnStates(MODELS);
		const state = fold(a, [
			ev("col-0", "column_started"),
			ev("col-0", "text_delta", { delta: "你" }),
			ev("col-0", "text_delta", { delta: "好" }),
			ev("col-0", "text_delta", { delta: "！" }),
		]);
		expect(state.text).toBe("你好！");
	});

	it("思考按到达顺序累积，且与正文分开", () => {
		const [a] = createColumnStates(MODELS);
		const state = fold(a, [
			ev("col-0", "column_started"),
			ev("col-0", "thinking_delta", { delta: "先想" }),
			ev("col-0", "text_delta", { delta: "再说" }),
			ev("col-0", "thinking_delta", { delta: "一下" }),
		]);
		expect(state.thinking).toBe("先想一下");
		expect(state.text).toBe("再说");
	});

	it("assistant_done 的整段文本是权威值，覆盖流式累积的结果", () => {
		const [a] = createColumnStates(MODELS);
		const state = fold(a, [
			ev("col-0", "column_started"),
			ev("col-0", "text_delta", { delta: "半" }),
			doneEvent("col-0", { id: "m0", text: "半句话被修正后的完整回复" }),
		]);
		expect(state.text).toBe("半句话被修正后的完整回复");
	});

	it("assistant_done 带 thinking 时以它为准", () => {
		const [a] = createColumnStates(MODELS);
		const state = fold(a, [
			ev("col-0", "column_started"),
			ev("col-0", "thinking_delta", { delta: "草稿" }),
			doneEvent("col-0", { id: "m0", text: "回复", thinking: "定稿" }),
		]);
		expect(state.thinking).toBe("定稿");
	});

	it("assistant_done 不带 thinking 时保留已累积的思考", () => {
		const [a] = createColumnStates(MODELS);
		const state = fold(a, [
			ev("col-0", "column_started"),
			ev("col-0", "thinking_delta", { delta: "草稿" }),
			doneEvent("col-0", { id: "m0", text: "回复" }),
		]);
		expect(state.thinking).toBe("草稿");
	});

	it("column_started / column_queued 携带的 modelKey 会被采纳（渲染层靠它认列）", () => {
		const bare = { ...createColumnStates(MODELS)[0], modelKey: "" };
		expect(reduceColumn(bare, ev("col-0", "column_queued", { modelKey: "openai/gpt-4o" })).modelKey).toBe(
			"openai/gpt-4o",
		);
		expect(reduceColumn(bare, ev("col-0", "column_started", { modelKey: "openai/gpt-4o" })).modelKey).toBe(
			"openai/gpt-4o",
		);
	});

	it("不改动入参（返回新对象）", () => {
		const [a] = createColumnStates(MODELS);
		const snapshot = { ...a };
		reduceColumn(a, ev("col-0", "column_started"));
		reduceColumn(a, ev("col-0", "text_delta", { delta: "x" }));
		expect(a).toEqual(snapshot);
	});
});

describe("reduceColumn 的不适应事件：一律原样返回（同一引用）", () => {
	/** 造一个已收尾的列：`terminalKind` 决定它停在哪个终态。 */
	function settled(kind) {
		const [a] = createColumnStates(MODELS);
		if (kind === "done") {
			return fold(a, [
				ev("col-0", "column_started"),
				doneEvent("col-0", { id: "m0", text: "已经答完了" }),
			]);
		}
		const running = reduceColumn(a, ev("col-0", "column_started"));
		return reduceColumn(running, ev("col-0", kind === "failed" ? "column_failed" : "column_cancelled"));
	}

	it("终态之后迟到的 text_delta 不复活这一列", () => {
		for (const kind of ["done", "failed", "cancelled"]) {
			const state = settled(kind);
			const after = reduceColumn(state, ev("col-0", "text_delta", { delta: "迟到的话" }));
			expect(after, `${kind} 之后不该再收文本`).toBe(state);
			expect(after.status).toBe(kind);
		}
	});

	it("终态之后重复的终态事件被忽略（不改 finalized 的 elapsed 与文本）", () => {
		const state = settled("done");
		expect(reduceColumn(state, doneEvent("col-0", { id: "m0", text: "第二次" }))).toBe(state);
		expect(reduceColumn(state, ev("col-0", "column_failed", { error: "然后又失败了" }))).toBe(state);
		expect(reduceColumn(state, ev("col-0", "column_cancelled"))).toBe(state);
		expect(state.text).toBe("已经答完了");
		expect(state.error).toBeUndefined();
	});

	it("running 之后重复的 column_started 被忽略（不重启计时）", () => {
		const [a] = createColumnStates(MODELS);
		const running = reduceColumn(a, ev("col-0", "column_started"));
		expect(reduceColumn(running, ev("col-0", "column_started"))).toBe(running);
	});

	it("还没 column_started 就来 delta：丢弃，而不是把文本塞进一个「还没开始」的列", () => {
		// 事件顺序由编排层保证；顺序错了就丢弃 —— 静默接受会把一个顺序错误
		// 变成界面上看不见的错位文本。
		const [a] = createColumnStates(MODELS);
		expect(reduceColumn(a, ev("col-0", "text_delta", { delta: "x" }))).toBe(a);
		expect(reduceColumn(a, ev("col-0", "thinking_delta", { delta: "x" }))).toBe(a);
		expect(reduceColumn(a, doneEvent("col-0", { id: "m0", text: "x" }))).toBe(a);
	});

	it("未知 kind 与整体事件 run_finished 被忽略", () => {
		const [a] = createColumnStates(MODELS);
		expect(reduceColumn(a, ev("col-0", "run_finished", { outcome: "completed" }))).toBe(a);
		expect(reduceColumn(a, ev("col-0", "something_new"))).toBe(a);
		// run_finished 是整体信号，不带 columnId —— 绝不能被某一列当成自己的终态。
		expect(reduceColumn(a, { kind: "run_finished", outcome: "completed" })).toBe(a);
	});

	it("畸形事件（空、非字符串 delta、没有 message）被忽略而不是抛错", () => {
		const [a] = createColumnStates(MODELS);
		const running = reduceColumn(a, ev("col-0", "column_started"));
		expect(reduceColumn(running, ev("col-0", "text_delta"))).toBe(running);
		expect(reduceColumn(running, ev("col-0", "text_delta", { delta: 42 }))).toBe(running);
		expect(reduceColumn(running, ev("col-0", "assistant_done"))).toBe(running);
		expect(reduceColumn(running, ev("col-0", "assistant_done", { message: "不是对象" }))).toBe(running);
		expect(reduceColumn(running, undefined)).toBe(running);
		expect(reduceColumn(undefined, ev("col-0", "text_delta", { delta: "x" }))).toBeUndefined();
		expect(running.status).toBe("running");
	});

	it("失败但没有给出原因时，兜底文案是可读的一句话（不是空白、不是「操作失败」）", () => {
		const [a] = createColumnStates(MODELS);
		const failed = fold(a, [ev("col-0", "column_failed", { error: "   " })]);
		expect(failed.error.length).toBeGreaterThan(0);
		expect(failed.error).not.toBe("操作失败");
		expect(failed.error).toContain("原因");
	});

	it("失败原因给的是 Error 实例时取它的 message", () => {
		const [a] = createColumnStates(MODELS);
		const failed = reduceColumn(a, ev("col-0", "column_failed", { error: new Error("连接被重置") }));
		expect(failed.error).toBe("连接被重置");
	});
});

// ── 用量提取 ────────────────────────────────────────────────

describe("extractUsage", () => {
	/** 对齐 `session-host.js` 的 `toTokenUsage(message.usage)` 产出（见该处注释）。 */
	const full = {
		input: 1200,
		output: 340,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 1540,
		cost: 0.0123,
		costBreakdown: { input: 0.008, output: 0.0043, cacheRead: 0, cacheWrite: 0 },
	};

	it("正常：取出可展示的数值字段", () => {
		const usage = extractUsage(doneEvent("col-0", { id: "m0", text: "x", usage: full }));
		expect(usage).toEqual({
			input: 1200,
			output: 340,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1540,
			cost: 0.0123,
		});
	});

	it("可选字段（reasoning / cacheWrite1h）在时带上", () => {
		const usage = extractUsage(
			doneEvent("col-0", {
				id: "m0",
				text: "x",
				usage: { ...full, reasoning: 88, cacheWrite1h: 512 },
			}),
		);
		expect(usage.reasoning).toBe(88);
		expect(usage.cacheWrite1h).toBe(512);
	});

	it("缺 usage 时如实返回 undefined —— 不编一个 0 出来", () => {
		expect(extractUsage(doneEvent("col-0", { id: "m0", text: "x" }))).toBeUndefined();
		expect(extractUsage(ev("col-0", "assistant_done"))).toBeUndefined();
		expect(extractUsage(undefined)).toBeUndefined();
	});

	it("畸形 usage（不是对象 / 全是非数值）返回 undefined", () => {
		expect(extractUsage(doneEvent("col-0", { usage: null }))).toBeUndefined();
		expect(extractUsage(doneEvent("col-0", { usage: "很多" }))).toBeUndefined();
		expect(extractUsage(doneEvent("col-0", { usage: [] }))).toBeUndefined();
		expect(extractUsage(doneEvent("col-0", { usage: {} }))).toBeUndefined();
		expect(extractUsage(doneEvent("col-0", { usage: { input: "1200" } }))).toBeUndefined();
	});

	it("畸形字段被逐个剔除：只留下真正的数值", () => {
		const usage = extractUsage(
			doneEvent("col-0", {
				usage: { input: 10, output: "三十", cacheRead: Number.NaN, totalTokens: Number.POSITIVE_INFINITY },
			}),
		);
		expect(usage).toEqual({ input: 10 });
		expect(usage.output).toBeUndefined();
		expect(usage.cacheRead).toBeUndefined();
		expect(usage.totalTokens).toBeUndefined();
	});
});

// ── 耗时口径 ────────────────────────────────────────────────

describe("accumulateTiming", () => {
	it("column_started 记下这一列自己开始的时刻", () => {
		const [a] = createColumnStates(MODELS);
		const state = accumulateTiming(a, ev("col-0", "column_started"), T0);
		expect(state.startedAt).toBe(T0);
		expect(state.endedAt).toBeUndefined();
		expect(state.elapsedMs).toBeUndefined();
	});

	it("终态记下结束时刻与耗时", () => {
		for (const kind of ["assistant_done", "column_failed", "column_cancelled"]) {
			const [a] = createColumnStates(MODELS);
			const started = accumulateTiming(a, ev("col-0", "column_started"), T0);
			const extra = kind === "assistant_done" ? { message: { id: "m0", text: "x" } } : {};
			const ended = accumulateTiming(started, ev("col-0", kind, extra), T0 + 2_500);
			expect(ended.endedAt, kind).toBe(T0 + 2_500);
			expect(ended.elapsedMs, kind).toBe(2_500);
		}
	});

	it("两列先后启动，各自的耗时不同（都从**自己**开始那一刻起算）", () => {
		// A 列先跑到，B 列排队 3 秒后才轮到；两列在同一时刻收尾。
		const [a, b] = createColumnStates(MODELS);
		const startedA = accumulateTiming(a, ev("col-0", "column_started"), T0);
		const startedB = accumulateTiming(b, ev("col-1", "column_started"), T0 + 3_000);
		const doneA = accumulateTiming(startedA, ev("col-0", "assistant_done"), T0 + 5_000);
		const doneB = accumulateTiming(startedB, ev("col-1", "assistant_done"), T0 + 5_000);
		expect(doneA.elapsedMs).toBe(5_000);
		expect(doneB.elapsedMs).toBe(2_000);
		expect(doneA.elapsedMs).not.toBe(doneB.elapsedMs);
	});

	it("还没轮到就被取消：不记耗时（没有「跑了多久」可言）", () => {
		const [a] = createColumnStates(MODELS);
		const cancelled = accumulateTiming(a, ev("col-0", "column_cancelled"), T0 + 1_000);
		expect(cancelled.startedAt).toBeUndefined();
		expect(cancelled.endedAt).toBeUndefined();
		expect(cancelled.elapsedMs).toBeUndefined();
	});

	it("列 id 不匹配时不计时（同一引用）", () => {
		const [a] = createColumnStates(MODELS);
		expect(accumulateTiming(a, ev("col-1", "column_started"), T0)).toBe(a);
	});

	it("重复的 column_started / 终态不覆盖已经记下的时间", () => {
		const [a] = createColumnStates(MODELS);
		const started = accumulateTiming(a, ev("col-0", "column_started"), T0);
		expect(accumulateTiming(started, ev("col-0", "column_started"), T0 + 900)).toBe(started);

		const ended = accumulateTiming(started, ev("col-0", "column_cancelled"), T0 + 1_000);
		expect(accumulateTiming(ended, ev("col-0", "column_cancelled"), T0 + 5_000)).toBe(ended);
	});

	it("now 不是有限数时不计时（绝不把 NaN 写进耗时）", () => {
		const [a] = createColumnStates(MODELS);
		expect(accumulateTiming(a, ev("col-0", "column_started"), Number.NaN)).toBe(a);
		expect(accumulateTiming(a, ev("col-0", "column_started"), undefined)).toBe(a);
		const started = accumulateTiming(a, ev("col-0", "column_started"), T0);
		expect(accumulateTiming(started, ev("col-0", "column_cancelled"), Number.NaN)).toBe(started);
	});

	it("时钟回拨不会算出负耗时（取 0）", () => {
		const [a] = createColumnStates(MODELS);
		const started = accumulateTiming(a, ev("col-0", "column_started"), T0);
		const ended = accumulateTiming(started, ev("col-0", "column_cancelled"), T0 - 500);
		expect(ended.elapsedMs).toBe(0);
	});

	it("与 reduceColumn 的字段不重叠，喂事件的先后顺序不影响结果", () => {
		const [a] = createColumnStates(MODELS);
		const events = [ev("col-0", "column_started"), ev("col-0", "text_delta", { delta: "答" })];
		let stateThenTiming = a;
		for (const event of events) {
			stateThenTiming = accumulateTiming(reduceColumn(stateThenTiming, event), event, T0 + 100);
		}
		let timingThenState = a;
		for (const event of events) {
			timingThenState = reduceColumn(accumulateTiming(timingThenState, event, T0 + 100), event);
		}
		expect(stateThenTiming).toEqual(timingThenState);
		expect(stateThenTiming.startedAt).toBe(T0 + 100);
		expect(stateThenTiming.text).toBe("答");
	});
});

// ── 一整列的完整生命周期 ────────────────────────────────────

describe("一次完整的一问多答", () => {
	it("两列凭各自的事件收尾，文本与耗时各归各的", () => {
		let states = createColumnStates(MODELS);
		const apply = (event, now) => {
			states = states.map((state) => accumulateTiming(reduceColumn(state, event), event, now));
		};

		apply(ev("col-0", "column_queued", { modelKey: MODELS[0] }), T0);
		apply(ev("col-1", "column_queued", { modelKey: MODELS[1] }), T0);
		apply(ev("col-0", "column_started"), T0);
		apply(ev("col-1", "column_started"), T0 + 1_200);
		apply(ev("col-0", "text_delta", { delta: "简洁" }), T0 + 3_000);
		apply(ev("col-1", "text_delta", { delta: "啰嗦" }), T0 + 2_000);
		apply(doneEvent("col-0", { id: "m0", text: "简洁的回答", usage: { input: 100, output: 20 } }), T0 + 4_000);
		apply(ev("col-1", "column_failed", { error: "服务商返回 500" }), T0 + 6_000);

		const [a, b] = states;
		expect(a.status).toBe("done");
		expect(a.text).toBe("简洁的回答");
		expect(a.usage).toEqual({ input: 100, output: 20 });
		expect(a.elapsedMs).toBe(4_000);

		expect(b.status).toBe("failed");
		expect(b.error).toBe("服务商返回 500");
		expect(b.usage).toBeUndefined();
		expect(b.elapsedMs).toBe(4_800);

		// 一列失败没有影响另一列的任何字段。
		expect(a.error).toBeUndefined();
		expect(b.text).toBe("啰嗦");
	});
});