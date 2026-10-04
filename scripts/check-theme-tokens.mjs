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
 *   ④ **token 块之外的声明里不许出现颜色字面量**（2026-10-04 新增，#105）。
 *      前三项按**名字**比对两个 token 块，因此有一条结构性盲区：它认不出
 *      「压根没走 token 的硬编码颜色」。2026-10-03 踩到的实例是 `.composer-slot`
 *      的亮色渐变裸写（`#f0f0f0` / `#f5f5f5`），暗色块里没有任何覆盖 ——
 *      后果是深色首页的输入卡自带一圈浅灰发光边，而检查全程是绿的。
 *      这一项把「记得住」变成「改错就红」：token 块之外的声明里凡出现
 *      hex / `rgb()` / `hsl()` / 命名色，一律报错，除非在下面的**带理由白名单**里
 *      （白名单按「选择器 + 属性 + 值形态」精确匹配，且**过期条目也会报错**）。
 *
 *      边界：只看 `src/renderer/src/app.css`。其余样式表（`json-mode.css` 是
 *      原样分发的 VS Code 主题、`katex.css` 与 `code-preview.css` 是 vendor 产物）
 *      不在本项目的设计 token 体系内，也没有 `[data-theme]` 块 —— 拿这套判据
 *      去套它们只会得到一屏无意义的告警。
 *
 * 解析用逐字符状态机（跟踪注释/字符串/花括号深度）而不是正则切片，
 * 理由见 .trellis/spec/renderer/ 的「CSS 陷阱」：注释会吞掉选择器与 `}`，
 * 括号配平查不出来，正则更查不出来。:root 在本文件里有三个块
 * （react-pdf 的 textLayer / annotationLayer 各带一个），设计 token 主块
 * 用「含 `--text:` 定义」识别——那是文字色三级的首项，只有主块有。
 *
 * ## 反向验证记录（2026-10-04，第 ④ 项）
 *
 * 1. 往 app.css 末尾塞 `.injected-probe { background: #f0f0f0; color: white }`
 *    → 报两处未登记字面量并退出 1（hex 与命名色两种形态都被抓到）。
 * 2. 把白名单里 `.preview-video` 那条的选择器改成一个不存在的名字 →
 *    **同时**报两条：该处变成「未登记」，且那条白名单变成「用不上的过期条目」。
 *    这一条同时证明两件事：白名单真的在生效，过期条目也会被清出来。
 * 3. 把 `.markdown code.clickable-path` 恢复成 `#e9eef2` 字面量（它就是本项检查
 *    第一次运行时抓到的真漏网）→ 报 2 处未登记字面量。修法见 app.css 该规则的注释。
 *
 * 用法：node scripts/check-theme-tokens.mjs
 *       node scripts/check-theme-tokens.mjs --list   # 只打印 token 块外的颜色字面量清单
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

/**
 * 逐字符扫描**所有**声明（不限顶层），带上它的选择器路径与行号。
 *
 * 与 `collectTopLevelRules` 的分工：那个只收顶层规则（本脚本要看 token 块），
 * 这个要钻进 `@media` / `@keyframes` 里 —— `.composer-slot` 那次踩坑的规则
 * 就完全可能是写在媒体查询里面的。两者共用同一套括号/字符串/注释纪律。
 *
 * @param {string} css 已剥离注释的样式表
 * @returns {Array<{path: string[], selector: string, prop: string, value: string, line: number}>}
 */
function collectDeclarations(css) {
	const out = [];
	const stack = [];
	const lines = [0];
	for (let i = 0; i < css.length; i += 1) if (css[i] === "\n") lines.push(i + 1);
	/** 二分查某个偏移量在第几行（1 起）。 */
	const lineAt = (offset) => {
		let lo = 0;
		let hi = lines.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (lines[mid] <= offset) lo = mid;
			else hi = mid - 1;
		}
		return lo + 1;
	};

	let buffer = "";
	let start = 0;
	let i = 0;
	while (i < css.length) {
		const ch = css[i];
		if (ch === '"' || ch === "'") {
			// 字符串：整段收进 buffer，期间不参与括号/分号判断
			let j = i + 1;
			while (j < css.length) {
				if (css[j] === "\\") j += 2;
				else if (css[j] === ch) {
					j += 1;
					break;
				} else j += 1;
			}
			buffer += css.slice(i, j);
			i = j;
			continue;
		}
		if (ch === "{") {
			stack.push({ selector: buffer.trim(), line: lineAt(start) });
			buffer = "";
			i += 1;
			start = i;
			continue;
		}
		if (ch === "}" || ch === ";") {
			const text = buffer.trim();
			if (text !== "" && stack.length > 0) {
				const colon = text.indexOf(":");
				if (colon > 0) {
					const raw = stack[stack.length - 1].selector;
					out.push({
						path: stack.map((frame) => frame.selector),
						selector: raw,
						// 分组选择器（`a,\n b { }`）按逗号拆开：白名单逐条对，
						// 否则「一条声明服务两个选择器」时怎么写都对不上。
						selectors: raw.split(",").map((part) => part.trim()).filter((part) => part !== ""),
						prop: text.slice(0, colon).trim(),
						value: text.slice(colon + 1).trim(),
						line: lineAt(start),
					});
				}
			}
			// `}` 收掉一层；`;` 只收掉这条声明
			if (ch === "}") stack.pop();
			buffer = "";
			i += 1;
			start = i;
			continue;
		}
		buffer += ch;
		i += 1;
	}
	return out;
}

/**
 * CSS 命名色（完整 148 个）。
 *
 * 为什么用**完整**名单而不是「常见的十几个」：漏掉一个名字就是一处静默盲区，
 * 而 `color: darkgoldenrod` 与 `#b8860b` 是同一种错误。名单是一份数据，
 * 长一点不构成维护负担 —— 它几乎不会变（CSS Color 4 之后没再加过）。
 */
const NAMED_COLORS = new Set(
	("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown " +
		"burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan " +
		"darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid " +
		"darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet " +
		"deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro " +
		"ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
		"lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow " +
		"lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray " +
		"lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine " +
		"mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise " +
		"mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab " +
		"orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru " +
		"pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown " +
		"seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan " +
		"teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen")
		.split(" ")
		.filter(Boolean),
);

/**
 * 掩膜类属性：`mask-image` / `-webkit-mask-image`。
 *
 * 这类值里的颜色**不是颜色**：掩膜只取 alpha（Chromium 的默认 `mask-mode`），
 * `#000` 与 `#fff` 在掩膜里完全等价，写成哪个都不影响渲染，也就谈不上「没走 token」。
 * `.turn-nav-scroller.fade-top` 那三处渐变正是这种形态 —— 把它们当颜色报错
 * 是纯粹的噪声，而噪声会让一条检查很快被无视。
 */
const MASK_PROP = /^(?:-webkit-)?mask(?:-image|-composite|-position|-size|-repeat|-origin|-clip)?$/;

/**
 * 一段声明值里出现的颜色字面量（去重、保持出现顺序）。
 *
 * 刻意**不算**字面量的：`transparent` 与 `currentColor` —— 它们表达的是
 * 「透明」「跟随前景色」，不是某个具体色值，因此与主题无关。
 * 刻意**跳过**的：`url(...)` 的内容（文件名里出现 `white` 不是颜色）。
 */
function colorLiteralsIn(value, prop = "") {
	if (MASK_PROP.test(prop)) return [];
	const found = [];
	const push = (text) => {
		if (!found.includes(text)) found.push(text);
	};
	const scanned = value.replace(/url\([^)]*\)/gi, "url()");
	for (const match of scanned.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) push(match[0].toLowerCase());
	for (const match of scanned.matchAll(/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/g)) {
		push(`${match[0].toLowerCase()}(…)`);
	}
	for (const word of scanned.toLowerCase().matchAll(/[a-z]+/g)) {
		if (NAMED_COLORS.has(word[0])) push(word[0]);
	}
	return found;
}

/**
 * 白名单：token 块之外**允许**的颜色字面量，每条都要写清理由与出处。
 *
 * 匹配是「选择器 + 属性 + 值形态」三重精确 —— 只放松到这一处，不会顺带放松
 * 同一个选择器上的其它属性。**过期条目同样报错**（写了却没人用 = 白名单在
 * 悄悄变宽），与 check-design-exceptions 的口径一致。
 *
 * 2026-10-04（#105）首次盘点：token 块之外的颜色字面量 32 处，去重归类后是下面这些，
 * 每一类都能指到出处。**没有一条是「懒得收 token」** —— 收编它们要么会造出第 7 档
 * 分类色，要么会把语义不同的值压成同一个。
 */
const COLOR_LITERAL_ALLOWED = [
	{
		// PDF 注释层 / 文字层：app.css 开头那一整段是 **pdf.js 的原样复制**
		// （文件第 1 行就是 Mozilla 的 Apache-2.0 版权头）。选区高亮、
		// 链接黄框、表单必填红框、popup 的米黄底都是它的原生观感，
		// 盖在**第三方渲染出来的页面**上，不参与我们的设计 token 体系。
		selector: /^\.(?:textLayer|annotationLayer)\b/,
		prop: /./,
		pattern: /./,
		reason: "pdf.js 原生样式（app.css 第 1 行起的 Mozilla 版权段，原样复制）",
	},
	{
		// 挂件删除键的加深底：它是**控件 scrim**（压在缩略图上让白色 ✕ 可读），
		// 不是模态背板 —— 收编进 --overlay 会让「模态遮罩」这个语义被污染。
		selector: /^\.attachment-remove(?::hover)?$/,
		prop: /^background(-color)?$/,
		pattern: /^rgba?\(/,
		reason: "控件 scrim（app.css 的 --overlay 注释 + docs/DESIGN.md §10.3.2）",
	},
	{
		selector: ".image-preview-overlay",
		prop: /^background(-color)?$/,
		pattern: /^rgba?\(/,
		reason: "全屏看图的沉浸遮罩（app.css 的 --overlay 注释 + docs/DESIGN.md §10.3.2）",
	},
	{
		// 视频信箱底：字母箱要**纯黑**，跟主题走反而不对（亮色主题下视频区
		// 变浅灰会让人以为播放器没加载）。原文注释就写在规则上方。
		selector: ".preview-video",
		prop: "background",
		pattern: /^#000(?:000)?$/i,
		reason: "视频信箱要纯黑，不跟主题走（app.css 该规则上方的注释）",
	},
	// 文件类型分色：按**族**分色（族来自 shared/doc-formats.ts 的 docBadgeOf），
	// 是信息不是状态；--cat-* 只有 6 槽，塞不下。docs/DESIGN.md §10.3.2 已登记。
	{
		selector: ".doc-file-icon.doc-file-pdf",
		prop: "color",
		pattern: /^#c94f4f$/i,
		reason: "文件类型分色（DESIGN §10.3.2）",
	},
	{
		selector: /^\.doc-file-icon\.doc-file-word$|^\.file-icon-code$/,
		prop: "color",
		pattern: /^#4a7bc8$/i,
		reason: "文件类型分色（DESIGN §10.3.2）",
	},
	{
		selector: /^\.doc-file-icon\.doc-file-excel$|^\.file-icon-markdown$/,
		prop: "color",
		pattern: /^#4b9e6b$/i,
		reason: "文件类型分色（DESIGN §10.3.2）",
	},
	{
		selector: ".doc-file-icon.doc-file-ppt",
		prop: "color",
		pattern: /^#d98a3d$/i,
		reason: "文件类型分色（DESIGN §10.3.2）",
	},
	{
		selector: ".file-icon-config",
		prop: "color",
		pattern: /^#b7903d$/i,
		reason: "文件类型分色（DESIGN §10.3.2）",
	},
	{
		selector: ".file-icon-image",
		prop: "color",
		pattern: /^#8b6bc8$/i,
		reason: "文件类型分色（DESIGN §10.3.2）",
	},
	{
		selector: ".file-icon-media",
		prop: "color",
		pattern: /^#c85a8f$/i,
		reason: "文件类型分色（DESIGN §10.3.2）",
	},
	// 档外阴影 5 处声明：都是「场景值」（全屏面板向左的投影、预览菜单、
	// 纸的抬升、开关滑块的贴边投影），归 --shadow-sm/md 会让轻的变重、
	// 重的变轻 —— 收编的代价大于收益。docs/DESIGN.md §10.3.2 已登记。
	{
		selector: ".preview-panel.fullscreen",
		prop: "box-shadow",
		pattern: /rgb\(0 0 0 \/ 6%\)/,
		reason: "档外阴影：全屏面板向左的投影（DESIGN §10.3.2）",
	},
	{
		selector: ".preview-menu",
		prop: "box-shadow",
		pattern: /rgb\(0 0 0 \/ 18%\)/,
		reason: "档外阴影：预览菜单（DESIGN §10.3.2）",
	},
	{
		selector: /^\.preview-pdf-body \.react-pdf__Page$|^\.office-docx \.docx-wrapper>section\.docx$/,
		prop: "box-shadow",
		pattern: /rgb\(0 0 0 \/ 15%\)/,
		reason: "档外阴影：「纸」的抬升（DESIGN §10.3.2，同值两处）",
	},
	{
		selector: /^\.mcp-switch-thumb$|^\.skill-switch-thumb$/,
		prop: "box-shadow",
		pattern: /rgb\(0 0 0 \/ 20%\)/,
		reason: "档外阴影：开关滑块的贴边投影（DESIGN §10.3.2）",
	},
];

/**
 * 白名单命中判定：选择器与属性都要对上（字符串 = 逐字相等，正则 = 匹配），
 * 值形态用正则。只放松到这一处，不会顺带放松同一个选择器上的其它属性 ——
 * 除非该条的 selector/prop 本来就是通配（pdf.js 那种整段 vendor）。
 */
function allowedLiteral(decl, literal) {
	const entry = COLOR_LITERAL_ALLOWED.find(
		(item) =>
			decl.selectors.some((selector) => matches(item.selector, selector)) &&
			matches(item.prop, decl.prop) &&
			item.pattern.test(decl.value),
	);
	return entry === undefined ? null : { entry, literal };
}

/** 白名单字段的匹配：字符串逐字，正则 test。 */
function matches(expected, actual) {
	return expected instanceof RegExp ? expected.test(actual) : expected === actual;
}

/** token 块 = 设计 token 主块 :root 与 [data-theme="dark"] 块（顶层规则）。 */
function isTokenBlockPath(path) {
	return path.length === 1 && (path[0] === ":root" || path[0] === '[data-theme="dark"]');
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

	// ---- ④ token 块之外的颜色字面量（#105 的盲区）----
	const declarations = collectDeclarations(css);
	const outside = declarations.filter((decl) => !isTokenBlockPath(decl.path));
	const offenders = [];
	for (const decl of outside) {
		for (const literal of colorLiteralsIn(decl.value, decl.prop)) {
			const allowed = allowedLiteral(decl, literal);
			offenders.push({ decl, literal, allowed });
		}
	}
	const used = new Set();
	const unallowed = [];
	for (const item of offenders) {
		if (item.allowed === null) unallowed.push(item);
		else used.add(item.allowed.entry);
	}

	if (process.argv.includes("--list")) {
		process.stdout.write(`\n token 块之外的声明 ${outside.length} 条，含颜色字面量 ${offenders.length} 处：\n`);
		for (const item of offenders) {
			const mark = item.allowed === null ? red("漏网") : green("白名单");
			process.stdout.write(
				`  [${mark}] app.css:${item.decl.line}  ${item.decl.selector} { ${item.decl.prop}: ${item.decl.value} }` +
					`  → ${item.literal}\n`,
			);
		}
		return 0;
	}

	if (unallowed.length === 0) {
		process.stdout.write(
			`  ${green("✓")} token 块之外没有未登记的颜色字面量` +
				dim(`（扫描 ${outside.length} 条声明，命中白名单 ${offenders.length} 处）`) +
				"\n",
		);
	} else {
		const detail = unallowed
			.map((item) => {
				const path = item.decl.path.join(" > ");
				return (
					`app.css:${item.decl.line}  ${path} { ${item.decl.prop}: ${item.decl.value} }` +
					`\n        → 颜色字面量「${item.literal}」没有走 token`
				);
			})
			.join("\n      ");
		problems.push(
			`token 块之外有 ${unallowed.length} 处未登记的硬编码颜色（深色用户才会看到的那种错）——\n` +
				`      ${detail}\n` +
				`      处置：① 收进 token（亮暗两块各定义一次，首选）；或 ② 若确实是刻意例外，` +
				`加进本脚本的 COLOR_LITERAL_ALLOWED 并写明理由与出处。`,
		);
	}

	// 白名单里的过期条目也要红：写了却没人用 = 白名单在悄悄变宽
	const stale = COLOR_LITERAL_ALLOWED.filter((entry) => !used.has(entry));
	if (stale.length > 0) {
		problems.push(
			`COLOR_LITERAL_ALLOWED 里有 ${stale.length} 条已经用不上的白名单（对应的声明改了或删了）——\n` +
				`      ${stale.map((entry) => `${entry.selector} { ${entry.prop} }`).join(", ")}\n` +
				`      白名单只在被命中时才生效，过期条目等于悄悄放宽了检查，请删掉。`,
		);
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
