/**
 * `scripts/check-unicode.mjs` 的单元测试。
 *
 * 门禁本身很短，但它守着的东西**不可逆**（替换字符写进去，原文就没了），
 * 所以三个纯函数各自要钉住：
 *   1. 定位：行号从 1 起、一行多个 U+FFFD 只报一次（报告是给人整行重写用的）
 *   2. 豁免：三个合法字面量文件恒豁免；`resources/**` 默认豁免、`--all` 时不豁免
 *   3. 二进制：含 NUL 的前 8000 字节判为二进制（与 git grep -I 同口径）
 */
import { describe, expect, it } from 'vitest';
import {
	ALLOWED_FILES,
	findReplacements,
	isExempt,
	looksBinary,
	REPLACEMENT,
} from '../../scripts/check-unicode.mjs';

describe('findReplacements —— 逐行定位', () => {
	it('干净文本返回空数组', () => {
		expect(findReplacements('第一行\n第二行\n')).toEqual([]);
	});

	it('空文本返回空数组', () => {
		expect(findReplacements('')).toEqual([]);
	});

	it('行号从 1 起，且带回该行原文', () => {
		const text = ['没问题', `坏了一处：${REPLACEMENT}`, '也没问题'].join('\n');
		const hits = findReplacements(text);
		expect(hits).toHaveLength(1);
		expect(hits[0].line).toBe(2);
		expect(hits[0].text).toBe(`坏了一处：${REPLACEMENT}`);
	});

	it('一行里连续多个 U+FFFD 只报一条 —— 修法是整行重写，不是逐字符替换', () => {
		// 这正是 AGENTS.md 记过的坑：一行里可能有连续多个，replace 会整段替换成
		// 完整文本、产出重复串。所以报告以「行」为单位，不逐字符计数。
		const text = `互为${REPLACEMENT}${REPLACEMENT}线索`;
		expect(findReplacements(text)).toHaveLength(1);
	});

	it('多行各自命中时逐行报出', () => {
		const text = [`a${REPLACEMENT}`, 'b', `c${REPLACEMENT}`].join('\n');
		expect(findReplacements(text).map((h) => h.line)).toEqual([1, 3]);
	});

	it('CRLF 行尾不影响行号', () => {
		const text = `a\r\nb${REPLACEMENT}\r\n`;
		expect(findReplacements(text).map((h) => h.line)).toEqual([2]);
	});
});

describe('isExempt —— 豁免范围', () => {
	it('三个合法字面量文件恒豁免（含 --all）', () => {
		for (const file of ALLOWED_FILES) {
			expect(isExempt(file)).toBe(true);
			expect(isExempt(file, { includeResources: true })).toBe(true);
		}
	});

	it('resources/** 默认豁免 —— 第三方内容不参与本项目工具链（红线 5）', () => {
		expect(isExempt('resources/plugins/x/index.js')).toBe(true);
		expect(isExempt('resources/docx-engine/engine.py')).toBe(true);
	});

	it('--all 时 resources/** 不再豁免（保留人工脚本当年的覆盖能力）', () => {
		expect(isExempt('resources/plugins/x/index.js', { includeResources: true })).toBe(false);
	});

	it('普通源码文件一律不豁免', () => {
		expect(isExempt('src/renderer/src/app.css')).toBe(false);
		expect(isExempt('CHANGELOG.md')).toBe(false);
		expect(isExempt('tests/unit/check-unicode.test.mjs')).toBe(false);
	});

	it('前缀判定不带通配 —— 名字里含 resources 的普通路径不受影响', () => {
		// `resources/` 是带斜杠的前缀，`scripts/resources-report.mjs` 这类同名前缀不会被误豁免
		expect(isExempt('scripts/resources-report.mjs')).toBe(false);
	});
});

describe('looksBinary —— 与 git grep -I 同口径', () => {
	it('纯文本判为否', () => {
		expect(looksBinary(Buffer.from('中文文本\n第二行', 'utf8'))).toBe(false);
	});

	it('含 NUL 判为是', () => {
		expect(looksBinary(Buffer.from([0x41, 0x00, 0x42]))).toBe(true);
	});

	it('只探前 8000 字节 —— 后面才出现的 NUL 不改变判定', () => {
		const buffer = Buffer.concat([Buffer.alloc(8001, 0x41), Buffer.from([0x00])]);
		expect(looksBinary(buffer)).toBe(false);
	});

	it('空缓冲不算二进制', () => {
		expect(looksBinary(Buffer.alloc(0))).toBe(false);
	});
});

describe('REPLACEMENT 常量', () => {
	it('就是 U+FFFD', () => {
		expect(REPLACEMENT).toBe('\uFFFD');
		expect(REPLACEMENT.codePointAt(0)).toBe(0xfffd);
	});
});
