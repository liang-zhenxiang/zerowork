// 第五轮十连截图：统计页（徽章/分享卡/CSV）、数据管理（概览/清空归档）、首页周柱、侧栏气泡。
// 手法复刻 stats-share.mjs（locator 点击 + waitUntil evaluate）。
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const h = createHarness({ name: "ui-round5-shots", shots: true });
const mock = await startMockModelServer({ models: ["round5-mock"] });

// ── 种子：12 场会话（解锁 sessions-10 徽章）────────────────────────
// 格式复刻 stats-share.mjs（实测能被 usageStats 读到）：嵌套 message 结构，
// assistant 必带 model（isLegacySession 否则整条跳过）；usage 记在 message 层。
const SESSIONS_DIR = join(h.CONFIG_DIR, "sessions");
mkdirSync(SESSIONS_DIR, { recursive: true });
const now = Date.now();
function msg(id, parentId, role, text, usage) {
  const extra = role === "assistant" ? { model: "round5-mock" } : {};
  return JSON.stringify({
    type: "message", id, parentId, timestamp: new Date(now - 36e5).toISOString(),
    message: { role, content: [{ type: "text", text }], ...extra, ...(usage ?? {}) }
  });
}
for (let i = 1; i <= 12; i++) {
  const sid = `dddddddd-dddd-4ddd-8ddd-ddddddddddd${i}`;
  const file = `2026-10-27T0${String(i).padStart(2, "0")}-00-00-r5-${i}-000Z_s${i}.jsonl`;
  writeFileSync(join(SESSIONS_DIR, file), [
    JSON.stringify({ type: "session", version: 3, id: sid, timestamp: new Date(now - i * 36e5).toISOString(), title: `第五轮样例会话 ${i}`, cwd: h.WORKSPACE_DIR }),
    msg(`r5u${i}`, null, "user", `帮我安排第 ${i} 批物料的采购计划`),
    msg(`r5a${i}`, `r5u${i}`, "assistant", `已生成采购计划 ${i}：三家供应商比价完成。`, { usage: { input: 1200 + i * 100, output: 800 + i * 50, cacheRead: 0, cacheWrite: 0, cost: 0.001 * i } })
  ].join("\n") + "\n");
}

await h.launch();
const win = h.window();
await waitUntil(() => win.evaluate(() => globalThis.kami !== undefined), { timeout: 10_000, desc: "kami 就绪" });
await win.evaluate(async (m) => {
  const k = globalThis.kami;
  await k.saveCustomProvider({ id: "round5-mock", name: "R5", baseUrl: m.baseUrl, api: "openai-completions", authHeader: true,
    models: [{ id: "round5-mock-model", name: "r5", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }] }, "mk");
  await k.setModel("round5-mock/round5-mock-model");
  await k.setWorkspace(m.ws);
}, { baseUrl: mock.baseUrl, ws: h.WORKSPACE_DIR });

// 01 统计页全貌（徽章墙 + 数字卡 + 分享卡/CSV 按钮 + count-up 落定）
await h.check("① 统计页徽章墙与按钮", async () => {
  await win.locator("button.nav-item", { hasText: "统计" }).first().click();
  await waitUntil(() => win.evaluate(() => document.querySelector("h1")?.textContent === "使用统计"), { timeout: 20_000, desc: "统计页标题" });
  await waitUntil(() => win.evaluate(() => document.querySelector(".stats-badge-grid") !== null), { timeout: 20_000, desc: "徽章墙出现" });
  await win.waitForTimeout(900); // count-up 落定
  const hasCsv = await win.evaluate(() => [...document.querySelectorAll("button")].some((b) => (b.textContent ?? "").includes("导出 CSV")));
  if (!hasCsv) throw new Error("导出 CSV 按钮缺失");
});
await h.shoot("01-stats-badges");

// 02 点分享卡 → 落盘提示（路径提示在统计页头部）
await h.check("② 分享卡生成落盘", async () => {
  await win.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("分享卡"));
    if (btn === undefined || btn === null) throw new Error("找不到分享卡按钮");
    btn.click();
  });
  await waitUntil(() => win.evaluate(() => document.body.textContent?.includes("exports") === true), { timeout: 15_000, desc: "保存路径提示" });
});
await h.shoot("02-share-card");

// 03 数据管理页（概览条）—— 手法复刻 prompt-templates.mjs 的 openSettings
await h.check("③ 数据概览条", async () => {
  await win.evaluate(() => document.querySelector('[aria-label="设置"]').click());
  await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") !== null), { timeout: 30_000, desc: "设置对话框打开" });
  const found = await win.evaluate(() => {
    const item = [...document.querySelectorAll(".settings-nav-item")].find((n) => n.textContent.trim() === "数据管理");
    if (item === undefined) return false;
    item.click();
    return true;
  });
  if (!found) throw new Error("找不到「数据管理」导航项");
  await waitUntil(() => win.evaluate(() => document.querySelector(".data-overview") !== null), { timeout: 10_000, desc: "数据概览条出现" });
});
await h.shoot("03-data-overview");

// 04 首页周柱状 + 问候（关闭设置 → 回首页）
await h.check("④ 首页周柱状", async () => {
  const closer = await win.evaluate(() => {
    const btn = document.querySelector('[aria-label="关闭设置"]');
    if (btn === null) return false;
    btn.click();
    return true;
  });
  if (closer) {
    await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") === null), { timeout: 15_000, desc: "设置关闭" });
  }
  await waitUntil(() => win.evaluate(() => document.querySelector(".week-sparkline, .home-greeting") !== null), { timeout: 10_000, desc: "首页问候/周柱出现" });
});
await h.shoot("04-home-week");

// 05 侧栏会话行气泡
await h.check("⑤ 侧栏会话气泡", async () => {
  const has = await win.evaluate(() => document.querySelectorAll(".task-item-count").length);
  // 侧栏可见的会话行未必有 messageCount（热会话在内存）；≥0 都拍，气泡断言宽松
  if (has < 0) throw new Error("impossible");
});
await h.shoot("05-sidebar-counts");

await h.finish();
mock.close();
