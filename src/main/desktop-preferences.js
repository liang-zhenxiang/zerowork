/*
 * desktop-preferences.js —— 桌面行为偏好（#422）
 *
 * 三项开关：关闭窗口到托盘 / 完成任务时通知 / 开机自启。
 *
 * **为什么单独一份 desktop.json、不写 preferences.json**：
 * `preferences.json` 的唯一写入方是 daemon（主题、代理、记忆等都在那里）。
 * 主进程再往同一份文件里写，就会变成两个进程抢一个文件 —— 后写的一方
 * 覆盖前一方，表现为「刚改的设置过一会儿自己变回去了」。这三项又完全是
 * **主进程侧**的行为（托盘、窗口、登录项），daemon 不需要知道，所以分开存。
 *
 * 读失败（不存在 / 损坏 / 无权限）一律按默认值，不阻塞启动；写回时保留
 * 文件里已有的合法项。只接受布尔值，未知键丢弃 —— 配置是用户能直接编辑的
 * 文本文件，宽容读取比报错更合适，但**不能**把非法值带进运行态。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
// 显式 import 而不是用全局（main 目录的 eslint globals 白名单不含 process，
// 与 updates.js 同一口径）。
import process from "node:process";

/** 默认值：三项里只有「完成任务时通知」默认开（它不改变窗口行为）。 */
const DESKTOP_DEFAULTS = Object.freeze({
	closeToTray: false,
	notifyOnComplete: true,
	launchAtLogin: false,
	/* #439 第二十六轮 F2：通知免打扰时段（24h 制，跨零点用 start>end 表达）。
	   免打扰期间系统通知静默（应用内 toast 不受影响）。 */
	quietHoursEnabled: false,
	quietStart: "22:00",
	quietEnd: "08:00",
});

const DESKTOP_KEYS = Object.keys(DESKTOP_DEFAULTS);

/** 与 index.js 的代理 / 主题读取同一口径：ZEROWORK_CONFIG_DIR 优先。 */
function configDir() {
	const override = process.env["ZEROWORK_CONFIG_DIR"];
	return override !== void 0 && override !== "" ? override : join(homedir(), ".zerowork");
}

function desktopPreferencesPath() {
	return join(configDir(), "desktop.json");
}

/** 只挑出三个已知键里的布尔值；其余键与非布尔值一律忽略。 */
function normalizeDesktopPreferences(value) {
	const picked = {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) return picked;
	for (const key of DESKTOP_KEYS) {
		if (typeof value[key] === "boolean") picked[key] = value[key];
	}
	return picked;
}

/** 读偏好：文件不存在 / 损坏 / 无权限都是正常态（首启、手删、手改坏）。 */
function readDesktopPreferences() {
	const result = { ...DESKTOP_DEFAULTS };
	try {
		const parsed = JSON.parse(readFileSync(desktopPreferencesPath(), "utf8"));
		Object.assign(result, normalizeDesktopPreferences(parsed));
	} catch {
		// 落到默认值，调用方不需要区分「没有文件」与「文件坏了」。
	}
	return result;
}

/**
 * 原子写：临时文件写全后 rename 替换。
 *
 * Windows 上 rename 不能覆盖已存在的文件（同 daemon 的 packs.js）：目标存在时
 * 先删再改名。临时名带 pid 与时间戳，避免并发写互相踩。
 */
function writeFileAtomic(destination, contents) {
	const temp = `${destination}.tmp-${process.pid}-${Date.now()}`;
	try {
		writeFileSync(temp, contents, "utf8");
		try {
			renameSync(temp, destination);
		} catch (error) {
			if (!existsSync(destination)) throw error;
			rmSync(destination, { force: true });
			renameSync(temp, destination);
		}
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

/**
 * 合并写入并返回写入后的完整对象（调用方直接拿它更新内存态）。
 * 传进来的 patch 里非布尔值被忽略 —— 不是静默接受，而是「读侧与写侧
 * 同一份判据」：能写进去的值一定也能原样读回来。
 */
function writeDesktopPreferences(patch) {
	const next = { ...readDesktopPreferences(), ...normalizeDesktopPreferences(patch) };
	const destination = desktopPreferencesPath();
	mkdirSync(dirname(destination), { recursive: true });
	writeFileAtomic(destination, `${JSON.stringify(next, null, 2)}\n`);
	return next;
}

export {
	DESKTOP_DEFAULTS,
	desktopPreferencesPath,
	normalizeDesktopPreferences,
	readDesktopPreferences,
	writeDesktopPreferences,
};
