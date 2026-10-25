/**
 * 会话过程可见性（issue #274）的 GUI 验证 + 截图。
 * 完全复刻 focus-mode.mjs 的可用链路：mock.baseUrl（带 /v1）、
 * saveCustomProvider → setModel → setWorkspace，用 aria-label 消息框发消息。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const REPLY = [
	"## 开始",
	"",
	"先读文件：",
	"",
	"```js",
	"const a = 1;",
	"console.log(a);",
	"```",
	"",
	"| 步骤 | 状态 |",
	"| --- | --- |",
	"| 读取 | 完成 |",
].join("\n");

const h = createHarness({ name: "session-visibility", shots: true });
mkdirSync(h.WORKSPACE_DIR, { recursive: true });
writeFileSync(resolve(h.WORKSPACE_DIR, "README.md"), "# visibility\n", "utf8");
/* toolCall: true —— mock 先回一个工具调用（ls）再回文本，
   这样 turn 的 trace 才有 segments，活动侧栏才有东西可列。 */
const mock = await startMockModelServer({ reply: REPLY, models: ["vis-model"], toolCall: true });
await h.launch();
const win = h.window();

// 建会话 + 配 provider（照抄 focus-mode 的可用序列）
await win.evaluate(() => globalThis.kami.newTask());
await win.evaluate(
	async ({ baseUrl, ws }) => {
		const k = globalThis.kami;
		await k.saveCustomProvider(
			{
				id: "mock-vis",
				name: "Mock Vis",
				baseUrl,
				api: "openai-completions",
				authHeader: true,
				models: [
					{ id: "vis-model", name: "vis-model", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }
				]
			},
			"mock-key"
		);
		await k.setModel("mock-vis/vis-model");
		await k.setWorkspace(ws);
	},
	{ baseUrl: mock.baseUrl, ws: h.WORKSPACE_DIR }
);
const box = win.locator('[aria-label="消息输入框"]');
await box.waitFor({ state: "visible", timeout: 30_000 });
await box.fill("帮我读一下 README 并总结");
await box.press("Enter");
await waitUntil(
	() => win.evaluate(() => document.querySelector(".entry.assistant .markdown") !== null),
	{ timeout: 60_000, desc: "助手回答渲染出来" }
);
await win.waitForTimeout(800);

await h.check("活动侧栏在会话页渲染（有工具轨迹时）", async () => {
	const railItems = await win.locator(".activity-rail .rail-item").count();
	if (railItems === 0) throw new Error("rail-item 数为 0 —— 活动侧栏没渲染");
	await h.shoot("01-activity-rail");
});

await h.check("用户消息带 hover 时间戳节点", async () => {
	const times = await win.locator(".entry-time").count();
	if (times === 0) throw new Error("entry-time 数为 0");
	await h.shoot("02-entry-time");
});

await h.check("滚离底部后出现回到最新按钮", async () => {
	/* scrollTop=0 不够：内容不够高时 scrollHeight-scrollTop-clientHeight < 40
	   仍算 atBottom。先确认内容真的可滚（先截一张基线），再滚到顶。 */
	const scrollable = await win.evaluate(() => {
		const s = document.querySelector(".stream");
		return s ? s.scrollHeight - s.clientHeight : -1;
	});
	console.log(`stream scrollable=${scrollable}px`);
	if (scrollable <= 0) {
		/* 单轮会话内容不满一屏：多问两轮把内容撑高 */
		const box2 = win.locator('[aria-label="消息输入框"]');
		for (const q of ["再总结一次，多写几段", "把每一段展开成小节"]) {
			await box2.fill(q);
			await box2.press("Enter");
			await win.waitForTimeout(4000);
		}
	}
	await win.evaluate(() => {
		const s = document.querySelector(".stream");
		if (s) {
			s.scrollTop = 0;
			/* React 的 onScroll 挂在元素上，程序设 scrollTop 也会触发；
			   但轮询时序上保险起见手动补一个（对真实用户无影响）。 */
			s.dispatchEvent(new window.Event("scroll", { bubbles: false }));
		}
	});
	await win.waitForTimeout(600);
	const btn = await win.locator(".jump-to-bottom").count();
	if (btn === 0) throw new Error("jump-to-bottom 未出现");
	await h.shoot("03-jump-bottom");
});

await h.check("暗色下侧栏与时间戳正常", async () => {
	await win.evaluate(() => {
		document.documentElement.setAttribute("data-theme", "dark");
	});
	await win.waitForTimeout(600);
	await h.shoot("04-dark");
});

await h.finish();
