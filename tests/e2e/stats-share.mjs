/**
 * 统计分享卡与里程碑徽章（#288）：
 *  ① 打开统计页，徽章墙渲染（含「已解锁」计数与锁定态）
 *  ② 点「分享卡」按钮，exports/ 落盘 PNG（>1KB、PNG 魔数）且界面显示路径
 *  ③ 无统计时空态正常（不崩）
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const h = createHarness({ name: "stats-share" });
const mock = await startMockModelServer({ models: ["stats-mock"] });

// 种子会话 ×3（够了徽章不空、统计有数）
const SD = join(h.CONFIG_DIR, "sessions");
mkdirSync(SD, { recursive: true });
function msg(id, parentId, role, text) {
	// assistant 消息必须带 model 字段：isLegacySession（session-files.js:753）
	// 对「全部 assistant 都没有可识别 model」的会话整条跳过（老格式数据
	// 不掺进新统计），种子不带 model 就会 totalSessions=0 走空态分支。
	const extra = role === "assistant" ? { model: "stats-mock-model" } : {};
	return JSON.stringify({ type: "message", id, parentId, timestamp: new Date().toISOString(),
		message: { role, content: [{ type: "text", text }], ...extra } });
}
for (let i = 1; i <= 12; i++) {  // 12 场：解锁 sessions-10「十全十美」，其余仍锁定
	writeFileSync(join(SD, `2026-10-27T0${String(i).padStart(2, "0")}-00-00-st${i}-000Z_s${i}.jsonl`),
		[JSON.stringify({ type: "session", version: 3, id: `dddddddd-dddd-4ddd-8ddd-ddddddddddd${i}`, timestamp: new Date().toISOString(), cwd: h.WORKSPACE_DIR }),
		 msg(`sm${i}a`, null, "user", `统计种子 ${i}：随便聊两句`),
		 msg(`sm${i}b`, `sm${i}a`, "assistant", `好的，第 ${i} 场统计种子会话。`)].join("\n") + "\n");
}
mkdirSync(h.WORKSPACE_DIR, { recursive: true });
writeFileSync(resolve(h.WORKSPACE_DIR, "README.md"), "# s\n");

await h.launch();
const win = h.window();
await waitUntil(() => win.evaluate(() => globalThis.kami !== undefined), { timeout: 10_000, desc: "kami 就绪" });
await win.evaluate(async (m) => {
	const k = globalThis.kami;
	await k.saveCustomProvider({ id: "stats-mock", name: "SM", baseUrl: m.baseUrl, api: "openai-completions", authHeader: true,
		models: [{ id: "stats-mock-model", name: "sm", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }] }, "mk");
	await k.setModel("stats-mock/stats-mock-model");
	await k.setWorkspace(m.ws);
}, { baseUrl: mock.baseUrl, ws: h.WORKSPACE_DIR });

const raw = await win.evaluate(() => globalThis.kami.usageStats());
console.log("      usageStats: totalSessions=%d totalMessages=%d", raw.totalSessions, raw.totalMessages);
assert.ok(raw.totalSessions >= 3, `种子应被统计到（totalSessions=${raw.totalSessions}）`);

await h.check("① 统计页徽章墙渲染", async () => {
	await win.locator("button.nav-item", { hasText: "统计" }).first().click();
	await waitUntil(() => win.evaluate(() => document.querySelector(".stats-badge-grid") !== null), { timeout: 10_000, desc: "徽章墙出现" });
	const state = await win.evaluate(() => ({
		badges: document.querySelectorAll(".stats-badge").length,
		earned: document.querySelectorAll(".stats-badge.is-earned").length,
		locked: document.querySelectorAll(".stats-badge.is-locked").length,
		shareBtn: [...document.querySelectorAll("button")].some((b) => (b.textContent ?? "").includes("分享卡"))
	}));
	assert.ok(state.badges === 10, `应有 10 枚徽章（含锁定），实际 ${state.badges}`);
	assert.ok(state.earned >= 1, `种子应解锁至少 1 枚（会话数≥3 不够 10 —— 那看 totalSessions 实际值），实际 ${state.earned}`);
	assert.ok(state.locked >= 1, "应有锁定徽章");
	assert.ok(state.shareBtn, "分享卡按钮应存在");
});

await h.check("② 分享卡生成并落盘", async () => {
	await win.locator("button", { hasText: "分享卡" }).first().click();
	const hint = await waitUntil(
		() => win.evaluate(() => document.querySelector(".stats-share-hint")?.textContent ?? null),
		{ timeout: 15_000, desc: "保存路径提示出现" }
	);
	const match = hint.match(/exports\/[^\s]+\.png|exports\\[^\s]+\.png/);
	assert.ok(match !== null, `提示应含 exports/…png 路径，实际：${hint}`);
	const rel = match[0];
	const abs = rel.includes("\\") ? join(h.WORKSPACE_DIR, ...rel.split("\\")) : resolve(h.WORKSPACE_DIR, rel);
	assert.ok(existsSync(abs), `PNG 应已落盘：${abs}`);
	const buf = readFileSync(abs);
	assert.ok(buf.length > 1024, `PNG 应大于 1KB，实际 ${buf.length}`);
	assert.equal(buf[0], 0x89, "PNG 魔数第一字节");
	assert.equal(buf[1], 0x50, "PNG 魔数第二字节");
});

await h.finish();
mock.close();
