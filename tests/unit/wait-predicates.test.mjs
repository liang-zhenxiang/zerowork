/**
 * `tools/check-wait-predicates.mjs` 的单元测试（issue #150）。
 *
 * **门禁自己也要有门禁**：一个「永远说没问题」的检查比没有检查更坏 —— 它会让下一个
 * 假等待合法地溜过去，而且没人会再去看它。所以这个判定器的两个方向都要钉住：
 *
 *   ① 真阳性：谓词**每一条**返回路径都是常量真值 → 必须报（这是 Issue 点名的形态）
 *   ② 不误报：就绪才交出对象、外层包成布尔、比较、具名 helper … 一处都不能报 ——
 *      误报会逼着人发明「抑制注释」，那条路一旦开了，门禁就开始腐烂
 *
 * 判定器的取舍写在它的头注释里：**判不出来的一律不报**（列成「需人工确认」），
 * 所以这里的「不报」用例同时也是「它不假装自己什么都知道」的边界记录。
 */
import { describe, expect, it } from 'vitest';
import { analyze } from '../../tools/check-wait-predicates.mjs';

/** 只关心「有没有被判成假等待」的断言糖。 */
const fakeCount = (source) => analyze(source).fake.length;

describe('analyze —— 真阳性：每一条返回路径都是常量真值', () => {
	it('gui-space-pin 的原始形态：未就绪时返回 { found: false }（对象恒真）', () => {
		// 这正是被修掉的那一处，原样抄进来当回归样本
		const source = `
			const r = await waitUntil(
				async () =>
					await win.evaluate(() => {
						const headers = [...document.querySelectorAll(".space-group-header")];
						if (headers.length < 2) return { found: false, count: headers.length };
						return { found: true };
					}),
				{ timeout: 30_000, desc: "空间区出现两组" },
			);
		`;
		expect(fakeCount(source)).toBe(1);
	});

	it('最赤裸的形态：谓词就是 () => true', () => {
		expect(fakeCount('await waitUntil(() => true, { desc: "x" });')).toBe(1);
	});

	it('两个分支都是对象字面量（条件表达式也救不了）', () => {
		const source = `
			await waitUntil(() => (document.body ? { ok: true } : { ok: false }), { desc: "x" });
		`;
		expect(fakeCount(source)).toBe(1);
	});

	it('每条路径都返回非空字符串 / 非零数字', () => {
		expect(fakeCount('await waitUntil(() => "就绪", { desc: "x" });')).toBe(1);
		expect(fakeCount('await waitUntil(() => 1, { desc: "x" });')).toBe(1);
	});

	it('evaluate 回调里每个分支都是对象（钻进回调才看得见）', () => {
		const source = `
			await waitUntil(() => win.evaluate(() => {
				if (document.body === null) return { state: "loading" };
				return { state: "ready" };
			}), { desc: "x" });
		`;
		expect(fakeCount(source)).toBe(1);
	});
});

describe('analyze —— 不误报：已知的好写法一处都不能报', () => {
	it('就绪才交出对象，否则返回 null（Issue 里给的「✓」写法）', () => {
		const source = `
			const r = await waitUntil(async () => {
				const s = await win.evaluate(() => ({ ok: document.body !== null }));
				return s.ok ? s : null;
			}, { desc: "x" });
		`;
		expect(fakeCount(source)).toBe(0);
	});

	it('谓词直接返回布尔比较', () => {
		expect(fakeCount('await waitUntil(() => win.evaluate(() => el !== null), { desc: "x" });')).toBe(
			0,
		);
		expect(fakeCount('await waitUntil(() => mock.requests.length >= 2, { desc: "x" });')).toBe(0);
		expect(fakeCount('await waitUntil(() => existsSync(out), { desc: "x" });')).toBe(0);
	});

	it('返回成员访问 / 变量：判不出常量真值，就不报', () => {
		expect(fakeCount('await waitUntil(async () => (await readState()).found, { desc: "x" });')).toBe(
			0,
		);
		expect(fakeCount('await waitUntil(() => document.querySelector(".x")?.value, { desc: "x" });')).toBe(
			0,
		);
	});

	it('一部分路径可能为假，就不算假等待（哪怕另一部分是对象）', () => {
		const source = `
			await waitUntil(async () => {
				const s = await win.evaluate(() => ({ ok: document.body !== null }));
				return s.ok ? s : undefined;
			}, { desc: "x" });
		`;
		expect(fakeCount(source)).toBe(0);
	});

	it('嵌套函数里的 return 不算谓词的返回路径', () => {
		const source = `
			await waitUntil(() => {
				const inner = () => ({ a: 1 });
				return inner().a === 2;
			}, { desc: "x" });
		`;
		expect(fakeCount(source)).toBe(0);
	});

	it('谓词是具名 helper：解析到顶层定义后按它的返回路径判定', () => {
		const good = `
			const paletteOpen = () => win.evaluate(() => document.querySelector(".p") !== null);
			await waitUntil(paletteOpen, { desc: "x" });
		`;
		expect(fakeCount(good)).toBe(0);

		// 同一个 helper 形态，但它是恒真的 —— 一样要报（说明解析真的生效了，
		// 不是靠「解析不到就放过」蒙混过关）
		const bad = `
			const alwaysReady = () => ({ ok: true });
			await waitUntil(alwaysReady, { desc: "x" });
		`;
		expect(fakeCount(bad)).toBe(1);
	});
});

describe('analyze —— 判不出来的如实说「判不了」，不猜', () => {
	it('谓词是找不到定义的标识符 → unknown，且**不**报成假等待', () => {
		const result = analyze('await waitUntil(someImportedHelper, { desc: "x" });');
		expect(result.fake).toEqual([]);
		expect(result.unknown).toHaveLength(1);
		expect(result.unknown[0].reason).toContain('someImportedHelper');
	});

	it('谓词没有任何 return → unknown（不报假等待，也不假装通过）', () => {
		const result = analyze('await waitUntil(async () => { await doSomething(); }, { desc: "x" });');
		expect(result.fake).toEqual([]);
		expect(result.unknown).toHaveLength(1);
	});

	it('统计口径：调用点数、真阳性数、未知数各自分开', () => {
		const source = `
			await waitUntil(() => true, { desc: "fake" });
			await waitUntil(() => el !== null, { desc: "ok" });
			await waitUntil(mystery, { desc: "unknown" });
		`;
		const result = analyze(source);
		expect(result.sites).toBe(3);
		expect(result.fake).toHaveLength(1);
		expect(result.unknown).toHaveLength(1);
	});
});
