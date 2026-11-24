// 第三十一轮截图：4 张（斜杠导航 / 长文本确认 / 草稿保存提示 / 粘贴 toast）
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const h = createHarness({ name: "ui-round31-shots", shots: true });
const mock = await startMockModelServer({ models: ["r31-model"], reply: "回复" });
const SESSIONS_DIR = join(h.CONFIG_DIR, "sessions");
mkdirSync(SESSIONS_DIR, { recursive: true });
const tmp = join(h.WORKSPACE_DIR, "临时任务", "2026-11-25-02-00-00");
const id = "aaaaaaaa-3131-4aaa-8aaa-aaaaaaaaaaa1";
const t0 = Date.now();
const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(t0).toISOString(), cwd: tmp, title: "Composer 体验验证" })];
for (let i2 = 0; i2 < 2; i2++) {
  const role = i2 % 2 === 0 ? "user" : "assistant";
  const text2 = i2 === 0 ? "Composer 体验验证" : "回复正文。";
  lines.push(JSON.stringify({ type: "message", id: `${id}-m${i2}`, parentId: i2 === 0 ? id : `${id}-m${i2-1}`, timestamp: new Date(t0 + i2 * 60000).toISOString(), message: { role, content: [{ type: "text", text: text2 }] }, ...(role === "assistant" ? { model: "r31-model" } : {}) }));
}
writeFileSync(join(SESSIONS_DIR, "s1.jsonl"), lines.join("\n") + "\n");

await h.launch();
const win = h.window();
await win.waitForTimeout(2400);
await h.dismissWhatsNew();
await win.evaluate(async ({ baseUrl, ws }) => {
  const k = globalThis.kami;
  await k.saveCustomProvider({ id: "r31p", name: "R31", baseUrl, api: "openai-completions", authHeader: true, models: [{ id: "r31-model", name: "r31-model", reasoning: false, vision: false, contextWindow: 32000, maxTokens: 8192 }] }, "k");
  await k.setModel("r31p/r31-model");
  await k.setWorkspace(ws);
}, { baseUrl: mock.baseUrl, ws: h.WORKSPACE_DIR });
await win.evaluate(() => {
  const row = [...document.querySelectorAll(".sidebar .task-item")].find((el) => (el.textContent ?? "").includes("Composer 体验验证"));
  row?.querySelector(".task-item-body")?.click();
});
await win.waitForTimeout(4000);

await h.check("① 斜杠菜单键盘导航（↓ 高亮移动 / Enter 执行）", async () => {
  const ta = win.locator('[aria-label="消息输入框"]');
  await ta.fill("/");
  await win.waitForTimeout(400);
  await win.keyboard.press("ArrowDown");
  await win.waitForTimeout(200);
  const active = await win.evaluate(() => {
    const items = [...document.querySelectorAll(".slash-menu-item")];
    const idx = items.findIndex((el) => el.classList.contains("is-active"));
    return { idx, total: items.length, label: items[idx]?.getAttribute("aria-label") ?? items[idx]?.textContent };
  });
  if (active.idx !== 1) throw new Error(`↓ 后高亮应在第 2 项：${JSON.stringify(active)}`);
  await h.shoot("01-slash-nav");
  await win.keyboard.press("Enter");
  await win.waitForTimeout(800);
  const ran = await win.evaluate(() => (document.body.textContent ?? "").includes("使用统计") || (document.body.textContent ?? "").includes("统计"));
  if (!ran) throw new Error("Enter 未执行选中命令");
  await win.evaluate(() => {
    const back = [...document.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === "返回");
    back?.click();
  });
  await win.waitForTimeout(500);
});

await h.check("② 长文本发送确认面板", async () => {
  const ta = win.locator('[aria-label="消息输入框"]');
  await ta.fill("这是一条超过两千字的测试消息。".repeat(150));
  await win.keyboard.press("Enter");
  await win.waitForTimeout(500);
  await waitUntil(() => win.evaluate(() => document.querySelector(".long-text-confirm") !== null), { timeout: 6000, desc: "确认面板出现" });
  const body = await win.evaluate(() => {
    const el = document.querySelector(".long-text-confirm");
    return el === null ? "" : (el.textContent ?? "");
  });
  if (!body.includes("确定要发送吗")) throw new Error(`面板文案缺失：${body.slice(0, 80)}`);
  await h.shoot("02-long-text-confirm");
  // 「发送」走真实链路
  await win.evaluate(() => {
    const btn = [...document.querySelectorAll(".long-text-confirm-actions .mini-btn")].find((b) => (b.textContent ?? "") === "发送");
    btn?.click();
  });
  await win.waitForTimeout(2500);
  const sent = await win.evaluate(() => document.querySelectorAll(".entry").length >= 2);
  if (!sent) throw new Error("确认发送后消息未提交");
});

await h.check("③ 草稿自动保存微提示", async () => {
  const ta = win.locator('[aria-label="消息输入框"]');
  await ta.fill("草稿自动保存验证");
  await waitUntil(() => win.evaluate(() => document.querySelector(".draft-saved-hint") !== null), { timeout: 4000, desc: "已自动保存提示出现" });
  await h.shoot("03-draft-saved");
  await win.waitForTimeout(2200);
  const faded = await win.evaluate(() => document.querySelector(".draft-saved-hint") === null);
  if (!faded) throw new Error("提示未淡出");
});

await h.check("④ 附件添加 toast", async () => {
  await win.evaluate(() => {
    window.dispatchEvent(new CustomEvent("zw:toast", { detail: [{ type: "success", text: "已添加附件：test.png（12 KB）" }] }));
  });
  await waitUntil(() => win.evaluate(() => [...document.querySelectorAll(".toast")].some((el) => (el.textContent ?? "").includes("已添加附件"))), { timeout: 5000, desc: "附件 toast 渲染" });
  await h.shoot("04-attachment-toast");
});

await h.finish();
mock.close().catch(() => {});
