// 第三十二轮截图：4 张（设置搜索 / 最近访问 / desc title / ⌘K 设置直达）
import { createHarness, waitUntil } from "./lib/harness.mjs";

const h = createHarness({ name: "ui-round32-shots", shots: true });

await h.launch();
const win = h.window();
await win.waitForTimeout(2400);

await h.check("① 设置搜索：输入过滤 nav 项", async () => {
  await win.evaluate(() => {
    const button = document.querySelector('[aria-label="设置"]');
    if (button === null) throw new Error("找不到设置按钮");
    button.click();
  });
  await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") !== null), { timeout: 10000, desc: "设置对话框挂上" });
  await waitUntil(() => win.evaluate(() => document.querySelector(".settings-search") !== null), { timeout: 6000, desc: "搜索框出现" });
  await win.evaluate(() => {
    const input = document.querySelector(".settings-search");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "模型");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await win.waitForTimeout(400);
  const nav = await win.evaluate(() => ({
    visible: [...document.querySelectorAll(".settings-nav-item")].map((el) => (el.textContent ?? "").trim()),
    empty: document.querySelector(".settings-search-empty") !== null
  }));
  if (!nav.visible.includes("模型")) throw new Error(`「模型」应可见：${JSON.stringify(nav)}`);
  if (nav.visible.includes("审计中心")) throw new Error(`无关项未过滤：${JSON.stringify(nav.visible)}`);
  await h.shoot("01-settings-search");
  await win.evaluate(() => {
    const input = document.querySelector(".settings-search");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await win.waitForTimeout(300);
});

await h.check("② 每组 nav 项 title 说明", async () => {
  const desc = await win.evaluate(() => {
    const item = [...document.querySelectorAll(".settings-nav-item")].find((el) => (el.textContent ?? "").trim() === "数据管理");
    return item?.getAttribute("title") ?? "";
  });
  if (!desc.includes("备份")) throw new Error(`数据管理 title 缺描述：${desc}`);
  await h.shoot("02-nav-desc");
});

await h.check("③ 最近访问：打开两个分组后置顶", async () => {
  await win.evaluate(() => {
    const items = [...document.querySelectorAll(".settings-nav-item")];
    items.find((el) => (el.textContent ?? "").trim() === "审计中心")?.click();
  });
  await win.waitForTimeout(300);
  await win.evaluate(() => {
    const items = [...document.querySelectorAll(".settings-nav-item")];
    items.find((el) => (el.textContent ?? "").trim() === "统计")?.click();
  });
  await win.waitForTimeout(300);
  // 打开的是设置页内的其他分组——点「数据管理」和「审计中心」
  await win.evaluate(() => {
    const items = [...document.querySelectorAll(".settings-nav-item")];
    items.find((el) => (el.textContent ?? "").trim() === "数据管理")?.click();
  });
  await win.waitForTimeout(400);
  const recent = await win.evaluate(() => {
    const box = document.querySelector(".settings-recent");
    if (box === null) return null;
    return [...box.querySelectorAll("button")].map((el) => (el.textContent ?? "").trim());
  });
  if (recent === null) throw new Error("最近访问分组未出现");
  if (recent.length < 2) throw new Error(`最近访问不足 2 条：${JSON.stringify(recent)}`);
  await h.shoot("03-recent-pages");
  await win.evaluate(() => {
    const btn = document.querySelector(".settings-card-close");
    btn?.click();
  });
  await win.waitForTimeout(400);
});

await h.check("④ ⌘K 命令面板收录设置分组直达", async () => {
  await win.keyboard.press("Meta+k");
  await win.waitForTimeout(500);
  await win.keyboard.type("设置：模型");
  await win.waitForTimeout(600);
  await waitUntil(() => win.evaluate(() => [...document.querySelectorAll(".ac-item")].some((el) => (el.textContent ?? "").includes("设置：模型"))), { timeout: 8000, desc: "设置直达条目出现" });
  await h.shoot("04-palette-settings");
  await win.keyboard.press("Escape");
  await win.waitForTimeout(400);
});

await h.finish();
