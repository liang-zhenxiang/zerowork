/**
 * 首页上手清单的三态：加载中 / 读失败 / 恢复（issue #148）。
 *
 * 此前 `OnboardingChecklist` 是一句 `return null`，把「加载中」与「读失败」一起压成了
 * 「什么都不显示」—— 只有「三步都完成且未展开」才该什么都不显示。读失败的用户因此读成
 * 「这个应用没有引导」。本文件钉住修好后的两态与恢复路径：
 *
 *   ① **读失败** → 就地错误态（`.home-guide[role=alert]`：图标 + 原因 + 重试），
 *      并顺带断言它**没有边框**、底距仍是 16px —— 这两条对应 `docs/DESIGN.md`
 *      的 §3.9 盒子预算与 §3.8 垂直节奏，是本改动的设计红线。
 *   ② **点重试** → 先回到「加载中」的骨架（`role=status` + 与真行同结构），
 *      不是空白、也不是错误态卡住。
 *   ③ **数据到达** → 同一块区域被填上真实行（§4 的骨架纪律）。
 *
 * 「三步完成 → 只剩一枚小按钮」那一态不在这里重复：`onboarding.mjs` 已经走完整条链
 * 并留了截图（`checklist-hidden` / `checklist-all-done`），本文件不为了对齐形态再跑一遍
 * 那条几分钟的流程。
 *
 * ## 怎么注入读失败
 *
 * `window.kami` 是 contextBridge 暴露的，**整个对象是冻结的**（实测 `Object.isFrozen`
 * 为真、属性不可写不可配置），页面里打不了桩。所以学 `dialog-native.mjs` 的做法 ——
 * **在主进程里换掉那个 IPC handler**：清单读的三份数据里 `settings:snapshot` 是关键的一路，
 * 换掉它会如实走到渲染层的 `.catch`，与被测代码走的是同一条路径。
 *
 * 三种模式由一个全局标志驱动：`pass`（原样转发）/ `reject`（抛错）/ `hold`（挂住不返回，
 * 由测试决定何时放行）—— 后两种正好对应「读失败」与「读得慢」。
 */
import assert from "node:assert/strict";
import { createHarness, waitUntil } from "./lib/harness.mjs";

/** 清单读的三份数据之一。选它是因为它同时决定「有没有可用模型」那一行，失败面最大。 */
const CHANNEL = "settings:snapshot";

const h = createHarness({ name: "home-checklist-states" });
await h.launch();
const win = h.window();
const app = h.app();

// ── 界面读回 ─────────────────────────────────────────────────
//
// 断言只取 DOM 与计算样式，不碰 React 内部状态：三态的判据是「用户能看见什么」。
const readGuide = () =>
	win.evaluate(() => {
		const guide = document.querySelector(".home-guide");
		if (guide === null) return { present: false };
		const style = getComputedStyle(guide);
		return {
			present: true,
			// 状态类是三态在 DOM 上的显式判据（见 app.css 里那段说明）—— 不靠嗅探样式或文案
			loading: guide.classList.contains("home-guide-loading"),
			error: guide.classList.contains("home-guide-error"),
			role: guide.getAttribute("role"),
			ariaLabel: guide.getAttribute("aria-label"),
			rows: guide.querySelectorAll(".home-guide-row").length,
			// 真实行才有文案；骨架行里是空的（骨架条 aria-hidden）
			texts: [...guide.querySelectorAll(".home-guide-text")]
				.map((node) => node.textContent.trim())
				.filter((text) => text !== ""),
			// 骨架条 = 带 color-mix 背景的行内样式 span（Skeleton 组件的实现）
			bars: [...guide.querySelectorAll("*")].filter((node) =>
				(node.getAttribute("style") ?? "").includes("color-mix"),
			).length,
			buttons: [...guide.querySelectorAll("button")].map((b) => b.textContent.trim()),
			hasAlertIcon: guide.querySelector(".home-guide-icon-alert") !== null,
			borderTopWidth: style.borderTopWidth,
			marginBottom: style.marginBottom,
			background: style.backgroundColor,
		};
	});

/**
 * 让清单重新拉一次数据：去别的视图再回首页。
 *
 * 清单只在**挂载**与 **cwd 变化**时拉数据，所以「换视图」是唯一不依赖工作空间的入口。
 * 副作用只有「当前视图切到首页」这一条 —— 本文件不断言清单的**内容**（哪几项完成），
 * 只断言三态各自的形态，所以触发方式换掉也不会让断言失真。
 */
async function remountChecklist() {
	await win.evaluate(() => {
		const nav = [...document.querySelectorAll("button")].find((b) =>
			(b.textContent ?? "").includes("专家·技能·连接器"),
		);
		nav?.click();
	});
	await waitUntil(() => win.evaluate(() => document.querySelector(".home-title") === null), {
		timeout: 30_000,
		desc: "离开首页（.home-title 消失）",
	});
	await win.evaluate(() => {
		const newTask = [...document.querySelectorAll("button")].find((b) =>
			(b.textContent ?? "").includes("新建任务"),
		);
		newTask?.click();
	});
	await waitUntil(() => win.evaluate(() => document.querySelector(".home-title") !== null), {
		timeout: 30_000,
		desc: "回到首页（.home-title 出现）",
	});
}

// ── 主进程侧的注入器 ─────────────────────────────────────────
await app.evaluate(({ ipcMain }, channel) => {
	const g = globalThis;
	const registry = ipcMain._invokeHandlers;
	if (!(registry instanceof Map) || !registry.has(channel)) {
		// 内部注册表是 Electron 的实现细节。拿不到就**明确报错**，不要静默变成一个
		// 「永远通过」的用例 —— 那种失败方式最难查（Electron 升级后会这样坏）。
		throw new Error(`拿不到 ${channel} 的 handler（Electron 升级了？改注入方式前先看这里）`);
	}
	g.__checklistInjection = { mode: "pass", release: null };
	g.__checklistOriginal = registry.get(channel);
	ipcMain.removeHandler(channel);
	ipcMain.handle(channel, (event, ...args) => {
		const injection = g.__checklistInjection;
		if (injection.mode === "reject") {
			return Promise.reject(new Error("注入的读取失败（E2E）"));
		}
		if (injection.mode === "hold") {
			return new Promise((resolve) => {
				// 放行时再走真实实现，拿到的就是真实数据（不是编的）
				injection.release = () => resolve(g.__checklistOriginal(event, ...args));
			});
		}
		return g.__checklistOriginal(event, ...args);
	});
}, CHANNEL);

const setInjection = (mode) =>
	// 第一个参数是主进程侧的 electron 模块 —— 这条注入用不到它，取个名字而不是空解构
	app.evaluate((_electron, value) => {
		globalThis.__checklistInjection.mode = value;
	}, mode);

const releaseInjection = () =>
	app.evaluate(async () => {
		await globalThis.__checklistInjection.release?.();
	});

/** 点错误态里的重试（用文案定位，不依赖结构下标）。 */
const clickRetry = () =>
	win.evaluate(() => {
		const button = [...document.querySelectorAll(".home-guide button")].find(
			(b) => b.textContent.trim() === "重试",
		);
		if (button === undefined) return false;
		button.click();
		return true;
	});

// ── ① 读失败 ────────────────────────────────────────────────
await h.check("读失败时清单就地报错并给出重试，而不是整块消失（issue #148）", async () => {
	await setInjection("reject");
	await remountChecklist();
	await waitUntil(async () => (await readGuide()).error === true, {
		timeout: 30_000,
		desc: "清单进入错误态（.home-guide-error）",
	});
	const guide = await readGuide();
	await h.shoot("checklist-error");

	assert.equal(guide.present, true, "读失败时清单整块消失了 —— 这正是 #148 要修的形态");
	assert.equal(guide.loading, false, "错误态与加载态同时成立（状态类互斥性被破坏）");
	assert.equal(guide.role, "alert", "错误态缺少 role=alert（屏幕阅读器读不到这是一条报错）");
	assert.ok(
		guide.texts.some((text) => text.includes("读取失败")),
		`错误态没有「读取失败」的文案：${JSON.stringify(guide.texts)}`,
	);
	assert.ok(
		guide.texts.some((text) => text.includes("注入的读取失败")),
		`错误态把原因吞掉了（应当原样带上 IPC 的报错）：${JSON.stringify(guide.texts)}`,
	);
	assert.ok(guide.buttons.includes("重试"), `没有重试动作：${JSON.stringify(guide.buttons)}`);
	assert.equal(guide.hasAlertIcon, true, "错误态的行首没有危险色图标");

	// 这两条是设计红线，不是排版偏好：见 research/ux-proposal.md
	assert.equal(guide.borderTopWidth, "0px", "错误态带了边框 —— 主列因此多出一个盒子（§3.9）");
	assert.equal(
		guide.marginBottom,
		"16px",
		`清单槽的底距应恒为 --space-5(16px)（§3.8 的 12/12/24/16），实为 ${guide.marginBottom}`,
	);
});

// ── ② 点重试 → 加载中的骨架 ─────────────────────────────────
await h.check("点重试先回到「加载中」的骨架：与真行同结构，不是空白也不是停在错误上", async () => {
	await setInjection("hold");
	assert.equal(await clickRetry(), true, "错误态里没有可点的「重试」按钮");
	await waitUntil(async () => (await readGuide()).loading === true, {
		timeout: 30_000,
		desc: "清单从错误态转到加载态（.home-guide-loading）",
	});
	const guide = await readGuide();
	await h.shoot("checklist-loading");

	assert.equal(guide.error, false, "加载态里还留着错误态的状态类");
	assert.equal(guide.role, "status", "加载态缺少 role=status（「在读取」的语义）");
	assert.equal(guide.ariaLabel, "正在读取上手清单", `加载态缺少在读取的语义：${guide.ariaLabel}`);
	assert.equal(
		guide.rows,
		4,
		`骨架行数应与真行一致（三条待办 + 一句本地优先），实为 ${guide.rows}`,
	);
	assert.equal(guide.bars, 8, `骨架条应为 4 个图标位 + 4 个文字位，实为 ${guide.bars}`);
	assert.deepEqual(guide.texts, [], `骨架里不该出现真文案：${JSON.stringify(guide.texts)}`);
	assert.equal(guide.buttons.length, 0, "加载态不该有按钮（重试已随错误态一起收掉）");
	assert.equal(
		guide.marginBottom,
		"16px",
		`加载态的底距也必须是 16px（换形态不换槽），实为 ${guide.marginBottom}`,
	);
});

// ── ③ 数据到达 → 原地填上 ───────────────────────────────────
await h.check("数据到达后同一块区域被填上：真实行回来，骨架清零", async () => {
	await releaseInjection();
	await waitUntil(
		async () => {
			const guide = await readGuide();
			return guide.present && guide.loading === false && guide.error === false && guide.bars === 0 && guide.texts.length > 0;
		},
		{ timeout: 30_000, desc: "骨架被真实行替换（同一块区域被填上）" },
	);
	const guide = await readGuide();
	await h.shoot("checklist-recovered");

	assert.ok(
		guide.texts.some((text) => text.includes("选一个工作空间")),
		`恢复后没看到清单的第一条待办：${JSON.stringify(guide.texts)}`,
	);
	assert.ok(
		guide.texts.some((text) => text.includes("本地优先")),
		`恢复后没看到那句「本地优先」说明：${JSON.stringify(guide.texts)}`,
	);
	assert.equal(guide.bars, 0, "恢复后还有骨架条没被替换掉");
	assert.equal(guide.hasAlertIcon, false, "恢复后还留着错误态的元素");
});

// 收尾：把通道恢复原样（本进程随后就退出，但保持注入器前后一致更好排查）
await app.evaluate(({ ipcMain }, channel) => {
	ipcMain.removeHandler(channel);
	ipcMain.handle(channel, globalThis.__checklistOriginal);
}, CHANNEL);

await h.finish();
