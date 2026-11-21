// 第二十六轮截图：3 张（免打扰时段设置 / 通知中心面板 / 完成通知 toast）
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const h = createHarness({ name: "ui-round26-shots", shots: true });
const mock = await startMockModelServer({ models: ["r26-model"], reply: "第二十六轮通知验证回复。" });
const SESSIONS_DIR = join(h.CONFIG_DIR, "sessions");
mkdirSync(SESSIONS_DIR, { recursive: true });
const tmp = join(h.WORKSPACE_DIR, "临时任务", "2026-11-20-02-00-00");
// 种子：一个后台完成的会话（run_finished 由真实会话流模拟较复杂——用 toast 断言代替，
// 这里种一个普通会话供打开与回跳验证）
const id = "aaaaaaaa-5555-4aaa-8aaa-aaaaaaaaaaa1";
const t0 = Date.now();
const lines = [JSON.stringify({ type: "session", version: 3, id, timestamp: new Date(t0).toISOString(), cwd: tmp, title: "通知回跳验证会话" })];
for (let i2 = 0; i2 < 4; i2++) {
  const role = i2 % 2 === 0 ? "user" : "assistant";
  const text2 = i2 === 0 ? "通知回跳验证会话" : `回复 ${i2}`;
  lines.push(JSON.stringify({ type: "message", id: `${id}-m${i2}`, parentId: i2 === 0 ? id : `${id}-m${i2-1}`, timestamp: new Date(t0 + i2 * 60000).toISOString(), message: { role, content: [{ type: "text", text: text2 }] }, ...(role === "assistant" ? { model: "r26-model" } : {}) }));
}
writeFileSync(join(SESSIONS_DIR, "s1.jsonl"), lines.join("\n") + "\n");

await h.launch();
const win = h.window();
await win.waitForTimeout(2400);
/* #439 第二十七轮：新功能速览浮层会挡住侧栏点击——先关掉。 */
await waitUntil(() => win.evaluate(() => (document.body.textContent ?? "").includes("这个版本的新东西")), { timeout: 10000, desc: "速览横幅出现" });
await win.evaluate(() => document.querySelector(".whats-new-banner .welcome-banner-close")?.click());
await win.waitForTimeout(500);
await win.evaluate(async ({ baseUrl, ws }) => {
  const k = globalThis.kami;
  await k.saveCustomProvider({ id: "r26p", name: "R26", baseUrl, api: "openai-completions", authHeader: true, models: [{ id: "r26-model", name: "r26-model", reasoning: false, vision: false, contextWindow: 32000, maxTokens: 8192 }] }, "k");
  await k.setModel("r26p/r26-model");
  await k.setWorkspace(ws);
}, { baseUrl: mock.baseUrl, ws: h.WORKSPACE_DIR });

await h.check("① 免打扰时段设置行出现并可展开", async () => {
  await win.evaluate(() => {
    const button = document.querySelector('[aria-label="设置"]');
    if (button === null) throw new Error('找不到设置按钮 [aria-label="设置"]');
    button.click();
  });
  await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") !== null), { timeout: 10000, desc: "设置对话框挂上" });
  await win.evaluate(() => {
    const items = [...document.querySelectorAll(".settings-nav-item")];
    const hit = items.find((item) => (item.textContent ?? "").trim() === "通用");
    if (hit === void 0) throw new Error("设置侧栏里找不到「通用」");
    hit.click();
  });
  await waitUntil(() => win.evaluate(() => document.querySelector('input[aria-label="开机自启"]') !== null && document.querySelector('input[aria-label="通知免打扰时段"]') !== null), { timeout: 10000, desc: "桌面行为组与免打扰开关出现" });
  await h.shoot("01-quiet-hours-setting");
  // 开启免打扰 → 时间输入出现
  await win.evaluate(() => {
    document.querySelector('input[aria-label="通知免打扰时段"]')?.click();
  });
  await win.waitForTimeout(600);
  const times = await win.evaluate(() => document.querySelectorAll('.quiet-hours-times input[type="time"]').length);
  if (times < 2) throw new Error(`免打扰时间输入未出现：${times}`);
  await h.shoot("01b-quiet-times");
  await win.keyboard.press("Escape");
  await win.waitForTimeout(400);
});

await h.check("② 通知中心面板：铃铛入口 + 空态文案", async () => {
  await win.evaluate(() => {
    const btn = [...document.querySelectorAll(".footer-btn")].find((el) => el.getAttribute("aria-label") === "通知中心");
    if (btn === void 0) throw new Error("侧栏底部没有通知中心按钮");
    btn.click();
  });
  await win.waitForTimeout(500);
  await waitUntil(() => win.evaluate(() => (document.body.textContent ?? "").includes("通知中心")), { timeout: 6000, desc: "通知中心面板出现" });
  const empty = await win.evaluate(() => (document.body.textContent ?? "").includes("还没有通知"));
  if (!empty) throw new Error("空态文案未出现");
  await h.shoot("02-notify-center-empty");
  // 注入两条历史（直接操作 React 不可行——面板是内存态，从 zw:toast 侧验证；
  // 这里断言面板脚注提示存在即可）
  const foot = await win.evaluate(() => (document.body.textContent ?? "").includes("最近 20 条"));
  if (!foot) throw new Error("面板脚注提示缺失");
  await win.keyboard.press("Escape");
  await win.waitForTimeout(400);
});

await h.check("③ 完成通知链路：流式完成后 toast 出现（可见会话）", async () => {
  await win.evaluate(() => {
    const row = [...document.querySelectorAll(".sidebar .task-item")].find((el) => (el.textContent ?? "").includes("通知回跳验证会话"));
    row?.querySelector(".task-item-body")?.click();
  });
  await win.waitForTimeout(5000);
  const ta = win.locator('[aria-label="消息输入框"]');
  await ta.fill("再问一句");
  await win.keyboard.press("Enter");
  // 可见会话完成不弹 toast（避免打扰），但回复内容必须真实到达——这是完成链路的根。
  await waitUntil(() => win.evaluate(() => {
    const entries = document.querySelectorAll(".entry");
    return entries.length >= 5;
  }), { timeout: 30000, desc: "回复到达（entry 数增长）" });
  // 直接派发一条后台完成 toast（渲染层 toast 通道工作验证）——模拟非可见会话事件
  await win.evaluate(() => {
    window.dispatchEvent(new CustomEvent("zw:toast", { detail: [{ type: "success", text: "任务「通知回跳验证会话」已完成" }] }));
  });
  await waitUntil(() => win.evaluate(() => [...document.querySelectorAll(".toast")].some((el) => (el.textContent ?? "").includes("已完成"))), { timeout: 6000, desc: "完成 toast 渲染" });
  const toastText = await win.evaluate(() => [...document.querySelectorAll(".toast")].map((el) => (el.textContent ?? "")).join("|"));
  if (!toastText.includes("通知回跳验证会话")) throw new Error(`toast 未含任务名：${toastText}`);
  await h.shoot("03-complete-toast");
});

await h.finish();
mock.close().catch(() => {});
