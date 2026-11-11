/**
 * 合并冲突标记扫描（scripts/check-conflict-markers.mjs）的单测。
 *
 * 2026-11-11：第二十轮把 CHANGELOG 的冲突标记直接提交进 main，CI 全绿。
 * 这个扫描器是那道门禁的纯逻辑核心；重点是**不误伤** Markdown 里单独
 * 一行的 `=======`，只报成对块里的标记。
 */
import { describe, expect, it } from "vitest";
import { findConflictMarkers } from "../../scripts/check-conflict-markers.mjs";

describe("findConflictMarkers", () => {
	it("干净文本 → 空", () => {
		expect(findConflictMarkers("# 标题\n\n普通内容\n")).toEqual([]);
	});

	it("完整的冲突块 → 三行都命中", () => {
		const text = ["## 段", "<<<<<<< HEAD", "我们的内容", "=======", "对方内容", ">>>>>>> origin/main", "## 下一段"].join("\n");
		expect(findConflictMarkers(text).map((hit) => hit.line)).toEqual([2, 4, 6]);
	});

	it("多个冲突块分别命中", () => {
		const text = ["<<<<<<< HEAD", "a", "=======", "b", ">>>>>>> main", "中间", "<<<<<<< HEAD", "c", "=======", "d", ">>>>>>> main"].join("\n");
		expect(findConflictMarkers(text).map((hit) => hit.line)).toEqual([1, 3, 5, 7, 9, 11]);
	});

	it("块外的单独一行 ======= 不误伤（Markdown 分隔线）", () => {
		expect(findConflictMarkers("标题\n=======\n正文\n")).toEqual([]);
	});

	it("只有半截标记也要报（没等到结束标记）", () => {
		expect(findConflictMarkers("<<<<<<< HEAD\n内容\n").map((hit) => hit.line)).toEqual([1]);
	});
});
