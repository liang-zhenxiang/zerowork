#!/usr/bin/env node
/**
 * vendor-katex.mjs —— KaTeX 数学渲染链的可再生 vendor 步骤（issue #74）
 *
 * 「可再生」是关键：不手工粘贴，任何时候重跑都从 node_modules 重新生成
 * （chartUmd 是手工粘的先例，不可再生，勿效仿）。
 *
 * 做三件事：
 *   1. `src/renderer/src/vendor-katex.js`：用 esbuild 把
 *      remark-math + rehype-katex + katex 及其依赖树打成**单个 ESM**
 *      （~296KB min）。为什么整链 vendor 而不是只用 katex：
 *      $..$ 语法必须在 **micromark 字符层**捕获——先走 markdown 的 text
 *      解码再切分的话，TeX 里的反斜杠序列（\alpha、\,）已经被 markdown
 *      当转义吃掉了（2026-10-02 第一版自写切分就栽在这：`f(x)\,dx`
 *      进公式时变 `f(x),dx`）。remark-math 是官方语法插件，字符层保真。
 *   2. `src/renderer/src/katex.css`：katex.min.css 拷贝 + 三处改写
 *      （字体 url 指向 ./katex-fonts/；删 woff/ttf 旧格式；删未随包
 *      字体的 @font-face 块——留着是产物 css 里的死引用）。
 *   3. `src/renderer/src/katex-fonts/*.woff2`：核心字体子集 13 个
 *      （Main 四态/Math 两态/AMS/Size1-4/Caligraphic 两态）。不带
 *      Fraktur/SansSerif/Typewriter/Script 与 ttf/woff——Chromium 原生
 *      woff2，旧格式是老浏览器兜底的死重；罕见字体缺失时 KaTeX 以
 *      回退字形渲染，不报错。
 *
 * esbuild 不进 devDependencies：产物已提交，CI 不需要重新生成；
 * 本机升级 katex 后 `npx -y esbuild` 临时拉取即可。
 *
 * 用法：node scripts/vendor-katex.mjs（katex 版本变更后重跑）
 * 守卫：scripts/check-vendored-deps.mjs 登记本产物。
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = resolve(ROOT, 'node_modules/katex/dist');
// vendor-katex.js 放 src/renderer/（src 的上一级）：check-renderer-assets 按
// src/renderer/src/*.js 对账产物名，静态并入 app chunk 的 vendor 不产出独立文件，
// 放在扫描范围外避免契约误报（功能与产物路径见各自登记）。
const RENDERER = resolve(ROOT, 'src/renderer');

const CORE_FONTS = [
	'KaTeX_AMS-Regular',
	'KaTeX_Caligraphic-Regular',
	'KaTeX_Caligraphic-Bold',
	'KaTeX_Main-Regular',
	'KaTeX_Main-Bold',
	'KaTeX_Main-Italic',
	'KaTeX_Main-BoldItalic',
	'KaTeX_Math-Italic',
	'KaTeX_Math-BoldItalic',
	'KaTeX_Size1-Regular',
	'KaTeX_Size2-Regular',
	'KaTeX_Size3-Regular',
	'KaTeX_Size4-Regular',
];

function fail(message) {
	console.error(`✗ ${message}`);
	process.exit(1);
}

if (!existsSync(DIST)) fail('node_modules/katex 不在（先 npm install）');
const katexVersion = JSON.parse(readFileSync(resolve(ROOT, 'node_modules/katex/package.json'), 'utf8')).version;

// ── 1. vendor-katex.js（esbuild 整链打包）──────────────────────
const entry = resolve(ROOT, 'scripts/.katex-entry.tmp.mjs');
writeFileSync(entry, [
	"import remarkMath from 'remark-math';",
	"import rehypeKatex from 'rehype-katex';",
	'export { remarkMath, rehypeKatex };',
	'',
].join('\n'));
const esbuild = spawnSync(
	'npx',
	['-y', 'esbuild', entry, '--bundle', '--format=esm', '--minify', `--outfile=${resolve(RENDERER, 'vendor-katex.js')}`, '--log-level=warning'],
	{ cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' },
);
rmSync(entry, { force: true });
if (esbuild.status !== 0) fail('esbuild 打包失败（看上方输出）');
// 头注释补在产物最前（esbuild 的 --banner 换行处理不稳，直接前置）
const js = readFileSync(resolve(RENDERER, 'vendor-katex.js'), 'utf8');
writeFileSync(
	resolve(RENDERER, 'vendor-katex.js'),
	`/* eslint-disable */\n// 由 scripts/vendor-katex.mjs 生成（katex ${katexVersion}）——勿手改，升级后重跑脚本。\n// remark-math + rehype-katex + katex 整链（含依赖树）的 esbuild 产物；\n// 语法捕获在 micromark 字符层，TeX 的反斜杠序列不被 markdown 转义吃掉。\n${js}`,
);
console.log(`✓ vendor-katex.js（${(js.length / 1024).toFixed(0)} KB，katex ${katexVersion}）`);

// ── 2. katex.css ──────────────────────────────────────────────
let css = readFileSync(resolve(DIST, 'katex.min.css'), 'utf8');
css = css.replaceAll('url(fonts/', 'url(./katex-fonts/');
css = css.replace(/,url\([^)]*\.woff\) format\("woff"\)/g, '');
css = css.replace(/,url\([^)]*\.ttf\) format\("truetype"\)/g, '');
const included = new Set(CORE_FONTS);
css = css.replace(/@font-face\{[^}]*font-family:"?KaTeX_([A-Za-z0-9]+)"?[^}]*\}/g, (block, family) => {
	// family 捕获要含数字（KaTeX_Size1 的 "1"）与可选引号（"KaTeX_SansSerif"
	// 带引号形态）——第一版漏了这两样，Size1-4 被误删、SansSerif 漏删。
	const named = `KaTeX_${family}`;
	return included.has(`${named}-Regular`) || included.has(`${named}-Bold`) || included.has(`${named}-Italic`) || included.has(`${named}-BoldItalic`) ? block : '';
});
writeFileSync(resolve(SRC, 'katex.css'), `/* 由 scripts/vendor-katex.mjs 生成（勿手改）；字体 url 已改写至 ./katex-fonts/（仅 woff2 核心子集） */\n${css}`);
console.log(`✓ katex.css（${(css.length / 1024).toFixed(0)} KB）`);

// ── 3. 核心字体 woff2 ─────────────────────────────────────────
const fontsDir = resolve(SRC, 'katex-fonts');
mkdirSync(fontsDir, { recursive: true });
for (const name of CORE_FONTS) {
	copyFileSync(resolve(DIST, 'fonts', `${name}.woff2`), resolve(fontsDir, `${name}.woff2`));
}
console.log(`✓ katex-fonts/（${CORE_FONTS.length} 个核心 woff2，子集取舍见脚本头注释）`);
