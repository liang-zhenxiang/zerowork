/**
 * 提示词模板的纯逻辑。
 *
 * 盯的是三类「界面看不出来、但真会出事」的行为：
 *   1. 写侧严格 / 读侧宽容的不对称 —— 写进去的东西一定能原样读回来；
 *   2. 上限与去重 —— 否则 preferences.json 会被一坨脏数据撑坏；
 *   3. id 生成不撞 —— 撞了会被去重丢掉，界面上表现为「点了新增没反应」。
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	STARTER_COUNT_MAX,
	STARTER_PROMPT_MAX,
	STARTER_TITLE_MAX,
	assertStarters,
	createStarterId,
	normalizeStarter,
	normalizeStarters
} from "../../src/shared/starter-prompts.js";

const tpl = (over = {}) => ({ id: "tpl-aaaa1", title: "写周报", prompt: "按上周的结构写周报", ...over });

describe("normalizeStarter", () => {
	it("接受合法模板，并顺手裁掉首尾空白", () => {
		const r = normalizeStarter({ id: "tpl-aaaa1", title: "  写周报  ", prompt: "\n按上周的结构写周报\n" });
		assert.equal(r.ok, true);
		assert.deepEqual(r.value, { id: "tpl-aaaa1", title: "写周报", prompt: "按上周的结构写周报" });
	});

	it("拒绝空标题、空提示词、超长、坏 id、非对象", () => {
		const cases = [
			[tpl({ id: "  " }), /id/i],
			[tpl({ title: "   " }), /标题不能为空/],
			[tpl({ title: "x".repeat(STARTER_TITLE_MAX + 1) }), /标题最多/],
			[tpl({ prompt: "" }), /提示词不能为空/],
			[tpl({ prompt: "x".repeat(STARTER_PROMPT_MAX + 1) }), /提示词最多/],
			[null, /对象/],
			[["tpl-aaaa1"], /对象/]
		];
		for (const [raw, pattern] of cases) {
			const r = normalizeStarter(raw);
			assert.equal(r.ok, false, `应当拒绝：${JSON.stringify(raw)}`);
			assert.match(r.reason, pattern);
		}
	});

	it("id 形状卡死：没有前缀、含大写、带连字符都拒", () => {
		for (const id of ["aaaa1", "tpl-AAAA1", "tpl-aa-1", "tpl-a"]) {
			assert.equal(normalizeStarter(tpl({ id })).ok, false, id);
		}
	});
});

describe("normalizeStarters（读侧宽容）", () => {
	it("丢掉坏条目，保留好条目 —— 不让一条脏数据毁掉整份列表", () => {
		const list = normalizeStarters([
			tpl({ id: "tpl-aaaa1" }),
			// @ts-expect-error 故意塞脏数据
			{ id: "bad", title: "没有合法 id", prompt: "x" },
			tpl({ id: "tpl-bbbb2", title: "整理会议纪要" })
		]);
		assert.deepEqual(
			list.map((t) => t.id),
			["tpl-aaaa1", "tpl-bbbb2"]
		);
	});

	it("按 id 去重，保留先出现的", () => {
		const list = normalizeStarters([tpl({ id: "tpl-aaaa1", title: "第一条" }), tpl({ id: "tpl-aaaa1", title: "重复的" })]);
		assert.equal(list.length, 1);
		assert.equal(list[0].title, "第一条");
	});

	it("按上限截断，而不是抛错", () => {
		const many = Array.from({ length: STARTER_COUNT_MAX + 5 }, (_, i) => tpl({ id: `tpl-${String(i).padStart(4, "0")}` }));
		assert.equal(normalizeStarters(many).length, STARTER_COUNT_MAX);
	});

	it("非数组一律当空列表（旧版本可能没这个字段）", () => {
		for (const raw of [undefined, null, {}, "tpl-x", 42]) {
			assert.deepEqual(normalizeStarters(raw), []);
		}
	});
});

describe("assertStarters（写侧严格）", () => {
	it("合法列表原样返回（已归一）", () => {
		const out = assertStarters([tpl({ title: " 写周报 " })]);
		assert.deepEqual(out, [{ id: "tpl-aaaa1", title: "写周报", prompt: "按上周的结构写周报" }]);
	});

	it("任何一条不合法都抛，且错误信息能直接显示给用户", () => {
		assert.throws(() => assertStarters([tpl({ title: "" })]), /标题不能为空/);
		assert.throws(() => assertStarters([tpl({ id: "bad" })]), /不合法/);
	});

	it("超过上限要抛，不是静默截断 —— 写侧不能假装成功", () => {
		const many = Array.from({ length: STARTER_COUNT_MAX + 1 }, (_, i) => tpl({ id: `tpl-${String(i).padStart(4, "0")}` }));
		assert.throws(() => assertStarters(many), /最多保存/);
	});

	it("重复 id 要抛 —— 去重是读侧的宽容，不是写侧的许可", () => {
		assert.throws(() => assertStarters([tpl({ id: "tpl-aaaa1" }), tpl({ id: "tpl-aaaa1" })]), /重复/);
	});

	it("非数组要抛", () => {
		assert.throws(() => assertStarters(undefined), /必须是数组/);
	});
});

describe("createStarterId", () => {
	it("形状合法、可被 normalizeStarter 接受", () => {
		const id = createStarterId(1761400000000, () => 0.42);
		assert.match(id, /^tpl-[a-z0-9]{4,32}$/);
		assert.equal(normalizeStarter({ id, title: "t", prompt: "p" }).ok, true);
	});

	it("同一毫秒内连发也不会撞（随机尾数在起作用）", () => {
		const now = 1761400000000;
		const a = createStarterId(now, () => 0.1);
		const b = createStarterId(now, () => 0.9);
		assert.notEqual(a, b);
	});
});
