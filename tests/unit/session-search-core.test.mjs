/**
 * 会话检索页展示逻辑的单测（`src/renderer/src/session-search-core.js`）。
 *
 * 重点是**高亮区间**：daemon 给的是「片段 + 区间」，界面直接按区间切片上色。
 * 区间错一格，用户看到的就是「红字标在无关的字上」—— 这在真实界面里很难靠肉眼发现，
 * 只能在这一层逐段断言。
 */
import { describe, expect, it } from "vitest";
import {
	buildHighlightSegments,
	describeSearchSummary,
	flattenSearchHits,
	roleLabel,
	summarizeSearch,
} from "../../src/renderer/src/session-search-core.js";

describe("roleLabel", () => {
	it("把人话与内部字段分开", () => {
		expect(roleLabel("user")).toBe("你问的");
		expect(roleLabel("assistant")).toBe("它答的");
		expect(roleLabel(undefined)).toBe("它答的");
	});
});

describe("buildHighlightSegments", () => {
	it("按区间切成普通段与高亮段", () => {
		expect(buildHighlightSegments("报价单里的单价", [{ start: 0, end: 3 }])).toEqual([
			{ text: "报价单", hit: true },
			{ text: "里的单价", hit: false },
		]);
	});

	it("没有区间时整段普通文本", () => {
		expect(buildHighlightSegments("普通文本", [])).toEqual([{ text: "普通文本", hit: false }]);
		expect(buildHighlightSegments("普通文本", undefined)).toEqual([{ text: "普通文本", hit: false }]);
	});

	it("重叠 / 相邻的区间合并成一段（不产出连续两个 mark）", () => {
		expect(buildHighlightSegments("abcde", [
			{ start: 1, end: 3 },
			{ start: 2, end: 4 },
			{ start: 3, end: 5 },
		])).toEqual([
			{ text: "a", hit: false },
			{ text: "bcde", hit: true },
		]);
	});

	it("乱序区间先排序再切", () => {
		expect(buildHighlightSegments("甲乙丙丁", [
			{ start: 2, end: 4 },
			{ start: 0, end: 1 },
		])).toEqual([
			{ text: "甲", hit: true },
			{ text: "乙", hit: false },
			{ text: "丙丁", hit: true },
		]);
	});

	it("越界 / 反向 / 零长度区间被忽略，不会切出错位的红字", () => {
		expect(buildHighlightSegments("abc", [
			{ start: 2, end: 2 },
			{ start: 3, end: 1 },
			{ start: 10, end: 20 },
			{ start: -5, end: 1 },
		])).toEqual([
			{ text: "a", hit: true },
			{ text: "bc", hit: false },
		]);
	});

	it("空片段返回空数组（调用方直接渲染空容器，不会出现 undefined）", () => {
		expect(buildHighlightSegments("", [{ start: 0, end: 1 }])).toEqual([]);
		expect(buildHighlightSegments(undefined, undefined)).toEqual([]);
	});
});

describe("flattenSearchHits", () => {
	it("摊平后保留会话上下文与稳定 key", () => {
		const rows = flattenSearchHits([
			{
				sessionId: "s1",
				title: "季度复盘",
				path: "/tmp/s1.jsonl",
				modifiedAt: 100,
				hits: [
					{ entryId: "e1", role: "user", snippet: "甲", matches: [] },
					{ entryId: "e2", role: "assistant", snippet: "乙", matches: [] },
				],
			},
			{ sessionId: "s2", title: "报价", path: "/tmp/s2.jsonl", modifiedAt: 200, hits: [{ entryId: "e9", role: "user", snippet: "丙", matches: [] }] },
		]);
		expect(rows.map((row) => row.key)).toEqual(["s1:e1", "s1:e2", "s2:e9"]);
		expect(rows[2]).toMatchObject({ sessionId: "s2", entryId: "e9", title: "报价", path: "/tmp/s2.jsonl" });
	});

	it("空输入 / 脏数据返回空数组", () => {
		expect(flattenSearchHits(undefined)).toEqual([]);
		expect(flattenSearchHits([null, { hits: null }])).toEqual([]);
	});
});

describe("summarizeSearch / describeSearchSummary", () => {
	it("命中总数按 totalHits 累加，而不是只看带回的片段条数", () => {
		const result = {
			scanned: 12,
			scannedLimit: 200,
			truncated: false,
			sessions: [
				{ sessionId: "s1", totalHits: 7, hits: [{ entryId: "e1" }] },
				{ sessionId: "s2", totalHits: 2, hits: [{ entryId: "e2" }] },
			],
		};
		expect(summarizeSearch(result)).toEqual({
			sessionCount: 2,
			hitCount: 9,
			scanned: 12,
			scannedLimit: 200,
			truncated: false,
		});
		expect(describeSearchSummary(result)).toBe("在最近 12 个会话里找到 2 个会话、9 处命中");
	});

	it("没有命中时说明扫了多少，而不是一句「无结果」", () => {
		expect(describeSearchSummary({ scanned: 0, scannedLimit: 200, sessions: [] })).toBe(
			"在最近 0 个会话里没有找到匹配"
		);
	});

	it("有更早的会话没扫到时如实说明上限", () => {
		const text = describeSearchSummary({
			scanned: 50,
			scannedLimit: 200,
			truncated: true,
			sessions: [{ sessionId: "s1", totalHits: 1, hits: [{ entryId: "e1" }] }],
		});
		expect(text).toContain("更早的会话没有扫");
		expect(text).toContain("200");
	});
});
