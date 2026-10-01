/**
 * 主题偏好的单元测试（isThemePreference 纯函数 + preferences.json 读写路径）。
 *
 * 守的三件事：
 *   1. 三档枚举的口径——「写入时合法、读回时被丢」这类漂移不可能发生，
 *      因为写侧校验与读侧过滤共用同一个 isThemePreference；
 *   2. 往返不丢键——writePreferences 是整对象覆盖写，readPreferences 是
 *      白名单读取，theme 若没进白名单就会「写进去、读不出来」（静默失效），
 *      这正是本文件要防的回归；
 *   3. 缺省语义的位置——读偏好处**不填**默认档（「没写就是没写」），
 *      缺省 light 收在 handler 单出口（session-files.js 的
 *      getThemePreference），那边由 GUI 测试覆盖端到端，这里只断言
 *      「文件缺席 / 字段缺席时读不出 theme 键」这个事实。
 *
 * 文件系统隔离与 tests/unit/mailbox-session-index.test.mjs 同一模式：
 * 每个用例一个全新的 ZEROWORK_CONFIG_DIR 临时目录（getConfigDir 现读
 * 环境变量，不缓存，改了立即生效），用完即删。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getConfigDir } from "../../src/main/daemon/config-paths.js";
import {
	isThemePreference,
	readPreferences,
	writePreferences,
} from "../../src/main/daemon/preferences.js";

let configDir;
let previousConfigDir;

beforeEach(() => {
	previousConfigDir = process.env["ZEROWORK_CONFIG_DIR"];
	configDir = mkdtempSync(join(tmpdir(), "zerowork-theme-prefs-"));
	process.env["ZEROWORK_CONFIG_DIR"] = configDir;
});

afterEach(() => {
	if (previousConfigDir === undefined) delete process.env["ZEROWORK_CONFIG_DIR"];
	else process.env["ZEROWORK_CONFIG_DIR"] = previousConfigDir;
	rmSync(configDir, { recursive: true, force: true });
});

describe("isThemePreference —— 三档枚举判定", () => {
	it("三个合法档位", () => {
		expect(isThemePreference("system")).toBe(true);
		expect(isThemePreference("light")).toBe(true);
		expect(isThemePreference("dark")).toBe(true);
	});

	it("枚举外的字符串非法", () => {
		expect(isThemePreference("blue")).toBe(false);
		expect(isThemePreference("")).toBe(false);
		expect(isThemePreference("light dark")).toBe(false);
	});

	it("非字符串一律非法（严格类型，不做宽容转换）", () => {
		expect(isThemePreference(undefined)).toBe(false);
		expect(isThemePreference(null)).toBe(false);
		expect(isThemePreference(1)).toBe(false);
		expect(isThemePreference(true)).toBe(false);
		// 数组与带 toString 的对象是「宽容实现」（先 String() 再比对）下唯一
		// 会漏进去的形态：String(["dark"]) === "dark"。只用标量输入的话，
		// 这条用例无法区分严格实现与宽容实现——等于没测 typeof 分支。
		expect(isThemePreference(["dark"])).toBe(false);
		expect(isThemePreference({ toString: () => "dark" })).toBe(false);
	});

	it("大小写变体非法（「Dark」不等于「dark」，枚举值是协议不是提示语）", () => {
		expect(isThemePreference("Dark")).toBe(false);
		expect(isThemePreference("SYSTEM")).toBe(false);
	});
});

describe("preferences.json 的 theme 读写路径", () => {
	it("写入后能读回（白名单读取没把 theme 丢掉）", () => {
		writePreferences({ ...readPreferences(), theme: "dark" });
		expect(readPreferences().theme).toBe("dark");
	});

	it("往返保留三档各一的值（不只是 dark 能过）", () => {
		for (const theme of ["system", "light", "dark"]) {
			writePreferences({ ...readPreferences(), theme });
			expect(readPreferences().theme, `档位 ${theme} 应原样读回`).toBe(theme);
		}
	});

	it("写 theme 不丢其他键（整对象覆盖写的读改写口径）", () => {
		writePreferences({ ...readPreferences(), styleId: "professional" });
		writePreferences({ ...readPreferences(), theme: "dark" });
		const prefs = readPreferences();
		expect(prefs.theme).toBe("dark");
		expect(prefs.styleId).toBe("professional");
	});

	it("文件不存在时读不出 theme 键（缺省语义不在读侧）", () => {
		// 「没写就是没写」：EMPTY 不含 theme，缺省档收在 handler 单出口
		expect("theme" in readPreferences()).toBe(false);
	});

	it("存量偏好文件（无 theme 字段）读不出 theme 键", () => {
		const file = join(getConfigDir(), "preferences.json");
		writeFileSync(file, JSON.stringify({ styleId: "professional" }), "utf8");
		expect("theme" in readPreferences()).toBe(false);
	});

	it("文件里 theme 为非法值时整条丢弃（白名单过滤，不带病运行）", () => {
		// 场景：外部手改 / 旧版本写入的坏值。宁可丢掉回缺省，也不把
		// 未知档位透传给渲染层（那边的三档控件没法渲染第四种值）。
		const file = join(getConfigDir(), "preferences.json");
		writeFileSync(file, JSON.stringify({ theme: "blue" }), "utf8");
		expect("theme" in readPreferences()).toBe(false);
	});
});
