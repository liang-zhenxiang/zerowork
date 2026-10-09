/**
 * 模型对比（一问多答）端到端测试：同一个问题并行问 2–4 个模型，一屏并排看。
 *
 * 覆盖的是**只有真实启动 Electron 才暴露的那一层**：⌘K 那条入口真的通、对比真的
 * 打到了各列自己那台模型服务、两列的正文与读数**各归各的**、一列失败不拖垮别列、
 * 越界被明确拒绝、以及**跑完对比之后默认路径（单模型对话）仍然正常**。
 * 纯逻辑那部分（列状态机、读数口径、名单校验）在 `tests/unit/compare-view.test.mjs`
 * 与 `tests/unit/compare-core.test.mjs`，不在这里重复。
 *
 * ## 四台 mock，各司其职（不是一台改参数 —— 那样账本会串在一起）
 *
 * | mock | 用途 | 关键设置 |
 * | --- | --- | --- |
 * | `mockA` | 对比第一列 | 回复 A、用量 A、每片之间 200ms |
 * | `mockB` | 对比第二列 | 回复 B、用量 B、每片之间 700ms |
 * | `mockFail` | 「一列失败」那一列 | `/chat/completions` 直接回 400 |
 * | `mockChat` | 默认路径回归（普通会话） | 回复 CHAT、**带 usage**（⑧ 那条断言的前提） |
 *
 * 两台对比 mock 的**回复不同、用量不同、快慢不同**是刻意的：三样里少任何一样，
 * 「两列各算各的」就会退化成一条永远绿的假断言。
 *
 * ## 失败那一台为什么回 **400** 而不是 500
 *
 * 试过 500：pi 对 5xx 会**自动重试**（`maxRetries: 3` + 2s 起步的指数退避，
 * 见 pi 的 `_isRetryableError` / `RETRYABLE_PROVIDER_ERROR_PATTERN`），于是同一台 mock
 * 会收到 **4 轮**请求、那一列要 ~14 秒才落进失败态 —— 而 15 秒后「另一列早就流完了」。
 *
 * 两处代价：① 用例白等十几秒；② 更麻烦的是**反向验证做不出来** ——
 * 「一列失败把整轮也拖垮」这类注入要在另一列**还在流式**时才看得见，
 * 而 500 的失败来得太晚，注入后另一列已经是终态、注入什么都不改变界面。
 * 400 不属于可重试错误（不在那张正则表里），落在配置错误那一类
 * （模型 id 写错、服务商拒了这次请求）—— 这本来就是对比屏最常见的失败形态，
 * 而且它是**即时**的：失败那一列 ~0.3s 就落定，另一列还在流。
 *
 * ## 「两列各收各的」的判据是什么（这条最容易写成同义反复）
 *
 * 判据是**三样互相独立的证据**，缺一条都可能漏掉串台：
 *
 *   1. **mock 侧**：每台 mock 收到的请求体里的 `model` 等于它自己被选中时那个 id；
 *   2. **DOM 侧**：两列渲染出的正文分别等于各自 mock 的 `reply`（逐字相等，
 *      不是「界面没报错」）；
 *   3. **读数侧**：两列的 `↑/↓` 读数分别等于各自 mock 给的那组 token，
 *      且**互相不出现对方的数字**，两列的耗时都 > 0 且不相等。
 *
 * 第 3 条以前是没法做的：默认 mock 不吐 `usage`，pi 会给出**全 0** 的用量，
 * 于是「两列的用量互不串台」变成「两列都是 ↑0 ↓0」。为此给 mock 加了 `usage` /
 * `delayMs` / `failWith` 三个选项（默认值下行为一个字节不变，
 * 见 `tests/unit/mock-model-server.test.mjs` 的回归组）。
 *
 * ## 等待一律用信号（测试规范 §三.1）
 *
 * 所有 `waitUntil` 的谓词**都能返回假值**；「发出去了没有」等的是**对端的副作用**
 * （mock 收到请求 / mock 收到第 2 轮），不是「没报错」也不 `waitForTimeout`。
 * 模型回合进行中**不用** `waitForSettled()`（回合里有 500ms 级计时器在改 DOM，
 * 「连续静默」永远达不到）。
 *
 * ## 点选模型的节奏：这里**故意**在同一个 JS 任务里连点两下
 *
 * 第 ② 条检查连点两个模型项（`alpha` 与 `beta`，在同一个 `evaluate` 里各 `.click()` 一次），
 * 断言两个都在名单里。这不是为了「模拟手快」—— 它是一条**回归断言**：
 * 修好之前，同一个任务里的第二条点击会读到同一份旧 state 并把第一条的结果覆盖掉，
 * 症状正是「只选中了后一个」，而分开点（中间隔着一次重渲染）完全正常。
 * 归约器改成了**相对动作**（`{type:"toggle", key}`）之后，连点与分开点是同一个结果。
 * 其余步骤仍按真实节奏来（一次点一个、等界面收口），没有别处依赖「同一任务」。
 *
 * ## 反向验证记录（2026-10-07，逐条真跑：注入 → `npm run build` → 跑 → 还原 → 再跑）
 *
 * e2e 跑的是 `out/` 的构建产物，**每次注入都必须先重建**，否则等于什么都没注入
 * （测试规范 §四.1 记过这次浪费）。注入面两处：渲染层 `src/renderer/src/compare-view.js`
 * 与 daemon `src/main/daemon/compare.js` / `session-files.js`。四条全部**注入后先跑红、
 * 还原后跑绿**（还原判据是 `diff` 备份文件逐字节一致）：
 *
 * | 注入 | 结果 |
 * | --- | --- |
 * | 归约器的 `toggle` 退回「绝对列表」语义（加选时只保留这一次点的那个） | ② 红：`此刻选中的是 ["Mock Beta"]（期望两个都在）`；③④⑥⑦ 是**连带的**（名单凑不满 2 个，那些场景根本跑不起来），⓪①⑤⑧⑨ 仍绿 |
 * | 编排层在 `hostError` 分支里 `cancelRun(record)`（一列失败把整轮拖垮） | **恰好 ⑥ 红**：`另一列被拖垮了：状态 cancelled`，其余 10 条全绿 |
 * | 渲染层去掉列间隔离（每条列事件喂给所有列） | ④⑥ 红，且**断言文案本身就是串台**：`认不出两列：["Alpha 服务/alpha-model","Alpha 服务/alpha-model"]`（两列都宣称自己是同一个模型）；其余 9 条全绿 |
 * | daemon 的 `aggregateUsageStats` 去掉 `if (session.isCompare) continue` | **恰好 ⑧ 红**：`对比会话被算进了统计的会话数`（5 ≠ 1），其余 10 条全绿 |
 *
 * 「同一任务连点」那条更细的注入（把基准名单换回「这次渲染的闭包」）在
 * `tests/unit/compare-view.test.mjs` 的同名分组里，那里**恰好 1 条**变红
 * （`expected [ 'prov-b/model-b' ] to deeply equal [ …A, …B ]`）—— 单测能逐条钉住
 * 归约器的语义，e2e 证明它在真界面里也是这个行为。
 *
 * ## 收尾顺序
 *
 * `app.close()` → 各 mock `close()` → `h.finish()`（顺序反了 `server.close()` 会等
 * daemon 与 mock 之间还活着的长连接断开）。
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

/** macOS 用 ⌘（Meta），Windows/Linux 用 Ctrl —— 与 app.js 的 PALETTE_MOD 同口径。 */
const MOD = process.platform === "darwin" ? "Meta" : "Control";

const REPLY_A = "ALPHA 这一份回答来自第一台模型服务";
const REPLY_B = "BETA 这一份回答来自第二台模型服务";
const REPLY_CHAT = "CHAT 单模型对话仍然正常";
/** 两台对比 mock 的用量：**刻意不同**，否则「读数不串台」测不出来。 */
const USAGE_A = { prompt_tokens: 1200, completion_tokens: 340 };
const USAGE_B = { prompt_tokens: 900, completion_tokens: 55 };
const QUESTION = "用一句话说说你是什么模型";

/** 参与对比的两台（列头显示的是 `model.name`，所以名字要能一眼区分）。 */
const PROVIDERS = [
	{ id: "cmp-a", name: "Alpha 服务", baseUrl: null, model: { id: "alpha-model", name: "Mock Alpha" } },
	{ id: "cmp-b", name: "Beta 服务", baseUrl: null, model: { id: "beta-model", name: "Mock Beta" } },
	{ id: "cmp-fail", name: "Fail 服务", baseUrl: null, model: { id: "fail-model", name: "Mock Fail" } },
	{ id: "cmp-chat", name: "Chat 服务", baseUrl: null, model: { id: "chat-model", name: "Mock Chat" } },
];
/** 越界（第 5 个）那条要凑够 5 个可选模型，故另立一个带 3 个模型的服务商。 */
const EXTRAS = {
	id: "cmp-extra",
	name: "Extra 服务",
	models: [
		{ id: "extra-1", name: "Mock Extra 1" },
		{ id: "extra-2", name: "Mock Extra 2" },
		{ id: "extra-3", name: "Mock Extra 3" },
	],
};

const h = createHarness({ name: "multi-model-compare" });
// harness 负责隔离与清空工作区根目录，目录本身要由用例建出来
mkdirSync(h.WORKSPACE_DIR, { recursive: true });

const mockA = await startMockModelServer({ reply: REPLY_A, usage: USAGE_A, models: ["alpha-model"], delayMs: 200 });
const mockB = await startMockModelServer({ reply: REPLY_B, usage: USAGE_B, models: ["beta-model"], delayMs: 700 });
const mockFail = await startMockModelServer({ reply: "这一台刻意失败，回复不该出现在界面上", models: ["fail-model"], failWith: 400 });
const mockChat = await startMockModelServer({
	reply: REPLY_CHAT,
	usage: { prompt_tokens: 500, completion_tokens: 80 },
	models: ["chat-model"],
});
PROVIDERS.find((p) => p.id === "cmp-a").baseUrl = mockA.baseUrl;
PROVIDERS.find((p) => p.id === "cmp-b").baseUrl = mockB.baseUrl;
PROVIDERS.find((p) => p.id === "cmp-fail").baseUrl = mockFail.baseUrl;
PROVIDERS.find((p) => p.id === "cmp-chat").baseUrl = mockChat.baseUrl;
EXTRAS.baseUrl = mockA.baseUrl;
const ALL_MOCKS = [mockA, mockB, mockFail, mockChat];
console.log(`✓ 四台 mock 已就绪：A=${mockA.port} B=${mockB.port} Fail=${mockFail.port} Chat=${mockChat.port}`);

await h.launch();
const win = h.window();

/* ══════════════════════════════════════════════════════════════════════
 * 页面侧的探针
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 把列事件**原样记一份**到页面里（与 `CompareView` 自己的订阅各自独立）。
 *
 * 为什么需要它：「两列同时开始流式」这条若去轮询 DOM 的 `data-status`，需要撞上那一段
 * 重叠窗口，在慢机器上必然 flaky。这里改成读**已经发生过的**时间线：
 * 每列的 `column_started` 与终态各自的时刻都在账上，重叠窗口是一个算得出来的数。
 *
 * 只挑要用的字段落地（跨进程对象不做深拷贝，保持可序列化）。
 */
const installCompareRecorder = () =>
	win.evaluate(() => {
		window.__compareLog = [];
		window.kami.onCompareEvent((event) => {
			window.__compareLog.push({
				at: Date.now(),
				runId: event.runId,
				columnId: event.columnId,
				kind: event.kind,
				delta: event.delta,
				text: event.message?.text,
				usage: event.message?.usage,
				error: event.error,
				outcome: event.outcome,
				elapsedMs: event.elapsedMs,
			});
		});
		return true;
	});

const readCompareLog = () => win.evaluate(() => window.__compareLog ?? []);

/** 一列的两个时刻：自己开始跑的时刻、自己收尾的时刻（都是页面收到事件那一刻）。 */
function windowOf(log, columnId) {
	const mine = log.filter((event) => event.columnId === columnId);
	const started = mine.find((event) => event.kind === "column_started");
	const settled = mine.find((event) => ["assistant_done", "column_failed", "column_cancelled"].includes(event.kind));
	return started === undefined || settled === undefined ? null : { start: started.at, end: settled.at };
}

/** 每列读成一份可断言的东西。`title` 是 `${服务商名}/${模型 id}`，用来认列（不靠下标）。 */
const readColumns = () =>
	win.evaluate(() =>
		[...document.querySelectorAll(".compare-col")].map((column) => ({
			title: column.querySelector(".turn-agent")?.getAttribute("title") ?? "",
			name: (column.querySelector(".turn-agent")?.textContent ?? "").trim(),
			duration: (column.querySelector(".turn-duration")?.textContent ?? "").trim(),
			metrics: (column.querySelector(".run-metrics")?.textContent ?? "").replace(/\s+/g, " ").trim(),
			status: column.getAttribute("data-status"),
			text: (column.querySelector(".markdown")?.innerText ?? "").trim(),
			error: (column.querySelector(".state-error-text")?.textContent ?? "").trim(),
			retry: (column.querySelector(".state-error .mini-btn")?.textContent ?? "").trim() || null,
		})),
	);

/** 按 `title` 认一列（列序会随点选顺序变，所以不按下标取）。 */
const columnFor = (columns, modelId) => columns.find((column) => column.title.endsWith(`/${modelId}`)) ?? null;

const compareViewMounted = () => win.evaluate(() => document.querySelector(".compare-grid") !== null);

const readMenuState = () =>
	win.evaluate(() => ({
		button: (document.querySelector(".composer-card .model-chip")?.textContent ?? "").replace(/\s+/g, " ").trim(),
		picked: [...document.querySelectorAll(".pop-menu.model-menu .model-menu-item")].filter((item) => item.classList.contains("active")).map((item) => (item.querySelector(".model-menu-name")?.textContent ?? "").trim()),
		toasts: [...document.querySelectorAll(".toast")].map((toast) => (toast.textContent ?? "").trim()),
	}));

/** 打开对比屏的多选菜单（触发钮在输入卡右组，与对话页同位置）。 */
async function openModelMenu() {
	await win.evaluate(() => document.querySelector(".composer-card .model-chip")?.click());
	await waitUntil(() => win.evaluate(() => document.querySelector(".pop-menu.model-menu") !== null), {
		timeout: 15_000,
		desc: "对比屏的模型多选菜单挂上（.pop-menu.model-menu）",
	});
}

/** 关掉菜单（`.ws-backdrop` 是它自带的遮罩，与既有 ModelMenu 同一条退路）。 */
async function closeModelMenu() {
	await win.evaluate(() => document.querySelector(".composer-card .menu-zone .ws-backdrop")?.click());
	await waitUntil(() => win.evaluate(() => document.querySelector(".pop-menu.model-menu") === null), {
		timeout: 15_000,
		desc: "模型菜单关闭",
	});
}

/**
 * 按显示名点一个模型项。返回是否点到了 —— 名字对不上时**不静默**，由调用方断言。
 * 一次点一个（真实节奏），除非调用方明确要求同步连点（见 `pickTwoInOneTask`）。
 */
const pickModel = (name) =>
	win.evaluate((target) => {
		const item = [...document.querySelectorAll(".pop-menu.model-menu .model-menu-item")].find(
			(button) => (button.querySelector(".model-menu-name")?.textContent ?? "").trim() === target,
		);
		if (item === undefined) return false;
		item.click();
		return true;
	}, name);

/**
 * **同一个 JS 任务里**连点两个模型项 —— 这条是刻意的（见文件头）。
 * 返回是否两个都点到了。
 */
const pickTwoInOneTask = (first, second) =>
	win.evaluate(
		({ a, b }) => {
			const items = [...document.querySelectorAll(".pop-menu.model-menu .model-menu-item")];
			const find = (name) => items.find((button) => (button.querySelector(".model-menu-name")?.textContent ?? "").trim() === name);
			const one = find(a);
			const two = find(b);
			if (one === undefined || two === undefined) return false;
			one.click();
			two.click();
			return true;
		},
		{ a: first, b: second },
	);

/** 从 ⌘K 打开对比屏。返回面板里第一条结果是不是那条动作。 */
async function openCompareFromPalette() {
	await win.keyboard.press(`${MOD}+k`);
	await waitUntil(() => win.evaluate(() => document.querySelector(".command-palette") !== null), {
		timeout: 15_000,
		desc: "命令面板出现（.command-palette）",
	});
	await win.locator(".command-palette-input").fill("对比多个模型");
	const first = await waitUntil(
		async () => {
			const texts = await win.evaluate(() => [...document.querySelectorAll('.command-palette [role="option"]')].map((el) => (el.textContent ?? "").trim()));
			return texts.length > 0 ? texts[0] : null;
		},
		{ timeout: 15_000, desc: "搜「对比多个模型」有结果" },
	);
	await win.keyboard.press("Enter");
	await waitUntil(compareViewMounted, { timeout: 20_000, desc: "对比屏挂上（.compare-grid）" });
	return first;
}

/** 提交一个问题（走真实键位：填 textarea + Enter，不是直接调 IPC）。 */
async function submitQuestion(text) {
	const box = win.locator('textarea[aria-label="对比的问题"]');
	await box.waitFor({ state: "visible", timeout: 20_000 });
	await box.fill(text);
	await box.press("Enter");
}

/** 等 mock 收到第 n 轮对话请求（「发出去了没有」只能这样回答）。 */
async function waitForRounds(mock, n, why) {
	try {
		await waitUntil(() => mock.requests.length >= n, { timeout: 60_000, interval: 100, desc: `mock 收到第 ${n} 轮请求` });
	} catch (error) {
		throw new Error(`mock 只收到 ${mock.requests.length} 轮请求（期望 ≥${n}）—— ${why}（${error.message}）`, { cause: error });
	}
}

/** 等这一轮对比收尾（`run_finished`）。 */
const waitForRunFinished = (from) =>
	waitUntil(
		async () => {
			const log = await readCompareLog();
			return log.slice(from).some((event) => event.kind === "run_finished") ? log : null;
		},
		{ timeout: 120_000, interval: 100, desc: "本轮对比收尾（run_finished）" },
	);

/** 切主题（截图用）。切完等属性真的落上再截。 */
async function setTheme(theme) {
	await win.evaluate((value) => {
		void window.kami?.setThemePreference?.(value);
		document.documentElement.setAttribute("data-theme", value);
	}, theme);
	await waitUntil(() => win.evaluate((value) => document.documentElement.dataset.theme === value, theme), {
		timeout: 10_000,
		desc: `data-theme 切到 ${theme}`,
	});
	await h.waitForSettled();
}

/* ══════════════════════════════════════════════════════════════════════
 * ① 准备：四个服务商 + 一条「还没发问」的现场
 * ══════════════════════════════════════════════════════════════════════ */

await installCompareRecorder();

await h.check("准备：注册服务商指向四台 mock，普通对话的模型设为 cmp-chat", async () => {
	const result = await win.evaluate(
		async ({ providers, extras, workspace }) => {
			const k = globalThis.kami;
			const toModels = (models) =>
				models.map((model) => ({
					id: model.id,
					name: model.name,
					reasoning: false,
					vision: false,
					contextWindow: 128000,
					maxTokens: 4096,
				}));
			try {
				for (const provider of providers) {
					await k.saveCustomProvider(
						{
							id: provider.id,
							name: provider.name,
							baseUrl: provider.baseUrl,
							api: "openai-completions",
							authHeader: true,
							models: toModels([provider.model]),
						},
						"sk-e2e-dummy",
					);
				}
				await k.saveCustomProvider(
					{ id: extras.id, name: extras.name, baseUrl: extras.baseUrl, api: "openai-completions", authHeader: true, models: toModels(extras.models) },
					"sk-e2e-dummy",
				);
				await k.setModel("cmp-chat/chat-model");
				await k.setWorkspace(workspace);
				const snapshot = await k.settingsSnapshot();
				return { ok: true, keys: (snapshot?.models ?? []).filter((m) => m.available).map((m) => `${m.providerId}/${m.id}`) };
			} catch (error) {
				return { ok: false, err: String(error?.message ?? error).slice(0, 300) };
			}
		},
		{ providers: PROVIDERS, extras: EXTRAS, workspace: h.WORKSPACE_DIR },
	);
	assert.ok(result.ok, `配置失败：${result.err}`);
	/*
	 * 断言的是「我这几个模型**都在**可用清单里」，不是「可用模型恰好 N 个」——
	 * 后者是一台机器碰巧什么样就成什么样的断言（测试规范 §四·补：CI runner 上
	 * 一个内置服务商都没配，开发机上 `ANTHROPIC_AUTH_TOKEN` 让 Anthropic 可用）。
	 * 本机跑出来的可用模型就远多于我这 7 个。
	 */
	const missing = [...PROVIDERS.map((p) => `${p.id}/${p.model.id}`), ...EXTRAS.models.map((m) => `${EXTRAS.id}/${m.id}`)].filter(
		(key) => !result.keys.includes(key),
	);
	assert.deepEqual(missing, [], `这些模型没进可用清单：${missing.join(", ")}`);
	// 越界（第 5 个）那条要凑够 5 个以上可选模型
	assert.ok(result.keys.length >= 5, `可用模型只有 ${result.keys.length} 个，凑不出「选满 4 个再点第 5 个」`);
});

/* ══════════════════════════════════════════════════════════════════════
 * ⓪ 默认路径的基线：先确认普通会话本来是好的
 *
 * 这一轮不只是「热身」——它是 ⑧⑨ 两条断言的前提：
 *   · 让侧栏/统计里**先有东西**（否则「对比之后一条都没多」是一条恒真的断言）；
 *   · 让 ⑨ 的「对比跑完之后还正常」有一个**改动之前的对照**。
 * ══════════════════════════════════════════════════════════════════════ */

await h.check("⓪ 基线：普通会话能发消息、能收到回复（对比之前）", async () => {
	const box = win.locator('[aria-label="消息输入框"]');
	await box.waitFor({ state: "visible", timeout: 30_000 });
	await box.fill("对比之前，先确认普通会话是好的");
	await box.press("Enter");
	await waitForRounds(mockChat, 1, "基线这一轮普通会话发不出消息");
	await waitUntil(
		async () => ((await win.evaluate(() => document.body.innerText)) || "").includes(REPLY_CHAT),
		{ timeout: 60_000, interval: 200, desc: "基线回复渲染到界面上" },
	);
	await h.shoot("home-chat-before-compare-light");
});

/** 对比跑之前的统计与会话列表 —— 后面要断言「对比一点没污染它们」。 */
const statsBefore = await win.evaluate(async () => {
	const k = globalThis.kami;
	const [stats, sessions] = await Promise.all([k.usageStats(), k.listSessions()]);
	return { totalSessions: stats.totalSessions, tokenTotal: stats.totalTokens.total, list: sessions.map((s) => s.path).sort() };
});

await h.check("① ⌘K 搜「对比多个模型」→ 进入对比屏；初始是一列已预选 + 「至少选 2 个」提示", async () => {
	const first = await openCompareFromPalette();
	assert.ok(first.includes("对比多个模型"), `⌘K 第一条结果不是那条动作，而是「${first}」`);
	const mounted = await compareViewMounted();
	assert.ok(mounted, "没有进入对比屏（.compare-grid 不在）");
	await h.waitForSettled();
	await h.shoot("compare-idle-light");
	const columns = await readColumns();
	const menu = await readMenuState();
	// 从 ⌘K 进来时会把「当前会话的模型」预选成第一个参赛者（见 app.js 的 initialModelId）
	assert.equal(columns.length, 1, `初始应恰好一列（预选的那个），实际 ${columns.length} 列：${JSON.stringify(columns.map((c) => c.name))}`);
	assert.equal(columns[0].status, "empty", `还没发问的那一列应当是 empty，实际 ${columns[0].status}`);
	assert.equal(menu.button, "选择对比模型", `只有一个模型时按钮应当是「选择对比模型」，实际「${menu.button}」`);
	const hint = await win.evaluate(() => document.querySelector(".composer-zone .session-stats")?.textContent ?? "");
	assert.ok(hint.includes("至少选 2 个模型"), `缺少「至少选 2 个」的约束提示，实际「${hint}」`);
});

/* ══════════════════════════════════════════════════════════════════════
 * ② 选模型：先去预选、再**同一个任务里连点两下**（回归断言）
 * ══════════════════════════════════════════════════════════════════════ */

await h.check("② 同一个任务里连点两个模型项，两个都进名单（修复前只会剩后一个）", async () => {
	await openModelMenu();
	// 先把预选的那个去掉：它指向 mockChat，是默认路径回归那一台，不参与对比
	assert.ok(await pickModel("Mock Chat"), "菜单里没有「Mock Chat」");
	await waitUntil(async () => (await readMenuState()).picked.length === 0, { timeout: 10_000, desc: "预选被去掉" });

	// 同一个 evaluate 里连点两下 —— 这是回归断言的核心（见文件头）
	assert.ok(await pickTwoInOneTask("Mock Alpha", "Mock Beta"), "菜单里找不到 Mock Alpha / Mock Beta");
	let state;
	try {
		state = await waitUntil(
			async () => {
				const menu = await readMenuState();
				return menu.picked.length === 2 ? menu : null;
			},
			{ timeout: 10_000, interval: 50, desc: "同一个任务里的两次点击都生效（连点不丢第一个）" },
		);
	} catch (error) {
		// 把此刻真正的名单读出来再抛：这条断言的失败现场就是「只剩后一个」那个形状，
		// 光看「等待超时」看不出选中的到底是哪几个。
		const scene = await readMenuState();
		throw new Error(`${error.message}｜此刻选中的是 ${JSON.stringify(scene.picked)}（期望两个都在）`, { cause: error });
	}
	assert.deepEqual(state.picked.sort(), ["Mock Alpha", "Mock Beta"], `连点后选中的是 ${JSON.stringify(state.picked)}`);
	assert.equal(state.button, "对比 2 个模型", `按钮文案不对：「${state.button}」`);
	const columns = await readColumns();
	assert.deepEqual(columns.map((column) => column.name).sort(), ["Mock Alpha", "Mock Beta"], "列阵与名单不一致");
});

/* ══════════════════════════════════════════════════════════════════════
 * ③ 一轮对比：两列同时流式、各收各的正文与读数
 * ══════════════════════════════════════════════════════════════════════ */

const logBeforeRun1 = (await readCompareLog()).length;
/** 本轮收尾后的完整账本（③ 拿到，④ 复用 —— 不让两处各自等一次收尾）。 */
let logRun1;

await h.check("③ 两列同时开始流式（重叠窗口 > 200ms），且各打到自己那台 mock", async () => {
	await closeModelMenu();
	await submitQuestion(QUESTION);

	// 先等「两列都开跑」这个信号，再截图（先截图后断言）
	await waitUntil(
		async () => {
			const log = (await readCompareLog()).slice(logBeforeRun1);
			const ids = new Set(log.filter((event) => event.kind === "column_started").map((event) => event.columnId));
			return ids.size >= 2 ? log : null;
		},
		{ timeout: 60_000, interval: 50, desc: "两列的 column_started 都到了" },
	);
	await h.snap("compare-streaming-light");

	const columns = await readColumns();
	assert.equal(columns.length, 2, `应当是 2 列，实际 ${columns.length} 列`);
	assert.ok(
		columns.every((column) => column.status === "running"),
		`两列此刻都应当在流式中，实际 ${JSON.stringify(columns.map((c) => c.status))}`,
	);
	assert.ok(
		columns.every((column) => column.duration.includes("已处理")),
		`运行中的列头应当显示「已处理 Ns」，实际 ${JSON.stringify(columns.map((c) => c.duration))}`,
	);

	// mock 侧：每台只收到 1 轮，且请求体里的 model 就是它自己那个
	await waitForRounds(mockA, 1, "第一列没有打到 mockA");
	await waitForRounds(mockB, 1, "第二列没有打到 mockB");
	assert.equal(mockA.requests[0].body.model, "alpha-model", `mockA 收到的 model 是 ${mockA.requests[0].body.model}`);
	assert.equal(mockB.requests[0].body.model, "beta-model", `mockB 收到的 model 是 ${mockB.requests[0].body.model}`);
	assert.equal(mockFail.requests.length, 0, "失败那一台根本没被选中，却收到了请求");

	/*
	 * 时间线：两列的重叠窗口 > 200ms（串行执行的话这个数会掉到 0 以下）。
	 *
	 * 这一步必须等**本轮收尾之后**再算 —— 上面那份 `started` 快照里只有起始事件，
	 * 拿它算窗口会得到两个 null（第一版就是这么写的，报的是「起始/收尾时刻没都记到」）。
	 * 等收尾与「先截图后断言」不冲突：上面那张流式截图已经截完了。
	 */
	logRun1 = await waitForRunFinished(logBeforeRun1);
	const windows = [...new Set(logRun1.filter((event) => event.kind === "column_started").map((event) => event.columnId))].map((id) =>
		windowOf(logRun1, id),
	);
	assert.equal(windows.filter((entry) => entry !== null).length, 2, "两列的起始/收尾时刻没都记到");
	const overlap = Math.min(windows[0].end, windows[1].end) - Math.max(windows[0].start, windows[1].start);
	assert.ok(
		overlap > 200,
		`两列的流式窗口只重叠了 ${overlap}ms —— 它们不是并行跑的（串行的话第二列会在第一列收尾后才开始）`,
	);
});

await h.check("④ 两列各收各的正文与读数：正文逐字等于各自 mock 的 reply，用量与耗时互不串台", async () => {
	const log = logRun1;
	await h.waitForSettled();
	await h.shoot("compare-done-light");

	const columns = await readColumns();
	const alpha = columnFor(columns, "alpha-model");
	const beta = columnFor(columns, "beta-model");
	assert.ok(alpha !== null && beta !== null, `认不出两列：${JSON.stringify(columns.map((c) => c.title))}`);

	// 正文：逐字相等（判据是文本本身，不是「界面没报错」）
	assert.equal(alpha.text, REPLY_A, `第一列正文不是 mockA 的回复：${JSON.stringify(alpha.text)}`);
	assert.equal(beta.text, REPLY_B, `第二列正文不是 mockB 的回复：${JSON.stringify(beta.text)}`);
	assert.equal(alpha.status, "done", `第一列状态是 ${alpha.status}`);
	assert.equal(beta.status, "done", `第二列状态是 ${beta.status}`);

	// 读数：各等于自己那份用量，且**不出现对方的数字**
	assert.ok(alpha.metrics.includes("↑1.2K"), `第一列用量读数里没有 ↑1.2K：「${alpha.metrics}」`);
	assert.ok(alpha.metrics.includes("↓340"), `第一列用量读数里没有 ↓340：「${alpha.metrics}」`);
	assert.ok(beta.metrics.includes("↑900"), `第二列用量读数里没有 ↑900：「${beta.metrics}」`);
	assert.ok(beta.metrics.includes("↓55"), `第二列用量读数里没有 ↓55：「${beta.metrics}」`);
	assert.ok(!alpha.metrics.includes("↑900") && !alpha.metrics.includes("↓55"), `第一列里出现了第二列的用量：「${alpha.metrics}」`);
	assert.ok(!beta.metrics.includes("↑1.2K") && !beta.metrics.includes("↓340"), `第二列里出现了第一列的用量：「${beta.metrics}」`);

	// 事件账本里的用量同样各归各的（DOM 与账本两处独立证据）
	const doneOf = (columnId) => log.find((event) => event.columnId === columnId && event.kind === "assistant_done");
	const ids = [...new Set(log.filter((event) => event.kind === "column_started").map((event) => event.columnId))];
	const usages = ids.map((id) => ({ id, usage: doneOf(id)?.usage }));
	const alphaUsage = usages.find((u) => u.usage?.output === USAGE_A.completion_tokens);
	const betaUsage = usages.find((u) => u.usage?.output === USAGE_B.completion_tokens);
	assert.ok(alphaUsage !== undefined, `账本里没有 output=${USAGE_A.completion_tokens} 的那一列：${JSON.stringify(usages)}`);
	assert.ok(betaUsage !== undefined, `账本里没有 output=${USAGE_B.completion_tokens} 的那一列：${JSON.stringify(usages)}`);
	assert.notEqual(alphaUsage.id, betaUsage.id, "两列的用量落在了同一列上 —— 用量串台");

	// 耗时：两列都 > 0 且**不相等**（mockB 每片之间多等 500ms，所以必然更慢）
	const windows = ids.map((id) => ({ id, ...windowOf(log, id) }));
	const alphaMs = windows.find((w) => w.id === alphaUsage.id);
	const betaMs = windows.find((w) => w.id === betaUsage.id);
	assert.ok(alphaMs.end - alphaMs.start > 0, "第一列耗时不是正数");
	assert.ok(betaMs.end - betaMs.start > 0, "第二列耗时不是正数");
	assert.ok(
		betaMs.end - betaMs.start > alphaMs.end - alphaMs.start,
		`慢的那一列反而耗时更短：A=${alphaMs.end - alphaMs.start}ms B=${betaMs.end - betaMs.start}ms`,
	);
	// 列头上的耗时文字也各不相同（「已完成 Ns」，两列的时间不会都落进同一秒）
	assert.ok(alpha.duration.startsWith("已完成"), `第一列列头不是「已完成 Ns」：「${alpha.duration}」`);
	assert.ok(beta.duration.startsWith("已完成"), `第二列列头不是「已完成 Ns」：「${beta.duration}」`);

	// 整轮耗时 ≥ 每一列自己的耗时
	const finished = log.find((event) => event.kind === "run_finished");
	assert.ok(finished.elapsedMs >= betaMs.end - betaMs.start, "整轮耗时比某一列还短，口径不对");
});

await h.check("⑤ 深色下同一屏正常渲染（截图 + 像素断言）", async () => {
	await setTheme("dark");
	await h.shoot("compare-done-dark");
	await setTheme("light");
});

/* ══════════════════════════════════════════════════════════════════════
 * ⑥ 一列失败不影响另一列（同一轮里，一台 mock 回 500）
 * ══════════════════════════════════════════════════════════════════════ */

await h.check("⑥ 一列失败另一列照常：失败列可辨且有重试，成功列渲染出自己的回复", async () => {
	const logBefore = (await readCompareLog()).length;
	await openModelMenu();
	assert.ok(await pickModel("Mock Alpha"), "菜单里没有「Mock Alpha」"); // 去掉快的那一列
	assert.ok(await pickModel("Mock Fail"), "菜单里没有「Mock Fail」"); // 换成失败那一台
	await waitUntil(
		async () => {
			const menu = await readMenuState();
			return menu.picked.length === 2 && menu.picked.includes("Mock Fail") ? menu : null;
		},
		{ timeout: 10_000, interval: 50, desc: "名单换成「Mock Beta + Mock Fail」" },
	);
	await closeModelMenu();
	await submitQuestion(QUESTION);

	await waitForRunFinished(logBefore);
	await h.waitForSettled();
	await h.shoot("compare-one-failed-light");

	const columns = await readColumns();
	const beta = columnFor(columns, "beta-model");
	const failed = columnFor(columns, "fail-model");
	assert.ok(beta !== null && failed !== null, `认不出两列：${JSON.stringify(columns.map((c) => c.title))}`);
	// 失败列：形态可辨 + 有重试入口
	assert.equal(failed.status, "failed", `失败列的状态是 ${failed.status}`);
	assert.ok(failed.error.length > 0, "失败列没有给出可读的原因（错误要可诊断）");
	assert.equal(failed.retry, "重试", "失败列没有「重试」按钮（docs/DESIGN.md §4：错误要就地给出重试）");
	assert.ok(failed.duration.includes("失败"), `失败列的列头应当显示「失败 Ns」，实际「${failed.duration}」`);
	// 成功列：照常流完并渲染
	assert.equal(beta.status, "done", `另一列被拖垮了：状态 ${beta.status}`);
	assert.equal(beta.text, REPLY_B, `另一列的正文不对：${JSON.stringify(beta.text)}`);
	/*
	 * mock 侧：失败那一台**确实被打过**（不是编排层自己判的失败）。
	 *
	 * 用 `>= 1` 而不是 `=== 1`：这一条要证明的是「请求真的打到它了」，
	 * 不该把 pi 的重试策略写死进断言（换成 5xx 时它会重试 3 次）。
	 */
	assert.ok(mockFail.requests.length >= 1, `失败那一台一轮请求都没收到（编排层是不是自己判了失败？）`);
	assert.ok(
		mockFail.requests.every((request) => request.body.model === "fail-model"),
		`打到失败那一台的请求里混进了别的模型：${JSON.stringify(mockFail.requests.map((r) => r.body.model))}`,
	);
	assert.equal(mockB.requests.length, 2, `成功那一台总共收到 ${mockB.requests.length} 轮请求`);
	assert.ok(!beta.text.includes(REPLY_A), "成功列里出现了别的 mock 的文本");
});

/* ══════════════════════════════════════════════════════════════════════
 * ⑦ 第 5 个模型被明确拒绝（有可见反馈，不是静默忽略）
 * ══════════════════════════════════════════════════════════════════════ */

await h.check("⑦ 选满 4 个之后再点第 5 个：弹 toast 说明原因，名单保持 4 个", async () => {
	await openModelMenu();
	// ⑥ 之后名单里是「Mock Beta + Mock Fail」两个，这里补到 4 个
	assert.equal((await readMenuState()).picked.length, 2, "⑦ 的前提是名单里已经有两个（⑥ 的结果）");
	for (const name of ["Mock Extra 1", "Mock Extra 2"]) {
		assert.ok(await pickModel(name), `菜单里没有「${name}」`);
	}
	await waitUntil(async () => (await readMenuState()).picked.length === 4, { timeout: 10_000, interval: 50, desc: "已选满 4 个" });
	const before = await readMenuState();
	assert.equal(before.button, "对比 4 个模型", `选满后按钮文案不对：「${before.button}」`);

	// 第 5 个：越界那一刻要有可见反馈
	assert.ok(await pickModel("Mock Extra 3"), "菜单里没有「Mock Extra 3」");
	const after = await waitUntil(
		async () => {
			const menu = await readMenuState();
			return menu.toasts.length > 0 ? menu : null;
		},
		{ timeout: 10_000, interval: 50, desc: "越界后弹出 toast（而不是静默忽略）" },
	);
	assert.ok(
		after.toasts.some((text) => text.includes("最多同时对比 4 个模型")),
		`toast 文案没说清原因：${JSON.stringify(after.toasts)}`,
	);
	assert.equal(after.picked.length, 4, `第 5 个被加进了名单：${JSON.stringify(after.picked)}`);
	assert.equal(after.button, "对比 4 个模型", `越界后按钮文案变成了「${after.button}」`);
	await h.shoot("compare-full-toast-light");
	await closeModelMenu();
});

/* ══════════════════════════════════════════════════════════════════════
 * ⑧ 不污染：对比跑了两轮，统计与侧栏一条都没多
 * ══════════════════════════════════════════════════════════════════════ */

await h.check("⑧ 跑完两轮对比：usageStats 与 listSessions 一条都没多（对比不进统计、不进侧栏）", async () => {
	const after = await win.evaluate(async () => {
		const k = globalThis.kami;
		const [stats, sessions] = await Promise.all([k.usageStats(), k.listSessions()]);
		return { totalSessions: stats.totalSessions, tokenTotal: stats.totalTokens.total, list: sessions.map((s) => s.path).sort() };
	});
	assert.equal(after.totalSessions, statsBefore.totalSessions, "对比会话被算进了统计的会话数");
	assert.equal(after.tokenTotal, statsBefore.tokenTotal, "对比列的 token 进了统计总量");
	assert.deepEqual(after.list, statsBefore.list, "对比会话出现在了会话列表（侧栏 / 资料库）里");
	/*
	 * 两条「前提」断言：没有它们，上面三条相等断言可能全是恒真的。
	 *   · 会话列表一开始就得有东西（⓪ 那一轮已经产生了一个会话文件）；
	 *   · token 总量一开始就得非 0（mockChat 也带 usage —— 否则四台 mock 的
	 *     token 全是 0，「对比没进统计」就无从判断）。
	 */
	assert.ok(statsBefore.list.length > 0, "会话列表一开始就是空的 —— 这条断言测不出东西");
	assert.ok(statsBefore.tokenTotal > 0, `统计的 token 总量一开始就是 0（${statsBefore.tokenTotal}）—— 这条断言测不出东西`);
});

/* ══════════════════════════════════════════════════════════════════════
 * ⑨ 默认路径回归：对比跑完之后，单模型对话仍然正常
 * ══════════════════════════════════════════════════════════════════════ */

await h.check("⑨ 对比跑完后单模型对话仍可用：能发消息、能收到回复（宿主体没被对比回收掉）", async () => {
	// 退出对比屏（返回按钮 → 回到进来时那个视图）
	await win.evaluate(() => document.querySelector('[aria-label="返回"]')?.click());
	await waitUntil(async () => (await compareViewMounted()) === false, { timeout: 20_000, desc: "对比屏卸载" });
	await waitUntil(() => win.evaluate(() => document.querySelector('[aria-label="消息输入框"]') !== null), {
		timeout: 20_000,
		desc: "普通会话的输入框可用（默认路径还在）",
	});
	/** 会话里最后一条助手回复的文本 + 助手条目数（用来证明「新的一轮真的画上去了」）。 */
	const readAssistantTail = () =>
		win.evaluate(() => {
			const entries = [...document.querySelectorAll(".entry.assistant")];
			return {
				count: entries.length,
				text: entries.length === 0 ? "" : (entries[entries.length - 1].innerText ?? "").trim(),
			};
		});
	// ⓪ 那一轮的回复文本与这一轮**一模一样**（同一个 mock、同一个 reply），所以只判
	// 「文本里有没有 REPLY_CHAT」是恒真的。判据必须是「助手条目多了一条」——
	// 于是「新的一轮真的渲染出来了」与上一轮区分得开。
	const tailBefore = await readAssistantTail();
	const box = win.locator('[aria-label="消息输入框"]');
	await box.fill("对比跑完之后，普通会话还正常吗");
	await box.press("Enter");
	// ⓪ 已经发过一轮，所以这一轮是第 2 轮 —— 等到第 2 轮才算「对比之后这一轮真的发出去了」
	await waitForRounds(mockChat, 2, "对比跑完之后普通会话发不出消息");
	assert.equal(
		mockChat.requests[1].body.model,
		"chat-model",
		`普通会话用的模型变成了 ${mockChat.requests[1].body.model}`,
	);
	await waitUntil(
		async () => {
			const tail = await readAssistantTail();
			return tail.count > tailBefore.count && tail.text.includes(REPLY_CHAT) ? tail : null;
		},
		{ timeout: 60_000, interval: 200, desc: "对比跑完之后那一轮的回复渲染到界面上（助手条目多了一条）" },
	);
	await h.shoot("home-chat-after-compare-light");

	/*
	 * 反证：统计的 token 总量这一次**真的**动了。
	 *
	 * 会话数不能用：⓪ 与这一轮用的是**同一个会话**（同一个工作区、同一轮对话），
	 * 它只多消息、不多会话。token 总量才是「账本活着」的证据 ——
	 * 没有它，⑧ 的「对比列的 token 没进统计」可能是一条恒真的断言。
	 */
	const statsAfterChat = await win.evaluate(async () => {
		const stats = await globalThis.kami.usageStats();
		return { tokenTotal: stats.totalTokens.total };
	});
	assert.ok(
		statsAfterChat.tokenTotal > statsBefore.tokenTotal,
		`普通会话又发了一轮，统计的 token 总量却没变（${statsBefore.tokenTotal} → ${statsAfterChat.tokenTotal}）` +
			"—— 那说明 ⑧ 的「对比没进统计」是一条恒真的断言",
	);
});

// 收尾顺序按 testing spec §五.3：先关应用，再关 mock
// （反过来 server.close 会等 daemon 与 mock 之间还活着的长连接断开）。
await h.app().close();
for (const mock of ALL_MOCKS) await mock.close();
await h.finish();