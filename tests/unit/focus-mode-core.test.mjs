/**
 * 专注模式的纯逻辑。
 *
 * 这里的每一条都对应一个「界面看不出来、但会真出事」的分支：
 * 存储里是坏值、隐私模式写不进、窄窗口下不该加宽。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	FOCUS_ATTR,
	FOCUS_CONTENT_WIDTH,
	FOCUS_STORAGE_KEY,
	applyFocus,
	focusContentWidth,
	normalizeFocus,
	persistFocus,
	readFocus,
	toggleFocus
} from "../../src/renderer/src/focus-mode-core.js";

/** 极简 localStorage 替身：只实现被测到的那几个方法。 */
function fakeStorage(initial = {}) {
	const map = new Map(Object.entries(initial));
	return {
		getItem: (key) => (map.has(key) ? map.get(key) : null),
		setItem: (key, value) => map.set(key, value),
		dump: () => Object.fromEntries(map)
	};
}

describe("normalizeFocus", () => {
	it("只把明确的「开」当开", () => {
		for (const value of [true, 1, "1", "on"]) {
			assert.equal(normalizeFocus(value), true, `${JSON.stringify(value)} 应算开`);
		}
	});

	it("坏值、缺值、字符串 false 一律按关（失败方向是回到普通界面）", () => {
		for (const value of [false, 0, "0", "false", "", null, undefined, {}, [], "也许"]) {
			assert.equal(normalizeFocus(value), false, `${JSON.stringify(value) ?? String(value)} 应算关`);
		}
	});
});

describe("toggleFocus", () => {
	it("从存储原始值切换也正确", () => {
		assert.equal(toggleFocus("on"), false);
		assert.equal(toggleFocus("false"), true);
		assert.equal(toggleFocus(null), true);
	});

	it("连续切两次回到原状态", () => {
		assert.equal(toggleFocus(toggleFocus(true)), true);
	});
});

describe("readFocus / persistFocus", () => {
	it("没有键时按关", () => {
		assert.equal(readFocus(fakeStorage()), false);
	});

	it("坏 JSON 不抛，按关", () => {
		assert.equal(readFocus(fakeStorage({ [FOCUS_STORAGE_KEY]: "{not json" })), false);
	});

	it("写进去的能被读回来（存的是 JSON 布尔）", () => {
		const storage = fakeStorage();
		assert.equal(persistFocus(storage, true), true);
		assert.equal(storage.dump()[FOCUS_STORAGE_KEY], "true");
		assert.equal(readFocus(storage), true);
		assert.equal(persistFocus(storage, "on"), true);
		assert.equal(readFocus(storage), true);
	});

	it("写失败只返回 false，不抛（配额满 / 隐私模式）", () => {
		const storage = {
			getItem: () => null,
			setItem: () => {
				throw new Error("QuotaExceededError");
			}
		};
		assert.equal(persistFocus(storage, true), false);
	});

	it("storage 为 null 时不炸", () => {
		assert.equal(readFocus(null), false);
		assert.equal(persistFocus(null, true), false);
	});
});

describe("applyFocus", () => {
	it("写到 data-focus 上，而且是 on / off 两个显式值", () => {
		const attrs = new Map();
		const root = { setAttribute: (k, v) => attrs.set(k, v) };
		applyFocus(root, true);
		assert.equal(attrs.get(FOCUS_ATTR), "on");
		applyFocus(root, "false");
		assert.equal(attrs.get(FOCUS_ATTR), "off");
	});

	it("root 为 null 或没有 setAttribute 时静默返回", () => {
		assert.doesNotThrow(() => applyFocus(null, true));
		assert.doesNotThrow(() => applyFocus({}, true));
	});
});

describe("focusContentWidth", () => {
	it("宽窗口收到 720", () => {
		assert.equal(focusContentWidth(832), FOCUS_CONTENT_WIDTH);
		assert.equal(focusContentWidth(1400), 720);
	});

	it("窄窗口保持原值（专注模式不加宽，加了就出横向滚动条）", () => {
		assert.equal(focusContentWidth(600), 600);
	});

	it("非法输入回落到标准宽度", () => {
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -10, null, undefined]) {
			assert.equal(focusContentWidth(bad), FOCUS_CONTENT_WIDTH);
		}
	});
});
