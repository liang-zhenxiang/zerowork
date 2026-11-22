/**
 * 修订模式（`src/main/daemon/doc-edits.js`，#456）的单测。
 *
 * 这条链路没有编译期检查，写错的形态也都**不会崩**：
 * - 白名单写松 → 修订模式变成「任意路径的读写入口」；
 * - `oldText` 找不到却照样生成建议 → 用户到审阅台发现「接受后文件会变样」；
 * - 条目裁剪写反 → 丢的是最新那条；
 * - 存储失败却放行写入 → 静默退化成「直接改文件」，正是 PRD 明令禁止的事。
 *
 * 覆盖：白名单 / 路径（越界、`..`、符号链接）、after 生成、哈希、hunk 分组、
 * 超限拒绝、存储往返 / 坏 JSON / 上限裁剪 / id 穿越，以及拦截扩展的最小接线
 * （fake `pi.on`，关闭放行 / 开启 block + 建议落盘 + 目标文件字节不变）。
 *
 * ── 反向验证（已真跑并还原，见交付报告）──────────────────────────────
 * 1) 把 `isEnabled?.() !== true` 改成恒 false 的相反判断（关闭也拦截）→
 *    「关闭时放行」那条变红。
 * 2) 去掉 `isTextEditPath` 判定 → 非白名单扩展名用例变红。
 */
import { afterEach, describe, expect, it } from "vitest";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	DOC_EDIT_MAX_ENTRIES,
	applyToolInput,
	buildProposal,
	createDocEditExtension,
	deleteProposal,
	groupHunks,
	isDocEditId,
	isTextEditPath,
	lineOps,
	listProposals,
	readProposal,
	resolveInsideWorkspace,
	saveProposal,
	sha256,
} from "../../src/main/daemon/doc-edits.js";
import { DOC_EDIT_BLOCK_PREFIX, isDocEditBlockText } from "../../src/shared/doc-edit.js";

let roots = [];

function tempDir(prefix = "zerowork-doc-edits-") {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	roots.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of roots) rmSync(dir, { recursive: true, force: true });
	roots = [];
});

/** 把 handler 从 fake pi 里取出来（扩展只注册 tool_call 一条）。 */
function captureToolCall(extension) {
	const handlers = [];
	extension({ on: (name, fn) => handlers.push({ name, fn }) });
	const entry = handlers.find((item) => item.name === "tool_call");
	expect(entry, "扩展没有注册 tool_call 监听器").toBeDefined();
	return entry.fn;
}

function proposalInput(overrides = {}) {
	return {
		absPath: "/ws/notes.md",
		before: "第一行\n第二行\n",
		after: "第一行\n第二行改\n第三行\n",
		sessionId: "sess-1",
		toolName: "edit",
		at: 1_700_000_000_000,
		...overrides,
	};
}

describe("isTextEditPath —— 白名单只看扩展名", () => {
	it("接受 .md / .markdown / .txt，大小写不敏感", () => {
		for (const name of ["a.md", "B.MD", "c.markdown", "d.MarkDown", "e.txt", "F.TXT"]) {
			expect(isTextEditPath(name), name).toBe(true);
		}
	});

	it("拒绝其它扩展名、无扩展名与空值", () => {
		for (const name of ["a.docx", "b.js", "c.html", "noext", "", " .mdx"]) {
			expect(isTextEditPath(name), name).toBe(false);
		}
		expect(isTextEditPath(undefined)).toBe(false);
	});
});

describe("resolveInsideWorkspace —— 工作区围栏", () => {
	it("相对路径解析成工作区内的绝对路径", () => {
		const ws = tempDir();
		expect(resolveInsideWorkspace(ws, "notes/today.md")).toBe(join(ws, "notes", "today.md"));
	});

	it("工作区内的绝对路径照常接受", () => {
		const ws = tempDir();
		const target = join(ws, "a.md");
		expect(resolveInsideWorkspace(ws, target)).toBe(target);
	});

	it("`..` 逃逸 / 区外绝对路径 / 空路径 / NUL → undefined", () => {
		const ws = tempDir();
		const outside = join(tempDir(), "secret.md");
		expect(resolveInsideWorkspace(ws, "../secret.md")).toBeUndefined();
		expect(resolveInsideWorkspace(ws, outside)).toBeUndefined();
		expect(resolveInsideWorkspace(ws, "")).toBeUndefined();
		expect(resolveInsideWorkspace(ws, "   ")).toBeUndefined();
		expect(resolveInsideWorkspace(ws, "a\0b.md")).toBeUndefined();
		expect(resolveInsideWorkspace("", "a.md")).toBeUndefined();
	});

	it("不存在的子目录：最近祖先在工作区内则接受（write 会自己建目录）", () => {
		const ws = tempDir();
		expect(resolveInsideWorkspace(ws, "new-dir/new.md")).toBe(join(ws, "new-dir", "new.md"));
	});

	it("工作区内的符号链接指向区外 → 拒绝（不跟随）", () => {
		const ws = tempDir();
		const outsideFile = join(tempDir(), "secret.md");
		writeFileSync(outsideFile, "不该被读到");
		symlinkSync(outsideFile, join(ws, "link.md"));
		expect(resolveInsideWorkspace(ws, "link.md")).toBeUndefined();
	});
});

describe("applyToolInput —— write / edit 折成改后全文", () => {
	it("write 直接取 content", () => {
		expect(applyToolInput("write", { path: "a.md", content: "新内容" }, "")).toBe("新内容");
		expect(applyToolInput("write", { path: "a.md" }, "")).toBeUndefined();
	});

	it("edit 顺序应用多条替换", () => {
		const before = "alpha beta gamma";
		const after = applyToolInput(
			"edit",
			{ path: "a.md", edits: [{ oldText: "alpha", newText: "A" }, { oldText: "gamma", newText: "G" }] },
			before,
		);
		expect(after).toBe("A beta G");
	});

	it("oldText 找不到 / edits 为空 / 条目形态不对 → undefined（不产出半截建议）", () => {
		expect(applyToolInput("edit", { path: "a.md", edits: [{ oldText: "找不到", newText: "x" }] }, "原文")).toBeUndefined();
		expect(applyToolInput("edit", { path: "a.md", edits: [] }, "原文")).toBeUndefined();
		expect(applyToolInput("edit", { path: "a.md", edits: [{ oldText: "", newText: "x" }] }, "原文")).toBeUndefined();
		expect(applyToolInput("edit", { path: "a.md", edits: ["x"] }, "原文")).toBeUndefined();
	});

	it("非 write / edit 的工具不介入", () => {
		expect(applyToolInput("read", { path: "a.md" }, "")).toBeUndefined();
	});
});

describe("哈希与 hunk 分组", () => {
	it("sha256 是 UTF-8 的十六进制摘要（已知向量）", () => {
		expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
	});

	it("纯新增 / 纯删除 / 无改动", () => {
		const added = lineOps("", "a\nb");
		expect(added.map((op) => op.type)).toEqual(["+", "+"]);
		const hunks = groupHunks(added);
		expect(hunks).toHaveLength(1);
		expect(hunks[0].added).toBe(2);
		expect(hunks[0].removed).toBe(0);
		expect(hunks[0].lines.map((line) => line.text)).toEqual(["a", "b"]);

		const removed = lineOps("a\nb", "");
		expect(removed.map((op) => op.type)).toEqual(["-", "-"]);
		expect(groupHunks(removed)[0].removed).toBe(2);

		expect(groupHunks(lineOps("same", "same"))).toEqual([]);
	});

	it("相隔较远的两处改动拆成两个 hunk，且带 3 行上下文与 ops 区间", () => {
		const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
		const after = before.split("\n");
		after[1] = "line 1 changed";
		after[17] = "line 17 changed";
		const ops = lineOps(before, after.join("\n"));
		const hunks = groupHunks(ops);
		expect(hunks).toHaveLength(2);
		expect(hunks[0].id).toBe("h1");
		expect(hunks[1].id).toBe("h2");
		// 第一处改动在第 2 行（ops 下标 1），上下文从 0 开始。
		expect(hunks[0].opsStart).toBe(0);
		expect(hunks[0].oldStart).toBe(1);
		// 第二处附近带上前后 3 行。
		const second = hunks[1];
		const changeAt = second.lines.findIndex((line) => line.type === "-" && line.text === "line 17");
		expect(changeAt).toBeGreaterThanOrEqual(3);
		expect(second.lines.length - changeAt).toBeGreaterThanOrEqual(4);
		expect(second.added).toBe(1);
		expect(second.removed).toBe(1);
	});
});

describe("buildProposal —— 字段、哈希与四种拒绝", () => {
	it("生成 id / baseSha256 / ops / hunks / 来源会话 / 时间", () => {
		const proposal = buildProposal(proposalInput());
		expect(proposal.id).toMatch(/^[a-z0-9]+-[a-f0-9]{6}$/);
		expect(isDocEditId(proposal.id)).toBe(true);
		expect(proposal.path).toBe("/ws/notes.md");
		expect(proposal.baseSha256).toBe(sha256(proposalInput().before));
		expect(proposal.sessionId).toBe("sess-1");
		expect(proposal.toolName).toBe("edit");
		expect(proposal.createdAt).toBe(1_700_000_000_000);
		expect(proposal.hunks.length).toBeGreaterThan(0);
		expect(proposal.before).toBe(proposalInput().before);
		expect(proposal.after).toBe(proposalInput().after);
	});

	it("前后逐字相同 → 拒绝（没有实际改动）", () => {
		expect(() => buildProposal(proposalInput({ after: proposalInput().before }))).toThrow(/没有产生任何实际改动/);
	});

	it("单侧超过 1 MiB → 拒绝并说明上限", () => {
		const big = "x".repeat(1024 * 1024 + 1);
		expect(() => buildProposal(proposalInput({ before: "", after: big }))).toThrow(/1 MiB/);
	});

	it("diff 矩阵超过预算 → 拒绝并说明规模上限", () => {
		const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
		const before = lines.join("\n");
		const after = lines.map((line) => `${line}!`).join("\n");
		expect(() => buildProposal(proposalInput({ before, after }))).toThrow(/4,000,000/);
	});

	it("输入不完整 → 拒绝", () => {
		expect(() => buildProposal({})).toThrow(/绝对路径/);
		expect(() => buildProposal(proposalInput({ before: undefined }))).toThrow(/改动前后/);
	});
});

describe("存储 —— 往返、坏记录、上限裁剪、id 校验", () => {
	it("save → list → read → delete 往返", () => {
		const dir = tempDir();
		const proposal = buildProposal(proposalInput());
		const saved = saveProposal(proposal, { dir });
		expect(existsSync(saved.path)).toBe(true);

		const listed = listProposals({ dir });
		expect(listed.skipped).toBe(0);
		expect(listed.entries).toHaveLength(1);
		expect(listed.entries[0]).toMatchObject({
			id: proposal.id,
			path: "/ws/notes.md",
			name: "notes.md",
			sessionId: "sess-1",
			hunkCount: proposal.hunks.length,
		});

		const loaded = readProposal(proposal.id, { dir });
		expect(loaded).toEqual(proposal);

		expect(deleteProposal(proposal.id, { dir })).toEqual({ deleted: true });
		expect(readProposal(proposal.id, { dir })).toBeUndefined();
		expect(listProposals({ dir }).entries).toEqual([]);
	});

	it("坏 JSON 跳过并计数，不影响其余条目", () => {
		const dir = tempDir();
		const proposal = buildProposal(proposalInput());
		saveProposal(proposal, { dir });
		writeFileSync(join(dir, "abc-000000.json"), "{ 这不是 JSON");
		const listed = listProposals({ dir });
		expect(listed.entries).toHaveLength(1);
		expect(listed.skipped).toBe(1);
	});

	it("超过条数上限时丢最旧的", () => {
		const dir = tempDir();
		for (let i = 0; i < DOC_EDIT_MAX_ENTRIES + 1; i += 1) {
			const proposal = buildProposal(
				proposalInput({ absPath: `/ws/n${i}.md`, at: 1_700_000_000_000 + i }),
			);
			saveProposal(proposal, { dir });
		}
		const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
		expect(files).toHaveLength(DOC_EDIT_MAX_ENTRIES);
		const listed = listProposals({ dir });
		expect(listed.entries).toHaveLength(DOC_EDIT_MAX_ENTRIES);
		// 最旧的那条（时间戳最小）已经不在清单里。
		expect(listed.entries.some((entry) => entry.createdAt === 1_700_000_000_000)).toBe(false);
	});

	it("id 必须符合存储规则 —— 路径穿越一律拒绝", () => {
		const dir = tempDir();
		for (const bad of ["../escape", "a/b", "abc-00000", "ABC-000000", "", "abc-000000/../x"]) {
			expect(isDocEditId(bad), bad).toBe(false);
			expect(() => readProposal(bad, { dir }), bad).toThrow(/id 格式不正确/);
			expect(() => deleteProposal(bad, { dir }), bad).toThrow(/id 格式不正确/);
		}
		expect(isDocEditId("m3abc-0f1e2d")).toBe(true);
	});

	it("saveProposal 拒绝外部伪造的 id", () => {
		const dir = tempDir();
		const proposal = buildProposal(proposalInput());
		expect(() => saveProposal({ ...proposal, id: "../x" }, { dir })).toThrow(/id 不合法/);
	});
});

describe("createDocEditExtension —— 最小接线（fake pi）", () => {
	function setup() {
		const ws = tempDir("zerowork-doc-edit-ws-");
		const store = tempDir("zerowork-doc-edit-store-");
		let enabled = false;
		const blocked = [];
		const extension = createDocEditExtension({
			cwd: ws,
			isEnabled: () => enabled,
			getSessionId: () => "sess-live",
			dir: store,
			now: () => 1_700_000_000_000,
			onBlocked: (info) => blocked.push(info),
		});
		return {
			ws,
			store,
			blocked,
			handler: captureToolCall(extension),
			setEnabled: (value) => {
				enabled = value;
			},
		};
	}

	it("关闭时放行，且不产生任何建议", async () => {
		const { ws, store, handler } = setup();
		const file = join(ws, "notes.md");
		writeFileSync(file, "原文\n");
		const result = await handler({ toolName: "write", toolCallId: "call-1", input: { path: "notes.md", content: "改后\n" } });
		expect(result).toBeUndefined();
		expect(listProposals({ dir: store }).entries).toEqual([]);
	});

	it("开启时 block、建议落盘、目标文件字节不变", async () => {
		const { ws, store, blocked, handler, setEnabled } = setup();
		setEnabled(true);
		const file = join(ws, "notes.md");
		const originalBytes = Buffer.from("第一行\n第二行\n", "utf8");
		writeFileSync(file, originalBytes);
		const result = await handler({
			toolName: "edit",
			toolCallId: "call-2",
			input: { path: "notes.md", edits: [{ oldText: "第二行", newText: "第二行改" }] },
		});
		/* 宿主按同一个 toolCallId 认领「不是失败」；没有回执就会画成红卡。 */
		expect(blocked.map((info) => info.toolCallId)).toEqual(["call-2"]);
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/待审建议/);
		/* 跨层协议：回放与界面按这个前缀认出「不是失败」（shared/doc-edit.js）。 */
		expect(result?.reason.startsWith(DOC_EDIT_BLOCK_PREFIX)).toBe(true);
		expect(isDocEditBlockText(result?.reason)).toBe(true);
		expect(result?.reason).toMatch(/不要原样重试/);
		// 目标文件一个字节都没动。
		expect(readFileSync(file).equals(originalBytes)).toBe(true);

		const { entries } = listProposals({ dir: store });
		expect(entries).toHaveLength(1);
		const proposal = readProposal(entries[0].id, { dir: store });
		expect(proposal.sessionId).toBe("sess-live");
		expect(proposal.toolName).toBe("edit");
		expect(proposal.before).toBe("第一行\n第二行\n");
		expect(proposal.after).toBe("第一行\n第二行改\n");
	});

	it("非白名单扩展名 / 区外路径 / oldText 不匹配 → block 且不落建议", async () => {
		const { ws, store, handler, setEnabled } = setup();
		setEnabled(true);
		writeFileSync(join(ws, "notes.md"), "原文\n");

		const script = await handler({ toolName: "write", input: { path: "main.js", content: "x" } });
		expect(script?.block).toBe(true);
		expect(script?.reason).toMatch(/\.md \/ \.markdown \/ \.txt/);

		const outside = await handler({ toolName: "write", input: { path: "../outside.md", content: "x" } });
		expect(outside?.block).toBe(true);
		expect(outside?.reason).toMatch(/工作区内/);

		const mismatch = await handler({
			toolName: "edit",
			input: { path: "notes.md", edits: [{ oldText: "不存在的原文", newText: "x" }] },
		});
		expect(mismatch?.block).toBe(true);
		expect(mismatch?.reason).toMatch(/oldText 在目标文件里找不到/);

		expect(listProposals({ dir: store }).entries).toEqual([]);
		expect(readFileSync(join(ws, "notes.md"), "utf8")).toBe("原文\n");
	});

	it("没有实际改动 → block 且不落建议", async () => {
		const { ws, store, handler, setEnabled } = setup();
		setEnabled(true);
		writeFileSync(join(ws, "notes.md"), "原文\n");
		const result = await handler({ toolName: "write", input: { path: "notes.md", content: "原文\n" } });
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/没有产生任何实际改动/);
		expect(listProposals({ dir: store }).entries).toEqual([]);
	});

	it("新建文件（原本不存在）也能进建议，before 为空串", async () => {
		const { ws, store, handler, setEnabled } = setup();
		setEnabled(true);
		mkdirSync(join(ws, "sub"), { recursive: true });
		const result = await handler({ toolName: "write", input: { path: "sub/new.md", content: "# 新文档\n" } });
		expect(result?.block).toBe(true);
		const { entries } = listProposals({ dir: store });
		expect(entries).toHaveLength(1);
		const proposal = readProposal(entries[0].id, { dir: store });
		expect(proposal.before).toBe("");
		expect(proposal.baseSha256).toBe(sha256(""));
		expect(existsSync(join(ws, "sub", "new.md"))).toBe(false);
	});
});
