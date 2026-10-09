/**
 * 子代理委派端到端测试：`task` 工具 → 起隔离子会话 → 子代理跑完 → 结果回传主代理。
 *
 * 补的是一处零覆盖：`task`（「把可独立完成的子任务委派给子代理，在隔离上下文中执行」）
 * 是应用的头牌能力之一，但此前**没有任何测试调用过它** —— 连失败分支都没验过。
 * 子代理这条链路比普通工具调用长得多：要起一个**独立会话**、带上那份 agent 人设、
 * 跑它自己的循环，再把结果并回主代理的上下文。任何一环断了，表现都是
 * 「模型说委派了，但什么也没发生」。
 *
 * 做法（确定性，用 mock 模型）——mock 按请求的**内容特征**分流，
 * 而不是靠轮次计数（子代理可能自己再调工具，计数会错）：
 *
 *   - 请求里出现 `role:"tool"` 且带子代理标记 ⇒ 主代理收尾轮 → 返回最终文本；
 *   - 请求里以**任务描述**为用户消息 ⇒ 那是子代理的第一轮 → 返回子代理标记；
 *   - 其余（第一条）⇒ 主代理首轮 → 返回 `task` 工具调用。
 *
 * 断言：子代理**真的被起了**（mock 收到带任务描述的那一轮）、它的产出**回传到了
 * 主代理**（最终上下文里找得到子代理标记）、主代理收尾正常。
 *
 * 迁移说明（共享 harness）：骨架（清隔离目录、启动并等到就绪、check 收集器、
 * 末尾报告与退出码）全部来自 `./lib/harness.mjs`。启动不再固定等 9 秒；
 * 「发送」不再固定等 3 秒，改为等 **mock 真的收到请求**；
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

const SUBAGENT = "scout"; // resources/agents/ 下的基础子代理之一
const TASK_TEXT = "请只回复这一串标记：SUBAGENT_RAN_7412";
const SUB_MARK = "SUBAGENT_RAN_7412";
const FINAL_TEXT = "TASK_DELEGATION_DONE";

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
				const chunk = { id: "chatcmpl-sub", object: "chat.completion.chunk", choices: [{ index: 0, delta }] };
				if (finish !== undefined) chunk.choices[0].finish_reason = finish;
				res.write(`data: ${JSON.stringify(chunk)}\n\n`);
			};
			const asText = (s) => {
				for (const chunk of s.match(/.{1,8}/gu) ?? []) send({ content: chunk });
				send({}, "stop");
			};

			send({ role: "assistant", content: "" });
			const msgs = parsed?.messages ?? [];
			const flat = JSON.stringify(msgs);

			if (flat.includes(SUB_MARK) && msgs.some((m) => m.role === "tool")) {
				// 主代理收到了子代理的产出 → 收尾
				asText(FINAL_TEXT);
			} else if (flat.includes(TASK_TEXT) && !msgs.some((m) => m.role === "tool")) {
				// 子代理的第一轮（它的用户消息就是那份任务描述）→ 给出标记
				asText(SUB_MARK);
			} else if (requests.length === 1) {
				// 主代理首轮 → 委派出去
				send({
					tool_calls: [
						{
							index: 0,
							id: "call_task_1",
							type: "function",
							function: { name: "task", arguments: JSON.stringify({ agent: SUBAGENT, task: TASK_TEXT }) },
						},
					],
				});
				send({}, "tool_calls");
			} else {
				// 兜底：不要让 mock 与服务端互相等住
				asText(FINAL_TEXT);
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

const h = createHarness({ name: "subagent" });
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
		throw new Error(`mock 只收到 ${mock.requests.length} 轮请求（期望 ≥${n}）—— ${why}（${error.message}）`, { cause: error });
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
		throw new Error(`${error.message}；界面尾部：${String(last?.sample ?? "(未取到)").slice(-300)}`, { cause: error });
	}
}

// 子代理执行时会请求权限；全部放行，否则用例会卡在权限确认上
await win.evaluate(() => {
	const k = globalThis.kami;
	if (typeof k.onPermissionRequest === "function") {
		k.onPermissionRequest((req) => {
			try {
				k.respondToPermission({ id: req.id, decision: "allow" });
			} catch {
				/* 忽略 */
			}
		});
	}
});

await h.check("注册指向 mock 的 provider 并切模型", async () => {
	const r = await win.evaluate(async ({ baseUrl, ws }) => {
		const k = globalThis.kami;
		try {
			await k.saveCustomProvider(
				{
					id: "mock-sub",
					name: "Mock Sub",
					baseUrl,
					api: "openai-completions",
					authHeader: true,
					models: [{ id: "sub-model", name: "sub-model", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }],
				},
				"mock-key",
			);
			await k.setModel("mock-sub/sub-model");
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
	await box.fill("请把这个小任务委派给子代理去办");
	await box.press("Enter");
	// 原来是固定等 3 秒。改成等 mock 真收到请求 —— 发送有没有走通，这是直接证据
	await waitForRounds(1, "消息没有发出去");
});

await h.check("子代理真的被起了（mock 收到带任务描述的那一轮）", async () => {
	await waitForRounds(3, "委派可能只发了工具调用、没真起子会话");
	const subReq = mock.requests.find(
		(r) => JSON.stringify(r.body?.messages ?? []).includes(TASK_TEXT) && !(r.body?.messages ?? []).some((m) => m.role === "tool"),
	);
	assert.ok(
		subReq,
		`没看到子代理自己那一轮请求 —— 委派可能只发了工具调用、没真起子会话。共收到 ${mock.requests.length} 轮：${mock.requests
			.map((r) => (r.body?.messages ?? []).length)
			.join(", ")}`,
	);
	// 子代理是**隔离会话**：它那轮的上下文里不该有主代理之前的对话
	console.log(`      子代理那一轮消息数 ${(subReq.body?.messages ?? []).length}（隔离会话）`);
});

await h.check("子代理的产出回传到主代理（最终上下文里有它的标记）", async () => {
	const r = await waitForFound(
		"主代理上下文里出现子代理的产出（结果没并回来？）",
		async (mark) => {
			const s = await globalThis.kami.snapshot();
			return JSON.stringify(s).includes(mark)
				? { found: true }
				: { found: false, sample: JSON.stringify(s).slice(-300) };
		},
		{ arg: SUB_MARK, timeout: 40_000 },
	);
	assert.ok(r.found, `主代理上下文里找不到子代理的产出 ${SUB_MARK} —— 结果没并回来`);
});

await h.check("主代理收尾正常（最终回复渲染到界面上）", async () => {
	const r = await waitForFound(
		"界面上出现最终回复",
		(mark) => {
			const text = document.body.innerText || "";
			return text.includes(mark) ? { found: true } : { found: false, sample: text.slice(-200) };
		},
		{ arg: FINAL_TEXT, timeout: 25_000 },
	);
	// 先截图、后断言：主代理收尾这一屏先留现场
	await h.shoot("final-reply");
	assert.ok(r.found, `界面上找不到最终回复 ${FINAL_TEXT}`);
});

await h.check("无渲染层未捕获异常", () => assert.equal(h.pageErrors.length, 0, h.pageErrors.join("; ")));

// 先关应用再关 mock：应用一关，daemon 与 mock 之间的长连接才会断开，
// server.close() 才不会一直等在那儿（原实现的顺序就是这样）。
await h.app().close();
await mock.close();
console.log(`（mock 共收到 ${mock.requests.length} 轮请求）`);
await h.finish();
