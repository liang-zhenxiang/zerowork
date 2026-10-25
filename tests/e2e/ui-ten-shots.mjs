/**
 * 十个视觉功能的截图采集（只截图，不判定；判定在 ui-ten.mjs 里）。
 * 每一步失败都记一条错误并继续 —— 目的是「尽量把能看的都拍下来」，
 * 而不是让第一个导航失败毁掉后面九张。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const WORKSPACE_DIR = resolve(process.env.ZEROWORK_E2E_DIR ?? "/tmp", "e2e-ui-ten-shots");
mkdirSync(WORKSPACE_DIR, { recursive: true });
writeFileSync(resolve(WORKSPACE_DIR, "README.md"), "# ui ten\n", "utf8");

const CODE = Array.from({ length: 22 }, (_, i) => `.line-${i + 1} { padding: var(--space-${(i % 4) + 1}); }`).join("\n");
const REPLY = ["## 输入卡外槽的样式", "", "```css", CODE, "```", "", "行号由 CodeBlockCard 自己算，界面里不存第二份。", ""].join("\n");

const h = createHarness({ name: "ui-ten-shots", shots: true });
await h.launch();
const win = h.window();
const failures = [];

async function step(label, fn) {
	try {
		await fn();
	} catch (error) {
		failures.push(`${label}: ${error.message}`);
	}
}

const clickByText = (text) =>
	win.evaluate((wanted) => {
		const nodes = [...document.querySelectorAll("button, .nav-item, .settings-nav-item, [role='button'], a")];
		const node = nodes.find((n) => n.textContent.trim() === wanted);
		if (node === undefined) throw new Error(`找不到「${wanted}」`);
		node.click();
	}, text);

const openSettings = async () => {
	await win.evaluate(() => document.querySelector('[aria-label="设置"]')?.click());
	await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") !== null), { timeout: 30_000, desc: "设置打开" });
};
const closeSettings = async () => {
	await win.keyboard.press("Escape");
	await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") === null), { timeout: 20_000, desc: "设置关闭" });
};

await waitUntil(() => win.evaluate(() => document.querySelector(".home") !== null), { timeout: 40_000, desc: "首页" });
await h.waitForSettled();

await step("01 首页浅色", async () => {
	await h.shoot("01-home-light");
});

await step("02/03 主题预设", async () => {
	await openSettings();
	await clickByText("通用");
	await waitUntil(() => win.evaluate(() => document.querySelectorAll("[data-palette-id]").length >= 5), { timeout: 20_000, desc: "预设卡" });
	await h.waitForSettled();
	await h.shoot("02-settings-palette");
	await win.evaluate(() => document.querySelector('[data-palette-id="dusk"]')?.click());
	await h.waitForSettled();
	await h.shoot("03-palette-dusk-settings");
});

await step("04 暮光下的首页", async () => {
	await closeSettings();
	await h.waitForSettled();
	await h.shoot("04-home-dusk");
	await openSettings();
	await win.evaluate(() => document.querySelector('[data-palette-id="aurora"]')?.click());
	await closeSettings();
});

await step("05 命令面板", async () => {
	await win.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
	await waitUntil(() => win.evaluate(() => document.querySelector(".command-palette") !== null), { timeout: 20_000, desc: "面板" });
	await h.waitForSettled();
	await h.shoot("05-command-palette");
	await win.keyboard.press("Escape");
});

await step("07 空态插画", async () => {
	await openSettings();
	await clickByText("模型");
	await waitUntil(() => win.evaluate(() => document.querySelector(".state-art") !== null), { timeout: 25_000, desc: "插画" });
	await h.waitForSettled();
	await h.shoot("07-empty-art");
	await closeSettings();
});

await step("08 代码块行号", async () => {
	const mock = await startMockModelServer({ reply: REPLY, models: ["ui-ten-model"], delayMs: 20 });
	await win.evaluate(
		async ({ baseUrl, workspace }) => {
			const k = globalThis.kami;
			await k.saveCustomProvider(
				{
					id: "mock-ui-ten",
					name: "UI Ten",
					baseUrl,
					api: "openai-completions",
					authHeader: true,
					models: [{ id: "ui-ten-model", name: "ui-ten-model", contextWindow: 200000, maxTokens: 4096 }]
				},
				"sk-e2e-dummy"
			);
			await k.setWorkspace(workspace);
			await k.setModel("mock-ui-ten/ui-ten-model");
		},
		{ baseUrl: mock.baseUrl, workspace: WORKSPACE_DIR }
	);
	await win.evaluate(() => globalThis.kami.newTask());
	const box = win.locator('[aria-label="消息输入框"]');
	await box.waitFor({ state: "visible", timeout: 30_000 });
	await box.fill("给我看下输入卡外槽的样式");
	await box.press("Enter");
	await waitUntil(() => win.evaluate(() => document.querySelector(".code-gutter") !== null), { timeout: 90_000, desc: "代码块" });
	await h.waitForSettled();
	await h.shoot("08-code-block");
	await mock.close();
});

await step("06 统计", async () => {
	await win.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
	await waitUntil(() => win.evaluate(() => document.querySelector(".command-palette") !== null), { timeout: 20_000, desc: "面板" });
	await win.keyboard.type("统计");
	await win.keyboard.press("Enter");
	await waitUntil(() => win.evaluate(() => document.querySelector(".stat-value") !== null), { timeout: 30_000, desc: "统计数字" });
	await h.waitForSettled();
	await h.shoot("06-stats");
	await clickByText("新建任务");
	await waitUntil(() => win.evaluate(() => document.querySelector(".home") !== null), { timeout: 30_000, desc: "回首页" });
});

await step("09 暗色首页", async () => {
	await win.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
	await waitUntil(() => win.evaluate(() => document.querySelector(".command-palette") !== null), { timeout: 20_000, desc: "面板" });
	await win.keyboard.type("深色");
	await win.keyboard.press("Enter");
	await waitUntil(() => win.evaluate(() => document.documentElement.getAttribute("data-theme") === "dark"), { timeout: 20_000, desc: "暗色" });
	await win.keyboard.press("Escape");
	await clickByText("新建任务");
	await waitUntil(() => win.evaluate(() => document.querySelector(".home") !== null), { timeout: 30_000, desc: "暗色首页" });
	await h.waitForSettled();
	await h.shoot("09-home-dark");
});

await step("10 设置阅读进度", async () => {
	await openSettings();
	await clickByText("通用");
	await win.evaluate(() => {
		const body = document.querySelector(".settings-body") ?? document.querySelector(".settings-card");
		body.scrollTop = Math.round(body.scrollHeight * 0.55);
	});
	await h.waitForSettled();
	await h.shoot("10-settings-progress");
	await closeSettings();
});

await h.finish();
if (failures.length > 0) {
	console.log("\n未完成的步骤：");
	for (const line of failures) console.log(` - ${line}`);
}
