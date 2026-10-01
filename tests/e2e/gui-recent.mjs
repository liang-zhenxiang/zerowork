/**
 * 首页「最近会话」的 GUI 测试。
 *
 * 这块功能的存在理由：把「第二次打开」的路径从两跳（会话列表 → 翻找）
 * 缩成一跳（首页直接点）。对应地，测试锁住的就是这条路径本身：
 *
 * 断言：
 *   ① 新环境首页没有「最近会话」区（新用户只看到上手清单，不出现空壳）；
 *   ② 用真实 UI 路径发出一条消息（mock 模型）→ 会话创建；
 *   ③ 返回首页后「最近会话」出现，且包含刚才会话的标题；
 *   ④ 点击该行 → 真的恢复进会话视图（标题对得上），不是只做了跳转动画；
 *   ⑤ 浅色与深色（沿用已落地的外观切换）下都截图 + 像素断言——
 *      新组件的次级面语言在两套主题里都不破。
 *
 * mock 而非真实模型：验的是**首页路径**，不是模型能力；mock 让「会话被创建」
 * 完全确定（等 mock 收到请求即为发出信号）。
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const mock = await startMockModelServer();
console.log(`✓ mock 模型服务已就绪：${mock.baseUrl}`);

const h = createHarness({ name: "recent" });
mkdirSync(h.WORKSPACE_DIR, { recursive: true });

await h.launch();
const win = h.window();

const currentTheme = () => win.evaluate(() => document.documentElement.dataset.theme ?? null);

// ── ① 新环境首页没有最近会话区 ────────────────────────────────
await h.check("新环境首页不出现「最近会话」（无空壳）", async () => {
	const found = await win.evaluate(() => document.querySelector(".home-recent") !== null);
	assert.equal(found, false, "没有历史会话时不应渲染最近会话区");
});
await h.shoot("home-empty");

// ── ② 真实路径创建一个会话 ────────────────────────────────────
await h.check("注册 mock provider 并发出第一条消息", async () => {
	const r = await win.evaluate(async ({ baseUrl, ws }) => {
		const k = globalThis.kami;
		try {
			await k.saveCustomProvider(
				{
					id: "mock-recent",
					name: "Mock Recent",
					baseUrl,
					api: "openai-completions",
					authHeader: true,
					models: [{ id: "recent-model", name: "recent-model", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }],
				},
				"mock-key",
			);
			await k.setModel("mock-recent/recent-model");
			await k.setWorkspace(ws);
			return { ok: true };
		} catch (e) {
			return { ok: false, err: String(e?.message ?? e).slice(0, 200) };
		}
	}, { baseUrl: mock.baseUrl, ws: h.WORKSPACE_DIR });
	assert.ok(r.ok, `配置失败：${r.err}`);

	const box = win.locator('[aria-label="消息输入框"]');
	await box.waitFor({ state: "visible", timeout: 30_000 });
	await box.fill("帮我安排下周的会议日程");
	await box.press("Enter");
	await waitUntil(() => mock.requests.length >= 1, {
		timeout: 40_000,
		interval: 500,
		desc: "mock 收到请求（消息发出去了）",
	});
});

// ── ③ 回首页，最近会话出现 ────────────────────────────────────
await h.check("返回首页后「最近会话」出现且含本会话", async () => {
	await waitUntil(() => win.evaluate(() => document.querySelector('[aria-label="返回首页"]') !== null), {
		timeout: 30_000,
		desc: "进入会话视图",
	});
	// 等回合收尾（mock 单轮即止）：回复正文出现在 DOM
	await waitUntil(
		() => win.evaluate(() => document.body.innerText.includes("mock 模型的回复")),
		{ timeout: 30_000, interval: 500, desc: "mock 回复渲染出来" },
	);
	await win.evaluate(() => document.querySelector('[aria-label="返回首页"]').click());
	await waitUntil(
		() => win.evaluate(() => {
			const zone = document.querySelector(".home-recent");
			if (zone === null) return false;
			return (zone.textContent ?? "").includes("会议日程");
		}),
		{ timeout: 30_000, interval: 500, desc: "首页最近会话区出现并含会话标题" },
	);
});
await h.shoot("home-with-recent");

// ── ④ 点击恢复 ────────────────────────────────────────────────
await h.check("点击最近会话行能恢复进会话", async () => {
	await win.evaluate(() => {
		const row = document.querySelector(".home-recent-row");
		if (row === null) throw new Error("最近会话行不在");
		row.click();
	});
	await waitUntil(() => win.evaluate(() => document.querySelector('[aria-label="返回首页"]') !== null), {
		timeout: 30_000,
		desc: "回到会话视图",
	});
	const inChat = await win.evaluate(() => document.body.innerText.includes("会议日程"));
	assert.ok(inChat, "会话视图里应能看到原会话内容");
});

// ── ⑤ 深色下的最近会话 ────────────────────────────────────────
await h.check("深色主题下最近会话区正常渲染", async () => {
	await win.evaluate(() => document.querySelector('[aria-label="返回首页"]').click());
	await waitUntil(() => win.evaluate(() => document.querySelector(".home-recent") !== null), {
		timeout: 30_000,
		desc: "回到首页",
	});
	await win.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
	await h.waitForSettled();
	assert.equal(await currentTheme(), "dark");
	await h.shoot("home-recent-dark");
	await win.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
});

await h.finish();
