// 第二十七轮截图：3 张（模型引导条 / 新功能速览浮层 / 免打扰延续确认）
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const h = createHarness({ name: "ui-round27-shots", shots: true });
const mock = await startMockModelServer({ models: ["r27-model"], reply: "回复" });
const SESSIONS_DIR = join(h.CONFIG_DIR, "sessions");
mkdirSync(SESSIONS_DIR, { recursive: true });
const tmp = join(h.WORKSPACE_DIR, "临时任务", "2026-11-21-02-00-00");
const id = "aaaaaaaa-6666-4aaa-8aaa-aaaaaaaaaaa1";
const t0 = Date.now();
const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(t0).toISOString(), cwd: tmp, title: "首启引导验证会话" })];
for (let i2 = 0; i2 < 4; i2++) {
  const role = i2 % 2 === 0 ? "user" : "assistant";
  const text2 = i2 === 0 ? "首启引导验证会话" : `回复 ${i2}`;
  lines.push(JSON.stringify({ type: "message", id: `${id}-m${i2}`, parentId: i2 === 0 ? id : `${id}-m${i2-1}`, timestamp: new Date(t0 + i2 * 60000).toISOString(), message: { role, content: [{ type: "text", text: text2 }] }, ...(role === "assistant" ? { model: "r27-model" } : {}) }));
}
writeFileSync(join(SESSIONS_DIR, "s1.jsonl"), lines.join("\n") + "\n");

await h.launch();
const win = h.window();
await win.waitForTimeout(2400);

await h.check("① 关于页「本版本新东西」列表", async () => {
  await win.evaluate(() => {
    const button = document.querySelector('[aria-label="设置"]');
    if (button === null) throw new Error("找不到设置按钮");
    button.click();
  });
  await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") !== null), { timeout: 10000, desc: "设置对话框挂上" });
  await win.evaluate(() => {
    const items = [...document.querySelectorAll(".settings-nav-item")];
    const hit = items.find((item) => (item.textContent ?? "").trim() === "关于");
    if (hit === void 0) throw new Error("设置侧栏里找不到「关于」");
    hit.click();
  });
  await waitUntil(() => win.evaluate(() => (document.body.textContent ?? "").includes("本版本新东西")), { timeout: 8000, desc: "本版本新东西分组出现" });
  const items = await win.evaluate(() => document.querySelectorAll(".whats-new-item").length);
  if (items < 3) throw new Error(`速览条目不足：${items}`);
  await h.shoot("01-whats-new");
});

await h.check("② 配置模型后引导条消失（刷新后不再弹速览）", async () => {
  // 配置模型（modelsCount 变 1 → 引导条隐藏）
  await win.evaluate(async ({ baseUrl, ws }) => {
    const k = globalThis.kami;
    await k.saveCustomProvider({ id: "r27p", name: "R27", baseUrl, api: "openai-completions", authHeader: true, models: [{ id: "r27-model", name: "r27-model", reasoning: false, vision: false, contextWindow: 32000, maxTokens: 8192 }] }, "k");
    await k.setModel("r27p/r27-model");
    await k.setWorkspace(ws);
  }, { baseUrl: mock.baseUrl, ws: h.WORKSPACE_DIR });
  // 引导条随 modelsCount 轮询（≤15s）消失
  await waitUntil(() => win.evaluate(() => document.querySelector(".model-guide-banner") === null), { timeout: 18000, desc: "引导条随模型配置消失" });
  const stillListed = await win.evaluate(() => (document.body.textContent ?? "").includes("本版本新东西"));
  if (!stillListed) throw new Error("关于页新东西列表消失");
  await h.shoot("02-after-config");
});

await h.check("③ 首页与既有链路回归：能打开会话", async () => {
  await win.evaluate(() => {
    const row = [...document.querySelectorAll(".sidebar .task-item")].find((el) => (el.textContent ?? "").includes("首启引导验证会话"));
    row?.querySelector(".task-item-body")?.click();
  });
  await win.waitForTimeout(5000);
  const chat = await win.evaluate(() => document.querySelector(".chat") !== null && document.querySelectorAll(".turn-group").length > 0);
  if (!chat) throw new Error("会话未正常打开");
  await h.shoot("03-session-open");
});

await h.finish();
mock.close().catch(() => {});
