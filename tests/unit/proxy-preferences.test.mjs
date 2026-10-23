/**
 * 网络代理偏好的单元测试（spec: proxy-settings）。
 *
 * 守的三件事：
 *   1. 读侧与写侧共用同一份判据 —— 写入时合法、读回时被丢的漂移不可能发生；
 *   2. proxy 进了 readPreferences 的白名单 —— 否则「写进去、读不出来」，
 *      表现为设置页显示直连、但文件里明明写着代理（静默失效）；
 *   3. 拒绝比宽容好 —— SOCKS 明确报错而不是接受后静默直连。
 *
 * 文件系统隔离与 tests/unit/theme-preferences.test.mjs 同一模式。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	normalizeProxyUrl,
	readPreferences,
	validateProxyInput,
	writePreferences,
} from "../../src/main/daemon/preferences.js";

let configDir;
let previousConfigDir;

beforeEach(() => {
	previousConfigDir = process.env["ZEROWORK_CONFIG_DIR"];
	configDir = mkdtempSync(join(tmpdir(), "zerowork-proxy-prefs-"));
	process.env["ZEROWORK_CONFIG_DIR"] = configDir;
});

afterEach(() => {
	if (previousConfigDir === undefined) delete process.env["ZEROWORK_CONFIG_DIR"];
	else process.env["ZEROWORK_CONFIG_DIR"] = previousConfigDir;
	rmSync(configDir, { recursive: true, force: true });
});

describe("normalizeProxyUrl —— 地址规范化", () => {
	it("接受 http / https，并可带端口", () => {
		expect(normalizeProxyUrl("http://127.0.0.1:7890")).toBe("http://127.0.0.1:7890/");
		expect(normalizeProxyUrl("https://proxy.example.com:8443")).toBe("https://proxy.example.com:8443/");
	});

	it("去首尾空白", () => {
		expect(normalizeProxyUrl("  http://127.0.0.1:7890  ")).toBe("http://127.0.0.1:7890/");
	});

	it("拒绝 SOCKS（undici 的 ProxyAgent 只处理 HTTP(S)）", () => {
		expect(normalizeProxyUrl("socks5://127.0.0.1:7891")).toBeUndefined();
	});

	it("拒绝缺 scheme 的裸地址", () => {
		expect(normalizeProxyUrl("127.0.0.1:7890")).toBeUndefined();
	});

	it("拒绝 URL 里夹带认证信息（必须拆成独立字段）", () => {
		expect(normalizeProxyUrl("http://user:pass@127.0.0.1:7890")).toBeUndefined();
	});

	it("非字符串与空串一律非法", () => {
		expect(normalizeProxyUrl(undefined)).toBeUndefined();
		expect(normalizeProxyUrl(null)).toBeUndefined();
		expect(normalizeProxyUrl("")).toBeUndefined();
		expect(normalizeProxyUrl("   ")).toBeUndefined();
	});
});

describe("validateProxyInput —— 写侧校验与可诊断的消息", () => {
	it("三档合法输入", () => {
		expect(validateProxyInput({ mode: "off" })).toEqual({ ok: true, value: { mode: "off" } });
		expect(validateProxyInput({ mode: "system" })).toEqual({ ok: true, value: { mode: "system" } });
		const manual = validateProxyInput({ mode: "manual", url: "http://127.0.0.1:7890" });
		expect(manual.ok).toBe(true);
		expect(manual.value.url).toBe("http://127.0.0.1:7890/");
	});

	it("未知模式被拒绝", () => {
		const result = validateProxyInput({ mode: "auto" });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("未知的代理模式");
	});

	it("手动模式缺地址时给出示例", () => {
		const result = validateProxyInput({ mode: "manual", url: "  " });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("http://127.0.0.1:7890");
	});

	it("SOCKS 的拒绝消息说明替代方案", () => {
		const result = validateProxyInput({ mode: "manual", url: "socks5://127.0.0.1:7891" });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("暂不支持 SOCKS");
		expect(result.message).toContain("HTTP");
	});

	it("缺 scheme 时说明需要 http:// 或 https://", () => {
		const result = validateProxyInput({ mode: "manual", url: "127.0.0.1:7890" });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("http://");
	});

	it("用户名与密码原样保留（不写进 URL）", () => {
		const result = validateProxyInput({
			mode: "manual",
			url: "http://127.0.0.1:7890",
			username: "alice",
			password: "s3cret",
		});
		expect(result.ok).toBe(true);
		expect(result.value.username).toBe("alice");
		expect(result.value.password).toBe("s3cret");
		expect(result.value.url).not.toContain("s3cret");
	});
});

describe("readPreferences —— proxy 必须在白名单里（往返不丢）", () => {
	it("写入 manual 后能原样读回", () => {
		writePreferences({
			proxy: { mode: "manual", url: "http://127.0.0.1:7890/", username: "alice", password: "s3cret" },
		});
		expect(readPreferences().proxy).toEqual({
			mode: "manual",
			url: "http://127.0.0.1:7890/",
			username: "alice",
			password: "s3cret",
		});
	});

	it("system / off 档不带 url 字段", () => {
		writePreferences({ proxy: { mode: "system" } });
		expect(readPreferences().proxy).toEqual({ mode: "system" });
	});

	it("文件里的非法 proxy 整块丢弃（不留半个配置）", () => {
		writePreferences({ proxy: { mode: "manual", url: "socks5://127.0.0.1:7891" } });
		expect(readPreferences().proxy).toBeUndefined();
	});

	it("未知 mode 整块丢弃", () => {
		writePreferences({ proxy: { mode: "auto", url: "http://127.0.0.1:7890" } });
		expect(readPreferences().proxy).toBeUndefined();
	});

	it("写 proxy 不会丢掉其它已知偏好", () => {
		writePreferences({ proxy: { mode: "off" }, theme: "dark", thinkingLevel: "high" });
		const prefs = readPreferences();
		expect(prefs.theme).toBe("dark");
		expect(prefs.thinkingLevel).toBe("high");
		expect(prefs.proxy).toEqual({ mode: "off" });
	});
});
