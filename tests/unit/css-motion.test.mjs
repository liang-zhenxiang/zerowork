/**
 * 动效缓动的静态门禁（任务 11-17-ui-p2-polish 第 6 项）。
 *
 * 守的是 `docs/DESIGN.md` §3.2：`transition` 只走 `var(--ease-standard)`，
 * CSS 关键字 `ease`（`cubic-bezier(0.25, 0.1, 0.25, 1)`）不在允许之列 ——
 * 它与 `ease-out` 是两条不同曲线，混用会让「同样的 150ms」在不同控件上
 * 手感不一致。2026-10-01 收口过一轮 49 个裸 `ease`，2026-11-17 又漏出 4 处
 * （`home-quick-btn` / `stats-badge` / 两处已登记的 height / width 过渡）——
 * 只在人工审计里查得到，所以补成门禁。
 *
 * 扫描口径：
 * - 先剥离注释（注释里引用第三方取值如 `.15s ease` 不算违规）；
 * - 只看 `transition:` / `animation:` 声明值；
 * - 「裸 `ease`」= 前后都不是 `-` 或单词字符的 `ease` 令牌。
 *   `var(--ease-standard)` 与 `ease-in-out` / `ease-out` 都不命中。
 *
 * 反向验证（已实际执行）：在 app.css 注入 `transition: color 1s ease;`
 * → `app.css` 那条变红并报出行号与声明值；还原后全绿。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const APP_CSS = fileURLToPath(new URL("../../src/renderer/src/app.css", import.meta.url));

/** 剥离 CSS 注释（替换为空白，保留换行与偏移），避免注释里的示例值参与扫描。 */
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
 * 「裸 `ease`」的判据：令牌本身是 `ease`。
 * `(?<!-)` 排除 `var(--ease-standard)` / `--ease-out`；
 * `(?![\w-])` 排除 `ease-in-out` / `ease-out`。
 */
const BARE_EASE = /(?<![-\w])ease(?![\w-])/;

/** 返回所有「transition / animation 里出现裸 ease」的声明（带行号，便于定位）。 */
function findBareEase(css) {
	const stripped = stripComments(css);
	const hits = [];
	for (const match of stripped.matchAll(/(?:^|[;{\s])(transition|animation)\s*:\s*([^;}]*)/gi)) {
		const prop = match[1];
		const value = match[2];
		if (!BARE_EASE.test(value)) continue;
		const valueStart = match[0].lastIndexOf(value);
		const offset = (match.index ?? 0) + valueStart;
		const line = stripped.slice(0, offset).split("\n").length;
		hits.push({ line, prop, value: value.trim() });
	}
	return hits;
}

describe("css-motion 扫描器自测", () => {
	it("命中裸 ease 的 transition", () => {
		expect(findBareEase(".a { transition: color 1s ease; }")).toEqual([
			{ line: 1, prop: "transition", value: "color 1s ease" },
		]);
	});

	it("命中多属性里夹着的一个裸 ease", () => {
		const hits = findBareEase(".a { transition: color 1s var(--ease-standard), transform 1s ease; }");
		expect(hits).toHaveLength(1);
	});

	it("var(--ease-*) 与 ease-in-out / ease-out 不算裸 ease", () => {
		expect(findBareEase(".a { transition: color 1s var(--ease-standard); }")).toEqual([]);
		expect(findBareEase(".a { animation: fade 1s ease-in-out infinite; }")).toEqual([]);
		expect(findBareEase(".a { animation: fade 1s ease-out; }")).toEqual([]);
	});

	it("注释里的示例值不参与扫描", () => {
		expect(findBareEase("/* transition: color 1s ease; */ .a { color: red; }")).toEqual([]);
	});
});

describe("app.css 动效声明", () => {
	const css = readFileSync(APP_CSS, "utf8");

	it("transition / animation 不出现裸 ease（DESIGN.md §3.2）", () => {
		const hits = findBareEase(css);
		expect(
			hits.map((hit) => `app.css:${hit.line} ${hit.prop}: ${hit.value}`),
			"裸 ease 会与 --ease-standard（ease-out）混成两条曲线；改用 var(--ease-standard)",
		).toEqual([]);
	});
});
