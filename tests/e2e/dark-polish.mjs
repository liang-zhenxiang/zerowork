/**
 * 暗色首屏收口的 GUI 测试（任务 10-03-dark-polish）。
 *
 * 锁两条「深色下才暴露」的视觉缺陷，并给它们**物理证据**（不是只看属性切没切）：
 *
 *   ① **输入卡外槽**：`.composer-slot` 的渐变此前是裸字面量、暗色块漏配，
 *      深色下在输入卡外圈炸出一圈浅灰发光边。修法是把渐收进 `--composer-slot-bg`
 *      （亮/暗两块各定义）。本用例直接量**外槽底缘区域的平均亮度**：
 *      修好后它必须与主背景同档（不再明显更亮）。
 *   ② **案例封面**：深色下实拍封面是首屏最亮的四块矩形。修法是
 *      `[data-theme="dark"] .case-cover img { filter: brightness(.86) saturate(.94) }`
 *      + 加载完成淡入。本用例锁 filter 与过渡的**计算值契约**
 *      （不依赖 CDN 是否可达，稳定可断言），淡入的像素证据另存前后截图。
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
 * 2. 把 `[data-theme="dark"] .case-cover img` 的 `filter` 删掉 →
 *    「封面被压暗」这条**变红**。
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

/** 用真实类名造一个探针，读 `.case-cover img` 的计算样式（不依赖真的加载图片）。 */
const probeCoverImg = () =>
	win.evaluate(() => {
		const span = document.createElement("span");
		span.className = "case-cover";
		const img = document.createElement("img");
		span.appendChild(img);
		document.body.appendChild(span);
		const cs = getComputedStyle(img);
		const out = {
			filter: cs.filter,
			transitionProperty: cs.transitionProperty,
			transitionDuration: cs.transitionDuration,
		};
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

// ── ④ 深色下案例封面被压暗（filter 计算值契约，不依赖 CDN）──────
const darkCoverProbe = await probeCoverImg();
await h.check("深色下案例封面被压暗（R2：filter 契约）", () => {
	assert.ok(
		/brightness\(\s*0\.86\s*\)/.test(darkCoverProbe.filter),
		`.case-cover img 深色计算 filter=${darkCoverProbe.filter} —— 缺 brightness(0.86)`,
	);
	assert.ok(
		/saturate\(\s*0\.94\s*\)/.test(darkCoverProbe.filter),
		`.case-cover img 深色计算 filter=${darkCoverProbe.filter} —— 缺 saturate(0.94)`,
	);
});

// 反向对照：浅色下不该有这层压暗
await setTheme("light");
const lightCoverProbe = await probeCoverImg();
await h.check("浅色下案例封面不加压暗（反向对照）", () => {
	assert.equal(lightCoverProbe.filter, "none", `浅色 .case-cover img 计算 filter=${lightCoverProbe.filter}，应为 none`);
});
await setTheme("dark");

// ── ⑤ 案例封面淡入：过渡走既有 token ────────────────────────────
await h.check("案例封面淡入走既有时长/缓动 token（opacity 过渡）", () => {
	assert.ok(
		darkCoverProbe.transitionProperty.includes("opacity"),
		`transition-property=${darkCoverProbe.transitionProperty} —— 不含 opacity`,
	);
	assert.equal(
		darkCoverProbe.transitionDuration,
		"0.15s",
		`transition-duration=${darkCoverProbe.transitionDuration} —— 应为 --dur-fast(150ms)`,
	);
});

// ── ⑥ prefers-reduced-motion：淡入被关停 ───────────────────────
// 反向对照：未开启减弱动效时，探针上确实挂着过渡。
await h.check("默认动效下封面探针确有过渡（反向对照）", () => {
	assert.notEqual(darkCoverProbe.transitionDuration, "0s", `transition-duration=${darkCoverProbe.transitionDuration}`);
});

await win.emulateMedia({ reducedMotion: "reduce" });
const reducedCoverProbe = await probeCoverImg();
await h.check("减弱动效下案例封面淡入被关停（R2：transition 要单独关）", () => {
	assert.equal(
		reducedCoverProbe.transitionDuration,
		"0s",
		`transition-duration=${reducedCoverProbe.transitionDuration} —— reduced-motion 下淡入没被关停`,
	);
});
await win.emulateMedia({ reducedMotion: "no-preference" });

await h.finish();