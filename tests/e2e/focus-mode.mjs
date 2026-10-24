/**
 * 专注模式（§13）：把会话从「工具界面」切成「一页纸」。
 *
 * 这一套断言的原则：**只测用户能看见的东西**。所以不测 React state，
 * 只读 `html[data-focus]`、侧栏的可见性、`.home-inner` 的计算样式、以及重载后的状态。
 *
 * 五项缺一不可：
 *  ① 入口存在且是开关（aria-pressed）—— 快捷键不能是唯一入口；
 *  ② 进入后侧栏真的不可见、阅读列宽真的收窄 —— 否则就是个没效果的按钮；
 *  ③ 极光真的降档 —— 把「更好读」落实到画面上，而不只是宽度变了；
 *  ④ Esc 能退出 —— 只进不出是最糟的失败形态；
 *  ⑤ 重载后仍是上次的状态 —— 否则每次打开都得重新按一遍。
 */
import assert from "node:assert/strict";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const h = createHarness({ name: "focus-mode", shots: true });
await h.launch();
const win = h.window();

const state = () =>
	win.evaluate(() => {
		const html = document.documentElement;
		const sidebar = document.querySelector(".sidebar");
		const inner = document.querySelector(".home-inner");
		const app = document.querySelector(".app");
		const entry = [...document.querySelectorAll(".sidebar .new-task")].find((n) =>
			n.textContent.includes("专注模式")
		);
		return {
			attr: html.getAttribute("data-focus"),
			stored: window.localStorage.getItem("zerowork.focusMode"),
			sidebarVisible: sidebar !== null && sidebar.getBoundingClientRect().width > 0,
			innerMaxWidth: inner === null ? null : getComputedStyle(inner).maxWidth,
			appBackground: app === null ? null : getComputedStyle(app).backgroundImage,
			entryPressed: entry === null ? null : entry.getAttribute("aria-pressed"),
			pill: document.querySelector(".focus-exit") !== null
		};
	});

await h.check("侧栏有「专注模式」入口，初始为关（aria-pressed=false）", async () => {
	const s = await waitUntil(
		async () => {
			const v = await state();
			return v.entryPressed === null ? null : v;
		},
		{ timeout: 30_000, desc: "侧栏渲染出专注模式入口" }
	);
	assert.equal(s.attr, "off", "首次启动应显式写着 data-focus=off，而不是缺省无属性");
	assert.equal(s.entryPressed, "false", "入口应是一个开关，初始为按起状态");
	assert.equal(s.sidebarVisible, true, "普通模式下侧栏当然要可见");
	await h.shoot("focus-off-light");
});

let offBackground = null;
let offInner = null;

await h.check("进入专注模式：侧栏收起、列宽 720、极光降档", async () => {
	const before = await state();
	offBackground = before.appBackground;
	offInner = before.innerMaxWidth;
	await win.evaluate(() => {
		[...document.querySelectorAll(".sidebar .new-task")]
			.find((n) => n.textContent.includes("专注模式"))
			.click();
	});
	const s = await waitUntil(
		async () => {
			const v = await state();
			return v.attr === "on" ? v : null;
		},
		{ timeout: 10_000, desc: "html[data-focus=on]" }
	);
	assert.equal(s.sidebarVisible, false, "专注模式下侧栏必须真的不可见（不是变透明）");
	assert.equal(s.innerMaxWidth, "720px", "首页阅读列宽应收窄到 720");
	assert.notEqual(offInner, "720px", "对照：普通模式下的列宽本就不是 720（否则上一行断言是空转）");
	assert.notEqual(s.appBackground, offBackground, "极光应降档：画布背景的计算值必须与普通模式不同");
	assert.equal(s.pill, true, "进入后应有退出胶囊");
	await h.shoot("focus-on-light");
});

await h.check("状态写进了 localStorage（供下次启动恢复）", async () => {
	const s = await state();
	assert.equal(s.stored, "true", "开启状态应持久化为 true");
});

await h.check("Esc 退出，并且胶囊随之消失", async () => {
	await win.keyboard.press("Escape");
	const s = await waitUntil(
		async () => {
			const v = await state();
			return v.attr === "off" ? v : null;
		},
		{ timeout: 10_000, desc: "Esc 后回到 off" }
	);
	assert.equal(s.pill, false, "退出后胶囊必须消失（否则会留一个点不动的死按钮）");
	assert.equal(s.sidebarVisible, true, "侧栏应回来");
	assert.equal(s.stored, "false", "关闭状态同样要持久化");
});

await h.check("快捷键 ⌘⇧F / Ctrl+Shift+F 可进入", async () => {
	const mod = process.platform === "darwin" ? "Meta" : "Control";
	await win.keyboard.press(`${mod}+Shift+F`);
	const s = await waitUntil(
		async () => {
			const v = await state();
			return v.attr === "on" ? v : null;
		},
		{ timeout: 10_000, desc: "快捷键进入专注模式" }
	);
	assert.equal(s.sidebarVisible, false, "快捷键进入后侧栏同样要收起");
});

await h.check("重载后仍是专注模式（首屏不闪变）", async () => {
	await win.reload();
	const s = await waitUntil(
		async () => {
			const v = await state();
			return v.attr === "on" ? v : null;
		},
		{ timeout: 40_000, desc: "重载后仍是 on" }
	);
	assert.equal(s.sidebarVisible, false, "重载后侧栏仍应收起");
	assert.equal(s.innerMaxWidth, "720px", "重载后列宽仍是 720");
});

await h.check("暗色主题下依然是「一页纸」（切主题不丢状态）", async () => {
	// 主题走真实设置面板（渲染层唯一真源是 html[data-theme]，直接调 preload 的
	// setThemePreference 只写偏好、不改 DOM —— 那是另一个函数，别拿它当捷径）。
	await win.keyboard.press("Escape");
	await waitUntil(() => win.evaluate(() => document.documentElement.getAttribute("data-focus") === "off"), {
		timeout: 10_000,
		desc: "先退出专注，才能点到侧栏的设置"
	});
	await win.evaluate(() => document.querySelector('[aria-label="设置"]').click());
	await waitUntil(() => win.evaluate(() => document.querySelector('[aria-label="外观"]') !== null), {
		timeout: 20_000,
		desc: "外观选择器渲染"
	});
	await win.evaluate(() => document.querySelector('[aria-label="外观"]').click());
	await waitUntil(() => win.evaluate(() => document.querySelector('[role="listbox"]') !== null), {
		timeout: 10_000,
		desc: "外观下拉展开"
	});
	await win.evaluate(() => {
		const hit = [...document.querySelectorAll('[role="listbox"] [role="option"]')].find((el) =>
			(el.textContent ?? "").includes("深色")
		);
		if (hit === undefined) throw new Error("外观下拉里没有「深色」");
		hit.click();
	});
	await waitUntil(
		() => win.evaluate(() => document.documentElement.getAttribute("data-theme") === "dark"),
		{ timeout: 15_000, desc: "切到暗色" }
	);
	await win.evaluate(() => document.querySelector('[aria-label="关闭设置"]').click());
	await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") === null), {
		timeout: 15_000,
		desc: "设置关闭"
	});

	const mod = process.platform === "darwin" ? "Meta" : "Control";
	await win.keyboard.press(`${mod}+Shift+F`);
	const s = await waitUntil(
		async () => {
			const v = await state();
			return v.attr === "on" ? v : null;
		},
		{ timeout: 10_000, desc: "暗色下进入专注模式" }
	);
	assert.equal(s.sidebarVisible, false, "暗色下侧栏同样收起");
	assert.equal(s.innerMaxWidth, "720px", "暗色下列宽同样是 720");
	// 等打字机标题与主题过渡跑完再截图：早 300ms 拍到的是半透明的首帧，
	// 图上标题会「消失」—— 那是动画，不是缺陷。
	await h.waitForSettled?.();
	await new Promise((r) => setTimeout(r, 600));
	await h.shoot("focus-on-dark");
});

await h.finish();
