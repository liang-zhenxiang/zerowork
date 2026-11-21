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
 * 11-17-ui-p1-rest 又并入剩余四项 P1（标签前缀 P1-）：
 *   P1-① 首页矮视口下输入卡完整落在首屏；P1-② 统计空态隐藏数据类动作；
 *   P1-③ 记忆空态整块可点进入编辑；P1-④ 侧栏空间组名称与计数分两行。
 * 11-17-ui-p2-polish 并入六项 P2 里五处可见行为（最后一条 check）：设置初始焦点、
 * 关于页链接色、检索焦点环、健康评分状态词、专家页 sr-only h1。
 * 其中统计空态要求「一条会话都没有」，所以预置会话（hooks 注入卡）改到这些
 * 空态用例之后再落盘，并用一次渲染层重载让侧栏拿到新的 taskList。
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
/**
 * 落盘预置会话。
 *
 * **必须在「统计页空态」与「记忆空态」两条用例跑完之后再调用**：usageStats 把
 * 任何「有消息的会话」计入 totalSessions，先落盘会让统计页不再是空态。
 * 写入后渲染层需要重载一次才能拿到新的 taskList 与空间分组（侧栏没有文件监听）。
 */
function seedHookSession() {
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
}

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

/* ══ 任务 11-17-ui-p1-rest 新增的四项 ───────────────────────────────────── */

/**
 * 请求窗口尺寸，等它**连续两帧稳定**后返回**实际**尺寸。
 *
 * 与 gui-plan-book.mjs 同款：CI runner 的屏幕会把请求钳制（1024×679 上下的
 * 物理屏），断言一律按实际 innerHeight，不写死请求值（testing spec「断言不要
 * 依赖本机恰好配了什么」）。
 */
async function resizeWindow(width, height) {
	return win.evaluate(
		({ w, h: h2 }) =>
			new Promise((resolve) => {
				window.resizeTo(w, h2);
				let last = "";
				let stable = 0;
				const onResize = () => {
					stable = 0;
				};
				const tick = () => {
					const now = `${window.innerWidth}x${window.innerHeight}`;
					stable = now === last ? stable + 1 : 0;
					last = now;
					if (stable >= 2) {
						window.removeEventListener("resize", onResize);
						resolve({ width: window.innerWidth, height: window.innerHeight });
						return;
					}
					window.requestAnimationFrame(tick);
				};
				window.addEventListener("resize", onResize);
				window.requestAnimationFrame(tick);
			}),
		{ w: width, h: height },
	);
}

// ══ ① 首页矮视口：输入卡完整落在 .home 可视区内 ═════════════════════════
await h.check("P1-① 首页矮视口：composer 完整可见，案例区不压到输入卡上", async () => {
	await waitUntil(
		async () =>
			(await win.evaluate(() => {
				const home = document.querySelector("main.home");
				const composer = document.querySelector(".composer-slot");
				// 案例区是绝对定位的兄弟块，重叠断言要用它 —— 一并等它出现。
				const cases = document.querySelector(".cases");
				if (home === null || composer === null || cases === null) return null;
				return {
					home: home.getBoundingClientRect().height,
					composer: composer.getBoundingClientRect().height,
					cases: cases.getBoundingClientRect().height,
				};
			})) !== null,
		{ timeout: 30_000, desc: "首页渲染出 .home、.composer-slot 与 .cases" },
	);
	// 首页有异步内容（今日统计、上手清单），空闲态才适合 waitForSettled。
	await h.waitForSettled();
	/*
	 * 把「测量前字体已就绪」钉成断言（Issue #443）：`waitForSettled` 现在会在观察
	 * DOM 静默期之前先等 `document.fonts.ready`，因为字体替换**不改 DOM**、不会重置
	 * 静默计时，而它决定行盒高度 —— 字体晚到会让案例区从 212.4 变成 226.8，
	 * 预留 268 只多 0.4px，于是被误判成「压到输入卡上」。这条断言失败说明等待
	 * 又退回到了「不等字体」，而不是布局本身出了问题。
	 */
	assert.equal(
		await win.evaluate(() => document.fonts.status),
		"loaded",
		"waitForSettled 返回时字体尚未就绪 —— 布局测量会落在字体替换的中途",
	);
	const before = await win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
	/*
	 * 860 逻辑高下必须**完全没有变化**（§3.8 的 12:12:24:16 配比、眉标与能力宫格
	 * 都不该被矮视口规则波及）。CI runner 的屏幕会把 1280×860 钳到 679 上下，
	 * 那条分支在那里不成立 —— 所以只在「初始窗口确实高于 720」时断言，
	 * 本机（1280×860）会真的走到。
	 */
	if (before.height > 840) {
		const wide = await win.evaluate(() => {
			const main = document.querySelector(".home-main");
			const eyebrow = document.querySelector(".home-eyebrow");
			const capability = document.querySelector(".capability-zone");
			const home = document.querySelector("main.home").getBoundingClientRect();
			const composer = document.querySelector(".composer-slot").getBoundingClientRect();
			return {
				innerHeight: window.innerHeight,
				paddingBottom: main === null ? null : getComputedStyle(main).paddingBottom,
				eyebrow: eyebrow === null ? null : getComputedStyle(eyebrow).display,
				capability: capability === null ? null : getComputedStyle(capability).display,
				homeBottom: home.bottom,
				composerBottom: composer.bottom,
			};
		});
		assert.equal(wide.paddingBottom, "268px", "860 高下案例预留被误改（§3.8 的配比基线）");
		assert.notEqual(wide.eyebrow, "none", "860 高下眉标不该被收起");
		assert.notEqual(wide.capability, "none", "860 高下能力宫格不该被收起");
		assert.ok(
			wide.composerBottom <= wide.homeBottom + 0.5,
			`完整档（innerHeight=${wide.innerHeight}）输入卡也不该溢出：` +
				`composer.bottom=${wide.composerBottom.toFixed(1)}，home.bottom=${wide.homeBottom.toFixed(1)}`,
		);
	}

	/** 读一屏的布局事实（几何 + 两档的显示状态 + 案例预留）。 */
	const readLayout = () =>
		win.evaluate(() => {
			const homeEl = document.querySelector("main.home");
			const home = homeEl.getBoundingClientRect();
			const composer = document.querySelector(".composer-slot").getBoundingClientRect();
			const casesEl = document.querySelector(".cases");
			const cases = casesEl === null ? null : casesEl.getBoundingClientRect();
			const styleOf = (selector) => {
				const el = document.querySelector(selector);
				return el === null ? null : getComputedStyle(el).display;
			};
			const main = document.querySelector(".home-main");
			return {
				innerHeight: window.innerHeight,
				home: {
					top: home.top,
					bottom: home.bottom,
					scrollHeight: homeEl.scrollHeight,
					clientHeight: homeEl.clientHeight,
				},
				composer: { top: composer.top, bottom: composer.bottom, height: composer.height },
				cases: cases === null ? null : { top: cases.top, bottom: cases.bottom, height: cases.height },
				eyebrow: styleOf(".home-eyebrow"),
				capability: styleOf(".capability-zone"),
				paddingBottom: main === null ? null : getComputedStyle(main).paddingBottom,
			};
		});

	/** 任一档的硬约束：输入卡完整可见、案例区不压上来且可滚动到。 */
		const dumpHomeChildren = () =>
		win.evaluate(() => {
			const home = document.querySelector("main.home");
			return [...(home?.children ?? [])].map((el) => ({
				tag: el.tagName.toLowerCase(),
				cls: [...el.classList].join("."),
				h: Math.round(el.getBoundingClientRect().height),
				pos: getComputedStyle(el).position,
			}));
		});

	const assertShortLayout = (geometry) => {
		void dumpHomeChildren().then((dump) => {
			console.log("[P1-diag]", JSON.stringify(dump));
		});
		const where = `innerHeight=${geometry.innerHeight}`;
		assert.ok(geometry.composer.height > 0, `${where}：输入卡高度为 0（没渲染出来）`);
		assert.ok(
			geometry.composer.top >= geometry.home.top - 0.5,
			`输入卡上缘被顶出 .home：composer.top=${geometry.composer.top.toFixed(1)}，` +
				`home.top=${geometry.home.top.toFixed(1)}（${where}）`,
		);
		assert.ok(
			geometry.composer.bottom <= geometry.home.bottom + 0.5,
			`${where} 下输入卡底边超出 .home：composer.bottom=${geometry.composer.bottom.toFixed(1)}，` +
				`home.bottom=${geometry.home.bottom.toFixed(1)} —— 主输入框首屏看不到`,
		);
		/*
		 * 只保证输入卡在首屏还不够 —— 案例区是**绝对定位**、钉在 .home-inner 底部
		 * 56px 处，预留一旦降得比「案例区实际高 + 56」还小，它就会盖到输入卡上
		 * （170 的预留实测入侵约 90px）。容差 2px：860 高下两者本来就只差约 0.4px。
		 */
		assert.ok(geometry.cases !== null, `${where}：首页没有案例区 —— 无法确认它是否压到输入卡上`);
		assert.ok(
			geometry.cases.top >= geometry.composer.bottom - 2,
			`案例区压到输入卡上：composer.bottom=${geometry.composer.bottom.toFixed(1)}，` +
				`cases.top=${geometry.cases.top.toFixed(1)}（案例区高 ${geometry.cases.height.toFixed(1)}，${where}）` +
				" —— 核对 --home-case-reserve 是否小于「案例区高 + 56」",
		);
		// 内容超出首屏时要真的能滚动到案例区，而不是被裁掉。
		assert.ok(
			geometry.home.scrollHeight > geometry.home.clientHeight,
			`${where}：内容超出首屏却不可滚动：scrollHeight=${geometry.home.scrollHeight}，` +
				`clientHeight=${geometry.home.clientHeight}`,
		);
		assert.ok(
			geometry.home.scrollHeight + 1 >= geometry.cases.bottom - geometry.home.top,
			`案例区被裁掉、滚不到：cases.bottom=${geometry.cases.bottom.toFixed(1)}，` +
				`home.top=${geometry.home.top.toFixed(1)}，scrollHeight=${geometry.home.scrollHeight}`,
		);
		assert.equal(
			geometry.paddingBottom,
			"268px",
			`${where}：案例预留被改成 ${geometry.paddingBottom} —— 它必须保持 268（小于「案例区高 + 56」就会压住输入卡）`,
		);
	};

	/*
	 * 分级覆盖：820（首档，能力宫格应保留）、800（次档起点）、679（CI 视口）。
	 * 断言按**实际** innerHeight 分档 —— CI runner 屏幕只有 679 上下，前两档会被
	 * 钳制到 679，此时它们退化成对同一档的重复校验（不假红）；本机（1280×860）
	 * 三档都真的走得到。
	 */
	for (const requested of [820, 800, 679]) {
		const actual = await resizeWindow(1280, requested);
		await h.waitForSettled();
		const geometry = await readLayout();
		assert.ok(
			geometry.innerHeight <= requested + 1,
			`窗口没有缩到 ${requested}：实际 innerHeight=${geometry.innerHeight}（${actual.width}×${actual.height}）`,
		);
		assertShortLayout(geometry);
		const where = `innerHeight=${geometry.innerHeight}（请求 ${requested}）`;
		// 眉标在 ≤840 一律收起；能力宫格只在 ≤800 收起（820/860 保留）。
		assert.equal(geometry.eyebrow, "none", `${where}：装饰眉标应收起`);
		if (geometry.innerHeight > 800) {
			assert.notEqual(geometry.capability, "none", `${where}：能力宫格应保留（首档）`);
		} else {
			assert.equal(geometry.capability, "none", `${where}：能力宫格应收起（次档）`);
		}
		await h.shoot(`home-h${requested}-light`);
	}

	await setTheme("dark");
	await h.shoot("home-short-dark");
	await setTheme("light");
	// 恢复到进入本用例前的尺寸；CI 上同样可能被屏幕钳制，按实际值即可。
	await resizeWindow(before.width, before.height);
	await h.waitForSettled();
});

/*
 * 窄宽分支（issue #437）：窗口最小宽度 900 下，`.bento-grid` 必须是**单行横滚**，
 * 而不是退回 2 列 —— 2 列会让 8 张卡排 4 行，能力宫格从 151px 长到 286px，
 * 在 860 高下把输入卡顶出首屏（实测 composer 底 979 > home 底 854）。
 *
 * 单独成一条 check 而不是塞进上一条：它的前提是「860 高」，而 CI runner 的物理屏
 * 会把窗口钳到 679；前提不成立时必须**显式 SKIP**（check 里 h.skip 会把整条记为
 * SKIP、不计入 passed），不能把断言放宽成永远绿。
 */
const NARROW_LABEL = "P1-①b 首页窄宽 900：宫格单行横滚，composer 仍完整落在首屏";
await h.check(NARROW_LABEL, async () => {
	const restoreTo = await win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
	const actual = await resizeWindow(900, 860);
	await h.waitForSettled();
	try {
		/*
		 * 高度被钳到 ≤840 时矮视口档（收眉标 / 收能力宫格）会接管布局，
		 * 「宫格换行顶出输入卡」根本不会发生；宽度没落到 ≤900 时窄宽档也复现不了。
		 * 两种都跳过，并在报告里留下实际钳制尺寸。
		 */
		if (actual.height <= 840 || actual.width > 900) {
			h.skip(
				NARROW_LABEL,
				`窗口被钳制到 ${actual.width}×${actual.height}，900 宽 × 860 高分支在本机不可复现`,
			);
		}
		const state = await win.evaluate(() => {
			const home = document.querySelector("main.home")?.getBoundingClientRect() ?? null;
			const composer = document.querySelector(".composer-slot")?.getBoundingClientRect() ?? null;
			const zone = document.querySelector(".capability-zone");
			const grid = document.querySelector(".bento-grid");
			const cards = [...document.querySelectorAll(".bento-card")];
			return {
				innerWidth: window.innerWidth,
				innerHeight: window.innerHeight,
				zoneDisplay: zone === null ? null : getComputedStyle(zone).display,
				gridDisplay: grid === null ? null : getComputedStyle(grid).display,
				gridClientWidth: grid === null ? null : grid.clientWidth,
				gridScrollWidth: grid === null ? null : grid.scrollWidth,
				cardCount: cards.length,
				cardRows: new Set(cards.map((card) => Math.round(card.getBoundingClientRect().top))).size,
				homeTop: home === null ? null : home.top,
				homeBottom: home === null ? null : home.bottom,
				composerTop: composer === null ? null : composer.top,
				composerBottom: composer === null ? null : composer.bottom,
			};
		});
		const where = `innerWidth=${state.innerWidth} × innerHeight=${state.innerHeight}`;
		// 先截图后断言：失败时才有窄宽首页的现场。
		await h.shoot("home-narrow-900-light");
		assert.ok(state.zoneDisplay !== "none", `${where}：860 高下能力宫格不该被收起`);
		// 先断用户可见的后果（输入卡溢出），再断造成它的形态 —— 反向验证时
		// 报错文案直接给出 composer.bottom，而不是一句「display 不是 flex」。
		assert.ok(
			state.composerTop >= state.homeTop - 0.5,
			`输入卡上缘被顶出 .home：composer.top=${state.composerTop.toFixed(1)}，` +
				`home.top=${state.homeTop.toFixed(1)}（${where}）`,
		);
		assert.ok(
			state.composerBottom <= state.homeBottom + 0.5,
			`${where} 下输入卡底边超出 .home：composer.bottom=${state.composerBottom.toFixed(1)}，` +
				`home.bottom=${state.homeBottom.toFixed(1)} —— 主输入框首屏看不到`,
		);
		assert.equal(state.gridDisplay, "flex", `${where}：窄宽档的宫格应改为 flex 单行（实际 ${state.gridDisplay}）`);
		assert.equal(state.cardCount, 8, `${where}：8 张能力卡应全部留在 DOM 中（实际 ${state.cardCount}）`);
		assert.equal(state.cardRows, 1, `${where}：宫格排成 ${state.cardRows} 行 —— 应单行横滚`);
		assert.ok(
			state.gridScrollWidth > state.gridClientWidth,
			`${where}：宫格没有横向溢出，说明没形成横滚：` +
				`scrollWidth=${state.gridScrollWidth}，clientWidth=${state.gridClientWidth}`,
		);
	} finally {
		// 无论断言成败都把窗口还给后面的用例（它们假定 1280 宽）。
		await resizeWindow(restoreTo.width, restoreTo.height);
		await h.waitForSettled();
	}
});

// ══ ② 统计页空态：数据类动作隐藏，恢复动作保留 ═════════════════════════
await h.check("P1-② 统计空态：隐藏分享卡/本周摘要/导出 CSV，重试首页无 refresh 图标", async () => {
	await clickNav("统计");
	const header = await waitUntil(
		async () => {
			const value = await win.evaluate(() => {
				const main = document.querySelector("main.settings");
				if (main === null) return null;
				const empty = main.querySelector(".state-empty-title");
				if (empty === null) return null;
				const buttons = [...main.querySelectorAll(".settings-head .mini-btn")].map((button) => ({
					label: (button.textContent ?? "").trim(),
					svg: button.querySelector("svg") !== null,
				}));
				return { empty: (empty.textContent ?? "").trim(), buttons };
			});
			return value !== null ? value : null;
		},
		{ timeout: 20_000, desc: "统计页进入空态" },
	);
	assert.ok(header.empty.includes("还没有任何会话"), `统计页不是空态：${header.empty}`);
	await h.shoot("stats-empty-light");
	const labels = header.buttons.map((button) => button.label);
	for (const hidden of ["分享卡", "本周摘要", "导出 CSV"]) {
		assert.ok(!labels.includes(hidden), `空态下不该出现「${hidden}」：${JSON.stringify(labels)}`);
	}
	assert.ok(labels.includes("刷新"), `空态下仍要能刷新：${JSON.stringify(labels)}`);
	assert.ok(labels.includes("重试首页"), `空态下仍要能重试首页：${JSON.stringify(labels)}`);
	const retry = header.buttons.find((button) => button.label === "重试首页");
	assert.equal(
		retry.svg,
		false,
		"「重试首页」不该再带 refresh 图标 —— 与「刷新」同图标时两件事分不清",
	);
	const refresh = header.buttons.find((button) => button.label === "刷新");
	assert.equal(refresh.svg, true, "「刷新」应保留图标");
	await setTheme("dark");
	await h.shoot("stats-empty-dark");
	await setTheme("light");
});

// ══ ③ 记忆空态：整块可点进入编辑 ═══════════════════════════════════════
await h.check("P1-③ 记忆空态：整块 role=button，点击后出现编辑框", async () => {
	await win.evaluate(() => document.querySelector('[aria-label="设置"]')?.click());
	await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") !== null), {
		timeout: 15_000,
		desc: "设置对话框挂上",
	});
	const opened = await win.evaluate(() => {
		const item = [...document.querySelectorAll(".settings-nav-item")].find(
			(n) => (n.textContent ?? "").trim() === "记忆与进化",
		);
		if (item === undefined) return false;
		item.click();
		return true;
	});
	assert.ok(opened, "设置侧栏找不到「记忆与进化」");

	const view = await waitUntil(
		async () => {
			const value = await win.evaluate(() => {
				const el = document.querySelector(".profile-view");
				if (el === null) return null;
				return {
					role: el.getAttribute("role"),
					tabIndex: el.tabIndex,
					text: (el.textContent ?? "").trim(),
				};
			});
			return value !== null && value.text !== "" ? value : null;
		},
		{ timeout: 20_000, desc: "长期记忆空态渲染" },
	);
	assert.equal(view.role, "button", "空态块应挂 button 语义（键盘可进入）");
	assert.equal(view.tabIndex, 0, "空态块应进入 Tab 序列（tabIndex=0）");
	assert.ok(view.text.includes("点击编辑添加"), `空态文案变了：${view.text}`);

	await win.evaluate(() => document.querySelector(".profile-view")?.click());
	const editing = await waitUntil(
		async () =>
			(await win.evaluate(() => {
				const textarea = document.querySelector('textarea[aria-label="长期记忆"]');
				return textarea === null ? null : { visible: textarea.offsetHeight > 0 };
			}))?.visible === true
				? true
				: null,
		{ timeout: 10_000, desc: "点击空态块进入编辑态" },
	);
	assert.equal(editing, true, "点了空态块却没有出现编辑框 —— 承诺的「点击编辑添加」不成立");
	await h.shoot("memory-edit-light");
	await setTheme("dark");
	await h.shoot("memory-edit-dark");
	await setTheme("light");
	// 取消后必须回到可点的查看态：原「编辑」/「取消」流程不能被点击语义吃掉。
	await win.evaluate(() => {
		const button = [...document.querySelectorAll(".mini-btn")].find(
			(b) => (b.textContent ?? "").trim() === "取消",
		);
		button?.click();
	});
	await waitUntil(
		async () =>
			(await win.evaluate(() => {
				const el = document.querySelector(".profile-view");
				return el === null ? null : { role: el.getAttribute("role") };
			}))?.role === "button"
				? true
				: null,
		{ timeout: 10_000, desc: "取消编辑后回到 role=button 的查看态" },
	);
	// 键盘路径：Enter 也必须进入编辑（空态文案不只承诺鼠标）。
	await win.evaluate(() => {
		const el = document.querySelector(".profile-view");
		el?.focus();
		el?.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
	});
	await waitUntil(
		async () =>
			(await win.evaluate(() => {
				const textarea = document.querySelector('textarea[aria-label="长期记忆"]');
				return textarea === null ? null : textarea.offsetHeight > 0;
			}))
				? true
				: null,
		{ timeout: 10_000, desc: "在查看态按 Enter 进入编辑态" },
	);
	// 再取消一次，然后关闭设置，避免影响后续用例。
	await win.evaluate(() => {
		const button = [...document.querySelectorAll(".mini-btn")].find(
			(b) => (b.textContent ?? "").trim() === "取消",
		);
		button?.click();
	});
	await win.evaluate(() => document.querySelector('[aria-label="关闭设置"]')?.click());
	await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") === null), {
		timeout: 10_000,
		desc: "设置对话框关闭",
	});
});

// ══ ④ 侧栏空间组：名称第一行、计数第二行 ═══════════════════════════════
/*
 * 本项需要一条**有真实 cwd 的会话**才会出现空间组，而上面的统计空态要求
 * 「一条会话都没有」—— 所以预置会话在两条空态用例之后才落盘，并重载一次
 * 渲染层（侧栏没有 sessions 目录的文件监听，重载才能拿到新的 taskList /
 * groupMetas）。重载后 daemon 与配置都在，只重建渲染层，代价约两秒。
 */
seedHookSession();
await win.reload({ waitUntil: "domcontentloaded" });
await waitUntil(
	async () =>
		(await win.evaluate(
			() =>
				document.querySelector("main.home") !== null &&
				document.querySelector(".sidebar-nav .nav-item") !== null &&
				document.querySelector(".composer-slot") !== null,
		))
			? true
			: null,
	{ timeout: 30_000, desc: "重载后界面重新就绪" },
);
await h.waitForSettled();

await h.check("P1-④ 侧栏空间组：名称独占第一行，计数在第二行缩进对齐", async () => {
	const group = await waitUntil(
		async () => {
			const value = await win.evaluate(() => {
				const main = document.querySelector(".space-group-header-main");
				if (main === null) return null;
				const titleRow = main.querySelector(".space-group-title-row");
				const name = main.querySelector(".space-group-name");
				const sub = main.querySelector(".space-group-sub-row");
				if (titleRow === null || name === null || sub === null) return null;
				const nameRect = name.getBoundingClientRect();
				const subRect = sub.getBoundingClientRect();
				const mainRect = main.getBoundingClientRect();
				const indent = parseFloat(getComputedStyle(sub).paddingLeft);
				return {
					name: {
						top: nameRect.top,
						bottom: nameRect.bottom,
						left: nameRect.left,
						width: nameRect.width,
						scrollWidth: name.scrollWidth,
						clientWidth: name.clientWidth,
					},
					sub: {
						top: subRect.top,
						bottom: subRect.bottom,
						textLeft: subRect.left + indent,
						text: (sub.textContent ?? "").trim(),
					},
					mainWidth: mainRect.width,
				};
			});
			return value !== null ? value : null;
		},
		{ timeout: 30_000, desc: "侧栏渲染出空间组两行结构" },
	);
	assert.ok(
		group.sub.top >= group.name.bottom - 1,
		`会话计数没有落到第二行：name.bottom=${group.name.bottom.toFixed(1)}，` +
			`sub.top=${group.sub.top.toFixed(1)}`,
	);
	assert.ok(
		group.name.width >= 60,
		`组名可见宽度只有 ${group.name.width.toFixed(1)}px（侧栏内容宽 ${group.mainWidth.toFixed(1)}px）—— ` +
			"仍被挤成 1~3 个字",
	);
	assert.ok(group.sub.text.includes("会话"), `第二行应显示会话计数：${group.sub.text}`);
	assert.ok(
		Math.abs(group.sub.textLeft - group.name.left) <= 2,
		`第二行没有缩进对齐名称：计数起点 ${group.sub.textLeft.toFixed(1)}，名称起点 ${group.name.left.toFixed(1)}`,
	);
	await h.shoot("sidebar-group-light");
	await setTheme("dark");
	await h.shoot("sidebar-group-dark");
	await setTheme("light");
});

// ══ ②-补 统计非空态：空态只是「隐藏」，不是「删掉」这五个动作 ═════════
/*
 * 上面的 P1-② 只验了空态。空态的实现如果是「把按钮删掉」，这里就会缺项 ——
 * 预置会话落盘后统计页不再是空态，五个动作必须全都回来。
 */
await h.check("P1-② 统计非空态：五个动作照旧，重试首页仍无 refresh 图标", async () => {
	await clickNav("统计");
	const header = await waitUntil(
		async () => {
			const value = await win.evaluate(() => {
				const main = document.querySelector("main.settings");
				if (main === null) return null;
				// .stat-grid 只出现在非空分支，用它当「数据已就位」的信号。
				if (main.querySelector(".stat-grid") === null) return null;
				// 非空页里仍可能有分区级空态（如「还没有 token 记录」），
				// 判「整页空态」必须认那条顶层文案，不能见到任一 .state-empty 就下结论。
				const emptyTitles = [...main.querySelectorAll(".state-empty-title")].map((node) =>
					(node.textContent ?? "").trim(),
				);
				return {
					empty: emptyTitles.some((title) => title.includes("还没有任何会话")),
					buttons: [...main.querySelectorAll(".settings-head .mini-btn")].map((button) => ({
						label: (button.textContent ?? "").trim(),
						svg: button.querySelector("svg") !== null,
					})),
				};
			});
			return value !== null && value.buttons.length > 0 ? value : null;
		},
		{ timeout: 20_000, desc: "统计页渲染出非空数据（预置会话应计入 totalSessions）" },
	);
	assert.equal(header.empty, false, "预置了会话，统计页仍是空态 —— 非空态用例无从验证");
	const labels = header.buttons.map((button) => button.label);
	assert.equal(
		labels.length,
		5,
		`非空态头部应恰好 5 个动作（分享卡/本周摘要/导出 CSV/刷新/重试首页）：${JSON.stringify(labels)}`,
	);
	for (const label of ["分享卡", "本周摘要", "导出 CSV", "刷新", "重试首页"]) {
		assert.ok(labels.includes(label), `非空态缺少「${label}」：${JSON.stringify(labels)}`);
	}
	assert.equal(
		header.buttons.find((button) => button.label === "重试首页")?.svg,
		false,
		"「重试首页」在任何状态下都不该带 refresh 图标（与「刷新」同图标时两件事分不清）",
	);
	await h.shoot("stats-nonempty-light");
});

// ══ ④ 资料库空态：统计块在上、空态卡在下且水平居中（不得并排）══════════
await h.check("④ 资料库空态：统计块与空态卡上下排列，空态卡水平居中", async () => {
	await clickNav("资料库");
	const rects = await waitUntil(
		async () => {
			const value = await win.evaluate(() => {
				const body = document.querySelector("main.settings .settings-body");
				// 资料库顶部摘要从三格统计改成一行的 .lib-summary（#423）；
				// 兼容旧选择器，避免这条版式断言随标记改名而失去信号。
				const overview = body?.querySelector(":scope > .data-overview, :scope > .lib-summary");
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
		{ timeout: 20_000, desc: "资料库同时渲染出顶部摘要（.lib-summary / .data-overview）与 .state-empty" },
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
	/*
	 * 居中判据用**同级统计块的内容轴**，不用 body 的左右边界：body 带内边距
	 * 与滚动条 gutter，两端留白天然不对称（CI 上实测差 11px，本机差 0），
	 * 拿它判「居中」会把正确布局判红。统计块与空态卡是同一内容列里的兄弟，
	 * 两者中心对齐才是用户看到的「居中」。
	 */
	const overviewCenter = (rects.overview.left + rects.overview.right) / 2;
	const emptyCenter = (rects.empty.left + rects.empty.right) / 2;
	assert.ok(
		Math.abs(overviewCenter - emptyCenter) <= 8,
		`空态卡没有与统计块同一内容轴居中：统计块中心 ${overviewCenter.toFixed(1)}px，` +
			`空态卡中心 ${emptyCenter.toFixed(1)}px`,
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

// ══ 收尾三项：平台文案、Hooks 规则折叠（计划书暗色在 gui-plan-book 里）════
await h.check("设置页：存储位置用平台中立文案；Hooks 规则说明默认折叠", async () => {
	await win.evaluate(() => document.querySelector('[aria-label="设置"]')?.click());
	await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") !== null), {
		timeout: 15_000,
		desc: "设置对话框挂上",
	});
	const clickNav = (label) =>
		win.evaluate((text) => {
			const item = [...document.querySelectorAll(".settings-nav-item")].find(
				(n) => (n.textContent ?? "").trim() === text,
			);
			item?.click();
		}, label);

	await clickNav("数据管理");
	const row = await waitUntil(
		async () => {
			const value = await win.evaluate(() => {
				// 页面里有多条 .data-ops-row（备份 / 体检 / 存储位置），按文案锁定。
				const node = [...document.querySelectorAll(".data-ops-row")].find((n) =>
					(n.textContent ?? "").includes("存储位置"),
				);
				return node === undefined ? null : (node.textContent ?? "").trim();
			});
			return value === null ? null : value;
		},
		{ timeout: 15_000, desc: "数据管理渲染出存储位置行" },
	);
	assert.ok(row.includes("在文件夹中显示"), `存储位置按钮应是平台中立文案：${row}`);
	assert.ok(!row.includes("Finder"), `macOS 专属文案「Finder」不该出现在跨平台界面：${row}`);

	await clickNav("通用");
	const folded = await waitUntil(
		async () => {
			const value = await win.evaluate(() => {
				const details = document.querySelector(".hooks-rules");
				if (details === null) return null;
				const summary = details.querySelector("summary");
				return {
					open: details.open === true,
					summary: (summary?.textContent ?? "").trim(),
					summaryDisplay: summary === null ? "" : getComputedStyle(summary).display,
				};
			});
			return value === null ? null : value;
		},
		{ timeout: 20_000, desc: "Hooks 分组出现规则说明" },
	);
	assert.equal(folded.open, false, "Hooks 规则说明应默认折叠（设置页要能扫读）");
	assert.ok(folded.summary.includes("规则说明"), `折叠标题应含「规则说明」：${folded.summary}`);
	await win.evaluate(() => document.querySelector(".hooks-rules summary")?.click());
	const opened = await waitUntil(
		async () =>
			(await win.evaluate(() => document.querySelector(".hooks-rules")?.open === true)) ? true : null,
		{ timeout: 10_000, desc: "规则说明可展开" },
	);
	assert.equal(opened, true, "点击后规则说明应展开");
	await win.evaluate(() => document.querySelector('[aria-label="关闭设置"]')?.click());
});

/* ══ 任务 11-17-ui-p2-polish：六项打磨里五处「只有真跑起来才看得见」的行为 ══ */
await h.check("P2：设置初始焦点、关于链接、检索焦点环、健康文案、专家页 sr-only h1", async () => {
	// ① 打开设置：初始焦点落在当前分组的导航项，而不是右上角关闭键
	//    （useModalFocus 默认取第一个可聚焦元素，那颗正是关闭键）。
	await win.evaluate(() => document.querySelector('[aria-label="设置"]')?.click());
	await waitUntil(
		async () =>
			(await win.evaluate(() => document.querySelector(".settings-card") !== null)) ? true : null,
		{ timeout: 15_000, desc: "设置对话框挂上" },
	);
	const focus = await win.evaluate(
		() =>
			new Promise((resolve) => {
				// 焦点在 ref 回调里同步设置；等一帧让样式与 class 都落定再读。
				window.requestAnimationFrame(() => {
					const active = document.activeElement;
					const current = document.querySelector(".settings-nav-item[aria-current='page']");
					resolve({
						activeLabel: (active?.getAttribute("aria-label") ?? active?.textContent ?? "").trim(),
						isClose: active?.getAttribute("aria-label") === "关闭设置",
						isNavItem: active?.classList?.contains("settings-nav-item") === true,
						isCurrent: current !== null && active === current,
						currentLabel: (current?.textContent ?? "").trim(),
					});
				});
			}),
	);
	assert.equal(focus.isClose, false, `设置初始焦点落在关闭键上（active=${focus.activeLabel}）`);
	assert.ok(focus.isNavItem, `设置初始焦点不在分组导航项上（active=${focus.activeLabel}）`);
	assert.equal(focus.isCurrent, true, `设置初始焦点不是当前分组「${focus.currentLabel}」`);

	// ② 「关于」页脚注链接与全站可点标识同色（--accent），不是浏览器默认蓝。
	await win.evaluate(() => {
		const item = [...document.querySelectorAll(".settings-nav-item")].find(
			(n) => (n.textContent ?? "").trim() === "关于",
		);
		item?.click();
	});
	const linkColor = await waitUntil(
		async () => {
			const value = await win.evaluate(() => {
				const link = document.querySelector(".settings-foot a");
				return link === null ? null : getComputedStyle(link).color;
			});
			return value;
		},
		{ timeout: 15_000, desc: "关于页脚注链接出现" },
	);
	const accent = await resolvedColor("--accent");
	assert.equal(linkColor, accent, `关于页链接色=${linkColor}（浏览器默认蓝？），应等于 --accent ${accent}`);
	await win.evaluate(() => document.querySelector('[aria-label="关闭设置"]')?.click());
	await waitUntil(
		async () =>
			(await win.evaluate(() => document.querySelector(".settings-card") === null)) ? true : null,
		{ timeout: 10_000, desc: "设置对话框关闭" },
	);

	// ③ 会话检索：外框焦点环与全局焦点语言同色（--ring，不再是 --text-secondary）。
	await clickNav("会话检索");
	const outline = await waitUntil(
		async () => {
			const value = await win.evaluate(() => {
				const input = document.querySelector(".ss-field .ss-input");
				if (input === null) return null;
				input.focus();
				const field = input.closest(".ss-field");
				return {
					focused: field?.matches(":focus-within") === true,
					color: field === null ? "" : getComputedStyle(field).outlineColor,
				};
			});
			return value?.focused === true ? value : null;
		},
		{ timeout: 15_000, desc: "会话检索输入框获得焦点" },
	);
	const ring = await resolvedColor("--ring");
	assert.equal(outline.color, ring, `检索焦点环色=${outline.color}，应等于 --ring ${ring}`);

	// ④ 诊断：扣分行的状态词是「待改善」——紧挨「10 / 25」时「扣分」会被读成
	//    「扣了 10 分」（口径是四项合计，不是单行扣分）。
	//    哪一项是扣分行取决于本机配置（开发机可能已有可用模型），所以按
	//    status 类（.deduct）锁定而非写死「模型可用」——testing spec §四·补：
	//    断言不依赖本机恰好配了什么。
	await clickNav("诊断");
	const healthRows = await waitUntil(
		async () => {
			const value = await win.evaluate(() =>
				[...document.querySelectorAll(".health-row")].map((row) => ({
					name: (row.querySelector(".health-row-name")?.textContent ?? "").trim(),
					state: (row.querySelector(".health-row-state")?.textContent ?? "").trim(),
					deduct: row.querySelector(".health-row-state")?.classList.contains("deduct") === true,
				})),
			);
			return Array.isArray(value) && value.length === 4 ? value : null;
		},
		{ timeout: 20_000, desc: "诊断页健康评分四行渲染" },
	);
	for (const row of healthRows) {
		assert.ok(
			["正常", "待改善", "无法判断"].includes(row.state),
			`「${row.name}」状态文案=${row.state}（应是这三词之一）`,
		);
	}
	const deductRows = healthRows.filter((row) => row.deduct);
	for (const row of deductRows) {
		assert.equal(row.state, "待改善", `「${row.name}」扣分行状态=${row.state}（应显示「待改善」而不是「扣分」）`);
	}
	assert.ok(
		healthRows.every((row) => row.state !== "扣分"),
		`状态词仍是「扣分」：${healthRows.map((row) => `${row.name}=${row.state}`).join(" / ")}`,
	);

	// ⑤ 专家页：没有可见 h1，但有 sr-only 标题给读屏用户报「当前在哪」。
	await clickNav("专家·技能·连接器");
	const heading = await waitUntil(
		async () => {
			const value = await win.evaluate(() => {
				const h1 = document.querySelector("h1.sr-only");
				return h1 === null
					? null
					: { text: (h1.textContent ?? "").trim(), clip: getComputedStyle(h1).clipPath };
			});
			return value;
		},
		{ timeout: 15_000, desc: "专家页 sr-only h1 出现" },
	);
	assert.equal(heading.text, "专家·技能·连接器", `专家页 h1 文案=${heading.text}`);
	assert.notEqual(heading.clip, "none", "sr-only h1 必须真的不占布局（clip-path 应生效）");
});

await h.check("无渲染层未捕获异常", () => assert.equal(h.pageErrors.length, 0, h.pageErrors.join("; ")));

await h.finish();
