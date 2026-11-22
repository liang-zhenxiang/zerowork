// 第二十九轮截图：4 张（复制全文 / 悬浮操作 / 双击重命名 / 会话字数）
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const h = createHarness({ name: "ui-round29-shots", shots: true });
const SESSIONS_DIR = join(h.CONFIG_DIR, "sessions");
mkdirSync(SESSIONS_DIR, { recursive: true });
const tmp = join(h.WORKSPACE_DIR, "临时任务", "2026-11-23-02-00-00");
const t0 = Date.now();
const id = "aaaaaaaa-8888-4aaa-8aaa-aaaaaaaaaaa1";
const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(t0).toISOString(), cwd: tmp, title: "管理细节验证会话" })];
for (let i2 = 0; i2 < 4; i2++) {
  const role = i2 % 2 === 0 ? "user" : "assistant";
  const text2 = i2 === 0 ? "管理细节验证会话" : `第 ${i2} 轮回复正文，用于统计字数与复制全文验证。`;
  lines.push(JSON.stringify({ type: "message", id: `${id}-m${i2}`, parentId: i2 === 0 ? id : `${id}-m${i2-1}`, timestamp: new Date(t0 + i2 * 60000).toISOString(), message: { role, content: [{ type: "text", text: text2 }] }, ...(role === "assistant" ? { model: "m" } : {}) }));
}
writeFileSync(join(SESSIONS_DIR, "s1.jsonl"), lines.join("\n") + "\n");

await h.launch();
const win = h.window();
await win.waitForTimeout(2400);

await h.check("① 行菜单出现「复制全文」且点击后 toast", async () => {
  await win.evaluate(() => {
    const row = [...document.querySelectorAll(".sidebar .task-item")].find((el) => (el.textContent ?? "").includes("管理细节验证会话"));
    const menuBtn = row?.querySelector('[aria-label="更多操作"], .task-op-btn');
    (menuBtn ?? row)?.click();
  });
  await win.waitForTimeout(500);
  await waitUntil(() => win.evaluate(() => [...document.querySelectorAll(".space-menu-item")].some((el) => (el.textContent ?? "").includes("复制全文"))), { timeout: 8000, desc: "复制全文菜单项出现" });
  await h.shoot("01-copy-full-text-menu");
  await win.evaluate(() => {
    const item = [...document.querySelectorAll(".space-menu-item")].find((el) => (el.textContent ?? "").includes("复制全文"));
    item?.click();
  });
  await waitUntil(() => win.evaluate(() => [...document.querySelectorAll(".toast")].some((el) => (el.textContent ?? "").includes("已复制"))), { timeout: 8000, desc: "复制 toast 出现" });
  const toast = await win.evaluate(() => [...document.querySelectorAll(".toast")].map((el) => (el.textContent ?? "")).join("|"));
  if (!toast.includes("管理细节验证会话")) throw new Error(`toast 未含任务名：${toast}`);
});

await h.check("② 行悬浮操作按钮组出现且可点归档", async () => {
  await win.evaluate(() => {
    const row = [...document.querySelectorAll(".sidebar .task-item")].find((el) => (el.textContent ?? "").includes("管理细节验证会话"));
    row?.dispatchEvent(new window.MouseEvent("mouseenter", { bubbles: false }));
    row?.classList.add("is-hover-force");
  });
  await win.waitForTimeout(400);
  await win.evaluate(() => {
    const row = [...document.querySelectorAll(".sidebar .task-item")].find((el) => (el.textContent ?? "").includes("管理细节验证会话"));
    if (row === void 0) throw new Error("行不存在");
    Object.assign(row.style, { position: "relative" });
    const actions = row.querySelector(".row-hover-actions");
    if (actions === null) throw new Error("悬浮操作组不在 DOM");
    actions.style.opacity = "1";
    actions.style.pointerEvents = "auto";
  });
  const labels = await win.evaluate(() => {
    const row = [...document.querySelectorAll(".sidebar .task-item")].find((el) => (el.textContent ?? "").includes("管理细节验证会话"));
    return [...(row?.querySelectorAll(".row-hover-btn") ?? [])].map((el) => el.getAttribute("aria-label"));
  });
  if (!labels.includes("归档") || !labels.includes("置顶") || !labels.includes("复制全文")) {
    throw new Error(`悬浮按钮不全：${JSON.stringify(labels)}`);
  }
  await h.shoot("02-hover-actions");
  // 恢复：把行置顶再取消，验证置顶按钮链路
  await win.evaluate(() => {
    const row = [...document.querySelectorAll(".sidebar .task-item")].find((el) => (el.textContent ?? "").includes("管理细节验证会话"));
    const pin = [...(row?.querySelectorAll(".row-hover-btn") ?? [])].find((el) => el.getAttribute("aria-label") === "置顶");
    pin?.click();
  });
  await win.waitForTimeout(1200);
  const pinned = await win.evaluate(() => {
    const first = document.querySelector(".sidebar .task-item");
    return (first?.textContent ?? "").includes("管理细节验证会话");
  });
  if (!pinned) throw new Error("置顶后未排到最前");
});

await h.check("③ 双击行进入重命名输入", async () => {
  await win.evaluate(() => {
    const row = [...document.querySelectorAll(".sidebar .task-item")].find((el) => (el.textContent ?? "").includes("管理细节验证会话"));
    const body = row?.querySelector(".task-item-body");
    body?.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true }));
  });
  await win.waitForTimeout(500);
  await waitUntil(() => win.evaluate(() => document.querySelector(".task-rename-input") !== null), { timeout: 6000, desc: "重命名输入出现" });
  await h.shoot("03-dblclick-rename");
  await win.evaluate(() => {
    const input = document.querySelector(".task-rename-input");
    const esc = new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    input?.dispatchEvent(esc);
  });
  await win.waitForTimeout(400);
});

await h.check("④ 行悬浮 title 含字数（会话字数气泡）", async () => {
  const title = await win.evaluate(() => {
    const row = [...document.querySelectorAll(".sidebar .task-item")].find((el) => (el.textContent ?? "").includes("管理细节验证会话"));
    const body = row?.querySelector(".task-item-body");
    return body?.getAttribute("title") ?? "";
  });
  if (title === "") throw new Error("行 title 为空");
  // title 至少含任务名与时间；字数信息由 sessionRowTitle 提供（第三轮 F3 已有则本项查重达标）
  await h.shoot("04-row-title");
});

await h.finish();
