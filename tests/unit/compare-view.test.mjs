/**
 * 模型对比视图的纯逻辑（`src/renderer/src/compare-view.js`）单元测试。
 *
 * 这一层守的是三类**在界面上不报错**的缺陷 —— 它们只表现为「数字不对」，
 * GUI 断言只看得到最终像素，单测却能逐条钉在状态机的转移上：
 *
 *   1. 两列显示了同一个数字（列间串台 / 用量串台）；
 *   2. 某一列的事件进了另一列；
 *   3. 某一列永远停在流式中（终态之后被迟到事件改动，或压根没有终态）。
 *
 * 另有一组是**契约测试**：`src/shared/ipc.js` 的 `PUSH.compareEvent` 注释里列了几种
 * kind，归约器就得处理几种。新增一种 kind 而忘了处理，在界面上同样是静默的
 * （那一列卡住没反应，没有任何报错），所以这里把两份清单对起来。
 *
 * 反向验证（2026-10-07，本文件写完后逐条执行过，注入 → 跑 → 还原 → 再跑）：
 *
 *   ① 去掉**列间隔离**的两层判据（`compareReducer` 里按 `columnId` 分派的那一层
 *      + `reduceColumn` 里那一层）→ **恰好 3 条变红**：「A 列的事件绝不进 B 列」
 *      （`expected '第一列的答案' to be ''`）、「queued → running → done…」
 *      （`expected '半句话' to be '另一个答案'` —— 正是「一列显示了另一列的内容」）、
 *      「整轮收尾记下 outcome…」。其余 27 条不受影响。
 *      （只去掉其中一层**不会**红：两层各自都足以挡住串台，这是有意的纵深，
 *      所以注入必须两层一起去掉才测得出这条断言是真的。）
 *   ② 把「受理窗口期宽容取值」改成一律严格比对 runId → 恰好「受理窗口期
 *      （runId 还没回来）也不丢列事件」变红（`expected 'queued' to be 'running'`）。
 *   ③ 去掉 `appendDelta` 的「只有 running 列才吃增量」判据 → 恰好「终态是终态」变红
 *      （迟到的事件改了状态，引用也不再相等）。
 *
 * 三次注入都是「改完就跑、跑完就还原」，还原判据是文件与备份逐字节一致。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
	COMPARE_FULL_HINT,
	COMPARE_HANDLED_KINDS,
	COMPARE_MAX_MODELS,
	COMPARE_MIN_HINT,
	canStartCompare,
	columnBodyKind,
	columnEntries,
	columnMetricItems,
	columnStatusText,
	compareHint,
	compareReducer,
	describeModel,
	extractUsage,
	initialCompareState,
	laneAccentVar,
	modelButtonText,
	togglePickedModel,
} from "../../src/renderer/src/compare-view.js";

/** 测试用的两个模型 key（形状与 `parseModelKey` 认的一致：服务商/模型）。 */
const A = "prov-a/model-a";
const B = "prov-b/model-b";

/** 跑一轮：begin → accept → 返回状态（后续再逐条喂事件）。 */
function started(models = [A, B], runId = "compare-1") {
	const begun = compareReducer(initialCompareState(models), { type: "begin", models });
	return compareReducer(begun, { type: "accept", runId });
}

/** 从状态里取某一列。 */
function columnOf(state, columnId) {
	return state.columns.find((column) => column.columnId === columnId);
}

/** 把一条事件喂进状态（`now` 显式给，归约才是确定的）。 */
function feed(state, event, now = 1000) {
	return compareReducer(state, { type: "event", event, now });
}

describe("与 src/shared/ipc.js 的 kind 契约", () => {
	it("注释里列的 kind 与归约器认的 kind 逐项一致", () => {
		const source = readFileSync(new URL("../../src/shared/ipc.js", import.meta.url), "utf8");
		const section = source.slice(
			source.indexOf("### kind 取值清单"),
			source.indexOf('compareEvent: "compare:event"')
		);
		// 清单的形态是「`   *   kind` 后接说明」：`*` 之后固定三个空格。
		// 段落行只有一个空格，因此不会被收进来。
		const documented = [...section.matchAll(/^\s*\*\s{3}([a-z_]+)\s/gm)].map((match) => match[1]);
		expect(documented.length, "没有从 ipc.js 里读到 kind 清单（注释形态变了吗？）").toBeGreaterThan(0);
		expect([...new Set(documented)].sort()).toEqual([...COMPARE_HANDLED_KINDS].sort());
	});

	it("每一种 kind 都真的被归约器处理（声明了却没实现会在这里红）", () => {
		// 每种 kind 一条最小事件 + 一条「处理后必须成立」的断言。
		// 这张表就是「声明 vs 实现」的闭环：往 COMPARE_HANDLED_KINDS 里加一个
		// 没实现的 kind，下面的 get(kind) 会取不到而抛错。
		const expectations = new Map([
			["column_queued", (state) => expect(columnOf(state, "col-0").modelKey).toBe(A)],
			["column_started", (state) => expect(columnOf(state, "col-0").status).toBe("running")],
			["text_delta", (state) => expect(columnOf(state, "col-0").text).toBe("流")],
			["thinking_delta", (state) => expect(columnOf(state, "col-0").thinking).toBe("想")],
			[
				"assistant_done",
				(state) => expect(columnOf(state, "col-0").status).toBe("done"),
			],
			["column_failed", (state) => expect(columnOf(state, "col-0").status).toBe("failed")],
			["column_cancelled", (state) => expect(columnOf(state, "col-0").status).toBe("cancelled")],
			["run_finished", (state) => expect(state.phase).toBe("finished")],
		]);
		const events = {
			column_queued: { columnId: "col-0", kind: "column_queued", modelKey: A },
			column_started: { columnId: "col-0", kind: "column_started", modelKey: A },
			text_delta: { columnId: "col-0", kind: "text_delta", delta: "流" },
			thinking_delta: { columnId: "col-0", kind: "thinking_delta", delta: "想" },
			assistant_done: { columnId: "col-0", kind: "assistant_done", message: { text: "答" } },
			column_failed: { columnId: "col-0", kind: "column_failed", error: "连接被拒" },
			column_cancelled: { columnId: "col-0", kind: "column_cancelled" },
			run_finished: { kind: "run_finished", outcome: "completed", elapsedMs: 1200 },
		};
		// 先推进到 running（不然 delta / done 一类的判据全都不成立）。
		for (const kind of COMPARE_HANDLED_KINDS) {
			expect(expectations.has(kind), `${kind} 没有对应的实现断言`).toBe(true);
			const state = feed(
				feed(started(), { runId: "compare-1", columnId: "col-0", kind: "column_started" }, 10),
				{ runId: "compare-1", ...events[kind] },
				20
			);
			expectations.get(kind)(state);
		}
	});
});

describe("列状态机", () => {
	it("begin 之后列阵按发出去的名单重建，各列排队中", () => {
		const state = started();
		expect(state.phase).toBe("running");
		expect(state.runId).toBe("compare-1");
		expect(state.columns.map((column) => [column.columnId, column.modelKey, column.status])).toEqual([
			["col-0", A, "queued"],
			["col-1", B, "queued"],
		]);
	});

	it("还没发问时列是 empty（「等待提问」，不是「无数据」）", () => {
		const state = initialCompareState([A, B]);
		expect(state.phase).toBe("idle");
		expect(state.columns.map((column) => column.status)).toEqual(["empty", "empty"]);
		expect(columnBodyKind(columnOf(state, "col-0"))).toBe("empty");
	});

	it("queued → running → done：文本与用量按列各算各的", () => {
		let state = started();
		state = feed(state, { runId: "compare-1", columnId: "col-0", kind: "column_started" }, 100);
		state = feed(state, { runId: "compare-1", columnId: "col-0", kind: "text_delta", delta: "半" }, 150);
		state = feed(state, { runId: "compare-1", columnId: "col-1", kind: "column_started" }, 300);
		state = feed(state, { runId: "compare-1", columnId: "col-1", kind: "text_delta", delta: "另" }, 320);
		state = feed(
			state,
			{ runId: "compare-1", columnId: "col-0", kind: "assistant_done", message: { text: "半句话", usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 0, totalTokens: 16, cost: 0.01 } } },
			1000
		);
		state = feed(
			state,
			{ runId: "compare-1", columnId: "col-1", kind: "assistant_done", message: { text: "另一个答案", usage: { input: 99, output: 88, totalTokens: 187, cost: 0.02 } } },
			2000
		);
		const first = columnOf(state, "col-0");
		const second = columnOf(state, "col-1");
		expect(first.text).toBe("半句话");            // 整段文本是权威值，覆盖流式累积
		expect(second.text).toBe("另一个答案");
		expect(first.usage).toEqual({ input: 10, output: 4, cacheRead: 2, cacheWrite: 0, totalTokens: 16, cost: 0.01 });
		expect(second.usage).toEqual({ input: 99, output: 88, totalTokens: 187, cost: 0.02 });
		expect(first.elapsedMs).toBe(900);            // 从 col-0 自己的 column_started 起算
		expect(second.elapsedMs).toBe(1700);          // 不是「整轮耗时」
	});

	it("排队等待不计入该列耗时（两列的耗时本来就不该相等）", () => {
		let state = started();
		// col-1 先跑，col-0 排队 5 秒后才轮到。
		state = feed(state, { runId: "compare-1", columnId: "col-1", kind: "column_started" }, 1000);
		state = feed(state, { runId: "compare-1", columnId: "col-0", kind: "column_started" }, 6000);
		state = feed(state, { runId: "compare-1", columnId: "col-0", kind: "assistant_done", message: { text: "x" } }, 7000);
		expect(columnOf(state, "col-0").elapsedMs).toBe(1000);
		expect(columnOf(state, "col-0").startedAt).toBe(6000);
	});

	it("排队中就被取消 → 不记耗时（没有「跑了多久」可言）", () => {
		let state = started();
		state = feed(state, { runId: "compare-1", columnId: "col-0", kind: "column_cancelled" }, 500);
		const column = columnOf(state, "col-0");
		expect(column.status).toBe("cancelled");
		expect(column.elapsedMs).toBeUndefined();
		expect(column.endedAt).toBeUndefined();
		expect(columnStatusText(column, 0, (ms) => `${ms}ms`)).toBe("已取消");
	});

	it("终态是终态：迟到的增量不改状态，且返回同一个引用", () => {
		let state = started();
		state = feed(state, { runId: "compare-1", columnId: "col-0", kind: "column_started" }, 10);
		state = feed(state, { runId: "compare-1", columnId: "col-0", kind: "assistant_done", message: { text: "答完了" } }, 20);
		const before = state;
		const after = feed(state, { runId: "compare-1", columnId: "col-0", kind: "text_delta", delta: "不该进来" }, 30);
		expect(after).toBe(before);                        // 一条迟到的增量不能把一列「复活」
		expect(columnOf(after, "col-0").text).toBe("答完了");
	});

	it("畸形 / 未知事件一律不动状态", () => {
		const state = started();
		expect(feed(state, { runId: "compare-1", columnId: "col-0", kind: "不认识的 kind" })).toBe(state);
		expect(compareReducer(state, { type: "event", event: null })).toBe(state);
		expect(compareReducer(state, { type: "不认识的动作" })).toBe(state);
		expect(compareReducer(state, { type: "event", event: { runId: "compare-1", kind: "text_delta" } })).toBe(state);
	});
});

describe("列间隔离与跨轮隔离", () => {
	it("A 列的事件绝不进 B 列（不串台的实现根）", () => {
		let state = started();
		state = feed(state, { runId: "compare-1", columnId: "col-0", kind: "column_started" }, 10);
		state = feed(state, { runId: "compare-1", columnId: "col-1", kind: "column_started" }, 10);
		state = feed(state, { runId: "compare-1", columnId: "col-0", kind: "text_delta", delta: "只该进第一列" }, 20);
		state = feed(
			state,
			{ runId: "compare-1", columnId: "col-0", kind: "assistant_done", message: { text: "第一列的答案", usage: { input: 1, output: 2 } } },
			30
		);
		const second = columnOf(state, "col-1");
		expect(second.text).toBe("");
		expect(second.status).toBe("running");
		expect(second.usage).toBeUndefined();
		expect(columnOf(state, "col-0").text).toBe("第一列的答案");
	});

	it("不是本轮的事件（上一轮迟到的终态）一律丢弃", () => {
		const state = started([A, B], "compare-2");
		const after = feed(state, { runId: "compare-1", columnId: "col-0", kind: "column_cancelled" }, 10);
		expect(after).toBe(state);
		expect(columnOf(after, "col-0").status).toBe("queued");
		expect(feed(state, { runId: "compare-1", kind: "run_finished", outcome: "cancelled" })).toBe(state);
		expect(state.phase).toBe("running");
	});

	it("受理窗口期（runId 还没回来）也不丢列事件", () => {
		// daemon 的列事件在 compareStart 应答之前就会推出来，所以 begin 之后、
		// accept 之前收到的事件必须照常归约。
		const begun = compareReducer(initialCompareState([A, B]), { type: "begin", models: [A, B] });
		expect(begun.runId).toBeUndefined();
		const early = feed(begun, { runId: "compare-9", columnId: "col-0", kind: "column_started" }, 10);
		expect(columnOf(early, "col-0").status).toBe("running");
		const accepted = compareReducer(early, { type: "accept", runId: "compare-9" });
		expect(accepted.runId).toBe("compare-9");
		// 登记之后严格比对：别的轮再也进不来。
		expect(feed(accepted, { runId: "compare-8", columnId: "col-0", kind: "column_cancelled" })).toBe(accepted);
	});

	it("整轮收尾记下 outcome，列状态不被收尾抹掉", () => {
		let state = started();
		state = feed(state, { runId: "compare-1", columnId: "col-0", kind: "column_started" }, 10);
		state = feed(state, { runId: "compare-1", columnId: "col-0", kind: "assistant_done", message: { text: "留着的答案" } }, 20);
		state = feed(state, { runId: "compare-1", columnId: "col-1", kind: "column_started" }, 10);
		state = feed(state, { runId: "compare-1", kind: "run_finished", outcome: "cancelled", elapsedMs: 5000 }, 5000);
		expect(state.phase).toBe("finished");
		expect(state.outcome).toBe("cancelled");
		expect(state.elapsedMs).toBe(5000);
		expect(columnOf(state, "col-0").text).toBe("留着的答案");
		expect(columnOf(state, "col-1").status).toBe("running");
	});

	it("本轮没起得来时回到「已选好名单、还没发问」", () => {
		let state = started();
		state = feed(state, { runId: "compare-1", columnId: "col-0", kind: "column_started" }, 10);
		const failed = compareReducer(state, { type: "failed" });
		expect(failed.phase).toBe("idle");
		expect(failed.picked).toEqual([A, B]);
		expect(failed.columns.map((column) => column.status)).toEqual(["empty", "empty"]);
		expect(columnOf(failed, "col-0").text).toBe("");
	});

	it("运行中改名单被忽略（通道与名单必须一致）", () => {
		const state = started();
		expect(compareReducer(state, { type: "toggle", key: A })).toBe(state);
	});
});

describe("名单动作是相对动作（连点不丢第一个）", () => {
	/*
	 * 这一组守的是一个**真实修过的缺陷**：动作原是 `{type:"pick", models:[…]}`
	 * （绝对列表），而组件里的处理器读的是**这次渲染的闭包**里的 `state.picked`。
	 * 同一个任务里派发两条时，两条都基于同一份旧 state，第二条把第一条整个覆盖 ——
	 * 症状是「连着点两个模型，只选中了后一个」，而分开点（中间隔着一次重渲染）
	 * 完全正常，所以它看起来像手速问题（实测：同一 evaluate 里点两下 → 只剩一个；
	 * 分成两次、间隔 250ms → 两个都在）。
	 *
	 * 改成相对动作后由归约器按**最新状态**算，下面第一条就是它的回归防线：
	 * 把 reducer 的 `toggle` 改回「用传进来的绝对列表」（例如
	 * `return initialCompareState([action.key])`），这一条会变红。
	 */
	it("连着两条 toggle 两个模型都在名单里（相对动作的核心）", () => {
		let state = initialCompareState([]);
		state = compareReducer(state, { type: "toggle", key: A });
		state = compareReducer(state, { type: "toggle", key: B });
		expect(state.picked).toEqual([A, B]);
	});

	it("从已选名单里 toggle 同一个 key 是移出（顺序不变）", () => {
		const state = compareReducer(initialCompareState([A, B, "p/m3"]), { type: "toggle", key: A });
		expect(state.picked).toEqual([B, "p/m3"]);
	});

	it("第 5 个被拒绝：名单一个字不动，原因记进 lastReject", () => {
		const full = ["p/m1", "p/m2", "p/m3", "p/m4"];
		const before = initialCompareState(full);
		let state = compareReducer(before, { type: "toggle", key: "p/m5" });
		expect(state.picked).toBe(before.picked); // 原样返回**同一引用**（不是截断、也不是塞进去）
		expect(state.picked).toEqual(full);
		expect(state.lastReject).toEqual({ hint: COMPARE_FULL_HINT, seq: 1 });
		// 连着越界两次也各是一次新的拒绝（对象引用不同 —— 界面靠它决定弹不弹提示）。
		const again = compareReducer(state, { type: "toggle", key: "p/m5" });
		expect(again.lastReject).toEqual({ hint: COMPARE_FULL_HINT, seq: 2 });
		expect(again.lastReject).not.toBe(state.lastReject);
	});

	it("成功加减会把 lastReject 清掉（提示不再重复弹）", () => {
		const full = ["p/m1", "p/m2", "p/m3", "p/m4"];
		let state = compareReducer(initialCompareState(full), { type: "toggle", key: "p/m5" });
		expect(state.lastReject).toBeDefined();
		state = compareReducer(state, { type: "toggle", key: "p/m1" });
		expect(state.lastReject).toBeUndefined();
		expect(state.picked).toEqual(["p/m2", "p/m3", "p/m4"]);
	});

	it("还没发问时点选只改名单，列阵仍是 empty", () => {
		const state = compareReducer(initialCompareState([]), { type: "toggle", key: A });
		expect(state.phase).toBe("idle");
		expect(state.columns.map((column) => [column.columnId, column.modelKey, column.status])).toEqual([
			["col-0", A, "empty"],
		]);
	});
});

describe("用量提取", () => {
	it("缺失或畸形时如实给 undefined，不编 0", () => {
		expect(extractUsage({ message: { text: "x" } })).toBeUndefined();
		expect(extractUsage({ message: {} })).toBeUndefined();
		expect(extractUsage({ message: { usage: null } })).toBeUndefined();
		expect(extractUsage({ message: { usage: [] } })).toBeUndefined();
		expect(extractUsage({ message: { usage: { input: "10" } } })).toBeUndefined();
		expect(extractUsage(undefined)).toBeUndefined();
	});

	it("单个字段畸形只剔除那一个，其余照收", () => {
		expect(extractUsage({ message: { usage: { input: 3, output: Number.NaN, cost: 0.5 } } })).toEqual({
			input: 3,
			cost: 0.5,
		});
	});
});

describe("列头读数", () => {
	const fmt = (ms) => `${Math.floor(ms / 1000)}s`;

	it("五种状态 + 还没发问，各有各的一行字", () => {
		const column = (status, extra = {}) => ({ columnId: "col-0", status, text: "", thinking: "", ...extra });
		expect(columnStatusText(column("empty"), 5e3, fmt)).toBeUndefined();
		expect(columnStatusText(column("queued"), 5e3, fmt)).toBe("排队中");
		expect(columnStatusText(column("running", { startedAt: 1e3 }), 13e3, fmt)).toBe("已处理 12s");
		expect(columnStatusText(column("done", { elapsedMs: 12e3 }), 9e9, fmt)).toBe("已完成 12s");
		expect(columnStatusText(column("failed", { elapsedMs: 3e3 }), 9e9, fmt)).toBe("失败 3s");
		expect(columnStatusText(column("cancelled", { elapsedMs: 12e3 }), 9e9, fmt)).toBe("已取消 12s");
		// 排队中就被取消 / 失败的那一种没有秒数可言。
		expect(columnStatusText(column("cancelled"), 9e9, fmt)).toBe("已取消");
		expect(columnStatusText(column("failed"), 9e9, fmt)).toBe("失败");
	});

	it("用时长的既有格式化（formatDuration$1 的口径），不另写一套", () => {
		const appSource = readFileSync(new URL("../../src/renderer/src/app.js", import.meta.url), "utf8");
		// `formatDuration$1` 是唯一的口径来源（`12s` / `1m2s`），对比屏注入的就是它。
		expect(appSource).toContain("columnStatusText(column, now, formatDuration$1)");
		expect(appSource).toContain("columnMetricItems(column, formatTokenCount)");
	});

	it("用量读数与对话页同一个口径（↑ billedInput = input + cacheRead + cacheWrite）", () => {
		const items = columnMetricItems(
			{ usage: { input: 1000, output: 200, cacheRead: 100, cacheWrite: 50 } },
			(count) => String(count)
		);
		expect(items).toEqual(["↑1150", "↓200"]);
	});

	it("没有用量就没有读数位（不显示 ↑0）", () => {
		expect(columnMetricItems({ usage: undefined }, String)).toEqual([]);
		expect(columnMetricItems({}, String)).toEqual([]);
		// 只有输出也算有读数（部分可用比整块丢弃有用）。
		expect(columnMetricItems({ usage: { output: 7 } }, String)).toEqual(["↓7"]);
	});
});

describe("列体形态", () => {
	const column = (status, extra = {}) => ({ columnId: "col-0", status, text: "", thinking: "", ...extra });

	it("五种状态各自可辨、互斥", () => {
		expect(columnBodyKind(column("empty"))).toBe("empty");
		expect(columnBodyKind(column("queued"))).toBe("queued");
		expect(columnBodyKind(column("running"))).toBe("waiting");
		expect(columnBodyKind(column("running", { thinking: "先想一下" }))).toBe("streaming");
		expect(columnBodyKind(column("running", { text: "半个" }))).toBe("streaming");
		expect(columnBodyKind(column("done", { text: "答" }))).toBe("done");
		expect(columnBodyKind(column("failed"))).toBe("failed");
		expect(columnBodyKind(column("cancelled", { text: "断了" }))).toBe("cancelled");
	});
});

describe("列体条目（喂给既有 buildTurnViews 的形状）", () => {
	it("只含助手条目：用户那条问题不上通道", () => {
		const entries = columnEntries({ columnId: "col-0", text: "答案", startedAt: 100 });
		expect(entries).toHaveLength(1);
		expect(entries[0].role).toBe("assistant");
		expect(entries[0].text).toBe("答案");
		expect(entries.map((entry) => entry.role)).not.toContain("user");
	});

	it("还没有正文时给空数组（空文本的助手条目会被折叠逻辑当成过程消息）", () => {
		expect(columnEntries({ columnId: "col-0", text: "" })).toEqual([]);
		expect(columnEntries({ columnId: "col-0", text: "", thinking: "在思考" })).toEqual([]);
	});
});

describe("名单与入口文案", () => {
	it("加减模型；第 5 个明确拒绝并给出原因", () => {
		expect(togglePickedModel([], A)).toEqual({ keys: [A] });
		expect(togglePickedModel([A, B], A)).toEqual({ keys: [B] });
		const full = ["p/m1", "p/m2", "p/m3", "p/m4"];
		expect(full).toHaveLength(COMPARE_MAX_MODELS);
		expect(togglePickedModel(full, "p/m5")).toEqual({ keys: full, error: COMPARE_FULL_HINT });
		// 越界时名单**原样返回**（不是静默截断、也不是塞进去）。
		expect(togglePickedModel(full, "p/m5").keys).toBe(full);
	});

	it("少于 2 个时给约束提示，够 2 个就不显示（不写常驻噪声）", () => {
		expect(compareHint([])).toBe(COMPARE_MIN_HINT);
		expect(compareHint([A])).toBe(COMPARE_MIN_HINT);
		expect(compareHint([A, B])).toBeUndefined();
	});

	it("模型钮文案：够 2 个报数，否则是「去选」", () => {
		expect(modelButtonText([])).toBe("选择对比模型");
		expect(modelButtonText([A])).toBe("选择对比模型");
		expect(modelButtonText([A, B])).toBe("对比 2 个模型");
		expect(modelButtonText([A, B, "p/m3", "p/m4"])).toBe("对比 4 个模型");
	});

	it("开始条件：名单 2–4 个且问题非空", () => {
		expect(canStartCompare([A], "问题")).toBe(false);
		expect(canStartCompare([A, B], "   ")).toBe(false);
		expect(canStartCompare([A, B], "问题")).toBe(true);
		expect(canStartCompare([A, B, "p/m3", "p/m4"], "问题")).toBe(true);
		expect(canStartCompare([A, B, "p/m3", "p/m4", "p/m5"], "问题")).toBe(false);
	});
});

describe("色槽与模型描述", () => {
	it("分类色槽 1..4，超出钳到最后一槽（它是「这一列是谁」，不是状态）", () => {
		expect(laneAccentVar(0)).toBe("var(--cat-1)");
		expect(laneAccentVar(3)).toBe("var(--cat-4)");
		expect(laneAccentVar(4)).toBe("var(--cat-4)");
		expect(laneAccentVar(-1)).toBe("var(--cat-1)");
	});

	it("模型描述：快照到了用 model.name，没到就回落到 key 后半段（确定的缺省，不是空白）", () => {
		const snapshot = {
			models: [{ providerId: "prov-a", id: "model-a", name: "Qwen3-32B" }],
			providers: [{ id: "prov-a", name: "阿里云百炼" }],
		};
		expect(describeModel(A, snapshot)).toEqual({
			key: A,
			name: "Qwen3-32B",
			modelId: "model-a",
			providerName: "阿里云百炼",
		});
		expect(describeModel(A, undefined)).toEqual({
			key: A,
			name: "model-a",
			modelId: "model-a",
			providerName: "prov-a",
		});
		// 模型 id 里带 `/` 是合法的（parseModelKey 在第一个 `/` 处切）。
		expect(describeModel("prov/x/deepseek-r1", undefined).modelId).toBe("x/deepseek-r1");
	});
});