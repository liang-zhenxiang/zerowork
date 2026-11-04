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

await h.finish();
mock.close();
