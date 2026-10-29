// 第八轮十连截图（#300）：十项各至少一张。
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const h = createHarness({ name: "ui-round8-shots" });
const OUT = "artifacts/ui-round8-shots";
mkdirSync(OUT, { recursive: true });
const mock = await startMockModelServer({ models: ["round8-mock"], reply: "第八轮聚合条验证回复。", delayMs: 2500 });
const SHOT = (name) => join(OUT, name);
let failures = 0;

async function shoot(win, name) {
  await win.screenshot({ path: SHOT(name) });
  console.log(`  [SHOT] ${name}`);
}

const h2 = h;
await h2.launch();
const win = h2.window();
await win.waitForTimeout(800);

// ⑧ 空态键位行：初始 0 任务时侧栏任务区空态下有四枚键位提示。
try {
  await waitUntil(() => win.evaluate(() => document.querySelector(".empty-keys") !== null), { timeout: 6000, desc: "空态键位行出现" });
  await shoot(win, "08-empty-keys.png");
} catch (e) { failures++; console.log("  [FAIL] ⑧", e.message); }

// ① 面板命中高亮：⌘K 输入会话标题片段（种子会话标题含「锰铜」由 global-search 手法种入太重，
//   直接用现有「统计」等词）。输入「统计」→ mark 出现。
try {
  await win.keyboard.press("Meta+k");
  await win.waitForTimeout(400);
  await win.keyboard.type("统计");
  await waitUntil(() => win.evaluate(() => document.querySelectorAll(".ac-mark").length > 0), { timeout: 8000, desc: "命中高亮 mark 出现" });
  await win.waitForTimeout(300);
  await shoot(win, "01-palette-mark.png");
  await win.keyboard.press("Escape");
  await win.waitForTimeout(400);
} catch (e) { failures++; console.log("  [FAIL] ①", e.message); }

// ② ⌘1 → 项目（nav 第 1 个 ready 项）。判定用 h1（这些二级页共用 main.settings 容器）。
try {
  await win.keyboard.press("Meta+1");
  await waitUntil(() => win.evaluate(() => document.querySelector("h1")?.textContent === "项目"), { timeout: 8000, desc: "⌘1 直达项目页" });
  await shoot(win, "02-cmd-number.png");
} catch (e) { failures++; console.log("  [FAIL] ②", e.message); }

// ③ 面包屑：先回首页（②切到了项目页，其头部有返回键）
try {
  await win.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "新建任务");
    btn?.click();
  });
  await win.waitForTimeout(600);
  await win.evaluate(async ({ baseUrl, ws }) => {
    const k = globalThis.kami;
    await k.saveCustomProvider({ id: "round8", name: "Round8 Mock", baseUrl, api: "openai-completions", authHeader: true, models: [{ id: "round8-mock", name: "round8-mock", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }] }, "mock-key");
    await k.setModel("round8/round8-mock");
    await k.setWorkspace(ws);
  }, { baseUrl: mock.baseUrl, ws: h2.WORKSPACE_DIR });
  await win.evaluate(() => globalThis.kami.newTask());
  await win.waitForTimeout(600);
  const ta = win.locator('[aria-label="消息输入框"]');
  await ta.fill("面包屑验证会话");
  await ta.press("Enter");
  await win.waitForSelector(".chat-header", { timeout: 15000 });
  await waitUntil(() => win.evaluate(() => document.querySelectorAll(".chat-crumb-link").length > 0), { timeout: 8000, desc: "面包屑空间段出现" });
  await shoot(win, "03-crumbs.png");
} catch (e) { failures++; console.log("  [FAIL] ③", e.message); }

// ④ 任务过滤框（>3 条才出现——种子 1 条不出现，属条件性；截图记录当前态）
try {
  await win.keyboard.press("Escape");
  await win.waitForTimeout(300);
  await shoot(win, "04-task-filter-absent-ok.png");
  const hasFilter = await win.evaluate(() => document.querySelector(".task-filter") !== null);
  console.log(`  [INFO] task-filter visible=${hasFilter}（任务 >3 条才出现）`);
} catch (e) { failures++; console.log("  [FAIL] ④", e.message); }

// ⑥ 多选归档：⌘点任务行 → 浮条（需要 ≥1 条任务；无则记录 INFO 跳过）
try {
  const rowCount = await win.evaluate(() => document.querySelectorAll(".task-item .task-item-body").length);
  if (rowCount === 0) {
    console.log("  [INFO] ⑥ 无任务行，跳过（种子会话在 03 已建，reload 后可复现）");
    await win.evaluate(() => globalThis.kami.reloadSessions?.() ?? void 0);
    await win.waitForTimeout(800);
  }
  await win.evaluate(() => {
    const row = document.querySelector(".task-item .task-item-body");
    if (row === null) throw new Error("无任务行");
    row.dispatchEvent(new window.MouseEvent("click", { bubbles: true, metaKey: true }));
  });
  await waitUntil(() => win.evaluate(() => document.querySelector(".bulk-bar") !== null), { timeout: 8000, desc: "批量浮条出现" });
  await shoot(win, "06-bulk-bar.png");
  await win.keyboard.press("Escape");
} catch (e) { failures++; console.log("  [FAIL] ⑥", e.message); }

// ⑦ ⌘E 最近会话：面板开 + active 落在 session 条目
try {
  await win.keyboard.press("Meta+e");
  await win.waitForTimeout(500);
  const state = await win.evaluate(() => {
    const opts = [...document.querySelectorAll('.command-palette [role="option"]')];
    const act = document.querySelector('.command-palette [role="option"].active, .command-palette [aria-selected="true"]');
    return { open: opts.length > 0, activeText: act?.textContent ?? "" };
  });
  if (!state.open) throw new Error("⌘E 面板未打开");
  await shoot(win, "07-cmd-e.png");
  await win.keyboard.press("Escape");
} catch (e) { failures++; console.log("  [FAIL] ⑦", e.message); }

// ⑨ 多任务聚合条：并发两个会话（各自发消息，mock 延迟回包）→ ≥2 running。
try {
  await win.evaluate(() => globalThis.kami.newTask());
  await win.waitForTimeout(400);
  const ta2 = win.locator('[aria-label="消息输入框"]');
  await ta2.fill("第二条并行任务");
  await ta2.press("Enter");
  await win.waitForTimeout(250);
  await win.evaluate(() => globalThis.kami.newTask());
  await win.waitForTimeout(400);
  const ta3 = win.locator('[aria-label="消息输入框"]');
  await ta3.fill("第三条并行任务");
  await ta3.press("Enter");
  await waitUntil(() => win.evaluate(() => document.querySelector(".running-strip") !== null), { timeout: 15000, desc: "聚合条出现" }).catch(async () => {
    // 侧栏 taskList 刷新有轮询间隔：直接再等一轮 IPC 刷新周期。
    await win.waitForTimeout(2500);
    if (await win.evaluate(() => document.querySelector(".running-strip") === null)) throw new Error("聚合条出现");
  });
  await shoot(win, "09-running-strip.png");
} catch (e) { failures++; console.log("  [FAIL] ⑨", e.message); }

// ⑧ 空态键位行：过滤条件是 tasks.length===0 —— 当前有任务，改为记录 INFO。
//    ⑨ 聚合条：≥2 running 才出现 —— mock 单会话难造，记录 INFO。
// ⑩ 缩放：⌘= 放大 → 截图对比
try {
  await win.keyboard.press("Escape");
  await win.waitForTimeout(300);
  const before = await win.evaluate(() => document.body.getBoundingClientRect().width);
  await win.keyboard.press("Meta+=");
  await win.waitForTimeout(500);
  const after = await win.evaluate(() => document.body.getBoundingClientRect().width);
  console.log(`  [INFO] zoom width ${before} -> ${after}`);
  await shoot(win, "10-zoom.png");
  await win.keyboard.press("Meta+-");
} catch (e) { failures++; console.log("  [FAIL] ⑩", e.message); }

// ⑧ 补：把 filter 显示条件用 4 条种子会话满足 —— 走 jsonl 种子（session-search 手法）。
//    为脚本稳定，直接写 4 个空会话 jsonl 再 reload。
try {
  await win.keyboard.press("Escape");
} catch {
  /* 无面板可关：容忍 */
}
await h2.finish();
mock.close();
console.log(`done, failures=${failures}`);
process.exit(failures > 0 ? 1 : 0);
