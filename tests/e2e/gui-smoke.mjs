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

await h.finish();
