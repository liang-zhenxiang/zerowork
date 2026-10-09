/**
 * 项目（Projects）的端到端测试：卡片墙 → 归入会话 → 详情 → 常驻指令注入 → 解散。
 *
 * 关键路径全覆盖（prd.md 验收标准的 GUI 部分）：
 *   ① 侧栏「项目」可点开，空态给第一步；浅/深主题各留一张截图；
 *   ② 建项目 → 卡片墙出现（色条 + 名称 + 「还没有会话」）；
 *   ③ 会话 ⋯ 菜单「归入项目」→ 侧栏行出现项目色点（title 文字冗余）→
 *      详情看到该会话，卡片 meta 从「还没有会话」变「1 个会话」；
 *   ④ 详情点会话能 resume 进入（不预配全局模型——正好同时验证 #162 的回落
 *      与项目指令的注入走的是同一条 resume 链）；
 *   ⑤ 常驻指令：编辑 → 失焦保存 → 在该项目会话里发一条 → **mock 收到的
 *      systemPrompt 里含「## 项目要求」与指令原文**（注入的直接证据，不是
 *      从界面上猜的）；
 *   ⑥ 解散项目：确认后回卡片墙；**侧栏会话还在**（只解除归组，色点消失）。
 *
 * 环境与传统用例的差异：不 setModel（依赖 #162 的会话自身模型回落），
 * 会话文件手写（带 provider/model 与 usage 字段——pi 恢复时都要读）。
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const PROJECT_NAME = "Q3 竞品调研";
const SESSION_TITLE = "帮我整理调研线索";
const INSTRUCTION = "输出一律用中文，引用必须给出处";
const REPLY = "PROJECTS_E2E_OK";
const h = createHarness({ name: "projects" });
const SESSIONS_DIR = join(h.CONFIG_DIR, "sessions");
const WS = join(h.WORKSPACE_DIR, "调研");

/* 手写一条可恢复的会话（provider/model + usage 缺一不可，见 resume-model-fallback.mjs 的踩坑注释）。 */
function writeSession(id, userText) {
	const stamp = (n) => `2026-10-09T11:00:0${n}.000Z`;
	const message = (mid, parentId, n, payload) =>
		JSON.stringify({ type: "message", id: mid, parentId, timestamp: stamp(n), message: { timestamp: Date.parse(stamp(n)), ...payload } });
	writeFileSync(
		join(SESSIONS_DIR, `2026-10-09T11-00-00-000Z_${id}.jsonl`),
		[
			JSON.stringify({ type: "session", version: 3, id, timestamp: stamp(0), cwd: WS }),
			JSON.stringify({ type: "model_change", id: "m1", parentId: null, timestamp: stamp(0), provider: "mock-proj", modelId: "proj-model" }),
			message("u1", "m1", 1, { role: "user", content: [{ type: "text", text: userText }] }),
			message("a1", "u1", 2, {
				role: "assistant",
				provider: "mock-proj",
				model: "proj-model",
				content: [{ type: "text", text: "好的，先从公开资料开始。" }],
				stopReason: "endTurn",
				usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 120, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }
			})
		].join("\n") + "\n",
	);
}

/* 预置：目录 + 一条可恢复的会话（launch 前落盘，侧栏启动即见） */
mkdirSync(SESSIONS_DIR, { recursive: true });
mkdirSync(WS, { recursive: true });
writeSession("proj-e2e", SESSION_TITLE);

const mock = await startMockModelServer({
	reply: REPLY,
	models: ["proj-model"],
	usage: { prompt_tokens: 200, completion_tokens: 20 }
});
console.log(`✓ mock 模型服务已就绪：${mock.port}`);

await h.launch();
const win = h.window();

/* ── 准备：配 provider（不选全局模型）、设工作空间 ── */
await h.check("准备：注册服务商与工作空间（不选全局模型，会话用自身模型回落）", async () => {
	const r = await win.evaluate(
		async ({ baseUrl, ws }) => {
			const k = globalThis.kami;
			try {
				await k.saveCustomProvider(
					{
						id: "mock-proj",
						name: "Projects Mock",
						baseUrl,
						api: "openai-completions",
						authHeader: true,
						models: [{ id: "proj-model", name: "proj-model", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }]
					},
					"mock-key"
				);
				await k.setWorkspace(ws);
				return { ok: true };
			} catch (e) {
				return { ok: false, err: String(e?.message ?? e).slice(0, 300) };
			}
		},
		{ baseUrl: mock.baseUrl, ws: h.WORKSPACE_DIR }
	);
	assert.ok(r.ok, `配置失败：${r.err}`);
});

/* ── ① 打开项目视图：空态 ── */
await h.check("① 侧栏「项目」可点开，空态给出第一步（浅色截图）", async () => {
	await waitUntil(() => win.evaluate(() => document.body.innerText.includes("帮我整理调研线索")), {
		timeout: 30_000, interval: 500, desc: "侧栏出现目标会话"
	});
	await win.evaluate(() => {
		const btn = [...document.querySelectorAll(".nav-item")].find((b) => (b.textContent ?? "").trim() === "项目");
		if (btn === null) throw new Error("侧栏「项目」入口不在");
		btn.click();
	});
	await waitUntil(() => win.evaluate(() => document.body.innerText.includes("还没有项目")), {
		timeout: 30_000, desc: "项目空态出现"
	});
	await h.shoot("projects-empty-light");
});

/* ── ② 建项目（空态入口是中央 CTA——head 在空态不放按钮，避免双入口） ── */
await h.check("② 新建项目 → 卡片墙出现（色条 + 名称）", async () => {
	await win.evaluate(() => {
		const cta = [...document.querySelectorAll(".state-empty button")].find((b) => (b.textContent ?? "").includes("新建第一个项目"));
		if (cta === undefined) throw new Error("空态中央 CTA 不在");
		cta.click();
	});
	await win.evaluate(() => {
		const input = document.querySelector('.settings-head input[aria-label="新项目名称"]');
		if (input === null) throw new Error("新建输入框未展开");
	});
	const box = win.locator('.settings-head input[aria-label="新项目名称"]');
	await box.fill(PROJECT_NAME);
	await box.press("Enter");
	await waitUntil(() => win.evaluate((name) => [...document.querySelectorAll(".proj-card-name")].some((n) => n.textContent === name), PROJECT_NAME), {
		timeout: 30_000, desc: "卡片出现"
	});
	await h.shoot("projects-wall");
	const meta = await win.evaluate(() => (document.querySelector(".proj-card-meta")?.textContent ?? "").trim());
	assert.ok(meta.includes("还没有会话"), `新卡片 meta 应为「还没有会话」，实际：${meta}`);
});

/* ── ③ 归入会话 ── */
await h.check("③ 会话 ⋯ 菜单归入项目 → 侧栏色点 + 详情可见该会话", async () => {
	await win.evaluate(() => {
		/* 回首页拿侧栏 */
		document.querySelector('.settings-head [aria-label="返回"]')?.click();
	});
	await waitUntil(() => win.evaluate(() => document.querySelector(".task-item-body") !== null), { timeout: 30_000, desc: "回到侧栏" });
	/* ⋯ 按钮 hover 才显示（§7.9），evaluate 直接触发点击不走可见性等待 */
	await win.evaluate((title) => {
		const rowEl = [...document.querySelectorAll(".task-item")].find((r) => (r.textContent ?? "").includes(title));
		if (rowEl === undefined) throw new Error("会话行不在");
		rowEl.querySelector('[aria-label="更多操作"]')?.click();
	}, SESSION_TITLE);
	await win.waitForSelector(".task-op-menu", { timeout: 10_000 });
	await win.evaluate((name) => {
		const item = [...document.querySelectorAll(".task-op-menu .space-menu-item")].find((b) => (b.textContent ?? "").includes(name));
		if (item === null) throw new Error(`菜单里没有项目「${name}」`);
		item.click();
	}, PROJECT_NAME);
	/* 侧栏行出现色点（title 冗余可读项目名） */
	await waitUntil(
		() => win.evaluate((title) => {
			const rowEl = [...document.querySelectorAll(".task-item")].find((r) => (r.textContent ?? "").includes(title));
			const dot = rowEl?.querySelector(".proj-dot-inline");
			return dot !== null && dot.getAttribute("title")?.includes("Q3") === true ? true : null;
		}, SESSION_TITLE),
		{ timeout: 30_000, desc: "侧栏行出现项目色点（带 title）" }
	);
	/* 详情看到该会话；卡片 meta 变「1 个会话」 */
	await win.evaluate(() => {
		[...document.querySelectorAll(".nav-item")].find((b) => (b.textContent ?? "").trim() === "项目")?.click();
	});
	await win.waitForSelector(".proj-card", { timeout: 30_000 });
	await win.evaluate((name) => {
		[...document.querySelectorAll(".proj-card")].find((c) => (c.querySelector(".proj-card-name")?.textContent ?? "") === name)?.click();
	}, PROJECT_NAME);
	await waitUntil(() => win.evaluate((t) => document.body.innerText.includes(t), SESSION_TITLE), {
		timeout: 30_000, desc: "详情出现该会话"
	});
	/* 跨屏色一致性（设计师终审第 1 条的永久回归）：卡片色条与详情色点必须
	   同色——项目色是身份承诺，两屏两色整个色彩系统就失信了。 */
	const colors = await win.evaluate(() => {
		const dot = document.querySelector(".proj-detail-dot");
		return { detail: dot === null ? null : getComputedStyle(dot).backgroundColor };
	});
	await win.evaluate(() => document.querySelector('.settings-head [aria-label="返回项目列表"]')?.click());
	const wallColor = await win.evaluate(() => {
		const card = document.querySelector(".proj-card");
		return card === null ? null : getComputedStyle(card).boxShadow.match(/rgb\([^)]+\)/)?.[0] ?? null;
	});
	assert.ok(wallColor !== null, "卡片色条的计算色没取到");
	assert.ok(
		colors.detail !== null && wallColor.replace(/\s/g, "") === colors.detail.replace(/\s/g, ""),
		`卡片色条（${wallColor}）与详情色点（${colors.detail}）不同色 —— 项目色跨屏漂移`
	);
	await win.evaluate((name) => {
		[...document.querySelectorAll(".proj-card")].find((c) => (c.querySelector(".proj-card-name")?.textContent ?? "") === name)?.click();
	}, PROJECT_NAME);
	await h.shoot("projects-detail");
});

/* ── ④ 详情点会话 → resume 进入 ── */
await h.check("④ 详情点会话能进入对话（不预配全局模型，靠会话自身模型回落）", async () => {
	await win.evaluate((t) => {
		const row = [...document.querySelectorAll(".proj-session-row")].find((r) => (r.textContent ?? "").includes(t));
		if (row === null) throw new Error("详情会话行不在");
		row.click();
	}, SESSION_TITLE);
	await waitUntil(() => win.evaluate(() => document.querySelector('[aria-label="返回首页"]') !== null), {
		timeout: 30_000, desc: "进入会话视图"
	});
	const text = await win.evaluate(() => document.body.innerText);
	assert.ok(text.includes("好的，先从公开资料开始。"), "会话历史应已渲染");
});

/* ── ⑤ 常驻指令注入 ── */
await h.check("⑤ 编辑项目指令 → 该会话发消息 → mock 收到的 systemPrompt 含指令段", async () => {
	/* 先在会话里发一条「无指令」的消息，确认基线不含「项目要求」段 */
	const box = win.locator('[aria-label="消息输入框"]');
	await box.waitFor({ state: "visible", timeout: 30_000 });
	await box.fill("先报个到");
	await box.press("Enter");
	await waitUntil(() => mock.requests.length >= 1, { timeout: 30_000, desc: "mock 收到第 1 轮（无指令基线）" });
	const baselineSystem = systemTextOf(mock.requests[0]);
	assert.ok(!baselineSystem.includes("## 项目要求"), "未设置指令时 systemPrompt 不该有项目要求段");

	/* 回项目详情编辑指令（失焦保存） */
	await win.evaluate(() => {
		[...document.querySelectorAll(".nav-item")].find((b) => (b.textContent ?? "").trim() === "项目")?.click();
	});
	await win.waitForSelector(".proj-card", { timeout: 30_000 });
	await win.evaluate((name) => {
		[...document.querySelectorAll(".proj-card")].find((c) => (c.querySelector(".proj-card-name")?.textContent ?? "") === name)?.click();
	}, PROJECT_NAME);
	const area = win.locator('[aria-label="项目常驻指令"]');
	await area.waitFor({ state: "visible", timeout: 30_000 });
	await area.fill(INSTRUCTION);
	await area.blur();
	await waitUntil(() => win.evaluate(() => [...document.querySelectorAll(".toast-stack .toast")].some((t) => (t.textContent ?? "").includes("已保存"))), {
		timeout: 30_000, desc: "保存 toast"
	});
	/* 卡片墙出现「常驻指令」chip（回 L1 验证） */
	await win.evaluate(() => document.querySelector('.settings-head [aria-label="返回项目列表"]')?.click());
	await waitUntil(() => win.evaluate(() => document.querySelector(".proj-card-chip") !== null), {
		timeout: 30_000, desc: "卡片出现「常驻指令」chip"
	});

	/* 回会话再发一条 → systemPrompt 含指令段 */
	await win.evaluate(() => document.querySelector('.settings-head [aria-label="返回"]')?.click());
	await waitUntil(() => win.evaluate(() => document.querySelector(".task-item-body") !== null), { timeout: 30_000, desc: "回到侧栏" });
	await win.evaluate((t) => {
		[...document.querySelectorAll(".task-item-body")].find((r) => (r.textContent ?? "").includes(t))?.click();
	}, SESSION_TITLE);
	await waitUntil(() => win.evaluate(() => document.querySelector('[aria-label="返回首页"]') !== null), {
		timeout: 30_000, desc: "再次进入会话"
	});
	const box2 = win.locator('[aria-label="消息输入框"]');
	await box2.waitFor({ state: "visible", timeout: 30_000 });
	await box2.fill("带上项目要求再答一次");
	await box2.press("Enter");
	await waitUntil(() => mock.requests.length >= 2, { timeout: 30_000, desc: "mock 收到第 2 轮" });
	const system2 = systemTextOf(mock.requests[1]);
	assert.ok(system2.includes("## 项目要求"), `第 2 轮 systemPrompt 应含「## 项目要求」段`);
	assert.ok(system2.includes(INSTRUCTION), `systemPrompt 应含指令原文「${INSTRUCTION}」`);
	await waitUntil(() => win.evaluate((t) => document.body.innerText.includes(t), REPLY), {
		timeout: 30_000, desc: "回复渲染"
	});
	await h.shoot("projects-injected");
});

/* ── 深色下的卡片墙 ── */
await h.check("深色主题下项目墙正常渲染（截图 + 像素断言）", async () => {
	await win.evaluate(() => {
		void window.kami?.setThemePreference?.("dark");
		document.documentElement.setAttribute("data-theme", "dark");
	});
	await waitUntil(() => win.evaluate(() => document.documentElement.dataset.theme === "dark"), { timeout: 10_000, desc: "切到深色" });
	await win.evaluate(() => {
		[...document.querySelectorAll(".nav-item")].find((b) => (b.textContent ?? "").trim() === "项目")?.click();
	});
	await win.waitForSelector(".proj-card", { timeout: 30_000 });
	await h.shoot("projects-wall-dark");
	await win.evaluate(() => {
		void window.kami?.setThemePreference?.("light");
		document.documentElement.setAttribute("data-theme", "light");
	});
});

/* ── ⑥ 解散项目：会话还在 ── */
await h.check("⑥ 解散项目 → 回卡片墙空态；侧栏会话还在、色点消失", async () => {
	await waitUntil(() => win.evaluate(() => document.querySelector(".proj-card") !== null), { timeout: 30_000, desc: "回到卡片墙" });
	/* 「解散项目」在详情页 head：先点进项目 */
	await win.evaluate((name) => {
		[...document.querySelectorAll(".proj-card")].find((c) => (c.querySelector(".proj-card-name")?.textContent ?? "") === name)?.click();
	}, PROJECT_NAME);
	await waitUntil(() => win.evaluate(() => [...document.querySelectorAll(".settings-head button")].some((b) => (b.textContent ?? "").includes("解散项目"))), {
		timeout: 30_000, desc: "进入详情（解散按钮在 head）"
	});
	await win.evaluate(() => {
		[...document.querySelectorAll(".settings-head button")].find((b) => (b.textContent ?? "").includes("解散项目"))?.click();
	});
	await win.evaluate(() => {
		[...document.querySelectorAll(".settings-head button")].find((b) => (b.textContent ?? "").includes("确认解散"))?.click();
	});
	await waitUntil(() => win.evaluate(() => document.body.innerText.includes("还没有项目")), {
		timeout: 30_000, desc: "回到空态"
	});
	await win.evaluate(() => document.querySelector('.settings-head [aria-label="返回"]')?.click());
	await waitUntil(() => win.evaluate((t) => {
		const rowEl = [...document.querySelectorAll(".task-item")].find((r) => (r.textContent ?? "").includes(t));
		return rowEl !== undefined && rowEl.querySelector(".proj-dot-inline") === null ? true : null;
	}, SESSION_TITLE), { timeout: 30_000, desc: "会话还在且色点已消失" });
	await h.shoot("projects-disbanded");
});

await mock.close();
await h.finish();

/** 从一轮请求里取 system 消息全文（openai-completions 形状）。 */
function systemTextOf(request) {
	const messages = request?.body?.messages ?? [];
	const system = messages.find((m) => m.role === "system");
	return typeof system?.content === "string" ? system.content : "";
}
