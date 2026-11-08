// 第十八轮截图：4 张（强调色切换 / 问候昵称 / 表达偏好区 / 分组短语 chips）
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const h = createHarness({ name: "ui-round18-shots", shots: true });
const REPLY = "第十八轮个性化验证回复。\n\n第二段。\n\n收尾段。";
const mock = await startMockModelServer({ models: ["r18-model"], reply: REPLY });
const SESSIONS_DIR = join(h.CONFIG_DIR, "sessions");
mkdirSync(SESSIONS_DIR, { recursive: true });
const id = "aaaaaaaa-4444-4aaa-8aaa-aaaaaaaaaaa1";
{
  const t = new Date().toISOString();
  const tmp = join(h.WORKSPACE_DIR, "临时任务", "2026-11-09-02-00-00");
  const msg = (mid, parentId, role, text) => JSON.stringify({ type: "message", id: mid, parentId, timestamp: t, message: { role, content: [{ type: "text", text }] }, ...(role === "assistant" ? { model: "r18-model" } : {}) });
  const lines = [
    JSON.stringify({ type: "session", version: 3, id, timestamp: t, cwd: tmp, title: "十八轮的验证会话" }),
    msg(`${id}-u`, id, "user", "十八轮的验证会话"),
    msg(`${id}-a`, `${id}-u`, "assistant", "回复。")
  ];
  const file = join(SESSIONS_DIR, "2026-11-04T00-00-01-000Z_s1.jsonl");
  writeFileSync(file, lines.join("\n") + "\n");
  utimesSync(file, new Date(), new Date());
}
// 预置：昵称 + 一条分组短语
writeFileSync(join(h.CONFIG_DIR, "preferences.json"), JSON.stringify({ userNickname: "阿梁" }), "utf8");
// （昵称写进 preferences.json 即可，无需预置 localStorage）

await h.launch();
const win = h.window();
await win.waitForTimeout(2500);

await h.check("① 问候带昵称 + 强调色切换生效", async () => {
  await waitUntil(() => win.evaluate(() => document.querySelector(".home-greeting-nick") !== null && (document.querySelector(".home-greeting-nick").textContent ?? "").includes("阿梁")), { timeout: 8000, desc: "问候昵称出现" });
  // 切强调色（直接走存储 + apply，等价于设置页点选）
  await win.evaluate(() => {
    localStorage.setItem("zw:accent", "iris");
    document.documentElement.setAttribute("data-accent", "iris");
  });
  await win.waitForTimeout(400);
  const accent = await win.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
  if (!accent.includes("155") && accent !== "#6d4aff" && !/rgb/.test(accent)) throw new Error(`强调色应变为 iris 系，实际「${accent}」`);
  await h.shoot("01-greeting-accent");
  // 还原
  await win.evaluate(() => {
    localStorage.setItem("zw:accent", "aurora");
    document.documentElement.removeAttribute("data-accent");
  });
});

await h.check("② 表达偏好区四排可见", async () => {
  await win.keyboard.press("Meta+k");
  await win.waitForTimeout(400);
  await win.keyboard.type("个性化");
  await win.waitForTimeout(600);
  await win.keyboard.press("Enter");
  await win.waitForTimeout(700);
  await waitUntil(() => win.evaluate(() => [...document.querySelectorAll("h2")].some((h2) => (h2.textContent ?? "") === "表达偏好")), { timeout: 8000, desc: "表达偏好区出现" });
  const rows = await win.evaluate(() => [...document.querySelectorAll(".seg-toggle")].length);
  if (rows < 4) throw new Error(`表达偏好应有 4 排选项组，实际 ${rows}`);
  await h.shoot("02-expression-prefs");
  // 切侧栏密度为紧凑，验证 data 属性生效
  await win.evaluate(() => {
    const btns = [...document.querySelectorAll(".seg-toggle-btn")].filter((b) => (b.textContent ?? "").trim() === "紧凑");
    btns[0]?.click();
  });
  await win.waitForTimeout(400);
  const dense = await win.evaluate(() => document.documentElement.getAttribute("data-sidebar-density") === "compact");
  if (!dense) throw new Error("紧凑密度未生效");
  await win.keyboard.press("Escape");
  await win.waitForTimeout(400);
});

await h.check("③ 侧栏紧凑密度 + 封面色条", async () => {
  // 给种子会话的空间上色（zw:space-colors 存 cwd→index）→ 行首色条。
  // cwd 从 listSessions IPC 拿（task-item 上没有 data-cwd 属性）。
  const cwd = await win.evaluate(async () => {
    const list = await globalThis.kami.listSessions();
    const first = (list ?? []).find((s) => (s.title ?? "").includes("十八轮"));
    return first?.cwd ?? "";
  });
  if (cwd === "") throw new Error("listSessions 没拿到种子会话 cwd");
  await win.evaluate((c) => {
    const store = JSON.parse(localStorage.getItem("zw:space-colors") ?? "{}");
    store[c] = 2;
    localStorage.setItem("zw:space-colors", JSON.stringify(store));
  }, cwd);
  // spaceColors 是 useState（挂载时读一次）——reload 让它重读。
  await win.reload();
  await win.waitForTimeout(1800);
  const strip = await win.evaluate(() => document.querySelector(".sidebar .task-strip") !== null);
  if (!strip) throw new Error("任务行封面色条未出现");
  await h.shoot("03-density-strip");
});

await h.check("④ 分组短语 chips", async () => {
  await win.evaluate(() => {
    localStorage.setItem("zw:quick-chips", JSON.stringify(["总结一下刚才的结论", "写作::帮我润色这段文字", "列出接下来的待办"]));
  });
  // quickChips 是 useMemo([]) 挂载时读一次 —— reload 让它重读。
  await win.reload();
  await win.waitForTimeout(1800);
  const grp = await win.evaluate(() => document.querySelector(".quick-chip-group") !== null && (document.querySelector(".quick-chip-group").textContent ?? "") === "写作");
  if (!grp) throw new Error("分组角标未出现");
  await h.shoot("04-grouped-chips");
});

await h.finish();
mock.close().catch(() => {});
