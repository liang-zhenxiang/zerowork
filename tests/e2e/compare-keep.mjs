/**
 * 「留为会话」端到端：对比跑完后，把满意的那一列收成一条**普通会话**。
 *
 * 覆盖的是只有真实启动 Electron 才暴露的那一层：
 *   · 点「留为会话」→ 侧栏**真的**出现一条新会话（标题 = 模型名 · 问题摘要，
 *     cwd 落在用户工作空间而不是 compare 目录）；
 *   · 「去这条会话 →」真的跳进那条会话：能看到这轮问答（**不含**另一列的回答），
 *     还能继续对话（等 mock 真收到第 2 轮，不是「没报错」）；
 *   · 同列再留被明确拒绝、不产生孪生；没留的列依旧即弃；
 *   · failed / cancelled 列没有「留为会话」按钮；
 *   · 统计把留下的会话当普通会话计入。
 *
 * ## 为什么「新会话出现在侧栏」是本功能最要紧的一条 e2e
 *
 * daemon 侧的文件手术（剔除 compare_run + 重接 parentId + 改写 cwd）有 22 条单测
 * （tests/unit/compare-keep.test.mjs），但「标记没摘掉」在 e2e 层的表现是**新会话
 * 被 listSessions 静默过滤** —— 单测钉的是行数组，这条钉的是「用户真的看得到」。
 * 反过来说：手术坏了，③ 必红；手术好了、列表推送坏了，③ 也红。
 *
 * ## 判据的反同义反复设计（测试规范 §三.12）
 *
 *   · 两列的模型名、回复、用量**刻意不同** —— 否则「不含列 B 的回答」「标题含该列
 *     模型名」全是恒真断言；
 *   · 「统计计入了新会话」必须以 keep 之前的基线为对照（delta = 恰好 +1），
 *     而不是「统计里有东西」；
 *   · 「继续对话收到回复」等的是 mockA 的第 2 轮请求（对端副作用），
 *     文本回复与第 1 轮相同，所以判据用**助手条目数 +1**，不用文本 includes。
 *
 * ## 点「停止」的节奏
 *
 * 停止是 arm + 3 秒窗口内再点的二次确认。两次点击**必须隔着一次真实重渲染**
 * （第一次点击把 arm 状态写进 React state，第二次点击的处理器要从新闭包里读到它；
 * 同一个 JS 任务里连点两下只会 arm 两次）。等 `.stop-confirm-kbd` 出现就是
 * 「arm 已生效」的信号 —— 这与多模型对比用例里「连点模型」那条的教训同源。
 *
 * ## 反向验证记录（2026-10-08，逐条真跑：注入 → `npm run build` → 跑 → 还原 → 再跑）
 *
 * e2e 跑的是 `out/` 的构建产物，**每次注入都必须先重建**（测试规范 §四.1）。
 * 注入面在渲染层 `src/renderer/src/app.js`：
 *
 * | 注入 | 结果 |
 * | --- | --- |
 * | `renderKeepSlot` 去掉 `status !== "done"` 守卫（任何有正文的列都给按钮） | **恰好 ⑩ 红**：`取消列不该有「留为会话」按钮（data-keep=idle）`；其余 9 条仍绿。失败列没红是**结构性的**：它没有正文条目、连操作行都不渲染，这条注入碰不到它 —— 这正是把取消列单独做成一条断言的原因（§四.0：注入打在哪一层，哪条断言才红） |
 * | 「去这条会话 →」跳到不存在的路径 | **⑦ 红在根因上**（等「进入留下的会话」超时：resume 失败、视图停在对比屏），⑧⑨⑩ 是它的**级联**（⑧ 要的对话页没到；⑨ 的名单前提因没离开对比屏而不成立；⑩ 继承 ⑨ 的菜单现场） |
 *
 * 还原判据：`diff` 备份文件逐字节一致。
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

/** macOS 用 ⌘（Meta），Windows/Linux 用 Ctrl —— 与 app.js 的 PALETTE_MOD 同口径。 */
const MOD = process.platform === "darwin" ? "Meta" : "Control";

const REPLY_A = "ALPHA 留下这一列，会收进侧栏成为一条会话";
const REPLY_B = "BETA 这一列不留，它的回答不该出现在任何会话里";
const USAGE_A = { prompt_tokens: 700, completion_tokens: 210 };
const USAGE_B = { prompt_tokens: 300, completion_tokens: 40 };
/** 短于 40 字：留下的标题应逐字等于 `Mock Alpha · 问题`，不触发截断省略号。 */
const QUESTION = "帮我把这轮对比收进会话";

/** 三台 mock 各司其职：A 是要留的那列，B 是对照（不留），Fail 造失败列。 */
const PROVIDERS = [
	{ id: "keep-a", name: "Alpha 服务", baseUrl: null, model: { id: "alpha-model", name: "Mock Alpha" } },
	{ id: "keep-b", name: "Beta 服务", baseUrl: null, model: { id: "beta-model", name: "Mock Beta" } },
	{ id: "keep-fail", name: "Fail 服务", baseUrl: null, model: { id: "fail-model", name: "Mock Fail" } },
];

const h = createHarness({ name: "compare-keep" });
// harness 负责隔离与清空工作区根目录，目录本身要由用例建出来
mkdirSync(h.WORKSPACE_DIR, { recursive: true });

const mockA = await startMockModelServer({ reply: REPLY_A, usage: USAGE_A, models: ["alpha-model"], delayMs: 150 });
const mockB = await startMockModelServer({ reply: REPLY_B, usage: USAGE_B, models: ["beta-model"], delayMs: 600 });
const mockFail = await startMockModelServer({ reply: "这一台刻意失败，回复不该出现在界面上", models: ["fail-model"], failWith: 400 });
PROVIDERS.find((p) => p.id === "keep-a").baseUrl = mockA.baseUrl;
PROVIDERS.find((p) => p.id === "keep-b").baseUrl = mockB.baseUrl;
PROVIDERS.find((p) => p.id === "keep-fail").baseUrl = mockFail.baseUrl;
const ALL_MOCKS = [mockA, mockB, mockFail];
console.log(`✓ 三台 mock 已就绪：A=${mockA.port} B=${mockB.port} Fail=${mockFail.port}`);

await h.launch();
const win = h.window();

/* ══════════════════════════════════════════════════════════════════════
 * 页面侧的探针
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 把列事件原样记一份到页面里（与 CompareView 自己的订阅各自独立）。
 * 与多模型对比那份 recorder 的差异：这里**多记 modelKey** —— 本用例要从账本里
 * 反查「alpha 那一列的 runId + columnId」（同列再留那条要拿它直接调 IPC）。
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
				modelKey: event.modelKey,
				delta: event.delta,
				outcome: event.outcome,
			});
		});
		return true;
	});

const readCompareLog = () => win.evaluate(() => window.__compareLog ?? []);

const compareViewMounted = () => win.evaluate(() => document.querySelector(".compare-grid") !== null);

/** 每列读成一份可断言的东西（`title` 是 `服务商名/模型 id`，用来认列，不靠下标）。 */
const readColumns = () =>
	win.evaluate(() =>
		[...document.querySelectorAll(".compare-col")].map((column) => ({
			title: column.querySelector(".turn-agent")?.getAttribute("title") ?? "",
			name: (column.querySelector(".turn-agent")?.textContent ?? "").trim(),
			status: column.getAttribute("data-status"),
			text: (column.querySelector(".markdown")?.innerText ?? "").trim(),
			keep: column.querySelector("[data-keep]")?.getAttribute("data-keep") ?? null,
			keepText: (column.querySelector("[data-keep]")?.textContent ?? "").trim() || null,
			jump: (column.querySelector(".entry-toolbar .bar-btn-text")?.textContent ?? "").trim() || null,
			toastTexts: [...document.querySelectorAll(".toast")].map((toast) => (toast.textContent ?? "").trim()),
		})),
	);

/** 按 `title` 认一列（列序会随点选顺序变，所以不按下标取）。 */
const columnFor = (columns, modelId) => columns.find((column) => column.title.endsWith(`/${modelId}`)) ?? null;

const readMenuState = () =>
	win.evaluate(() => ({
		picked: [...document.querySelectorAll(".pop-menu.model-menu .model-menu-item")].filter((item) => item.classList.contains("active")).map((item) => (item.querySelector(".model-menu-name")?.textContent ?? "").trim()),
	}));

/** 打开对比屏的多选菜单。 */
async function openModelMenu() {
	await win.evaluate(() => document.querySelector(".composer-card .model-chip")?.click());
	await waitUntil(() => win.evaluate(() => document.querySelector(".pop-menu.model-menu") !== null), {
		timeout: 15_000,
		desc: "对比屏的模型多选菜单挂上（.pop-menu.model-menu）",
	});
}

async function closeModelMenu() {
	await win.evaluate(() => document.querySelector(".composer-card .menu-zone .ws-backdrop")?.click());
	await waitUntil(() => win.evaluate(() => document.querySelector(".pop-menu.model-menu") === null), {
		timeout: 15_000,
		desc: "模型菜单关闭",
	});
}

const pickModel = (name) =>
	win.evaluate((target) => {
		const item = [...document.querySelectorAll(".pop-menu.model-menu .model-menu-item")].find(
			(button) => (button.querySelector(".model-menu-name")?.textContent ?? "").trim() === target,
		);
		if (item === undefined) return false;
		item.click();
		return true;
	}, name);

/** 从 ⌘K 打开对比屏。 */
async function openCompareFromPalette() {
	await win.keyboard.press(`${MOD}+k`);
	await waitUntil(() => win.evaluate(() => document.querySelector(".command-palette") !== null), {
		timeout: 15_000,
		desc: "命令面板出现（.command-palette）",
	});
	await win.locator(".command-palette-input").fill("对比多个模型");
	await win.keyboard.press("Enter");
	await waitUntil(compareViewMounted, { timeout: 20_000, desc: "对比屏挂上（.compare-grid）" });
}

/** 提交一个问题（走真实键位：填 textarea + Enter）。 */
async function submitQuestion(text) {
	const box = win.locator('textarea[aria-label="对比的问题"]');
	await box.waitFor({ state: "visible", timeout: 20_000 });
	await box.fill(text);
	await box.press("Enter");
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

/** 侧栏与会话列表的快照（RPC 口径 —— 侧栏 DOM 的断言在 ⑥ 跳过去之后做）。 */
const readSessions = () =>
	win.evaluate(async () => {
		const k = globalThis.kami;
		const [stats, sessions] = await Promise.all([k.usageStats(), k.listSessions()]);
		return {
			totalSessions: stats.totalSessions,
			tokenTotal: stats.totalTokens.total,
			list: sessions.map((s) => ({ path: s.path, title: s.title, cwd: s.cwd, isTempTask: s.isTempTask === true })).sort((a, b) => a.path.localeCompare(b.path)),
		};
	});

/** 切主题（截图用）。 */
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
 * ① 准备：三个服务商 + 基线
 * ══════════════════════════════════════════════════════════════════════ */

await installCompareRecorder();

await h.check("① 准备：注册三个服务商指向三台 mock，工作空间设为本用例的隔离目录", async () => {
	const result = await win.evaluate(
		async ({ providers, workspace }) => {
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
				await k.setWorkspace(workspace);
				// 「去这条会话 →」走 resumeSession，而它要求**全局已选模型**（与资料库
				// 「定位到来源会话」同一条既有约束 —— library.mjs 有同款踩坑注释：
				// 没配可用模型时 resume 现场建宿主会假红）。这里选 A 列那个模型。
				await k.setModel("keep-a/alpha-model");
				const snapshot = await k.settingsSnapshot();
				return { ok: true, keys: (snapshot?.models ?? []).filter((m) => m.available).map((m) => `${m.providerId}/${m.id}`) };
			} catch (error) {
				return { ok: false, err: String(error?.message ?? error).slice(0, 300) };
			}
		},
		{ providers: PROVIDERS, workspace: h.WORKSPACE_DIR },
	);
	assert.ok(result.ok, `配置失败：${result.err}`);
	const missing = PROVIDERS.map((p) => `${p.id}/${p.model.id}`).filter((key) => !result.keys.includes(key));
	assert.deepEqual(missing, [], `这些模型没进可用清单：${missing.join(", ")}`);
});

/** keep 之前的基线：后面断言「恰好多一条」「统计恰好 +1」都以它为对照。 */
const before = await readSessions();

/* ══════════════════════════════════════════════════════════════════════
 * ② 一轮对比跑完：两列 done，都有「留为会话」按钮
 * ══════════════════════════════════════════════════════════════════════ */

const logBeforeRun1 = (await readCompareLog()).length;

await h.check("② 两列跑完：列尾出现「留为会话」按钮（data-keep=idle，title 说明去向）", async () => {
	await openCompareFromPalette();
	await openModelMenu();
	// 进屏时会把「当前会话的模型」预选成第一个参赛者（① 里 setModel 设的就是
	// Alpha）—— 先去掉再选，与 multi-model-compare ② 的处理同款。
	const initial = await readMenuState();
	if (initial.picked.includes("Mock Alpha")) {
		assert.ok(await pickModel("Mock Alpha"), "去掉预选时找不到「Mock Alpha」");
		await waitUntil(async () => (await readMenuState()).picked.length === 0, { timeout: 10_000, desc: "预选被去掉" });
	}
	assert.ok(await pickModel("Mock Alpha"), "菜单里没有「Mock Alpha」");
	assert.ok(await pickModel("Mock Beta"), "菜单里没有「Mock Beta」");
	await waitUntil(async () => (await readMenuState()).picked.length === 2, { timeout: 10_000, desc: "两个模型都进了名单" });
	await closeModelMenu();
	await submitQuestion(QUESTION);

	await waitForRunFinished(logBeforeRun1);
	await h.waitForSettled();
	await h.shoot("compare-done-light");

	const columns = await readColumns();
	const alpha = columnFor(columns, "alpha-model");
	const beta = columnFor(columns, "beta-model");
	assert.ok(alpha !== null && beta !== null, `认不出两列：${JSON.stringify(columns.map((c) => c.title))}`);
	assert.equal(alpha.status, "done", `A 列状态是 ${alpha.status}`);
	assert.equal(beta.status, "done", `B 列状态是 ${beta.status}`);
	assert.equal(alpha.keep, "idle", `A 列没有「留为会话」按钮（data-keep=${alpha.keep}）`);
	assert.equal(beta.keep, "idle", `B 列没有「留为会话」按钮（data-keep=${beta.keep}）`);
	assert.equal(alpha.keepText, "留为会话", `A 列按钮文案是「${alpha.keepText}」`);
});

/* ══════════════════════════════════════════════════════════════════════
 * ③ 点 A 列「留为会话」→ 侧栏出现新会话
 * ══════════════════════════════════════════════════════════════════════ */

/** A 列在 daemon 登记表里的坐标（同列再留那条直接调 IPC 用）。 */
let alphaRun1;

await h.check("③ 点 A 列「留为会话」：按钮转「已留为会话」+ 跳转键；侧栏恰好多一条，标题与 cwd 都对", async () => {
	// 从账本反查 A 列的 runId + columnId（column_queued 带 modelKey）
	const log = await readCompareLog();
	const queued = log.find((event) => event.kind === "column_queued" && event.modelKey === "keep-a/alpha-model");
	assert.ok(queued !== undefined, "账本里没有 alpha 那一列的 column_queued（modelKey 没记？）");
	alphaRun1 = { runId: queued.runId, columnId: queued.columnId };

	await win.evaluate((columnId) => {
		const column = [...document.querySelectorAll(".compare-col")].find((c) => c.querySelector(".turn-agent")?.getAttribute("title")?.endsWith("/alpha-model"));
		const button = column?.querySelector("[data-keep]");
		if (columnId !== null && button === undefined) return;
		button?.click();
	}, null);

	// 按钮就地走完三段：idle → saving/kept（saving 是几十毫秒的事，直接等终态）
	const kept = await waitUntil(
		async () => {
			const columns = await readColumns();
			const alpha = columnFor(columns, "alpha-model");
			return alpha?.keep === "kept" ? alpha : null;
		},
		{ timeout: 30_000, interval: 50, desc: "A 列转成已留态（data-keep=kept）" },
	);
	assert.equal(kept.keepText, "已留为会话", `已留按钮文案是「${kept.keepText}」`);
	assert.equal(kept.jump, "去这条会话 →", `跳转键文案是「${kept.jump}」`);
	// 成功不弹 toast（design-spec：就地持续态强于瞬态提示）——此刻若有 error toast 就是失败路径
	assert.ok(!kept.toastTexts.some((text) => text.includes("没能留为会话")), `出现了失败 toast：${JSON.stringify(kept.toastTexts)}`);

	await h.shoot("compare-kept-light");

	// 侧栏（RPC 口径）：恰好多一条，标题逐字等于「模型名 · 问题」，cwd 是用户工作空间
	const after = await waitUntil(
		async () => {
			const snapshot = await readSessions();
			return snapshot.list.length === before.list.length + 1 ? snapshot : null;
		},
		{ timeout: 30_000, interval: 100, desc: `会话列表从 ${before.list.length} 条变成恰好多一条` },
	);
	const added = after.list.filter((item) => !before.list.some((old) => old.path === item.path));
	assert.equal(added.length, 1, `新增的会话不是恰好一条：${JSON.stringify(added)}`);
	assert.equal(added[0].title, `Mock Alpha · ${QUESTION}`, `新会话标题不对：「${added[0].title}」`);
	assert.equal(added[0].cwd, h.WORKSPACE_DIR, `新会话的 cwd 是 ${added[0].cwd} —— 应该是用户工作空间`);
	assert.notEqual(added[0].isTempTask, true, "新会话被记成了任务区会话");

	// 统计把它当普通会话计入：会话数 +1，token 总量真的动了（mockA 带 usage）
	assert.equal(after.totalSessions, before.totalSessions + 1, `统计的会话数没 +1（${before.totalSessions} → ${after.totalSessions}）`);
	assert.ok(after.tokenTotal > before.tokenTotal, `统计的 token 总量没动（${before.tokenTotal} → ${after.tokenTotal}）—— 留下的会话没被计入统计`);
});

/* ══════════════════════════════════════════════════════════════════════
 * ④ 没留的那列依旧即弃；没有 compare 空间组；深色截图
 * ══════════════════════════════════════════════════════════════════════ */

await h.check("④ 列 B 不出现在会话列表；没有任何会话落在 compare 目录（侧栏不会多出 compare 组）", async () => {
	const after = await readSessions();
	assert.ok(
		!after.list.some((item) => item.title.startsWith("Mock Beta ·")),
		`没留的 B 列也出现在列表里：${JSON.stringify(after.list.map((s) => s.title))}`,
	);
	/*
	 * 判据是 cwd 的 **basename 恰好是 compare**（侧栏组名取 basename），不是子串 ——
	 * 本用例的工作空间目录名本身就含 "compare-keep"（harness 名），子串匹配必误报。
	 */
	assert.ok(
		!after.list.some((item) => item.cwd.endsWith("/compare")),
		`有会话的 cwd 落在 compare 目录：${JSON.stringify(after.list.filter((s) => s.cwd.endsWith("/compare")))}`,
	);
	// B 列的按钮原样（idle，可点）——留 A 不影响 B
	const columns = await readColumns();
	const beta = columnFor(columns, "beta-model");
	assert.equal(beta.keep, "idle", `B 列的按钮被动了（data-keep=${beta.keep}）`);
});

await h.check("⑤ 深色下已留态正常渲染（截图 + 像素断言）", async () => {
	await setTheme("dark");
	await h.shoot("compare-kept-dark");
	await setTheme("light");
});

/* ══════════════════════════════════════════════════════════════════════
 * ⑥ 同列再留被明确拒绝，不产生孪生
 * ══════════════════════════════════════════════════════════════════════ */

await h.check("⑥ 同列再点（直接调 IPC）：明确报「已经留为会话」，列表一条不多", async () => {
	assert.ok(alphaRun1 !== undefined, "③ 没拿到 A 列的 runId/columnId");
	const result = await win.evaluate(async (coords) => globalThis.kami.compareKeep(coords.runId, coords.columnId), alphaRun1);
	assert.ok(result?.ok !== true, `第二次留竟然成功了：${JSON.stringify(result)}`);
	assert.ok(
		typeof result?.error === "string" && result.error.includes("已经留为会话"),
		`拒绝理由没说清「已留过」：${JSON.stringify(result)}`,
	);
	const after = await readSessions();
	assert.equal(after.list.length, before.list.length + 1, `第二次留产生了孪生会话（${after.list.length} 条，应恰好 ${before.list.length + 1}）`);
	const titled = after.list.filter((item) => item.title === `Mock Alpha · ${QUESTION}`);
	assert.equal(titled.length, 1, `同标题的会话有 ${titled.length} 条 —— 孪生了`);
});

/* ══════════════════════════════════════════════════════════════════════
 * ⑦ 「去这条会话 →」：跳进那条会话，看到这轮问答（不含 B），还能继续对话
 * ══════════════════════════════════════════════════════════════════════ */

await h.check("⑦ 「去这条会话 →」进入会话：能看到问题与 A 列回答（不含 B），侧栏 DOM 也没有 compare 组", async () => {
	await win.evaluate(() => {
		const column = [...document.querySelectorAll(".compare-col")].find((c) => c.querySelector(".turn-agent")?.getAttribute("title")?.endsWith("/alpha-model"));
		[...column.querySelectorAll(".entry-toolbar .bar-btn-text")].find((button) => button.textContent?.trim() === "去这条会话 →")?.click();
	});
	await waitUntil(() => win.evaluate(() => document.querySelector('[aria-label="消息输入框"]') !== null), {
		timeout: 30_000,
		desc: "进入留下的会话（对话页输入框出现）",
	});
	await h.waitForSettled();
	await h.shoot("kept-session-chat-light");

	const body = await win.evaluate(() => document.body.innerText);
	assert.ok(body.includes(QUESTION), `会话里看不到用户的问题（${QUESTION}）`);
	assert.ok(body.includes(REPLY_A), `会话里看不到 A 列的回答`);
	assert.ok(!body.includes(REPLY_B), "会话里混进了 B 列的回答 —— 留错了列");

	// 侧栏 DOM：留下那条真的在侧栏里；空间组里没有 compare
	const sidebar = await win.evaluate(() => ({
		titles: [...document.querySelectorAll(".task-item-title")].map((node) => (node.textContent ?? "").trim()),
		groups: [...document.querySelectorAll(".space-group-name")].map((node) => (node.textContent ?? "").trim()),
	}));
	assert.ok(
		sidebar.titles.some((title) => title === `Mock Alpha · ${QUESTION}`),
		`侧栏会话行里没有留下的那条：${JSON.stringify(sidebar.titles)}`,
	);
	// 组名判据同样是**恰好叫 compare**（组名取 cwd 的 basename；本用例工作空间名含
	// "compare-keep"，子串匹配必误报）。
	assert.ok(
		!sidebar.groups.some((group) => group.toLowerCase() === "compare"),
		`侧栏出现了 compare 空间组：${JSON.stringify(sidebar.groups)}`,
	);
});

await h.check("⑧ 在留下的会话里继续对话：发一条能收到回复（等 mock 真收到第 2 轮）", async () => {
	const tailBefore = await win.evaluate(() => document.querySelectorAll(".entry.assistant").length);
	const box = win.locator('[aria-label="消息输入框"]');
	await box.fill("继续说说你的看法");
	await box.press("Enter");
	await waitUntil(() => mockA.requests.length >= 2, { timeout: 60_000, interval: 100, desc: "mockA 收到第 2 轮请求（留下会话的后续对话）" });
	assert.equal(mockA.requests[1].body.model, "alpha-model", `留下会话的后续消息打到了别的模型：${mockA.requests[1].body.model}`);
	// 回复文本与第 1 轮相同（同一台 mock），判据用助手条目数 +1，不用文本 includes
	await waitUntil(
		async () => {
			const count = await win.evaluate(() => document.querySelectorAll(".entry.assistant").length);
			return count > tailBefore ? count : null;
		},
		{ timeout: 60_000, interval: 200, desc: "后续回复渲染到会话里（助手条目多了一条）" },
	);
});

/* ══════════════════════════════════════════════════════════════════════
 * ⑨ 失败列与取消列都没有「留为会话」按钮
 * ══════════════════════════════════════════════════════════════════════ */

await h.check("⑨ 失败列没有「留为会话」按钮，成功列照常有", async () => {
	const logBefore = (await readCompareLog()).length;
	await openCompareFromPalette();
	// 重进后名单重置：从聊天页进来会把「当前会话的模型」预选成第一个（A），
	// 再加一台 Fail —— 名单 = A + Fail。
	await openModelMenu();
	const picked = await readMenuState();
	if (!picked.picked.includes("Mock Alpha")) assert.ok(await pickModel("Mock Alpha"), "菜单里没有「Mock Alpha」");
	assert.ok(await pickModel("Mock Fail"), "菜单里没有「Mock Fail」");
	await waitUntil(async () => (await readMenuState()).picked.length === 2, { timeout: 10_000, desc: "名单凑齐两个（Alpha + Fail）" });
	await closeModelMenu();
	await submitQuestion(QUESTION);

	await waitForRunFinished(logBefore);
	await h.waitForSettled();
	await h.shoot("compare-failed-round-light");

	const columns = await readColumns();
	const alpha = columnFor(columns, "alpha-model");
	const failed = columnFor(columns, "fail-model");
	assert.ok(alpha !== null && failed !== null, `认不出两列：${JSON.stringify(columns.map((c) => c.title))}`);
	assert.equal(failed.status, "failed", `失败列状态是 ${failed.status}`);
	assert.equal(failed.keep, null, `失败列不该有「留为会话」按钮（data-keep=${failed.keep}）`);
	assert.ok(!JSON.stringify(columns).includes("留为会话") || alpha.keep !== null, "失败列界面上出现了留为会话字样");
	assert.equal(alpha.status, "done", `成功列状态是 ${alpha.status}`);
	assert.equal(alpha.keep, "idle", `新一轮的成功列应该重新有按钮（data-keep=${alpha.keep}）`);
});

await h.check("⑩ 取消列（有半截正文）也没有「留为会话」按钮", async () => {
	const logBefore = (await readCompareLog()).length;
	await openModelMenu();
	// 名单换成 B（慢，600ms/片）+ Fail：停掉时 B 还在流式，留下半截正文
	assert.ok(await pickModel("Mock Alpha"), "菜单里没有「Mock Alpha」（去掉它）");
	assert.ok(await pickModel("Mock Beta"), "菜单里没有「Mock Beta」");
	await waitUntil(
		async () => {
			const menu = await readMenuState();
			return menu.picked.length === 2 && menu.picked.includes("Mock Beta") ? menu : null;
		},
		{ timeout: 10_000, interval: 50, desc: "名单换成「Mock Beta + Mock Fail」" },
	);
	await closeModelMenu();
	await submitQuestion(QUESTION);

	// 等 B 列真的开始流出正文（半截正文的取消列才有测试价值：复制在、留不该在）
	await waitUntil(
		async () => {
			const columns = await readColumns();
			const beta = columnFor(columns, "beta-model");
			return beta !== null && beta.text !== "" ? beta : null;
		},
		{ timeout: 60_000, interval: 50, desc: "B 列流出第一片正文" },
	);
	// 停止是 arm + 3 秒窗口内再点：两次点击必须隔着一次真实重渲染（见文件头）
	await win.evaluate(() => document.querySelector(".send-btn.stop")?.click());
	await waitUntil(() => win.evaluate(() => document.querySelector(".stop-confirm-kbd") !== null), {
		timeout: 10_000,
		desc: "停止键进入待确认态（.stop-confirm-kbd）",
	});
	await win.evaluate(() => document.querySelector(".send-btn.stop")?.click());
	await waitForRunFinished(logBefore);
	await h.waitForSettled();
	await h.shoot("compare-cancelled-round-light");

	const columns = await readColumns();
	const beta = columnFor(columns, "beta-model");
	assert.ok(beta !== null, `认不出 B 列：${JSON.stringify(columns.map((c) => c.title))}`);
	assert.equal(beta.status, "cancelled", `B 列状态是 ${beta.status}（应已取消）`);
	assert.ok(beta.text !== "", "B 列没有半截正文 —— 这条断言测不出「取消列不给按钮」");
	assert.equal(beta.keep, null, `取消列不该有「留为会话」按钮（data-keep=${beta.keep}）`);
});

// 收尾顺序按 testing spec §五.3：先关应用，再关 mock
await h.app().close();
for (const mock of ALL_MOCKS) await mock.close();
await h.finish();
