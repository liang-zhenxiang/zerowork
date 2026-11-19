/**
 * 资料库画廊纯逻辑（src/renderer/src/library-gallery-core.js）的单元测试。
 *
 * 守的是「界面上只表现为一张卡的类型不对 / 筛出来少一条 / 继续修改灰着」的那几块：
 *   1. 类型判定：扩展名大小写、无扩展名、URL 优先；
 *   2. 封面几何：同一文件永远同一张、不同文件不同、取值落在登记范围内；
 *   3. 筛选四条件：类型 × 来源 × 时间 × 文件名是**与**关系，时间边界可复现；
 *   4. 路径归属：Windows 分隔符 / 大小写 / 末尾斜杠 / 兄弟目录；
 *   5. 继续修改提示与文件历史 key 匹配。
 *
 * 时间相关的用例一律传固定 `now`，不依赖运行机器的当前时刻。
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	ARTIFACT_TYPES,
	TIME_RANGES,
	artifactBadge,
	artifactCover,
	artifactCoverShape,
	artifactCoverVariant,
	artifactType,
	continuePrompt,
	displayPathFor,
	filterArtifacts,
	pathWithinCwd,
	relativePathWithin,
	sourceCwdFor,
	typeAccent,
	typeLabel,
	versionKeyFor,
} from "../../src/renderer/src/library-gallery-core.js";

const NOW = Date.parse("2026-11-19T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function session(overrides = {}) {
	return {
		id: "s1",
		path: "/sessions/a.jsonl",
		title: "季度复盘",
		cwd: "/workspace/ws",
		modifiedAt: 0,
		...overrides,
	};
}

function artifact(overrides = {}) {
	return {
		path: "/workspace/ws/季度复盘.md",
		name: "季度复盘.md",
		kind: "local",
		size: 42,
		html: false,
		deliveredAt: "2026-11-18T10:00:00.000Z",
		exists: true,
		sessions: [session()],
		...overrides,
	};
}

describe("artifactType：类型由扩展名 / kind 判定", () => {
	it("按扩展名判定常见类型", () => {
		assert.equal(artifactType(artifact({ path: "/w/report.md" })), "markdown");
		assert.equal(artifactType(artifact({ path: "/w/report.docx" })), "doc");
		assert.equal(artifactType(artifact({ path: "/w/data.xlsx" })), "sheet");
		assert.equal(artifactType(artifact({ path: "/w/deck.pptx" })), "slide");
		assert.equal(artifactType(artifact({ path: "/w/paper.pdf" })), "pdf");
		assert.equal(artifactType(artifact({ path: "/w/photo.jpeg" })), "image");
		assert.equal(artifactType(artifact({ path: "/w/index.html" })), "html");
		assert.equal(artifactType(artifact({ path: "/w/app.tsx" })), "code");
	});

	it("扩展名大小写不敏感", () => {
		assert.equal(artifactType(artifact({ path: "/w/REPORT.MD" })), "markdown");
		assert.equal(artifactType(artifact({ path: "/w/DATA.XLSX" })), "sheet");
		assert.equal(artifactType(artifact({ path: "/w/APP.JS" })), "code");
	});

	it("查询串 / 片段不影响扩展名", () => {
		assert.equal(artifactType(artifact({ path: "/w/report.pdf?download=1" })), "pdf");
		assert.equal(artifactType(artifact({ path: "/w/page.html#top" })), "html");
	});

	it("URL 一律是 url（哪怕路径以 .html 结尾）", () => {
		assert.equal(artifactType(artifact({ kind: "url", path: "https://example.com/a.html" })), "url");
		// 老数据没有 kind 时按 scheme 兜底。
		assert.equal(artifactType(artifact({ kind: undefined, path: "https://example.com/a.md" })), "url");
	});

	it("无扩展名 / 隐藏文件 / 未知扩展名落到 other", () => {
		assert.equal(artifactType(artifact({ path: "/w/README" })), "other");
		assert.equal(artifactType(artifact({ path: "/w/.gitignore" })), "other");
		assert.equal(artifactType(artifact({ path: "/w/archive.xyz" })), "other");
		assert.equal(artifactType({}), "other");
	});

	it("typeLabel 覆盖全部登记档位，未知 id 回「其他」", () => {
		for (const type of ARTIFACT_TYPES) assert.equal(typeLabel(type.id), type.label);
		assert.equal(typeLabel("nope"), "其他");
	});
});

describe("封面几何：确定性、可复现、范围已登记", () => {
	it("同一文件两次给出同一张封面", () => {
		const one = artifactCover(artifact());
		const two = artifactCover(artifact());
		assert.deepEqual(one, two);
	});

	it("不同文件不会得到完全相同的几何", () => {
		const a = artifactCover(artifact({ path: "/w/a.md" }));
		const b = artifactCover(artifact({ path: "/w/b.md" }));
		assert.notDeepEqual(a, b);
	});

	it("线宽 / 柱高 / 色条都在 case-cover 登记的范围内", () => {
		const cover = artifactCover(artifact());
		assert.equal(cover.lines.length, 3);
		assert.equal(cover.bars.length, 3);
		const within = (value, min, max) => value >= min && value <= max;
		assert.ok(within(cover.lines[0], 52, 78));
		assert.ok(within(cover.lines[1], 68, 96));
		assert.ok(within(cover.lines[2], 38, 66));
		assert.ok(within(cover.bars[0], 34, 58));
		assert.ok(within(cover.bars[1], 50, 76));
		assert.ok(within(cover.bars[2], 62, 96));
		assert.ok(within(cover.barWidth, 26, 58));
	});
});

describe("封面画法与类型色：不新增颜色档", () => {
	it("类型只映射到四种既有画法", () => {
		assert.equal(artifactCoverVariant("sheet"), "chart");
		assert.equal(artifactCoverVariant("slide"), "slide");
		assert.equal(artifactCoverVariant("image"), "slide");
		assert.equal(artifactCoverVariant("markdown"), "note");
		assert.equal(artifactCoverVariant("doc"), "doc");
		assert.equal(artifactCoverVariant("pdf"), "doc");
		assert.equal(artifactCoverVariant("url"), "doc");
	});

	it("纸片形状按类型分家：文档类竖版、演示 / 图片横版、表格柱状", () => {
		for (const type of ["doc", "pdf", "markdown", "html", "code"]) {
			assert.equal(artifactCoverShape(type), "portrait", `${type} 应为竖版`);
		}
		assert.equal(artifactCoverShape("slide"), "landscape");
		assert.equal(artifactCoverShape("image"), "landscape");
		assert.equal(artifactCoverShape("sheet"), "bars");
		assert.equal(artifactCoverShape("other"), "portrait");
	});

	it("扩展名角标：大写扩展名 / 无扩展名「文件」/ URL「链接」", () => {
		assert.equal(artifactBadge(artifact({ path: "/w/report.md" })), "MD");
		assert.equal(artifactBadge(artifact({ path: "/w/deck.PPTX" })), "PPTX");
		assert.equal(artifactBadge(artifact({ path: "/w/README" })), "文件");
		assert.equal(artifactBadge(artifact({ path: "/w/.gitignore" })), "文件");
		assert.equal(artifactBadge(artifact({ kind: "url", path: "https://example.com/a.pdf" })), "链接");
	});

	it("类型色只取 --cat-1..6，中性类型不借分类色", () => {
		const used = new Set();
		for (const type of ARTIFACT_TYPES) {
			const accent = typeAccent(type.id);
			if (accent === undefined) continue;
			assert.match(accent, /^var\(--cat-[1-6]\)$/);
			used.add(accent);
		}
		assert.ok(used.size >= 6, `六槽分类色应全部被用到，实际 ${used.size} 个`);
		assert.equal(typeAccent("other"), undefined);
		assert.equal(typeAccent("all"), undefined);
	});
});

describe("filterArtifacts：四条件是「与」关系", () => {
	const md = artifact({
		path: "/ws/季度复盘.md",
		name: "季度复盘.md",
		deliveredAt: new Date(NOW - DAY).toISOString(),
	});
	const sheet = artifact({
		path: "/ws/销售数据.csv",
		name: "销售数据.csv",
		deliveredAt: new Date(NOW - 10 * DAY).toISOString(),
		sessions: [session({ path: "/sessions/b.jsonl", title: "做销售表" })],
	});
	const deck = artifact({
		path: "/ws/方案.pptx",
		name: "方案.pptx",
		deliveredAt: new Date(NOW - 40 * DAY).toISOString(),
	});
	const list = [md, sheet, deck];

	it("类型筛选", () => {
		assert.deepEqual(filterArtifacts(list, { type: "markdown", now: NOW }), [md]);
		assert.deepEqual(filterArtifacts(list, { type: "sheet", now: NOW }), [sheet]);
		assert.deepEqual(filterArtifacts(list, { type: "all", now: NOW }), list);
	});

	it("来源会话筛选按 session.path 匹配任意一条来源", () => {
		assert.deepEqual(filterArtifacts(list, { sessionId: "/sessions/b.jsonl", now: NOW }), [sheet]);
		assert.deepEqual(filterArtifacts(list, { sessionId: "/sessions/a.jsonl", now: NOW }), [md, deck]);
		assert.deepEqual(filterArtifacts(list, { sessionId: "all", now: NOW }), list);
	});

	it("时间范围边界：恰好 N 天在范围内，多 1ms 就被排除", () => {
		const exactly = artifact({ deliveredAt: new Date(NOW - 7 * DAY).toISOString() });
		const older = artifact({ deliveredAt: new Date(NOW - 7 * DAY - 1).toISOString() });
		assert.deepEqual(filterArtifacts([exactly], { days: 7, now: NOW }), [exactly]);
		assert.deepEqual(filterArtifacts([older], { days: 7, now: NOW }), []);
		assert.deepEqual(filterArtifacts([older], { days: 0, now: NOW }), [older]);
	});

	it("按时间筛选时无法解析的 deliveredAt 不出现；不按时间筛时照常出现", () => {
		const broken = artifact({ deliveredAt: "not-a-date" });
		assert.deepEqual(filterArtifacts([broken], { days: 7, now: NOW }), []);
		assert.deepEqual(filterArtifacts([broken], { days: 0, now: NOW }), [broken]);
	});

	it("关键词只匹配文件名（大小写不敏感），不匹配路径里的目录名", () => {
		const nested = artifact({ path: "/ws/季度复盘/notes.txt", name: "notes.txt" });
		assert.deepEqual(filterArtifacts([md], { keyword: "复盘", now: NOW }), [md]);
		assert.deepEqual(filterArtifacts([md], { keyword: " 复盘 ", now: NOW }), [md]);
		assert.deepEqual(filterArtifacts([nested], { keyword: "复盘", now: NOW }), []);
		assert.deepEqual(filterArtifacts([md], { keyword: "QUARTER", now: NOW }), []);
	});

	it("四个条件叠加后同时成立才留下", () => {
		const options = { type: "markdown", sessionId: "/sessions/a.jsonl", days: 7, keyword: "复盘", now: NOW };
		assert.deepEqual(filterArtifacts(list, options), [md]);
		assert.deepEqual(
			filterArtifacts(list, { ...options, sessionId: "/sessions/b.jsonl" }),
			[],
			"来源会话换了，与其它条件不成立时应为空",
		);
	});

	it("非数组输入返回空数组（不抛）", () => {
		assert.deepEqual(filterArtifacts(undefined, {}), []);
		assert.deepEqual(filterArtifacts(null, {}), []);
	});
});

describe("pathWithinCwd：分隔符、大小写、末尾斜杠与兄弟目录", () => {
	it("同一个目录算在内", () => {
		assert.equal(pathWithinCwd("/ws", "/ws"), true);
		assert.equal(pathWithinCwd("/ws/", "/ws"), true);
	});

	it("子路径算在内（含 Windows 分隔符与大小写差异）", () => {
		assert.equal(pathWithinCwd("C:\\Work\\WS", "c:\\work\\ws\\a.md"), true);
		assert.equal(pathWithinCwd("/ws", "/ws/sub/a.md"), true);
		assert.equal(pathWithinCwd("/ws/", "/ws/sub/a.md"), true);
	});

	it("兄弟目录与父目录不算在内", () => {
		assert.equal(pathWithinCwd("/ws", "/ws2/a.md"), false);
		assert.equal(pathWithinCwd("/ws", "/workspace/a.md"), false);
		assert.equal(pathWithinCwd("/ws/sub", "/ws/a.md"), false);
	});

	it("空值与根目录", () => {
		assert.equal(pathWithinCwd("", "/ws/a.md"), false);
		assert.equal(pathWithinCwd("/ws", ""), false);
		assert.equal(pathWithinCwd("/", "/ws/a.md"), true);
	});
});

describe("sourceCwdFor：只认来源会话的 cwd", () => {
	it("返回第一个包含该路径的来源会话 cwd", () => {
		const art = artifact({
			path: "/ws/a.md",
			sessions: [session({ path: "/s/1.jsonl", cwd: "/other" }), session({ path: "/s/2.jsonl", cwd: "/ws" })],
		});
		assert.equal(sourceCwdFor(art), "/ws");
	});

	it("所有来源都不包含该路径时返回 undefined（界面据此禁用继续修改）", () => {
		assert.equal(sourceCwdFor(artifact({ path: "/outside/a.md" })), undefined);
		assert.equal(sourceCwdFor(artifact({ sessions: [] })), undefined);
		assert.equal(sourceCwdFor(artifact({ sessions: [session({ cwd: undefined })] })), undefined);
	});

	it("URL 产物没有来源 cwd", () => {
		assert.equal(sourceCwdFor(artifact({ kind: "url", path: "https://example.com" })), undefined);
	});
});

describe("continuePrompt：提示里用相对路径，并带两条边界", () => {
	it("默认按来源 cwd 给出相对路径（不把绝对路径写进对话）", () => {
		const text = continuePrompt(artifact({ path: "/workspace/ws/季度复盘.md" }));
		assert.ok(text.includes("继续完善这份交付物：季度复盘.md"), text);
		assert.equal(text.includes("/workspace/ws"), false, "提示里不应出现绝对路径");
		assert.ok(text.includes("先读这个文件"));
		assert.ok(text.includes("不要移动文件位置"));
		assert.ok(text.includes("来源工作区之外"));
	});

	it("嵌套路径保留子目录；显式传入 cwd 时也按它算相对路径", () => {
		const art = artifact({
			path: "/workspace/ws/reports/2026/Q4.md",
			sessions: [session({ cwd: "/workspace/ws" })],
		});
		assert.ok(continuePrompt(art).includes("reports/2026/Q4.md"));
		assert.ok(continuePrompt(art, "/workspace/ws/reports").includes("2026/Q4.md"));
	});

	it("没有来源 cwd（或不在 cwd 内）时退回文件名，仍不铺绝对路径", () => {
		const outside = artifact({ path: "/outside/notes.md", name: "notes.md", sessions: [] });
		assert.ok(continuePrompt(outside).includes("notes.md"));
		assert.equal(continuePrompt(outside).includes("/outside/notes.md"), false);
	});
});

describe("relativePathWithin / displayPathFor：界面只显示相对路径", () => {
	it("相对路径保留原始大小写与子目录", () => {
		assert.equal(relativePathWithin("/workspace/ws", "/workspace/ws/Reports/Q4.md"), "Reports/Q4.md");
		assert.equal(relativePathWithin("C:\\Work\\WS", "c:\\work\\ws\\a.md"), "a.md");
	});

	it("不在 cwd 内 / 等于 cwd 本身时返回 undefined", () => {
		assert.equal(relativePathWithin("/workspace/ws", "/workspace/other/a.md"), undefined);
		assert.equal(relativePathWithin("/workspace/ws", "/workspace/ws"), undefined);
	});

	it("详情副标题 = 来源 cwd 的 basename / 相对路径，title 仍是完整路径", () => {
		const art = artifact({ path: "/workspace/ws/reports/Q4.md" });
		assert.deepEqual(displayPathFor(art), {
			text: "ws / reports/Q4.md",
			title: "/workspace/ws/reports/Q4.md",
		});
	});

	it("没有来源 cwd 时只显示文件名", () => {
		const outside = artifact({ path: "/outside/notes.md", name: "notes.md", sessions: [] });
		assert.deepEqual(displayPathFor(outside), { text: "notes.md", title: "/outside/notes.md" });
	});
});

describe("versionKeyFor：按归一化路径匹配文件历史", () => {
	const files = [
		{ key: "aaaaaaaaaaaaaaaa", path: "/ws/季度复盘.md" },
		{ key: "bbbbbbbbbbbbbbbb", path: "/ws/notes.txt" },
	];

	it("精确匹配返回 key", () => {
		assert.equal(versionKeyFor(files, "/ws/季度复盘.md"), "aaaaaaaaaaaaaaaa");
	});

	it("分隔符与大小写差异仍能匹配", () => {
		assert.equal(versionKeyFor([{ key: "cccccccccccccccc", path: "C:\\Work\\WS\\a.md" }], "c:/work/ws/A.md"), "cccccccccccccccc");
	});

	it("匹配不到 / 入参非法时返回 undefined（不假装有版本）", () => {
		assert.equal(versionKeyFor(files, "/ws/other.md"), undefined);
		assert.equal(versionKeyFor(files, ""), undefined);
		assert.equal(versionKeyFor(undefined, "/ws/a.md"), undefined);
		assert.equal(versionKeyFor([{ path: "/ws/a.md" }], "/ws/a.md"), undefined);
	});
});

describe("登记表", () => {
	it("类型档位 id 唯一，且 all 排第一", () => {
		const ids = ARTIFACT_TYPES.map((type) => type.id);
		assert.equal(ids[0], "all");
		assert.equal(new Set(ids).size, ids.length);
	});

	it("时间三档：全部 / 7 天 / 30 天", () => {
		assert.deepEqual(
			TIME_RANGES.map((range) => range.days),
			[0, 7, 30],
		);
	});
});
