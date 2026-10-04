/**
 * 首屏案例封面「不出网」的 GUI 端到端测试（#104）。
 *
 * 背景：这 12 张封面此前直接引第三方 CDN（`static.workbuddy.cn`）。数据面没问题，
 * 但**体验面破功** —— 一个把「本地优先」当卖点的产品，第一屏就在向第三方出网。
 * 现在封面由渲染层第一方生成（`src/renderer/src/case-cover.js`）。
 *
 * 覆盖：
 *   ① 四张可见封面都渲染出来了，且**卡片里没有 `<img>`**（DOM）
 *   ② 仓库与构建产物里**搜不到**那批 CDN 地址（静态证据，不依赖运行时）
 *   ③ 封面几何彼此不同（同类目三条不是三张复制瓷砖）
 *   ④ **断网**（`context.setOffline(true)`）+ 整页 reload：封面照常渲染
 *   ⑤ 浅色 / 深色：封面区域有层次（不是一块纯色）、两主题画面可区分（截图 + 像素断言）
 *
 * ## 反向验证记录（2026-10-04）
 *
 * 【验证 1】把 `CaseCover` 换回 `<img src="https://static.workbuddy.cn/...">`：
 *   · ① 变红（卡片里出现了 4 个 img）
 *   · ② 变红（构建产物里搜到了那个域名 —— 这条静态证据确实在扫真东西）
 *   · ③ 变红（DOM 探针读不到线宽，四张签名都成了空签名）——如实记录：
 *     ③ 本来就是「几何/签名」的断言，换回图片那条路时它跟着红是合理的，不是误伤。
 * 【验证 2】把 `coverLines` 改成恒定 `[60, 80, 50]`：
 *   · 单测 3 条变红（同类目不雷同 / 12 条两两不同 / 同类目两两不同）
 *   · GUI 的 ③ 变红（三张 doc 封面的签名完全相同）
 * 复原后全绿（单测 20、GUI 6）。
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHarness, ROOT, waitUntil } from "./lib/harness.mjs";
import { diffGrids } from "./lib/png.mjs";

const h = createHarness({ name: "offline-covers" });
await h.launch();
const win = h.window();

// ── 探针 ──────────────────────────────────────────────────────────────
/** 每张封面的「形状签名」：画法 + 内部几何（线宽 / 柱高）—— 不依赖像素。 */
const coverShapes = () =>
	win.evaluate(() =>
		[...document.querySelectorAll(".case-cover")].map((el) => {
			const variant = [...el.classList].find((c) => c.startsWith("case-cover-") && c !== "case-cover");
			const inner = [...el.querySelectorAll(".case-cover-line, .case-cover-bar")].map(
				(node) => node.style.width || node.style.height,
			);
			return `${variant}:${inner.join("|")}`;
		}),
	);

const coverGeometry = () =>
	win.evaluate(() =>
		[...document.querySelectorAll(".case-cover")].map((el) => {
			const r = el.getBoundingClientRect();
			return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
		}),
	);

/** 一块区域的亮度均值与标准差（截图是设备像素，按视口宽换算）。 */
function regionStats(img, rect, viewportWidth) {
	const scale = img.width / viewportWidth;
	const x0 = Math.max(0, Math.round(rect.x * scale));
	const y0 = Math.max(0, Math.round(rect.y * scale));
	const x1 = Math.min(img.width, Math.round((rect.x + rect.w) * scale));
	const y1 = Math.min(img.height, Math.round((rect.y + rect.h) * scale));
	const values = [];
	for (let y = y0; y < y1; y += 1) {
		for (let x = x0; x < x1; x += 1) {
			const o = (y * img.width + x) * img.channels;
			const r = img.data[o];
			const g = img.channels >= 3 ? img.data[o + 1] : r;
			const b = img.channels >= 3 ? img.data[o + 2] : r;
			values.push(0.2126 * r + 0.7152 * g + 0.0722 * b);
		}
	}
	const mean = values.reduce((a, b) => a + b, 0) / values.length;
	const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / values.length;
	return { mean, stdDev: Math.sqrt(variance) };
}

const viewportWidth = () => win.evaluate(() => window.innerWidth);

// 等首屏案例区渲染出来（首页默认显示案例）。
await waitUntil(async () => (await coverGeometry()).length > 0, {
	timeout: 30_000,
	desc: "首屏渲染出案例封面（.case-cover）",
});

// ══ ① 封面在，且卡片里没有 img ══════════════════════════════════════
await h.check("① 封面渲染出来了，且卡片里没有 <img>（第一方生成）", async () => {
	const cards = await win.evaluate(() => document.querySelectorAll(".case-card").length);
	const covers = await coverGeometry();
	assert.ok(cards >= 4, `首屏应有至少 4 张案例卡，实际 ${cards}`);
	assert.equal(covers.length, cards, `每张案例卡都该有自己的封面，卡片 ${cards} / 封面 ${covers.length}`);
	for (const cover of covers) {
		assert.ok(cover.w > 40 && cover.h > 20, `封面尺寸异常：${JSON.stringify(cover)}`);
	}
	const imgs = await win.evaluate(() => document.querySelectorAll(".case-cover img").length);
	assert.equal(imgs, 0, `封面里不该再有 <img>（那是 CDN 实图的路），实际 ${imgs} 个`);
});

// ══ ② 仓库与产物里搜不到那批 CDN 地址 ═══════════════════════════════
await h.check("② 数据与渲染层产物里都不再出现那批 CDN 地址", async () => {
	const casesJson = readFileSync(resolve(ROOT, "resources/welcome/cases.json"), "utf8");
	assert.ok(
		!casesJson.includes("workbuddy.cn"),
		"cases.json 里仍有第三方 CDN 地址（cover 字段没删干净）",
	);
	assert.ok(!/"cover"\s*:/.test(casesJson), "cases.json 里不该再有 cover 字段");

	// 渲染层产物：把 out/renderer/assets 下的 js 全扫一遍（含懒加载 chunk）。
	const assetsDir = resolve(ROOT, "out/renderer/assets");
	const hits = [];
	for (const name of readdirSync(assetsDir)) {
		if (!name.endsWith(".js")) continue;
		const text = readFileSync(join(assetsDir, name), "utf8");
		if (text.includes("workbuddy.cn") || text.includes("playbook/cases")) {
			hits.push(name);
		}
	}
	assert.deepEqual(hits, [], `渲染层产物里仍有 CDN 地址：${hits.join("、")}`);
});

// ══ ③ 每张封面的几何彼此不同 ════════════════════════════════════════
await h.check("③ 可见封面的几何彼此不同（不是同一张瓷砖复制四遍）", async () => {
	const shapes = await coverShapes();
	const unique = new Set(shapes);
	assert.equal(
		unique.size,
		shapes.length,
		`有封面长得完全一样：${shapes.join(" / ")}`,
	);
	// 形状签名必须真的带上了内部几何（否则上面那条会因为「都是空签名」而假通过）。
	assert.ok(
		shapes.every((s) => s.includes("|") || s.includes("cover-slide")),
		`形状签名里没有几何信息：${shapes.join(" / ")}`,
	);
});

// ══ ④ 断网 + 整页 reload，封面照常 ══════════════════════════════════
await h.check("④ 断网后整页重载，封面照常渲染（本地优先的硬证据）", async () => {
	const before = await coverShapes();
	await win.context().setOffline(true);
	try {
		await win.reload();
		// reload 后应用要重新挂载：等案例区再出来。
		await waitUntil(async () => (await coverGeometry()).length > 0, {
			timeout: 30_000,
			desc: "断网重载后封面仍在",
		});
		const after = await coverShapes();
		assert.deepEqual(after, before, "断网重载后的封面几何应与联网时完全一致");
		const geometry = await coverGeometry();
		assert.ok(
			geometry.every((g) => g.w > 40 && g.h > 20),
			`断网重载后有封面尺寸异常（可能塌成了一条线）：${JSON.stringify(geometry)}`,
		);
	} finally {
		await win.context().setOffline(false);
	}
	await h.waitForSettled();
});

// ══ ⑤ 浅色 / 深色：封面有层次，且两主题可区分 ════════════════════════
let lightGrid = null;
await h.check("⑤ 浅色下封面区域有层次（不是一块纯色）", async () => {
	const shot = await h.shoot("covers-light");
	lightGrid = shot.grid;
	const [cover] = await coverGeometry();
	const stats = regionStats(shot.img, cover, await viewportWidth());
	assert.ok(
		stats.stdDev >= 4,
		`封面区域几乎是一块纯色（亮度标准差 ${stats.stdDev.toFixed(2)}）—— 纸片与底色没画出来？`,
	);
});

await h.check("⑤ 深色下同样有层次，且深浅两张画面可区分", async () => {
	await win.evaluate(() => {
		void window.kami?.setThemePreference?.("dark");
		document.documentElement.setAttribute("data-theme", "dark");
	});
	await waitUntil(() => win.evaluate(() => document.documentElement.dataset.theme === "dark"), {
		timeout: 10_000,
		desc: "data-theme 切到 dark",
	});
	await h.waitForSettled();
	const dark = await h.shoot("covers-dark");
	const [cover] = await coverGeometry();
	const stats = regionStats(dark.img, cover, await viewportWidth());
	assert.ok(stats.stdDev >= 4, `深色下封面区域几乎是一块纯色（标准差 ${stats.stdDev.toFixed(2)}）`);

	// 与**刚才那张浅色图**比：降采样后的整体差异必须显著
	// （否则说明主题没生效 / 两张其实是同一张）。
	// ⚠️ 不要在这里重拍一张「浅色」——此刻还在深色，那样两张当然一模一样（踩过）。
	const diff = diffGrids(dark.grid, lightGrid);
	assert.ok(diff > 3, `深浅两套主题的画面差异应显著，实际 ${diff.toFixed(2)}`);

	// 收尾：切回浅色 + 留一张收尾截图（供人工看）。
	await win.evaluate(() => {
		void window.kami?.setThemePreference?.("light");
		document.documentElement.setAttribute("data-theme", "light");
	});
	await waitUntil(() => win.evaluate(() => document.documentElement.dataset.theme === "light"), {
		timeout: 10_000,
		desc: "主题切回浅色",
	});
	await h.waitForSettled();
	await h.shoot("covers-light2");
});

await h.finish();
