/**
 * 资料库聚合逻辑的单测。
 *
 * 被测对象是 `src/main/daemon/library.js` —— 刻意抽成一个**能在 Electron
 * 之外 import** 的纯模块：`session-files.js` 在顶层就 `requireParentPort()` +
 * `loadResources()`，根本 import 不了，把聚合塞那里就等于放弃单测。
 *
 * 覆盖 design.md §4「单元」的全部条目：逐行解析（正常 / 坏行 / 空文件 /
 * 不存在的文件）、去重（同 path 跨会话合并、同会话两次只记一次）、截断保留最近的、
 * `exists` 实时标记、坏文件与不存在的目录不炸。
 *
 * ── 反向验证（已真跑并还原，见 prd.md R3）──────────────────────────────
 * 1) 去掉去重：把 `aggregateLibraryArtifacts` 里 `byPath` 的合并改成「每条
 *    产物都 new 一个 entry」，则下面两条会变红：
 *      - 「同一路径被两个会话交付 → 只出一行」
 *      - 「同一会话先后交付两次 → sessions 只出现一次」
 * 2) 把「坏行跳过」改成抛错：`parseLibrarySession` 的 `JSON.parse` catch 里
 *    改成 `throw`，则「坏行跳过」那条会红。
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	LIBRARY_MAX_ITEMS,
	aggregateLibraryArtifacts,
	parseLibrarySession,
	readLibraryArtifacts,
} from "../../src/main/daemon/library.js";

let dirs = [];

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), "zerowork-library-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs = [];
});

/** 造一个会话文件：header + 可选首条用户消息 + 若干产物条目。 */
function sessionFile(sessionsDir, { id, cwd = "/ws", firstText = "做一个东西", artifacts = [] }) {
	const lines = [
		JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-01T00:00:00.000Z", cwd }),
	];
	if (firstText !== undefined) {
		lines.push(
			JSON.stringify({
				type: "message",
				id: `${id}-m0`,
				parentId: null,
				timestamp: "2026-10-01T00:00:01.000Z",
				message: { role: "user", content: [{ type: "text", text: firstText }] },
			}),
		);
	}
	for (const [index, artifact] of artifacts.entries()) {
		lines.push(
			JSON.stringify({
				type: "custom",
				customType: "artifacts_presented",
				data: { files: [{ path: artifact.path, size: artifact.size, html: artifact.html ?? false, kind: artifact.kind ?? "local" }] },
				id: `${id}-a${index}`,
				parentId: `${id}-m0`,
				timestamp: artifact.deliveredAt,
			}),
		);
	}
	const file = join(sessionsDir, `${id}.jsonl`);
	writeFileSync(file, `${lines.join("\n")}\n`);
	return file;
}

const artifact = (path, extra = {}) => ({ path, size: 100, deliveredAt: "2026-10-02T12:00:00.000Z", ...extra });

describe("parseLibrarySession —— 逐行解析（纯函数）", () => {
	it("正常条目：抽出会话头与产物字段", () => {
		const raw = [
			JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/ws/a" }),
			JSON.stringify({
				type: "message",
				id: "m1",
				message: { role: "user", content: [{ type: "text", text: "写一份周报" }] },
			}),
			JSON.stringify({
				type: "custom",
				customType: "artifacts_presented",
				data: { files: [{ path: "/ws/a/周报.md", size: 2876, html: false, kind: "local" }] },
				id: "a1",
				timestamp: "2026-10-02T12:21:58.641Z",
			}),
		].join("\n");
		const parsed = parseLibrarySession(raw);
		expect(parsed.id).toBe("s1");
		expect(parsed.cwd).toBe("/ws/a");
		expect(parsed.firstUserText).toBe("写一份周报");
		expect(parsed.artifacts).toEqual([
			{ path: "/ws/a/周报.md", size: 2876, html: false, kind: "local", deliveredAt: "2026-10-02T12:21:58.641Z" },
		]);
	});

	it("坏行跳过，不影响同一文件里的好行", () => {
		const raw = [
			JSON.stringify({ type: "session", id: "s2" }),
			"{ 这不是合法 JSON",
			JSON.stringify({
				type: "custom",
				customType: "artifacts_presented",
				data: { files: [{ path: "/x/ok.md", size: 1, html: false, kind: "local" }] },
				id: "a1",
				timestamp: "2026-10-02T00:00:00.000Z",
			}),
			"",
			"null",
		].join("\n");
		const parsed = parseLibrarySession(raw);
		expect(parsed.artifacts).toHaveLength(1);
		expect(parsed.artifacts[0].path).toBe("/x/ok.md");
	});

	it("空文件 → undefined（没有会话头，不算会话）", () => {
		expect(parseLibrarySession("")).toBeUndefined();
		expect(parseLibrarySession("\n\n")).toBeUndefined();
	});

	it("没有会话头（只有消息）→ undefined", () => {
		const raw = JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "hi" } });
		expect(parseLibrarySession(raw)).toBeUndefined();
	});

	it("非字符串输入 → undefined（不抛）", () => {
		expect(parseLibrarySession(undefined)).toBeUndefined();
		expect(parseLibrarySession(null)).toBeUndefined();
	});
});

describe("aggregateLibraryArtifacts —— 去重与截断（纯函数）", () => {
	it("同一路径被两个会话交付 → 只出一行，sessions 两条，取更晚一次交付的元数据", () => {
		const early = { id: "s1", path: "/s1.jsonl", title: "早", cwd: "/a", modifiedAt: 1000, artifacts: [artifact("/shared/out.md", { size: 10, deliveredAt: "2026-10-01T00:00:00.000Z" })] };
		const late = { id: "s2", path: "/s2.jsonl", title: "晚", cwd: "/b", modifiedAt: 2000, artifacts: [artifact("/shared/out.md", { size: 999, deliveredAt: "2026-10-03T00:00:00.000Z" })] };
		const { artifacts } = aggregateLibraryArtifacts([early, late]);
		expect(artifacts).toHaveLength(1);
		expect(artifacts[0].name).toBe("out.md");
		// 更晚一次交付覆盖快照元数据
		expect(artifacts[0].size).toBe(999);
		expect(artifacts[0].deliveredAt).toBe("2026-10-03T00:00:00.000Z");
		// 两个来源会话，最近在前
		expect(artifacts[0].sessions.map((s) => s.id)).toEqual(["s2", "s1"]);
	});

	it("同一会话里先后交付两次 → sessions 里只出现一次（按会话 id 去重）", () => {
		const session = {
			id: "s1",
			path: "/s1.jsonl",
			title: "同一会话",
			cwd: "/a",
			modifiedAt: 1000,
			artifacts: [
				artifact("/out.md", { size: 1, deliveredAt: "2026-10-01T00:00:00.000Z" }),
				artifact("/out.md", { size: 2, deliveredAt: "2026-10-02T00:00:00.000Z" }),
			],
		};
		const { artifacts } = aggregateLibraryArtifacts([session]);
		expect(artifacts).toHaveLength(1);
		expect(artifacts[0].sessions).toHaveLength(1);
		// 元数据取更晚的那次
		expect(artifacts[0].size).toBe(2);
	});

	it("超过上限 → truncated: true，且保留的是**最近的**（留下第 501 条而不是第 1 条）", () => {
		const sessions = [
			{
				id: "s1",
				path: "/s1.jsonl",
				title: "t",
				cwd: "/a",
				modifiedAt: 1,
				artifacts: Array.from({ length: LIBRARY_MAX_ITEMS + 1 }, (_, i) => ({
					path: `/out/${i}.md`,
					size: i,
					html: false,
					kind: "local",
					// 序号越大越晚
					deliveredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
				})),
			},
		];
		const { artifacts, truncated } = aggregateLibraryArtifacts(sessions);
		expect(truncated).toBe(true);
		expect(artifacts).toHaveLength(LIBRARY_MAX_ITEMS);
		// 最近的那一条（序号 500）必须在，最早的一条（序号 0）必须被丢掉
		expect(artifacts[0].path).toBe(`/out/${LIBRARY_MAX_ITEMS}.md`);
		expect(artifacts.some((a) => a.path === "/out/0.md")).toBe(false);
	});

	it("不超上限 → truncated: false", () => {
		const session = { id: "s1", path: "/s.jsonl", title: "t", cwd: "/a", modifiedAt: 1, artifacts: [artifact("/out.md")] };
		const { truncated } = aggregateLibraryArtifacts([session]);
		expect(truncated).toBe(false);
	});

	it("不相关的会话（无产物条目）不产生任何行", () => {
		const quiet = { id: "s1", path: "/s.jsonl", title: "t", cwd: "/a", modifiedAt: 1, artifacts: [] };
		const { artifacts } = aggregateLibraryArtifacts([quiet]);
		expect(artifacts).toEqual([]);
	});

	it("URL 项 kind 记为 url，name 取末段", () => {
		const session = {
			id: "s1",
			path: "/s.jsonl",
			title: "t",
			cwd: "/a",
			modifiedAt: 1,
			artifacts: [artifact("https://example.com/report.html", { kind: "url", html: true })],
		};
		const { artifacts } = aggregateLibraryArtifacts([session]);
		expect(artifacts[0].kind).toBe("url");
		expect(artifacts[0].html).toBe(true);
		expect(artifacts[0].name).toBe("report.html");
	});
});

describe("readLibraryArtifacts —— IO 层", () => {
	it("正常：会话文件里的产物被聚合成一行，来源会话信息正确", () => {
		const sessionsDir = tempDir();
		const artifactPath = join(tempDir(), "周报.md");
		writeFileSync(artifactPath, "# 周报\n");
		sessionFile(sessionsDir, {
			id: "s1",
			cwd: "/ws/a",
			firstText: "写一份周报",
			artifacts: [artifact(artifactPath, { size: 2876 })],
		});
		const result = readLibraryArtifacts({ sessionsDir });
		expect(result.truncated).toBe(false);
		expect(result.artifacts).toHaveLength(1);
		const entry = result.artifacts[0];
		expect(entry.name).toBe("周报.md");
		expect(entry.size).toBe(2876);
		expect(entry.exists).toBe(true);
		expect(entry.sessions).toHaveLength(1);
		expect(entry.sessions[0].cwd).toBe("/ws/a");
		expect(entry.sessions[0].title).toBe("写一份周报");
	});

	it("产物被删除后 → exists: false，且不抛、条目不消失", () => {
		const sessionsDir = tempDir();
		const artifactPath = join(tempDir(), "gone.md");
		writeFileSync(artifactPath, "x");
		sessionFile(sessionsDir, { id: "s1", artifacts: [artifact(artifactPath)] });
		rmSync(artifactPath);
		const result = readLibraryArtifacts({ sessionsDir });
		expect(result.artifacts).toHaveLength(1);
		expect(result.artifacts[0].exists).toBe(false);
	});

	it("URL 产物 exists 记为 true（不 stat 一个 http 地址）", () => {
		const sessionsDir = tempDir();
		sessionFile(sessionsDir, { id: "s1", artifacts: [artifact("https://example.com/x.html", { kind: "url" })] });
		const result = readLibraryArtifacts({ sessionsDir });
		expect(result.artifacts[0].exists).toBe(true);
	});

	it("空目录 → 空列表（不是抛错）", () => {
		expect(readLibraryArtifacts({ sessionsDir: tempDir() })).toEqual({ artifacts: [], truncated: false });
	});

	it("不存在的目录 → 空列表（不抛）", () => {
		const missing = join(tempDir(), "does-not-exist");
		expect(readLibraryArtifacts({ sessionsDir: missing })).toEqual({ artifacts: [], truncated: false });
	});

	it("坏文件（没有会话头）跳过，同目录里的好会话照常聚合", () => {
		const sessionsDir = tempDir();
		writeFileSync(join(sessionsDir, "broken.jsonl"), "{ 乱码\n不是 JSON\n");
		sessionFile(sessionsDir, { id: "good", artifacts: [artifact("/tmp/ok.md")] });
		const result = readLibraryArtifacts({ sessionsDir });
		expect(result.artifacts).toHaveLength(1);
		expect(result.artifacts[0].path).toBe("/tmp/ok.md");
	});

	it("非 .jsonl 文件与子目录都被忽略", () => {
		const sessionsDir = tempDir();
		writeFileSync(join(sessionsDir, "notes.txt"), "忽略我");
		mkdirSync(join(sessionsDir, "sub.jsonl"));
		const result = readLibraryArtifacts({ sessionsDir });
		expect(result.artifacts).toEqual([]);
	});

	it("注入的内部会话判据为真时，该会话被跳过", () => {
		const sessionsDir = tempDir();
		const internal = sessionFile(sessionsDir, { id: "internal", artifacts: [artifact("/tmp/i.md")] });
		sessionFile(sessionsDir, { id: "visible", artifacts: [artifact("/tmp/v.md")] });
		const result = readLibraryArtifacts({
			sessionsDir,
			isInternalSessionFile: (filePath) => filePath === internal,
		});
		expect(result.artifacts.map((a) => a.path)).toEqual(["/tmp/v.md"]);
	});

	it("默认 isInternalSessionFile 缺省时不过滤（判据可选）", () => {
		const sessionsDir = tempDir();
		sessionFile(sessionsDir, { id: "s1", artifacts: [artifact("/tmp/a.md")] });
		expect(readLibraryArtifacts({ sessionsDir }).artifacts).toHaveLength(1);
	});
});
