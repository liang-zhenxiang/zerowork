#!/usr/bin/env node
/**
 * check-docs.mjs —— 文档有效性校验
 *
 * 检查两件事：
 *
 *   ① **相对链接都能落到真实文件**。文档里写 `docs/USAGE.md`，那个文件就得在。
 *      链接腐烂是文档类仓库最常见的失效形式，而它恰好是机器能查的。
 *
 *   ② **文档里提到的环境变量真实存在**。README 与 docs 里写了 `ZEROWORK_XXX`，
 *      代码里就必须真的有地方读它。这条防的是「文档描述了一个不存在的开关」——
 *      使用者照着配，配了没反应，比报错更难排查。
 *
 * 用法：
 *   node scripts/check-docs.mjs
 *
 * 退出码：0 全部有效，1 存在失效项。
 *
 * **不做**的事：不校验外链（http/https）是否可访问 —— 那要联网，
 * 会让一个静态检查变成网络依赖；也不校验 `#锚点` 是否存在，
 * 中文标题的锚点规则（大小写、标点、URL 编码）在各渲染器下并不一致。
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 被纳入检查的文档。CHANGELOG 与第三方清单不查链接（它们大量引用外部地址）。 */
const DOC_FILES = [
	'README.md',
	'README.en.md',
	'CONTRIBUTING.md',
	'SECURITY.md',
	'SUPPORT.md',
	'CODE_OF_CONDUCT.md',
	'docs/ARCHITECTURE.md',
	'docs/USAGE.md',
	'docs/TROUBLESHOOTING.md',
	'docs/MAINTAINER_GUIDE.md',
	'docs/DESIGN.md',
];

/** 环境变量的扫描范围：文档里提到它，这里就得有地方读它。 */
const ENV_SCAN_DIRS = ['src', 'tools', 'tests', 'resources', 'scripts'];
const ENV_TOKEN = /\bZEROWORK_[A-Z0-9_]+\b/g;

const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (USE_COLOR ? `\u001b[${code}m${text}\u001b[0m` : text);
const green = (t) => paint('32', t);
const red = (t) => paint('31', t);
const dim = (t) => paint('2', t);

/**
 * 去掉围栏代码块，**保留行内代码**。
 *
 * 两种用途对行内代码的需求相反，所以分成两个函数：
 *   · 找链接时要连行内代码一起去掉 —— 代码里的 `[foo](bar)` 是示例，不是真链接
 *   · 找环境变量时**必须保留** —— 文档里的变量名恰恰写在反引号里（`ZEROWORK_CONFIG_DIR`），
 *     先剥掉就一个都找不到了
 */
function stripFences(text) {
	const out = [];
	let inFence = false;
	for (const line of text.split('\n')) {
		if (/^\s*(```|~~~)/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		out.push(line);
	}
	return out.join('\n');
}

/** 围栏代码块 + 行内代码都去掉，专供链接检查使用。 */
function stripCode(text) {
	return stripFences(text).replace(/`[^`]*`/g, '');
}

/** 抽取 markdown 链接与图片的相对目标。 */
function extractLinks(text) {
	const links = [];
	// [文字](目标 "可选标题") 与 ![alt](目标)
	const re = /!?\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
	let m;
	while ((m = re.exec(text)) !== null) links.push(m[1]);
	return links;
}

function isExternal(target) {
	return (
		/^[a-z][a-z0-9+.-]*:/i.test(target) || // http: mailto: data: 等
		target.startsWith('//') ||
		target.startsWith('#')
	);
}

/** 收集一个目录下所有文本文件的源码，用于环境变量存在性检查。 */
function collectSourceText() {
	let text = '';
	for (const dir of ENV_SCAN_DIRS) {
		const abs = path.join(ROOT, dir);
		if (!existsSync(abs)) continue;
		const stack = [abs];
		while (stack.length > 0) {
			const current = stack.pop();
			for (const entry of readdirSync(current, { withFileTypes: true })) {
				if (entry.name === 'node_modules' || entry.name === '.git') continue;
				const full = path.join(current, entry.name);
				if (entry.isDirectory()) {
					stack.push(full);
				} else if (/\.(js|mjs|cjs|json|md|py|sh|txt|yml|yaml)$/.test(entry.name)) {
					try {
						text += readFileSync(full, 'utf8');
					} catch {
						/* 二进制或不可读，跳过 */
					}
				}
			}
		}
	}
	return text;
}

function main() {
	const problems = [];
	let checkedLinks = 0;
	let checkedFiles = 0;

	for (const rel of DOC_FILES) {
		const abs = path.join(ROOT, rel);
		if (!existsSync(abs)) continue; // 文件本身还没写，不算链接失效
		checkedFiles += 1;
		const raw = readFileSync(abs, 'utf8');
		const body = stripCode(raw);
		const dir = path.dirname(abs);

		body.split('\n').forEach((line, index) => {
			for (const target of extractLinks(line)) {
				if (isExternal(target)) continue;
				checkedLinks += 1;

				const withoutAnchor = target.split('#')[0];
				if (withoutAnchor === '') continue; // 纯锚点

				const resolved = path.resolve(dir, decodeURIComponent(withoutAnchor));
				if (!resolved.startsWith(ROOT)) {
					problems.push(`${rel}:${index + 1} 链接指到仓库之外：${target}`);
					continue;
				}
				if (!existsSync(resolved)) {
					problems.push(`${rel}:${index + 1} 链接指向不存在的路径：${target}`);
					continue;
				}
				// 目录链接必须带结尾斜杠或指向其中的文件，这里只提示目录存在即可
				statSync(resolved);
			}
		});
	}

	// ---- 环境变量 ----
	const sourceText = collectSourceText();
	const declared = new Set();
	for (const rel of DOC_FILES) {
		const abs = path.join(ROOT, rel);
		if (!existsSync(abs)) continue;
		// 这里用 stripFences 而不是 stripCode：变量名写在行内代码里，剥掉就找不到了
		const found = stripFences(readFileSync(abs, 'utf8')).match(ENV_TOKEN);
		if (found) for (const token of found) declared.add(token);
	}

	const unknownEnv = [...declared].filter((token) => !sourceText.includes(token)).sort();

	// ---- 报告 ----
	process.stdout.write('\n文档校验\n');
	process.stdout.write(
		`  检查了 ${checkedFiles} 个文档文件、${checkedLinks} 个相对链接、${declared.size} 个环境变量名\n`,
	);

	if (unknownEnv.length > 0) {
		process.stdout.write(
			`\n${red('以下环境变量在文档里出现过，但代码里没有任何地方读它：')}\n`,
		);
		for (const token of unknownEnv) process.stdout.write(`  ✗ ${token}\n`);
		process.stdout.write(
			dim('  （文档描述一个不存在的开关，使用者配了不会有反应 —— 比报错更难排查）\n'),
		);
	}

	if (problems.length > 0) {
		process.stdout.write(`\n${red('失效链接：')}\n`);
		for (const problem of problems) process.stdout.write(`  ✗ ${problem}\n`);
	}

	if (problems.length === 0 && unknownEnv.length === 0) {
		process.stdout.write(`  ${green('✓')} 相对链接全部有效，环境变量全部有出处\n`);
		return 0;
	}

	process.stdout.write(`\n${red(`共 ${problems.length + unknownEnv.length} 处问题`)}\n`);
	return 1;
}

process.exit(main());
