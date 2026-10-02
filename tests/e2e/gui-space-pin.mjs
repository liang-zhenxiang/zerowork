/**
 * 侧栏「当前工作空间」置顶与徽标的 GUI 测试（issue #73）。
 *
 * 前提修正后的实际缺口（见 issue 评论）：分组/单组折叠/重命名/移除此前已在，
 * 本用例锁的是新增的两样——
 *   ① 当前工作空间的组**置顶**（其余组保持最近活动序）；
 *   ② 当前组头的「当前」**文字徽标**与组名主色（位置+文字承担状态，
 *      不只靠颜色）。
 *
 * 路径：mock 模型 + 真实 UI 发消息，在两个工作空间各建一个会话，
 * 断言第二空间成为当前后它排在空间区第一且带徽标。
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const mock = await startMockModelServer();
console.log(`✓ mock 模型服务已就绪：${mock.baseUrl}`);

const h = createHarness({ name: "space-pin" });
const SPACE_A = join(h.WORKSPACE_DIR, "项目A");
const SPACE_B = join(h.WORKSPACE_DIR, "项目B");
mkdirSync(SPACE_A, { recursive: true });
mkdirSync(SPACE_B, { recursive: true });

await h.launch();
const win = h.window();

/** 在指定工作空间用真实 UI 路径发一条消息（建会话）。 */
async function sendInSpace(space, text) {
	// 在指定空间新建任务（与侧栏「在某空间新建」同一 IPC）：setWorkspace 只改
	// daemon 默认值，当前已打开会话的 cwd 不动，首页发消息会续建到旧空间——
	// 第一次跑就因此两条会话挤在同一组。newTask 会真切换当前会话。
	await win.evaluate(async (ws) => {
		await globalThis.kami.newTask(ws);
	}, space);
	await waitUntil(
		async () => await win.evaluate(async (ws) => {
			// kami.snapshot() 无参返回当前会话状态（daemon currentBucket.conversation），
			// 新建会话的 cwd 就取自这里的 state.cwd。
			const snap = await globalThis.kami.snapshot().catch(() => void 0);
			return snap?.state?.cwd === ws;
		}, space),
		{ timeout: 20_000, interval: 400, desc: `会话状态 cwd 换到 ${space}` },
	);
	const box = win.locator('[aria-label="消息输入框"]');
	await box.waitFor({ state: "visible", timeout: 30_000 });
	await box.fill(text);
	await box.press("Enter");
	const before = mock.requests.length;
	await waitUntil(() => mock.requests.length >= before + 1, {
		timeout: 40_000,
		interval: 500,
		desc: `mock 收到「${text}」的请求`,
	});
	await waitUntil(
		() => win.evaluate(() => document.body.innerText.includes("mock 模型的回复")),
		{ timeout: 30_000, interval: 500, desc: "回复渲染出来" },
	);
}

await h.check("注册 mock provider", async () => {
	const r = await win.evaluate(async ({ baseUrl }) => {
		const k = globalThis.kami;
		try {
			await k.saveCustomProvider(
				{
					id: "mock-pin",
					name: "Mock Pin",
					baseUrl,
					api: "openai-completions",
					authHeader: true,
					models: [{ id: "pin-model", name: "pin-model", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }],
				},
				"mock-key",
			);
			await k.setModel("mock-pin/pin-model");
			return { ok: true };
		} catch (e) {
			return { ok: false, err: String(e?.message ?? e).slice(0, 200) };
		}
	}, { baseUrl: mock.baseUrl });
	assert.ok(r.ok, `配置失败：${r.err}`);
});

await h.check("在两个工作空间各建一个会话", async () => {
	await sendInSpace(SPACE_A, "整理项目A的周报");
	await sendInSpace(SPACE_B, "核对项目B的预算");
});

await h.check("当前工作空间（项目B）置顶且带「当前」徽标", async () => {
	const r = await waitUntil(
		async () =>
			await win.evaluate(() => {
				const headers = [...document.querySelectorAll(".space-group-header")];
				if (headers.length < 2) return { found: false, count: headers.length };
				const first = headers[0];
				return {
					found: true,
					firstIsCurrent: first.classList.contains("space-group-current"),
					firstBadge: first.querySelector(".space-group-badge")?.textContent ?? null,
					firstName: first.querySelector(".space-group-name")?.textContent ?? null,
					secondName: headers[1]?.querySelector(".space-group-name")?.textContent ?? null,
				};
			}),
		{ timeout: 30_000, interval: 500, desc: "空间区出现两组" },
	);
	assert.ok(r.found, `空间区组数不足：${r.count}`);
	assert.ok(r.firstIsCurrent, `第一组没有 space-group-current（置顶的应是当前空间，读到 ${r.firstName}）`);
	assert.equal(r.firstBadge, "当前", `第一组徽标文字是 ${r.firstBadge}`);
	assert.ok(String(r.firstName).includes("项目B"), `置顶组应是项目B，读到 ${r.firstName}`);
	assert.ok(String(r.secondName).includes("项目A"), `第二组应是项目A，读到 ${r.secondName}`);
});
await h.waitForSettled();
await h.shoot("space-pin");

// 反向验证：切回项目A，置顶随之换位（不是写死的）
await h.check("切回项目A后置顶换位（跟随当前，非静态）", async () => {
	await win.evaluate(async (ws) => {
		await globalThis.kami.newTask(ws);
	}, SPACE_A);
	await waitUntil(
		async () =>
			await win.evaluate(() => {
				const first = document.querySelector(".space-group-header");
				return first?.querySelector(".space-group-name")?.textContent?.includes("项目A") ?? false;
			}),
		{ timeout: 30_000, interval: 500, desc: "项目A 组升到第一位" },
	);
	await h.waitForSettled();
	await h.shoot("space-pin-switched");
});

await h.finish();
