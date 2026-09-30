/**
 * Agent 工具调用循环测试：模型请求工具 → agent 执行 → 结果回传 → 最终回复。
 *
 * 这一层验证的是「agent 能不能干活」，而不只是「模型能不能回话」。
 * 与 model-roundtrip.mjs 的区别：
 *   model-roundtrip —— 模型直接回文本（一问一答）
 *   tool-loop       —— 模型要求执行工具，agent 执行后再让它总结（多轮循环）
 *
 * 用 mock 服务分两轮响应：
 *   第 1 轮：返回 tool_calls，要求执行 `ls`
 *   第 2 轮：收到工具执行结果后，返回最终文本
 * 断言 mock 服务**收到了第 2 轮请求且请求体里带工具执行结果** ——
 * 这就证明 agent 循环真的转起来了，而不是模型自说自话。
 *
 * 迁移说明（共享 harness）：骨架（清隔离目录、启动并等到就绪、check 收集器、
 * 末尾报告与退出码）全部来自 `./lib/harness.mjs`。启动不再固定等 9 秒；
 * 「等循环转起来」不再固定轮询 20×1.5 秒，改为等 **mock 真的收到第 2 轮请求**；
 * 页面里的 `for + sleep` 轮询换成 `waitUntil`。
 *
 * ⚠️ 这里**刻意不用** `h.waitForSettled()`：断言全部发生在**模型回合进行中**，
 * 而回合中界面有 500ms 级的计时器在刷新（时长显示、等待提示轮播），
 * 永远达不到「800ms 静默」——用了只会等到超时。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const FINAL_TEXT = "TOOL_LOOP_DONE_已完成";

/**
 * 两轮 mock 服务：
 *   第 1 次请求 → 返回 tool_calls（要求 ls）
 *   第 2 次及以后 → 返回最终文本
 *
 * 注：这段内联的 mock 服务是各用例里重复的，**统一抽取是后续独立的一步**，
 * 本文件迁移时原样保留，不动它。
 */
function startTwoTurnServer() {
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

			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			const base = { id: `chatcmpl-tl-${Date.now()}`, object: "chat.completion.chunk", created: 0, model: "mock-model" };
			const send = (delta, finish = null) => {
				res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
			};

			send({ role: "assistant", content: "" });

			// 判断这是第几轮：请求体里出现 role:"tool" 说明工具已执行完
			const msgs = parsed?.messages ?? [];
			const hasToolResult = msgs.some((m) => m.role === "tool");

			if (!hasToolResult && requests.length === 1) {
				send({
					tool_calls: [
						{
							index: 0,
							id: "call_tl_1",
							type: "function",
							function: { name: "ls", arguments: '{"path":"."}' },
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

	return new Promise((resolve_) => {
		server.listen(0, "127.0.0.1", () => {
			resolve_({
				baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
				requests,
				close: () => new Promise((r) => server.close(r)),
			});
		});
	});
}

const h = createHarness({ name: "toolloop" });
// harness 负责隔离与清空工作区根目录，目录本身要由用例建出来
mkdirSync(h.WORKSPACE_DIR, { recursive: true });

const mock = await startTwoTurnServer();
console.log(`✓ 两轮 mock 服务已就绪：${mock.baseUrl}`);

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
 * 慢机器不假失败、快机器不白等；超时时把**最后一次探针看到的样例**带进错误里，
 * 失败信息才能看出会话状态里到底有什么。
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

await h.check("注册 provider 并选中模型", async () => {
	const r = await win.evaluate(
		async ({ baseUrl }) => {
			const k = globalThis.kami;
			try {
				await k.saveCustomProvider(
					{
						id: "e2e-loop",
						name: "E2E Loop",
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
					"sk-e2e-dummy",
				);
				await k.setModel("e2e-loop/mock-model");
				return { ok: true };
			} catch (e) {
				return { ok: false, err: String(e?.message ?? e).slice(0, 200) };
			}
		},
		{ baseUrl: mock.baseUrl },
	);
	assert.ok(r.ok, `配置失败: ${r.err}`);
});

await h.check("发送消息触发工具调用循环", async () => {
	try {
		await win.evaluate(async () => {
			await Promise.race([
				globalThis.kami.prompt({ text: "请列出当前目录" }),
				new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT_90S")), 90_000)),
			]);
		});
	} catch (e) {
		// 前端调用本身可能异步返回；关键是服务端行为，下一步断言
		const msg = String(e?.message ?? e);
		assert.ok(!msg.includes("TIMEOUT_90S"), `发送后挂起 90 秒未返回：${msg}`);
	}
});

await h.check("mock 服务收到至少两轮请求（证明循环转起来了）", async () => {
	// 工具执行 + 二次请求需要时间：等 mock 真的收到第 2 轮，而不是固定轮询 20×1.5 秒
	await waitForRounds(2, "agent 循环未转起来 —— 若只收到 1 轮，说明工具调用没有被执行并回传");
	assert.ok(
		mock.requests.length >= 2,
		`只收到 ${mock.requests.length} 轮请求。agent 循环未转起来 —— ` +
			`若只收到 1 轮，说明工具调用没有被执行并回传`,
	);
});

await h.check("第二轮请求带回了工具执行结果", async () => {
	const second = mock.requests[1];
	assert.ok(second, "没有第二轮请求");
	const msgs = second.body?.messages ?? [];
	const toolMsgs = msgs.filter((m) => m.role === "tool");
	assert.ok(
		toolMsgs.length > 0,
		`第二轮请求里没有 role:"tool" 的消息，说明工具结果未回传。` + `消息角色：${msgs.map((m) => m.role).join(", ")}`,
	);
});

await h.check("最终回复落到会话状态", async () => {
	const r = await waitForFound(
		"会话状态里出现最终回复（工具结果回传了，但收尾没落进会话？）",
		async (mark) => {
			const s = await globalThis.kami.snapshot();
			return JSON.stringify(s).includes(mark)
				? { found: true }
				: { found: false, sample: JSON.stringify(s).slice(0, 400) };
		},
		{ arg: "TOOL_LOOP_DONE", timeout: 30_000 },
	);
	// 先截图、后断言：循环跑完这一屏先留现场
	await h.shoot("after-tool-loop");
	assert.ok(r.found, `会话状态里找不到最终回复。样例: ${r.sample}`);
});

await h.check("无渲染层未捕获异常", () => assert.equal(h.pageErrors.length, 0, h.pageErrors.join("; ")));

// 先关应用再关 mock：应用一关，daemon 与 mock 之间的长连接才会断开，
// server.close() 才不会一直等在那儿（原实现的顺序就是这样）。
await h.app().close();
await mock.close();
console.log(`（mock 共收到 ${mock.requests.length} 轮请求）`);
await h.finish();
