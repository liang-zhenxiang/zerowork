/**
 * 变更审阅台视图纯逻辑的单测（review-core.js，零依赖直测）。
 *
 * 界面本身只有 e2e 能覆盖（渲染层是 chunk 粒度），但「并排 diff 怎么配对」
 * 「筛选与计数」「那些不许静默的边界措辞」全是纯函数 —— 放进单测之后，
 * e2e 只需要验「IPC 通了、DOM 挂上了、标记与还原真的落盘了」。
 *
 * ── 反向验证（已真跑并还原）──────────────────────────────────────────
 * 1) 把 parseSideBySideDiff 的删/增配对顺序改成「先读完所有删行、再读所有增行」
 *    → 「改一行时左右在同一行」那条变红，其余不受影响。
 * 2) 把 filterReviewEntries 的 pending 分支恒返回全部 → 「待审阅筛选」变红。
 */
import { describe, expect, it } from "vitest";
import {
	REVIEW_EMPTY_DESC,
	filterReviewEntries,
	formatChangeStats,
	formatHunkHeader,
	formatReviewCounts,
	parseSideBySideDiff,
	reviewBadgeText,
	reviewReasonRetryable,
	reviewReasonText,
	reviewSkippedNote,
	reviewStateLabel,
	reviewTruncatedDiffNote,
	reviewSourceText,
	visibleReviewEntries,
} from "../../src/renderer/src/review-core.js";

describe("计数 / 状态 / 角标", () => {
	it("顶部计数按「待审阅 · 已审阅」的固定口径", () => {
		expect(formatReviewCounts(3, 2)).toBe("待审阅 3 · 已审阅 2");
		expect(formatReviewCounts(undefined, undefined)).toBe("待审阅 0 · 已审阅 0");
	});

	it("状态是文字而不是只有颜色", () => {
		expect(reviewStateLabel(false)).toBe("待审阅");
		expect(reviewStateLabel(true)).toBe("已审阅");
	});

	it("角标 0 时不渲染、超过 99 显示 99+", () => {
		expect(reviewBadgeText(0)).toBe("");
		expect(reviewBadgeText(-1)).toBe("");
		expect(reviewBadgeText(1)).toBe("1");
		expect(reviewBadgeText(99)).toBe("99");
		expect(reviewBadgeText(100)).toBe("99+");
	});
});

describe("+N −M 与筛选", () => {
	it("有记录的增删行数照原样显示", () => {
		expect(formatChangeStats({ added: 12, removed: 3 })).toBe("+12 −3");
		expect(formatChangeStats({ added: 0, removed: 0 })).toBe("+0 −0");
	});

	it("还原快照没有行数时如实说，不摆一个不存在的 +0 −0", () => {
		expect(formatChangeStats({})).toBe("行数未记录");
		expect(formatChangeStats({ added: 3 })).toBe("行数未记录");
	});

	it("全部筛选原样返回、待审阅只留未审阅的，且不改入参", () => {
		const entries = [
			{ key: "a", reviewed: false },
			{ key: "b", reviewed: true },
			{ key: "c", reviewed: false }
		];
		const all = filterReviewEntries(entries, "all");
		expect(all.map((e) => e.key)).toEqual(["a", "b", "c"]);
		expect(all).not.toBe(entries);
		expect(filterReviewEntries(entries, "pending").map((e) => e.key)).toEqual(["a", "c"]);
		expect(entries).toHaveLength(3);
	});

	it("只看待审阅时，刚标记的那一条先保留在列表里（不会立刻跳走）", () => {
		const entries = [
			{ key: "a", reviewed: true },
			{ key: "b", reviewed: false }
		];
		expect(visibleReviewEntries(entries, "pending", "a").map((e) => e.key)).toEqual(["a", "b"]);
		// 保留的是「不在筛选结果里」的那一条；已经在结果里就不重复。
		expect(visibleReviewEntries(entries, "pending", "b").map((e) => e.key)).toEqual(["b"]);
		// 切到全部 / 保留项已不在清单里 → 不再多塞一条。
		expect(visibleReviewEntries(entries, "all", "a").map((e) => e.key)).toEqual(["a", "b"]);
		expect(visibleReviewEntries(entries, "pending", "gone").map((e) => e.key)).toEqual(["b"]);
	});
});

describe("并排 diff 的行配对", () => {
	it("改一行时左右在同一行（不是先读完删行再读增行）", () => {
		const rows = parseSideBySideDiff(["@@ -1,2 +1,2 @@", "-旧的一行", "+新的一行", " 不变的"].join("\n"));
		expect(rows[0]).toEqual({ kind: "hunk", header: "@@ -1,2 +1,2 @@" });
		expect(rows[1]).toEqual({
			kind: "row",
			left: { text: "旧的一行", kind: "del" },
			right: { text: "新的一行", kind: "add" }
		});
		expect(rows[2]).toEqual({
			kind: "row",
			left: { text: "不变的", kind: "same" },
			right: { text: "不变的", kind: "same" }
		});
	});

	it("删多增少时右侧补空单元格，反之亦然", () => {
		const rows = parseSideBySideDiff(["-a", "-b", "+a2"].join("\n"));
		expect(rows).toHaveLength(2);
		expect(rows[0].right).toEqual({ text: "a2", kind: "add" });
		expect(rows[1].right).toEqual({ text: "", kind: "empty" });
		expect(rows[1].left).toEqual({ text: "b", kind: "del" });

		const more = parseSideBySideDiff(["-a", "+a2", "+b2"].join("\n"));
		expect(more[1].left).toEqual({ text: "", kind: "empty" });
		expect(more[1].right).toEqual({ text: "b2", kind: "add" });
	});

	it("空 diff（两版逐行相同或触顶）返回空数组，不伪造一行空白", () => {
		expect(parseSideBySideDiff("")).toEqual([]);
		expect(parseSideBySideDiff(undefined)).toEqual([]);
	});

	it("内容本身以空格开头时不会被当成上下文前缀丢掉", () => {
		const rows = parseSideBySideDiff(" 缩进的上下文");
		expect(rows[0].left.text).toBe("缩进的上下文");
	});
});

describe("边界措辞（一律不许静默）", () => {
	it("读取失败的每一条都有用户话术，未知原因兜底带原始信息", () => {
		expect(reviewReasonText("binary")).toContain("二进制");
		expect(reviewReasonText("too-large")).toContain("256 KiB");
		expect(reviewReasonText("no-after")).toContain("删除或移走");
		expect(reviewReasonText("symlink")).toContain("符号链接");
		expect(reviewReasonText("stale")).toContain("刷新");
		expect(reviewReasonText("weird", "底层摘要")).toBe("底层摘要");
		expect(reviewReasonText("weird")).toBe("读取失败。");
	});

	it("只有状态侧的原因给刷新，文件当前的事实不给", () => {
		expect(reviewReasonRetryable("stale")).toBe(true);
		expect(reviewReasonRetryable("missing")).toBe(true);
		expect(reviewReasonRetryable("binary")).toBe(false);
		expect(reviewReasonRetryable("too-large")).toBe(false);
		expect(reviewReasonRetryable("no-after")).toBe(false);
	});

	it("truncated 明说「不逐行对照」，不把空 diff 当成没有改动", () => {
		expect(reviewTruncatedDiffNote(40, 2)).toContain("+40 −2");
		expect(reviewTruncatedDiffNote(40, 2)).toContain("不逐行对照");
	});

	it("被跳过的改动有计数说明，0 时不出声", () => {
		expect(reviewSkippedNote(0)).toBe("");
		expect(reviewSkippedNote(2)).toContain("2 次改动没有留下版本");
	});

	it("来源会话解析不到时如实说，不显示裸 id", () => {
		expect(reviewSourceText({ tool: "write" }, undefined)).toBe("写入 · 来源会话已不在");
		expect(reviewSourceText({ tool: "edit" }, "周报整理")).toBe("编辑 · 周报整理");
		// 未知工具原样返回（不吞信息），空工具只有会话标题。
		expect(reviewSourceText({ tool: "custom" }, "周报整理")).toBe("custom · 周报整理");
		expect(reviewSourceText({}, "周报整理")).toBe("周报整理");
	});
});

describe("空态文案与 hunk 头（事实 / 去黑话）", () => {
	it("空态说的是「一文件一条」，不是「每次改动一条」", () => {
		expect(REVIEW_EMPTY_DESC).toContain("每个文件最近一次改动");
		expect(REVIEW_EMPTY_DESC).toContain("更早的改动会被新的覆盖");
		expect(REVIEW_EMPTY_DESC).not.toContain("每次改动都会");
	});

	it("唯一的 hunk 且从第 1 行开始 → 整行不渲染", () => {
		expect(formatHunkHeader("@@ -1,6 +1,6 @@", { total: 1 })).toBe("");
	});

	it("多段 diff 或不是从头开始时给「第 N 行起」", () => {
		expect(formatHunkHeader("@@ -12,4 +12,5 @@", { total: 1 })).toBe("第 12 行起");
		expect(formatHunkHeader("@@ -1,6 +1,6 @@", { total: 2 })).toBe("第 1 行起");
		expect(formatHunkHeader("@@ -8,3 +9,3 @@", { total: 2 })).toBe("改前第 8 行起 / 现在第 9 行起");
	});

	it("不是 hunk 头的字符串不出话术", () => {
		expect(formatHunkHeader("")).toBe("");
		expect(formatHunkHeader("+新增行")).toBe("");
		expect(formatHunkHeader(undefined)).toBe("");
	});
});
