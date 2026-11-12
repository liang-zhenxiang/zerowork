/**
 * 生命周期 hooks 的 daemon 集成测试：真实 Electron + 本地 mock 模型 + 真实子进程。
 *
 * 工具事件（hooks-block.mjs）能证明「拦得住」，却证明不了这三件事：
 *   · `SessionStart` / `UserPromptSubmit` / `Stop` 是否**真的**在对应时机各跑一次；
 *   · 其中一条 exit 1 时消息是否仍然正常完成（非阻断的**行为**，不是文案）；
 *   · pi 的载荷是否带上了各自的事实（reason / prompt / aborted）。
 *
 * 三条 hook 各向自己的日志文件追加一行 **stdin 原文**（JSON），于是「跑没跑、
 * 收到什么、什么顺序」三件事都能从磁盘上读回来 —— 不看审计文案猜行为。
 *
 * 等待全部用可观察信号（文件出现、mock 收到请求、审计落盘），不用固定 sleep；
 * 回合中不使用 waitForSettled()（回合内有 500ms 级计时器刷新 DOM）。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const FINAL_TEXT = "LIFECYCLE_DONE";
const PROMPT_TEXT = "请把这条消息的生命周期记录下来";

const h = createHarness({ name: "hooks-lifecycle" });
mkdirSync(h.WORKSPACE_DIR, { recursive: true });
mkdirSync(h.CONFIG_DIR, { recursive: true });

const START_LOG = join(h.WORKSPACE_DIR, "session-start.log");
const SUBMIT_LOG = join(h.WORKSPACE_DIR, "user-prompt-submit.log");
const STOP_LOG = join(h.WORKSPACE_DIR, "stop.log");
const WORKSPACE_MARKER = join(h.WORKSPACE_DIR, "workspace-hook-ran.log");

/**
 * 生成一条 hook 脚本：把 stdin 原文追加进日志，然后按指定退出码退出。
 *
 * 用 node 的绝对路径而不是 shell 方言（GUI CI 在 macOS，但这个习惯让脚本
 * 在 Windows 上读起来也成立）。`appendFileSync` 是同步的，`process.exit`
 * 不会丢行。
 */
function lifecycleScript(logPath, exitCode) {
	return [
		'import { appendFileSync } from "node:fs";',
		'let input = "";',
		'process.stdin.setEncoding("utf8");',
		'process.stdin.on("data", (chunk) => (input += chunk));',
		'process.stdin.on("end", () => {',
		`  try { appendFileSync(${JSON.stringify(logPath)}, input.trim() + "\\n", "utf8"); } catch {}`,
		`  process.exit(${exitCode});`,
		"});",
		"",
	].join("\n");
}

const scriptOf = (name, logPath, exitCode) => {
	const path = join(h.WORKSPACE_DIR, name);
	writeFileSync(path, lifecycleScript(logPath, exitCode), "utf8");
	return `"${process.execPath}" "${path}"`;
};

/*
 * 用户级三条 hook：
 *   · SessionStart     —— exit 0，写日志；
 *   · UserPromptSubmit —— **exit 1**（这条是故意的：非阻断的失败必须不影响消息）；
 *   · Stop             —— exit 0，写日志。
 * 超时给 10s：node 冷启动在慢 CI 上可能超过缺省的 5s，那会制造一条假失败。
 */
writeFileSync(
	join(h.CONFIG_DIR, "preferences.json"),
	JSON.stringify(
		{
			hooks: [
				{ id: "h-start", event: "SessionStart", command: scriptOf("hook-start.mjs", START_LOG, 0), timeoutMs: 10_000 },
				{
					id: "h-submit",
					event: "UserPromptSubmit",
					command: scriptOf("hook-submit.mjs", SUBMIT_LOG, 1),
					timeoutMs: 10_000,
				},
				{ id: "h-stop", event: "Stop", command: scriptOf("hook-stop.mjs", STOP_LOG, 0), timeoutMs: 10_000 },
			],
		},
		null,
		2,
	),
	"utf8",
);

/*
 * 工作区级 hooks：**从未被信任**（preferences 里没有 trustedWorkspaceHooks）。
 * 它必须一条都不执行 —— 这是 hooks MVP 的默认安全姿态，生命周期事件不能
 * 因为「不可阻断」就顺手放宽。审计里的 skipped 记录证明这份文件确实被看见了
 * （否则「没执行」也可能只是根本没读到，那样这条断言就是空的）。
 */
mkdirSync(join(h.WORKSPACE_DIR, ".zerowork"), { recursive: true });
writeFileSync(
	join(h.WORKSPACE_DIR, ".zerowork", "hooks.json"),
	JSON.stringify(
		{
			version: 1,
			hooks: [
				{
					id: "ws-start",
					event: "SessionStart",
					command: `"${process.execPath}" "${join(h.WORKSPACE_DIR, "ws-hook.mjs")}"`,
					timeoutMs: 10_000,
				},
			],
		},
		null,
		2,
	),
	"utf8",
);
writeFileSync(
	join(h.WORKSPACE_DIR, "ws-hook.mjs"),
	lifecycleScript(WORKSPACE_MARKER, 0),
	"utf8",
);

/** 单轮对话的 mock：收到提示就流式吐回最终文本。 */
function startMockModel({ onRequest }) {
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
						data: [{ id: "lifecycle-model", object: "model", created: 0, owned_by: "mock" }],
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
			onRequest?.();

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
					id: "chatcmpl-hooks-lifecycle",
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

/** 模型请求到达时 Stop 是否已经跑过 —— 这是「Stop 在回合结束之后」的硬证据。 */
const stopSeenAtModelRequest = [];
const mock = await startMockModel({ onRequest: () => stopSeenAtModelRequest.push(existsSync(STOP_LOG)) });
console.log(`✓ mock 模型服务已就绪：${mock.baseUrl}`);

/** 读一个日志文件里的 payload 行（每行是一条 hook 收到的 stdin 原文）。 */
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

function readAuditRecords() {
	const dir = join(h.CONFIG_DIR, "logs", "audit");
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".jsonl"))
		.flatMap((name) => readFileSync(join(dir, name), "utf8").split("\n"))
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line));
}

await h.launch();
const win = h.window();

await h.check("注册 provider 并选中模型", async () => {
	const r = await win.evaluate(
		async ({ baseUrl }) => {
			const k = globalThis.kami;
			try {
				await k.saveCustomProvider(
					{
						id: "mock-lifecycle",
						name: "Mock Lifecycle",
						baseUrl,
						api: "openai-completions",
						models: [
							{
								id: "lifecycle-model",
								name: "lifecycle-model",
								reasoning: false,
								vision: false,
								contextWindow: 128000,
								maxTokens: 4096,
							},
						],
					},
					"sk-mock-lifecycle",
				);
				await k.setModel("mock-lifecycle/lifecycle-model");
				return { ok: true };
			} catch (e) {
				return { ok: false, err: String(e?.message ?? e).slice(0, 300) };
			}
		},
		{ baseUrl: mock.baseUrl },
	);
	assert.ok(r.ok, `配置失败：${r.err}`);
});

await h.check("发送一条消息（UserPromptSubmit hook 会 exit 1）", async () => {
	try {
		await win.evaluate(
			async ({ text }) => {
				await Promise.race([
					globalThis.kami.prompt({ text }),
					new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT_90S")), 90_000)),
				]);
			},
			{ text: PROMPT_TEXT },
		);
	} catch (e) {
		const message = String(e?.message ?? e);
		assert.ok(!message.includes("TIMEOUT_90S"), `发送后挂起 90 秒未返回：${message}`);
	}
});

await h.check("消息正常完成（非阻断：UserPromptSubmit 的 exit 1 没有拦住这一轮）", async () => {
	await waitUntil(
		() => (mock.requests.length >= 1 ? mock.requests.length : null),
		{ timeout: 60_000, interval: 300, desc: "mock 收到模型请求（消息没有被 hook 失败拦下？）" },
	);
	await waitUntil(
		async () =>
			(await win.evaluate((text) => document.body.innerText.includes(text), FINAL_TEXT))
				? true
				: null,
		{ timeout: 30_000, interval: 300, desc: `界面上出现 ${FINAL_TEXT}（这一轮没有正常收尾？）` },
	);
	// Stop 在**回合结束**之后：模型请求到达那一刻它必须还没跑过。
	assert.ok(
		stopSeenAtModelRequest.length > 0 && stopSeenAtModelRequest.every((seen) => seen === false),
		`模型请求到达时 Stop hook 已经跑过：${JSON.stringify(stopSeenAtModelRequest)}`,
	);
});

await h.check("三个事件各跑一次，载荷带上了各自的事实", async () => {
	await waitUntil(
		() => (payloadsIn(STOP_LOG).length > 0 ? true : null),
		{ timeout: 30_000, interval: 300, desc: "Stop hook 写下了日志（agent_settled 没有触发？）" },
	);
	const start = payloadsIn(START_LOG);
	const submit = payloadsIn(SUBMIT_LOG);
	const stop = payloadsIn(STOP_LOG);
	assert.equal(start.length, 1, `SessionStart 应跑一次，实际：${JSON.stringify(start)}`);
	assert.equal(submit.length, 1, `UserPromptSubmit 应跑一次，实际：${JSON.stringify(submit)}`);
	assert.equal(stop.length, 1, `Stop 应跑一次，实际：${JSON.stringify(stop)}`);

	assert.equal(start[0].event, "SessionStart");
	assert.ok(
		["startup", "reload", "new", "resume", "fork"].includes(start[0].reason),
		`SessionStart 的 reason 不在 pi 的取值集合里：${JSON.stringify(start[0].reason)}`,
	);
	assert.ok(start[0].session?.cwd, `SessionStart 载荷没有 cwd：${JSON.stringify(start[0])}`);
	/*
	 * 会话 id 不能是空串。`SessionStart` 发生在会话被 adopt 之前 —— 装配点把
	 * 「现读 bucket.sessionId」当来源，那一刻它还是 `""`。空 id 让 hook 无法把
	 * 「这次会话」与后续 `UserPromptSubmit` / `Stop` 的行关联起来，而这正是
	 * 「写一条本地日志」最常见的用法。
	 */
	assert.ok(
		typeof start[0].session?.id === "string" && start[0].session.id !== "",
		`SessionStart 载荷的 session.id 为空：${JSON.stringify(start[0])}`,
	);

	assert.equal(submit[0].event, "UserPromptSubmit");
	assert.ok(
		typeof submit[0].prompt === "string" && submit[0].prompt.includes("生命周期"),
		`UserPromptSubmit 的 prompt 不是用户提交的全文：${JSON.stringify(submit[0].prompt)}`,
	);
	assert.equal("tool" in submit[0], false, "生命周期载荷不该有 tool 字段");

	assert.equal(stop[0].event, "Stop");
	assert.equal(stop[0].aborted, false, `Stop 的 aborted 应为 false：${JSON.stringify(stop[0])}`);
});

await h.check("审计里 SessionStart / Stop 是 allowed，UserPromptSubmit 是 failed（未阻断）", async () => {
	let records = [];
	await waitUntil(
		() => {
			records = readAuditRecords().filter((record) => record.category === "hook");
			return records.some((record) => record.detail.includes("h-stop")) ? true : null;
		},
		{ timeout: 20_000, interval: 300, desc: "审计 JSONL 出现 Stop hook 的记录" },
	);
	const byHook = (id) => records.filter((record) => record.detail.includes(`hook ${id}`));
	assert.ok(
		byHook("h-start").some((record) => record.outcome === "allowed" && record.detail.startsWith("SessionStart")),
		`SessionStart 没有 allowed 审计：${JSON.stringify(records)}`,
	);
	assert.ok(
		byHook("h-stop").some((record) => record.outcome === "allowed" && record.detail.startsWith("Stop")),
		`Stop 没有 allowed 审计：${JSON.stringify(records)}`,
	);
	const submit = byHook("h-submit");
	assert.ok(submit.some((record) => record.outcome === "failed"), `exit 1 应记 failed：${JSON.stringify(submit)}`);
	assert.ok(
		submit.every((record) => record.detail.includes("未阻断")),
		`非阻断事件的失败文案必须写「未阻断」：${JSON.stringify(submit)}`,
	);
});

await h.check("未信任工作区的 hooks 不执行，但审计里留下了跳过记录", async () => {
	assert.equal(
		existsSync(WORKSPACE_MARKER),
		false,
		`未信任工作区的 hook 被执行了（${WORKSPACE_MARKER} 存在）—— 默认安全姿态被放宽`,
	);
	const skipped = readAuditRecords().filter(
		(record) => record.category === "hook" && record.outcome === "skipped",
	);
	assert.ok(
		skipped.some((record) => record.detail.includes(h.WORKSPACE_DIR)),
		`没有「工作区 hooks 未信任，已跳过」审计 —— 这份文件可能根本没被读到：${JSON.stringify(skipped)}`,
	);
});

await h.check("hooks:get 带上最近运行（设置页「最近运行」的数据源）", async () => {
	const data = await win.evaluate(() => globalThis.kami.getHooks());
	assert.ok(Array.isArray(data.recentRuns), `hooks:get 没有返回 recentRuns 数组：${JSON.stringify(data)}`);
	assert.ok(
		data.recentRuns.length > 0 && data.recentRuns.length <= 5,
		`recentRuns 应为 1–5 条，实际 ${data.recentRuns.length} 条`,
	);
	for (const run of data.recentRuns) {
		assert.equal(typeof run.ts, "number", `recentRuns 条目缺 ts：${JSON.stringify(run)}`);
		assert.equal(typeof run.detail, "string", `recentRuns 条目缺 detail：${JSON.stringify(run)}`);
		assert.ok(
			["allowed", "blocked", "failed", "skipped"].includes(run.outcome),
			`recentRuns 里出现了未知结论：${JSON.stringify(run.outcome)}`,
		);
	}
	// 最后两条必然是本轮刚跑过的 UserPromptSubmit 与 Stop（最近 5 条窗口足够）。
	const details = data.recentRuns.map((run) => run.detail).join("\n");
	assert.ok(details.includes("h-submit"), `最近运行里没有 UserPromptSubmit 的记录：${details}`);
	assert.ok(details.includes("h-stop"), `最近运行里没有 Stop 的记录：${details}`);
});

await h.snap("after-hooks-lifecycle");
await h.check("无渲染层未捕获异常", () => assert.equal(h.pageErrors.length, 0, h.pageErrors.join("; ")));

await h.app().close();
await mock.close();
console.log(`（mock 共收到 ${mock.requests.length} 轮请求）`);
await h.finish();
