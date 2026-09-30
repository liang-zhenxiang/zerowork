#!/usr/bin/env node
/**
 * check-app-id.mjs —— 应用唯一标识的一致性检查
 *
 * 这个项目里有**一处标识、两个消费者**：
 *
 *   · `electron-builder.yml` 的 `appId` —— 安装器的身份。由它派生：
 *     macOS 的 `CFBundleIdentifier`（以及 6 个 helper 的 bundle id）、
 *     Windows 的 Application User Model ID、NSIS 升级用的 GUID
 *   · `src/main/index.js` 的 `APP_ID` —— 运行时那一半，
 *     传给 `app.setAppUserModelId()` 与安装器对齐
 *
 * 两者不一致时**只会在 Windows 上出问题**（任务栏固定项与通知分组对不上），
 * 而开发机多半是 macOS —— 这正是需要一条自动检查的场景。
 *
 * 顺带验第二件事：标识本身应当是 `io.github.<owner>.<repo>` 形式，
 * 且 owner/repo 与 `package.json` 的仓库地址一致 —— 仓库迁移或改名时，
 * 标识不会悄悄指着一个不存在的地方。
 *
 * 用法：node scripts/check-app-id.mjs
 * 退出码：0 一致且形式正确，1 有问题。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (USE_COLOR ? `\u001b[${code}m${text}\u001b[0m` : text);
const green = (t) => paint('32', t);
const red = (t) => paint('31', t);
const dim = (t) => paint('2', t);

/** 从 electron-builder.yml 取 appId。 */
function readBuilderAppId() {
	const yml = readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
	// 只匹配顶格的 `appId:`，避免命中 mac:/win: 下的覆盖项 ——
	// 那两处的默认值是从顶层继承的，本文件不设它们
	const match = yml.match(/^appId:\s*(\S+)\s*$/m);
	return match ? match[1] : null;
}

/** 从主进程入口取 APP_ID 常量。 */
function readRuntimeAppId() {
	const src = readFileSync(path.join(ROOT, 'src/main/index.js'), 'utf8');
	const match = src.match(/^const APP_ID = "([^"]+)";/m);
	return match ? match[1] : null;
}

/** 从 package.json 的 repository.url 取 owner/repo。 */
function readRepoSlug() {
	try {
		const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
		const match = (pkg?.repository?.url ?? '').match(/github\.com[/:]([^/]+\/[^/.]+)/);
		return match ? match[1] : null;
	} catch {
		return null;
	}
}

function main() {
	const problems = [];
	const builderAppId = readBuilderAppId();
	const runtimeAppId = readRuntimeAppId();
	const slug = readRepoSlug();

	process.stdout.write('\n应用标识一致性\n');

	if (!builderAppId) problems.push('electron-builder.yml 里找不到顶格的 `appId:`');
	if (!runtimeAppId) problems.push('src/main/index.js 里找不到 `const APP_ID = "...";`');

	// ---- ① 两处必须一致 ----
	if (builderAppId && runtimeAppId) {
		if (builderAppId === runtimeAppId) {
			process.stdout.write(`  ${green('✓')} 安装器与运行时一致：${builderAppId}\n`);
		} else {
			problems.push(
				`安装器与运行时不一致 ——\n` +
					`      electron-builder.yml  appId   = ${builderAppId}\n` +
					`      src/main/index.js     APP_ID  = ${runtimeAppId}\n` +
					'      Windows 上会导致快捷方式与通知的 AUMID 对不上。',
			);
		}
	}

	// ---- ② 形式：io.github.<owner>.<repo>，且与仓库地址一致 ----
	if (builderAppId && slug) {
		const [owner, repo] = slug.split('/');
		const expected = `io.github.${owner}.${repo}`;
		if (builderAppId === expected) {
			process.stdout.write(`  ${green('✓')} 形式与仓库地址一致：io.github.${owner}.${repo}\n`);
		} else {
			problems.push(
				`标识与仓库地址对不上 —— 期望 \`${expected}\`，实际 \`${builderAppId}\``,
			);
		}
	}

	if (problems.length === 0) {
		process.stdout.write(
			`  ${dim('（安装器身份由 appId 一处派生：CFBundleIdentifier / 6 个 helper / AUMID / NSIS GUID）')}\n`,
		);
		return 0;
	}

	process.stdout.write(`\n${red('存在不一致：')}\n`);
	for (const problem of problems) process.stdout.write(`  ✗ ${problem}\n`);
	return 1;
}

process.exit(main());
