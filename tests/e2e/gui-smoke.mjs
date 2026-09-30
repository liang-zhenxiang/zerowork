/**
 * 端到端 GUI 冒烟测试。
 *
 * 目标不是"跑起来不报错"，而是验证**重建后的源码构建产物**真的可用：
 * 主窗口渲染出真实界面、daemon 子进程起来并应答 IPC、关键交互可用。
 *
 * 之所以用 Playwright 的 _electron 而不是截图比对：Electron 应用的很多
 * 失败是"界面看着在、但 IPC 全挂"（daemon 没起来、通道名对不上）。
 * 必须真正驱动 DOM、读回状态，才能发现这类问题。
 *
 * 这里同时演示本仓库 e2e 的两条纪律：
 *   ① 骨架全部来自 `./lib/harness.mjs`，本文件只写"驱动界面 + 断言"
 *   ② **先截图、后断言** —— 断言失败时截图里才有出问题的那一屏
 */
import assert from "node:assert/strict";
import { createHarness } from "./lib/harness.mjs";

const h = createHarness({ name: "smoke" });
await h.launch();
const win = h.window();

// ── 断言 ─────────────────────────────────────────────
await h.check("窗口标题为 ZeroWork", async () => assert.equal(await win.title(), "ZeroWork"));

const probe = await win.evaluate(() => {
	const sideNav = document.querySelector("aside, nav, [class*='sidebar'], [class*='sider']");
	return {
		rootChildren: document.getElementById("root")?.childElementCount ?? -1,
		text: document.body.innerText || "",
		textareas: document.querySelectorAll("textarea").length,
		buttons: document.querySelectorAll("button").length,
		elementCount: document.querySelectorAll("*").length,
		// 样式加载检测：无样式时 body 字体是浏览器默认衬线字体，
		// 侧边栏也不会被 flex 撑开。只看"有没有文本"抓不到丢 CSS 的问题。
		styleSheets: document.styleSheets.length,
		bodyFont: getComputedStyle(document.body).fontFamily,
		sideNavWidth: sideNav ? sideNav.getBoundingClientRect().width : -1,
	};
});

await h.check("React 已挂载到 #root", () => assert.ok(probe.rootChildren > 0, `root 子节点=${probe.rootChildren}`));
await h.check("渲染出足量 DOM 元素", () => assert.ok(probe.elementCount > 100, `元素数=${probe.elementCount}`));
await h.check("存在输入框", () => assert.ok(probe.textareas > 0, "未找到 textarea"));
await h.check("存在按钮", () => assert.ok(probe.buttons > 0, "未找到 button"));
await h.check("侧边栏导航渲染", () => assert.ok(probe.text.includes("新建任务"), "缺少「新建任务」"));
await h.check("欢迎页文案渲染", () => assert.ok(probe.text.includes("开工吧"), "缺少欢迎页文案"));
await h.check("场景标签渲染", () => assert.ok(probe.text.includes("日常办公"), "缺少场景标签"));
await h.check("最佳实践案例渲染", () => assert.ok(probe.text.includes("最佳实践"), "缺少案例区"));
await h.check("样式表已加载", () => assert.ok(probe.styleSheets > 0, "未加载任何样式表"));
await h.check(
	"样式实际生效（非默认字体）",
	() => assert.ok(!/^(Times|serif|"Times New Roman")/.test(probe.bodyFont.trim()), `body 字体=${probe.bodyFont}`),
);
await h.check("侧边栏布局生效", () => assert.ok(probe.sideNavWidth > 120, `侧边栏宽度=${probe.sideNavWidth}`));

// daemon 是独立 utility process，它没起来的话界面会一直在「正在启动」
await h.waitForDaemon();
await h.check(
	"daemon 在 darwin 上运行",
	() => assert.ok(h.procLines.some((l) => l.includes("darwin")), "未看到 darwin 平台标识"),
);
await h.check(
	"daemon 正常应答 IPC",
	() => assert.ok(h.procLines.some((l) => l.includes("settings:snapshot")), "未看到 settings:snapshot 应答"),
);
await h.check("无 daemon 崩溃", () => assert.ok(!h.procLines.some((l) => l.includes("daemon 退出")), "daemon 退出"));
await h.check("无渲染层未捕获异常", () => assert.equal(h.pageErrors.length, 0, h.pageErrors.join("; ")));

// 首屏是全新用户看到的第一眼，最该有像素级证据。
// 断言「不是一片纯色」能抓住白屏、整块错误边界、崩溃后残留的空壳。
await h.shoot("home");

// ── 减弱动态效果（prefers-reduced-motion: reduce）────────────────
//
// 这条断言的重点**不是**「动画没了」，而是「动画没了**且界面照常可用**」。
// `.home-title-char` 的基础态是 `opacity: 0`（靠动画淡入、`both` 填充），
// 只写 `animation: none` 会让首页标题**永久不可见** —— 一个无障碍改动反而
// 制造出更严重的问题。所以断言里必须同时含「文字非空且 opacity 为 1」。
//
// 为什么用 emulateMedia 而不是启动参数：Playwright 的 `electron.launch()`
// 没有 `reducedMotion` 选项（只有 colorScheme/locale/… 这几个），
// 而 `page.emulateMedia()` 对 Electron 页面同样有效，且改的是真实的媒体特性
// —— CSS 的 @media 会立刻重新求值。
const SPINNER_PROBE = 'spinner';
const SHIMMER_PROBE = 'text-shimmer';
const PROBE_TEXT = '正在压缩上下文…';

/** 读回「拿本文件的真实类名造一个探针」的动画状态。 */
const probeAnimations = () =>
	win.evaluate(
		({ spinner, shimmer, text }) => {
			const read = (className, content) => {
				const el = document.createElement('span');
				el.className = className;
				if (content) el.textContent = content;
				document.body.appendChild(el);
				const cs = getComputedStyle(el);
				const out = { animationName: cs.animationName, color: cs.color, opacity: cs.opacity };
				el.remove();
				return out;
			};
			return { spinner: read(spinner), shimmer: read(shimmer, text) };
		},
		{ spinner: SPINNER_PROBE, shimmer: SHIMMER_PROBE, text: PROBE_TEXT },
	);

// 反向对照：**先证明这条断言不是恒真的** —— 默认（未开启减弱动效）时探针上
// 确实挂着动画。少了这一步，后面断言 animation-name 为 none 毫无意义。
const motionOn = await probeAnimations();
await h.check("默认动效下探针确有动画（反向对照）", () => {
	assert.equal(motionOn.spinner.animationName, "spin", `spinner=${motionOn.spinner.animationName}`);
	assert.equal(motionOn.shimmer.animationName, "text-shimmer-sweep", `shimmer=${motionOn.shimmer.animationName}`);
});

await win.emulateMedia({ reducedMotion: "reduce" });

const reduced = await win.evaluate(() => {
	const chars = [...document.querySelectorAll(".home-title-char")];
	const caret = document.querySelector(".home-title-caret");
	const first = chars[0] ?? null;
	return {
		charCount: chars.length,
		charText: chars.map((c) => c.textContent || "").join(""),
		charOpacity: first ? getComputedStyle(first).opacity : null,
		charAnimation: first ? getComputedStyle(first).animationName : null,
		caretOpacity: caret ? getComputedStyle(caret).opacity : "（没有光标元素）",
	};
});

await h.check("减弱动效：首页标题文字仍在且可见（终态陷阱）", () => {
	assert.ok(reduced.charText.trim().length > 0, `标题文字为空（${reduced.charCount} 个 .home-title-char）`);
	assert.equal(reduced.charOpacity, "1", `opacity=${reduced.charOpacity} —— 只关动画没写终态，标题会永久不可见`);
});
await h.check("减弱动效：打字机动画已停", () =>
	assert.equal(reduced.charAnimation, "none", `animation-name=${reduced.charAnimation}`),
);
await h.check("减弱动效：光标隐藏（它的终态是隐，不是停成恒亮）", () =>
	assert.equal(reduced.caretOpacity, "0", `opacity=${reduced.caretOpacity}`),
);

const reducedProbes = await probeAnimations();
await h.check("减弱动效：转圈不再旋转", () =>
	assert.equal(reducedProbes.spinner.animationName, "none", `animation-name=${reducedProbes.spinner.animationName}`),
);
await h.check("减弱动效：扫光已停且文字改为实色（不落在 26% 极浅色上）", () => {
	assert.equal(reducedProbes.shimmer.animationName, "none", `animation-name=${reducedProbes.shimmer.animationName}`);
	// 基础态是 `color: transparent` + background-clip: text —— 关掉扫光后如果
	// 还停在透明色上，这行字就等于没有
	assert.ok(
		!/^rgba?\([^)]*,\s*0(\.0+)?\)$/.test(reducedProbes.shimmer.color),
		`color=${reducedProbes.shimmer.color} —— 关掉扫光后文字仍是透明的`,
	);
});

await h.finish();
