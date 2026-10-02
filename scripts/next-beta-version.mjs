#!/usr/bin/env node
/**
 * next-beta-version.mjs —— 计算下一个 beta 版本号（beta workflow 用）
 *
 * 规则：
 *   下一 beta 的主线版本 = package.json 的 version 的 minor + 1（patch 归零）。
 *   例：当前稳定 0.3.0 → beta 主线 0.4.0 → beta 号 = 已有 v0.4.0-beta.* release 数 + 1。
 *   这样 beta 永远领先稳定版一个 minor，稳定发布（0.4.0）时天然覆盖这条 beta 线，
 *   不需要「beta 转正」的额外动作。
 *
 * 两种用法：
 *   node scripts/next-beta-version.mjs --check-unreleased   # 只判断 [Unreleased] 是否有货，退出码 0=有 / 3=没有（workflow 用）
 *   node scripts/next-beta-version.mjs --with-releases <json>  # 传入 gh release list --json 的产物，输出下一版本号
 *   node scripts/next-beta-version.mjs                       # 本地无 release 信息时只打印目标主线（调试用）
 *
 * 版本计算抽成纯函数 computeNextBeta(version, releaseTags) 导出，
 * 单测（tests/unit/update-version.test.mjs）只测纯函数，不碰网络与 gh。
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {string} currentVersion 稳定版本（package.json 的 version，形如 0.3.0）
 * @param {string[]} releaseTags 已存在的 release tag 列表（形如 ["v0.3.0", "v0.4.0-beta.1", ...]）
 * @returns {string} 下一个 beta 版本（不带 v 前缀，形如 0.4.0-beta.2）
 */
export function computeNextBeta(currentVersion, releaseTags) {
	const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(currentVersion).trim());
	if (match === null) {
		throw new Error(`package.json 的 version 不是语义化版本：${String(currentVersion)}`);
	}
	const minor = Number(match[2]);
	const line = `${match[1]}.${minor + 1}.0`;
	const prefix = `v${line}-beta.`;
	const count = releaseTags.filter((tag) => String(tag).startsWith(prefix)).length;
	return `${line}-beta.${count + 1}`;
}

/** [Unreleased] 段是否有实际内容（除注释与空白外）。 */
export function unreleasedHasContent(changelogText) {
	const start = changelogText.indexOf('## [Unreleased]');
	if (start === -1) return false;
	const end = changelogText.indexOf('\n## ', start + 1);
	const section = end === -1 ? changelogText.slice(start) : changelogText.slice(start, end);
	// 逐行看：跳过 HTML 注释（含**跨行**注释的中间行——用状态开关而不是
	// 只看行首前缀，单行与多行注释都不算内容）、标题行与空白。
	let inComment = false;
	const meaningful = section
		.split('\n')
		.filter((line) => {
			const trimmed = line.trim();
			if (inComment) {
				if (trimmed.includes('-->')) inComment = false;
				return false;
			}
			if (trimmed.startsWith('<!--')) {
				if (!trimmed.includes('-->')) inComment = true;
				return false;
			}
			return trimmed !== '' && !trimmed.startsWith('## [Unreleased]');
		});
	return meaningful.length > 0;
}

function main() {
	const args = process.argv.slice(2);
	const changelog = readFileSync(resolve(ROOT, 'CHANGELOG.md'), 'utf8');
	if (args.includes('--check-unreleased')) {
		if (unreleasedHasContent(changelog)) {
			console.log('unreleased: 有内容');
			process.exit(0);
		}
		console.log('unreleased: 空（没有可发 beta 的变更）');
		process.exit(3);
	}
	const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
	const withIdx = args.indexOf('--with-releases');
	if (withIdx !== -1) {
		const raw = args[withIdx + 1] ?? '[]';
		// 字段名核对过 `gh release list --json`：是 **tagName**（首版写成 r.tag，
		// 三元一路 fallback 到整个对象 → startsWith 全不匹配 → 序号永远 1，
		// beta.2 发成了 beta.1 并撞上「已存在」路径。真机端到端才暴露）。
		const tags = JSON.parse(raw).map((r) => r.tagName ?? r.tag ?? r.name ?? r);
		console.log(computeNextBeta(pkg.version, tags));
		return;
	}
	console.log(computeNextBeta(pkg.version, []));
}

// 直接执行时跑 main；被 import 时不跑（单测路径）。
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main();
}
