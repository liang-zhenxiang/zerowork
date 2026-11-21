// 第二十八轮截图：4 张（筛选 chips / 统计行 / 最近搜索 / 复制结果）
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const h = createHarness({ name: "ui-round28-shots", shots: true });
const SESSIONS_DIR = join(h.CONFIG_DIR, "sessions");
mkdirSync(SESSIONS_DIR, { recursive: true });
const tmp = join(h.WORKSPACE_DIR, "会议纪要项目", "2026-11-22-02-00-00");
const t0 = Date.now();
const mkSession = (idx, title, userText, asstText, daysAgo) => {
  const id = `aaaaaaaa-7777-4aaa-8aaa-aaaaaaaaaaa${idx}`;
  const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(t0 - daysAgo * 864e5).toISOString(), cwd: tmp, title })];
  const msgs = [
    { role: "user", text: userText },
    { role: "assistant", text: asstText },
    { role: "user", text: "会议纪要格式再发一遍" },
    { role: "assistant", text: `会议纪要：\n- 结论：OK\n- 待办：跟进` }
  ];
  for (let i2 = 0; i2 < msgs.length; i2++) {
    const m = msgs[i2];
    lines.push(JSON.stringify({ type: "message", id: `${id}-m${i2}`, parentId: i2 === 0 ? id : `${id}-m${i2-1}`, timestamp: new Date(t0 - daysAgo * 864e5 + i2 * 60000).toISOString(), message: { role: m.role, content: [{ type: "text", text: m.text }] }, ...(m.role === "assistant" ? { model: "m" } : {}) }));
  }
  const filePath = join(SESSIONS_DIR, `s${idx}.jsonl`);
  writeFileSync(filePath, lines.join("\n") + "\n");
  /* daemon 的 modifiedAt 取文件 mtime——把 mtime 拨到 daysAgo 前才能让时间筛选命中。 */
  const past = new Date(t0 - daysAgo * 864e5);
  utimesSync(filePath, past, past);
};
mkSession(1, "周会讨论", "帮我整理一份会议纪要模板", "好的，这是会议纪要模板。", 0);
mkSession(2, "项目复盘", "上次项目会议纪要里提到哪些待办？", "会议纪要里的待办是这些。", 3);
mkSession(3, "旧归档会话", "很早之前的会议纪要", "好的。", 40);

await h.launch();
const win = h.window();
await win.waitForTimeout(2400);

await h.check("① 会话检索基础命中 + 统计行", async () => {
  await win.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((el) => (el.textContent ?? "").includes("会话检索"));
    btn?.click();
  });
  await waitUntil(() => win.evaluate(() => document.querySelector(".ss-input") !== null), { timeout: 10000, desc: "检索页出现" });
  await win.evaluate(() => {
    const input = document.querySelector(".ss-input");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "会议纪要");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await waitUntil(() => win.evaluate(() => [...document.querySelectorAll(".ss-hit")].length > 0), { timeout: 15000, desc: "命中出现" });
  await waitUntil(() => win.evaluate(() => document.querySelector(".ss-stats") !== null), { timeout: 5000, desc: "统计行出现" });
  const stats = await win.evaluate(() => (document.querySelector(".ss-stats")?.textContent ?? "").replace(/\s+/g, " ").trim());
  if (!stats.includes("处命中")) throw new Error(`统计行缺失：${stats}`);
  await h.shoot("01-stats-row");
});

await h.check("② 角色筛选：它答的只留 assistant 命中", async () => {
  await win.evaluate(() => {
    const chips = [...document.querySelectorAll(".ss-filter-group")].find((g) => g.getAttribute("aria-label") === "角色筛选");
    const chip = [...(chips?.querySelectorAll("button") ?? [])].find((el) => (el.textContent ?? "") === "它答的");
    chip?.click();
  });
  await win.waitForTimeout(400);
  const diag = await win.evaluate(() => ({
    active: [...document.querySelectorAll(".ss-chip.is-active")].map((el) => (el.textContent ?? "").trim()),
    groups: document.querySelectorAll(".ss-filter-group").length
  }));
  console.log("DIAG2:", JSON.stringify(diag));
  const rawRoles = await win.evaluate(() => [...document.querySelectorAll(".ss-hit-role")].map((el) => el.textContent));
  console.log("RAW:", JSON.stringify(rawRoles));
  const roles = await win.evaluate(() => [...document.querySelectorAll(".ss-hit-role")].map((el) => (el.textContent ?? "").trim()));
  if (roles.length === 0) throw new Error("筛选后命中为空");
  if (roles.some((r) => r !== "它答的")) throw new Error(`角色筛选未生效：${JSON.stringify(roles)}`);
  await h.shoot("02-role-filter");
  // 恢复全部
  await win.evaluate(() => {
    const chips = [...document.querySelectorAll(".ss-filter-group")].find((g) => g.getAttribute("aria-label") === "角色筛选");
    const chip = [...(chips?.querySelectorAll("button") ?? [])].find((el) => (el.textContent ?? "") === "全部");
    chip?.click();
  });
  await win.waitForTimeout(300);
});

await h.check("③ 时间范围筛选：7 天内排除 40 天前的旧会话", async () => {
  const before = await win.evaluate(() => new Set([...document.querySelectorAll(".ss-session-title")].map((el) => el.textContent)).size);
  await win.evaluate(() => {
    const chips = [...document.querySelectorAll(".ss-filter-group")].find((g) => g.getAttribute("aria-label") === "时间范围筛选");
    const chip = [...(chips?.querySelectorAll("button") ?? [])].find((el) => (el.textContent ?? "") === "7 天内");
    chip?.click();
  });
  await win.waitForTimeout(400);
  const after = await win.evaluate(() => {
    const titles = new Set([...document.querySelectorAll(".ss-session-title")].map((el) => el.textContent));
    return { count: titles.size, hasOld: [...titles].some((t) => (t ?? "").includes("旧归档会话")) };
  });
  if (after.count >= before) throw new Error(`7 天筛选未缩小范围：before=${before} after=${after.count}`);
  if (after.hasOld) throw new Error("40 天前的会话未被 7 天筛选排除");
  await h.shoot("03-time-filter");
});

await h.check("④ 最近搜索记录 + 复制结果", async () => {
  await win.evaluate(() => {
    const input = document.querySelector(".ss-input");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await win.waitForTimeout(400);
  const recent = await win.evaluate(() => [...document.querySelectorAll(".ss-recent .ss-chip")].map((el) => (el.textContent ?? "").trim()));
  if (!recent.includes("会议纪要")) throw new Error(`最近搜索缺「会议纪要」：${JSON.stringify(recent)}`);
  await h.shoot("04-recent-searches");
  // 点最近搜索回填
  await win.evaluate(() => {
    const chip = [...document.querySelectorAll(".ss-recent .ss-chip")].find((el) => (el.textContent ?? "").trim() === "会议纪要");
    chip?.click();
  });
  await win.waitForTimeout(1500);
  const hitsBack = await win.evaluate(() => [...document.querySelectorAll(".ss-hit")].length);
  if (hitsBack === 0) throw new Error("点最近搜索后未恢复命中");
});

await h.finish();
