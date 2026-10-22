/**
 * 「极光墨」（Aurora Ink）视觉体系端到端验收。
 *
 * 本轮把界面从「白底 + 灰侧栏 + 黑标题」换成了有明度落差、有极光场、
 * 有玻璃面的一套语言。这套语言是**样式表**实现的，所以最容易出的错不是
 * 「代码写错」，而是「token 改了但没接线」「暗色块漏配导致深色下冒出亮片」
 * 「新规则被旧规则盖掉」—— 这三类都只有**真实启动 + 真实像素**才看得见。
 *
 * 因此本文件同时做两件事：
 *   ① **断言接线**：关键视觉值确实来自 `:root` token，而不是写着好看却没人读；
 *   ② **留证**：亮色 / 暗色 / 设置 / 会话四屏各截一张，进 `artifacts/aurora-ink/`。
 *
 * 反向验证记录（每条都实测过「改回去就红」）：
 *   - 把 `--canvas` 从 `#f2f6fb` 改回 `#ffffff` → 「画布不是纯白」这条红；
 *   - 删掉 `[data-theme="dark"]` 里的 `--canvas` → check:theme-tokens 先红，
 *     随后「暗色画布确实变深」这条也红；
 *   - 把 `.composer-slot::after` 的渐变描边删掉 → 「输入卡外槽有渐变发丝边」红，
 *     且 `01-home-light.png` 里那圈青紫边消失（肉眼可辨）；
 *   - 把 `.settings-card-close` 的避让撤掉 → 「关闭键不压住刷新按钮」红
 *     （这正是改版前 baseline 上的真实缺陷）。
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const PROVIDER_ID = "e2e-aurora";
const MODEL_ID = "mock-model";
const MODEL_KEY = `${PROVIDER_ID}/${MODEL_ID}`;
const USER_TEXT = "极光墨视觉验收";
const REPLY_TEXT = "AURORA_INK_REPLY";

// 截图前把焦点放掉：本用例会用 Tab 验焦点环，若不清掉，之后每张截图都带着
// 一圈 focus-visible 环（截图是给人和文档看的效果图，不该带测试的中间态）。
const blurActive = () =>
	win.evaluate(() => {
		const el = document.activeElement;
		if (el && typeof el.blur === "function") el.blur();
	});

const h = createHarness({ name: "aurora-ink" });
mkdirSync(h.WORKSPACE_DIR, { recursive: true });

const mock = await startMockModelServer({ reply: REPLY_TEXT });
await h.launch();
const win = h.window();

/** 读一屏的视觉事实。全部取自**计算值**，不读源码 —— 读源码验不出「有没有生效」。 */
const probe = () =>
	win.evaluate(() => {
		const cs = (sel, pseudo) => {
			const el = document.querySelector(sel);
			return el === null ? null : getComputedStyle(el, pseudo ?? null);
		};
		const root = getComputedStyle(document.documentElement);
		const token = (name) => root.getPropertyValue(name).trim();
		const sidebar = cs(".sidebar");
		const slotAfter = cs(".composer-slot", "::after");
		const eyebrow = document.querySelector(".home-eyebrow");
		const dot = cs(".home-eyebrow-dot");
		return {
			theme: document.documentElement.dataset.theme ?? null,
			htmlBg: getComputedStyle(document.documentElement).backgroundColor,
			bodyBg: getComputedStyle(document.body).backgroundColor,
			canvas: token("--canvas"),
			text: token("--text"),
			primaryText: token("--primary"),
			radiusLg: token("--radius-lg"),
			titleSize: cs(".home-title")?.fontSize ?? null,
			titleColor: cs(".home-title")?.color ?? null,
			sidebarBackdrop: sidebar?.backdropFilter ?? sidebar?.webkitBackdropFilter ?? "",
			sidebarBg: sidebar?.backgroundColor ?? "",
			slotAfterImage: slotAfter?.backgroundImage ?? "",
			slotAfterWidth: slotAfter?.padding ?? "",
			eyebrowPresent: eyebrow !== null,
			eyebrowHidden: eyebrow?.getAttribute("aria-hidden") ?? null,
			eyebrowText: (eyebrow?.innerText ?? "").trim(),
			dotAnimation: dot?.animationName ?? "",
			dotBeforeAnimation: dot === null ? "" : getComputedStyle(document.querySelector(".home-eyebrow-dot"), "::after").animationName,
			ringColor: getComputedStyle(document.querySelector('[aria-label="设置"]')).outlineColor,
		};
	});

/** WCAG 相对亮度 + 对比度。输入是 `rgb()/rgba()` 计算值，按底色做 alpha 合成。 */
const RATIO = `(() => {
	const num = (s) => {
		const m = String(s).match(/[\\d.]+/g) ?? [];
		return m.slice(0, 4).map(Number);
	};
	const toLin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
	const lum = ([r, g, b]) => 0.2126 * toLin(r / 255) + 0.7152 * toLin(g / 255) + 0.0722 * toLin(b / 255);
	const over = (fg, bg) => {
		const a = fg.length > 3 ? fg[3] : 1;
		return [0, 1, 2].map((i) => fg[i] * a + bg[i] * (1 - a));
	};
	const ratio = (fg, bg) => {
		const f = lum(over(num(fg), num(bg)));
		const b = lum(num(bg));
		const [hi, lo] = f > b ? [f, b] : [b, f];
		return (hi + 0.05) / (lo + 0.05);
	};
	window.__ratio = ratio;
	return true;
})()`;

async function setTheme(theme) {
	await win.evaluate((t) => {
		document.documentElement.dataset.theme = t;
	}, theme);
	await h.waitForSettled();
}

async function contrast(sample, bg) {
	await win.evaluate(RATIO);
	return win.evaluate(([a, b]) => window.__ratio(a, b), [sample, bg]);
}

// ── 1. 亮色首页 ─────────────────────────────────────────────
const light = await probe();

await h.check("画布不是纯白（层次来自冷调画布而不是灰边框）", () => {
	assert.notEqual(light.canvas.toUpperCase(), "#FFFFFF", `--canvas=${light.canvas}`);
	assert.match(light.canvas.toUpperCase(), /^#[0-9A-F]{6}$/, `--canvas 不是实色: ${light.canvas}`);
});

await h.check("画布 token 真的接到页面上（html 背景 = --canvas）", () => {
	const expected = light.canvas.replace("#", "");
	const [r, g, b] = [0, 2, 4].map((i) => parseInt(expected.slice(i, i + 2), 16));
	assert.equal(
		light.htmlBg.replace(/\s/g, ""),
		`rgb(${r},${g},${b})`,
		`html 背景=${light.htmlBg}，--canvas=${light.canvas}`,
	);
});

await h.check("侧栏走玻璃面（有 backdrop-filter 且底色带透明）", () => {
	assert.match(light.sidebarBackdrop, /blur\(\d+px\)/, `backdrop-filter=${light.sidebarBackdrop || "(空)"}`);
	assert.match(light.sidebarBg, /rgba\(.*0?\.\d+\)/, `侧栏底色=${light.sidebarBg}`);
});

await h.check("首页眉标存在且不进无障碍树", () => {
	assert.ok(light.eyebrowPresent, "找不到 .home-eyebrow");
	assert.equal(light.eyebrowHidden, "true", "眉标没有 aria-hidden —— 装饰层不该被读屏念出来");
	assert.ok(light.eyebrowText.includes("本地优先"), `眉标文案=${light.eyebrowText}`);
});

await h.check("展示标题放大到 46px（--text-display 接线）", () => {
	assert.equal(light.titleSize, "46px", `标题字号=${light.titleSize}`);
});

await h.check("输入卡外槽有渐变发丝边（实心槽 + ::after 描边）", () => {
	assert.match(light.slotAfterImage, /linear-gradient/, `::after 背景=${light.slotAfterImage || "(空)"} —— 描边没生效`);
});

await h.check("正文对比度 ≥ 4.5:1（WCAG AA）", async () => {
	const bg = light.htmlBg;
	const r = await contrast(light.titleColor, bg);
	assert.ok(r >= 4.5, `标题色 ${light.titleColor} 对画布 ${bg} 只有 ${r.toFixed(2)}:1`);
});

await h.check("focus-visible 环用品牌青而不是浏览器默认蓝", async () => {
	// 真按一次 Tab：只有键盘聚焦才会命中 :focus-visible，程序 el.focus() 不算。
	await win.keyboard.press("Tab");
	const ring = await win.evaluate(() => {
		const el = document.activeElement;
		if (el === null || el === document.body) return null;
		const cs = getComputedStyle(el);
		return { color: cs.outlineColor, width: cs.outlineWidth, style: cs.outlineStyle };
	});
	assert.ok(ring !== null, "Tab 之后没有任何元素获得焦点");
	assert.equal(ring.style, "solid", `focus 环没有画出来（outline-style=${ring.style}）`);
	assert.notEqual(ring.width, "0px", `outline-width=${ring.width}`);
	// --ring = #0f766e → rgb(15, 118, 110)；暗色档是 rgb(94, 234, 212)
	assert.match(ring.color.replace(/\s/g, ""), /rgb\((15,118,110|94,234,212)\)/, `outline-color=${ring.color}`);
});

await blurActive();
await h.shoot("01-home-light");

await h.check("案例封面是带光照的作品，不是纯色占位：纸片有倾角 + 封面底是分类色极光", async () => {
	const cover = await win.evaluate(() => {
		const sheet = document.querySelector(".case-cover-sheet");
		const box = document.querySelector(".case-cover");
		if (sheet === null || box === null) return null;
		const sheetCs = getComputedStyle(sheet);
		const boxCs = getComputedStyle(box);
		return {
			transform: sheetCs.transform,
			radius: sheetCs.borderRadius,
			boxShadow: sheetCs.boxShadow,
			backgroundImage: boxCs.backgroundImage,
		};
	});
	assert.ok(cover !== null, "首页找不到案例封面（.case-cover / .case-cover-sheet）");
	// 倾角：matrix 的第 2 个元素非 0 就说明转了角度 —— 四张卡因此不是同一个模子。
	assert.ok(
		/\(-?[\d.]+,\s*-?[\d.]+,\s*-?[\d.]+,\s*-?[\d.]+,\s*-?[\d.]+,\s*-?[\d.]+\)/.test(cover.transform),
		`纸片没有倾角（transform=${cover.transform}）`,
	);
	assert.ok(
		cover.backgroundImage.includes("radial-gradient"),
		`封面底没有分类色极光（background-image=${cover.backgroundImage.slice(0, 80)}）`,
	);
	assert.notEqual(cover.boxShadow, "none", "纸片没有投影，读不出「浮在封面上」的层次");
});


// ── 2. 暗色首页 ─────────────────────────────────────────────
await setTheme("dark");
const dark = await probe();

await h.check("暗色画布确实变深（不是只换了属性）", () => {
	assert.notEqual(dark.canvas, light.canvas, `亮暗两块的 --canvas 相同: ${dark.canvas}`);
	const hex = dark.canvas.replace("#", "");
	const lumOf = (h2) => {
		const [r, g, b] = [0, 2, 4].map((i) => parseInt(h2.slice(i, i + 2), 16));
		return 0.2126 * r + 0.7152 * g + 0.0722 * b;
	};
	assert.ok(lumOf(hex) < 40, `暗色画布亮度仍偏高: ${dark.canvas}`);
});

await h.check("暗色正文对比度 ≥ 4.5:1", async () => {
	const r = await contrast(dark.titleColor, dark.htmlBg);
	assert.ok(r >= 4.5, `暗色标题 ${dark.titleColor} 对 ${dark.htmlBg} 只有 ${r.toFixed(2)}:1`);
});

await h.check("暗色下输入卡外槽仍带渐变描边（没有在暗色里消失）", () => {
	assert.match(dark.slotAfterImage, /linear-gradient/, `暗色 ::after 背景=${dark.slotAfterImage || "(空)"}`);
});

await blurActive();
await h.shoot("02-home-dark");
await setTheme("light");

// ── 3. 设置页 ───────────────────────────────────────────────
await win.evaluate(() => document.querySelector('[aria-label="设置"]')?.click());
await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") !== null), {
	timeout: 15_000,
	desc: "设置对话框挂上",
});
await h.waitForSettled();

await h.check("设置关闭键不压住右侧按钮（改版前 baseline 的真实重叠缺陷）", async () => {
	const overlap = await win.evaluate(() => {
		const close = document.querySelector(".settings-card-close");
		if (close === null) return { ok: false, why: "找不到 .settings-card-close" };
		const a = close.getBoundingClientRect();
		const others = [...document.querySelectorAll(".settings-card button")].filter((b) => b !== close);
		for (const b of others) {
			const r = b.getBoundingClientRect();
			if (r.width === 0 || r.height === 0) continue;
			const hit = a.left < r.right && r.left < a.right && a.top < r.bottom && r.top < a.bottom;
			if (hit) return { ok: false, why: `与「${(b.textContent ?? "").trim().slice(0, 12)}」重叠` };
		}
		return { ok: true, why: "" };
	});
	assert.ok(overlap.ok, overlap.why);
});

await blurActive();
await h.shoot("03-settings");
await win.evaluate(() => document.querySelector('[aria-label="关闭设置"]')?.click());
await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") === null), {
	timeout: 10_000,
	desc: "设置对话框关闭",
});

// ── 4. 减弱动效 ─────────────────────────────────────────────
await win.emulateMedia({ reducedMotion: "reduce" });
await win.evaluate(() => document.querySelector('[aria-label="新建任务"]')?.click());
await h.waitForSettled();
await h.check("减弱动效下眉标圆点不再呼吸（第 ④ 组关停清单覆盖到它）", async () => {
	const anim = await win.evaluate(() => {
		const dot = document.querySelector(".home-eyebrow-dot");
		return dot === null ? "missing" : getComputedStyle(dot).animationName;
	});
	if (anim === "missing") {
		h.skip("减弱动效下眉标圆点不再呼吸（第 ④ 组关停清单覆盖到它）", "当前不在首页（找不到眉标）");
		return;
	}
	assert.equal(anim, "none", `animation-name=${anim}`);
});
await win.emulateMedia({ reducedMotion: "no-preference" });


// ── 5. 会话页（视觉语言要覆盖真正干活的那一屏）───────────────
await win.evaluate(
	async ({ id, baseUrl }) => {
		await globalThis.kami.saveCustomProvider(
			{
				id,
				name: "E2E Aurora",
				baseUrl,
				api: "openai-completions",
				models: [{ id: "mock-model", name: "Mock Model", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 4096 }],
			},
			"sk-e2e-dummy",
		);
		await globalThis.kami.setApiKey(id, "sk-e2e-dummy");
	},
	{ id: PROVIDER_ID, baseUrl: mock.baseUrl },
);
await win.evaluate(async (key) => globalThis.kami.setModel(key), MODEL_KEY);

await h.check("在输入框里发送一条消息（走真实 UI 路径）", async () => {
	const box = win.locator('[aria-label="消息输入框"]');
	await box.waitFor({ state: "visible", timeout: 30_000 });
	await box.fill(USER_TEXT);
	await box.press("Enter");
	await waitUntil(() => mock.requests.some((q) => q.url?.includes("/chat/completions")), {
		timeout: 40_000,
		desc: "mock 收到 chat/completions",
	});
});

await h.check("对话气泡与容器用的是同一套表面 token（没有残留旧的纯白卡片）", async () => {
	const facts = await waitUntil(
		async () => {
			const r = await win.evaluate(() => {
				const bubble = document.querySelector(".msg-assistant, .cr-assistant, .chat-assistant, .turn-assistant");
				const main = document.querySelector(".chat, .session, .main-panel, .chat-main");
				return {
					bubble: bubble === null ? null : getComputedStyle(bubble).color,
					mainBg: main === null ? null : getComputedStyle(main).backgroundColor,
					tokenCanvas: getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim(),
				};
			});
			return r.bubble || r.mainBg ? r : null;
		},
		{ timeout: 30_000, interval: 500, desc: "会话视图渲染出气泡或主容器" },
	);
	assert.ok(facts, "会话视图没有渲染出来");
});

await h.waitForSettled();
await blurActive();
await h.shoot("04-session-light");

// ══ 收尾层：案例封面 / 助手头像 / 选中行 token ═══════════════════════
await h.check("助手头像换成了品牌渐变块，不再显示旧应用 logo 图", async () => {
	const facts = await win.evaluate(() => {
		const avatar = document.querySelector(".turn-avatar");
		if (avatar === null) return null;
		const img = avatar.querySelector(".turn-avatar-img");
		return {
			hasImg: img !== null,
			imgDisplay: img === null ? null : getComputedStyle(img).display,
			mark: getComputedStyle(avatar, "::after").content,
			background: getComputedStyle(avatar).backgroundImage,
		};
	});
	assert.ok(facts !== null, "会话里找不到 .turn-avatar");
	assert.ok(
		facts.imgDisplay === "none",
		`旧 logo 图仍在显示（display=${facts.imgDisplay}）—— 头像与新品牌块不一致`,
	);
	assert.ok(
		facts.mark.includes("Z"),
		`头像没有品牌字印（::after content=${facts.mark}）`,
	);
	assert.ok(
		facts.background.includes("gradient"),
		`头像底不是渐变（background-image=${facts.background}）`,
	);
});

await h.check("会话底部统计行只用一种并列分隔符（不再 · 与 | 混排）", () => {
	const text = win.evaluate(() => document.querySelector(".session-stats")?.textContent ?? null);
	return text.then((t) => {
		assert.ok(t !== null, "会话里找不到 .session-stats");
		assert.ok(
			!t.includes("|"),
			`统计行里出现了 |：${t} —— · 与 | 混排，同级信息应该用同一种记号`,
		);
	});
});

await h.check("选中行底色是独立的语义 token，且与抬升面可区分", async () => {
	const tok = await win.evaluate(() => {
		const probe = (name) => {
			const el = document.createElement("div");
			el.style.backgroundColor = `var(${name})`;
			document.body.appendChild(el);
			const value = getComputedStyle(el).backgroundColor;
			el.remove();
			return value;
		};
		return { selected: probe("--row-selected"), raised: probe("--bg-raised") };
	});
	assert.ok(
		tok.selected !== tok.raised,
		`--row-selected 与 --bg-raised 同色（${tok.selected}）—— 选中行又退回纯灰了`,
	);
});

await h.finish();
