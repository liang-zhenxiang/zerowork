/**
 * 「留为会话」（INVOKE.compareKeep）daemon 侧的单元测试。
 *
 * 四块，对应 compare.js 里新增的四个出口：
 *
 * 1. **rewriteKeptSessionLines**（文件手术，核心）：剔除 `compare_run` 条目并重接
 *    parentId、改写 header.cwd。这条链为什么是全功能成败的关键：pi 的分叉会**连
 *    标记一起复制**，而 `readSessionHeadMarkers`（session-files.js）扫描文件头部、
 *    **遇第一条 message 就停** —— 不从头部剔除条目本身，新会话就被列表与统计双重
 *    过滤，「用户点完什么也看不到」；且标记是第一条 user 消息的**父节点**，只删行
 *    不重接 parentId 会让 user 变孤儿，resume 时整条对话**静默丢失**。
 *    这里全部用手写的 jsonl 文本行做夹具，不真起 pi —— 手术是纯函数正是为了这一点。
 * 2. **keptSessionTitle**：`{模型名} · {问题前 N 字}` 的格式、截断与回落。
 * 3. **createKeptColumnRegistry**（登记表）：命中 / 未命中 / 防重复 / 上限淘汰。
 *    runner 在 run 结束即 `runs.delete(runId)`，「几十秒后再点」全靠这份另立的账。
 * 4. **createCompareRunner 的登记时机**：只有到达终态 done 的列进登记表
 *    （failed / cancelled 列的文件可能还没落盘）。
 *
 * 真实 IPC / 分叉 / 落盘那一层由端到端用例守（compare-keep.mjs）。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createCompareRunner,
	createKeptColumnRegistry,
	keptSessionTitle,
	rewriteKeptSessionLines,
} from "../../src/main/daemon/compare.js";
import { SESSION_TITLE_MAX } from "../../src/main/daemon/session-state.js";

/** 一个真实存在的目录：编排层会 `mkdirSync(cwd)`。 */
const CWD = mkdtempSync(join(tmpdir(), "compare-keep-"));

/* ── 夹具：手写 jsonl 行（形状对齐 pi 的真实条目）────────────────────── */

const COMPARE_CWD = "/ws/临时任务/compare";
const USER_CWD = "/ws/projects/demo";

const headerLine = (overrides = {}) =>
	JSON.stringify({ type: "session", id: "s-1", cwd: COMPARE_CWD, ...overrides });
const markerLine = (id, parentId, model) =>
	JSON.stringify({ type: "custom", customType: "compare_run", id, parentId, data: { model } });
/** 别的 custom 条目（如 session_info / artifacts_presented）：必须原样保留。 */
const otherCustomLine = (id, parentId, customType = "session_info") =>
	JSON.stringify({ type: "custom", customType, id, parentId, data: { name: "原名" } });
const messageLine = (id, parentId, role, text) =>
	JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: 1_800_000_000_000,
		message: { role, content: text },
	});

/**
 * 复刻 `readSessionHeadMarkers` 的口径（session-files.js）：扫文件开头、
 * 遇第一条 message 就停、看到子会话类 custom 标记即 childSession = true。
 * 手术的产出要过**这一关**，新会话才可见 —— 直接拿真实判据做断言。
 */
const CHILD_SESSION_TYPES = new Set(["subagent_run", "team_member", "compare_run"]);
function headSeesChildSession(lines) {
	let childSession = false;
	for (const line of lines) {
		if (line.trim() === "") continue;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof entry !== "object" || entry === null) continue;
		if (entry.type === "custom") {
			if (typeof entry.customType === "string" && CHILD_SESSION_TYPES.has(entry.customType)) {
				childSession = true;
			}
			continue;
		}
		if (entry.type === "message") break;
	}
	return childSession;
}

function parseAll(lines) {
	return lines.filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. 文件手术：rewriteKeptSessionLines
 * ══════════════════════════════════════════════════════════════════════════ */

describe("rewriteKeptSessionLines —— 剔除标记", () => {
	it("头部扫描读不到 compare_run（这条直接决定新会话可不可见）", () => {
		const lines = [
			headerLine(),
			markerLine("m-1", null, "prov-a/model-a"),
			messageLine("u-1", "m-1", "user", "用一句话说说你是什么模型"),
			messageLine("a-1", "u-1", "assistant", "ALPHA 的回答"),
		];
		const out = rewriteKeptSessionLines(lines, USER_CWD);

		expect(headSeesChildSession(out)).toBe(false);
		// 整个文件里都不再有 compare_run（不只在头部）
		expect(out.some((line) => line.includes('"compare_run"'))).toBe(false);
		expect(out).toHaveLength(3);
	});

	it("手术是幂等的：对产出再跑一次（同 cwd）返回同一引用", () => {
		const lines = [
			headerLine(),
			markerLine("m-1", null, "prov-a/model-a"),
			messageLine("u-1", "m-1", "user", "问"),
			messageLine("a-1", "u-1", "assistant", "答"),
		];
		const once = rewriteKeptSessionLines(lines, USER_CWD);
		expect(rewriteKeptSessionLines(once, USER_CWD)).toBe(once);
	});

	it("没有 compare_run 的文件原样返回（同引用，不炸）", () => {
		const lines = [
			headerLine({ cwd: USER_CWD }),
			messageLine("u-1", null, "user", "问"),
			messageLine("a-1", "u-1", "assistant", "答"),
		];
		expect(rewriteKeptSessionLines(lines, USER_CWD)).toBe(lines);
	});

	it("没有 compare_run 但 cwd 不同：只改写 header，条目行逐字不动", () => {
		const lines = [
			headerLine(),
			messageLine("u-1", null, "user", "问"),
			messageLine("a-1", "u-1", "assistant", "答"),
		];
		const out = rewriteKeptSessionLines(lines, USER_CWD);
		expect(out).toHaveLength(3);
		expect(JSON.parse(out[0]).cwd).toBe(USER_CWD);
		expect(out[1]).toBe(lines[1]);
		expect(out[2]).toBe(lines[2]);
	});
});

describe("rewriteKeptSessionLines —— 重接 parentId", () => {
	it("user 的 parent 从标记条目改回原根（null），assistant 的 parent 不动", () => {
		const lines = [
			headerLine(),
			markerLine("m-1", null, "prov-a/model-a"),
			messageLine("u-1", "m-1", "user", "问"),
			messageLine("a-1", "u-1", "assistant", "答"),
		];
		const entries = parseAll(rewriteKeptSessionLines(lines, USER_CWD));
		const user = entries.find((entry) => entry.id === "u-1");
		const assistant = entries.find((entry) => entry.id === "a-1");
		expect(user.parentId).toBeNull();
		// user 行的其余字段不丢（重接是改一个字段，不是重造条目）
		expect(user.message).toEqual({ role: "user", content: "问" });
		expect(assistant.parentId).toBe("u-1");
	});

	it("标记前面有别的 custom（如 session_info）：重接到最近的存活祖先，别的 custom 保留", () => {
		const info = otherCustomLine("c-1", null);
		const lines = [
			headerLine(),
			info,
			markerLine("m-1", "c-1", "prov-a/model-a"),
			messageLine("u-1", "m-1", "user", "问"),
			messageLine("a-1", "u-1", "assistant", "答"),
		];
		const out = rewriteKeptSessionLines(lines, USER_CWD);
		expect(out).toContain(info);
		const entries = parseAll(out);
		expect(entries.find((entry) => entry.id === "u-1").parentId).toBe("c-1");
	});

	it("两个相连的标记都剔除：user 重接回 null（逐级向上找存活祖先）", () => {
		const lines = [
			headerLine(),
			markerLine("m-1", null, "prov-a/model-a"),
			markerLine("m-2", "m-1", "prov-a/model-a"),
			messageLine("u-1", "m-2", "user", "问"),
		];
		const entries = parseAll(rewriteKeptSessionLines(lines, USER_CWD));
		expect(entries.find((entry) => entry.id === "u-1").parentId).toBeNull();
		expect(entries.some((entry) => entry.id === "m-1" || entry.id === "m-2")).toBe(false);
	});

	it("标记出现在会话中段（user 之后）：照样剔除并重接它下面的条目", () => {
		const lines = [
			headerLine(),
			messageLine("u-1", null, "user", "问"),
			markerLine("m-1", "u-1", "prov-a/model-a"),
			messageLine("a-1", "m-1", "assistant", "答"),
		];
		const entries = parseAll(rewriteKeptSessionLines(lines, USER_CWD));
		expect(entries.find((entry) => entry.id === "a-1").parentId).toBe("u-1");
	});
});

describe("rewriteKeptSessionLines —— 改写 header.cwd", () => {
	it("compare 目录 → 用户工作空间；header 无 cwd 字段时补上；其余字段保留", () => {
		const lines = [
			headerLine({ parentSession: "/sessions/mother.jsonl" }),
			markerLine("m-1", null, "prov-a/model-a"),
			messageLine("u-1", "m-1", "user", "问"),
		];
		const header = parseAll(rewriteKeptSessionLines(lines, USER_CWD)).find(
			(entry) => entry.type === "session",
		);
		expect(header.cwd).toBe(USER_CWD);
		expect(header.parentSession).toBe("/sessions/mother.jsonl");
		expect(header.id).toBe("s-1");

		const noCwd = [
			JSON.stringify({ type: "session", id: "s-2" }),
			messageLine("u-1", null, "user", "问"),
		];
		const patched = parseAll(rewriteKeptSessionLines(noCwd, USER_CWD)).find(
			(entry) => entry.type === "session",
		);
		expect(patched.cwd).toBe(USER_CWD);
	});

	it("坏行与空行原样保留在原位（与 pi 的逐行解析口径一致）", () => {
		const broken = "not json at all";
		const lines = [headerLine(), broken, "", markerLine("m-1", null, "p/m"), messageLine("u-1", "m-1", "user", "问")];
		const out = rewriteKeptSessionLines(lines, USER_CWD);
		expect(out[1]).toBe(broken);
		expect(out[2]).toBe("");
		expect(out.some((line) => line.includes('"compare_run"'))).toBe(false);
	});
});

/* ══════════════════════════════════════════════════════════════════════════
 * 2. 标题：keptSessionTitle
 * ══════════════════════════════════════════════════════════════════════════ */

describe("keptSessionTitle —— 格式 / 截断 / 回落", () => {
	it("基本格式：{模型展示名} · {问题}", () => {
		expect(keptSessionTitle("prov-a/model-a", "Mock Alpha", "怎么写周报")).toBe("Mock Alpha · 怎么写周报");
	});

	it("超长问题截断到 SESSION_TITLE_MAX 并补省略号", () => {
		const question = "这".repeat(SESSION_TITLE_MAX + 20);
		const title = keptSessionTitle("prov-a/model-a", "Mock Alpha", question);
		expect(title).toBe(`Mock Alpha · ${question.slice(0, SESSION_TITLE_MAX)}…`);
		// 恰好等于上限时不截断（与 deriveSessionTitle 同口径：> 才截）
		expect(keptSessionTitle("p/m", "N", "字".repeat(SESSION_TITLE_MAX))).toBe(
			`N · ${"字".repeat(SESSION_TITLE_MAX)}`,
		);
	});

	it("模型名解析失败回落到 key 的 id 段（与渲染层 describeModel 的回落同源）", () => {
		expect(keptSessionTitle("prov-a/model-a", undefined, "问")).toBe("model-a · 问");
		// 空白展示名同样回落，不让标题变成「 · 问」
		expect(keptSessionTitle("prov-a/model-a", "   ", "问")).toBe("model-a · 问");
		expect(keptSessionTitle("model-a", undefined, "问")).toBe("model-a · 问");
		expect(keptSessionTitle(undefined, undefined, "问")).toBe("未知模型 · 问");
	});

	it("问题为空（空串 / 纯空白 / 非字符串）：标题只有模型名", () => {
		expect(keptSessionTitle("p/m", "Mock Alpha", "")).toBe("Mock Alpha");
		expect(keptSessionTitle("p/m", "Mock Alpha", "  \n  ")).toBe("Mock Alpha");
		expect(keptSessionTitle("p/m", "Mock Alpha", undefined)).toBe("Mock Alpha");
	});

	it("问题里的换行与连续空白压成单个空格（单行标题）", () => {
		expect(keptSessionTitle("p/m", "N", "第一行\n\n第二行   有空格")).toBe("N · 第一行 第二行 有空格");
	});
});

/* ══════════════════════════════════════════════════════════════════════════
 * 3. 登记表：createKeptColumnRegistry
 * ══════════════════════════════════════════════════════════════════════════ */

describe("createKeptColumnRegistry —— 命中 / 未命中 / 防重复 / 上限", () => {
	it("登记后能按 runId+columnId 命中，entry 带 path / modelKey / prompt", () => {
		const registry = createKeptColumnRegistry(16);
		registry.register("compare-1", "col-0", {
			path: "/sessions/a.jsonl",
			modelKey: "prov-a/model-a",
			prompt: "问题",
		});
		// 只断言对外契约字段（claimed 是登记表的内部占位旗标，不是接口）
		expect(registry.lookup("compare-1", "col-0")).toMatchObject({
			runId: "compare-1",
			columnId: "col-0",
			path: "/sessions/a.jsonl",
			modelKey: "prov-a/model-a",
			prompt: "问题",
		});
		expect(registry.lookup("compare-1", "col-0").keptPath).toBeUndefined();
		// 未命中：run 结束太久（被淘汰）/ runId 记错，都长这样
		expect(registry.lookup("compare-99", "col-0")).toBeUndefined();
		expect(registry.claim("compare-99", "col-0")).toEqual({ status: "missing" });
	});

	it("同一 runId+columnId 只留一次：complete 之后再 claim 明确报 kept", () => {
		const registry = createKeptColumnRegistry(16);
		registry.register("compare-1", "col-0", { path: "/sessions/a.jsonl", modelKey: "p/m", prompt: "问" });
		expect(registry.claim("compare-1", "col-0").status).toBe("ok");
		registry.complete("compare-1", "col-0", "/sessions/kept.jsonl");
		const again = registry.claim("compare-1", "col-0");
		expect(again.status).toBe("kept");
		expect(again.keptPath).toBe("/sessions/kept.jsonl");
		expect(registry.lookup("compare-1", "col-0").keptPath).toBe("/sessions/kept.jsonl");
	});

	it("claim 是占位：手术进行中的第二次 claim 报 busy，release 后可重试", () => {
		const registry = createKeptColumnRegistry(16);
		registry.register("compare-1", "col-0", { path: "/sessions/a.jsonl", modelKey: "p/m", prompt: "问" });
		expect(registry.claim("compare-1", "col-0").status).toBe("ok");
		expect(registry.claim("compare-1", "col-0")).toEqual({ status: "busy" });
		// 手术失败：释放占位，按钮回弹后重试必须还能走通
		registry.release("compare-1", "col-0");
		expect(registry.claim("compare-1", "col-0").status).toBe("ok");
	});

	it("上限淘汰：超出 limit 的最老条目被挤掉（后来的还在）", () => {
		const registry = createKeptColumnRegistry(2);
		for (const runId of ["compare-1", "compare-2", "compare-3"]) {
			registry.register(runId, "col-0", { path: `/sessions/${runId}.jsonl`, modelKey: "p/m", prompt: "问" });
		}
		expect(registry.claim("compare-1", "col-0")).toEqual({ status: "missing" });
		expect(registry.claim("compare-2", "col-0").status).toBe("ok");
		expect(registry.claim("compare-3", "col-0").status).toBe("ok");
	});

	it("limit 下限保护：limit 为 1 时不会把刚登记的又挤掉", () => {
		const registry = createKeptColumnRegistry(1);
		registry.register("compare-1", "col-0", { path: "/sessions/a.jsonl", modelKey: "p/m", prompt: "问" });
		registry.register("compare-2", "col-0", { path: "/sessions/b.jsonl", modelKey: "p/m", prompt: "问" });
		expect(registry.claim("compare-1", "col-0")).toEqual({ status: "missing" });
		expect(registry.claim("compare-2", "col-0").status).toBe("ok");
	});
});

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 编排层的登记时机（createCompareRunner + 注入的登记表）
 * ══════════════════════════════════════════════════════════════════════════ */

/** 造一个带注入登记表的编排环境（宿主是最小 mock，只实现编排真正用到的四个口）。 */
function buildEnv({ scripts = {}, keptRegistry, hostOverrides } = {}) {
	const runner = createCompareRunner({
		getCatalog: async () => ({ isUsable: () => true }),
		resources: { modes: [] },
		getThinkingLevel: () => undefined,
		getCwd: () => CWD,
		isTempCwd: () => true,
		keptRegistry,
		createHost: async (options) => {
			const script = scripts[options.modelKey] ?? { kind: "ok" };
			return {
				sessionFilePath: `${CWD}/session-${options.modelKey.replace(/\//g, "_")}.jsonl`,
				markCompareRun() {},
				async prompt() {
					if (script.kind === "error") {
						options.emit({ type: "assistant_done", message: { id: "m", role: "assistant", text: "", at: 0 } });
						options.emit({ type: "run_error", runId: "r", message: script.error ?? "上游 500" });
						return;
					}
					options.emit({ type: "assistant_text_delta", messageId: "m", delta: "答" });
					options.emit({ type: "assistant_done", message: { id: "m", role: "assistant", text: script.text ?? "答案", at: 0 } });
					options.emit({ type: "run_finished", runId: "r", outcome: "completed" });
				},
				async abort() {},
				dispose() {},
				...(hostOverrides?.(options) ?? {}),
			};
		},
	});
	return { runner };
}

describe("createCompareRunner —— 「留为会话」登记", () => {
	it("done 的列进登记表（path / modelKey / prompt 齐全）；failed 的列不进", async () => {
		const kept = createKeptColumnRegistry(16);
		const { runner } = buildEnv({
			scripts: { "a/one": { kind: "ok", text: "甲" }, "b/two": { kind: "error" } },
			keptRegistry: kept,
		});
		const done = await runner.run({
			models: ["a/one", "b/two"],
			prompt: "同一个问题",
			onEvent: () => {},
		});
		expect(done.ok).toBe(true);
		// run 早已从 runs 里删掉（runs.delete 是既有语义）—— 登记表是另一份账，
		// 「几十秒后再点」靠的是它，不是 runner 的内存。
		const hit = kept.lookup(done.runId, "col-0");
		expect(hit).toMatchObject({ modelKey: "a/one", prompt: "同一个问题" });
		expect(typeof hit.path).toBe("string");
		expect(kept.claim(done.runId, "col-1")).toEqual({ status: "missing" });
	});

	it("宿主拿不出会话文件路径（in-memory 会话）时不登记，也不炸", async () => {
		const kept = createKeptColumnRegistry(16);
		const { runner } = buildEnv({
			keptRegistry: kept,
			hostOverrides: () => ({ sessionFilePath: undefined }),
		});
		const done = await runner.run({
			models: ["a/one", "b/two"],
			prompt: "问题",
			onEvent: () => {},
		});
		expect(done.columns.map((column) => column.status)).toEqual(["done", "done"]);
		expect(kept.claim(done.runId, "col-0")).toEqual({ status: "missing" });
		expect(kept.claim(done.runId, "col-1")).toEqual({ status: "missing" });
	});
});
