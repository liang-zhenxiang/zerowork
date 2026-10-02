#!/usr/bin/env node
/**
 * check-vendored-deps.mjs —— 「随包的 vendored 依赖」清单与 bundle 的一致性校验
 *
 * `SECURITY.md` 的「随包的 vendored 依赖：审计盲区」一节里有一张 `vendor-*.js` 的清单。
 * 那一节记的是一个**结构性问题**：这些 bundle 随安装包分发，却不在任何审计工具的
 * 视野里（不是 npm 依赖、原包已移出生产依赖、Dependabot 里被 ignore、且升级
 * `package.json` 根本不改变随包的字节 —— 四条理由见 SECURITY.md）。
 *
 * 既然没有工具盯它们，「这份清单本身会不会腐烂」就成了唯一的防线。这个脚本守三件事：
 *
 *   ① **源码树里的每个 `vendor-*.js` 都要在清单里有一行**。新引入一份 vendored
 *      bundle 而没登记，直接失败 —— 这是「没人盯着」最容易复发的形态。
 *   ② **清单里的每一行都要对应真实的文件**。反向也查，否则清单会变成一份
 *      「写得很全但早已过时」的文档。
 *   ③ **清单里写的版本必须与 bundle 内的版本标记逐字一致**。版本写错比不写更坏：
 *      它会让「这个版本有没有公告」的判断整个失去意义。
 *
 * 用法：
 *   node scripts/check-vendored-deps.mjs
 *
 * 退出码：0 一致，1 存在漂移或未登记的 bundle。
 *
 * **不做**的事：
 *   · **不联网查漏洞数据库**。那会让一个静态门禁变成网络依赖，进而变成一个不稳定的
 *     门禁 —— 理由与 `scripts/check-docs.mjs` 的「不做的事」完全相同。
 *     所以「版本 ↔ 公告状态」的比对仍是**定期的人工事项**，跟踪在 Issue #61。
 *     这个脚本只保证**那份人工比对的输入（清单）是准的**。
 *   · **不判断「这个版本该不该升级」**。那是 Issue #61 的设计决策。
 *
 * **维护须知**：`VERSION_MARKER` 里的正则是**按当前 bundle 的压缩形态**写的
 * （打包器会把 `n.version = "…"` 这类赋值里的局部变量名压短）。重新打包过
 * `vendor-*.js` 之后如果这条检查报「找不到版本标记」，**不要放宽它** ——
 * 那是它按设计在提醒你「bundle 换了形态，得重新确认清单还是不是真的」。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// vendor bundle 可能落在两处：src/renderer/src/（动态 import 型，有独立产物）或
// src/renderer/（静态并入 app chunk 型，无独立产物、也在 chunk 契约扫描之外——
// vendor-katex.js 是第一例）。两处都扫，登记行里的路径写哪处都认。
const SRC_DIRS = [path.join(ROOT, 'src/renderer/src'), path.join(ROOT, 'src/renderer')];
const SECURITY = path.join(ROOT, 'SECURITY.md');

/** 清单所在的章节标题（`SECURITY.md`）。只取这一节里的表格行。 */
const SECTION_HEADING = /^###\s+随包的 vendored 依赖/;

/**
 * 每个 vendored bundle 的**版本来源**。这是本脚本唯一需要人工维护的部分。
 *
 * - `re`：从 bundle 正文里抠出版本号的正则，捕获组 1 即版本
 * - `from`：自身没有版本号、必须沿用另一份 bundle 的版本（再导出薄壳）
 * - `lib`：库名，仅用于报告
 *
 * **源码树里出现新的 `vendor-*.js` 时，这里必须补一条** —— 补不出来（比如新 bundle
 * 里没有任何可机读的版本号）本身就是一个值得记进 SECURITY.md 的结论，
 * 而不是把这条检查绕过。
 */
const VERSION_MARKER = {
	'vendor-xlsx.js': {
		lib: 'SheetJS Community Edition',
		re: /XLSX\.version\s*=\s*"([^"]+)"/,
	},
	'vendor-lodash.js': {
		lib: 'lodash',
		re: /var VERSION\s*=\s*"([^"]+)"/,
	},
	// 版本号读生成头注释（scripts/vendor-katex.mjs 写入的「katex X.Y.Z」）——
	// esbuild 的 min 产物内部无稳定版本常量可锚，头部注释就是这份 bundle 的版本标记。
	'vendor-katex.js': {
		lib: 'KaTeX（含 remark-math / rehype-katex 整链）',
		re: /生成（katex ([0-9.]+)）/,
	},
	'vendor-jszip.js': {
		lib: 'JSZip',
		re: /n\.version\s*=\s*"([^"]+)"/,
	},
	'vendor-jszip-2.js': {
		lib: 'JSZip（再导出薄壳）',
		re: null,
		from: 'vendor-jszip.js',
	},
};

const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (USE_COLOR ? `\u001b[${code}m${text}\u001b[0m` : text);
const green = (t) => paint('32', t);
const red = (t) => paint('31', t);
const dim = (t) => paint('2', t);

/** 源码树里全部 `vendor-*.js` 的文件名。 */
function vendorFilesOnDisk() {
	return SRC_DIRS.flatMap((dir) => readdirSync(dir))
		.filter((name) => /^vendor-.*\.js$/.test(name))
		.sort();
}

/**
 * 从 SECURITY.md 的清单表里抽出登记项。
 *
 * 表行形如 `| \`vendor-xlsx.js\` | SheetJS … | 0.18.5 | 动态 import 懒加载 |`，
 * 取第 1 格（文件名）、第 2 格（库名）、第 3 格（版本）。
 */
function readInventory(text) {
	const lines = text.split('\n');
	const start = lines.findIndex((l) => SECTION_HEADING.test(l));
	if (start < 0) {
		return { error: '在 SECURITY.md 里找不到「### 随包的 vendored 依赖」这一节' };
	}

	const rest = lines.slice(start + 1);
	const end = rest.findIndex((l) => /^#{2,3}\s/.test(l));
	const section = end < 0 ? rest : rest.slice(0, end);

	const entries = [];
	for (const line of section) {
		const trimmed = line.trimStart();
		if (!trimmed.startsWith('|')) continue;

		const cells = trimmed.split('|').slice(1, -1).map((c) => c.trim());
		// 第 1 格写成 `src/renderer/src/vendor-xlsx.js`（带路径），这里取其中的文件名。
		// 表头的分隔行（`| --- | --- |`）没有反引号，天然被下面的匹配排除。
		const backticked = cells[0]?.match(/`([^`]+)`/)?.[1];
		const file = backticked?.match(/(?:^|\/)(vendor-[^/]+\.js)$/)?.[1];
		if (!file) continue;
		entries.push({ file, lib: cells[1] ?? '', versionCell: cells[2] ?? '' });
	}

	if (entries.length === 0) {
		return { error: '「随包的 vendored 依赖」一节里没有解析到任何清单表行' };
	}
	return { entries };
}

/** 从版本单元格里抠出形如 1.2.3 的版本号（单元格可能带「（同 …）」这类附注）。 */
function versionsIn(cell) {
	return [...cell.matchAll(/\d+\.\d+\.\d+/g)].map((m) => m[0]);
}

/** bundle 里的版本标记。返回 { version } 或 { error }。 */
function versionFromBundle(file, registry) {
	const source = readFileSync(
		SRC_DIRS.map((dir) => path.join(dir, file)).find((f) => existsSync(f)) ?? path.join(SRC_DIRS[0], file),
		'utf8',
	);
	if (registry.from) return { from: registry.from, version: versionFromBundle(registry.from, VERSION_MARKER[registry.from]).version };
	const match = source.match(registry.re);
	if (!match) {
		return {
			error:
				`在 ${file} 里找不到版本标记（正则 ${registry.re}）—— ` +
				'bundle 的压缩形态可能变过了，请确认清单是否仍然属实后更新 VERSION_MARKER',
		};
	}
	return { version: match[1] };
}

function main() {
	const problems = [];

	if (!existsSync(SECURITY) || !SRC_DIRS.every((d) => existsSync(d))) {
		process.stdout.write(`\n${red('vendored 依赖校验：找不到 SECURITY.md 或 src/renderer/src')}\n`);
		return 1;
	}

	const onDisk = vendorFilesOnDisk();
	const inventory = readInventory(readFileSync(SECURITY, 'utf8'));
	if (inventory.error) {
		process.stdout.write(`\n${red(`vendored 依赖校验：${inventory.error}`)}\n`);
		return 1;
	}

	const registered = new Map();
	for (const entry of inventory.entries) {
		if (registered.has(entry.file)) {
			problems.push(`SECURITY.md 的清单里 ${entry.file} 出现了两次 —— 每份 bundle 只登记一行`);
		}
		registered.set(entry.file, entry);
	}

	// ① 源码树里的每个 vendor-*.js 都要登记
	for (const file of onDisk) {
		if (!registered.has(file)) {
			problems.push(
				`src/renderer/src/${file} 没有登记在 SECURITY.md 的清单里 —— ` +
					'新引入的 vendored bundle 必须先登记（含库名、版本、加载方式），否则它就是一处在盲区里没人盯的代码',
			);
		}
	}

	// ② 清单里的每一行都要对应真实文件
	const onDiskSet = new Set(onDisk);
	for (const file of registered.keys()) {
		if (!onDiskSet.has(file)) {
			problems.push(`SECURITY.md 的清单登记了 ${file}，但 src/renderer/src/ 里没有这个文件`);
		}
	}

	// ③ 清单里的版本必须与 bundle 里的版本标记一致
	let verified = 0;
	const unchecked = [];
	for (const file of onDisk) {
		const entry = registered.get(file);
		if (!entry) continue;

		const registry = VERSION_MARKER[file];
		if (!registry) {
			problems.push(
				`scripts/check-vendored-deps.mjs 的 VERSION_MARKER 里没有 ${file} —— ` +
					'新增的 vendored bundle 必须声明它的版本从哪里读，这条检查才管得住它',
			);
			continue;
		}

		const found = versionFromBundle(file, registry);
		if (found.error) {
			problems.push(found.error);
			continue;
		}

		const listed = versionsIn(entry.versionCell);
		if (!listed.includes(found.version)) {
			problems.push(
				`SECURITY.md 给 ${file} 记的版本是「${entry.versionCell}」，` +
					`但 bundle 里的版本标记是 ${found.version} —— 清单写错会让「这个版本有没有公告」的判断失去意义`,
			);
			continue;
		}

		verified += 1;
		if (registry.from) unchecked.push(`${file}（沿用 ${registry.from} 的 ${found.version}）`);
	}

	// ---- 报告 ----
	process.stdout.write('\nvendored 依赖校验\n');
	process.stdout.write(
		`  源码树 ${onDisk.length} 份 vendor-*.js；SECURITY.md 清单 ${registered.size} 行\n`,
	);

	if (problems.length === 0) {
		process.stdout.write(
			`  ${green('✓')} 每份 bundle 都登记在册，清单里的版本与 bundle 内的版本标记逐字一致` +
				`（${verified} 份完成核对）\n`,
		);
		process.stdout.write(
			dim(
				'  这只保证清单是准的 —— 「版本 ↔ 公告状态」的比对仍需人工定期做，见 SECURITY.md 与 Issue #61。\n',
			),
		);
		if (unchecked.length > 0) {
			process.stdout.write(dim(`  沿用来源版本的：${unchecked.join('、')}\n`));
		}
		return 0;
	}

	process.stdout.write(`\n${red('漂移：')}\n`);
	for (const problem of problems) process.stdout.write(`  ✗ ${problem}\n`);
	process.stdout.write(
		dim(
			'  清单在 SECURITY.md 的「随包的 vendored 依赖：审计盲区」一节；\n' +
				'  这些 bundle 不在 npm 依赖图里，任何审计工具都看不到它们 —— 清单是唯一的落点。\n',
		),
	);
	return 1;
}

process.exit(main());
