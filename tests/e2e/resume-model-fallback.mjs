/**
 * #162 方案 A 的端到端验证：**不预配全局模型**，resume 回落到会话自身记录的模型。
 *
 * 这是「留为会话 → 去这条会话」与资料库「定位到来源会话」共用的那条链路：
 * `resumeSession` → `mountSessionFile` → `createHost`，此前在 `activeModelKey`
 * 为空时直接抛「还没有选择模型」。对比屏恰恰是给「还没决定用哪个模型」的人用的，
 * 这堵墙就横在新用户的主线上（见 Issue #162 与 library.mjs 的同款踩坑注释）。
 *
 * 环境与传统用例的**关键差异**：全新 CONFIG_DIR、注册 provider 但**从不 setModel**
 * —— 全局确实没有选择，会话文件里写着 `model_change` 指向那个 provider 的模型。
 *
 * 验四件事：
 *   ① 点开这条会话能**进入**（此前在这一步就被拦）；
 *   ② 过程中不出现「还没有选择模型」的报错 toast；
 *   ③ 进去后**继续发一条消息能收到回复** —— 宿主真的用会话自己的模型建起来了，
 *      不是只把历史画出来（mock 收到请求是直接证据）；
 *   ④ 反向：会话记录的模型在 catalog 里**不存在**（provider 没配过）时，
 *      报错要点名那个模型并指路设置页，而不是泛泛的「还没有选择模型」。
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const SESSION_TITLE_TEXT = "用会话里记录的模型接我回去";
const FOLLOWUP_REPLY = "RESUME_FALLBACK_ALIVE";

const h = createHarness({ name: "resume-model-fallback" });
const SESSIONS_DIR = join(h.CONFIG_DIR, "sessions");
const WS = join(h.WORKSPACE_DIR, "季度汇总");

/**
 * 手写一条含 model_change 的会话（schema 与 export-markdown.mjs 的预置同款）。
 * assistant 消息必须带 provider/model 字段 —— pi 的投影（getSessionContextSettings）
 * 用**最后一条 assistant 消息自己的字段**判定「这会话当时是谁在答」，model_change
 * 条目反而会被它覆盖；不带字段等于造了一条「不知道谁答的」的坏会话。
 */
function writeSession(id, provider, modelId, userText) {
	const stamp = (n) => `2026-10-09T09:00:0${n}.000Z`;
	const message = (mid, parentId, n, payload) =>
		JSON.stringify({ type: "message", id: mid, parentId, timestamp: stamp(n), message: { timestamp: Date.parse(stamp(n)), ...payload } });
	writeFileSync(
		join(SESSIONS_DIR, `2026-10-09T09-00-00-000Z_${id}.jsonl`),
		[
			JSON.stringify({ type: "session", version: 3, id, timestamp: stamp(0), cwd: WS }),
			JSON.stringify({ type: "model_change", id: "m1", parentId: null, timestamp: stamp(0), provider, modelId }),
			message("u1", "m1", 1, { role: "user", content: [{ type: "text", text: userText }] }),
			message("a1", "u1", 2, {
				role: "assistant",
				provider,
				model: modelId,
				content: [{ type: "text", text: "好的，我在。" }],
				stopReason: "endTurn",
				// usage 必须带（pi 形状）：恢复会话时 pi 读 message.usage.totalTokens，
				// 缺了整轮回合以「Cannot read properties of undefined (reading
				// 'totalTokens')」炸掉（与真实会话文件的字段对齐，实测过）。
				usage: {
					input: 100,
					output: 20,
					cacheRead: 0,
					cacheWrite: 0,
					reasoning: 0,
					totalTokens: 120,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			}),
		].join("\n") + "\n",
	);
}

mkdirSync(SESSIONS_DIR, { recursive: true });
mkdirSync(WS, { recursive: true });
// 主会话：记录的模型指向真实 mock（能回话，验「回落后模型真的能用」）
writeSession("rfb-main", "mock-rfb", "rfb-model", SESSION_TITLE_TEXT);
// 反向会话：记录一个**从未配置**的 provider（catalog 里不存在 → unavailable）
writeSession("rfb-ghost", "ghost-provider", "ghost-model", "记录的模型早已不在");

// usage 必须给：pi 解析 openai-completions 响应要读它，缺了会以
// 「Cannot read properties of undefined (reading 'totalTokens')」炸掉整个回合（实测）。
const mock = await startMockModelServer({
	reply: FOLLOWUP_REPLY,
	models: ["rfb-model"],
	usage: { prompt_tokens: 120, completion_tokens: 12 },
});
console.log(`✓ mock 模型服务已就绪：${mock.port}`);

await h.launch();
const win = h.window();

// ── 准备：注册 provider 但**不选全局模型**（本用例的全部前提） ──────────
await h.check("准备：注册可用服务商、不选全局模型", async () => {
	const r = await win.evaluate(
		async ({ baseUrl, ws }) => {
			const k = globalThis.kami;
			try {
				await k.saveCustomProvider(
					{
						id: "mock-rfb",
						name: "Resume Fallback",
						baseUrl,
						api: "openai-completions",
						authHeader: true,
						models: [{ id: "rfb-model", name: "rfb-model", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }],
					},
					"mock-key",
				);
				// 会话的 cwd 要落在工作空间内（resumeSession 会 validateWorkspacePath）
				await k.setWorkspace(ws);
				return { ok: true };
			} catch (e) {
				return { ok: false, err: String(e?.message ?? e).slice(0, 300) };
			}
		},
		{ baseUrl: mock.baseUrl, ws: h.WORKSPACE_DIR },
	);
	assert.ok(r.ok, `配置失败：${r.err}`);
});

// ── ① 点开主会话 → 进入（此前被「还没有选择模型」拦下） ─────────────────
await h.check("① 没选过全局模型，点开会话也能进入（回落到会话记录的模型）", async () => {
	await waitUntil(
		() => win.evaluate((text) => document.body.innerText.includes(text), SESSION_TITLE_TEXT),
		{ timeout: 30_000, interval: 500, desc: "首页最近会话出现目标会话" },
	);
	await h.shoot("home-with-session");
	await win.evaluate(() => {
		const row = [...document.querySelectorAll(".home-recent-row")].find((r) =>
			(r.textContent ?? "").includes("用会话里记录的模型接我回去"),
		);
		if (row === null) throw new Error("最近会话行不在");
		row.click();
	});
	await waitUntil(() => win.evaluate(() => document.querySelector('[aria-label="返回首页"]') !== null), {
		timeout: 30_000,
		desc: "进入会话视图",
	});
	const inChat = await win.evaluate(() => document.body.innerText);
	assert.ok(inChat.includes("好的，我在。"), "会话历史应已渲染");
	// ② 没有报错 toast（resume 失败的形态就是 toast-stack 里冒错误）
	const toasts = await win.evaluate(() => [
		...document.querySelectorAll(".toast-stack .toast")].map((t) => (t.textContent ?? "").trim()),
	);
	assert.ok(
		!toasts.some((t) => t.includes("还没有选择模型")),
		`不该出现「还没有选择模型」，实际 toast：${JSON.stringify(toasts)}`,
	);
});

// ── ③ 继续发一条 → mock 收到请求并回复（宿主真的建起来了） ──────────────
await h.check("③ 进去后继续发消息，会话自己的模型真的能回话", async () => {
	await h.shoot("session-opened");
	const box = win.locator('[aria-label="消息输入框"]');
	await box.waitFor({ state: "visible", timeout: 30_000 });
	await box.fill("还在吗");
	await box.press("Enter");
	await waitUntil(() => mock.requests.length >= 1, { timeout: 30_000, desc: "mock 收到第一条请求" });
	await waitUntil(() => win.evaluate((t) => document.body.innerText.includes(t), FOLLOWUP_REPLY), {
		timeout: 30_000,
		desc: "回复出现在界面上",
	});
	await h.shoot("followup-replied");
});

// ── ④ 反向：记录的模型不存在 → 报错点名模型并指路设置，而非泛泛一句 ─────
await h.check("④ 反向：记录的模型接不上时，报错点名模型（宁可拒绝，不静默换脑）", async () => {
	await win.evaluate(() => document.querySelector('[aria-label="返回首页"]')?.click());
	await waitUntil(() => win.evaluate(() => document.querySelector(".home-recent-row") !== null), {
		timeout: 30_000,
		desc: "回到首页",
	});
	await win.evaluate(() => {
		const row = [...document.querySelectorAll(".home-recent-row")].find((r) =>
			(r.textContent ?? "").includes("记录的模型早已不在"),
		);
		if (row === null) throw new Error("反向会话行不在");
		row.click();
	});
	await waitUntil(
		() =>
			win.evaluate(() =>
				[...document.querySelectorAll(".toast-stack .toast")].some((t) =>
					(t.textContent ?? "").includes("ghost-provider/ghost-model"),
				),
			),
		{ timeout: 30_000, interval: 500, desc: "出现点名 ghost 模型的报错" },
	);
	await h.shoot("ghost-model-error");
});

await mock.close();
await h.finish();
