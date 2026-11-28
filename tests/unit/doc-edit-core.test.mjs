/**
 * 修订工作台纯逻辑的单测（doc-edit-core.js，零 DOM 直测）。
 *
 * 这一页真正容易错的不是布局，而是「分组与排序对不对」「接受时到底选了哪几段」
 * 「过期时说哪一句话」—— 它们在界面上只表现为一个数字或一句文案，e2e 说不清。
 *
 * ── 反向验证（已真跑并还原，2026-11-23）──────────────────────────────
 * 1) 把 summarizeSelection 的 canAccept 改成只判 count > 0 → 「过期建议不可接受」
 *    那条变红，其余不受影响。
 * 2) 把 groupProposalsByPath 的组内排序改成 createdAt 升序 → 「组内最新在前」变红。
 */
import { describe, expect, it } from "vitest";
import {
	DOC_EDIT_DONE_TITLE,
	DOC_EDIT_EMPTY_DESC,
	DOC_EDIT_STALE_TEXT,
	acceptDocxSuccessText,
	splitDocxContext,
	acceptSuccessText,
	formatHunkStats,
	formatProposalStats,
	groupProposalsByPath,
	hunkApplyLabel,
	hunkRangeText,
	isDocxProposal,
	mergeSelectAll,
	proposalDirOf,
	proposalModeLabel,
	proposalNameOf,
	proposalPendingAnnouncement,
	proposalSourceText,
	defaultSelectedHunks,
	rejectConfirmText,
	rejectSuccessText,
	summarizeSelection,
} from "../../src/renderer/src/doc-edit-core.js";

const HUNKS = [
	{ id: "h1", oldStart: 1, newStart: 1, added: 1, removed: 1, lines: [{ type: "-", text: "旧" }, { type: "+", text: "新" }] },
	{ id: "h2", oldStart: 12, newStart: 12, added: 2, removed: 0, lines: [{ type: "+", text: "a" }, { type: "+", text: "b" }] },
];

describe("按文件分组", () => {
	it("同一路径合成一组，组内最新的在前", () => {
		const groups = groupProposalsByPath([
			{ id: "a1", path: "/ws/周报.md", name: "周报.md", createdAt: 100 },
			{ id: "a2", path: "/ws/周报.md", name: "周报.md", createdAt: 300 },
			{ id: "b1", path: "/ws/纪要.md", name: "纪要.md", createdAt: 200 },
		]);
		expect(groups).toHaveLength(2);
		expect(groups[0].path).toBe("/ws/周报.md");
		expect(groups[0].entries.map((entry) => entry.id)).toEqual(["a2", "a1"]);
		expect(groups[1].entries.map((entry) => entry.id)).toEqual(["b1"]);
	});

	it("组间按各自最新一条倒序；并列时按路径稳定排序", () => {
		const groups = groupProposalsByPath([
			{ id: "b", path: "/ws/z.md", name: "z.md", createdAt: 10 },
			{ id: "a", path: "/ws/a.md", name: "a.md", createdAt: 10 },
			{ id: "c", path: "/ws/m.md", name: "m.md", createdAt: 20 },
		]);
		expect(groups.map((group) => group.name)).toEqual(["m.md", "a.md", "z.md"]);
	});

	it("坏数据不抛：null / 非对象跳过，缺 path 归到空路径组", () => {
		const groups = groupProposalsByPath([
			null,
			42,
			{ id: "x", path: "/ws/x.md", createdAt: 1 },
			{ id: "y", createdAt: 2 },
		]);
		expect(groups).toHaveLength(2);
		const unknown = groups.find((group) => group.path === "");
		expect(unknown).toBeDefined();
		expect(unknown.name).toBe("未知文件");
		// 缺 name 时从 path 取末段，不显示整条绝对路径。
		const named = groups.find((group) => group.path === "/ws/x.md");
		expect(named.name).toBe("x.md");
		expect(named.dir).toBe("/ws");
	});

	it("空列表 / 非数组返回空数组", () => {
		expect(groupProposalsByPath([])).toEqual([]);
		expect(groupProposalsByPath(undefined)).toEqual([]);
		expect(groupProposalsByPath("nope")).toEqual([]);
	});
});

describe("默认全选与全选切换", () => {
	it("默认选中所有合法 hunk id，重复与坏值跳过", () => {
		expect(defaultSelectedHunks({ hunks: HUNKS })).toEqual(["h1", "h2"]);
		expect(defaultSelectedHunks({ hunks: [{ id: "h1" }, { id: "" }, {}, { id: "h1" }] })).toEqual(["h1"]);
		expect(defaultSelectedHunks(undefined)).toEqual([]);
	});

	it("全选返回全部（去重），全不选返回空数组", () => {
		expect(mergeSelectAll([], ["h1", "h2", "h1"], true)).toEqual(["h1", "h2"]);
		expect(mergeSelectAll(["h1"], ["h1", "h2"], false)).toEqual([]);
		expect(mergeSelectAll(["h1"], undefined, true)).toEqual([]);
	});
});

describe("选中汇总", () => {
	it("只统计被选中的段，增删行数按段累加", () => {
		expect(summarizeSelection({ hunks: HUNKS }, ["h1"])).toEqual({
			count: 1,
			added: 1,
			removed: 1,
			canAccept: true,
		});
		expect(summarizeSelection({ hunks: HUNKS }, ["h1", "h2"])).toEqual({
			count: 2,
			added: 3,
			removed: 1,
			canAccept: true,
		});
	});

	it("一段都没选不能接受", () => {
		const summary = summarizeSelection({ hunks: HUNKS }, []);
		expect(summary.count).toBe(0);
		expect(summary.canAccept).toBe(false);
	});

	it("过期建议即使选了段也不能接受（按钮禁用的唯一判据）", () => {
		expect(summarizeSelection({ hunks: HUNKS, stale: true }, ["h1"]).canAccept).toBe(false);
	});

	it("hunk 缺 added/removed 时退回数 lines，不凭空记 0", () => {
		const summary = summarizeSelection({ hunks: [{ id: "h1", lines: [{ type: "+", text: "a" }, { type: "-", text: "b" }] }] }, ["h1"]);
		expect(summary.added).toBe(1);
		expect(summary.removed).toBe(1);
	});
});

describe("段的显示文案", () => {
	it("勾选框可访问名按 PRD 口径", () => {
		expect(hunkApplyLabel(HUNKS[0], 0)).toBe("应用第 1 段：+1 / -1 行");
		expect(hunkApplyLabel(HUNKS[1], 1)).toBe("应用第 2 段：+2 / -0 行");
	});

	it("区间复用并排对照页的同一句话", () => {
		expect(hunkRangeText({ oldStart: 1, newStart: 1 }, { total: 1 })).toBe("");
		expect(hunkRangeText({ oldStart: 12, newStart: 12 }, { total: 1 })).toBe("第 12 行起");
		expect(hunkRangeText({ oldStart: 8, newStart: 9 }, { total: 2 })).toBe("改前第 8 行起 / 现在第 9 行起");
		expect(hunkRangeText({})).toBe("");
	});

	it("段统计与列表统计都不会摆不存在的数字", () => {
		expect(formatHunkStats(HUNKS[1])).toBe("+2 −0 行");
		expect(formatProposalStats({ added: 3, removed: 1 })).toBe("+3 −1");
		expect(formatProposalStats({})).toBe("行数未记录");
	});

	it("docx 建议没有「段」：列表统计报「1 处替换」", () => {
		expect(isDocxProposal({ kind: "docx" })).toBe(true);
		expect(isDocxProposal({ kind: "text" })).toBe(false);
		expect(isDocxProposal(undefined)).toBe(false);
		// 列表项即使带着 summarize 给的 hunkCount / added / removed，也不该显示成 +1 −1。
		expect(formatProposalStats({ kind: "docx", hunkCount: 1, added: 1, removed: 1 })).toBe("1 处替换");
		// 文本建议不受影响（kind 缺省是 #481 之前的记录，按文本处理）。
		expect(formatProposalStats({ kind: "text", added: 3, removed: 1 })).toBe("+3 −1");
		expect(formatProposalStats({ added: 0, removed: 0 })).toBe("+0 −0");
	});

	it("路径的末段与父目录跨平台都对", () => {
		expect(proposalNameOf("/ws/a/周报.md")).toBe("周报.md");
		expect(proposalNameOf("C:\\ws\\周报.md")).toBe("周报.md");
		expect(proposalDirOf("/ws/a/周报.md")).toBe("/ws/a");
		expect(proposalDirOf("C:\\ws\\周报.md")).toBe("C:\\ws");
		expect(proposalDirOf("周报.md")).toBe("");
	});
});

describe("文案（同一件事同一句话）", () => {
	it("空态说清「开启修订模式后写入先到这里」", () => {
		expect(DOC_EDIT_EMPTY_DESC).toContain("开启修订模式后");
		expect(DOC_EDIT_EMPTY_DESC).toContain("不会被修改");
		expect(DOC_EDIT_DONE_TITLE).toContain("都处理完了");
	});

	it("过期提示必须原样给出「原文已变化」与重新生成指引", () => {
		expect(DOC_EDIT_STALE_TEXT).toContain("原文已变化");
		expect(DOC_EDIT_STALE_TEXT).toContain("重新生成");
	});

	it("模式按钮与读屏播报只报数量", () => {
		expect(proposalModeLabel(2)).toBe("待修订 2");
		expect(proposalModeLabel(undefined)).toBe("待修订 0");
		expect(proposalPendingAnnouncement(3)).toBe("有 3 条待修订建议");
	});

	it("来源会话解析不到时如实说，不显示裸 id", () => {
		expect(proposalSourceText({ toolName: "edit" }, undefined)).toBe(
			"编辑 · 来源会话不在列表中（可能已归档或删除）"
		);
		expect(proposalSourceText({ toolName: "edit" }, undefined, { sessionsLoaded: false })).toBe(
			"编辑 · 来源会话读取中…"
		);
		expect(proposalSourceText({ toolName: "edit" }, "周报整理")).toBe("编辑 · 周报整理");
		expect(proposalSourceText({ toolName: "write" }, "整理周报")).toBe("写入 · 整理周报");
	});

	it("接受 / 拒绝的结果把段数、行数与「文件未改动」说清", () => {
		expect(acceptSuccessText("周报.md", 1, 2, 3, 1)).toBe("已应用「周报.md」的 1 / 2 段（+3 −1 行）；其余 1 段已丢弃");
		expect(acceptSuccessText("周报.md", 2, 2, 3, 1)).toBe("已应用「周报.md」的 2 / 2 段（+3 −1 行）");
		expect(rejectSuccessText("周报.md")).toContain("目标文件没有被改动");
		expect(rejectConfirmText("周报.md")).toContain("拒绝");
		expect(rejectConfirmText("周报.md")).toContain("周报.md");
	});

	it("docx 上下文切成前文 / 命中 / 后文；非法字段返回 undefined", () => {
		expect(splitDocxContext({ paragraph: 2, heading: "季度报告", text: "…前文旧文字后文…", offset: 3, length: 3 })).toEqual({
			before: "…前文",
			match: "旧文字",
			after: "后文…",
		});
		expect(splitDocxContext(undefined)).toBeUndefined();
		expect(splitDocxContext({ text: "abc", offset: 2, length: 2 })).toBeUndefined();
		expect(splitDocxContext({ text: "abc", offset: -1, length: 1 })).toBeUndefined();
		expect(splitDocxContext({ text: "abc", offset: 0, length: 0 })).toBeUndefined();
	});

	it("docx 接受结果只报「1 处文字」，不套段 / 行口径", () => {
		expect(acceptDocxSuccessText("季度报告.docx")).toBe("已替换「季度报告.docx」正文中的 1 处文字");
		expect(acceptDocxSuccessText("")).toBe("已替换「这份文档」正文中的 1 处文字");
		expect(acceptDocxSuccessText("季度报告.docx")).not.toContain("段");
	});
});
