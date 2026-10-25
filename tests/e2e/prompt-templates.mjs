/**
 * 开局模板：从「设置里加一条」到「首页点一下就填进输入框」的完整闭环。
 *
 * 为什么值得一条 GUI 测试：这条链跨了四层（renderer → preload → daemon →
 * preferences.json），任何一层接错都表现为**看起来没坏**：
 *   · 只存在内存里 → 当前会话能看见，重开没了；
 *   · 写进去但读侧不认 → 首页永远不显示，设置里却列着；
 *   · 卡片能点但填错字段 → 输入框里出现的不是提示词。
 * 所以这里钉的是「写下 → 关掉设置 → 首页出现 → 点一下填进去 → 真的落盘 → 重载还在」。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const WORKSPACE_DIR = resolve(process.env.ZEROWORK_E2E_DIR ?? "/tmp", "e2e-prompt-templates");
mkdirSync(WORKSPACE_DIR, { recursive: true });
writeFileSync(resolve(WORKSPACE_DIR, "README.md"), "# prompt templates\n", "utf8");

const TITLE = "整理会议纪要为待办";
const PROMPT = "把下面这段会议纪要整理成待办清单，每条标注负责人与截止时间。";
const TITLE_EDITED = "会议纪要 → 待办";

const h = createHarness({ name: "prompt-templates", shots: true });
await h.launch();
const win = h.window();

const sectionText = (label) =>
	win.evaluate((text) => {
		const section = [...document.querySelectorAll(".settings-section")].find((node) => node.querySelector("h2")?.textContent.trim() === text);
		return section === undefined ? null : section.textContent;
	}, label);

async function openSettings() {
	await win.evaluate(() => document.querySelector('[aria-label="设置"]').click());
	await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") !== null), { timeout: 30_000, desc: "设置对话框打开" });
	const hasGeneral = await win.evaluate(() => [...document.querySelectorAll(".settings-nav-item")].some((n) => n.textContent.trim() === "通用"));
	if (hasGeneral) {
		await win.evaluate(() => {
			const item = [...document.querySelectorAll(".settings-nav-item")].find((node) => node.textContent.trim() === "通用");
			item?.click();
		});
	}
	await waitUntil(() => sectionText("开局模板"), { timeout: 20_000, desc: "通用页里的「开局模板」分组" });
}

async function closeSettings() {
	await win.evaluate(() => document.querySelector('[aria-label="关闭设置"]').click());
	await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") === null), { timeout: 15_000, desc: "设置对话框关闭" });
}

async function pickTheme(label) {
	// 等 SelectField 真渲染出来（它的出现依赖 getThemePreference 的 IPC 回包）。
	await waitUntil(() => win.evaluate(() => document.querySelector('[aria-label="外观"]') !== null), {
		timeout: 15_000,
		desc: "「外观」选择器渲染（IPC 回包后）"
	});
	await win.evaluate(() => document.querySelector('[aria-label="外观"]').click());
	await waitUntil(() => win.evaluate(() => document.querySelector('[role="listbox"]') !== null), { timeout: 10_000, desc: "外观下拉展开" });
	await win.evaluate((target) => {
		const listbox = document.querySelector('[role="listbox"]');
		const options = [...listbox.querySelectorAll('[role="option"]')];
		const hit = options.find((el) => (el.textContent ?? "").includes(target));
		if (hit === undefined) throw new Error(`外观下拉里没有「${target}」，现有：${options.map((el) => el.textContent).join(" / ")}`);
		hit.click();
	}, label);
	await waitUntil(
		() => win.evaluate(() => document.documentElement.getAttribute("data-theme") === "dark"),
		{ timeout: 15_000, desc: "切到暗色" }
	);
}

const homeBadges = () =>
	win.evaluate(() => [...document.querySelectorAll(".case-card-starter")].map((node) => node.querySelector(".case-title")?.textContent.trim() ?? ""));

await h.check("干净配置下首页与没有这个功能时一模一样（没有「我的」徽标）", async () => {
	const badges = await homeBadges();
	assert.deepEqual(badges, [], "干净配置下不该出现自定义模板卡片");
	const header = await win.evaluate(() => document.querySelector(".cases-header span")?.textContent.trim() ?? "");
	assert.equal(header, "不知道做什么，试试最佳实践案例", "案例区标题应保持原样");
});

await h.check("设置 → 通用 里有「开局模板」分组，空列表给的是可读空态", async () => {
	await openSettings();
	assert.equal(await win.evaluate(() => document.querySelectorAll(".starter-empty").length), 1, "空列表要有空态文案，不是一片空白");
	await h.shoot("settings-starter-empty-light");
});

await h.check("标题留空点保存 → 行内报错，且不写入", async () => {
	await win.evaluate(() => document.querySelector(".starter-add").click());
	await waitUntil(() => win.evaluate(() => document.querySelector(".starter-editor") !== null), { timeout: 10_000, desc: "编辑区展开" });
	await win.evaluate(() => {
		const button = [...document.querySelectorAll(".starter-editor-actions button")].find((node) => node.textContent.trim() === "保存模板");
		button.click();
	});
	const error = await waitUntil(
		() => win.evaluate(() => document.querySelector(".starter-error")?.textContent.trim() ?? null),
		{ timeout: 10_000, desc: "行内错误" }
	);
	assert.match(error, /标题不能为空/);
	assert.equal(await win.evaluate(() => document.querySelectorAll(".starter-row").length), 0, "校验失败不得出现新行");
});

await h.check("填好标题与提示词并保存 → 列表出现一行", async () => {
	await win.evaluate(({ title, prompt }) => {
		const input = document.querySelector(".starter-input");
		const textarea = document.querySelector(".starter-textarea");
		const setValue = (node, value) => {
			const proto = node instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
			Object.getOwnPropertyDescriptor(proto, "value").set.call(node, value);
			node.dispatchEvent(new window.Event("input", { bubbles: true }));
		};
		setValue(input, title);
		setValue(textarea, prompt);
	}, { title: TITLE, prompt: PROMPT });
	await win.evaluate(() => {
		const button = [...document.querySelectorAll(".starter-editor-actions button")].find((node) => node.textContent.trim() === "保存模板");
		button.click();
	});
	await waitUntil(() => win.evaluate(() => document.querySelectorAll(".starter-row").length === 1), { timeout: 15_000, desc: "模板行出现" });
	const row = await win.evaluate(() => {
		const node = document.querySelector(".starter-row");
		return { title: node.querySelector(".starter-row-title")?.textContent.trim(), prompt: node.querySelector(".starter-row-prompt")?.textContent.trim() };
	});
	assert.equal(row.title, TITLE);
	assert.equal(row.prompt, PROMPT);
	await h.shoot("settings-starter-row-light");
});

await h.check("关掉设置后首页出现「我的」卡片，且排在内置案例之前", async () => {
	await closeSettings();
	await h.waitForSettled();
	const cards = await win.evaluate(() => [...document.querySelectorAll(".case-grid .case-card")].map((node) => ({
		badge: node.querySelector(".case-badge")?.textContent.trim() ?? null,
		title: node.querySelector(".case-title")?.textContent.trim() ?? ""
	})));
	assert.equal(cards.length > 0, true, "案例区应有卡片");
	assert.equal(cards[0].badge, "我的", "自定义模板必须排在第一张");
	assert.equal(cards[0].title, TITLE);
	await h.shoot("home-starter-card-light");
});

await h.check("点这张卡 → 提示词被原样填进输入框", async () => {
	await win.evaluate(() => document.querySelector(".case-card-starter").click());
	await waitUntil(
		() => win.evaluate((prompt) => document.querySelector('[aria-label="消息输入框"]')?.value === prompt, PROMPT),
		{ timeout: 15_000, desc: "输入框被填入模板提示词" }
	);
});

await h.check("模板真的落盘到 preferences.json（不是只活在内存里）", async () => {
	const file = resolve(h.CONFIG_DIR, "preferences.json");
	assert.equal(existsSync(file), true, "偏好文件应已创建");
	const parsed = JSON.parse(readFileSync(file, "utf8"));
	assert.equal(Array.isArray(parsed.starterPrompts), true, "preferences.json 里应有 starterPrompts 数组");
	assert.equal(parsed.starterPrompts.length, 1);
	assert.equal(parsed.starterPrompts[0].title, TITLE);
	assert.equal(parsed.starterPrompts[0].prompt, PROMPT);
	assert.match(parsed.starterPrompts[0].id, /^tpl-[a-z0-9]{4,32}$/);
});

await h.check("重载界面后模板还在（读侧认得写侧写下的东西）", async () => {
	await win.reload();
	await waitUntil(() => win.evaluate(() => (document.getElementById("root")?.childElementCount ?? 0) > 0), { timeout: 60_000, desc: "React 重新挂载" });
	await h.waitForSettled();
	const badges = await homeBadges();
	assert.deepEqual(badges, [TITLE], "重载后首页应仍有这张卡");
});

await h.check("编辑标题 → 列表与首页同步更新", async () => {
	await openSettings();
	await win.evaluate(() => {
		const button = [...document.querySelectorAll(".starter-action")].find((node) => node.textContent.trim() === "编辑");
		button.click();
	});
	await waitUntil(() => win.evaluate(() => document.querySelector(".starter-input") !== null), { timeout: 10_000, desc: "编辑区展开" });
	await win.evaluate((title) => {
		const input = document.querySelector(".starter-input");
		Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, title);
		input.dispatchEvent(new window.Event("input", { bubbles: true }));
	}, TITLE_EDITED);
	await win.evaluate(() => {
		const button = [...document.querySelectorAll(".starter-editor-actions button")].find((node) => node.textContent.trim() === "保存模板");
		button.click();
	});
	await waitUntil(
		() => win.evaluate((title) => document.querySelector(".starter-row-title")?.textContent.trim() === title, TITLE_EDITED),
		{ timeout: 15_000, desc: "列表里的标题被更新" }
	);
	assert.equal(await win.evaluate(() => document.querySelectorAll(".starter-row").length), 1, "编辑不得变成新增");
	await closeSettings();
	await h.waitForSettled();
	assert.deepEqual(await homeBadges(), [TITLE_EDITED]);
});

await h.check("暗色下卡片与列表都可读", async () => {
	await openSettings();
	await pickTheme("深色");
	await h.waitForSettled();
	await h.shoot("settings-starter-row-dark");
	await closeSettings();
	await h.waitForSettled();
	await h.shoot("home-starter-card-dark");
});

await h.check("删除最后一条 → 列表回到空态、首页徽标消失", async () => {
	await openSettings();
	await win.evaluate(() => {
		const button = [...document.querySelectorAll(".starter-action")].find((node) => node.textContent.trim() === "删除");
		if (button === undefined) throw new Error("行上没有「删除」按钮");
		button.click();
	});
	// 删除是二次确认的：先点「删除」，确认行出现后点「确认删除」。
	// 这一条同时守住了「误点一下就把用户写的东西删掉」这个回归。
	const confirmButton = [...await win.locator(".starter-confirm .starter-action-danger").all()][0];
	if (confirmButton === undefined) throw new Error("点「删除」后没有出现确认按钮");
	await confirmButton.click();
	await waitUntil(() => win.evaluate(() => document.querySelectorAll(".starter-row").length === 0), { timeout: 15_000, desc: "行被删除" });
	assert.equal(await win.evaluate(() => document.querySelectorAll(".starter-empty").length), 1, "删空后回到空态");
	await closeSettings();
	await h.waitForSettled();
	assert.deepEqual(await homeBadges(), [], "首页不该再有自定义卡片");
	const parsed = JSON.parse(readFileSync(resolve(h.CONFIG_DIR, "preferences.json"), "utf8"));
	assert.deepEqual(parsed.starterPrompts ?? [], [], "删空后偏好文件里也应清掉（不是留下一条残影）");
});

await h.finish();
