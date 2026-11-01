// 第九轮十连截图（#302）：每项至少一张真实 Electron 截图。
// 手法沿用 ui-round8-shots.mjs；会话正文由 mock 模型流式返回（含表格/长代码块）。
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const h = createHarness({ name: "ui-round9-shots" });
const OUT = "artifacts/ui-round9-shots";
mkdirSync(OUT, { recursive: true });
const REPLY = [
  "这是第九轮功能验证的回答，包含一张表格与一段代码。",
  "",
  "| 项 | 值 |",
  "| --- | --- |",
  "| 轮次 | 9 |",
  "| 主题 | 沉浸对话 |",
  "| 截图 | 十张 |",
  "",
  "```js",
  "const ruler = document.querySelector('.time-ruler');",
  "if (ruler) ruler.dataset.pct = '42';",
  "",
  "// 下面再来几行，确保超过折叠阈值",
  "const lines = [];",
  "for (let i = 0; i < 24; i++) lines.push(`line-${i}`);",
  "console.log(lines.join('\\n'));",
  "```",
  "",
  "收尾段。"
].join("\n");
// 长回复：F2 阅读位记忆只在会话可滚（sh>ch）时有意义 —— 短会话读完即清是设计行为。
const LONG_TAIL = Array.from({ length: 26 }, (_, i) => `补充段落 ${i + 1}：这里刻意写长，把会话撑出滚动条，阅读进度与跟随开关才有用武之地。`).join("\n\n");
const mock = await startMockModelServer({ models: ["round9-mock"], reply: `${REPLY}\n\n${LONG_TAIL}` });
const SHOT = (name) => join(OUT, name);
async function shoot(win, name) {
  await win.screenshot({ path: SHOT(name) });
  console.log(`  [SHOT] ${name}`);
}

await h.launch();
const win = h.window();
await win.waitForTimeout(800);

// ── 进入会话：新建任务 + 发一条消息，等回答渲染完 ──
const seeded = await win.evaluate(async ({ baseUrl, ws }) => {
  const k = globalThis.kami;
  await k.saveCustomProvider(
    {
      id: "round9-p", name: "Round9 Mock", baseUrl, api: "openai-completions", authHeader: true,
      models: [{ id: "round9-mock", name: "round9-mock", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }]
    },
    "mock-key"
  );
  await k.setModel("round9-p/round9-mock");
  await k.setWorkspace(ws);
  await k.newTask();
  return true;
}, { baseUrl: mock.baseUrl, ws: h.WORKSPACE_DIR });
if (!seeded) throw new Error("mock provider setup failed");
await win.waitForTimeout(600);

const composer = win.locator('[aria-label="消息输入框"]');
await composer.fill("帮我看看第九轮的功能");
await win.evaluate(() => document.querySelector(".send-btn")?.click());
// 等回答出现（.entry.assistant 的文本包含「收尾段」）
await waitUntil(
  () => win.evaluate(() => [...document.querySelectorAll(".entry.assistant")].some((el) => (el.textContent ?? "").includes("收尾段"))),
  { timeout: 20000, desc: "回答渲染完成" }
);
await win.waitForTimeout(400);

// ④ 代码块行数徽标
await h.check("④ 代码块行数徽标", async () => {
  await waitUntil(() => win.evaluate(() => {
    const el = document.querySelector(".code-block-lines");
    return el !== null && /\d+ 行/.test(el.textContent ?? "");
  }), { timeout: 8000, desc: "代码块行数徽标" });
  await win.evaluate(() => document.querySelector(".code-block")?.scrollIntoView({ block: "center" }));
  await win.waitForTimeout(350);
  await shoot(win, "04-code-lines.png");
});  /* ④ */

// ③ 表格增强（斑马纹 + scroll wrapper）
await h.check("③ 表格增强", async () => {
  await waitUntil(() => win.evaluate(() => document.querySelector(".markdown .table-scroll table") !== null), { timeout: 8000, desc: "表格 scroll wrapper" });
  await win.evaluate(() => document.querySelector(".markdown .table-scroll")?.scrollIntoView({ block: "center" }));
  await win.waitForTimeout(350);
  await shoot(win, "03-table.png");
});  /* ③ */

// ⑦ 会话统计（头部 N 轮 · N 字）
await h.check("⑦ 会话统计", async () => {
  await waitUntil(() => win.evaluate(() => {
    const el = document.querySelector(".chat-session-stats");
    return el !== null && /轮/.test(el.textContent ?? "") && /字/.test(el.textContent ?? "");
  }), { timeout: 8000, desc: "会话统计出现" });
  await shoot(win, "07-session-stats.png");
});  /* ⑦ */

// ⑤ 复制整轮（hover 出现 turn-copy-turn）
await h.check("⑤ 复制整轮", async () => {
  await waitUntil(() => win.evaluate(() => document.querySelector(".turn-copy-turn") !== null), { timeout: 6000, desc: "复制整轮按钮" });
  await win.evaluate(() => { const el = document.querySelector(".turn-copy-turn"); el.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true })); });
  await win.evaluate(() => document.querySelector(".turn-copy-turn")?.scrollIntoView({ block: "center" }));
  await win.waitForTimeout(350);
  await shoot(win, "05-copy-turn.png");
});  /* ⑤ */

// ⑥ 引用回复（assistant 工具条按钮）
await h.check("⑥ 引用回复", async () => {
  await waitUntil(() => win.evaluate(() => {
    const btn = document.querySelector('[aria-label="引用回复"]');
    return btn !== null;
  }), { timeout: 6000, desc: "引用回复按钮" });
  await win.evaluate(() => document.querySelector('[aria-label="引用回复"]')?.closest(".entry")?.scrollIntoView({ block: "center" }));
  await win.waitForTimeout(300);
  await shoot(win, "06-quote-reply-btn.png");
  // 点一下，草稿应出现 "> "
  await win.evaluate(() => document.querySelector('[aria-label="引用回复"]')?.click());
  await waitUntil(() => win.evaluate(() => {
    const ta = document.querySelector('[aria-label="消息输入框"]');
    return ta !== null && (ta.value ?? "").startsWith("> ");
  }), { timeout: 6000, desc: "草稿出现引用块" });
  await win.waitForTimeout(250);
  await shoot(win, "06b-quote-draft.png");
});  /* ⑥ */

// ⑧ 流式跟随：mock delayMs 不足以来第二轮流式——用排队第二条消息后立即上翻截「跟随后暂停」态
await h.check("⑧ 流式跟随", async () => {
  const ta2 = win.locator('[aria-label="消息输入框"]');
  await ta2.fill("再来一轮验证跟随");
  await ta2.press("Enter");
  await win.waitForTimeout(500);
  // 立刻上翻 → 应出现回到底部按钮
  await win.evaluate(() => { const n = document.querySelector(".stream"); if (n) n.scrollTop = Math.max(0, n.scrollTop - 600); n?.dispatchEvent(new window.Event("scroll")); });
  await waitUntil(() => win.evaluate(() => document.querySelector(".jump-to-bottom") !== null), { timeout: 6000, desc: "上翻后回到底部按钮出现" });
  await shoot(win, "08-follow-pause.png");
  // 等第二轮回答结束，避免影响后续
  await waitUntil(() => win.evaluate(() => document.querySelectorAll(".entry.assistant").length >= 2), { timeout: 20000, desc: "第二轮回答完成" });
  await win.waitForTimeout(600);
});  /* ⑧ */

// ② 阅读进度记忆：上翻后等防抖落盘 → reload → 从侧栏重进 → 应恢复位置并 toast。
// 注意 scrollTop=0 也算一次 scroll（写入 0），必须上翻后**等待写完**再上翻到中段，
// 且恢复判据是「saved < maxScroll-240」—— 所以保存的位置要足够深（翻到 40px 附近）。
await h.check("② 阅读进度记忆", async () => {
  /* 上翻深度用固定 300px：折叠态（#312 LongAnswerFold）把 sh 压到 ~689，
     比例 35% 只剩 43px，恢复判据 saved<maxScroll-240 永不满足（#312 实测）。
     300 满足「>240 阈值且 <可滚全程」两种内容高度。 */
  await win.evaluate(() => { const n = document.querySelector(".stream"); n.scrollTop = Math.max(0, (n.scrollHeight - n.clientHeight) > 320 ? 300 : Math.round((n.scrollHeight - n.clientHeight) * 0.5)); n.dispatchEvent(new window.Event("scroll")); });
  await win.waitForTimeout(1200); // 等防抖写入
  await win.reload();
  await win.waitForTimeout(1500);
  // reload 后回到首页（view 不跨刷新保持）；从侧栏任务行重进会话 → 此刻恢复阅读位
  await win.evaluate(() => { const row = document.querySelector(".task-item-body"); row?.click(); });
  await waitUntil(() => win.evaluate(() => document.querySelector(".stream") !== null), { timeout: 8000, desc: "重进会话" });
  /* 产品事实断言：滚动位置已恢复到 saved（±40）。toast 只活 2.2s，
     resume 流程慢一点就错过 —— 不能作为判据（#312 实测）。 */
  const expected = await win.evaluate(() => Number(window.localStorage.getItem(Object.keys(window.localStorage).find((k) => k.startsWith("zw:readpos:")) ?? "") ?? "0"));
  await waitUntil(() => win.evaluate((exp) => { const n = document.querySelector(".stream"); return n !== null && Math.abs(n.scrollTop - exp) <= 40; }, expected), { timeout: 10000, desc: "滚动位置已恢复" });
  await win.waitForTimeout(200);
  await shoot(win, "02-readpos.png");
});  /* ② */

// ① 命中高亮：⌘K 搜「第九轮」→ 高亮默认落在标题命中的会话行（第 1 条），
// Enter 走的是纯 resumeTask。要用正文命中链路，先 ArrowDown 到「正文命中」行再 Enter
// （probe-r9v2 实证：键盘路径后 T+600ms marks=2、flash=1）。
await h.check("① 命中高亮", async () => {
  await win.keyboard.press("Meta+k");
  await win.waitForTimeout(400);
  await win.keyboard.type("第九轮");
  await win.waitForTimeout(1200); // 等正文命中防抖 + 行渲染
  await win.keyboard.press("ArrowDown"); // 0(会话标题) → 1(正文命中)
  await win.waitForTimeout(150);
  await win.keyboard.press("Enter");
  await waitUntil(() => win.evaluate(() => document.querySelectorAll("mark.search-hit").length > 0), { timeout: 10000, desc: "mark.search-hit 出现" });
  await win.waitForTimeout(300);
  await shoot(win, "01-search-hit.png");
});  /* ① */

// ⑨ 夜间柔化：直接给 <html> 挂 data-night-dim（真实求值受时钟控制，这里验证 CSS 生效）
await h.check("⑨ 夜间柔化", async () => {
  await win.keyboard.press("Escape");
  await win.evaluate(() => { document.documentElement.setAttribute("data-night-dim", "on"); document.documentElement.setAttribute("data-theme", "light"); });
  await win.waitForTimeout(400);
  await shoot(win, "09-night-dim.png");
  await win.evaluate(() => document.documentElement.setAttribute("data-night-dim", "off"));
});  /* ⑨ */

// ⑩ 导出 Markdown：入口在侧栏任务行的「更多操作」菜单里（space-menu-item）。
// 唤出菜单 → 点「导出为 Markdown」→ exports/ 落盘 .md。
await h.check("⑩ 导出 Markdown", async () => {
  await win.evaluate(() => document.querySelector('[aria-label="更多操作"]')?.click());
  await waitUntil(() => win.evaluate(() => document.querySelector(".space-menu-item") !== null), { timeout: 5000, desc: "更多操作菜单打开" });
  const exists = await win.evaluate(() => [...document.querySelectorAll("button")].some((b) => (b.textContent ?? "").includes("导出为 Markdown")));
  if (!exists) throw new Error("找不到「导出为 Markdown」按钮");
  await win.evaluate(() => [...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("导出为 Markdown"))?.click());
  await win.waitForTimeout(2500);
  await shoot(win, "10-export-md.png");
});  /* ⑩ */

await h.finish();
mock.close();
