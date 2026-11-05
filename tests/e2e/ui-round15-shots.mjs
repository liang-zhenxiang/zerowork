// 第十五轮截图：3 张（快速过滤语法 / 键盘导航 / 行内统计）
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const h = createHarness({ name: "ui-round15-shots", shots: true });
const REPLY = "第十五轮功能验证回复，含足够长度以形成会话记录。\n\n第二段内容。";

const mock = await startMockModelServer({ models: ["r15-model"], reply: REPLY });
const SESSIONS_DIR = join(h.CONFIG_DIR, "sessions");
mkdirSync(SESSIONS_DIR, { recursive: true });
// 种子 4 个会话（不同标题/标签/时间），验证过滤语法与键盘导航
const seed = (n, title, daysAgo) => {
  const id = `aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaa${n}`;
  const t = new Date(Date.now() - daysAgo * 86400000).toISOString();
  const msg = (mid, parentId, role, text) => JSON.stringify({
    type: "message", id: mid, parentId, timestamp: t,
    message: { role, content: [{ type: "text", text }] },
    ...(role === "assistant" ? { model: "r15-model" } : {})
  });
  const lines = [
    JSON.stringify({ type: "session", version: 3, id, timestamp: t, cwd: join(h.WORKSPACE_DIR, "临时任务", "2026-11-06-02-00-00"), title }),
    msg(`${id}-u`, id, "user", title),
    msg(`${id}-a`, `${id}-u`, "assistant", REPLY)
  ];
  const file = join(SESSIONS_DIR, `2026-11-01T00-00-0${n}-000Z_s${n}.jsonl`);
  writeFileSync(file, lines.join("\n") + "\n");
  const past = new Date(Date.now() - daysAgo * 86400000);
  utimesSync(file, past, past);
};
seed(1, "合同整理工作", 1);
seed(2, "学习笔记 JavaScript", 2);
seed(3, "生活采购清单", 10);
seed(4, "紧急修复登录", 0);
seed(5, "周报整理", 2);
seed(6, "季度复盘材料", 5);

await h.launch();
const win = h.window();

await h.check("① 快速过滤语法：label:工作 命中 1 行", async () => {
  // 给第一个会话打「工作」标签（labelStore key=任务 path）
  await win.evaluate(() => {
    const row = document.querySelector(".sidebar [data-path]");
    const store = JSON.parse(window.localStorage.getItem("zw:labels") ?? "{}");
    store[row?.dataset?.path ?? ""] = "工作";
    window.localStorage.setItem("zw:labels", JSON.stringify(store));
    window.dispatchEvent(new CustomEvent("zw:labels-changed", { detail: store }));
  });
  await win.waitForTimeout(400);
  const filter = win.locator('[aria-label="过滤任务"]');
  await filter.fill("label:工作");
  await win.waitForTimeout(400);
  const n = await win.evaluate(() => document.querySelectorAll(".sidebar .task-item-body").length);
  if (n !== 1) throw new Error(`label:工作 应命中 1 行，实际 ${n}`);
});

await h.check("② >3d 语法：命中 ≥3 天未动的 2 行", async () => {
  await win.locator('[aria-label="过滤任务"]').fill(">3d");
  await win.waitForTimeout(400);
  const n = await win.evaluate(() => document.querySelectorAll(".sidebar .task-item-body").length);
  if (n !== 2) throw new Error(`>3d 应命中 2 行（10 天前 + 5 天前），实际 ${n}`);
});

await h.check("③ 键盘导航：↓ 选中第一行、Enter 打开", async () => {
  await win.locator('[aria-label="过滤任务"]').fill("");
  await win.waitForTimeout(300);
  await win.locator('[aria-label="过滤任务"]').press("Escape");
  await win.keyboard.press("ArrowDown");
  await win.waitForTimeout(300);
  // 实现是「视觉高亮」（nav-index class），不是 DOM focus —— Enter 才 click。
  const highlighted = await win.evaluate(() => {
    const rows = [...document.querySelectorAll(".task-list .task-item")].filter((el) => el.offsetParent !== null);
    return rows.findIndex((el) => el.classList.contains("nav-highlight") || el.querySelector(".nav-highlight") !== null);
  });
  if (highlighted !== 0) throw new Error(`ArrowDown 后第一行应高亮，实际 index=${highlighted}`);
  // resumeSession 需要已选模型（无模型抛「还没有选择模型」）——挂 mock。
  await win.evaluate(
    async ({ baseUrl, ws }) => {
      const k = globalThis.kami;
      await k.saveCustomProvider(
        { id: "r15p", name: "R15", baseUrl, api: "openai-completions", authHeader: true,
          models: [{ id: "r15-model", name: "r15-model", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }] },
        "mock-key"
      );
      await k.setModel("r15p/r15-model");
      await k.setWorkspace(ws);
    },
    { baseUrl: mock.baseUrl, ws: h.WORKSPACE_DIR }
  );
  await win.keyboard.press("Enter");
  // resumeSession 是异步 IPC（首次要起会话宿主），轮询等它完成。
  await waitUntil(
    () => win.evaluate(() => document.querySelector(".home") === null),
    { timeout: 15000, desc: "Enter 后离开首页（会话打开）" },
  );
  await h.shoot("01-keyboard-nav");
});

await h.shoot("02-filter-syntax");

await h.finish();
mock.close();
