/**
 * 「导出为 Markdown」的 GUI 端到端测试。
 *
 * 渲染逻辑（`src/main/daemon/session-markdown.js`）已由 `tests/unit/session-markdown.test.mjs`
 * 覆盖，其中还包含一条**用真实 SessionManager 读预置会话文件**的集成用例。
 * 本文件补的是只有真实启动 Electron 才暴露的那一层：
 *
 *   ① 会话行的 ⋯ 菜单里**两种导出格式并列**，名称写全（不再是含糊的一个「导出」）
 *   ② 点「导出为 Markdown」→ `exports/*.md` **真的出现在盘上**，内容是这次对话
 *      （标题 / 用户的话 / 助手的话 / 工具名 / 交付的产物路径都在）
 *   ③ 界面给的是**成功**反馈（toast 里带着导出路径），不是错误提示
 *
 * 三条断言都走「菜单项必须在侧栏可视区内」的定位方式 —— 页面内 `btn.click()` 对
 * 看不见的按钮照样成功，不先判可见性的话这条测试就成了摆设。
 *
 * 菜单「空间不足时向上展开」那条修复属于 **#118（会话置顶）**：本轮的置顶项把它推到
 * 会真发生的位置，所以连同它的 GUI 断言一起落在了那个 PR 里。
 *
 * ## 为什么用「预置会话文件」
 *
 * 导出只读会话内容，不需要模型跑一轮（口径同 `tests/e2e/library.mjs`）。预置 .jsonl
 * 比跑一次模型快两个数量级，而且能**精确**控制要导出的内容（工具调用、产物条目这些
 * 在真实对话里不容易稳定复现）。文件配方与 `tests/unit/session-markdown.test.mjs` 的
 * 集成用例同源 —— 两处都验证过 pi 读得出来。
 *
 * ## 反向验证
 *
 * 单元层两条已真跑并还原（见 design.md）：让 `clamp()` 不截断 → 2 条红；
 * 把围栏写死成三个反引号 → 1 条红。
 * GUI 层（本机已真跑全绿，未做注入式反向验证）：
 *   (1) 把 `[INVOKE.sessionExportMarkdown]` 分支删掉 → ②③ 应变红
 *   (2) 把 `renderSessionMarkdown` 的「工具调用」那一段注释掉 → ② 对工具的断言应变红
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const h = createHarness({ name: "export-markdown" });

const SESSIONS_DIR = join(h.CONFIG_DIR, "sessions");
const EXPORTS_DIR = join(h.WORKSPACE_DIR, "exports");
const WS = join(h.WORKSPACE_DIR, "销售分析");
// 目标会话放在**任务区**（目录名匹配 isAutoSessionDirName）：导出只读会话内容，
// 放哪个区都行，选任务区是因为它同时覆盖「任务区会话也能导出」这条路径。
const TASK_CWD = join(h.WORKSPACE_DIR, "2026-10-03-09-00-00");
const ARTIFACT = join(WS, "out", "dashboard.html");
const FIRST_LINE = "把这份数据做成看板";

// ── 预置会话（含工具调用、思考、产物交付 —— 导出该覆盖的几类都在里面）──
mkdirSync(SESSIONS_DIR, { recursive: true });
mkdirSync(WS, { recursive: true });
mkdirSync(TASK_CWD, { recursive: true });
mkdirSync(join(WS, "out"), { recursive: true });
writeFileSync(ARTIFACT, "<html>看板</html>");

const stamp = (n) => `2026-10-03T10:00:0${n}.000Z`;
const message = (id, parentId, n, payload) =>
	JSON.stringify({ type: "message", id, parentId, timestamp: stamp(n), message: { timestamp: Date.parse(stamp(n)), ...payload } });

writeFileSync(
	join(SESSIONS_DIR, "2026-10-03T10-00-00-000Z_export-e2e.jsonl"),
	`${[
		JSON.stringify({ type: "session", version: 3, id: "export-e2e", timestamp: stamp(0), cwd: TASK_CWD }),
		JSON.stringify({ type: "model_change", id: "m1", parentId: null, timestamp: stamp(0), provider: "storefront", modelId: "model-x" }),
		message("u1", "m1", 1, { role: "user", content: [{ type: "text", text: FIRST_LINE }] }),
		message("a1", "u1", 2, {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "先读数据再聚合" },
				{ type: "text", text: "做好了，看板已经生成。" },
				{ type: "toolCall", id: "tc-1", name: "read_document", arguments: { path: "sales.csv" } },
			],
			stopReason: "toolUse",
		}),
		message("r1", "a1", 3, {
			role: "toolResult",
			toolCallId: "tc-1",
			toolName: "read_document",
			content: [{ type: "text", text: "date,amount" }],
			isError: false,
		}),
		JSON.stringify({
			type: "custom",
			id: "art1",
			parentId: "r1",
			timestamp: stamp(4),
			customType: "artifacts_presented",
			data: { files: [{ path: ARTIFACT, size: 20, html: true, kind: "local" }], focusFile: ARTIFACT },
		}),
	].join("\n")}\n`,
);

await h.launch();
const win = h.window();

/** 打开某个会话行的 ⋯ 菜单（按标题定位）。 */
const openRowMenu = async (title) => {
	const ok = await win.evaluate((t) => {
		const row = [...document.querySelectorAll(".sidebar .task-item")].find(
			(r) => (r.querySelector(".task-item-title")?.textContent ?? "").trim() === t,
		);
		if (row === undefined) return false;
		const btn = row.querySelector(".task-item-ops .task-op-btn");
		if (btn === undefined) return false;
		btn.click();
		return true;
	}, title);
	assert.ok(ok, `找不到会话行「${title}」或它的 ⋯ 按钮`);
	await waitUntil(() => win.evaluate(() => document.querySelector(".task-op-menu") !== null), {
		timeout: 15_000,
		desc: "⋯ 菜单展开",
	});
};

/** 菜单条目文案。 */
const menuItems = () =>
	win.evaluate(() =>
		[...document.querySelectorAll(".task-op-menu .space-menu-item")].map((b) => (b.textContent ?? "").trim()),
	);

/**
 * 点菜单里文案精确匹配的条目。
 *
 * **先断言这一项真的落在侧栏可视区里**再点（口径与 `tests/e2e/session-pin.mjs` 一致）：
 * 菜单是绝对定位挂在行上的，而它的裁剪祖先是 `.sidebar-scroll`；靠下的行、项数多的
 * 菜单可能落到可视区之外，那时页面内 `btn.click()` 仍然「成功」，测试照样绿。
 */
const clickMenuItem = async (label) => {
	const box = await win.evaluate((l) => {
		const btn = [...document.querySelectorAll(".task-op-menu .space-menu-item")].find(
			(b) => (b.textContent ?? "").trim() === l,
		);
		if (btn === undefined) return null;
		const rect = btn.getBoundingClientRect();
		const view = document.querySelector(".sidebar-scroll")?.getBoundingClientRect();
		return {
			w: rect.width,
			h: rect.height,
			top: rect.top,
			bottom: rect.bottom,
			viewTop: view?.top ?? null,
			viewBottom: view?.bottom ?? null,
		};
	}, label);
	assert.ok(box !== null, `菜单里没有「${label}」这一项`);
	assert.ok(
		box.viewTop !== null && box.top >= box.viewTop - 1 && box.bottom <= box.viewBottom + 1,
		`菜单项「${label}」落在侧栏可视区之外，点它等于点了一个看不见的按钮：${JSON.stringify(box)}`,
	);
	const ok = await win.evaluate((l) => {
		const btn = [...document.querySelectorAll(".task-op-menu .space-menu-item")].find(
			(b) => (b.textContent ?? "").trim() === l,
		);
		if (btn === undefined) return false;
		btn.click();
		return true;
	}, label);
	assert.ok(ok, `菜单里没有「${label}」这一项`);
};

/** 盘上最新的那个 .md（导出文件名带时间戳，不预测名字）。 */
const latestMarkdown = () => {
	if (!existsSync(EXPORTS_DIR)) return null;
	const files = readdirSync(EXPORTS_DIR)
		.filter((name) => name.endsWith(".md"))
		.sort();
	return files.length === 0 ? null : join(EXPORTS_DIR, files[files.length - 1]);
};

// ══ ① 菜单里两种格式并列 ═════════════════════════════════════
await h.check("① ⋯ 菜单里「导出为 HTML」与「导出为 Markdown」并列，名称写全", async () => {
	await openRowMenu(FIRST_LINE);
	const items = await menuItems();
	assert.ok(items.includes("导出为 HTML"), `菜单里应有「导出为 HTML」：${JSON.stringify(items)}`);
	assert.ok(items.includes("导出为 Markdown"), `菜单里应有「导出为 Markdown」：${JSON.stringify(items)}`);
	assert.ok(!items.includes("导出"), "含糊的单项「导出」应已被两个具名项取代");
	// 先截图后断言：菜单打开的现场要留图。
	await h.shoot("menu-with-export-formats");
});

// ══ ② 导出真的落盘，且内容是这次对话 ═════════════════════════
await h.check("② 点「导出为 Markdown」→ exports/*.md 落盘，内容含这次对话", async () => {
	await clickMenuItem("导出为 Markdown");
	await waitUntil(() => win.evaluate(() => document.querySelector(".task-op-menu") === null), {
		timeout: 15_000,
		desc: "⋯ 菜单收起",
	});
	// 非当前会话**不会**被恢复（只读打开会话文件），所以这里等的是文件真的出现。
	const file = await waitUntil(
		() => {
			const hit = latestMarkdown();
			return hit === null ? null : hit;
		},
		{ timeout: 30_000, desc: "exports/ 下出现 .md" },
	);
	const md = readFileSync(file, "utf8");

	assert.ok(md.startsWith(`# ${FIRST_LINE}\n`), `一级标题应是会话标题：${md.slice(0, 60)}`);
	assert.ok(md.includes("- 由 ZeroWork 导出"), "元信息行缺失");
	// 会话的 cwd 是任务区目录（见文件头的预置说明）——导出的元信息应当如实写它。
	assert.ok(md.includes(`- 工作空间：\`${TASK_CWD}\``), `工作空间没写进元信息：${md.slice(0, 200)}`);
	assert.ok(md.includes("## 你"), "缺少用户段");
	assert.ok(md.includes("## ZeroWork"), "缺少助手段");
	assert.ok(md.includes("做好了，看板已经生成。"), "助手正文没进去");
	assert.ok(md.includes("> 思考"), "思考段没进去");
	assert.ok(md.includes("**工具调用：read_document**"), "工具调用没进去");
	assert.ok(md.includes("date,amount"), "工具结果没进去");
	assert.ok(md.includes("交付的产物") && md.includes(ARTIFACT), "交付的产物没进去");

	// 同一份会话导出的两种格式落在同一个目录：html 那次不在本轮，这里只确认目录契约成立。
	assert.equal(file.startsWith(EXPORTS_DIR), true, `导出文件应落在 exports/ 下：${file}`);
});

// ══ ③ 界面反馈是成功，不是报错 ═══════════════════════════════
await h.check("③ 界面上是成功反馈（toast 带导出路径），不是错误提示", async () => {
	const toast = await waitUntil(
		() =>
			win.evaluate(() => {
				const stack = document.querySelector(".toast-stack");
				if (stack === null) return null;
				const node = [...stack.querySelectorAll(".toast")].find((t) =>
					(t.textContent ?? "").includes("已导出"),
				);
				if (node === undefined) return null;
				return { text: (node.textContent ?? "").trim(), success: node.classList.contains("toast-success") };
			}),
		{ timeout: 15_000, desc: "出现「已导出」toast" },
	);
	assert.equal(toast.success, true, `导出成功的提示应是 success 样式：${JSON.stringify(toast)}`);
	assert.ok(toast.text.includes(".md"), `toast 里应带导出路径：${toast.text}`);
});

await h.finish();
