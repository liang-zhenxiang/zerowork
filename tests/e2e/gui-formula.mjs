/**
 * 数学公式渲染的 GUI 测试（issue #74：块级 $$..$$ → KaTeX）。
 *
 * 语法范围（2026-10-02 定案）：**块级走围栏式 $$（独立行开闭）**——
 * remark-math 的 mathFlow 形态；单行 $$..$$ 在 text-math 里是行内形态，
 * 「单行也提升为块」曾用一个后处理插件尝试，结果与消息流的流式/终态
 * 重建相互踩踏（整条消息渲染异常），撤回——后续单独评估再上。行内语法被刻意排除——
 * 单 $ 会把「预算 $500 与 $800 之间」这类金额切走（中文办公场景金额远多于
 * 行内公式），\(..\) 的反斜杠又会被 markdown 转义层吃掉。这是融合取舍，
 * 不是照搬 remark-math 默认（singleDollarTextMath:false）。
 *
 * 链路：remark-math（micromark 字符层捕获，TeX 保真）→ rehype-katex
 * （hast 层渲染出 HTML+MathML）→ katex.css + 核心字体随包（离线可用）。
 * 任何一层断了，表现都是「$$ 原文显示」而不是报错——所以断言锚在
 * KaTeX 真实渲染出的结构上，而不是「没抛异常」。
 *
 * 断言：
 *   ① 块级公式渲染出 KaTeX 结构 + MathML（可访问性路径）；
 *   ② TeX 保真：f(x)\,dx 的 thin space（U+2009）在渲染结果里——反斜杠
 *      序列若被 markdown 转义吃掉，这里第一个红（第一版自写切分的死因）；
 *   ③ 金额写法不误伤（singleDollarTextMath:false 的守卫）；
 *   ④ 浅/深双主题截图 + 像素断言（公式 currentColor 继承，深色下应可见）。
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const reply = [
	"质能方程的积分形式：",
	"",
	"$$",
	"\\int_a^b f(x)\\,dx = F(b) - F(a)",
	"$$",
	"",
	"预算在 $500 与 $800 之间，注意这两个美元符不是公式。",
].join("\n");

const mock = await startMockModelServer({ reply });
console.log(`✓ mock 模型服务已就绪：${mock.baseUrl}`);

const h = createHarness({ name: "formula" });
mkdirSync(h.WORKSPACE_DIR, { recursive: true });

await h.launch();
const win = h.window();

await h.check("注册 mock provider 并发出消息", async () => {
	const r = await win.evaluate(async ({ baseUrl, ws }) => {
		const k = globalThis.kami;
		try {
			await k.saveCustomProvider(
				{
					id: "mock-formula",
					name: "Mock Formula",
					baseUrl,
					api: "openai-completions",
					authHeader: true,
					models: [{ id: "formula-model", name: "formula-model", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }],
				},
				"mock-key",
			);
			await k.setModel("mock-formula/formula-model");
			await k.newTask(ws);
			return { ok: true };
		} catch (e) {
			return { ok: false, err: String(e?.message ?? e).slice(0, 200) };
		}
	}, { baseUrl: mock.baseUrl, ws: h.WORKSPACE_DIR });
	assert.ok(r.ok, `配置失败：${r.err}`);
	const box = win.locator('[aria-label="消息输入框"]');
	await box.waitFor({ state: "visible", timeout: 30_000 });
	await box.fill("推导一下微积分基本定理");
	await box.press("Enter");
	await waitUntil(() => mock.requests.length >= 1, { timeout: 40_000, interval: 500, desc: "消息发出" });
});

// ── ① 块级渲染 + ② TeX 保真（同一稳定窗口取证）─────────────────
/*
 * 取证时机说明（2026-10-02 调试记录）：流式中公式完整闭合的那一刻起，
 * .katex-display 就在且 mspace 已由 KaTeX 解析；而「流式收尾后的终态
 * 重渲染」存在一段内容重建的窗口，紧随其后的查询可能扑空——那属于
 * 消息流生命周期的独立课题，不是公式链路的问题。所以这里在公式渲染
 * 出现的当口一次性取齐全部证据（display/MathML/mspace），后续断言
 * 只消费这份证据，不再二次查询。
 */
const rendered = await waitUntil(
	async () =>
		await win.evaluate(() => {
			const el = document.querySelector(".markdown .katex-display .katex");
			if (el === null) return { found: false };
			return {
				found: true,
				hasMathml: el.querySelector("math") !== null,
				/* 反斜杠序列若被 markdown 转义层吃掉（第一版自写切分的死因），
				 * f(x)\,dx 的 TeX 会变成 f(x),dx（文本逗号）。KaTeX 真解析 \, 输出
				 * <span class="mspace">（不是文本字符，别在 textContent 里找）。 */
				mspace: el.querySelector(".mspace") !== null,
				text: el.textContent ?? "",
			};
		}),
	{ timeout: 40_000, interval: 500, desc: "KaTeX 渲染出块级公式" },
);
await h.check("块级公式渲染出 MathML（可访问性路径）", async () => {
	assert.ok(rendered.hasMathml, "块级公式缺 MathML——KaTeX 未渲染或版本行为变了");
});
await h.check("TeX 保真：\\, 被 KaTeX 真解析（mspace 而非文本逗号）", async () => {
	assert.ok(rendered.mspace, `mspace 不在——TeX 反斜杠序列被 markdown 吃了；文本形态：${JSON.stringify(rendered.text.slice(0, 50))}`);
});
await h.waitForSettled();
await h.shoot("formula-light");

// ── ③ 金额不误伤 ─────────────────────────────────────────────
await h.check("金额写法的 $ 不被切走", async () => {
	const kept = await win.evaluate(() => document.body.innerText.includes("$500") && document.body.innerText.includes("$800"));
	assert.ok(kept, "「$500 与 $800」被公式切分吞掉了——singleDollarTextMath:false 的守卫失效");
});

// ── ④ 深色下的公式 ───────────────────────────────────────────
await h.check("深色主题下公式仍渲染（currentColor 继承）", async () => {
	await win.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
	await h.waitForSettled();
	const visible = await waitUntil(
		async () =>
			await win.evaluate(() => {
				const el = document.querySelector(".markdown .katex-display .katex, .markdown .katex");
				if (el === null) return false;
				const style = getComputedStyle(el);
				return style.color !== "rgba(0, 0, 0, 0)" && el.getBoundingClientRect().height > 4;
			}),
		{ timeout: 30_000, interval: 500, desc: "深色下公式容器可见" },
	);
	assert.ok(visible, "深色下公式容器不可见/零高度");
	await h.shoot("formula-dark");
	await win.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
});

await h.finish();
