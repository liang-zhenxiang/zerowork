#!/usr/bin/env node
/**
 * check-unicode.mjs —— U+FFFD 替换字符检查
 *
 * 这个仓库的中文内容被改坏过多次，而**替换字符是不可逆的**：写坏的字节
 * （`ef bf bd`）是合法的 U+FFFD，原文从 git 历史里直接消失，只能靠周围
 * 上下文反推。更糟的是它不只影响源码 —— CSS 注释会被压缩器原样保留进构建
 * 产物，所以乱码会随包发出去（2026-10-10 实测：`app.css` 一句注释乱码，
 * 跟着 beta 包发了两个版本）。
 *
 * 原先这件事靠 `AGENTS.md` 里一段人工 `python3 -c`，CI 不跑 —— 于是它滑过去了。
 * 这条把它钉成门禁：零安装、秒级、跑在 ubuntu 上。
 *
 * 与 `check-line-endings.mjs` 同形：用 `git ls-files` 取「仓库里该被检查的东西」，
 * 而不是 `rglob` 全盘扫再拿一张 SKIP 名单过滤（漏一项就会扫进 out/ 与本地缓存，
 * 那里的乱码是假警报）。
 *
 * 顺带能抓**非法 UTF-8 字节**：读文件用 Buffer.toString('utf8')，坏字节会被解成
 * U+FFFD。二进制先跳过，所以不会误报。
 *
 * 用法：
 *   node scripts/check-unicode.mjs           # 默认不扫 resources/**（见下）
 *   node scripts/check-unicode.mjs --all     # 连 resources/** 一起扫
 * 退出码：0 没有替换字符，1 命中（或不在 git 仓库里时按需给 0，见下）
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (USE_COLOR ? `\u001b[${code}m${text}\u001b[0m` : text);
const green = (t) => paint('32', t);
const red = (t) => paint('31', t);
const dim = (t) => paint('2', t);

/** 替换字符本身。写成转义，免得这个文件自己成为命中项。 */
export const REPLACEMENT = '\uFFFD';

/**
 * 合法字面量：vendored 解码器（`code-preview.js`）与 XML 字符集（`workspace.js`）
 * 里就有正当的 U+FFFD —— 它们是「把坏字节转成可显示字符」那件事的产物本身。
 * `AGENTS.md` 写明不要动。`app.js` 同理（同一批 vendored 代码的产物）。
 */
export const ALLOWED_FILES = new Set([
	'src/renderer/src/code-preview.js',
	'src/renderer/src/workspace.js',
	'src/renderer/src/app.js',
]);

/**
 * 随包第三方内容不参与本项目的 lint / 格式化 / 测试（AGENTS.md 红线 5），
 * 这条检查默认也不把它算进来 —— 否则某份 vendored 内容里出现正当的 U+FFFD 时，
 * 门禁会变红而我们**无从修**（那是第三方的字节）。需要时用 `--all` 扫。
 */
export const EXCLUDED_PREFIXES = ['resources/'];

/** 该文件是否豁免（不检查）。 */
export function isExempt(file, { includeResources = false } = {}) {
	if (ALLOWED_FILES.has(file)) return true;
	if (!includeResources && EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix))) {
		return true;
	}
	return false;
}

/**
 * 找出含替换字符的行。
 *
 * 返回 `[{ line, text }]`，`line` 从 1 起（与编辑器一致）。一行里连续多个
 * U+FFFD 只报**一次** —— 报告是给人去修整行的，重复计数没有意义。
 */
export function findReplacements(text) {
	const hits = [];
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i += 1) {
		if (lines[i].includes(REPLACEMENT)) hits.push({ line: i + 1, text: lines[i] });
	}
	return hits;
}

/**
 * git 认二进制的方式：前 8000 字节里有 NUL。与 `git grep -I` 同口径，
 * 免得去报 `resources/bin/*.exe` 这类文件里恰好凑出的字节。
 */
export function looksBinary(buffer) {
	return buffer.subarray(0, 8000).includes(0);
}

/** 被 git 跟踪的文件清单（NUL 分隔，路径里带空格也安全）。 */
function trackedFiles() {
	const out = execFileSync('git', ['ls-files', '-z'], {
		cwd: ROOT,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	return out.split('\0').filter(Boolean);
}

/** 行内容太长时截断，只在报告里给人一个定位用的锚。 */
function snippet(text) {
	const trimmed = text.trim();
	return trimmed.length > 120 ? `${trimmed.slice(0, 120)}…` : trimmed;
}

function main() {
	const includeResources = process.argv.includes('--all');
	process.stdout.write('\nU+FFFD 替换字符检查\n');

	let files;
	try {
		files = trackedFiles();
	} catch (error) {
		if (error.status === 128) {
			process.stdout.write(
				`${dim('  跳过：当前目录不是 git 仓库（这条检查依赖 git ls-files）\n')}`,
			);
			return 0;
		}
		throw error;
	}

	const hits = [];
	let scanned = 0;
	let exempted = 0;
	let binary = 0;

	for (const file of files) {
		if (isExempt(file, { includeResources })) {
			exempted += 1;
			continue;
		}
		let buffer;
		try {
			buffer = readFileSync(path.join(ROOT, file));
		} catch {
			// 文件被删除但索引还没更新（例如 rebase 中途）—— 跳过，不制造假警报
			continue;
		}
		if (looksBinary(buffer)) {
			binary += 1;
			continue;
		}
		scanned += 1;
		// 非法 UTF-8 字节在这里会被解成 U+FFFD —— 与字面 U+FFFD 一起抓
		for (const hit of findReplacements(buffer.toString('utf8'))) {
			hits.push({ file, ...hit });
		}
	}

	const scope = includeResources ? '全部被跟踪文件' : '全部被跟踪文件（不含 resources/**）';
	if (hits.length === 0) {
		process.stdout.write(`  ${green('✓')} ${scope}里没有替换字符（扫了 ${scanned} 个）\n`);
		process.stdout.write(
			dim(
				`    跳过 ${exempted} 个（3 个合法字面量文件${includeResources ? '' : ' + resources/**'}）、` +
					`${binary} 个二进制\n`,
			),
		);
		if (!includeResources) {
			process.stdout.write(dim('    要连 resources/** 一起扫：npm run check:unicode -- --all\n'));
		}
		return 0;
	}

	process.stdout.write(`\n${red(`发现 ${hits.length} 处替换字符（U+FFFD）：`)}\n`);
	for (const hit of hits) {
		process.stdout.write(`  ✗ ${hit.file}:${hit.line}\n`);
		process.stdout.write(dim(`      ${snippet(hit.text)}\n`));
	}
	process.stdout.write(
		dim(
			'\n  修：按行号**整行重写**。不要 replace(单个替换字符) —— 一行里可能有连续多个，\n' +
				'      replace 会把它整段换成完整文本，产出「用用于最佳努力的清理」这种重复串。\n' +
				'  注：替换字符不可逆（写坏的字节是合法的 U+FFFD），原文只能靠上下文反推。\n',
		),
	);
	return 1;
}

// 直接执行时跑 main；被 import 时不跑（单测路径）。与 next-beta-version.mjs 同形。
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exit(main());
}
