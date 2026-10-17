/**
 * 值守规矩端到端测试：真的建一个带规矩的定时任务 → 真的跑它 → 真的越一次界。
 *
 * 为什么非要有这个文件：`watch-policy.test.mjs` 测的是**判定**（纯函数），
 * `local-state.mjs` 测的是**存取**（存得下、读得回、非法输入被拒），
 * 两者都绿也说明不了「规矩在真实运行里真的拦得住东西」——
 * 判定与接线之间隔着一层取值、一层工具钩子、一层运行记账，
 * 已经出过一次「读错字段名、判定写对了却从不生效」的事（见 session-files.js
 * 里 effectivePolicy 调用点上方的记录）。那个 bug 在纯函数测试里是全绿的。
 *
 * 所以这里断言的是整条链路，尤其是**越界证人**：
 *   ① 给任务声明「只读」，提示词让模型去写文件 → 写入必须被拒；
 *   ② 运行记录里留下 boundary（越界条目带工具名与理由）；
 *   ③ 运行报告在界面上看得见，且徽标是「越界叫停」而不是笼统的「失败」；
 *   ④ 声明「可写」+ 范围限定，范围外的写入被拒、范围内的放行。
 *
 * ⚠️ 凭据运行时从 ~/.claude/settings.json 读取，不进仓库、不打印。
 *    端点不可用时**逐条上报跳过**，而不是整轮 exit(0)。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

/** 探针任务名：形如一个单词加数字，弱模型也抄得准。 */
const READONLY_TASK = "zw-watch-readonly-probe";
const SCOPE_TASK = "zw-watch-scope-probe";

const h = createHarness({ name: "watch-policy" });
const WORKSPACE_DIR = h.WORKSPACE_DIR;

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

/** 探一次端点是不是真的活着；返回 `{ endpoint }` 或 `{ reason }`。 */
async function probeEndpoint() {
	if (!existsSync(SETTINGS)) return { reason: `本机没有 ${SETTINGS}` };
	const endpoint = readEndpoint();
	if (endpoint === undefined) {
		return {
			reason: `${SETTINGS} 的 env 里缺少 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL`,
		};
	}
	const probe = await fetch(`${endpoint.baseUrl}/v1/messages`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-api-key": endpoint.token,
			"anthropic-version": "2023-06-01",
		},
		body: JSON.stringify({
			model: endpoint.model,
			max_tokens: 16,
			messages: [{ role: "user", content: "hi" }],
		}),
	}).catch(() => undefined);
	if (!probe || !probe.ok) {
		return {
			reason: `模型端点探活失败（HTTP ${probe?.status ?? "无响应"}）：${endpoint.baseUrl}`,
		};
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
	"值守规矩：只读任务里的写入被拒，且运行记录留下越界证人",
	"值守规矩：界面上运行报告的徽标是「越界叫停」而不是「失败」",
	"值守规矩：范围限定下，范围外被拒、范围内放行",
	"值守规矩：探针任务已清理干净",
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

	// 权限自动批准：任务执行时若遇到审批会一直挂着。
	// 注意这**不会**绕过值守规矩 —— 规矩是额外的合取项，在审批之前就拦。
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
							models: [
								{
									id: model,
									name: model,
									reasoning: false,
									vision: false,
									contextWindow: 128000,
									maxTokens: 8192,
								},
							],
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

	/** 读探针任务的最近一次运行（含 boundary）。 */
	const readProbe = (taskName) =>
		win.evaluate(async (name) => {
			const k = globalThis.kami;
			const asArray = (v) => (Array.isArray(v) ? v : (v?.tasks ?? []));
			const task = asArray(await k.listAutomations()).find((t) => t.name === name);
			const run = (task?.runs ?? [])[0];
			return {
				stillListed: task !== undefined,
				taskWatch: task?.watch ?? null,
				runCount: (task?.runs ?? []).length,
				success: run?.success,
				error: run?.error,
				boundary: run?.boundary ?? null,
			};
		}, taskName);

	/** 建一个探针任务（先清同名残留），入队即返回。 */
	const createProbe = ({ name, prompt, watch }) =>
		win.evaluate(
			async ({ ws, name: taskName, prompt: text, watch: rules }) => {
				const k = globalThis.kami;
				const asArray = (v) => (Array.isArray(v) ? v : (v?.tasks ?? []));
				for (const t of asArray(await k.listAutomations())) {
					if (t.name === taskName) await k.deleteAutomation(t.id).catch(() => {});
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
			{ ws: WORKSPACE_DIR, name, prompt, watch },
		);

	/** 等到运行记录落盘；返回最后一次读到的快照。 */
	async function waitForRun(taskName, timeout = 180_000) {
		let last = undefined;
		let note = "";
		try {
			await waitUntil(
				async () => {
					last = await readProbe(taskName);
					return last.runCount > 0;
				},
				{
					timeout,
					interval: 2000,
					desc: `任务 ${taskName} 的运行记录落盘（调度器入队即返回，跑完才 appendRun —— 它一直没跑完？）`,
				},
			);
		} catch (error) {
			note = `${error.message}；`;
		}
		return { run: last ?? { runCount: 0 }, note };
	}

	// ── ① 只读：写入必须被拒，并留下越界证人 ──────────────────────

	await h.check("值守规矩：只读任务里的写入被拒，且运行记录留下越界证人", async () => {
		const taskId = await createProbe({
			name: READONLY_TASK,
			// 直接要求它写文件 —— 越界才说明规矩真的拦住了东西
			prompt:
				"请立刻用 write 工具在当前工作目录下创建文件 watch-probe.txt，内容写 hello。" +
				"写完就回复「完成」。如果被拒绝，请直接回复「被拒绝」两个字，不要重试。",
			watch: { minutes: 15, tier: "read-only", scope: [], stopOnExceed: true },
		});

		try {
			const { run, note } = await waitForRun(READONLY_TASK);

			// 规矩存进去了（存取没问题，这里顺带钉一下往返）
			assert.equal(run.taskWatch?.tier, "read-only", "任务里存的 tier 不是 read-only");

			assert.ok(run.runCount > 0, `任务触发了但运行记录一直没落。${note}`);

			const boundary = run.boundary;
			assert.ok(
				boundary !== null && typeof boundary === "object",
				"运行记录里没有 boundary —— 这次运行没有留下任何边界记录，规矩等于没生效",
			);

			const exceeded = boundary.exceeded ?? [];
			assert.ok(
				exceeded.length > 0,
				`只读任务里模型尝试写入，却没有一条越界记录（boundary=${JSON.stringify(boundary)}）` +
					` —— 规矩没有拦下这次写入`,
			);

			// 证人要说清「谁越的、凭什么越」，不是一句「操作失败」
			const first = exceeded[0];
			assert.ok(
				typeof first.tool === "string" && first.tool !== "",
				`越界条目缺工具名：${JSON.stringify(first)}`,
			);
			assert.ok(
				typeof first.detail === "string" && first.detail.includes("只读"),
				`越界理由没带上规矩原文（用户看不到「为什么被拒」）：${JSON.stringify(first.detail)}`,
			);

			// 真的没写进去 —— 拦住的是效果，不只是留了条记录。
			// 直接读工作区（它就是本机临时目录，与 file-history.mjs 同一做法）；
			// 不要走渲染层的 IPC —— 那里没有 readFile 这个通道，
			// 拿不存在的通道去读会抛错，于是「读不到」被误当成「文件不存在」，
			// 一条本该抓 bug 的断言反而会为 bug 放行。
			const wrote = existsSync(join(WORKSPACE_DIR, "watch-probe.txt"));
			assert.equal(
				wrote,
				false,
				"越界记录有了，但文件真的被写出来了 —— 规矩没有拦住写入",
			);

			console.log(
				`      越界证人: tool=${first.tool} detail=${String(first.detail).slice(0, 60)}…`,
			);
		} finally {
			await win.evaluate(async (id) => {
				await globalThis.kami.deleteAutomation(id).catch(() => {});
			}, taskId);
		}
	});

	// ── ② 界面：报告要能一眼读出「越界叫停」而非笼统失败 ──────────

	await h.check("值守规矩：界面上运行报告的徽标是「越界叫停」而不是「失败」", async () => {
		/*
		 * 不重跑任务（那要再等一次模型），直接读**上一条**落盘的运行记录渲染出来的界面。
		 * 为了让界面拿得到数据，这里重新建一个同名任务并手动触发一次「不跑模型」的场景
		 * 是不现实的 —— 所以改为再跑一遍同样的只读探针，然后立刻看界面。
		 */
		const taskId = await createProbe({
			name: READONLY_TASK,
			prompt:
				"请用 write 工具在当前工作目录创建 watch-ui-probe.txt。被拒绝就直接回复「被拒绝」，不要重试。",
			watch: { minutes: 15, tier: "read-only", scope: [], stopOnExceed: true },
		});

		try {
			await waitForRun(READONLY_TASK);

			await openAutomations();
			/*
			 * 分两步等，不要挤在一次 evaluate 里点两个开关：
			 * React 把同一个事件里的两次 setState 批处理掉，报告体要等**下一帧**才在 DOM 里。
			 * 同一次 evaluate 里点完「展开运行记录」再点「报告」并立刻读 `.run-report-line`，
			 * 读到的是还没提交的那一帧 —— 于是把「我读早了」报成了「界面上没有报告」。
			 */
			await waitUntil(
				async () =>
					win.evaluate((name) => {
						const row = [...document.querySelectorAll(".auto-row")].find(
							(el) => (el.querySelector(".auto-row-name")?.textContent ?? "").trim() === name,
						);
						if (row === undefined) return false;
						const expand = row.querySelector(".auto-row-expand");
						if (expand !== null && expand.getAttribute("aria-expanded") !== "true") expand.click();
						return expand !== null && expand.getAttribute("aria-expanded") === "true";
					}, READONLY_TASK),
				{ timeout: 30_000, interval: 500, desc: `展开 ${READONLY_TASK} 的运行记录` },
			);

			// 第二跳：展开「报告」。点击与读取必须分成两次 evaluate ——
			// React 在同一个事件里批处理 setState，点完立刻读 `.run-report-line`
			// 拿到的是**上一帧**（元素还不存在），会把「我读早了」报成「界面没有报告」。
			await waitUntil(
				async () =>
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
				{ timeout: 30_000, interval: 500, desc: `展开 ${READONLY_TASK} 的运行报告` },
			);

			const ui = await waitUntil(
				async () =>
					win.evaluate((name) => {
						// 结构：`.auto-row` 是那一行；运行记录在它内部的 `.auto-runs` 里。
						const row = [...document.querySelectorAll(".auto-row")].find(
							(el) => (el.querySelector(".auto-row-name")?.textContent ?? "").trim() === name,
						);
						if (row === undefined) return null;
						const badge = row.querySelector(".auto-run-badge");
						const report = row.querySelector(".run-report-line");
						return badge === null
							? null
							: {
									badge: (badge.textContent ?? "").trim(),
									report: (report?.textContent ?? "").trim(),
								};
					}, READONLY_TASK),
				{
					timeout: 30_000,
					interval: 500,
					desc: `「自动化」区域里 ${READONLY_TASK} 展开后能看到运行报告`,
				},
			);

			// 先截图后断言：界面长什么样，这张图就是现场
			await h.shoot("watch-run-report");

			assert.ok(
				ui.badge !== "" && ui.badge !== "失败",
				`徽标是笼统的「失败」—— 越界叫停与真失败是两件事，必须能一眼分开（实际 ${JSON.stringify(ui.badge)}）`,
			);
			assert.ok(
				ui.report !== "",
				`运行报告没有文字（徽标=${JSON.stringify(ui.badge)}）—— 用户看不出这次被规矩拦了`,
			);
			console.log(`      界面徽标: ${ui.badge}｜报告: ${ui.report.slice(0, 60)}…`);
		} finally {
			await win.evaluate(async (id) => {
				await globalThis.kami.deleteAutomation(id).catch(() => {});
			}, taskId);
		}
	});

	// ── ③ 范围：范围外被拒、范围内放行 ────────────────────────────

	await h.check("值守规矩：范围限定下，范围外被拒、范围内放行", async () => {
		const scope = "reports/";
		const taskId = await createProbe({
			name: SCOPE_TASK,
			prompt:
				`请依次做两件事：` +
				`第一，用 write 工具创建 reports/inside.txt，内容写 ok；` +
				`第二，用 write 工具创建 outside.txt，内容写 bad。` +
				`如果第二次被拒绝，就回复「第二次被拒绝」，不要重试。`,
			watch: { minutes: 15, tier: "workspace-write", scope: [scope], stopOnExceed: false },
		});

		try {
			const { run, note } = await waitForRun(SCOPE_TASK);
			assert.ok(run.runCount > 0, `任务触发了但运行记录一直没落。${note}`);

			const exceeded = run.boundary?.exceeded ?? [];
			assert.ok(
				exceeded.length > 0,
				`范围外的写入没有被拦（boundary=${JSON.stringify(run.boundary)}）`,
			);
			/*
			 * 理由里点名的是**归一化后**的范围（`reports/` → `reports`）：
			 * parseWatchPolicy 会去掉尾部斜杠，而理由用的是收敛后 policy 的原值。
			 * 断言按去斜杠的形式比 —— 拿界面输入的原文去比会误判成「没说明范围」。
			 */
			const scopeName = scope.replace(/\/+$/u, "");
			assert.ok(
				String(exceeded[0].detail).includes(scopeName),
				`越界理由没说明是哪个范围被越了：${JSON.stringify(exceeded[0].detail)}`,
			);

			// stopOnExceed=false → 只拒这一次调用，整轮继续，所以范围内的写入该成功。
			// 同样直接查文件系统，不走不存在的渲染层通道。
			const insideExists = existsSync(join(WORKSPACE_DIR, "reports", "inside.txt"));
			const outsideExists = existsSync(join(WORKSPACE_DIR, "outside.txt"));

			assert.equal(outsideExists, false, "范围外文件真的被写出来了 —— 范围没拦住");
			assert.ok(
				insideExists,
				"范围内的 reports/inside.txt 没写出来 —— stopOnExceed=false 时不该把整轮叫停" +
					`（越界条目：${JSON.stringify(exceeded.map((e) => e.tool))}）`,
			);
			console.log(`      范围内写入成功、范围外被拒；越界理由: ${exceeded[0].detail}`);
		} finally {
			await win.evaluate(async (id) => {
				await globalThis.kami.deleteAutomation(id).catch(() => {});
			}, taskId);
		}
	});

	await h.check("值守规矩：探针任务已清理干净", async () => {
		const r = await win.evaluate(
			async (names) => {
				const v = await globalThis.kami.listAutomations();
				const arr = Array.isArray(v) ? v : (v?.tasks ?? []);
				return { leftover: arr.filter((t) => names.includes(t.name)).length };
			},
			[READONLY_TASK, SCOPE_TASK],
		);
		assert.equal(r.leftover, 0, `还有 ${r.leftover} 个探针任务没删掉`);
	});

	await h.check("无渲染层未捕获异常", () =>
		assert.equal(h.pageErrors.length, 0, h.pageErrors.join("; ")),
	);

	/*
	 * ── ⑤ 规矩编辑区本身（浅色 + 深色各一张）──────────────────────
	 *
	 * 前面几条断的都是「跑起来之后」的行为：越界被拒、报告怎么读。
	 * 但用户**声明**规矩的地方是表单里那一组字段，它此前从未被截图看过 ——
	 * 而设计评审的第一条意见正是「四条声明必须是一个整体、不能被读成四个无关字段」，
	 * 那是一件**只能靠看图判断**的事。所以这里把它拍下来，两种主题各一张。
	 *
	 * 只截图不断言画面（像素断言由 shoot 自带），文案与结构由前面的断言负责。
	 */
	await h.check("值守规矩：编辑区浅色 / 深色各留一张现场图", async () => {
		await openAutomations();
		/*
		 * 点「新建任务」时要**限定在自动化页内**：
		 * 侧边栏顶部也有一个同名的「新建任务」（那是新建会话），
		 * 按文字全局取第一个会点到它，于是截出来的是首页 —— 表单永远不会打开。
		 *
		 * 自动化页的容器是 `main.settings`（它复用了设置页的外壳），
		 * 空态那个按钮额外带 `primary-btn`；头部那个是 `mini-btn`。
		 * 两个都能开表单，这里取 `.settings-body` 里的那个，并把范围卡死在页内。
		 */
		const opened = await win.evaluate(() => {
			const page = document.querySelector("main.settings");
			if (page === null) return false;
			const hit = [...page.querySelectorAll("button")].find(
				(n) => (n.textContent || "").trim() === "新建任务",
			);
			if (hit === undefined) return false;
			hit.click();
			return true;
		});
		assert.ok(opened, "没找到自动化页里的「新建任务」按钮");

		// 等表单出现：判据是「值守规矩」这组字段真的渲染出来了
		await waitUntil(
			async () =>
				win.evaluate(() => {
					const text = document.body.textContent || "";
					return text.includes("值守规矩") && document.querySelector(".auto-form-card") !== null;
				}),
			{ timeout: 30_000, interval: 500, desc: "新建任务表单里的「值守规矩」渲染出来" },
		);

		/*
		 * 等入场动画真的走完再截图。
		 *
		 * `.auto-form-card` 挂着 `animation: pop-layer-in var(--dur-base)`，
		 * 表单是「挂载即终态」的动画 —— 元素一出现就在，但**画面还在动**。
		 * `waitForSettled()` 等的是没有计时器的空闲帧，抓不住 CSS 动画的中间帧：
		 * 上一版截图就是这么拍到了半透明的表单叠在空态上，
		 * 看起来像个渲染 bug，其实是**拍早了**。
		 * 主动等动画结束，截图才是稳定的终态。
		 */
		await win.evaluate(
			() =>
				new Promise((done) => {
					const card = document.querySelector(".auto-form-card");
					if (card === null) return done(false);
					const running = card.getAnimations({ subtree: true });
					if (running.length === 0) return done(true);
					void Promise.all(running.map((a) => a.finished)).then(() => done(true));
				}),
		);

		await h.shoot("watch-rules-form-light");

		// 深色对照：同一屏换主题再拍一张（token 用法在暗色下最容易露馅）
		await win.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
		await h.waitForSettled();
		await h.shoot("watch-rules-form-dark");
		await win.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
		await h.waitForSettled();
	});

	/**
	 * 打开侧边栏的「自动化」区域。
	 *
	 * 导航后是空闲态（页面里没有计时器），所以可以用 `waitForSettled()`。
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
const { endpoint, reason } = await probeEndpoint();
if (endpoint === undefined) {
	console.warn(`⚠ 模型端点不可用 —— 值守规矩的真实运行需要模型：${reason}`);
	skipAll(reason);
} else {
	console.log(`✓ 模型端点可用：${endpoint.baseUrl}，模型 ${endpoint.model}`);
	await runWithModel(endpoint);
}

await h.finish();
