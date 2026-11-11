/**
 * 确定性 hooks 的 daemon 集成测试：真实 Electron + 本地 mock 模型 + 真实 daemon。
 *
 * 这条链路只有真跑起来才看得见「工具到底有没有执行」：
 *   · hook 的配置在 daemon 侧读（preferences.json），不在渲染层；
 *   · PreToolUse 必须排在权限门之前（否则拒绝会被权限门的放行顺序绕过）；
 *   · 被拦下的工具**不能有副作用**（这里用目标文件不存在来证），
 *     且模型必须收到可诊断的原因（第二轮请求里的 tool 消息）。
 *
 * 一轮里发三个工具调用，分别覆盖三件事：
 *   · write —— 被 exit 2 拒绝（deny）；
 *   · read  —— 被 exit 1 拒绝（fail-closed：非 0/2 退出同样阻止）；
 *   · ls    —— 没有命中的 hook，**正常执行**（证明门不是「一律拒绝」）。
 *
 * 等待全部用可观察信号：mock 收到第 2 轮请求、审计 JSONL 落盘。
 * 模型回合中不使用 waitForSettled()（回合内有 500ms 级计时器刷新 DOM）。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const FINAL_TEXT = "HOOKS_BLOCK_DONE";
const PROBE_FILE = "hooks-probe.txt";

/** 取消息正文；OpenAI 兼容消息可能是字符串，也可能是分段数组。 */
function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (typeof part === "string" ? part : String(part?.text ?? "")))
		.join("\n");
}

/**
 * 一轮工具调用的 mock：
 *   第 1 次请求 → 三个 tool_calls（write / read / ls）；
 *   第 2 次及以后 → 最终文本。
 * tool_call id 跨轮唯一（live 视图按 id 整卡替换，复用会静默顶掉前一张卡）。
 */
function startMockModel() {
	const requests = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			let parsed;
			try {
				parsed = JSON.parse(body);
			} catch {
				parsed = undefined;
			}
			const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
			if (req.method === "GET" && pathname.replace(/\/+$/u, "").endsWith("/models")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						object: "list",
						data: [{ id: "hooks-model", object: "model", created: 0, owned_by: "mock" }],
					}),
				);
				return;
			}

			const messages = parsed?.messages ?? [];
			const toolResults = messages.filter((message) => message.role === "tool").length;
			requests.push({ body: parsed, toolResults });

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
					id: "chatcmpl-hooks-block",
					object: "chat.completion.chunk",
					choices: [{ index: 0, delta }],
				};
				if (finish !== undefined) chunk.choices[0].finish_reason = finish;
				if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
			};
			const toolCall = (index, name, args) => ({
				index,
				id: `call_hooks_${index}`,
				type: "function",
				function: { name, arguments: JSON.stringify(args) },
			});

			send({ role: "assistant", content: "" });
			if (toolResults < 1) {
				send({
					tool_calls: [
						// 绝对路径：断言「文件没被写出来」时不依赖会话 cwd 的时间戳目录名。
						toolCall(0, "write", { path: join(h.WORKSPACE_DIR, PROBE_FILE), content: "should-not-exist" }),
						toolCall(1, "read", { path: "missing-for-hook.txt" }),
						toolCall(2, "ls", { path: "." }),
					],
				});
				send({}, "tool_calls");
			} else {
				for (const chunk of FINAL_TEXT.match(/[\s\S]{1,8}/gu) ?? []) send({ content: chunk });
				send({}, "stop");
			}
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

const h = createHarness({ name: "hooks-block" });
mkdirSync(h.WORKSPACE_DIR, { recursive: true });

/*
 * 两条 hook 在**启动前**写进偏好文件：
 *   · exit 2 → deny（拒绝，stderr 进原因）；
 *   · exit 1 → fail（非 0/2，按 fail-closed 阻止）。
 * 命令用 node 的绝对路径 + 独立脚本，不依赖 POSIX shell 方言（GUI CI 在 macOS，
 * 但这个习惯让脚本在 Windows 上读起来也成立）。
 */
const denyScript = join(h.WORKSPACE_DIR, "deny-write.mjs");
const failScript = join(h.WORKSPACE_DIR, "fail-read.mjs");
const postScript = join(h.WORKSPACE_DIR, "deny-post.mjs");
writeFileSync(
	denyScript,
	`let input = "";\nprocess.stdin.setEncoding("utf8");\nprocess.stdin.on("data", (c) => (input += c));\nprocess.stdin.on("end", () => {\n  process.stderr.write("HOOK_WRITE_DENIED\\n");\n  process.exit(2);\n});\n`,
	"utf8",
);
writeFileSync(
	failScript,
	`let input = "";\nprocess.stdin.setEncoding("utf8");\nprocess.stdin.on("data", (c) => (input += c));\nprocess.stdin.on("end", () => {\n  process.stderr.write("HOOK_READ_FAILED\\n");\n  process.exit(1);\n});\n`,
	"utf8",
);
writeFileSync(
	postScript,
	`let input = "";\nprocess.stdin.setEncoding("utf8");\nprocess.stdin.on("data", (c) => (input += c));\nprocess.stdin.on("end", () => {\n  process.stderr.write("HOOK_POST_DENIED\\n");\n  process.exit(2);\n});\n`,
	"utf8",
);
const commandOf = (script) => `"${process.execPath}" "${script}"`;
mkdirSync(h.CONFIG_DIR, { recursive: true });
writeFileSync(
	join(h.CONFIG_DIR, "preferences.json"),
	JSON.stringify(
		{
			hooks: [
				{ id: "h-deny-write", event: "PreToolUse", matcher: "write", command: commandOf(denyScript), timeoutMs: 5000 },
				{ id: "h-fail-read", event: "PreToolUse", matcher: "read", command: commandOf(failScript), timeoutMs: 5000 },
				// PostToolUse 不可阻断：它即使 exit 2 也不能改变工具结果，只留审计。
				{ id: "h-post-ls", event: "PostToolUse", matcher: "ls", command: commandOf(postScript), timeoutMs: 5000 },
				// 被 PreToolUse 拦下的调用**不该**触发 PostToolUse（工具没执行）。
				// 这条 hook 存在的意义是：它一旦留下审计，就说明上面那条语义破了。
				{ id: "h-post-write", event: "PostToolUse", matcher: "write", command: commandOf(postScript), timeoutMs: 5000 },
			],
		},
		null,
		2,
	),
	"utf8",
);

const mock = await startMockModel();
console.log(`✓ mock 模型服务已就绪：${mock.baseUrl}`);

await h.launch();
const win = h.window();

await h.check("注册 provider 并选中模型", async () => {
	const r = await win.evaluate(
		async ({ baseUrl }) => {
			const k = globalThis.kami;
			try {
				await k.saveCustomProvider(
					{
						id: "mock-hooks",
						name: "Mock Hooks",
						baseUrl,
						api: "openai-completions",
						models: [
							{
								id: "hooks-model",
								name: "hooks-model",
								reasoning: false,
								vision: false,
								contextWindow: 128000,
								maxTokens: 4096,
							},
						],
					},
					"sk-mock-hooks",
				);
				await k.setModel("mock-hooks/hooks-model");
				return { ok: true };
			} catch (e) {
				return { ok: false, err: String(e?.message ?? e).slice(0, 300) };
			}
		},
		{ baseUrl: mock.baseUrl },
	);
	assert.ok(r.ok, `配置失败：${r.err}`);
});

await h.check("发送一条会触发三个工具调用的消息", async () => {
	try {
		await win.evaluate(async () => {
			await Promise.race([
				globalThis.kami.prompt({ text: "请同时写文件、读文件、列目录" }),
				new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT_90S")), 90_000)),
			]);
		});
	} catch (e) {
		const message = String(e?.message ?? e);
		assert.ok(!message.includes("TIMEOUT_90S"), `发送后挂起 90 秒未返回：${message}`);
	}
});

await h.check("mock 收到第 2 轮请求（工具结果被回传）", async () => {
	await waitUntil(() => mock.requests.length >= 2, {
		timeout: 60_000,
		interval: 300,
		desc: "mock 收到第 2 轮请求（工具调用没有被执行并回传？）",
	});
	assert.ok(mock.requests.length >= 2, `只收到 ${mock.requests.length} 轮请求`);
});

await h.check("被 hook 拒绝的调用带回了可诊断原因，且 ls 正常执行", async () => {
	const second = mock.requests[1];
	assert.ok(second, "没有第二轮请求");
	const toolMessages = (second.body?.messages ?? []).filter((message) => message.role === "tool");
	const texts = toolMessages.map((message) => contentText(message.content));
	assert.equal(texts.length, 3, `应有 3 条工具结果（write/read/ls），实际：${JSON.stringify(texts)}`);
	assert.ok(
		texts.some((text) => text.includes("HOOK_WRITE_DENIED") && text.includes("h-deny-write")),
		`write 的拒绝原因里没有 hook 的 stderr / id：${JSON.stringify(texts)}`,
	);
	assert.ok(
		texts.some((text) => text.includes("HOOK_READ_FAILED") && /fail-closed/.test(text)),
		`read 的失败原因没有按 fail-closed 说明：${JSON.stringify(texts)}`,
	);
	const lsText = texts.find((text) => !text.includes("PreToolUse hook"));
	assert.ok(
		lsText !== undefined,
		`三条结果都被 PreToolUse 拦了 —— ls 没有命中的前置 hook 应当正常执行：${JSON.stringify(texts)}`,
	);
	// PostToolUse 命中了 ls，但它**不可阻断**：拒绝原因不能出现在工具结果里。
	assert.equal(
		lsText.includes("HOOK_POST_DENIED"),
		false,
		`PostToolUse 的拒绝写进了工具结果 —— 它不该改变结果：${JSON.stringify(lsText)}`,
	);
});

await h.check("被拒绝的写工具没有副作用（目标文件不存在）", () => {
	assert.equal(
		existsSync(join(h.WORKSPACE_DIR, PROBE_FILE)),
		false,
		`${PROBE_FILE} 被写出来了 —— PreToolUse 拒绝没有真的终止工具执行`,
	);
});

await h.check("审计里留下 hook/blocked 与 hook/failed", async () => {
	const auditDir = join(h.CONFIG_DIR, "logs", "audit");
	const readAll = () => {
		if (!existsSync(auditDir)) return [];
		return readdirSync(auditDir)
			.filter((name) => name.endsWith(".jsonl"))
			.flatMap((name) => readFileSync(join(auditDir, name), "utf8").split("\n"))
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line));
	};
	let records = [];
	await waitUntil(
		() => {
			records = readAll();
			return records.some((record) => record.category === "hook" && record.outcome === "blocked") ? records : null;
		},
		{ timeout: 20_000, interval: 300, desc: "审计 JSONL 出现 hook/blocked" },
	);
	const hookRecords = records.filter((record) => record.category === "hook");
	assert.ok(
		hookRecords.some((record) => record.outcome === "blocked" && record.detail.includes("HOOK_WRITE_DENIED")),
		`没有 hook/blocked 记录：${JSON.stringify(hookRecords)}`,
	);
	assert.ok(
		hookRecords.some((record) => record.outcome === "failed" && record.detail.includes("HOOK_READ_FAILED")),
		`没有 hook/failed 记录（exit 1 应按失败留痕）：${JSON.stringify(hookRecords)}`,
	);
	// 被 PreToolUse 拦下的 write **没有执行**，所以它的 PostToolUse 不该出现。
	// 这条断言锁的是 pi 的语义（blocked → immediate，不走 tool_result）：
	// 哪天它变了，这里会多出一条 h-post-write 的记录。
	assert.ok(
		!hookRecords.some((record) => record.detail.includes("h-post-write")),
		`被 PreToolUse 拦下的 write 触发了 PostToolUse：${JSON.stringify(hookRecords)}`,
	);
	// PostToolUse 的 exit 2 只记 failed，detail 要写明「未阻断」——
	// 记成 blocked 会让审计说「已拦截」而工具其实执行了。
	assert.ok(
		hookRecords.some(
			(record) =>
				record.outcome === "failed" &&
				record.detail.includes("PostToolUse") &&
				record.detail.includes("h-post-ls") &&
				record.detail.includes("未阻断"),
		),
		`没有 PostToolUse 的「拒绝（未阻断）」审计：${JSON.stringify(hookRecords)}`,
	);
});

await h.snap("after-hooks-block");
await h.check("无渲染层未捕获异常", () => assert.equal(h.pageErrors.length, 0, h.pageErrors.join("; ")));

await h.app().close();
await mock.close();
console.log(`（mock 共收到 ${mock.requests.length} 轮请求）`);
await h.finish();
