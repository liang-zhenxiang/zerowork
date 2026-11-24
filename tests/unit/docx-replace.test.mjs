/**
 * docx_replace 工具与 docx 修订建议（#481）的单测。
 *
 * 这一层最容易「静默做错」的形态，每条都有对应用例：
 * - 路径 / 扩展名 / 体积未被拦住 → 工具成了工作区外的任意文件改写入口；
 * - 修订模式开着却写了盘（或反过来）→ 用户以为要审、文件已经变了；
 * - 版本记录失败还继续写 → 「可从文件历史还原」这句承诺不成立；
 * - 哈希守卫缺失 → ensure 期间用户手改的内容被覆盖；
 * - 审计记了 find / replace 正文 → 审计日志成了文档内容的第二个副本。
 *
 * 真跑引擎的那组只在有 python3 / python 时执行（与 docx-patch.test.mjs 同一口径），
 * 没有解释器时显式跳过而不是静默变绿。
 *
 * ── 反向验证（已真跑并还原，见交付报告）──────────────────────────────────
 * 1) 去掉 ensure 之后的哈希守卫 → 「ensure 期间原文变了」用例变红；
 * 2) 版本记录失败不中止、继续调 patch → 「版本失败中止」用例变红。
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
	DOCX_PART_DEFAULT,
	applyDocxProposal,
	buildDocxProposal,
	checkFreshness,
	listProposals,
	parseProposal,
	readProposal,
	rejectProposal,
	saveProposal,
	sha256Bytes,
	summarize,
} from "../../src/main/daemon/doc-edits.js";
import {
	DOCX_REPLACE_MAX_BYTES,
	DOCX_REPLACE_TOOL_NAME,
	createDocxReplaceTool,
} from "../../src/main/daemon/docx-replace.js";
import { DocxPatchError } from "../../src/main/daemon/docx-patch.js";
import { decide, MUTATING } from "../../src/main/daemon/command-exec.js";
import { readVersionBytes, readVersionFile, versionKeyOf } from "../../src/main/daemon/version-store.js";

const ROOT = resolve(import.meta.dirname, "../..");
const FIXTURE = join(ROOT, "tests", "fixtures", "docx-revision", "a-styles.docx");
/** 夹具正文里唯一出现的一段原文（与 docx-patch.test.mjs 同一条）。 */
const FIND = "本季度营收";
const REPLACE = "本季度营业收入";

let roots = [];

function tempDir(prefix) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of roots) rmSync(dir, { recursive: true, force: true });
	roots = [];
});

function setup() {
	return {
		ws: tempDir("zerowork-docx-replace-ws-"),
		store: tempDir("zerowork-docx-replace-store-"),
		versions: tempDir("zerowork-docx-replace-versions-"),
		audit: tempDir("zerowork-docx-replace-audit-"),
	};
}

function seedDocx(ctx, name = "report.docx") {
	const absPath = join(ctx.ws, name);
	copyFileSync(FIXTURE, absPath);
	return absPath;
}

function bytesOf(path) {
	return readFileSync(path);
}

/** 注册工具并返回执行器 + 记录下来的调用痕迹。 */
function makeTool(ctx, overrides = {}) {
	const calls = { ensure: 0, patch: [], record: [] };
	const has = (key) => Object.prototype.hasOwnProperty.call(overrides, key);
	let registered;
	const options = {
		cwd: ctx.ws,
		engineDir: join(ROOT, "resources", "docx-engine"),
		getDocEditMode: () => false,
		getSessionId: () => "sess-docx-replace",
		docsDir: ctx.store,
		versionsDir: ctx.versions,
		auditDir: ctx.audit,
		now: () => 1_700_000_000_000,
		ensure: async () => {
			calls.ensure += 1;
			return { status: "ready", python: "python3" };
		},
		patch: async (req) => {
			calls.patch.push(req);
			return { part: req.part, entries: 1, changed: 1, bytesBefore: 100, bytesAfter: 120, otherEntriesUnchanged: true };
		},
		...overrides,
	};
	// 显式传 `recordBinaryVersion: void 0` = 用真实的版本记录（集成用例要读回字节）
	if (!has("recordBinaryVersion")) {
		options.recordBinaryVersion = (input, opts) => {
			calls.record.push({ input, opts });
			return { recorded: true, skipped: false, id: "v1", count: 1 };
		};
	}
	createDocxReplaceTool(options)({
		registerTool: (tool) => {
			registered = tool;
		},
	});
	return { tool: registered, options, calls };
}

async function run(tool, params) {
	const result = await tool.execute("call-1", params);
	expect(result.content).toHaveLength(1);
	return JSON.parse(result.content[0].text);
}

function proposalsIn(dir) {
	return listProposals({ dir }).entries;
}

function readAudit(dir) {
	const records = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".jsonl")) continue;
		for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
			if (line.trim() === "") continue;
			records.push(JSON.parse(line));
		}
	}
	return records;
}

describe("参数与目标校验 —— 拒绝面", () => {
	it("缺参数 / find 为空 / replace 为空 / find 与 replace 相同", async () => {
		const ctx = setup();
		const absPath = seedDocx(ctx);
		const { tool } = makeTool(ctx);
		await expect(run(tool, { path: absPath, find: FIND })).rejects.toThrow(/replace/);
		await expect(run(tool, { path: absPath, find: "", replace: REPLACE })).rejects.toThrow(/find/);
		await expect(run(tool, { path: absPath, find: FIND, replace: "" })).rejects.toThrow(/replace/);
		await expect(run(tool, { path: absPath, find: FIND, replace: FIND })).rejects.toThrow(/不会产生任何改动/);
		expect(proposalsIn(ctx.store)).toEqual([]);
	});

	it("工作区外的路径（.. 逃逸与绝对路径）一律拒绝", async () => {
		const ctx = setup();
		const outside = tempDir("zerowork-docx-replace-outside-");
		const outsideFile = join(outside, "x.docx");
		copyFileSync(FIXTURE, outsideFile);
		const { tool, calls } = makeTool(ctx);
		await expect(run(tool, { path: "../x.docx", find: FIND, replace: REPLACE })).rejects.toThrow(/工作区内/);
		await expect(run(tool, { path: outsideFile, find: FIND, replace: REPLACE })).rejects.toThrow(/工作区内/);
		expect(calls.ensure).toBe(0);
		expect(bytesOf(outsideFile)).toEqual(bytesOf(FIXTURE));
	});

	it("非 .docx 扩展名被拒绝", async () => {
		const ctx = setup();
		const txt = join(ctx.ws, "notes.md");
		writeFileSync(txt, "hello", "utf8");
		const { tool } = makeTool(ctx);
		await expect(run(tool, { path: txt, find: FIND, replace: REPLACE })).rejects.toThrow(/只接受 \.docx/);
	});

	it("不存在的文件与目录被拒绝", async () => {
		const ctx = setup();
		const { tool } = makeTool(ctx);
		await expect(run(tool, { path: join(ctx.ws, "missing.docx"), find: FIND, replace: REPLACE })).rejects.toThrow(
			/不存在/,
		);
		mkdirSync(join(ctx.ws, "folder.docx"));
		await expect(run(tool, { path: join(ctx.ws, "folder.docx"), find: FIND, replace: REPLACE })).rejects.toThrow(
			/不是普通文件/,
		);
	});

	it("超过 20 MiB 的文件在读取前被拒绝（稀疏文件，不真的写 20 MiB）", async () => {
		const ctx = setup();
		const big = join(ctx.ws, "big.docx");
		writeFileSync(big, Buffer.from("PK"));
		truncateSync(big, DOCX_REPLACE_MAX_BYTES + 1);
		expect(statSync(big).size).toBe(DOCX_REPLACE_MAX_BYTES + 1);
		const { tool, calls } = makeTool(ctx);
		await expect(run(tool, { path: big, find: FIND, replace: REPLACE })).rejects.toThrow(/20 MiB/);
		expect(calls.ensure).toBe(0);
	});
});

describe("修订模式开启 —— 只生成建议，不写盘、不启动 Python", () => {
	function revisionCtx(overrides = {}) {
		const ctx = setup();
		const absPath = seedDocx(ctx);
		const before = bytesOf(absPath);
		const { tool, calls } = makeTool(ctx, {
			getDocEditMode: () => true,
			ensure: async () => {
				throw new Error("修订模式下不该调用 ensure");
			},
			patch: async () => {
				throw new Error("修订模式下不该调用 patch");
			},
			...overrides,
		});
		return { ctx, absPath, before, tool, calls };
	}

	it("文件字节不变，回执带建议 id 且说明文件未修改", async () => {
		const { ctx, absPath, before, tool } = revisionCtx();
		const receipt = await run(tool, { path: absPath, find: FIND, replace: REPLACE });
		expect(receipt.type).toBe("docx_replace_suggestion");
		expect(receipt.id).toMatch(/^[a-z0-9]+-[a-f0-9]{6}$/);
		expect(receipt.path).toBe(absPath);
		expect(receipt.find).toBe(FIND);
		expect(receipt.replace).toBe(REPLACE);
		expect(receipt.message).toContain("文件尚未修改");
		expect(bytesOf(absPath)).toEqual(before);
		expect(proposalsIn(ctx.store)).toHaveLength(1);
	});

	it("建议字段完整（kind / part / baseSha256 / 来源会话 / 工具名）", async () => {
		const { ctx, absPath, before, tool } = revisionCtx();
		const receipt = await run(tool, { path: absPath, find: FIND, replace: REPLACE });
		const proposal = readProposal(receipt.id, { dir: ctx.store });
		expect(proposal).toMatchObject({
			kind: "docx",
			path: absPath,
			part: DOCX_PART_DEFAULT,
			find: FIND,
			replace: REPLACE,
			sessionId: "sess-docx-replace",
			toolName: DOCX_REPLACE_TOOL_NAME,
			createdAt: 1_700_000_000_000,
		});
		expect(proposal.baseSha256).toBe(sha256Bytes(before));
		// 文本建议的字段不该混进来
		expect(proposal.before).toBeUndefined();
		expect(proposal.hunks).toBeUndefined();
	});

	it("列表里是 kind:docx、一处替换；新鲜度按文件字节判定", async () => {
		const { ctx, absPath, tool } = revisionCtx();
		const receipt = await run(tool, { path: absPath, find: FIND, replace: REPLACE });
		const entry = proposalsIn(ctx.store)[0];
		expect(entry).toMatchObject({ id: receipt.id, kind: "docx", hunkCount: 1, added: 1, removed: 1, part: DOCX_PART_DEFAULT });
		const proposal = readProposal(receipt.id, { dir: ctx.store });
		expect(checkFreshness(proposal)).toMatchObject({ stale: false, missing: false });
	});
});

describe("修订模式关闭 —— 直接写回", () => {
	it("顺序固定：ensure → 留旧版本 → 引擎修补；回执与审计齐全", async () => {
		const ctx = setup();
		const absPath = seedDocx(ctx);
		const before = bytesOf(absPath);
		const order = [];
		const { tool, calls } = makeTool(ctx, {
			ensure: async () => {
				order.push("ensure");
				return { status: "ready", python: "/venv/python" };
			},
			recordBinaryVersion: (input, opts) => {
				order.push("version");
				calls.record.push({ input, opts });
				return { recorded: true, skipped: false, id: "v1", count: 1 };
			},
			patch: async (req) => {
				order.push("patch");
				calls.patch.push(req);
				return { part: req.part, entries: 1, changed: 1, bytesBefore: 200, bytesAfter: 240, otherEntriesUnchanged: true };
			},
		});

		const receipt = await run(tool, { path: absPath, find: FIND, replace: REPLACE });

		expect(order).toEqual(["ensure", "version", "patch"]);
		expect(receipt).toMatchObject({
			type: "docx_replace_result",
			path: absPath,
			part: DOCX_PART_DEFAULT,
			replaced: 1,
			bytesBefore: 200,
			bytesAfter: 240,
		});
		// 版本拿到的必须是「改前」的同一份字节
		expect(calls.record[0].input).toMatchObject({ path: absPath, sessionId: "sess-docx-replace", tool: "docx_replace" });
		expect(Buffer.compare(calls.record[0].input.bytes, before)).toBe(0);
		// 引擎入参：同一个文件进出、默认正文部件、find / replace 原样
		expect(calls.patch[0]).toMatchObject({
			python: "/venv/python",
			engineDir: join(ROOT, "resources", "docx-engine"),
			inputPath: absPath,
			outputPath: absPath,
			part: DOCX_PART_DEFAULT,
			find: FIND,
			replace: REPLACE,
		});
		// 成功路径不产生建议
		expect(proposalsIn(ctx.store)).toEqual([]);

		const audit = readAudit(ctx.audit);
		expect(audit).toHaveLength(1);
		expect(audit[0]).toMatchObject({ category: "file", outcome: "allowed" });
		expect(audit[0].detail).toContain("report.docx");
		expect(audit[0].detail).toContain("200 → 240");
		// 审计不含文档正文
		expect(audit[0].detail).not.toContain(FIND);
		expect(audit[0].detail).not.toContain(REPLACE);
	});

	it("真 recordBinaryVersion：旧字节可从文件历史逐字节读回", async () => {
		const ctx = setup();
		const absPath = seedDocx(ctx);
		const before = bytesOf(absPath);
		const { tool } = makeTool(ctx, {
			// 用真实的版本记录（不注入）
			recordBinaryVersion: void 0,
		});
		await run(tool, { path: absPath, find: FIND, replace: REPLACE });
		const key = versionKeyOf(absPath);
		const file = readVersionFile(key, { dir: ctx.versions });
		expect(file.versions).toHaveLength(1);
		expect(file.versions[0]).toMatchObject({ binary: true, tool: "docx_replace", sessionId: "sess-docx-replace" });
		const restored = readVersionBytes(key, file.versions[0].id, { dir: ctx.versions });
		expect(restored.ok).toBe(true);
		expect(Buffer.compare(restored.bytes, before)).toBe(0);
	});
});

describe("直接写回的失败中止 —— 任一步失败都不改原文件", () => {
	function directCtx(overrides = {}) {
		const ctx = setup();
		const absPath = seedDocx(ctx);
		const before = bytesOf(absPath);
		const { tool, calls } = makeTool(ctx, overrides);
		return { ctx, absPath, before, tool, calls };
	}

	it("运行时未就绪：不记版本、不调引擎，审计 runtime/failed", async () => {
		const { ctx, absPath, before, tool, calls } = directCtx({
			ensure: async () => ({ status: "failed", phase: "download", error: "下载超时" }),
		});
		await expect(run(tool, { path: absPath, find: FIND, replace: REPLACE })).rejects.toThrow(/环境未就绪/);
		expect(calls.record).toHaveLength(0);
		expect(calls.patch).toHaveLength(0);
		expect(bytesOf(absPath)).toEqual(before);
		const audit = readAudit(ctx.audit);
		expect(audit[0]).toMatchObject({ category: "runtime", outcome: "failed" });
		expect(audit[0].detail).toContain("下载超时");
	});

	it("哈希守卫：ensure 期间原文变了 → 中止，不记版本、不改文件", async () => {
		const { ctx, absPath, before, tool, calls } = directCtx({
			ensure: async () => {
				// 模拟用户在安装运行时期间手改了这份文档
				writeFileSync(absPath, Buffer.concat([before, Buffer.from("user-edit")]));
				return { status: "ready", python: "/venv/python" };
			},
		});
		await expect(run(tool, { path: absPath, find: FIND, replace: REPLACE })).rejects.toThrow(/原文已变化/);
		expect(calls.record).toHaveLength(0);
		expect(calls.patch).toHaveLength(0);
		const audit = readAudit(ctx.audit);
		expect(audit[0]).toMatchObject({ category: "file", outcome: "failed" });
		expect(audit[0].detail).toContain("原文在准备运行时期间发生变化");
	});

	it("版本记录失败 → 中止，不调引擎，错误说明为什么不能写", async () => {
		const { ctx, absPath, before, tool, calls } = directCtx({
			recordBinaryVersion: () => ({ recorded: false, skipped: true, reason: "io-error", message: "磁盘已满" }),
		});
		await expect(run(tool, { path: absPath, find: FIND, replace: REPLACE })).rejects.toThrow(/旧版本/);
		await expect(run(tool, { path: absPath, find: FIND, replace: REPLACE })).rejects.toThrow(/磁盘已满/);
		expect(calls.patch).toHaveLength(0);
		expect(bytesOf(absPath)).toEqual(before);
		const audit = readAudit(ctx.audit);
		expect(audit.every((record) => record.outcome === "failed")).toBe(true);
	});

	it("旧版本超限（>20 MiB）→ 中止，提示改用修订模式", async () => {
		const { absPath, tool, calls } = directCtx({
			recordBinaryVersion: () => ({ recorded: false, skipped: true, reason: "too-large", size: 30 * 1024 * 1024 }),
		});
		await expect(run(tool, { path: absPath, find: FIND, replace: REPLACE })).rejects.toThrow(/20 MiB/);
		await expect(run(tool, { path: absPath, find: FIND, replace: REPLACE })).rejects.toThrow(/修订模式/);
		expect(calls.patch).toHaveLength(0);
	});

	it("引擎的三类语义拒绝（找不到 / 多处命中 / 跨 run）都带回错误码与「请在 Word 里手动修改」", async () => {
		for (const code of ["not-found", "multiple-matches", "cross-run"]) {
			const { ctx, absPath, before, tool } = directCtx({
				patch: async () => {
					throw new DocxPatchError(code, `docx 文本替换失败（${code}）：夹具拒绝`);
				},
			});
			const error = await run(tool, { path: absPath, find: FIND, replace: REPLACE }).catch((thrown) => thrown);
			expect(error.message, code).toContain(code);
			expect(error.message, code).toContain("Word");
			expect(error.message, code).toContain("文件未修改");
			expect(bytesOf(absPath), code).toEqual(before);
			const audit = readAudit(ctx.audit);
			expect(audit[0], code).toMatchObject({ category: "file", outcome: "failed" });
			expect(audit[0].detail, code).toContain(code);
		}
	});
	it("引擎非契约失败（spawn-failed）也如实带出并可重试", async () => {
		const { absPath, tool } = directCtx({
			patch: async () => {
				throw new DocxPatchError("spawn-failed", "Python 调用失败：ENOENT（/venv/python）");
			},
		});
		const error = await run(tool, { path: absPath, find: FIND, replace: REPLACE }).catch((thrown) => thrown);
		expect(error.message).toContain("ENOENT");
		expect(error.message).toContain("可重试");
	});
});

describe("Proposal 模型扩展 —— kind:docx 与旧文本建议兼容", () => {
	function docxProposalInput(overrides = {}) {
		return {
			absPath: "/ws/report.docx",
			baseSha256: "a".repeat(64),
			find: FIND,
			replace: REPLACE,
			part: DOCX_PART_DEFAULT,
			sessionId: "sess-1",
			toolName: "docx_replace",
			at: 1_700_000_000_000,
			...overrides,
		};
	}

	it("buildDocxProposal 拒绝不完整与无改动", () => {
		expect(() => buildDocxProposal({})).toThrow(/绝对路径/);
		expect(() => buildDocxProposal(docxProposalInput({ baseSha256: "xyz" }))).toThrow(/基准哈希/);
		expect(() => buildDocxProposal(docxProposalInput({ find: "" }))).toThrow(/原文/);
		expect(() => buildDocxProposal(docxProposalInput({ replace: "" }))).toThrow(/替换后的文本/);
		expect(() => buildDocxProposal(docxProposalInput({ replace: FIND }))).toThrow(/没有产生任何实际改动/);
	});

	it("parseProposal：docx 往返 / 未知 kind 当损坏 / 缺 part 当损坏", () => {
		const proposal = buildDocxProposal(docxProposalInput());
		expect(parseProposal(JSON.parse(JSON.stringify(proposal)))).toEqual(proposal);
		expect(parseProposal({ ...proposal, kind: "spreadsheet" })).toBeUndefined();
		const { part: _dropped, ...withoutPart } = proposal;
		expect(parseProposal(withoutPart)).toBeUndefined();
	});

	it("旧文本建议（没有 kind 字段）仍按 text 解析，写入时带 kind:text", () => {
		const legacy = {
			id: "abc-123abc",
			path: "/ws/notes.md",
			baseSha256: "b".repeat(64),
			before: "a\n",
			after: "b\n",
			ops: [
				{ type: "-", text: "a" },
				{ type: "+", text: "b" },
			],
			hunks: [],
			sessionId: "sess-old",
			createdAt: 1,
			toolName: "edit",
		};
		expect(parseProposal(legacy)).toMatchObject({ id: legacy.id, kind: "text", path: legacy.path });
		const ctx = setup();
		const textProposal = { ...legacy, before: "x\n", after: "y\n", ops: [{ type: "-", text: "x" }, { type: "+", text: "y" }] };
		saveProposal({ ...textProposal, kind: "text" }, { dir: ctx.store });
		expect(listProposals({ dir: ctx.store }).entries[0]).toMatchObject({ kind: "text" });
	});

	it("rejectProposal 对 docx 建议可用：审计 blocked、删除建议、不碰目标文件", () => {
		const ctx = setup();
		const absPath = seedDocx(ctx);
		const bytes = bytesOf(absPath);
		const proposal = buildDocxProposal({
			absPath,
			baseSha256: sha256Bytes(bytes),
			find: FIND,
			replace: REPLACE,
			sessionId: "sess-reject",
			toolName: "docx_replace",
		});
		saveProposal(proposal, { dir: ctx.store });
		const result = rejectProposal(proposal.id, { dir: ctx.store, auditDir: ctx.audit });
		expect(result).toEqual({ rejected: true, deleted: true });
		expect(readProposal(proposal.id, { dir: ctx.store })).toBeUndefined();
		expect(bytesOf(absPath)).toEqual(bytes);
		const audit = readAudit(ctx.audit);
		expect(audit[0]).toMatchObject({ category: "file", outcome: "blocked" });
		expect(audit[0].detail).toContain("1 处替换");
		expect(audit[0].detail).not.toContain(FIND);
	});

	it("summarize：docx 是「1 处替换」，文本建议不受影响", () => {
		const proposal = buildDocxProposal(docxProposalInput());
		expect(summarize(proposal)).toMatchObject({
			kind: "docx",
			hunkCount: 1,
			added: 1,
			removed: 1,
			part: DOCX_PART_DEFAULT,
			name: "report.docx",
		});
	});

	it("checkFreshness：字节一致 → 新鲜；改一个字节 → changed；文件不在 → missing", () => {
		const ctx = setup();
		const absPath = seedDocx(ctx);
		const bytes = bytesOf(absPath);
		const proposal = buildDocxProposal(docxProposalInput({ absPath, baseSha256: sha256Bytes(bytes) }));
		expect(checkFreshness(proposal)).toMatchObject({ stale: false, missing: false });

		writeFileSync(absPath, Buffer.concat([bytes, Buffer.from([0])]));
		expect(checkFreshness(proposal)).toMatchObject({ stale: true, missing: false, reason: "changed" });

		rmSync(absPath);
		expect(checkFreshness(proposal)).toMatchObject({ stale: true, missing: true, reason: "missing" });
	});
});

describe("applyDocxProposal —— 接受 docx 建议", () => {
	function seedProposal(ctx) {
		const absPath = seedDocx(ctx);
		const bytes = bytesOf(absPath);
		const proposal = buildDocxProposal({
			absPath,
			baseSha256: sha256Bytes(bytes),
			find: FIND,
			replace: REPLACE,
			sessionId: "sess-accept",
			toolName: "docx_replace",
			at: 1_700_000_000_000,
		});
		saveProposal(proposal, { dir: ctx.store });
		return { absPath, bytes, proposal };
	}

	function acceptOptions(ctx, extra = {}) {
		return {
			python: "/venv/python",
			engineDir: join(ROOT, "resources", "docx-engine"),
			dir: ctx.store,
			versionsDir: ctx.versions,
			auditDir: ctx.audit,
			now: () => 1_700_000_100_000,
			...extra,
		};
	}

	const fakePatch = async (req) => ({
		part: req.part,
		entries: 1,
		changed: 1,
		bytesBefore: 300,
		bytesAfter: 330,
		otherEntriesUnchanged: true,
	});

	it("哈希守卫通过 → 留旧版本 → 修补 → 审计 → 删除建议", async () => {
		const ctx = setup();
		const { absPath, bytes, proposal } = seedProposal(ctx);
		const result = await applyDocxProposal(proposal.id, acceptOptions(ctx, { patch: fakePatch }));
		expect(result).toMatchObject({ path: absPath, part: DOCX_PART_DEFAULT, replaced: 1, bytesBefore: 300, bytesAfter: 330 });
		expect(result.proposalDeleted).toBe(true);
		expect(readProposal(proposal.id, { dir: ctx.store })).toBeUndefined();

		const key = versionKeyOf(absPath);
		const file = readVersionFile(key, { dir: ctx.versions });
		expect(readVersionBytes(key, file.versions[0].id, { dir: ctx.versions }).bytes).toEqual(bytes);

		const audit = readAudit(ctx.audit);
		expect(audit).toHaveLength(1);
		expect(audit[0]).toMatchObject({ category: "file", outcome: "allowed" });
		expect(audit[0].detail).not.toContain(FIND);
	});

	it("原文已变化 → 拒绝，不记版本、不调引擎、建议仍在", async () => {
		const ctx = setup();
		const { absPath, bytes, proposal } = seedProposal(ctx);
		let patched = 0;
		writeFileSync(absPath, Buffer.concat([bytes, Buffer.from([0])]));
		await expect(
			applyDocxProposal(proposal.id, acceptOptions(ctx, { patch: async () => void (patched += 1) })),
		).rejects.toThrow(/原文已变化/);
		expect(patched).toBe(0);
		expect(readProposal(proposal.id, { dir: ctx.store })).not.toBeUndefined();
		expect(readAudit(ctx.audit)[0]).toMatchObject({ category: "file", outcome: "failed" });
	});

	it("版本记录失败 → 中止，不调引擎，建议仍在", async () => {
		const ctx = setup();
		const { proposal } = seedProposal(ctx);
		let patched = 0;
		await expect(
			applyDocxProposal(
				proposal.id,
				acceptOptions(ctx, {
					recordBinaryVersion: () => ({ recorded: false, skipped: true, reason: "io-error", message: "磁盘已满" }),
					patch: async () => void (patched += 1),
				}),
			),
		).rejects.toThrow(/旧版本/);
		expect(patched).toBe(0);
		expect(readProposal(proposal.id, { dir: ctx.store })).not.toBeUndefined();
	});

	it("文本建议不能走 docx 接受通道；未知 id 报可读错误", async () => {
		const ctx = setup();
		const textProposal = saveProposal(
			{
				id: "abc-123abc",
				kind: "text",
				path: join(ctx.ws, "notes.md"),
				baseSha256: "b".repeat(64),
				before: "",
				after: "x",
				ops: [{ type: "+", text: "x" }],
				hunks: [],
				sessionId: "",
				createdAt: 1,
				toolName: "write",
			},
			{ dir: ctx.store },
		);
		await expect(applyDocxProposal(textProposal.id, acceptOptions(ctx))).rejects.toThrow(/不是 docx/);
		await expect(applyDocxProposal("zzz-000000", acceptOptions(ctx))).rejects.toThrow(/找不到修订建议/);
	});

	it("缺少 Python 路径 → 在任何写操作前拒绝", async () => {
		const ctx = setup();
		const { proposal } = seedProposal(ctx);
		await expect(applyDocxProposal(proposal.id, acceptOptions(ctx, { python: "" }))).rejects.toThrow(/Python/);
		expect(readAudit(ctx.audit)).toEqual([]);
		expect(readProposal(proposal.id, { dir: ctx.store })).not.toBeUndefined();
	});
});

describe("权限门：docx_replace 属于 MUTATING，按 path 判定", () => {
	const workspaceDir = "/ws";
	const paths = { workspaceDir, configDir: "/config", protectedDirs: [] };

	it("MUTATING 集合包含 docx_replace", () => {
		expect(MUTATING.has("docx_replace")).toBe(true);
	});

	it("只读档直接拒绝，workspace-write 放行区内路径", () => {
		const facts = { toolName: "docx_replace", path: "/ws/report.docx" };
		expect(decide(facts, paths, workspaceDir, { sandbox: "read-only", approval: "ask" })).toMatchObject({ kind: "deny" });
		expect(decide(facts, paths, workspaceDir, { sandbox: "workspace-write", approval: "ask" })).toMatchObject({ kind: "allow" });
	});

	it("工作区外的目标在默认档是询问（不是静默放行）", () => {
		const decision = decide(
			{ toolName: "docx_replace", path: "/elsewhere/report.docx" },
			paths,
			workspaceDir,
			{ sandbox: "workspace-write", approval: "ask" },
		);
		expect(decision.kind).toBe("ask");
		expect(decision.summary).toContain("修改");
	});
});

/* ──────────────────────────────────────────────────────────────────────────
 * 真跑引擎：验证工具层的入参接线（python / 同一文件进出 / part / find / replace）
 * 与 patchDocx 的契约确实对得上 —— 注入的 fake 抓不到这类「名字写错」。
 * ────────────────────────────────────────────────────────────────────────── */

function detectPlainPython() {
	for (const command of [process.env.ZW_PYTHON, "python3", "python"].filter((name) => typeof name === "string" && name !== "")) {
		const probe = spawnSync(command, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
		if (probe.status === 0) return command;
	}
	return null;
}

const PYTHON = detectPlainPython();

describe.skipIf(PYTHON === null)("真跑引擎（需要 python3 / python；没有解释器时整组跳过）", () => {
	it("直接写回：正文被替换、其余部件不变、旧字节留在文件历史里", async () => {
		const ctx = setup();
		const absPath = seedDocx(ctx);
		const before = bytesOf(absPath);
		const { tool } = makeTool(ctx, {
			ensure: async () => ({ status: "ready", python: PYTHON }),
			patch: void 0, // 用真实 patchDocx
			recordBinaryVersion: void 0, // 用真实的版本记录
		});
		const receipt = await run(tool, { path: absPath, find: FIND, replace: REPLACE });
		expect(receipt.type).toBe("docx_replace_result");
		expect(receipt.replaced).toBe(1);

		const after = bytesOf(absPath);
		expect(sha256Bytes(after)).not.toBe(sha256Bytes(before));

		const beforeZip = await JSZip.loadAsync(before);
		const afterZip = await JSZip.loadAsync(after);
		const body = await afterZip.file("word/document.xml").async("string");
		expect(body).toContain(REPLACE);
		expect(body).not.toContain(FIND);
		// 其余条目逐字节一致
		for (const name of Object.keys(beforeZip.files)) {
			if (name === "word/document.xml" || beforeZip.files[name].dir) continue;
			const [a, b] = await Promise.all([beforeZip.file(name).async("nodebuffer"), afterZip.file(name).async("nodebuffer")]);
			expect(Buffer.compare(a, b), `条目 ${name} 不应被改动`).toBe(0);
		}

		const key = versionKeyOf(absPath);
		const file = readVersionFile(key, { dir: ctx.versions });
		expect(readVersionBytes(key, file.versions[0].id, { dir: ctx.versions }).bytes).toEqual(before);
	});
});
