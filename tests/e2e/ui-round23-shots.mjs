// 第二十三轮截图：3 张（数据链路卡备份+路径 / 体检行 / 备份恢复确认流）
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const h = createHarness({ name: "ui-round23-shots" });
const SESSIONS_DIR = join(h.CONFIG_DIR, "sessions");
mkdirSync(SESSIONS_DIR, { recursive: true });
const tmp = join(h.WORKSPACE_DIR, "临时任务", "2026-11-14-02-00-00");
const seed = (n, title, msgCount) => {
  const id = `aaaaaaaa-2222-4aaa-8aaa-aaaaaaaaaaa${n}`;
  const t = new Date().toISOString();
  const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: t, cwd: tmp, title })];
  for (let i2 = 0; i2 < msgCount; i2++) {
    const role = i2 % 2 === 0 ? "user" : "assistant";
    const text2 = i2 === 0 ? title : `回复 ${i2}`;
    lines.push(JSON.stringify({ type: "message", id: `${id}-m${i2}`, parentId: i2 === 0 ? id : `${id}-m${i2 - 1}`, timestamp: t, message: { role, content: [{ type: "text", text: text2 }] }, ...(role === "assistant" ? { model: "m", usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: 0.001 } } : {}) }));
  }
  writeFileSync(join(SESSIONS_DIR, `s${n}.jsonl`), lines.join("\n") + "\n");
};
seed(1, "数据链路验证会话A", 2);
seed(2, "数据链路验证会话B", 1);

await h.launch();
const win = h.window();
await win.waitForTimeout(2200);

await h.check("① 数据链路卡出现：备份/体检/路径三行", async () => {
  await win.keyboard.press("Meta+k");
  await win.waitForTimeout(400);
  await win.keyboard.type("数据管理");
  await win.waitForTimeout(600);
  await win.keyboard.press("Enter");
  await waitUntil(() => win.evaluate(() => document.querySelector(".data-ops-card") !== null), { timeout: 10000, desc: "数据链路卡出现" });
  const diag = await win.evaluate(() => ({
    backupBtn: [...document.querySelectorAll(".data-ops-card .mini-btn")].some((b) => (b.textContent ?? "") === "备份全部会话"),
    dirShown: (document.body.innerText ?? "").includes("存储位置："),
    health: (document.body.innerText ?? "").match(/体检：.+/) !== null
  }));
  if (!diag.backupBtn) throw new Error("备份按钮未出现");
  if (!diag.dirShown) throw new Error("存储位置未显示");
  if (!diag.health) throw new Error("体检行未显示");
  await h.shoot("01-data-ops-card");
});

await h.check("② 备份动作落盘 .zwbackups 且卡片显示上次备份", async () => {
  await win.evaluate(() => {
    const btn = [...document.querySelectorAll(".data-ops-card .mini-btn")].find((b) => (b.textContent ?? "") === "备份全部会话");
    btn?.click();
  });
  await win.waitForTimeout(800);
  const info = await win.evaluate(async () => {
    const backups = await globalThis.kami.listBackups();
    return { count: backups.length, sessions: (await globalThis.kami.listSessions()).length };
  });
  if (info.count < 1) throw new Error("备份归档未落盘");
  const cardText = await win.evaluate(() => (document.querySelector(".data-ops-card")?.textContent ?? ""));
  if (!cardText.includes("上次备份")) throw new Error("卡片未显示上次备份");
  if (!cardText.includes(`已备份 ${info.sessions}`)) throw new Error(`未显示备份数量：${cardText.slice(0, 80)}`);
  await h.shoot("02-backup-done");
});

await h.check("③ 恢复确认流：确认摘要 + 跳过同名", async () => {
  await win.evaluate(() => {
    const btn = [...document.querySelectorAll(".data-ops-card .mini-btn")].find((b) => (b.textContent ?? "") === "从最近备份恢复");
    btn?.click();
  });
  await win.waitForTimeout(400);
  const confirm = await win.evaluate(() => document.querySelector(".data-ops-confirm") !== null);
  if (!confirm) throw new Error("恢复确认摘要未出现");
  await win.evaluate(() => {
    const btn = [...document.querySelectorAll(".data-ops-confirm .mini-btn")].find((b) => (b.textContent ?? "") === "确认恢复");
    btn?.click();
  });
  await waitUntil(() => win.evaluate(() => (document.querySelector(".data-ops-card")?.textContent ?? "").includes("恢复完成")), { timeout: 10000, desc: "恢复完成文案出现" });
  const result = await win.evaluate(() => (document.querySelector(".data-ops-card")?.textContent ?? ""));
  if (!result.includes("跳过同名 2 个")) throw new Error(`应跳过同名 2 个：${result.slice(0, 120)}`);
  await h.shoot("03-restore-skip");
});

await h.finish();
