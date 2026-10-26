/**
 * 专注模式（⌘./Ctrl+. 折叠侧栏）的 GUI 测试。
 *
 * 侧栏折叠的**按钮路径**与 CSS 过渡此前已完整存在（`.app[data-sidebar]`
 * 状态机 + flex-basis 受控例外 ④），本用例锁的是 issue #70 补的**键盘路径**
 * 与两态的视觉事实，防止快捷键被后续改动无声碰掉：
 *
 * 断言：
 *   ① 快捷键切换：默认展开 → 按 ⌘./Ctrl+. → data-sidebar 变 collapsed
 *      （测注入的 keydown 带修饰键，两种修饰键各验一次）；
 *   ② 折叠态截图 + 像素断言，且与展开态**平均亮度/内容区宽度可区分**
 *      ——侧栏是灰底（浅色主题 #f2f2f2），折叠后主区左边界右移，
 *      画面确实不同（防「属性切了、布局没变」的假通过）；
 *   * ③ 再按一次恢复展开；
 *   ④ 修饰键不全不触发（只按「.」不折叠——输入场景不误伤）；
 *   ⑤ 按钮路径回归：收起态的左上角浮动按钮仍能展开（展开态开关在侧栏品牌行右端，
 *      这条锁的是「收起后仍有鼠标入口」）。
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const h = createHarness({ name: "focus" });
mkdirSync(h.WORKSPACE_DIR, { recursive: true });

await h.launch();
const win = h.window();

const sidebarState = () =>
	win.evaluate(() => document.querySelector(".app")?.dataset.sidebar ?? null);

/**
 * 用 Playwright 真实键盘按组合键（Meta+./Control+.），不走合成事件——
 * 合成 KeyboardEvent 需要浏览器全局、在 eslint 的 Node 视角是 no-undef，
 * 而真实按键连「修饰键原生行为被 preventDefault 拦住」这条也一并覆盖。
 */
const pressShortcut = (combo) => win.keyboard.press(combo);

await h.check("默认侧栏展开", async () => {
	assert.equal(await sidebarState(), "open");
});
await h.check("展开态开关在侧栏品牌行右端，不压品牌文案", async () => {
	const box = await win.evaluate(() => {
		const brand = document.querySelector(".sidebar-brand");
		const btn = brand?.querySelector(".sidebar-toggle-btn");
		const name = brand?.querySelector(".brand-name");
		if (!brand || !btn || !name) return null;
		return {
			brandRight: brand.getBoundingClientRect().right,
			btn: btn.getBoundingClientRect().toJSON(),
			nameRight: name.getBoundingClientRect().right
		};
	});
	assert.ok(box, "展开态应有位于 .sidebar-brand 内的侧栏开关");
	assert.ok(box.btn.left >= box.nameRight, "开关应在品牌文案右侧，不压住 ZeroWork");
	assert.ok(
		Math.abs(box.brandRight - box.btn.right) <= 12,
		`开关应贴品牌行右端（与行右边缘差 ${(box.brandRight - box.btn.right).toFixed(1)}px）`
	);
});
await h.shoot("sidebar-open");
// 主列左边缘：折叠侧栏后应左移。几何比「整幅平均亮度」可靠得多。
const mainLeft = () =>
	win.evaluate(() => {
		const el = document.querySelector(".home, .chat, .settings, .app-view");
		return el ? el.getBoundingClientRect().left : -1;
	});
const openLeft = await mainLeft();

await h.check("⌘+.（meta 修饰）能折叠侧栏", async () => {
	await pressShortcut("Meta+.");
	await waitUntil(async () => (await sidebarState()) === "collapsed", {
		timeout: 10_000,
		desc: "data-sidebar 切到 collapsed",
	});
});
await h.waitForSettled();
await h.shoot("sidebar-collapsed");

await h.check("折叠后主列真的向让位了（几何断言：主列左边缘左移）", async () => {
	// 原断言比的是整幅平均亮度（旧版侧栏是灰底、主区是白底，折叠后必然变亮）。
	// 极光墨之后侧栏与画布同属浅色系，平均亮度对布局几乎不敏感（实测 |Δ|≈0.4），
	// 它就不再是「布局有没有让位」的有效信号 —— 换成直接量几何：主列左边缘应左移。
	const collapsedLeft = await mainLeft();
	assert.ok(openLeft >= 0, `找不到主列容器（left=${openLeft}）`);
	assert.ok(
		collapsedLeft < openLeft - 80,
		`展开 left=${openLeft.toFixed(1)}，折叠 left=${collapsedLeft.toFixed(1)} —— ` +
			`侧栏收了但主列没有让位？`,
	);
});

await h.check("Ctrl+.（ctrl 修饰，Windows/Linux 路径）也能触发", async () => {
	await pressShortcut("Control+."); // 展开
	await waitUntil(async () => (await sidebarState()) === "open", { timeout: 10_000, desc: "恢复展开" });
	await pressShortcut("Control+."); // 再折叠
	await waitUntil(async () => (await sidebarState()) === "collapsed", { timeout: 10_000, desc: "再次折叠" });
});

await h.check("裸「.」不触发（打字场景不误伤）", async () => {
	await win.keyboard.press(".");
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(await sidebarState(), "collapsed", "无修饰键的 . 不应改变侧栏状态");
});

await h.check("收起态左上角浮动按钮仍能展开（唯一鼠标入口）", async () => {
	await win.evaluate(() => {
		const btn = document.querySelector('[aria-label="展开侧栏"]') ?? document.querySelector('[aria-label="收起侧栏"]');
		if (btn === null) throw new Error("找不到侧栏切换按钮");
		btn.click();
	});
	await waitUntil(async () => (await sidebarState()) === "open", { timeout: 10_000, desc: "按钮展开" });
	await h.waitForSettled();
	await h.shoot("sidebar-open-restored");
});

await h.finish();
