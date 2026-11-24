/**
 * 二进制版本快照（#480）的单测：`recordBinaryVersion` / `readVersionBytes` /
 * `readVersionFile` 的 binary 标记 / `restoreVersion` 的字节分支。
 *
 * 为什么值得单独测：docx 写回前要「版本先行」（#458），而旧的记录通道把前 8 KiB
 * 含 NUL 的内容一律判 binary 跳过 —— 于是 docx 根本没有旧版本可退。这条链路写错
 * 不会崩，只会让用户「以为能退回去、其实退不回去」，正是单测该钉住的那类静默失效。
 *
 * 全部用注入的临时目录，不 import Electron、不 sleep。
 *
 * ── 反向验证（已真跑并还原）──────────────────────────────────────
 * 1) 把二进制内容按 `.txt` 写出（commitVersion 的扩展名分支写反）→
 *    「二进制往返」「共存」若干用例变红（broken / missing）。
 * 2) 去掉 readVersionContent 的 `binary` 守卫（按 UTF-8 解码返回乱码）→
 *    「二进制不提供文本预览」那条变红。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
	VERSION_MAX_BINARY_BYTES,
	VERSION_MAX_PER_FILE,
	listVersionFiles,
	readVersionBytes,
	readVersionContent,
	readVersionFile,
	recordBinaryVersion,
	recordVersion,
	restoreVersion,
	versionKeyOf,
} from "../../src/main/daemon/version-store.js";

let roots = [];

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), "zerowork-version-binary-"));
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

/** 一段像 docx 的字节：ZIP 本地文件头签名 + 若干 NUL + 非 UTF-8 高位字节。 */
function docxBytes(salt = 0) {
	return Buffer.from([
		0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00,
		0xff, 0xd8, 0x00, 0x7b, 0x80, 0x81, salt & 0xff,
	]);
}

describe("recordBinaryVersion —— 二进制往返", () => {
	it("记录后：meta 标 binary / 落 .bin / 字节一致 / 可读回", () => {
		const dir = tempDir();
		const target = join(tempDir(), "合同.docx");
		const bytes = docxBytes(1);
		const result = recordBinaryVersion(
			{ path: target, bytes, at: 100, sessionId: "s1", tool: "write", added: 2, removed: 1 },
			{ dir },
		);
		expect(result).toMatchObject({ recorded: true, skipped: false, id: "100" });

		const key = versionKeyOf(resolve(target));
		const meta = readMeta(dir, key);
		expect(meta.versions).toHaveLength(1);
		const entry = meta.versions[0];
		expect(entry).toMatchObject({
			id: "100",
			at: 100,
			size: bytes.length,
			binary: true,
			sessionId: "s1",
			tool: "write",
			added: 2,
			removed: 1,
		});
		expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
		// 内容在 .bin：按 UTF-8 写进 .txt 会丢字节（反向验证正是这么注入的）。
		expect(existsSync(join(dir, key, "100.bin"))).toBe(true);
		expect(existsSync(join(dir, key, "100.txt"))).toBe(false);
		expect(readFileSync(join(dir, key, "100.bin")).equals(bytes)).toBe(true);

		const file = readVersionFile(key, { dir });
		expect(file.versions[0]).toMatchObject({ binary: true, broken: false });
		expect(readVersionBytes(key, "100", { dir })).toMatchObject({ ok: true, at: 100 });
		expect(readVersionBytes(key, "100", { dir }).bytes.equals(bytes)).toBe(true);

		const { files } = listVersionFiles({ dir });
		expect(files.find((f) => f.key === key)).toMatchObject({ count: 1, versionId: "100", binary: true });
	});

	it("二进制版本不进文本预览：readVersionContent 返回 binary，不吐乱码", () => {
		const dir = tempDir();
		const target = join(tempDir(), "报告.docx");
		recordBinaryVersion({ path: target, bytes: docxBytes(2), at: 1 }, { dir });
		const key = versionKeyOf(resolve(target));
		expect(readVersionContent(key, "1", { dir })).toEqual({ ok: false, reason: "binary" });
	});

	it("还原按字节写回，且把当前内容先存成一条二进制版本（先留后改）", () => {
		const dir = tempDir();
		const target = join(tempDir(), "方案.docx");
		const oldBytes = docxBytes(3);
		recordBinaryVersion({ path: target, bytes: oldBytes, at: 100, sessionId: "s1", tool: "write" }, { dir });
		const newBytes = docxBytes(4);
		writeFileSync(target, newBytes);

		const key = versionKeyOf(resolve(target));
		const onAudit = vi.fn();
		const result = restoreVersion(key, "100", { dir, onAudit });
		expect(result).toMatchObject({ ok: true, unchanged: false });
		expect(readFileSync(target).equals(oldBytes)).toBe(true);

		const meta = readMeta(dir, key);
		expect(meta.versions).toHaveLength(2);
		const kept = meta.versions.at(-1);
		expect(kept).toMatchObject({ tool: "restore", binary: true, size: newBytes.length });
		expect(readFileSync(join(dir, key, `${kept.id}.bin`)).equals(newBytes)).toBe(true);
		expect(onAudit).toHaveBeenCalledTimes(1);
		expect(onAudit.mock.calls[0][0]).toMatchObject({ category: "file", outcome: "restored" });
	});

	it("当前磁盘已与目标逐字节相同：unchanged、不写新版本、不写审计", () => {
		const dir = tempDir();
		const target = join(tempDir(), "一致.docx");
		const bytes = docxBytes(5);
		recordBinaryVersion({ path: target, bytes, at: 100 }, { dir });
		writeFileSync(target, bytes);
		const key = versionKeyOf(resolve(target));
		const onAudit = vi.fn();
		const result = restoreVersion(key, "100", { dir, onAudit });
		expect(result).toMatchObject({ ok: true, unchanged: true });
		expect(readMeta(dir, key).versions).toHaveLength(1);
		expect(onAudit).not.toHaveBeenCalled();
	});

	it.skipIf(process.platform === "win32")("还原写回保留原文件的权限位", () => {
		const dir = tempDir();
		const target = join(tempDir(), "权限.docx");
		recordBinaryVersion({ path: target, bytes: docxBytes(6), at: 1 }, { dir });
		writeFileSync(target, docxBytes(7));
		// chmod 在 POSIX 生效；Windows 上只有只读位，断言无意义（跳过并留痕）。
		chmodSync(target, 0o640);
		const key = versionKeyOf(resolve(target));
		expect(restoreVersion(key, "1", { dir }).ok).toBe(true);
		expect(statSync(target).mode & 0o777).toBe(0o640);
	});
});

describe("文本版本回归 —— 既有行为不变", () => {
	it("文本仍写 .txt、无 binary 标记、读回/还原与之前一致", () => {
		const dir = tempDir();
		const target = join(tempDir(), "周报.md");
		recordVersion({ path: target, content: "旧内容", at: 100, sessionId: "s1", tool: "write" }, { dir });
		const key = versionKeyOf(resolve(target));
		const file = readVersionFile(key, { dir });
		expect(file.versions[0].binary).toBeUndefined();
		expect(file.versions[0].broken).toBe(false);
		expect(existsSync(join(dir, key, "100.txt"))).toBe(true);
		expect(readVersionContent(key, "100", { dir })).toMatchObject({ ok: true, content: "旧内容" });
		// 文本也能按字节读（UTF-8 编码），但还原仍走文本路径。
		expect(readVersionBytes(key, "100", { dir }).bytes.toString("utf8")).toBe("旧内容");

		writeFileSync(target, "新内容");
		expect(restoreVersion(key, "100", { dir }).ok).toBe(true);
		expect(readFileSync(target, "utf8")).toBe("旧内容");
		expect(readMeta(dir, key).versions.at(-1).binary).toBeUndefined();
	});

	it("旧 meta 没有 binary 字段 = 文本（向后兼容），内容仍从 .txt 读", () => {
		const dir = tempDir();
		const root = tempDir();
		const target = join(root, "旧条目.md");
		const key = versionKeyOf(resolve(target));
		mkdirSync(join(dir, key), { recursive: true });
		writeFileSync(join(dir, key, "meta.json"), JSON.stringify({
			path: resolve(target),
			skipped: 0,
			versions: [{ id: "1", at: 1, size: 2 }],
		}));
		writeFileSync(join(dir, key, "1.txt"), "旧");
		expect(readVersionFile(key, { dir }).versions[0]).toMatchObject({ broken: false });
		expect(readVersionContent(key, "1", { dir })).toMatchObject({ ok: true, content: "旧" });
	});
});

describe("二进制与文本共存同一 key", () => {
	it("同一文件的三个版本（文/二进制/文本）各自按自己的扩展名读回", () => {
		const dir = tempDir();
		const target = join(tempDir(), "混合.bin");
		recordVersion({ path: target, content: "第一版", at: 1 }, { dir });
		recordBinaryVersion({ path: target, bytes: docxBytes(8), at: 2 }, { dir });
		recordVersion({ path: target, content: "第三版", at: 3 }, { dir });
		const key = versionKeyOf(resolve(target));
		const meta = readMeta(dir, key);
		expect(meta.versions.map((v) => v.id)).toEqual(["1", "2", "3"]);

		const file = readVersionFile(key, { dir });
		expect(file.versions.map((v) => v.binary === true)).toEqual([false, true, false]);
		expect(file.versions.map((v) => v.broken)).toEqual([false, false, false]);
		expect(readVersionContent(key, "1", { dir })).toMatchObject({ ok: true, content: "第一版" });
		expect(readVersionContent(key, "2", { dir })).toEqual({ ok: false, reason: "binary" });
		expect(readVersionBytes(key, "2", { dir }).bytes.equals(docxBytes(8))).toBe(true);
		expect(readVersionContent(key, "3", { dir })).toMatchObject({ ok: true, content: "第三版" });
	});

	it("裁剪到上限时按条目自己的 binary 标记删对扩展名（不留下孤儿 .bin）", () => {
		const dir = tempDir();
		const target = join(tempDir(), "轮换.docx");
		// 第一版是二进制，其余是文本 —— 被裁掉的最旧那版必须删 .bin 而不是 .txt。
		recordBinaryVersion({ path: target, bytes: docxBytes(9), at: 1 }, { dir });
		for (let i = 1; i < VERSION_MAX_PER_FILE; i += 1) {
			recordVersion({ path: target, content: `v${i}`, at: 1 + i }, { dir });
		}
		const key = versionKeyOf(resolve(target));
		expect(existsSync(join(dir, key, "1.bin"))).toBe(true);

		recordVersion({ path: target, content: "挤掉最旧", at: 999 }, { dir });
		expect(readMeta(dir, key).versions).toHaveLength(VERSION_MAX_PER_FILE);
		// 最旧的二进制版本被裁掉：连同它的 .bin 一起删。
		expect(existsSync(join(dir, key, "1.bin"))).toBe(false);
		// 被保留的文本版本内容文件不受影响。
		expect(existsSync(join(dir, key, "2.txt"))).toBe(true);
	});

	it("还原文本版本时，当前内容是二进制则按字节先存一版（不按 UTF-8 解成乱码）", () => {
		const dir = tempDir();
		const target = join(tempDir(), "换型.bin");
		recordVersion({ path: target, content: "文本版", at: 1 }, { dir });
		const nowBytes = docxBytes(10);
		writeFileSync(target, nowBytes);

		const key = versionKeyOf(resolve(target));
		expect(restoreVersion(key, "1", { dir }).ok).toBe(true);
		expect(readFileSync(target, "utf8")).toBe("文本版");

		const meta = readMeta(dir, key);
		const kept = meta.versions.at(-1);
		expect(kept).toMatchObject({ tool: "restore", binary: true, size: nowBytes.length });
		expect(readFileSync(join(dir, key, `${kept.id}.bin`)).equals(nowBytes)).toBe(true);
	});
});

describe("二进制上限 —— 超限如实 skipped，不假装记录", () => {
	it(`超过 ${VERSION_MAX_BINARY_BYTES} 字节：skipped +1、不落内容文件`, () => {
		const dir = tempDir();
		const target = join(tempDir(), "超大.docx");
		const huge = Buffer.alloc(VERSION_MAX_BINARY_BYTES + 1);
		const result = recordBinaryVersion({ path: target, bytes: huge, at: 1 }, { dir });
		expect(result).toMatchObject({ recorded: false, skipped: true, reason: "too-large" });
		expect(result.size).toBe(VERSION_MAX_BINARY_BYTES + 1);

		const key = versionKeyOf(resolve(target));
		const meta = readMeta(dir, key);
		expect(meta.skipped).toBe(1);
		expect(meta.versions).toHaveLength(0);
		// 只留 meta.json：没有内容文件，也没有「看起来成功」的条目。
		expect(readdirSync(join(dir, key))).toEqual(["meta.json"]);
		// 被跳过的文件仍出现在清单里（界面要能说「这次没留下版本」）。
		expect(listVersionFiles({ dir }).files.find((f) => f.key === key)).toMatchObject({ count: 0, skipped: 1 });
	});

	it("边界正好等于上限不跳过（判据是「超过」）", () => {
		const dir = tempDir();
		const target = join(tempDir(), "正好.docx");
		const exact = Buffer.alloc(VERSION_MAX_BINARY_BYTES, 1);
		const result = recordBinaryVersion({ path: target, bytes: exact, at: 1 }, { dir });
		expect(result.recorded).toBe(true);
		const key = versionKeyOf(resolve(target));
		expect(readFileSync(join(dir, key, "1.bin")).length).toBe(VERSION_MAX_BINARY_BYTES);
	});

	it("非法入参不记也不抛（没路径 / bytes 不是字节 / 非对象）", () => {
		const dir = tempDir();
		expect(recordBinaryVersion({ bytes: docxBytes() }, { dir }).reason).toBe("no-path");
		expect(recordBinaryVersion({ path: "/tmp/x", bytes: "不是字节" }, { dir }).reason).toBe("no-bytes");
		expect(recordBinaryVersion(null, { dir }).reason).toBe("bad-input");
	});

	it("Uint8Array 也接受（不只是 Buffer）", () => {
		const dir = tempDir();
		const target = join(tempDir(), "u8.docx");
		const bytes = new Uint8Array(docxBytes(11));
		expect(recordBinaryVersion({ path: target, bytes, at: 1 }, { dir }).recorded).toBe(true);
		const key = versionKeyOf(resolve(target));
		expect(readFileSync(join(dir, key, "1.bin")).equals(Buffer.from(bytes))).toBe(true);
	});
});

describe("坏数据一律降级、不炸", () => {
	it("meta.json 损坏：读它返回 unknown；随后仍能重新记一版二进制", () => {
		const dir = tempDir();
		const target = join(tempDir(), "坏meta.docx");
		const key = versionKeyOf(resolve(target));
		mkdirSync(join(dir, key), { recursive: true });
		writeFileSync(join(dir, key, "meta.json"), "{ 这不是 JSON");

		expect(readVersionFile(key, { dir })).toBeUndefined();
		expect(readVersionBytes(key, "1", { dir })).toEqual({ ok: false, reason: "unknown" });

		expect(recordBinaryVersion({ path: target, bytes: docxBytes(12), at: 7 }, { dir }).recorded).toBe(true);
		expect(readMeta(dir, key).versions).toHaveLength(1);
	});

	it("单条坏条目丢它自己、不作废整份 meta（二进制与文本的好条目照常）", () => {
		const dir = tempDir();
		const root = tempDir();
		const target = join(root, "条目.docx");
		const key = versionKeyOf(resolve(target));
		mkdirSync(join(dir, key), { recursive: true });
		writeFileSync(join(dir, key, "meta.json"), JSON.stringify({
			path: resolve(target),
			skipped: 0,
			versions: [
				{ id: "1", at: 1, size: 2, binary: true, sha256: "a".repeat(64) },
				{ at: 2, size: 3 }, // 缺 id：丢它自己
				{ id: "3", at: 3, size: 2 },
			],
		}));
		writeFileSync(join(dir, key, "1.bin"), docxBytes(13));
		writeFileSync(join(dir, key, "3.txt"), "文本");

		const file = readVersionFile(key, { dir });
		expect(file.versions.map((v) => v.id)).toEqual(["1", "3"]);
		expect(file.versions.map((v) => v.broken)).toEqual([false, false]);
		expect(readVersionBytes(key, "1", { dir }).bytes.equals(docxBytes(13))).toBe(true);
	});

	it("二进制正文缺失：该版标 broken、读/还原都返回 missing（带逃生指引）", () => {
		const dir = tempDir();
		const target = join(tempDir(), "丢内容.docx");
		recordBinaryVersion({ path: target, bytes: docxBytes(14), at: 100 }, { dir });
		const key = versionKeyOf(resolve(target));
		rmSync(join(dir, key, "100.bin"));

		expect(readVersionFile(key, { dir }).versions[0].broken).toBe(true);
		expect(readVersionBytes(key, "100", { dir })).toEqual({ ok: false, reason: "missing" });
		const result = restoreVersion(key, "100", { dir });
		expect(result).toMatchObject({ ok: false, reason: "missing" });
		expect(result.message).toContain("无法还原");
	});
});

describe("还原失败不得破坏当前文件", () => {
	it("目标路径是目录 → write-failed，目录与里面的文件原样保留、不留临时文件", () => {
		const dir = tempDir();
		const root = tempDir();
		const target = join(root, "目标");
		mkdirSync(target);
		writeFileSync(join(target, "keep.txt"), "keep");

		const key = versionKeyOf(resolve(target));
		mkdirSync(join(dir, key), { recursive: true });
		writeFileSync(join(dir, key, "meta.json"), JSON.stringify({
			path: resolve(target),
			skipped: 0,
			versions: [{ id: "100", at: 100, size: 8, binary: true }],
		}));
		writeFileSync(join(dir, key, "100.bin"), docxBytes(15));

		const result = restoreVersion(key, "100", { dir });
		expect(result).toMatchObject({ ok: false, reason: "write-failed" });
		expect(typeof result.message).toBe("string");

		// 目标（目录）与里面的文件都没被动过；临时文件已清理。
		expect(existsSync(target)).toBe(true);
		expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("keep");
		expect(readdirSync(root)).toEqual(["目标"]);
		// 读写都没发生，不该多出一条「先留后改」的版本。
		expect(readMeta(dir, key).versions).toHaveLength(1);
	});
});
