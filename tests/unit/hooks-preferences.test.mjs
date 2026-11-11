/**
 * 用户级 hooks 在 `preferences.json` 里的读写路径。
 *
 * 这一层只有一个错误形态，但它很隐蔽：**readPreferences 是白名单读取、
 * writePreferences 是整份覆写**。读侧漏一个键，任何一次「与它无关」的设置保存
 * 都会把那个键从文件里悄悄抹掉。
 *
 * 对 hooks 来说后果分两档：
 *
 *   1. 合法的 hooks 被抹掉 → 用户写的确定性规则静默消失；
 *   2. **损坏的** hooks 被抹掉 → 更糟：`PreToolUse` 的 fail-closed 随之中止。
 *      用户本来会看到「配置无效，工具调用被拒绝」，保存一次主题之后就变成
 *      「没有配置，全部放行」—— 一次静默降级。
 *
 * 文件系统隔离与 `tests/unit/update-channel-preferences.test.mjs` 同一模式。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getConfigDir } from "../../src/main/daemon/config-paths.js";
import {
	readHooksConfig,
	readPreferences,
	writePreferences,
} from "../../src/main/daemon/preferences.js";

let configDir;
let previousConfigDir;

beforeEach(() => {
	previousConfigDir = process.env["ZEROWORK_CONFIG_DIR"];
	configDir = mkdtempSync(join(tmpdir(), "zerowork-hooks-prefs-"));
	process.env["ZEROWORK_CONFIG_DIR"] = configDir;
});

afterEach(() => {
	if (previousConfigDir === undefined) delete process.env["ZEROWORK_CONFIG_DIR"];
	else process.env["ZEROWORK_CONFIG_DIR"] = previousConfigDir;
	rmSync(configDir, { recursive: true, force: true });
});

const prefsFile = () => join(getConfigDir(), "preferences.json");
const readRaw = () => JSON.parse(readFileSync(prefsFile(), "utf8"));

const goodHook = { id: "h-1", event: "PreToolUse", command: "exit 0" };

describe("hooks 的读写往返", () => {
	it("写入后能读回（白名单没把 hooks 丢掉），并补齐缺省超时", () => {
		writePreferences({ ...readPreferences(), hooks: [goodHook] });
		const hooks = readPreferences().hooks;
		expect(hooks).toHaveLength(1);
		expect(hooks[0].id).toBe("h-1");
		expect(hooks[0].timeoutMs).toBe(5000);
		expect(readHooksConfig().config.hooks).toHaveLength(1);
	});

	it("写其它偏好不丢 hooks", () => {
		writePreferences({ ...readPreferences(), hooks: [goodHook] });
		writePreferences({ ...readPreferences(), theme: "dark" });
		expect(readPreferences().hooks).toHaveLength(1);
		expect(readPreferences().theme).toBe("dark");
	});

	it("hooks 未配置时不写这个键（缺省语义不在读侧）", () => {
		writePreferences({ theme: "dark" });
		expect("hooks" in readPreferences()).toBe(false);
	});

	it("信任名单写入后能读回", () => {
		writePreferences({ ...readPreferences(), trustedWorkspaceHooks: ["/w/a"] });
		expect(readPreferences().trustedWorkspaceHooks).toEqual(["/w/a"]);
		expect(readHooksConfig().trusted).toEqual(["/w/a"]);
	});
});

describe("损坏的 hooks 配置不能被无关写入抹掉", () => {
	it("结构性损坏（hooks 不是数组）：原样保留，fail-closed 仍在", () => {
		writeFileSync(prefsFile(), JSON.stringify({ hooks: "oops", theme: "dark" }), "utf8");
		// 一次与 hooks 无关的保存：
		writePreferences({ ...readPreferences(), theme: "light" });
		expect(readRaw().hooks).toBe("oops");
		expect(readHooksConfig().config.fatal).toBe(true);
	});

	it("单条损坏：整份原样保留（不把坏条目静默删掉）", () => {
		const broken = [goodHook, { id: "h-2", event: "Nope", command: "x" }];
		writeFileSync(prefsFile(), JSON.stringify({ hooks: broken }), "utf8");
		writePreferences({ ...readPreferences(), theme: "dark" });
		expect(readRaw().hooks).toEqual(broken);
		// 好的那条仍然进可执行集合，坏的那条在设置页以 errors 呈现。
		const config = readHooksConfig().config;
		expect(config.hooks).toHaveLength(1);
		expect(config.errors).toHaveLength(1);
	});

	it("合法的 hooks 被无关写入保留时仍是规范化形（不是 raw）", () => {
		writeFileSync(prefsFile(), JSON.stringify({ hooks: [{ id: "h-1", event: "PreToolUse", command: "x" }] }), "utf8");
		writePreferences({ ...readPreferences(), theme: "dark" });
		expect(readRaw().hooks[0].timeoutMs).toBe(5000);
	});
});

describe("readHooksConfig —— 整个偏好文件坏掉时是 fail-closed 的来源", () => {
	it("文件不是合法 JSON → fatal", () => {
		writeFileSync(prefsFile(), "{ not json", "utf8");
		const { config } = readHooksConfig();
		expect(config.fatal).toBe(true);
		expect(config.fatalMessage).toMatch(/不是合法 JSON/);
	});

	it("文件不存在 → 空配置且不 fatal（干净安装不该拒绝一切工具）", () => {
		const { config } = readHooksConfig();
		expect(config.fatal).toBe(false);
		expect(config.hooks).toEqual([]);
	});

	it("读不出来但不是 ENOENT → fatal（用户可能配了规则，只是读不到）", () => {
		// 同名目录 → readFileSync 抛 EISDIR（Windows 上同样成立），
		// 这是可移植的「非 ENOENT 读取失败」造法。
		mkdirSync(prefsFile(), { recursive: true });
		const { config } = readHooksConfig();
		expect(config.fatal).toBe(true);
		expect(config.fatalMessage).toMatch(/读取偏好文件失败/);
	});
});
