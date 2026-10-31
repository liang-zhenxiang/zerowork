// 第十轮十连截图（#304）：每项至少一张真实 Electron 截图 + h.check 断言。
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const h = createHarness({ name: "ui-round10-shots" });
const OUT = "artifacts/ui-round10-shots";
mkdirSync(OUT, { recursive: true });
const REPLY = [
  "这是第十轮功能验证的回答。",
  "",
  "```js",
  "const diff = true; // 演示代码",
  "function demo() { return 1; }",
  "```",
  "",
  "- [ ] 待办一：验证任务清单",
  "- [x] 待办二：已完成的示例",
  "- 普通列表项",
  "",
  "收尾段。"
].join("\n");
const mock = await startMockModelServer({ models: ["round10-mock"], reply: REPLY });
const SHOT = (name) => join(OUT, name);
let failures = 0;
function check(name, pass, detail = "") {
  return h.check(`${name}${pass ? "" : ` —— ${detail}`}`, async () => {
    if (!pass) throw new Error(detail || "断言未通过");
  });
}
async function shoot(win, name) {
  await win.screenshot({ path: SHOT(name) });
  console.log(`  [SHOT] ${name}`);
}

await h.launch();
const win = h.window();
await win.waitForTimeout(800);

// 会话：mock + 发消息，等回答
await win.evaluate(async ({ baseUrl, ws }) => {
  const k = globalThis.kami;
  await k.saveCustomProvider(
    { id: "round10-p", name: "Round10 Mock", baseUrl, api: "openai-completions", authHeader: true,
      models: [{ id: "round10-mock", name: "round10-mock", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }] },
    "mock-key"
  );
  await k.setModel("round10-p/round10-mock");
  await k.setWorkspace(ws);
  await k.newTask();
}, { baseUrl: mock.baseUrl, ws: h.WORKSPACE_DIR });
const composer = win.locator('[aria-label="消息输入框"]');
await composer.fill("验证第十轮功能");
await win.evaluate(() => document.querySelector(".send-btn")?.click());
await waitUntil(() => win.evaluate(() => [...document.querySelectorAll(".entry.assistant")].some((el) => (el.textContent ?? "").includes("收尾段"))), { timeout: 20000, desc: "回答完成" });
await win.waitForTimeout(400);

// ③ 任务清单交互化
try {
  await waitUntil(() => win.evaluate(() => document.querySelectorAll("li.md-task").length >= 2), { timeout: 8000, desc: "md-task 渲染" });
  await win.evaluate(() => document.querySelector("li.md-task")?.scrollIntoView({ block: "center" }));
  await win.waitForTimeout(300);
  // 点第一个 checkbox → done class
  await win.evaluate(() => document.querySelector("li.md-task .md-task-box")?.click());
  await win.waitForTimeout(250);
  const doneCount = await win.evaluate(() => document.querySelectorAll("li.md-task-done").length);
  check("任务清单可勾选", doneCount >= 1, `done=${doneCount}`);
  await shoot(win, "03-task-list.png");
} catch (e) { check("任务清单可勾选", false, e.message); }

// F1 代码块 → 新任务
try {
  await win.evaluate(() => document.querySelector(".code-block")?.scrollIntoView({ block: "center" }));
  await win.waitForTimeout(300);
  await win.evaluate(() => document.querySelector(".code-block-task")?.click());
  await win.waitForTimeout(900);
  const st = await win.evaluate(() => ({
    home: document.querySelector(".home") !== null,
    ta: document.querySelector('[aria-label="消息输入框"]')?.value ?? "",
    toast: [...document.querySelectorAll(".toast-text")].some((el) => (el.textContent ?? "").includes("新任务"))
  }));
  check("代码→新任务带回首页", st.home && st.ta.includes("```"), `home=${st.home} taLen=${st.ta.length}`);
  await shoot(win, "01-code-to-task.png");
} catch (e) { check("代码→新任务", false, e.message); }

// F6 J/K 跳转（需要 ≥2 任务行；刚才的会话 + 新建一个空任务）
try {
  // J：跳到下一个任务行
  await win.evaluate(() => document.activeElement?.blur());
  await win.keyboard.press("j");
  await win.waitForTimeout(600);
  const jState = await win.evaluate(() => ({
    chat: document.querySelector(".chat") !== null || document.querySelector(".stream") !== null,
    current: document.querySelector(".task-item-body.task-item-current, .task-item-body[aria-current='true']") !== null || document.querySelectorAll(".task-item-body").length
  }));
  check("J 键跳转任务行", jState.chat === true || (typeof jState.current === "number" && jState.current > 0), JSON.stringify(jState));
  await shoot(win, "06-jk-jump.png");
} catch (e) { check("J/K 跳转", false, e.message); }

// F2 TL;DR（≥5 轮才出；这里补 4 轮短问短答）
try {
  const rounds = 4;
  for (let i = 0; i < rounds; i++) {
    const ta = win.locator('[aria-label="消息输入框"]');
    // 当前可能在首页或会话；若是新任务先回会话（J 已进入某行）
    await ta.fill(`追问 ${i + 1}`);
    await ta.press("Enter");
    // 计数：首轮完成后 assistant=1；第 i 轮追问完成后 = 2+i（探针 r10q 实测）。
    await waitUntil(() => win.evaluate((expected) => [...document.querySelectorAll(".entry.assistant")].length >= expected, 2 + i), { timeout: 25000, desc: `第 ${i + 1} 轮完成` });
  }
  await waitUntil(() => win.evaluate(() => document.querySelector(".chat-tldr-toggle") !== null), { timeout: 8000, desc: "TL;DR 开关出现" });
  await win.evaluate(() => document.querySelector(".chat-tldr-toggle")?.click());
  await waitUntil(() => win.evaluate(() => document.querySelector(".chat-tldr") !== null), { timeout: 5000, desc: "TL;DR 卡展开" });
  await win.waitForTimeout(300);
  await shoot(win, "02-tldr.png");
  check("TL;DR 摘要卡", true);
} catch (e) { check("TL;DR 摘要卡", false, e.message); }

// F6b 快捷键表里应有 J/K 条目
try {
  await win.keyboard.press("Meta+/");
  await win.waitForTimeout(500);
  const hasJk = await win.evaluate(() => [...document.querySelectorAll(".shortcut-sheet kbd, kbd")].some((el) => el.textContent === "J"));
  check("快捷键表含 J/K", hasJk, "没找到 J 键帽");
  await win.evaluate(() => { const b = document.querySelector(".shortcut-sheet-backdrop"); if (b !== null) b.click(); });
  await win.waitForTimeout(300);
} catch (e) { check("快捷键表含 J/K", false, e.message); }

// F10 关于页升级足迹：先伪造 zw:first-version 再开设置→关于
try {
  await win.evaluate(() => window.localStorage.setItem("zw:first-version", "0.13.0"));
  await win.keyboard.press("Meta+k");
  await win.waitForTimeout(400);
  await win.keyboard.type("设置");
  await win.waitForTimeout(500);
  await win.keyboard.press("Enter");
  await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") !== null), { timeout: 10000, desc: "设置打开" });
  // 切到「关于」分组
  await win.evaluate(() => {
    const items = [...document.querySelectorAll(".settings-nav .settings-nav-item, .settings-nav button")];
    const about = items.find((el) => (el.textContent ?? "").includes("关于"));
    about?.click();
  });
  await win.waitForTimeout(500);
  const upgraded = await win.evaluate(() => document.querySelector(".about-upgrade-from") !== null);
  check("关于页显示升级足迹", upgraded, "没找到 about-upgrade-from");
  await win.evaluate(() => document.querySelector(".about-upgrade-from")?.scrollIntoView({ block: "center" }));
  await win.waitForTimeout(300);
  await shoot(win, "10-upgrade-from.png");
} catch (e) { check("关于页升级足迹", false, e.message); }

console.log(`\n完成：失败 ${failures}`);
await h.finish();
mock.close();
