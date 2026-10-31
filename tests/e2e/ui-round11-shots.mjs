// 第十一轮十连截图（#312）：长会话可读性与掌控。每项至少一张。
// 手法沿用 probe-r11 系列（全功能复检已过的链路）。
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const h = createHarness({ name: "ui-round11-shots" });
const OUT = "artifacts/ui-round11-shots";
mkdirSync(OUT, { recursive: true });
const LONG = Array.from({ length: 72 }, (_, i) => (i === 2 ? "## 第二节标题" : `第 ${i + 1} 行：这里是超长回答的填充内容，用来撑出滚动与折叠。`)).join("\n");
const mock = await startMockModelServer({ models: ["r11"], reply: LONG });
let failures = 0;
const shot = async (win, name) => { await win.screenshot({ path: join(OUT, name) }); console.log(`  [SHOT] ${name}`); };

await h.launch();
const win = h.window();
await win.waitForTimeout(900);
await win.evaluate(async ({ baseUrl, ws }) => {
  const k = globalThis.kami;
  await k.saveCustomProvider({ id: "r11p", name: "R11", baseUrl, api: "openai-completions", authHeader: true, models: [{ id: "r11", name: "r11", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }] }, "mock-key");
  await k.setModel("r11p/r11");
  await k.setWorkspace(ws);
  await k.newTask();
}, { baseUrl: mock.baseUrl, ws: h.WORKSPACE_DIR });

// ④⑤ 超长回答折叠 + 阅读时间
const composer = win.locator('[aria-label="消息输入框"]');
await composer.fill("写一份长报告");
await composer.press("Enter");
try {
  await waitUntil(() => win.evaluate(() => document.querySelector(".answer-fold") !== null), { timeout: 30000, desc: "折叠条出现" });
  await win.waitForTimeout(400);
  await shot(win, "04-long-answer-fold.png");
} catch (e) { failures++; console.log("  [FAIL] ④⑤", e.message.slice(0, 120)); }

// ① 会话大纲（⌘P）
try {
  await win.keyboard.press("Meta+p");
  await waitUntil(() => win.evaluate(() => document.querySelector(".outline-sheet") !== null), { timeout: 6000, desc: "大纲浮层" });
  await win.waitForTimeout(300);
  await shot(win, "01-outline.png");
  await win.evaluate(() => document.querySelector(".outline-item")?.click());
  await waitUntil(() => win.evaluate(() => document.querySelector(".outline-sheet") === null), { timeout: 5000, desc: "选后关闭" });
} catch (e) { failures++; console.log("  [FAIL] ①", e.message.slice(0, 120)); }

// ⑥ 标题锚点（先展开全文）
try {
  await win.evaluate(() => document.querySelector(".answer-fold-toggle")?.click());
  await waitUntil(() => win.evaluate(() => document.querySelector(".markdown h2 .heading-anchor") !== null), { timeout: 8000, desc: "锚点出现" });
  await win.evaluate(() => { const el = document.querySelector(".markdown h2"); el?.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true })); });
  await win.waitForTimeout(300);
  await shot(win, "06-heading-anchor.png");
  await win.evaluate(() => document.querySelector(".markdown h2 .heading-anchor")?.click());
  await waitUntil(() => win.evaluate(() => [...document.querySelectorAll(".toast-text")].some((el) => (el.textContent ?? "").includes("标题链接"))), { timeout: 5000, desc: "复制 toast" });
} catch (e) { failures++; console.log("  [FAIL] ⑥", e.message.slice(0, 120)); }

// ③ 会话内查找（工具条，turnViews>=2 才出现 —— 补一轮）
try {
  await composer.fill("再来一轮");
  await composer.press("Enter");
  await waitUntil(() => win.evaluate(() => document.querySelectorAll(".entry.assistant").length >= 2), { timeout: 30000, desc: "第二轮" });
  await win.waitForTimeout(600);
  await win.evaluate(() => document.querySelector(".chat-find-input")?.focus());
  await win.keyboard.type("填充内容");
  await waitUntil(() => win.evaluate(() => document.querySelectorAll("mark.find-hit").length > 0), { timeout: 8000, desc: "查找高亮" });
  await win.waitForTimeout(300);
  await shot(win, "03-find-highlight.png");
} catch (e) { failures++; console.log("  [FAIL] ③", e.message.slice(0, 120)); }

// ② 折叠全部/展开全部
try {
  await win.evaluate(() => [...document.querySelectorAll(".chat-tool-btn")].find((b) => b.textContent === "折叠全部")?.click());
  await waitUntil(() => win.evaluate(() => document.querySelectorAll(".turn-folded-mark, [data-folded]").length > 0 || document.querySelector(".turn-trace") === null), { timeout: 6000, desc: "折叠生效" });
  await win.waitForTimeout(300);
  await shot(win, "02-collapse-all.png");
  await win.evaluate(() => [...document.querySelectorAll(".chat-tool-btn")].find((b) => b.textContent === "展开全部")?.click());
} catch (e) { failures++; console.log("  [FAIL] ②", e.message.slice(0, 120)); }

// ⑨ 字号调节
try {
  await win.evaluate(() => document.querySelector('[aria-label="放大会话字号"]')?.click());
  await win.evaluate(() => document.querySelector('[aria-label="放大会话字号"]')?.click());
  await waitUntil(() => win.evaluate(() => document.querySelector(".chat").style.getPropertyValue("--chat-font-size") === "16px"), { timeout: 5000, desc: "字号 16px" });
  await shot(win, "09-font-size.png");
} catch (e) { failures++; console.log("  [FAIL] ⑨", e.message.slice(0, 120)); }

// ⑦ 打印样式（CDP emulate print media + 截图）
try {
  const client = await win.context().newCDPSession(win);
  await client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await client.send("Emulation.setEmulatedMedia", { media: "print" });
  await win.waitForTimeout(500);
  await shot(win, "07-print-preview.png");
  await client.send("Emulation.setEmulatedMedia", { media: "screen" });
} catch (e) { failures++; console.log("  [FAIL] ⑦", e.message.slice(0, 120)); }

console.log(`\n完成：${7 - failures} 类成功，${failures} 类失败`);
await h.finish();
mock.close();
