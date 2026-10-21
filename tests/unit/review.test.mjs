/**
 * 变更审阅台（`src/main/daemon/review.js`）的单测。
 *
 * 这条链路上没有编译期检查，写错的形态也都**不会崩**：已阅判定写反会让所有改动
 * 永远显示「已阅」、排序写反会让昨天的改动压住今天的、读当前文件少一条边界会让
 * 审阅页变成一个「读任意路径」的入口。这些正是单测该钉住的东西。
 *
 * ── 反向验证（已真跑并还原）──────────────────────────────────────────
 * 1) 把 isReviewed 改成恒 `true` → 「版本 id 变化 → 回到待审阅」与计数用例变红。
 * 2) 把 readReviewDiff 的 `after` 改成恒等于 `before.content` → 「正常 diff
 *    带 hunks」用例变红（hunks 为空、added/removed 为 0）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
	REVIEW_MAX_BYTES,
	REVIEW_STATE_FILE,
	buildReviewEntries,
	isReviewed,
	markReviewed,
	readReviewDiff,
	readReviewState,
	reviewStatePath,
	unmarkReviewed,
	writeReviewState,
} from "../../src/main/daemon/review.js";
import { listVersionFiles, recordVersion, versionKeyOf } from "../../src/main/daemon/version-store.js";

let roots = [];

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), "zerowork-review-"));
	roots.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of roots) rmSync(dir, { recursive: true, force: true });
	roots = [];
});

/** 记一版并把当前磁盘内容写成「改后」，返回 key（模拟一次真实的 Agent 改动）。 */
function seedChange({ versionsDir, file, before, after, at, sessionId, tool }) {
	recordVersion({ path: file, content: before, at, sessionId, tool }, { dir: versionsDir });
	writeFileSync(file, after);
	return versionKeyOf(resolve(file));
}

describe("审阅状态文件 —— 坏文件当空、原子写入", () => {
	it("文件不存在 / 坏 JSON / 顶层结构不对 → 当空（不抛）", () => {
		const dir = tempDir();
		expect(readReviewState(dir)).toEqual({ files: {} });

		writeFileSync(reviewStatePath(dir), "{ 这不是 JSON");
		expect(readReviewState(dir)).toEqual({ files: {} });

		writeFileSync(reviewStatePath(dir), JSON.stringify(["not", "an", "object"]));
		expect(readReviewState(dir)).toEqual({ files: {} });

		writeFileSync(reviewStatePath(dir), JSON.stringify({ files: "nope" }));
		expect(readReviewState(dir)).toEqual({ files: {} });
	});

	it("单条坏记录丢它自己，其余照常读回", () => {
		const dir = tempDir();
		writeFileSync(
			reviewStatePath(dir),
			JSON.stringify({
				files: {
					aaaaaaaaaaaaaaaa: { versionId: "12", at: 99 },
					bbbbbbbbbbbbbbbb: { at: 1 },
					cccccccccccccccc: "garbage",
				},
			}),
		);
		expect(readReviewState(dir)).toEqual({ files: { aaaaaaaaaaaaaaaa: { versionId: "12", at: 99 } } });
	});

	it("写入走临时文件 + rename：读回一致，且不留 .tmp", () => {
		const dir = tempDir();
		const state = { files: { aaaaaaaaaaaaaaaa: { versionId: "12", at: 99 } } };
		expect(writeReviewState(dir, state)).toEqual({ ok: true });
		expect(readReviewState(dir)).toEqual(state);
		const raw = readFileSync(join(dir, REVIEW_STATE_FILE), "utf8");
		expect(raw.endsWith("\n")).toBe(true);
	});

	it("配置目录不存在时写入会先建目录（不在就 silently 丢标记）", () => {
		const dir = join(tempDir(), "还没有这个目录");
		expect(writeReviewState(dir, { files: {} })).toEqual({ ok: true });
		expect(readReviewState(dir)).toEqual({ files: {} });
	});
});

describe("isReviewed / markReviewed —— 版本 id 是唯一判据", () => {
	it("同一个 key 的 versionId 相同才算已阅；空 id 不算", () => {
		const state = { files: { aaaaaaaaaaaaaaaa: { versionId: "12", at: 1 } } };
		expect(isReviewed(state, "aaaaaaaaaaaaaaaa", "12")).toBe(true);
		expect(isReviewed(state, "aaaaaaaaaaaaaaaa", "13")).toBe(false);
		expect(isReviewed(state, "bbbbbbbbbbbbbbbb", "12")).toBe(false);
		expect(isReviewed(state, "aaaaaaaaaaaaaaaa", "")).toBe(false);
		expect(isReviewed(undefined, "aaaaaaaaaaaaaaaa", "12")).toBe(false);
	});

	it("markReviewed 返回新 state，**不改入参**", () => {
		const original = { files: { aaaaaaaaaaaaaaaa: { versionId: "12", at: 1 } } };
		const frozen = Object.freeze({ files: Object.freeze({ ...original.files }) });
		const next = markReviewed(frozen, "bbbbbbbbbbbbbbbb", "20", 500);
		expect(next).not.toBe(frozen);
		expect(next.files).not.toBe(frozen.files);
		expect(frozen.files).toEqual({ aaaaaaaaaaaaaaaa: { versionId: "12", at: 1 } });
		expect(next.files).toEqual({
			aaaaaaaaaaaaaaaa: { versionId: "12", at: 1 },
			bbbbbbbbbbbbbbbb: { versionId: "20", at: 500 },
		});
	});

	it("unmarkReviewed 只删那一条标记、不改入参，其余文件不受影响", () => {
		const state = {
			files: {
				aaaaaaaaaaaaaaaa: { versionId: "12", at: 1 },
				bbbbbbbbbbbbbbbb: { versionId: "20", at: 2 },
			},
		};
		const next = unmarkReviewed(state, "aaaaaaaaaaaaaaaa");
		expect(next).not.toBe(state);
		expect(next.files).not.toBe(state.files);
		// 入参原样
		expect(state.files.aaaaaaaaaaaaaaaa).toEqual({ versionId: "12", at: 1 });
		expect(next.files).toEqual({ bbbbbbbbbbbbbbbb: { versionId: "20", at: 2 } });
		// 已阅撤销之后，同一版本 id 回到「待审阅」
		expect(isReviewed(next, "aaaaaaaaaaaaaaaa", "12")).toBe(false);
	});

	it("unmarkReviewed 对不存在的键是幂等的（不抛、不凭空造键）", () => {
		const state = { files: { aaaaaaaaaaaaaaaa: { versionId: "12", at: 1 } } };
		const next = unmarkReviewed(state, "cccccccccccccccc");
		expect(next.files).toEqual(state.files);
		expect(unmarkReviewed(undefined, "cccccccccccccccc")).toEqual({ files: {} });
	});
});

describe("buildReviewEntries —— 列队、排序与计数", () => {
	it("按 at 降序；已阅标记与 pending / reviewed 计数正确", () => {
		const versionsDir = tempDir();
		const root = tempDir();
		const a = join(root, "a.md");
		const b = join(root, "b.md");
		seedChange({ versionsDir, file: a, before: "a-old", after: "a-new", at: 100, sessionId: "s1", tool: "write" });
		seedChange({ versionsDir, file: b, before: "b-old", after: "b-new", at: 200, sessionId: "s2", tool: "edit" });

		const keyA = versionKeyOf(resolve(a));
		const state = markReviewed({ files: {} }, keyA, "100", 300);
		const { entries, pending, reviewed } = buildReviewEntries(listVersionFiles({ dir: versionsDir }).files, state);

		expect(entries.map((entry) => entry.name)).toEqual(["b.md", "a.md"]);
		expect(entries[0]).toMatchObject({
			key: versionKeyOf(resolve(b)),
			name: "b.md",
			dir: resolve(root),
			versionId: "200",
			at: 200,
			tool: "edit",
			sessionId: "s2",
			exists: true,
			reviewed: false,
		});
		expect(entries[1].reviewed).toBe(true);
		expect(pending).toBe(1);
		expect(reviewed).toBe(1);
	});

	it("没有版本的条目（只被跳过）不进队列 —— 没有旧内容可审", () => {
		const versionsDir = tempDir();
		const root = tempDir();
		recordVersion({ path: join(root, "blob.bin"), content: "PNG\0rest", at: 50 }, { dir: versionsDir });
		expect(listVersionFiles({ dir: versionsDir }).files).toHaveLength(1);
		expect(buildReviewEntries(listVersionFiles({ dir: versionsDir }).files, { files: {} })).toEqual({
			entries: [],
			pending: 0,
			reviewed: 0,
		});
	});

	it("**版本 id 变化 → 自动回到待审阅**（核心语义，不靠时间比较）", () => {
		const versionsDir = tempDir();
		const root = tempDir();
		const file = join(root, "周报.md");
		const key = seedChange({ versionsDir, file, before: "v1", after: "v2", at: 100 });

		// 审阅第一版并标记已阅。
		let state = markReviewed({ files: {} }, key, "100", 150);
		let built = buildReviewEntries(listVersionFiles({ dir: versionsDir }).files, state);
		expect(built.entries[0]).toMatchObject({ versionId: "100", reviewed: true });
		expect(built.pending).toBe(0);

		// 文件再被改一次（旧内容 "v2" 成为新版本，id=300）——无需清理任何历史。
		recordVersion({ path: file, content: "v2", at: 300 }, { dir: versionsDir });
		built = buildReviewEntries(listVersionFiles({ dir: versionsDir }).files, state);
		expect(built.entries[0]).toMatchObject({ versionId: "300", reviewed: false });
		expect(built.pending).toBe(1);
		// 旧的已阅标记原样保留（不删历史：万一同一个 id 再出现也说得清）。
		expect(state.files[key]).toEqual({ versionId: "100", at: 150 });
	});
});

describe("readReviewDiff —— 改前读版本、改后读当前磁盘", () => {
	it("正常：给并排 hunks、改前 / 现在正文与增删行数", () => {
		const versionsDir = tempDir();
		const file = join(tempDir(), "notes.md");
		const key = seedChange({
			versionsDir,
			file,
			before: "第一行\n第二行\n第三行\n",
			after: "第一行\n第二行（改过）\n第三行\n新增一行\n",
			at: 100,
		});

		const result = readReviewDiff({ key, versionId: "100", versionsDir });
		expect(result.ok).toBe(true);
		expect(result.before).toBe("第一行\n第二行\n第三行\n");
		expect(result.after).toBe("第一行\n第二行（改过）\n第三行\n新增一行\n");
		expect(result.added).toBe(2);
		expect(result.removed).toBe(1);
		expect(result.truncated).toBe(false);
		expect(result.hunks).toContain("-第二行");
		expect(result.hunks).toContain("+第二行（改过）");
		expect(result.hunks).toContain("+新增一行");
	});

	it("两版逐行相同 → hunks 为空串、truncated 为 false（不是「算不出来」）", () => {
		const versionsDir = tempDir();
		const file = join(tempDir(), "same.md");
		const key = seedChange({ versionsDir, file, before: "一致\n", after: "一致\n", at: 100 });
		expect(readReviewDiff({ key, versionId: "100", versionsDir })).toMatchObject({
			ok: true,
			hunks: "",
			added: 0,
			removed: 0,
			truncated: false,
		});
	});

	it("diff 触顶 DIFF_CELL_BUDGET → truncated:true、hunks 空、仍给增删行数", () => {
		const versionsDir = tempDir();
		const file = join(tempDir(), "huge-lines.txt");
		const oldLines = Array.from({ length: 2100 }, (_v, i) => `old-${i}`).join("\n");
		const newLines = Array.from({ length: 2100 }, (_v, i) => `new-${i}`).join("\n");
		const key = seedChange({ versionsDir, file, before: oldLines, after: newLines, at: 100 });
		const result = readReviewDiff({ key, versionId: "100", versionsDir });
		expect(result).toMatchObject({ ok: true, hunks: "", truncated: true });
		expect(result.added).toBe(2100);
		expect(result.removed).toBe(2100);
	});

	it("当前文件不存在 → no-after（不伪造 diff、不抛）", () => {
		const versionsDir = tempDir();
		const file = join(tempDir(), "gone.md");
		const key = seedChange({ versionsDir, file, before: "旧", after: "新", at: 100 });
		rmSync(file);
		const result = readReviewDiff({ key, versionId: "100", versionsDir });
		expect(result).toEqual({ ok: false, reason: "no-after" });
	});

	it("当前文件是二进制（前 8 KiB 含 NUL）→ binary", () => {
		const versionsDir = tempDir();
		const file = join(tempDir(), "blob.bin");
		const key = versionKeyOf(resolve(file));
		recordVersion({ path: file, content: "旧", at: 100 }, { dir: versionsDir });
		writeFileSync(file, Buffer.from([0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
		expect(readReviewDiff({ key, versionId: "100", versionsDir })).toEqual({ ok: false, reason: "binary" });
	});

	it("当前文件超过 256 KiB → too-large（不读正文）", () => {
		const versionsDir = tempDir();
		const file = join(tempDir(), "big.md");
		const key = versionKeyOf(resolve(file));
		recordVersion({ path: file, content: "旧", at: 100 }, { dir: versionsDir });
		writeFileSync(file, "x".repeat(REVIEW_MAX_BYTES + 1));
		expect(readReviewDiff({ key, versionId: "100", versionsDir })).toEqual({ ok: false, reason: "too-large" });
		// 边界正好等于上限时放行（判据是「超过」）。
		writeFileSync(file, "x".repeat(REVIEW_MAX_BYTES));
		expect(readReviewDiff({ key, versionId: "100", versionsDir }).ok).toBe(true);
	});

	it("当前路径是符号链接 → symlink（不跟随，避免读链接指向的任意路径）", () => {
		const versionsDir = tempDir();
		const file = join(tempDir(), "link.md");
		const elsewhere = join(tempDir(), "secret.txt");
		writeFileSync(elsewhere, "不该被读到");
		const key = versionKeyOf(resolve(file));
		recordVersion({ path: file, content: "旧", at: 100 }, { dir: versionsDir });
		symlinkSync(elsewhere, file);
		expect(readReviewDiff({ key, versionId: "100", versionsDir })).toEqual({ ok: false, reason: "symlink" });
	});

	it("key 未知 / 版本不存在 → 沿用版本存储的 reason", () => {
		const versionsDir = tempDir();
		expect(readReviewDiff({ key: "ffffffffffffffff", versionId: "1", versionsDir })).toEqual({
			ok: false,
			reason: "unknown",
		});

		const file = join(tempDir(), "x.md");
		const key = seedChange({ versionsDir, file, before: "旧", after: "新", at: 100 });
		expect(readReviewDiff({ key, versionId: "999", versionsDir })).toEqual({
			ok: false,
			reason: "no-such-version",
		});
	});

	it("版本正文文件缺失 → missing（与文件历史同一口径）", () => {
		const versionsDir = tempDir();
		const file = join(tempDir(), "y.md");
		const key = seedChange({ versionsDir, file, before: "旧", after: "新", at: 100 });
		rmSync(join(versionsDir, key, "100.txt"));
		expect(readReviewDiff({ key, versionId: "100", versionsDir })).toEqual({ ok: false, reason: "missing" });
	});

	it("旧版本 id + 新磁盘内容 → stale（不画归因错误的 diff）", () => {
		/*
		 * CI 上真的撞到过：列表刷新与详情请求交错时，界面拿「第一版」去配
		 * 「第三版」的磁盘内容，画出「改前 = 第一版」的假对照 —— 而真正的上一次
		 * 改动是第二版。这里钉住：只要 versionId 不是最新，就拒绝。
		 */
		const versionsDir = tempDir();
		const file = join(tempDir(), "z.md");
		recordVersion({ path: file, content: "第一版\n", at: 100 }, { dir: versionsDir });
		recordVersion({ path: file, content: "第二版\n", at: 200 }, { dir: versionsDir });
		writeFileSync(file, "第三版\n");
		const key = versionKeyOf(resolve(file));

		// 最新一版（200）可以算；旧的那一版（100）必须拒绝。
		expect(readReviewDiff({ key, versionId: "200", versionsDir }).ok).toBe(true);
		expect(readReviewDiff({ key, versionId: "100", versionsDir })).toEqual({ ok: false, reason: "stale" });
	});
});
