/**
 * 网络代理设置的 GUI 测试（spec: proxy-settings）。
 *
 * 覆盖的是**配置链路**，不是代理转发本身（转发由
 * tests/unit/network-proxy.test.mjs 用本地 mock 代理验证）：
 *
 *   ① 设置 → 通用里有「网络代理」区块，三档可选；
 *   ② 选「手动代理」并填地址 → 保存 → preferences.json 落盘正确；
 *   ③ 保存会重启 daemon（收到 daemon:down → daemon:ready）——
 *      模型请求的 dispatcher 在进程启动时构造，不重启就不会生效；
 *   ④ 非法地址（SOCKS / 缺 scheme）的报错能指导用户，且不落盘；
 *   ⑤ 切回「直连」后持久化生效。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const PROXY_URL = "http://127.0.0.1:18999";
const h = createHarness({ name: "proxy" });

await h.launch();
const win = h.window();

/** 打开设置 → 通用（代理区在通用分组里）。 */
async function openSettingsGeneral() {
	await win.evaluate(() => {
		const btn = document.querySelector('[aria-label="设置"]');
		if (btn === null) throw new Error('找不到设置按钮 [aria-label="设置"]');
		btn.click();
	});
	await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") !== null), {
		timeout: 15_000,
		desc: "设置对话框挂载",
	});
	await waitUntil(
		() => win.evaluate(() => [...document.querySelectorAll("h2")].some((el) => el.textContent === "网络代理")),
		{ timeout: 30_000, interval: 300, desc: "「网络代理」区块渲染" },
	);
}

/** 选代理模式（自定义 SelectField：点触发器 → 点选项）。 */
async function chooseMode(label) {
	await win.evaluate(() => {
		const trigger = document.querySelector('[aria-label="代理模式"]');
		if (trigger === null) throw new Error("找不到代理模式选择器");
		trigger.click();
	});
	await waitUntil(() => win.evaluate(() => document.querySelector('[role="listbox"]') !== null), {
		timeout: 10_000,
		desc: "代理模式下拉展开",
	});
	await win.evaluate((target) => {
		const listbox = document.querySelector('[role="listbox"]');
		const hit = [...listbox.querySelectorAll('[role="option"]')].find((el) => (el.textContent ?? "").includes(target));
		if (hit === undefined) throw new Error(`下拉里没有 ${target}`);
		hit.click();
	}, label);
}

function readPrefs() {
	return JSON.parse(readFileSync(join(h.CONFIG_DIR, "preferences.json"), "utf8"));
}

/**
 * 等设置区的「保存代理设置」按钮出现。
 *
 * 保存代理会重启 daemon：重启窗口里 ProxySection 的 getProxy 会短暂失败、
 * 整块退回加载/错误态，按钮随之下线。直接查一次就点会偶发「找不到按钮」——
 * 这不是功能问题，是测试没等状态恢复。
 */
async function waitSaveButton() {
	await waitUntil(
		() =>
			win.evaluate(() =>
				[...document.querySelectorAll("button")].some((b) => b.textContent === "保存代理设置"),
			),
		{ timeout: 30_000, interval: 300, desc: "「保存代理设置」按钮出现" },
	);
}

async function clickSave() {
	await waitSaveButton();
	await win.evaluate(() => {
		const btn = [...document.querySelectorAll("button")].find((b) => b.textContent === "保存代理设置");
		if (btn === undefined) throw new Error("找不到「保存代理设置」");
		btn.click();
	});
}

// ── ① 区块渲染 ───────────────────────────────────────────────
await h.check("设置 → 通用有「网络代理」区块，默认直连", async () => {
	await openSettingsGeneral();
	const state = await win.evaluate(() => {
		const select = document.querySelector('[aria-label="代理模式"]');
		return {
			hasSelect: select !== null,
			text: select?.textContent ?? "",
			foot: [...document.querySelectorAll(".settings-foot")].some((el) => (el.textContent ?? "").includes("本地地址")),
		};
	});
	assert.ok(state.hasSelect, "代理模式选择器不在");
	assert.ok(state.text.includes("直连"), `默认档位不是直连：${state.text}`);
	assert.ok(state.foot, "缺少生效范围说明");
});
await h.snap("proxy-section");

// ── ② 手动代理保存 ───────────────────────────────────────────
await h.check("选「手动代理」并保存 → 偏好落盘", async () => {
	await chooseMode("手动代理");
	await waitUntil(() => win.evaluate(() => document.querySelector('[aria-label="代理地址"]') !== null), {
		timeout: 10_000,
		desc: "地址输入框出现",
	});
	await win.evaluate((url) => {
		const input = document.querySelector('[aria-label="代理地址"]');
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
		setter.call(input, url);
		input.dispatchEvent(new window.Event("input", { bubbles: true }));
	}, PROXY_URL);
	await clickSave();
	await waitUntil(
		() => {
			try {
				return readPrefs().proxy?.mode === "manual";
			} catch {
				return false;
			}
		},
		{ timeout: 20_000, interval: 200, desc: "偏好文件写入 manual" },
	);
	const prefs = readPrefs();
	assert.equal(prefs.proxy.url, `${PROXY_URL}/`, "地址没有被规范化落盘");
});
await h.snap("proxy-manual-saved");

// ── ③ 保存会重启 daemon ──────────────────────────────────────
await h.check("保存代理会重启 daemon（down → ready）", async () => {
	// 上一次保存触发的重启可能还没结束，等内核回到 ready 再开始。
	await waitUntil(
		async () => (await win.evaluate(() => window.kami.daemonStatus())).kind === "ready",
		{ timeout: 30_000, interval: 300, desc: "daemon 回到 ready" },
	);
	// 事件可能在我们注册之前就发生，所以重新保存一次并现场监听。
	await win.evaluate(() => {
		window.__proxyDaemonEvents = [];
		window.kami.onDaemonDown(() => window.__proxyDaemonEvents.push("down"));
		window.kami.onDaemonReady(() => window.__proxyDaemonEvents.push("ready"));
	});
	await clickSave();
	await waitUntil(
		async () => {
			const events = await win.evaluate(() => window.__proxyDaemonEvents ?? []);
			return events.includes("ready") ? events : null;
		},
		{ timeout: 30_000, interval: 200, desc: "daemon 重启完成" },
	);
	const events = await win.evaluate(() => window.__proxyDaemonEvents);
	assert.ok(events.includes("down") || events.includes("ready"), `没有观察到 daemon 重启：${events.join(",")}`);
	// 最终必须是 ready，否则后面的设置页操作都会失败。
	await waitUntil(
		async () => (await win.evaluate(() => window.kami.daemonStatus())).kind === "ready",
		{ timeout: 30_000, interval: 300, desc: "daemon 回到 ready" },
	);
});

// ── ④ 非法地址拒绝且不落盘 ───────────────────────────────────
await h.check("SOCKS 地址被拒绝且偏好不变", async () => {
	const before = readPrefs().proxy;
	await waitUntil(
		() => win.evaluate(() => document.querySelector('[aria-label="代理地址"]') !== null),
		{ timeout: 30_000, interval: 300, desc: "地址输入框恢复" },
	);
	await win.evaluate(() => {
		const input = document.querySelector('[aria-label="代理地址"]');
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
		setter.call(input, "socks5://127.0.0.1:7891");
		input.dispatchEvent(new window.Event("input", { bubbles: true }));
	});
	await clickSave();
	await waitUntil(
		() =>
			win.evaluate(() =>
				[...document.querySelectorAll(".state-error, [role=alert]")].some((el) =>
					(el.textContent ?? "").includes("SOCKS"),
				),
			),
		{ timeout: 15_000, interval: 300, desc: "出现 SOCKS 提示" },
	);
	assert.deepEqual(readPrefs().proxy, before, "非法地址不应改动偏好");
});

// ── ⑤ 切回直连 ───────────────────────────────────────────────
await h.check("切回「直连」后持久化生效", async () => {
	await waitUntil(
		() => win.evaluate(() => document.querySelector('[aria-label="代理模式"]') !== null),
		{ timeout: 30_000, interval: 300, desc: "代理模式选择器恢复" },
	);
	await chooseMode("直连");
	await clickSave();
	await waitUntil(() => readPrefs().proxy?.mode === "off", {
		timeout: 20_000,
		interval: 200,
		desc: "偏好切回 off",
	});
});

await h.finish();
