/**
 * 主题（浅色/深色/跟随系统）的 GUI 测试。
 *
 * 暗色 token 块（`app.css` 的 `[data-theme="dark"]`）此前是「定义了、没接线」的
 * 预留状态；本用例锁住的是**接线后的完整行为**，防止以后退化回半成品：
 *
 * 断言：
 *   ① 缺省浅色：全新环境下 `data-theme` 是 light（保守缺省，见任务 design.md §6）；
 *   ② 设置 → 通用 → 外观 → 选「深色」：`data-theme` 变 dark；首页截图像素断言，
 *      且**平均亮度显著低于浅色截图**（防「属性切了、画面没变」的假通过——
 *      这正是 #39 那类「断言被无关信号满足」的病灶，这里用同一画面两态的
 *      物理量差异做证据）；
 *   ③ 深色下的设置面板截图 + 像素断言（深色不只首页生效）；
 *   ④ 重启仍是深色（preferences.json 持久化 + 渲染层启动接线）；
 *   ⑤ 切回「浅色」属性回 light；选「跟随系统」属性等于系统求值结果；
 *   ⑥ titleBarOverlay 的 symbolColor 随主题变化（Windows 才有 overlay，
 *      macOS 跳过——同 command-exec 的平台 SKIP 口径）。
 *
 * 反向验证记录（2026-10-01）：注释掉渲染层接线后 ②④ 变红，测试不是空壳。
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const h = createHarness({ name: "theme" });
// harness 负责隔离与清空工作区根目录，目录本身要由用例建出来
mkdirSync(h.WORKSPACE_DIR, { recursive: true });

await h.launch();
let win = h.window();

/** 读当前生效主题（渲染层唯一真源是 documentElement 的 data-theme 属性）。 */
const currentTheme = () => win.evaluate(() => document.documentElement.dataset.theme ?? null);

/**
 * 在设置 → 通用 → 「外观」里选一档。
 * SelectField 是自绘下拉：点触发按钮展开 listbox，再点选项。
 */
async function pickTheme(label) {
	await win.evaluate(() => {
		const trigger = document.querySelector('[aria-label="外观"]');
		if (trigger === null) throw new Error('找不到「外观」选择器（AppearanceSection 未渲染？）');
		trigger.click();
	});
	await waitUntil(
		() => win.evaluate(() => document.querySelector('[role="listbox"]') !== null),
		{ timeout: 10_000, desc: "外观下拉展开" },
	);
	await win.evaluate((target) => {
		const listbox = document.querySelector('[role="listbox"]');
		if (listbox === null) throw new Error("listbox 不在");
		// DOM evaluate 里没有 playwright 的 :has-text 语法，用 textContent 匹配
		const options = [...listbox.querySelectorAll('[role="option"]')];
		const hit = options.find((el) => (el.textContent ?? "").includes(target));
		if (hit === undefined) {
			throw new Error(
				`外观下拉里没有「${target}」，现有：${options.map((el) => el.textContent).join(" / ")}`,
			);
		}
		hit.click();
	}, label);
}

async function openSettings() {
	await win.evaluate(() => {
		const btn = document.querySelector('[aria-label="设置"]');
		if (btn === null) throw new Error('找不到设置按钮 [aria-label="设置"]');
		btn.click();
	});
	await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") !== null), {
		timeout: 15_000,
		desc: "设置对话框挂载",
	});
}

// ── ① 缺省浅色 ────────────────────────────────────────────────
await h.check("全新环境缺省为浅色（data-theme=light）", async () => {
	assert.equal(await currentTheme(), "light");
});
const lightStats = (await h.shoot("home-light")).stats;

// ── ② 切深色 ─────────────────────────────────────────────────
await h.check("设置里能选「深色」并立即生效", async () => {
	await openSettings();
	await pickTheme("深色");
	await waitUntil(async () => (await currentTheme()) === "dark", {
		timeout: 10_000,
		desc: "data-theme 切到 dark",
	});
});
await h.waitForSettled();
const darkStats = (await h.shoot("home-dark")).stats;

await h.check("深色首页真的变暗了（平均亮度差 ≥ 25，防属性切换假通过）", async () => {
	assert.ok(
		lightStats.mean - darkStats.mean >= 25,
		`浅色 mean=${lightStats.mean.toFixed(1)}，深色 mean=${darkStats.mean.toFixed(1)}，` +
			`差值 ${lightStats.mean - darkStats.mean < 0 ? "为负" : (lightStats.mean - darkStats.mean).toFixed(1)} ` +
			`未达到 25 —— 属性切了但画面没跟着变？`,
	);
});

// ── ③ 深色下的设置面板 ────────────────────────────────────────
await h.check("深色下设置面板仍正常渲染", async () => {
	assert.equal(await currentTheme(), "dark");
	// 选档会让对话框重挂载/重排版（pop-layer-in 动画 + 分组内容变化），
	// 不等 settled 会拍到白色中间帧（2026-10-01 实拍踩过：卡片底色还在动画里）。
	await h.waitForSettled();
	await h.shoot("settings-dark");
	await win.keyboard.press("Escape");
	await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") === null), {
		timeout: 10_000,
		desc: "设置对话框关闭",
	});
});

// ── ④ 重启持久化 ──────────────────────────────────────────────
await h.check("重启后仍是深色（持久化 + 启动接线）", async () => {
	await h.app().close();
	await h.launch(); // 同一 CONFIG_DIR，preferences.json 里已是 dark
	win = h.window();
	await waitUntil(async () => (await currentTheme()) === "dark", {
		timeout: 30_000,
		desc: "重启后 data-theme=dark",
	});
});
await h.shoot("home-dark-restart");

// ── ⑤ 切回浅色 / 跟随系统 ─────────────────────────────────────
await h.check("能切回「浅色」", async () => {
	await openSettings();
	await pickTheme("浅色");
	await waitUntil(async () => (await currentTheme()) === "light", {
		timeout: 10_000,
		desc: "data-theme 回 light",
	});
});
	await h.check("「跟随系统」档：属性等于系统当前求值", async () => {
		await pickTheme("跟随系统");
		await waitUntil(
			async () =>
				await win.evaluate(() => {
					const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
					return document.documentElement.dataset.theme === (prefersDark ? "dark" : "light");
				}),
			{ timeout: 10_000, desc: "跟随系统档属性与媒体查询一致" },
		);
		await h.snap("home-system");
	});

// ── ⑥ titleBarOverlay 联动（Windows 专属）────────────────────
await h.check("titleBarOverlay 的 symbolColor 随主题（Windows）/ 平台跳过", async () => {
	if (process.platform !== "win32") {
		h.skip("titleBarOverlay 的 symbolColor 随主题（Windows）/ 平台跳过", "macOS 用 hiddenInset 系统红绿灯，无 overlay");
		return;
	}
	const overlay = await h.app().evaluate(({ BrowserWindow }) => {
		const win2 = BrowserWindow.getAllWindows()[0];
		return win2?.getTitleBarOverlay() ?? null;
	});
	assert.notEqual(overlay, null, "窗口没有 titleBarOverlay");
	// 具体颜色值断言放在实现侧：浅色 #333333 / 深色 #f2f2f2
	assert.ok(["#333333", "#f2f2f2"].includes(overlay.symbolColor), `symbolColor=${overlay.symbolColor}`);
});

await h.finish();
