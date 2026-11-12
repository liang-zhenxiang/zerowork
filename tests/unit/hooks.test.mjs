/**
 * 确定性 hooks（`src/main/daemon/hooks.js`）的单测。
 *
 * 这一层的错误形态几乎都是**静默失效**：hook 没有真的拦住调用、用户级配置
 * 把工作区级的拒绝覆盖掉、超时后进程留着继续跑、未信任的工作区文件被执行。
 * 它们都不会崩，只会让用户「以为写了一条规则、其实没有」—— 正是单测该钉住的。
 *
 * 不 import Electron、不启动 Electron：本模块只碰 node 内置模块。
 * 子进程一律**注入假 runner**，不依赖 bash / PowerShell 存在
 *（单测在 ubuntu 与 windows 两个 job 上跑）。
 *
 * ── 反向验证（改动时照做）──────────────────────────────────────────
 * 1) 把 `decideVerdict` 的 `exitCode === 2 → "deny"` 改成 `"allow"`：
 *    「退出码 2 是拒绝」与「PreToolUse 短路」两条用例变红。
 * 2) 把 `resolveHookSet` 里 `workspace.exists && trusted` 的 `trusted` 去掉：
 *    「未信任的工作区不进入可执行集合」那条变红。
 * 3) 把 `runHooks` 的 `if (blockable && result.verdict !== "allow") break`
 *    删掉：「任一拒绝即停」那条变红（spawn 次数从 1 变 2）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BLOCKING_EVENTS,
	HOOK_EVENTS,
	HOOK_OUTPUT_MAX,
	HOOK_TIMEOUT_DEFAULT,
	HOOK_TIMEOUT_MAX,
	HOOK_TIMEOUT_MIN,
	LIFECYCLE_EVENTS,
	TOOL_EVENTS,
	assertHookConfig,
	chooseWorkspaceRoot,
	createLifecycleHookExtension,
	createPostToolUseHookExtension,
	createPreToolUseHookExtension,
	decideVerdict,
	isPathInside,
	isWorkspaceTrusted,
	matchTool,
	matchesEvent,
	normalizeHook,
	normalizeTrustedWorkspaceHooks,
	normalizeWorkspacePath,
	parseHookConfig,
	payloadForPostToolUse,
	payloadForPreToolUse,
	payloadForSessionStart,
	payloadForStop,
	payloadForUserPromptSubmit,
	readWorkspaceHookConfig,
	resolveHookSet,
	resolveSavedHook,
	runHook,
	runHooks,
	shellInvocation,
	workspaceHooksPath,
} from "../../src/main/daemon/hooks.js";
import { buildSubagentExtensions } from "../../src/main/daemon/command-exec.js";
import { worktreeInfoFromCwd } from "../../src/main/daemon/git-worktree.js";

/**
 * 假子进程：事件都在**微任务**里发出 —— `runHook` 是先挂监听再等结果，
 * 同步 emit 会全部丢掉（那会得到「永远挂起」的假现场）。
 */
function createFakeChild({ stdout = "", stderr = "", closeCode = 0, hang = false, error } = {}) {
	const child = new EventEmitter();
	child.pid = 4321;
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.stdin = new EventEmitter();
	child.stdin.end = () => {};
	child.kill = () => {};
	Promise.resolve().then(() => {
		if (stdout !== "") child.stdout.emit("data", stdout);
		if (stderr !== "") child.stderr.emit("data", stderr);
		if (error !== undefined) {
			child.emit("error", new Error(error));
			return;
		}
		if (!hang) child.emit("close", closeCode);
	});
	return child;
}

function fakeSpawn(behaviors) {
	const calls = [];
	let index = 0;
	const spawn = (file, args, options) => {
		const behavior = behaviors[Math.min(index, behaviors.length - 1)] ?? {};
		index += 1;
		const child = createFakeChild(behavior);
		// 超时杀进程树时，close 仍要回来（模拟 SIGKILL 生效）。
		child.kill = () => {
			Promise.resolve().then(() => child.emit("close", null));
		};
		calls.push({ file, args, options, child });
		return child;
	};
	return { spawn, calls };
}

const cleanups = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()();
	vi.useRealTimers();
});

function makeWorkspace() {
	const root = mkdtempSync(join(tmpdir(), "zerowork-hooks-unit-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, ".zerowork"), { recursive: true });
	return root;
}

function writeWorkspaceHooks(root, content) {
	writeFileSync(workspaceHooksPath(root), content, "utf8");
}

const goodHook = { id: "h-1", event: "PreToolUse", command: "exit 0" };

describe("matchTool —— 只支持精确名 / * / 前缀", () => {
	it("精确名与通配", () => {
		expect(matchTool("write", "write")).toBe(true);
		expect(matchTool("write", "write_file")).toBe(false);
		expect(matchTool("*", "anything")).toBe(true);
		expect(matchTool(undefined, "anything")).toBe(true);
		expect(matchTool("", "anything")).toBe(true);
	});

	it("前缀只认末尾的 *", () => {
		expect(matchTool("write*", "write")).toBe(true);
		expect(matchTool("write*", "write_file")).toBe(true);
		expect(matchTool("write*", "read")).toBe(false);
	});

	it("不在末尾或含多个 * 的写法按精确名处理，不当正则猜", () => {
		expect(matchTool("wr*te", "write")).toBe(false);
		expect(matchTool("*write", "write")).toBe(false);
	});
});

describe("matchesEvent —— matcher 只作用于工具事件", () => {
	const pre = { ...goodHook, matcher: "write" };
	it("事件不同即不匹配", () => {
		expect(matchesEvent(pre, "PostToolUse", "write")).toBe(false);
	});
	it("工具事件看 matcher", () => {
		expect(matchesEvent(pre, "PreToolUse", "write")).toBe(true);
		expect(matchesEvent(pre, "PreToolUse", "read")).toBe(false);
	});
	it("生命周期事件忽略 matcher（没有工具名可比）", () => {
		const stop = { id: "s", event: "Stop", command: "x", timeoutMs: 1000 };
		expect(matchesEvent(stop, "Stop", undefined)).toBe(true);
		expect(matchesEvent(stop, "Stop", "write")).toBe(true);
	});
});

/*
 * 事件表是「哪些事件存在」与「哪些能阻断」的单一事实源。
 * 写死断言而不是 `toContain` 是有意的：多一个/少一个事件都必须被人看见 ——
 * 少一个 = 用户配了却永不触发；多一个 = 可能悄悄改变安全边界。
 */
describe("事件表 —— 五个事件、三类生命周期、只有一个可阻断", () => {
	it("HOOK_EVENTS 含三个生命周期事件（顺序即设置页下拉顺序）", () => {
		expect(HOOK_EVENTS).toEqual(["PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit", "Stop"]);
	});

	it("TOOL_EVENTS / LIFECYCLE_EVENTS 覆盖全部事件且互斥", () => {
		expect([...TOOL_EVENTS]).toEqual(["PreToolUse", "PostToolUse"]);
		expect([...LIFECYCLE_EVENTS]).toEqual(["SessionStart", "UserPromptSubmit", "Stop"]);
		const union = new Set([...TOOL_EVENTS, ...LIFECYCLE_EVENTS]);
		expect([...union].sort()).toEqual([...HOOK_EVENTS].sort());
		for (const event of TOOL_EVENTS) expect(LIFECYCLE_EVENTS.has(event)).toBe(false);
	});

	it("BLOCKING_EVENTS 只有 PreToolUse —— 三个生命周期事件都不可阻断", () => {
		expect([...BLOCKING_EVENTS]).toEqual(["PreToolUse"]);
		for (const event of LIFECYCLE_EVENTS) expect(BLOCKING_EVENTS.has(event)).toBe(false);
		expect(BLOCKING_EVENTS.has("PostToolUse")).toBe(false);
	});
});

describe("生命周期事件的 matcher 校验 —— 接受却不生效比报错更坏", () => {
	it("缺省 / 空串 / * 都通过，且不写回 matcher", () => {
		const bare = normalizeHook({ event: "SessionStart", command: "x" });
		expect(bare.matcher).toBeUndefined();
		expect(normalizeHook({ event: "UserPromptSubmit", command: "x", matcher: "" }).matcher).toBeUndefined();
		expect(normalizeHook({ event: "Stop", command: "x", matcher: "*" }).matcher).toBe("*");
	});

	it("写工具名被拒，错误里说清原因与实际值", () => {
		expect(() => normalizeHook({ event: "UserPromptSubmit", command: "x", matcher: "write*" })).toThrow(
			/没有工具名/u,
		);
		expect(() => normalizeHook({ event: "UserPromptSubmit", command: "x", matcher: "write*" })).toThrow(
			/write\*/u,
		);
		expect(() => normalizeHook({ event: "Stop", command: "x", matcher: "bash" })).toThrow(/没有工具名/u);
	});

	it("写侧整体校验同样拒绝（assertHookConfig 会抛）", () => {
		expect(() =>
			assertHookConfig([
				{ id: "a", event: "PreToolUse", matcher: "write*", command: "x" },
				{ id: "b", event: "SessionStart", matcher: "write*", command: "x" },
			]),
		).toThrow(/没有工具名/u);
	});

	it("工具事件仍接受工具名 matcher", () => {
		expect(normalizeHook({ event: "PreToolUse", matcher: "write*", command: "x" }).matcher).toBe("write*");
		expect(normalizeHook({ event: "PostToolUse", matcher: "ls", command: "x" }).matcher).toBe("ls");
	});
});

describe("parseHookConfig —— 读侧宽容、结构坏掉才 fatal", () => {
	it("未配置即空", () => {
		expect(parseHookConfig(undefined)).toEqual({ hooks: [], errors: [], fatal: false, fatalMessage: undefined });
	});

	it("接受数组与 { version, hooks } 两种形状", () => {
		expect(parseHookConfig([goodHook]).hooks).toHaveLength(1);
		expect(parseHookConfig({ version: 1, hooks: [goodHook] }).hooks).toHaveLength(1);
	});

	it("单条坏数据只丢该条，其余保留", () => {
		const parsed = parseHookConfig([goodHook, { event: "Nope", command: "" }]);
		expect(parsed.hooks).toHaveLength(1);
		expect(parsed.errors).toHaveLength(1);
		expect(parsed.fatal).toBe(false);
	});

	it("结构非法是 fatal", () => {
		expect(parseHookConfig("nope").fatal).toBe(true);
		expect(parseHookConfig({ version: 1 }).fatal).toBe(true);
	});

	it("超时越界 / 命令为空 / 事件非法都会被拒", () => {
		expect(() => normalizeHook({ event: "PreToolUse", command: "x", timeoutMs: HOOK_TIMEOUT_MIN - 1 })).toThrow();
		expect(() => normalizeHook({ event: "PreToolUse", command: "x", timeoutMs: HOOK_TIMEOUT_MAX + 1 })).toThrow();
		expect(() => normalizeHook({ event: "PreToolUse", command: "   " })).toThrow();
		expect(() => normalizeHook({ event: "Nope", command: "x" })).toThrow();
	});

	it("缺省超时是 5000", () => {
		expect(normalizeHook({ event: "PreToolUse", command: "x" }).timeoutMs).toBe(HOOK_TIMEOUT_DEFAULT);
	});
});

describe("assertHookConfig —— 写侧严格", () => {
	it("任一条非法即抛错", () => {
		expect(() => assertHookConfig([goodHook, { event: "PreToolUse", command: "" }])).toThrow(/第 2 条/);
	});
	it("重复 id 被拒", () => {
		expect(() => assertHookConfig([goodHook, goodHook])).toThrow(/重复/);
	});
	it("合法输入原样返回", () => {
		expect(assertHookConfig([goodHook])[0].id).toBe("h-1");
	});
});

describe("信任名单规范化", () => {
	it("丢弃非字符串并去重", () => {
		// 规范形是「绝对 + 小写（Windows）」：/a 在 Windows 上会被解析到当前盘符，
		// 所以期望值必须按平台算，不能写死 POSIX 路径。
		const shape = (p) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
		const parsed = normalizeTrustedWorkspaceHooks(["/a", "/a", 1, "", "/b"]);
		expect(parsed).toEqual([shape("/a"), shape("/b")]);
	});
	it("非数组整块忽略", () => {
		expect(normalizeTrustedWorkspaceHooks("nope")).toBeUndefined();
	});
	it("按绝对路径判定信任", () => {
		expect(isWorkspaceTrusted("/a/b", ["/a/b"])).toBe(true);
		expect(isWorkspaceTrusted("/a/b", ["/a/c"])).toBe(false);
		expect(isWorkspaceTrusted("/a/b", undefined)).toBe(false);
	});
	/*
	 * macOS 上 `/tmp` 与 `/var` 都是链接（`/tmp/ws` 与 `/private/tmp/ws`
	 * 是同一个目录），Windows 上的目录联接同理。两边不展开符号链接时，
	 * 用户「信任了」而会话 cwd 走另一个写法 → 信任静默不生效。
	 */
	it("符号链接在比较前被展开（信任与 cwd 写法不同也能对上）", () => {
		const root = makeWorkspace();
		const linkParent = mkdtempSync(join(tmpdir(), "zerowork-hooks-link-"));
		const link = join(linkParent, "ws-link");
		cleanups.push(() => rmSync(linkParent, { recursive: true, force: true }));
		try {
			symlinkSync(root, link, "dir");
		} catch {
			// Windows 未开启开发者模式时建不了符号链接：这条性质无从验证。
			return;
		}
		expect(normalizeWorkspacePath(link)).toBe(normalizeWorkspacePath(root));
		expect(isWorkspaceTrusted(link, [root])).toBe(true);
		expect(isWorkspaceTrusted(root, [link])).toBe(true);
	});

	it("路径包含判断不会把前缀相同的目录当成内部", () => {
		expect(isPathInside("/a/reports", "/a/reports/x.json")).toBe(true);
		expect(isPathInside("/a/reports", "/a/reports-old/x.json")).toBe(false);
		expect(isPathInside("/a/reports", "/a/reports")).toBe(false);
	});
});

describe("chooseWorkspaceRoot —— worktree 用源仓库、任务区回退生效根", () => {
	const effectiveRoot = "/home/u/ZeroWork";
	const cases = [
		{
			name: "worktree 优先用源仓库（即使 cwd 被判定为任务区）",
			input: { cwd: "/cfg/worktrees/repo/main-abcd", sourceCwd: "/repo", isTask: true, effectiveRoot },
			want: "/repo",
		},
		{
			name: "临时任务 / 自动会话目录回退生效工作区根",
			input: { cwd: "/home/u/ZeroWork/2026-11-12-101010", isTask: true, effectiveRoot },
			want: effectiveRoot,
		},
		{
			name: "普通会话用自己的 cwd",
			input: { cwd: "/repo", isTask: false, effectiveRoot },
			want: "/repo",
		},
		{
			name: "还没有 cwd 的新会话回退生效根",
			input: { cwd: "", isTask: true, effectiveRoot },
			want: effectiveRoot,
		},
	];
	for (const { name, input, want } of cases) {
		it(name, () => expect(chooseWorkspaceRoot(input)).toBe(want));
	}
});

describe("worktreeInfoFromCwd —— 从 .git 反推源仓库", () => {
	it("解析 gitdir 得到 sourceCwd（这样按源仓库信任的规则才命中）", () => {
		const previous = process.env["ZEROWORK_CONFIG_DIR"];
		const configDir = mkdtempSync(join(tmpdir(), "zerowork-hooks-worktree-"));
		try {
			process.env["ZEROWORK_CONFIG_DIR"] = configDir;
			const source = join(configDir, "source-repo");
			const worktreePath = join(configDir, "worktrees", "repo", "main-abcd1234");
			mkdirSync(worktreePath, { recursive: true });
			writeFileSync(join(worktreePath, ".git"), `gitdir: ${source}/.git/worktrees/wt-1\n`, "utf8");
			const info = worktreeInfoFromCwd(worktreePath);
			expect(info?.worktreePath).toBe(worktreePath);
			expect(info?.sourceCwd).toBe(source);
		} finally {
			if (previous === undefined) delete process.env["ZEROWORK_CONFIG_DIR"];
			else process.env["ZEROWORK_CONFIG_DIR"] = previous;
			rmSync(configDir, { recursive: true, force: true });
		}
	});

	it("读不到 .git 时 sourceCwd 缺席，但不抛错", () => {
		const previous = process.env["ZEROWORK_CONFIG_DIR"];
		const configDir = mkdtempSync(join(tmpdir(), "zerowork-hooks-worktree-"));
		try {
			process.env["ZEROWORK_CONFIG_DIR"] = configDir;
			const worktreePath = join(configDir, "worktrees", "repo", "main-abcd1234");
			mkdirSync(worktreePath, { recursive: true });
			const info = worktreeInfoFromCwd(worktreePath);
			expect(info?.sourceCwd).toBeUndefined();
		} finally {
			if (previous === undefined) delete process.env["ZEROWORK_CONFIG_DIR"];
			else process.env["ZEROWORK_CONFIG_DIR"] = previous;
			rmSync(configDir, { recursive: true, force: true });
		}
	});
});

describe("resolveHookSet —— 合并与信任边界", () => {
	it("没有工作区文件时只有用户级", () => {
		const root = makeWorkspace();
		const user = parseHookConfig([goodHook]);
		const set = resolveHookSet({ user, workspaceRoot: root, trustedWorkspaceHooks: undefined });
		expect(set.hooks.map((h) => h.id)).toEqual(["h-1"]);
		expect(set.workspace.exists).toBe(false);
		expect(set.skippedWorkspace).toBe(false);
	});

	it("未信任的工作区 hooks 不进入可执行集合，但会被解析出来展示", () => {
		const root = makeWorkspace();
		writeWorkspaceHooks(
			root,
			JSON.stringify({ version: 1, hooks: [{ id: "ws-1", event: "PreToolUse", command: "exit 2" }] })
		);
		const user = parseHookConfig([goodHook]);
		const set = resolveHookSet({ user, workspaceRoot: root, trustedWorkspaceHooks: [] });
		expect(set.hooks.map((h) => h.id)).toEqual(["h-1"]);
		expect(set.workspace.hooks.map((h) => h.id)).toEqual(["ws-1"]);
		expect(set.workspace.trusted).toBe(false);
		expect(set.skippedWorkspace).toBe(true);
	});

	it("已信任时按「用户级 → 工作区级」顺序合并", () => {
		const root = makeWorkspace();
		writeWorkspaceHooks(
			root,
			JSON.stringify({ version: 1, hooks: [{ id: "ws-1", event: "PreToolUse", command: "exit 2" }] })
		);
		const user = parseHookConfig([goodHook]);
		const set = resolveHookSet({ user, workspaceRoot: root, trustedWorkspaceHooks: [root] });
		expect(set.hooks.map((h) => h.id)).toEqual(["h-1", "ws-1"]);
		expect(set.skippedWorkspace).toBe(false);
	});

	it("已信任的工作区配置损坏是 fatal；未信任的损坏只展示、不阻断", () => {
		const root = makeWorkspace();
		writeWorkspaceHooks(root, "{ not json");
		const user = parseHookConfig([goodHook]);

		const untrusted = resolveHookSet({ user, workspaceRoot: root, trustedWorkspaceHooks: [] });
		expect(untrusted.fatal).toHaveLength(0);
		expect(untrusted.workspace.fatalMessage).toMatch(/不是合法 JSON/);

		const trusted = resolveHookSet({ user, workspaceRoot: root, trustedWorkspaceHooks: [root] });
		expect(trusted.fatal).toHaveLength(1);
		expect(trusted.fatal[0].source).toBe("workspace");
	});

	it("用户级配置损坏始终是 fatal", () => {
		const root = makeWorkspace();
		const user = parseHookConfig({ notHooks: [] });
		const set = resolveHookSet({ user, workspaceRoot: root, trustedWorkspaceHooks: undefined });
		expect(set.fatal).toHaveLength(1);
		expect(set.fatal[0].source).toBe("user");
	});

	it("worktree 会话用源仓库的已信任 hooks，而不是生效工作区根", () => {
		const source = makeWorkspace();
		writeWorkspaceHooks(
			source,
			JSON.stringify({ version: 1, hooks: [{ id: "source-1", event: "PreToolUse", command: "exit 2" }] })
		);
		const unrelated = makeWorkspace();
		writeWorkspaceHooks(
			unrelated,
			JSON.stringify({ version: 1, hooks: [{ id: "unrelated-1", event: "PreToolUse", command: "exit 2" }] })
		);
		const root = chooseWorkspaceRoot({
			cwd: "/cfg/worktrees/repo/main-abcd1234",
			sourceCwd: source,
			isTask: true,
			effectiveRoot: unrelated
		});
		const set = resolveHookSet({
			user: parseHookConfig([goodHook]),
			workspaceRoot: root,
			trustedWorkspaceHooks: [source, unrelated]
		});
		expect(set.hooks.map((hook) => hook.id)).toEqual(["h-1", "source-1"]);
		expect(set.hooks.some((hook) => hook.id === "unrelated-1")).toBe(false);
	});

	it("工作区文件不存在时 readWorkspaceHookConfig 不抛错", () => {
		const root = makeWorkspace();
		const result = readWorkspaceHookConfig(root);
		expect(result.exists).toBe(false);
	});
});

describe("载荷构造 —— 不传 now 时用当前时间", () => {
	it("PreToolUse 载荷形状", () => {
		const before = Date.now();
		const payload = payloadForPreToolUse({ toolName: "write", input: { path: "a" }, sessionId: "s", cwd: "/w" });
		expect(payload.event).toBe("PreToolUse");
		expect(payload.tool).toEqual({ name: "write", input: { path: "a" } });
		expect(payload.session).toEqual({ id: "s", cwd: "/w" });
		expect(typeof payload.timestamp).toBe("number");
		expect(payload.timestamp).toBeGreaterThanOrEqual(before);
	});

	it("PostToolUse 的 error 按输出上限截断（它不是被检查的对象，是状态摘要）", () => {
		const payload = payloadForPostToolUse({
			toolName: "read",
			input: {},
			sessionId: "s",
			cwd: "/w",
			ok: false,
			error: "x".repeat(HOOK_OUTPUT_MAX + 100),
		});
		expect(payload.error).toHaveLength(HOOK_OUTPUT_MAX + 1);
		expect(payload.error.endsWith("…")).toBe(true);
	});

	it("PostToolUse 的 input 不截断（hook 要靠它检查将要写入的内容）", () => {
		const big = "y".repeat(HOOK_OUTPUT_MAX * 2);
		const payload = payloadForPostToolUse({ toolName: "write", input: { content: big }, ok: true });
		expect(payload.tool.input.content).toHaveLength(HOOK_OUTPUT_MAX * 2);
	});

	it("PostToolUse 追加 ok/error", () => {
		const payload = payloadForPostToolUse({
			toolName: "write",
			input: {},
			sessionId: "s",
			cwd: "/w",
			ok: false,
			error: "boom",
		});
		expect(payload.event).toBe("PostToolUse");
		expect(payload.ok).toBe(false);
		expect(payload.error).toBe("boom");
	});
});

describe("生命周期载荷 —— 形状与工具事件一致，只有各自的事实", () => {
	it("SessionStart 带 reason（缺省 startup）", () => {
		expect(payloadForSessionStart({ sessionId: "s", cwd: "/w", reason: "resume", now: () => 42 })).toEqual({
			event: "SessionStart",
			session: { id: "s", cwd: "/w" },
			reason: "resume",
			timestamp: 42,
		});
		expect(payloadForSessionStart({ sessionId: "", cwd: "" }).reason).toBe("startup");
	});

	it("UserPromptSubmit 带完整 prompt（不截断）", () => {
		const prompt = "x".repeat(HOOK_OUTPUT_MAX * 2);
		const payload = payloadForUserPromptSubmit({ sessionId: "s", cwd: "/w", prompt, now: () => 1 });
		expect(payload).toEqual({
			event: "UserPromptSubmit",
			session: { id: "s", cwd: "/w" },
			prompt,
			timestamp: 1,
		});
		expect(payload.prompt).toHaveLength(HOOK_OUTPUT_MAX * 2);
	});

	it("Stop 带 aborted（只认 true）", () => {
		expect(payloadForStop({ sessionId: "s", cwd: "/w", aborted: true, now: () => 2 })).toEqual({
			event: "Stop",
			session: { id: "s", cwd: "/w" },
			aborted: true,
			timestamp: 2,
		});
		expect(payloadForStop({ aborted: undefined }).aborted).toBe(false);
	});

	it("三个载荷都不含 tool 字段（没有工具名可比）", () => {
		for (const payload of [
			payloadForSessionStart({}),
			payloadForUserPromptSubmit({}),
			payloadForStop({}),
		]) {
			expect("tool" in payload).toBe(false);
		}
	});
});

describe("shellInvocation —— 两个平台的 shell 与 Windows 的引号处理", () => {
	it("POSIX 走 /bin/sh -lc", () => {
		const invocation = shellInvocation("node x.js", "linux");
		expect(invocation.file).toBe("/bin/sh");
		expect(invocation.args).toEqual(["-lc", "node x.js"]);
		expect(invocation.windowsVerbatimArguments).toBe(false);
	});

	/*
	 * Windows 上最常见的写法就是带引号的绝对路径（程序目录里带空格）。
	 * 交给 Node 自动加引号会把内部 `"` 转义成 `\"`，而 cmd.exe 不认反斜杠转义 ——
	 * 于是「路径带空格就必现」地拆坏。这里钉的是正确的组合：
	 * verbatim（Node 不碰引号）+ 我们自己再套一层（cmd 的 /s 会剥掉这对）。
	 */
	it("Windows：verbatim + 外层再套一对引号", () => {
		const command = '"C:\\Program Files\\node.exe" "hook a.mjs"';
		const invocation = shellInvocation(command, "win32");
		expect(invocation.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
		expect(invocation.args[3]).toBe(`"${command}"`);
		expect(invocation.windowsVerbatimArguments).toBe(true);
	});

	it("runHook 把 verbatim 标志交给 spawn", async () => {
		const fake = fakeSpawn([{ closeCode: 0 }]);
		await runHook({ ...normalizeHook(goodHook), timeoutMs: 1000 }, {}, {
			spawn: fake.spawn,
			platform: "win32",
			now: () => 0,
		});
		expect(fake.calls[0].options.windowsVerbatimArguments).toBe(true);
	});
});

describe("decideVerdict —— 0 放行 / 2 拒绝 / 其它失败", () => {
	it("退出码映射", () => {
		expect(decideVerdict({ exitCode: 0 })).toBe("allow");
		expect(decideVerdict({ exitCode: 2 })).toBe("deny");
		expect(decideVerdict({ exitCode: 1 })).toBe("fail");
		expect(decideVerdict({ exitCode: null })).toBe("fail");
	});
	it("超时与启动失败都是 fail", () => {
		expect(decideVerdict({ timedOut: true })).toBe("fail");
		expect(decideVerdict({ spawnError: "ENOENT" })).toBe("fail");
	});
});

describe("runHook —— 输出与状态翻译", () => {
	it("退出码 0 放行并带回 stdout/stderr", async () => {
		const fake = fakeSpawn([{ stdout: "ok", stderr: "note", closeCode: 0 }]);
		const result = await runHook({ ...normalizeHook(goodHook), timeoutMs: 1000 }, {}, { spawn: fake.spawn, platform: "linux", now: () => 0 });
		expect(result.verdict).toBe("allow");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("ok");
		expect(result.stderr).toBe("note");
	});

	it("退出码 2 是拒绝", async () => {
		const fake = fakeSpawn([{ stderr: "不许写", closeCode: 2 }]);
		const result = await runHook({ ...normalizeHook(goodHook), timeoutMs: 1000 }, {}, { spawn: fake.spawn, platform: "linux", now: () => 0 });
		expect(result.verdict).toBe("deny");
		expect(result.stderr).toBe("不许写");
	});

	it("启动失败是 fail", async () => {
		const fake = fakeSpawn([{ error: "spawn ENOENT" }]);
		const result = await runHook({ ...normalizeHook(goodHook), timeoutMs: 1000 }, {}, { spawn: fake.spawn, platform: "linux", now: () => 0 });
		expect(result.verdict).toBe("fail");
		expect(result.spawnError).toMatch(/ENOENT/);
	});

	it("输出截断到上限", async () => {
		const fake = fakeSpawn([{ stdout: "x".repeat(HOOK_OUTPUT_MAX + 500), closeCode: 0 }]);
		const result = await runHook({ ...normalizeHook(goodHook), timeoutMs: 1000 }, {}, { spawn: fake.spawn, platform: "linux", now: () => 0 });
		expect(result.stdout).toHaveLength(HOOK_OUTPUT_MAX);
	});

	it("超时是 fail，且会尝试杀掉进程", async () => {
		vi.useFakeTimers();
		const fake = fakeSpawn([{ hang: true }]);
		// 用 win32 分支走 taskkill（注入的假 spawn），避免在测试进程里真的 process.kill(-pid)。
		const promise = runHook({ ...normalizeHook(goodHook), timeoutMs: 1000 }, {}, { spawn: fake.spawn, platform: "win32", now: () => 0 });
		await vi.advanceTimersByTimeAsync(1000);
		const result = await promise;
		expect(result.timedOut).toBe(true);
		expect(result.verdict).toBe("fail");
		const killed = fake.calls.some((call) => call.file === "taskkill" || call.child.killed === true);
		expect(killed).toBe(true);
	});
});

/*
 * 静态契约：这一条不是重复行为测试，而是钉住 PRD 的「三处装配点都装」。
 * 只测主会话也能全绿，而委派给子代理的路径会变成旁路 —— 那正是最危险的形态。
 * 用源码位置判断而不是运行装配（后者要起 Electron，单测做不到）。
 */
describe("接入点 —— 主会话 / 定时任务 / 子代理都装（静态契约）", () => {
	const sessionFiles = readFileSync(new URL("../../src/main/daemon/session-files.js", import.meta.url), "utf8");
	const commandExec = readFileSync(new URL("../../src/main/daemon/command-exec.js", import.meta.url), "utf8");
	const indexes = (source, re) => [...source.matchAll(re)].map((match) => match.index);

	it("三处装配点都注册 PreToolUse 与 PostToolUse", () => {
		// session-files：主会话 + 定时任务 run；command-exec：子代理 / 团队成员。
		expect(indexes(sessionFiles, /createPreToolUseHookExtension\(/g)).toHaveLength(2);
		expect(indexes(sessionFiles, /createPostToolUseHookExtension\(/g)).toHaveLength(2);
		expect(indexes(commandExec, /createPreToolUseHookExtension\(/g)).toHaveLength(1);
		expect(indexes(commandExec, /createPostToolUseHookExtension\(/g)).toHaveLength(1);
	});

	/*
	 * 生命周期事件不可阻断，所以「漏装一处」不会带来安全旁路 —— 它的失败形态是
	 * 静默：用户配了「每条消息记一行」，委派出去的子代理跑完却什么都没留下。
	 * 这条静态断言让「漏装」在单测阶段就可见。
	 */
	it("三处装配点都注册生命周期扩展（SessionStart / UserPromptSubmit / Stop）", () => {
		expect(indexes(sessionFiles, /createLifecycleHookExtension\(/g)).toHaveLength(2);
		expect(indexes(commandExec, /createLifecycleHookExtension\(/g)).toHaveLength(1);
	});

	it("每一处 Pre 都排在权限门之前（第一个 block 才是终局）", () => {
		const pre = indexes(sessionFiles, /createPreToolUseHookExtension\(/g);
		const gates = indexes(sessionFiles, /createPermissionGate\(/g);
		expect(gates).toHaveLength(2);
		for (const gate of gates) {
			const before = pre.filter((index) => index < gate);
			expect(before.length, `权限门 @${gate} 之前没有 PreToolUse`).toBeGreaterThan(0);
			expect(gate - Math.max(...before), "PreToolUse 与权限门之间隔了太多代码（可能插错位置）").toBeLessThan(1500);
		}

		const commandPre = indexes(commandExec, /createPreToolUseHookExtension\(/g);
		// command-exec 里有一个 createPermissionGate 是函数定义（在 Pre 之前），
		// 装配点那个在文件后部 —— 只看 Pre 之后的第一个。
		const commandGate = indexes(commandExec, /createPermissionGate\(/g).filter((index) => index > commandPre[0]);
		expect(commandGate).toHaveLength(1);
		expect(commandGate[0]).toBeGreaterThan(commandPre[0]);
	});

	it("子代理 / 团队成员与主会话共用同一个 hooks root（worktree → 源仓库）", () => {
		// 主会话：bucket.worktree 显式传进去（resume 时也由 worktreeInfoFromCwd 补齐）。
		expect(sessionFiles.includes("hookSetForCwd(cwd, bucket.worktree)")).toBe(true);
		// 子代理与成员：主会话把同一个 root 放进派生请求。
		expect([...sessionFiles.matchAll(/hooksRoot: hooksRootFor\(cwd, bucket\.worktree\)/g)]).toHaveLength(2);
		// 子代理装配层只认传进来的 root，不自行按 worktree cwd 猜。
		expect(commandExec.includes("deps.hooksFor?.(cwd, hooksRoot)")).toBe(true);
	});

	it("Post 排在 spill 之后（看到的是模型最终内容）", () => {
		const spills = indexes(sessionFiles, /spillExtensionFactory\(/g);
		const posts = indexes(sessionFiles, /createPostToolUseHookExtension\(/g);
		for (const post of posts) {
			expect(spills.some((spill) => spill < post), "PostToolUse 之前没有 spill（注册顺序错了）").toBe(true);
		}

		const body = commandExec.slice(commandExec.indexOf("function buildSubagentExtensions("));
		const postSpread = body.indexOf("hookExtensions.post === void 0");
		const spill = body.indexOf("spillExtensionFactory(");
		expect(postSpread).toBeGreaterThan(-1);
		expect(spill).toBeGreaterThan(-1);
		expect(postSpread).toBeGreaterThan(spill);
	});
});

describe("子代理装配 —— 消费主会话传入的 hooksRoot", () => {
	it("hooksFor 拿到的 cwd 与 root 都不是猜出来的", () => {
		const calls = [];
		const deps = {
			hooksFor: (cwd, root) => {
				calls.push({ cwd, root });
				return { hooks: [], errors: [], fatal: [], skippedWorkspace: false, workspace: {} };
			},
			getPermissions: () => ({ sandbox: "workspace-write", approval: "on-request" }),
			protectedDirs: [],
			isOwnWorkspace: () => true,
			isTempCwd: () => true,
			getWebSearchConfig: () => void 0,
			requestApproval: () => Promise.resolve("deny"),
			getCatalog: async () => {
				throw new Error("装配阶段不该取目录");
			},
			getModelKey: () => void 0,
			resources: {},
		};
		const extensions = buildSubagentExtensions(
			deps,
			{ name: "a", body: "b", tools: ["read"] },
			"/cfg/worktrees/repo/main-abcd1234",
			() => void 0,
			"/repo",
		);
		expect(calls).toEqual([{ cwd: "/cfg/worktrees/repo/main-abcd1234", root: "/repo" }]);
		expect(extensions.length).toBeGreaterThan(0);
	});

	it("没有 hooksFor 时不装空壳（不额外注册监听器）", () => {
		const deps = {
			getPermissions: () => ({ sandbox: "workspace-write", approval: "on-request" }),
			protectedDirs: [],
			isOwnWorkspace: () => true,
			isTempCwd: () => true,
			getWebSearchConfig: () => void 0,
			requestApproval: () => Promise.resolve("deny"),
			getCatalog: async () => {
				throw new Error("装配阶段不该取目录");
			},
			getModelKey: () => void 0,
			resources: {},
		};
		const extensions = buildSubagentExtensions(
			deps,
			{ name: "a", body: "b", tools: ["read"] },
			"/w",
			() => void 0,
			"/w",
		);
		expect(extensions.length).toBeGreaterThan(0);
	});
});

describe("resolveSavedHook —— 试运行只认已保存的 id", () => {
	const config = { hooks: [normalizeHook({ id: "saved", event: "PreToolUse", command: "echo safe" })] };

	it("未知 id 直接拒绝", () => {
		expect(() => resolveSavedHook(config, "nope")).toThrow(/未知的 hook id/);
	});

	it("空 id / 非字符串对象拒绝", () => {
		expect(() => resolveSavedHook(config, "")).toThrow(/已保存 hook 的 id/);
		expect(() => resolveSavedHook(config, { command: "evil" })).toThrow(/已保存 hook 的 id/);
		expect(() => resolveSavedHook(config, null)).toThrow(/已保存 hook 的 id/);
	});

	it("传入伪造 command / event 被忽略，取的是已保存那条", () => {
		const hook = resolveSavedHook(config, { id: "saved", command: "rm -rf /", event: "PostToolUse" });
		expect(hook.id).toBe("saved");
		expect(hook.command).toBe("echo safe");
		expect(hook.event).toBe("PreToolUse");
	});
});

describe("扩展接线 —— 命中才 spawn、拒绝才 block", () => {
	const mountPre = (hookSet, deps, audits) => {
		let handler;
		createPreToolUseHookExtension({
			cwd: "/w",
			hookSet,
			getSessionId: () => "",
			onAudit: (record) => audits.push(record),
			deps,
		})({ on: (name, fn) => { if (name === "tool_call") handler = fn; } });
		return handler;
	};

	it("没有命中 matcher 时不 spawn、不阻断", async () => {
		const fake = fakeSpawn([{ closeCode: 0 }]);
		const audits = [];
		const handler = mountPre(
			{
				hooks: [normalizeHook({ id: "h", event: "PreToolUse", matcher: "write", command: "x" })],
				fatal: [],
				skippedWorkspace: false,
				workspace: {},
			},
			{ spawn: fake.spawn, platform: "linux", now: () => 0 },
			audits,
		);
		const result = await handler({ toolName: "read", input: {} });
		expect(result).toBeUndefined();
		expect(fake.calls).toHaveLength(0);
		expect(audits).toHaveLength(0);
	});

	it("命中且 exit 2 → 返回可诊断的 block，并记 hook/blocked", async () => {
		const fake = fakeSpawn([{ stderr: "不许这样写", closeCode: 2 }]);
		const audits = [];
		const handler = mountPre(
			{
				hooks: [normalizeHook({ id: "h", event: "PreToolUse", matcher: "write", command: "x" })],
				fatal: [],
				skippedWorkspace: false,
				workspace: {},
			},
			{ spawn: fake.spawn, platform: "linux", now: () => 0 },
			audits,
		);
		const result = await handler({ toolName: "write", input: { path: "a" } });
		expect(result.block).toBe(true);
		expect(result.reason).toMatch(/h/);
		expect(result.reason).toMatch(/不许这样写/);
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({ category: "hook", outcome: "blocked" });
	});

	it("PostToolUse 的 exit 2 只记 failed（审计不能说「已拦截」）", async () => {
		const fake = fakeSpawn([{ stderr: "其实没拦住", closeCode: 2 }]);
		const audits = [];
		let handler;
		createPostToolUseHookExtension({
			cwd: "/w",
			hookSet: {
				hooks: [normalizeHook({ id: "p", event: "PostToolUse", matcher: "write", command: "x" })],
				fatal: [],
				skippedWorkspace: false,
				workspace: {},
			},
			getSessionId: () => "",
			onAudit: (record) => audits.push(record),
			deps: { spawn: fake.spawn, platform: "linux", now: () => 0 },
		})({ on: (name, fn) => { if (name === "tool_result") handler = fn; } });
		const result = await handler({ toolName: "write", input: {}, content: [], isError: false });
		expect(result).toBeUndefined();
		expect(audits).toHaveLength(1);
		expect(audits[0].outcome).toBe("failed");
		expect(audits[0].detail).toMatch(/未阻断/);
	});

	it("配置 fatal → 不 spawn 也阻断（fail-closed）", async () => {
		const fake = fakeSpawn([{ closeCode: 0 }]);
		const audits = [];
		const handler = mountPre(
			{ hooks: [], fatal: [{ source: "user", message: "配置坏了" }], skippedWorkspace: false, workspace: {} },
			{ spawn: fake.spawn, platform: "linux", now: () => 0 },
			audits,
		);
		const result = await handler({ toolName: "write", input: {} });
		expect(result.block).toBe(true);
		expect(result.reason).toMatch(/配置无效/);
		expect(fake.calls).toHaveLength(0);
		expect(audits[0]).toMatchObject({ category: "hook", outcome: "failed" });
	});
});

describe("生命周期扩展 —— 非阻断、全部跑完、fatal 不刷审计", () => {
	/** 装扩展并收集三个 handler（按 pi 的事件名索引）。 */
	const mountLifecycle = (hookSet, deps, audits, getSessionId = () => "s-1") => {
		const handlers = new Map();
		createLifecycleHookExtension({
			cwd: "/w",
			hookSet,
			getSessionId,
			onAudit: (record) => audits.push(record),
			deps,
		})({ on: (name, fn) => handlers.set(name, fn) });
		return handlers;
	};
	/**
	 * 收集每次 spawn 收到的 stdin 载荷。
	 *
	 * `createFakeChild` 的 `stdin.end` 是空实现（其他用例不关心载荷），这里替换掉它
	 * 才能断言「hook 到底收到了什么」—— 那正是 SessionStart 缺 session.id 的可见面。
	 */
	const spawnCapturingPayloads = (payloads) => (_file, _args, _options) => {
		const child = createFakeChild({ closeCode: 0 });
		child.stdin.end = (text) => payloads.push(JSON.parse(text));
		return child;
	};
	const setOf = (...hooks) => ({ hooks, fatal: [], skippedWorkspace: false, workspace: {} });
	const fakeDeps = (behaviors) => {
		const fake = fakeSpawn(behaviors);
		return { fake, deps: { spawn: fake.spawn, platform: "linux", now: () => 0 } };
	};

	it("三个 pi 事件各自注册一个 handler", () => {
		const fake = fakeDeps([]);
		const handlers = mountLifecycle(setOf(), fake.deps, []);
		expect([...handlers.keys()].sort()).toEqual(["agent_settled", "before_agent_start", "session_start"]);
	});

	it("无命中不 spawn、不写审计（空配置零成本）", async () => {
		const { fake, deps } = fakeDeps([{ closeCode: 0 }]);
		const audits = [];
		// 只有 PreToolUse 的 hook：生命周期事件一条也不命中。
		const handlers = mountLifecycle(
			setOf(normalizeHook({ id: "p", event: "PreToolUse", command: "x" })),
			deps,
			audits,
		);
		expect(await handlers.get("session_start")({ reason: "startup" })).toBeUndefined();
		expect(await handlers.get("before_agent_start")({ messageType: "user", prompt: "hi" })).toBeUndefined();
		expect(await handlers.get("agent_settled")({ aborted: false })).toBeUndefined();
		expect(fake.calls).toHaveLength(0);
		expect(audits).toHaveLength(0);
	});

	it("顺序执行、全部跑完：第一条 exit 1 第二条仍然跑，且都不改变返回值", async () => {
		const { fake, deps } = fakeDeps([{ closeCode: 1, stderr: "第一个失败" }, { closeCode: 0 }]);
		const audits = [];
		const handlers = mountLifecycle(
			setOf(
				normalizeHook({ id: "a", event: "UserPromptSubmit", command: "x" }),
				normalizeHook({ id: "b", event: "UserPromptSubmit", command: "y" }),
			),
			deps,
			audits,
		);
		const result = await handlers.get("before_agent_start")({ messageType: "user", prompt: "hi" });
		expect(result).toBeUndefined();
		expect(fake.calls).toHaveLength(2);
		expect(audits.map((record) => record.outcome)).toEqual(["failed", "allowed"]);
		// 非阻断的失败必须写明「未阻断」——只写「失败」会让人以为这一轮真的被拦下了。
		expect(audits[0].detail).toMatch(/失败（未阻断）/u);
	});

	it("exit 2 只记 failed，文案是「拒绝（未阻断）」", async () => {
		const { fake, deps } = fakeDeps([{ closeCode: 2, stderr: "不同意" }]);
		const audits = [];
		const handlers = mountLifecycle(
			setOf(normalizeHook({ id: "s", event: "Stop", command: "x" })),
			deps,
			audits,
		);
		const result = await handlers.get("agent_settled")({ aborted: true });
		expect(result).toBeUndefined();
		expect(fake.calls).toHaveLength(1);
		expect(audits).toHaveLength(1);
		expect(audits[0]).toMatchObject({ category: "hook", outcome: "failed" });
		expect(audits[0].detail).toMatch(/Stop 拒绝（未阻断）/u);
		expect(audits[0].detail).not.toMatch(/已拦截/u);
	});

	it("超时记为 failed（未阻断）", async () => {
		vi.useFakeTimers();
		const { fake, deps } = fakeDeps([{ hang: true }]);
		const audits = [];
		deps.platform = "win32"; // 走注入的 taskkill 分支，避免真的 process.kill(-pid)
		const handlers = mountLifecycle(
			setOf(normalizeHook({ id: "t", event: "SessionStart", command: "x" })),
			deps,
			audits,
		);
		const promise = handlers.get("session_start")({ reason: "startup" });
		await vi.advanceTimersByTimeAsync(6000);
		await promise;
		expect(fake.calls.length).toBeGreaterThan(0);
		expect(audits).toHaveLength(1);
		expect(audits[0].outcome).toBe("failed");
		expect(audits[0].detail).toMatch(/超时/u);
		expect(audits[0].detail).toMatch(/未阻断/u);
	});

	it("配置 fatal → 不 spawn、不写审计（工具事件已留证，重复记会淹没审计）", async () => {
		const { fake, deps } = fakeDeps([{ closeCode: 0 }]);
		const audits = [];
		const handlers = mountLifecycle(
			{
				hooks: [normalizeHook({ id: "s", event: "SessionStart", command: "x" })],
				fatal: [{ source: "user", message: "配置坏了" }],
				skippedWorkspace: false,
				workspace: {},
			},
			deps,
			audits,
		);
		await handlers.get("session_start")({ reason: "startup" });
		await handlers.get("agent_settled")({ aborted: false });
		expect(fake.calls).toHaveLength(0);
		expect(audits).toHaveLength(0);
	});

	it("before_agent_start 的 custom 不触发（只认用户提交）", async () => {
		const { fake, deps } = fakeDeps([{ closeCode: 0 }]);
		const audits = [];
		const handlers = mountLifecycle(
			setOf(normalizeHook({ id: "u", event: "UserPromptSubmit", command: "x" })),
			deps,
			audits,
		);
		expect(await handlers.get("before_agent_start")({ messageType: "custom", message: {} })).toBeUndefined();
		expect(fake.calls).toHaveLength(0);
		expect(audits).toHaveLength(0);
	});

	it("三个事件互不串台：只有对应事件的 hook 会被执行", async () => {
		const { fake, deps } = fakeDeps([{ closeCode: 0 }]);
		const audits = [];
		const handlers = mountLifecycle(
			setOf(
				normalizeHook({ id: "start", event: "SessionStart", command: "x" }),
				normalizeHook({ id: "submit", event: "UserPromptSubmit", command: "y" }),
				normalizeHook({ id: "stop", event: "Stop", command: "z" }),
			),
			deps,
			audits,
		);
		await handlers.get("session_start")({ reason: "resume" });
		await handlers.get("before_agent_start")({ messageType: "user", prompt: "hi" });
		await handlers.get("agent_settled")({ aborted: false });
		expect(fake.calls).toHaveLength(3);
		expect(audits.map((record) => record.detail.split(" ")[0])).toEqual(["SessionStart", "UserPromptSubmit", "Stop"]);
	});

	it("SessionStart 的 session.id：装配点为空时回落到 pi 的 ctx.sessionManager", async () => {
		/*
		 * 真实时序：`SessionStart` 由 `SessionHost.create` 末尾的 `bindExtensions`
		 * 发出，那一刻宿主还没被 adopt，装配点给的 getter 读到的是空串；
		 * pi 的 sessionManager 已经有 id（AgentSession.sessionId 就是它的
		 * getSessionId()）。不回落的话载荷里的 session.id 恒为空。
		 */
		const payloads = [];
		const deps = { spawn: spawnCapturingPayloads(payloads), platform: "linux", now: () => 0 };
		const handlers = mountLifecycle(
			setOf(normalizeHook({ id: "s", event: "SessionStart", command: "x" })),
			deps,
			[],
			() => "",
		);
		await handlers.get("session_start")(
			{ reason: "startup" },
			{ sessionManager: { getSessionId: () => "pi-session-1" } },
		);
		expect(payloads).toHaveLength(1);
		expect(payloads[0].session.id).toBe("pi-session-1");
	});

	it("装配点的 getter 有值时优先于 ctx（真值只有一个来源且组装方更准）", async () => {
		const payloads = [];
		const deps = { spawn: spawnCapturingPayloads(payloads), platform: "linux", now: () => 0 };
		const handlers = mountLifecycle(
			setOf(normalizeHook({ id: "s", event: "SessionStart", command: "x" })),
			deps,
			[],
			() => "daemon-session",
		);
		await handlers.get("session_start")(
			{ reason: "startup" },
			{ sessionManager: { getSessionId: () => "pi-session-1" } },
		);
		expect(payloads[0].session.id).toBe("daemon-session");
	});

	it("ctx 缺失或两侧都抛错时退化为空串，不炸事件", async () => {
		const payloads = [];
		const deps = { spawn: spawnCapturingPayloads(payloads), platform: "linux", now: () => 0 };
		const handlers = mountLifecycle(
			setOf(normalizeHook({ id: "s", event: "SessionStart", command: "x" })),
			deps,
			[],
			() => {
				throw new Error("装配点坏了");
			},
		);
		await handlers.get("session_start")({ reason: "startup" }, {
			sessionManager: {
				getSessionId: () => {
					throw new Error("manager 也坏了");
				},
			},
		});
		expect(payloads).toHaveLength(1);
		expect(payloads[0].session.id).toBe("");
	});

	it("执行异常 → 写一条 failed 审计并吞掉（不抛给 pi，不炸会话）", async () => {
		const { fake, deps } = fakeDeps([{ closeCode: 0 }]);
		deps.now = () => {
			throw new Error("时钟坏了");
		};
		const audits = [];
		const handlers = mountLifecycle(
			setOf(normalizeHook({ id: "e", event: "Stop", command: "x" })),
			deps,
			audits,
		);
		expect(await handlers.get("agent_settled")({ aborted: false })).toBeUndefined();
		expect(fake.calls).toHaveLength(0);
		expect(audits).toHaveLength(1);
		expect(audits[0].outcome).toBe("failed");
		expect(audits[0].detail).toMatch(/执行异常（未阻断）/u);
	});
});

describe("runHooks —— 顺序与短路", () => {
	const deps = (behaviors) => {
		const fake = fakeSpawn(behaviors);
		return { fake, deps: { spawn: fake.spawn, platform: "linux", now: () => 0 } };
	};

	it("空集合不 spawn 任何进程", async () => {
		const { fake, deps: d } = deps([{ closeCode: 0 }]);
		const results = await runHooks([], {}, "PreToolUse", d);
		expect(results).toEqual([]);
		expect(fake.calls).toHaveLength(0);
	});

	it("PreToolUse 任一拒绝即停", async () => {
		const { fake, deps: d } = deps([{ closeCode: 2, stderr: "no" }, { closeCode: 0 }]);
		const hooks = [
			normalizeHook({ id: "a", event: "PreToolUse", command: "x" }),
			normalizeHook({ id: "b", event: "PreToolUse", command: "y" })
		];
		const results = await runHooks(hooks, {}, "PreToolUse", d);
		expect(results).toHaveLength(1);
		expect(results[0].result.verdict).toBe("deny");
		expect(fake.calls).toHaveLength(1);
	});

	it("PreToolUse 的启动失败同样短路（fail-closed）", async () => {
		const { fake, deps: d } = deps([{ error: "spawn ENOENT" }, { closeCode: 0 }]);
		const hooks = [
			normalizeHook({ id: "a", event: "PreToolUse", command: "x" }),
			normalizeHook({ id: "b", event: "PreToolUse", command: "y" })
		];
		const results = await runHooks(hooks, {}, "PreToolUse", d);
		expect(results).toHaveLength(1);
		expect(results[0].result.verdict).toBe("fail");
		expect(fake.calls).toHaveLength(1);
	});

	it("PostToolUse 不可阻断：全部跑完，不因拒绝停下", async () => {
		const { fake, deps: d } = deps([{ closeCode: 2, stderr: "no" }, { closeCode: 0 }]);
		const hooks = [
			normalizeHook({ id: "a", event: "PostToolUse", command: "x" }),
			normalizeHook({ id: "b", event: "PostToolUse", command: "y" })
		];
		const results = await runHooks(hooks, {}, "PostToolUse", d);
		expect(results).toHaveLength(2);
		expect(fake.calls).toHaveLength(2);
	});
});
