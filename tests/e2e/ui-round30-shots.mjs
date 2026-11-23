// 第三十轮截图：3 张（看板视图 / 列表切换 / 拖拽归档）
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const h = createHarness({ name: "ui-round30-shots", shots: true });
const SESSIONS_DIR = join(h.CONFIG_DIR, "sessions");
mkdirSync(SESSIONS_DIR, { recursive: true });
const tmp = join(h.WORKSPACE_DIR, "临时任务", "2026-11-24-02-00-00");
const t0 = Date.now();
const mk = (idx, title, daysAgo) => {
  const id = `aaaaaaaa-9999-4aaa-8aaa-aaaaaaaaaaa${idx}`;
  const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(t0 - daysAgo * 864e5).toISOString(), cwd: tmp, title })];
  const msgs = [
    { role: "user", text: title },
    { role: "assistant", text: `关于「${title}」的回复。` }
  ];
  for (let i2 = 0; i2 < msgs.length; i2++) {
    const m = msgs[i2];
    lines.push(JSON.stringify({ type: "message", id: `${id}-m${i2}`, parentId: i2 === 0 ? id : `${id}-m${i2-1}`, timestamp: new Date(t0 - daysAgo * 864e5 + i2 * 60000).toISOString(), message: { role: m.role, content: [{ type: "text", text: m.text }] }, ...(m.role === "assistant" ? { model: "m" } : {}) }));
  }
  const filePath = join(SESSIONS_DIR, `s${idx}.jsonl`);
  writeFileSync(filePath, lines.join("\n") + "\n");
  const past = new Date(t0 - daysAgo * 864e5);
  utimesSync(filePath, past, past);
};
mk(1, "看板任务甲", 0);
mk(2, "看板任务乙", 1);

await h.launch();
const win = h.window();
await win.waitForTimeout(2400);

await h.check("① 看板切换按钮出现并可切到看板视图", async () => {
  await waitUntil(() => win.evaluate(() => document.querySelector(".task-view-toggle") !== null), { timeout: 8000, desc: "切换按钮出现" });
  await win.evaluate(() => document.querySelector(".task-view-toggle")?.click());
  await waitUntil(() => win.evaluate(() => document.querySelector(".task-board") !== null), { timeout: 6000, desc: "看板容器出现" });
  const cols = await win.evaluate(() => [...document.querySelectorAll(".task-board-col-head")].map((el) => (el.textContent ?? "").replace(/\s+/g, "")));
  if (!cols.some((c) => c.startsWith("进行中"))) throw new Error(`看板列缺失：${JSON.stringify(cols)}`);
  const cards = await win.evaluate(() => document.querySelectorAll(".task-board-card").length);
  if (cards < 2) throw new Error(`看板卡片不足：${cards}`);
  await h.shoot("01-board-view");
});

await h.check("② 列计数徽标与卡片标题", async () => {
  const info = await win.evaluate(() => {
    const heads = [...document.querySelectorAll(".task-board-col-head")].map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim());
    const titles = [...document.querySelectorAll(".task-board-card-title")].map((el) => (el.textContent ?? "").trim());
    return { heads, titles };
  });
  const activeHead = info.heads.find((t) => t.startsWith("进行中"));
  if (activeHead === void 0 || !/\d/.test(activeHead)) throw new Error(`列头无计数：${JSON.stringify(info.heads)}`);
  if (!info.titles.includes("看板任务甲")) throw new Error(`卡片标题缺失：${JSON.stringify(info.titles)}`);
  await h.shoot("02-board-detail");
});

await h.check("③ 切回列表视图且选择持久化", async () => {
  await win.evaluate(() => document.querySelector(".task-view-toggle")?.click());
  await win.waitForTimeout(500);
  const back = await win.evaluate(() => ({
    list: document.querySelector(".task-list") !== null,
    board: document.querySelector(".task-board") !== null,
    saved: window.localStorage.getItem("zw:task-view")
  }));
  if (!back.list || back.board) throw new Error(`切回列表失败：${JSON.stringify(back)}`);
  if (back.saved !== "list") throw new Error(`视图未持久化：${back.saved}`);
  await h.shoot("03-list-view");
});

await h.finish();
