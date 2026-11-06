// 第十六轮截图：3 张（颜色标记 / 组内搜索 / 移动到空间）
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { createHarness } from "./lib/harness.mjs";

const h = createHarness({ name: "ui-round16-shots" });
const SESSIONS_DIR = join(h.CONFIG_DIR, "sessions");
mkdirSync(SESSIONS_DIR, { recursive: true });
const seed = (n, cwd, title, daysAgo) => {
  const id = `aaaaaaaa-2222-4aaa-8aaa-aaaaaaaaaaa${n}`;
  const t = new Date(Date.now() - daysAgo * 86400000).toISOString();
  const msg = (mid, parentId, role, text) => JSON.stringify({ type: "message", id: mid, parentId, timestamp: t, message: { role, content: [{ type: "text", text }] }, ...(role === "assistant" ? { model: "m" } : {}) });
  const lines = [
    JSON.stringify({ type: "session", version: 3, id, timestamp: t, cwd, title }),
    msg(`${id}-u`, id, "user", title),
    msg(`${id}-a`, `${id}-u`, "assistant", "回复。")
  ];
  const file = join(SESSIONS_DIR, `2026-11-02T00-00-0${n}-000Z_s${n}.jsonl`);
  writeFileSync(file, lines.join("\n") + "\n");
  const past = new Date(Date.now() - daysAgo * 86400000);
  utimesSync(file, past, past);
};
const WS = h.WORKSPACE_DIR;
const projA = join(WS, "proj-alpha");
const projB = join(WS, "proj-beta");
const tmp = join(WS, "临时任务", "2026-11-07-02-00-00");
seed(1, projA, "alpha 的功能开发", 1);
seed(2, projA, "alpha 的缺陷修复", 2);
seed(3, projB, "beta 的调研", 1);
seed(4, tmp, "零散的临时任务", 0);

await h.launch();
const win = h.window();

await h.check("① 颜色标记：点击色点后组头出现实心色点", async () => {
  await win.evaluate(() => {
    document.querySelector('[aria-label="切换空间颜色"]').click();
  });
  await win.waitForTimeout(300);
  const filled = await win.evaluate(() => document.querySelector(".space-color-dot:not(.space-color-empty)") !== null);
  if (!filled) throw new Error("点击后没有出现实心色点");
  await h.shoot("01-space-color");
});

await h.check("② 组内搜索：过滤后只剩匹配行", async () => {
  /* 组按最近活跃排序，proj-alpha 不一定是 [0] —— 按组名找。 */
  const alphaIndex = await win.evaluate(() => [...document.querySelectorAll(".space-group")].findIndex((g) => (g.querySelector(".space-group-name")?.textContent ?? "").includes("proj-alpha")));
  if (alphaIndex < 0) throw new Error("没找到 proj-alpha 组");
  await win.evaluate((idx) => {
    document.querySelectorAll(".space-group")[idx].querySelector('[aria-label="组内搜索"]').click();
  }, alphaIndex);
  await win.waitForTimeout(200);
  await win.locator('[aria-label="组内搜索词"]').fill("缺陷");
  await win.waitForTimeout(400);
  const rows = await win.evaluate((idx) => {
    const g = document.querySelectorAll(".space-group")[idx];
    return g.querySelectorAll(".task-item-body").length;
  }, alphaIndex);
  if (rows !== 1) throw new Error(`组内搜索「缺陷」应剩 1 行，实际 ${rows}`);
  await h.shoot("02-group-search");
});

await h.check("③ 移动到空间：菜单出现并列出其他组", async () => {
  await win.evaluate(() => {
    const row = document.querySelector(".space-group .task-item");
    const more = [...row.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "更多操作");
    if (more === undefined) throw new Error("行内没找到更多按钮");
    more.click();
  });
  await win.waitForTimeout(300);
  await win.evaluate(() => {
    const item = [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "移动到空间…");
    item.click();
  });
  await win.waitForTimeout(300);
  const sheet = await win.evaluate(() => document.querySelector(".move-sheet") !== null);
  if (!sheet) throw new Error("移动浮层未出现");
  await h.shoot("03-move-sheet");
});

await h.finish();
