/**
 * 产物交付端到端测试：`present_files` → 会话事件 → 界面上的产物卡片。
 *
 * 补的是一处零覆盖：`present_files`（「把成果文件交付给用户」）此前只在一处注释里
 * 被提到过，没有任何测试真正调用它。而它是**任务收尾的最后一环** ——
 * 模型干完活把文件交给用户，用户能不能在界面上看到那张卡片，全看这条链路。
 *
 * 走的是**确定性**路径（mock 模型 + 真实 UI 发送），验三件事：
 *   ① 合法绝对路径 → 工具成功，且界面上渲染出 `.artifact-card` 与文件名；
 *   ② **相对路径必须被拒** —— 契约写明 files 只能是绝对路径或 URL，
 *      静默接受相对路径会让「产物」指向不可预期的地方；
 *   ③ 拒绝时**给出可读原因**（模型据此改），而不是含糊报错。
 *
 * 不用真实模型：这条验的是**交付链路与渲染**，不是模型能力。
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
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const PRESENTED = "交付探针报告.md";
const FINAL_TEXT = "ARTIFACT_PRESENT_DONE";

// ── mock 模型服务：按轮次返回不同的工具调用 ──────────────────
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
				const chunk = { id: "chatcmpl-artifact", object: "chat.completion.chunk", choices: [{ index: 0, delta }] };
				if (finish !== undefined) chunk.choices[0].finish_reason = finish;
				res.write(`data: ${JSON.stringify(chunk)}\n\n`);
			};
			const callTool = (name, args, id) => {
				send({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
				send({}, "tool_calls");
			};

			send({ role: "assistant", content: "" });
			const msgs = parsed?.messages ?? [];
			const toolResults = msgs.filter((m) => m.role === "tool").length;

			if (toolResults === 0) {
				// 第 1 轮：用**绝对路径**交付（合法）
				callTool("present_files", { files: [resolve(WORKSPACE_DIR, PRESENTED)], explanation: "交付探针" }, "call_pf_1");
			} else if (toolResults === 1) {
				// 第 2 轮：用**相对路径**交付（必须被拒）
				callTool("present_files", { files: [PRESENTED] }, "call_pf_2");
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

const h = createHarness({ name: "artifact" });
// 工作区路径改由 harness 决定（按用例名隔离），mock 服务体本身保持原样 ——
// 它在被调用时才读这个常量，所以声明在后面也安全。
const WORKSPACE_DIR = h.WORKSPACE_DIR;
// harness 负责隔离与清空工作区根目录，目录本身要由用例建出来
mkdirSync(WORKSPACE_DIR, { recursive: true });
// 交付的文件必须真实存在（工具会 stat 它，不存在的会被标 missing）
writeFileSync(resolve(WORKSPACE_DIR, PRESENTED), "# 交付探针\n\n这段用于验证交付链路。\n", "utf8");

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
					id: "mock-artifact",
					name: "Mock Artifact",
					baseUrl,
					api: "openai-completions",
					authHeader: true,
					models: [{ id: "artifact-model", name: "artifact-model", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }],
				},
				"mock-key",
			);
			await k.setModel("mock-artifact/artifact-model");
			await k.setWorkspace(ws);
			return { ok: true };
		} catch (e) {
			return { ok: false, err: String(e?.message ?? e).slice(0, 200) };
		}
	}, { baseUrl: mock.baseUrl, ws: WORKSPACE_DIR });
	assert.ok(r.ok, `配置失败：${r.err}`);
});

await h.check("在输入框里输入并发送（走真实 UI 路径）", async () => {
	const box = win.locator('[aria-label="消息输入框"]');
	await box.waitFor({ state: "visible", timeout: 30_000 });
	await box.fill("把报告交付给我");
	await box.press("Enter");
	// 原来是固定等 3 秒。改成等 mock 真收到请求 —— 发送有没有走通，这是直接证据
	await waitForRounds(1, "消息没有发出去");
});

await h.check("产物卡片渲染到界面上（.artifact-card + 文件名）", async () => {
	const r = await waitForFound("界面上出现 .artifact-card（交付事件没画出来？）", () => {
		const card = document.querySelector(".artifact-card");
		if (card === null) return { found: false, sample: (document.body.innerText || "").slice(-300) };
		return {
			found: true,
			name: (card.querySelector(".artifact-name")?.textContent ?? "").trim(),
			hasPreviewBtn: card.querySelector(".artifact-preview-btn") !== null,
			gridCount: document.querySelectorAll(".artifact-card").length,
		};
	});
	// 先截图、后断言：卡片在屏上时留现场；下面的断言一旦失败，图里就有那一屏。
	// 截图自带像素断言 —— DOM 里有卡片不等于卡片真的画出来了。
	await h.shoot("artifact-card");
	assert.ok(String(r.name).includes(basename(PRESENTED, ".md")), `卡片上的文件名不对：${JSON.stringify(r.name)}`);
	console.log(`      产物卡片「${r.name}」（共 ${r.gridCount} 张，含预览按钮：${r.hasPreviewBtn}）`);
});

await h.check("相对路径被拒绝，且给出可读原因", async () => {
	// 第 2 轮 mock 用相对路径交付 —— 工具契约要求绝对路径或 URL，必须被拒。
	// 断言落在**第二轮请求带回的工具结果**上（那正是模型看到的东西），
	// 而不是我们的推测。
	await waitForRounds(3, "第二轮工具没跑完");

	const third = mock.requests[2];
	const toolMsgs = (third?.body?.messages ?? []).filter((m) => m.role === "tool");
	assert.ok(toolMsgs.length >= 2, `第三轮请求里只有 ${toolMsgs.length} 条工具结果，期望 ≥2`);
	const second = JSON.stringify(toolMsgs[1]?.content ?? "");
	assert.ok(
		/绝对路径|无效/.test(second),
		`相对路径没有被拒，或原因不含可操作信息：${second.slice(0, 200)}`,
	);
	console.log(`      拒绝原因: ${second.slice(0, 120)}`);
});

await h.check("最终回复也渲染出来", async () => {
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
