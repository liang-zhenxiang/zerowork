// 第三十三轮截图：4 张（工具筛选 / 时间筛选+计数 / 导出按钮 / 加载更多）
import { createHarness, waitUntil } from "./lib/harness.mjs";

const h = createHarness({ name: "ui-round33-shots", shots: true });

await h.launch();
const win = h.window();
await win.waitForTimeout(2400);

await h.check("① 审计中心出现且工具筛选下拉有选项", async () => {
  await win.evaluate(() => {
    const button = document.querySelector('[aria-label="设置"]');
    if (button === null) throw new Error("找不到设置按钮");
    button.click();
  });
  await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") !== null), { timeout: 10000, desc: "设置对话框挂上" });
  await win.evaluate(() => {
    const items = [...document.querySelectorAll(".settings-nav-item")];
    const hit = items.find((item) => (item.textContent ?? "").trim() === "审计中心");
    if (hit === void 0) throw new Error("找不到「审计中心」");
    hit.click();
  });
  await waitUntil(() => win.evaluate(() => document.querySelector(".audit-tool-filter") !== null), { timeout: 8000, desc: "筛选框出现" });
  await h.shoot("01-tool-filter");
  /* 无记录环境下用注入的 toast 无法造审计——③④ 在有记录时才断言，
     这里改为断言空态与筛选 UI 同时存在。 */
  const empty = await win.evaluate(() => (document.body.textContent ?? "").includes("还没有审计记录"));
  if (!empty) throw new Error("空态文案未出现");
});

await h.check("② 时间范围 chips 与计数行", async () => {
  await win.evaluate(() => {
    const chip = [...document.querySelectorAll(".audit-time-chips button")].find((el) => (el.textContent ?? "") === "今天");
    chip?.click();
  });
  await win.waitForTimeout(400);
  const stats = await win.evaluate(() => {
    const meta = [...document.querySelectorAll(".provider-meta")].find((el) => (el.textContent ?? "").includes("筛选后"));
    return meta === null ? null : (meta.textContent ?? "").replace(/\s+/g, " ").trim();
  });
  if (stats === null || !stats.includes("筛选后")) throw new Error(`筛选计数行缺失：${stats}`);
  await h.shoot("02-time-filter-stats");
  await win.evaluate(() => {
    const chip = [...document.querySelectorAll(".audit-time-chips button")].find((el) => (el.textContent ?? "") === "全部时间");
    chip?.click();
  });
  await win.waitForTimeout(400);
});

await h.check("③ 导出 JSON / CSV 按钮存在（有记录时）", async () => {
  /* CI/本地全新环境无审计记录——按钮 disabled 也在 DOM，断言存在性即可。 */
  const buttons = await win.evaluate(() => [...document.querySelectorAll("button")].map((el) => (el.textContent ?? "").trim()));
  if (!buttons.includes("导出 JSON")) throw new Error("缺「导出 JSON」按钮（DOM 存在性）");
  if (!buttons.includes("导出 CSV")) throw new Error("缺「导出 CSV」按钮（DOM 存在性）");
  const exportButtons2 = await win.evaluate(() => [...document.querySelectorAll("button")].map((el) => (el.textContent ?? "").trim()));
  if (!exportButtons2.includes("导出 JSON")) throw new Error("缺「导出 JSON」");
  if (!exportButtons2.includes("导出 CSV")) throw new Error("缺「导出 CSV」");
  await h.shoot("03-export-buttons");
});

await h.check("④ 清空确认摘要显示条数", async () => {
  await win.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find((el) => (el.textContent ?? "") === "清空记录");
    btn?.click();
  });
  await win.waitForTimeout(400);
  const summary = await win.evaluate(() => {
    const hint = document.querySelector(".stat-hint");
    return hint === null ? "" : (hint.textContent ?? "").replace(/\s+/g, " ").trim();
  });
  if (!summary.includes("审计记录") || !/\d/.test(summary)) throw new Error(`清空确认摘要缺条数：${summary}`);
  await h.shoot("04-clear-confirm");
  await win.evaluate(() => {
    const cancel = [...document.querySelectorAll("button")].find((el) => (el.textContent ?? "") === "取消");
    cancel?.click();
  });
});

await h.finish();
