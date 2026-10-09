/**
 * 项目视图模型纯逻辑的单测（projects-core.js，零依赖直测）。
 *
 * ── 反向验证（已真跑并还原）──────────────────────────────────────────
 * 把 projectSessionRows 里 unresolvedPaths.push 删掉（映射不到静默跳过），
 * 「映射不到不丢弃」变红 —— 那条守的是「不静默丢东西」的仓库纪律。
 */
import { describe, expect, it } from "vitest";
import {
	INSTRUCTIONS_LIMIT,
	instructionsStatus,
	projectArtifactRows,
	projectColorVar,
	projectSessionRows,
	sortProjectCards
} from "../../src/renderer/src/projects-core.js";

const session = (path, modifiedAt) => ({ path, modifiedAt, title: path });
const byPath = (list) => new Map(list.map((s) => [s.path, s]));

describe("projectColorVar", () => {
	it("0..5 映射到 --cat-1..6；越界按同余归位（脏数据防御）", () => {
		expect(projectColorVar(0)).toBe("var(--cat-1)");
		expect(projectColorVar(5)).toBe("var(--cat-6)");
		expect(projectColorVar(6)).toBe("var(--cat-1)");
		expect(projectColorVar(-1)).toBe("var(--cat-6)");
	});
});

describe("卡片模型与排序", () => {
	it("最近活动 = 项目内会话 modifiedAt 最大值；无会话回落 createdAt", () => {
		const sessions = byPath([session("/a.jsonl", 100), session("/b.jsonl", 300), session("/c.jsonl", 200)]);
		const model = sortProjectCards(
			[
				{ id: "p1", name: "A", createdAt: 10, sessionPaths: ["/a.jsonl", "/b.jsonl"], instructions: "x" },
				{ id: "p2", name: "空项目", createdAt: 50, sessionPaths: [] }
			],
			sessions
		)[0];
		expect(model.id).toBe("p1");
		expect(model.lastActivity).toBe(300);
		expect(model.resolvedSessionCount).toBe(2);
		const empty = sortProjectCards([{ id: "p2", name: "空", createdAt: 50, sessionPaths: [], instructions: "" }], sessions)[0];
		expect(empty.lastActivity).toBe(50);
		expect(empty.hasInstructions).toBe(false);
	});

	it("排序：最近活动降序；并列按创建时间降序", () => {
		const sessions = byPath([session("/s1.jsonl", 100)]);
		const sorted = sortProjectCards(
			[
				{ id: "old-active", createdAt: 1, sessionPaths: ["/s1.jsonl"], instructions: "" },
				{ id: "fresh-empty", createdAt: 999, sessionPaths: [], instructions: "" },
				{ id: "older-empty", createdAt: 500, sessionPaths: [], instructions: "" }
			],
			sessions
		);
		// fresh-empty(999) > older-empty(500) > old-active(100)
		expect(sorted.map((p) => p.id)).toEqual(["fresh-empty", "older-empty", "old-active"]);
	});

	it("引用已归档/丢失会话计入 unresolvedCount（不静默消失）", () => {
		const model = sortProjectCards(
			[{ id: "p", createdAt: 1, sessionPaths: ["/有.jsonl", "/丢了.jsonl"], instructions: "" }],
			byPath([session("/有.jsonl", 100)])
		)[0];
		expect(model.resolvedSessionCount).toBe(1);
		expect(model.unresolvedCount).toBe(1);
	});
});

describe("详情会话行", () => {
	it("按 modifiedAt 降序；映射不到的汇成 unresolvedPaths 不丢弃", () => {
		const { rows, unresolvedPaths } = projectSessionRows(
			{ sessionPaths: ["/a.jsonl", "/ghost.jsonl", "/b.jsonl"] },
			byPath([session("/a.jsonl", 100), session("/b.jsonl", 300)])
		);
		expect(rows.map((r) => r.path)).toEqual(["/b.jsonl", "/a.jsonl"]);
		expect(unresolvedPaths).toEqual(["/ghost.jsonl"]);
	});
});

describe("产物过滤", () => {
	it("任一来源会话在项目里即命中；来源字段缺失按不命中", () => {
		const entries = [
			{ path: "/x.md", sessions: [{ path: "/a.jsonl" }] },
			{ path: "/y.md", sessions: [{ path: "/a.jsonl" }, { path: "/z.jsonl" }] },
			{ path: "/w.md", sessions: [{ path: "/z.jsonl" }] },
			{ path: "/bad.md" }
		];
		const rows = projectArtifactRows(entries, { sessionPaths: ["/a.jsonl"] });
		expect(rows.map((r) => r.path)).toEqual(["/x.md", "/y.md"]);
	});
});

describe("指令字数", () => {
	it("恰在上限不超限；超一字判 over", () => {
		expect(instructionsStatus("字".repeat(INSTRUCTIONS_LIMIT)).over).toBe(false);
		expect(instructionsStatus("字".repeat(INSTRUCTIONS_LIMIT + 1)).over).toBe(true);
		expect(instructionsStatus("字".repeat(INSTRUCTIONS_LIMIT + 1)).remaining).toBe(-1);
		expect(instructionsStatus("").count).toBe(0);
	});
});
