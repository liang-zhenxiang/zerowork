/**
 * `scripts/after-pack.cjs` 的 @esbuild 裁剪：映射表与真删。
 *
 * 这个守卫在这次修复之前**有一半是失效的**，而且失效得毫无声息：手抄的 arch 数字
 * 与 `builder-util` 的 `Arch` 枚举差一位，于是 x64 目标被认成 ia32、落进
 * 「未知平台组合」的兜底分支（一个都不删）；arm64 恰好蒙对，所以看起来一直正常。
 * 三个纯函数各自要钉住：
 *   1. 映射：darwin / win32 / linux × 全部 arch，且**对着装着的 builder-util 反查**
 *      —— 上游改枚举时这里变红，不靠谁记得回来改那张表
 *   2. 表里**不能有不可达条目**：键必须是 Arch 的枚举名，且枚举里的值一个都不能漏
 *      （`arm` vs `armv7l` 这类拼写差就是同一场事故的另一种形态）
 *   3. `trimEsbuildDir` **真的会删**：夹具里放多个平台目录，断言只剩目标那一个
 *      （本机只有一个平台目录，所以这条以前根本没法证伪）
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { ARCH_NAMES, ESBUILD_PLATFORM, esbuildDirFor, trimEsbuild, trimEsbuildDir } = require(
	'../../scripts/after-pack.cjs',
);

const tempRoots = [];

/** 造一个假的 `node_modules/@esbuild` 目录，里面放若干平台目录。 */
function makeEsbuildFixture(names) {
	// mkdtempSync 而不是「tmpdir + 可预测名字」：可预测的临时目录会被
	// CodeQL 判为 insecure temporary file（也确实可被预创建/符号链接利用）。
	const root = mkdtempSync(join(tmpdir(), 'zerowork-esbuild-trim-'));
	tempRoots.push(root);
	for (const name of names) {
		mkdirSync(join(root, name), { recursive: true });
		writeFileSync(join(root, name, 'package.json'), '{}');
	}
	return root;
}

afterAll(() => {
	for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
});

describe('esbuildDirFor —— 与 builder-util 的 Arch 枚举对齐', () => {
	it('本地映射与装着的 builder-util 枚举逐项一致（上游改了这里就红）', () => {
		// builder-util 是 electron-builder 的依赖，它导出的 Arch 才是 afterPack 里
		// context.arch 的真正含义来源。这条不是「再抄一遍」，是**反查证据**。
		const { Arch } = require('builder-util');
		for (const [number, name] of Object.entries(ARCH_NAMES)) {
			expect(Arch[Number(number)], `Arch[${number}] 应为 ${name}`).toBe(name);
		}
		// 反向也要成立：枚举里不该有我们没登记的值（漏一个 = 那个 arch 会走兜底全留）
		for (const [key, value] of Object.entries(Arch)) {
			if (Number.isNaN(Number(key))) continue; // 跳过反向索引项（name → number）
			expect(ARCH_NAMES[Number(key)], `ARCH_NAMES 缺 Arch.${value}`).toBe(value);
		}
	});

	it('x64（枚举值 1）解析成各平台的 x64 目录 —— 这正是此前失效的那一档', () => {
		expect(esbuildDirFor('darwin', 1)).toBe('darwin-x64');
		expect(esbuildDirFor('win32', 1)).toBe('win32-x64');
		expect(esbuildDirFor('linux', 1)).toBe('linux-x64');
	});

	it('arm64（枚举值 3）与其它档位', () => {
		expect(esbuildDirFor('darwin', 3)).toBe('darwin-arm64');
		expect(esbuildDirFor('win32', 3)).toBe('win32-arm64');
		expect(esbuildDirFor('linux', 3)).toBe('linux-arm64');
		expect(esbuildDirFor('win32', 0)).toBe('win32-ia32');
		expect(esbuildDirFor('linux', 0)).toBe('linux-ia32');
		// armv7l 的枚举名就是 armv7l —— 表里曾经写成 arm，于是这一档也走兜底全留
		expect(esbuildDirFor('linux', 2)).toBe('linux-arm');
		expect(esbuildDirFor('linux', 'armv7l')).toBe('linux-arm');
	});

	it('字符串形态的 arch 也认（CLI 传 arch 名时）', () => {
		expect(esbuildDirFor('darwin', 'x64')).toBe('darwin-x64');
		expect(esbuildDirFor('win32', 'arm64')).toBe('win32-arm64');
	});

	it('表里没有的组合返回 undefined —— 调用方据此走「保守全留 + 警告」', () => {
		// darwin 只有 x64 / arm64 两种目标；ia32 不是合法组合 → 兜底（全留 + 警告）
		expect(esbuildDirFor('darwin', 0)).toBeUndefined();
		// 整个平台都不认识
		expect(esbuildDirFor('plan9', 1)).toBeUndefined();
		// 不是 Arch 枚举值的名字（ppc64 / riscv64 曾在表里，已删）
		expect(esbuildDirFor('linux', 'ppc64')).toBeUndefined();
		expect(esbuildDirFor('linux', 'riscv64')).toBeUndefined();
	});

	it('值必须是以平台名开头的 esbuild 目录名（防手误）', () => {
		for (const [platformName, byPlatform] of Object.entries(ESBUILD_PLATFORM)) {
			for (const [archName, dir] of Object.entries(byPlatform)) {
				expect(dir.startsWith(`${platformName}-`), `${platformName}.${archName} → ${dir}`).toBe(true);
			}
		}
	});
});

describe('trimEsbuildDir —— 夹具证明它真的会删', () => {
	const NAMES = ['darwin-x64', 'darwin-arm64', 'linux-x64', 'win32-x64', 'linux-arm64'];

	it('只留下目标平台，其余四个都删掉', () => {
		const dir = makeEsbuildFixture(NAMES);
		expect(trimEsbuildDir(dir, 'darwin-x64')).toBe(4);
		expect(readdirSync(dir)).toEqual(['darwin-x64']);
	});

	it('目录里本来就没有多余的平台时不误删', () => {
		const dir = makeEsbuildFixture(['darwin-x64']);
		expect(trimEsbuildDir(dir, 'darwin-x64')).toBe(0);
		expect(readdirSync(dir)).toEqual(['darwin-x64']);
	});

	it('目标平台不在夹具里时，其余全删（宁缺勿滥的方向由 keep 决定，不由这里决定）', () => {
		const dir = makeEsbuildFixture(['linux-x64', 'win32-x64']);
		expect(trimEsbuildDir(dir, 'darwin-x64')).toBe(2);
		expect(readdirSync(dir)).toEqual([]);
	});
});

describe('trimEsbuild —— 从 context 到真删的整条接线', () => {
	/**
	 * 造一个形状正确的最小 .app：`findAppBundle` 只认 `Contents/Info.plist`。
	 * 这样整条接线（找 .app → 定位 @esbuild → 算 keep → 删）都能在不真打包的前提下跑。
	 */
	function makeAppFixture(platformDirs) {
		const outDir = mkdtempSync(join(tmpdir(), 'zerowork-appfx-'));
		const app = join(outDir, 'ZeroWork.app');
		mkdirSync(join(app, 'Contents'), { recursive: true });
		writeFileSync(join(app, 'Contents', 'Info.plist'), '<plist/>');
		const esbuildDir = join(app, 'Contents', 'Resources', 'app', 'node_modules', '@esbuild');
		mkdirSync(esbuildDir, { recursive: true });
		tempRoots.push(outDir);
		for (const name of platformDirs) mkdirSync(join(esbuildDir, name), { recursive: true });
		return { outDir, esbuildDir };
	}

	it('darwin/x64（枚举 1）：只留 darwin-x64 —— 这正是修之前一个都不删的那一档', () => {
		const { outDir, esbuildDir } = makeAppFixture([
			'darwin-x64',
			'darwin-arm64',
			'linux-x64',
			'win32-x64',
		]);
		trimEsbuild({ electronPlatformName: 'darwin', arch: 1, appOutDir: outDir });
		expect(readdirSync(esbuildDir)).toEqual(['darwin-x64']);
	});

	it('darwin/arm64（枚举 3）：只留 darwin-arm64', () => {
		const { outDir, esbuildDir } = makeAppFixture(['darwin-x64', 'darwin-arm64']);
		trimEsbuild({ electronPlatformName: 'darwin', arch: 3, appOutDir: outDir });
		expect(readdirSync(esbuildDir)).toEqual(['darwin-arm64']);
	});

	it('win32/x64（枚举 1）：只留 win32-x64', () => {
		const { outDir, esbuildDir } = makeAppFixture(['win32-x64', 'win32-arm64', 'darwin-x64']);
		trimEsbuild({ electronPlatformName: 'win32', arch: 1, appOutDir: outDir });
		expect(readdirSync(esbuildDir)).toEqual(['win32-x64']);
	});

	it('表里没有的组合（darwin/ia32）：一个都不删，并留下警告 —— 保守方向不能反', () => {
		const { outDir, esbuildDir } = makeAppFixture(['darwin-x64', 'darwin-arm64']);
		const warned = [];
		const originalWarn = console.warn;
		console.warn = (message) => warned.push(message);
		try {
			trimEsbuild({ electronPlatformName: 'darwin', arch: 0, appOutDir: outDir });
		} finally {
			console.warn = originalWarn;
		}
		expect(readdirSync(esbuildDir).sort()).toEqual(['darwin-arm64', 'darwin-x64']);
		expect(warned.join('\n')).toContain('未知的平台组合 darwin/ia32');
	});

	it('找不到 .app 时安全跳过（不抛）', () => {
		const outDir = mkdtempSync(join(tmpdir(), 'zerowork-appfx-none-'));
		tempRoots.push(outDir);
		expect(() =>
			trimEsbuild({ electronPlatformName: 'darwin', arch: 1, appOutDir: outDir }),
		).not.toThrow();
	});
});
