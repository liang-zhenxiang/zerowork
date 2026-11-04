// 第十三轮十连截图（#327）。复用 round12 手法：mock 模型 + 种子会话，
// 每个功能一张，h.check 注册门禁断言。
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const h = createHarness({ name: "ui-round13-shots" });
const REPLY = "这是第十三轮功能验证的回答。\n\n- 并行面板验证用\n- 批量队列验证用\n\n收尾段。";
const mock = await startMockModelServer({ models: ["r13"], reply: REPLY, delayMs: 9000 });
const check = async (label, fn) => {
  try {
    await fn();
    console.log(`  [PASS] ${label}`);
  } catch (error) {
    console.log(`  [FAIL] ${label} —— ${error?.message ?? error}`);
    h.failed = (h.failed ?? 0) + 1;
  }
};
const seedTask = async (win, { title, text }, opt = {}) => {
  await win.evaluate(async ({ baseUrl, ws }) => {
    const k = globalThis.kami;
    await k.saveCustomProvider({ id: "r13p", name: "R13", baseUrl, api: "openai-completions", authHeader: true, models: [{ id: "r13", name: "r13", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }] }, "mock-key");
    await k.setModel("r13p/r13");
    await k.setWorkspace(ws);
    await k.newTask();
  }, { baseUrl: mock.baseUrl, ws: h.WORKSPACE_DIR, title, text });
  const composer = win.locator('[aria-label="消息输入框"]');
  await composer.fill(text);
  await composer.press("Enter");
  if (opt.noWait !== true) {
    await waitUntil(() => win.evaluate(() => [...document.querySelectorAll(".entry.assistant")].some((el) => (el.textContent ?? "").includes("收尾段"))), { timeout: 20000, desc: "回答完成" });
  }
};

await h.launch();
const win = h.window();
await win.waitForTimeout(600);

// ① 并行面板：mock delayMs=9000，第一个会话还在跑时开第二个 → 真 2 个运行中
await check("① 并行面板", async () => {
  await seedTask(win, { title: "并行任务甲", text: "帮我写一份并行任务甲的报告" }, { noWait: true });
  await win.evaluate(() => globalThis.kami.newTask());
  await win.waitForTimeout(400);
  const composer = win.locator('[aria-label="消息输入框"]');
  await composer.fill("帮我写一份并行任务乙的报告");
  await composer.press("Enter");
  await waitUntil(() => win.evaluate(() => document.querySelectorAll(".running-strip").length > 0), { timeout: 15000, desc: "运行聚合条出现" });
  await win.evaluate(() => document.querySelector(".running-strip")?.click());
  await waitUntil(() => win.evaluate(() => document.querySelector(".parallel-panel") !== null), { timeout: 8000, desc: "并行面板出现" });
  await h.shoot("01-parallel-panel");
  await win.keyboard.press("Escape");
});

// ③ 批量提问队列
await check("③ 批量队列", async () => {
  await win.evaluate(() => globalThis.kami.newTask());
  await win.waitForTimeout(400);
  const composer = win.locator('[aria-label="消息输入框"]');
  await composer.fill("第一个问题：排队机制验证\n---\n第二个问题：队列依次发送");
  await composer.press("Enter");
  await waitUntil(() => win.evaluate(() => [...document.querySelectorAll(".toast")].some((el) => (el.textContent ?? "").includes("已排队")), ), { timeout: 8000, desc: "排队 toast" });
  await h.shoot("03-batch-queue");
});

// ⑤ 会话标签
await check("⑤ 会话标签", async () => {
  const rowTexts = await win.evaluate(() => [...document.querySelectorAll(".task-item-body")].map((el) => el.textContent ?? ""));
  if (rowTexts.length === 0) throw new Error("侧栏无任务行");
  await win.evaluate(() => {
    const row = document.querySelector(".task-item .task-item-body");
    row?.dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true }));
    (window).__r13menu = true;
  });
  // 行菜单经 hover ops 打开：直接点更多操作按钮
  const rows = win.locator(".task-item").first();
  await rows.hover();
  await win.waitForTimeout(200);
  const menus = await win.locator('[aria-label="更多操作"]');
  if ((await menus.count()) > 0) {
    await menus.first().evaluate((el) => el.click());
    await win.waitForTimeout(300);
    const setLabel = win.locator('button:has-text("设置标签")');
    if ((await setLabel.count()) > 0) {
      await setLabel.first().click();
      await win.waitForTimeout(300);
    } else {
      await win.keyboard.press("Escape");
    }
  }
  const dot = await win.evaluate(() => document.querySelectorAll(".task-label-dot").length);
  if (dot === 0) throw new Error("标签色点未出现");
  await h.shoot("05-task-label");
});

// ⑧ 会话比较
await check("⑧ 会话比较", async () => {
  await win.evaluate(() => {
    const rows = [...document.querySelectorAll(".task-item-body")];
    for (const row of rows.slice(0, 2)) {
      row.dispatchEvent(new window.MouseEvent("click", { bubbles: true, metaKey: true, shiftKey: true }));
    }
  });
  await win.waitForTimeout(300);
  const go = await win.evaluate(() => document.querySelector(".compare-bar-go") !== null);
  if (!go) throw new Error("比较浮条未出现");
  await win.evaluate(() => document.querySelector(".compare-bar-go")?.click());
  await waitUntil(() => win.evaluate(() => document.querySelector(".compare-sheet") !== null), { timeout: 8000, desc: "比较浮层" });
  await h.shoot("08-compare");
  await win.keyboard.press("Escape");
});

// ⑨ 归档摘要卡：归档一个会话后看数据管理区
await check("⑨ 归档摘要", async () => {
  await win.waitForTimeout(800);
  await waitUntil(() => win.evaluate(() => document.querySelectorAll(".task-item").length > 0), { timeout: 15000, desc: "侧栏有任务行" });
  const firstRow = win.locator(".task-item").first();
  await firstRow.hover({ force: true });
  await win.waitForTimeout(300);
  const menuBtn = win.locator('[aria-label="更多操作"]');
  if ((await menuBtn.count()) > 0) {
    await menuBtn.first().evaluate((el) => el.click());
    await win.waitForTimeout(300);
    await win.evaluate(() => {
      const item = [...document.querySelectorAll(".space-menu-item, [class*=menu] button")].find((el) => (el.textContent ?? "").trim() === "归档");
      item?.click();
    });
    await win.waitForTimeout(800);
  }
  await h.shoot("09-archive-summary");
});

// ⑦ 定时入口 + ② 模板 + ⑩ 备注 + ⑥ 时长提醒：菜单项存在性断言（同菜单）
await check("②⑦⑩ 菜单项", async () => {
  await waitUntil(() => win.evaluate(() => document.querySelectorAll(".task-item").length > 0), { timeout: 15000, desc: "侧栏有任务行" });
  const anyRow = win.locator(".task-item").first();
  await anyRow.hover({ force: true });
  await win.waitForTimeout(300);
  const menuBtn = win.locator('[aria-label="更多操作"]');
  if ((await menuBtn.count()) === 0) throw new Error("无更多操作按钮");
  await menuBtn.first().evaluate((el) => el.click());
  await win.waitForTimeout(300);
  const labels = await win.evaluate(() => [...document.querySelectorAll(".space-menu-item")].map((el) => el.textContent ?? ""));
  for (const need of ["存为模板", "创建定时任务…", "添加备注"]) {
    if (!labels.some((l) => l.includes(need))) throw new Error(`菜单缺「${need}」`);
  }
  await h.shoot("02-template-menu");
  await win.keyboard.press("Escape");
});

await h.finish();
mock.close();
console.log(`R13_DONE failed=${h.failed ?? 0}`);
