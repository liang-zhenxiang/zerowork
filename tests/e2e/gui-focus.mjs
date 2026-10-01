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
 *   ⑤ 按钮路径回归：顶栏按钮仍能切换（既有能力不受新代码影响）。
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

/** 派发一个带修饰键的「.」按键（keydown 足以触发，无需 keyup）。 */
const pressShortcut = (modifier) =>
	win.evaluate((mod) => {
		const event = new KeyboardEvent("keydown", {
			key: ".",
			bubbles: true,
			cancelable: true,
			[mod]: true,
		});
		window.dispatchEvent(event);
	}, modifier);

await h.check("默认侧栏展开", async () => {
	assert.equal(await sidebarState(), "open");
});
const openStats = (await h.shoot("sidebar-open")).stats;

await h.check("⌘+.（meta 修饰）能折叠侧栏", async () => {
	await pressShortcut("metaKey");
	await waitUntil(async () => (await sidebarState()) === "collapsed", {
		timeout: 10_000,
		desc: "data-sidebar 切到 collapsed",
	});
});
await h.waitForSettled();
const collapsedStats = (await h.shoot("sidebar-collapsed")).stats;

await h.check("折叠后画面确实变了（亮度差 > 1，布局真的让位了）", async () => {
	// 侧栏灰底比主区白底暗：折叠后灰区消失，浅色主题下画面应变亮。
	// 阈值取 1：这是「布局是否真的变了」的信号断言，不是主题级的大反差。
	const delta = Math.abs(collapsedStats.mean - openStats.mean);
	assert.ok(
		delta > 1,
		`展开 mean=${openStats.mean.toFixed(2)}，折叠 mean=${collapsedStats.mean.toFixed(2)}，` +
			`|Δ|=${delta.toFixed(2)} ≤ 1 —— 属性切了但布局没让位？`,
	);
});

await h.check("Ctrl+.（ctrl 修饰，Windows/Linux 路径）也能触发", async () => {
	await pressShortcut("ctrlKey"); // 展开
	await waitUntil(async () => (await sidebarState()) === "open", { timeout: 10_000, desc: "恢复展开" });
	await pressShortcut("ctrlKey"); // 再折叠
	await waitUntil(async () => (await sidebarState()) === "collapsed", { timeout: 10_000, desc: "再次折叠" });
});

await h.check("裸「.」不触发（打字场景不误伤）", async () => {
	await pressShortcut("__none__");
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(await sidebarState(), "collapsed", "无修饰键的 . 不应改变侧栏状态");
});

await h.check("顶栏按钮仍能切换（既有路径回归）", async () => {
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
