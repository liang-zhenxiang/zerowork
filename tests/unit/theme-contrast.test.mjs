/**
 * 文字色对比度单测（2026-11-16 UI 一致性 Top 5 第 1 项）。
 *
 * 守的是这件事：`--text-faint` 承载「3 个模板」「1 会话」「由本地 hook 生成」
 * 这类**必须读到**的信息，却在亮色下只有 2.94:1（暗色更低），低于 WCAG AA
 * 正文的 4.5:1。修好之后如果没有人拦着，后人为了「层级更明显」再把它调淡，
 * 这个缺陷就会静默回来 —— 肉眼看截图分不出 2.94 与 4.53。
 *
 * 做法：直接解析 `app.css` 的 token（单一真源），按 alpha 混色合成到各主题的
 * 画布 / 抬升面上，再算 WCAG 相对亮度对比度。**token 找不到就失败** ——
 * 否则改名之后测试会静默跳过，变成一条永远绿的假防线。
 *
 * 反向验证（已实际执行）：把亮色 `--text-faint` 改回 `rgba(10, 18, 32, 0.44)`
 * → 本文件的亮色三条断言变红（实测 2.94 / 2.94 / 2.92），其余全绿；还原后全绿。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APP_CSS = fileURLToPath(new URL("../../src/renderer/src/app.css", import.meta.url));
const WCAG_AA_NORMAL = 4.5;

/** 剥离 CSS 注释（替换为空白，保留换行与偏移），避免注释里的 token 名参与解析。 */
function stripComments(css) {
	let i = 0;
	let out = "";
	while (i < css.length) {
		const open = css.indexOf("/*", i);
		if (open === -1) {
			out += css.slice(i);
			break;
		}
		out += css.slice(i, open);
		const close = css.indexOf("*/", open + 2);
		if (close === -1) {
			out += " ".repeat(css.length - open);
			break;
		}
		out += css.slice(open, close + 2).replace(/[^\n]/g, " ");
		i = close + 2;
	}
	return out;
}

/**
 * 收集顶层规则（选择器 + 声明块）。逐字符走一遍，跳过字符串里的花括号 ——
 * 与 scripts/check-theme-tokens.mjs 同一套纪律（见 .trellis/spec/renderer 的
 * 「CSS 陷阱」：注释丢收尾符会吞掉整条规则，正则切片查不出来）。
 */
function topLevelRules(css) {
	const rules = [];
	const stack = [];
	let buffer = "";
	for (let i = 0; i < css.length; i += 1) {
		const ch = css[i];
		if (ch === '"' || ch === "'") {
			let j = i + 1;
			while (j < css.length) {
				if (css[j] === "\\") j += 2;
				else if (css[j] === ch) break;
				else j += 1;
			}
			if (stack.length === 0) buffer += css.slice(i, Math.min(j + 1, css.length));
			i = j;
			continue;
		}
		if (ch === "{") {
			stack.push({ selector: buffer.trim(), start: i + 1 });
			buffer = "";
			continue;
		}
		if (ch === "}") {
			const frame = stack.pop();
			if (frame !== undefined && stack.length === 0) {
				rules.push({ selector: frame.selector, body: css.slice(frame.start, i) });
			}
			buffer = "";
			continue;
		}
		if (stack.length === 0) buffer += ch;
	}
	return rules;
}

/** 主 token 块：`:root` 且定义了 `--text:`（pdf.js 的另外两个 :root 块没有它）。 */
function mainRootRule(rules) {
	return rules.find((rule) => rule.selector === ":root" && /^[ \t]*--text[ \t]*:/m.test(rule.body));
}

/** 暗色 token 块：顶层 `[data-theme="dark"]`。 */
function darkRootRule(rules) {
	return rules.find((rule) => rule.selector === '[data-theme="dark"]');
}

/** 声明块 → Map（同名后者胜，与浏览器行为一致）。 */
function tokenMap(body) {
	const map = new Map();
	for (const match of body.matchAll(/^[ \t]*(--[A-Za-z0-9_-]+)[ \t]*:[ \t]*([^;]+);/gm)) {
		map.set(match[1], match[2].trim());
	}
	return map;
}

function readToken(map, name, theme) {
	const value = map.get(name);
	expect(value, `${theme} 主题的 app.css 里找不到 ${name}（改名后本测试会静默失效，故直接失败）`).toBeDefined();
	return value;
}

function parseHex(text) {
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
	if (hex === null) return null;
	const raw = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
	return {
		r: Number.parseInt(raw.slice(0, 2), 16),
		g: Number.parseInt(raw.slice(2, 4), 16),
		b: Number.parseInt(raw.slice(4, 6), 16),
		a: 1,
	};
}

function parseRgba(text) {
	const match = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i.exec(
		text,
	);
	if (match === null) return null;
	const alpha = match[4] === undefined ? 1 : match[4].endsWith("%") ? Number.parseFloat(match[4]) / 100 : Number.parseFloat(match[4]);
	return {
		r: Number.parseFloat(match[1]),
		g: Number.parseFloat(match[2]),
		b: Number.parseFloat(match[3]),
		a: alpha,
	};
}

/** 解析 token 值里的颜色；不认识的写法直接抛错（不静默当透明白）。 */
function parseColor(value, label) {
	const trimmed = value.trim();
	const color = parseHex(trimmed) ?? parseRgba(trimmed);
	if (color === null) throw new Error(`${label} 的取值「${trimmed}」不是本测试支持的 hex / rgba 写法`);
	return color;
}

/** 把带 alpha 的前景合成到不透明背景上。 */
function composite(fg, bg) {
	const mix = (f, b) => f * fg.a + b * (1 - fg.a);
	return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: 1 };
}

/** WCAG 2.x 相对亮度。 */
function relativeLuminance({ r, g, b }) {
	const channel = (value) => {
		const c = value / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a, b) {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const css = stripComments(readFileSync(APP_CSS, "utf8"));
const rules = topLevelRules(css);
const lightTokens = tokenMap(mainRootRule(rules)?.body ?? "");
const darkTokens = tokenMap(darkRootRule(rules)?.body ?? "");

describe("对比度计算器自身", () => {
	it("纯黑与纯白是 WCAG 的 21:1 上限", () => {
		const black = { r: 0, g: 0, b: 0, a: 1 };
		const white = { r: 255, g: 255, b: 255, a: 1 };
		expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
	});

	it("alpha 混色按剩余比例把背景提上来", () => {
		const halfBlack = composite({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 });
		expect(halfBlack).toMatchObject({ r: 127.5, g: 127.5, b: 127.5 });
	});
});

for (const theme of ["light", "dark"]) {
	const tokens = theme === "light" ? lightTokens : darkTokens;

	describe(`${theme} 主题`, () => {
		const surfaces = {
			"--bg": parseColor(readToken(tokens, "--bg", theme), `${theme} --bg`),
			"--surface-1": parseColor(readToken(tokens, "--surface-1", theme), `${theme} --surface-1`),
			"--surface-2": parseColor(readToken(tokens, "--surface-2", theme), `${theme} --surface-2`),
			/* 抬升面也是 faint 的宿主（选中行、次级卡），不能漏。 */
			"--bg-raised": parseColor(readToken(tokens, "--bg-raised", theme), `${theme} --bg-raised`),
		};
		const colors = {
			"--text-faint": parseColor(readToken(tokens, "--text-faint", theme), `${theme} --text-faint`),
			"--text-secondary": parseColor(readToken(tokens, "--text-secondary", theme), `${theme} --text-secondary`),
		};

		for (const [colorName, color] of Object.entries(colors)) {
			for (const [surfaceName, surface] of Object.entries(surfaces)) {
				it(`${colorName} 在 ${surfaceName} 上达到 WCAG AA 正文（≥ ${WCAG_AA_NORMAL}:1）`, () => {
					const ratio = contrastRatio(composite(color, surface), surface);
					expect(
						ratio,
						`${theme} 主题下 ${colorName} 在 ${surfaceName} 上只有 ${ratio.toFixed(2)}:1`,
					).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
				});
			}
		}

		it("选中态（--primary-active 底 + --primary-text 字）达到 WCAG AA 正文", () => {
			const bg = parseColor(readToken(tokens, "--primary-active", theme), `${theme} --primary-active`);
			const fg = parseColor(readToken(tokens, "--primary-text", theme), `${theme} --primary-text`);
			const ratio = contrastRatio(composite(fg, bg), bg);
			expect(
				ratio,
				`${theme} 主题下选中态文字只有 ${ratio.toFixed(2)}:1（深青底配深字会跌破 AA）`,
			).toBeGreaterThanOrEqual(WCAG_AA_NORMAL);
		});
	});
}
