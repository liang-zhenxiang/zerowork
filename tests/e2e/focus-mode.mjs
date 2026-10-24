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
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

/** 一段有层次的长回答：标题 + 段落 + 代码块 + 表格，用来量真实读感。 */
const REPLY = [
	"## 这轮改了什么",
	"",
	"把阅读列宽从 832 收到 720，正文升一档到 15px。这里是用来量行长的一段中文，",
	"刻意写得长一些，好让每一行都接近列宽上限，从而能算出真实的每行字数。",
	"",
	"```js",
	'const width = 720; // 专注模式下的阅读列宽',
	"```",
	"",
	"| 项 | 普通 | 专注 |",
	"| --- | --- | --- |",
	"| 列宽 | 832 | 720 |",
	"| 字号 | 14 | 15 |",
	""
].join("\n");

const h = createHarness({ name: "focus-mode", shots: true });
mkdirSync(h.WORKSPACE_DIR, { recursive: true });
writeFileSync(resolve(h.WORKSPACE_DIR, "README.md"), "# focus mode\n", "utf8");
const mock = await startMockModelServer({ reply: REPLY, models: ["focus-model"] });
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
		// 极光真正的**绘制层**是视图卡（`.home` / `.chat`），不是 `.app` ——
		// `.app` 自己的背景被那条 (0,7,1) 的排除法规则整条盖住。第一版断言读 `.app`，
		// 于是「屏幕没变、测试却绿」。这里读被画出来的那一层。
		const view = document.querySelector(".home, .chat, .settings");
		const pill = document.querySelector(".focus-exit");
		const toggle = document.querySelector(".sidebar-toggle-btn");
		return {
			attr: html.getAttribute("data-focus"),
			stored: window.localStorage.getItem("zerowork.focusMode"),
			sidebarVisible: sidebar !== null && sidebar.getBoundingClientRect().width > 0,
			innerMaxWidth: inner === null ? null : getComputedStyle(inner).maxWidth,
			viewBackground: view === null ? null : getComputedStyle(view).backgroundImage,
			appBackground: app === null ? null : getComputedStyle(app).backgroundImage,
			entryPressed: entry === null ? null : entry.getAttribute("aria-pressed"),
			pill: pill !== null,
			pillBox: pill === null ? null : pill.getBoundingClientRect().toJSON(),
			pillOpacity: pill === null ? null : getComputedStyle(pill).opacity,
			pillFontSize: pill === null ? null : getComputedStyle(pill).fontSize,
			toggleDisplay: toggle === null ? null : getComputedStyle(toggle).display,
			casesDisplay: (() => {
				const cases = document.querySelector(".cases");
				return cases === null ? null : getComputedStyle(cases).display;
			})(),
			composerBottom: (() => {
				const zone = document.querySelector(".composer-zone, .composer-slot");
				return zone === null ? 0 : zone.getBoundingClientRect().bottom;
			})(),
			homeHeight: (() => {
				const home = document.querySelector(".home");
				return home === null ? 0 : home.getBoundingClientRect().height;
			})()
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
	offBackground = before.viewBackground;
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
	assert.notEqual(
		s.viewBackground,
		offBackground,
		"极光应降档：**被画出来的那一层**（视图卡）的计算背景必须与普通模式不同"
	);
	assert.equal(s.pill, true, "进入后应有退出胶囊");
	assert.equal(s.toggleDisplay, "none", "左上角那个侧栏开关在专注模式下点不动，应直接隐藏");
	assert.equal(s.casesDisplay, "none", "案例区在专注模式下应整块撤掉（它是首页最亮的四块矩形，与「少被打断」相反）");
	assert.ok(
		s.composerBottom < s.homeHeight,
		`输入卡不能溢出首页视口（composerBottom=${Math.round(s.composerBottom)}, home=${Math.round(s.homeHeight)}）`
	);
	assert.ok(
		s.pillBox.left < 200 && s.pillBox.top < 200,
		`退出胶囊应在左上（不占主操作角），实测 left=${Math.round(s.pillBox.left)} top=${Math.round(s.pillBox.top)}`
	);
	assert.equal(s.pillOpacity, "1", "它是唯一的鼠标出口，不许靠半透明藏起来");
	assert.equal(s.pillFontSize, "13px", "出口文字用 --text-list（13px），12px 太弱");
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

/* ══════════════════════════════════════════════════════════════════════
 * 会话页：专注真正发生的地方，必须被看见（设计师评审 P0-4）
 * ══════════════════════════════════════════════════════════════════════ */

/**
 * 走真实设置面板切主题。渲染层唯一真源是 `html[data-theme]`，而 preload 的
 * `setThemePreference()` 只写偏好、不改 DOM —— 用它等于绕开被测对象。
 * 前提：专注模式已退出、没有模态开着。
 */
const pickTheme = async (label) => {
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
	await win.evaluate((want) => {
		const hit = [...document.querySelectorAll('[role="listbox"] [role="option"]')].find((el) =>
			(el.textContent ?? "").includes(want)
		);
		if (hit === undefined) throw new Error(`外观下拉里没有「${want}」`);
		hit.click();
	}, label);
	await waitUntil(
		() => win.evaluate((want) => document.documentElement.getAttribute("data-theme") === (want === "深色" ? "dark" : "light"), label),
		{ timeout: 15_000, desc: `切到${label}` }
	);
	await win.evaluate(() => document.querySelector('[aria-label="关闭设置"]').click());
	await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") === null), {
		timeout: 15_000,
		desc: "设置关闭"
	});
};

await h.check("会话页：普通 vs 专注的读感是量出来的，不是看代码猜的", async () => {
	// 上一段停在专注 + 暗色：先退出专注，再从首页起步
	if ((await state()).attr === "on") {
		await win.keyboard.press("Escape");
		await waitUntil(async () => (await state()).attr !== "on", { timeout: 10_000, desc: "退出专注模式" });
	}
	await pickTheme("浅色");
	await win.evaluate(() => globalThis.kami.newTask());
	await win.evaluate(
		async ({ baseUrl, ws }) => {
			const k = globalThis.kami;
			await k.saveCustomProvider(
				{
					id: "mock-focus",
					name: "Mock Focus",
					baseUrl,
					api: "openai-completions",
					authHeader: true,
					models: [
						{
							id: "focus-model",
							name: "focus-model",
							reasoning: false,
							vision: false,
							contextWindow: 128000,
							maxTokens: 8192
						}
					]
				},
				"mock-key"
			);
			await k.setModel("mock-focus/focus-model");
			await k.setWorkspace(ws);
		},
		{ baseUrl: mock.baseUrl, ws: h.WORKSPACE_DIR }
	);
	const box = win.locator('[aria-label="消息输入框"]');
	await box.waitFor({ state: "visible", timeout: 30_000 });
	await box.fill("给我一份这轮改动的说明");
	await box.press("Enter");
	await waitUntil(
		() =>
			win.evaluate(() => {
				const block = document.querySelector(".entry.assistant .markdown, .markdown");
				return block !== null && block.innerText.includes("这轮改了什么");
			}),
		{ timeout: 60_000, desc: "助手回答渲染出来" }
	);

	/** 读正文的真实排版：列宽、字号、和一行能装多少字。 */
	const readMetrics = () =>
		win.evaluate(() => {
			const paragraph = document.querySelector(".entry.assistant .markdown p, .markdown p");
			if (paragraph === null) return null;
			const style = getComputedStyle(paragraph);
			const box = document.querySelector(".chat-composer") ?? document.querySelector(".chat");
			return {
				fontSize: parseFloat(style.fontSize),
				paragraphWidth: Math.round(paragraph.getBoundingClientRect().width),
				chatWidth: box === null ? null : Math.round(box.getBoundingClientRect().width),
				annotationWidth: getComputedStyle(document.querySelector(".chat")).maxWidth,
				pillBox: (() => {
					const pill = document.querySelector(".focus-exit");
					return pill === null ? null : pill.getBoundingClientRect().toJSON();
				})(),
				sendBox: (() => {
					const send = document.querySelector(".chat-composer .send-btn, .send-btn");
					return send === null ? null : send.getBoundingClientRect().toJSON();
				})()
			};
		});

	await h.shoot("focus-off-chat-light");
	const plain = await readMetrics();
	assert.notEqual(plain, null, "会话页应渲染出助手段落");

	await win.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Shift+F`);
	await waitUntil(async () => (await state()).attr === "on", { timeout: 10_000, desc: "再次进入专注模式" });
	await new Promise((r) => setTimeout(r, 700));
	await h.shoot("focus-chat-light");
	const focused = await readMetrics();

	assert.equal(focused.fontSize, 15, `正文应升到 15px，实测 ${focused.fontSize}`);
	assert.ok(
		focused.fontSize > plain.fontSize,
		`专注正文（${focused.fontSize}）必须比普通（${plain.fontSize}）大`
	);
	assert.ok(
		focused.paragraphWidth <= 696,
		`阅读列宽应收在 720 以内（正文可用宽约 696），实测段落 ${focused.paragraphWidth}`
	);
	// 列宽是「只收不扩」：窗口本来就比 720 窄时保持原值（否则窄窗口直接出横向滚动条）。
	// 所以这里断言的是「不会变宽」，只有普通模式确实超过 720 时才要求真的收窄 ——
	// CI 的窗口比本机小，第一版无条件断言在 CI 上必红。
	assert.ok(
		focused.paragraphWidth <= plain.paragraphWidth,
		`专注模式不许把阅读列放宽（普通 ${plain.paragraphWidth} → 专注 ${focused.paragraphWidth}）`
	);
	if (plain.paragraphWidth > 720) {
		assert.ok(
			focused.paragraphWidth < plain.paragraphWidth,
			`普通模式列宽 ${plain.paragraphWidth} 超过 720 时，专注模式必须收窄`
		);
	}
	if (focused.pillBox !== null && focused.sendBox !== null) {
		const gap = focused.sendBox.left - (focused.pillBox.left + focused.pillBox.width);
		assert.ok(Boolean(gap >= 0) || focused.pillBox.top < 120, `退出胶囊不应压在发送键上（gap=${Math.round(gap)}）`);
	}

	// 暗色会话：同一套版式，换肤后还要能读
	await win.keyboard.press("Escape");
	await waitUntil(async () => (await state()).attr !== "on", { timeout: 10_000, desc: "退出专注（准备切暗色）" });
	await pickTheme("深色");
	await win.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Shift+F`);
	await waitUntil(async () => (await state()).attr === "on", { timeout: 10_000, desc: "暗色下进入专注" });
	await new Promise((r) => setTimeout(r, 700));
	await h.shoot("focus-chat-dark");

	// 收尾：把主题与专注态还原，别把状态留给后面的检查
	await win.keyboard.press("Escape");
	await waitUntil(async () => (await state()).attr !== "on", { timeout: 10_000, desc: "收尾退出专注" });
	await pickTheme("浅色");
});

mock.close();

await h.finish();
