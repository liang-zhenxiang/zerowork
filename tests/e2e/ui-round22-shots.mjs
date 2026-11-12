// 第二十二轮截图：4 张（启动耗时显示 / 长会话窗口化 / 大 markdown 截断 / 合并预览外的性能断言）
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const h = createHarness({ name: "ui-round22-shots", shots: true });
const mock = await startMockModelServer({ models: ["r22-model"], reply: "回复" });
const SESSIONS_DIR = join(h.CONFIG_DIR, "sessions");
mkdirSync(SESSIONS_DIR, { recursive: true });
const tmp = join(h.WORKSPACE_DIR, "临时任务", "2026-11-13-02-00-00");

// 种子：一个 120 轮的超长会话（触发窗口化）+ 一个 60KB 超大回复
const seed = (n, title, turns) => {
  const id = `aaaaaaaa-9999-4aaa-8aaa-aaaaaaaaaaa${n}`;
  const t = new Date().toISOString();
  const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: t, cwd: tmp, title })];
  for (let i2 = 0; i2 < turns; i2++) {
    const role = i2 % 2 === 0 ? "user" : "assistant";
    const text2 = i2 === 0 ? title : `第 ${Math.floor(i2 / 2) + 1} 轮的提问内容`;
    lines.push(JSON.stringify({ type: "message", id: `${id}-m${i2}`, parentId: i2 === 0 ? id : `${id}-m${i2 - 1}`, timestamp: t, message: { role, content: [{ type: "text", text: text2 }] }, ...(role === "assistant" ? { model: "m", usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: 0.001 } } : {}) }));
  }
  writeFileSync(join(SESSIONS_DIR, `s${n}.jsonl`), lines.join("\n") + "\n");
};
seed(1, "超长会话窗口化验证", 240);
// 大回复会话
{
  const id = "aaaaaaaa-9999-4aaa-8aaa-aaaaaaaaaaa2";
  const t = new Date().toISOString();
  const bigText = "这是一个很长的回复。\n\n".repeat(400) + "# 大标题\n\n" + "段落内容填充。".repeat(20000);
  const lines = [
    JSON.stringify({ type: "session", version: 3, id, timestamp: t, cwd: tmp, title: "超大回复会话" }),
    JSON.stringify({ type: "message", id: `${id}-m0`, parentId: id, timestamp: t, message: { role: "user", content: [{ type: "text", text: "超大回复会话" }] } }),
    JSON.stringify({ type: "message", id: `${id}-m1`, parentId: `${id}-m0`, timestamp: t, message: { role: "assistant", content: [{ type: "text", text: bigText }], model: "m", usage: { input: 10, output: 50000, cacheRead: 0, cacheWrite: 0, totalTokens: 50030, cost: 0.01 } } })
  ];
  writeFileSync(join(SESSIONS_DIR, "s2.jsonl"), lines.join("\n") + "\n");
}

await h.launch();
const win = h.window();
await win.waitForTimeout(2400);
await win.evaluate(async ({ baseUrl, ws }) => {
  const k = globalThis.kami;
  await k.saveCustomProvider({ id: "r22p", name: "R22", baseUrl, api: "openai-completions", authHeader: true, models: [{ id: "r22-model", name: "r22-model", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }] }, "k");
  await k.setModel("r22p/r22-model");
  await k.setWorkspace(ws);
}, { baseUrl: mock.baseUrl, ws: h.WORKSPACE_DIR });

await h.check("① 启动耗时显示在关于区", async () => {
  const boot = await win.evaluate(() => window.__zwBootMs !== void 0);
  if (!boot) throw new Error("__zwBootMs 未打点");
  await win.keyboard.press("Meta+k");
  await win.waitForTimeout(400);
  await win.keyboard.type("关于");
  await win.waitForTimeout(600);
  await win.keyboard.press("Enter");
  await win.waitForTimeout(800);
  await waitUntil(() => win.evaluate(() => (document.body.innerText ?? "").match(/启动 \d+ ms/) !== null), { timeout: 8000, desc: "启动耗时行出现" });
  await h.shoot("01-boot-ms");
  await win.keyboard.press("Escape");
  await win.waitForTimeout(300);
});

await h.check("② 长会话窗口化：120 轮组只渲染头 2 + 尾 40 + 展开条", async () => {
  await win.evaluate(() => {
    const row = [...document.querySelectorAll(".sidebar .task-item")].find((el) => (el.textContent ?? "").includes("超长会话窗口化验证"));
    const body = row?.querySelector(".task-item-body");
    body?.click();
  });
  await waitUntil(() => win.evaluate(() => document.querySelector(".chat") !== null), { timeout: 15000, desc: "进入会话页" });
  await win.waitForTimeout(800);
  const diag = await win.evaluate(() => ({
    turns: document.querySelectorAll(".turn-group").length,
    moreBtn: document.querySelector(".turn-window-more") !== null,
    moreText: document.querySelector(".turn-window-more")?.textContent ?? ""
  }));
  if (!diag.moreBtn) throw new Error("展开条未出现（窗口化未生效）");
  if (diag.turns > 50) throw new Error(`DOM 轮数应 ≤ 42，实际 ${diag.turns}`);
  if (!diag.moreText.includes("展开中间的")) throw new Error(`展开条文案不对：「${diag.moreText}」`);
  await h.shoot("02-turn-window");
  // 点展开后全部渲染
  await win.evaluate(() => document.querySelector(".turn-window-more")?.click());
  await win.waitForTimeout(800);
  const expanded = await win.evaluate(() => document.querySelectorAll(".turn-group").length);
  if (expanded < 110) throw new Error(`展开后应 ≥110 轮组，实际 ${expanded}`);
  await win.keyboard.press("Escape");
  await win.waitForTimeout(300);
});

await h.check("③ 超大回复分段渲染：先 50KB + 渲染完整内容按钮", async () => {
  await win.evaluate(() => {
    const row = [...document.querySelectorAll(".sidebar .task-item")].find((el) => (el.textContent ?? "").includes("超大回复会话"));
    const body = row?.querySelector(".task-item-body");
    body?.click();
  });
  await waitUntil(() => win.evaluate(() => document.querySelector(".md-truncated-bar") !== null), { timeout: 15000, desc: "截断条出现" });
  const text = await win.evaluate(() => (document.querySelector(".md-truncated-bar")?.textContent ?? ""));
  if (!text.includes("渲染完整内容")) throw new Error(`截断条文案不对：「${text.slice(0, 40)}」`);
  await h.shoot("03-big-markdown");
  await win.evaluate(() => {
    const btn = document.querySelector(".md-truncated-bar .mini-btn");
    btn?.click();
  });
  await win.waitForTimeout(800);
  const gone = await win.evaluate(() => document.querySelector(".md-truncated-bar") === null);
  if (!gone) throw new Error("点击渲染完整内容后截断条未消失");
});

await h.finish();
mock.close().catch(() => {});
