/**
 * 资料库（侧栏「资料库」）的 GUI 端到端测试（任务 10-03-library，对应 Issue #115）。
 *
 * 数据面（`src/main/daemon/library.js` 的解析 / 去重 / 截断）已有单测
 * （`tests/unit/library-aggregate.test.mjs`）。**本文件补的是只有真实启动 Electron
 * 才暴露的那层**：侧栏项真的可点、视图真的挂上、IPC 真的通、DOM 真的渲染出列表、
 * 失效标记真的出现、「定位到来源会话」真的跳过去。
 *
 * ## 为什么用「预置会话文件」造产物，而不是跑 mock 模型
 *
 * 交付链路本身已由 `tests/e2e/artifact-present.mjs` 覆盖（present_files → 事件 → 卡片）。
 * 本文件要验的是**聚合**（跨会话读 .jsonl 里的 artifacts_presented 条目），
 * 直接往隔离配置目录里写会话 .jsonl 即可，**比跑一个模型回合快得多，也不依赖网络**。
 * 会话文件形态取自 `research/feasibility.md` §1.4 的磁盘原文。
 *
 * ## 七条断言（design.md §4「GUI」）
 *
 *   ① 侧栏「资料库」可点（不是 disabled），且不在「规划中」组里
 *   ② 全新环境 → 空态（不是加载态、不是错误态），且含「怎么产生产物」的指引
 *   ③ 预置产物后 → 列表出现该产物，名称 / 来源会话标题 / 大小都正确
 *   ④ 删掉产物文件 → 刷新 → 该条标出失效（且行没有消失）
 *   ⑤ 点「定位到来源会话」→ 真的进到那个会话
 *   ⑥ 浅色 + 深色两套主题截图 + 像素断言
 *   ⑦ 两个会话交付同一路径 → 只有一行，且标出「共 2 个会话交付过」
 *
 * ## 反向验证记录（必做，两条都真跑并还原）
 *
 * （1）把去重去掉 → ⑦ 变红。做法：在 `library.js` 的 `aggregateLibraryArtifacts`
 *     里把 `byPath` 的 key 从 `artifact.path` 改成 `${artifact.path}\u0000${sessionMeta.id}`
 *     （同一路径来自不同会话就各占一行）。重建后重跑，实测输出：
 *
 *       [FAIL] ⑦ 两个会话交付同一路径：只有一行，且标出「共 2 个会话交付过」
 *              —— 同一路径应全局去重成一行，实际 2 行：["200 B · 做销售表 · 19:00 | …",
 *              "100 B · 帮我写季度复盘 · 18:00"]；2 !== 1
 *
 *     其余 8 条**全绿**（① ② ③ ⑥ ⑤ ④ 与准备项、渲染层异常）—— 恰好只打中 ⑦。还原后全绿。
 *
 * （2）把空态与加载态的判据合并 → ② 变红。做法：在 `LibraryView` 里把
 *     `data.artifacts.length === 0 ? <EmptyState/> : …` 改成 `… ? <LoadingState/> : …`
 *     （即「没有产物」也渲染成加载态）。重建后重跑，实测输出：
 *
 *       [FAIL] ② 全新环境：进入资料库是空态（非加载 / 非错误），且空态教人怎样产生产物
 *              —— 应有空态 .state-empty，实际 loading=true error=false
 *
 *     其余 8 条**全绿**。还原后全绿。
 *
 *     ⚠️ 刻意**不是** design.md 字面写的方向（「undefined 也渲染空态」）：
 *     那个方向在本用例上**不会变红** —— listLibrary 是本地读盘，几十毫秒内就返回，
 *     `data === undefined` 的那一帧在 `waitForSettled` 之前早已过去了，最终落在
 *     空结果 → 仍是空态。要让 ② 真的检验「空态与加载态可辨」，注入必须是
 *     「空结果渲染成加载态」（把空态判据并入加载态），这才是与 ② 直接对立的那条。
 *
 * ## ⚠️ 关于等待
 *
 * 所有 `waitUntil` 的谓词都**能返回假值**（见 `.trellis/spec/testing/index.md`）——
 * 不写 `() => win.evaluate(() => ({...}))` 那种恒真形态。导航后、进入视图后是空闲态，
 * 可以用 `waitForSettled()`；但**不要在模型回合进行中用**它（本项目实测会等到超时）。
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const h = createHarness({ name: "library" });
await h.launch();
const win = h.window();

const SESSIONS_DIR = join(h.CONFIG_DIR, "sessions");
const WORKSPACE_DIR = h.WORKSPACE_DIR;

// 两个工作区目录（resumeSession 会校验会话 header 的 cwd 是存在的目录）
const WS_A = join(WORKSPACE_DIR, "wsA");
const WS_B = join(WORKSPACE_DIR, "wsB");
mkdirSync(WS_A, { recursive: true });
mkdirSync(WS_B, { recursive: true });

// 产物文件（必须真实存在，聚合时 statSync 才为 exists:true）
const UNIQUE_PATH = join(WS_A, "唯一报告.md"); // 只有会话 A 交付
const SHARED_PATH = join(WS_A, "共享产物.md"); // A 与 B 都交付（验跨会话去重）

// ── 预置会话文件的配方（见文件头）────────────────────────────────
let sessionSeq = 0;
function sessionFile({ id, cwd, firstText, artifacts }) {
	sessionSeq += 1;
	const name = `2026-10-03T12-00-${String(sessionSeq).padStart(2, "0")}-000Z_${id}.jsonl`;
	const lines = [
		JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd }),
		JSON.stringify({
			type: "message",
			id: `${id}-m0`,
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: [{ type: "text", text: firstText }] },
		}),
	];
	for (const [index, artifact] of artifacts.entries()) {
		lines.push(
			JSON.stringify({
				type: "custom",
				customType: "artifacts_presented",
				data: { files: [{ path: artifact.path, size: artifact.size, html: false, kind: "local" }], focusFile: artifact.path },
				id: `${id}-a${index}`,
				parentId: `${id}-m0`,
				timestamp: artifact.deliveredAt,
			}),
		);
	}
	writeFileSync(join(SESSIONS_DIR, name), `${lines.join("\n")}\n`);
}

/** 写入两个会话：A 交付唯一 + 共享；B 交付共享（更晚一次）。 */
function seedSessions() {
	mkdirSync(SESSIONS_DIR, { recursive: true });
	writeFileSync(UNIQUE_PATH, "# 唯一报告\n\n只有会话 A 交付过的产物。\n");
	writeFileSync(SHARED_PATH, "# 共享产物\n\n被两个会话交付过。\n");
	sessionFile({
		id: "11111111-1111-7111-8111-111111111111",
		cwd: WS_A,
		firstText: "帮我写季度复盘",
		artifacts: [
			{ path: UNIQUE_PATH, size: 42, deliveredAt: "2026-10-03T10:00:00.000Z" },
			{ path: SHARED_PATH, size: 100, deliveredAt: "2026-10-03T10:00:05.000Z" },
		],
	});
	sessionFile({
		id: "22222222-2222-7222-8222-222222222222",
		cwd: WS_B,
		firstText: "做销售表",
		artifacts: [{ path: SHARED_PATH, size: 200, deliveredAt: "2026-10-03T11:00:00.000Z" }],
	});
}

// ── DOM 工具 ────────────────────────────────────────────────────

/** 点侧栏导航项（按精确文字），并确认它真的是可点的按钮。 */
const clickNav = async (label) => {
	const ok = await win.evaluate((text) => {
		const btn = [...document.querySelectorAll(".sidebar-nav button")].find((b) => (b.textContent ?? "").trim() === text);
		if (btn === undefined || btn.disabled) return false;
		btn.click();
		return true;
	}, label);
	assert.ok(ok, `侧栏找不到可点的「${label}」导航项`);
};

/** 等资料库视图挂上（页头 h1 = 资料库）。 */
const waitLibrary = () =>
	waitUntil(
		() => win.evaluate(() => document.querySelector("main.settings h1")?.textContent === "资料库"),
		{ timeout: 15_000, desc: "进入资料库视图" },
	);

/** 读当前资料库视图的可观察状态（一次求值拿全，避免多次往返）。 */
const readLibrary = () =>
	win.evaluate(() => {
		const main = document.querySelector("main.settings");
		if (main === null) return { present: false };
		const rows = [...main.querySelectorAll(".auto-row")].map((row) => ({
			name: (row.querySelector(".auto-row-name")?.textContent ?? "").trim(),
			meta: [...row.querySelectorAll(".auto-row-meta")]
				.map((m) => (m.textContent ?? "").trim())
				.filter((t) => t !== "")
				.join(" | "),
			missed: row.querySelector(".auto-badge-missed") !== null,
			ops: [...row.querySelectorAll(".auto-row-ops button")].map((b) => (b.textContent ?? "").trim()),
		}));
		return {
			present: true,
			title: (main.querySelector("h1")?.textContent ?? "").trim(),
			empty: main.querySelector(".state-empty") !== null,
			loading: main.querySelector(".state-loading") !== null,
			error: main.querySelector(".state-error") !== null,
			emptyTitle: (main.querySelector(".state-empty-title")?.textContent ?? "").trim(),
			emptyDesc: (main.querySelector(".state-empty-desc")?.textContent ?? "").trim(),
			newTask: main.querySelector(".state-empty-action .primary-btn") !== null,
			rows,
		};
	});

/** 点页头的「刷新」（重新拉一次 IPC —— 列表数据是拉式的，不会自己变）。 */
const clickRefresh = () =>
	win.evaluate(() => {
		const btn = [...document.querySelectorAll("main.settings .settings-head .mini-btn")].find(
			(b) => (b.textContent ?? "").trim() === "刷新",
		);
		if (btn === undefined) throw new Error("资料库页头找不到「刷新」按钮");
		btn.click();
	});

/** 轮询直到 readLibrary() 满足谓词（谓词必须能返回假值 —— 拿不到就返回 null）。 */
const waitLibraryState = (pred, desc) =>
	waitUntil(async () => {
		const state = await readLibrary();
		return pred(state) ? state : null;
	}, { timeout: 15_000, desc });

// ══ ① 侧栏「资料库」可点，且不在「规划中」组里 ══════════════════════
await h.check("① 侧栏「资料库」可点（不是 disabled），且已不在「规划中」组里", async () => {
	const r = await win.evaluate(() => {
		const nav = document.querySelector(".sidebar-nav");
		if (nav === null) return { found: false };
		const btn = [...nav.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "资料库");
		if (btn === undefined) return { found: false };
		return {
			found: true,
			disabled: btn.disabled,
			// 「规划中」组是 .sidebar-section；已就绪项直挂 .sidebar-nav
			inPlanningGroup: btn.closest(".sidebar-section") !== null,
			navText: nav.innerText,
		};
	});
	assert.ok(r.found, "侧栏里找不到「资料库」导航项");
	assert.equal(r.disabled, false, "「资料库」应是可点按钮，实际是 disabled —— 还在「规划中」组里吗？");
	assert.equal(r.inPlanningGroup, false, "「资料库」不应属于「规划中」分组（.sidebar-section）");
	const iLib = r.navText.indexOf("资料库");
	const iPlan = r.navText.indexOf("规划中");
	assert.ok(iLib >= 0, `侧栏文字里没有「资料库」：${JSON.stringify(r.navText)}`);
	assert.ok(iPlan >= 0, `侧栏文字里没有「规划中」组标题：${JSON.stringify(r.navText)}`);
	assert.ok(iLib < iPlan, "「资料库」应排在「规划中」之前（它已就绪，不在未开放组里）");
});

// ══ ② 全新环境 → 空态（不是加载态、不是错误态），且含教学文案 ═════════
await h.check("② 全新环境：进入资料库是空态（非加载 / 非错误），且空态教人怎样产生产物", async () => {
	await clickNav("资料库");
	await waitLibrary();
	await h.waitForSettled();
	await h.shoot("library-empty-light");

	const s = await readLibrary();
	assert.ok(s.present, "资料库视图没有挂上（main.settings 不存在）");
	assert.ok(s.empty, `应有空态 .state-empty，实际 loading=${s.loading} error=${s.error}`);
	assert.equal(s.loading, false, "全新环境不应停在加载态（数据为空列表，不是 undefined）");
	assert.equal(s.error, false, "全新环境不应是错误态");
	assert.ok(s.emptyTitle.includes("还没有交付过产物"), `空态标题不对：${JSON.stringify(s.emptyTitle)}`);
	assert.ok(
		s.emptyDesc.includes("让 Agent 做一件事"),
		`空态缺少「怎样产生产物」的指引：${JSON.stringify(s.emptyDesc)}`,
	);
	assert.ok(s.newTask, "空态应带一个「新建任务」入口（能直接去做）");
});

// ══ ③ 预置产物 → 列表出现，名称 / 来源会话标题 / 大小正确 ═════════════
await h.check("③ 预置产物后：列表出现该产物，名称 / 来源会话标题 / 大小正确", async () => {
	seedSessions();
	await clickRefresh();
	const state = await waitLibraryState((s) => s.rows.some((row) => row.name === "唯一报告.md"), "列表出现「唯一报告.md」");
	await h.shoot("library-list-light");

	const row = state.rows.find((r) => r.name === "唯一报告.md");
	assert.ok(row !== undefined, "列表里应有「唯一报告.md」这一行");
	assert.ok(row.meta.includes("帮我写季度复盘"), `行内应标出来源会话标题「帮我写季度复盘」：${JSON.stringify(row.meta)}`);
	assert.ok(row.meta.includes("42 B"), `行内应显示交付时刻的大小「42 B」：${JSON.stringify(row.meta)}`);
	// 三个动作都在（本行落在来源 cwd 内，故有「预览」）
	assert.deepEqual(
		[...row.ops].sort(),
		["定位到来源会话", "在文件夹中显示", "预览"].sort(),
		`行内操作按钮不对：${JSON.stringify(row.ops)}`,
	);
});

// ══ ⑦ 两个会话交付同一路径 → 只有一行，标出会话数 ════════════════════
await h.check("⑦ 两个会话交付同一路径：只有一行，且标出「共 2 个会话交付过」", async () => {
	const { rows } = await readLibrary();
	const shared = rows.filter((r) => r.name === "共享产物.md");
	assert.equal(shared.length, 1, `同一路径应全局去重成一行，实际 ${shared.length} 行：${JSON.stringify(shared.map((r) => r.meta))}`);
	assert.ok(
		shared[0].meta.includes("共 2 个会话交付过"),
		`应标出「共 2 个会话交付过」：${JSON.stringify(shared[0].meta)}`,
	);
	// 取更晚一次交付的快照元数据（B 交付时 size 200）
	assert.ok(shared[0].meta.includes("200 B"), `去重后应保留最近一次交付的 size「200 B」：${JSON.stringify(shared[0].meta)}`);
});

// ══ ⑥ 浅色 + 深色两套主题截图 + 像素断言 ═════════════════════════════
await h.check("⑥ 深色主题下资料库仍正常渲染（截图 + 像素断言）", async () => {
	await win.evaluate(() => {
		void window.kami?.setThemePreference?.("dark");
		document.documentElement.setAttribute("data-theme", "dark");
	});
	await waitUntil(() => win.evaluate(() => document.documentElement.dataset.theme === "dark"), {
		timeout: 10_000,
		desc: "data-theme 切到 dark",
	});
	await h.waitForSettled();
	// shoot 自带像素断言（不是纯色）—— 抓「属性切了但画面没重绘」一类的坑
	const dark = await h.shoot("library-list-dark");
	assert.ok(dark.stats.stdDev > 3, `深色资料库截图不像渲染出来的界面（stdDev=${dark.stats.stdDev.toFixed(2)}）`);

	// 切回浅色，避免影响后续与人工看图
	await win.evaluate(() => {
		void window.kami?.setThemePreference?.("light");
		document.documentElement.setAttribute("data-theme", "light");
	});
	await waitUntil(() => win.evaluate(() => document.documentElement.dataset.theme === "light"), {
		timeout: 10_000,
		desc: "data-theme 切回 light",
	});
	await h.waitForSettled();
});

// ── 前置：resumeSession 需要「已选模型」（daemon 的 createHost 会拦）──────
//
// 「定位到来源会话」走的是 resumeSession，而它在现场会 `createHost` —— 没有可用
// 模型时直接抛「还没有选择模型」。本用例不跑模型回合，只要**注册一个可用的**即可
// （`isUsable` 校验的是「模型能解析 + 服务商已配置」，不联网），所以给一个不会
// 被访问的 baseUrl、一份假 key 就够。不配的话 ⑤ 会在这一步假红（实测过）。
await h.check("准备：配置一个可用模型（「定位到来源会话」的 resume 需要它）", async () => {
	const r = await win.evaluate(async ({ ws }) => {
		const k = globalThis.kami;
		try {
			await k.saveCustomProvider(
				{
					id: "mock-library",
					name: "Mock Library",
					baseUrl: "http://127.0.0.1:9/v1",
					api: "openai-completions",
					authHeader: true,
					models: [{ id: "library-model", name: "library-model", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }],
				},
				"mock-key",
			);
			await k.setModel("mock-library/library-model");
			await k.setWorkspace(ws);
			return { ok: true };
		} catch (e) {
			return { ok: false, err: String(e?.message ?? e).slice(0, 300) };
		}
	}, { ws: WS_A });
	assert.ok(r.ok, `配置模型失败：${r.err}`);
});

// ══ ⑤ 点「定位到来源会话」→ 真的进到那个会话 ═════════════════════════
await h.check("⑤ 点「定位到来源会话」→ 真的进入那个会话（切到会话视图并露出该会话）", async () => {
	const clicked = await win.evaluate(() => {
		const row = [...document.querySelectorAll("main.settings .auto-row")].find((r) =>
			(r.querySelector(".auto-row-name")?.textContent ?? "").trim() === "唯一报告.md",
		);
		if (row === undefined) return false;
		const btn = [...row.querySelectorAll(".auto-row-ops button")].find((b) => (b.textContent ?? "").trim() === "定位到来源会话");
		if (btn === undefined) return false;
		btn.click();
		return true;
	});
	assert.ok(clicked, "找不到「唯一报告.md」行的「定位到来源会话」按钮");

	// 进入会话的可观察证据：资料库视图消失、聊天输入框出现、且该会话的首条用户消息在页面上
	await waitUntil(
		() =>
			win.evaluate(() => {
				const inChat = document.querySelector('[aria-label="消息输入框"]') !== null;
				const leftLibrary = document.querySelector("main.settings h1")?.textContent !== "资料库";
				const showsMessage = (document.body.innerText ?? "").includes("帮我写季度复盘");
				return inChat && leftLibrary && showsMessage;
			}),
		{ timeout: 20_000, desc: "进入来源会话（输入框出现 + 首条消息可见）" },
	);
	await h.shoot("library-located-chat");
});

// ══ ④ 删掉产物文件 → 刷新 → 该条标出失效（且行没消失） ═══════════════
await h.check("④ 删掉产物文件后刷新：该条标出「文件已不在」，且不消失", async () => {
	rmSync(UNIQUE_PATH, { force: true });
	await clickNav("资料库");
	await waitLibrary();
	await clickRefresh();
	const state = await waitLibraryState(
		(s) => s.rows.some((row) => row.name === "唯一报告.md" && row.missed),
		"「唯一报告.md」被标为失效",
	);
	await h.shoot("library-missed-light");

	const row = state.rows.find((r) => r.name === "唯一报告.md");
	assert.ok(row !== undefined, "产物失效后该行不应消失（应留在列表里标为失效）");
	assert.ok(row.missed, "该行应带「文件已不在」失效标记（.auto-badge-missed）");
	// 失效只针对这一条 —— 共享产物仍在磁盘上，不该被误标
	const shared = state.rows.find((r) => r.name === "共享产物.md");
	assert.ok(shared !== undefined && shared.missed === false, "只有被删的那条标失效，其它行不应受影响");
});

await h.check("无渲染层未捕获异常", () => assert.equal(h.pageErrors.length, 0, h.pageErrors.join("; ")));

await h.finish();
