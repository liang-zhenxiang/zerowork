/**
 * 专家停用偏好的单元测试（#426）。
 *
 * 守的三件事：
 *   1. 读侧口径 —— 整块非法（不是数组）整块忽略；单条非法只丢那一条；
 *      去重保序。`disabledExperts` 会直接参与 `includes` 判定，重复项与
 *      非法项都不该让「某位专家到底停没停用」变得说不清。
 *   2. 往返不丢键 —— `writePreferences` 是整对象覆盖写，`readPreferences`
 *      是白名单读取；`disabledExperts` 漏进白名单就会「写进去、读不出来」
 *      （与 updateChannel 那次事故同形）。这条是回归防线。
 *   3. 写侧去重与空清单删键 —— 「没停用任何专家」不该在 preferences.json 里
 *      留一个 `[]`，否则每次与别的设置一起读改写都会把空数组写回去。
 *
 * 文件系统隔离与 theme-preferences.test.mjs 同一模式：每个用例一个全新的
 * ZEROWORK_CONFIG_DIR（getConfigDir 现读环境变量，不缓存）。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getConfigDir } from "../../src/main/daemon/config-paths.js";
import {
	readDisabledExperts,
	readPreferences,
	withExpertDisabled,
	writePreferences,
} from "../../src/main/daemon/preferences.js";

let configDir;
let previousConfigDir;

beforeEach(() => {
	previousConfigDir = process.env["ZEROWORK_CONFIG_DIR"];
	configDir = mkdtempSync(join(tmpdir(), "zerowork-expert-prefs-"));
	process.env["ZEROWORK_CONFIG_DIR"] = configDir;
});

afterEach(() => {
	if (previousConfigDir === undefined) delete process.env["ZEROWORK_CONFIG_DIR"];
	else process.env["ZEROWORK_CONFIG_DIR"] = previousConfigDir;
	rmSync(configDir, { recursive: true, force: true });
});

describe("readDisabledExperts —— 读侧宽容但整块有边界", () => {
	it("合法数组原样读出（保持顺序）", () => {
		expect(readDisabledExperts(["a", "b"])).toEqual(["a", "b"]);
	});

	it("重复项去重并保序", () => {
		expect(readDisabledExperts(["b", "a", "b", "a"])).toEqual(["b", "a"]);
	});

	it("单条非法只丢那一条（非字符串 / 空串 / 纯空白）", () => {
		expect(readDisabledExperts(["a", 1, null, "", "   ", "b"])).toEqual(["a", "b"]);
	});

	it("首尾空白被裁掉（手改过的文件不至于让 id 对不上）", () => {
		expect(readDisabledExperts(["  a  "])).toEqual(["a"]);
	});

	it("不是数组时整块忽略（字符串 / 对象 / 数字 / null）", () => {
		expect(readDisabledExperts("a")).toBeUndefined();
		expect(readDisabledExperts({ 0: "a" })).toBeUndefined();
		expect(readDisabledExperts(42)).toBeUndefined();
		expect(readDisabledExperts(null)).toBeUndefined();
	});

	it("缺省与「全是坏值」都等于没停用任何专家", () => {
		expect(readDisabledExperts(undefined)).toBeUndefined();
		expect(readDisabledExperts([])).toBeUndefined();
		expect(readDisabledExperts([1, "", null])).toBeUndefined();
	});
});

describe("preferences.json 的 disabledExperts 读写路径", () => {
	it("写入后能读回（白名单读取没把它丢掉）", () => {
		writePreferences({ ...readPreferences(), disabledExperts: ["e2e-expert"] });
		expect(readPreferences().disabledExperts).toEqual(["e2e-expert"]);
	});

	it("写停用清单不丢其他键（整对象覆盖写的读改写口径）", () => {
		writePreferences({ ...readPreferences(), styleId: "professional" });
		writePreferences({ ...readPreferences(), disabledExperts: ["a"] });
		const prefs = readPreferences();
		expect(prefs.disabledExperts).toEqual(["a"]);
		expect(prefs.styleId).toBe("professional");
	});

	it("文件里是非法形态时读不出这个键（不带病运行）", () => {
		writeFileSync(join(getConfigDir(), "preferences.json"), JSON.stringify({ disabledExperts: "a" }), "utf8");
		expect("disabledExperts" in readPreferences()).toBe(false);
	});

	it("纯坏值的清单读出来等于没有这个键", () => {
		writeFileSync(join(getConfigDir(), "preferences.json"), JSON.stringify({ disabledExperts: [1, ""] }), "utf8");
		expect("disabledExperts" in readPreferences()).toBe(false);
	});
});

describe("withExpertDisabled —— 写侧去重与空清单删键", () => {
	it("停用时加入并去重", () => {
		const next = withExpertDisabled({ disabledExperts: ["a", "b"] }, "b", true);
		expect(next.disabledExperts).toEqual(["a", "b"]);
		const added = withExpertDisabled({ disabledExperts: ["a"] }, "b", true);
		expect(added.disabledExperts).toEqual(["a", "b"]);
	});

	it("恢复时移除；最后一条移除后删键", () => {
		expect(withExpertDisabled({ disabledExperts: ["a", "b"] }, "a", false).disabledExperts).toEqual(["b"]);
		const empty = withExpertDisabled({ disabledExperts: ["a"] }, "a", false);
		expect("disabledExperts" in empty).toBe(false);
	});

	it("不改入参对象", () => {
		const before = { disabledExperts: ["a"], styleId: "professional" };
		withExpertDisabled(before, "b", true);
		withExpertDisabled(before, "a", false);
		expect(before.disabledExperts).toEqual(["a"]);
	});

	it("没有该键时停用会新建，恢复到空时回到「没有该键」", () => {
		expect(withExpertDisabled({}, "a", true).disabledExperts).toEqual(["a"]);
		expect("disabledExperts" in withExpertDisabled({}, "a", false)).toBe(false);
	});

	it("落盘后空清单真的不写这个键（文件里看不到 disabledExperts）", () => {
		writePreferences({ ...readPreferences(), disabledExperts: ["a"] });
		writePreferences(withExpertDisabled(readPreferences(), "a", false));
		const raw = JSON.parse(readFileSync(join(getConfigDir(), "preferences.json"), "utf8"));
		expect("disabledExperts" in raw).toBe(false);
	});
});
