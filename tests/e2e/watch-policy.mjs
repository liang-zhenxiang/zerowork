/**
 * 值守规矩端到端测试：mock 模型 + 真实 Electron。
 *
 * 这条链路需要的是「一条带 boundary 的运行记录」，不是真实模型能力：
 * 越界证人来自真实的 `tool_call` 钩子，`timedOut` / `readOnlyEnforced` /
 * `scoped` 来自任务规矩与 executor，`changedFiles` 来自运行会话。mock 只需
 * 按剧本发起一次会被拦下的真实工具调用。
 *
 * 断言覆盖：
 *   ① 测试源码不读取本机凭据配置，且在指向不存在路径的 HOME 下照常运行；
 *   ② 只读任务里的写入被拒，运行记录留下越界证人，磁盘上没有副作用；
 *   ③ 界面报告的徽标是「被叫停」而不是「失败」，结论句与证人行都渲染出来；
 *   ④ 范围限定下范围外被拒、范围内放行；
 *   ⑤ 探针任务清理干净，渲染层没有未捕获异常；
 *   ⑥ 报告与规矩编辑区各留浅色现场图，报告另留暗色对照。
 *
 * mock 按请求里 `role:"tool"` 的条数决定轮次，而不是按请求数：工具结果没回传
 * 时，下一轮会被误判成已经开始。`tool_calls.id` 跨轮唯一，否则 live 视图会按 id
 * 整卡替换，前一张卡被静默顶掉。
 *
 * 所有等待都用可观察信号：mock 收到的请求、运行记录落盘、DOM 的
 * `aria-expanded` 与报告文本。模型回合中不使用 `waitForSettled()`。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const READONLY_TASK = "zw-watch-readonly-probe";
const SCOPE_TASK = "zw-watch-scope-probe";
const READONLY_MARKER = "WATCH_MOCK_READONLY";
const SCOPE_MARKER = "WATCH_MOCK_SCOPE";
const FINAL_TEXT = "WATCH_MOCK_DONE";

/*
 * 子进程的家目录指向一个**不存在**的临时路径。配置文件目录仍由 harness 的
 * ZEROWORK_CONFIG_DIR 隔离；这两件事一起证明运行不依赖本机家目录里的模型凭据。
 */
const MISSING_HOME = join(tmpdir(), `zerowork-watch-missing-home-${process.pid}-${Date.now()}`);
const h = createHarness({ name: "watch-policy", env: { HOME: MISSING_HOME } });
const fakeHomeWasMissingBeforeLaunch = !existsSync(MISSING_HOME);

/** 取消息正文；OpenAI 兼容消息可能是字符串，也可能是分段数组。 */
function contentText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((part) => (typeof part === "string" ? part : String(part?.text ?? ""))).join("\n");
}

function scenarioOf(messages) {
	const text = messages.map((message) => contentText(message?.content)).join("\n");
	if (text.includes(SCOPE_MARKER)) return "scope";
	if (text.includes(READONLY_MARKER)) return "readonly";
	return "unknown";
}

/** 最小 OpenAI 兼容服务：按已回传的工具结果数决定下一轮剧本。 */
function startMockModel() {
	const requests = [];
	const probeRequests = [];
	let callSeq = 0;

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
				probeRequests.push({ url: req.url, method: req.method });
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						object: "list",
						data: [{ id: "watch-model", object: "model", created: 0, owned_by: "mock" }],
					}),
				);
				return;
			}

			const messages = parsed?.messages ?? [];
			const scenario = scenarioOf(messages);
			const toolResults = messages.filter((message) => message.role === "tool").length;
			requests.push({ url: req.url, body: parsed, scenario, toolResults });

			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});
			res.on("error", () => {
				/* 运行被越界即停时客户端会断开，这是预期路径。 */
			});

			const send = (delta, finish) => {
				const chunk = {
					id: "chatcmpl-watch-policy",
					object: "chat.completion.chunk",
					choices: [{ index: 0, delta }],
				};
				if (finish !== undefined) chunk.choices[0].finish_reason = finish;
				if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
			};
			const toolCall = (index, name, args) => ({
				index,
				id: `call_watch_${(callSeq += 1)}`,
				type: "function",
				function: { name, arguments: JSON.stringify(args) },
			});

			send({ role: "assistant", content: "" });
			if (scenario === "readonly" && toolResults < 1) {
				send({
					tool_calls: [toolCall(0, "write", { path: "watch-probe.txt", content: "hello" })],
				});
				send({}, "tool_calls");
			} else if (scenario === "scope" && toolResults < 2) {
				send({
					tool_calls: [
						toolCall(0, "write", { path: "reports/inside.txt", content: "ok" }),
						toolCall(1, "write", { path: "outside.txt", content: "bad" }),
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
			const address = server.address();
			resolve({
				baseUrl: `http://127.0.0.1:${address.port}/v1`,
				requests,
				probeRequests,
				close: () => new Promise((done) => server.close(done)),
			});
		});
	});
}

const mock = await startMockModel();
console.log(`✓ mock 模型服务已就绪：${mock.baseUrl}`);

/*
 * 可证伪的静态断言：源码里不能出现本机凭据文件名。名称用数组拼接，
 * 避免检查语句本身把被禁字符串写回脚本。
 */
await h.check("测试源码不读取本机凭据配置", () => {
	const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
	const forbiddenName = ["settings", "json"].join(".");
	assert.equal(
		source.includes(forbiddenName),
		false,
		`watch-policy 源码不应再出现本机凭据文件名 ${forbiddenName}`,
	);
	assert.equal(
		source.includes(["ANTHROPIC", "BASE", "URL"].join("_")),
		false,
		"watch-policy 源码不应再读取本机模型端点配置",
	);
});

await h.launch();
const win = h.window();

await h.check("真实 Electron 在不存在 HOME 的隔离环境里运行", async () => {
	assert.equal(
		fakeHomeWasMissingBeforeLaunch,
		true,
		`假 HOME 在启动前意外存在，运行环境不成立：${MISSING_HOME}`,
	);
	/*
	 * 不用 app.getPath("home")：macOS 上它走系统账户家目录，即使子进程 HOME
	 * 已经指向哨兵也仍返回真实用户目录。这里要证明的是 Electron 子进程实际收到的
	 * 环境变量，因此直接读主进程的 process.env.HOME。
	 */
	const home = await h.app().evaluate(() => process.env.HOME);
	assert.equal(home, MISSING_HOME, `Electron 子进程的 HOME 不是隔离哨兵：${JSON.stringify(home)}`);
	console.log(`      HOME=${MISSING_HOME}（启动前存在=${fakeHomeWasMissingBeforeLaunch ? "否" : "是"}）`);
});

await h.snap("home");

// 权限自动批准：任务执行时若遇到审批会一直挂着。
// 值守规矩是额外的合取项，在审批之前就拦，不会被这里的自动批准绕过。
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

await h.check("配置 mock 模型并切换工作区", async () => {
	const r = await win.evaluate(
		async ({ baseUrl, ws }) => {
			const k = globalThis.kami;
			try {
				await k.saveCustomProvider(
					{
						id: "mock-watch",
						name: "Mock Watch",
						baseUrl,
						api: "openai-completions",
						authHeader: true,
						models: [
							{
								id: "watch-model",
								name: "watch-model",
								reasoning: false,
								vision: false,
								contextWindow: 128000,
								maxTokens: 8192,
							},
						],
					},
					"mock-key",
				);
				await k.setModel("mock-watch/watch-model");
				await k.setWorkspace(ws);
				return { ok: true };
			} catch (e) {
				return { ok: false, err: String(e?.message ?? e).slice(0, 200) };
			}
		},
		{ baseUrl: mock.baseUrl, ws: h.WORKSPACE_DIR },
	);
	assert.ok(r.ok, `配置失败：${r.err}`);
});

/** 读探针任务的最近一次运行（含 boundary）。 */
const readProbe = ({ id, name }) =>
	win.evaluate(
		async ({ taskId, taskName }) => {
			const k = globalThis.kami;
			const asArray = (value) => (Array.isArray(value) ? value : (value?.tasks ?? []));
			const task = asArray(await k.listAutomations()).find((item) => item.id === taskId || item.name === taskName);
			const runs = task?.runs ?? [];
			const run = [...runs].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
			return {
				stillListed: task !== undefined,
				taskWatch: task?.watch ?? null,
				runCount: runs.length,
				success: run?.success,
				error: run?.error,
				boundary: run?.boundary ?? null,
			};
		},
		{ taskId: id, taskName: name },
	);

/** 建一个探针任务（先清同名残留），入队即返回。 */
const createProbe = ({ name, prompt, watch }) =>
	win.evaluate(
		async ({ ws, name: taskName, prompt: text, watch: rules }) => {
			const k = globalThis.kami;
			const asArray = (value) => (Array.isArray(value) ? value : (value?.tasks ?? []));
			for (const task of asArray(await k.listAutomations())) {
				if (task.name === taskName) await k.deleteAutomation(task.id).catch(() => {});
			}
			const task = await k.saveAutomation({
				name: taskName,
				prompt: text,
				cwd: ws,
				schedule: { type: "interval", everyMinutes: 60 },
				watch: rules,
			});
			await k.runAutomationNow(task.id);
			return task.id;
		},
		{ ws: h.WORKSPACE_DIR, name, prompt, watch },
	);

/**
 * 等 mock 收到对应剧本，再等运行记录落盘。
 *
 * 两个信号缺一不可：只有 mock 请求说明提示词发出去了，只有运行记录说明
 * executor 真的收尾并写入了 boundary。
 */
async function waitForRun({ id, name, scenario, timeout = 180_000 }) {
	let last;
	try {
		await waitUntil(
			() => mock.requests.length > 0 && mock.requests.some((request) => request.scenario === scenario),
			{
				timeout: 60_000,
				interval: 250,
				desc: `mock 收到 ${scenario} 剧本（请求数 ${mock.requests.length}）`,
			},
		);
		await waitUntil(
			async () => {
				last = await readProbe({ id, name });
				return last.runCount > 0 ? last : null;
			},
			{
				timeout,
				interval: 500,
				desc: `任务 ${name} 的运行记录落盘（调度器入队即返回，跑完才 appendRun）`,
			},
		);
	} catch (error) {
		throw new Error(
			`等待 ${name} 完成失败：${error.message}；` +
				`当前 mock 请求=${JSON.stringify(mock.requests.map((request) => ({
					scenario: request.scenario,
					toolResults: request.toolResults,
				})))}；` +
				`最后一次任务快照=${JSON.stringify(last ?? null)}`,
			{ cause: error },
		);
	}
	return last;
}

let readonlyTaskId;
let readonlyRun;

// ── ① 只读：写入必须被拒，并留下越界证人 ──────────────────────
await h.check("值守规矩：只读任务里的写入被拒，且运行记录留下越界证人", async () => {
	const requestsBefore = mock.requests.length;
	/*
	 * toast 只活 2.2 秒 —— **不能靠轮询抓它**（等运行记录落盘时它早就消失了）。
	 * 在触发任务**之前**装一个 MutationObserver，凡是插进来的 toast 都记进
	 * `window.__watchToasts`。这与 export-markdown.mjs 里那条是同一手法、同一个理由。
	 */
	await watchToasts();
	readonlyTaskId = await createProbe({
		name: READONLY_TASK,
		prompt:
			`${READONLY_MARKER}\n` +
			"请立刻用 write 工具在当前工作目录下创建文件 watch-probe.txt，内容写 hello。" +
			"写完就回复「完成」。如果被拒绝，请直接回复「被拒绝」两个字，不要重试。",
		watch: { minutes: 15, tier: "read-only", scope: [], stopOnExceed: true },
	});

	readonlyRun = await waitForRun({
		id: readonlyTaskId,
		name: READONLY_TASK,
		scenario: "readonly",
	});

	const firstRequest = mock.requests
		.slice(requestsBefore)
		.find((request) => request.scenario === "readonly");
	assert.ok(firstRequest !== undefined, "mock 没有收到只读剧本的首轮请求");
	assert.equal(firstRequest.toolResults, 0, `只读首轮应在没有工具结果时发起 write，实际 ${firstRequest.toolResults}`);

	assert.equal(readonlyRun.taskWatch?.tier, "read-only", "任务里存的 tier 不是 read-only");

	const boundary = readonlyRun.boundary;
	assert.ok(
		boundary !== null && typeof boundary === "object",
		"运行记录里没有 boundary —— 这次运行没有留下任何边界记录，规矩等于没生效",
	);
	assert.equal(boundary.readOnlyEnforced, true, `boundary 没有标记只读约束已生效：${JSON.stringify(boundary)}`);
	assert.equal(boundary.timedOut, false, `只读探针不应超时：${JSON.stringify(boundary)}`);

	const exceeded = boundary.exceeded ?? [];
	assert.ok(
		exceeded.length > 0,
		`只读任务里模型尝试写入，却没有一条越界记录（boundary=${JSON.stringify(boundary)}）—— 规矩没有拦下这次写入`,
	);

	const first = exceeded[0];
	assert.ok(
		typeof first.tool === "string" && first.tool !== "",
		`越界条目缺工具名：${JSON.stringify(first)}`,
	);
	assert.ok(
		typeof first.detail === "string" && first.detail.includes("只读"),
		`越界理由没带上规矩原文（用户看不到「为什么被拒」）：${JSON.stringify(first.detail)}`,
	);
	assert.equal(readonlyRun.success, false, `只读探针越界即停后不应报告成功：${JSON.stringify(readonlyRun)}`);

	// 拦住的是效果，不只是留了条记录。直接查隔离工作区，不走不存在的 renderer 读文件通道。
	const wrote = existsSync(join(h.WORKSPACE_DIR, "watch-probe.txt"));
	assert.equal(wrote, false, "越界记录有了，但文件真的被写出来了 —— 规矩没有拦住写入");

	console.log(`      越界证人: tool=${first.tool} detail=${String(first.detail).slice(0, 60)}…`);
});

// ── ② 界面：报告要能一眼读出「被叫停」而非笼统失败 ──────────────
await h.check("值守规矩：界面上运行报告的徽标是「被叫停」而不是「失败」", async () => {
	assert.ok(readonlyRun !== undefined, "只读运行没有完成，界面报告无从验证");

	await openAutomations();
	/*
	 * 分两次 evaluate，不要挤在一次里点两个开关：
	 * React 把同一个事件里的两次 setState 批处理掉，报告体要等下一帧才提交。
	 * 同一次 evaluate 里点完运行记录再点报告并立刻读 `.run-report-line`，
	 * 读到的是上一帧 —— 那会把「我读早了」误报成「界面没有报告」。
	 */
	await waitUntil(
		() =>
			win.evaluate((name) => {
				const row = [...document.querySelectorAll(".auto-row")].find(
					(el) => (el.querySelector(".auto-row-name")?.textContent ?? "").trim() === name,
				);
				if (row === undefined) return false;
				const expand = row.querySelector(".auto-row-expand");
				if (expand !== null && expand.getAttribute("aria-expanded") !== "true") expand.click();
				return expand !== null && expand.getAttribute("aria-expanded") === "true";
			}, READONLY_TASK),
		{ timeout: 30_000, interval: 250, desc: `展开 ${READONLY_TASK} 的运行记录` },
	);

	// 第二跳必须在新一次 evaluate 中完成（原因见上）。
	await waitUntil(
		() =>
			win.evaluate((name) => {
				const row = [...document.querySelectorAll(".auto-row")].find(
					(el) => (el.querySelector(".auto-row-name")?.textContent ?? "").trim() === name,
				);
				if (row === undefined) return false;
				const fold = row.querySelector(".auto-run-fold");
				if (fold === null) return false;
				if (fold.getAttribute("aria-expanded") !== "true") fold.click();
				return fold.getAttribute("aria-expanded") === "true";
			}, READONLY_TASK),
		{ timeout: 30_000, interval: 250, desc: `展开 ${READONLY_TASK} 的运行报告` },
	);

	const ui = await waitUntil(
		() =>
			win.evaluate((name) => {
				const row = [...document.querySelectorAll(".auto-row")].find(
					(el) => (el.querySelector(".auto-row-name")?.textContent ?? "").trim() === name,
				);
				if (row === undefined) return null;
				const badge = row.querySelector(".auto-run-badge");
				const report = row.querySelector(".run-report-line");
				const witnesses = [...row.querySelectorAll(".run-report-list li")].map((item) =>
					(item.textContent ?? "").trim(),
				);
				const badgeText = (badge?.textContent ?? "").trim();
				const reportText = (report?.textContent ?? "").trim();
				return badge !== null && reportText !== "" && witnesses.length > 0
					? { badge: badgeText, report: reportText, witnesses }
					: null;
			}, READONLY_TASK),
		{
			timeout: 30_000,
			interval: 250,
			desc: `「自动化」区域里 ${READONLY_TASK} 展开后应出现徽标、非空报告与证人行`,
		},
	);

	// 先截图后断言：失败时现场图里能看到用户实际读到的那一屏。
	await h.shoot("watch-run-report");
	await setTheme("dark");
	await h.waitForSettled();
	await h.shoot("watch-run-report-dark");
	await setTheme("light");
	await h.waitForSettled();

	assert.equal(
		ui.badge,
		"被叫停",
		`越界即停的徽标必须是「被叫停」，不能压成笼统的「失败」（实际 ${JSON.stringify(ui.badge)}）`,
	);
	assert.ok(ui.report !== "", `运行报告没有文字（徽标=${JSON.stringify(ui.badge)}）`);
	assert.ok(
		ui.report.includes("越界即停") && ui.report.includes("当场停下"),
		`报告结论没有说清规矩按设计生效：${JSON.stringify(ui.report)}`,
	);
	assert.ok(
		ui.witnesses.some((line) => line.includes("write") && line.includes("只读")),
		`报告里没有渲染可读的证人行：${JSON.stringify(ui.witnesses)}`,
	);
	console.log(`      界面徽标: ${ui.badge}｜报告: ${ui.report.slice(0, 60)}…`);

	/*
	 * 跑完的 toast 必须与报告说同一件事。
	 *
	 * 此前它只看 event.success：越界即停的 success 也是 false（那一轮确实没跑完），
	 * 于是同一屏上报告说「被叫停」、toast 说「运行失败」—— 用户不知道信哪个。
	 * 这条断言就是钉住那个矛盾的（2026-10-18 在 mock 截图里第一次被看见）。
	 */
	const toasts = await win.evaluate(() => window.__watchToasts ?? []);
	const runToast = toasts.find((toast) => toast.text.includes(READONLY_TASK));
	assert.ok(
		runToast !== undefined,
		`没有捕获到这次运行的完成 toast（捕获到 ${JSON.stringify(toasts.map((t) => t.text))}）`,
	);
	assert.ok(
		runToast.text.includes("被值守规矩叫停"),
		`toast 与报告互相矛盾：报告说「被叫停」，toast 说的是「${runToast.text}」`,
	);
	assert.ok(
		!runToast.text.includes("运行失败"),
		`toast 把「规矩按设计生效」说成了「运行失败」：${runToast.text}`,
	);
	assert.ok(
		!runToast.cls.includes("error"),
		`toast 用了错误色，但被叫停不是错误：${runToast.cls}`,
	);
});

// 上一条 check 完成后才删除任务；h.check 不返回 Promise，因此清理放在单独的全局收口。
await deleteProbe(win, { id: readonlyTaskId, name: READONLY_TASK });

// ── ③ 范围：范围外被拒、范围内放行 ────────────────────────────
let scopeTaskId;
await h.check("值守规矩：范围限定下，范围外被拒、范围内放行", async () => {
	const requestsBefore = mock.requests.length;
	const scope = "reports/";
	scopeTaskId = await createProbe({
		name: SCOPE_TASK,
		prompt:
			`${SCOPE_MARKER}\n` +
			"请依次做两件事：" +
			"第一，用 write 工具创建 reports/inside.txt，内容写 ok；" +
			"第二，用 write 工具创建 outside.txt，内容写 bad。" +
			"如果第二次被拒绝，就回复「第二次被拒绝」，不要重试。",
		watch: { minutes: 15, tier: "workspace-write", scope: [scope], stopOnExceed: false },
	});

	const run = await waitForRun({
		id: scopeTaskId,
		name: SCOPE_TASK,
		scenario: "scope",
	});
	assert.equal(run.success, true, `范围探针应在一次越界后继续跑完：${run.error ?? "（无错误说明）"}`);

	const boundary = run.boundary;
	assert.ok(boundary !== null && typeof boundary === "object", `范围任务没有 boundary：${JSON.stringify(run)}`);
	assert.equal(boundary.readOnlyEnforced, false, `范围任务不应被标成只读：${JSON.stringify(boundary)}`);
	assert.ok(
		boundary.scoped?.includes("reports"),
		`boundary 没有记录收敛后的范围 reports：${JSON.stringify(boundary.scoped)}`,
	);

	const exceeded = boundary.exceeded ?? [];
	assert.ok(exceeded.length > 0, `范围外的写入没有被拦（boundary=${JSON.stringify(boundary)}）`);
	const scopeName = scope.replace(/\/+$/u, "");
	assert.ok(
		String(exceeded[0].detail).includes(scopeName),
		`越界理由没说明是哪个范围被越了：${JSON.stringify(exceeded[0].detail)}`,
	);

	const scopeRequests = mock.requests.slice(requestsBefore).filter((request) => request.scenario === "scope");
	assert.ok(scopeRequests.length >= 2, `scope 剧本应至少收到两轮请求，实际 ${scopeRequests.length}`);
	assert.equal(
		scopeRequests.at(-1).toolResults,
		2,
		`scope 第二轮应收到两条工具结果，实际 ${scopeRequests.at(-1).toolResults}`,
	);

	// stopOnExceed=false → 只拒这一次调用，整轮继续，所以范围内的写入该成功。
	const insideExists = existsSync(join(h.WORKSPACE_DIR, "reports", "inside.txt"));
	const outsideExists = existsSync(join(h.WORKSPACE_DIR, "outside.txt"));
	assert.equal(outsideExists, false, "范围外文件真的被写出来了 —— 范围没拦住");
	assert.ok(
		insideExists,
		"范围内的 reports/inside.txt 没写出来 —— stopOnExceed=false 时不该把整轮叫停" +
			`（越界条目：${JSON.stringify(exceeded.map((item) => item.tool))}）`,
	);
	console.log(`      范围内写入成功、范围外被拒；越界理由: ${exceeded[0].detail}`);
});

await deleteProbe(win, { id: scopeTaskId, name: SCOPE_TASK });

await h.check("值守规矩：探针任务已清理干净", async () => {
	const r = await win.evaluate(
		async (names) => {
			const value = await globalThis.kami.listAutomations();
			const tasks = Array.isArray(value) ? value : (value?.tasks ?? []);
			return { leftover: tasks.filter((task) => names.includes(task.name)).length };
		},
		[READONLY_TASK, SCOPE_TASK],
	);
	assert.equal(r.leftover, 0, `还有 ${r.leftover} 个探针任务没删掉`);
});

await h.check("无渲染层未捕获异常", () => assert.equal(h.pageErrors.length, 0, h.pageErrors.join("; ")));

/*
 * ── ④ 规矩编辑区本身（浅色 + 深色各一张）────────────────────────
 *
 * 前面几条断的是「跑起来之后」的行为；用户声明规矩的地方也要有现场图。
 * 像素断言由 shoot 自带，结构由前面的断言与 gui-sections 覆盖。
 */
await h.check("值守规矩：编辑区浅色 / 深色各留一张现场图", async () => {
	await openAutomations();
	const opened = await win.evaluate(() => {
		const page = document.querySelector("main.settings");
		if (page === null) return false;
		const hit = [...page.querySelectorAll("button")].find((node) => (node.textContent || "").trim() === "新建任务");
		if (hit === undefined) return false;
		hit.click();
		return true;
	});
	assert.ok(opened, "没找到自动化页里的「新建任务」按钮");

	await waitUntil(
		() =>
			win.evaluate(() => {
				const text = document.body.textContent || "";
				return text.includes("值守规矩") && document.querySelector(".auto-form-card") !== null;
			}),
		{ timeout: 30_000, interval: 250, desc: "新建任务表单里的「值守规矩」渲染出来" },
	);

	// CSS 入场动画可能在元素挂载后还在播放；等动画真正结束再截图。
	await win.evaluate(
		() =>
			new Promise((done) => {
				const card = document.querySelector(".auto-form-card");
				if (card === null) return done(false);
				const running = card.getAnimations({ subtree: true });
				if (running.length === 0) return done(true);
				void Promise.all(running.map((animation) => animation.finished)).then(() => done(true));
			}),
	);

	await h.shoot("watch-rules-form-light");
	await setTheme("dark");
	await h.waitForSettled();
	await h.shoot("watch-rules-form-dark");
	await setTheme("light");
	await h.waitForSettled();
});

/** 打开侧边栏的「自动化」区域；只在模型回合结束后的空闲态调用。 */
async function openAutomations() {
	const clicked = await win.evaluate(() => {
		const nodes = [...document.querySelectorAll("button, a, [role='button'], li, div")];
		const hits = nodes.filter((node) => (node.textContent || "").trim() === "自动化");
		if (hits.length === 0) return false;
		hits[hits.length - 1].click();
		return true;
	});
	if (!clicked) throw new Error("未找到侧边栏入口「自动化」");
	await h.waitForSettled();
}

/**
 * 在渲染层装一个 toast 记录器。
 *
 * toast 只活 2.2 秒 —— 轮询抓它会在等运行记录落盘时整段错过
 * （export-markdown.mjs 就是被这个坑红过的）。事件驱动之后，无论它活多久，
 * 出现那一刻就被记下来了。
 */
async function watchToasts() {
	await win.evaluate(() => {
		window.__watchToasts = [];
		const record = (node) => {
			if (node === null || node === undefined || node.nodeType !== 1) return;
			const el = node.matches?.(".toast") === true ? node : node.querySelector?.(".toast");
			if (el === null || el === undefined) return;
			window.__watchToasts.push({ text: (el.textContent ?? "").trim(), cls: el.className });
		};
		new MutationObserver((entries) => {
			for (const entry of entries) for (const node of entry.addedNodes) record(node);
		}).observe(document.body, { childList: true, subtree: true });
	});
}

async function setTheme(theme) {
	await win.evaluate((value) => {
		void globalThis.kami?.setThemePreference?.(value);
		document.documentElement.setAttribute("data-theme", value);
	}, theme);
	await waitUntil(() => win.evaluate((value) => document.documentElement.dataset.theme === value, theme), {
		timeout: 10_000,
		interval: 250,
		desc: `主题切到 ${theme}`,
	});
}

async function deleteProbe(activeWindow, { id, name }) {
	await activeWindow.evaluate(
		async ({ taskId, taskName }) => {
			const value = await globalThis.kami.listAutomations();
			const tasks = Array.isArray(value) ? value : (value?.tasks ?? []);
			for (const task of tasks) {
				if (task.id === taskId || task.name === taskName) {
					await globalThis.kami.deleteAutomation(task.id).catch(() => {});
				}
			}
		},
		{ taskId: id, taskName: name },
	);
}

await h.app().close();
await mock.close();
await h.finish();
