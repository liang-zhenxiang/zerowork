/**
 * 托盘值守的纯决策与桌面偏好的单元测试（#422）。
 *
 * 守三件事：
 *   1. 设置的读写判据是同一份 —— 能写进去的布尔值一定读得回来，
 *      非法值 / 未知键被丢弃而不是带进运行态；
 *   2. 关窗决策的四象限（开/关 × 正常/退出中）—— 退出那一格错了，
 *      应用会永远退不出去；
 *   3. 通知决策全矩阵 —— 「后台完成才通知」错了，要么打扰用户，
 *      要么最该通知的时候没有通知。
 *
 * 文件系统隔离与 tests/unit/proxy-preferences.test.mjs 同一模式：
 * 每个用例一个临时 ZEROWORK_CONFIG_DIR。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	DESKTOP_DEFAULTS,
	desktopPreferencesPath,
	readDesktopPreferences,
	writeDesktopPreferences,
} from "../../src/main/desktop-preferences.js";
import {
	addRunning,
	removeRunning,
	runningCount,
	shouldHideOnClose,
	shouldNotifyCompletion,
	isQuietHours,
} from "../../src/main/desktop-behavior.js";

let configDir;
let previousConfigDir;

beforeEach(() => {
	previousConfigDir = process.env["ZEROWORK_CONFIG_DIR"];
	configDir = mkdtempSync(join(tmpdir(), "zerowork-desktop-prefs-"));
	process.env["ZEROWORK_CONFIG_DIR"] = configDir;
});

afterEach(() => {
	if (previousConfigDir === undefined) delete process.env["ZEROWORK_CONFIG_DIR"];
	else process.env["ZEROWORK_CONFIG_DIR"] = previousConfigDir;
	rmSync(configDir, { recursive: true, force: true });
});

describe("#439 免打扰时段判定 isQuietHours", () => {
	it("未开启/非法输入一律不算免打扰", () => {
		expect(isQuietHours({ quietStart: "22:00", quietEnd: "08:00" }, 23 * 60)).toBe(true);
		expect(isQuietHours({}, 23 * 60)).toBe(false);
		expect(isQuietHours({ quietStart: "bad", quietEnd: "08:00" }, 23 * 60)).toBe(false);
		expect(isQuietHours({ quietStart: "22:00", quietEnd: "99:00" }, 23 * 60)).toBe(false);
		expect(isQuietHours({ quietStart: "08:00", quietEnd: "08:00" }, 23 * 60)).toBe(false);
	});
	it("不跨零点：start<end 区间内含头不含尾", () => {
		expect(isQuietHours({ quietStart: "12:00", quietEnd: "14:00" }, 12 * 60)).toBe(true);
		expect(isQuietHours({ quietStart: "12:00", quietEnd: "14:00" }, 13 * 60 + 30)).toBe(true);
		expect(isQuietHours({ quietStart: "12:00", quietEnd: "14:00" }, 14 * 60)).toBe(false);
		expect(isQuietHours({ quietStart: "12:00", quietEnd: "14:00" }, 11 * 60 + 59)).toBe(false);
	});
	it("跨零点：start>end，22:00-08:00 在 23:00 与 07:00 都算", () => {
		expect(isQuietHours({ quietStart: "22:00", quietEnd: "08:00" }, 22 * 60)).toBe(true);
		expect(isQuietHours({ quietStart: "22:00", quietEnd: "08:00" }, 23 * 60 + 59)).toBe(true);
		expect(isQuietHours({ quietStart: "22:00", quietEnd: "08:00" }, 0)).toBe(true);
		expect(isQuietHours({ quietStart: "22:00", quietEnd: "08:00" }, 7 * 60 + 59)).toBe(true);
		expect(isQuietHours({ quietStart: "22:00", quietEnd: "08:00" }, 8 * 60)).toBe(false);
		expect(isQuietHours({ quietStart: "22:00", quietEnd: "08:00" }, 12 * 60)).toBe(false);
	});
	it("免打扰下 shouldNotifyCompletion 直接 null", () => {
		expect(shouldNotifyCompletion({ enabled: true, focused: false, eventType: "run_finished", outcome: "completed", quietHours: true })).toBe(null);
		expect(shouldNotifyCompletion({ enabled: true, focused: false, eventType: "run_finished", outcome: "completed", quietHours: false })).toBe("completed");
	});
});

describe("desktop.json —— 默认值与读写", () => {
	it("文件不存在时按默认值（首启不阻塞）", () => {
		expect(readDesktopPreferences()).toEqual({
			closeToTray: false,
			notifyOnComplete: true,
			launchAtLogin: false,
			quietHoursEnabled: false,
			quietStart: "22:00",
			quietEnd: "08:00",
		});
	});

	it("默认值：只有通知默认开，关窗到托盘与自启默认关", () => {
		expect(DESKTOP_DEFAULTS.closeToTray).toBe(false);
		expect(DESKTOP_DEFAULTS.notifyOnComplete).toBe(true);
		expect(DESKTOP_DEFAULTS.launchAtLogin).toBe(false);
	});

	it("写入后读回同一份值，并返回完整对象", () => {
		const written = writeDesktopPreferences({ closeToTray: true });
		expect(written).toEqual({ closeToTray: true, notifyOnComplete: true, launchAtLogin: false, quietHoursEnabled: false, quietStart: "22:00", quietEnd: "08:00" });
		expect(readDesktopPreferences()).toEqual(written);
		expect(desktopPreferencesPath()).toBe(join(configDir, "desktop.json"));
	});

	it("部分写：只改给的键，其余保留", () => {
		writeDesktopPreferences({ closeToTray: true, launchAtLogin: true });
		const next = writeDesktopPreferences({ notifyOnComplete: false });
		expect(next).toEqual({ closeToTray: true, notifyOnComplete: false, launchAtLogin: true, quietHoursEnabled: false, quietStart: "22:00", quietEnd: "08:00" });
	});

	it("非布尔值与未知键一律丢弃（写侧与读侧同一判据）", () => {
		// @ts-expect-error 故意传非法类型，模拟用户手改配置
		const written = writeDesktopPreferences({ closeToTray: "true", notifyOnComplete: 1, launchAtLogin: null, 别的键: true });
		expect(written).toEqual(DESKTOP_DEFAULTS);
	});

	it("损坏的 JSON 按默认值读；写回时得到一份干净的新文件", () => {
		writeFileSync(desktopPreferencesPath(), "{ 这不是 JSON", "utf8");
		expect(readDesktopPreferences()).toEqual(DESKTOP_DEFAULTS);
		const written = writeDesktopPreferences({ closeToTray: true });
		expect(written).toEqual({ ...DESKTOP_DEFAULTS, closeToTray: true });
		expect(JSON.parse(readFileSync(desktopPreferencesPath(), "utf8"))).toEqual(written);
	});

	it("文件里混入非法项时只取合法项", () => {
		writeFileSync(
			desktopPreferencesPath(),
			JSON.stringify({ closeToTray: "yes", notifyOnComplete: false, launchAtLogin: true, extra: 1 }),
			"utf8",
		);
		expect(readDesktopPreferences()).toEqual({
			closeToTray: false,
			notifyOnComplete: false,
			launchAtLogin: true,
			quietHoursEnabled: false,
			quietStart: "22:00",
			quietEnd: "08:00",
		});
	});

	it("原子写：不留临时文件，落盘内容是完整 JSON", () => {
		writeDesktopPreferences({ closeToTray: true });
		writeDesktopPreferences({ closeToTray: false });
		const leftovers = readdirSync(configDir).filter((name) => name.includes(".tmp-"));
		expect(leftovers, `残留临时文件：${leftovers.join(", ")}`).toEqual([]);
		expect(() => JSON.parse(readFileSync(desktopPreferencesPath(), "utf8"))).not.toThrow();
	});
});

describe("shouldHideOnClose —— 关窗决策四象限", () => {
	it("开着关窗到托盘、且不在退出中 → 隐藏", () => {
		expect(shouldHideOnClose({ closeToTray: true, quitting: false })).toBe(true);
	});

	it("没开 → 照常关闭", () => {
		expect(shouldHideOnClose({ closeToTray: false, quitting: false })).toBe(false);
	});

	it("退出中 → 永远放行（哪怕开着关窗到托盘）", () => {
		expect(shouldHideOnClose({ closeToTray: true, quitting: true })).toBe(false);
		expect(shouldHideOnClose({ closeToTray: false, quitting: true })).toBe(false);
	});

	it("只有显式 true 才隐藏（非法值不阻塞关闭）", () => {
		expect(shouldHideOnClose({ closeToTray: "true", quitting: false })).toBe(false);
		expect(shouldHideOnClose({ closeToTray: undefined, quitting: false })).toBe(false);
	});
});

describe("shouldNotifyCompletion —— 通知决策全矩阵", () => {
	const base = { enabled: true, focused: false, eventType: "run_finished", outcome: "completed" };

	it("后台完成 → completed", () => {
		expect(shouldNotifyCompletion(base)).toBe("completed");
	});

	it("后台失败 → failed", () => {
		expect(shouldNotifyCompletion({ ...base, eventType: "run_error", outcome: undefined })).toBe("failed");
	});

	it("用户主动取消 → 不通知", () => {
		expect(shouldNotifyCompletion({ ...base, outcome: "cancelled" })).toBe(null);
	});

	it("开关关掉 → 不通知（任何终态）", () => {
		expect(shouldNotifyCompletion({ ...base, enabled: false })).toBe(null);
		expect(shouldNotifyCompletion({ ...base, eventType: "run_error", enabled: false })).toBe(null);
	});

	it("窗口在前台 → 不通知（用户自己看得到）", () => {
		expect(shouldNotifyCompletion({ ...base, focused: true })).toBe(null);
		expect(shouldNotifyCompletion({ ...base, eventType: "run_error", focused: true })).toBe(null);
	});

	it("不相关的事件类型 → 不通知", () => {
		expect(shouldNotifyCompletion({ ...base, eventType: "run_started" })).toBe(null);
		expect(shouldNotifyCompletion({ ...base, eventType: "assistant_done" })).toBe(null);
	});
});

describe("运行中集合 —— 托盘菜单的计数", () => {
	it("按 runId 去重；新 id 才让计数变化", () => {
		const runs = new Set();
		expect(addRunning(runs, "run-1")).toBe(true);
		expect(addRunning(runs, "run-1")).toBe(false);
		expect(addRunning(runs, "run-2")).toBe(true);
		expect(runningCount(runs)).toBe(2);
	});

	it("缺 id / 空 id 不计入（否则计数会被空串污染）", () => {
		const runs = new Set();
		expect(addRunning(runs, undefined)).toBe(false);
		expect(addRunning(runs, "")).toBe(false);
		expect(addRunning(runs, 42)).toBe(false);
		expect(runningCount(runs)).toBe(0);
	});

	it("结束事件移除；重复移除返回 false", () => {
		const runs = new Set(["run-1", "run-2"]);
		expect(removeRunning(runs, "run-1")).toBe(true);
		expect(removeRunning(runs, "run-1")).toBe(false);
		expect(runningCount(runs)).toBe(1);
	});
});
