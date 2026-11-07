// 第十七轮截图：4 张（撤销归档 toast / 清空草稿+撤销 / 存储余量 / 错误卡搜索按钮）
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const h = createHarness({ name: "ui-round17-shots", shots: true });
const REPLY = "第十七轮可靠性验证回复。\n\n第二段内容。\n\n收尾段。";
const mock = await startMockModelServer({ models: ["r17-model"], reply: REPLY });
const SESSIONS_DIR = join(h.CONFIG_DIR, "sessions");
mkdirSync(SESSIONS_DIR, { recursive: true });
const seed = (n, cwd, title, daysAgo) => {
  const id = `aaaaaaaa-3333-4aaa-8aaa-aaaaaaaaaaa${n}`;
  const t = new Date(Date.now() - daysAgo * 86400000).toISOString();
  const msg = (mid, parentId, role, text) => JSON.stringify({ type: "message", id: mid, parentId, timestamp: t, message: { role, content: [{ type: "text", text }] }, ...(role === "assistant" ? { model: "r17-model" } : {}) });
  const lines = [
    JSON.stringify({ type: "session", version: 3, id, timestamp: t, cwd, title }),
    msg(`${id}-u`, id, "user", title),
    msg(`${id}-a`, `${id}-u`, "assistant", "回复。")
  ];
  const file = join(SESSIONS_DIR, `2026-11-03T00-00-0${n}-000Z_s${n}.jsonl`);
  writeFileSync(file, lines.join("\n") + "\n");
  const past = new Date(Date.now() - daysAgo * 86400000);
  utimesSync(file, past, past);
};
const WS = h.WORKSPACE_DIR;
const tmp = join(WS, "临时任务", "2026-11-08-02-00-00");
seed(1, tmp, "十七轮的验证会话", 0);

await h.launch();
const win = h.window();
await win.waitForTimeout(2500);

await h.check("① 撤销归档：归档 toast 带「撤销」按钮", async () => {
  // 种子 cwd 是绝对路径且 basename 是自动目录名 → 进任务区。
  const row = win.locator(".sidebar .task-item").first();
  await row.hover();
  await win.waitForTimeout(300);
  await win.evaluate(() => {
    const r = document.querySelector(".sidebar .task-item");
    const more = [...r.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "更多操作");
    more.click();
  });
  await win.waitForTimeout(300);
  await win.evaluate(() => {
    const item = [...document.querySelectorAll(".task-op-menu .space-menu-item")].find((b) => (b.textContent ?? "").includes("归档"));
    if (item === undefined) throw new Error("菜单里没有归档项");
    item.click();
  });
  await waitUntil(() => win.evaluate(() => {
    const t = [...document.querySelectorAll(".toast")].find((el) => (el.textContent ?? "").includes("已归档"));
    return t !== undefined && t.querySelector(".toast-action") !== null && (t.querySelector(".toast-action").textContent ?? "").includes("撤销");
  }), { timeout: 10000, desc: "归档 toast 出现且带撤销按钮" });
  await h.shoot("01-undo-archive");
  // 点撤销，验证会话回到列表（toast 也消失）。
  await win.evaluate(() => {
    const t = [...document.querySelectorAll(".toast")].find((el) => (el.textContent ?? "").includes("已归档"));
    t.querySelector(".toast-action").click();
  });
  await win.waitForTimeout(800);
  const back = await win.evaluate(() => document.querySelectorAll(".sidebar .task-item").length);
  if (back < 1) throw new Error(`撤销后任务行应回到列表，实际 ${back}`);
});

await h.check("② 清空草稿+撤销：文本还原", async () => {
  await win.evaluate(() => globalThis.kami.newTask());
  await win.waitForTimeout(600);
  const ta = win.locator('[aria-label="消息输入框"]');
  await ta.fill("这段草稿是要被清空再撤销的");
  await win.waitForTimeout(300);
  await win.evaluate(() => {
    const btn = document.querySelector(".composer-clear-btn");
    if (btn === null) throw new Error("清空按钮未出现");
    btn.click();
  });
  await win.waitForTimeout(400);
  const cleared = await win.evaluate(() => document.querySelector('[aria-label="消息输入框"]').value === "");
  if (!cleared) throw new Error("点清空后草稿应已清空");
  await waitUntil(() => win.evaluate(() => [...document.querySelectorAll(".toast")].some((el) => (el.textContent ?? "").includes("草稿已清空"))), { timeout: 8000, desc: "清空 toast 出现" });
  await h.shoot("02-clear-draft-undo");
  await win.evaluate(() => {
    const t = [...document.querySelectorAll(".toast")].find((el) => (el.textContent ?? "").includes("草稿已清空"));
    t.querySelector(".toast-action").click();
  });
  await win.waitForTimeout(400);
  const restored = await win.evaluate(() => document.querySelector('[aria-label="消息输入框"]').value);
  if (!restored.includes("这段草稿是要被清空再撤销的")) throw new Error(`撤销后应还原文本，实际「${restored}」`);
});

await h.check("③ 存储余量条出现在数据管理页", async () => {
  await win.keyboard.press("Meta+k");
  await win.waitForTimeout(400);
  await win.keyboard.type("数据管理");
  await win.waitForTimeout(600);
  await win.keyboard.press("Enter");
  await win.waitForTimeout(800);
  await waitUntil(() => win.evaluate(() => document.querySelector(".storage-meter-track") !== null), { timeout: 10000, desc: "存储余量条出现" });
  await h.shoot("03-storage-meter");
  await win.keyboard.press("Escape");
  await win.waitForTimeout(300);
});

await h.check("④ 错误卡带「搜索此错误」按钮", async () => {
  // 挂一个指向死端口的 provider，发送必然 run_error（探针验证过这个链路）。
  await win.evaluate(async ({ ws }) => {
    const k = globalThis.kami;
    await k.saveCustomProvider({ id: "dead", name: "Dead", baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", authHeader: true, models: [{ id: "m", name: "m", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }] }, "k");
    await k.setModel("dead/m");
    await k.setWorkspace(ws);
  }, { ws: h.WORKSPACE_DIR });
  await win.waitForTimeout(300);
  const ta = win.locator('[aria-label="消息输入框"]');
  await ta.fill("触发一条错误");
  await ta.press("Enter");
  await waitUntil(() => win.evaluate(() => document.querySelector(".error-card") !== null), { timeout: 30000, desc: "错误卡出现" });
  const hasSearch = await win.evaluate(() => document.querySelector(".error-card .error-card-search") !== null);
  if (!hasSearch) throw new Error("错误卡没有搜索按钮");
  await h.shoot("04-error-search");
});

await h.finish();
mock.close().catch(() => {});
