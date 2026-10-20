/**
 * 会话检索的单测（`src/main/daemon/session-state.js` 的 `searchFileHits`
 * 与 `src/main/daemon/session-search.js` 的扫描层）。
 *
 * 这块的价值在**边界**，不在「能搜到」：检索页要拿命中片段做高亮，
 * 片段一旦与索引错位，界面上就是一段乱标的红字；而「只扫最近 N 个会话」
 * 如果没被钉住，某次改动把上限去掉，使用者会以为搜遍了全库。
 *
 * 覆盖：多命中 / 角色 / entryId、AND 语义、大小写、每会话上限、
 * 坏行与非法 JSON 容错、片段与高亮区间对齐、代理对不被切半、
 * mtime 倒序、会话数上限、扫描上限（truncated）、排除指定会话、空查询不扫盘。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { searchFileHits, SCAN_LIMIT } from "../../src/main/daemon/session-state.js";
import { searchSessionMessages } from "../../src/main/daemon/session-search.js";

let dirs = [];

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), "zerowork-search-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs = [];
});

/** 一行一个 JSON 条目 —— 与会话文件真实格式一致。 */
function sessionFile(id, entries) {
	return [JSON.stringify({ type: "session", id }), ...entries.map((entry) => JSON.stringify(entry))].join("\n");
}

function message(id, role, content) {
	return { type: "message", id, message: { role, content } };
}

function writeSession(dir, id, entries, mtimeMs) {
	const path = join(dir, `${id}.jsonl`);
	writeFileSync(path, sessionFile(id, entries));
	if (mtimeMs !== undefined) {
		utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
	}
	return path;
}

describe("searchFileHits：一份文件里的多条命中", () => {
	it("按出现顺序收集命中，带回 entryId、角色与高亮区间", () => {
		const content = sessionFile("s1", [
			message("e1", "user", "帮我把报价单里的单价改成含税价"),
			message("e2", "assistant", "改好了：单价已经从 100 调到 113。"),
			message("e3", "user", "再检查一遍报价单"),
		]);
		const found = searchFileHits(content, ["报价单"], { limit: 3 });
		expect(found.sessionId).toBe("s1");
		expect(found.totalHits).toBe(2);
		expect(found.hits.map((hit) => hit.entryId)).toEqual(["e1", "e3"]);
		expect(found.hits.map((hit) => hit.role)).toEqual(["user", "user"]);
		for (const hit of found.hits) {
			expect(hit.snippet).toContain("报价单");
			// 高亮区间必须与片段本身对得上：界面直接按 start/end 切片上色
			for (const match of hit.matches) {
				expect(hit.snippet.slice(match.start, match.end)).toBe("报价单");
			}
		}
	});

	it("多词是 AND：少一个词就不算命中", () => {
		const content = sessionFile("s1", [message("e1", "user", "报价单里的单价")]);
		expect(searchFileHits(content, ["报价单", "合同"], {})).toBeNull();
		expect(searchFileHits(content, ["报价单", "单价"], {})).not.toBeNull();
	});

	it("大小写不敏感，且多个词在同一段里的区间都标出来", () => {
		const content = sessionFile("s1", [message("e1", "assistant", "Run the BUILD, then run the build again")]);
		const found = searchFileHits(content, ["build", "run"], {});
		const matches = found.hits[0].matches;
		// run/build 各出现两次 → 合并相邻重叠后仍是 4 段
		expect(matches).toHaveLength(4);
		const highlighted = matches.map((match) => found.hits[0].snippet.slice(match.start, match.end).toLowerCase());
		expect(highlighted).toEqual(["run", "build", "run", "build"]);
	});

	it("每会话命中条数有上限，但命中总数照实统计", () => {
		const entries = Array.from({ length: 6 }, (_, index) =>
			message(`e${index + 1}`, "user", `第 ${index + 1} 次提到合同`)
		);
		const found = searchFileHits(sessionFile("s1", entries), ["合同"], { limit: 2 });
		expect(found.hits).toHaveLength(2);
		expect(found.totalHits).toBe(6);
	});

	it("坏行与非法 JSON 跳过，不影响后面的命中", () => {
		const content = [
			JSON.stringify({ type: "session", id: "s1" }),
			"{ 这不是 JSON",
			"",
			JSON.stringify({ type: "tool", id: "t1" }),
			JSON.stringify(message("e1", "user", "合同在附件里")),
		].join("\n");
		const found = searchFileHits(content, ["合同"], {});
		expect(found.hits.map((hit) => hit.entryId)).toEqual(["e1"]);
	});

	it("content 为块数组时只拼 text 块，工具结果不参与", () => {
		const content = sessionFile("s1", [
			{
				type: "message",
				id: "e1",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "合同这个词不该被搜到" },
						{ type: "text", text: "合同我看了" },
						{ type: "tool_result", text: "合同" },
					],
				},
			},
		]);
		const found = searchFileHits(content, ["合同"], {});
		expect(found.hits[0].snippet).toBe("合同我看了");
		expect(found.hits[0].matches).toEqual([{ start: 0, end: 2 }]);
	});

	it("换行折叠成空格后，高亮区间仍按折叠后的片段计算", () => {
		const content = sessionFile("s1", [message("e1", "user", "第一行普通\n第二行 里有 合同 二字")]);
		const found = searchFileHits(content, ["合同"], {});
		const hit = found.hits[0];
		expect(hit.snippet).not.toContain("\n");
		expect(hit.snippet.slice(hit.matches[0].start, hit.matches[0].end)).toBe("合同");
	});

	it("窗口边界落在代理对中间时向外扩，不产出半个 emoji", () => {
		const filler = "字".repeat(400);
		const text = `${filler}😀${filler}合同${filler}`;
		const found = searchFileHits(sessionFile("s1", [message("e1", "user", text)]), ["合同"], { radius: 60 });
		const hit = found.hits[0];
		// 孤立的高位/低位代理会让渲染层出现替换字符（本项目对 U+FFFD 零容忍）
		expect(hit.snippet).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
		expect(hit.snippet).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
		expect(hit.snippet.slice(hit.matches[0].start, hit.matches[0].end)).toBe("合同");
	});

	it("没有会话头、或完全没有命中时返回 null", () => {
		expect(searchFileHits("", ["合同"], {})).toBeNull();
		expect(searchFileHits(sessionFile("s1", [message("e1", "user", "无关内容")]), ["合同"], {})).toBeNull();
	});

	it("标题优先取 session_info 的名字，没有则取首条用户消息", () => {
		const named = sessionFile("s1", [
			{ type: "session_info", name: "季度复盘" },
			message("e1", "user", "合同"),
		]);
		expect(searchFileHits(named, ["合同"], {}).title).toBe("季度复盘");
		const unnamed = sessionFile("s2", [message("e1", "user", "把合同打印出来")]);
		expect(searchFileHits(unnamed, ["合同"], {}).title).toBe("把合同打印出来");
	});
});

describe("searchSessionMessages：跨会话扫描", () => {
	it("按 mtime 倒序返回会话，并且每个会话带 path 供跳转", async () => {
		const dir = tempDir();
		writeSession(dir, "old", [message("e1", "user", "旧会话里的合同")], 1_000);
		writeSession(dir, "new", [message("e1", "user", "新会话里的合同")], 2_000);
		const result = await searchSessionMessages("合同", { sessionsDir: dir });
		expect(result.sessions.map((session) => session.sessionId)).toEqual(["new", "old"]);
		expect(result.sessions[0].path.endsWith("new.jsonl")).toBe(true);
		expect(result.scanned).toBe(2);
		expect(result.truncated).toBe(false);
	});

	it("会话数上限生效：只返回最近的 N 个会话", async () => {
		const dir = tempDir();
		writeSession(dir, "a", [message("e1", "user", "合同 a")], 1_000);
		writeSession(dir, "b", [message("e1", "user", "合同 b")], 2_000);
		const result = await searchSessionMessages("合同", { sessionsDir: dir, limit: 1 });
		expect(result.sessions.map((session) => session.sessionId)).toEqual(["b"]);
		// 还有没读到的会话：这是「显示上限」，不是「扫描上限」，界面要分开说
		expect(result.capped).toBe(true);
	});

	it("还有会话没扫到时 truncated 为 true，且返回的会话数不超过 limit", async () => {
		const dir = tempDir();
		for (let index = 0; index < 60; index += 1) {
			writeSession(dir, `s${index}`, [message("e1", "user", `第 ${index} 个合同`)], 1_000 + index);
		}
		const result = await searchSessionMessages("合同", { sessionsDir: dir, limit: 50 });
		expect(result.scannedLimit).toBe(SCAN_LIMIT);
		expect(result.scanned).toBe(50);
		expect(result.sessions).toHaveLength(50);
		expect(result.truncated).toBe(true);
		expect(result.capped).toBe(true);
	});

	it("排除指定会话（与 Agent 工具同一语义）", async () => {
		const dir = tempDir();
		writeSession(dir, "here", [message("e1", "user", "合同在这里")], 2_000);
		writeSession(dir, "there", [message("e1", "user", "合同在那里")], 1_000);
		const result = await searchSessionMessages("合同", { sessionsDir: dir, excludeSessionId: "here" });
		expect(result.sessions.map((session) => session.sessionId)).toEqual(["there"]);
	});

	it("空查询不扫盘：目录不存在也返回空结果而不是抛错", async () => {
		const result = await searchSessionMessages("   ", {
			sessionsDir: join(tempDir(), "does-not-exist"),
		});
		expect(result).toEqual({
			query: "",
			scanned: 0,
			scannedLimit: SCAN_LIMIT,
			truncated: false,
			capped: false,
			sessions: [],
		});
	});

	it("目录不存在时返回空结果（首启 / 目录未建）", async () => {
		const result = await searchSessionMessages("合同", {
			sessionsDir: join(tempDir(), "nope"),
		});
		expect(result.sessions).toEqual([]);
		expect(result.scanned).toBe(0);
	});

	it("query 原样带回（去掉首尾空白），界面据此判断是否过期响应", async () => {
		const dir = tempDir();
		writeSession(dir, "s1", [message("e1", "user", "合同")], 1_000);
		const result = await searchSessionMessages("  合同  ", { sessionsDir: dir });
		expect(result.query).toBe("合同");
	});

	it("非法会话文件（没有会话头）不会被当成命中", async () => {
		const dir = tempDir();
		mkdirSync(join(dir, "sub"));
		writeFileSync(join(dir, "broken.jsonl"), JSON.stringify(message("e1", "user", "合同")) + "\n");
		writeSession(dir, "good", [message("e1", "user", "合同")], 1_000);
		const result = await searchSessionMessages("合同", { sessionsDir: dir });
		expect(result.sessions.map((session) => session.sessionId)).toEqual(["good"]);
	});
});
