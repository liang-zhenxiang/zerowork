#!/usr/bin/env node
/**
 * check-line-endings.mjs —— 行尾一致性检查
 *
 * 这个仓库的约定是 **LF**（`.gitattributes` 的 `* text=auto eol=lf`）。
 * 目前是守住的（全仓 0 个 CRLF 文件），但守住它靠的是「大家都用对编辑器」——
 * 一次 Windows 上的误操作就能让某个文件变成 CRLF，
 * 而 `src/renderer/src/*.js` 与 `src/main/daemon/index.js` 被标了 `-text`
 * （不做行尾归一化，因为它们体量大），**这些文件一旦混入 CRLF，git 不会帮你纠正**。
 *
 * 所以把约定钉成一条检查：零安装、秒级、跑在 ubuntu 上。
 *
 * 注意 `.gitattributes` 的 `-text` 只覆盖 `src/renderer/src/*.js`（单层，非递归）
 * 与 `src/main/daemon/index.js` 这一个文件 —— 不是整个目录。
 *
 * 用 git grep 而不是自己遍历文件：它只搜**被跟踪**的文件，
 * 自动跳过二进制（`-I`），也就不会去报 `resources/bin/*.exe` 里的字节。
 *
 * 用法：node scripts/check-line-endings.mjs
 * 退出码：0 没有 CRLF，1 存在 CRLF 文件（或不在 git 仓库里）。
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (USE_COLOR ? `\u001b[${code}m${text}\u001b[0m` : text);
const green = (t) => paint('32', t);
const red = (t) => paint('31', t);
const dim = (t) => paint('2', t);

function main() {
	process.stdout.write('\n行尾检查\n');

	let out = '';
	try {
		// -I 跳过二进制；-l 只列文件名；-e $'\r' 匹配回车符
		out = execFileSync('git', ['grep', '-I', '-l', '-e', '\r'], {
			cwd: ROOT,
			encoding: 'utf8',
			stdio: ['ignore', 'pipe', 'pipe'],
		});
	} catch (error) {
		if (error.status === 1) {
			// git grep 的 1 = 没有匹配。这正是我们要的结果。
			process.stdout.write(`  ${green('✓')} 被跟踪的文本文件里没有 CRLF，全部是 LF\n`);
			return 0;
		}
		// 128 = 不在 git 仓库里
		process.stdout.write(
			`${dim('  跳过：当前目录不是 git 仓库（这条检查依赖 git grep）\n')}`,
		);
		return 0;
	}

	const files = out.split('\n').filter(Boolean);
	if (files.length === 0) {
		process.stdout.write(`  ${green('✓')} 被跟踪的文本文件里没有 CRLF，全部是 LF\n`);
		return 0;
	}

	process.stdout.write(`\n${red('以下文件的换行符是 CRLF，应为 LF：')}\n`);
	for (const file of files.slice(0, 20)) process.stdout.write(`  ✗ ${file}\n`);
	if (files.length > 20) process.stdout.write(dim(`  …另有 ${files.length - 20} 个\n`));
	process.stdout.write(
		dim('  修复：`git add --renormalize .` 后重新提交；同时检查编辑器的行尾设置。\n'),
	);
	return 1;
}

process.exit(main());
