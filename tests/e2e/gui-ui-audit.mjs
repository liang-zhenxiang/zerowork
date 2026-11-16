/**
 * 界面一致性 Top 5 的 GUI 端到端测试（任务 11-16-ui-top5）。
 *
 * 这五项的共同点是「样式或状态在真实 Electron 里才看得出来」，单测与截图人工
 * 核对都拦不住回归：
 *
 *   ① `--text-faint` 对比度 —— 由 `tests/unit/theme-contrast.test.mjs` 守，
 *      本文件只负责在界面上确认 token 真的被应用（信息行可见）；
 *   ② 选中态统一 —— 专家分类胶囊与审计类别筛选的 `aria-pressed` 与视觉底；
 *   ③ 侧栏当前页 —— 8 个二级页面各自 `aria-current="page"` + `.nav-item-current`；
 *   ④ 资料库空态排版 —— 统计块与空态卡**不得并排**（用元素矩形关系断言）；
 *   ⑤ 新功能状态 —— hooks 注入卡的「查看内容 / 收起」与回复长度选中态。
 *
 * 等待纪律见 `.trellis/spec/testing/index.md`：所有 `waitUntil` 谓词都能返回
 * 假值，不用固定 sleep；导航后、空闲态才用 `waitForSettled()`。
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const h = createHarness({ name: "ui-audit" });
mkdirSync(h.WORKSPACE_DIR, { recursive: true });

const SESSIONS_DIR = join(h.CONFIG_DIR, "sessions");
mkdirSync(SESSIONS_DIR, { recursive: true });

/*
 * 预置一条会话：hooks 注入卡只在历史里存在 `custom_message` 且
 * `customType:"hook_context"`、`display:true` 时才渲染（session-view.js）。
 * 这里直接落盘一条，比跑一整个 mock 模型回合快得多，也不依赖网络。
 */
const SESSION_ID = "33333333-3333-7333-8333-333333333333";
const SESSION_PATH = join(SESSIONS_DIR, `2026-11-16T10-00-00-000Z_${SESSION_ID}.jsonl`);
const HOOK_MARK = "这是由本地 hook 注入的上下文正文。";
const HOOK_TIMESTAMP = "2026-11-16T10:00:01.000Z";
writeFileSync(
	SESSION_PATH,
	`${[
		JSON.stringify({
			type: "session",
			version: 3,
			id: SESSION_ID,
			timestamp: "2026-11-16T10:00:00.000Z",
			cwd: h.WORKSPACE_DIR,
		}),
		JSON.stringify({
			type: "message",
			id: `${SESSION_ID}-m0`,
			parentId: null,
			timestamp: "2026-11-16T10:00:00.500Z",
			message: { role: "user", content: [{ type: "text", text: "带上下文开始吧" }] },
		}),
		JSON.stringify({
			type: "custom_message",
			id: `${SESSION_ID}-h0`,
			parentId: `${SESSION_ID}-m0`,
			timestamp: HOOK_TIMESTAMP,
			customType: "hook_context",
			display: true,
			content: HOOK_MARK,
			details: { hooks: [{ event: "SessionStart", id: "h-ui-audit", truncated: false }] },
		}),
	].join("\n")}\n`,
);

await h.launch();
const win = h.window();

const clickNav = async (label) => {
	const ok = await win.evaluate((text) => {
		const btn = [...document.querySelectorAll(".sidebar-nav button")].find(
			(b) => (b.textContent ?? "").trim() === text,
		);
		if (btn === undefined || btn.disabled) return false;
		btn.click();
		return true;
	}, label);
	assert.ok(ok, `侧栏找不到可点的「${label}」导航项`);
};

const setTheme = async (theme) => {
	await win.evaluate((value) => {
		void window.kami?.setThemePreference?.(value);
		document.documentElement.setAttribute("data-theme", value);
	}, theme);
	await waitUntil(() => win.evaluate((value) => document.documentElement.dataset.theme === value, theme), {
		timeout: 10_000,
		desc: `data-theme 切到 ${theme}`,
	});
	await h.waitForSettled();
};

/**
 * 等某个选择器下的有限动画 / 过渡跑完再截图或读计算样式。
 *
 * 为什么需要：`background-color` 走 `--dur-fast` 过渡，类名一挂上就读取会拿到
 * 过渡起点；测试窗口被遮挡时 Chromium 还会节流过渡，读到的可能是几十毫秒前的
 * 中间值（实测侧栏当前页的底色因此看起来像没生效）。无限循环动画不能等，
 * 否则永远不结束。
 */
const settleAnimations = (selector) =>
	win.evaluate(async (sel) => {
		const el = document.querySelector(sel);
		if (el === null) return;
		const finite = el
			.getAnimations({ subtree: true })
			.filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
		await Promise.all(finite.map((animation) => animation.finished)).catch(() => {
			/* 过渡被取消（例如再次切换）时 finished 会 reject，忽略即可 */
		});
	}, selector);

/** 把一个 CSS 变量解析成实际的 rgb()/rgba() 字符串（用于比较计算样式）。 */
const resolvedColor = (variable) =>
	win.evaluate((name) => {
		const probe = document.createElement("div");
		probe.style.background = `var(${name})`;
		document.body.appendChild(probe);
		const value = getComputedStyle(probe).backgroundColor;
		probe.remove();
		return value;
	}, variable);

/**
 * 选中项在 hover 下必须保持选中底。
 *
 * 守的是这条真实的坑：`.mini-btn:hover:not(:disabled)` 的特异性 (0,3,0) 高于
 * `.reply-length-btn.is-selected` / `.mini-btn.active` 的 (0,2,0) —— 只写选中态、
 * 不写 hover 覆盖时，鼠标一移上去底就掉回 `--bg-hover`（亮色下是
 * `rgba(13,148,136,.08)`），而字仍是 `--primary-text` 反白，实测这枚按钮的文字
 * 等于消失。单看静态截图发现不了，必须在真实 hover 下读计算样式。
 */
const expectHoverKeepsSelected = async (selector, label) => {
	const expected = await resolvedColor("--primary-active");
	/*
	 * 先关掉过渡再读。`background-color` 走 `--dur-fast`：hover 后立刻读会拿到
	 * **过渡起点**，于是这条断言在缺陷存在时也会「通过」（实测踩过一次：
	 * 审计筛选在坏 CSS 下读到的仍是选中底）。关掉过渡后拿到的是终值。
	 */
	const mute = await win.addStyleTag({
		content: "*,*::before,*::after{transition:none!important;animation:none!important}",
	});
	try {
		await win.locator(selector).hover();
		const state = await waitUntil(
			async () => {
				const value = await win.evaluate((sel) => {
					const el = document.querySelector(sel);
					if (el === null) return null;
					const style = getComputedStyle(el);
					return { hovered: el.matches(":hover"), background: style.backgroundColor, color: style.color };
				}, selector);
				return value?.hovered === true ? value : null;
			},
			{ timeout: 6_000, desc: `${label} 进入 hover` },
		);
		assert.equal(
			state.background,
			expected,
			`${label} 悬停后底色不是选中底：期望 ${expected}，实际 ${state.background}（字色 ${state.color}）—— ` +
				"反白字落在近白底上会看不见",
		);
	} finally {
		await mute.evaluate((node) => node.remove());
	}
};

/** 侧栏当前页状态：每个 .nav-item 的文本 / aria-current / 是否有当前页类。 */
const readNavState = () =>
	win.evaluate(() =>
		[...document.querySelectorAll(".sidebar-nav .nav-item")].map((item) => ({
			label: (item.textContent ?? "").trim(),
			current: item.getAttribute("aria-current"),
			className: item.className,
		})),
	);

/** 等某个 nav 项成为唯一的当前页。 */
const waitCurrentNav = (label) =>
	waitUntil(
		async () => {
			const state = await readNavState();
			const hit = state.find((item) => item.label === label);
			const currents = state.filter((item) => item.current === "page");
			return hit?.current === "page" && currents.length === 1 ? state : null;
		},
		{ timeout: 15_000, desc: `侧栏「${label}」成为唯一的当前页` },
	);

// ══ ④ 资料库空态：统计块在上、空态卡在下且水平居中（不得并排）══════════
await h.check("④ 资料库空态：统计块与空态卡上下排列，空态卡水平居中", async () => {
	await clickNav("资料库");
	const rects = await waitUntil(
		async () => {
			const value = await win.evaluate(() => {
				const body = document.querySelector("main.settings .settings-body");
				const overview = body?.querySelector(":scope > .data-overview");
				const empty = body?.querySelector(":scope > .state-empty");
				if (body === null || overview == null || empty == null) return null;
				const b = body.getBoundingClientRect();
				const o = overview.getBoundingClientRect();
				const e = empty.getBoundingClientRect();
				return {
					body: { left: b.left, right: b.right, top: b.top, bottom: b.bottom },
					overview: { left: o.left, right: o.right, top: o.top, bottom: o.bottom },
					empty: { left: e.left, right: e.right, top: e.top, bottom: e.bottom },
				};
			});
			return value === null ? null : value;
		},
		{ timeout: 20_000, desc: "资料库同时渲染出 .data-overview 与 .state-empty" },
	);
	await h.shoot("library-empty-light");

	assert.ok(
		rects.empty.top >= rects.overview.bottom - 1,
		`统计块与空态卡被并排了：overview.bottom=${rects.overview.bottom.toFixed(1)}，` +
			`empty.top=${rects.empty.top.toFixed(1)}，empty.left=${rects.empty.left.toFixed(1)}`,
	);
	assert.ok(
		rects.overview.top < rects.empty.top,
		`统计块应排在空态卡之前（上）：overview.top=${rects.overview.top.toFixed(1)}，` +
			`empty.top=${rects.empty.top.toFixed(1)}`,
	);
	const leftGap = rects.empty.left - rects.body.left;
	const rightGap = rects.body.right - rects.empty.right;
	assert.ok(
		Math.abs(leftGap - rightGap) <= 8,
		`空态卡没有水平居中：左留白 ${leftGap.toFixed(1)}px，右留白 ${rightGap.toFixed(1)}px`,
	);

	await setTheme("dark");
	await h.shoot("library-empty-dark");
	await setTheme("light");
});

// ══ ③ 侧栏当前页：8 个二级页面各自命中，且同一时刻只有一项 ═════════════
await h.check("③ 侧栏当前页：8 个二级页面各自 aria-current=page + .nav-item-current", async () => {
	const pages = [
		["项目", "项目"],
		["专家·技能·连接器", "专家"],
		["自动化", "自动化"],
		["资料库", "资料库"],
		["会话检索", "检索"],
		["文件历史", "文件历史"],
		["诊断", "诊断"],
		["统计", "统计"],
	];
	for (const [label, marker] of pages) {
		await clickNav(label);
		const state = await waitCurrentNav(label);
		const hit = state.find((item) => item.label === label);
		assert.ok(
			hit.className.split(/\s+/).includes("nav-item-current"),
			`「${marker}」页的导航项缺少 .nav-item-current：${JSON.stringify(hit)}`,
		);
	}
	// 「规划中」的禁用项永远不该被标成当前页（该分组默认折叠，先展开才在 DOM 里）。
	const expanded = await win.evaluate(() => {
		const toggle = [...document.querySelectorAll(".sidebar-nav .section-title-btn")].find((button) =>
			(button.textContent ?? "").includes("规划中"),
		);
		if (toggle === undefined) return false;
		toggle.click();
		return true;
	});
	assert.ok(expanded, "侧栏找不到「规划中」分组标题");
	await waitUntil(
		() => win.evaluate(() => document.querySelectorAll(".sidebar-nav .nav-item-pending").length > 0),
		{ timeout: 10_000, desc: "「规划中」分组展开出未就绪导航项" },
	);
	const pending = await win.evaluate(() =>
		[...document.querySelectorAll(".sidebar-nav .nav-item-pending")].map((item) => ({
			label: (item.textContent ?? "").trim(),
			current: item.getAttribute("aria-current"),
			className: item.className,
		})),
	);
	assert.ok(pending.length > 0, "侧栏的「规划中」分组不见了 —— 当前页规则无从复核");
	for (const item of pending) {
		assert.equal(item.current, null, `未就绪项「${item.label}」不该有 aria-current`);
		assert.ok(!item.className.includes("nav-item-current"), `未就绪项「${item.label}」不该有 .nav-item-current`);
	}
	// 回到「项目」页截一张当前页的现场图。
	await clickNav("项目");
	await waitCurrentNav("项目");
	// 视觉通道：抬升面 --bg-raised（等过渡跑完再读，否则只是过渡起点）。
	await settleAnimations(".sidebar-nav");
	const raised = await resolvedColor("--bg-raised");
	const backgrounds = await win.evaluate(() =>
		[...document.querySelectorAll(".sidebar-nav .nav-item")].map((item) => ({
			label: (item.textContent ?? "").trim(),
			background: getComputedStyle(item).backgroundColor,
		})),
	);
	const currentRow = backgrounds.find((item) => item.label === "项目");
	assert.equal(currentRow?.background, raised, `当前页「项目」未使用抬升面底（期望 ${raised}）：${JSON.stringify(currentRow)}`);
	for (const item of backgrounds) {
		if (item.label === "项目") continue;
		assert.equal(
			item.background,
			"rgba(0, 0, 0, 0)",
			`非当前页「${item.label}」不该有抬升面底：${item.background}`,
		);
	}
	await h.shoot("sidebar-current-light");
});

// ══ ② 专家分类胶囊：aria-pressed + 选中底色与未选中不同 ═════════════════
await h.check("② 专家分类：点击后 aria-pressed=true，且底色与未选中项不同", async () => {
	await clickNav("专家·技能·连接器");
	const cats = await waitUntil(
		async () => {
			const value = await win.evaluate(() =>
				[...document.querySelectorAll(".ex-cat")].map((button) => ({
					label: (button.textContent ?? "").trim(),
					pressed: button.getAttribute("aria-pressed"),
					active: button.classList.contains("active"),
					background: getComputedStyle(button).backgroundColor,
				})),
			);
			return value.length >= 2 ? value : null;
		},
		{ timeout: 20_000, desc: "专家分类胶囊加载出「全部」之外的标签" },
	);

	const target = cats.find((cat) => cat.label !== "全部");
	assert.ok(target !== undefined, `专家分类里只有「全部」：${JSON.stringify(cats.map((c) => c.label))}`);
	const clicked = await win.evaluate((label) => {
		const button = [...document.querySelectorAll(".ex-cat")].find((b) => (b.textContent ?? "").trim() === label);
		if (button == null) return false;
		button.click();
		return true;
	}, target.label);
	assert.ok(clicked, `点不到专家分类「${target.label}」`);

	const after = await waitUntil(
		async () => {
			const value = await win.evaluate((label) => {
				const button = [...document.querySelectorAll(".ex-cat")].find((b) => (b.textContent ?? "").trim() === label);
				if (button == null) return null;
				const other = [...document.querySelectorAll(".ex-cat")].find((b) => (b.textContent ?? "").trim() === "全部");
				return {
					pressed: button.getAttribute("aria-pressed"),
					active: button.classList.contains("active"),
					background: getComputedStyle(button).backgroundColor,
					allPressed: other?.getAttribute("aria-pressed"),
					allBackground: other === null || other === undefined ? "" : getComputedStyle(other).backgroundColor,
				};
			}, target.label);
			// 同时要求底色已经变化：background-color 走 --dur-fast 过渡，
			// 类名一挂上就读取会拿到过渡起点的旧底色（实测过）。
			return value?.pressed === "true" && value.background !== value.allBackground ? value : null;
		},
		{ timeout: 10_000, desc: `专家分类「${target.label}」被标为选中` },
	);
	assert.ok(after.active, "选中的专家分类缺少 .active 类");
	assert.equal(cats.find((c) => c.label === "全部")?.pressed, "true", "初始态「全部」应为 aria-pressed=true");
	assert.equal(after.allPressed, "false", "选了具体分类后「全部」应为 aria-pressed=false");
	assert.notEqual(
		after.background,
		after.allBackground,
		`选中与未选中的专家分类底色相同（都是 ${after.background}）—— 选中态不可见`,
	);
	await settleAnimations(".ex-cat.active");
	await h.shoot("expert-selected-light");
	// 暗色下同一控件不翻色（选中底仍是 --primary-active 这一档）。
	await setTheme("dark");
	await h.shoot("expert-selected-dark");
	await setTheme("light");
});

// ══ ② 审计类别筛选：aria-pressed 随点击变化 ═══════════════════════════
await h.check("② 审计类别筛选：aria-pressed 随点击切换，选中底色生效", async () => {
	await win.evaluate(() => {
		const open = document.querySelector('[aria-label="设置"]');
		if (open === null) throw new Error("找不到设置入口");
		open.click();
	});
	await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") !== null), {
		timeout: 15_000,
		desc: "设置对话框挂上",
	});
	const opened = await win.evaluate(() => {
		const item = [...document.querySelectorAll(".settings-nav-item")].find(
			(n) => (n.textContent ?? "").trim() === "审计中心",
		);
		if (item === undefined) return false;
		item.click();
		return true;
	});
	assert.ok(opened, "设置侧栏找不到「审计中心」");

	const filters = await waitUntil(
		async () => {
			const value = await win.evaluate(() =>
				[...document.querySelectorAll('.settings-panel [aria-pressed]')].map((button) => ({
					label: (button.textContent ?? "").trim(),
					pressed: button.getAttribute("aria-pressed"),
					background: getComputedStyle(button).backgroundColor,
				})),
			);
			return value.length >= 2 ? value : null;
		},
		{ timeout: 20_000, desc: "审计中心渲染出类别筛选按钮" },
	);
	assert.equal(filters[0].pressed, "true", `「全部」默认应为选中：${JSON.stringify(filters)}`);

	const category = filters.find((filter) => filter.label !== "全部");
	assert.ok(category !== undefined, "审计类别筛选里只有「全部」");
	await win.evaluate((label) => {
		const button = [...document.querySelectorAll(".settings-panel [aria-pressed]")].find(
			(b) => (b.textContent ?? "").trim() === label,
		);
		button?.click();
	}, category.label);
	const after = await waitUntil(
		async () => {
			const value = await win.evaluate((label) => {
				const buttons = [...document.querySelectorAll(".settings-panel [aria-pressed]")];
				const hit = buttons.find((b) => (b.textContent ?? "").trim() === label);
				const all = buttons.find((b) => (b.textContent ?? "").trim() === "全部");
				return hit === undefined || all === undefined
					? null
					: {
							pressed: hit.getAttribute("aria-pressed"),
							background: getComputedStyle(hit).backgroundColor,
							allPressed: all.getAttribute("aria-pressed"),
							allBackground: getComputedStyle(all).backgroundColor,
						};
			}, category.label);
			return value?.pressed === "true" && value.background !== value.allBackground ? value : null;
		},
		{ timeout: 10_000, desc: `审计类别「${category.label}」被标为选中` },
	);
	assert.equal(after.allPressed, "false", "选了具体类别后「全部」应为 aria-pressed=false");
	assert.notEqual(after.background, after.allBackground, `审计类别选中底色与未选中相同（${after.background}）`);
	await expectHoverKeepsSelected(".settings-panel .mini-btn.active", "审计类别选中项");
});

// ══ ⑤ 回复长度：可见组标签 + 选中态 ═══════════════════════════════════
await h.check("⑤ 回复长度：有可见组标签，点击后 is-selected 且底色变化", async () => {
	const opened = await win.evaluate(() => {
		const item = [...document.querySelectorAll(".settings-nav-item")].find(
			(n) => (n.textContent ?? "").trim() === "个性化",
		);
		if (item === undefined) return false;
		item.click();
		return true;
	});
	assert.ok(opened, "设置侧栏找不到「个性化」");

	const buttons = await waitUntil(
		async () => {
			const value = await win.evaluate(() =>
				[...document.querySelectorAll(".reply-length-btn")].map((button) => ({
					label: (button.textContent ?? "").trim(),
					pressed: button.getAttribute("aria-pressed"),
					selected: button.classList.contains("is-selected"),
					background: getComputedStyle(button).backgroundColor,
				})),
			);
			return value.length === 3 ? value : null;
		},
		{ timeout: 20_000, desc: "个性化页渲染出 3 枚回复长度按钮" },
	);
	const label = await win.evaluate(
		() => document.querySelector(".reply-length-row .reply-length-label")?.textContent?.trim() ?? "",
	);
	assert.equal(label, "回复长度", `胶囊行左侧缺少可见标签「回复长度」，实际「${label}」`);
	// 初始态不该有选中项（也确认旧的 .saved 类没有残留 —— 那是「保存成功闪一下」）。
	assert.ok(
		buttons.every((button) => button.selected === false),
		`初始态不该有 is-selected：${JSON.stringify(buttons)}`,
	);

	const target = "简洁";
	await win.evaluate((text) => {
		const button = [...document.querySelectorAll(".reply-length-btn")].find(
			(b) => (b.textContent ?? "").trim() === text,
		);
		button?.click();
	}, target);
	const after = await waitUntil(
		async () => {
			const value = await win.evaluate((text) => {
				const buttons = [...document.querySelectorAll(".reply-length-btn")];
				const hit = buttons.find((b) => (b.textContent ?? "").trim() === text);
				const other = buttons.find((b) => (b.textContent ?? "").trim() === "详细");
				return hit === undefined
					? null
					: {
							selected: hit.classList.contains("is-selected"),
							pressed: hit.getAttribute("aria-pressed"),
							background: getComputedStyle(hit).backgroundColor,
							otherBackground: getComputedStyle(other).backgroundColor,
						};
			}, target);
			return value?.selected === true && value.background !== value.otherBackground ? value : null;
		},
		{ timeout: 15_000, desc: "「简洁」被标为回复长度选中档" },
	);
	assert.equal(after.pressed, "true", "选中的回复长度按钮 aria-pressed 应为 true");
	assert.notEqual(after.background, after.otherBackground, `选中与未选中回复长度按钮底色相同（${after.background}）`);
	await expectHoverKeepsSelected(".reply-length-btn.is-selected", "回复长度选中项");
	await settleAnimations(".reply-length-btn.is-selected");
	await h.shoot("reply-length-light");
	await setTheme("dark");
	await settleAnimations(".reply-length-btn.is-selected");
	await h.shoot("reply-length-dark");
	await setTheme("light");

	// 关闭设置，回到主界面，为注入卡用例腾出画面。
	await win.evaluate(() => document.querySelector('[aria-label="关闭设置"]')?.click());
	await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") === null), {
		timeout: 10_000,
		desc: "设置对话框关闭",
	});
});

// ══ ⑤ hooks 注入卡：折叠提示、chevron、可聚焦、展开态切换 ═══════════════
await h.check("⑤ hooks 注入卡：折叠态提示「查看内容」，展开后「收起」且箭头旋转", async () => {
	// resumeSession 会创建 host，需要一个可用模型（library.mjs 同一处理）。
	const ready = await win.evaluate(async (ws) => {
		const k = globalThis.kami;
		try {
			await k.saveCustomProvider(
				{
					id: "mock-ui-audit",
					name: "Mock UI Audit",
					baseUrl: "http://127.0.0.1:9/v1",
					api: "openai-completions",
					authHeader: true,
					models: [
						{
							id: "ui-audit-model",
							name: "ui-audit-model",
							reasoning: false,
							vision: false,
							contextWindow: 128000,
							maxTokens: 8192,
						},
					],
				},
				"mock-key",
			);
			await k.setModel("mock-ui-audit/ui-audit-model");
			await k.setWorkspace(ws);
			return true;
		} catch (error) {
			return String(error?.message ?? error).slice(0, 300);
		}
	}, h.WORKSPACE_DIR);
	assert.equal(ready, true, `配置模型失败：${ready}`);

	await waitUntil(
		() =>
			win.evaluate(
				(path) => [...document.querySelectorAll(".task-item")].some((el) => el.dataset.path === path),
				SESSION_PATH,
			),
		{ timeout: 20_000, desc: "侧栏出现预置会话" },
	);
	const clicked = await win.evaluate((path) => {
		const row = [...document.querySelectorAll(".task-item")].find((el) => el.dataset.path === path);
		const body = row?.querySelector(".task-item-body");
		if (body == null) return false;
		body.click();
		return true;
	}, SESSION_PATH);
	assert.ok(clicked, "点不开预置会话（侧栏行的 .task-item-body 不在）");

	const folded = await waitUntil(
		async () => {
			const value = await win.evaluate(() => {
				const card = document.querySelector(".hook-context-card");
				if (card === null) return null;
				const summary = card.querySelector("summary.hook-context-head");
				const closed = card.querySelector(".hook-context-toggle .when-closed");
				const open = card.querySelector(".hook-context-toggle .when-open");
				return {
					open: card.open === true,
					closedText: closed?.textContent?.trim() ?? "",
					closedDisplay: closed === null || closed === undefined ? "" : getComputedStyle(closed).display,
					openText: open?.textContent?.trim() ?? "",
					openDisplay: open === null || open === undefined ? "" : getComputedStyle(open).display,
					chevron: card.querySelector(".hook-context-chevron") !== null,
					summaryTabIndex: summary?.tabIndex ?? -1,
					body: card.querySelector(".hook-context-body")?.textContent ?? "",
				};
			});
			return value !== null && value.body.includes(HOOK_MARK) ? value : null;
		},
		{ timeout: 30_000, desc: "预置会话渲染出 hooks 注入卡与正文" },
	);
	assert.equal(folded.open, false, "注入卡应默认折叠");
	assert.equal(folded.closedText, "查看内容", `折叠态提示应为「查看内容」，实际「${folded.closedText}」`);
	assert.notEqual(folded.closedDisplay, "none", "折叠态「查看内容」应可见");
	assert.equal(folded.openDisplay, "none", "折叠态「收起」不应显示");
	assert.ok(folded.chevron, "注入卡缺少 chevron（.hook-context-chevron）");
	assert.equal(folded.summaryTabIndex, 0, "summary 应可聚焦（tabIndex 0）");
	/*
	 * 减弱动态效果：chevron 的旋转过渡必须真的被关掉。
	 * 全局 reduced-motion 块在 app.css **文件中部**，而本节的基础声明在它之后 ——
	 * 同特异性下按源序基础声明获胜，写在中部的那条等于没写（DESIGN §10.3.1
	 * 「位置是硬约束」）。这条断言就是守这个源序陷阱的。
	 */
	await win.emulateMedia({ reducedMotion: "reduce" });
	const chevronTransition = await win.evaluate(
		() => getComputedStyle(document.querySelector(".hook-context-chevron")).transitionProperty,
	);
	await win.emulateMedia({ reducedMotion: "no-preference" });
	assert.equal(
		chevronTransition,
		"none",
		`减弱动态效果下 chevron 仍有过渡（${chevronTransition}）—— 关停规则被后面的基础声明按源序盖掉了`,
	);
	await h.shoot("hook-context-light");

	await win.evaluate(() => document.querySelector(".hook-context-card summary")?.click());
	const unfolded = await waitUntil(
		async () => {
			const value = await win.evaluate(() => {
				const card = document.querySelector(".hook-context-card");
				if (card === null || card.open !== true) return null;
				const closed = card.querySelector(".hook-context-toggle .when-closed");
				const open = card.querySelector(".hook-context-toggle .when-open");
				const chevron = card.querySelector(".hook-context-chevron");
				return {
					closedDisplay: getComputedStyle(closed).display,
					openDisplay: getComputedStyle(open).display,
					openText: open.textContent?.trim() ?? "",
					transform: getComputedStyle(chevron).transform,
					focused: document.activeElement === card.querySelector("summary"),
				};
			});
			return value !== null && value.openDisplay !== "none" && /matrix\(-1/.test(value.transform) ? value : null;
		},
		{ timeout: 10_000, desc: "注入卡展开且箭头旋转完成" },
	);
	assert.equal(unfolded.openText, "收起", `展开态提示应为「收起」，实际「${unfolded.openText}」`);
	assert.equal(unfolded.closedDisplay, "none", "展开态「查看内容」不应显示");
	assert.match(unfolded.transform, /matrix\(-1/, `展开后箭头应旋转 180°，实际 ${unfolded.transform}`);

	// summary 真的拿得到焦点（键盘可达；focus-visible 环由 app.css 的全局规则承担）。
	const focusable = await win.evaluate(() => {
		const summary = document.querySelector(".hook-context-card summary");
		summary.focus();
		return document.activeElement === summary;
	});
	assert.ok(focusable, "summary 无法获得焦点 —— 键盘用户没有入口");
	await h.shoot("hook-context-open-light");

	await setTheme("dark");
	await h.shoot("hook-context-dark");
	await setTheme("light");
});

// ══ ⑤ 回复长度：历史重复标记的清理（旧版 bug 的残留）═══════════════════
await h.check("⑤ 回复长度：重复的历史标记会被全量清理，读取以最后一条为准", async () => {
	const seeded = await win.evaluate(async () => {
		try {
			await globalThis.kami.setPersonalization({
				customInstructions:
					"我的自定义指令\n\n<!-- zw:reply-length: concise 简洁规则 -->\n\n<!-- zw:reply-length: detailed 详细规则 -->",
			});
			return true;
		} catch (error) {
			return String(error?.message ?? error).slice(0, 200);
		}
	});
	assert.equal(seeded, true, `写入重复标记的自定义指令失败：${seeded}`);

	await win.evaluate(() => document.querySelector('[aria-label="设置"]')?.click());
	await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") !== null), {
		timeout: 15_000,
		desc: "设置对话框挂上",
	});
	await win.evaluate(() => {
		const item = [...document.querySelectorAll(".settings-nav-item")].find(
			(n) => (n.textContent ?? "").trim() === "个性化",
		);
		item?.click();
	});

	// 两条历史标记：选中态应为**最后一条**（detailed），而不是第一条。
	const selectedLabel = await waitUntil(
		async () => {
			const value = await win.evaluate(() => {
				const selected = [...document.querySelectorAll(".reply-length-btn.is-selected")];
				return selected.length === 1 ? (selected[0].textContent ?? "").trim() : "";
			});
			return value === "" ? null : value;
		},
		{ timeout: 15_000, desc: "读到回复长度的当前档" },
	);
	assert.equal(selectedLabel, "详细", `重复标记时应以最后一条为准，实际选中「${selectedLabel}」`);

	// 点另一档：保存后只应剩一条标记，且前缀自定义文本保留。
	await win.evaluate(() => {
		const button = [...document.querySelectorAll(".reply-length-btn")].find(
			(b) => (b.textContent ?? "").trim() === "平衡",
		);
		button?.click();
	});
	const saved = await waitUntil(
		async () => {
			const value = await win.evaluate(() => globalThis.kami.getPersonalization());
			const text = value?.customInstructions ?? "";
			return text.includes("balanced") ? text : null;
		},
		{ timeout: 15_000, desc: "选中档写回自定义指令" },
	);
	const markerCount = [...saved.matchAll(/<!-- zw:reply-length: /g)].length;
	assert.equal(markerCount, 1, `历史重复标记应被全量清理，实际还剩 ${markerCount} 条：${saved}`);
	assert.ok(saved.includes("我的自定义指令"), `原有自定义指令被误删：${saved}`);
	await win.evaluate(() => document.querySelector('[aria-label="关闭设置"]')?.click());
});

await h.check("无渲染层未捕获异常", () => assert.equal(h.pageErrors.length, 0, h.pageErrors.join("; ")));

await h.finish();
