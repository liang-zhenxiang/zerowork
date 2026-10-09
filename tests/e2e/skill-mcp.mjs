/**
 * 技能调用与 MCP 连接器端到端测试。
 *
 * 这两块此前完全没测过，而它们都不属于"环境做不到"：
 *
 *   ① 技能调用 —— `/skill:<name>` 的展开发生在 daemon 的 **prompt 入口**
 *      （expandSkillInvocation）：读技能文件 → 剥 frontmatter → 拼成技能块
 *      注入到发给模型的文本里。用真实模型让它回报技能正文里的标题，
 *      即可验证「解析 → 读文件 → 注入 → 模型收到」整条链路。
 *
 *   ② MCP 连接器 —— 起一个最小 stdio MCP server，注册到应用里，验证
 *      连接建立、工具被识别、以及模型能调用该工具并拿到结果。
 *      这是独立子系统，此前一行都没测过。
 *
 * ⚠️ 凭据运行时从 ~/.claude/settings.json 读取，不进仓库、不打印。
 *
 * ── 迁移说明（共享 harness）────────────────────────────────
 *
 * 骨架（隔离目录、启动并等到就绪、check 收集器、末尾报告与退出码）全部来自
 * `./lib/harness.mjs`。启动不再固定等 9 秒；页面里的 `for + sleep` 轮询换成
 * `waitUntil`（并把原来的失败诊断搬进错误里）；末尾补一张带像素断言的截图。
 *
 * ⚠️ **依赖模型端点的用例，探不到端点时必须逐条 `h.skip()` 上报，不许静默跳过。**
 * 这个文件在 CI 上是**零信号**的：CI 没有模型端点，此前那些 `if (endpoint) { … }`
 * 分支整块不进报告 —— 报告里只有 4 条断言、全绿，看起来「跑了且都过」，
 * 实际上一行模型链路都没验。静默 return 只是把谎言换个写法，所以这里用
 * `h.skip(label, reason)`：报告里会出现「跳过 N」，与「通过 N」区分得清清楚楚。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 技能正文里的辨识标题（见 resources/skills/meeting-notes/SKILL.md）
const SKILL_NAME = "meeting-notes";
const SKILL_HEADING = "会议纪要整理";
// mock MCP server 返回的固定标记
const MCP_TOOL_MARK = "ZW_MCP_TOOL_OK";

// ── 模型端点（可选）──────────────────────────────────────────
const SETTINGS = resolve(homedir(), ".claude", "settings.json");
function readEndpoint() {
	if (!existsSync(SETTINGS)) return undefined;
	try {
		const env = JSON.parse(readFileSync(SETTINGS, "utf8"))?.env ?? {};
		const baseUrl = env.ANTHROPIC_BASE_URL;
		const token = env.ANTHROPIC_AUTH_TOKEN;
		const model = String(env.ANTHROPIC_MODEL ?? "").replace(/\[[^\]]*\]$/, "");
		return baseUrl && token && model ? { baseUrl, token, model } : undefined;
	} catch {
		return undefined;
	}
}
let endpoint = readEndpoint();
if (endpoint) {
	const probe = await fetch(`${endpoint.baseUrl}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": endpoint.token, "anthropic-version": "2023-06-01" },
		body: JSON.stringify({ model: endpoint.model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
	}).catch(() => undefined);
	if (!probe || !probe.ok) endpoint = undefined;
}
console.log(endpoint ? "✓ 模型端点可用" : "⚠ 模型端点不可用 —— 依赖模型的用例将逐条上报「跳过」");

/**
 * 探不到端点时，每一条依赖模型的用例都带着它上报 —— 报告里留痕，不伪装成全绿。
 */
const NO_ENDPOINT =
	"本机 ~/.claude/settings.json 里没有可用的模型端点（需要 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / " +
	"ANTHROPIC_MODEL，且 /v1/messages 探活通过）—— 这条要发真实模型请求";

const h = createHarness({
	name: "skillmcp",
	// 本文件要真的调模型（单次 prompt 的内部超时就有 150s），12 分钟的默认上限太紧
	fileTimeout: 20 * 60_000,
});
// harness 负责隔离与清空工作区根目录。MCP 配置写在**工作区级**（<cwd>/.mcp.json），
// 目录本身要由用例建出来
mkdirSync(h.WORKSPACE_DIR, { recursive: true });

await h.launch();
const win = h.window();

await h.shoot("home");

/**
 * 在页面里轮询探针，直到它报告 `found`。
 *
 * 取代原来「在页面里 for 循环 + sleep」的写法：截止时间交给 `waitUntil` 统一管，
 * 慢机器不假失败、快机器不白等；超时时把**最后一次探针看到的回复尾部**带进错误里，
 * 失败信息不能弱于原来的 `回复尾部: …`。
 */
async function waitForFound(desc, probe, { arg, timeout = 30_000, interval = 1_000 } = {}) {
	let last = null;
	try {
		return await waitUntil(
			async () => {
				last = await win.evaluate(probe, arg);
				return last?.found ? last : null;
			},
			{ timeout, interval, desc },
		);
	} catch (error) {
		throw new Error(`${error.message}；回复尾部：${String(last?.sample ?? "(未取到)").slice(-300)}`, { cause: error });
	}
}

// ── ① 技能调用 ─────────────────────────────────────────────
await h.check("技能清单里能找到目标技能", async () => {
	const r = await win.evaluate(async (name) => {
		const s = await globalThis.kami.skillsSnapshot();
		const items = s?.skills ?? s?.items ?? [];
		return { names: items.map((x) => x.name ?? x.id), found: items.some((x) => (x.name ?? x.id) === name) };
	}, SKILL_NAME);
	assert.ok(r.found, `技能清单里没有 ${SKILL_NAME}。现有：${r.names.join(", ")}`);
});

if (endpoint) {
	await h.check("配置真实模型", async () => {
		const r = await win.evaluate(
			async ({ baseUrl, token, model, ws }) => {
				const k = globalThis.kami;
				try {
					await k.saveCustomProvider(
						{
							id: "local-proxy",
							name: "Local Proxy",
							baseUrl,
							api: "anthropic-messages",
							authHeader: true,
							models: [{ id: model, name: model, reasoning: false, vision: false, contextWindow: 128000, maxTokens: 4096 }],
						},
						token,
					);
					await k.setModel(`local-proxy/${model}`);
					await k.setWorkspace(ws);
					return { ok: true };
				} catch (e) {
					return { ok: false, err: String(e?.message ?? e).slice(0, 200) };
				}
			},
			{ ...endpoint, ws: h.WORKSPACE_DIR },
		);
		assert.ok(r.ok, `配置失败: ${r.err}`);
	});

	await h.check("技能调用：/skill: 展开并送达模型", async () => {
		// 提示里要求回报技能正文的**第一个标题**。只有当技能内容真的被注入到
		// 发给模型的文本里，模型才可能答得出来 —— 单条断言覆盖整条链路。
		const timedOut = await win.evaluate(
			async ({ skill }) => {
				const k = globalThis.kami;
				try {
					await Promise.race([
						k.prompt({ text: `/skill:${skill} 请只回复你收到的技能正文里的第一个标题，不要加其它内容。` }),
						new Promise((_, rej) => setTimeout(() => rej(new Error("__TIMEOUT__")), 150_000)),
					]);
				} catch (e) {
					if (String(e?.message ?? "").includes("__TIMEOUT__")) return true;
				}
				return false;
			},
			{ skill: SKILL_NAME },
		);
		assert.ok(!timedOut, "技能调用挂起");

		const r = await waitForFound(
			`模型回报的技能正文第一个标题「${SKILL_HEADING}」（技能内容没被注入到发给模型的文本里？）`,
			(expect) => {
				return globalThis.kami.snapshot().then((s) => {
					const a = (s?.entries ?? []).filter((x) => x?.role === "assistant" && String(x?.text ?? "").length > 0);
					const text = a.map((x) => x.text).join("\n");
					if (text.includes(expect)) return { found: true, text: text.slice(-200) };
					return { found: false, sample: JSON.stringify(a).slice(-300) };
				});
			},
			{ arg: SKILL_HEADING, timeout: 90_000 },
		);
		console.log(`      模型回报了技能标题，回复尾部：${r.text}`);
	});
} else {
	h.skip("配置真实模型", NO_ENDPOINT);
	h.skip("技能调用：/skill: 展开并送达模型", NO_ENDPOINT);
}

// ── 自动批准权限请求 ───────────────────────────────────────
//
// MCP 工具的权限判定是 `kind: "ask"`（见 command-decider）—— 需要用户批准。
// 无人批准时工具调用会被拒，模型收不到结果。这是**设计如此**：MCP 工具等同
// 于执行用户配置的任意命令，不该静默放行。
//
// 测试里注册一个自动批准器，从而把「权限请求 → 批准 → 工具执行」这条链路
// 也覆盖掉，而不是绕过它。
await win.evaluate(() => {
	globalThis.__zwPermissionLog = [];
	const k = globalThis.kami;
	if (typeof k.onPermissionRequest === "function") {
		k.onPermissionRequest((req) => {
			globalThis.__zwPermissionLog.push({ id: req?.id, toolName: req?.toolName, risk: req?.risk });
			try {
				k.respondToPermission({ id: req.id, decision: "allow" });
			} catch {
				/* 应答失败时忽略：本用例只关心主链路 */
			}
		});
	}
});

// ── ② MCP 连接器 ───────────────────────────────────────────
await h.check("MCP：注册 stdio server 并通过配置校验", async () => {
	const serverPath = resolve(__dirname, "mock-mcp-server.mjs");
	const cfg = JSON.stringify({
		mcpServers: { "zw-mock": { command: process.execPath, args: [serverPath] } },
	});
	const r = await win.evaluate(async (configJson) => {
		try {
			await globalThis.kami.mcpConfigSet(configJson);
			const got = await globalThis.kami.mcpConfigGet();
			return { ok: true, has: JSON.stringify(got).includes("zw-mock") };
		} catch (e) {
			return { ok: false, err: String(e?.message ?? e).slice(0, 220) };
		}
	}, cfg);
	assert.ok(r.ok, `写入 MCP 配置失败: ${r.err}`);
	assert.ok(r.has, "写回的配置里找不到 zw-mock");
});

await h.check("MCP：非法配置被拒绝（command 与 url 不能并存）", async () => {
	const bad = JSON.stringify({ mcpServers: { broken: { command: "node", url: "http://x" } } });
	const r = await win.evaluate(async (configJson) => {
		try {
			await globalThis.kami.mcpConfigSet(configJson);
			return { rejected: false };
		} catch (e) {
			return { rejected: true, err: String(e?.message ?? e).slice(0, 200) };
		}
	}, bad);
	assert.ok(r.rejected, "非法配置（command + url 并存）应被拒绝");
	assert.ok(/只能留一个|command|url/.test(r.err), `拒绝理由不明确：${r.err}`);
});

if (endpoint) {
	await h.check("MCP：连接器状态可读取（含 server 与工具信息）", async () => {
		// ⚠️ 时序要点（踩过一次）：MCP 客户端是**按会话桶**建的，连接发生在
		// **会话构造期** —— 扩展工厂在 resourceLoader.reload() 里被 await 跑完
		// （session-host.js 的 createAgentSession 之前），连完才求值
		// extraActiveTools()。所以桶里**还没建过会话**时，mcpConfigGet 取不到
		// 活句柄，只能按配置**合成**一个 `connecting` 占位
		// （session-files.js 的 mcpConfigGet 回退分支）——
		// 那个 "connecting" 不是"正在连"，而是"还没开始连"，等到天亮也不会变。
		//
		// 所以这里先主动构造一次会话（发一句最短的提示），再等真状态。
		const warm = await win.evaluate(async () => {
			try {
				await Promise.race([
					globalThis.kami.prompt({ text: "只回复：OK" }),
					new Promise((res) => setTimeout(res, 90_000)),
				]);
				return { ok: true };
			} catch (e) {
				return { ok: false, err: String(e?.message ?? e).slice(0, 160) };
			}
		});
		assert.ok(warm.ok, `构造会话失败（MCP 连接依附于会话构造）: ${warm.err}`);

		// 原来的失败信息里带「状态轨迹」与「现状」，这里照样留住：
		// 轨迹在 Node 侧累积（探针会被序列化进页面，闭包变量进不去），现状每轮记一次。
		const seen = [];
		let lastRaw = "(未取到)";
		let server;
		try {
			server = await waitUntil(
				async () => {
					const s = await win.evaluate(async () => await globalThis.kami.mcpConfigGet());
					lastRaw = JSON.stringify(s).slice(0, 400);
					const found = (s?.servers ?? []).find((x) => x.name === "zw-mock");
					if (found !== undefined) seen.push(`${found.status}/${found.toolCount}`);
					return found?.status === "connected" ? found : null;
				},
				{ timeout: 30_000, interval: 1_000, desc: "MCP server 进入 connected 终态" },
			);
		} catch (error) {
			throw new Error(`MCP server 未进入终态。状态轨迹: ${seen.join(" → ")}；现状: ${lastRaw}（${error.message}）`, { cause: error });
		}
		console.log(`      server 状态: ${JSON.stringify(server)?.slice(0, 160)}`);
	});

	await h.check("MCP：server 提供的工具被识别", async () => {
		// 注意：mcpConfigGet 的快照只暴露 toolCount，**不含工具名** ——
		// 工具名在注册进会话时才由 sanitizeToolName 拼出（`mcp__<server>__<tool>`）。
		// 所以这里断言 toolCount，而不是去快照里找工具名。
		const r = await win.evaluate(async () => {
			const s = await globalThis.kami.mcpConfigGet();
			const server = (s?.servers ?? []).find((x) => x.name === "zw-mock");
			return { toolCount: server?.toolCount, status: server?.status };
		});
		assert.equal(r.status, "connected", `server 未连接：${r.status}`);
		assert.equal(r.toolCount, 1, `mock server 应暴露 1 个工具，实际 ${r.toolCount}`);
	});
} else {
	h.skip("MCP：连接器状态可读取（含 server 与工具信息）", `${NO_ENDPOINT}。MCP 连接依附于会话构造，构造会话要先发一次模型请求`);
	h.skip("MCP：server 提供的工具被识别", `${NO_ENDPOINT}。连接状态与工具计数只有会话构造完才可见`);
}

if (endpoint) {
	await h.check("MCP：模型可调用该工具并拿到结果", async () => {
		const timedOut = await win.evaluate(
			async ({ ws }) => {
				const k = globalThis.kami;
				try {
					// 关键：MCP 工具名是在**会话构造时**进工具白名单的
					// （session-host.js 的 extraActiveTools），而 MCP 客户端
					// 是**按会话桶**隔离的（mcpHandleByBucket）—— 上一个桶里
					// 已注册的工具名不属于新桶。
					//
					// 因此 newTask 之后**不要**轮询 mcpConfigGet 等 "connected"：
					// 新桶还没构造会话时，那里读到的是按配置**合成**的 connecting
					// 占位，永远等不到（见上一条用例的注释）。
					//
					// 正确做法就是**直接发消息**：发消息才会构造会话，而构造期里
					// MCP 扩展工厂是被 await 跑完的 —— 连接完成与工具名入白名单
					// 都发生在 extraActiveTools() 求值**之前**。顺序在构造内部
					// 已经保证，外部无需等待。
					//
					// newTask 必须带工作区：MCP 配置写在**工作区级**
					// （<cwd>/.mcp.json，见 writeMcpConfig 的 cwd 参数）。
					// 无参 newTask 会把 cwd 换成临时任务目录，新会话就读不到
					// 那份配置，MCP server 自然连不上。
					await k.newTask(ws);
					await Promise.race([
						k.prompt({
							// 必须给**清洗后的完整工具名**：MCP 工具注册时会被
							// sanitizeToolName 拼成 `mcp__<server>__<tool>`，
							// 模型看到的是这个名字，不是 server 原始的 tool.name。
							text: `请调用名为 mcp__zw-mock__zw_probe_tool 的工具（参数 echo 传 "hello"），然后原样回复工具返回的文本。`,
						}),
						new Promise((_, rej) => setTimeout(() => rej(new Error("__TIMEOUT__")), 150_000)),
					]);
				} catch (e) {
					if (String(e?.message ?? "").includes("__TIMEOUT__")) return true;
				}
				return false;
			},
			{ ws: h.WORKSPACE_DIR },
		);
		assert.ok(!timedOut, "MCP 工具调用挂起");

		let r;
		try {
			r = await waitForFound(
				`模型回复里出现工具返回的标记 ${MCP_TOOL_MARK}（工具没被调用，或结果没回传？）`,
				(mark) => {
					return globalThis.kami.snapshot().then((s) => {
						const a = (s?.entries ?? []).filter((x) => x?.role === "assistant" && String(x?.text ?? "").length > 0);
						const text = a.map((x) => x.text).join("\n");
						if (text.includes(mark)) return { found: true, text: text.slice(-200) };
						return { found: false, sample: JSON.stringify(a).slice(-300) };
					});
				},
				{ arg: MCP_TOOL_MARK, timeout: 90_000 },
			);
		} catch (error) {
			// 原来的失败信息里还有一份 server 快照 —— 这里补上，诊断不弱于原来
			const snap = await win
				.evaluate(async () => JSON.stringify((await globalThis.kami.mcpConfigGet())?.servers ?? []))
				.catch(() => "(取不到)");
			throw new Error(`${error.message}；server: ${String(snap).slice(0, 200)}`, { cause: error });
		}
		console.log(`      工具回执：${r.text}`);
	});

	await h.check("MCP：工具调用触发了权限请求并被批准", async () => {
		// MCP 工具的权限判定是 ask（同于「执行用户配置的任意命令」），
		// 因此调用前必有权限请求。这里断言请求确实发出来了、且带上了工具名 ——
		// 若为 0 条，说明审批链路被绕过了，那是个安全问题。
		const r = await win.evaluate(() => ({ log: globalThis.__zwPermissionLog ?? [] }));
		assert.ok(r.log.length > 0, "未观察到任何权限请求 —— MCP 工具被静默放行了？");
		const mcpReq = r.log.find((x) => String(x.toolName ?? "").startsWith("mcp__"));
		assert.ok(mcpReq, `权限请求里没有 MCP 工具。收到的：${JSON.stringify(r.log).slice(0, 200)}`);
		console.log(`      权限请求: ${JSON.stringify(mcpReq)}`);
	});
} else {
	h.skip("MCP：模型可调用该工具并拿到结果", NO_ENDPOINT);
	h.skip("MCP：工具调用触发了权限请求并被批准", `${NO_ENDPOINT}。没有模型发起工具调用，就不会有 MCP 工具的权限请求`);
}

await h.check("无渲染层未捕获异常", () => assert.equal(h.pageErrors.length, 0, h.pageErrors.join("; ")));

await h.finish();
