/**
 * 真实模型端到端测试：用真实 LLM 验证「发送 → 收到回复」。
 *
 * 与 model-roundtrip.mjs 的关系：
 *   model-roundtrip —— 用本地 mock 服务，验证**链路通了**（无外部依赖，CI 里跑）
 *   real-model       —— 用真实模型，验证**真的能对话**（需要本机有可用端点）
 *
 * 为什么要分开：mock 只能证明管道不漏，证明不了协议对接正确 ——
 * 真实端点的鉴权头格式、流式事件类型、token 计数、错误结构都可能与 mock 不同。
 * 这一层补上「与真实服务对接」的验证。
 *
 * ⚠️ 凭据处理：
 *   凭据在**运行时**从 ~/.claude/settings.json 读取，**不进仓库、不打印**。
 *
 * ── 迁移说明（共享 harness）────────────────────────────────
 *
 * 骨架（隔离目录、启动并等到就绪、check 收集器、末尾报告与退出码）全部来自
 * `./lib/harness.mjs`：不再手写固定路径 /tmp/zerowork-realmodel*、不再 `rmSync`、
 * 不再固定等 9 秒、不再自建报告循环。等待一律走信号（等 snapshot 里真的出现
 * 带内容的 assistant 条目），把「够不够久」交给实际状态来回答。
 *
 * ⚠️ 端点探不到时**逐条 h.skip**，不再是整轮 `exit(0)`。
 *   后者在报告里表现为「全绿」，实际一条断言都没跑 —— 在 CI 上就是零信号，
 *   一个坏掉的链路也能长期显示通过。改后报告会多出「跳过 N」，跳过是有痕迹的。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const h = createHarness({ name: "real-model" });

// ── 读取本机端点配置（凭据不落盘、不打印）────────────────────
const SETTINGS = resolve(homedir(), ".claude", "settings.json");

function readEndpoint() {
	if (!existsSync(SETTINGS)) return undefined;
	try {
		const env = JSON.parse(readFileSync(SETTINGS, "utf8"))?.env ?? {};
		const baseUrl = env.ANTHROPIC_BASE_URL;
		const token = env.ANTHROPIC_AUTH_TOKEN;
		// 模型名去掉方括号后缀（[1M] 之类是本地代理的档位标注，不是 API 里的模型 id）
		const model = String(env.ANTHROPIC_MODEL ?? "").replace(/\[[^\]]*\]$/, "");
		if (!baseUrl || !token || !model) return undefined;
		return { baseUrl, token, model };
	} catch {
		return undefined;
	}
}

/**
 * 解析出可用端点；不可用时给出**能照着修**的原因（而不是一个布尔值）。
 *
 * 除了读配置还要探测端点是否真的活着：「本机没起代理」是环境问题，
 * 报成应用故障只有误导。
 */
async function resolveEndpoint() {
	if (!existsSync(SETTINGS)) {
		return { reason: `未找到 ${SETTINGS}（需要其中的 env.ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL）` };
	}
	const endpoint = readEndpoint();
	if (endpoint === undefined) {
		return { reason: `${SETTINGS} 的 env 里缺少 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL 中的某一项` };
	}
	const probe = await fetch(`${endpoint.baseUrl}/v1/messages`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-api-key": endpoint.token,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify({
			model: endpoint.model,
			max_tokens: 16,
			messages: [{ role: "user", content: "hi" }],
		}),
	}).catch(() => undefined);
	if (!probe || !probe.ok) {
		return { reason: `模型端点不可用（HTTP ${probe?.status ?? "无响应"}）：${endpoint.baseUrl}` };
	}
	return { endpoint };
}

/** 端点不可用时要**逐条**上报的跳过项 —— 与下面的 h.check 一一对应。 */
const CHECKS = [
	"启动后界面已渲染",
	"配置真实模型端点",
	"发送消息并收到真实回复",
	"回复携带真实 token 用量",
	"无渲染层未捕获异常",
];

const { endpoint, reason } = await resolveEndpoint();

if (endpoint === undefined) {
	console.log(`⚠ ${reason}`);
	console.log("  真实模型测试整轮跳过 —— 逐条记入报告，而不是伪装成全绿。");
	for (const label of CHECKS) h.skip(label, reason);
	await h.finish(); // finish 会 exit；下面只有端点可用时才会执行到
}

console.log(`✓ 模型端点可用：${endpoint.baseUrl}，模型 ${endpoint.model}`);

await h.launch();
const win = h.window();

await h.check("启动后界面已渲染", async () => {
	// 先截图后断言：这一屏是后面所有断言的起点，界面不对时图里能直接看出来
	await h.shoot("welcome");
});

const PROVIDER_ID = "local-proxy";

await h.check("配置真实模型端点", async () => {
	const r = await win.evaluate(
		async ({ id, baseUrl, token, model }) => {
			try {
				await globalThis.kami.saveCustomProvider(
					{
						id,
						name: "Local Proxy",
						baseUrl,
						// 本机代理讲 Anthropic Messages 协议，且走 x-api-key 头
						api: "anthropic-messages",
						authHeader: true,
						models: [
							{
								id: model,
								name: model,
								reasoning: false,
								vision: false,
								contextWindow: 128000,
								maxTokens: 4096,
							},
						],
					},
					token,
				);
				await globalThis.kami.setModel(`${id}/${model}`);
				return { ok: true };
			} catch (e) {
				return { ok: false, err: String(e?.message ?? e).slice(0, 200) };
			}
		},
		{ id: PROVIDER_ID, baseUrl: endpoint.baseUrl, token: endpoint.token, model: endpoint.model },
	);
	assert.ok(r.ok, `配置失败: ${r.err}`);
});

/** 读一页状态：assistant 条目（带内容的那条）与整页条目。 */
function readReplyState() {
	return win.evaluate(async () => {
		const s = await globalThis.kami.snapshot();
		const entries = s?.entries ?? [];
		// ⚠️ 不能只在整个 snapshot 里找标记 —— 消息发出后**任务标题**立刻就会
		// 带上这段文本，标记很快就「找得到」，但那时 assistant 回复尚未落盘。
		// 判据必须是 entries 里真的出现**带内容的 assistant 条目**。
		const assistant = entries.filter((e) => e?.role === "assistant" && String(e?.text ?? "").length > 0);
		const last = assistant.at(-1);
		return {
			complete: assistant.length > 0,
			entryCount: entries.length,
			text: last?.text ?? "",
			usage: last?.usage ?? null,
			sample: JSON.stringify(entries).slice(0, 400),
		};
	});
}

await h.check("发送消息并收到真实回复", async () => {
	// 让模型回一个可断言的特征串，避免"随便回点什么都算过"
	const MARK = `ZW${Date.now().toString().slice(-6)}`;
	const sent = await win.evaluate(
		async ({ mark }) => {
			try {
				await Promise.race([
					globalThis.kami.prompt({ text: `请原样回复这个标记，不要加任何其它内容：${mark}` }),
					new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT_120S")), 120_000)),
				]);
				return { timedOut: false };
			} catch (e) {
				const msg = String(e?.message ?? e);
				// 只有超时才算「挂起」；其余异常（提供方报错、鉴权失败……）也如实带出来
				return { timedOut: msg.includes("TIMEOUT_120S"), err: msg.slice(0, 200) };
			}
		},
		{ mark: MARK },
	);
	assert.ok(!sent.timedOut, `发送后 120 秒未返回 —— 主链路挂起${sent.err ? `（${sent.err}）` : ""}`);

	// 轮询等 assistant 条目落盘。原来是页面里 `for × 40 + sleep 2s` 的手写轮询，
	// 换成 waitUntil：同样的 80 秒预算，超时信息里带上最后一次探针状态。
	let state = null;
	let why = "";
	try {
		await waitUntil(
			async () => {
				state = await readReplyState();
				return state.complete;
			},
			{
				timeout: 80_000,
				interval: 1000,
				desc: "assistant 条目带内容落盘（任务标题会先带上标记，所以不能只在整个 snapshot 里找标记）",
			},
		);
	} catch (error) {
		why = error.message;
	}

	// 先截图、后断言 —— 断言失败时图里才有出问题的那一屏。
	// 名字如实描述画面：本文件不驱动导航，回合结束后界面仍停在欢迎页
	// （会话在后台跑），所以这张图抓的是「回复已到达时的界面」，不是对话本身。
	await h.shoot("after-reply");
	const seen = state ?? { entryCount: "(未取到)", sample: "(未取到)" };
	assert.ok(state?.complete, `等不到 assistant 回复。条目数 ${seen.entryCount}，样例: ${seen.sample}${why ? `（${why}）` : ""}`);
	console.log(`      模型回复: ${JSON.stringify(state.text).slice(0, 120)}`);
	console.log(`      token 用量: ${JSON.stringify(state.usage)}`);
});

await h.check("回复携带真实 token 用量", async () => {
	// 真实服务会在 usage 里回报 token 数；这是"确实调用了真实模型"的硬证据，
	// mock 服务不会有这个字段。
	//
	// 这里读的是**同一条 assistant 条目**的另一个字段：text 与 usage 由
	// session-view 从**同一条已落盘消息**投影而来（`message.usage === undefined`
	// 才缺省），两者不会先后到达 —— 所以不存在「等到了 text 再去断言 usage」
	// 那种竞态，不需要把 usage 塞进上一条的完成条件里。
	const r = await win.evaluate(async () => {
		const s = await globalThis.kami.snapshot();
		const a = (s?.entries ?? []).filter((e) => e?.role === "assistant").at(-1);
		return { usage: a?.usage ?? null };
	});
	assert.ok(r.usage !== null && r.usage !== undefined, "assistant 条目没有 usage 字段");
	assert.ok(
		Number(r.usage?.input ?? 0) > 0 || Number(r.usage?.totalTokens ?? 0) > 0,
		`usage 里没有有效的 token 计数: ${JSON.stringify(r.usage)}`,
	);
});

await h.check("无渲染层未捕获异常", () => assert.equal(h.pageErrors.length, 0, h.pageErrors.join("; ")));

await h.finish();
