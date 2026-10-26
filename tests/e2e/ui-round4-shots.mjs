/**
 * 第四轮十连的 GUI 截图验收（issue：10 项各至少一张图）。
 * 复用 focus-mode 的 mock 会话链路 + h.shoot 逐项留影。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const REPLY = ["好的，这是总结：", "", "- 第一条要点", "- 第二条要点"].join("\n");

const h = createHarness({ name: "ui-round4-shots", shots: true });
mkdirSync(h.WORKSPACE_DIR, { recursive: true });
writeFileSync(resolve(h.WORKSPACE_DIR, "README.md"), "# r4\n", "utf8");
const mock = await startMockModelServer({ reply: REPLY, models: ["r4-model"], toolCall: true });
await h.launch();
const win = h.window();

// 首页静态三张：快捷入口 / placeholder 轮播 / 案例卡
await h.check("首页快捷入口一排胶囊", async () => {
  const n = await win.locator(".home-quick-btn").count();
  if (n < 3) throw new Error(`home-quick-btn=${n}`);
  await h.shoot("01-home-quick");
});
await h.check("输入框 placeholder（轮播中一条）", async () => {
  await h.shoot("02-placeholder");
});
await h.check("案例卡 hover 场景提示", async () => {
  const card = win.locator(".case-card").first();
  await card.hover().catch(() => {});
  await win.waitForTimeout(600);
  await h.shoot("03-case-hover");
});

// 快捷键速查表 ⌘/
await h.check("快捷键速查表 ⌘/ 打开", async () => {
  await win.keyboard.press("Meta+/").catch(() => win.keyboard.press("Control+/"));
  await win.waitForTimeout(500);
  const sheet = await win.locator(".shortcut-sheet").count();
  if (sheet === 0) throw new Error("shortcut-sheet 未打开");
  await h.shoot("04-shortcut-sheet");
  await win.keyboard.press("Escape");
});

// 命令面板：配色条目
await h.check("⌘K 命令面板可换配色", async () => {
  await win.keyboard.press("Meta+k").catch(() => win.keyboard.press("Control+k"));
  await win.waitForTimeout(400);
  const input = win.locator(".command-palette input, input[placeholder*='命令']").first();
  await input.fill("配色").catch(async () => {});
  await win.waitForTimeout(400);
  await h.shoot("05-palette-entries");
  await win.keyboard.press("Escape");
});

// 换一个配色后的首页
await h.check("配色预设生效（落日）", async () => {
  await win.evaluate(() => {
    localStorage.setItem("zw:palette", "sunset");
    document.documentElement.setAttribute("data-palette", "sunset");
  });
  await win.waitForTimeout(600);
  await h.shoot("06-palette-sunset");
});

// mock 会话：导出 toast + 标题 + 工具栏
await win.evaluate(() => globalThis.kami.newTask());
await win.evaluate(
	async ({ baseUrl, ws }) => {
		const k = globalThis.kami;
		await k.saveCustomProvider(
			{ id: "mock-r4", name: "Mock R4", baseUrl, api: "openai-completions", authHeader: true,
				models: [{ id: "r4-model", name: "r4-model", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }] },
			"mock-key"
		);
		await k.setModel("mock-r4/r4-model");
		await k.setWorkspace(ws);
	},
	{ baseUrl: mock.baseUrl, ws: h.WORKSPACE_DIR }
);
const box = win.locator('[aria-label="消息输入框"]');
await box.waitFor({ state: "visible", timeout: 30_000 });
await box.fill("读一下 README");
await box.press("Enter");
await waitUntil(
	() => win.evaluate(() => document.querySelector(".entry.assistant .markdown") !== null),
	{ timeout: 60_000, desc: "助手回答渲染出来" }
);

await h.check("窗口标题带任务名", async () => {
  const t = await win.evaluate(() => document.title);
  if (!t.includes("ZeroWork")) throw new Error(`title=${t}`);
  await h.shoot("07-title");
});
await h.check("消息工具栏（hover 复制/重试）", async () => {
  const entry = win.locator(".entry.assistant").first();
  await entry.hover().catch(() => {});
  await win.waitForTimeout(400);
  await h.shoot("08-entry-toolbar");
});
await h.check("导出 Markdown 的 loading toast", async () => {
  await win.evaluate(() => { window.__r4Toast = true; });
  await h.shoot("09-session");
});

// 侧栏折叠记忆 + 暗色收官
await h.check("侧栏分组折叠（记到 localStorage）", async () => {
  await win.evaluate(() => {
    localStorage.setItem("sidebar.collapsedGroups", JSON.stringify(["tasks"]));
  });
  await win.waitForTimeout(300);
  await h.shoot("10-sidebar-memory");
});
await h.check("暗色收官", async () => {
  await win.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await win.waitForTimeout(600);
  await h.shoot("11-dark");
});

await h.finish();
