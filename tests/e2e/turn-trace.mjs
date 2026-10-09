/**
 * 工作轨迹条（TurnTraceBar）端到端测试（不需要真实模型 —— mock 服务按轮次返回）。
 *
 * 验的是「聚合对了、渲染层也真的接上了」这条全链路：trace-core 的纯逻辑有单测，
 * 但**轨迹条是否真的画到回合里**、点击定位是否真的展开折叠并滚到目标行、
 * 折叠过程后它是否还在 —— 只有真实启动才能暴露（widget-render.mjs 同教训：
 * 工具返回对了、渲染层没接上，单测与 IPC 断言全都照过）。
 *
 * mock 脚本（轮次由「请求里出现过几个 role:"tool"」决定，不数请求数 ——
 * 数请求数会把「工具结果没回传」误判成下一轮）：
 *   第 1 轮：read 预置文件 + write 新文件（都成功 → 读 / 写 两段）；
 *   第 2 轮：read 不存在的文件 ×2（error → 合并成 bad 段 ×2，验证「失败不被成功稀释」）；
 *   第 3 轮：最终文本。
 * 期望轨迹：读 · 写 · 读(bad)×2 —— 三段、两根连接符、bad 段带 ⚠。
 * 注意 tool_call 的 id 必须跨轮唯一（live 视图按 id 整卡替换，复用会顶掉前一张卡）。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const FINAL_TEXT = "TRACE_E2E_DONE";

function startMockModel() {
	const requests = [];
	// id 必须跨请求唯一：live 视图按 toolCallId 整卡替换，复用 id 会让后一轮
	// 顶掉前一轮的卡（第一版 mock 就这样把第一个 read 顶没了）。
	let callSeq = 0;
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
				const chunk = { id: "chatcmpl-trace", object: "chat.completion.chunk", choices: [{ index: 0, delta }] };
				if (finish !== undefined) chunk.choices[0].finish_reason = finish;
				res.write(`data: ${JSON.stringify(chunk)}\n\n`);
			};
			const toolCall = (i, name, args) => ({
				index: i,
				id: `call_${name}_${(callSeq += 1)}`,
				type: "function",
				function: { name, arguments: JSON.stringify(args) }
			});

			send({ role: "assistant", content: "" });
			const toolResults = (parsed?.messages ?? []).filter((m) => m.role === "tool").length;

			if (toolResults === 0) {
				// 多个工具调用按真实 OpenAI 流的形态分 delta 发（每个 tool_call 一个 chunk，
				// index 递增）—— 一次 delta 塞两个 tool_call 不是真实供应商的形态。
				send({ tool_calls: [toolCall(0, "read", { path: "note.txt" })] });
				send({ tool_calls: [toolCall(1, "write", { path: "out-trace.txt", content: "trace e2e" })] });
				send({}, "tool_calls");
			} else if (toolResults <= 2) {
				// 第二轮：read 不存在的文件 ×2 → 两条 error 合并成一个 bad 段（×2）。
				// 平台无关，不依赖沙箱在 macOS 上的拒绝行为。
				send({ tool_calls: [toolCall(0, "read", { path: "missing-file.txt" })] });
				send({ tool_calls: [toolCall(1, "read", { path: "missing-file.txt" })] });
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
			ok({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests, close: () => new Promise((r) => server.close(r)) })
		);
	});
}

const h = createHarness({ name: "turn-trace" });
mkdirSync(h.WORKSPACE_DIR, { recursive: true });
writeFileSync(`${h.WORKSPACE_DIR}/note.txt`, "轨迹 e2e 的预置文件\n", "utf8");

const mock = await startMockModel();
console.log(`✓ mock 模型服务已就绪：${mock.baseUrl}`);

await h.launch();
const win = h.window();

async function waitForRounds(n, why) {
	try {
		await waitUntil(() => mock.requests.length >= n, { timeout: 40_000, interval: 500, desc: `mock 收到第 ${n} 轮请求` });
	} catch (error) {
		throw new Error(`mock 只收到 ${mock.requests.length} 轮请求（期望 ≥${n}）—— ${why}（${error.message}）`, { cause: error });
	}
}

async function waitForFound(desc, probe, { arg, timeout = 30_000 } = {}) {
	let last = null;
	try {
		return await waitUntil(
			async () => {
				last = await win.evaluate(probe, arg);
				return last?.found ? last : null;
			},
			{ timeout, interval: 250, desc }
		);
	} catch (error) {
		throw new Error(`${error.message}；界面尾部：${String(last?.sample ?? "(未取到)").slice(-300)}`, { cause: error });
	}
}

/** 页面内 50ms 粒度轮询：900ms 的 flash 类用 500ms 外层轮询可能整段错过。 */
function waitForPage(condSrc, timeoutMs = 5_000) {
	return win.evaluate(
		({ src, timeoutMs: t }) =>
			new Promise((resolve) => {
				const fn = new Function(`return (${src})`)();
				const started = Date.now();
				const timer = setInterval(() => {
					let value;
					try {
						value = fn();
					} catch {
						value = false;
					}
					if (value) {
						clearInterval(timer);
						resolve({ ok: true });
					} else if (Date.now() - started > t) {
						clearInterval(timer);
						resolve({ ok: false });
					}
				}, 50);
			}),
		{ src: condSrc, timeoutMs }
	);
}

await h.check("注册指向 mock 的 provider 并切模型", async () => {
	const r = await win.evaluate(async ({ baseUrl, ws }) => {
		const k = globalThis.kami;
		try {
			await k.saveCustomProvider(
				{
					id: "mock-trace",
					name: "Mock Trace",
					baseUrl,
					api: "openai-completions",
					authHeader: true,
					models: [{ id: "trace-model", name: "trace-model", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }]
				},
				"mock-key"
			);
			await k.setModel("mock-trace/trace-model");
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
	await box.fill("读一下 note.txt 再写个文件");
	await box.press("Enter");
	await waitForRounds(1, "消息没有发出去");
});

await h.check("轨迹条随回合出现：读 / 写 两段 ok + 末段 读(bad)×2", async () => {
	// 等最终文本出现 = 回合已收尾，轨迹进入终态（bad 段此时必然已定）。
	const done = await waitForFound(
		"最终回复出现",
		(mark) => {
			const text = document.body.innerText || "";
			return text.includes(mark) ? { found: true } : { found: false, sample: text.slice(-200) };
		},
		{ arg: FINAL_TEXT }
	);
	assert.ok(done.found, "最终回复没出现，回合没跑完");

	const r = await waitForFound(
		"轨迹条渲染出三段",
		() => {
			const bar = document.querySelector(".turn-trace");
			if (bar === null) return { found: false, sample: (document.body.innerText || "").slice(-200) };
			const segs = [...bar.querySelectorAll(".trace-seg")];
			return {
				found: segs.length >= 3,
				labels: segs.map((s) => (s.querySelector(".trace-seg-label")?.textContent ?? "").trim() + (s.classList.contains("bad") ? "(bad)" : "")),
				counts: segs.map((s) => (s.querySelector(".trace-seg-count")?.textContent ?? "").trim()),
				connCount: bar.querySelectorAll(".trace-conn").length,
				sample: bar.textContent
			};
		}
	);
	// live 视图里写卡在生成期（tool_stream_started）就插入，与读的相对顺序随事件时序
	// 摆动（工具行本身也是这个顺序，轨迹与正文一致即为正确）；这里锁定的不变量是：
	// 恰好三段、前两段是 {读, 写} 各一次、末段是 bad 且计数 ×2（两条失败合并）。
	assert.equal(r.labels.length, 3, `轨迹段数不对：${JSON.stringify(r.labels)}（整条：${r.sample}）`);
	assert.deepEqual([...r.labels.slice(0, 2)].sort(), ["写", "读"], `前两段应是 读/写：${JSON.stringify(r.labels)}`);
	assert.equal(r.labels[2], "读(bad)", `末段应是 bad 读：${JSON.stringify(r.labels)}`);
	assert.equal(r.counts[2], "×2", `两条失败 read 应合并计数 ×2：${JSON.stringify(r.counts)}`);
	assert.equal(r.counts[0], "", `单独一次的段不该有 ×N：${JSON.stringify(r.counts)}`);
	assert.equal(r.connCount, 2, "三段之间应有 2 根连接符");
});

await h.check("bad 段有 ⚠ 形态（不看颜色也读得出）", async () => {
	const r = await win.evaluate(() => {
		const seg = document.querySelector(".trace-seg.bad");
		if (seg === null) return { found: false };
		return { found: true, hasAlert: seg.querySelector(".trace-seg-alert") !== null, aria: seg.getAttribute("aria-label"), title: seg.getAttribute("title") };
	});
	assert.ok(r.found, "没有 .trace-seg.bad —— 失败读文件那步没进轨迹或没标 bad");
	assert.ok(r.hasAlert, "bad 段没有 ⚠ 图标");
	assert.ok(r.aria?.includes("失败"), `bad 段 aria 没说清失败：${r.aria}`);
	assert.ok((r.title ?? "").includes("读"), `bad 段 tooltip 缺类别：${r.title}`);
});

await h.check("点击 bad 段：展开折叠、滚动定位、目标行闪一下", async () => {
	await win.click(".trace-seg.bad");
	const flashed = await waitForPage(`() => document.querySelector(".entry.tool.entry-flash") !== null`, 5_000);
	assert.ok(flashed.ok, "点击轨迹段后没有出现 .entry-flash —— 定位逻辑没接上");
	const r = await win.evaluate(() => {
		const el = document.querySelector(".entry.tool.entry-flash") ?? [...document.querySelectorAll(".entry.tool")].at(-1);
		if (el === undefined || el === null) return { found: false };
		const rect = el.getBoundingClientRect();
		return {
			found: true,
			visible: rect.top >= 0 && rect.bottom <= window.innerHeight,
			hasDataId: el.hasAttribute("data-entry-id")
		};
	});
	assert.ok(r.found, "目标工具行不存在");
	assert.ok(r.hasDataId, "工具行没有 data-entry-id 锚点");
	// 目标行不在视口时 scrollIntoView 必须把它带进来；本来就在视口（内容一屏放得下）
	// 则不需要滚 —— 两种情形都算定位成功，flash 是共同证据。
	assert.ok(r.visible, "目标行不在视口内 —— scrollIntoView 没生效");
});

await h.snap("after-click");

await h.check("折叠整轮过程后：轨迹条还在，工具行全隐藏", async () => {
	const clicked = await win.evaluate(() => {
		const header = document.querySelector(".turn-header.clickable");
		if (header === null) return { ok: false, err: "回合头不可折叠（没有 .turn-header.clickable）" };
		header.click();
		return { ok: true };
	});
	assert.ok(clicked.ok, clicked.err);
	const r = await waitForPage(
		`() => document.querySelector(".turn-trace") !== null && document.querySelector(".turn-trace").offsetParent !== null && document.querySelectorAll(".entry.tool").length === 0`,
		5_000
	);
	assert.ok(r.ok, "折叠后：轨迹条应可见且工具行应全部隐藏");
	// 展开回去，让后续截图里两种状态都有代表性。
	await win.evaluate(() => document.querySelector(".turn-header.clickable")?.click());
});

await h.check("浅色 / 深色截图（像素断言：非纯色）", async () => {
	await h.shoot("trace-light");
	await win.evaluate(() => {
		void window.kami?.setThemePreference?.("dark");
		document.documentElement.setAttribute("data-theme", "dark");
	});
	await waitUntil(async () => (await win.evaluate(() => document.documentElement.getAttribute("data-theme"))) === "dark", {
		timeout: 10_000,
		desc: "data-theme 切到 dark"
	});
	await h.shoot("trace-dark");
	await win.evaluate(() => {
		void window.kami?.setThemePreference?.("light");
		document.documentElement.setAttribute("data-theme", "light");
	});
});

await h.check("无渲染层未捕获异常", () => assert.equal(h.pageErrors.length, 0, h.pageErrors.join("; ")));

await h.app().close();
await mock.close();
await h.finish();
