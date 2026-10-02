// afterPack 钩子：两件事，各自对应一次真实事故。
//
// ⚠️ 为什么是 afterPack 而不是 afterSign：electron-builder 在「本次没有发生签名」
// 时**不会调用 afterSign**（源码 eventEmitter 那行的原话：
// `skipping "afterSign" hook as no signing occurred, perhaps you intended "afterPack"?`），
// 而本项目 `identity: null` 正是「不签名」。afterPack 是唯一必被调用的落点。
//
// ⚠️ 钩子顺序（读 app-builder-lib/out/platformPackager.js 确认）：
//     emitAfterPack → framework.afterPack → doAddElectronFuses → doSignAfterPack
// 也就是说 **fuses 会在本钩子之后改二进制**，会把这里签好的名弄坏。
// 当前安全，因为本项目没有配置 `electronFuses`（未配置时 doAddElectronFuses
// 直接 return）。**将来若启用 electronFuses，必须把签名挪到 fuses 之后**
// ——下面的 `--verify` 步骤会让这种错误在构建期就红，而不是等用户装完打不开。
const { execFileSync } = require('node:child_process');
const { rmSync, existsSync, readdirSync } = require('node:fs');
const { join } = require('node:path');

/**
 * 找到本次打包产物里的 .app。
 * appOutDir 在多架构打包时是**平台目录**（release/mac-arm64），.app 在它下面；
 * 单目标时也可能直接是 .app 目录。
 */
function findAppBundle(appOutDir) {
	if (appOutDir.endsWith('.app') && existsSync(join(appOutDir, 'Contents', 'Info.plist'))) return appOutDir;
	if (!existsSync(appOutDir)) return null;
	for (const name of readdirSync(appOutDir)) {
		if (!name.endsWith('.app')) continue;
		const candidate = join(appOutDir, name);
		if (existsSync(join(candidate, 'Contents', 'Info.plist'))) return candidate;
	}
	return null;
}

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

// ---------------------------------------------------------------------------
// ① 裁剪 @esbuild 的跨平台二进制（2026-10-02，update-channels）
//
// @earendil-works/chord（Agent 内核运行时依赖）依赖 esbuild，其平台二进制是
// optionalDependencies 形态的 @esbuild/<platform>（27 个）。electron-builder
// 打包时按 package.json 重装依赖树，npm 会把**全部平台**都装进产物，实测多出
// 262 MB（129 → 391 MB node_modules）。只保留与本次打包目标匹配的那一个，
// 表外的目录一并删除（保守方向：宁可将来补表，不能让产物再次膨胀）。
// ---------------------------------------------------------------------------
function trimEsbuild(context) {
	const platformName = context.electronPlatformName;
	// context.arch 是 electron-builder 的 Arch 枚举（数字：ia32=1、x64=2、arm64=3）
	const archNumber = { 1: 'ia32', 2: 'x64', 3: 'arm64' };
	const archName = archNumber[context.arch] ?? String(context.arch);
	const keep = ESBUILD_PLATFORM[platformName]?.[archName];

	const app = findAppBundle(context.appOutDir);
	if (app === null) {
		console.log('[afterPack] 没找到 .app，跳过 @esbuild 裁剪');
		return;
	}
	const target = join(app, 'Contents', 'Resources', 'app', 'node_modules', '@esbuild');
	if (!existsSync(target)) {
		console.log('[afterPack] 产物里没有 @esbuild 目录，无需裁剪');
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
}

// ---------------------------------------------------------------------------
// ② macOS：整体重新 ad-hoc 签名（2026-10-02，beta.2 用户实测）
//
// 症状：Apple 芯片用户双击 arm64 包 →「ZeroWork.app 已损坏，无法打开」，
// 且**系统设置里没有「仍要打开」按钮**（那是「无法验证开发者」才有的）。
//
// 根因（取证）：`identity: null` 让上游 Electron 预编译二进制自带的
// linker-signed 签名原样留下，而构建往 bundle 里加了 out/、resources/、
// node_modules/ ——签名记录的资源清单与实际不符：
//     spctl → code has no resources but signature indicates they must be present
//     codesign → flags=0x20002(adhoc, linker-signed)  Identifier=Electron
//
// 为什么 Intel 包反而能开：Apple 芯片**强制要求 arm64 二进制有有效签名才能执行**，
// 签名损坏 = 直接拒绝执行；x86_64 走 Rosetta 不受这条约束，所以只是普通的
// Gatekeeper 未验证（能放行，但慢）。
//
// 修法：所有 bundle 改动完成之后整体重签（--deep 自内向外签嵌套代码）。
// 效果：判定从「签名损坏」变为「未验证开发者」→ 右键「打开」可用、
// 系统设置出现「仍要打开」按钮。
//
// 代价（有意接受）：签名随时可被用户绕过（ad-hoc 本就不提供身份证明），
// 它的作用只是让 bundle **结构自洽**，从而让 macOS 愿意执行 arm64 二进制。
// 真正的信任仍需开发者证书 + 公证，见 docs/MAINTAINER_GUIDE.md 的「安装包签名」。
// ---------------------------------------------------------------------------
function adhocSign(context) {
	if (context.electronPlatformName !== 'darwin') return;
	const app = findAppBundle(context.appOutDir);
	if (app === null) {
		throw new Error('[afterPack] 没找到 .app，无法 ad-hoc 签名');
	}
	console.log('[afterPack] ad-hoc 签名中…');
	// --force 覆盖既有（损坏的）签名；--deep 自内向外签嵌套的 framework/helper；
	// --sign - 表示 ad-hoc；--timestamp=none 不去连 Apple 时间戳服务（离线可构建）。
	execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', app], { stdio: 'inherit' });
	// 构建期自证：签名必须**能验过**且**不是损坏态**。这一步同时守住
	// 「将来启用 electronFuses 会把签名弄坏」那条路——那时这里会红，
	// 而不是等用户装完打不开。
	execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
	console.log('[afterPack] ad-hoc 签名完成并通过校验');
}

module.exports = async function afterPack(context) {
	trimEsbuild(context);
	adhocSign(context);
};
