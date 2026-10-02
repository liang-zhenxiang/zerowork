/**
 * 命令面板纯逻辑内核（command-palette-core.js）的单元测试。
 *
 * 守的是「排序优先级链」—— 它是这个功能的全部技术含量，而在界面上只表现为
 * 「顺序有点怪」：顺序错了不报错、不异常、没有任何可断言的失败信号，
 * GUI 测试几乎抓不住。所以把它从组件里拿进这个毫秒级文件里钉死。
 *
 * 覆盖三块：
 *   1. matchRank 的五个等级（0 精确 / 1 前缀 / 2 子串 / 3 子序列 / 4 副标题或关键词）
 *      与 null（不匹配、空查询）；
 *   2. rankEntries 的三级排序键（匹配质量 → 类别权重 → 原数组索引）；
 *   3. 空查询保序不截断、limit 截断但 total 是截断前总数、实体数据未就绪不抛错。
 *
 * ## 反向验证记录（2026-10-03）
 *
 * 按设计（design.md §3）临时把三级排序键砍成两级，跑本文件，记录结果：
 *
 *   · 砍掉**第三级「原数组索引」**（comparator 变成 `a.rank - b.rank || a.weight - b.weight`）：
 *     **没有用例变红**。原因是 V8 的 Array.prototype.sort 自 Node 11 起就是稳定排序，
 *     两键相等时它保留输入顺序，而「输入顺序」正是索引升序所表达的次序 ——
 *     两者在 Node 上**行为等价**。这一级因此**不是**靠某条用例的红色来守的，
 *     而是靠「换一个非稳定引擎也成立」的健壮性。等价性本身是实测结论，不是推断。
 *   · 为证明这些用例不是空壳，另做一次反向验证：砍掉**第二级「类别权重」**
 *     （comparator 变成 `a.rank - b.rank`）→
 *     「第二级：同分时动作优先于实体」「三级合力」两条用例变红，
 *     说明排序链的断言确实与被测实现绑定。
 */

import { describe, expect, it } from "vitest";
import { KIND_WEIGHT, matchRank, rankEntries } from "../../src/renderer/src/command-palette-core.js";

/** 构造条目；不传的字段走默认（kind 默认 action，方便只看 title 的用例）。 */
function e(over = {}) {
	return { id: over.id ?? over.title ?? "", kind: "action", title: "", ...over };
}

describe("matchRank —— 五个匹配等级", () => {
	it("等级 0：标题与查询完全相等", () => {
		expect(matchRank("打开设置", e({ title: "打开设置" }))).toBe(0);
		expect(matchRank("settings", e({ title: "settings" }))).toBe(0);
	});

	it("大小写不敏感（英文），且恰好等于是 0 不是 1", () => {
		expect(matchRank("SETTINGS", e({ title: "Settings" }))).toBe(0);
		expect(matchRank("set", e({ title: "settings" }))).toBe(1);
	});

	it("去首尾空白后比较：查询与标题两侧的空白都不影响判定", () => {
		expect(matchRank("  设置  ", e({ title: " 设置 " }))).toBe(0);
		expect(matchRank("设置", e({ title: " 设置" }))).toBe(0);
	});

	it("等级 1：标题以查询开头（恰好前缀是 1 不是 2）", () => {
		expect(matchRank("打开", e({ title: "打开设置" }))).toBe(1);
		expect(matchRank("Set", e({ title: "Settings" }))).toBe(1);
	});

	it("等级 2：标题包含查询（子串，含中文）", () => {
		expect(matchRank("设置", e({ title: "打开设置" }))).toBe(2);
		expect(matchRank("ting", e({ title: "settings" }))).toBe(2);
	});

	it("等级 3：查询字符按序出现在标题中（英文模糊，可跨词）", () => {
		expect(matchRank("scf", e({ title: "save current file" }))).toBe(3);
		expect(matchRank("stg", e({ title: "settings" }))).toBe(3);
	});

	it("等级 4：副标题命中（标题里没有这个词）", () => {
		expect(matchRank("深色", e({ title: "切换外观", subtitle: "深色 / 浅色 / 跟随系统" }))).toBe(4);
	});

	it("等级 4：关键词命中 —— prd R3 的原例（『深色』→『切换外观』）", () => {
		expect(matchRank("深色", e({ title: "切换外观", keywords: ["浅色", "深色", "跟随系统"] }))).toBe(4);
	});

	it("等级 4：关键词恰好等于查询也仍是 4（关键词命中一律降到 4）", () => {
		expect(matchRank("dark", e({ title: "切换外观", keywords: ["dark"] }))).toBe(4);
	});

	it("标题命中优先于副标题/关键词（同在标题里就不降到 4）", () => {
		expect(matchRank("深色", e({ title: "深色", keywords: ["深色"] }))).toBe(0);
	});

	it("关键词是纯空白串时不误命中", () => {
		expect(matchRank("深色", e({ title: "切换外观", keywords: ["", "  "] }))).toBe(null);
	});
});

describe("matchRank —— 不匹配与空查询", () => {
	it("都不命中返回 null", () => {
		expect(matchRank("xyz", e({ title: "打开设置" }))).toBe(null);
	});

	it("子序列要求字符按序：乱序不命中", () => {
		expect(matchRank("置设", e({ title: "设置" }))).toBe(null);
	});

	it("查询比标题长、且非子序列时不命中", () => {
		expect(matchRank("设置面板", e({ title: "设置" }))).toBe(null);
	});

	it("空 / 纯空白查询返回 null（显示什么由调用方决定，core 不做产品判断）", () => {
		expect(matchRank("", e({ title: "打开设置" }))).toBe(null);
		expect(matchRank("   ", e({ title: "打开设置" }))).toBe(null);
	});

	it("标题缺失（undefined）不抛错，只是不命中", () => {
		expect(matchRank("设置", { id: "x", kind: "action" })).toBe(null);
	});
});

describe("KIND_WEIGHT —— 类别权重契约", () => {
	it("八个类别齐全，且权重严格递增（动作 < 设置 < 会话 < … < 自动化）", () => {
		expect(KIND_WEIGHT).toEqual({
			action: 0,
			settings: 1,
			session: 2,
			workspace: 3,
			expert: 4,
			skill: 5,
			connector: 6,
			automation: 7,
		});
	});
});

describe("rankEntries —— 空查询", () => {
	it("空查询原样返回，保持调用方给定的顺序", () => {
		const list = [e({ id: "a", title: "A" }), e({ id: "b", title: "B" }), e({ id: "c", title: "C" })];
		const { items, total } = rankEntries(list, "");
		expect(items.map((x) => x.id)).toEqual(["a", "b", "c"]);
		expect(total).toBe(3);
	});

	it("纯空白查询等同空查询", () => {
		const list = [e({ id: "a", title: "A" }), e({ id: "b", title: "B" })];
		expect(rankEntries(list, "   ").items.map((x) => x.id)).toEqual(["a", "b"]);
	});

	it("空查询不按 limit 截断（展示什么由调用方编排）", () => {
		const list = Array.from({ length: 60 }, (_, i) => e({ id: `i${i}`, title: `T${i}` }));
		const { items, total } = rankEntries(list, "", { limit: 10 });
		expect(items.length).toBe(60);
		expect(total).toBe(60);
	});
});

describe("rankEntries —— 三级排序键", () => {
	it("第一级：匹配质量优先于类别权重（精确命中的实体排在子串命中的动作之前）", () => {
		// 自动化类权重最大（7），但「设置」对它精确命中；动作类权重最小（0），
		// 却只是子串命中。第一级是匹配质量，所以自动化那条约先。
		const action = e({ id: "act", kind: "action", title: "打开设置面板" });
		const automation = e({ id: "auto", kind: "automation", title: "设置" });
		const { items } = rankEntries([action, automation], "设置");
		expect(items.map((x) => x.id)).toEqual(["auto", "act"]);
	});

	it("第二级：同分时动作优先于实体，与数组顺序无关", () => {
		// 两条同 rank（「新」都是前缀命中）。数组里自动化在前，但权重决定动作先出。
		const automationFirst = e({ id: "auto", kind: "automation", title: "新建任务" });
		const actionSecond = e({ id: "act", kind: "action", title: "新建任务" });
		const { items } = rankEntries([automationFirst, actionSecond], "新");
		expect(items.map((x) => x.id)).toEqual(["act", "auto"]);
	});

	it("第三级：同分同类时保持原数组顺序（稳定性）", () => {
		// 两条完全同分（同 title、同 kind）。数组里 b 在前，结果里 b 也必须在前。
		const first = e({ id: "b", kind: "action", title: "新建任务" });
		const second = e({ id: "a", kind: "action", title: "新建任务" });
		const { items } = rankEntries([first, second], "新");
		expect(items.map((x) => x.id)).toEqual(["b", "a"]);
	});

	it("三级合力：先按匹配质量、再按类别、最后按原序", () => {
		const list = [
			e({ id: "s1", kind: "session", title: "设置" }), // 精确 0，session 权重 2
			e({ id: "a1", kind: "action", title: "打开设置" }), // 子串 2，action 权重 0
			e({ id: "a2", kind: "action", title: "设置面板" }), // 前缀 1，action 权重 0
			e({ id: "s2", kind: "session", title: "设置" }), // 精确 0，session 权重 2
			e({ id: "a3", kind: "action", title: "设置" }), // 精确 0，action 权重 0
		];
		const { items } = rankEntries(list, "设置");
		// rank0 里：a3（权重 0）先于 s1、s2（权重 2）；s1 与 s2 同类同分 → 原序 s1 先。
		// 再是 rank1 的 a2，最后 rank2 的 a1。
		expect(items.map((x) => x.id)).toEqual(["a3", "s1", "s2", "a2", "a1"]);
	});
});

describe("rankEntries —— 过滤与截断", () => {
	it("不匹配的条目被过滤掉", () => {
		const list = [e({ id: "a", title: "打开设置" }), e({ id: "b", title: "完全不搭" })];
		const { items, total } = rankEntries(list, "设置");
		expect(items.map((x) => x.id)).toEqual(["a"]);
		expect(total).toBe(1);
	});

	it("limit 截断 items，但 total 是截断前的命中总数", () => {
		const list = Array.from({ length: 5 }, (_, i) => e({ id: `x${i}`, title: "新建任务" }));
		const { items, total } = rankEntries(list, "新", { limit: 2 });
		expect(items.length).toBe(2);
		expect(total).toBe(5);
	});

	it("默认 limit 是 50", () => {
		const list = Array.from({ length: 80 }, (_, i) => e({ id: `x${i}`, title: "新建任务" }));
		const { items, total } = rankEntries(list, "新");
		expect(items.length).toBe(50);
		expect(total).toBe(80);
	});

	it("全部不匹配 → items 为空、total 为 0", () => {
		const list = [e({ title: "abc" }), e({ title: "def" })];
		const { items, total } = rankEntries(list, "xyz");
		expect(items).toEqual([]);
		expect(total).toBe(0);
	});
});

describe("rankEntries —— 关键词命中参与排序", () => {
	it("搜标题里没有的词也能命中（prd R3 的验收点）", () => {
		const list = [e({ id: "theme", kind: "action", title: "切换外观", keywords: ["深色", "浅色"] })];
		const { items, total } = rankEntries(list, "深色");
		expect(items.map((x) => x.id)).toEqual(["theme"]);
		expect(total).toBe(1);
	});
});

describe("rankEntries —— 实体数据未就绪时不抛错", () => {
	it("entries 为 undefined / null 时按空处理", () => {
		expect(rankEntries(undefined, "设置")).toEqual({ items: [], total: 0 });
		expect(rankEntries(null, "设置")).toEqual({ items: [], total: 0 });
		expect(rankEntries(undefined, "")).toEqual({ items: [], total: 0 });
	});
});
