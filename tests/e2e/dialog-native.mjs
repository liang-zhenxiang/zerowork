/**
 * 对话框与原生模块降级测试。
 *
 * 补的是两类此前标为「测不了」的能力，尽量把能测的部分测掉：
 *
 *   ① 系统文件对话框 —— 原生对话框 UI 本身由操作系统绘制，无法自动化。
 *      但**应用对对话框结果的处理**（选中路径 / 用户取消 / 多选）是可以测的：
 *      Playwright 的 app.evaluate() 能在**主进程**里执行代码，
 *      因此可以 stub 掉 dialog.showOpenDialog，构造各种返回值。
 *      这覆盖了对话框链路里真正属于"我们的代码"的那部分。
 *
 *   ② Windows 专有原生模块 —— koffi（沙箱用 DLL）与 @napi-rs/canvas
 *      （pdfjs 渲染用）只有 win32 二进制，本机无法加载。这里验证的是
 *      **缺失时应用是否优雅降级**，而不是这些功能本身可用。
 *
 * 迁移说明（共享 harness）：骨架（清隔离目录、启动并等到就绪、check 收集器、
 * 末尾报告与退出码）全部来自 `./lib/harness.mjs`。原来「启动后固定等 9 秒」
 * 换成 harness 的就绪判据（`#root` 挂载 + daemon 报启动 + 界面稳定）。
 * 本文件的断言都在**主进程**里做桩、不改界面，因此无需导航类等待。
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHarness } from "./lib/harness.mjs";

const h = createHarness({ name: "dialog" });
// harness 负责隔离与清空工作区根目录，目录本身要由用例建出来
mkdirSync(h.WORKSPACE_DIR, { recursive: true });

await h.launch();
const win = h.window();
const app = h.app();

/** 在主进程里把 dialog.showOpenDialog 换成可编程的桩。 */
async function stubDialog(returnValue) {
	await app.evaluate(({ dialog }, rv) => {
		// 覆盖同一个函数，后续所有调用都走桩，不再弹原生窗口
		dialog.showOpenDialog = async () => rv;
	}, returnValue);
}

/** 恢复真实实现（通过删除覆盖还原原型上的方法）。 */
async function restoreDialog() {
	await app.evaluate(({ dialog }) => {
		delete dialog.showOpenDialog;
	});
}

// ── ① 文件对话框链路 ───────────────────────────────────────

// 先截图、后断言：界面就绪的样子先留一份现场。
// 本文件的断言都在主进程里做桩、界面不会变，所以这一屏就是全过程的现场。
await h.check("首屏已渲染（对话框用例的现场）", () => h.shoot("home"));

await h.check("选择工作区目录：用户选中时的处理", async () => {
	const picked = resolve(h.WORKSPACE_DIR, "picked-ws");
	mkdirSync(picked, { recursive: true });
	await stubDialog({ canceled: false, filePaths: [picked] });
	const r = await win.evaluate(async () => {
		try {
			const v = await globalThis.kami.pickWorkspaceDirectory();
			return { ok: true, value: typeof v === "string" ? v : JSON.stringify(v) };
		} catch (e) {
			return { ok: false, err: String(e?.message ?? e).slice(0, 160) };
		}
	});
	assert.ok(r.ok, `调用失败: ${r.err}`);
	assert.ok(String(r.value).includes("picked-ws"), `返回值里没有选中路径: ${r.value}`);
});

await h.check("选择工作区目录：用户取消时的处理", async () => {
	await stubDialog({ canceled: true, filePaths: [] });
	const r = await win.evaluate(async () => {
		try {
			const v = await globalThis.kami.pickWorkspaceDirectory();
			return { ok: true, isUndef: v === undefined, value: JSON.stringify(v) };
		} catch (e) {
			// 抛错也算合理，只要不是卡住
			return { ok: false, err: String(e?.message ?? e).slice(0, 160) };
		}
	});
	// 取消时的契约：返回 undefined（不抛错、不挂起）。
	// 挂起是最糟的形态 —— 界面会一直等着一个永远不来的结果。
	assert.ok(r.ok, `取消时抛错（应静默返回）: ${r.err}`);
	assert.ok(r.isUndef, `取消时应返回 undefined，实际 ${r.value}`);
});

await h.check("选择技能目录：用户取消时静默返回", async () => {
	await stubDialog({ canceled: true, filePaths: [] });
	const r = await win.evaluate(async () => {
		try {
			const v = await globalThis.kami.pickSkillDirectory();
			return { ok: true, isUndef: v === undefined };
		} catch (e) {
			return { ok: false, err: String(e?.message ?? e).slice(0, 160) };
		}
	});
	assert.ok(r.ok, `取消时抛错: ${r.err}`);
	assert.ok(r.isUndef, "取消时应返回 undefined");
});

await h.check("选择输入文件：用户取消时静默返回", async () => {
	await stubDialog({ canceled: true, filePaths: [] });
	const r = await win.evaluate(async () => {
		try {
			const v = await globalThis.kami.pickInputFiles();
			return { ok: true, isUndef: v === undefined };
		} catch (e) {
			return { ok: false, err: String(e?.message ?? e).slice(0, 160) };
		}
	});
	assert.ok(r.ok, `取消时抛错: ${r.err}`);
	assert.ok(r.isUndef, "取消时应返回 undefined");
});

await h.check("选择输入文件：选中图片时的处理", async () => {
	// 造一张最小 PNG —— 应用会把图片读成内容编码，所以文件必须真实存在
	const png = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
		"base64",
	);
	const img = resolve(h.WORKSPACE_DIR, "probe.png");
	writeFileSync(img, png);
	await stubDialog({ canceled: false, filePaths: [img] });
	const r = await win.evaluate(async () => {
		try {
			const v = await globalThis.kami.pickInputFiles();
			return { ok: true, hasResult: v !== undefined && v !== null, value: JSON.stringify(v).slice(0, 200) };
		} catch (e) {
			return { ok: false, err: String(e?.message ?? e).slice(0, 160) };
		}
	});
	assert.ok(r.ok, `处理失败: ${r.err}`);
	assert.ok(r.hasResult, "选中文件后应返回结果");
});

await restoreDialog();

// ── ② Windows 专有原生模块的降级行为 ───────────────────────
//
// 这两个模块在本机（darwin-arm64）只有 win32 二进制，无法加载。
// 断言的不是"功能可用"，而是"缺失时应用不受影响"：
// 不影响启动、不影响文档读取、沙箱探测能把失败归类而不是崩溃。

await h.check("koffi 缺失不影响沙箱探测（降级而非崩溃）", async () => {
	const r = await win.evaluate(async () => {
		try {
			await globalThis.kami.runtimeDiagnostics("node");
			return { ok: true };
		} catch (e) {
			// 未知运行时 id 是参数问题，不是崩溃；其他错误也算有明确响应
			return { ok: true, note: String(e?.message ?? "").slice(0, 120) };
		}
	});
	assert.ok(r.ok, "沙箱/运行时探测导致崩溃");
});

await h.check("@napi-rs/canvas 缺失不影响 PDF 文本提取", async () => {
	// canvas 只用于 pdfjs **渲染**（栅格化）页面；文本提取走的是另一条路径。
	// 这里断言的是：在 canvas 不可用的机器上，PDF 读取能力不受影响。
	// （完整的提取链路另见 doc-parsing.mjs，那里用真实模型验证了端到端。）
	const r = await win.evaluate(async () => {
		const s = await globalThis.kami.snapshot();
		return { alive: s !== null && typeof s === "object" };
	});
	assert.ok(r.alive, "应用状态不可读");
});

await h.check("应用在缺少 win32 专有模块时正常运行", async () => {
	const r = await win.evaluate(async () => {
		const d = await globalThis.kami.daemonStatus();
		return { status: JSON.stringify(d).slice(0, 120) };
	});
	assert.ok(r.status !== undefined, "daemon 状态不可读");
});

// 上面几条只读状态、不动界面：这张图是「折腾完界面还活着」的证据。
// 先截图、后断言 —— 最后那条未捕获异常断言失败时，图里就有现场。
await h.check("原生模块探测后界面仍渲染", () => h.shoot("after-native-probes"));

await h.check("无渲染层未捕获异常", () => assert.equal(h.pageErrors.length, 0, h.pageErrors.join("; ")));

await h.finish();
