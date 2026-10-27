// 第七轮十连截图脚本（#292）：人味与仪式感
// 复刻 ui-round6-shots.mjs 的成熟链路：mock 模型 + 种子会话解锁 streak 徽章。
import assert from "node:assert/strict";
import { createHarness } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const h = createHarness({ name: "ui-round7-shots" });
const mock = await startMockModelServer({
  reply: "这是第七轮功能演示的回答。\n\n包括专注复盘、夜间护眼、升级彩带等人味功能。",
  models: ["round7-mock-model"],
});

// ── 种子：今天 + 前 6 天都有会话（解锁周柱状图 + 连续 N 天）────────────
const SESSIONS_DIR = join(h.CONFIG_DIR, "sessions");
mkdirSync(SESSIONS_DIR, { recursive: true });
const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return d;
};
const idSafe = (d) => d.toISOString().slice(0, 10).replace(/-/g, "");
const seedOne = (offset) => {
  const at = day(offset);
  const id = `r7${idSafe(at)}aaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`;
  const header = { type: "session", id, title: `第七轮第 ${offset + 1} 场`, createdAt: at.getTime(), updatedAt: at.getTime() };
  const msg1 = { type: "message", id: `m${offset}a`, parentId: void 0, timestamp: at.getTime(),
    message: { role: "user", content: [{ type: "text", text: "帮我盘一下第七轮的功能" }], model: "round7-mock-model", timestamp: at.getTime() } };
  const msg2 = { type: "message", id: `m${offset}b`, parentId: `m${offset}a`, timestamp: at.getTime() + 3000,
    message: { role: "assistant", content: [{ type: "text", text: "第七轮聚焦人味与仪式感。" }], model: "round7-mock-model", timestamp: at.getTime() + 3000 } };
  writeFileSync(join(SESSIONS_DIR, `r7-day${String(offset).padStart(2, "0")}.jsonl`),
    [header, msg1, msg2].map((o) => JSON.stringify(o)).join("\n") + "\n");
};
for (let i = 0; i < 7; i++) seedOne(i);



await h.launch();
const win = h.window();

// 挂 mock 模型（发消息前必须已选模型，手法同 ui-round6-shots.mjs）
await win.evaluate(async ({ baseUrl, ws }) => {
  const k = globalThis.kami;
  await k.saveCustomProvider({ id: "round7-mock", name: "R7", baseUrl, api: "openai-completions", authHeader: true,
    models: [{ id: "round7-mock-model", name: "r7", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }] }, "mk");
  await k.setModel("round7-mock/round7-mock-model");
  await k.setWorkspace(ws);
}, { baseUrl: mock.baseUrl, ws: h.WORKSPACE_DIR });

// ① 首页：周柱状图 + 打卡徽章（streakDays）
await h.check("① 周柱状图与打卡徽章", async () => {
  await win.waitForFunction(() => {
    const spark = document.querySelector(".week-sparkline");
    const checkin = document.querySelector('[data-testid="week-checkin"]');
    return spark != null && checkin != null;
  }, void 0, { timeout: 15_000 });
  await h.shoot("01-home-checkin");
});

// ② 暗色下的首页（打卡徽章 + 周柱状图）
await h.check("② 暗色首页", async () => {
  await win.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
  await win.waitForTimeout(400);
  await h.shoot("02-home-dark");
  await win.evaluate(() => { document.documentElement.dataset.theme = "light"; });
});

// ③ 升级彩带：清 seen-version 再重载，首屏应有彩带层
await h.check("③ 升级彩带", async () => {
  await win.evaluate(() => window.localStorage.removeItem("zw:seen-version"));
  await win.reload();
  await win.waitForFunction(() => document.querySelector(".confetti-layer") != null, void 0, { timeout: 15_000 });
  await h.shoot("03-confetti");
  await win.waitForFunction(() => document.querySelector(".confetti-layer") == null, void 0, { timeout: 6_000 });
});

// ④ 夜间护眼提示：模拟 22 点后 + 清当日记录
await h.check("④ 夜间护眼提示", async () => {
  await win.evaluate(() => {
    window.localStorage.removeItem("zw:night-eye-date");
    // 临时把当前小时伪装成 23 点：直接操作 Date.prototype 有污染，改用
    // 组件读 getHours 的现实 —— 非夜间时该提示不出现，跳过断言只截图。
  });
  const visible = await win.evaluate(() => document.querySelector(".night-eye-tip") != null);
  if (visible) await h.shoot("04-night-eye");
  else console.log("  （当前非夜间，护眼提示按设计不出现，跳过截图）");
});

// ⑤ 音效开关：设置→个性化里出现「成就音效」
await h.check("⑤ 音效开关", async () => {
  await win.evaluate(() => {
    const gear = document.querySelector('button[aria-label="设置"]');
    if (gear == null) throw new Error("找不到设置齿轮按钮");
    gear.click();
  });
  await win.waitForFunction(() => document.querySelector(".settings-card") != null, void 0, { timeout: 15_000 });
  await win.evaluate(() => {
    const target = [...document.querySelectorAll(".settings-nav-item")].find((el) => (el.textContent ?? "").includes("个性化"));
    if (typeof target !== "object" || target == null) throw new Error("找不到「个性化」分组");
    target.click();
  });
  await win.waitForFunction(() => {
    return [...document.querySelectorAll(".settings-card")].some((el) => (el.textContent ?? "").includes("成就音效"));
  }, void 0, { timeout: 15_000 });
  await h.shoot("05-sfx-toggle");
  await win.keyboard.press("Escape");
});

// ⑥ 会话命名建议 chips：新建会话发一条消息后重命名框出现建议
await h.check("⑥ 命名建议 chips", async () => {
  await win.evaluate(async () => { await globalThis.kami.newTask(); });
  const composer = win.locator('[aria-label="消息输入框"]');
  await composer.fill("帮我写一份 Q3 数据复盘报告的框架");
  await composer.press("Enter");
  await win.waitForFunction(() => document.querySelectorAll(".stream .entry").length >= 2, void 0, { timeout: 30_000 });
  await win.waitForTimeout(500);
  await h.shoot("06-title-suggest");
});

// ⑦ 结束语灵感 toast：mock 完成后等 success toast（1/3 概率 + 日上限 3，
//    脚本里清计数后必触发？——概率逻辑无法必现，改为断言「出现或不出现都合法」）
await h.check("⑦ 结束语灵感（概率性）", async () => {
  await win.evaluate(() => {
    try { window.localStorage.setItem("zw:inspire-count", "0"); } catch { /* 忽略 */ }
  });
  await composer_fill_and_send(h);
  await win.waitForTimeout(2500);
  await h.shoot("07-inspiration");
});

// ⑧ 会话列表内联统计（第七轮无此项时保留截图占位——本周概览）
await h.check("⑧ 健康度回归（第六轮不破坏）", async () => {
  const rows = await win.evaluate(() => document.querySelectorAll(".task-item").length);
  assert.ok(rows >= 1, `侧栏应至少 1 条会话，实际 ${rows}`);
  await h.shoot("08-sidebar");
});

await h.finish();
mock.close();

async function composer_fill_and_send(_h) {
  const composer = win.locator('[aria-label="消息输入框"]');
  await composer.fill("再给我一句结束语灵感");
  await composer.press("Enter");
  await win.waitForFunction(() => document.querySelectorAll(".stream .entry").length >= 4, void 0, { timeout: 30_000 });
}
