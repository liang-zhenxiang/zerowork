/**
 * 托盘值守 e2e（#422）：设置里的「桌面行为」三项开关 + 真实关窗行为。
 *
 * 为什么必须是 e2e：单测只能证明「决策函数返回了正确的值」，证明不了
 * **它真的接在窗口的 close 事件与 IPC 上** —— 而这条链路断了的表现恰好是
 * 「界面看起来都对，关掉窗口应用就没了」。
 *
 * 断言（全部走真实 Electron）：
 *   ① 设置 → 通用 → 「桌面行为」三行开关渲染出来（含默认值）；
 *   ② 打开「关闭窗口时最小化到托盘」→ desktop.json 落盘 → 主进程窗口 close
 *      被拦下：窗口不可见、进程与 daemon 仍活；
 *   ③ 重新显示窗口 → 开机自启开关触发 app.setLoginItemSettings（主进程 stub）；
 *   ④ 关闭该开关 → 再关窗恢复平台默认（macOS 关窗留进程，Windows/Linux 退出）。
 *      这一条放在最后：它会销毁窗口，之后不再截图。
 *   ⑤ 亮 / 暗两张截图（artifacts/tray/）。
 *
 * 托盘对象本身**不在断言里**：无桌面会话 / 平台限制下它可能建不出来，
 * 而「关窗后窗口隐藏且进程存活」才是这条功能真正要保证的事。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const h = createHarness({ name: "tray" });
const app = await h.launch();
const win = h.window();

const desktopFile = join(h.CONFIG_DIR, "desktop.json");

/** 直接读落盘文件：比只看 UI 状态更能证明「真的保存了」。 */
function readDesktopFile() {
	try {
		return JSON.parse(readFileSync(desktopFile, "utf8"));
	} catch {
		return undefined;
	}
}

async function waitForPref(key, value) {
	await waitUntil(() => readDesktopFile()?.[key] === value, {
		timeout: 10_000,
		desc: `desktop.json 的 ${key} 变成 ${value}（当前：${JSON.stringify(readDesktopFile())}）`,
	});
}

async function openGeneralSettings() {
	await win.evaluate(() => {
		const button = document.querySelector('[aria-label="设置"]');
		if (button === null) throw new Error('找不到设置按钮 [aria-label="设置"]');
		button.click();
	});
	await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") !== null), {
		timeout: 15_000,
		desc: "设置对话框挂上（.settings-card 出现）",
	});
	await win.evaluate(() => {
		const items = [...document.querySelectorAll(".settings-nav-item")];
		const hit = items.find((item) => (item.textContent || "").trim() === "通用");
		if (hit === undefined) throw new Error("设置侧栏里找不到「通用」");
		hit.click();
	});
	await h.waitForSettled();
	// 等到**具体内容元素**出现，而不是只等分组标题（见 testing spec §5.8）：
	// 「桌面行为」的数据要等一次 IPC 回包。
	await waitUntil(
		() =>
			win.evaluate(
				() =>
					document.querySelector('input[aria-label="关闭窗口时最小化到托盘"]') !== null &&
					document.querySelector('input[aria-label="完成任务时通知"]') !== null &&
					document.querySelector('input[aria-label="开机自启"]') !== null,
			),
		{ timeout: 15_000, desc: "「桌面行为」三行开关出现" },
	);
}

async function scrollToDesktopSection() {
	await win.evaluate(() => {
		const input = document.querySelector('input[aria-label="关闭窗口时最小化到托盘"]');
		input?.closest(".settings-section")?.scrollIntoView({ block: "center" });
	});
	await h.waitForSettled();
}

function readRows() {
	return win.evaluate(() =>
		[...document.querySelectorAll(".desktop-toggle-row")].map((row) => {
			const input = row.querySelector("input");
			const note = row.querySelector(".desktop-toggle-note");
			return {
				tag: row.tagName,
				// 行本身是 <label>，内部不许再有 label（嵌套 label 会吞点击 / 读屏语义）
				nestedLabels: row.querySelectorAll("label").length,
				title: row.querySelector(".desktop-toggle-title")?.textContent?.trim() ?? "",
				note: note?.textContent?.trim() ?? "",
				noteId: note?.id ?? "",
				describedBy: input?.getAttribute("aria-describedby") ?? "",
				ariaDisabled: input?.getAttribute("aria-disabled"),
				checked: input?.checked === true,
				disabled: input?.disabled === true,
				visible: row.getClientRects().length > 0,
			};
		}),
	);
}

async function toggleSwitch(label) {
	await win.evaluate((aria) => {
		const input = document.querySelector(`input[aria-label="${aria}"]`);
		if (input === null) throw new Error(`找不到开关：${aria}`);
		input.click();
	}, label);
}

await h.check("设置里能打开「通用」并看到「桌面行为」三项开关", async () => {
	await openGeneralSettings();
	await scrollToDesktopSection();
	const rows = await readRows();
	const titles = rows.map((row) => row.title);
	for (const expected of ["关闭窗口时最小化到托盘", "完成任务时通知", "开机自启"]) {
		assert.ok(titles.includes(expected), `缺少开关「${expected}」。现有：${titles.join(" / ")}`);
	}
	/* #439 第二十六轮新增「通知免打扰时段」第四行——断言放宽为 ≥3，
	   三个既有标题仍在（严格三行的时代已过，桌面行为组允许扩展）。 */
	assert.ok(rows.length >= 3, `应至少三行开关，实际 ${rows.length} 行`);
	assert.ok(
		rows.every((row) => row.visible),
		"有开关在 DOM 里但没渲染出来（getClientRects 为空）",
	);
	// 整行是 label、开关不再套一层 label；说明通过 aria-describedby 挂在控件上
	for (const row of rows) {
		assert.equal(row.tag, "LABEL", `「${row.title}」所在行应是 <label>（整行可点）`);
		assert.equal(row.nestedLabels, 0, `「${row.title}」行内嵌套了 label`);
		assert.ok(row.noteId !== "", `「${row.title}」的说明没有 id`);
		assert.equal(
			row.describedBy,
			row.noteId,
			`「${row.title}」的 aria-describedby 没有指向自己的说明`,
		);
	}
	// 默认值：关窗到托盘关、通知开、自启关（PRD 的「默认行为不变」）
	const byTitle = new Map(rows.map((row) => [row.title, row]));
	assert.equal(byTitle.get("关闭窗口时最小化到托盘").checked, false, "关窗到托盘默认应为关");
	assert.equal(byTitle.get("完成任务时通知").checked, true, "完成通知默认应为开");
	assert.equal(byTitle.get("开机自启").checked, false, "开机自启默认应为关");
	// 说明文案要能读到「关窗后程序还在跑」—— 开关本身不承担这段语义
	assert.match(byTitle.get("关闭窗口时最小化到托盘").note, /程序仍在后台运行/u);
});

await h.check("「桌面行为」亮色截图", () => h.shoot("settings-desktop-light"));

await h.check("「桌面行为」暗色截图", async () => {
	await win.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
	await h.waitForSettled();
	await h.shoot("settings-desktop-dark");
	await win.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
	await h.waitForSettled();
});

await h.check("开关可操作（本机平台支持托盘与登录项）", async () => {
	const rows = await readRows();
	const byTitle = new Map(rows.map((row) => [row.title, row]));
	if (process.platform === "darwin" || process.platform === "win32") {
		assert.equal(byTitle.get("关闭窗口时最小化到托盘").disabled, false, "支持的平台上关窗到托盘不应被禁用");
		assert.equal(byTitle.get("开机自启").disabled, false, "支持的平台上开机自启不应被禁用");
	} else {
		h.skip("开关可操作（本机平台支持托盘与登录项）", `当前平台 ${process.platform} 不在完整支持范围`);
	}
});

await h.check("打开关窗到托盘 → desktop.json 落盘且 IPC 读回同一值", async () => {
	await toggleSwitch("关闭窗口时最小化到托盘");
	await waitForPref("closeToTray", true);
	const snapshot = await win.evaluate(() => window.kami.getDesktopPrefs());
	assert.equal(snapshot.prefs.closeToTray, true, "IPC 读回的 closeToTray 与落盘值不一致");
	assert.equal(snapshot.traySupported, true, "支持的平台上 traySupported 应为 true");
});

await h.check("关窗到托盘：窗口隐藏、进程与 daemon 仍活", async () => {
	await app.evaluate(({ BrowserWindow }) => {
		const target = BrowserWindow.getAllWindows()[0];
		if (target === undefined) throw new Error("没有可关闭的窗口");
		target.close();
	});
	await waitUntil(
		() =>
			app.evaluate(({ BrowserWindow }) => {
				const target = BrowserWindow.getAllWindows()[0];
				return target !== undefined && target.isVisible() === false;
			}),
		{ timeout: 15_000, desc: "窗口被隐藏（而不是销毁）" },
	);
	// daemon 仍能应答 —— 隐藏窗口没有顺手把内核停掉
	const status = await win.evaluate(() => window.kami.daemonStatus());
	assert.equal(status.kind, "ready", `窗口隐藏后 daemon 状态是 ${JSON.stringify(status)}`);
});

await h.check("从托盘恢复窗口（模拟托盘菜单的显示动作）", async () => {
	await app.evaluate(({ BrowserWindow }) => {
		const target = BrowserWindow.getAllWindows()[0];
		if (target === undefined) throw new Error("窗口已销毁，无法恢复");
		target.show();
		target.focus();
	});
	await waitUntil(
		() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() === true),
		{ timeout: 10_000, desc: "窗口重新可见" },
	);
	await h.waitForSettled();
});

await h.check("开机自启开关调用 app.setLoginItemSettings 且值可读回", async () => {
	// 主进程里换掉登录项 API：e2e 不该真的往系统登录项里写东西。
	await app.evaluate(({ app: electronApp }) => {
		globalThis.__zwLoginState = { openAtLogin: false };
		globalThis.__zwLoginCalls = [];
		electronApp.setLoginItemSettings = (options) => {
			globalThis.__zwLoginCalls.push(options);
			globalThis.__zwLoginState.openAtLogin = options?.openAtLogin === true;
		};
		electronApp.getLoginItemSettings = () => ({ ...globalThis.__zwLoginState });
	});
	await toggleSwitch("开机自启");
	await waitForPref("launchAtLogin", true);
	const calls = await app.evaluate(() => globalThis.__zwLoginCalls);
	assert.ok(
		calls.some((options) => options?.openAtLogin === true),
		`setLoginItemSettings 没收到 openAtLogin:true，实际收到 ${JSON.stringify(calls)}`,
	);
	const readback = await app.evaluate(({ app: electronApp }) => electronApp.getLoginItemSettings());
	assert.equal(readback.openAtLogin, true, "登录项值没能读回");
});

await h.check("关闭关窗到托盘 → 落盘恢复，再关窗走回平台默认", async () => {
	await toggleSwitch("关闭窗口时最小化到托盘");
	await waitForPref("closeToTray", false);
	/*
	 * Windows / Linux 上最后一个窗口关闭会触发退出 —— 监听要**先挂上**再关窗，
	 * 否则进程退出得比注册更快时，这里会一直等到超时（假红）。macOS 关窗不退出，
	 * 走另一条断言。
	 */
	const exited = process.platform === "darwin"
		? undefined
		: new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error("关闭最后一个窗口后应用没有退出")), 15_000);
			app.once("close", () => {
				clearTimeout(timer);
				resolve();
			});
		});
	await app.evaluate(({ BrowserWindow }) => {
		for (const target of BrowserWindow.getAllWindows()) target.close();
	});
	if (process.platform === "darwin") {
		await waitUntil(
			() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length === 0),
			{ timeout: 15_000, desc: "窗口被真正关闭（不再被托盘拦下）" },
		);
		// macOS 的既有语义：关窗不退出应用，由 activate / Dock 再开。
		assert.equal(await app.evaluate(() => true), true, "macOS 关窗后应用应继续运行");
	} else {
		await exited;
	}
});

await h.finish();
