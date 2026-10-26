/**
 * 更新渠道偏好（stable / beta）的单元测试（issue #283）。
 *
 * 守的两件事：
 *   1. 枚举判定与 theme 同口径 —— 读侧丢弃非法值、写侧拒绝非法值，共用
 *      isUpdateChannel，不会出现「写入时合法、读回时被丢」；
 *   2. **写其它偏好不能抹掉 updateChannel** —— readPreferences 是白名单读取、
 *      writePreferences 是整份覆写：白名单一旦漏字段，任何一次无关写入都会
 *      把渠道悄悄删掉。这正是这个 bug 的形态，也是本文件最该防的回归。
 *
 * 文件系统隔离与 tests/unit/theme-preferences.test.mjs 同一模式：每个用例
 * 一个全新的 ZEROWORK_CONFIG_DIR 临时目录，用完即删。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getConfigDir } from "../../src/main/daemon/config-paths.js";
import {
	isUpdateChannel,
	readPreferences,
	writePreferences,
} from "../../src/main/daemon/preferences.js";

let configDir;
let previousConfigDir;

beforeEach(() => {
	previousConfigDir = process.env["ZEROWORK_CONFIG_DIR"];
	configDir = mkdtempSync(join(tmpdir(), "zerowork-update-channel-prefs-"));
	process.env["ZEROWORK_CONFIG_DIR"] = configDir;
});

afterEach(() => {
	if (previousConfigDir === undefined) delete process.env["ZEROWORK_CONFIG_DIR"];
	else process.env["ZEROWORK_CONFIG_DIR"] = previousConfigDir;
	rmSync(configDir, { recursive: true, force: true });
});

describe("isUpdateChannel —— 双档枚举判定", () => {
	it("两个合法档位", () => {
		expect(isUpdateChannel("stable")).toBe(true);
		expect(isUpdateChannel("beta")).toBe(true);
	});

	it("枚举外的字符串非法", () => {
		expect(isUpdateChannel("latest")).toBe(false);
		expect(isUpdateChannel("nightly")).toBe(false);
		expect(isUpdateChannel("")).toBe(false);
	});

	it("非字符串一律非法（严格类型，不做宽容转换）", () => {
		expect(isUpdateChannel(undefined)).toBe(false);
		expect(isUpdateChannel(null)).toBe(false);
		expect(isUpdateChannel(1)).toBe(false);
		expect(isUpdateChannel(true)).toBe(false);
		// 数组与带 toString 的对象是「宽容实现」下唯一会漏进去的形态。
		expect(isUpdateChannel(["beta"])).toBe(false);
		expect(isUpdateChannel({ toString: () => "beta" })).toBe(false);
	});

	it("大小写变体非法（枚举值是协议不是提示语）", () => {
		expect(isUpdateChannel("Beta")).toBe(false);
		expect(isUpdateChannel("STABLE")).toBe(false);
	});
});

describe("preferences.json 的 updateChannel 读写路径", () => {
	it("写入后能读回（白名单读取没把 updateChannel 丢掉）", () => {
		writePreferences({ ...readPreferences(), updateChannel: "beta" });
		expect(readPreferences().updateChannel).toBe("beta");
	});

	it("写其它偏好不丢渠道（整对象覆盖写的读改写口径）", () => {
		// 先切 beta，再写一次无关偏好 —— 旧实现会在第二次写入时
		// 因 readPreferences 不返回 updateChannel 而把它整条抹掉。
		writePreferences({ ...readPreferences(), updateChannel: "beta" });
		writePreferences({ ...readPreferences(), theme: "dark" });
		const prefs = readPreferences();
		expect(prefs.updateChannel).toBe("beta");
		expect(prefs.theme).toBe("dark");
	});

	it("写渠道不丢其它键", () => {
		writePreferences({ ...readPreferences(), theme: "dark" });
		writePreferences({ ...readPreferences(), updateChannel: "beta" });
		const prefs = readPreferences();
		expect(prefs.updateChannel).toBe("beta");
		expect(prefs.theme).toBe("dark");
	});

	it("文件不存在时读不出 updateChannel 键（缺省语义不在读侧）", () => {
		expect("updateChannel" in readPreferences()).toBe(false);
	});

	it("文件里 updateChannel 为非法值时整条丢弃", () => {
		const file = join(getConfigDir(), "preferences.json");
		writeFileSync(file, JSON.stringify({ updateChannel: "nightly" }), "utf8");
		expect("updateChannel" in readPreferences()).toBe(false);
	});
});
