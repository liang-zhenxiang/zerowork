/**
 * before-pack.cjs —— 打包前的保险
 *
 * electron-builder 会把 `files` 里列到的路径照单打包，**不检查它是否真的存在**。
 * 于是「忘了先 `npm run build`」的后果不是打包失败，而是**产出一个装完打不开的安装包** ——
 * 而那条路要走完「上传 → 用户下载 → 安装 → 双击 → 没反应」才会被发现。
 *
 * 所以在打包前显式确认一次：产物在不在。
 *
 * 用 `.cjs` 而不是 `.mjs`：electron-builder 用 `require()` 加载钩子，
 * 而本项目是 `"type": "module"` —— `.cjs` 是唯一不需要赌版本的正确后缀。
 */

const fs = require("node:fs");
const path = require("node:path");

const REQUIRED = [
	"out/main/index.mjs",
	"out/main/daemon.mjs",
	"out/preload/index.mjs",
	"out/renderer/index.html",
	"resources/scenes/work/prompt.md",
];

async function beforePack(context) {
	const root = context?.appDir ?? process.cwd();
	const missing = REQUIRED.filter((rel) => !fs.existsSync(path.join(root, rel)));

	if (missing.length > 0) {
		const list = missing.map((m) => `  ✗ ${m}`).join("\n");
		throw new Error(
			[
				"打包所需的产品不存在，先跑 `npm run build`：",
				list,
				"",
				"（不检查的话会产出一个装完打不开的安装包 —— 那比打包失败更糟。）",
			].join("\n"),
		);
	}
}

// electron-builder 支持 `exports.default` 与「模块本身是函数」两种解析方式，
// 两个都设上，不赌它走哪条。
module.exports = beforePack;
module.exports.default = beforePack;
