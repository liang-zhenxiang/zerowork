/**
 * 暗色首屏收口的 GUI 测试（任务 10-03-dark-polish）。
 *
 * 锁两条「深色下才暴露」的视觉缺陷，并给它们**物理证据**（不是只看属性切没切）：
 *
 *   ① **输入卡外槽**：`.composer-slot` 的渐变此前是裸字面量、暗色块漏配，
 *      深色下在输入卡外圈炸出一圈浅灰发光边。修法是把渐收进 `--composer-slot-bg`
 *      （亮/暗两块各定义）。本用例直接量**外槽底缘区域的平均亮度**：
 *      修好后它必须与主背景同档（不再明显更亮）。
 *   ② ~~**案例封面**：深色下实拍封面是首屏最亮的四块矩形。~~ **已退役（2026-10-04，#104）**：
 *      封面改成第一方生成的示意图后，那条 `[data-theme="dark"] .case-cover img` 的
 *      压暗规则连同它盯着的两条断言一起删掉了 —— 规则没了还留断言就是假通过。
 *      封面现在的覆盖在 `tests/e2e/offline-covers.mjs`（不出网 + 断网重载 + 深浅两套）。
 *
 * ## 为什么用「区域平均亮度」而不是整屏
 *
 * 输入卡外槽在深色下只占输入卡外圈一圈很窄的边（底缘 4px 最宽），整屏平均
 * 会被输入卡本体与文字淹没、读不出这一圈。所以量的是**槽底缘那一条带**
 * （落在槽的 padding-bottom 内、避开圆角），再与**主背景**那条带对比。
 *
 * ## 反向验证记录（2026-10-03，两条都真跑过）
 *
 * 1. 把 `--composer-slot-bg` 从 `[data-theme="dark"]` 块删掉 →
 *    深色下 `.composer-slot` 回退亮色值，本用例的「外槽不再是亮色」这条**变红**
 *    （实测槽底缘平均亮度从 ~30 跳到 ~245），`check:theme-tokens` 同时报红。
 * 2. （已退役，见上）把 `[data-theme="dark"] .case-cover img` 的 `filter` 删掉 →
 *    「封面被压暗」这条**变红** —— 那条规则与断言在 #104 里一起删掉了。
 *    两次都改回后重新全绿。
 */
import assert from "node:assert/strict";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const h = createHarness({ name: "dark-polish" });
await h.launch();
const win = h.window();

/**
 * 取一块矩形区域（CSS px，相对视口左上）的平均 Rec.709 亮度。
 * 截图是设备像素（dpr 缩放），用 `img.width / 视口宽` 换算。
 */
function regionMean(img, rect, viewportWidth) {
	const scale = img.width / viewportWidth;
	const x0 = Math.max(0, Math.round(rect.x * scale));
	const y0 = Math.max(0, Math.round(rect.y * scale));
	const x1 = Math.min(img.width, Math.round((rect.x + rect.w) * scale));
	const y1 = Math.min(img.height, Math.round((rect.y + rect.h) * scale));
	let sum = 0;
	let n = 0;
	for (let y = y0; y < y1; y += 1) {
		for (let x = x0; x < x1; x += 1) {
			const o = (y * img.width + x) * img.channels;
			const r = img.data[o];
			const g = img.channels >= 3 ? img.data[o + 1] : r;
			const b = img.channels >= 3 ? img.data[o + 2] : r;
			sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
			n += 1;
		}
	}
	if (n === 0) throw new Error(`区域为空：${JSON.stringify(rect)}（视口宽 ${viewportWidth}，图像宽 ${img.width}）`);
	return sum / n;
}

/** 读外槽与主背景的几何（CSS px）+ 两点锚定的采样带。 */
const readGeometry = () =>
	win.evaluate(() => {
		const slot = document.querySelector(".composer-slot");
		if (slot === null) throw new Error("首页没有 .composer-slot —— 界面结构变了？");
		const s = slot.getBoundingClientRect();
		const cs = getComputedStyle(slot);
		const padBottom = parseFloat(cs.paddingBottom);
		const inner = document.querySelector(".home-inner")?.getBoundingClientRect() ?? null;
		return {
			vw: window.innerWidth,
			slot: { x: s.x, y: s.y, w: s.width, h: s.height },
			padBottom,
			// 主背景采样点：落在主列自身的 padding（= --bg，无底色）里，
			// 与外槽同一竖直位置 —— 控制变量。
			bgAnchorX: s.x,
			// 便于诊断：主列左边缘（若布局被大改，这里的数值会一起变）
			innerLeft: inner ? inner.x : null,
		};
	});

/**
 * 外槽底缘采样带：落在槽的 padding-bottom 内（卡片已结束），左右各内缩 30px
 * 避开 24px 圆角；竖直只取底缘 2px，避免蹭到卡片底边的抗锯齿。
 */
function slotRingRect(geo) {
	const h2 = Math.max(2, Math.round(geo.padBottom) - 2);
	return {
		x: geo.slot.x + 30,
		y: geo.slot.y + geo.slot.h - geo.padBottom + 1,
		w: geo.slot.w - 60,
		h: h2,
	};
}

/** 主背景采样带：在槽左侧、主列 padding 内的一块小方块（纯 --bg）。 */
function bgRect(geo) {
	return { x: geo.slot.x - 18, y: geo.slot.y + geo.slot.h / 2, w: 8, h: 8 };
}

/** 切主题：走与应用同一条路（localStorage 镜像 + data-theme 属性 + 真源落盘）。 */
async function setTheme(pref) {
	await win.evaluate(async (p) => {
		const resolved =
			p === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : p;
		localStorage.setItem("zw:theme-pref", p);
		document.documentElement.setAttribute("data-theme", resolved);
		window.dispatchEvent(new CustomEvent("zw:theme-changed"));
		await window.kami.setThemePreference(p);
	}, pref);
	await waitUntil(() => win.evaluate((p) => document.documentElement.dataset.theme === p, pref), {
		timeout: 10_000,
		desc: `data-theme 切到 ${pref}`,
	});
	await h.waitForSettled();
}

/**
 * 用真实类名造一个探针，读 `.turn-nav-mark::before` 的计算样式。
 *
 * 为什么换成它：此前这里探的是 `.case-cover img`（那张 CDN 实图的淡入过渡）。
 * 封面改成本地生成后那条规则没了（#104），而「reduced-motion 的第 ④ 组真的
 * 关掉了**过渡**、不只是关 animation」这条纪律必须有东西盯着 ——
 * `.turn-nav-mark::before` 是第 ④ 组里**真有过渡**的那一个（transform +
 * background-color 两条），探它才有意义（探一个本来就没有过渡的元素是假通过）。
 */
const probeTurnNavMark = () =>
	win.evaluate(() => {
		const span = document.createElement("span");
		span.className = "turn-nav-mark";
		document.body.appendChild(span);
		const cs = getComputedStyle(span, "::before");
		const out = { transitionProperty: cs.transitionProperty, transitionDuration: cs.transitionDuration };
		span.remove();
		return out;
	});

// ── ① 浅色：外槽仍是原来的浅灰渐变（没被改暗）──────────────────
const light = await h.shoot("home-light");
const lightGeo = await readGeometry();
const lightRing = regionMean(light.img, slotRingRect(lightGeo), lightGeo.vw);
const lightBg = regionMean(light.img, bgRect(lightGeo), lightGeo.vw);

await h.check("浅色下输入卡外槽仍是浅灰渐变（未被改暗）", () => {
	assert.ok(
		lightRing >= 220,
		`浅色外槽底缘平均亮度=${lightRing.toFixed(1)}（主背景=${lightBg.toFixed(1)}，期望 ≥220 的浅灰渐变）`,
	);
});

// ── ② 深色：外槽回到「比主背景深一档」，不再是一圈亮边 ──────────
await setTheme("dark");
const dark = await h.shoot("home-dark");
const darkGeo = await readGeometry();
const darkRing = regionMean(dark.img, slotRingRect(darkGeo), darkGeo.vw);
const darkBg = regionMean(dark.img, bgRect(darkGeo), darkGeo.vw);

await h.check("深色下输入卡外槽不再是亮色（R1：不高于主背景一个可辨阈值）", () => {
	assert.ok(
		darkRing <= darkBg + 12,
		`深色外槽底缘平均亮度=${darkRing.toFixed(1)}，主背景=${darkBg.toFixed(1)}，` +
			`差值 ${(darkRing - darkBg).toFixed(1)} 超过阈值 12 —— 外槽仍比背景亮，硬编码亮色没被 token 接管？`,
	);
	assert.ok(
		lightRing - darkRing >= 100,
		`浅色外槽=${lightRing.toFixed(1)}，深色外槽=${darkRing.toFixed(1)}，差值 ` +
			`${(lightRing - darkRing).toFixed(1)} < 100 —— 主题切了但外槽几乎没变？`,
	);
});

// ── ③ 外槽渐变的计算值在两主题下确实不同（token 真切了主题）─────
await h.check("外槽渐变的计算值随主题变化（token 双块接线）", async () => {
	const readBg = () => win.evaluate(() => getComputedStyle(document.querySelector(".composer-slot")).backgroundImage);
	const darkBgImage = await readBg();
	await setTheme("light");
	const lightBgImage = await readBg();
	assert.notEqual(lightBgImage, darkBgImage, `两主题下 .composer-slot 的 background-image 相同：${lightBgImage}`);
	// 复原成深色，供后续断言与截图（本用例的其余断言都在深色下）
	await setTheme("dark");
});

// ── ④ reduced-motion 的第 ④ 组：关的是**过渡**，不是只关动画 ──────────
// 反向对照：未开启减弱动效时，探针上确实挂着过渡（否则下面那条是假通过）。
const normalTransition = await probeTurnNavMark();
await h.check("默认动效下轨道刻度探针确有过渡（反向对照）", () => {
	assert.notEqual(
		normalTransition.transitionDuration,
		"0s",
		`transition-duration=${normalTransition.transitionDuration} —— 探针本来就没有过渡，下面那条会假通过`,
	);
});

// ── ④ 续：开启减弱动效后，同一条过渡被关停 ─────────────────────────
await win.emulateMedia({ reducedMotion: "reduce" });
const reduced = await probeTurnNavMark();
await h.check("减弱动效下轨道刻度的过渡被关停（第 ④ 组不是空转）", () => {
	assert.equal(
		reduced.transitionDuration,
		"0s",
		`transition-duration=${reduced.transitionDuration} —— reduced-motion 下过渡没被关停`,
	);
});
await win.emulateMedia({ reducedMotion: "no-preference" });

// ── ⑤ markdown 路径徽章必须随主题变（#105 抓到的那处硬编码底色）────────
/**
 * 探针：造一个 `.markdown code.clickable-path`（路径徽章）读它的计算底色。
 * 不依赖真实会话 —— 这条规则只吃选择器。
 */
const probePathChip = () =>
	win.evaluate(() => {
		const wrap = document.createElement("p");
		wrap.className = "markdown";
		const code = document.createElement("code");
		code.className = "clickable-path";
		code.textContent = "src/foo.ts";
		wrap.appendChild(code);
		document.body.appendChild(wrap);
		const cs = getComputedStyle(code);
		const out = { background: cs.backgroundColor, color: cs.color, raw: cs.background };
		wrap.remove();
		return out;
	});

/**
 * 一个计算出来的颜色值的 Rec.709 亮度（0–255 刻度）。
 *
 * ⚠️ **两种语法都要认**：`rgb(20, 112, 180)` 的分量是 0–255，而 `color-mix()`
 * 在现代 Chromium 里的计算值是 `color(srgb 0.89 0.93 0.96)` —— 分量是 **0–1**。
 * 只按前者解析的话会拿 0.89 当 0.89/255 用，算出「亮度 1」这种荒谬数字
 * （真实踩到：断言因此误判「浅色下徽章底色太暗」）。
 */
function luminance(value) {
	const modern = value.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
	if (modern !== null) {
		return 255 * (0.2126 * Number(modern[1]) + 0.7152 * Number(modern[2]) + 0.0722 * Number(modern[3]));
	}
	const nums = (value.match(/[\d.]+/g) ?? []).map(Number);
	return 0.2126 * nums[0] + 0.7152 * nums[1] + 0.0722 * nums[2];
}

await h.check("markdown 路径徽章底色随主题变，且深色下不再是亮片（#105）", async () => {
	await setTheme("light");
	const light = await probePathChip();
	await setTheme("dark");
	const dark = await probePathChip();
	assert.notEqual(
		light.background,
		dark.background,
		`两套主题下徽章底色相同（${light.background}）—— 它又变成与主题无关的硬编码了`,
	);
	assert.ok(
		luminance(dark.background) < 90,
		`深色下徽章底色亮度 ${luminance(dark.background).toFixed(0)} 太高：` +
			`正文里会出现一块近白亮片（修之前正是写死的 #e9eef2）`,
	);
	assert.ok(
		luminance(light.background) > 200,
		`浅色下徽章底色亮度 ${luminance(light.background).toFixed(0)} 太低：徽章该是浅底 —— 实测 ${JSON.stringify(light)}`,
	);
});

await h.finish();
