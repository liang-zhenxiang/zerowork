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

/**
 * electron-builder 的 platform/arch → esbuild 的平台目录名。
 *
 * **键必须与 `builder-util` 的 `Arch` 枚举名一一对应**（见下面的 `ARCH_NAMES`）：
 * 查到就保留那个目录、删掉其余；查不到（`undefined`）表示「表里没有这个组合」，
 * 走保守分支 —— 全留 + 警告（宁可臃肿，不能删错）。
 *
 * 2026-10-10 除了修 arch 数字，还清掉了两类**不可达条目**：
 *   · `linux.arm` 应为 `linux.armv7l` —— 枚举名是 `armv7l`，写 `arm` 的话
 *     linux/armv7l 也会掉进兜底分支（与 x64 那次同一个病）
 *   · `linux.ppc64` / `linux.riscv64` —— 这两个 **不是 `Arch` 的枚举值**，
 *     `context.arch` 永远取不到，留着只会制造「已经考虑过」的错觉
 */
const ESBUILD_PLATFORM = {
	darwin: { arm64: 'darwin-arm64', x64: 'darwin-x64' },
	win32: { x64: 'win32-x64', arm64: 'win32-arm64', ia32: 'win32-ia32' },
	linux: { arm64: 'linux-arm64', x64: 'linux-x64', armv7l: 'linux-arm', ia32: 'linux-ia32' },
};

/**
 * electron-builder 的 `Arch` 枚举值 → 名字。
 *
 * ⚠️ 这几个数字是**抄自上游**的，不是我们定的：来源是
 * `node_modules/builder-util/out/arch.js`（electron-builder 的依赖）：
 *     ia32=0, x64=1, armv7l=2, arm64=3, universal=4
 *
 * 2026-10-10 修掉的正是这里：原表写成 `{1:'ia32', 2:'x64', 3:'arm64'}`（差一位），
 * 于是 x64 目标被认成 ia32、走进「未知平台组合」兜底分支 —— 裁剪对
 * darwin-x64 / win32-x64 / linux-x64 **全部静默失效**，而 arm64 恰好蒙对。
 *
 * 上游若再改枚举，`tests/unit/after-pack-trim.test.mjs` 里那条「对着装着的
 * builder-util 反查」会变红 —— 不依赖谁记得回来改这张表。
 */
const ARCH_NAMES = {
	0: 'ia32',
	1: 'x64',
	2: 'armv7l',
	3: 'arm64',
	4: 'universal',
};

/**
 * 纯函数：`(平台, arch) → 要保留的 esbuild 目录名`。
 *
 * `arch` 可以是 electron-builder 的枚举数字，也可以是字符串（CLI 传 arch 名时）。
 * 返回字符串 = 保留它；返回 `undefined` = 表里没有这个组合（调用方走保守分支）。
 */
function esbuildDirFor(platformName, arch) {
	const archName = typeof arch === 'string' ? arch : (ARCH_NAMES[arch] ?? String(arch));
	const byPlatform = ESBUILD_PLATFORM[platformName];
	return byPlatform === undefined ? undefined : byPlatform[archName];
}

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
	// context.arch 是 electron-builder 的 Arch 枚举数字，映射见 ARCH_NAMES
	const keep = esbuildDirFor(platformName, context.arch);

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
		const archName = typeof context.arch === 'string' ? context.arch : (ARCH_NAMES[context.arch] ?? String(context.arch));
		console.warn(`[afterPack] 未知的平台组合 ${platformName}/${archName}：@esbuild 全部保留（请补 ESBUILD_PLATFORM 表）`);
		return;
	}
	const removed = trimEsbuildDir(target, keep);
	console.log(`[afterPack] @esbuild 裁剪：保留 ${keep}，删除 ${removed} 个平台目录`);
}

/**
 * 在 `@esbuild` 目录里执行裁剪：只留下 `keep`，其余全删。返回删掉的目录个数。
 *
 * 抽成可测函数是为了夹具能证明它**真的会删** —— 本机只有一个平台目录时，
 * 原来的实现（连 keep 都算错）看不出任何异常。
 */
function trimEsbuildDir(target, keep) {
	let removed = 0;
	for (const name of readdirSync(target)) {
		if (name === keep) continue;
		rmSync(join(target, name), { recursive: true, force: true });
		removed += 1;
	}
	return removed;
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

async function afterPack(context) {
	trimEsbuild(context);
	adhocSign(context);
}

// electron-builder 的契约是「模块导出一个函数」——命名导出挂在它身上，
// 供单测直接验证，不改变 electron-builder 的调用方式。
module.exports = afterPack;
module.exports.esbuildDirFor = esbuildDirFor;
module.exports.trimEsbuild = trimEsbuild;
module.exports.trimEsbuildDir = trimEsbuildDir;
module.exports.ARCH_NAMES = ARCH_NAMES;
module.exports.ESBUILD_PLATFORM = ESBUILD_PLATFORM;
