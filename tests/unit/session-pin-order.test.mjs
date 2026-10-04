/**
 * 会话置顶的纯逻辑单测（`src/renderer/src/session-pin.js`）。
 *
 * 这两条判断在界面上只表现为「顺序对不对」「某一行在不在」，正是 GUI 断言
 * 最难说清、纯函数最容易钉死的一类（与 command-palette-core 抽出来的理由同源）。
 *
 * 覆盖：
 *   · 置顶优先 —— 且置顶区**内部**仍是「最近活动在前」（不按置顶时刻排）
 *   · 缺省 / 非布尔 `pinned` 一律当未置顶（不认识这个字段就把行顶到最前是 bug）
 *   · 稳定排序 —— `modifiedAt` 相同保持 daemon 给的顺序（否则每次刷新侧栏会抖）
 *   · 不改入参（调用方还拿着同一份 taskList）
 *   · 折叠窗口 —— **置顶项不参与那 5 个名额的竞争**（"钉住了却看不见"的失效形态）
 *
 * ── 反向验证（已真跑并还原，见 design.md「反向验证」）──────────────────
 * 把 `compareSessionsByPin` 里的置顶比较键去掉（只留 `modifiedAt`），实测输出：
 *
 *   × 置顶的排在最前，其余保持最近活动在前
 *   × 比较器可直接用于既有 sort 调用点：置顶在前，其次时间倒序
 *   Tests  2 failed | 17 passed (19)
 *
 * 恰好是「置顶优先」那两条；**折叠窗口那一组不受影响** —— 它自己按 `pinned`
 * 分桶再拼窗口，本来就**不依赖比较器**（这正是它能在比较器坏掉时仍然成立的原因，
 * 也是两条判据分开测的价值：它们防的是不同的失效形态）。
 */

import { describe, expect, it } from "vitest";
import {
	compareSessionsByPin,
	isPinned,
	sortSessionsByPin,
	taskListWindow,
} from "../../src/renderer/src/session-pin.js";

/** 造会话：只带排序用到的字段。 */
function session(title, modifiedAt, extra = {}) {
	return { title, modifiedAt, ...extra };
}

describe("isPinned —— 缺省与脏值一律按未置顶", () => {
	it("只有严格的 true 算置顶", () => {
		expect(isPinned({ pinned: true })).toBe(true);
		for (const value of [undefined, false, 1, "true", null]) {
			expect(isPinned({ pinned: value }), `pinned=${String(value)} 不应算置顶`).toBe(false);
		}
	});
});

describe("sortSessionsByPin —— 置顶优先 + 最近活动在前", () => {
	it("置顶的排在最前，其余保持最近活动在前", () => {
		const list = [
			session("新", 300),
			session("旧", 100),
			session("钉住的老会话", 50, { pinned: true }),
			session("中", 200),
		];
		expect(sortSessionsByPin(list).map((s) => s.title)).toEqual([
			"钉住的老会话",
			"新",
			"中",
			"旧",
		]);
	});

	it("置顶区内部仍按最近活动排（不按置顶时刻，置顶时刻根本没进排序）", () => {
		const list = [
			session("a", 100, { pinned: true, pinnedAt: 999 }),
			session("b", 200, { pinned: true, pinnedAt: 1 }),
		];
		expect(sortSessionsByPin(list).map((s) => s.title)).toEqual(["b", "a"]);
	});

	it("稳定：modifiedAt 相同则保持 daemon 给的顺序", () => {
		const list = [session("先出来的", 100), session("后出来的", 100), session("最后的", 100)];
		expect(sortSessionsByPin(list).map((s) => s.title)).toEqual(["先出来的", "后出来的", "最后的"]);
	});

	it("不改入参（调用方还拿着同一份 taskList）", () => {
		const list = [session("新", 300), session("旧", 100, { pinned: true })];
		const before = list.map((s) => s.title);
		sortSessionsByPin(list).reverse();
		expect(list.map((s) => s.title)).toEqual(before);
	});

	it("比较器可直接用于既有 sort 调用点：置顶在前，其次时间倒序", () => {
		const list = [session("新", 300), session("钉", 100, { pinned: true })];
		expect([...list].sort(compareSessionsByPin).map((s) => s.title)).toEqual(["钉", "新"]);
	});
});

describe("taskListWindow —— 折叠窗口不让置顶项被截断", () => {
	it("默认 5 行：窗口内按置顶优先排序，多的进 hiddenCount", () => {
		const list = [1, 2, 3, 4, 5, 6, 7].map((n) => session(`第 ${n} 条`, 1000 - n));
		const { visible, hiddenCount } = taskListWindow(list, 5);
		expect(visible.map((s) => s.title)).toEqual(["第 1 条", "第 2 条", "第 3 条", "第 4 条", "第 5 条"]);
		expect(hiddenCount).toBe(2);
	});

	it("置顶项不参与那 5 个名额：第 7 条被置顶后依然在窗口内", () => {
		const list = [1, 2, 3, 4, 5, 6, 7].map((n) => session(`第 ${n} 条`, 1000 - n));
		list[6] = { ...list[6], pinned: true };
		const { visible, hiddenCount } = taskListWindow(list, 5);
		expect(visible[0].title).toBe("第 7 条");
		// 置顶占位 + 前 4 条非置顶 = 5 行；被挤掉的正是「第 5 条」（它本来就在窗口末尾）。
		expect(visible.map((s) => s.title)).toEqual(["第 7 条", "第 1 条", "第 2 条", "第 3 条", "第 4 条"]);
		expect(hiddenCount).toBe(2);
	});

	it("置顶多于 limit 时窗口变长（宁可多显示，也不把钉住的行藏起来）", () => {
		const list = [1, 2, 3, 4, 5, 6, 7].map((n) => session(`第 ${n} 条`, 1000 - n, { pinned: true }));
		const { visible, hiddenCount } = taskListWindow(list, 5);
		expect(visible).toHaveLength(7);
		expect(hiddenCount).toBe(0);
	});

	it("不足 limit / 空列表 / 全未置顶都不越界", () => {
		expect(taskListWindow([], 5)).toEqual({ visible: [], hiddenCount: 0 });
		const three = [1, 2, 3].map((n) => session(`第 ${n} 条`, 1000 - n));
		expect(taskListWindow(three, 5).visible).toHaveLength(3);
		expect(taskListWindow(three, 5).hiddenCount).toBe(0);
	});
});
