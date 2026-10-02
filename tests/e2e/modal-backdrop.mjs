/**
 * 模态背板（遮罩）的 GUI 端到端守卫。
 *
 * ## 背景：修的是什么
 *
 * **直挂 `.app` 的模态**（实测 3 处：设置面板 / 命令面板 / 权限审批）的背板曾经
 * 不是半透明遮罩，而是一块**不透明 `--bg` 面板**；嵌套在视图里的那几处一向正确，
 * 本文件把它们当**对照组**一并锁住。
 * 根因是 `app.css` 的视图页规则
 * `.app > :not(…)`（特异性 (0,6,1)）压过了 `.modal-backdrop`（(0,1,0)）的
 * `background: var(--overlay)`，把背板盖成了不透明 `--bg`，并连带把 `margin`
 * 与 `border-radius` 也套了上去。`--overlay` 这个 token 从定义至今从未生效过。
 *
 * ## 关键事实（实测，不是推断 —— 这一点修正了 design.md 初稿的表）
 *
 * 那条规则只命中 **`.app` 的直接子项**。8 处 `.modal-backdrop` 里**只有 3 处**是直挂
 * `.app` 的（渲染在 App 根 JSX 上）：权限审批（`.permission-card`）、设置面板
 * （`.settings-card`）、命令面板（`.command-palette`）—— **只有这 3 个曾被压成不透明面板**。
 * 其余 5 处（添加模型 / MCP 表单 / MCP 编辑器 / 自动化模板 / 自动化表单）都**嵌套**在
 * 某个视图或设置卡内部，父元素不是 `.app`，所以一直是对的。
 * 两种控制组因此都要断言：受影响的自不必说，**没受影响的也要防被误改**。
 *
 * ## 这个守卫的形状（本文件真正的主张）
 *
 * 断言**不是**「给 `.modal-backdrop` 写死一个期望值」，而是**遍历 DOM 里所有遮罩类
 * 元素**（`.modal-backdrop` / `.ex-modal-mask`）逐个断言计算样式 —— 于是将来任何
 * 新增的、直挂 `.app` 的浮层被那条排除法规则压掉时，都会被它抓到。
 * 这正是排除法规则一直缺的那道网：注释拦不住人，断言能。
 *
 * ## 断言
 *
 *   ① 视图页仍是灰底上的圆角白卡（防这次修复把 `.app` 的其它直接子项改坏）
 *   ② 设置面板（直挂 .app，受影响）：背板 = `--overlay` 浅色 rgba(0,0,0,0.4) / margin 0 / radius 0
 *   ③ 命令面板（直挂 .app，受影响）：同上
 *   ④ 权限审批（直挂 .app，第三个受影响模态）：需要 daemon 发一次活的工具审批请求，
 *      本环境无法可靠触发 → **显式 SKIP 并写明原因**（并入列「受影响组」以备将来能触发时补上）
 *   ⑤ 自动化表单（**嵌套**模态，控制组）：背板仍是遮罩，且断言它**不是** `.app` 直接子项
 *      —— 记录「为什么它一直是对的」这条证据
 *   ⑥ 专家详情（`.ex-modal-mask`，嵌套在 `.ex` 下，控制组）：背板仍是遮罩
 *   ⑦ 背景内容透出来：模态开/关两张同主题截图，`diffGrids` 显著 > 0；
 *      且背板区域（卡片以外）平均亮度**介于原页面与全黑之间**（被压暗但不是被完全盖住）
 *   ⑧ 浅色 + 深色各测一次（`--overlay` 两块都有定义：浅 0.4 / 深 0.6）
 *
 * ## 反向验证记录（必做，见 implement.md 步骤 3）
 *
 * 做法：注入缺陷 → `npm run build` → 跑本文件 → 记下哪些用例变红 → 复原重建。
 * （e2e 跑的是 out/ 产物，注入后必须重建，否则改动不生效。）
 *
 * 【验证 1】把 app.css 排除清单里的 `.modal-backdrop` 去掉（恢复缺陷）：
 *   · ② 变红 —— 「设置面板：遮罩 .modal-backdrop 背景应为 rgba(0, 0, 0, 0.4)（--overlay），
 *     实际 rgb(255, 255, 255)—— 被 .app > :not(…) 的 var(--bg) 压成不透明面板了？」
 *   · ③ 变红 —— 同上（命令面板）
 *   · ⑧ 变红 —— 「深色设置面板：遮罩 .modal-backdrop 背景应为 rgba(0, 0, 0, 0.6)（--overlay），
 *     实际 rgb(28, 28, 30)—— …」（顺带证明 margin/背景在深色块也一并被压）
 *   · ⑦ 变红 —— 「模态打开后背板区域应被压暗：关闭 246.0 → 打开 251.8
 *     （缺陷态是不透明面板，打开反而更亮）」← 像素证据独立抓住同一个缺陷
 *   · ①⑤⑥ **仍绿**（如实记录）：① 是视图页、⑤⑥ 是嵌套模态，都不受这条规则影响 ——
 *     两条控制组按预期不动，说明这次的修复没有误伤它们。
 *
 * 【验证 2】把 `.app > :not(…)` 的 `margin` 改坏（`var(--space-2)` → `var(--space-3)`）：
 *   · ① 变红 —— 「视图页 margin 应为 var(--space-2)=6px，实际 8px（改坏了吗？）」
 *   · 其余不受影响（它们断言的是遮罩，不是视图页）。复原后全绿。
 */
import assert from "node:assert/strict";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { diffGrids } from "./lib/png.mjs";

const h = createHarness({ name: "modal-backdrop" });
await h.launch();
const win = h.window();

// 平台修饰键：macOS 用 ⌘（Meta），其余用 Ctrl —— 与 app.js 的 PALETTE_MOD 同口径。
const MOD = process.platform === "darwin" ? "Meta" : "Control";

// --overlay 的登记值（app.css 的 :root / [data-theme="dark"]）：浅色 40%、深色 60%。
// 这里写死期望值而**不是**读 token —— 否则就与实现同义反复，压不压得住都测不出来。
const OVERLAY_LIGHT = "rgba(0, 0, 0, 0.4)";
const OVERLAY_DARK = "rgba(0, 0, 0, 0.6)";

// ── DOM 探针 ──────────────────────────────────────────────────────────

/**
 * 收集当前 DOM 里**所有**遮罩类元素的计算样式。
 *
 * 关键：不是查 `.modal-backdrop` 写死期望值，而是遍历所有遮罩类 —— 将来新增的
 * 直挂 `.app` 的浮层也会被这条断言抓到（排除法规则一直缺的就是这道网）。
 */
const readMasks = () =>
	win.evaluate(() =>
		[...document.querySelectorAll(".modal-backdrop, .ex-modal-mask")].map((el) => {
			const cs = getComputedStyle(el);
			return {
				cls: el.className,
				bg: cs.backgroundColor,
				margin: cs.margin,
				radius: cs.borderRadius,
				parentIsApp: el.parentElement?.classList.contains("app") ?? false,
			};
		}),
	);

/** 断言当前 DOM 里每一个遮罩都是「半透明遮罩」而非「不透明面板」，返回实测清单。 */
const assertAllScrims = async (expectedBg, ctxLabel) => {
	const masks = await readMasks();
	assert.ok(masks.length > 0, `${ctxLabel}：DOM 里应有遮罩类元素，实际 0 个`);
	for (const m of masks) {
		assert.equal(
			m.bg,
			expectedBg,
			`${ctxLabel}：遮罩 .${m.cls} 背景应为 ${expectedBg}（--overlay），实际 ${m.bg}` +
				`—— 被 .app > :not(…) 的 var(--bg) 压成不透明面板了？`,
		);
		assert.equal(m.margin, "0px", `${ctxLabel}：遮罩 .${m.cls} 的 margin 应为 0px，实际 ${m.margin}`);
		assert.equal(m.radius, "0px", `${ctxLabel}：遮罩 .${m.cls} 的 border-radius 应为 0px，实际 ${m.radius}`);
	}
	return masks;
};

// ── 等待 / 导航工具 ──────────────────────────────────────────────────

const waitFor = (selector, desc, timeout = 10_000) =>
	waitUntil(() => win.evaluate((s) => document.querySelector(s) !== null, selector), { timeout, desc });
const waitForGone = (selector, desc, timeout = 10_000) =>
	waitUntil(() => win.evaluate((s) => document.querySelector(s) === null, selector), { timeout, desc });

const pressModK = () => win.keyboard.press(`${MOD}+k`);
const paletteInput = () => win.locator(".command-palette-input");
const paletteOpen = () => win.evaluate(() => document.querySelector(".command-palette") !== null);
const waitPaletteOpen = () => waitUntil(paletteOpen, { timeout: 10_000, desc: "命令面板出现" });
const waitPaletteClosed = () =>
	waitUntil(async () => (await paletteOpen()) === false, { timeout: 10_000, desc: "命令面板卸载" });

/**
 * 用命令面板执行一次「跳到某视图 / 打开设置」的动作。
 * 走面板而不是各视图的入口按钮：面板是全局的，与当前 view / 侧栏开合无关，
 * 起点更干净（命令面板本身已有独立用例覆盖，这里只借它当导航）。
 */
const runPaletteAction = async (text) => {
	await pressModK();
	await waitPaletteOpen();
	await paletteInput().fill(text);
	await waitUntil(
		() =>
			win.evaluate(
				(t) =>
					[...document.querySelectorAll('.command-palette [role="option"]')].some((el) =>
						(el.textContent ?? "").includes(t),
					),
				text,
			),
		{ timeout: 10_000, desc: `命令面板出现「${text}」条目` },
	);
	await win.keyboard.press("Enter");
};

/** 点当前视图头部的「返回」按钮回到首页（一次只挂一个视图，故该按钮唯一）。 */
const clickBack = async () => {
	await win.evaluate(() => {
		const btn = document.querySelector('[aria-label="返回"]');
		if (btn === null) throw new Error("当前视图找不到「返回」按钮");
		btn.click();
	});
	await waitFor("main.home", "回到首页视图");
};

// ══ ① 视图页仍是灰底上的圆角白卡 ══════════════════════════════════════
await h.check("① 视图页（.app 直接子项）仍是圆角白卡：margin 6px / radius 10px / bg var(--bg)", async () => {
	await waitFor("main.home", "首页视图出现（默认 view=home）");
	const card = await win.evaluate(() => {
		const el = document.querySelector(".app > main.home");
		if (el === null) throw new Error("找不到 .app > main.home");
		const cs = getComputedStyle(el);
		return { margin: cs.margin, radius: cs.borderRadius, bg: cs.backgroundColor };
	});
	assert.equal(card.margin, "6px", `视图页 margin 应为 var(--space-2)=6px，实际 ${card.margin}（改坏了吗？）`);
	assert.equal(card.radius, "10px", `视图页 border-radius 应为 var(--radius-md)=10px，实际 ${card.radius}`);
	assert.equal(card.bg, "rgb(255, 255, 255)", `视图页背景应为 var(--bg)=#ffffff（浅色），实际 ${card.bg}`);
});

// ══ ② 设置面板（直挂 .app，受影响；浅色） ══════════════════════════════
await h.check("② 设置面板背板是 --overlay 遮罩（浅色：rgba(0,0,0,0.4) / margin 0 / radius 0）", async () => {
	// try/finally：这条失败也要把设置面板关掉，否则会牵连后续用例（反向验证时尤其明显）。
	try {
		await runPaletteAction("设置 · 通用");
		await waitFor(".settings-card", "设置面板出现");
		await h.waitForSettled();
		await h.shoot("mb-settings-light");
		const masks = await assertAllScrims(OVERLAY_LIGHT, "设置面板");
		assert.ok(
			masks.some((m) => m.parentIsApp),
			`设置面板背板应直挂 .app（它是被压成不透明的那一类），实测 ${JSON.stringify(masks.map((m) => m.parentIsApp))}`,
		);
	} finally {
		await win.evaluate(() => document.querySelector(".settings-card-close")?.click());
		await waitForGone(".settings-card", "设置面板关闭").catch(() => {});
	}
});

// ══ ③ 命令面板（直挂 .app，受影响；浅色） ══════════════════════════════
await h.check("③ 命令面板背板是 --overlay 遮罩（浅色）", async () => {
	try {
		await pressModK();
		await waitPaletteOpen();
		await h.waitForSettled();
		await h.shoot("mb-palette-open-light");
		const masks = await assertAllScrims(OVERLAY_LIGHT, "命令面板");
		assert.ok(
			masks.some((m) => m.parentIsApp),
			`命令面板背板应直挂 .app（它是被压成不透明的那一类），实测 ${JSON.stringify(masks.map((m) => m.parentIsApp))}`,
		);
	} finally {
		await win.keyboard.press("Escape");
		await waitPaletteClosed().catch(() => {});
	}
});

// ══ ④ 权限审批（直挂 .app，第三个受影响模态） ══════════════════════════
await h.check("④ 权限审批（.permission-card）背板是 --overlay 遮罩", async () => {
	// 权限审批弹窗只在 daemon 发来活的工具审批请求时出现 —— 需要配好模型、审批预设与一次
	// 真实工具调用（本项目由 model-roundtrip / tool-loop 一类脚本覆盖那条链路）。
	// 本文件（纯渲染层背板守卫）的隔离环境里不会发生，故**显式 SKIP 并写明原因**，
	// 不做静默跳过。它的背板同样是直挂 .app 的 .modal-backdrop —— 与 ②③ 同一机制，
	// 一旦出现，assertAllScrims 的「遍历所有遮罩」就会一并断言它。
	if ((await win.evaluate(() => document.querySelector(".permission-card") !== null)) === false) {
		h.skip("④ 权限审批（.permission-card）背板是 --overlay 遮罩", "本环境没有待处理的工具审批请求（需活的模型回合 + 审批预设 + 一次需审批的工具调用），无法可靠触发权限审批弹窗；该弹窗的背板与设置/命令面板同属直挂 .app 的 .modal-backdrop，由 assertAllScrims 在其出现时兜底");
		return;
	}
	await h.shoot("mb-permission");
	await assertAllScrims(OVERLAY_LIGHT, "权限审批");
});

// ══ ⑤ 自动化表单（嵌套模态，控制组；浅色） ══════════════════════════════
await h.check("⑤ 自动化表单（嵌套模态）背板是 --overlay 遮罩，且它不是 .app 直接子项", async () => {
	try {
		await runPaletteAction("打开自动化");
		await waitUntil(
			() =>
				win.evaluate(() =>
					[...document.querySelectorAll(".settings-head .mini-btn")].some((b) =>
						(b.textContent ?? "").includes("新建任务"),
					),
				),
			{ timeout: 10_000, desc: "自动化视图头部出现「新建任务」按钮" },
		);
		// 打开新建表单。
		await win.evaluate(() => {
			const btn = [...document.querySelectorAll(".settings-head .mini-btn")].find((b) =>
				(b.textContent ?? "").includes("新建任务"),
			);
			if (btn === undefined) throw new Error("自动化视图找不到「新建任务」按钮");
			btn.click();
		});
		await waitFor(".auto-form-card", "自动化表单出现");
		await h.waitForSettled();
		await h.shoot("mb-automation-light");
		const masks = await assertAllScrims(OVERLAY_LIGHT, "自动化表单");
		// 记录「为什么它一直是对的」：它的父元素是自动化视图（main.settings），不是 .app，
		// 所以那条 `.app > :not(…)` 规则从来压不到它。这条断言把这层因果钉成事实。
		assert.ok(
			masks.every((m) => m.parentIsApp === false),
			`自动化表单背板应是嵌套模态（父元素不是 .app），实测 ${JSON.stringify(masks.map((m) => m.parentIsApp))}`,
		);
	} finally {
		// 收尾：取消表单 → 返回首页。
		await win.evaluate(() => {
			const btn = [...document.querySelectorAll(".auto-form-card .mini-btn")].find(
				(b) => (b.textContent ?? "").trim() === "取消",
			);
			btn?.click();
		});
		await waitForGone(".auto-form-card", "自动化表单关闭").catch(() => {});
		await clickBack().catch(() => {});
	}
});

// ══ ⑥ 专家详情（.ex-modal-mask，嵌套在 .ex 下，控制组；浅色） ══════════
await h.check("⑥ 专家详情（.ex-modal-mask，嵌套在 .ex 下）背板是 --overlay 遮罩", async () => {
	try {
		await runPaletteAction("打开专家 · 技能 · 连接器");
		// 该动作落到「技能」子页（openSkillsAt("skills")），专家卡在顶层「专家」页 —— 先切过去。
		await waitUntil(
			() => win.evaluate(() => document.querySelector(".skills-tab") !== null),
			{ timeout: 15_000, desc: "专家 · 技能 · 连接器视图出现顶层页签" },
		);
		await win.evaluate(() => {
			const tab = [...document.querySelectorAll(".skills-tab")].find(
				(b) => (b.textContent ?? "").trim() === "专家",
			);
			if (tab === undefined) throw new Error("找不到「专家」顶层页签");
			tab.click();
		});
		// resources/experts 内置了若干专家，列表应至少有「非创建卡」的一张。
		await waitUntil(
			() => win.evaluate(() => document.querySelector(".ex-card:not(.ex-create-card)") !== null),
			{ timeout: 15_000, desc: "专家列表出现至少一张专家卡（resources/experts 内置）" },
		);
		await win.evaluate(() => {
			const card = document.querySelector(".ex-card:not(.ex-create-card)");
			if (card === null) throw new Error("找不到专家卡");
			card.click();
		});
		await waitFor(".ex-modal-mask", "专家详情模态出现");
		await h.waitForSettled();
		await h.shoot("mb-expert-light");
		const masks = await assertAllScrims(OVERLAY_LIGHT, "专家详情");
		assert.ok(
			masks.every((m) => m.parentIsApp === false),
			`专家详情遮罩 .ex-modal-mask 应嵌套在 .ex 下（父元素不是 .app），实测 ${JSON.stringify(masks.map((m) => m.parentIsApp))}`,
		);
	} finally {
		// 收尾：关详情 → 返回首页。
		await win.evaluate(() => document.querySelector(".ex-modal-close")?.click());
		await waitForGone(".ex-modal-mask", "专家详情关闭").catch(() => {});
		await clickBack().catch(() => {});
	}
});

// ══ ⑦ 背景内容透出来（像素证据） ══════════════════════════════════════
await h.check("⑦ 背景内容透出来：开/关画面差异显著，且背板区域被压暗但未全黑", async () => {
	await waitFor("main.home", "首页（干净起点）");
	await h.waitForSettled();
	const closed = await h.shoot("mb-closed-light");

	try {
		// 打开设置面板：背板覆盖整窗，卡片居中（尺寸大，是「背板区域」最清楚的取样场景）。
		await runPaletteAction("设置 · 通用");
		await waitFor(".settings-card", "设置面板出现");
		await h.waitForSettled();
		const open = await h.shoot("mb-open-light");

		// (a) 画面确实变了。
		const diff = diffGrids(closed.grid, open.grid);
		assert.ok(diff > 4, `开/关设置面板的画面差异应显著，实际 ${diff.toFixed(2)} —— 属性切了但画面没变？`);

		// (b) 取「背板区域」= 视口内、卡片矩形之外的单元格。用页面里实测的卡片矩形**归一化**，
		//     与窗口尺寸无关（不假设窗口多宽、卡片多大）。
		const rect = await win.evaluate(() => {
			const card = document.querySelector(".settings-card");
			if (card === null) throw new Error("找不到 .settings-card");
			const r = card.getBoundingClientRect();
			// 用 document 上的尺寸而不是全局 innerWidth/innerHeight：后者在 eslint 的
			// Node 视角是未定义全局（no-undef）—— 本项目在合成事件上踩过同一个坑。
			const vw = document.documentElement.clientWidth;
			const vh = document.documentElement.clientHeight;
			return { x: r.left / vw, y: r.top / vh, w: r.width / vw, h: r.height / vh };
		});
		const regionMean = (grid) => {
			let sum = 0;
			let n = 0;
			for (let r = 0; r < grid.rows; r++) {
				for (let c = 0; c < grid.cols; c++) {
					const cx = (c + 0.5) / grid.cols;
					const cy = (r + 0.5) / grid.rows;
					const inCard = cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h;
					if (inCard) continue;
					sum += grid.cells[r * grid.cols + c];
					n++;
				}
			}
			return n > 0 ? sum / n : NaN;
		};
		const closedBg = regionMean(closed.grid);
		const openBg = regionMean(open.grid);
		assert.ok(Number.isFinite(openBg) && Number.isFinite(closedBg), "背板区域应有足够单元格参与统计");
		// 被压暗：40% 黑遮罩应让背板区域明显变暗（缺陷态是被盖成 --bg，那里 openBg ≈ 255 > closedBg）。
		assert.ok(
			openBg < closedBg - 2,
			`模态打开后背板区域应被压暗：关闭 ${closedBg.toFixed(1)} → 打开 ${openBg.toFixed(1)}（缺陷态是不透明面板，打开反而更亮）`,
		);
		// 未全黑：背景内容仍透出来 —— 处于 (0, 原亮度) 区间，而不是被盖成 0 或原色。
		assert.ok(openBg > 0, `背板区域不应全黑（内容应透出来），实际 ${openBg.toFixed(1)}`);
	} finally {
		// 收尾：关闭设置。
		await win.evaluate(() => document.querySelector(".settings-card-close")?.click());
		await waitForGone(".settings-card", "设置面板关闭").catch(() => {});
	}
});

// ══ ⑧ 深色主题（设置 + 命令面板） ══════════════════════════════════
await h.check("⑧ 深色主题：背板是 --overlay 遮罩（rgba(0,0,0,0.6)），设置 + 命令面板各验一次", async () => {
	await win.evaluate(() => {
		void window.kami?.setThemePreference?.("dark");
		document.documentElement.setAttribute("data-theme", "dark");
	});
	await waitUntil(() => win.evaluate(() => document.documentElement.dataset.theme === "dark"), {
		timeout: 10_000,
		desc: "data-theme 切到 dark",
	});
	await h.waitForSettled();

	try {
		// 设置面板（深色）
		await runPaletteAction("设置 · 通用");
		await waitFor(".settings-card", "深色下设置面板出现");
		await h.waitForSettled();
		await h.shoot("mb-settings-dark");
		await assertAllScrims(OVERLAY_DARK, "深色设置面板");
		await win.evaluate(() => document.querySelector(".settings-card-close")?.click());
		await waitForGone(".settings-card", "深色下设置面板关闭");

		// 命令面板（深色）
		await pressModK();
		await waitPaletteOpen();
		await h.waitForSettled();
		await h.shoot("mb-palette-open-dark");
		await assertAllScrims(OVERLAY_DARK, "深色命令面板");
		await win.keyboard.press("Escape");
		await waitPaletteClosed();
	} finally {
		// 收尾：关掉可能残留的模态，切回浅色，避免影响人工看截图时的界面状态。
		await win.evaluate(() => {
			document.querySelector(".settings-card-close")?.click();
			document.documentElement.setAttribute("data-theme", "light");
		});
	}
});

await h.finish();
