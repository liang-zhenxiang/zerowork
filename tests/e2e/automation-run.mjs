/**
 * 定时任务**执行**链路端到端测试：入队 → 起会话 → 跑提示词 → 落运行记录。
 *
 * 此前只测过定时任务的 CRUD（建/改/启停/删，见 local-state.mjs），**执行**这一半
 * 一行都没跑过 —— 而「到点真的把任务跑起来」才是这个功能存在的意义。
 * CRUD 全绿而执行不通，用户看到的是「任务都在列表里，但从来没跑过」。
 *
 * 断言的是整条链路：
 *   ① `automationRunNow` 入队后，调度器真的起了会话、把提示词跑完；
 *   ② 运行记录落盘（`runs[0]` 有 `success: true` 与非空 `sessionId`）；
 *   ③ 这份记录在**界面上也看得见**（「自动化」区域里那一行的徽标是「成功」）；
 *   ④ 任务本身仍留在列表里（执行不该把任务弄丢）。
 *
 * ⚠️ 凭据运行时从 ~/.claude/settings.json 读取，不进仓库、不打印。
 *    端点不可用时**逐条上报跳过**（见文件末尾的分派），而不是整轮 `exit(0)`。
 *
 * 迁移说明（共享 harness）：骨架（隔离目录、启动并等到就绪、check 收集器、
 * 末尾报告与退出码）全部来自 `./lib/harness.mjs`。启动不再固定等 9 秒 ——
 * harness 等到「#root 挂载 + daemon 报启动 + DOM 变动静默」三件事都成立；
 * 页内手写的 `for + sleep` 轮询换成 `waitUntil`，截止时间统一交给它管。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

/** 自定义任务用的标记：形如一个单词加数字，弱模型也抄得准。 */
const TASK_NAME = "zw-auto-run-probe";

const h = createHarness({ name: "automation" });
const WORKSPACE_DIR = h.WORKSPACE_DIR;

// ── 模型端点（本机可选）──────────────────────────────────────

const SETTINGS = resolve(homedir(), ".claude", "settings.json");

/** 读本机端点配置；读到不等于服务活着（凭据不落盘、不打印）。 */
function readEndpoint() {
	if (!existsSync(SETTINGS)) return undefined;
	try {
		const env = JSON.parse(readFileSync(SETTINGS, "utf8"))?.env ?? {};
		const baseUrl = env.ANTHROPIC_BASE_URL;
		const token = env.ANTHROPIC_AUTH_TOKEN;
		const model = String(env.ANTHROPIC_MODEL ?? "").replace(/\[[^\]]*\]$/, "");
		return baseUrl && token && model ? { baseUrl, token, model } : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 探一次端点是不是真的活着。
 *
 * 返回 `{ endpoint }` 或 `{ reason }`；`reason` 会作为**跳过理由**逐条写进报告
 * （端点不活不等于用例有问题，但也不能当成通过）。
 */
async function probeEndpoint() {
	if (!existsSync(SETTINGS)) return { reason: `本机没有 ${SETTINGS}` };
	const endpoint = readEndpoint();
	if (endpoint === undefined) {
		return { reason: `${SETTINGS} 的 env 里缺少 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL` };
	}
	const probe = await fetch(`${endpoint.baseUrl}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": endpoint.token, "anthropic-version": "2023-06-01" },
		body: JSON.stringify({ model: endpoint.model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
	}).catch(() => undefined);
	if (!probe || !probe.ok) {
		return { reason: `模型端点探活失败（HTTP ${probe?.status ?? "无响应"}）：${endpoint.baseUrl}` };
	}
	return { endpoint };
}

/**
 * 需要模型才能跑的那些断言。
 *
 * 与下面的 `h.check` 一一对应：**新增依赖模型的断言时这里要同步加一条**，
 * 否则报告会低报跳过数（那正是这个清单存在的意义）。
 */
const NEEDS_MODEL = [
	"配置真实模型并切换工作区",
	"自动化执行：手动触发后真的跑完并落运行记录",
	"自动化执行：探针任务已清理干净",
];

/** 逐条上报跳过：报告里要出现「跳过 N」，而不是一片伪装出来的全绿。 */
function skipAll(reason) {
	for (const label of NEEDS_MODEL) h.skip(label, reason);
	h.skip("无渲染层未捕获异常", `${reason}；端点不可用时不启动应用，这条无从检查`);
}

/** 端点可用时的正戏。 */
async function runWithModel(endpoint) {
	await h.launch();
	const win = h.window();

	await h.snap("home");

	// 权限自动批准：任务执行时若遇到审批会一直挂着
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

	await h.check("配置真实模型并切换工作区", async () => {
		const r = await win.evaluate(
			async ({ baseUrl, token, model, ws }) => {
				const k = globalThis.kami;
				try {
					await k.saveCustomProvider(
						{
							id: "local-proxy",
							name: "Local Proxy",
							baseUrl,
							api: "anthropic-messages",
							authHeader: true,
							models: [{ id: model, name: model, reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }],
						},
						token,
					);
					await k.setModel(`local-proxy/${model}`);
					await k.setWorkspace(ws);
					return { ok: true };
				} catch (e) {
					return { ok: false, err: String(e?.message ?? e).slice(0, 200) };
				}
			},
			{ ...endpoint, ws: WORKSPACE_DIR },
		);
		assert.ok(r.ok, `配置失败: ${r.err}`);
	});

	/** 读探针任务的当前状态（列表里的那一条）。 */
	const readProbe = (taskId) =>
		win.evaluate(async ({ id, taskName }) => {
			const k = globalThis.kami;
			const asArray = (v) => (Array.isArray(v) ? v : (v?.tasks ?? []));
			const last = asArray(await k.listAutomations()).find((t) => t.id === id || t.name === taskName);
			const run = (last?.runs ?? [])[0];
			return {
				stillListed: last !== undefined,
				runCount: (last?.runs ?? []).length,
				success: run?.success,
				sessionId: run?.sessionId,
				error: run?.error,
				startedAt: run?.startedAt,
				finishedAt: run?.finishedAt,
			};
		}, { id: taskId, taskName: TASK_NAME });

	await h.check("自动化执行：手动触发后真的跑完并落运行记录", async () => {
		// 先清掉可能存在的同名残留，再建任务并**入队即返回**
		const taskId = await win.evaluate(
			async ({ ws, name }) => {
				const k = globalThis.kami;
				const asArray = (v) => (Array.isArray(v) ? v : (v?.tasks ?? []));
				for (const t of asArray(await k.listAutomations())) {
					if (t.name === name) await k.deleteAutomation(t.id).catch(() => {});
				}
				const task = await k.saveAutomation({
					name,
					prompt: "请只回复：定时任务已执行",
					cwd: ws,
					schedule: { type: "interval", everyMinutes: 60 },
				});
				await k.runAutomationNow(task.id);
				return task.id;
			},
			{ ws: WORKSPACE_DIR, name: TASK_NAME },
		);

		try {
			// 调度器是**入队即返回**，跑完才 appendRun —— 原实现是 `for 90 × sleep(2s)`，
			// 换成 waitUntil 等「运行记录真的落盘」这个信号
			let last = undefined;
			let note = "";
			try {
				await waitUntil(
					async () => {
						last = await readProbe(taskId);
						return last.runCount > 0;
					},
					{
						timeout: 180_000,
						interval: 2000,
						desc: `任务 ${TASK_NAME} 的运行记录落盘（调度器是入队即返回，跑完才 appendRun —— 它一直没跑完？）`,
					},
				);
			} catch (error) {
				note = `${error.message}；`;
			}
			const r = last ?? { runCount: 0, stillListed: false };

			// 界面侧：到「自动化」区域看一眼 —— 记录落了盘，界面上也得看得见
			await openAutomations();
			const ui = await waitUntil(
				async () =>
					win.evaluate((name) => {
						const row = [...document.querySelectorAll(".auto-row")].find(
							(el) => (el.querySelector(".auto-row-name")?.textContent ?? "").trim() === name,
						);
						if (row === undefined) return null;
						const btn = row.querySelector('[aria-label="展开运行记录"]');
						if (btn !== null && btn.getAttribute("aria-expanded") !== "true") btn.click();
						const badge = row.querySelector(".auto-run-badge");
						return badge === null ? null : { badge: (badge.textContent ?? "").trim() };
					}, TASK_NAME),
				{
					timeout: 30_000,
					interval: 500,
					desc: `「自动化」区域里 ${TASK_NAME} 展开后能看到运行记录（记录落了盘但界面没跟着刷新？）`,
				},
			);

			// 先截图后断言：界面上那条运行记录长什么样，这张图就是现场
			await h.shoot("automation-run-record");
			assert.equal(ui.badge, "成功", `界面上那条运行记录的徽标不是「成功」，实际是 ${JSON.stringify(ui.badge)}`);

			assert.ok(r.runCount > 0, `任务触发了但运行记录一直没落 —— 调度器没把它跑完。${note}`);
			assert.ok(r.stillListed, "执行后任务从列表里消失了");
			assert.equal(r.success, true, `任务执行失败：${r.error ?? "（无错误说明）"}`);
			assert.ok(typeof r.sessionId === "string" && r.sessionId !== "", "运行记录里没有 sessionId —— 没起会话？");
			assert.ok(
				typeof r.finishedAt === "number" && r.finishedAt >= r.startedAt,
				`运行记录的时间字段不对：started=${r.startedAt} finished=${r.finishedAt}`,
			);
			console.log(
				`      运行记录: success=${r.success} sessionId=${String(r.sessionId).slice(0, 12)}… 耗时 ${r.finishedAt - r.startedAt}ms`,
			);
		} finally {
			// 收尾：删掉探针任务，别把状态留给后续
			await win.evaluate(async (id) => {
				await globalThis.kami.deleteAutomation(id).catch(() => {});
			}, taskId);
		}
	});

	await h.check("自动化执行：探针任务已清理干净", async () => {
		const r = await win.evaluate(async (name) => {
			const v = await globalThis.kami.listAutomations();
			const arr = Array.isArray(v) ? v : (v?.tasks ?? []);
			return { leftover: arr.filter((t) => t.name === name).length };
		}, TASK_NAME);
		assert.equal(r.leftover, 0, `还有 ${r.leftover} 个探针任务没删掉`);
	});

	await h.check("无渲染层未捕获异常", () => assert.equal(h.pageErrors.length, 0, h.pageErrors.join("; ")));

	/**
	 * 打开侧边栏的「自动化」区域。
	 *
	 * 导航后是**空闲态**（页面里没有计时器，`now` 只在渲染时取一次），
	 * 所以这里可以用 `waitForSettled()` —— 与模型回合进行中的情形不同。
	 */
	async function openAutomations() {
		const clicked = await win.evaluate(() => {
			const nodes = [...document.querySelectorAll("button, a, [role='button'], li, div")];
			const hits = nodes.filter((n) => (n.textContent || "").trim() === "自动化");
			if (hits.length === 0) return false;
			hits[hits.length - 1].click();
			return true;
		});
		if (!clicked) throw new Error("未找到侧边栏入口「自动化」");
		await h.waitForSettled();
	}
}

// ── 分派：端点可用就跑正戏，不可用就逐条上报跳过 ────────────────
//
// 原来这里是不论如何都 `process.exit(0)`：报告里一片全绿、实际一条断言都没跑，
// 于是本文件在 CI 上是**零信号**。跳过与通过必须能被区分开。
const { endpoint, reason } = await probeEndpoint();
if (endpoint === undefined) {
	console.warn(`⚠ 模型端点不可用 —— 执行链路需要模型：${reason}`);
	skipAll(reason);
} else {
	console.log(`✓ 模型端点可用：${endpoint.baseUrl}，模型 ${endpoint.model}`);
	await runWithModel(endpoint);
}

await h.finish();
