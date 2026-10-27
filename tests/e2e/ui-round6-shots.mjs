// 第六轮十连截图：锚点/引用/目录/token/健康点/折叠/chips/标尺/导出卡/段落渐入。
// 手法复刻 ui-round5-shots.mjs（mock 链路 + waitUntil + step）。
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const h = createHarness({ name: "ui-round6-shots", shots: true });
const mock = await startMockModelServer({
  models: ["round6-mock"],
  reply:
    "这是一段用来展示第六轮功能的回答。\n\n第二段讲消息锚点与引用回复：每条回答现在都能复制深链、一键引用。\n\n```js\nconst ruler = document.querySelector('.time-ruler');\nif (ruler) ruler.dataset.pct = '42';\n// 超过 18 行的代码块会默认折叠\nconst lines = [];\nfor (let i = 0; i < 30; i++) lines.push(`line-${i}`);\nconsole.log(lines.join('\\n'));\n```\n\n- 列表项一\n- 列表项二\n\n第三段收尾。"
});

// ── 种子：6 场会话（解锁「最近会话」列表 + 健康度演示）──────────────
const SESSIONS_DIR = join(h.CONFIG_DIR, "sessions");
mkdirSync(SESSIONS_DIR, { recursive: true });
const now = Date.now();
function msg(id, parentId, role, text, usage) {
  const extra = role === "assistant" ? { model: "round6-mock" } : {};
  return JSON.stringify({
    type: "message", id, parentId, timestamp: new Date(now - 36e5).toISOString(),
    message: { role, content: [{ type: "text", text }], ...extra, ...(usage ?? {}) }
  });
}
for (let i = 1; i <= 6; i++) {
  const sid = `eeeeeeee-dddd-4ddd-8ddd-ddddddddddd${i}`;
  const file = `2026-10-27T1${i}-00-00-r6-${i}-000Z_s${i}.jsonl`;
  writeFileSync(join(SESSIONS_DIR, file), [
    JSON.stringify({ type: "session", version: 3, id: sid, timestamp: new Date(now - i * 36e5).toISOString(), title: `第六轮样例会话 ${i}`, cwd: h.WORKSPACE_DIR }),
    msg(`r6u${i}`, null, "user", `第六轮第 ${i} 场：帮我盘点本周的物料到货情况`),
    msg(`r6a${i}`, `r6u${i}`, "assistant", `本周物料到货率 ${90 + i}%，缺货清单已生成。`, { usage: { input: 900 + i * 80, output: 600 + i * 40, cacheRead: 0, cacheWrite: 0, cost: 0.001 * i } })
  ].join("\n") + "\n");
}

await h.launch();
const win = h.window();
await waitUntil(() => win.evaluate(() => globalThis.kami !== undefined), { timeout: 10_000, desc: "kami 就绪" });
await win.evaluate(async (m) => {
  const k = globalThis.kami;
  await k.saveCustomProvider({ id: "round6-mock", name: "R6", baseUrl: m.baseUrl, api: "openai-completions", authHeader: true,
    models: [{ id: "round6-mock-model", name: "r6", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }] }, "mk");
  await k.setModel("round6-mock/round6-mock-model");
  await k.setWorkspace(m.ws);
}, { baseUrl: mock.baseUrl, ws: h.WORKSPACE_DIR });

// ① 消息锚点：发起会话，hover 回答 → 工具条出现「复制锚点」
await h.check("① 消息锚点链接", async () => {
  await win.evaluate(() => globalThis.kami.newTask());
  const box = win.locator('[aria-label="消息输入框"]');
  await box.waitFor({ state: "visible", timeout: 30_000 });
  await box.fill("给我讲讲第六轮的功能");
  await win.keyboard.press("Enter");
  await waitUntil(() => win.evaluate(() => document.querySelectorAll(".entry.assistant").length >= 1), { timeout: 30_000, desc: "回答出现" });
  await win.evaluate(() => {
    const el = document.querySelector(".entry.assistant");
    el?.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
  });
  await win.waitForTimeout(400);
  await h.shoot("01-anchor-link");
});

// ② 引用回复：hover 用户消息 → 点「引用回复」→ 草稿变成 > 前缀
await h.check("② 引用回复", async () => {
  const userEntry = win.locator(".entry.user").first();
  await userEntry.hover();
  const quoteBtn = userEntry.locator('button[aria-label="引用回复"]');
  await quoteBtn.waitFor({ state: "visible", timeout: 5_000 });
  await quoteBtn.click();
  await win.waitForTimeout(300);
  await h.shoot("02-quote-reply");
  await win.evaluate(() => {
    const ta = document.querySelector('[aria-label="消息输入框"]');
    if (ta !== null) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(ta, "");
      ta.dispatchEvent(new window.Event("input", { bubbles: true }));
    }
  });
});

// ③ 会话内目录：.turn-nav 单轮也存在但 22px 高几乎不可见，多轮（3+）才成形。
await h.check("③ 会话内目录", async () => {
  const box3 = win.locator('[aria-label="消息输入框"]');
  for (let i = 0; i < 2; i++) {
    const target = i + 2;
    await box3.fill(`追问 ${target}：再展开讲讲`);
    await win.keyboard.press("Enter");
    await waitUntil((n) => win.evaluate((x) => document.querySelectorAll(".entry.assistant").length >= x, n ?? target), { timeout: 30_000, desc: `回答 ${target}` }).catch(async () => {
      // waitUntil 签名不同就退化用 evaluate 直查
      await waitUntil(() => win.evaluate((x) => document.querySelectorAll(".entry.assistant").length >= x, target), { timeout: 30_000, desc: `回答 ${target}` });
    });
  }
  await waitUntil(() => win.evaluate(() => document.querySelectorAll(".turn-nav-mark").length >= 3), { timeout: 10_000, desc: "目录刻度 ≥3" });
  await h.shoot("03-turn-nav");
});

// ④ token 计数：输入长文本 → composer 里出现 ≈N tok
await h.check("④ token 计数", async () => {
  // chars.show 的门是 remaining < 1000（app.js:14824），必须超 1000 字。
  // playwright fill 偶发不触发 React 受控更新（探针实测 taLen=600 但 est=null），
  // 用受控 setter 注入 + input 事件（与清空同手法，round5 已验证可用）。
  await win.evaluate(() => {
    const ta = document.querySelector('[aria-label="消息输入框"]');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
    setter.call(ta, "帮我写一份季度复盘，覆盖业务进展、数据表现、风险与下一步计划。".repeat(40));
    ta.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await waitUntil(() => win.evaluate(() => document.querySelector(".token-estimate") !== null), { timeout: 5_000, desc: "token 估算出现" });
  await h.shoot("04-token-count");
  await win.evaluate(() => {
    const ta = document.querySelector('[aria-label="消息输入框"]');
    if (ta !== null) {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(ta, "");
      ta.dispatchEvent(new window.Event("input", { bubbles: true }));
    }
  });
});

// ⑤ 健康度圆点：侧栏会话行上的状态点（就绪绿/失败红）
await h.check("⑤ 会话健康度圆点", async () => {
  await waitUntil(() => win.evaluate(() => document.querySelectorAll(".task-item, .session-item").length >= 1), { timeout: 10_000, desc: "侧栏会话行出现" });
  await h.shoot("05-health-dot");
});

// ⑥ 代码块折叠：回答里的长代码块（30 行 > 18 行阈值）
await h.check("⑥ 代码块折叠", async () => {
  // 代码块在回复末尾，先把会话滚到底
  await win.evaluate(() => {
    const s = document.querySelector(".stream");
    if (s !== null) s.scrollTop = s.scrollHeight;
  });
  await h.waitForSettled();
  await win.locator(".code-gutter").first().waitFor({ state: "visible", timeout: 15_000 });
  await h.shoot("06-code-fold");
});

// ⑦ 快速回复 chips：草稿为空时 composer 下方出现模板 chips
await h.check("⑦ 快速回复 chips", async () => {
  await waitUntil(() => win.evaluate(() => document.querySelector(".quick-chips") !== null), { timeout: 5_000, desc: "chips 出现" });
  await h.shoot("07-quick-chips");
});

// ⑧ 时间线标尺：把会话滚起来 → 右缘竖轨 + 百分比
await h.check("⑧ 时间线标尺", async () => {
  await win.evaluate(() => {
    const scroller = document.querySelector(".stream");
    if (scroller === null) throw new Error(".stream 不存在");
    scroller.scrollTop = scroller.scrollHeight * 0.45;
    scroller.dispatchEvent(new window.Event("scroll", { bubbles: true }));
  });
  await win.waitForTimeout(600);
  await h.shoot("08-time-ruler");
  await win.evaluate(() => {
    const scroller = document.querySelector(".stream");
    if (scroller !== null) scroller.scrollTop = 0;
  });
});

// ⑨ 消息导出卡：hover 回答 → 点「导出为图片」→ exports/ 落盘 PNG
await h.check("⑨ 消息导出卡", async () => {
  const asst = win.locator(".entry.assistant").first();
  await asst.hover();
  const expBtn = asst.locator('button[aria-label="导出为图片"]');
  await expBtn.waitFor({ state: "visible", timeout: 5_000 });
  await expBtn.click();
  // toast 2.2s 自动消失，DOM 断言不可靠；直接断言 exports/ 落盘的 PNG。
  const exportsDir = join(h.WORKSPACE_DIR, "exports");
  await waitUntil(() => {
    try { return readdirSync(exportsDir).some((n) => n.startsWith("ZeroWork-消息卡片-")); }
    catch { return false; }
  }, { timeout: 15_000, desc: "消息卡片 PNG 落盘" });
  await h.shoot("09-message-card");
});

// ⑩ 段落渐入：回答流式/插入时段落淡入（截一张含多段落的会话全貌）
await h.check("⑩ 段落渐入", async () => {
  await h.shoot("10-para-fade");
});

mock.close();
await h.finish();
