#!/usr/bin/env node
/**
 * lint.mjs —— 本地统一校验入口
 *
 * 一条命令跑完 CI 里**本地能跑**的那些静态检查。提交 PR 之前跑一次，
 * 可以把「推上去 → CI 红 → 改了再推」这个来回省掉。
 *
 * 用法：
 *   npm run lint:all
 *   node scripts/lint.mjs
 *
 * ## 覆盖范围（别把它当成 CI 的替代品）
 *
 * | 覆盖 | 不覆盖 |
 * | --- | --- |
 * | eslint、prettier、tsc | **提交信息规范** —— CI 校的是 PR 标题，而标题在 PR 建立之前根本不存在。本地全绿不等于 commit-messages 会绿 |
 * | 文档链接、随包内容、行尾、渲染层产物契约 | **端到端 GUI 测试** —— 需要真实图形环境，CI 在 macOS 上跑 |
 * | 发布说明里的首次运行指引（见 `scripts/check-release-notes.mjs`） | |
 * | 随包体积与依赖契约（需先 `dist:dir`，否则跳过） | |
 * | actionlint、yamllint、zizmor（工作流） | **安装包构建** —— 见 .github/workflows/build-installers.yml |
 *
 * 三条如实说明：
 *   · 缺失的工具会被**跳过并提示安装方式**，不会被算作通过（结尾单独列出）
 *   · zizmor 用 docker 跑，镜像版本从 ci.yml 抽出（与 CI 同源）；本机没有 docker 时跳过
 *   · actionlint 的版本同样从 ci.yml 抽；本机版本与 CI 不一致时只有 zizmor 那条会提示
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CI_YML = path.join(ROOT, '.github/workflows/ci.yml');

const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (USE_COLOR ? `\u001b[${code}m${text}\u001b[0m` : text);
const red = (t) => paint('31', t);
const green = (t) => paint('32', t);
const yellow = (t) => paint('33', t);
const blue = (t) => paint('34', t);
const bold = (t) => paint('1', t);

/** npm 在 Windows 上是 npm.cmd。 */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const state = { passed: 0, failed: 0, skipped: 0 };
const failedNames = [];
/** 跑了、但**结论与 CI 不同源**的项。它们的「通过」可信度不同，单独记下来。 */
const nonsyncNotes = [];

/** 从 ci.yml 里抽出工具版本，保证本地与 CI 用同一套编号。 */
function ciVersions() {
	let text = '';
	try {
		text = readFileSync(CI_YML, 'utf8');
	} catch {
		return {};
	}
	return {
		actionlint: text.match(/ACTIONLINT_VERSION:\s*["']([^"']+)["']/)?.[1],
		zizmor: text.match(/ghcr\.io\/zizmorcore\/zizmor:([0-9][\w.-]*)/)?.[1],
		yamllint: text.match(/YAMLLINT_VERSION:\s*["']([^"']+)["']/)?.[1],
	};
}

function commandExists(command) {
	const probe = spawnSync(command, ['--version'], { stdio: 'ignore', shell: false });
	return probe.error === undefined;
}

/** 执行一项检查。返回 true 表示通过。 */
function runCheck(name, command, args, options = {}) {
	process.stdout.write(`\n${bold(`▶ ${name}`)}\n`);
	process.stdout.write(`  ${blue(`$ ${[command, ...args].join(' ')}`)}\n`);

	const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options });

	if (result.error) {
		process.stdout.write(`  ${red('✗ 无法执行')}：${result.error.message}\n`);
		state.failed += 1;
		failedNames.push(name);
		return false;
	}
	if (result.status === 0) {
		process.stdout.write(`  ${green('✓ 通过')}\n`);
		state.passed += 1;
		return true;
	}

	process.stdout.write(`  ${red(`✗ 失败（退出码 ${result.status}）`)}\n`);
	state.failed += 1;
	failedNames.push(name);
	return false;
}

/** 跳过一项检查并说明原因，而不是让整个脚本崩掉。 */
function skipCheck(name, reason, hint = '') {
	process.stdout.write(`\n${bold(`▶ ${name}`)}\n`);
	process.stdout.write(`  ${yellow(`⚠ 已跳过：${reason}`)}\n`);
	if (hint) process.stdout.write(`  ${yellow(`  安装方式：${hint}`)}\n`);
	state.skipped += 1;
}

function main() {
	const versions = ciVersions();
	const startedAt = Date.now();

	process.stdout.write(`${bold('ZeroWork 本地检查')}\n`);
	process.stdout.write('跑完 CI 里本地能跑的那些静态检查（详见本文件头部注释的覆盖范围）\n');

	// ---- 项目自身的检查 ----
	runCheck('ESLint', NPM, ['run', '--silent', 'lint']);
	runCheck('Prettier（工具链与工作流）', NPM, ['run', '--silent', 'format:check']);
	runCheck('TypeScript 类型检查', NPM, ['run', '--silent', 'typecheck']);
	runCheck('应用标识一致性', process.execPath, ['scripts/check-app-id.mjs']);
	runCheck('文档有效性', process.execPath, ['scripts/check-docs.mjs']);
	runCheck('发布说明的首次运行指引', process.execPath, ['scripts/check-release-notes.mjs']);
	runCheck('随包内容完整性', process.execPath, ['scripts/check-resources.mjs']);
	runCheck('行尾一致性', process.execPath, ['scripts/check-line-endings.mjs']);

	// 渲染层产物契约：需要先构建。没构建就明确跳过，不假装通过。
	if (existsSync(path.join(ROOT, 'out/renderer/assets'))) {
		runCheck('渲染层产物契约', process.execPath, ['scripts/check-renderer-assets.mjs']);
	} else {
		skipCheck(
			'渲染层产物契约',
			'out/renderer/assets 不存在（尚未构建）',
			'npm run build && npm run check:renderer-assets',
		);
	}

	// 随包体积契约：需要先**打包**（不只是构建）。没打包就明确跳过，不假装通过。
	if (existsSync(path.join(ROOT, 'release'))) {
		runCheck('随包体积与依赖契约', process.execPath, ['scripts/check-package-size.mjs']);
	} else {
		skipCheck(
			'随包体积与依赖契约',
			'release/ 不存在（尚未打包）',
			'npm run dist:dir && npm run check:package-size',
		);
	}

	// ---- 工作流检查 ----
	if (commandExists('actionlint')) {
		const probe = spawnSync('actionlint', ['--version'], { encoding: 'utf8' });
		const localVersion = (probe.stdout ?? '').match(/(\d+\.\d+\.\d+)/)?.[1];
		if (versions.actionlint && localVersion && localVersion !== versions.actionlint) {
			nonsyncNotes.push(
				`actionlint：本地 ${localVersion}，CI ${versions.actionlint} —— 版本不同，结论未必一致`,
			);
		}
		// 与 CI 完全一致：不带任何 -ignore（那条针对 `$/` 的忽略已撤掉，理由见 ci.yml）
		runCheck('actionlint（工作流静态检查）', 'actionlint', ['-color']);
	} else {
		skipCheck(
			'actionlint（工作流静态检查）',
			'本机未安装 actionlint',
			'mise use actionlint@' + (versions.actionlint ?? '1.7.12') + ' 或 brew install actionlint',
		);
	}

	if (commandExists('yamllint')) {
		runCheck('yamllint（YAML 风格检查）', 'yamllint', ['.github/workflows/']);
	} else {
		skipCheck(
			'yamllint（YAML 风格检查）',
			'本机未安装 yamllint',
			'pipx install yamllint' + (versions.yamllint ? `==${versions.yamllint}` : ''),
		);
	}

	if (commandExists('docker') && versions.zizmor) {
		// 挂载只读：扫描器没有理由改动被扫描的文件
		runCheck(
			`zizmor（工作流安全扫描，镜像 ${versions.zizmor}）`,
			'docker',
			[
				'run',
				'--rm',
				'-v',
				`${ROOT}:/repo:ro`,
				`ghcr.io/zizmorcore/zizmor:${versions.zizmor}`,
				'/repo',
				'--no-online-audits',
			],
		);
	} else {
		skipCheck(
			'zizmor（工作流安全扫描）',
			commandExists('docker') ? '未从 ci.yml 解析到镜像版本' : '本机没有 docker',
			'docker run --rm -v "$PWD":/repo:ro ghcr.io/zizmorcore/zizmor:<版本> /repo --no-online-audits',
		);
	}

	// ---- 汇总 ----
	const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
	process.stdout.write(`\n${bold('汇总')}（耗时 ${seconds}s）\n`);
	process.stdout.write(
		`  ${green(`${state.passed} 通过`)}  ${state.failed > 0 ? red(`${state.failed} 失败`) : `${state.failed} 失败`}  ${yellow(`${state.skipped} 跳过`)}\n`,
	);

	if (state.skipped > 0) {
		process.stdout.write(
			`  ${yellow('跳过不等于通过')} —— 上面列出的跳过项没有被验证过。\n`,
		);
	}

	if (nonsyncNotes.length > 0) {
		process.stdout.write(`\n${yellow('与 CI 不同源，结论未必一致：')}\n`);
		for (const note of nonsyncNotes) process.stdout.write(`  · ${note}\n`);
	}

	if (state.failed > 0) {
		process.stdout.write(`\n${red('失败的检查：')}\n`);
		for (const name of failedNames) process.stdout.write(`  ✗ ${name}\n`);
		process.stdout.write(
			`\n${yellow('本地检查不覆盖：')}提交信息规范（CI 校的是 PR 标题，本地无从验证）、\n` +
				'端到端 GUI 测试、安装包构建。这几项仍需在 PR 上由 CI 把关。\n',
		);
		return 1;
	}

	process.stdout.write(
		`\n${green('全部通过')}（${state.skipped} 项被跳过，未被验证）\n`,
	);
	return 0;
}

process.exit(main());
