#!/usr/bin/env node
/**
 * check-conflict-markers.mjs —— 未解决的合并冲突标记检查
 *
 * 2026-11-11 实测事故：第二十轮（#364）的提交把 CHANGELOG.md 的
 * `<<<<<<< HEAD` / `=======` / `>>>>>>> origin/main` 原样提交进了 main，
 * 同时把 8 条新功能写进了**已发布**的 0.20.0 段。CI 全绿——因为当时
 * 没有任何一项检查会读这些标记。
 *
 * 这类错误比乱码更容易发生：冲突标记是合法的 ASCII，编辑器不会提示，
 * Markdown 渲染器会把它当普通段落，而发布说明会照抄。所以把它做成门禁：
 * 扫被 git 跟踪的文本文件，发现成对的冲突标记就红。
 *
 * 与 check-unicode 同口径：用 `git ls-files` 取检查范围；跳过二进制；
 * `resources/**` 是随包第三方内容，不套本项目工具链。
 *
 * 判定规则（避免误伤 Markdown 里单独一行的 `=======`）：
 *   - `<<<<<<< ` 开始一个冲突块；
 *   - 块内出现 `=======` 记为分隔；
 *   - `>>>>>>> ` 结束它。
 * 只有块内的分隔线才算命中；块外的 `=======` 不报。
 *
 * 用法：node scripts/check-conflict-markers.mjs
 * 退出码：0 干净，1 命中（不在 git 仓库时跳过并返回 0）。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXCLUDED_PREFIXES = ['resources/'];

const START = /^<<<<<<<(\s|$)/u;
const SEP = /^=======$/u;
const END = /^>>>>>>>(\s|$)/u;

/**
 * 找出文件里的冲突标记行。
 * 返回 `[{ line, text }]`，`line` 从 1 起。
 */
export function findConflictMarkers(text) {
	const hits = [];
	let inBlock = false;
	const lines = String(text).split('\n');
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i];
		if (START.test(line)) {
			inBlock = true;
			hits.push({ line: i + 1, text: line });
			continue;
		}
		if (inBlock && SEP.test(line)) {
			hits.push({ line: i + 1, text: line });
			continue;
		}
		if (END.test(line)) {
			hits.push({ line: i + 1, text: line });
			inBlock = false;
		}
	}
	return hits;
}

function looksBinary(buffer) {
	return buffer.subarray(0, 8000).includes(0);
}

function trackedFiles() {
	const out = execFileSync('git', ['ls-files', '-z'], {
		cwd: ROOT,
		encoding: 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	return out.split('\0').filter(Boolean);
}

function main() {
	process.stdout.write('\n合并冲突标记检查\n');
	let files;
	try {
		files = trackedFiles();
	} catch (error) {
		if (error.status === 128) {
			process.stdout.write('  跳过：当前目录不是 git 仓库（这条检查依赖 git ls-files）\n');
			return 0;
		}
		throw error;
	}

	let scanned = 0;
	const hits = [];
	for (const file of files) {
		if (EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix))) continue;
		let buffer;
		try {
			buffer = readFileSync(path.join(ROOT, file));
		} catch {
			continue;
		}
		if (looksBinary(buffer)) continue;
		scanned += 1;
		const found = findConflictMarkers(buffer.toString('utf8'));
		for (const hit of found) hits.push({ file, ...hit });
	}

	if (hits.length === 0) {
		process.stdout.write(`  通过（扫了 ${scanned} 个文本文件）\n`);
		return 0;
	}
	for (const hit of hits) {
		process.stdout.write(`  ${hit.file}:${hit.line}: ${hit.text.trim()}\n`);
	}
	process.stdout.write(`\n发现 ${hits.length} 行未解决的合并冲突标记 —— 请解决后重新提交\n`);
	return 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = main();
}
