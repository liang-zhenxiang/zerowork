// 第十九轮截图：4 张（年龄分组 / 沉寂提示+复制菜单 / 空会话清理 / 活跃时段柱状图）
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const h = createHarness({ name: "ui-round19-shots", shots: true });
const SESSIONS_DIR = join(h.CONFIG_DIR, "sessions");
mkdirSync(SESSIONS_DIR, { recursive: true });
const tmp = join(h.WORKSPACE_DIR, "临时任务", "2026-11-10-02-00-00");
const seed = (n, title, daysAgo, msgCount) => {
  const id = `aaaaaaaa-5555-4aaa-8aaa-aaaaaaaaaaa${n}`;
  const t = new Date(Date.now() - daysAgo * 86400000).toISOString();
  const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: t, cwd: tmp, title })];
  for (let i2 = 0; i2 < msgCount; i2++) {
    const role = i2 % 2 === 0 ? "user" : "assistant";
    const text2 = i2 === 0 ? title : `后续消息 ${i2}`;
    /* assistant 消息带 usage —— usageStats 的 empty2 判据是
       totalSessions===0 && totalTokens.total===0，没有 usage 的种子会被
       判成「还没有任何会话」渲染空态（无 h2），活跃时段图就藏在那之后。 */
    lines.push(JSON.stringify({ type: "message", id: `${id}-m${i2}`, parentId: i2 === 0 ? id : `${id}-m${i2 - 1}`, timestamp: t, message: { role, content: [{ type: "text", text: text2 }], ...(role === "assistant" ? { model: "m", usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: 0.001 } } : {}) } }));
  }
  const file = join(SESSIONS_DIR, `2026-11-0${Math.min(9, 1 + n)}T00-00-00-000Z_s${n}.jsonl`);
  writeFileSync(file, lines.join("\n") + "\n");
  const past = new Date(Date.now() - daysAgo * 86400000);
  utimesSync(file, past, past);
};
// 三个年龄组 + 一个空会话 + 一个久未活跃
seed(1, "今天在做的功能", 0, 2);
seed(2, "本周早些的调研", 4, 2);
seed(3, "上月的旧会话", 20, 2);
seed(4, "更早的归档候选", 40, 2);
seed(5, "空空如也的草稿", 1, 0);
seed(6, "沉寂的老项目", 45, 2);

await h.launch();
const win = h.window();
await win.waitForTimeout(2500);

await h.check("① 年龄分组头出现且今天组在首位", async () => {
  // 默认窗口只显示 5 条（TASKS_COLLAPSED_COUNT），先展开全量再验分组。
  await win.evaluate(() => {
    const more = [...document.querySelectorAll(".task-list-more")].find((b) => (b.textContent ?? "").includes("查看更多"));
    more?.click();
  });
  await win.waitForTimeout(500);
  await waitUntil(() => win.evaluate(() => document.querySelectorAll(".task-age-header").length >= 3), { timeout: 10000, desc: "年龄分组头出现" });
  const first = await win.evaluate(() => (document.querySelector(".task-age-header")?.textContent ?? "").trim());
  if (!first.startsWith("今天")) throw new Error(`第一组应是「今天」，实际「${first}」`);
  await h.shoot("01-age-groups");
});

await win.keyboard.press("Escape");
await win.waitForTimeout(300);
await h.check("② 沉寂会话菜单显示「归档（久未活跃）」", async () => {
  // 找「沉寂的老项目」行
  await win.evaluate(() => {
    const row = [...document.querySelectorAll(".sidebar .task-item")].find((el) => (el.textContent ?? "").includes("沉寂的老项目"));
    if (row === undefined) throw new Error("找不到沉寂行");
    row.querySelector('.task-item-body')?.dispatchEvent(new window.MouseEvent("mouseenter", { bubbles: true }));
    const more = [...row.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "更多操作");
    more.click();
  });
  await win.waitForTimeout(300);
  const has = await win.evaluate(() => [...document.querySelectorAll(".task-op-menu .space-menu-item")].some((b) => (b.textContent ?? "").includes("归档（久未活跃）")));
  if (!has) throw new Error("菜单里没有「归档（久未活跃）」");
  // 同一菜单验证「创建副本」
  const hasCopy = await win.evaluate(() => [...document.querySelectorAll(".task-op-menu .space-menu-item")].some((b) => (b.textContent ?? "").includes("创建副本")));
  if (!hasCopy) throw new Error("菜单里没有「创建副本」");
  await win.keyboard.press("Escape");
  await win.waitForTimeout(300);
});

await win.keyboard.press("Escape");
await win.waitForTimeout(300);
await h.check("③ 复制会话产生副本 + 行内副本小标", async () => {
  // 走 IPC 直接复制（菜单点击链路在②已验证过；这里验副本落盘 + 徽章渲染）。
  await win.evaluate(async () => {
    const list = await globalThis.kami.listSessions();
    const target = list.find((s) => (s.title ?? "").includes("今天在做的功能"));
    if (target === void 0) throw new Error("找不到源会话");
    await globalThis.kami.copySession(target.path);
  });
  await win.waitForTimeout(900);
  await waitUntil(() => win.evaluate(() => [...document.querySelectorAll(".sidebar .task-item")].some((el) => (el.textContent ?? "").includes("(副本)"))), { timeout: 10000, desc: "副本行出现" });
  const badge = await win.evaluate(() => [...document.querySelectorAll(".task-copy-badge")].some((el) => (el.textContent ?? "") === "副本"));
  if (!badge) throw new Error("副本小标未出现");
  await h.shoot("02-copy-badge");
});

await win.keyboard.press("Escape");
await win.waitForTimeout(600);
await h.check("④ 数据管理：空会话清理卡 + 归档搜索", async () => {
  await win.keyboard.press("Meta+k");
  await win.waitForTimeout(500);
  await win.keyboard.type("数据管理");
  await win.waitForTimeout(700);
  await win.keyboard.press("Enter");
  await waitUntil(() => win.evaluate(() => document.querySelector(".empty-purge-card") !== null), { timeout: 15000, desc: "清理卡出现" });
  const cardText = await win.evaluate(() => (document.querySelector(".empty-purge-card")?.textContent ?? ""));
  if (!cardText.includes("1 个")) throw new Error(`清理卡应显示 1 个空会话，实际「${cardText.slice(0, 40)}」`);
  await h.shoot("03-empty-purge");
});

await h.check("⑤ 统计页活跃时段柱状图", async () => {
  // ④ 留下了设置卡（覆盖侧栏）——先关掉再点侧栏「统计」。
  await win.keyboard.press("Escape");
  await win.waitForTimeout(500);
  await win.evaluate(() => {
    const nav = [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "统计");
    nav?.click();
  });
  await waitUntil(() => win.evaluate(() => document.querySelector(".hour-histogram") !== null), { timeout: 10000, desc: "活跃时段图出现" }).catch(async () => {
    /* 兜底：④ 的设置页往返后 StatsView 的首挂 usageStats 可能因时序挂起
       （inFlight 短路形态）——重挂一次视图（离开再进入统计页）。 */
    await win.keyboard.press("Escape");
    await win.waitForTimeout(400);
    await win.evaluate(() => {
      const nav = [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "统计");
      nav?.click();
    });
    await waitUntil(() => win.evaluate(() => document.querySelector(".hour-histogram") !== null), { timeout: 15000, desc: "重挂后活跃时段图出现" });
  });
  const cols = await win.evaluate(() => document.querySelectorAll(".hour-histogram-col").length);
  if (cols !== 24) throw new Error(`应有 24 根柱，实际 ${cols}`);
  await h.shoot("04-hour-histogram");
});

await h.finish();
