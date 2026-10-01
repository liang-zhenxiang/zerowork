#!/usr/bin/env node
/**
 * check-design-exceptions.mjs —— 受控例外登记表与代码引用的一致性校验
 *
 * `docs/DESIGN.md` §5.1 禁止过渡布局属性，破例必须在 §5 的登记表里**登记并编号**，
 * 且「未登记的布局属性过渡一律不放行」。这条规则此前只有人的自觉在守 ——
 * 结果是四处漂移：代码引用了表里没有的 ③，表里的 ⑤ 写的是「轨道高度」而真正用 ⑤ 的
 * 是 widget iframe，同一条 `flex-basis` 例外同时被叫「④」和「第二条 width 例外」。
 *
 * 这个脚本把它变成机器能查的四条：
 *
 *   ① **代码引用的编号都在表里**。`app.css` 里写 `§5 受控例外 ③`，表里就得有 ③。
 *   ② **表里的编号在代码里都有出处**。反向也查 —— 否则表会变成一份没人用的清单。
 *   ③ **每条布局属性过渡都有就近的编号引用**。这是 §5.1 那句「未登记的一律不放行」
 *      的可执行版本：新加一条 `transition: height …` 而附近没有编号，直接失败。
 *   ④ **不许出现平行叫法**（「第 N 条 width 例外」这类描述性名字）。编号只有一套，
 *      两套并行时读的人无从判断哪个权威 —— §5 的编号规则就是为此立的。
 *
 * 用法：
 *   node scripts/check-design-exceptions.mjs
 *
 * 退出码：0 一致，1 存在漂移。
 *
 * **不做**的事：
 *   · 只扫 `src/renderer/src/app.css`。全仓只有它带 §5 的编号引用（`workspace.js` /
 *     `code-preview.js` 是随包的第三方解码器，不参与本项目工具链）。哪天别的样式文件
 *     也要登记例外，把这个脚本的扫描范围扩到那个文件即可 —— 别只改样式不改这里。
 *   · 不判断「这条例外**该不该**存在」—— 那是设计评审的事，机器只知道「登记了没有」。
 *   · ③ 的「就近」是一个**行窗口**（声明行向上 60 行、向下 3 行），不是严格的注释块归属。
 *     窗口内的编号引用可能来自邻近的另一条规则 —— 它防的是「加了过渡却一个字没写」，
 *     不是「引用了错误的编号」（那要靠 ① 的语义核对 + 人看）。
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESIGN = path.join(ROOT, 'docs/DESIGN.md');
const APP_CSS = path.join(ROOT, 'src/renderer/src/app.css');

/** 圈码的码点区间：① = U+2460 … ⑳ = U+2473。 */
const CIRCLED = '\\u2460-\\u2473';

/**
 * 「引用了某个例外编号」的形态。收录本仓库实际使用过的三种写法：
 *   `§5 受控例外 ③`、`受控例外 ③`、`（例外 ④，…）`
 * 允许「例外」与编号之间隔一个左括号与空白。**右括号不算** —— 那正是
 * `受控例外）：① 理由…` 这种「编号其实是理由序号」的写法，它不该被当成引用。
 */
const CITATION = new RegExp(`(?:受控)?例外\\s*[（(]?\\s*([${CIRCLED}])`, 'g');

/** 被 §5.1 点名（或同类）的布局属性。 */
const LAYOUT_PROP =
	/(?:^|[\s,(])(width|height|flex-basis|flex-grow|flex-shrink|margin|padding|inset|font-size|line-height|gap|top|left|right|bottom)(?=[\s,;)]|$)/;

/** 平行叫法：`第二条 width 受控例外` 之类。§5 只认编号。 */
const PARALLEL_NAMING = /第[一二三四五六七八九十]+条\s*width/;

const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (USE_COLOR ? `\u001b[${code}m${text}\u001b[0m` : text);
const green = (t) => paint('32', t);
const red = (t) => paint('31', t);
const dim = (t) => paint('2', t);

/**
 * 从 DESIGN.md 里抽出 §5 的登记表编号。
 *
 * 范围取 `## §5 受控例外` 到下一个 `## ` 之间（§5.1 是 `###`，留在范围内也无妨 ——
 * 它里面没有表格）。表行形如 `| ③ | 例外 | 理由 |`，取第一格。
 */
function readRegisteredNumbers(text) {
	const lines = text.split('\n');
	const start = lines.findIndex((l) => /^##\s*§5\s/.test(l));
	if (start < 0) return { error: '在 docs/DESIGN.md 里找不到 `## §5 受控例外` 这一节' };
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((l) => /^##\s/.test(l));
	const section = (end < 0 ? rest : rest.slice(0, end)).join('\n');

	const numbers = [];
	for (const line of section.split('\n')) {
		if (!line.trimStart().startsWith('|')) continue;
		const first = line.split('|')[1]?.trim() ?? '';
		if (new RegExp(`^[${CIRCLED}]$`).test(first)) numbers.push(first);
	}
	if (numbers.length === 0) return { error: '`## §5 受控例外` 里没有解析到任何编号表行' };
	return { numbers };
}

/** 扫描 app.css：编号引用、布局属性过渡声明、平行叫法。 */
function readCssFacts(text) {
	const citations = [];
	const transitions = [];
	const parallel = [];

	text.split('\n').forEach((line, index) => {
		const lineNo = index + 1;

		CITATION.lastIndex = 0;
		let m;
		while ((m = CITATION.exec(line)) !== null) citations.push({ number: m[1], line: lineNo });

		const transition = line.match(/transition\s*:\s*([^;]+)/);
		if (transition && LAYOUT_PROP.test(transition[1])) {
			transitions.push({ line: lineNo, decl: transition[1].trim() });
		}

		if (PARALLEL_NAMING.test(line)) parallel.push({ line: lineNo });
	});

	return { citations, transitions, parallel };
}

/** 声明行附近（向上 60 行、向下 3 行）有没有编号引用。 */
function hasNearbyCitation(citations, line) {
	return citations.some((c) => c.line <= line + 3 && c.line >= line - 60);
}

function main() {
	const problems = [];

	if (!existsSync(DESIGN) || !existsSync(APP_CSS)) {
		process.stdout.write(`\n${red('受控例外校验：找不到 docs/DESIGN.md 或 src/renderer/src/app.css')}\n`);
		return 1;
	}

	const registered = readRegisteredNumbers(readFileSync(DESIGN, 'utf8'));
	if (registered.error) {
		process.stdout.write(`\n${red(`受控例外校验：${registered.error}`)}\n`);
		return 1;
	}

	const { citations, transitions, parallel } = readCssFacts(readFileSync(APP_CSS, 'utf8'));

	// ① 表内编号唯一
	const seen = new Set();
	for (const n of registered.numbers) {
		if (seen.has(n)) problems.push(`docs/DESIGN.md §5 的编号 ${n} 出现了两次 —— 编号必须唯一`);
		seen.add(n);
	}

	// ② 代码引用的编号都登记过
	const table = new Set(registered.numbers);
	const citedNumbers = new Set();
	for (const c of citations) {
		citedNumbers.add(c.number);
		if (!table.has(c.number)) {
			problems.push(
				`app.css:${c.line} 引用了受控例外 ${c.number}，但 docs/DESIGN.md §5 的表里没有它`,
			);
		}
	}

	// ③ 表里的编号在代码里有出处
	for (const n of registered.numbers) {
		if (!citedNumbers.has(n)) {
			problems.push(`docs/DESIGN.md §5 登记了 ${n}，但 app.css 里没有任何地方引用它`);
		}
	}

	// ④ 每条布局属性过渡都要有就近的编号引用
	for (const t of transitions) {
		if (!hasNearbyCitation(citations, t.line)) {
			problems.push(
				`app.css:${t.line} 过渡了布局属性（${t.decl}），附近却没有 §5 的例外编号 —— ` +
					'§5.1 的「未登记的布局属性过渡一律不放行」不成立',
			);
		}
	}

	// ⑤ 不许平行叫法
	for (const p of parallel) {
		problems.push(
			`app.css:${p.line} 用了「第 N 条 width 例外」这类描述性叫法 —— ` +
				'§5 只认全局编号（如 `受控例外 ④`），两套编号并行时无从判断哪个权威',
		);
	}

	// ---- 报告 ----
	process.stdout.write('\n受控例外校验\n');
	process.stdout.write(
		`  §5 登记 ${registered.numbers.length} 条（${registered.numbers.join(' ')}）；` +
			`app.css 引用 ${citations.length} 处、布局属性过渡 ${transitions.length} 条\n`,
	);

	if (problems.length === 0) {
		process.stdout.write(
			`  ${green('✓')} 代码引用的编号都能在 §5 查到，表里的编号都有出处，` +
				'每条布局属性过渡都挂了编号\n',
		);
		return 0;
	}

	process.stdout.write(`\n${red('漂移：')}\n`);
	for (const problem of problems) process.stdout.write(`  ✗ ${problem}\n`);
	process.stdout.write(
		dim(
			'  编号是全局序号、从 ③ 起且不复用（①② 留空）；规则见 docs/DESIGN.md §5。\n',
		),
	);
	return 1;
}

process.exit(main());
