/**
 * 文件时光机存储模块（`src/main/daemon/version-store.js`）的单测。
 *
 * 为什么值得单独测：这条链路上没有编译期检查，写错一处不会崩，只会让用户
 *「以为文件能退回去、其实退不回去」—— 记录判据写反（把失败/新建也记成版本）、
 * 裁剪没删内容文件（磁盘悄悄涨）、坏 meta 抛错（整个页面空白）、还原不校验都属
 * 这类「静默失效」。这些正是单测该钉住的东西，且都能用临时目录毫秒级覆盖。
 *
 * 不 import Electron、不 sleep：只读/写注入的临时目录。
 *
 * ── 反向验证（已真跑并还原，见任务记录）────────────────────────────
 * 1) 把 shouldRecordVersion 的 `outcome === "ok"` 去掉（等价于「开始就记」）→
 *    「成功才记 / 失败不记」相关用例变红，其余基本不受影响。
 * 2) 注掉 restoreVersion 里的 onAudit 调用 → 审计那条断言变红。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
	AUDIT_CATEGORIES,
	AUDIT_CATEGORY_LABELS,
	AUDIT_OUTCOME_LABELS,
	readAuditRecords,
	writeAuditRecord,
} from "../../src/main/daemon/audit.js";
import {
	VERSION_LIST_MAX_FILES,
	VERSION_MAX_BYTES,
	VERSION_MAX_PER_FILE,
	listVersionFiles,
	readVersionContent,
	readVersionFile,
	recordVersion,
	restoreVersion,
	shouldRecordVersion,
	versionKeyOf,
} from "../../src/main/daemon/version-store.js";

let roots = [];

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), "zerowork-versions-"));
	roots.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of roots) rmSync(dir, { recursive: true, force: true });
	roots = [];
});

/** 版本目录下某 key 的 meta.json 读回（断言用）。 */
function readMeta(dir, key) {
	return JSON.parse(readFileSync(join(dir, key, "meta.json"), "utf8"));
}

describe("shouldRecordVersion —— 成功的「覆盖」才记，其它一律不记", () => {
	it("成功 + 覆盖 → 记", () => {
		expect(shouldRecordVersion({ outcome: "ok", changeType: "modified" })).toBe(true);
	});

	it("新建（created）不记 —— 没被覆盖就没有旧版可留", () => {
		expect(shouldRecordVersion({ outcome: "ok", changeType: "created" })).toBe(false);
	});

	it("失败不记 —— 文件没变，记下来就是一条假版本", () => {
		expect(shouldRecordVersion({ outcome: "error", changeType: "modified" })).toBe(false);
	});

	it("缺字段（stash 未命中）不记，不抛", () => {
		expect(shouldRecordVersion({ outcome: "ok" })).toBe(false);
		expect(shouldRecordVersion({ changeType: "modified" })).toBe(false);
		expect(shouldRecordVersion(undefined)).toBe(false);
	});
});

describe("recordVersion —— 记录判据与落盘", () => {
	it("常态：写下改动前全文，meta 带路径 / 时间 / 会话 / 工具 / 行数变化", () => {
		const dir = tempDir();
		const target = join(tempDir(), "周报.md");
		const result = recordVersion(
			{ path: target, content: "第一版\n第二行", at: 1234, sessionId: "s1", tool: "write", added: 3, removed: 1 },
			{ dir },
		);
		expect(result.recorded).toBe(true);
		expect(result.skipped).toBe(false);

		const key = versionKeyOf(resolve(target));
		const meta = readMeta(dir, key);
		expect(meta.path).toBe(resolve(target));
		expect(meta.skipped).toBe(0);
		expect(meta.versions).toHaveLength(1);
		expect(meta.versions[0]).toMatchObject({ at: 1234, sessionId: "s1", tool: "write", added: 3, removed: 1 });
		expect(readFileSync(join(dir, key, `${meta.versions[0].id}.txt`), "utf8")).toBe("第一版\n第二行");

		const file = readVersionFile(key, { dir });
		expect(file.versions[0].broken).toBe(false);
	});

	it("同一毫秒重复时 id 递增到不冲突", () => {
		const dir = tempDir();
		const target = join(tempDir(), "a.md");
		recordVersion({ path: target, content: "a", at: 5000 }, { dir });
		recordVersion({ path: target, content: "b", at: 5000 }, { dir });
		const file = readVersionFile(versionKeyOf(resolve(target)), { dir });
		expect(file.versions.map((v) => v.id)).toEqual(["5000", "5001"]);
	});

	it("二进制（前 8 KiB 含 NUL）整条跳过，skipped +1，不落内容文件", () => {
		const dir = tempDir();
		const target = join(tempDir(), "blob.bin");
		const result = recordVersion({ path: target, content: "PNG\0\x01\x02rest", at: 1 }, { dir });
		expect(result.recorded).toBe(false);
		expect(result.skipped).toBe(true);
		expect(result.reason).toBe("binary");

		const key = versionKeyOf(resolve(target));
		const meta = readMeta(dir, key);
		expect(meta.skipped).toBe(1);
		expect(meta.versions).toHaveLength(0);
		// 被跳过的文件仍出现在清单里（界面要能说「这次没留下版本」，不静默）。
		const { files } = listVersionFiles({ dir });
		expect(files.map((f) => f.key)).toContain(key);
		expect(files.find((f) => f.key === key)).toMatchObject({ count: 0, skipped: 1 });
	});

	it("超 1 MiB 整条跳过且 skipped +1（已有版本时旧版本不受影响）", () => {
		const dir = tempDir();
		const target = join(tempDir(), "big.md");
		recordVersion({ path: target, content: "小内容", at: 10 }, { dir });
		const huge = "x".repeat(VERSION_MAX_BYTES + 1);
		const result = recordVersion({ path: target, content: huge, at: 11 }, { dir });
		expect(result.recorded).toBe(false);
		expect(result.reason).toBe("too-large");
		expect(result.size).toBeGreaterThan(VERSION_MAX_BYTES);

		const meta = readMeta(dir, versionKeyOf(resolve(target)));
		expect(meta.skipped).toBe(1);
		expect(meta.versions).toHaveLength(1); // 只有那条小内容
	});

	it("边界正好 1 MiB 不跳过（判据是「超过」）", () => {
		const dir = tempDir();
		const target = join(tempDir(), "exact.md");
		const result = recordVersion({ path: target, content: "y".repeat(VERSION_MAX_BYTES), at: 1 }, { dir });
		expect(result.recorded).toBe(true);
	});

	it(`超出 ${VERSION_MAX_PER_FILE} 版丢最旧，且连内容文件一起删`, () => {
		const dir = tempDir();
		const target = join(tempDir(), "log.txt");
		for (let i = 0; i < VERSION_MAX_PER_FILE + 1; i++) {
			recordVersion({ path: target, content: `v${i}`, at: 1000 + i }, { dir });
		}
		const key = versionKeyOf(resolve(target));
		const meta = readMeta(dir, key);
		expect(meta.versions).toHaveLength(VERSION_MAX_PER_FILE);
		expect(meta.versions[0].id).toBe("1001"); // "1000" 被丢
		expect(meta.versions.at(-1).id).toBe(String(1000 + VERSION_MAX_PER_FILE));
		// 丢的是版本、也要丢内容文件，否则磁盘会无声地涨。
		expect(existsSync(join(dir, key, "1000.txt"))).toBe(false);
		expect(existsSync(join(dir, key, "1001.txt"))).toBe(true);
	});

	it("非法入参不记也不抛（没路径 / 非字符串内容 / 非对象）", () => {
		const dir = tempDir();
		expect(recordVersion({ content: "x" }, { dir }).reason).toBe("no-path");
		expect(recordVersion({ path: "/tmp/x", content: 42 }, { dir }).reason).toBe("no-content");
		expect(recordVersion(null, { dir }).reason).toBe("bad-input");
	});
});

describe("坏数据一律降级、不崩", () => {
	it("meta.json 损坏：该文件不进清单，读它返回 unknown；随后仍能重新记", () => {
		const dir = tempDir();
		const target = join(tempDir(), "broken.md");
		const key = versionKeyOf(resolve(target));
		mkdirSync(join(dir, key), { recursive: true });
		writeFileSync(join(dir, key, "meta.json"), "{ 这不是 JSON");

		expect(listVersionFiles({ dir }).files).toEqual([]);
		expect(readVersionFile(key, { dir })).toBeUndefined();
		expect(readVersionContent(key, "1", { dir })).toEqual({ ok: false, reason: "unknown" });

		// 坏 meta 当空：重新记一版要能成立（= 从零开始，不抛）。
		const result = recordVersion({ path: target, content: "新内容", at: 7 }, { dir });
		expect(result.recorded).toBe(true);
		expect(readMeta(dir, key).versions).toHaveLength(1);
	});

	it("某个版本正文缺失：该版标 broken 且不可读，其余版本照常返回", () => {
		const dir = tempDir();
		const target = join(tempDir(), "多版.md");
		recordVersion({ path: target, content: "一", at: 1 }, { dir });
		recordVersion({ path: target, content: "二", at: 2 }, { dir });
		const key = versionKeyOf(resolve(target));
		rmSync(join(dir, key, "1.txt")); // 制造「正文缺失」

		const file = readVersionFile(key, { dir });
		expect(file.versions.map((v) => v.broken)).toEqual([true, false]);
		expect(readVersionContent(key, "1", { dir })).toEqual({ ok: false, reason: "missing" });
		expect(readVersionContent(key, "2", { dir })).toMatchObject({ ok: true, content: "二" });
	});

	it("meta 顶层结构不符（数组 / 缺 path）当空", () => {
		const dir = tempDir();
		const key = versionKeyOf("/tmp/whatever.md");
		mkdirSync(join(dir, key), { recursive: true });
		writeFileSync(join(dir, key, "meta.json"), JSON.stringify(["not", "an", "object"]));
		expect(readVersionFile(key, { dir })).toBeUndefined();

		// 缺 path：这份 meta 无法指向任何文件，当空（不是「一个没有版本的合法文件」）。
		writeFileSync(join(dir, key, "meta.json"), JSON.stringify({ skipped: 0, versions: [] }));
		expect(readVersionFile(key, { dir })).toBeUndefined();
	});

	it("存储目录不存在 → 空清单（空态，不是错误）", () => {
		const dir = join(tempDir(), "还没有这个目录", "versions");
		expect(listVersionFiles({ dir })).toEqual({ files: [], truncated: false });
	});
});

describe("listVersionFiles —— 排序、字段与截断", () => {
	it("按最后改动时间倒序；字段齐全（name / dir / count / exists / lastSessionId / lastTool）", () => {
		const dir = tempDir();
		const root = tempDir();
		const a = join(root, "a.txt");
		const b = join(root, "sub", "b.txt");
		recordVersion({ path: a, content: "a1", at: 100, sessionId: "sA", tool: "write" }, { dir });
		recordVersion({ path: a, content: "a2", at: 300, sessionId: "sA2", tool: "edit" }, { dir });
		recordVersion({ path: b, content: "b1", at: 200, sessionId: "sB", tool: "write" }, { dir });
		writeFileSync(a, "a-now"); // 让 exists=true

		const { files, truncated } = listVersionFiles({ dir });
		expect(truncated).toBe(false);
		expect(files.map((f) => f.path)).toEqual([resolve(a), resolve(b)]);
		expect(files[0]).toMatchObject({
			name: "a.txt",
			dir: resolve(root),
			count: 2,
			skipped: 0,
			lastAt: 300,
			lastSessionId: "sA2",
			lastTool: "edit",
			exists: true,
		});
		expect(files[1]).toMatchObject({ name: "b.txt", dir: resolve(root, "sub"), exists: false });
	});

	it(`超过 ${VERSION_LIST_MAX_FILES} 个文件置 truncated:true 且只留最近的`, () => {
		const dir = tempDir();
		const total = VERSION_LIST_MAX_FILES + 5;
		for (let i = 0; i < total; i++) {
			const key = versionKeyOf(`/p/${i}`);
			mkdirSync(join(dir, key), { recursive: true });
			writeFileSync(
				join(dir, key, "meta.json"),
				JSON.stringify({ path: `/p/${i}`, skipped: 0, versions: [{ id: "1", at: i, size: 1 }] }),
			);
		}
		const { files, truncated } = listVersionFiles({ dir });
		expect(truncated).toBe(true);
		expect(files).toHaveLength(VERSION_LIST_MAX_FILES);
		expect(files[0].lastAt).toBe(total - 1); // 最近的在前
	});
});

describe("restoreVersion —— 还原写回、先留后改、逐字节相同不写新版本", () => {
	function seed() {
		const dir = tempDir();
		const file = join(tempDir(), "表格.csv");
		// 记一版「旧内容」，然后把磁盘改成「新内容」——还原应把它换回旧内容。
		recordVersion({ path: file, content: "旧内容", at: 100, sessionId: "s1", tool: "write" }, { dir });
		writeFileSync(file, "新内容");
		return { dir, file, key: versionKeyOf(resolve(file)) };
	}

	it("还原写回：磁盘内容变回目标版本", () => {
		const { dir, file, key } = seed();
		const onAudit = vi.fn();
		const result = restoreVersion(key, "100", { dir, onAudit });
		expect(result.ok).toBe(true);
		expect(result.unchanged).toBe(false);
		expect(readFileSync(file, "utf8")).toBe("旧内容");
	});

	it("还原也留一版：当前内容先被存成一条 tool=restore 的新版本（先留后改）", () => {
		const { dir, file, key } = seed();
		restoreVersion(key, "100", { dir });
		const meta = readMeta(dir, key);
		expect(meta.versions).toHaveLength(2);
		const restored = meta.versions.at(-1);
		expect(restored.tool).toBe("restore");
		// 新版本的正文 = 还原前的磁盘内容（「新内容」），所以还原本身也能再退回去。
		expect(readFileSync(join(dir, key, `${restored.id}.txt`), "utf8")).toBe("新内容");
		expect(readFileSync(file, "utf8")).toBe("旧内容");
	});

	it("逐字节相同：不写新版本、unchanged:true、不写审计", () => {
		const { dir, file, key } = seed();
		writeFileSync(file, "旧内容"); // 磁盘已与目标一致
		const onAudit = vi.fn();
		const result = restoreVersion(key, "100", { dir, onAudit });
		expect(result.ok).toBe(true);
		expect(result.unchanged).toBe(true);
		expect(readMeta(dir, key).versions).toHaveLength(1);
		expect(onAudit).not.toHaveBeenCalled();
	});

	it("还原成功写一条 file/restored 审计（onAudit 注入）", () => {
		const { dir, key } = seed();
		const onAudit = vi.fn();
		restoreVersion(key, "100", { dir, onAudit });
		expect(onAudit).toHaveBeenCalledTimes(1);
		const record = onAudit.mock.calls[0][0];
		expect(record).toMatchObject({ category: "file", outcome: "restored" });
		expect(record.detail).toContain("表格.csv");
		expect(record.detail).toContain("已先存为一条新版本");
	});
});

describe("restoreVersion —— 四种拒绝（宁可拒绝，也不静默降级）", () => {
	function seed() {
		const dir = tempDir();
		const file = join(tempDir(), "f.md");
		recordVersion({ path: file, content: "old", at: 100, sessionId: "s1", tool: "write" }, { dir });
		writeFileSync(file, "new");
		return { dir, file, key: versionKeyOf(resolve(file)) };
	}

	it("key 不在存储里 → unknown", () => {
		const dir = tempDir();
		const result = restoreVersion(versionKeyOf("/p/none.md"), "1", { dir });
		expect(result).toMatchObject({ ok: false, reason: "unknown" });
	});

	it("id 不在 meta 里 → no-such-version", () => {
		const { dir, key } = seed();
		expect(restoreVersion(key, "999", { dir })).toMatchObject({ ok: false, reason: "no-such-version" });
	});

	it("目标版本正文缺失 → missing，带逃生指引", () => {
		const { dir, key } = seed();
		rmSync(join(dir, key, "100.txt"));
		const result = restoreVersion(key, "100", { dir });
		expect(result).toMatchObject({ ok: false, reason: "missing" });
		expect(result.message).toContain("无法还原");
	});

	it("会话在跑 → running（判据由注入的 isSessionRunning 给出）", () => {
		const { dir, key } = seed();
		const running = restoreVersion(key, "100", { dir, isSessionRunning: (id) => id === "s1" });
		expect(running).toMatchObject({ ok: false, reason: "running" });
		// 判据为假时才放行。
		const ok = restoreVersion(key, "100", { dir, isSessionRunning: () => false });
		expect(ok.ok).toBe(true);
	});

	it("写盘失败 → write-failed，带原始错误摘要", () => {
		const dir = tempDir();
		// 把 meta.path 指到一个**目录**上：写回时 EISDIR/EPERM → write-failed。
		const targetDir = tempDir();
		const key = versionKeyOf(resolve(targetDir));
		mkdirSync(join(dir, key), { recursive: true });
		writeFileSync(join(dir, key, "meta.json"), JSON.stringify({
			path: resolve(targetDir),
			skipped: 0,
			versions: [{ id: "100", at: 100, size: 2 }],
		}));
		writeFileSync(join(dir, key, "100.txt"), "old");
		const result = restoreVersion(key, "100", { dir });
		expect(result).toMatchObject({ ok: false, reason: "write-failed" });
		expect(typeof result.message).toBe("string");
	});
});

describe("审计契约：新类别 / 新结果不得被 parseRecord 丢掉", () => {
	it("file 类别与 restored 结果已登记，且写进去能被读回", () => {
		expect(AUDIT_CATEGORY_LABELS.file).toBe("文件改动");
		expect(AUDIT_OUTCOME_LABELS.restored).toBe("已还原");
		expect(AUDIT_CATEGORIES).toContain("file");

		const dir = tempDir();
		writeAuditRecord({ category: "file", outcome: "restored", detail: "用户把 表格.csv 还原到 10-15 12:00:00" }, dir);
		const { records } = readAuditRecords({ dir });
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ category: "file", outcome: "restored" });
	});
});
