/**
 * 主链路端到端测试：输入 → 模型请求 → 流式回复 → 会话状态。
 *
 * 这是本项目最重要的一条测试。此前所有测试都只在验证「应用自身的零件」，
 * 唯独没验证过「发一条消息，模型真的回话了」—— 因为常规做法需要 API Key。
 *
 * 做法：应用支持自定义 provider（baseUrl 可配），于是在本地起一个
 * OpenAI 兼容的 mock 服务，把整条链路串起来：
 *
 *   渲染层 window.kami.prompt()
 *     → preload IPC
 *     → daemon session-factories
 *     → pi agent harness
 *     → HTTP POST /v1/chat/completions
 *     → mock 服务 SSE 流式响应
 *     → 解析回会话状态
 *
 * 断言的是链路真的通了（mock 收到请求、回复落到会话），不是模型能力。
 *
 * 迁移说明（共享 harness）：骨架（清隔离目录、启动并等到就绪、check 收集器、
 * 末尾报告与退出码）全部来自 `./lib/harness.mjs`。启动不再固定等 9 秒；
 * 「发送后等 2.5 秒」改为等 **mock 真的收到 /chat/completions 请求**；
 * 「给网络往返留 3 秒」改为等目标请求出现；页面里的 `for + sleep` 换成 `waitUntil`；
 * 末尾那张固定路径的截图换成 harness 的 `h.shoot`（截图 + 像素断言）。
 *
 * ⚠️ 这里**刻意不用** `h.waitForSettled()`：断言全部发生在**模型回合进行中**，
 * 而回合中界面有 500ms 级的计时器在刷新（时长显示、等待提示轮播），
 * 永远达不到「800ms 静默」——用了只会等到超时。
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const REPLY_TEXT = "MOCK_REPLY_已收到你的消息";
const USER_TEXT = "你好，请回复";

const PROVIDER_ID = "e2e-mock";
const MODEL_ID = "mock-model";
const MODEL_KEY = `${PROVIDER_ID}/${MODEL_ID}`;

const h = createHarness({ name: "roundtrip" });
// harness 负责隔离与清空工作区根目录，目录本身要由用例建出来
mkdirSync(h.WORKSPACE_DIR, { recursive: true });

// ── 启动 mock 模型服务 ─────────────────────────────────────
const mock = await startMockModelServer({ reply: REPLY_TEXT });
console.log(`✓ mock 模型服务已就绪：${mock.baseUrl}`);

await h.launch();
const win = h.window();

await h.snap("home");

const findChatRequest = () => mock.requests.find((q) => q.url?.includes("/chat/completions"));

/**
 * 等 mock **真的**收到 chat/completions 请求。
 *
 * 「消息发出去了没有」不能靠固定等待来回答（那无法证伪）—— 等对端的可观察结果，
 * 超时时把已收到的 URL 清单带进错误里。
 */
async function waitForChatRequest(why) {
	try {
		return await waitUntil(() => findChatRequest() ?? null, {
			timeout: 40_000,
			interval: 500,
			desc: "mock 服务收到 /chat/completions 请求",
		});
	} catch (error) {
		throw new Error(
			`${why}。已收到 ${mock.requests.length} 条：${mock.requests.map((q) => q.url).join(", ")}（${error.message}）`,
		);
	}
}

/**
 * 在页面里轮询探针，直到它报告 `found`。
 *
 * 取代原来「在页面里 for 循环 + sleep」的写法：截止时间交给 `waitUntil` 统一管，
 * 慢机器不假失败、快机器不白等；超时时把**最后一次探针看到的样例**带进错误里。
 */
async function waitForFound(desc, probe, { arg, timeout = 30_000 } = {}) {
	let last = null;
	try {
		return await waitUntil(
			async () => {
				last = await win.evaluate(probe, arg);
				return last?.found ? last : null;
			},
			{ timeout, interval: 500, desc },
		);
	} catch (error) {
		throw new Error(`${error.message}；样例：${String(last?.sample ?? "(未取到)").slice(0, 400)}`);
	}
}

// ── 1. 注册自定义 provider 指向 mock 服务 ──────────────────
await h.check("注册自定义 provider 指向 mock 服务", async () => {
	const r = await win.evaluate(
		async ({ id, baseUrl, apiKey }) => {
			const k = globalThis.kami;
			try {
				await k.saveCustomProvider(
					{
						id,
						name: "E2E Mock",
						baseUrl,
						api: "openai-completions",
						models: [
							{
								id: "mock-model",
								name: "Mock Model",
								reasoning: false,
								vision: false,
								contextWindow: 128000,
								maxTokens: 4096,
							},
						],
					},
					apiKey,
				);
				return { ok: true };
			} catch (e) {
				return { ok: false, err: String(e?.message ?? e).slice(0, 200) };
			}
		},
		{ id: PROVIDER_ID, baseUrl: mock.baseUrl, apiKey: "sk-e2e-dummy" },
	);
	assert.ok(r.ok, `注册失败: ${r.err}`);
});

await h.check("自定义 provider 出现在设置快照中", async () => {
	const r = await win.evaluate(async (id) => {
		const s = await globalThis.kami.settingsSnapshot();
		return { found: JSON.stringify(s).includes(id) };
	}, PROVIDER_ID);
	assert.ok(r.found, "设置快照里找不到刚注册的 provider");
});

await h.check("设置 API Key", async () => {
	const r = await win.evaluate(
		async ({ id, key }) => {
			try {
				await globalThis.kami.setApiKey(id, key);
				return { ok: true };
			} catch (e) {
				return { ok: false, err: String(e?.message ?? e).slice(0, 160) };
			}
		},
		{ id: PROVIDER_ID, key: "sk-e2e-dummy" },
	);
	assert.ok(r.ok, `设置 API Key 失败: ${r.err}`);
});

// ── 2. 选中该模型 ──────────────────────────────────────────
await h.check("切换到 mock 模型", async () => {
	const r = await win.evaluate(async (key) => {
		const k = globalThis.kami;
		try {
			await k.setModel(key);
			const s = await k.snapshot();
			return { ok: true, active: JSON.stringify(s?.state ?? {}).slice(0, 200) };
		} catch (e) {
			return { ok: false, err: String(e?.message ?? e).slice(0, 200) };
		}
	}, MODEL_KEY);
	assert.ok(r.ok, `切换模型失败: ${r.err}`);
});

// ── 3. 发送消息，验证整条链路 ──────────────────────────────
//
// ⚠️ 这一步走**真实 UI 路径**（在输入框里打字 + Enter），而不是直接调
// `kami.prompt()`。踩过一次才知道差别有多大：直接调 IPC 时消息确实发出去了、
// 回复也确实落进了会话状态，但界面**停在欢迎页** —— 因为「切到会话视图」是
// 界面自己的动作，绕过它就不会发生。于是「回复渲染到界面上」这条断言
// 永远只能是假失败。
//
// 走 UI 路径之后，这条用例验的就是用户真正做的那件事。
await h.check("在输入框里输入并发送消息", async () => {
	const box = win.locator('[aria-label="消息输入框"]');
	await box.waitFor({ state: "visible", timeout: 30_000 });
	await box.fill(USER_TEXT); // 受控组件：必须用 fill 触发 React 的 onChange
	await box.press("Enter");
	// 原来是固定等 2.5 秒。改成等 mock 真收到请求 —— 发送有没有走通，这是直接证据
	await waitForChatRequest("消息没有发出去");
});

await h.check("mock 服务确实收到了 chat/completions 请求", async () => {
	const hit = findChatRequest();
	assert.ok(hit, `mock 服务未收到请求。已收到 ${mock.requests.length} 条：${mock.requests.map((q) => q.url).join(", ")}`);
});

await h.check("请求体包含用户消息内容", async () => {
	const hit = findChatRequest();
	assert.ok(hit, "没有请求可校验");
	const body = JSON.stringify(hit.body ?? {});
	assert.ok(body.includes("你好"), `请求体里没有用户消息内容: ${body.slice(0, 300)}`);
});

await h.check("请求携带了 Authorization 头", async () => {
	const hit = findChatRequest();
	assert.ok(hit, "没有请求可校验");
	const auth = hit.headers?.authorization ?? hit.headers?.Authorization ?? "";
	assert.ok(String(auth).length > 0, "请求未携带 Authorization 头");
});

// ── 4. 模型回复落到会话状态 ────────────────────────────────
await h.check("模型回复出现在会话状态中", async () => {
	const r = await waitForFound(
		"会话状态里出现模型回复（流式回包没落到会话？）",
		async (marker) => {
			const s = await globalThis.kami.snapshot();
			return JSON.stringify(s).includes(marker)
				? { found: true }
				: { found: false, sample: JSON.stringify(s).slice(0, 400) };
		},
		{ arg: "MOCK_REPLY", timeout: 30_000 },
	);
	assert.ok(r.found, `会话状态里找不到模型回复。快照样例: ${r.sample}`);
});

// ── 5. 回复**渲染到界面上** ─────────────────────────────────
//
// ⚠️ 这一条补的是一个真实缺口：上面那条断言的是「回复落到**会话状态**」，
// 走的是 IPC（`snapshot()`）。但「模型回话了」与「用户在界面上看到了」
// 是两件事 —— 渲染层完全可能没把它画出来（消息列表坏了、流式回包没接上、
// 组件抛错被吞），而所有现有断言照过。
//
// 所以这里直接读 DOM：**用户眼睛能看到的文本**。
await h.check("模型回复渲染到界面上（不只是落到会话状态）", async () => {
	const r = await waitForFound(
		"界面文本里出现模型回复（回复进了状态却没渲染出来？）",
		(marker) => {
			const text = document.body.innerText || "";
			return text.includes(marker) ? { found: true, len: text.length } : { found: false, sample: text.slice(-300) };
		},
		{ arg: "MOCK_REPLY", timeout: 30_000 },
	);
	// 先截图、后断言：回复在屏上时留现场；下面的断言一旦失败，图里就有那一屏。
	// 截图自带像素断言 —— DOM 里有文本不等于它真的画出来了。
	await h.shoot("final-reply");
	assert.ok(r.found, `界面文本里找不到模型回复 —— 回复进了状态但没渲染出来？界面尾部: ${r.sample}`);
	console.log(`      DOM 文本 ${r.len} 字符`);
});

await h.check("无渲染层未捕获异常", () => assert.equal(h.pageErrors.length, 0, h.pageErrors.join("; ")));

// 先关应用再关 mock：应用一关，daemon 与 mock 之间的长连接才会断开，
// server.close() 才不会一直等在那儿（原实现的顺序就是这样）。
await h.app().close();
await mock.close();
console.log(`（mock 共收到 ${mock.requests.length} 条请求）`);
await h.finish();
