#!/usr/bin/env node
/**
 * check-commit-msg.mjs —— 约定式提交信息校验
 *
 * 用于 CI 与本地自查。项目的所有提交必须遵循 Conventional Commits：
 *
 *   <类型>(<范围>): <描述>
 *
 * 用法：
 *   node scripts/check-commit-msg.mjs --message "feat(daemon): 支持批量同步"
 *   node scripts/check-commit-msg.mjs --file .git/COMMIT_EDITMSG   # 配合 commit-msg hook
 *   node scripts/check-commit-msg.mjs --range origin/main..HEAD
 *   node scripts/check-commit-msg.mjs --last                       # 只查最近一次提交
 *
 * 退出码：
 *   0  区间内没有不合规的提交（**区间里一条提交都没有也算 0**：没有可校验的内容）
 *   1  存在不合规的提交信息，或区间无法解析
 *
 * 为什么用 Node 而不是 bash：这个项目的使用者在 Windows / macOS / Linux 上都会跑它，
 * 而 bash 3.2（macOS 自带）与 Windows 的 shell 在这一类文本处理上差异太多。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * 允许的类型。**必须与 CONTRIBUTING.md 的「提交信息规范」表格保持一致** ——
 * 两处不一致时，贡献者会照着文档写然后被 CI 拦下。
 */
const ALLOWED_TYPES = [
	'feat',
	'fix',
	'docs',
	'ci',
	'chore',
	'refactor',
	'perf',
	'test',
	'style',
	'revert',
	'build',
];

/**
 * <类型>[(<范围>)][!]: <描述>
 * 范围限定为小写字母、数字、点、下划线、斜杠、连字符。
 * 末尾的 `!` 表示破坏性变更。
 */
const SUBJECT_PATTERN = new RegExp(
	`^(${ALLOWED_TYPES.join('|')})(\\([a-z0-9._/-]+\\))?!?: .+`,
);

const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (USE_COLOR ? `\u001b[${code}m${text}\u001b[0m` : text);
const dim = (t) => paint('2', t);
const green = (t) => paint('32', t);
const red = (t) => paint('31', t);
const yellow = (t) => paint('33', t);
const bold = (t) => paint('1', t);

function usage(stream = process.stdout) {
	stream.write(`check-commit-msg.mjs —— 校验提交信息是否符合约定式提交规范

用法：
  --message <文本>     校验一段提交信息
  --file <路径>        校验文件内容（配合 git 的 commit-msg hook）
  --range <区间>       校验一个提交区间，例如 origin/main..HEAD
  --last               校验最近一次提交
  -h, --help           显示帮助

合规示例：
  feat(daemon): 支持一次同步多个镜像
  fix(renderer): 补上 --all 避免丢失 arm64 平台
  docs: 补充模型供应商的配置说明
`);
}

/**
 * 这些提交信息无需遵循规范，直接放行：
 *   - Merge / Revert：git 自动生成的固定格式
 *   - fixup! / squash!：交互式 rebase 的中间产物
 *   - 以 # 开头：git 的注释行
 *   - 空行
 */
function shouldSkip(subject) {
	if (!subject) return true;
	return (
		subject.startsWith('Merge ') ||
		subject.startsWith('Revert ') ||
		subject.startsWith('fixup!') ||
		subject.startsWith('squash!') ||
		subject.startsWith('#')
	);
}

/** 累积计数。区间模式会逐条累加。 */
const counters = { checked: 0, failed: 0 };

/**
 * 校验单条提交信息。返回 true 表示通过。
 * 失败时给出**针对性的原因**，而不是甩一句「格式错误」。
 */
function checkOne(subject) {
	if (shouldSkip(subject)) {
		process.stdout.write(`  ${dim('跳过（无需校验）')} ${subject}\n`);
		return true;
	}

	counters.checked += 1;

	if (SUBJECT_PATTERN.test(subject)) {
		process.stdout.write(`  ${green('✓')} ${subject}\n`);
		return true;
	}

	counters.failed += 1;
	process.stdout.write(`  ${red('✗')} ${subject}\n`);

	// 判断顺序很重要：先定位「类型部分」的问题，再定位「冒号与描述」的问题。
	// 否则「Feat: xxx」会被误报成「类型缺失」，把人引到错误的方向。
	const lowered = subject.toLowerCase();
	const typePrefix = lowered.match(new RegExp(`^(${ALLOWED_TYPES.join('|')})(?=[(!:])`));
	const anyWord = subject.match(/^([A-Za-z][A-Za-z-]*)/);

	if (!new RegExp(`^(${ALLOWED_TYPES.join('|')})(?=[(!:])`).test(subject)) {
		if (typePrefix) {
			process.stdout.write(
				`      ${yellow(`→ 类型必须小写，应写作「${typePrefix[1]}」。`)}\n`,
			);
		} else if (anyWord) {
			process.stdout.write(`      ${yellow(`→ 类型「${anyWord[1]}」不在允许列表内。`)}\n`);
			process.stdout.write(`        允许的类型：${ALLOWED_TYPES.join(' ')}\n`);
		} else {
			process.stdout.write(`      ${yellow('→ 缺少类型前缀。')}\n`);
			process.stdout.write(`        允许的类型：${ALLOWED_TYPES.join(' ')}\n`);
		}
	} else if (!subject.includes(': ')) {
		process.stdout.write(
			`      ${yellow('→ 冒号后面需要有一个空格，应写作「…: 描述」。')}\n`,
		);
	} else {
		process.stdout.write(`      ${yellow('→ 格式应为：<类型>(<范围>): <描述>')}\n`);
	}

	return false;
}

/** 只取第一行（标题行），并去掉行尾空白。 */
function subjectOf(text) {
	return (text.split('\n')[0] ?? '').replace(/\s+$/, '');
}

function runGit(args) {
	try {
		const stdout = execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
		return { ok: true, stdout };
	} catch (error) {
		return {
			ok: false,
			stdout: error.stdout?.toString() ?? '',
			stderr: (error.stderr?.toString() ?? '').trim(),
		};
	}
}

function main(argv) {
	let mode = null;
	let value = null;

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		switch (arg) {
			case '--message':
				mode = 'message';
				value = argv[++i];
				break;
			case '--file':
				mode = 'file';
				value = argv[++i];
				break;
			case '--range':
				mode = 'range';
				value = argv[++i];
				break;
			case '--last':
				mode = 'last';
				value = 'HEAD';
				break;
			case '-h':
			case '--help':
				usage();
				return 0;
			default:
				process.stderr.write(`未知参数：${arg}\n`);
				usage(process.stderr);
				return 1;
		}
	}

	if (mode === null || value === null) {
		usage(process.stderr);
		return 1;
	}

	process.stdout.write(`\n${bold('校验提交信息')}\n`);

	if (mode === 'message') {
		checkOne(value);
	} else if (mode === 'file') {
		let content;
		try {
			content = readFileSync(value, 'utf8');
		} catch {
			process.stderr.write(`文件不存在：${value}\n`);
			return 1;
		}
		checkOne(subjectOf(content));
	} else {
		const inRepo = runGit(['rev-parse', '--git-dir']);
		if (!inRepo.ok) {
			process.stderr.write('当前目录不是 git 仓库\n');
			return 1;
		}

		// --last 不用 HEAD~1..HEAD 这种区间：仓库只有一条提交时 HEAD~1 不存在，
		// 区间形态会把「第一次提交」误报成「区间无法解析」。直接取最近一条即可。
		const isLast = mode === 'last';
		const label = isLast ? '最近一次提交' : `区间「${value}」`;

		const log = isLast ? runGit(['log', '-1', '--format=%s']) : runGit(['log', '--format=%s', value]);

		if (isLast && !log.ok && log.stdout.trim() === '') {
			process.stdout.write(`${yellow('仓库还没有提交，没有可校验的内容。')}\n`);
			return 0;
		}

		// 「区间无效」与「区间里没有提交」必须分开。两者都表现为「读到 0 条」，
		// 但前者是使用者敲错了 ref（应该报错），后者是合法情形（例如只有 merge 的 PR）。
		// git log 的退出码是区分二者的唯一依据：ref 不存在 → 非 0；区间有效但为空 → 0。
		if (!log.ok) {
			// 如实转述 git 的话，比自造文案可信
			const firstLine = log.stderr.split('\n')[0];
			process.stderr.write(`${red(`无法解析提交区间「${value}」`)}\n`);
			if (firstLine) process.stderr.write(`  git: ${firstLine}\n`);
			process.stderr.write(
				'  请确认区间两端的 ref 是否存在（未 fetch、拼写有误，或处于 detached HEAD 都可能）。\n',
			);
			return 1;
		}

		const subjects = log.stdout.split('\n').filter((line) => line.length > 0);

		if (subjects.length === 0) {
			// 措辞不能是「全部合规」—— 那是「验过了」的意思，而这里什么都没验。
			// 退出码仍是 0：CI 里 BASE..HEAD 为空是合法情形，判失败会制造假红。
			// 「有没有提交可验」与「提交信息合不合规」是两回事。
			process.stdout.write(`${yellow(`${label}内没有提交，没有可校验的内容。`)}\n`);
			return 0;
		}

		for (const subject of subjects) checkOne(subject);
	}

	process.stdout.write('\n');
	if (counters.failed > 0) {
		process.stdout.write(
			`${red(`${counters.failed} 条不合规`)}（共检查 ${counters.checked} 条）\n\n`,
		);
		process.stdout.write(`示例：
  feat(daemon): 支持一次同步多个镜像
  fix(renderer): 补上 --all 避免丢失 arm64 平台
  docs: 补充模型供应商的配置说明

详见 CONTRIBUTING.md 的「提交信息规范」一节。
`);
		return 1;
	}

	process.stdout.write(`${green('全部合规')}（共检查 ${counters.checked} 条）\n`);
	return 0;
}

process.exit(main(process.argv.slice(2)));
