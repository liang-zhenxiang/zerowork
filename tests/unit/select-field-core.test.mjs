/**
 * 自绘下拉（`SelectField`）纯逻辑（src/renderer/src/select-field-core.js）的单元测试。
 *
 * 守的是「界面上只表现为方向键跳错一格 / 读屏多念一遍当前值」的那几块：
 *   1. 打开时高亮落在**当前选中项**，没有选中则回到首项；空列表不越界；
 *   2. 移动在两端循环（首项向上回末项、末项向下回头项），大步长与 count 0/1；
 *   3. Home / End 取首末，空列表同样安全；
 *   4. 可访问名「标签 + 当前值」且**不重复拼接**（调用方已把值写进标签时原样返回）。
 *
 * 这几条都是纯函数，不需要启动 Electron —— 它们在界面上「看起来完全正常」，
 * 只有把索引 / 文案单独钉死才测得出。
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	accessibleName,
	edgeActiveIndex,
	initialActiveIndex,
	moveActiveIndex,
} from "../../src/renderer/src/select-field-core.js";

const OPTIONS = [
	{ value: "default", label: "默认" },
	{ value: "name", label: "名称" },
	{ value: "recent", label: "最近安装" },
];

describe("initialActiveIndex", () => {
	it("命中选中项时返回它的下标", () => {
		assert.equal(initialActiveIndex(OPTIONS, "name"), 1);
		assert.equal(initialActiveIndex(OPTIONS, "recent"), 2);
	});

	it("没有匹配时回到首项", () => {
		assert.equal(initialActiveIndex(OPTIONS, "missing"), 0);
		assert.equal(initialActiveIndex(OPTIONS, undefined), 0);
	});

	it("空列表 / 非数组返回 0（不把越界下标交给 DOM）", () => {
		assert.equal(initialActiveIndex([], "name"), 0);
		assert.equal(initialActiveIndex(undefined, "name"), 0);
	});

	it("用全等匹配值：0 与 '0' 不互相命中", () => {
		const numeric = [{ value: 0, label: "全部" }, { value: 7, label: "七天" }];
		assert.equal(initialActiveIndex(numeric, 0), 0);
		assert.equal(initialActiveIndex(numeric, 7), 1);
		assert.equal(initialActiveIndex(numeric, "7"), 0);
	});
});

describe("moveActiveIndex", () => {
	it("常规移动 ±1", () => {
		assert.equal(moveActiveIndex(0, 1, 3), 1);
		assert.equal(moveActiveIndex(1, 1, 3), 2);
		assert.equal(moveActiveIndex(2, -1, 3), 1);
	});

	it("两端循环：首项向上回末项、末项向下回头项", () => {
		assert.equal(moveActiveIndex(0, -1, 3), 2);
		assert.equal(moveActiveIndex(2, 1, 3), 0);
	});

	it("wrap 为假时夹在边界内", () => {
		assert.equal(moveActiveIndex(0, -1, 3, false), 0);
		assert.equal(moveActiveIndex(2, 1, 3, false), 2);
	});

	it("delta 大于 1 时按模运算落点", () => {
		assert.equal(moveActiveIndex(0, 4, 3), 1);
		assert.equal(moveActiveIndex(1, -4, 3), 0);
	});

	it("count 为 0 / 1 / 非法时安全", () => {
		assert.equal(moveActiveIndex(0, 1, 0), 0);
		assert.equal(moveActiveIndex(5, -1, 1), 0);
		assert.equal(moveActiveIndex(0, 1, Number.NaN), 0);
	});

	it("越界或非整数的当前下标按 0 处理", () => {
		assert.equal(moveActiveIndex(-1, 1, 3), 0);
		assert.equal(moveActiveIndex(undefined, 1, 3), 1);
		assert.equal(moveActiveIndex(2.5, 1, 3), 1);
	});
});

describe("edgeActiveIndex", () => {
	it("home 取首项、end 取末项", () => {
		assert.equal(edgeActiveIndex("home", 3), 0);
		assert.equal(edgeActiveIndex("end", 3), 2);
	});

	it("空列表 / 非法 count 返回 0", () => {
		assert.equal(edgeActiveIndex("home", 0), 0);
		assert.equal(edgeActiveIndex("end", 0), 0);
		assert.equal(edgeActiveIndex("end", Number.NaN), 0);
	});
});

describe("accessibleName", () => {
	it("标签未包含当前值时追加「：当前值」", () => {
		assert.equal(accessibleName("排序方式", "名称"), "排序方式：名称");
	});

	it("标签已包含当前值时原样返回，不重复拼接", () => {
		// 调用方已把值写进 ariaLabel 的真实形态（专家页排序 / 资料库筛选）。
		assert.equal(accessibleName("排序方式：名称", "名称"), "排序方式：名称");
		assert.equal(accessibleName("类型筛选：全部", "全部"), "类型筛选：全部");
	});

	it("按子串判断，不做全等比较", () => {
		assert.equal(accessibleName("来源会话筛选：季度复盘", "季度复盘"), "来源会话筛选：季度复盘");
	});

	it("标签为空时返回当前值（不渲染空 aria-label）", () => {
		assert.equal(accessibleName(undefined, "名称"), "名称");
		assert.equal(accessibleName("", "名称"), "名称");
	});

	it("当前值为空时返回标签", () => {
		assert.equal(accessibleName("排序方式", undefined), "排序方式");
		assert.equal(accessibleName("排序方式", ""), "排序方式");
	});

	it("两侧都为空时返回空串", () => {
		assert.equal(accessibleName(undefined, undefined), "");
		assert.equal(accessibleName("", ""), "");
	});

	it("两侧首尾空白被裁掉，避免读出多余停顿", () => {
		assert.equal(accessibleName(" 排序方式 ", " 名称 "), "排序方式：名称");
	});
});
