/**
 * 全路由视觉回归（route-crawl）—— 二级页面有没有掉回「旧世界」。
 *
 * v0.11.0 把极光墨落在四屏（首页 / 侧栏 / 设置 / 会话），但另外八个页面同样挂在
 * `.app` 外壳上，会跟着 token 一起变，却**没有任何像素级断言**守着。这一族的错法
 * 和首页那条不同：首页是「token 没接线」，二级页面更常见的是「某个页面自己写了
 * 白底 / 自己的圆角 / 自己的边框色」，于是从首页点进去像换了个人做的。
 *
 * 本文件做两件事：
 *   ① **逐个进入八个二级页面**，截图留证（`artifacts/route-crawl/<slug>.png`），
 *      断言它们的外壳确实吃到了同一套 token（画布色 / 圆角 / 带极光与底光的两层底图）；
 *   ② **验光照方向**：画布纵向必须单调变暗（顶部亮、底部沉）。这是设计师提的
 *      「页面越往下越暗」那条，只有量像素才验得出来 —— 计算样式里看不出来。
 *
 * 反向验证（都实测过）：
 *   - 把 `--canvas-floor` 的线性渐变从外壳规则里删掉 → 「纵向单调变暗」红；
 *   - 把某个二级页面的容器写死 `background:#fff` → 该页的「不是纯白」红。
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const h = createHarness({ name: "route-crawl" });
mkdirSync(h.WORKSPACE_DIR, { recursive: true });
await h.launch();
const win = h.window();

/** 侧栏可点的导航项（label 必须是侧栏按钮的文字）。 */
const VIEWS = [
	{ label: "项目", slug: "projects" },
	{ label: "专家·技能·连接器", slug: "skills" },
	{ label: "自动化", slug: "automations" },
	{ label: "资料库", slug: "library" },
	{ label: "文件历史", slug: "history" },
	{ label: "会话检索", slug: "search" },
	{ label: "诊断", slug: "diagnostics" },
	{ label: "统计", slug: "stats" }
];

const clickNav = async (label) => {
	const ok = await win.evaluate((text) => {
		const btn = [...document.querySelectorAll(".sidebar-nav button")].find(
			(b) => (b.textContent ?? "").trim() === text
		);
		if (btn === undefined || btn.disabled) return false;
		btn.click();
		return true;
	}, label);
	assert.ok(ok, `侧栏找不到可点的「${label}」导航项`);
};

/** 视图页外壳（.app 的第一个非侧栏子项）的计算值。 */
const shellFacts = () =>
	win.evaluate(() => {
		const root = getComputedStyle(document.documentElement);
		const pick = (name) => root.getPropertyValue(name).trim();
		const el = [...document.querySelectorAll(".app > *")].find(
			(n) => !n.classList.contains("sidebar") && n.getBoundingClientRect().width > 200
		);
		if (el === undefined) return null;
		const cs = getComputedStyle(el);
		const r = el.getBoundingClientRect();
		return {
			canvas: pick("--canvas"),
			// 圆角不写死数字：极光墨把 --radius-md 从 10px 提到 14px（更软的手感），
			// 断言应该盯「所有页面用的是同一个 token」，而不是某个具体像素值。
			radiusToken: pick("--radius-md"),
			background: cs.backgroundColor,
			image: cs.backgroundImage,
			radius: cs.borderRadius,
			width: Math.round(r.width),
			height: Math.round(r.height)
		};
	});

/** 当前视图页的页头标题（各视图的 h1 就是它）。 */
const viewTitle = () =>
	win.evaluate(() => {
		const el = document.querySelector(".app > main h1, .app > main .settings-head h1");
		return el === null ? null : (el.textContent ?? "").trim();
	});

/** 一条纵向带（占视图页高度的 [from, to)）的平均亮度。 */
const bandMean = (shot, from, to) => {
	const { img } = shot;
	const y0 = Math.round(img.height * from);
	const y1 = Math.round(img.height * to);
	// 只取左右两侧留白的竖条：中间那列是输入卡与案例卡（白色面），会把「画布
	// 本身的明度」整个盖掉 —— 量到的就成了「卡片有多白」，不是光照方向。
	// 左右各取一条（2026-10-26）：CI 窗口 1024 宽时 composer-card 右缘可到
	// x≈980（rect 实测），单取右侧 1300-1520×scale 会被 clamp 成空带或蹭到
	// 卡片边缘。左右对称各取一条，且都在卡片 rect 之外，宽度自适应：
	//   左条 8%–16% 视口宽，右条 84%–92% 视口宽。
	// 2026-10-26 第三次修正（这次把两侧都量透了）：
	// - 右侧：CI 窗口 1024 宽时 composer-card rect=x≈296..980（实测），
	//   84% 处（x≈860）仍在 TEXTAREA 里。右条取 95%–98.5%，在任何卡片
	//   与阴影之外，实测单调（中 243.6 ≥ 偏下 235.5 ≥ 底 230.9）。
	// - 左侧不可用：矮窗下左栏「最近/空态」（.state-empty，rect l=12
	//   w=239，实测）横跨 1%–24% 视口宽，任何左条都会量到它。
	// 所以只取右侧一条。
	const x0 = Math.round(img.width * 0.95);
	const x1 = Math.round(img.width * 0.985);
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
	if (n === 0) throw new Error("取样带为空");
	return sum / n;
};

// ══ ① 首页：光照方向必须单调 ══════════════════════════════════════
await h.check("首页画布下半部分单调变暗（底光生效，越往下越沉）", async () => {
	const shot = await h.shoot("00-home");
	// 只验**下半部分**：顶部那两块是极光的青/靛，颜色本身就比白画布暗，
	// 拿整页去验「越往上越亮」会被极光染色证伪 —— 那不是缺陷。
	// 底光要证的是一件事：从页面中段往下，明度单向衰减。
	const a = bandMean(shot, 0.50, 0.62);
	const b = bandMean(shot, 0.70, 0.82);
	const c = bandMean(shot, 0.88, 0.98);
	assert.ok(
		a >= b && b >= c,
		`下半部分不是单调下降：中=${a.toFixed(1)} 偏下=${b.toFixed(1)} 底=${c.toFixed(1)}` +
			" —— --canvas-floor 那条线性渐变没接上？"
	);
	assert.ok(
		a - c >= 2,
		`中段与底部只差 ${(a - c).toFixed(1)} 个亮度单位，肉眼看不出底光`
	);
});

// ══ ② 八个二级页面：都吃到同一套外壳 token ══════════════════════════
for (const view of VIEWS) {
	await h.check(`「${view.label}」仍是同一套外壳（画布 token / 圆角 / 极光与底光两层底图）`, async () => {
		await clickNav(view.label);
		// 必须**确认换页了**：只校验「外壳存在」会把「点了没反应、还停在首页」
		// 误判为通过 —— 统计页那张全屏空白就是这样漏过去的。
		await waitUntil(
			async () => {
				const f = await shellFacts();
				const title = await viewTitle();
				const onHome = await win.evaluate(() => document.querySelector(".app > main.home") !== null);
				// 有页头 h1 的视图等 h1；没有 h1 的（专家·技能·连接器是标签页面板）
				// 只要求「已经离开首页」—— 它是唯一没有 h1 的一个，别为它放宽全局。
				const needsTitle = view.slug !== "skills";
				return (
					f !== null &&
					f.width > 600 &&
					f.height > 400 &&
					!onHome &&
					(!needsTitle || (title !== null && title.length > 0))
				);
			},
			{ desc: `${view.label} 视图挂上` }
		);
		await h.waitForSettled();
		const title = await viewTitle();
		console.log(`    ↳ ${view.label} → 页头「${title}」`);

		const f = await shellFacts();
		assert.ok(f !== null, `${view.label}：找不到视图页外壳`);
		assert.ok(
			f.background !== "rgb(255, 255, 255)",
			`${view.label}：页面底是纯白 rgb(255,255,255) —— 这个页面自己写了底色，没走 --canvas`
		);
		assert.equal(
			f.radius,
			f.radiusToken,
			`${view.label}：外壳圆角 ${f.radius} 与 --radius-md(${f.radiusToken}) 不一致 —— 这个页面自己写了圆角`
		);
		assert.ok(
			f.image.includes("linear-gradient"),
			`${view.label}：底图里没有纵向底光层（backgroundImage=${f.image}）`
		);
		assert.ok(
			f.image.includes("radial-gradient"),
			`${view.label}：底图里没有极光层（backgroundImage=${f.image}）`
		);

		// 留证：截图能被 h.shoot 的「几乎是纯色」守卫拦下说明页面根本没渲染。
		await h.shoot(`view-${view.slug}`);
	});
}

// ══ ③ 暗色下同样成立 ══════════════════════════════════════════════
await h.check("暗色主题下二级页面的画布跟着变深，底光仍然单调", async () => {
	await win.evaluate(() => {
		document.documentElement.setAttribute("data-theme", "dark");
	});
	await clickNav("统计");
	await h.waitForSettled();
	const f = await shellFacts();
	assert.ok(f !== null, "暗色下找不到视图页外壳");
	assert.ok(
		f.background !== "rgb(255, 255, 255)",
		`暗色下页面底仍是纯白：${f.background}`
	);

	const shot = await h.shoot("view-stats-dark");
	const top = bandMean(shot, 0.04, 0.16);
	const bottom = bandMean(shot, 0.84, 0.96);
	assert.ok(
		top >= bottom,
		`暗色下亮度不是单调下降：顶=${top.toFixed(1)} 底=${bottom.toFixed(1)}`
	);
});

await h.finish();
