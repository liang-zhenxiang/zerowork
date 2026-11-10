// 第二十轮截图：4 张（片段库条目 / 模板变量 / 合并预览 / 知识库聚合）
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const h = createHarness({ name: "ui-round20-shots" });
const SESSIONS_DIR = join(h.CONFIG_DIR, "sessions");
mkdirSync(SESSIONS_DIR, { recursive: true });
const id = "aaaaaaaa-7777-4aaa-8aaa-aaaaaaaaaaa1";
const tmp = join(h.WORKSPACE_DIR, "临时任务", "2026-11-11-02-00-00");
const t = new Date().toISOString();
const lines = [
  JSON.stringify({ type: "session", version: 3, id, timestamp: t, cwd: tmp, title: "二十轮验证会话" }),
  JSON.stringify({ type: "message", id: `${id}-m0`, parentId: id, timestamp: t, message: { role: "user", content: [{ type: "text", text: "二十轮验证会话" }] } }),
  JSON.stringify({ type: "message", id: `${id}-m1`, parentId: `${id}-m0`, timestamp: t, message: { role: "assistant", content: [{ type: "text", text: "回复" }], model: "m", usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: 0.001 } } })
];
writeFileSync(join(SESSIONS_DIR, "s1.jsonl"), lines.join("\n") + "\n");

// 预置：片段（带标签）+ 模板（带变量）+ 短语
writeFileSync(join(h.CONFIG_DIR, "preferences.json"), JSON.stringify({ userNickname: "阿梁" }), "utf8");

const mock = await startMockModelServer({ models: ["r20-model"], reply: "回复" });
await h.launch();
const win = h.window();
await win.waitForTimeout(2200);
await win.evaluate(async ({ baseUrl, ws }) => {
  const k = globalThis.kami;
  await k.saveCustomProvider({ id: "r20p", name: "R20", baseUrl, api: "openai-completions", authHeader: true, models: [{ id: "r20-model", name: "r20-model", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }] }, "k");
  await k.setModel("r20p/r20-model");
  await k.setWorkspace(ws);
}, { baseUrl: mock.baseUrl, ws: h.WORKSPACE_DIR });

await h.check("① ⌘K 搜「片段」出片段条目 + 插入草稿", async () => {
  await win.evaluate(() => {
    localStorage.setItem("zw:snippets", JSON.stringify([{ text: "这是要插入的片段内容，包含关键结论。", tag: "结论", at: Date.now() }]));
  });
  // insert-draft 需要 chat 视图 + Composer —— 点任务行（UI 链路）切过去。
  await win.evaluate(() => {
    const row = [...document.querySelectorAll(".sidebar .task-item")][0];
    const body = row?.querySelector(".task-item-body");
    body?.click();
  });
  await waitUntil(() => win.evaluate(() => document.querySelector(".chat") !== null), { timeout: 15000, desc: "进入会话页" });
  await win.evaluate(() => {
    localStorage.setItem("zw:snippets", JSON.stringify([{ text: "这是要插入的片段内容，包含关键结论。", tag: "结论", at: Date.now() }]));
  });
  await win.keyboard.press("Meta+k");
  await win.waitForTimeout(400);
  await win.keyboard.type("片段");
  await win.waitForTimeout(600);
  await waitUntil(() => win.evaluate(() => [...document.querySelectorAll('[role="option"]')].some((el) => (el.textContent ?? "").includes("这是要插入的片段内容"))), { timeout: 8000, desc: "片段条目出现" });
  await win.keyboard.press("Enter");
  await win.waitForTimeout(500);
  const draft = await win.evaluate(() => document.querySelector('[aria-label="消息输入框"]')?.value ?? "");
  if (!draft.includes("这是要插入的片段内容")) throw new Error(`片段应插入草稿，实际「${draft.slice(0, 30)}」`);
  await h.shoot("01-snippet-insert");
});

await win.keyboard.press("Escape");
await win.waitForTimeout(300);
await win.reload();
await win.waitForTimeout(2200);
await h.check("② 模板变量替换生效", async () => {
  await win.evaluate(() => {
    localStorage.setItem("zw:templates", JSON.stringify([{ title: "日报模板", text: "今天的日期是 {{date}}，工作区是 {{workspace}}。", lastUsedAt: Date.now() }]));
    window.dispatchEvent(new CustomEvent("zw:templates-changed"));
  });
  await win.waitForTimeout(500);
  await win.evaluate(() => {
    const tpl = [...document.querySelectorAll(".quick-chip-template")].find((b) => (b.textContent ?? "").includes("日报模板"));
    if (tpl === undefined) throw new Error("模板 chip 未出现（可能草稿非空）");
    tpl.click();
  });
  await win.waitForTimeout(400);
  const draft = await win.evaluate(() => document.querySelector('[aria-label="消息输入框"]')?.value ?? "");
  if (!draft.match(/\d+ 月 \d+ 日/)) throw new Error(`{{date}} 未替换，实际「${draft.slice(0, 40)}」`);
  if (draft.includes("{{workspace}}") && draft.includes("{{")) throw new Error("{{workspace}} 未替换");
  await h.shoot("02-template-vars");
});

await win.keyboard.press("Escape");
await win.waitForTimeout(300);
await win.reload();
await win.waitForTimeout(2200);
await h.check("③ 合并预览浮层", async () => {
  // 先准备第二个会话
  const id2 = "aaaaaaaa-7777-4aaa-8aaa-aaaaaaaaaaa2";
  const t2 = new Date(Date.now() - 86400000).toISOString();
  const lines2 = [
    JSON.stringify({ type: "session", version: 3, id: id2, timestamp: t2, cwd: tmp, title: "昨天的调研" }),
    JSON.stringify({ type: "message", id: `${id2}-m0`, parentId: id2, timestamp: t2, message: { role: "user", content: [{ type: "text", text: "昨天的调研" }] } })
  ];
  writeFileSync(join(SESSIONS_DIR, "s2.jsonl"), lines2.join("\n") + "\n");
  await win.reload();
  await win.waitForTimeout(2200);
  // ⌘点两行进入多选
  await win.evaluate(() => {
    const rows = [...document.querySelectorAll(".sidebar .task-item")];
    for (const row of rows.slice(0, 2)) {
      const body = row.querySelector(".task-item-body");
      body?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, metaKey: true }));
    }
  });
  await win.waitForTimeout(400);
  await waitUntil(() => win.evaluate(() => document.querySelector(".bulk-bar") !== null), { timeout: 8000, desc: "批量浮条出现" }).catch(async (e) => {
    const diag = await win.evaluate(() => ({
      rows: document.querySelectorAll(".sidebar .task-item").length,
      bulk: document.querySelector(".bulk-bar") !== null
    }));
    throw new Error(`${e.message}；诊断=${JSON.stringify(diag)}`);
  });
  await win.evaluate(() => {
    const btn = [...document.querySelectorAll(".bulk-bar .mini-btn")].find((b) => (b.textContent ?? "").includes("合并预览"));
    btn?.click();
  });
  await win.waitForTimeout(400);
  await waitUntil(() => win.evaluate(() => document.querySelector(".merge-preview-sheet") !== null), { timeout: 8000, desc: "合并预览浮层出现" }).catch(async (e) => {
    const diag = await win.evaluate(() => ({
      bulkBtns: [...document.querySelectorAll(".bulk-bar .mini-btn")].map((b) => (b.textContent ?? "")),
      sheet: document.querySelector(".merge-preview-sheet") !== null,
      selected: document.querySelector(".bulk-bar-count")?.textContent ?? "gone"
    }));
    throw new Error(`${e.message}；诊断=${JSON.stringify(diag)}`);
  });
  await h.shoot("03-merge-preview");
  await win.keyboard.press("Escape");
  await win.waitForTimeout(300);
});

await win.keyboard.press("Escape");
await win.waitForTimeout(400);
await h.check("④ 知识库聚合三区卡", async () => {
  await win.evaluate(() => {
    const nav = [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "资料库");
    nav?.click();
  });
  await win.waitForTimeout(900);
  await waitUntil(() => win.evaluate(() => [...document.querySelectorAll(".data-overview-label")].some((el) => (el.textContent ?? "") === "片段")), { timeout: 10000, desc: "知识库三区卡出现" });
  const nums = await win.evaluate(() => [...document.querySelectorAll(".data-overview-num")].map((el) => el.textContent));
  if (nums.length < 3) throw new Error(`三区卡应有 3 个数字，实际 ${nums.length}`);
  await h.shoot("04-library-aggregate");
});

await h.finish();
mock.close().catch(() => {});
