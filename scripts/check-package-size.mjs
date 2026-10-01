#!/usr/bin/env node
/**
 * check-package-size.mjs —— 安装包体积 / 随包依赖契约检查
 *
 * 这条检查守的是 **v0.3.0 的真实事故**：用户下载后反馈「安装要很久、打开要很久、
 * 电脑很卡」。实测 `ZeroWork.app` 948 MB，其中 `Contents/Resources/app/node_modules`
 * 554 MB / 22016 个文件。
 *
 * 根因不是某一个包装错了，而是一条**结构性**的错误：`electron.vite.config.mjs` 用了
 * 无参数的 `externalizeDepsPlugin()`，于是 `package.json` 的 22 个 `dependencies`
 * **全部**被外置 → electron-builder 整个装进包。可其中大半是**渲染层专用**的，
 * 而渲染层已经被 Vite 打包进 `out/renderer`（sandbox 渲染进程根本 require 不到
 * node_modules）—— 这些随包纯属重复。
 *
 * 事故的修法有两半，这条检查就是它们的守卫：
 *
 *   ① 渲染层专用依赖从 `dependencies` 移到 `devDependencies`
 *      （渲染层的源码 chunk 是**预打包的 vendored bundle**，没有任何裸 import，
 *       所以移走不影响构建；见 `electron.vite.config.mjs` 的 renderer 段）
 *   ② OCR 链（tesseract.js / tesseract.js-core）与 `@napi-rs/canvas` 从产物里排除
 *      （理由与代价写在 `electron-builder.yml` 的 files 段，**改之前先读那里**）
 *
 * 为什么值得专门写一条检查，而不是靠端到端测试：**这不是功能问题，e2e 全绿也照样
 * 会胖回去**。它是「加功能时顺手把依赖写进 dependencies」这一个动作就能重新引入的，
 * 而代价要等用户下载 900 MB 才发现。所以判据必须是**打包产物本身**。
 *
 * 用法：
 *   npm run dist:dir && node scripts/check-package-size.mjs
 *
 * 退出码：0 契约成立，1 有违反；**尚未打包时返回 0 并明确说明「已跳过」**
 * （本地没打包就跑 lint 不该失败，但也不会被算作通过 —— 报告里会写明）。
 */

import { readFileSync, existsSync, readdirSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (USE_COLOR ? `\u001b[${code}m${text}\u001b[0m` : text);
const green = (t) => paint('32', t);
const red = (t) => paint('31', t);
const yellow = (t) => paint('33', t);
const dim = (t) => paint('2', t);

const MB = 1024 * 1024;
const fmtMB = (bytes) => `${(bytes / MB).toFixed(0)} MB`;

/**
 * 渲染层专用依赖：**既不许回到 `dependencies`，也不许出现在随包的 node_modules 里**。
 *
 * 名单里有几个是**传递依赖**（`echarts`/`zrender` ← `pptx-preview`，
 * `codepage` ← `xlsx`，`@fortune-sheet/core` ← `@fortune-sheet/react`）：
 * 它们不是直接声明在 package.json 里的，但只要上游还在，就会跟着进来 ——
 * 所以必须**按目录名逐个断言**，不能只查直接依赖。
 */
const RENDERER_ONLY = [
	'monaco-editor',
	'react',
	'react-dom',
	'react-markdown',
	'react-pdf',
	'remark-gfm',
	'xlsx',
	'pptx-preview',
	'docx-preview',
	'@fortune-sheet/react',
	'@corbe30/fortune-excel',
	// 上面这些的传递依赖，随上游一起走
	'echarts',
	'zrender',
	'codepage',
];

/**
 * 有意排除、且**代价已被接受**的包（理由见 `electron-builder.yml` 的 files 段）。
 *
 * 与 `RENDERER_ONLY` 分开列，是因为失败时的含义不同：
 * 那一边是「不该随包的东西进来了」，这一边是「electron-builder.yml 里的排除失效了」——
 * 后者多半意味着**有人改错了排除规则**，而不是有人加错了依赖。
 */
const DELIBERATELY_EXCLUDED = ['tesseract.js', 'tesseract.js-core', '@napi-rs/canvas'];

/**
 * 主进程**真正 import** 的第三方包 —— 硬编码，**刻意不从 package.json 推导**。
 *
 * 推导出来的话，「把 koffi 挪进 devDependencies」这种失误会让名单跟着缩水，
 * 检查自己把自己放过去了。硬编码的名单是**独立判据**：
 * 它代表「主进程运行时链路依赖这些包」这一事实，与 package.json 怎么写无关。
 *
 * 核实方式（改名单前请照做）：grep `src/main`、`src/preload`、`src/shared` 的
 * import / `await import()`。**渲染层那几个文件是预打包产物，grep 它们的 import
 * 不可靠** —— 那正是这次事故的成因，别重蹈。
 */
const MAIN_PROCESS_REQUIRED = [
	'@earendil-works/pi-coding-agent',
	'@modelcontextprotocol/sdk',
	'@mozilla/readability',
	'jsonc-parser',
	'jszip',
	'koffi',
	'linkedom',
	'officeparser',
	'pdfjs-dist',
	'turndown',
	'typebox',
];

/**
 * 上限。**每一个数都是量出来的**（2026-10-01，mac-arm64，`npm run dist:dir`），
 * 括号里是实测值。
 *
 * 为什么主判据是 `payloadBytes`（`Resources/app/`：out/ + node_modules + package.json）
 * 而不是整包的体积：**payload 是我们控制的、且跨平台同字节的那部分**。
 * 整包里还有 Electron 自带的运行时（macOS 的 `Contents/Frameworks` 288 MB、
 * Windows 的一堆 dll），那部分我们既控制不了、各平台大小也差得远 ——
 * 拿它当阈值只会得到一条「在 mac 上刚好、在 Windows 上随机红」的检查。
 *
 * 整包体积仍然**打印**出来（对照 Issue 里那个 948 MB 才看得懂），
 * 但只在**量过**的平台上断言，见 `BUNDLE_LIMITS`。
 */
const LIMITS = {
	// 实测 156 MB（node_modules 129 + out/ 27）。留约 30% 余量。
	payloadBytes: 200 * MB,
	// 实测 129 MB
	nodeModulesBytes: 160 * MB,
	// 实测 15098。⚠️ Issue 里写的目标是 5000，**那个数做不到** ——
	// 光 `@earendil-works` 一棵树就 4920 个文件，加 openai/zod/@anthropic-ai
	// 已经远超 5000。这里只做「再胖一圈就会响」的兜底，见 MAINTAINER_GUIDE。
	nodeModulesFiles: 17000,
};

/**
 * 整包体积上限，**按产物形态分别给**；`null` 表示不设（没量过就不写数字）。
 *
 * ⚠️ Windows 那条**故意留空**：量它需要下载 Windows 版 Electron 再打一次包，
 * 而本机网络到不了（TLS 断连，与 MAINTAINER_GUIDE「网络抖动是常态」一致）。
 * 宁可少一条断言，也不要写一个没量过的阈值 —— 那种检查第一次在 CI 上红
 * 就会被人把阈值改大，然后就再也没有意义了。
 */
const BUNDLE_LIMITS = {
	// macOS 实测 510 MB（Node 侧按文件大小求和；`du -sh` 因块粒度会显示 583 MB）
	'.app': 560 * MB,
	// Windows 未测量 —— 见上
	'-unpacked': null,
};

/**
 * 递归量一个目录：字节数与文件数。
 *
 * 口径是**按文件大小求和**，两处刻意的选择：
 *   · **不跟随符号链接**（与 `du` 一致）：跟进去既会重复计数，也可能绕成环
 *   · **不按块粒度**：`du` 数的是磁盘占用，小文件多时会被块粒度放大
 *     （本产物在 macOS 上 `du -sh` 显示 583 MB，这里算出 510 MB，差的就是这个）。
 *     块粒度随文件系统而变，**没法跨平台复现**，所以阈值只能用文件大小定。
 */
function measure(dir) {
	let bytes = 0;
	let files = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		const stat = lstatSync(full);
		if (stat.isSymbolicLink()) {
			// 符号链接只算它自己，不跟进去：跟进去既会重复计数，也可能绕成环
			bytes += stat.size;
			files += 1;
			continue;
		}
		if (stat.isDirectory()) {
			const inner = measure(full);
			bytes += inner.bytes;
			files += inner.files;
			continue;
		}
		bytes += stat.size;
		files += 1;
	}
	return { bytes, files };
}

/**
 * 找出打包产物里的 app 目录。
 *
 * 两种形态：
 *   macOS   release/mac-arm64/ZeroWork.app/Contents/Resources/app
 *   Windows release/win-unpacked/resources/app
 */
function findPackagedApps() {
	if (!existsSync(RELEASE_DIR)) return [];
	const found = [];
	for (const entry of readdirSync(RELEASE_DIR, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const full = path.join(RELEASE_DIR, entry.name);

		if (entry.name.endsWith('.app')) {
			found.push({
				label: entry.name,
				kind: '.app',
				bundle: full,
				appRoot: path.join(full, 'Contents/Resources/app'),
			});
			continue;
		}
		// release/mac-arm64/、release/mac/ 这类中间层
		for (const inner of readdirSync(full, { withFileTypes: true })) {
			if (!inner.isDirectory()) continue;
			const innerFull = path.join(full, inner.name);
			if (inner.name.endsWith('.app')) {
				found.push({
					label: `${entry.name}/${inner.name}`,
					kind: '.app',
					bundle: innerFull,
					appRoot: path.join(innerFull, 'Contents/Resources/app'),
				});
			} else if (inner.name.endsWith('unpacked')) {
				found.push({
					label: `${entry.name}/${inner.name}`,
					kind: '-unpacked',
					bundle: innerFull,
					appRoot: path.join(innerFull, 'resources/app'),
				});
			}
		}
	}
	return found.filter((app) => existsSync(app.appRoot));
}

/** 在随包 node_modules 里按目录名找包（含嵌套，例如 `node_modules/a/node_modules/b`）。 */
function collectPackagedModuleNames(nodeModulesDir) {
	const names = new Set();
	const walk = (dir, depth) => {
		if (depth > 6) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (entry.name === '.bin') continue;
			const full = path.join(dir, entry.name);
			if (entry.name.startsWith('@')) {
				for (const scoped of readdirSync(full, { withFileTypes: true })) {
					if (!scoped.isDirectory()) continue;
					names.add(`${entry.name}/${scoped.name}`);
					walk(path.join(full, scoped.name, 'node_modules'), depth + 1);
				}
				continue;
			}
			names.add(entry.name);
			walk(path.join(full, 'node_modules'), depth + 1);
		}
	};
	walk(nodeModulesDir, 0);
	return names;
}

function checkOne(app, problems) {
	const nodeModules = path.join(app.appRoot, 'node_modules');
	if (!existsSync(nodeModules)) {
		problems.push(`${app.label}：找不到 ${path.relative(ROOT, nodeModules)}（打包配置是不是被改坏了？）`);
		return null;
	}

	const appSize = measure(app.bundle);
	const payloadSize = measure(app.appRoot);
	const modulesSize = measure(nodeModules);
	const names = collectPackagedModuleNames(nodeModules);

	// ---- ① 渲染层专用依赖不得随包 ----
	for (const name of RENDERER_ONLY) {
		if (names.has(name)) {
			problems.push(
				`${app.label}：随包 node_modules 里出现了渲染层专用依赖 ${name}` +
					`（应从 dependencies 移到 devDependencies）`,
			);
		}
	}

	// ---- ② 有意排除的包不得随包 ----
	for (const name of DELIBERATELY_EXCLUDED) {
		if (names.has(name)) {
			problems.push(
				`${app.label}：随包 node_modules 里出现了已排除的 ${name}` +
					`（electron-builder.yml 的 files 排除规则失效了？）`,
			);
		}
	}

	// ---- ③ 主进程需要的包必须都在 ----
	for (const name of MAIN_PROCESS_REQUIRED) {
		if (!names.has(name)) {
			problems.push(
				`${app.label}：随包 node_modules 里缺少主进程需要的 ${name}` +
					`（移到 devDependencies 了？主进程会在运行时炸）`,
			);
		}
	}

	// ---- ④ package.json 的 dependencies 与产物一致 ----
	// 上面 ③ 是硬编码的「事实」，这一条是「声明」——两边都查，
	// 才能同时挡住「挪错了」与「声明与排除规则脱节」。
	for (const name of Object.keys(PKG.dependencies ?? {})) {
		if (DELIBERATELY_EXCLUDED.includes(name)) continue;
		if (!names.has(name)) {
			problems.push(`${app.label}：package.json 的 dependencies 里有 ${name}，但产物里没有`);
		}
	}

	// ---- ⑤ 体积与文件数 ----
	if (payloadSize.bytes > LIMITS.payloadBytes) {
		problems.push(
			`${app.label}：随包载荷（Resources/app）${fmtMB(payloadSize.bytes)}，` +
				`超过上限 ${fmtMB(LIMITS.payloadBytes)}`,
		);
	}
	if (modulesSize.bytes > LIMITS.nodeModulesBytes) {
		problems.push(
			`${app.label}：node_modules ${fmtMB(modulesSize.bytes)}，超过上限 ${fmtMB(LIMITS.nodeModulesBytes)}`,
		);
	}
	if (modulesSize.files > LIMITS.nodeModulesFiles) {
		problems.push(
			`${app.label}：node_modules ${modulesSize.files} 个文件，超过上限 ${LIMITS.nodeModulesFiles}`,
		);
	}

	// 整包体积：只在量过该形态的平台上断言（见 BUNDLE_LIMITS 的说明）
	const bundleLimit = BUNDLE_LIMITS[app.kind];
	if (bundleLimit !== null && bundleLimit !== undefined && appSize.bytes > bundleLimit) {
		problems.push(`${app.label}：整体 ${fmtMB(appSize.bytes)}，超过上限 ${fmtMB(bundleLimit)}`);
	}

	return { appSize, payloadSize, modulesSize, bundleLimit };
}

function main() {
	const apps = findPackagedApps();
	if (apps.length === 0) {
		process.stdout.write(`\n${yellow('随包体积契约检查：已跳过')}\n`);
		process.stdout.write(
			dim('  未找到打包产物（release/*/*.app、release/*-unpacked）—— 先跑 `npm run dist:dir`。本次没有验证任何东西。\n'),
		);
		return 0;
	}

	const problems = [];
	const rows = [];
	for (const app of apps) {
		const measured = checkOne(app, problems);
		if (measured) rows.push({ app, ...measured });
	}

	process.stdout.write('\n随包体积契约检查\n');
	for (const { app, appSize, payloadSize, modulesSize, bundleLimit } of rows) {
		process.stdout.write(
			`  ${app.label}\n` +
				`    随包载荷（Resources/app）${fmtMB(payloadSize.bytes)}` +
				`，node_modules ${fmtMB(modulesSize.bytes)} / ${modulesSize.files} 个文件\n` +
				`    整包 ${fmtMB(appSize.bytes)}` +
				(bundleLimit ? dim(`（上限 ${fmtMB(bundleLimit)}）`) : dim('（本形态未设上限）')) +
				'\n',
		);
	}
	process.stdout.write(
		dim(
			`  上限：载荷 ${fmtMB(LIMITS.payloadBytes)}，` +
				`node_modules ${fmtMB(LIMITS.nodeModulesBytes)} / ${LIMITS.nodeModulesFiles} 个文件\n` +
				'  注：体积按文件大小求和。`du -sh` 因块粒度会更大（macOS 上约 +14%），两个数都对，只是口径不同。\n',
		),
	);

	if (problems.length === 0) {
		process.stdout.write(
			`  ${green('✓')} 渲染层专用依赖 ${RENDERER_ONLY.length} 项均未随包；` +
				`主进程所需的 ${MAIN_PROCESS_REQUIRED.length} 个包均在\n`,
		);
		return 0;
	}

	process.stdout.write(`\n${red('随包依赖契约被破坏：')}\n`);
	for (const problem of problems.slice(0, 30)) process.stdout.write(`  ✗ ${problem}\n`);
	if (problems.length > 30) process.stdout.write(dim(`  …另有 ${problems.length - 30} 项\n`));
	process.stdout.write(
		dim(
			'  背景：v0.3.0 的安装包 948 MB / 22016 个文件，用户反馈「安装久、打开久、电脑卡」。\n' +
				'  移走渲染层专用依赖的经过与代价写在 electron-builder.yml 的 files 段。\n',
		),
	);
	return 1;
}

process.exit(main());
