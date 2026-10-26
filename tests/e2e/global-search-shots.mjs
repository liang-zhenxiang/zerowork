/**
 * ⌘K 全局搜索（#286）的交付截图：两张
 *   01 面板输入关键词后「正文命中」分组 + snippet 副行
 *   02 Enter 跳回原会话、目标消息 entry-flash 高亮
 * 种子手法与 command-palette.mjs ⑬ 一致（那里有完整注释）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const h = createHarness({ name: "global-search-shots", shots: true });
const mock = await startMockModelServer({ models: ["palette-mock"] });

const SD = join(h.CONFIG_DIR, "sessions");
mkdirSync(SD, { recursive: true });
function msg(id, parentId, role, text) {
	return JSON.stringify({ type: "message", id, parentId, timestamp: new Date().toISOString(),
		message: { role, content: [{ type: "text", text }] } });
}
writeFileSync(join(SD, "2026-10-26T22-00-00-gsaa-000Z_s1.jsonl"),
	[JSON.stringify({ type: "session", version: 3, id: "cccccccc-cccc-7ccc-8ccc-cccccccccccc", timestamp: new Date().toISOString(), cwd: h.WORKSPACE_DIR }),
	 msg("m1", null, "user", "帮我查一下锰铜合金的电阻率"),
	 msg("m2", "m1", "assistant", "锰铜合金电阻率约 4.4×10⁻⁷ Ω·m，温漂极低，适合做精密采样电阻。")].join("\n") + "\n");
mkdirSync(h.WORKSPACE_DIR, { recursive: true });
writeFileSync(resolve(h.WORKSPACE_DIR, "README.md"), "# gs\n");

await h.launch();
const win = h.window();
await waitUntil(() => win.evaluate(() => globalThis.kami !== undefined), { timeout: 10_000, desc: "kami 就绪" });

// resume 需要「已选模型」
await win.evaluate(async (m) => {
	const k = globalThis.kami;
	await k.saveCustomProvider({ id: "palette-mock", name: "PM", baseUrl: m.baseUrl, api: "openai-completions", authHeader: true,
		models: [{ id: "palette-mock-model", name: "pm", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }] }, "mk");
	await k.setModel("palette-mock/palette-mock-model");
	await k.setWorkspace(m.ws);
}, { baseUrl: mock.baseUrl, ws: h.WORKSPACE_DIR });

const MOD = process.platform === "darwin" ? "Meta" : "Control";
await win.keyboard.press(`${MOD}+k`);
await waitUntil(() => win.evaluate(() => document.querySelector(".command-palette") !== null), { timeout: 8_000, desc: "面板打开" });
await win.locator(".command-palette input, .command-palette textarea").first().fill("精密采样");
await waitUntil(() => win.evaluate(() => [...document.querySelectorAll('.command-palette [role="option"] .ac-subtitle')].some((e) => (e.textContent ?? "").includes("精密采样"))), { timeout: 15_000, desc: "正文命中 + snippet 副行出现" });
await win.waitForTimeout(400); // 等 ac-subtitle 布局稳定
await h.shoot("01-palette-hit");

await win.keyboard.press("Enter");
await waitUntil(() => win.evaluate(() => document.querySelector(".entry-flash") !== null), { timeout: 15_000, desc: "跳回原消息并高亮" });
await win.waitForTimeout(300); // flash 动画起帧
await h.shoot("02-jump-flash");

await h.finish();
mock.close();
