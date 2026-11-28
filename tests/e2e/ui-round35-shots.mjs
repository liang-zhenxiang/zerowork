// 第三十五轮截图：4 张（复制最后回复 / 归档当前 / ⌘G 跳底 / ⌘L 聚焦 / 拼音提示）
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const h = createHarness({ name: "ui-round35-shots", shots: true });
const mock = await startMockModelServer({ models: ["r35-model"], reply: "第三十五轮快捷键验证回复正文。" });
const SESSIONS_DIR = join(h.CONFIG_DIR, "sessions");
mkdirSync(SESSIONS_DIR, { recursive: true });
const tmp = join(h.WORKSPACE_DIR, "临时任务", "2026-11-29-02-00-00");
const id = "aaaaaaaa-3535-4aaa-8aaa-aaaaaaaaaaa1";
const t0 = Date.now();
const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(t0).toISOString(), cwd: tmp, title: "会议纪要整理" })];
for (let i2 = 0; i2 < 2; i2++) {
  const role = i2 % 2 === 0 ? "user" : "assistant";
  const text2 = i2 === 0 ? "会议纪要整理" : "回复正文。";
  lines.push(JSON.stringify({ type: "message", id: `${id}-m${i2}`, parentId: i2 === 0 ? id : `${id}-m${i2-1}`, timestamp: new Date(t0 + i2 * 60000).toISOString(), message: { role, content: [{ type: "text", text: text2 }] }, ...(role === "assistant" ? { model: "r35-model" } : {}) }));
}
writeFileSync(join(SESSIONS_DIR, "s1.jsonl"), lines.join("\n") + "\n");

await h.launch();
const win = h.window();
await win.waitForTimeout(2400);
await h.dismissWhatsNew();
await win.evaluate(async ({ baseUrl, ws }) => {
  const k = globalThis.kami;
  await k.saveCustomProvider({ id: "r35p", name: "R35", baseUrl, api: "openai-completions", authHeader: true, models: [{ id: "r35-model", name: "r35-model", reasoning: false, vision: false, contextWindow: 32000, maxTokens: 8192 }] }, "k");
  await k.setModel("r35p/r35-model");
  await k.setWorkspace(ws);
}, { baseUrl: mock.baseUrl, ws: h.WORKSPACE_DIR });
await win.waitForTimeout(2000);

await h.check("① ⌘⇧C 复制最后回复", async () => {
  await win.evaluate(() => {
    const row = [...document.querySelectorAll(".sidebar .task-item")].find((el) => (el.textContent ?? "").includes("会议纪要整理"));
    row?.querySelector(".task-item-body")?.click();
  });
  await win.waitForTimeout(4000);
  await win.keyboard.press("Meta+Shift+c");
  await waitUntil(() => win.evaluate(() => [...document.querySelectorAll(".toast")].some((el) => (el.textContent ?? "").includes("已复制最后一条回复"))), { timeout: 6000, desc: "复制 toast 出现" });
  await h.shoot("01-copy-last-reply");
});

await h.check("② ⌘G 跳到最新消息", async () => {
  await win.evaluate(() => {
    const stream = document.querySelector(".stream");
    stream?.scrollTo({ top: 0 });
  });
  await win.waitForTimeout(400);
  await win.keyboard.press("Meta+g");
  await win.waitForTimeout(900);
  const atBottom = await win.evaluate(() => {
    const el = document.querySelector(".stream");
    if (el === null) return false;
    return el.scrollTop >= el.scrollHeight - el.clientHeight - 50;
  });
  if (!atBottom) throw new Error("⌘G 未滚到底部");
  await h.shoot("02-jump-bottom");
});

await h.check("③ ⌘L 聚焦输入框", async () => {
  await win.evaluate(() => document.activeElement?.blur());
  await win.keyboard.press("Meta+l");
  await win.waitForTimeout(400);
  const focused = await win.evaluate(() => document.activeElement?.getAttribute("aria-label") === "消息输入框");
  if (!focused) throw new Error("⌘L 未聚焦输入框");
  await h.shoot("03-focus-composer");
});

await h.check("④ 拼音首字母提示：全文无命中时提示会话名", async () => {
  await win.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((el) => (el.textContent ?? "").includes("会话检索"));
    btn?.click();
  });
  await waitUntil(() => win.evaluate(() => document.querySelector(".ss-input") !== null), { timeout: 10000, desc: "检索页出现" });
  await win.evaluate(() => {
    const input = document.querySelector(".ss-input");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "hyj");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await win.waitForTimeout(2500);
  await waitUntil(() => win.evaluate(() => (document.body.textContent ?? "").includes("首字母")), { timeout: 8000, desc: "拼音提示出现" });
  const hintTitles = await win.evaluate(() => [...document.querySelectorAll(".ss-pinyin-hint .ss-chip")].map((el) => (el.textContent ?? "").trim()));
  if (!hintTitles.includes("会议纪要整理")) throw new Error(`拼音提示未命中会话名：${JSON.stringify(hintTitles)}`);
  await h.shoot("04-pinyin-hint");
});

await h.finish();
mock.close().catch(() => {});
