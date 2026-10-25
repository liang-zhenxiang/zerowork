/**
 * 第三轮十连的截图采集（只截图，不判定）。
 * 沿用 ui-ten-shots 的写法：每步失败记一条错误继续，尽量把能拍的都拍下来。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const WORKSPACE_DIR = resolve(process.env.ZEROWORK_E2E_DIR ?? "/tmp", "e2e-ui-round3-shots");
mkdirSync(WORKSPACE_DIR, { recursive: true });
writeFileSync(resolve(WORKSPACE_DIR, "README.md"), "# round3\n", "utf8");

const REPLY = [
  "## 好的，开工",
  "",
  "我先把目录扫了一遍：",
  "",
  "```js",
  "const answer = 42;",
  "console.log(answer);",
  "```",
  "",
  "| 步骤 | 状态 |",
  "| --- | --- |",
  "| 扫描 | 完成 |",
].join("\n");

const h = createHarness({ name: "ui-round3-shots", shots: true });
await h.launch();
const win = h.window();
const failures = [];

async function step(label, fn) {
  try {
    await fn();
  } catch (error) {
    failures.push(`${label}: ${error.message}`);
  }
}

// 01 首页：问候语 + token 迷你条
await step("01-home-greeting", () => h.shoot("01-home-greeting"));

// 02 发送键可用态：填文字让按钮亮起
await step("02-send-btn-ready", async () => {
  const ta = win.locator(".composer-card textarea").first();
  await ta.fill("帮我整理一份周报");
  await h.shoot("02-send-btn-ready");
  await ta.fill("");
});

// 03/04 会话：打字指示器 + 代码块
await startMockModelServer({ reply: REPLY });
await step("03-typing-dots", async () => {
  const ta = win.locator(".composer-card textarea").first();
  await ta.fill("帮我整理一份周报");
  await ta.press("Enter");
  await win.waitForTimeout(700);
  await h.shoot("03-typing-dots");
});
await step("04-code-block", async () => {
  await waitUntil(async () => (await win.locator(".code-block-card").count()) > 0, { timeout: 15000 }).catch(() => {});
  await h.shoot("04-code-block");
});

// 05/06 设置：搜索框 + 过滤
await step("05-settings-search", async () => {
  await win.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
  await win.waitForTimeout(500);
  await win.keyboard.type("设置");
  await win.waitForTimeout(400);
  await win.keyboard.press("Enter");
  await win.waitForTimeout(900);
  await h.shoot("05-settings-search");
});
await step("06-settings-filter", async () => {
  const search = win.locator("#settings-search-input");
  await search.fill("模型");
  await win.waitForTimeout(400);
  await h.shoot("06-settings-filter");
  await search.fill("");
});

// 07 拖拽覆盖层：合成 dragenter（只验视觉，drop 走真实逻辑）
await step("07-drop-hint", async () => {
  await win.evaluate(() => {
    const dt = {};
    Object.defineProperty(dt, "types", { value: { contains: (t) => t === "Files", length: 1, 0: "Files" } });
    const ev = new window.DragEvent("dragenter", { bubbles: true });
    Object.defineProperty(ev, "dataTransfer", { value: dt });
    document.dispatchEvent(ev);
  });
  await win.waitForTimeout(400);
  await h.shoot("07-drop-hint");
  await win.evaluate(() => {
    document.dispatchEvent(new window.DragEvent("dragleave", { bubbles: true }));
    document.dispatchEvent(new window.DragEvent("drop", { bubbles: true }));
  });
});

// 08 暗色首页
await step("08-home-dark", async () => {
  await win.keyboard.press("Escape");
  await win.waitForTimeout(400);
  await win.evaluate(() => {
    document.documentElement.setAttribute("data-theme", "dark");
  });
  await win.waitForTimeout(600);
  await h.shoot("08-home-dark");
});

await h.finish();
if (failures.length > 0) {
  console.error(failures.join("\n"));
}
console.log(`done, failures=${failures.length}`);
