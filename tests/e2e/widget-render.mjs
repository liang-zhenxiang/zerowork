/**
 * 可视化卡片**渲染**端到端测试（不需要真实模型 —— 用 mock 服务）。
 *
 * 补的是一处零覆盖：`show_widget` 的**校验规则**已有单元测试
 * （`tests/unit/tools.test.mjs`：6 条拒绝规则、render_mode 推断等），
 * 但**卡片是否真的画到界面上**从来没验过 —— 而那才是这个功能的全部意义。
 * 工具返回对了、渲染层没接上，用户看到的就是「回复里什么都没有」，
 * 而单测与 IPC 断言全都照过。
 *
 * 做法：mock 模型服务按轮次返回 ——
 *   第 1 轮：一个 `tool_calls`，调用 `show_widget`，参数是一段合法 SVG；
 *   第 2 轮（请求体里出现 role:"tool" 说明工具已执行完）：普通最终文本。
 * 然后用**真实 UI 路径**发消息（在输入框打字 + Enter），最后断言 DOM 里
 * 出现了 `.widget-card` 与标题。
 *
 * 为什么不用真实模型：这条验的是**渲染链路**，不是模型能力。mock 让轮次完全确定，
 * 也就没有「弱模型不肯调工具」这类抖动。
 *
 * 迁移说明（共享 harness）：骨架（清隔离目录、启动并等到就绪、check 收集器、
 * 末尾报告与退出码）全部来自 `./lib/harness.mjs`，本文件只剩「驱动界面 + 断言」。
 * 等待一律走信号：启动不再固定等 9 秒；「发送」不再固定等 3 秒，而是等
 * **mock 真的收到请求**；页面里原来的 `for + sleep` 轮询换成 `waitUntil`。
 *
 * ⚠️ 这里**刻意不用** `h.waitForSettled()`：本文件的断言全部发生在**模型回合进行中**，
 * 而回合中界面有 500ms 级的计时器在刷新（时长显示、等待提示轮播），
 * 永远达不到「800ms 静默」——用了只会等到超时。回合结束后才静默。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const WIDGET_TITLE = "渲染探针图";
const FINAL_TEXT = "WIDGET_RENDER_DONE";
// 合法片段：恰好一个 <svg>，viewBox 为 "0 0 680 H"（这两条是工具的硬校验）
const WIDGET_CODE =
	'<svg viewBox="0 0 680 200" width="100%" xmlns="http://www.w3.org/2000/svg">' +
	'<rect x="20" y="20" width="640" height="160" rx="12" fill="#1470b4"/>' +
	'<text x="340" y="110" text-anchor="middle" fill="#fff" font-size="32">WIDGET</text></svg>';

// ── mock 模型服务 ────────────────────────────────────────────
//
// 注：这段内联的 mock 服务是各用例里重复的，**统一抽取是后续独立的一步**，
// 本文件迁移时原样保留，不动它。
function startMockModel() {
	const requests = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			let parsed;
			try {
				parsed = JSON.parse(body);
			} catch {
				parsed = undefined;
			}
			requests.push({ url: req.url, body: parsed });

			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const send = (delta, finish) => {
				const chunk = { id: "chatcmpl-widget", object: "chat.completion.chunk", choices: [{ index: 0, delta }] };
				if (finish !== undefined) chunk.choices[0].finish_reason = finish;
				res.write(`data: ${JSON.stringify(chunk)}\n\n`);
			};

			send({ role: "assistant", content: "" });

			// 请求体里出现 role:"tool" ⇒ 工具已经执行完，该收尾了
			const msgs = parsed?.messages ?? [];
			const hasToolResult = msgs.some((m) => m.role === "tool");

			if (!hasToolResult && requests.length === 1) {
				send({
					tool_calls: [
						{
							index: 0,
							id: "call_widget_1",
							type: "function",
							function: {
								name: "show_widget",
								arguments: JSON.stringify({
									title: WIDGET_TITLE,
									widget_code: WIDGET_CODE,
									loading_messages: ["正在绘制"],
								}),
							},
						},
					],
				});
				send({}, "tool_calls");
			} else {
				for (const chunk of FINAL_TEXT.match(/.{1,8}/gu) ?? []) send({ content: chunk });
				send({}, "stop");
			}

			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	return new Promise((ok) => {
		server.listen(0, "127.0.0.1", () =>
			ok({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests, close: () => new Promise((r) => server.close(r)) }),
		);
	});
}

const h = createHarness({ name: "widget" });
// harness 负责隔离与清空工作区根目录，目录本身要由用例建出来
mkdirSync(h.WORKSPACE_DIR, { recursive: true });

const mock = await startMockModel();
console.log(`✓ mock 模型服务已就绪：${mock.baseUrl}`);

await h.launch();
const win = h.window();

await h.snap("home");

/** 等 mock 收到第 n 轮请求 —— 「模型真的被调到了」是比固定等待可靠的信号。 */
async function waitForRounds(n, why) {
	try {
		await waitUntil(() => mock.requests.length >= n, {
			timeout: 40_000,
			interval: 500,
			desc: `mock 收到第 ${n} 轮请求`,
		});
	} catch (error) {
		throw new Error(`mock 只收到 ${mock.requests.length} 轮请求（期望 ≥${n}）—— ${why}（${error.message}）`);
	}
}

/**
 * 在页面里轮询探针，直到它报告 `found`。
 *
 * 取代原来「在页面里 for 循环 + sleep」的写法：截止时间交给 `waitUntil` 统一管，
 * 慢机器不假失败、快机器不白等；超时时把**页面尾部内容**带进错误里，
 * 失败信息才能直接看出界面上到底有什么。
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
		throw new Error(`${error.message}；界面尾部：${String(last?.sample ?? "(未取到)").slice(-300)}`);
	}
}

await h.check("注册指向 mock 的 provider 并切模型", async () => {
	const r = await win.evaluate(async ({ baseUrl, ws }) => {
		const k = globalThis.kami;
		try {
			await k.saveCustomProvider(
				{
					id: "mock-widget",
					name: "Mock Widget",
					baseUrl,
					api: "openai-completions",
					authHeader: true,
					models: [{ id: "widget-model", name: "widget-model", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }],
				},
				"mock-key",
			);
			await k.setModel("mock-widget/widget-model");
			await k.setWorkspace(ws);
			return { ok: true };
		} catch (e) {
			return { ok: false, err: String(e?.message ?? e).slice(0, 200) };
		}
	}, { baseUrl: mock.baseUrl, ws: h.WORKSPACE_DIR });
	assert.ok(r.ok, `配置失败：${r.err}`);
});

await h.check("在输入框里输入并发送（走真实 UI 路径）", async () => {
	const box = win.locator('[aria-label="消息输入框"]');
	await box.waitFor({ state: "visible", timeout: 30_000 });
	await box.fill("请给我画一张示意图");
	await box.press("Enter");
	// 原来是固定等 3 秒。改成等 mock 真收到请求 —— 发送有没有走通，这是直接证据
	await waitForRounds(1, "消息没有发出去");
});

await h.check("mock 收到了两轮请求（工具调用循环转起来了）", async () => {
	await waitForRounds(2, "工具调用循环没转起来");
	const second = mock.requests[1];
	const hasToolMsg = (second?.body?.messages ?? []).some((m) => m.role === "tool");
	assert.ok(hasToolMsg, "第二轮请求里没有 role:tool —— 工具结果没回传");
	console.log(`      mock 收到 ${mock.requests.length} 轮请求`);
});

await h.check("可视化卡片渲染到界面上（.widget-card + 标题）", async () => {
	const r = await waitForFound("界面上出现 .widget-card（工具返回对了却没渲染？）", () => {
		const card = document.querySelector(".widget-card");
		if (card === null) return { found: false, sample: (document.body.innerText || "").slice(-300) };
		return {
			found: true,
			titleText: (card.querySelector(".widget-title")?.textContent ?? "").trim(),
			hasFrame: card.querySelector(".widget-frame") !== null,
			hasError: card.querySelector(".widget-error") !== null,
			cardText: (card.textContent ?? "").slice(0, 120),
		};
	});
	// 先截图、后断言：卡片在屏上时留现场；下面的内容断言一旦失败，图里就有那一屏。
	// 截图自带像素断言 —— DOM 里有卡片不等于卡片真的画出来了。
	await h.shoot("widget-card");
	assert.equal(r.titleText, WIDGET_TITLE, `卡片标题不对：${JSON.stringify(r.titleText)}`);
	assert.ok(r.hasFrame, "卡片里没有 .widget-frame —— 内容没挂上");
	assert.ok(!r.hasError, `卡片是错误态：${r.cardText}`);
	console.log(`      卡片标题「${r.titleText}」，含 frame ✓`);
});

await h.check("定稿后有产物徽标与入场动效（issue #71）", async () => {
	const r2 = await waitForFound(
		"产物徽标出现",
		() => {
			const badge = document.querySelector(".widget-artifact-badge");
			const card = document.querySelector(".widget-card");
			if (badge === null || card === null) return { found: false };
			const dot = badge.querySelector(".widget-artifact-dot") !== null;
			const finalized = card.classList.contains("widget-finalized");
			const anim = getComputedStyle(card.querySelector(".widget-body")).animationName;
			return { found: dot && finalized, dot, finalized, anim, sample: badge.textContent };
		},
		{ timeout: 20_000 },
	);
	assert.ok(r2.dot, "徽标里没有品牌绿状态点");
	assert.ok(r2.finalized, "卡片没挂 widget-finalized（入场动效的触发态）");
	// 动画在动效正常的环境应播放（名称非 none）；reduced-motion 的关停由 smoke 的
	// 减弱动效用例族覆盖，这里不重复断言。
	assert.notEqual(r2.anim, "none", `定稿入场动画没生效：animationName=${r2.anim}`);
});

await h.check("最终回复也渲染出来（工具调用后模型继续说话）", async () => {
	const r = await waitForFound(
		"界面上出现最终回复",
		(mark) => {
			const text = document.body.innerText || "";
			return text.includes(mark) ? { found: true } : { found: false, sample: text.slice(-200) };
		},
		{ arg: FINAL_TEXT, timeout: 20_000 },
	);
	await h.shoot("final-reply");
	assert.ok(r.found, `界面上找不到最终回复 ${FINAL_TEXT}`);
});

await h.check("无渲染层未捕获异常", () => assert.equal(h.pageErrors.length, 0, h.pageErrors.join("; ")));

// 先关应用再关 mock：应用一关，daemon 与 mock 之间的长连接才会断开，
// server.close() 才不会一直等在那儿（原实现的顺序就是这样）。
await h.app().close();
await mock.close();
await h.finish();
