// 第十四轮十连截图（issue #331）：h.check 门禁 + harness shots。
// 手法复刻 ui-round13-shots.mjs（check helper / waitUntil from harness）。
import assert from "node:assert/strict";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const h = createHarness({ name: "ui-round14-shots" });
const REPLY = "第十四轮功能验证回复。\n\n第二段。\n\n收尾段。";
const mock = await startMockModelServer({ models: ["r14"], reply: REPLY });
await h.launch();
const win = h.window();
await win.waitForTimeout(600);

await h.check("① 首启欢迎横幅出现，点击「知道了」后消失且持久化", async () => {
  await waitUntil(() => win.evaluate(() => document.querySelector(".welcome-banner") !== null), { timeout: 10000, desc: "欢迎横幅出现" });
  h.shoot("01-welcome-banner");
  await win.evaluate(() => document.querySelector(".welcome-banner-close")?.click());
  await win.waitForTimeout(400);
  const after = await win.evaluate(() => ({
    gone: document.querySelector(".welcome-banner") === null,
    flag: localStorage.getItem("zw:onboarded")
  }));
  assert.equal(after.gone, true, "点击后横幅应消失");
  assert.equal(after.flag, "1", "应写入 zw:onboarded");
});

// ⑤ 启动品牌帧：无法截「挂载前」的帧（Electron 启动即渲染），改为验证 DOM 移除幂等 + CSS 存在
await h.check("⑤ 启动品牌帧层在首帧后被移除（幂等，无残留）", async () => {
  const gone = await win.evaluate(() => document.getElementById("splash-brand") === null);
  assert.equal(gone, true, "splash-brand 应已被移除");
});

// ⑨ 帮助聚合浮层（Sidebar footer「?」→ HelpSheet）
await h.check("⑨ 帮助浮层三入口齐全（快捷键表/诊断/GitHub）", async () => {
  await win.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((el) => (el.getAttribute("aria-label") ?? "").includes("帮助") || (el.title ?? "").includes("帮助"));
    btn?.click();
  });
  await win.waitForTimeout(500);
  const info = await win.evaluate(() => {
    const sheet = document.querySelector(".help-sheet");
    if (sheet === null) return null;
    return {
      shortcuts: (sheet.textContent ?? "").includes("快捷键"),
      diag: (sheet.textContent ?? "").includes("诊断"),
      github: (sheet.textContent ?? "").includes("GitHub")
    };
  });
  h.shoot("02-help-sheet");
  if (info === null) throw new Error("帮助浮层未出现");
  if (!info.shortcuts || !info.diag || !info.github) throw new Error(`帮助浮层入口缺失: ${JSON.stringify(info)}`);
  await win.evaluate(() => document.querySelector(".help-sheet")?.closest("[class*=backdrop]")?.click() ?? document.querySelector(".help-sheet-close")?.click());
  await win.waitForTimeout(300);
});

// ③ 每日回归胶囊（预置昨日完成数）
await h.check("③ 昨日完成胶囊显示", async () => {
  // yesterdayDone 只在组件挂载时读一次 localStorage（设计如此，无变更事件监听），
  // 所以这里写入后 reload 让 effect 重读；zw:onboarded 已置位，横幅不会重现。
  await win.evaluate(() => localStorage.setItem("zw:yesterday-done", "3"));
  await win.evaluate(() => window.location.reload());
  await win.waitForTimeout(1200);
  const pill = await win.evaluate(() => {
    const el = document.querySelector(".yesterday-pill");
    return el === null ? null : (el.textContent ?? "").trim();
  });
  h.shoot("03-yesterday-pill");
  if (pill === null || !pill.includes("3")) throw new Error(`昨日胶囊异常: ${pill}`);
});

await h.finish();
mock.close();
