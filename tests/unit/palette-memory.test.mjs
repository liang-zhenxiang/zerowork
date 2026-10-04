/**
 * 命令面板记忆（palette-memory.js）的单元测试。
 *
 * 守三块：
 *   1. **分数**：写入时的衰减（半衰期 7 天）、记录、规模淘汰 —— 界面上只表现为
 *      「顺序有点怪」，GUI 断言几乎抓不住，所以在这里钉死；
 *   2. **收藏**：顺序 = 收藏时间序、上限到顶拒绝（不是静默丢弃）、切换可逆；
 *   3. **空查询排序**：收藏置顶 → 常用分降序 → 原顺序，且**干净记忆下原样返回**
 *      （新功能不给老用户的首屏加噪声）。
 *
 * ## 反向验证记录（2026-10-04）
 *
 * 按设计临时注入缺陷，跑本文件，记录结果：
 *
 *   · 去掉写入时的衰减（`recordUse` 里 decayed = entry.score，不清算旧分）：
 *     「过一个半衰期后旧分减半」与「衰减的是全部条目，不只是被用到的那条」两条变红。
 *   · 把 `FAVORITES_MAX` 的拒绝改成「挤掉最老的一条」：
 *     「收藏到上限后拒绝新增」变红（断言的是 `ok === false` 与 memory 不变）。
 *   复原后全绿。
 */

import { describe, expect, it } from "vitest";
import {
	EMPTY_MEMORY,
	FAVORITES_MAX,
	HALF_LIFE_MS,
	USAGE_MAX,
	decayFactor,
	evict,
	normalizeMemory,
	orderIdle,
	recordUse,
	scoreOf,
	scorerOf,
	toggleFavorite,
} from "../../src/renderer/src/palette-memory.js";

/** 条目；只关心 id 与顺序。 */
const e = (id, over = {}) => ({ id, kind: "action", title: id, ...over });

describe("normalizeMemory —— 降级而不是抛错", () => {
	it("非对象 / null / 数组一律给空记忆", () => {
		for (const bad of [undefined, null, 42, "x", [], true]) {
			expect(normalizeMemory(bad)).toEqual({ favorites: [], usage: {} });
		}
	});

	it("缺字段 / 字段类型不对也给空记忆", () => {
		expect(normalizeMemory({ favorites: "no", usage: 7 })).toEqual({ favorites: [], usage: {} });
	});

	it("收藏里非字符串、空串、重复项被丢弃（不做 String() 猜测）", () => {
		const out = normalizeMemory({ favorites: ["a", 7, "", null, "a", "b"] });
		expect(out.favorites).toEqual(["a", "b"]);
	});

	it("收藏超过上限只保留前 N 条", () => {
		const many = Array.from({ length: FAVORITES_MAX + 5 }, (_, i) => `id-${i}`);
		expect(normalizeMemory({ favorites: many }).favorites).toHaveLength(FAVORITES_MAX);
	});

	it("usage 的非法分数被丢弃（字符串 / NaN / Infinity / 0 / 负数）", () => {
		const out = normalizeMemory({
			usage: {
				ok: { score: 2, lastAt: 100 },
				str: { score: "2", lastAt: 100 },
				nan: { score: Number.NaN, lastAt: 100 },
				inf: { score: Number.POSITIVE_INFINITY, lastAt: 100 },
				zero: { score: 0, lastAt: 100 },
				neg: { score: -1, lastAt: 100 },
				notObject: 5,
			},
		});
		expect(Object.keys(out.usage)).toEqual(["ok"]);
	});

	it("usage 缺 lastAt 时补 0（而不是丢掉这条记录）", () => {
		const out = normalizeMemory({ usage: { a: { score: 1 } } });
		expect(out.usage.a).toEqual({ score: 1, lastAt: 0 });
	});

	it("EMPTY_MEMORY 是冻结的：拿它当默认值不会被就地改坏", () => {
		expect(Object.isFrozen(EMPTY_MEMORY)).toBe(true);
	});
});

describe("decayFactor —— 半衰期", () => {
	it("同一个时刻（elapsed 0）不衰减", () => {
		expect(decayFactor(0)).toBe(1);
	});

	it("负数 / 非数字一律当不衰减（不放大）", () => {
		expect(decayFactor(-1000)).toBe(1);
		expect(decayFactor(Number.NaN)).toBe(1);
		expect(decayFactor(undefined)).toBe(1);
	});

	it("恰好一个半衰期 → 0.5，两个半衰期 → 0.25", () => {
		expect(decayFactor(HALF_LIFE_MS)).toBeCloseTo(0.5, 10);
		expect(decayFactor(2 * HALF_LIFE_MS)).toBeCloseTo(0.25, 10);
	});

	it("半衰期是 7 天（改这个数会让「一周不用就减半」的承诺失效）", () => {
		expect(HALF_LIFE_MS).toBe(7 * 24 * 60 * 60 * 1000);
	});
});

describe("recordUse —— 写入时清算", () => {
	it("第一次使用：分数 1、lastAt 就是给的时刻", () => {
		const out = recordUse(EMPTY_MEMORY, "a", 1000);
		expect(out.usage.a).toEqual({ score: 1, lastAt: 1000 });
	});

	it("紧接着再用一次：+1 而不是从 0 重新开始", () => {
		const once = recordUse(EMPTY_MEMORY, "a", 1000);
		const twice = recordUse(once, "a", 2000);
		// 1 秒的相对半衰期（7 天）微不足道，分数几乎就是 2 —— 但**不是** 1
		expect(twice.usage.a.score).toBeGreaterThan(1.99);
		expect(twice.usage.a.score).toBeLessThanOrEqual(2);
		expect(twice.usage.a.lastAt).toBe(2000);
	});

	it("过一个半衰期后再用：旧分减半再加 1", () => {
		const first = recordUse(EMPTY_MEMORY, "a", 0);
		const later = recordUse(first, "a", HALF_LIFE_MS);
		expect(later.usage.a.score).toBeCloseTo(1.5, 10);
	});

	it("衰减的是**全部**条目，不只是被用到的那一条", () => {
		const a = recordUse(EMPTY_MEMORY, "a", 0);
		const both = recordUse(a, "b", 0);
		expect(both.usage.b.score).toBe(1);
		const later = recordUse(both, "b", HALF_LIFE_MS);
		// a 没被用到，但它也在同一时刻被清算了一次
		expect(later.usage.a.score).toBeCloseTo(0.5, 10);
		// b 的旧分 1 先减半成 0.5，再 +1
		expect(later.usage.b.score).toBeCloseTo(1.5, 10);
	});

	it("不改入参（纯函数）", () => {
		const before = recordUse(EMPTY_MEMORY, "a", 1000);
		const snapshot = JSON.parse(JSON.stringify(before));
		recordUse(before, "a", 2000);
		expect(before).toEqual(snapshot);
	});

	it("不合法 id 不记（也不抛错）", () => {
		expect(recordUse(EMPTY_MEMORY, "", 1000).usage).toEqual({});
		expect(recordUse(EMPTY_MEMORY, undefined, 1000).usage).toEqual({});
	});

	it("坏记忆进来也能记（先规整）", () => {
		const out = recordUse({ favorites: "no", usage: { bad: { score: "x" } } }, "a", 5);
		expect(out.usage).toEqual({ a: { score: 1, lastAt: 5 } });
	});

	it("超过上限时按分数淘汰（不无限增长）", () => {
		let memory = EMPTY_MEMORY;
		for (let i = 0; i < USAGE_MAX + 10; i += 1) memory = recordUse(memory, `id-${i}`, 1000 + i);
		expect(Object.keys(memory.usage)).toHaveLength(USAGE_MAX);
	});
});

describe("toggleFavorite —— 显式、可逆、到顶拒绝", () => {
	it("新增追加到末尾（收藏顺序 = 收藏时间序）", () => {
		const one = toggleFavorite(EMPTY_MEMORY, "a").memory;
		const two = toggleFavorite(one, "b").memory;
		expect(two.favorites).toEqual(["a", "b"]);
	});

	it("再点一次取消，且不影响别的收藏", () => {
		const one = toggleFavorite(EMPTY_MEMORY, "a").memory;
		const two = toggleFavorite(one, "b").memory;
		const back = toggleFavorite(two, "a");
		expect(back.ok).toBe(true);
		expect(back.memory.favorites).toEqual(["b"]);
	});

	it("到上限后拒绝新增：ok=false / reason=limit，且**不挤掉**已有收藏", () => {
		let memory = EMPTY_MEMORY;
		for (let i = 0; i < FAVORITES_MAX; i += 1) memory = toggleFavorite(memory, `id-${i}`).memory;
		const result = toggleFavorite(memory, "one-more");
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("limit");
		expect(result.memory.favorites).toEqual(memory.favorites);
		expect(result.memory.favorites).toHaveLength(FAVORITES_MAX);
	});

	it("已达上限时**取消**一条仍然可以（只有新增受上限约束）", () => {
		let memory = EMPTY_MEMORY;
		for (let i = 0; i < FAVORITES_MAX; i += 1) memory = toggleFavorite(memory, `id-${i}`).memory;
		const result = toggleFavorite(memory, "id-0");
		expect(result.ok).toBe(true);
		expect(result.memory.favorites).toHaveLength(FAVORITES_MAX - 1);
	});

	it("不合法 id：ok=false / reason=missing", () => {
		expect(toggleFavorite(EMPTY_MEMORY, "").reason).toBe("missing");
		expect(toggleFavorite(EMPTY_MEMORY, null).reason).toBe("missing");
	});

	it("不改入参（纯函数）", () => {
		const before = toggleFavorite(EMPTY_MEMORY, "a").memory;
		const snapshot = JSON.parse(JSON.stringify(before));
		toggleFavorite(before, "b");
		expect(before).toEqual(snapshot);
	});
});

describe("scoreOf / scorerOf —— 读取侧是纯查表", () => {
	it("没有记录就是 0（不是 undefined）", () => {
		expect(scoreOf(EMPTY_MEMORY, "nope")).toBe(0);
		expect(scoreOf(undefined, "nope")).toBe(0);
	});

	it("scorerOf 返回的函数对未知 id 给 0，对已知 id 给分数", () => {
		const memory = recordUse(EMPTY_MEMORY, "a", 0);
		const score = scorerOf(memory);
		expect(score(e("a"))).toBeCloseTo(1, 10);
		expect(score(e("b"))).toBe(0);
		expect(score(undefined)).toBe(0);
	});
});

describe("evict —— 规模淘汰", () => {
	it("使用记录超过上限时按分数保留最高的那些", () => {
		const usage = {};
		for (let i = 0; i < USAGE_MAX + 3; i += 1) usage[`id-${i}`] = { score: i + 1, lastAt: i };
		const out = evict({ favorites: [], usage });
		expect(Object.keys(out.usage)).toHaveLength(USAGE_MAX);
		// 最低的三条被淘汰了
		expect(out.usage["id-0"]).toBeUndefined();
		expect(out.usage["id-1"]).toBeUndefined();
		expect(out.usage["id-2"]).toBeUndefined();
		expect(out.usage[`id-${USAGE_MAX + 2}`]).toBeDefined();
	});

	it("没超上限时原样返回（不重排、不丢）", () => {
		const memory = { favorites: ["a"], usage: { a: { score: 1, lastAt: 0 } } };
		expect(evict(memory)).toEqual(memory);
	});
});

describe("orderIdle —— 空查询的排序", () => {
	const entries = [e("a"), e("b", { kind: "session" }), e("c"), e("d", { kind: "settings" })];

	it("干净记忆：原样返回（新功能不给老用户的首屏加噪声）", () => {
		expect(orderIdle(entries, EMPTY_MEMORY).map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
	});

	it("收藏置顶，且按收藏顺序（不是按原数组顺序）", () => {
		const memory = { favorites: ["c", "a"], usage: {} };
		expect(orderIdle(entries, memory).map((x) => x.id)).toEqual(["c", "a", "b", "d"]);
	});

	it("收藏跨类别也置顶（不会被 kind 压下去）", () => {
		const memory = { favorites: ["d"], usage: {} };
		expect(orderIdle(entries, memory).map((x) => x.id)[0]).toBe("d");
	});

	it("非收藏按常用分降序", () => {
		const memory = { favorites: [], usage: { c: { score: 3, lastAt: 0 }, b: { score: 1, lastAt: 0 } } };
		expect(orderIdle(entries, memory).map((x) => x.id)).toEqual(["c", "b", "a", "d"]);
	});

	it("同分保持原顺序（稳定）", () => {
		const memory = {
			favorites: [],
			usage: { a: { score: 2, lastAt: 0 }, d: { score: 2, lastAt: 0 } },
		};
		expect(orderIdle(entries, memory).map((x) => x.id)).toEqual(["a", "d", "b", "c"]);
	});

	it("收藏排在常用分之前（收藏是用户显式的选择，热度不能盖过它）", () => {
		const memory = { favorites: ["d"], usage: { a: { score: 99, lastAt: 0 } } };
		expect(orderIdle(entries, memory).map((x) => x.id)).toEqual(["d", "a", "b", "c"]);
	});

	it("不改入参，且非数组输入不抛错", () => {
		const snapshot = entries.map((x) => x.id);
		orderIdle(entries, { favorites: ["c"], usage: {} });
		expect(entries.map((x) => x.id)).toEqual(snapshot);
		expect(orderIdle(undefined, EMPTY_MEMORY)).toEqual([]);
	});

	it("悬空收藏 id（数据里没有这个条目）不产生幽灵行", () => {
		const memory = { favorites: ["ghost"], usage: {} };
		expect(orderIdle(entries, memory).map((x) => x.id)).toEqual(["a", "b", "c", "d"]);
	});
});
