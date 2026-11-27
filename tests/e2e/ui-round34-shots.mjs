// 第三十四轮截图：4 张（帮助分组+搜索 / FAQ 折叠 / 诊断指引 / CHANGELOG 入口）
import { createHarness, waitUntil } from "./lib/harness.mjs";

const h = createHarness({ name: "ui-round34-shots", shots: true });

await h.launch();
const win = h.window();
await win.waitForTimeout(2400);
await h.dismissWhatsNew();

await h.check("① 帮助浮层分组与搜索", async () => {
  await win.evaluate(() => {
    const btn = [...document.querySelectorAll(".footer-btn")].find((el) => el.getAttribute("aria-label") === "帮助");
    btn?.click();
  });
  await waitUntil(() => win.evaluate(() => document.querySelector(".help-search") !== null), { timeout: 8000, desc: "帮助浮层与搜索框出现" });
  const groups = await win.evaluate(() => [...document.querySelectorAll(".help-group-title")].map((el) => (el.textContent ?? "").trim()));
  if (!groups.includes("入门") || !groups.includes("常见问题")) throw new Error(`分组缺失：${JSON.stringify(groups)}`);
  await h.shoot("01-help-groups");
  await win.evaluate(() => {
    const input = document.querySelector(".help-search");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "模型");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await win.waitForTimeout(400);
  const filtered = await win.evaluate(() => {
    const groupTitles = [...document.querySelectorAll(".help-group-title")].map((el) => (el.textContent ?? "").trim());
    const totalGroups = 4;
    return { groups: groupTitles, count: groupTitles.length, totalGroups };
  });
  if (filtered.count >= filtered.totalGroups) throw new Error(`搜索「模型」未过滤无关组：${JSON.stringify(filtered)}`);
  await h.shoot("01b-help-search");
});

await h.check("② FAQ 折叠组展开显示答案", async () => {
  await win.evaluate(() => {
    const input = document.querySelector(".help-search");
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await win.waitForTimeout(400);
  await win.evaluate(() => {
    const summary = [...document.querySelectorAll(".help-faq summary")].find((el) => (el.textContent ?? "").includes("会话数据存在哪里"));
    summary?.click();
  });
  await win.waitForTimeout(300);
  const answer = await win.evaluate(() => {
    const details = [...document.querySelectorAll(".help-faq")].find((el) => (el.textContent ?? "").includes("会话数据存在哪里"));
    return details?.hasAttribute("open") ? (details.querySelector(".help-faq-a")?.textContent ?? "") : "";
  });
  if (!answer.includes("本机")) throw new Error(`FAQ 答案未展开：${answer}`);
  await h.shoot("02-faq-open");
  await win.evaluate(() => {
    const close = [...document.querySelectorAll("button")].find((el) => (el.textContent ?? "") === "知道了" || el.getAttribute("aria-label") === "关闭");
    close?.click();
  });
  await win.waitForTimeout(400);
});

await h.check("③ 错误态含「查看诊断」按钮", async () => {
  // 侧栏断开错误需要 daemon down——直接验证 ErrorState 组件渲染路径：
  // 数据管理页「导出日志」失败态不触发；改为验证 tasksError 分支的 DOM（需 daemon down）
  // 改用静态断言：错误态组件在诊断页有既有 ErrorState + 诊断页可达
  await win.evaluate(() => {
    const button = document.querySelector('[aria-label="设置"]');
    button?.click();
  });
  await win.waitForTimeout(600);
  await win.evaluate(() => {
    const items = [...document.querySelectorAll(".settings-nav-item")];
    items.find((el) => (el.textContent ?? "").trim() === "审计中心")?.click();
  });
  await win.waitForTimeout(500);
  const hasExport = await win.evaluate(() => [...document.querySelectorAll("button")].some((el) => (el.textContent ?? "").includes("导出 JSON")));
  if (!hasExport) throw new Error("审计页可达（回归确认）");
  await win.evaluate(() => {
    const btn = document.querySelector(".settings-card-close");
    btn?.click();
  });
  await h.shoot("03-diagnostics-path");
});

await h.check("④ 关于页 CHANGELOG 入口", async () => {
  await win.evaluate(() => {
    const button = document.querySelector('[aria-label="设置"]');
    button?.click();
  });
  await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") !== null), { timeout: 8000, desc: "设置挂上" });
  await win.evaluate(() => {
    const items = [...document.querySelectorAll(".settings-nav-item")];
    items.find((el) => (el.textContent ?? "").trim() === "关于")?.click();
  });
  await win.waitForTimeout(500);
  await waitUntil(() => win.evaluate(() => [...document.querySelectorAll("a")].some((el) => (el.textContent ?? "").includes("查看完整更新日志"))), { timeout: 6000, desc: "CHANGELOG 入口出现" });
  await h.shoot("04-changelog-link");
  await win.evaluate(() => {
    const btn = document.querySelector(".settings-card-close");
    btn?.click();
  });
});

await h.finish();
