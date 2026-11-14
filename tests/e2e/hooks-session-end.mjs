/**
 * `SessionEnd`（pi 的 `session_shutdown`）的 daemon 集成测试：真实 Electron +
 * 本地 mock 模型 + 真实子进程。
 *
 * 这一层要证明的是三件单测证明不了的事：
 *   · 删除会话 / 重启会话 / 应用退出时，事件**真的**各触发一次，`reason` 正确；
 *   · 关闭路径的 **2 秒预算** 真的生效 —— 配一条 30s、实际拖 10s 的 hook，
 *     删除会话仍在预算内返回，且后面的 hook **根本没被启动**；
 *   · 应用退出**不会被 hook 拖住**，同时收尾脚本确实跑起来了（日志里有行）。
 *
 * 两条 hook 的分工：
 *   · `h-end-slow` —— 先写日志再卡 10 秒。它证明「脚本跑到了」以及预算把它掐断；
 *   · `h-end-fast` —— 只写日志。它必须**永远不出现**：预算耗尽后不再 spawn，
 *     这条断言就是「不 spawn」的可见面（只数耗时会被慢机器掩盖）。
 *
 * 等待全部用可观察信号（文件出现、mock 收到请求、运行态结束），不用固定 sleep。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const FINAL_TEXT = "SESSION_END_DONE";

const h = createHarness({ name: "hooks-session-end" });
mkdirSync(h.WORKSPACE_DIR, { recursive: true });
mkdirSync(h.CONFIG_DIR, { recursive: true });

const SLOW_LOG = join(h.WORKSPACE_DIR, "session-end-slow.log");
const FAST_LOG = join(h.WORKSPACE_DIR, "session-end-fast.log");

/**
 * 收尾脚本：先把 stdin 原文追加进日志，再按 `holdMs` 留在事件循环里。
 *
 * `appendFileSync` 是同步的：即使预算在 2s 时把进程组杀掉，已经写下的行不会丢 ——
 * 这正是「脚本确实跑过」的证据。`holdMs` 让单条的执行时间远超预算，
 * 于是「预算被裁剪了吗」变成可观测的（耗时与 fast hook 是否启动）。
 */
function sessionEndScript(logPath, holdMs) {
	return [
		'import { appendFileSync } from "node:fs";',
		'let input = "";',
		'process.stdin.setEncoding("utf8");',
		'process.stdin.on("data", (chunk) => (input += chunk));',
		'process.stdin.on("end", () => {',
		`  try { appendFileSync(${JSON.stringify(logPath)}, input.trim() + "\\n", "utf8"); } catch {}`,
		...(holdMs > 0 ? [`  setTimeout(() => process.exit(0), ${holdMs});`] : ["  process.exit(0);"]),
		"});",
		"",
	].join("\n");
}

const scriptOf = (name, logPath, holdMs) => {
	const path = join(h.WORKSPACE_DIR, name);
	writeFileSync(path, sessionEndScript(logPath, holdMs), "utf8");
	return `"${process.execPath}" "${path}"`;
};

/*
 * 用户级 SessionEnd 配置。两条都配 30s / 5s（远高于 2s 预算）：
 *   · slow 实际拖 10 秒 —— 不裁剪预算时会直接把删除拖到 10s 以上；
 *   · fast 只写一行 —— 预算耗尽后它**不应该被启动**。
 */
writeFileSync(
	join(h.CONFIG_DIR, "preferences.json"),
	JSON.stringify(
		{
			hooks: [
				{
					id: "h-end-slow",
					event: "SessionEnd",
					command: scriptOf("hook-end-slow.mjs", SLOW_LOG, 10_000),
					timeoutMs: 30_000,
				},
				{
					id: "h-end-fast",
					event: "SessionEnd",
					command: scriptOf("hook-end-fast.mjs", FAST_LOG, 0),
					timeoutMs: 5_000,
				},
			],
		},
		null,
		2,
	),
	"utf8",
);

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
						data: [{ id: "session-end-model", object: "model", created: 0, owned_by: "mock" }],
					}),
				);
				return;
			}
			requests.push({ body });
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
					id: "chatcmpl-hooks-session-end",
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

/** 读日志里的 JSON 行（每行是一条 hook 收到的 stdin 原文）。 */
function payloadsIn(file) {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return { unparsable: line };
			}
		});
}

const mock = await startMockModel();
console.log(`✓ mock 模型服务已就绪：${mock.baseUrl}`);

await h.launch();
const win = h.window();

const listRealSessions = () =>
	win.evaluate(async () => {
		const list = await globalThis.kami.listSessions();
		const arr = Array.isArray(list) ? list : (list?.sessions ?? []);
		return arr.filter((s) => s?.isTempTask !== true && typeof s?.path === "string");
	});

/** 当前会话（列表里带 current 标记的那条）。 */
async function currentSession() {
	const arr = await listRealSessions();
	return arr.find((s) => s.current === true) ?? arr[0];
}

/** 发一条消息并等到「这一轮结束 + 会话文件已落盘」，返回那条会话的摘要。 */
async function promptAndLand(text) {
	await win.evaluate(
		async ({ text }) => {
			await Promise.race([
				globalThis.kami.prompt({ text }),
				new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT_90S")), 90_000)),
			]);
		},
		{ text },
	);
	return await waitUntil(
		async () => {
			const current = await currentSession();
			if (current === undefined || current.running !== false) return null;
			const stat = await win.evaluate(
				async (path) => await globalThis.kami.statPath(path).catch(() => undefined),
				current.path,
			);
			// 用就绪才交出对象、否则 null 的写法：对象字面量恒真会让超时形同虚设。
			return stat?.kind === "file" ? current : null;
		},
		{ timeout: 60_000, interval: 500, desc: "会话文件落盘且这一轮已结束" },
	);
}

await h.check("注册 provider 并选中模型", async () => {
	const r = await win.evaluate(
		async ({ baseUrl }) => {
			const k = globalThis.kami;
			try {
				await k.saveCustomProvider(
					{
						id: "mock-session-end",
						name: "Mock SessionEnd",
						baseUrl,
						api: "openai-completions",
						models: [
							{
								id: "session-end-model",
								name: "session-end-model",
								reasoning: false,
								vision: false,
								contextWindow: 128000,
								maxTokens: 4096,
							},
						],
					},
					"sk-mock-session-end",
				);
				await k.setModel("mock-session-end/session-end-model");
				return { ok: true };
			} catch (e) {
				return { ok: false, err: String(e?.message ?? e).slice(0, 300) };
			}
		},
		{ baseUrl: mock.baseUrl },
	);
	assert.ok(r.ok, `配置失败：${r.err}`);
});

/** 两个会话：A 用来删除，B 用来重启与应用退出。 */
let sessionA;
let sessionB;

await h.check("准备两个有真实宿主的会话（A 用来删除，B 用来重启 / 退出）", async () => {
	await win.evaluate(async (cwd) => await globalThis.kami.newTask(cwd), h.WORKSPACE_DIR);
	sessionA = await promptAndLand("这是会话 A：稍后会被删除");
	assert.ok(sessionA?.path, "会话 A 没有落盘路径");
	await win.evaluate(async (cwd) => await globalThis.kami.newTask(cwd), h.WORKSPACE_DIR);
	sessionB = await promptAndLand("这是会话 B：稍后会被重启");
	assert.ok(sessionB?.path, "会话 B 没有落盘路径");
	assert.notEqual(sessionA.path, sessionB.path, "两个会话落在了同一个文件上");
	// 此时还没有任何会话结束过。
	assert.equal(payloadsIn(SLOW_LOG).length, 0, `准备阶段不该触发 SessionEnd：${JSON.stringify(payloadsIn(SLOW_LOG))}`);
});

await h.check("删除会话：SessionEnd 触发一次（reason quit），且在 2s 预算内返回", async () => {
	const startedAt = Date.now();
	await win.evaluate(async (path) => await globalThis.kami.deleteSession(path), sessionA.path);
	const elapsed = Date.now() - startedAt;

	await waitUntil(
		() => (payloadsIn(SLOW_LOG).length > 0 ? true : null),
		{ timeout: 15_000, interval: 200, desc: "SessionEnd hook 写下了日志（session_shutdown 没有发出？）" },
	);
	const records = payloadsIn(SLOW_LOG);
	const ended = records.filter((record) => record.event === "SessionEnd");
	assert.ok(ended.length >= 1, `删除会话没有触发 SessionEnd：${JSON.stringify(records)}`);
	assert.equal(ended[0].reason, "quit", `删除会话的 reason 应为 quit：${JSON.stringify(ended[0])}`);
	assert.ok(ended[0].session?.cwd, `SessionEnd 载荷没有 cwd：${JSON.stringify(ended[0])}`);

	/*
	 * 预算的核心断言。slow hook 实际要拖 10 秒、配置写的是 30 秒：
	 *   · 没裁剪预算 → 删除至少 10 秒（远超这里的上限）；
	 *   · 裁剪生效   → 2 秒左右返回。
	 * 下限 1.5s 是为了证明「确实等了一段预算」，而不是压根没跑 hook。
	 */
	assert.ok(elapsed >= 1500, `删除在 ${elapsed}ms 内就返回了 —— 收尾脚本可能没跑`);
	assert.ok(elapsed < 6000, `删除被 hook 拖了 ${elapsed}ms（2s 预算是硬上限）`);

	/*
	 * 预算耗尽后不再启动后面的 hook：fast hook 的日志文件**不该存在**。
	 * 只断言耗时会被慢机器掩盖，这一条才是「没有 spawn」的直接证据。
	 */
	assert.equal(
		existsSync(FAST_LOG),
		false,
		`预算耗尽后仍启动了第二条 hook（${FAST_LOG} 存在）—— 超出预算的条目应直接记失败`,
	);
});

await h.check("重启会话：旧宿主发 SessionEnd，reason 是 resume", async () => {
	const before = payloadsIn(SLOW_LOG).filter((record) => record.event === "SessionEnd").length;
	const res = await win.evaluate(
		async (path) => await globalThis.kami.restartSessionFrom(path, 0, {}),
		sessionB.path,
	);
	assert.equal(res?.ok, true, `重启失败：${res?.message ?? JSON.stringify(res)?.slice(0, 200)}`);

	await waitUntil(
		() => (payloadsIn(SLOW_LOG).filter((record) => record.event === "SessionEnd").length > before ? true : null),
		{ timeout: 15_000, interval: 200, desc: "重启触发了 SessionEnd" },
	);
	const records = payloadsIn(SLOW_LOG).filter((record) => record.event === "SessionEnd");
	const resumed = records.filter((record) => record.reason === "resume");
	assert.equal(resumed.length, 1, `重启应产生一条 reason=resume 的 SessionEnd：${JSON.stringify(records)}`);
});

await h.check("应用退出：先跑 SessionEnd（reason quit），且进程在预算内退出", async () => {
	const before = payloadsIn(SLOW_LOG).filter((record) => record.event === "SessionEnd").length;
	await h.snap("before-quit");

	const exited = new Promise((resolve) => {
		h.app()
			.process()
			.once("exit", (code, signal) => resolve({ code, signal, at: Date.now() }));
	});
	const startedAt = Date.now();
	/*
	 * app.quit 会走 main 的 before-quit（先请 daemon 收尾）。**不要 await evaluate**：
	 * 进程在调用返回前就可能退出，那个 promise 可能永远不 settle；退出本身由
	 * `process().once("exit")` 观察。
	 */
	void h
		.app()
		.evaluate(({ app }) => {
			app.quit();
		})
		.catch(() => {});

	const result = await Promise.race([
		exited,
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error("15 秒内应用没有退出（退出被 hook 卡住了？）")), 15_000),
		),
	]);
	const elapsed = result.at - startedAt;

	// 退出前 daemon 收到过 daemon:shutdown，slow hook 至少启动了一次（日志是它写的）。
	await waitUntil(
		() => (payloadsIn(SLOW_LOG).filter((record) => record.event === "SessionEnd").length > before ? true : null),
		{ timeout: 5_000, interval: 100, desc: "退出路径触发了 SessionEnd" },
	);
	const records = payloadsIn(SLOW_LOG).filter((record) => record.event === "SessionEnd");
	const quitRecords = records.slice(before);
	assert.ok(
		quitRecords.some((record) => record.reason === "quit"),
		`退出时的 SessionEnd reason 应为 quit：${JSON.stringify(quitRecords)}`,
	);
	assert.ok(
		elapsed < 6000,
		`应用退出用了 ${elapsed}ms —— hook 把退出拖住了（2s 预算 + 2.5s 兜底应远低于这个数）`,
	);
});

await mock.close();
await h.finish();
