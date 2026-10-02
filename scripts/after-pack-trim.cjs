// afterPack 钩子：裁剪 @esbuild 的跨平台二进制（2026-10-02，update-channels）
//
// 背景：@earendil-works/chord（Agent 内核的运行时依赖）依赖 esbuild，
// esbuild 的平台二进制是 **optionalDependencies 形态的 @esbuild/<platform>**
// （aix-ppc64 到 win32-x64 共 27 个）。electron-builder 打包时按 package.json
// 重装依赖树，npm 会把**全部平台**的 optional 包都装进产物 —— 实测多出
// 262 MB（129 MB → 391 MB node_modules），体积契约当场爆红。
//
// 裁剪规则：只保留与**本次打包目标**匹配的平台目录，其余删除。
// 映射表覆盖 esbuild 全部平台名（esbuild 0.28）；esbuild 自身升级新增平台名时，
// 未在表里的目录**也一并删除**（保守方向：宁可将来补表，不能让产物再次膨胀）。
const { rmSync, existsSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

/** electron-builder 的 platform/arch → esbuild 的平台目录名。 */
const ESBUILD_PLATFORM = {
	darwin: { arm64: 'darwin-arm64', x64: 'darwin-x64' },
	win32: { x64: 'win32-x64', arm64: 'win32-arm64', ia32: 'win32-ia32' },
	linux: {
		arm64: 'linux-arm64',
		x64: 'linux-x64',
		arm: 'linux-arm',
		ia32: 'linux-ia32',
		ppc64: 'linux-ppc64',
		riscv64: undefined, // esbuild 无此目录；表里占位说明「linux+riscv64 不保留」
	},
};

module.exports = async function afterPack(context) {
	const platformName = context.electronPlatformName;
	// context.arch 是 electron-builder 的 Arch 枚举（数字：ia32=1、x64=2、arm64=3），
	// 也兼容已经是字符串的调用形态。
	const archNumber = { 1: 'ia32', 2: 'x64', 3: 'arm64' };
	const archName = archNumber[context.arch] ?? String(context.arch);
	const keep = ESBUILD_PLATFORM[platformName]?.[archName];
	const appDir = context.appOutDir;
	// appOutDir 在多架构打包时是**平台目录**（release/mac-arm64），.app 在它下面；
	// 单目标时也可能直接是 .app 目录。向下（最多两层）找 .app 结尾的目录。
	// asar:false（本项目既定），node_modules 是真实目录。
	const candidates = [];
	const dotApps = existsSync(appDir) ? readdirSync(appDir).filter((n) => n.endsWith('.app')) : [];
	for (const app of dotApps) {
		candidates.push(join(appDir, app, 'Contents', 'Resources', 'app', 'node_modules', '@esbuild'));
	}
	// appOutDir 直接就是 .app 的形态 / Windows（resources/app 无 Contents）
	candidates.push(join(appDir, 'Contents', 'Resources', 'app', 'node_modules', '@esbuild'));
	candidates.push(join(appDir, 'resources', 'app', 'node_modules', '@esbuild'));
	const target = candidates.find((dir) => existsSync(dir)) ?? null;
	if (target === null) {
		console.log(`[afterPack] 产物里没有 @esbuild 目录，无需裁剪`);
		return;
	}
	if (keep === undefined) {
		console.warn(`[afterPack] 未知的平台组合 ${platformName}/${archName}：@esbuild 全部保留（请补 ESBUILD_PLATFORM 表）`);
		return;
	}
	let removed = 0;
	for (const name of readdirSync(target)) {
		if (name === keep) continue;
		rmSync(join(target, name), { recursive: true, force: true });
		removed += 1;
	}
	console.log(`[afterPack] @esbuild 裁剪：保留 ${keep}，删除 ${removed} 个平台目录`);
};
