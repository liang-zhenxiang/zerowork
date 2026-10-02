#!/usr/bin/env node
/**
 * check-renderer-assets.mjs —— 渲染层产物契约检查
 *
 * 这条检查守的是一个**真实发生过的事故**（CHANGELOG 的 `0.1.4-zerowork.23`）：
 *
 *   渲染层的懒加载块用字面量字符串声明自己的依赖表：
 *
 *       viteMapDeps(["./office-xlsx.js", "./vendor-lodash.js", "./office-xlsx.css"])
 *
 *   这些字符串是**运行时**拼成 URL 去预加载的，构建工具不会改写它们
 *   —— 它只认 import 说明符。所以一旦产物文件名带上内容哈希
 *   （`office-xlsx.a1b2c3d4.js`），表里每一项就都指向不存在的文件。
 *   其中 CSS 那几条是致命的：预加载助手对 CSS 加载失败会 reject 懒加载 promise，
 *   未拦截的 `vite:preloadError` 直接抛出去，`<Suspense>` 兜不住，
 *   **整个渲染层落进错误边界**（表现为「点开 xlsx / 代码预览，界面变成『渲染出错』」）。
 *
 * 事故的修法写在 `electron.vite.config.mjs` 的 renderer 段：产物改用无哈希的语义名。
 * 这条检查就是那个修法的**守卫** —— 它比端到端测试快两个数量级，
 * 而且顺带覆盖 JS 项（现有 e2e 只断言了 3 个 css 文件存在）。
 *
 * 它同时还守着第二条**同样只有构建之后才能验证**的渲染层契约：**版本号注入**。
 * 界面显示的版本号来自 `electron.vite.config.mjs` 的 `renderer.define(__APP_VERSION__)`，
 * 单一真源是 `package.json` 的 `version`。若有人在渲染层源码里又写死一个版本字符串，
 * 界面就会向用户展示一个**不存在的版本**（真实缺陷：界面显示 `0.1.4`、package.json 是
 * `0.2.1`）。产物是判据：源码写死旧版本 → 产物里出现旧版本、找不到当前版本。
 *
 * 用法：
 *   npm run build && node scripts/check-renderer-assets.mjs
 *
 * 退出码：0 契约成立，1 有断链或版本号没注入；**尚未构建时返回 0 并明确说明「已跳过」**
 * （本地没构建就跑 lint 不该失败，但也不会被算作通过 —— 报告里会写明）。
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.join(ROOT, 'src/renderer/src');
const OUT_DIR = path.join(ROOT, 'out/renderer');
const ASSETS_DIR = path.join(OUT_DIR, 'assets');
const PKG_VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (USE_COLOR ? `\u001b[${code}m${text}\u001b[0m` : text);
const green = (t) => paint('32', t);
const red = (t) => paint('31', t);
const yellow = (t) => paint('33', t);
const dim = (t) => paint('2', t);

/**
 * 从源码里抽出懒加载依赖表的条目。
 *
 * 表的真实形态（压缩后的自赋值写法，见 src/renderer/src/app.js 第 1 行）：
 *
 *     const viteMapDeps=(i,m=viteMapDeps,d=(m.f||(m.f=["./office-docx.js", "./office-xlsx.css", ...])))=>i.map(i=>d[i]);
 *
 * 注意 `m.f||(m.f=[...])` 的含义是「已经设过就沿用」—— 同一个 bundle 里
 * 先加载的那个 chunk 的表会成为共享表。所以这里**逐个 chunk 收集**，
 * 不假设只有一处。
 */
function extractDeps(source) {
	const deps = [];
	const re = /m\.f\s*\|\|\s*\(\s*m\.f\s*=\s*\[([\s\S]*?)\]/g;
	let m;
	while ((m = re.exec(source)) !== null) {
		for (const lit of m[1].matchAll(/["']([^"']+)["']/g)) deps.push(lit[1]);
	}
	return deps;
}

/**
 * 判断某个产物是不是「源文件名 + 内容哈希」。
 *
 * **不能用正则去猜哈希形态**（比如「末尾 8 位字母数字」）—— `lang-javascript.js`
 * 里的 `javascript` 长度正好是 10，会被误判成哈希。这里改成对照源文件名：
 * 产物里出现了 `X-<后缀>.js` 而源码里是 `X.js`，那才是 Vite 加哈希的形态。
 */
function hashedVariantOf(assetNames, chunkName) {
	const stem = chunkName.replace(/\.(js|mjs|css)$/, '');
	return assetNames.find((name) => name.startsWith(`${stem}-`) && name !== chunkName) ?? null;
}

/**
 * 找出被**内联**的本地模块名 —— 即「只被静态 `from "./x.js"` 引用、从不按运行时
 * 名字加载的产物」的文件。
 *
 * 这类文件（如命令面板内核 command-palette-core.js）被 Rollup 内联进导入它的
 * chunk，**不产出同名产物**，因此不该被「每个源码 chunk 都要有一份同名产物」
 * 这条要求追究。漏掉这一步的后果是：往 src/renderer/src/ 加一个被静态引用的
 * 纯逻辑模块，检查会误报「产物里没有它」。
 *
 * **判据不能只看「静态 import」**：本仓库的产物格式是共享 chunk —— 懒加载块之间
 * 也互相 `from "./x.js"`（例如 lang-javascript.js `from "./lang-typescript.js"`），
 * 且以字面量字符串互相列进依赖表（`viteMapDeps(["./vendor-lodash.js", …])`）。
 * 若只看静态 import，一个真懒加载块被改名成带哈希时会被误当作「内联」而漏报 ——
 * 恰是这条守卫要防的事故。所以这里把「动态 import 目标」与「依赖表里的字面量名」
 * 一并算作**运行时按名引用**，从中扣除后剩下的才是真正内联的模块。
 */
function inlinedModuleNames(chunks, srcDir) {
	const staticNames = new Set();
	const runtimeNames = new Set();
	const fromRe = /from\s*["']\.\/([^"']+\.js)["']/g;
	const importRe = /import\s*\(\s*["']\.\/([^"']+\.js)["']\s*\)/g;
	for (const chunk of chunks) {
		const source = readFileSync(path.join(srcDir, chunk), 'utf8');
		let m;
		while ((m = fromRe.exec(source)) !== null) staticNames.add(m[1]);
		while ((m = importRe.exec(source)) !== null) runtimeNames.add(m[1]);
		for (const dep of extractDeps(source)) runtimeNames.add(dep.replace(/^\.\//, ''));
	}
	const inlined = new Set();
	for (const name of staticNames) {
		if (!runtimeNames.has(name)) inlined.add(name);
	}
	return inlined;
}

/**
 * 版本号有没有真的注入到产物里。
 *
 * 判据是**带引号**的字面量：注入的是 `JSON.stringify(pkg.version)`，
 * 落进产物就该是一个字符串字面量 `"0.2.1"`。不带引号的 `0.2.1` 可能是某个依赖
 * 自带的版本文本，用它当判据会误判为「注入成功」。
 *
 * 返回 null 表示没问题，否则返回一句可诊断的说明。
 */
function versionProblem() {
	const appJs = path.join(ASSETS_DIR, 'app.js');
	if (!existsSync(appJs)) return '产物里没有 app.js —— 版本号注入的落点不见了';
	const built = readFileSync(appJs, 'utf8');
	if (built.includes(`"${PKG_VERSION}"`)) return null;
	return `out/renderer/assets/app.js 里找不到版本号 "${PKG_VERSION}"`;
}

function main() {
	if (!existsSync(ASSETS_DIR)) {
		process.stdout.write(`\n${yellow('渲染层产物契约检查：已跳过')}\n`);
		process.stdout.write(
			dim('  未找到 out/renderer/assets —— 先跑 `npm run build`。本次没有验证任何东西。\n'),
		);
		return 0;
	}

	const chunks = readdirSync(SRC_DIR).filter((f) => f.endsWith('.js'));
	const inlined = inlinedModuleNames(chunks, SRC_DIR);
	const assetNames = readdirSync(ASSETS_DIR, { withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => entry.name);

	/** 产物里的可用文件名（assets/ 下的 + renderer 根下的，例如 index.html）。 */
	const available = new Set(assetNames);
	for (const entry of readdirSync(OUT_DIR, { withFileTypes: true })) {
		if (entry.isFile()) available.add(entry.name);
	}

	const missingDeps = [];
	const renamed = [];
	const badVersion = versionProblem();
	let total = 0;

	for (const chunk of chunks) {
		// ① 每个源码 chunk 都应当有一份**同名**产物。
		//    一旦名字变成 `chunk-<哈希>.js`，依赖表里的字面量字符串就全部落空。
		//    例外：被静态 import 且非动态入口的模块会被内联进导入方，本就没有独立产物，跳过。
		if (!inlined.has(chunk) && !available.has(chunk)) {
			const variant = hashedVariantOf(assetNames, chunk);
			renamed.push(variant ? `${chunk} → ${variant}` : `${chunk}（产物里没有它，也没有带后缀的变体）`);
		}

		// ② 依赖表里引用的每一项都必须真的存在。
		const source = readFileSync(path.join(SRC_DIR, chunk), 'utf8');
		for (const dep of extractDeps(source)) {
			total += 1;
			const name = dep.replace(/^\.\//, '');
			if (!available.has(name)) {
				missingDeps.push(`${chunk} 的依赖表引用了产物里不存在的 ${name}`);
			}
		}
	}

	const inlinedChunks = chunks.filter((chunk) => inlined.has(chunk));
	process.stdout.write('\n渲染层产物契约检查\n');
	process.stdout.write(
		`  源码 ${chunks.length} 个文件（其中 ${inlinedChunks.length} 个被静态 import、内联进导入方，无需独立产物），依赖表共 ${total} 项\n`,
	);

	if (missingDeps.length > 0) {
		process.stdout.write(`\n${red('依赖表指向了不存在的产物：')}\n`);
		for (const problem of missingDeps.slice(0, 20)) process.stdout.write(`  ✗ ${problem}\n`);
		if (missingDeps.length > 20) {
			process.stdout.write(dim(`  …另有 ${missingDeps.length - 20} 项\n`));
		}
		process.stdout.write(
			dim(
				'  这会导致懒加载预取失败；CSS 那几条会让整个渲染层落进错误边界（真实事故，见 CHANGELOG 的 0.1.4-zerowork.23）。\n',
			),
		);
	}

	if (renamed.length > 0) {
		process.stdout.write(`\n${red('产物名与源码 chunk 名对不上（多半是加上了内容哈希）：')}\n`);
		for (const name of renamed.slice(0, 10)) process.stdout.write(`  ✗ ${name}\n`);
		process.stdout.write(
			dim('  渲染层产物必须用无哈希的语义名，规则见 electron.vite.config.mjs 的 renderer 段。\n'),
		);
	}

	if (missingDeps.length === 0 && renamed.length === 0) {
		process.stdout.write(
			`  ${green('✓')} ${chunks.length - inlinedChunks.length} 个 chunk 全部同名产出，依赖表 ${total} 项全部命中\n`,
		);
	}

	if (badVersion === null) {
		process.stdout.write(`  ${green('✓')} 产物含当前版本号 "${PKG_VERSION}"（package.json 的 version）\n`);
	} else {
		process.stdout.write(`\n${red('版本号没注入到产物里：')}\n  ✗ ${badVersion}\n`);
		process.stdout.write(
			dim(
				'  渲染层显示给用户的版本号由 electron.vite.config.mjs 的 renderer.define(__APP_VERSION__) 注入，\n' +
					'  单一真源是 package.json 的 version。在渲染层源码里写死版本号会让界面展示一个不存在的版本。\n',
			),
		);
	}

	if (missingDeps.length === 0 && renamed.length === 0 && badVersion === null) return 0;

	return 1;
}

process.exit(main());
