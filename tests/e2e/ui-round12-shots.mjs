// 第十二轮十连截图（#315）：导出与复用。每项至少一张。
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const h = createHarness({ name: "ui-round12-shots" });
const OUT = "artifacts/ui-round12-shots";
mkdirSync(OUT, { recursive: true });
const REPLY = [
  "第十二轮导出与复用验证。",
  "",
  "## 第一节 演示表格",
  "",
  "| 功能 | 状态 |",
  "| --- | --- |",
  "| 表格复制 CSV | 已实现 |",
  "| 代码块存文件 | 已实现 |",
  "",
  "```js",
  "// 存为文件演示",
  "const answer = 42;",
  "console.log(answer);",
  "```",
  "",
  "收尾段。"
].join("\n");
const mock = await startMockModelServer({ models: ["r12"], reply: REPLY });
const shot = async (win, name) => { await win.screenshot({ path: join(OUT, name) }); console.log(`  [SHOT] ${name}`); };
let failures = 0;

await h.launch();
const win = h.window();
await win.waitForTimeout(900);
await win.evaluate(async ({ baseUrl, ws }) => {
  const k = globalThis.kami;
  await k.saveCustomProvider({ id: "r12p", name: "R12", baseUrl, api: "openai-completions", authHeader: true, models: [{ id: "r12", name: "r12", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }] }, "mock-key");
  await k.setModel("r12p/r12");
  await k.setWorkspace(ws);
  await k.newTask();
}, { baseUrl: mock.baseUrl, ws: h.WORKSPACE_DIR });

const composer = win.locator('[aria-label="消息输入框"]');
await composer.fill("第一个提问：这份报告的结构怎么排");
await win.evaluate(() => document.querySelector(".send-btn")?.click());
try {
  await waitUntil(() => win.evaluate(() => [...document.querySelectorAll(".entry.assistant")].some((el) => (el.textContent ?? "").includes("收尾段"))), { timeout: 30000, desc: "第一轮回答" });
} catch (e) { failures++; console.log("  [FAIL] setup1", e.message.slice(0, 100)); }

// ③ 表格复制 CSV（hover 出按钮）
try {
  await win.evaluate(() => { const el = document.querySelector(".table-scroll"); el?.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true })); });
  await waitUntil(() => win.evaluate(() => document.querySelector(".table-csv-btn") !== null), { timeout: 5000, desc: "CSV 按钮" });
  await win.waitForTimeout(250);
  await shot(win, "03-table-csv.png");
} catch (e) { failures++; console.log("  [FAIL] ③", e.message.slice(0, 100)); }

// ④ 代码块存文件
try {
  await waitUntil(() => win.evaluate(() => document.querySelector(".code-block-save") !== null), { timeout: 5000, desc: "存文件按钮" });
  await win.evaluate(() => document.querySelector(".code-block-save")?.click());
  await waitUntil(() => win.evaluate(() => [...document.querySelectorAll(".toast-text")].some((el) => (el.textContent ?? "").includes("已保存") || (el.textContent ?? "").includes("已存"))), { timeout: 8000, desc: "保存 toast" });
  await win.waitForTimeout(250);
  await shot(win, "04-code-save.png");
} catch (e) { failures++; console.log("  [FAIL] ④", e.message.slice(0, 100)); }

// ⑤ 会话海报（需要 chat-tools：>=2 轮）
try {
  await composer.fill("第二个提问：配图风格怎么定");
  await win.evaluate(() => document.querySelector(".send-btn")?.click());
  await waitUntil(() => win.evaluate(() => document.querySelectorAll(".entry.assistant").length >= 2), { timeout: 30000, desc: "第二轮回答" });
  await win.waitForTimeout(500);
  await win.evaluate(() => [...document.querySelectorAll(".chat-tool-btn")].find((b) => b.textContent === "生成海报")?.click());
  await waitUntil(() => win.evaluate(() => [...document.querySelectorAll(".toast-text")].some((el) => (el.textContent ?? "").includes("海报"))), { timeout: 10000, desc: "海报 toast" });
  await win.waitForTimeout(250);
  await shot(win, "05-poster.png");
} catch (e) { failures++; console.log("  [FAIL] ⑤", e.message.slice(0, 100)); }

// ⑥ 导出纯文本（侧栏更多操作菜单）
try {
  await win.evaluate(() => document.querySelector('[aria-label="更多操作"]')?.click());
  await waitUntil(() => win.evaluate(() => [...document.querySelectorAll("button")].some((b) => (b.textContent ?? "").includes("导出为纯文本"))), { timeout: 5000, desc: "纯文本入口" });
  await win.evaluate(() => [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("导出为纯文本"))?.click());
  await waitUntil(() => win.evaluate(() => [...document.querySelectorAll(".toast-text")].some((el) => (el.textContent ?? "").includes("已导出"))), { timeout: 10000, desc: "txt 导出 toast" });
  await win.waitForTimeout(250);
  await shot(win, "06-export-txt.png");
  // F6 的产物名供 ①⑦⑩ 内容断言用（F4 也会落 .txt「代码片段」，不能混）。
  globalThis.__txtPath = win.evaluate(() => [...document.querySelectorAll(".toast-text")].map((el) => el.textContent).find((t) => t.includes("已导出："))?.replace("已导出：", "").trim());
} catch (e) { failures++; console.log("  [FAIL] ⑥", e.message.slice(0, 100)); }

// ⑧ exports 可视化（设置→数据）
try {
  await win.keyboard.press("Escape");
  await win.evaluate(() => document.querySelector(".sidebar-footer button")?.click());
  await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") !== null), { timeout: 8000, desc: "设置打开" });
  await win.evaluate(() => [...document.querySelectorAll("button.settings-nav-item")].find((el) => (el.textContent ?? "").trim() === "数据管理")?.click());
  await waitUntil(() => win.evaluate(() => [...document.querySelectorAll("h3")].some((el) => (el.textContent ?? "").includes("导出产物"))), { timeout: 8000, desc: "导出产物区" });
  await win.waitForTimeout(250);
  await shot(win, "08-exports-list.png");
  await win.evaluate(() => document.querySelector('[aria-label="关闭设置"]')?.click());
} catch (e) { failures++; console.log("  [FAIL] ⑧", e.message.slice(0, 100)); }

// ⑨ 快捷短语编辑器（设置→个性化）
try {
  await win.evaluate(() => document.querySelector(".sidebar-footer button")?.click());
  await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") !== null), { timeout: 8000, desc: "设置再开" });
  await win.evaluate(() => [...document.querySelectorAll("button.settings-nav-item")].find((el) => (el.textContent ?? "").trim() === "个性化")?.click());
  await waitUntil(() => win.evaluate(() => [...document.querySelectorAll("h3")].some((el) => (el.textContent ?? "").includes("快捷短语"))), { timeout: 8000, desc: "短语编辑器" });
  await win.waitForTimeout(250);
  await shot(win, "09-quick-chips-editor.png");
  await win.evaluate(() => document.querySelector('[aria-label="关闭设置"]')?.click());
} catch (e) { failures++; console.log("  [FAIL] ⑨", e.message.slice(0, 100)); }

// ② 选中存为片段
try {
  await win.evaluate(() => {
    const el = [...document.querySelectorAll(".entry.assistant p")].find((p) => (p.textContent ?? "").includes("第十二轮导出"));
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await waitUntil(() => win.evaluate(() => document.querySelector(".selection-bar") !== null), { timeout: 6000, desc: "选中浮条" });
  await win.evaluate(() => [...document.querySelectorAll(".selection-bar button")].find((b) => b.textContent === "存为片段")?.click());
  await waitUntil(() => win.evaluate(() => [...document.querySelectorAll(".toast-text")].some((el) => (el.textContent ?? "").includes("片段"))), { timeout: 6000, desc: "片段 toast" });
  await win.waitForTimeout(250);
  await shot(win, "02-snippet.png");
} catch (e) { failures++; console.log("  [FAIL] ②", e.message.slice(0, 100)); }

// ①⑦⑩：md 导出增强（目录/分隔线/水印）+ txt 水印 —— 内容级，直接验文件
try {
  await win.evaluate(() => document.querySelector('[aria-label="更多操作"]')?.click());
  await win.waitForTimeout(400);
  await win.evaluate(() => [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("导出为 Markdown"))?.click());
  await waitUntil(() => win.evaluate(() => [...document.querySelectorAll(".toast-text")].some((el) => (el.textContent ?? "").includes("已导出"))), { timeout: 10000, desc: "md 导出 toast" });
  const exportsDir = join(h.WORKSPACE_DIR, "exports");
  const names = readdirSync(exportsDir);
  const mdFile = names.find((n) => n.endsWith(".md"));
  if (mdFile === void 0) throw new Error("无 .md 导出文件");
  const { readFileSync } = await import("node:fs");
  const md = readFileSync(join(exportsDir, mdFile), "utf8");
  if (!md.includes("由 ZeroWork 生成 · v")) throw new Error("md 缺水印");
  if (!md.includes("---")) throw new Error("md 缺分隔线");
  const txtPath = await globalThis.__txtPath;
  if (txtPath !== void 0 && txtPath !== null) {
    const txt = readFileSync(txtPath, "utf8");
    if (!txt.includes("由 ZeroWork 生成 · v")) throw new Error("txt 缺水印");
  }
  await shot(win, "01-md-export-verified.png");
} catch (e) { failures++; console.log("  [FAIL] ①⑦⑩", e.message.slice(0, 100)); }

console.log(`\n完成：${9 - failures} 类成功，${failures} 类失败`);
await h.finish();
mock.close();
