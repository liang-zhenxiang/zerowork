// 第二十四轮截图：4 张（上下文占比条 / 斜杠面板 / 帮助浮层斜杠命令 / 复制全文）
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const h = createHarness({ name: "ui-round24-shots", shots: true });
const REPLY = "第二十四轮上下文效率验证回复。\n\n第二段。\n\n收尾段。";
const mock = await startMockModelServer({ models: [{ id: "r24-model", name: "r24-model", reasoning: false, vision: false, contextWindow: 8000, maxTokens: 8192 }], reply: REPLY });
const SESSIONS_DIR = join(h.CONFIG_DIR, "sessions");
mkdirSync(SESSIONS_DIR, { recursive: true });
const tmp = join(h.WORKSPACE_DIR, "临时任务", "2026-11-16-02-00-00");
// 种子：30 轮会话（让 chars 粗估在 8K 窗口下占比可见）
const id = "aaaaaaaa-3333-4aaa-8aaa-aaaaaaaaaaa1";
const t = new Date().toISOString();
const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: t, cwd: tmp, title: "上下文占比验证" })];
for (let i2 = 0; i2 < 30; i2++) {
  const role = i2 % 2 === 0 ? "user" : "assistant";
  const TITLE = "上下文占比验证";
  const text2 = i2 === 0 ? TITLE : `第 ${i2} 轮回复，填充内容使其在 8K 窗口下占比可观测。`.repeat(30);
  lines.push(JSON.stringify({ type: "message", id: `${id}-m${i2}`, parentId: i2 === 0 ? id : `${id}-m${i2-1}`, timestamp: t, message: { role, content: [{ type: "text", text: text2 }] }, ...(role === "assistant" ? { model: "r24-model", usage: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0, totalTokens: 300, cost: 0.001 } } : {}) }));
}
writeFileSync(join(SESSIONS_DIR, "s1.jsonl"), lines.join("\n") + "\n");

await h.launch();
const win = h.window();
await win.waitForTimeout(2200);
await win.evaluate(async ({ baseUrl, ws }) => {
  const k = globalThis.kami;
  await k.saveCustomProvider({ id: "r24p", name: "R24", baseUrl, api: "openai-completions", authHeader: true, models: [{ id: "r24-model", name: "r24-model", reasoning: false, vision: false, contextWindow: 8000, maxTokens: 8192 }] }, "k");
  await k.setModel("r24p/r24-model");
  await k.setWorkspace(ws);
}, { baseUrl: mock.baseUrl, ws: h.WORKSPACE_DIR });

await h.check("① 上下文占比条出现（>80% 警示色）", async () => {
  await win.evaluate(() => {
    const row = [...document.querySelectorAll(".sidebar .task-item")].find((el) => (el.textContent ?? "").includes("上下文占比验证"));
    row?.querySelector(".task-item-body")?.click();
  });
  await waitUntil(() => win.evaluate(() => document.querySelector(".chat") !== null), { timeout: 15000, desc: "进入会话页" });
  await win.waitForTimeout(800);
  const meter = await win.evaluate(() => {
    const m = document.querySelector(".ctx-meter");
    return m === null ? null : { pct: (m.querySelector(".ctx-meter-label")?.textContent ?? ""), warn: m.classList.contains("ctx-meter-warn") };
  });
  if (meter === null) throw new Error("占比条未出现");
  if (meter.pct === "0%") throw new Error("占比 0%（会话内容未被统计）");
  await h.shoot("01-ctx-meter");
});

await h.check("② 斜杠命令面板：/ 触发 + 选中执行", async () => {
  const ta = win.locator('[aria-label="消息输入框"]');
  await ta.fill("/");
  await win.waitForTimeout(400);
  const items = await win.evaluate(() => [...document.querySelectorAll(".slash-menu-item")].map((el) => (el.querySelector(".slash-menu-cmd")?.textContent ?? "")));
  if (!items.includes("/help")) throw new Error(`斜杠面板缺 /help：${JSON.stringify(items)}`);
  await h.shoot("02-slash-menu");
  // 点 /stats 执行
  await win.evaluate(() => {
    const item = [...document.querySelectorAll(".slash-menu-item")].find((el) => (el.querySelector(".slash-menu-cmd")?.textContent ?? "") === "/stats");
    item?.click();
  });
  await win.waitForTimeout(800);
  const statsOpen = await win.evaluate(() => (document.body.innerText ?? "").includes("使用统计"));
  if (!statsOpen) throw new Error("/stats 未打开统计页");
  await win.evaluate(() => {
    const back = [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "返回");
    back?.click();
  });
  await win.waitForTimeout(500);
});

await h.check("③ 帮助浮层含斜杠命令组", async () => {
  await win.keyboard.press("Meta+k");
  await win.waitForTimeout(400);
  await win.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("快捷键"));
    btn?.click();
  });
  await win.waitForTimeout(600);
  await waitUntil(() => win.evaluate(() => (document.body.innerText ?? "").includes("斜杠命令")), { timeout: 8000, desc: "斜杠命令组出现" });
  await h.shoot("03-help-slash");
  await win.keyboard.press("Escape");
  await win.waitForTimeout(300);
});

await h.check("④ 提示词预览复制全文按钮", async () => {
  await win.keyboard.press("Meta+k");
  await win.waitForTimeout(400);
  await win.keyboard.type("提示词预览");
  await win.waitForTimeout(600);
  await win.keyboard.press("Enter");
  await win.waitForTimeout(900);
  await waitUntil(() => win.evaluate(() => [...document.querySelectorAll(".mini-btn")].some((b) => (b.textContent ?? "").includes("复制全文"))), { timeout: 10000, desc: "复制全文按钮出现" });
  await h.shoot("04-preview-copy");
});

await h.finish();
mock.close().catch(() => {});
