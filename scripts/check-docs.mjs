#!/usr/bin/env node
/**
 * check-docs.mjs —— 文档有效性校验
 *
 * 检查三件事：
 *
 *   ① **相对链接都能落到真实文件**。文档里写 `docs/USAGE.md`，那个文件就得在。
 *      链接腐烂是文档类仓库最常见的失效形式，而它恰好是机器能查的。
 *
 *   ② **文档里提到的环境变量真实存在**。README 与 docs 里写了 `ZEROWORK_XXX`，
 *      代码里就必须真的有地方读它。这条防的是「文档描述了一个不存在的开关」——
 *      使用者照着配，配了没反应，比报错更难排查。
 *
 *   ③ **指向本项目自身的链接用 canonical 仓库地址**（从 `package.json` 的
 *      `repository.url` 读）。写错一个字母的 owner，链接就静默变成 404 ——
 *      而下面的「不做的事」说明了为什么外链检查救不了它。**这条规则是踩出来的**：
 *      曾经有 19 处链接写成了 `github.com/liangyuxiang/zerowork`，那个仓库并不存在。
 *
 * 用法：
 *   node scripts/check-docs.mjs
 *
 * 退出码：0 全部有效，1 存在失效项。
 *
 * **不做**的事：不校验**外部**链接（指向别人的 http/https 地址）是否可访问 ——
 * 那要联网，会让一个静态检查变成网络依赖，进而变成一个不稳定的门禁。
 * 代价是外链腐烂只能靠人发现；第 ③ 条是对其中最高频那类（指向本项目自己）
 * 的免联网补偿。也不校验 `#锚点` 是否存在 —— 中文标题的锚点规则
 * （大小写、标点、URL 编码）在各渲染器下并不一致。
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 被纳入检查的文档。CHANGELOG 与第三方清单不查链接（它们大量引用外部地址）。
 *
 * `.trellis/spec/` 下的是**分层编码规范** —— 它们是手写的、会随代码演进，
 * 里面大量相对链接指向同层的其它文档，正是最容易腐烂的一类。纳入检查。
 * 反过来，`.trellis/workflow.md` 与 `.claude/skills/trellis-*` 是 Trellis
 * 生成的托管内容（`trellis update` 会整份替换），**不查** —— 查了只会
 * 在别人跑一次 update 后误报。
 */
const DOC_FILES = [
	'README.md',
	'README.en.md',
	'AGENTS.md',
	'CLAUDE.md',
	'CONTRIBUTING.md',
	'SECURITY.md',
	'SUPPORT.md',
	'CODE_OF_CONDUCT.md',
	'docs/ARCHITECTURE.md',
	'docs/USAGE.md',
	'docs/TROUBLESHOOTING.md',
	'docs/MAINTAINER_GUIDE.md',
	'docs/DESIGN.md',
	'.trellis/spec/main/index.md',
	'.trellis/spec/daemon/index.md',
	'.trellis/spec/renderer/index.md',
	'.trellis/spec/shared/index.md',
	'.trellis/spec/resources/index.md',
];

/** 环境变量的扫描范围：文档里提到它，这里就得有地方读它。 */
const ENV_SCAN_DIRS = ['src', 'tools', 'tests', 'resources', 'scripts'];
const ENV_TOKEN = /\bZEROWORK_[A-Z0-9_]+\b/g;

/**
 * 「指向本项目自身的链接」的扫描范围。比 DOC_FILES 宽 ——
 * Issue 模板、PR 模板、工作流里的欢迎语都会写死仓库地址。
 * 只扫文本文件，不扫二进制。
 */
const SELF_LINK_FILES = [
	...DOC_FILES,
	'.github/ISSUE_TEMPLATE/bug_report.yml',
	'.github/ISSUE_TEMPLATE/config.yml',
	'.github/ISSUE_TEMPLATE/documentation.yml',
	'.github/ISSUE_TEMPLATE/feature_request.yml',
	'.github/PULL_REQUEST_TEMPLATE.md',
	'.github/workflows/welcome.yml',
];

/** 从 package.json 的 repository.url 读出 canonical 仓库 slug（owner/repo）。 */
function readCanonicalSlug() {
	try {
		const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
		const url = pkg?.repository?.url ?? '';
		const match = url.match(/github\.com[/:]([^/]+\/[^/.]+)/);
		return match ? match[1] : null;
	} catch {
		return null;
	}
}

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

	// ---- 指向本项目自身的链接必须用 canonical 仓库地址 ----
	//
	// 这条规则是**踩出来的**：`check-docs` 不校验外链（那要联网），于是 19 处
	// `github.com/liangyuxiang/zerowork` 一路通过 —— 那个仓库**根本不存在**，
	// 全是 404。owner 写错一个字母，链接就静默失效，而没有任何东西会告诉你。
	//
	// 判据不需要联网：canonical 仓库地址从 `package.json` 的 `repository.url` 读，
	// 然后把文档里出现的 `github.com/<owner>/<repo>` 逐个比对 ——
	// **仓库名相同但 owner 不同**就是写错了。
	const canonicalSlug = readCanonicalSlug();
	const wrongOwner = [];

	if (canonicalSlug) {
		const [canonicalOwner, canonicalRepo] = canonicalSlug.split('/');
		// 扫描范围比 DOC_FILES 宽：Issue 模板与工作流里的欢迎语同样会写死仓库地址
		for (const rel of SELF_LINK_FILES) {
			const abs = path.join(ROOT, rel);
			if (!existsSync(abs)) continue;
			const text = readFileSync(abs, 'utf8');
			text.split('\n').forEach((line, index) => {
				for (const match of line.matchAll(/github\.com\/([^/\s)"'<]+)\/([^/\s)"'#?<]+)/g)) {
					const [, owner, repo] = match;
					if (repo === canonicalRepo && owner !== canonicalOwner) {
						wrongOwner.push(`${rel}:${index + 1} 指向 ${owner}/${repo}，本项目是 ${canonicalSlug}`);
					}
				}
			});
		}
	}

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

	if (wrongOwner.length > 0) {
		process.stdout.write(`\n${red('指向本项目的链接用错了 owner（那些仓库不存在）：')}\n`);
		for (const problem of wrongOwner) process.stdout.write(`  ✗ ${problem}\n`);
		process.stdout.write(
			dim(
				'  canonical 地址取自 package.json 的 repository.url；外链是否可达要联网，这条规则不需要。\n',
			),
		);
	}

	const totalProblems = problems.length + unknownEnv.length + wrongOwner.length;

	if (totalProblems === 0) {
		process.stdout.write(
			`  ${green('✓')} 相对链接全部有效，环境变量全部有出处，自引用链接都指向 ${canonicalSlug ?? '本项目'}\n`,
		);
		return 0;
	}

	process.stdout.write(`\n${red(`共 ${totalProblems} 处问题`)}\n`);
	return 1;
}

process.exit(main());
