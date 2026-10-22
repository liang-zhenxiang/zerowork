/**
 * 会话检索（侧栏「会话检索」）的 GUI 端到端测试（Issue #233）。
 *
 * 数据面（多命中收集 / AND 语义 / 片段与高亮区间）已有单测
 * （`tests/unit/session-search.test.mjs`、`tests/unit/session-search-core.test.mjs`）。
 * **本文件补的是只有真实启动 Electron 才暴露的那层**：侧栏项真的可点、页面真的挂上、
 * IPC 真的通、结果真的按会话分组渲染、点一条真的**回到那条消息并高亮它**。
 *
 * ## 为什么预置会话文件而不是跑 mock 模型
 *
 * 与 `tests/e2e/library.mjs` 同一条理由：这里验的是「读本机 .jsonl → 渲染 → 跳转」，
 * 跑模型回合只会变慢、且把检索的错误与模型协议的错误混在一起。
 *
 * ## 「跳回去了没有」要验证到 DOM 事实
 *
 * 只看「是否离开检索页」不够 —— 定位那条链路的失败形态是「会话开了、但停在底部」，
 * 界面上**没有任何报错**。所以断言落在两件事上：目标消息的 `data-entry-id` 节点
 * 真的存在，且它带着 `entry-flash`（定位动画的一次性类，`focusEntryInTurn` 在
 * 滚动时加上、`animationend` 摘除）。前者说明会话里确实有这条，后者说明**定位
 * 动作真的执行到了这一条**，而不是碰巧滚到了那里。
 *
 * ## 等待
 *
 * 所有 `waitUntil` 的谓词都能返回假值；`waitForSettled()` 只在空闲态用
 *（本用例全程不跑模型回合）。
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const h = createHarness({ name: "session-search" });

const SESSIONS_DIR = join(h.CONFIG_DIR, "sessions");
const WORKSPACE_DIR = h.WORKSPACE_DIR;
mkdirSync(WORKSPACE_DIR, { recursive: true });
mkdirSync(SESSIONS_DIR, { recursive: true });

const S1 = "aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa";
const S2 = "bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb";

function message(id, parentId, role, text) {
	return JSON.stringify({
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message: { role, content: [{ type: "text", text }] },
	});
}

function seedSession(fileId, sessionId, firstText, lines) {
	const file = join(SESSIONS_DIR, `2026-10-03T12-00-${fileId}-000Z_s${fileId}.jsonl`);
	writeFileSync(
		file,
		`${[
			JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd: WORKSPACE_DIR }),
			...lines,
		].join("\n")}\n`,
	);
	return file;
}

// 会话 1：两个角色里各有一处「报价单」→ 一条结果卡里两行命中
seedSession(1, S1, "把上周的报价单发我", [
	message("s1-m1", null, "user", "把上周的报价单发我"),
	message("s1-m2", "s1-m1", "assistant", "报价单在附件里，单价已经改成含税价。"),
	message("s1-m3", "s1-m2", "user", "会议纪要也补一下"),
]);
// 会话 2：只有另一件事，用来验证「分组」不是把全部命中揉在一起
seedSession(2, S2, "部署脚本改好了吗", [
	message("s2-m1", null, "user", "部署脚本改好了吗"),
	message("s2-m2", "s2-m1", "assistant", "改好了，跑一遍就行。"),
]);

await h.launch();
const win = h.window();

const clickNav = async (label) => {
	const ok = await win.evaluate((text) => {
		const btn = [...document.querySelectorAll(".sidebar-nav button")].find((b) => (b.textContent ?? "").trim() === text);
		if (btn === undefined || btn.disabled) return false;
		btn.click();
		return true;
	}, label);
	assert.ok(ok, `侧栏找不到可点的「${label}」导航项`);
};

const waitSearchView = () =>
	waitUntil(() => win.evaluate(() => document.querySelector("main.settings h1")?.textContent === "会话检索"), {
		timeout: 15_000,
		desc: "进入会话检索视图",
	});

const typeQuery = async (text) => {
	await win.evaluate(() => {
		const input = document.querySelector("main.settings .ss-input");
		if (input === null) throw new Error("找不到检索输入框 .ss-input");
		input.focus();
	});
	await win.keyboard.press("ControlOrMeta+A");
	await win.keyboard.type(text);
};

const readState = () =>
	win.evaluate(() => {
		const main = document.querySelector("main.settings");
		if (main === null) return { present: false };
		return {
			present: true,
			title: (main.querySelector("h1")?.textContent ?? "").trim(),
			idle: main.querySelector(".ss-idle") !== null,
			examples: [...main.querySelectorAll(".ss-example")].map((el) => (el.textContent ?? "").trim()),
			loading: main.querySelector(".ss-results-skeleton") !== null,
			error: main.querySelector(".state-error") !== null,
			empty: main.querySelector(".state-empty") !== null,
			emptyTitle: (main.querySelector(".state-empty-title")?.textContent ?? "").trim(),
			summary: (main.querySelector(".ss-summary-text")?.textContent ?? "").trim(),
			// 骨架卡也用 .ss-session —— 只数真实结果列表里的卡，否则「加载中」会被当成「已经搜到 3 个会话」。
			sessions: [...main.querySelectorAll(".ss-results:not(.ss-results-skeleton) .ss-session")].map((card) => ({
				title: (card.querySelector(".ss-session-title")?.textContent ?? "").trim(),
				count: (card.querySelector(".ss-session-count")?.textContent ?? "").trim(),
				hits: [...card.querySelectorAll(".ss-hit")].map((hit) => ({
					role: (hit.querySelector(".ss-hit-role")?.textContent ?? "").trim(),
					text: (hit.querySelector(".ss-hit-text")?.textContent ?? "").trim(),
					marks: [...hit.querySelectorAll("mark")].map((mark) => (mark.textContent ?? "").trim()),
					key: hit.getAttribute("data-search-key"),
				})),
			})),
		};
	});

const waitSearchState = (pred, desc) =>
	waitUntil(
		async () => {
			const state = await readState();
			return pred(state) ? state : null;
		},
		{ timeout: 15_000, desc },
	);

// ══ ① 侧栏入口：可点、位于「文件历史」之前、不在「规划中」组里 ═══════
await h.check("① 侧栏「会话检索」可点，排在「文件历史」之前，且不在规划组里", async () => {
	const r = await win.evaluate(() => {
		const nav = document.querySelector(".sidebar-nav");
		if (nav === null) return { found: false };
		const btn = [...nav.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "会话检索");
		if (btn === undefined) return { found: false };
		const text = nav.innerText ?? "";
		return {
			found: true,
			disabled: btn.disabled,
			inPlanningGroup: btn.closest(".sidebar-section") !== null,
			orderOK: text.indexOf("会话检索") >= 0 && text.indexOf("会话检索") < text.indexOf("文件历史"),
			navText: text,
		};
	});
	assert.ok(r.found, "侧栏里找不到「会话检索」导航项");
	assert.equal(r.disabled, false, "「会话检索」应是可点按钮");
	assert.equal(r.inPlanningGroup, false, "「会话检索」不应属于「规划中」分组");
	assert.ok(r.orderOK, `「会话检索」应排在「文件历史」之前：${JSON.stringify(r.navText)}`);
});

// ══ ② 初始态：教人搜什么，并给可点的示例 ═════════════════════════════
await h.check("② 进入页面是初始态（不是加载/错误/空结果），并给出可点的示例", async () => {
	await clickNav("会话检索");
	await waitSearchView();
	await h.waitForSettled();
	await h.shoot("session-search-idle-light");
	const s = await readState();
	assert.ok(s.present, "会话检索视图没有挂上");
	assert.ok(s.idle, "刚进来应是初始态 .ss-idle（此时还没有检索词）");
	assert.equal(s.loading, false, "空查询不应显示骨架");
	assert.equal(s.empty, false, "空查询不是「没有找到」—— 空结果属于另一态");
	assert.equal(s.examples.length, 3, `应有 3 条示例查询，实际 ${s.examples.length}`);
});

// ══ ③ 检索命中：按会话分组、两条命中、片段里高亮命中词 ═══════════════
await h.check("③ 搜「报价单」：按会话分组出现一条结果卡，卡内两处命中且都高亮", async () => {
	await typeQuery("报价单");
	const state = await waitSearchState((s) => s.sessions.length > 0, "检索结果出现");
	await h.waitForSettled();
	await h.shoot("session-search-results-light");

	assert.equal(state.sessions.length, 1, "「报价单」只出现在会话 1，应只有一张结果卡");
	const card = state.sessions[0];
	assert.equal(card.title, "把上周的报价单发我", `结果卡标题应是会话标题：${JSON.stringify(card.title)}`);
	assert.equal(card.count, "2 处", `命中数应是 2 处（一条问、一条答）：${JSON.stringify(card.count)}`);
	assert.equal(card.hits.length, 2, `卡内应展开两行命中：${JSON.stringify(card.hits.map((hit) => hit.role))}`);
	assert.deepEqual(card.hits.map((hit) => hit.role), ["你问的", "它答的"]);
	for (const hit of card.hits) {
		assert.ok(hit.marks.includes("报价单"), `每行命中片段都应高亮「报价单」：${JSON.stringify(hit)}`);
	}
	assert.ok(state.summary.includes("已检索 2 个会话"), `摘要应说明检索了多少会话：${JSON.stringify(state.summary)}`);
	assert.ok(state.summary.includes("1 个会话命中 2 处"), `摘要应说明会话数与命中总数：${JSON.stringify(state.summary)}`);
});

// ══ ④ Esc 先清词、再退出页面 ═════════════════════════════════════════
await h.check("④ Esc 先清空检索词，再按一次才返回上一页", async () => {
	await win.evaluate(() => document.querySelector("main.settings .ss-input")?.focus());
	await win.keyboard.press("Escape");
	const cleared = await waitSearchState((s) => s.idle === true, "Esc 后回到初始态");
	assert.equal(cleared.idle, true, "第一次 Esc 应清空检索词并回到初始态");
	await win.keyboard.press("Escape");
	await waitUntil(() => win.evaluate(() => document.querySelector("main.settings h1")?.textContent !== "会话检索"), {
		timeout: 10_000,
		desc: "第二次 Esc 退出检索页",
	});
});

// ══ ⑤ 点命中 → 打开会话并定位到那条消息（entry-flash）═══════════════
await h.check("⑤ 点第二条命中：真的打开会话，并把那条助手消息滚动定位、加上 entry-flash", async () => {
	await clickNav("会话检索");
	await waitSearchView();
	await typeQuery("报价单");
	const state = await waitSearchState((s) => s.sessions.length > 0, "结果重新出现");
	const assistantHit = state.sessions[0].hits.find((hit) => hit.role === "它答的");
	assert.ok(assistantHit !== undefined, "没有找到角色的「它答的」那一行命中");

	// resume 需要在现场有可用模型（library.mjs 的既有教训：没有模型时 createHost 会拦）
	const configured = await win.evaluate(async ({ ws }) => {
		try {
			await window.kami.saveCustomProvider(
				{
					id: "mock-search",
					name: "Mock Search",
					baseUrl: "http://127.0.0.1:9/v1",
					api: "openai-completions",
					authHeader: true,
					models: [{ id: "search-model", name: "search-model", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }],
				},
				"mock-key",
			);
			await window.kami.setModel("mock-search/search-model");
			await window.kami.setWorkspace(ws);
			return true;
		} catch {
			return false;
		}
	}, { ws: WORKSPACE_DIR });
	assert.ok(configured, "准备：配置一个可用模型失败（resume 会在 createHost 处被拦）");

	const clicked = await win.evaluate(() => {
		const btn = [...document.querySelectorAll("main.settings .ss-hit")].find((el) => {
			const marks = [...el.querySelectorAll("mark")].some((mark) => (mark.textContent ?? "").includes("报价单"));
			return marks && (el.querySelector(".ss-hit-role")?.textContent ?? "").trim() === "它答的";
		});
		if (btn === undefined) return false;
		btn.click();
		return true;
	});
	assert.ok(clicked, "找不到「它答的」那行命中按钮");

	await waitUntil(
		() =>
			win.evaluate(() => {
				const inChat = document.querySelector('[aria-label="消息输入框"]') !== null;
				const leftSearch = document.querySelector("main.settings h1")?.textContent !== "会话检索";
				const entry = document.querySelector('[data-entry-id="s1-m2"]');
				return inChat && leftSearch && entry !== null;
			}),
		{ timeout: 20_000, desc: "进入来源会话并出现目标消息节点" },
	);
	// entry-flash 是定位动画的一次性类：出现即证明 focusEntryInTurn 真的执行到了这一条。
	await waitUntil(() => win.evaluate(() => document.querySelector('[data-entry-id="s1-m2"]')?.classList.contains("entry-flash") === true), {
		timeout: 10_000,
		desc: "目标消息被打上 entry-flash",
	});
	await h.shoot("session-search-jump-chat");
});

// ══ ⑥ 无命中 → 空结果态（不是错误态）════════════════════════════════
await h.check("⑥ 搜一个不存在的词：是空结果态，并如实说明扫描上限", async () => {
	await clickNav("会话检索");
	await waitSearchView();
	await typeQuery("完全不存在的关键词");
	const state = await waitSearchState((s) => s.empty === true, "空结果态出现");
	await h.waitForSettled();
	await h.shoot("session-search-empty-light");
	assert.equal(state.error, false, "没有命中不是错误态");
	assert.ok(state.emptyTitle.includes("没有找到匹配的会话"), `空结果标题不对：${JSON.stringify(state.emptyTitle)}`);
});

// ══ ⑦ 深色主题截图 ═══════════════════════════════════════════════════
await h.check("⑦ 深色主题下检索结果可读（截图 + 像素断言）", async () => {
	await typeQuery("报价单");
	await waitSearchState((s) => s.sessions.length > 0, "深色截图前的检索结果");
	await win.evaluate(() => {
		void window.kami?.setThemePreference?.("dark");
		document.documentElement.setAttribute("data-theme", "dark");
	});
	await waitUntil(() => win.evaluate(() => document.documentElement.dataset.theme === "dark"), {
		timeout: 10_000,
		desc: "data-theme 切到 dark",
	});
	// 主题切换会走 --dur-fast 的背景过渡：立刻截屏会拍到「浅色选中底 + 深色文字」
	// 的中间帧。等选中行真的落到暗色的 --bg-raised 再拍。
	//
	// 期望值不写死 rgb(38,38,42)：那是上一版 --bg-raised 的值，极光墨把暗色抬升面
	// 调成了 #0e1624。这里把一个游离元素染成 var(--bg-raised) 读它的计算值，
	// 拿到的永远是当前 token 的真值 —— 断言守的是「选中行跟着 --bg-raised 走」。
	const expectedActiveBg = await win.evaluate(() => {
		const probe = document.createElement("div");
		probe.style.backgroundColor = "var(--bg-raised)";
		document.body.appendChild(probe);
		const value = getComputedStyle(probe).backgroundColor;
		probe.remove();
		return value;
	});
	await waitUntil(
		() => win.evaluate((want) => {
			const el = document.querySelector(".ss-hit.is-active");
			return el !== null && getComputedStyle(el).backgroundColor === want;
		}, expectedActiveBg),
		{ timeout: 5_000, desc: `选中行的底色过渡到暗色 --bg-raised(${expectedActiveBg})` },
	);
	const dark = await h.shoot("session-search-results-dark");
	assert.ok(dark.stats.stdDev > 3, `深色检索截图不像渲染出来的界面（stdDev=${dark.stats.stdDev.toFixed(2)}）`);
});

await h.finish();
