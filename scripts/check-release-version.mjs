#!/usr/bin/env node
/**
 * check-release-version.mjs —— 发布版本号一致性检查
 *
 * 发布流程里有四个地方各写了一份版本号，它们**必须对得上**：
 *
 *   ① git tag            `v0.2.0`        —— 触发 release 工作流
 *   ② CHANGELOG.md       `## [0.2.0]`    —— 发布说明的正文来源
 *   ③ package.json       `"version"`     —— 应用自身的版本
 *   ④ package-lock.json  `"version"`     —— 锁文件的根版本（两处：顶层与 packages[""]）
 *
 * ④ 是 2026-11-13 补上的：v0.21.0 发布时只改了三处，锁文件仍写着 0.20.0，
 * 而 `npm ci` / `npm install` 会以 package.json 为准改写它 —— 下一次安装就产生
 * 一个与发布无关的 diff（真实发生过，由 Dependabot 的 PR 顺带暴露）。
 * 它不影响发布说明，所以**没有任何一处会报错**，只能靠这个检查。
 *
 * 对不上时的表现是**静默的**：`release.yml` 从 CHANGELOG 提取版本段时
 * 一段都提不到，发布说明只剩 PR 清单，维护者要等看到 Release 才发现。
 * 而「tag 已经推上去了」这一步不好撤（删远端 tag 会留下痕迹）。
 *
 * 所以把这一步前置到打 tag **之前**跑：不合规就直接不发布。
 *
 * 用法：
 *   node scripts/check-release-version.mjs v0.2.0
 *   TAG=v0.2.0 node scripts/check-release-version.mjs      # CI 里更方便
 *
 * 退出码：0 四者一致，1 不一致（或 tag 形态不合法）。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * `CHECK_RELEASE_ROOT` 只给单测用：让脚本在一份临时夹具目录里跑，
 * 而不是永远读仓库根（测试见 tests/unit/check-release-version.test.mjs）。
 * 正常使用时不要设置它 —— 发布检查必须读真实的仓库。
 */
const ROOT = process.env.CHECK_RELEASE_ROOT
	? path.resolve(process.env.CHECK_RELEASE_ROOT)
	: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (USE_COLOR ? `\u001b[${code}m${text}\u001b[0m` : text);
const green = (t) => paint('32', t);
const red = (t) => paint('31', t);
const dim = (t) => paint('2', t);

const tag = (process.argv[2] ?? process.env.TAG ?? process.env.GITHUB_REF_NAME ?? '').trim();

if (!tag) {
	process.stderr.write('用法：node scripts/check-release-version.mjs <tag>（或设 TAG 环境变量）\n');
	process.exit(1);
}

process.stdout.write('\n发布版本一致性\n');
process.stdout.write(`  tag: ${tag}\n`);

// ---- ① tag 形态 ----
if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
	process.stdout.write(
		`\n${red(`tag「${tag}」不是合法形态。`)}\n` +
			dim('  期望：v<主>.<次>.<修订>，可带预发布后缀，例如 v0.2.0 或 v0.2.0-rc.1\n'),
	);
	process.exit(1);
}

const version = tag.replace(/^v/, '');
const isPrerelease = version.includes('-');

// ---- ② CHANGELOG ----
const changelog = readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
const heading = `## [${version}]`;
if (!changelog.includes(heading)) {
	const available = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1]);
	process.stdout.write(
		`\n${red(`CHANGELOG.md 里没有「${heading}」这一段。`)}\n` +
			dim(`  现有的版本段：${available.slice(0, 6).join('、')}${available.length > 6 ? ' …' : ''}\n`) +
			dim('  发布说明的正文来自这一段，缺了它 Release 里只有 PR 清单。\n'),
	);
	process.exit(1);
}

// ---- ③ package.json ----
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const pkgVersion = pkg.version;
// 允许两种对应关系：完全相等（正式版），或 tag 是 package.json 版本的预发布
// （package.json 写 0.2.0，tag 打 v0.2.0-rc.1 —— 预发布同样属于 0.2.0 这条线）
const consistent = pkgVersion === version || version.startsWith(`${pkgVersion}-`);

process.stdout.write(`  CHANGELOG: ${heading} ${green('✓')}\n`);
process.stdout.write(`  package.json: ${pkgVersion} ${consistent ? green('✓') : red('✗')}\n`);

if (!consistent) {
	process.stdout.write(
		`\n${red('package.json 的 version 与 tag 对不上。')}\n` +
			dim(`  期望 package.json 写 ${isPrerelease ? version.split('-')[0] : version}\n`),
	);
	process.exit(1);
}

// ---- ④ package-lock.json ----
/*
 * 锁文件的根版本必须跟随 package.json（不是 tag）：预发布 tag 不改 package.json，
 * 锁文件也不该改。两处都查 —— 顶层 `version` 与 `packages[""]` 各写了一份，
 * 只改一处会留下「看起来同步了」的假象。
 */
let lock;
try {
	lock = JSON.parse(readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
} catch (error) {
	process.stdout.write(
		`\n${red('package-lock.json 读不到或不是合法 JSON。')}\n` + dim(`  ${error.message}\n`),
	);
	process.exit(1);
}
const lockVersion = typeof lock.version === 'string' ? lock.version : '';
const lockRootVersion = typeof lock.packages?.['']?.version === 'string' ? lock.packages[''].version : '';
const lockConsistent = lockVersion === pkgVersion && lockRootVersion === pkgVersion;

process.stdout.write(
	`  package-lock.json: ${lockVersion === '' ? '（缺 version）' : lockVersion} ${lockConsistent ? green('✓') : red('✗')}\n`,
);

if (!lockConsistent) {
	process.stdout.write(
		`\n${red('package-lock.json 的根版本与 package.json 对不上。')}\n` +
			dim(`  期望 ${pkgVersion}（顶层与 packages[""] 都要改）\n`) +
			dim('  改法：npm install --package-lock-only（或手动同步这两处）\n'),
	);
	process.exit(1);
}

process.stdout.write(
	`  ${green('✓')} 四者一致${isPrerelease ? dim('（预发布版本，不会标记为 latest）') : ''}\n`,
);
process.exit(0);
