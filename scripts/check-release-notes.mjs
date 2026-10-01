#!/usr/bin/env node
/**
 * check-release-notes.mjs —— 首次运行指引的守卫
 *
 * ## 守的是什么
 *
 * 用户是从 **GitHub Release 页**下载安装包的，装完打不开时回到的**还是那个页面**。
 * 那一刻他要的答案只有一个：**「为什么打不开、我该怎么办」**。
 * 而安装包没有代码签名，所以这句话必须出现在他真正会看到的地方 ——
 * 发布说明里，且在 PR 清单**之前**。
 *
 * 于是本脚本断言三个对外界面上都具备同一组**能力**：
 *
 *   ① 说清「包没有代码签名」（缺了它，用户会以为下到了坏文件或恶意软件）
 *   ② 说清「这是正常的」（用户的原话就是「是正常的吗？」—— 这一句是问题的正面回答）
 *   ③ macOS 怎么打开（右键打开；右键不管用时去系统设置里放行）
 *   ④ Windows 怎么打开（SmartScreen 的「仍要运行」）
 *
 * ## 为什么不用「文件里出现某几个字」那种断言
 *
 * 那种断言一改文案就失效，维护者下一次顺手就把它删掉了 —— 防线等于没有。
 * 这里断言的是**能力**：换措辞不会变红，**删掉其中任一条才会**。
 *
 * 对 `release.yml` 还额外断言**位置**：指引必须在 PR 清单之前。
 * 位置是这条需求的一半 —— v0.3.0 及以前它写在发布说明的**最末尾**，
 * 用户没翻到，直接来问「有一个装完打不开，是正常的吗？」
 *
 * ## 刻意不做的事
 *
 * 不跑发布、不调 GitHub API、不校验渲染后的 markdown、不检查外链。
 * 它就是一个「读文件做断言」的静态检查，与 check-docs.mjs / check-renderer-assets.mjs 同一类。
 *
 * ## 什么时候要改这里
 *
 * 把指引**搬到别的文件**（而不是改措辞）时，要同步改下面的 SURFACES 与
 * RELEASE_NOTES_STEP。这是有意的：搬走指引的那个 PR 应该被拦一下，
 * 让搬运者正面确认「新位置同样显眼」——而不是让防线悄悄失效。
 *
 * 用法：
 *   node scripts/check-release-notes.mjs
 *
 * 退出码：0 全部具备，1 有缺失。
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 组装发布说明的那一步。指引与 PR 清单的相对位置在这里判定。 */
const RELEASE_NOTES_FILE = '.github/workflows/release.yml';
const RELEASE_NOTES_STEP = '组装发布说明';

/**
 * 三处对外界面的共同要求（中文）。
 *
 * 这些正则的写法有一条原则：**同类说法都给过**。
 *
 *   · 会被重写的部分（描述「这是正常现象」「怎么打开」的句子）——
 *     接受同义写法：「正常 / 预期」「右键 / Control / 辅助点按」
 *   · 不会被重写的部分（界面上的原文）—— 直接要求原词：
 *     `SmartScreen`、「仍要运行」、「隐私与安全性」都是**系统弹出的原话**，
 *     文案作者没有理由改写它们，改了反而与用户看到的界面对不上
 *
 * 换句话说：**换措辞不该变红，删掉一条能力才该**。
 * 若哪天真要换一种说法而这里报红，请把新的说法补进正则 —— 那正是本脚本存在的意义。
 *
 * 另外，正则都是对 `normalize()` 之后的结果跑的：`**加粗**` 与 `` `代码` `` 的标记
 * 先行剥掉，所以 `没有**代码签名**` 这类写法照样能被 `(没有|未|无).{0,4}签名` 命中。
 */
const ZH_REQUIREMENTS = [
	{ label: '说清安装包没有代码签名', re: /(没有|未|无).{0,4}签名/ },
	{ label: '说清被拦下是正常现象', re: /正常|预期|不是.{0,10}(坏|损坏|出错)|不必担心/ },
	{ label: 'macOS：怎么打开（右键 / Control 点按）', re: /(右键|Control|辅助点按)[^\n]{0,24}打开/i },
	{ label: 'macOS：系统设置里放行', re: /隐私与安全性/ },
	{ label: 'Windows：SmartScreen', re: /SmartScreen/ },
	{ label: 'Windows：仍要运行', re: /仍要运行/ },
];

/** README.en.md 是英文版，要求同样四件事，只是措辞是英文。 */
const EN_REQUIREMENTS = [
	{ label: 'says the installers are unsigned', re: /unsigned/i },
	{ label: 'says the block is expected', re: /expected|normal/i },
	{ label: 'macOS: how to open (right-click / Control-click)', re: /(right[- ]click|control[- ]click)[^\n]{0,40}open/i },
	{ label: 'macOS: allow in System Settings', re: /privacy & security/i },
	{ label: 'Windows: SmartScreen', re: /SmartScreen/ },
	{ label: 'Windows: Run anyway', re: /run anyway/i },
];

const SURFACES = [
	{ file: 'README.md', label: 'README（中文）', requirements: ZH_REQUIREMENTS },
	{ file: 'README.en.md', label: 'README（英文版）', requirements: EN_REQUIREMENTS },
	{ file: 'docs/USAGE.md', label: '使用指南', requirements: ZH_REQUIREMENTS },
];

const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (USE_COLOR ? `\u001b[${code}m${text}\u001b[0m` : text);
const green = (t) => paint('32', t);
const red = (t) => paint('31', t);
const dim = (t) => paint('2', t);

/**
 * 剥掉 markdown 的**强调**与`行内代码`标记。
 *
 * 必须先剥再匹配：`没有**代码签名**` 里的星号会把「没有代码签名」这个连续串切断，
 * 不剥的话正则全部落空 —— 而那是本项目最常见的写法。
 */
function normalize(text) {
	return text.replace(/[*`]/g, '');
}

/** 找出没被满足的能力项。 */
function missing(text, requirements) {
	const flat = normalize(text);
	return requirements.filter((item) => !item.re.test(flat));
}

function read(rel) {
	return readFileSync(path.join(ROOT, rel), 'utf8');
}

/**
 * 取出某个 step 的 `run:` 脚本正文。找不到返回 null。
 *
 * 判据是缩进：从 `- name: <step>` 那一行往下，遇到缩进不深于它的下一个 `- ` 就结束。
 * 不解析 YAML —— 这个文件里有大段 `${{ }}` 与 heredoc，走 YAML 解析器反而更容易出错。
 */
function extractStepScript(yml, stepName) {
	const lines = yml.split('\n');
	const start = lines.findIndex((line) => new RegExp(`-\\s*name:\\s*${stepName}\\s*$`).test(line));
	if (start === -1) return null;
	const indent = lines[start].match(/^\s*/)[0].length;
	const body = [];
	for (let i = start + 1; i < lines.length; i += 1) {
		const line = lines[i];
		if (/^\s*- /.test(line) && line.match(/^\s*/)[0].length <= indent) break;
		body.push(line);
	}
	return body.join('\n');
}

/**
 * 取出脚本里所有「写进 release-notes.md 的 heredoc 段落」，按出现顺序返回。
 *
 * 返回 `{ at, body }`：`at` 是该段落在脚本里的行号，用来判位置。
 */
function extractAppendedBlocks(script) {
	const lines = script.split('\n');
	const opener = /cat\s+>>\s*release-notes\.md\s*<<\s*'?"?([A-Za-z_][A-Za-z0-9_]*)'?"?/;
	const blocks = [];
	for (let i = 0; i < lines.length; i += 1) {
		const match = lines[i].match(opener);
		if (!match) continue;
		const delimiter = match[1];
		const body = [];
		let j = i + 1;
		for (; j < lines.length && lines[j].trim() !== delimiter; j += 1) body.push(lines[j]);
		blocks.push({ at: i, body: normalize(body.join('\n')) });
		i = j;
	}
	return blocks;
}

/** 校验发布说明的组装：指引存在、内容齐全、位置在 PR 清单之前。 */
function checkReleaseNotes(problems) {
	const abs = path.join(ROOT, RELEASE_NOTES_FILE);
	if (!existsSync(abs)) {
		problems.push(`${RELEASE_NOTES_FILE}：文件不存在`);
		return { checked: false, summary: '' };
	}

	const script = extractStepScript(read(RELEASE_NOTES_FILE), RELEASE_NOTES_STEP);
	if (script === null) {
		problems.push(
			`${RELEASE_NOTES_FILE}：找不到「${RELEASE_NOTES_STEP}」这一步 —— ` +
				'发布说明的组装方式变了，请同步更新本脚本',
		);
		return { checked: false, summary: '' };
	}

	// PR 清单写进发布说明的那一行。指引必须排在它前面。
	const prListAt = script
		.split('\n')
		.findIndex((line) => /cat\s+pr-list\.md\s*>>\s*release-notes\.md/.test(line));
	if (prListAt === -1) {
		problems.push(
			`${RELEASE_NOTES_FILE}：「${RELEASE_NOTES_STEP}」里没有把 pr-list.md 写进发布说明的语句 —— ` +
				'无法判定指引的相对位置，请同步更新本脚本',
		);
	}

	const blocks = extractAppendedBlocks(script);
	if (blocks.length === 0) {
		problems.push(
			`${RELEASE_NOTES_FILE}：「${RELEASE_NOTES_STEP}」里没有写进 release-notes.md 的指引段落 —— ` +
				'首次运行指引被删掉了',
		);
		return { checked: false, summary: '' };
	}

	// 取「满足得最多的那一段」来判：指引可能被拆成多段，但只要有一段把四件事说全即可。
	let best = null;
	let bestMissing = ZH_REQUIREMENTS;
	for (const block of blocks) {
		const left = missing(block.body, ZH_REQUIREMENTS);
		if (best === null || left.length < bestMissing.length) {
			best = block;
			bestMissing = left;
		}
	}

	for (const item of bestMissing) {
		problems.push(`${RELEASE_NOTES_FILE}：发布说明里的首次运行指引缺了这一条 —— ${item.label}`);
	}

	if (prListAt !== -1 && best && best.at > prListAt) {
		problems.push(
			`${RELEASE_NOTES_FILE}：发布说明里的首次运行指引排在了**变更清单之后**（第 ${best.at + 1} 行 vs 第 ${prListAt + 1} 行）——\n` +
				'      用户在下载页上看不到它。指引必须在 PR 清单之前，理由见 release.yml 里该 step 上方的注释',
		);
	}

	return {
		checked: true,
		summary: `发布说明：指引在第 ${best.at + 1} 行，变更清单在第 ${prListAt + 1} 行`,
	};
}

/** 校验三处文档。 */
function checkSurfaces(problems) {
	const summary = [];
	for (const surface of SURFACES) {
		const abs = path.join(ROOT, surface.file);
		if (!existsSync(abs)) {
			problems.push(`${surface.file}：文件不存在`);
			continue;
		}
		const left = missing(read(surface.file), surface.requirements);
		for (const item of left) {
			problems.push(`${surface.file}：${surface.label}里缺了这一条 —— ${item.label}`);
		}
		summary.push(`${surface.label} ${surface.requirements.length - left.length}/${surface.requirements.length}`);
	}
	return summary.join('、');
}

function main() {
	const problems = [];

	const notes = checkReleaseNotes(problems);
	const surfaces = checkSurfaces(problems);

	process.stdout.write('\n首次运行指引校验\n');
	process.stdout.write(`  ${dim('三处落点：README / README.en / docs/USAGE.md / 发布说明')}\n`);
	process.stdout.write(`  ${dim(surfaces)}\n`);
	if (notes.summary) process.stdout.write(`  ${dim(notes.summary)}\n`);

	if (problems.length === 0) {
		process.stdout.write(
			`  ${green('✓')} 三处都写明了「安装包未签名、这是正常的」，以及 macOS 与 Windows 各自怎么打开；\n` +
				`    发布说明里的指引排在变更清单之前。\n`,
		);
		return 0;
	}

	process.stdout.write(`\n${red('首次运行指引缺失：')}\n`);
	for (const problem of problems) process.stdout.write(`  ✗ ${problem}\n`);
	process.stdout.write(
		dim(
			'\n  用户是从 Release 页下载的，装完打不开时回到的也是那个页面。\n' +
				'  这里缺的每一条，都会让下一个人再问一次「有一个装完打不开，是正常的吗？」\n',
		),
	);
	if (!notes.checked) {
		process.stdout.write(dim('  （发布说明的组装方式若改动过，请同步更新本脚本的断言）\n'));
	}
	return 1;
}

process.exit(main());
