// 第二十一轮截图：5 张断言（skip link / 地标 / 焦点样式 / reduced-motion / 跳转目标）
import { createHarness, waitUntil } from "./lib/harness.mjs";

const h = createHarness({ name: "ui-round21-shots", shots: true });

await h.launch();
const win = h.window();
await win.waitForTimeout(2200);

await h.check("① 跳到主内容链接：Tab 首个到达且目标存在", async () => {
  const skip = await win.evaluate(() => {
    const link = document.querySelector(".skip-link");
    if (link === null) return { link: false };
    return { link: true, target: document.querySelector(link.getAttribute("href")) !== null };
  });
  if (!skip.link) throw new Error("skip link 不存在");
  if (!skip.target) throw new Error("skip link 目标不存在");
  // Tab 聚焦后应可见（位置进入视口）
  await win.keyboard.press("Tab");
  await win.waitForTimeout(200);
  const visible = await win.evaluate(() => {
    const link = document.querySelector(".skip-link");
    const rect = link.getBoundingClientRect();
    return document.activeElement === link && rect.left >= 0 && rect.top >= 0;
  });
  if (!visible) throw new Error("Tab 后 skip link 未可见");
  await h.shoot("01-skip-link-focused");
});

await h.check("② 地标角色：aside/sidebar + main 存在且唯一", async () => {
  const landmarks = await win.evaluate(() => ({
    aside: document.querySelectorAll("aside").length,
    mains: document.querySelectorAll("main").length,
    mainId: document.querySelector("main")?.id ?? "none"
  }));
  if (landmarks.aside < 1) throw new Error("缺 aside 地标（侧栏）");
  if (landmarks.mains !== 1) throw new Error(`main 应恰 1 个，实际 ${landmarks.mains}`);
  if (landmarks.mainId !== "main-content") throw new Error("main 缺 id=main-content");
});

await h.check("③ 焦点样式：focus-visible 有 outline", async () => {
  await win.keyboard.press("Tab");
  await win.waitForTimeout(150);
  const outline = await win.evaluate(() => {
    const el = document.activeElement;
    if (el === null) return null;
    const style = getComputedStyle(el);
    return { tag: el.tagName, outline: style.outlineWidth, color: style.outlineColor };
  });
  if (outline === null || outline.outline === "0px") throw new Error("聚焦元素无 outline");
  await h.shoot("02-focus-visible");
});

await h.check("④ reduced-motion 全局关停生效", async () => {
  await win.emulateMedia({ reducedMotion: "reduce" });
  await win.waitForTimeout(300);
  const anim = await win.evaluate(() => {
    const el = document.querySelector(".aurora") ?? document.querySelector(".app");
    if (el === null) return null;
    return getComputedStyle(el).animationDuration;
  });
  // 全局 0.01ms 规则命中或元素本身无动画都算过；只要不是长动画
  if (anim !== null && anim !== "0s" && parseFloat(anim) > 0.1) throw new Error(`reduce 下仍有长动画 ${anim}`);
  await win.emulateMedia({ reducedMotion: "no-preference" });
});

await h.check("⑤ html lang 与 accent-contrast token", async () => {
  const check = await win.evaluate(() => ({
    lang: document.documentElement.lang,
    contrast: getComputedStyle(document.documentElement).getPropertyValue("--accent-contrast").trim()
  }));
  if (check.lang !== "zh-CN") throw new Error(`lang=${check.lang}`);
  if (check.contrast === "") throw new Error("--accent-contrast 未定义");
});

await h.finish();
