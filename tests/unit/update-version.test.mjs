/**
 * beta 版本计算的单元测试（scripts/next-beta-version.mjs 的纯函数）。
 *
 * 守的三件事：
 *   1. 主线递进：稳定 0.3.0 → beta 落在 0.4.0 线（patch 归零，minor+1）；
 *   2. 序号幂等：数已有 v0.4.0-beta.* 的数量 +1——重跑同一批 release
 *      得到同一个号，不随时间漂；
 *   3. [Unreleased] 判空不看注释与空白——只有空壳时 beta workflow 要能
 *      靠它决定「这次不发」。
 */
import { describe, expect, it } from 'vitest';
import { computeNextBeta, unreleasedHasContent } from '../../scripts/next-beta-version.mjs';

describe('computeNextBeta —— 主线与序号', () => {
	it('稳定 0.3.0 的第一个 beta 是 0.4.0-beta.1', () => {
		expect(computeNextBeta('0.3.0', ['v0.3.0', 'v0.2.1'])).toBe('0.4.0-beta.1');
	});

	it('已有同线 beta 时序号 +1', () => {
		expect(computeNextBeta('0.3.0', ['v0.3.0', 'v0.4.0-beta.1', 'v0.4.0-beta.2'])).toBe('0.4.0-beta.3');
	});

	it('别的线的 prerelease 不干扰计数（v1.0.0-beta.9 不算 0.4.0 线）', () => {
		expect(computeNextBeta('0.3.0', ['v1.0.0-beta.9'])).toBe('0.4.0-beta.1');
	});

	it('两位数 minor 与两位数序号都正常', () => {
		expect(computeNextBeta('1.9.3', [])).toBe('1.10.0-beta.1');
		// 序号要数的是**同一条线**（v1.10.0-beta.*），别的线不掺和
		const ten = Array.from({ length: 10 }, (_, i) => `v1.10.0-beta.${i + 1}`);
		expect(computeNextBeta('1.9.3', ten)).toBe('1.10.0-beta.11');
	});

	it('version 不是语义化版本时抛可诊断的错', () => {
		expect(() => computeNextBeta('latest', [])).toThrow(/不是语义化版本/);
	});
});

describe('unreleasedHasContent —— 判空不看注释与空白', () => {
	it('有实际条目 → true', () => {
		const text = '## [Unreleased]\n\n### 新增\n\n- 深色主题\n\n## [0.3.0] - 2026-10-01\n';
		expect(unreleasedHasContent(text)).toBe(true);
	});

	it('只有注释与空白（空壳）→ false', () => {
		const text = '## [Unreleased]\n<!--\n下一段写在这里。\n-->\n\n## [0.3.0] - 2026-10-01\n';
		expect(unreleasedHasContent(text)).toBe(false);
	});

	it('[Unreleased] 是最后一段时（无后续 ##）也能判', () => {
		const text = '# 变更日志\n\n## [Unreleased]\n\n- 一条\n';
		expect(unreleasedHasContent(text)).toBe(true);
	});

	it('没有 [Unreleased] 段 → false（异常形态，不发）', () => {
		expect(unreleasedHasContent('# 变更日志\n')).toBe(false);
	});
});
