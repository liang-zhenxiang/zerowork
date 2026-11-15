/**
 * hooks 上下文注入（#385）的端到端测试：真实 Electron + 本地 mock 模型 + 真实 daemon。
 *
 * 这一层要证明的是单测证明不了的三件事：
 *   · 注入**真的进了模型请求**（mock 记录请求体），失败 hook 的输出**没有**进去；
 *   · 注入在时间线上是**看得见**的一张卡（`.hook-context-card`，默认折叠、可展开）；
 *   · **重新打开会话后仍在** —— 走的是 `session-view.js` 的历史投影，
 *     而不是 live 事件拼出来的内存条目。
 *
 * 三条 hook 的分工：
 *   · `h-start-ctx`   —— SessionStart，exit 0，输出 SESSION_CTX_OK（暂存到第一条用户消息）；
 *   · `h-prompt-ctx`  —— UserPromptSubmit，exit 0，输出 PROMPT_CTX_OK；
 *   · `h-prompt-fail` —— UserPromptSubmit，exit 1，输出 FAIL_CTX_SHOULD_NOT_APPEAR
 *                        （失败输出的「不可信」必须是可观测的：它一个字符都不能进上下文）。
 *
 * 等待全部用可观察信号：mock 收到请求、审计 JSONL 出现记录、目标 DOM 节点出现。
 * 回合进行中不使用 waitForSettled()（渲染层有 500ms 级计时器刷新 DOM）。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const FINAL_TEXT = "HOOKS_INJECT_DONE";
const PROMPT_TEXT = "请把会话上下文带进来";
const START_MARK = "SESSION_CTX_OK";
const PROMPT_MARK = "PROMPT_CTX_OK";
const FAIL_MARK = "FAIL_CTX_SHOULD_NOT_APPEAR";

/** 取消息正文；OpenAI 兼容消息可能是字符串，也可能是分段数组。 */
function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (typeof part === "string" ? part : String(part?.text ?? "")))
		.join("\n");
}

/** 单轮对话的 mock：收到提示就流式吐回最终文本（与 hooks-lifecycle 同一形状）。 */
function startMockModel() {
	const requests = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
			if (req.method === "GET" && pathname.replace(/\/+$/u, "").endsWith("/models")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						object: "list",
						data: [{ id: "hooks-inject-model", object: "model", created: 0, owned_by: "mock" }],
					}),
				);
				return;
			}
			let parsed;
			try {
				parsed = JSON.parse(body);
			} catch {
				parsed = undefined;
			}
			requests.push({ body: parsed });
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			res.on("error", () => {
				/* 客户端断开是预期路径之一 */
			});
			const send = (delta, finish) => {
				const chunk = {
					id: "chatcmpl-hooks-inject",
					object: "chat.completion.chunk",
					choices: [{ index: 0, delta }],
				};
				if (finish !== undefined) chunk.choices[0].finish_reason = finish;
				if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
			};
			send({ role: "assistant", content: "" });
			for (const piece of FINAL_TEXT.match(/[\s\S]{1,8}/gu) ?? []) send({ content: piece });
			send({}, "stop");
			if (!res.writableEnded && !res.destroyed) {
				res.write("data: [DONE]\n\n");
				res.end();
			}
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve({
				baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
				requests,
				close: () => new Promise((done) => server.close(done)),
			});
		});
	});
}

const h = createHarness({ name: "hooks-inject" });
mkdirSync(h.WORKSPACE_DIR, { recursive: true });
mkdirSync(h.CONFIG_DIR, { recursive: true });

/**
 * 一条只吐一段固定文本的 hook 脚本：读完 stdin 再写 stdout，最后按给定退出码退出。
 * 命令用 node 的绝对路径 + 独立脚本，不依赖 POSIX shell 方言。
 */
function contextScript(mark, exitCode) {
	const path = join(h.WORKSPACE_DIR, `hook-context-${exitCode}-${mark.length}.mjs`);
	writeFileSync(
		path,
		[
			'let input = "";',
			'process.stdin.setEncoding("utf8");',
			'process.stdin.on("data", (chunk) => (input += chunk));',
			'process.stdin.on("end", () => {',
			`  process.stdout.write(${JSON.stringify(mark)} + "\\n");`,
			`  process.exit(${exitCode});`,
			"});",
			"",
		].join("\n"),
		"utf8",
	);
	return `"${process.execPath}" "${path}"`;
}

writeFileSync(
	join(h.CONFIG_DIR, "preferences.json"),
	JSON.stringify(
		{
			hooks: [
				{ id: "h-start-ctx", event: "SessionStart", command: contextScript(START_MARK, 0), timeoutMs: 5000 },
				{ id: "h-prompt-ctx", event: "UserPromptSubmit", command: contextScript(PROMPT_MARK, 0), timeoutMs: 5000 },
				// 失败输出**不得注入**：exit 1 → fail-closed，但这里只要求「不进上下文」。
				{ id: "h-prompt-fail", event: "UserPromptSubmit", command: contextScript(FAIL_MARK, 1), timeoutMs: 5000 },
			],
		},
		null,
		2,
	),
	"utf8",
);

function readAuditRecords() {
	const dir = join(h.CONFIG_DIR, "logs", "audit");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".jsonl"))
		.flatMap((name) => readFileSync(join(dir, name), "utf8").split("\n"))
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line));
}

const mock = await startMockModel();
console.log(`✓ mock 模型服务已就绪：${mock.baseUrl}`);

await h.launch();
let win = h.window();

const listRealSessions = () =>
	win.evaluate(async () => {
		const list = await globalThis.kami.listSessions();
		const arr = Array.isArray(list) ? list : (list?.sessions ?? []);
		return arr.filter((s) => s?.isTempTask !== true && typeof s?.path === "string");
	});

async function currentSession() {
	const arr = await listRealSessions();
	return arr.find((s) => s.current === true) ?? arr[0];
}

/** 在页面里按 data-path 找侧栏会话行并点击（真正的「重开」UI 路径）。 */
const clickSessionRow = (path) =>
	win.evaluate((target) => {
		const row = [...document.querySelectorAll(".task-item")].find((el) => el.dataset.path === target);
		if (row === undefined) return false;
		const body = row.querySelector(".task-item-body");
		if (body === null) return false;
		body.click();
		return true;
	}, path);

await h.check("注册 provider、选定工作空间并选中模型", async () => {
	const r = await win.evaluate(
		async ({ baseUrl, ws }) => {
			const k = globalThis.kami;
			try {
				await k.saveCustomProvider(
					{
						id: "mock-hooks-inject",
						name: "Mock Hooks Inject",
						baseUrl,
						api: "openai-completions",
						models: [
							{
								id: "hooks-inject-model",
								name: "hooks-inject-model",
								reasoning: false,
								vision: false,
								contextWindow: 128000,
								maxTokens: 4096,
							},
						],
					},
					"sk-mock-hooks-inject",
				);
				await k.setModel("mock-hooks-inject/hooks-inject-model");
				// 选定真实工作空间：默认的临时任务目录会让会话落在 isTempTask 里，
				// 而 listSessions 的「真实会话」过滤会把它排除，拿不到稳定 path。
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

let sessionPath;

await h.check("从首页输入框发一条消息，进入会话视图（真实 UI 路径）", async () => {
	/*
	 * 必须走输入框而不是 `kami.prompt`：后者只在 daemon 侧跑，
	 * 渲染层仍停在首页 —— 那样「时间线上有没有卡片」根本无从观察。
	 */
	const box = win.locator('[aria-label="消息输入框"]');
	await box.waitFor({ state: "visible", timeout: 30_000 });
	await box.fill(PROMPT_TEXT);
	await box.press("Enter");

	await waitUntil(() => (mock.requests.length >= 1 ? mock.requests.length : null), {
		timeout: 60_000,
		interval: 300,
		desc: "mock 收到模型请求（消息没有被 hook 失败拦下？）",
	});
	await waitUntil(
		() => win.evaluate(() => document.querySelector('[aria-label="返回首页"]') !== null),
		{ timeout: 30_000, interval: 300, desc: "发送后进入会话视图" },
	);
	await waitUntil(
		async () =>
			(await win.evaluate((text) => document.body.innerText.includes(text), FINAL_TEXT)) ? true : null,
		{ timeout: 30_000, interval: 300, desc: `界面上出现 ${FINAL_TEXT}（这一轮没有正常收尾？）` },
	);

	// 会话文件落盘 + 这一轮结束，才有稳定的 path 供后面的「重开」使用。
	// 用测试进程直接 stat：kami.statPath 以当前会话 cwd 为边界，会话文件不在 cwd 下。
	sessionPath = await waitUntil(
		async () => {
			const session = await currentSession();
			if (session === undefined || session.running !== false || typeof session.path !== "string") return null;
			// 就绪才交出字符串，否则 null —— 返回对象字面量恒真会让超时形同虚设。
			return existsSync(session.path) ? session.path : null;
		},
		{ timeout: 60_000, interval: 500, desc: "会话文件落盘且这一轮已结束" },
	);
});

await h.check("模型请求体里有两段注入，且失败 hook 的输出不在其中", async () => {
	const request = mock.requests.find((item) => {
		const messages = item.body?.messages ?? [];
		return messages.some((message) => contentText(message.content).includes(PROMPT_TEXT));
	});
	assert.ok(request, "mock 没有收到带用户提示的那次请求");

	const messages = request.body?.messages ?? [];
	const texts = messages.map((message) => contentText(message.content));
	const promptIndex = texts.findIndex((text) => text.includes(PROMPT_TEXT));
	const injectedIndex = texts.findIndex(
		(text) => text.includes(START_MARK) && text.includes(PROMPT_MARK),
	);

	assert.ok(
		injectedIndex >= 0,
		`请求体里找不到两段注入内容。消息形状：${JSON.stringify(
			messages.map((message) => ({ role: message.role, preview: contentText(message.content).slice(0, 120) })),
		)}`,
	);
	/*
	 * pi 的 convertToLlm 把 `role:"custom"` 转成 `role:"user"` 交给 OpenAI 兼容端点
	 * （pi-coding-agent/dist/core/messages.js）。断言实际形状，而不是文件里的形状。
	 */
	assert.equal(
		messages[injectedIndex]?.role,
		"user",
		`注入消息在请求体里的角色应为 user（pi 的 convertToLlm 转换）：${JSON.stringify(messages[injectedIndex])}`,
	);
	assert.ok(
		injectedIndex > promptIndex,
		`注入必须排在本轮用户消息**之后**：promptIndex=${promptIndex}，injectedIndex=${injectedIndex}`,
	);
	assert.ok(
		texts[injectedIndex].includes("[hook h-start-ctx]") && texts[injectedIndex].includes("[hook h-prompt-ctx]"),
		`注入正文缺少来源标签：${texts[injectedIndex]}`,
	);
	assert.ok(
		texts.every((text) => !text.includes(FAIL_MARK)),
		`失败 hook（exit 1）的输出进了上下文 —— 不可信输出必须被丢弃：${JSON.stringify(texts)}`,
	);
});

await h.check("时间线上出现注入卡片：默认折叠、可展开、显示来源", async () => {
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".hook-context-card") !== null),
		{ timeout: 20_000, interval: 200, desc: "时间线出现 .hook-context-card" },
	);
	const state = await win.evaluate(() => {
		const card = document.querySelector(".hook-context-card");
		return {
			open: card.open === true,
			head: card.querySelector(".hook-context-head")?.textContent ?? "",
			body: card.querySelector(".hook-context-body")?.textContent ?? "",
			note: card.querySelector(".hook-context-note")?.textContent ?? "",
		};
	});
	assert.equal(state.open, false, `注入卡片应默认折叠：${JSON.stringify(state)}`);
	assert.ok(state.head.includes("hooks 注入的上下文"), `卡片标题不对：${state.head}`);
	// 来源胶囊用中文事件名（HOOK_EVENT_LABELS），并带 hook id。
	assert.ok(
		state.head.includes("会话开始") && state.head.includes("h-start-ctx"),
		`卡片头缺少 SessionStart 来源：${state.head}`,
	);
	assert.ok(
		state.head.includes("发送消息前") && state.head.includes("h-prompt-ctx"),
		`卡片头缺少 UserPromptSubmit 来源：${state.head}`,
	);
	assert.ok(state.body.includes(START_MARK) && state.body.includes(PROMPT_MARK), `正文缺注入文本：${state.body}`);
	assert.ok(!state.body.includes(FAIL_MARK), `正文出现了失败 hook 的输出：${state.body}`);
	assert.ok(state.note.includes("由本地 hook 生成，不改写用户消息"), `说明行不对：${state.note}`);

	// 折叠是真实的：点开 summary 后 open 变 true，正文仍在（原生 details 的内容始终在 DOM 里，
	// 所以「折叠」的判据只能是 open 状态，不能用正文是否存在）。
	await win.evaluate(() => document.querySelector(".hook-context-card summary")?.click());
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".hook-context-card")?.open === true),
		{ timeout: 5_000, interval: 100, desc: "点开注入卡片的折叠区" },
	);
});

await h.check("截图：浅色与暗色下的注入卡片", async () => {
	await h.shoot("timeline-light");
	await win.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
	await h.shoot("timeline-dark");
	await win.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
});

await h.check("审计记下注入口径，且不记注入正文", async () => {
	let records = [];
	await waitUntil(
		() => {
			records = readAuditRecords().filter((record) => record.category === "hook");
			return records.some((record) => record.detail.includes("h-prompt-fail")) ? records : null;
		},
		{ timeout: 20_000, interval: 300, desc: "审计出现 h-prompt-fail 的记录" },
	);
	const detailOf = (id) => records.filter((record) => record.detail.includes(`hook ${id}`)).map((r) => r.detail);

	const startDetails = detailOf("h-start-ctx");
	assert.ok(
		startDetails.some((detail) => /^SessionStart 放行/.test(detail) && /暂存 \d+ 字节/.test(detail)),
		`SessionStart 的注入措辞应为「暂存 N 字节」：${JSON.stringify(startDetails)}`,
	);
	const promptDetails = detailOf("h-prompt-ctx");
	assert.ok(
		promptDetails.some((detail) => /^UserPromptSubmit 放行/.test(detail) && /注入 \d+ 字节/.test(detail)),
		`UserPromptSubmit 的注入措辞应为「注入 N 字节」：${JSON.stringify(promptDetails)}`,
	);
	const failDetails = records.filter(
		(record) => record.category === "hook" && record.detail.includes("hook h-prompt-fail"),
	);
	assert.ok(
		failDetails.some((record) => record.outcome === "failed" && record.detail.includes("失败（未阻断）")),
		`exit 1 应记 failed（未阻断）：${JSON.stringify(failDetails)}`,
	);
	// 审计只写字节数：正文绝不能落进长期保留的日志。
	assert.ok(
		records.every((record) => !record.detail.includes(START_MARK) && !record.detail.includes(PROMPT_MARK)),
		`审计里出现了注入正文：${JSON.stringify(records.map((record) => record.detail))}`,
	);
});

await h.check("关闭并重启应用，注入卡片仍在（走历史投影）", async () => {
	assert.ok(typeof sessionPath === "string" && sessionPath !== "", "上一步没有拿到会话路径，本步无从验证");
	await h.app().close();
	await h.launch(); // 同一 CONFIG_DIR / WORKSPACE_DIR：会话文件与 hooks 配置都还在
	win = h.window();

	// 侧栏会话列表要等 daemon 起来才回包：等到目标行出现再点。
	await waitUntil(
		() =>
			win.evaluate(
				(path) => [...document.querySelectorAll(".task-item")].some((el) => el.dataset.path === path),
				sessionPath,
			),
		{ timeout: 30_000, interval: 300, desc: "重启后侧栏出现目标会话行" },
	);
	assert.ok(await clickSessionRow(sessionPath), "点击会话行失败（行不在或被遮挡）");

	await waitUntil(
		() => win.evaluate(() => document.querySelector(".hook-context-card") !== null),
		{
			timeout: 30_000,
			interval: 300,
			desc: "重开会话后出现 .hook-context-card（session-view 的历史投影没生效？）",
		},
	);
	const state = await win.evaluate(() => {
		const card = document.querySelector(".hook-context-card");
		return {
			head: card.querySelector(".hook-context-head")?.textContent ?? "",
			body: card.querySelector(".hook-context-body")?.textContent ?? "",
			userText: document.body.innerText.includes("请把会话上下文带进来"),
		};
	});
	assert.ok(state.userText, "重开后连用户消息都不在 —— 会话没真的打开");
	assert.ok(state.head.includes("h-start-ctx") && state.head.includes("h-prompt-ctx"), `重开后来源胶囊丢了：${state.head}`);
	assert.ok(state.body.includes(START_MARK) && state.body.includes(PROMPT_MARK), `重开后注入正文丢了：${state.body}`);
	assert.ok(!state.body.includes(FAIL_MARK), `重开后的卡片出现了失败 hook 的输出：${state.body}`);
	await h.shoot("reopened-history-projection");
});

await h.check("无渲染层未捕获异常", () => assert.equal(h.pageErrors.length, 0, h.pageErrors.join("; ")));

await h.app().close();
await mock.close();
console.log(`（mock 共收到 ${mock.requests.length} 轮请求）`);
await h.finish();
