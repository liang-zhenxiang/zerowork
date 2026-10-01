#!/usr/bin/env node
/**
 * check-theme-tokens.mjs —— 主题 token 契约检查
 *
 * 防的是「以后有人加了新颜色 token 忘配暗色」这件事——暗色主题落地之后
 * 它会反复发生：亮色块加一个 `--cat-7`，暗色块没跟上，深色用户那里就是
 * 一个刺眼的亮色值（或 var() 解析失败的继承色）。这类错静态上看不出来，
 * 只有深色下肉眼可见，而开发机日常是浅色。
 *
 * 三项断言：
 *   ① 暗色块必须覆盖亮色块中所有**随主题变化**的 token。
 *      「随主题变化」用反名单判定：间距/字号/圆角/时长/缓动/层级/字体
 *      这些**档位类** token 不随主题变（app.css 暗色块尾注原话：
 *      「间距/字号/圆角/时长/缓动/层级/字体 不随主题变化，继承 :root」），
 *      名单之外（颜色/阴影/遮罩/分类色）一律要求暗色块有同名定义。
 *      名单用**精确枚举**而不是前缀：字号五档是 `--text-meta` 这类名字，
 *      与文字色 `--text` 同前缀，纯前缀区分不了「颜色」与「字号」。
 *   ② app.css 存在顶层 `[data-theme="dark"]` 规则（剥注释后判定）。
 *      现状说明：app.css **没有** `prefers-color-scheme` 媒体查询那一路——
 *      任务 design.md 所述「双路规则已在 app.css」与实际不符，双路结构只在
 *      app.js 的 widget 字符串里（断言 ③）；主应用「跟随系统」档的实际机制
 *      是主进程 nativeTheme.themeSource + 渲染层 data-theme 属性路径。
 *      因此这里**不**断言 app.css 的 prefers-color-scheme 必须出现；
 *      未来接线若补上媒体查询一路，本断言也不挡（存在性检查仍然通过）。
 *   ③ app.js 的 widget 样式字符串里双路暗色规则齐全：显式
 *      `:root[data-theme="dark"]` 与 `@media (prefers-color-scheme: dark)
 *      { :root:not([data-theme="light"]) … }` 成对——widget iframe 的暗色
 *      靠这两条路分别响应「宿主显式设置」与「系统偏好」，删掉任何一路
 *      都会让 widget 在某个档位下与宿主界面割裂。
 *
 * 解析用逐字符状态机（跟踪注释/字符串/花括号深度）而不是正则切片，
 * 理由见 .trellis/spec/renderer/ 的「CSS 陷阱」：注释会吞掉选择器与 `}`，
 * 括号配平查不出来，正则更查不出来。:root 在本文件里有三个块
 * （react-pdf 的 textLayer / annotationLayer 各带一个），设计 token 主块
 * 用「含 `--text:` 定义」识别——那是文字色三级的首项，只有主块有。
 *
 * 用法：node scripts/check-theme-tokens.mjs
 * 退出码：0 契约成立，1 有违背。
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (USE_COLOR ? `\u001b[${code}m${text}\u001b[0m` : text);
const green = (t) => paint("32", t);
const red = (t) => paint("31", t);
const dim = (t) => paint("2", t);

/**
 * 「不随主题变化」的 token 名单（精确枚举）。
 * 档位数量本身是 docs/DESIGN.md §2 的硬约束（间距 7 / 字号 5 / 圆角 4 /
 * 时长 3 / 缓动 2 / 层级 5 / 字体 2），这里照抄档位表——顺带守住
 * 「名单里多出一个陌生名字」这种情况：有人加第 8 档间距时，这里改名单
 * 就是一次显式决策，而不是静默放行。
 */
const THEME_INVARIANT = new Set([
	// 间距 7 档（4 的倍数主轴，6 是桌面紧凑控件特批档）
	"--space-1",
	"--space-2",
	"--space-3",
	"--space-4",
	"--space-5",
	"--space-6",
	"--space-7",
	// 字号 5 档——注意与文字色 --text 同前缀，必须枚举而非前缀匹配
	"--text-meta",
	"--text-list",
	"--text-body",
	"--text-emphasis",
	"--text-display",
	// 圆角 4 档
	"--radius-sm",
	"--radius-md",
	"--radius-lg",
	"--radius-full",
	// 时长 3 档
	"--dur-fast",
	"--dur-base",
	"--dur-slow",
	// 缓动 2 个
	"--ease-out",
	"--ease-standard",
	// 层级 5 档
	"--z-base",
	"--z-panel",
	"--z-overlay",
	"--z-modal",
	"--z-toast",
	// 字体栈 2 个（唯一真源，主题无关）
	"--font-body",
	"--font-mono",
]);

/**
 * 逐字符剥离 CSS 注释（内容替换为空白，保留换行以维持行号）。
 * 注释内的 `{`/`}`/选择器文本都会污染规则收集，必须先剥掉——
 * app.css 头部注释里就引用着 `[data-theme="dark"]` 字样。
 */
function stripComments(css) {
	let out = "";
	let i = 0;
	while (i < css.length) {
		const open = css.indexOf("/*", i);
		if (open === -1) {
			out += css.slice(i);
			break;
		}
		out += css.slice(i, open);
		const close = css.indexOf("*/", open + 2);
		if (close === -1) {
			// 未闭合注释：按「吃到文件尾」处理（与浏览器行为一致），
			// 这里不报错——有没有闭合不影响本脚本只看得到什么规则
			out += " ".repeat(css.length - open);
			break;
		}
		// 用空白顶替注释原文，保持偏移量与行列号不变
		const body = css.slice(open, close + 2);
		out += body.replace(/[^\n]/g, " ");
		i = close + 2;
	}
	return out;
}

/**
 * 收集顶层规则（selector 与去注释的 body）。
 * 花括号配平走状态机：字符串里的括号不算深度。@media 等嵌套块的
 * 内部规则在 depth ≥ 1，不单独收集——本脚本只关心顶层的设计 token 块。
 */
function collectTopLevelRules(css) {
	const rules = [];
	const stack = [];
	let buffer = "";
	for (let i = 0; i < css.length; i += 1) {
		const ch = css[i];
		if (ch === '"' || ch === "'") {
			// 字符串：跳到配对引号（含 \ 转义），期间不参与括号/选择器判断
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
			if (frame && stack.length === 0) {
				rules.push({ selector: frame.selector, body: css.slice(frame.start, i) });
			}
			buffer = "";
			continue;
		}
		if (stack.length === 0) buffer += ch;
	}
	return rules;
}

/** 从声明块文本提取自定义属性名（`--xxx:` 的 xxx）。 */
function customPropNames(body) {
	const names = new Set();
	for (const match of body.matchAll(/^[ \t]*(--[A-Za-z0-9_-]+)[ \t]*:/gm)) {
		names.add(match[1]);
	}
	return names;
}

function main() {
	const problems = [];
	const css = stripComments(readFileSync(path.join(ROOT, "src/renderer/src/app.css"), "utf8"));
	const appJs = readFileSync(path.join(ROOT, "src/renderer/src/app.js"), "utf8");
	const rules = collectTopLevelRules(css);

	process.stdout.write("\n主题 token 契约\n");

	// 设计 token 主块：:root 且含 --text: 定义（pdf 的两个 :root 块没有它）
	const rootBlocks = rules.filter((r) => r.selector === ":root");
	const mainRoot = rootBlocks.find((r) => /^[\s]*--text:/m.test(r.body));
	if (!mainRoot) {
		problems.push("app.css 里找不到定义设计 token 的 :root 主块（判据：含 `--text:` 定义）");
	}
	const darkBlocks = rules.filter((r) => r.selector === '[data-theme="dark"]');
	if (darkBlocks.length === 0) {
		problems.push('app.css 里找不到顶层的 `[data-theme="dark"]` 规则（暗色块被删或被注释吞掉）');
	}

	// ---- ① 暗色块覆盖所有随主题变化的 token ----
	if (mainRoot && darkBlocks.length > 0) {
		const light = customPropNames(mainRoot.body);
		const dark = new Set();
		for (const block of darkBlocks) {
			for (const name of customPropNames(block.body)) dark.add(name);
		}
		const missing = [...light].filter((name) => !THEME_INVARIANT.has(name) && !dark.has(name)).sort();
		const exempt = [...light].filter((name) => THEME_INVARIANT.has(name)).length;
		if (missing.length === 0) {
			process.stdout.write(
				`  ${green("✓")} 暗色块覆盖全部随主题变化的 token（亮色 ${light.size} 项，` +
					`其中 ${exempt} 项为档位类不随主题变）\n`,
			);
		} else {
			problems.push(
				`暗色块缺以下 token 的同名定义（深色下会回退亮色值或继承色）——\n` +
					`      ${missing.join(", ")}\n` +
					`      若某个 token 确实不随主题变，把它加进本脚本的 THEME_INVARIANT 名单并注明理由。`,
			);
		}
	}

	// ---- ② 暗色块存在性（含顶层选择器形态检查）----
	if (darkBlocks.length > 0) {
		process.stdout.write(
			`  ${green("✓")} app.css 存在顶层 [data-theme="dark"] 规则（${darkBlocks.length} 处）` +
				dim("（app.css 无媒体查询一路是当前现状，见本文件头部说明）") +
				"\n",
		);
	}

	// ---- ③ widget 双路暗色规则（在 app.js 的样式字符串里）----
	const widgetExplicit = ':root[data-theme="dark"]';
	const widgetMedia = '@media (prefers-color-scheme: dark) { :root:not([data-theme="light"])';
	const hasExplicit = appJs.includes(widgetExplicit);
	const hasMedia = appJs.includes(widgetMedia);
	if (hasExplicit && hasMedia) {
		process.stdout.write(
			`  ${green("✓")} widget 双路暗色规则齐全（显式 data-theme + prefers-color-scheme 媒体查询）\n`,
		);
	} else {
		if (!hasExplicit) problems.push(`app.js 的 widget 样式串里找不到 \`${widgetExplicit}\``);
		if (!hasMedia) problems.push(`app.js 的 widget 样式串里找不到 \`${widgetMedia}\``);
	}

	if (problems.length === 0) {
		process.stdout.write(`  ${dim("（改 THEME_INVARIANT 名单 = 显式决策「这个 token 不随主题变」，须写明理由）")}\n`);
		return 0;
	}

	process.stdout.write(`\n${red("契约被打破：")}\n`);
	for (const problem of problems) process.stdout.write(`  ✗ ${problem}\n`);
	return 1;
}

process.exit(main());
