/**
 * 修订写回（`src/main/daemon/doc-edits.js` 的 applyProposal / rejectProposal，#458）的单测。
 *
 * 这一层没有编译期检查，写错的形态**都不会崩**，只会静默做错事：
 * - 哈希守卫失效 → 用户在建议生成后手动改过的内容被悄悄覆盖；
 * - 合并算法把未选中的 hunk 也带上 → 用户只勾了一段、文件却改了多处；
 * - 版本记录失败还继续写 → 「可从文件历史还原」这句承诺不成立；
 * - 拒绝时顺手碰了目标文件 → 「拒绝不修改文件」是 PRD 的硬约束；
 * - 审计记了文档正文 → 审计日志本身成了正文的第二个副本。
 *
 * 覆盖：全选 = after 逐字节 / 部分接受 / 哈希守卫 / 拒绝零副作用 / 版本可读回 /
 * 版本 io-error 中止 / 新建文件 / 非法与损坏 id / 审计不含正文 / 权限位保留。
 *
 * ── 反向验证（已真跑并还原，见交付报告）────────────────────────────────
 * 1) 去掉 `currentSha256 !== proposal.baseSha256` 那道闸 → 「原文被改」用例变红。
 * 2) 合并时把未选中的 `+` 也追加 → 「部分接受」用例变红。
 * 3) 版本记录失败后不再中止 → 「io-error 中止」用例变红。
 */
import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
	applyProposal,
	buildProposal,
	checkFreshness,
	mergeSelectedHunks,
	rejectProposal,
	saveProposal,
	sha256,
} from "../../src/main/daemon/doc-edits.js";
import { readVersionContent, readVersionFile, versionKeyOf } from "../../src/main/daemon/version-store.js";

let roots = [];

function tempDir(prefix = "zerowork-doc-apply-") {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of roots) rmSync(dir, { recursive: true, force: true });
	roots = [];
});

/** 四个隔离目录：工作区（目标文件）/ 建议 / 版本 / 审计。 */
function setup() {
	return {
		ws: tempDir("zerowork-doc-apply-ws-"),
		store: tempDir("zerowork-doc-apply-store-"),
		versions: tempDir("zerowork-doc-apply-versions-"),
		audit: tempDir("zerowork-doc-apply-audit-"),
	};
}

/**
 * 在临时工作区写一份「原文」并生成 + 落盘一条建议。
 * 返回建议对象（含 id / hunks / baseSha256）。
 */
function makeProposal(ctx, { name = "notes.md", before, after, sessionId = "sess-apply", at = 1_700_000_000_000 } = {}) {
	const absPath = join(ctx.ws, name);
	mkdirSync(dirname(absPath), { recursive: true });
	writeFileSync(absPath, before, "utf8");
	const proposal = buildProposal({ absPath, before, after, sessionId, toolName: "edit", at });
	saveProposal(proposal, { dir: ctx.store });
	return proposal;
}

function applyOptions(ctx, extra = {}) {
	return { dir: ctx.store, versionsDir: ctx.versions, auditDir: ctx.audit, now: () => 1_700_000_100_000, ...extra };
}

/** 把审计目录里的 jsonl 全部读回（writeAuditRecord 按日期分文件）。 */
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

function proposalFile(ctx, id) {
	return join(ctx.store, `${id}.json`);
}

describe("mergeSelectedHunks —— 只应用选中的 hunk", () => {
	/** 20 行原文，改动第 2 行与第 18 行 → 两个 hunk（间距 > 3×2）。 */
	function twoHunkProposal(ctx) {
		const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
		const before = `${lines.join("\n")}\n`;
		const changed = [...lines];
		changed[1] = "line 1 changed";
		changed[17] = "line 17 changed";
		const after = `${changed.join("\n")}\n`;
		return { ctx, lines, before, after, proposal: makeProposal(ctx, { before, after }) };
	}

	it("全选时合并结果逐字节等于 after", () => {
		const { after, proposal } = twoHunkProposal(setup());
		const merged = mergeSelectedHunks(proposal, proposal.hunks.map((hunk) => hunk.id));
		expect(merged.text).toBe(after);
		expect(merged.appliedHunks.map((hunk) => hunk.id)).toEqual(["h1", "h2"]);
		expect(merged.appliedHunks.reduce((sum, hunk) => sum + hunk.added, 0)).toBe(2);
		expect(merged.appliedHunks.reduce((sum, hunk) => sum + hunk.removed, 0)).toBe(2);
	});

	it("只选 h1：第二处改动回到原文，上下文行保留", () => {
		const { lines, before, proposal } = twoHunkProposal(setup());
		expect(proposal.hunks).toHaveLength(2);
		const merged = mergeSelectedHunks(proposal, ["h1"]);
		const expected = [...lines];
		expected[1] = "line 1 changed";
		expect(merged.text).toBe(`${expected.join("\n")}\n`);
		expect(merged.text).not.toBe(before);
		expect(merged.appliedHunks).toEqual([{ id: "h1", opsStart: proposal.hunks[0].opsStart, opsEnd: proposal.hunks[0].opsEnd, added: 1, removed: 1 }]);
	});

	it("只选 h2：第一处改动回到原文", () => {
		const { lines, proposal } = twoHunkProposal(setup());
		const merged = mergeSelectedHunks(proposal, ["h2"]);
		const expected = [...lines];
		expected[17] = "line 17 changed";
		expect(merged.text).toBe(`${expected.join("\n")}\n`);
	});

	it("纯新增 / 纯删除：选中即生效，未选中即保持原样", () => {
		const ctx = setup();
		const added = makeProposal(ctx, { name: "add.md", before: "a\n", after: "a\nb\n" });
		expect(mergeSelectedHunks(added, ["h1"]).text).toBe("a\nb\n");
		const removed = makeProposal(ctx, { name: "del.md", before: "a\nb\n", after: "a\n" });
		expect(mergeSelectedHunks(removed, ["h1"]).text).toBe("a\n");
	});

	it("空的 / 不存在的 / 重复的 hunkIds 一律拒绝（不静默忽略拼错的 id）", () => {
		const { proposal } = twoHunkProposal(setup());
		expect(() => mergeSelectedHunks(proposal, [])).toThrow(/至少选择一段/);
		expect(() => mergeSelectedHunks(proposal, ["h9"])).toThrow(/没有这一段/);
		expect(() => mergeSelectedHunks(proposal, ["h1", "h1"])).toThrow(/重复/);
		expect(() => mergeSelectedHunks(proposal, ["h1", 1])).toThrow(/没有这一段/);
		expect(() => mergeSelectedHunks(proposal, "h1")).toThrow(/至少选择一段/);
	});

	it("hunk 区间损坏（越界）时拒绝，不产出半截文本", () => {
		const { proposal } = twoHunkProposal(setup());
		const broken = { ...proposal, hunks: [{ ...proposal.hunks[0], opsEnd: proposal.ops.length + 5 }] };
		expect(() => mergeSelectedHunks(broken, ["h1"])).toThrow(/结构已损坏/);
	});
});

describe("checkFreshness —— 当前文件是否仍与基准一致", () => {
	it("原文未变 → stale:false，哈希等于 baseSha256", () => {
		const ctx = setup();
		const proposal = makeProposal(ctx, { before: "a\nb\n", after: "a\nB\n" });
		expect(checkFreshness(proposal)).toEqual({ stale: false, currentSha256: proposal.baseSha256, missing: false });
	});

	it("原文被改 → stale:true（reason:changed）", () => {
		const ctx = setup();
		const proposal = makeProposal(ctx, { before: "a\nb\n", after: "a\nB\n" });
		writeFileSync(join(ctx.ws, "notes.md"), "a\nb changed\n");
		const freshness = checkFreshness(proposal);
		expect(freshness.stale).toBe(true);
		expect(freshness.reason).toBe("changed");
		expect(freshness.currentSha256).toBe(sha256("a\nb changed\n"));
	});

	it("文件消失且基准非空 → stale:true（reason:missing）", () => {
		const ctx = setup();
		const proposal = makeProposal(ctx, { before: "a\nb\n", after: "a\nB\n" });
		rmSync(join(ctx.ws, "notes.md"));
		const freshness = checkFreshness(proposal);
		expect(freshness.stale).toBe(true);
		expect(freshness.missing).toBe(true);
		expect(freshness.reason).toBe("missing");
	});

	it("新建文件的建议（基准是空串哈希）在文件不存在时仍算新鲜", () => {
		const ctx = setup();
		const absPath = join(ctx.ws, "new.md");
		const proposal = buildProposal({ absPath, before: "", after: "# 新文档\n" });
		saveProposal(proposal, { dir: ctx.store });
		expect(proposal.baseSha256).toBe(sha256(""));
		expect(checkFreshness(proposal).stale).toBe(false);
	});
});

describe("applyProposal —— 接受与三道闸", () => {
	it("全部接受：文件逐字节等于 after、建议删除、审计记 allowed", () => {
		const ctx = setup();
		const before = "# 标题\n\n第一段\n第二段\n第三段\n";
		const after = "# 标题\n\n第一段改了\n第二段\n第三段\n";
		const proposal = makeProposal(ctx, { before, after, sessionId: "sess-apply" });

		const result = applyProposal(proposal.id, proposal.hunks.map((hunk) => hunk.id), applyOptions(ctx));

		const abs = join(ctx.ws, "notes.md");
		expect(readFileSync(abs).equals(Buffer.from(after, "utf8"))).toBe(true);
		expect(result.path).toBe(abs);
		expect(result.appliedHunks).toEqual(proposal.hunks.map((hunk) => hunk.id));
		expect(result.totalHunks).toBe(proposal.hunks.length);
		expect(result.added).toBe(1);
		expect(result.removed).toBe(1);
		expect(result.proposalDeleted).toBe(true);
		expect(existsSync(proposalFile(ctx, proposal.id))).toBe(false);

		const records = readAudit(ctx.audit);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ category: "file", outcome: "allowed" });
		expect(records[0].detail).toMatch(/接受修订建议/);
	});

	it("部分接受：只写入选中的 hunk，未选中的保持原文", () => {
		const ctx = setup();
		const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`);
		const before = `${lines.join("\n")}\n`;
		const changed = [...lines];
		changed[1] = "line 1 changed";
		changed[17] = "line 17 changed";
		const after = `${changed.join("\n")}\n`;
		const proposal = makeProposal(ctx, { before, after });

		const result = applyProposal(proposal.id, ["h1"], applyOptions(ctx));

		const expected = [...lines];
		expected[1] = "line 1 changed";
		expect(readFileSync(join(ctx.ws, "notes.md"), "utf8")).toBe(`${expected.join("\n")}\n`);
		expect(result.appliedHunks).toEqual(["h1"]);
		expect(result.totalHunks).toBe(2);
		expect(result.proposalDeleted).toBe(true);
	});

	it("原文被手动改过：拒绝写回、文件字节不变、审计记 failed、建议保留", () => {
		const ctx = setup();
		const proposal = makeProposal(ctx, { before: "alpha\nbeta\n", after: "alpha\nBETA\n" });
		const abs = join(ctx.ws, "notes.md");
		const tampered = Buffer.from("alpha\nbeta changed by hand\n", "utf8");
		writeFileSync(abs, tampered);

		expect(() => applyProposal(proposal.id, ["h1"], applyOptions(ctx))).toThrow(/原文已变化，请重新生成/);
		expect(readFileSync(abs).equals(tampered)).toBe(true);
		/* 没有写版本（写入根本没发生），建议也还在 —— 用户可对照后重新生成。 */
		expect(readdirSync(ctx.versions)).toEqual([]);
		expect(existsSync(proposalFile(ctx, proposal.id))).toBe(true);

		const records = readAudit(ctx.audit);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ category: "file", outcome: "failed" });
		expect(records[0].detail).toMatch(/原文已变化/);
		expect(records[0].detail).toMatch(/notes\.md/);
	});

	it("写回前留下旧版本，可从文件历史读回接受前的内容", () => {
		const ctx = setup();
		const before = "# 原稿\n\n正文\n";
		const after = "# 原稿\n\n改后的正文\n";
		const proposal = makeProposal(ctx, { before, after, sessionId: "sess-history" });
		applyProposal(proposal.id, ["h1"], applyOptions(ctx));

		const key = versionKeyOf(resolve(join(ctx.ws, "notes.md")));
		const file = readVersionFile(key, { dir: ctx.versions });
		expect(file).toBeDefined();
		expect(file.path).toBe(resolve(join(ctx.ws, "notes.md")));
		expect(file.versions).toHaveLength(1);
		expect(file.versions[0]).toMatchObject({ tool: "doc-edit", sessionId: "sess-history", added: 1, removed: 1 });
		expect(file.versions[0].at).toBe(1_700_000_100_000);

		const content = readVersionContent(key, file.versions[0].id, { dir: ctx.versions });
		expect(content.ok).toBe(true);
		expect(content.content).toBe(before);
		/* 还原的是「接受之前」的原文，不是改后内容。 */
		expect(content.content).not.toBe(after);
	});

	it("版本记录失败（io-error）：中止写回，文件不变、建议保留", () => {
		const ctx = setup();
		const proposal = makeProposal(ctx, { before: "a\nb\n", after: "a\nB\n" });
		const abs = join(ctx.ws, "notes.md");
		const original = readFileSync(abs);
		/* 用一个普通文件冒充版本目录 —— mkdirSync 必然 ENOTDIR，recordVersion 归为 io-error。 */
		const blocker = join(ctx.ws, "not-a-directory");
		writeFileSync(blocker, "我是文件，不是目录", "utf8");

		expect(() =>
			applyProposal(proposal.id, ["h1"], applyOptions(ctx, { versionsDir: blocker })),
		).toThrow(/无法在写回前保存旧版本/);
		expect(readFileSync(abs).equals(original)).toBe(true);
		expect(existsSync(proposalFile(ctx, proposal.id))).toBe(true);

		const records = readAudit(ctx.audit);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ category: "file", outcome: "failed" });
		expect(records[0].detail).toMatch(/旧版本/);
	});

	it("新建文件的建议：接受后创建文件，且不留空版本", () => {
		const ctx = setup();
		const abs = join(ctx.ws, "new.md");
		const proposal = buildProposal({ absPath: abs, before: "", after: "# 新文档\n正文\n", sessionId: "sess-new", toolName: "write" });
		saveProposal(proposal, { dir: ctx.store });

		const result = applyProposal(proposal.id, proposal.hunks.map((hunk) => hunk.id), applyOptions(ctx));
		expect(readFileSync(abs, "utf8")).toBe("# 新文档\n正文\n");
		expect(result.proposalDeleted).toBe(true);
		/* 文件此前不存在 —— 没有「旧内容」可留，不该出现一条空内容的假版本。 */
		expect(readdirSync(ctx.versions)).toEqual([]);
	});

	it("不存在 / 损坏的建议：报可读错误，文件不变", () => {
		const ctx = setup();
		const abs = join(ctx.ws, "notes.md");
		writeFileSync(abs, "x\n", "utf8");
		const original = readFileSync(abs);

		expect(() => applyProposal("m3abc-000000", ["h1"], applyOptions(ctx))).toThrow(/找不到修订建议/);
		writeFileSync(proposalFile(ctx, "m3abd-111111"), "{ 这不是 JSON", "utf8");
		expect(() => applyProposal("m3abd-111111", ["h1"], applyOptions(ctx))).toThrow(/找不到修订建议/);
		expect(() => applyProposal("../escape", ["h1"], applyOptions(ctx))).toThrow(/id 格式不正确/);

		expect(readFileSync(abs).equals(original)).toBe(true);
		expect(readAudit(ctx.audit)).toEqual([]);
	});

	it("非法 hunkIds：拒绝且文件不变、不写审计", () => {
		const ctx = setup();
		const proposal = makeProposal(ctx, { before: "a\nb\n", after: "a\nB\n" });
		const abs = join(ctx.ws, "notes.md");
		const original = readFileSync(abs);

		for (const bad of [[], ["h9"], ["h1", "h1"], ["h1", 1], "h1"]) {
			expect(() => applyProposal(proposal.id, bad, applyOptions(ctx)), JSON.stringify(bad)).toThrow();
		}
		expect(readFileSync(abs).equals(original)).toBe(true);
		expect(existsSync(proposalFile(ctx, proposal.id))).toBe(true);
		expect(readAudit(ctx.audit)).toEqual([]);
	});

	it("审计不含文档正文，只记 id / 文件名 / 段数", () => {
		const ctx = setup();
		const before = "机密正文第一行\n机密正文第二行\n";
		const after = "机密正文第一行\n改写后的机密行\n";
		const proposal = makeProposal(ctx, { before, after });
		applyProposal(proposal.id, ["h1"], applyOptions(ctx));

		const { detail } = readAudit(ctx.audit)[0];
		expect(detail).not.toMatch(/机密正文/);
		expect(detail).not.toMatch(/改写后的机密行/);
		expect(detail).toMatch(/notes\.md/);
		expect(detail).toMatch(/1\/1 段/);
		expect(detail.length).toBeLessThanOrEqual(241);
	});

	it.skipIf(process.platform === "win32")("原子写保留原文件的权限位", () => {
		const ctx = setup();
		const proposal = makeProposal(ctx, { before: "a\nb\n", after: "a\nB\n" });
		const abs = join(ctx.ws, "notes.md");
		chmodSync(abs, 0o600);
		applyProposal(proposal.id, ["h1"], applyOptions(ctx));
		expect(statSync(abs).mode & 0o777).toBe(0o600);
		/* 同目录的临时文件不许残留。 */
		expect(readdirSync(ctx.ws).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});
});

describe("rejectProposal —— 拒绝零副作用", () => {
	it("拒绝：文件不变、建议删除、审计记 blocked、不写版本", () => {
		const ctx = setup();
		const proposal = makeProposal(ctx, { before: "x\n", after: "y\n" });
		const abs = join(ctx.ws, "notes.md");
		const original = readFileSync(abs);

		const result = rejectProposal(proposal.id, { dir: ctx.store, auditDir: ctx.audit, versionsDir: ctx.versions });

		expect(result).toEqual({ rejected: true, deleted: true });
		expect(readFileSync(abs).equals(original)).toBe(true);
		expect(existsSync(proposalFile(ctx, proposal.id))).toBe(false);

		const records = readAudit(ctx.audit);
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ category: "file", outcome: "blocked" });
		expect(records[0].detail).toMatch(/拒绝修订建议/);
		expect(records[0].detail).toMatch(/notes\.md/);
		/* 拒绝只丢建议，不碰文件 —— 版本存储里不该多出任何东西。 */
		expect(readdirSync(ctx.versions)).toEqual([]);
	});

	it("拒绝不碰目标文件：即使目标文件已被删除也能拒绝", () => {
		const ctx = setup();
		const proposal = makeProposal(ctx, { before: "x\n", after: "y\n" });
		rmSync(join(ctx.ws, "notes.md"));
		expect(rejectProposal(proposal.id, { dir: ctx.store, auditDir: ctx.audit }).rejected).toBe(true);
		/* 没有把它「顺手重建」出来。 */
		expect(existsSync(join(ctx.ws, "notes.md"))).toBe(false);
	});

	it("不存在 / 损坏的建议：报可读错误、不写审计", () => {
		const ctx = setup();
		expect(() => rejectProposal("m3abc-000000", { dir: ctx.store, auditDir: ctx.audit })).toThrow(/找不到修订建议/);
		writeFileSync(proposalFile(ctx, "m3abd-111111"), "{ 坏 JSON", "utf8");
		expect(() => rejectProposal("m3abd-111111", { dir: ctx.store, auditDir: ctx.audit })).toThrow(/找不到修订建议/);
		expect(() => rejectProposal("bad id", { dir: ctx.store, auditDir: ctx.audit })).toThrow(/id 格式不正确/);
		expect(readAuditOrEmpty(ctx.audit)).toEqual([]);
	});
});

/** 审计目录可能一个文件都没建（writeAuditRecord 只在被调用时才 mkdir）。 */
function readAuditOrEmpty(dir) {
	try {
		return readAudit(dir);
	} catch {
		return [];
	}
}
