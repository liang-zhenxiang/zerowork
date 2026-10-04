/**
 * 会话置顶（pin）的 GUI 端到端测试。
 *
 * 纯逻辑（排序 / 折叠窗口）与索引落盘已由单测覆盖：
 *   - `tests/unit/session-pin-order.test.mjs`（session-pin.js）
 *   - `tests/unit/session-pin-store.test.mjs`（daemon 的 pin.js）
 * **本文件补的是只有真实启动 Electron 才暴露的那层**：⋯ 菜单里真的有这一项、
 * 点了之后侧栏真的重排、钉标记真的渲染出来、键盘真的够得着那一组行内操作、
 * 重启之后置顶真的还在、以及深浅两套主题下的画面。
 *
 * ## 十二条断言
 *
 *   ① 预置 7 条任务区会话 → 默认只显示 5 行 + 「查看更多 (2)」（**截断基线**：
 *      这条不成立的话，⑤ 的「置顶不被截断」就没有意义）
 *   ② ⋯ 菜单里有「置顶」；点它 → 该行移到任务区最前 + 出现钉标记 + 菜单项变「取消置顶」
 *   ③ 键盘可达：Tab 从行主体进入 ⋯ 时它真的**可见**（opacity 变 1）
 *   ④ 分区内置顶：置顶空间组里的一条 → 该组内排最前，且**任务区不受影响**
 *   ⑤ 置顶不被折叠截断：用 IPC 置顶默认被折叠的那条 → 折叠态下它出现在可见行里
 *   ⑥ `pins.json` 真的落盘（读文件，不看内存）
 *   ⑦ 取消置顶 → 回到按最近活动排序，钉标记消失
 *   ⑧ **真实重启** → 置顶仍在（daemon 读回索引）
 *   ⑨ 浅色 + 深色两套主题截图（`h.shoot` 自带像素断言）
 *   ⑩ 归档：会话从侧栏收起、置顶记录保留；**取消归档后置顶原样回来**
 *   ⑪ 重命名：置顶跟着走（同一个会话文件，path 不变）
 *   ⑫ 删除：会话消失、列表不抛错，置顶记录成为**不显示的悬空项**（按设计不自动清理）
 *
 * ## 为什么用「预置会话文件」而不是跑模型
 *
 * 置顶不依赖模型：它只读会话**列表**（daemon 的 listSessions）。预置 .jsonl 比跑
 * 一个模型回合快两个数量级、也不依赖网络（口径同 tests/e2e/library.mjs）。
 * 文件配方取自 pi 的 session 格式：header（含 cwd）+ 一条 user 消息。
 *
 * ⚠️ 排序真值是**条目里的时间戳**，不是文件 mtime —— 这条是实测出来的，
 * 不能靠猜：pi 的 `buildSessionInfo` 取 modified 的顺序是
 * 「最后一条消息条目自带的 timestamp → header.timestamp → **最后才**是 stat 的 mtime」
 * （写这条用例时先在 Node 里跑了一遍 `SessionManager.listAll` 才看清）。
 * 所以预置会话必须把 header 与消息的 timestamp 都写成确定值；`utimesSync` 顺手
 * 一起写，是为了「万一上游改成按 mtime 排」时顺序仍然对得上 —— 两道都钉住。
 *
 * ⚠️ 任务区 / 空间区由 cwd 决定：cwd 的目录名匹配 `YYYY-MM-DD-HH-MM-SS`
 * （isAutoSessionDirName）或空串 → 任务区；否则按 cwd 分组进空间区。
 * 任务区才会走「折叠到 5 行」，所以 ⑤ 用的那 7 条必须落在任务区。
 *
 * ## 反向验证（本机能跑的两条真跑了并还原，见 design.md）
 *
 * 单测层面的反向验证已真跑（去掉置顶比较键 → 2 条红；去掉 persist() → 6 条红）。
 * GUI 层面的这两条**需要真实图形环境**，本次会话的沙箱里 Electron 起不来
 * （进程在 HIServices 的 _RegisterApplication 处 SIGABRT，见 PR 说明），
 * 未能在本机实跑 —— 这是本用例唯一没有反向验证记录的部分，已在 PR 里如实标注：
 *   (1) 把 `groupSessions` 的 `sortSessionsByPin` 换回 `byModifiedDesc` → ②④⑦⑧ 应变红
 *   (2) 把 daemon 的 `[INVOKE.sessionPin]` 分支删掉 → ②④⑤⑥⑦⑧⑩ 应变红
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const h = createHarness({ name: "pin" });

const SESSIONS_DIR = join(h.CONFIG_DIR, "sessions");
const PINS_FILE = join(h.CONFIG_DIR, "pins.json");
// 任务区 cwd：目录名匹配 isAutoSessionDirName（`YYYY-MM-DD-HH-MM-SS`）即归任务区。
const TASK_CWD = join(h.WORKSPACE_DIR, "2026-10-03-12-00-00");
// 空间区 cwd：普通目录名 → 以目录名成组。
const SPACE_A = join(h.WORKSPACE_DIR, "项目甲");

// ── 预置会话 ───────────────────────────────────────────────────
let seq = 0;

/** 写一个会话文件，把它的时间戳钉到 `ageMinutes` 分钟之前（越大越旧）。 */
function seedSession({ id, cwd, text, ageMinutes }) {
	seq += 1;
	const name = `2026-10-03T12-00-${String(seq).padStart(2, "0")}-000Z_${id}.jsonl`;
	const file = join(SESSIONS_DIR, name);
	const at = new Date(Date.now() - ageMinutes * 60_000);
	const iso = at.toISOString();
	const lines = [
		JSON.stringify({ type: "session", version: 3, id, timestamp: iso, cwd }),
		JSON.stringify({
			type: "message",
			id: `${id}-m0`,
			parentId: null,
			timestamp: iso,
			message: { role: "user", content: [{ type: "text", text }] },
		}),
	];
	writeFileSync(file, `${lines.join("\n")}\n`);
	utimesSync(file, at, at);
	return { path: file, title: text };
}

mkdirSync(SESSIONS_DIR, { recursive: true });
mkdirSync(TASK_CWD, { recursive: true });
mkdirSync(SPACE_A, { recursive: true });

// 任务区 7 条：会话一最新 … 会话七最旧（决定「谁该在第一行」）。
const TASKS = [1, 2, 3, 4, 5, 6, 7].map((n) =>
	seedSession({ id: `aaaaaaa${n}-1111-7111-8111-11111111111${n}`, cwd: TASK_CWD, text: `会话${n}`, ageMinutes: n }),
);
// 空间区 2 条：A 最新、B 较旧（用于验证组内置顶）。A 只用来当「组内第二名」，
// 不需要引用它的 path —— 断言全部按标题定位。
seedSession({ id: "bbbbbbb1-2222-7222-8222-222222222221", cwd: SPACE_A, text: "空间会话 A", ageMinutes: 10 });
const SPACE_OLD = seedSession({ id: "bbbbbbb2-2222-7222-8222-222222222222", cwd: SPACE_A, text: "空间会话 B", ageMinutes: 11 });

await h.launch();
let win = h.window();

// ── DOM 工具 ───────────────────────────────────────────────────

/** 一次求值读出侧栏的完整结构：任务区行 + 各空间组的行（顺序即视觉顺序）。 */
const readLayout = () =>
	win.evaluate(() => {
		const rowsOf = (container) =>
			[...container.querySelectorAll(".task-item")].map((row) => ({
				title: (row.querySelector(".task-item-title")?.textContent ?? "").trim(),
				pinned: row.querySelector(".task-pin-mark") !== null,
				current: row.classList.contains("task-item-current"),
			}));
		const taskList = document.querySelector(".sidebar-scroll .task-list");
		const more = document.querySelector(".task-list-more");
		return {
			tasks: taskList === null ? [] : [...taskList.querySelectorAll(":scope > .task-item")].map((row) => ({
				title: (row.querySelector(".task-item-title")?.textContent ?? "").trim(),
				pinned: row.querySelector(".task-pin-mark") !== null,
				current: row.classList.contains("task-item-current"),
			})),
			moreLabel: more === null ? null : (more.textContent ?? "").trim(),
			spaces: [...document.querySelectorAll(".sidebar-scroll .space-group")].map((group) => ({
				name: (group.querySelector(".space-group-name")?.textContent ?? "").trim(),
				rows: rowsOf(group),
			})),
		};
	});

/** 等侧栏出现某条会话在任务区第一行（谓词必须能返回假值）。 */
const waitTaskOrder = (titles, desc) =>
	waitUntil(
		async () => {
			const layout = await readLayout();
			const now = layout.tasks.map((row) => row.title);
			return now.join("|") === titles.join("|") ? layout : null;
		},
		{ timeout: 15_000, desc: desc ?? `任务区顺序变为 ${titles.join(" | ")}` },
	);

/** 打开某个会话行的 ⋯ 菜单（按标题定位；标题即首条用户消息）。 */
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
		timeout: 10_000,
		desc: "⋯ 菜单展开",
	});
};

/** 菜单里的条目文案（顺序即视觉顺序）。 */
const menuItems = () =>
	win.evaluate(() =>
		[...document.querySelectorAll(".task-op-menu .space-menu-item")].map((b) => (b.textContent ?? "").trim()),
	);

/**
 * 点菜单里文案精确匹配的条目。
 *
 * **先断言这一项真的在侧栏可视区里**，再点。菜单是绝对定位挂在行上的（`top: 100%`），
 * 而它的裁剪祖先是 `.sidebar-scroll` —— 靠下的行、项数多的菜单可以落到可视区之外，
 * 那时页面内 `btn.click()` 仍然「成功」，测试照样绿，等于什么都没验。
 * 这条断言把「点了一个看不见的按钮」变成红灯。（菜单不翻转到上方是本轮登记的限制，
 * 见 `.trellis/tasks/10-03-session-pin/design.md` 的「已知未覆盖」。）
 */
const clickMenuItem = async (label) => {
	const box = await win.evaluate((l) => {
		const btn = [...document.querySelectorAll(".task-op-menu .space-menu-item")].find(
			(b) => (b.textContent ?? "").trim() === l,
		);
		if (btn === undefined) return null;
		const rect = btn.getBoundingClientRect();
		const scroller = document.querySelector(".sidebar-scroll");
		const view = scroller?.getBoundingClientRect();
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
	assert.ok(box.w > 0 && box.h > 0, `菜单项「${label}」没有实际尺寸：${JSON.stringify(box)}`);
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
	await waitUntil(() => win.evaluate(() => document.querySelector(".task-op-menu") === null), {
		timeout: 10_000,
		desc: "⋯ 菜单收起",
	});
};

// ══ ① 折叠基线 ════════════════════════════════════════════════
await h.check("① 任务区默认只显示 5 行，其余进「查看更多 (2)」", async () => {
	const layout = await waitTaskOrder(
		["会话1", "会话2", "会话3", "会话4", "会话5"],
		"任务区渲染出前 5 条（按最近活动倒序）",
	);
	assert.equal(layout.tasks.length, 5, `任务区默认应显示 5 行：${JSON.stringify(layout.tasks.map((r) => r.title))}`);
	assert.equal(layout.moreLabel, "查看更多 (2)", `「查看更多」的计数应反映被折叠的 2 条：${layout.moreLabel}`);
});
await h.shoot("sidebar-before-pin");

// ══ ② ⋯ 菜单置顶 ═════════════════════════════════════════════
await h.check("② ⋯ 菜单里的「置顶」把该会话钉到任务区最前，并显示钉标记", async () => {
	await openRowMenu("会话3");
	assert.ok((await menuItems()).includes("置顶"), `⋯ 菜单里应有「置顶」：${JSON.stringify(await menuItems())}`);
	await clickMenuItem("置顶");

	const layout = await waitTaskOrder(
		["会话3", "会话1", "会话2", "会话4", "会话5"],
		"置顶后「会话3」排到任务区最前",
	);
	// 先截图后断言（本仓库 e2e 的纪律）：断言挂了，出问题的那一屏已经在图里。
	await h.shoot("sidebar-pinned-top");
	assert.equal(layout.tasks[0].pinned, true, "第一行应带钉标记（.task-pin-mark）");
	assert.equal(layout.tasks.slice(1).some((row) => row.pinned), false, "没有别的行被连带标成置顶");

	// 菜单项随状态切换：再打开一次应写「取消置顶」。
	await openRowMenu("会话3");
	assert.ok((await menuItems()).includes("取消置顶"), "已置顶的行，菜单项应变成「取消置顶」");
	await win.keyboard.press("Escape");
	await waitUntil(() => win.evaluate(() => document.querySelector(".task-op-menu") === null), {
		timeout: 10_000,
		desc: "Esc 关闭 ⋯ 菜单",
	});
});

// ══ ③ 键盘可达 ════════════════════════════════════════════════
await h.check("③ 键盘：Tab 从行主体走进 ⋯ 时它真的可见（隐藏手法不能吃掉焦点）", async () => {
	// 先把焦点放到第一行的可点主体上，再按一次 Tab —— DOM 顺序里下一个可聚焦元素
	// 就是这一行的 ⋯（行结构：button.task-item-body → span.task-item-ops > button）。
	await win.evaluate(() => {
		const first = document.querySelector(".sidebar .task-item .task-item-body");
		if (first === null) throw new Error("找不到任务行主体");
		first.focus();
	});
	await win.keyboard.press("Tab");

	const focusedIsOp = await win.evaluate(() => {
		const el = document.activeElement;
		return el !== null && el.classList.contains("task-op-btn");
	});
	// 若 `.task-item-ops` 退回 `visibility: hidden`，Tab 会直接跳过这一格 →
	// 这里拿到 false，同时下面的 opacity 断言也永远等不到 1。
	assert.equal(focusedIsOp, true, "Tab 应能聚焦到行内的 ⋯ 按钮（否则行内全部动作对键盘关闭）");

	const opacity = await waitUntil(
		() =>
			win.evaluate(() => {
				const ops = document.activeElement?.closest(".task-item-ops");
				if (ops === null || ops === undefined) return null;
				const value = Number(getComputedStyle(ops).opacity);
				return value > 0.9 ? value : null;
			}),
		{ timeout: 10_000, desc: "聚焦后 .task-item-ops 淡入到不透明" },
	);
	assert.ok(opacity > 0.9, `聚焦态下操作钮应可见，实测 opacity=${opacity}`);
});

// ══ ④ 分区内置顶（空间组） ════════════════════════════════════
await h.check("④ 置顶空间组里的会话：组内排最前，任务区不受影响", async () => {
	await openRowMenu("空间会话 B");
	await clickMenuItem("置顶");

	const layout = await waitUntil(
		async () => {
			const next = await readLayout();
			const group = next.spaces.find((g) => g.name === "项目甲");
			return group !== undefined && group.rows[0]?.title === "空间会话 B" ? next : null;
		},
		{ timeout: 15_000, desc: "空间组「项目甲」内「空间会话 B」排到最前" },
	);
	const group = layout.spaces.find((g) => g.name === "项目甲");
	assert.equal(group.rows[0].pinned, true, "组内第一行应带钉标记");
	assert.deepEqual(
		group.rows.map((r) => r.title),
		["空间会话 B", "空间会话 A"],
		"组内顺序应为「置顶优先，其次最近活动」",
	);
	// 分区内置顶：任务区那 5 行的顺序不该因为空间组的变化而动。
	assert.deepEqual(
		layout.tasks.map((r) => r.title),
		["会话3", "会话1", "会话2", "会话4", "会话5"],
		"空间组内的置顶不应影响任务区",
	);
});

// ══ ⑤ 置顶不被折叠截断 ════════════════════════════════════════
await h.check("⑤ 被折叠的最后一条（最旧）置顶后仍出现在可见行里（不走「查看更多」）", async () => {
	// 界面路径够不到这一条（它默认被折叠），所以直接走 IPC —— 这条断言验的是
	// 「置顶项不参与那 5 个名额」这条**窗口规则**，与「菜单能点」是两件事。
	await win.evaluate(async (path) => {
		await globalThis.kami.pinSession(path, true);
	}, TASKS[6].path);

	const layout = await waitUntil(
		async () => {
			const next = await readLayout();
			return next.tasks.some((row) => row.title === "会话7") ? next : null;
		},
		{ timeout: 15_000, desc: "置顶后「会话7」出现在可见行里" },
	);
	// 置顶区内部仍按「最近活动」排（会话3 比 会话7 新），所以它排在会话3 之后 ——
	// **但在窗口内**，这正是这条断言要的：它本来是第 7 新、默认折叠看不到的。
	assert.deepEqual(
		layout.tasks.map((r) => r.title),
		["会话3", "会话7", "会话1", "会话2", "会话4"],
		`置顶的「会话7」应挤进可见窗口：${JSON.stringify(layout.tasks.map((r) => r.title))}`,
	);
	assert.equal(layout.tasks[1].pinned, true, "「会话7」应带钉标记");
	assert.equal(layout.moreLabel, "查看更多 (2)", `窗口仍是 5 行（置顶占位、第 5 条被挤出去）：${layout.moreLabel}`);
});

// ══ ⑥ 索引落盘 ════════════════════════════════════════════════
await h.check("⑥ pins.json 真的落盘（读文件，不看内存）", async () => {
	const index = JSON.parse(readFileSync(PINS_FILE, "utf8"));
	assert.ok(typeof index[TASKS[2].path] === "number", `「会话3」应已落盘：${JSON.stringify(index)}`);
	assert.ok(typeof index[TASKS[6].path] === "number", `「会话7」应已落盘：${JSON.stringify(index)}`);
	assert.ok(typeof index[SPACE_OLD.path] === "number", `「空间会话 B」应已落盘：${JSON.stringify(index)}`);
	assert.equal(Object.keys(index).length, 3, `这次只置顶了 3 条：${JSON.stringify(index)}`);
});

// ══ ⑦ 取消置顶 ════════════════════════════════════════════════
await h.check("⑦ 取消置顶后回到按最近活动排序，钉标记消失", async () => {
	await openRowMenu("会话3");
	await clickMenuItem("取消置顶");

	const layout = await waitTaskOrder(
		["会话7", "会话1", "会话2", "会话3", "会话4"],
		"取消置顶后「会话3」回到它按时间应在的位置",
	);
	assert.equal(layout.tasks[0].title, "会话7", "「会话7」仍置顶，应还在最前");
	const three = layout.tasks.find((row) => row.title === "会话3");
	assert.equal(three.pinned, false, "取消置顶后钉标记应消失");

	const index = JSON.parse(readFileSync(PINS_FILE, "utf8"));
	assert.equal(index[TASKS[2].path], undefined, `取消置顶应从索引里删掉：${JSON.stringify(index)}`);
});

// ══ ⑧ 真实重启 ════════════════════════════════════════════════
await h.check("⑧ 重启应用后置顶仍在（daemon 从 pins.json 读回）", async () => {
	await h.app().close();
	await h.launch();
	win = h.window();

	// 谓词等的是**界面事实**（那一行带着钉标记排在最前），不是 daemon 日志 ——
	// 否则上一轮启动留下的日志会让这条断言瞬间为真（假通过）。
	const layout = await waitUntil(
		async () => {
			const next = await readLayout();
			const first = next.tasks[0];
			return first?.title === "会话7" && first.pinned === true ? next : null;
		},
		{ timeout: 30_000, desc: "重启后「会话7」仍置顶在最前" },
	);
	const group = layout.spaces.find((g) => g.name === "项目甲");
	assert.equal(group?.rows[0]?.title, "空间会话 B", "重启后空间组内的置顶也应还原");
	assert.equal(group?.rows[0]?.pinned, true, "重启后空间组内的钉标记应还在");
});

// ══ ⑨ 深浅两套主题截图 ════════════════════════════════════════
await h.check("⑨ 深色主题下置顶标记仍正常渲染（截图 + 像素断言）", async () => {
	await h.shoot("sidebar-pinned-light");
	await win.evaluate(() => {
		void window.kami?.setThemePreference?.("dark");
		document.documentElement.setAttribute("data-theme", "dark");
	});
	await waitUntil(() => win.evaluate(() => document.documentElement.dataset.theme === "dark"), {
		timeout: 10_000,
		desc: "data-theme 切到 dark",
	});
	await h.waitForSettled();
	const dark = await h.shoot("sidebar-pinned-dark");
	assert.ok(dark.stats.stdDev > 3, `深色截图不像渲染出来的界面（stdDev=${dark.stats.stdDev.toFixed(2)}）`);

	// 置顶标记在深色下仍然画出来了（不是「深色把标记吃掉了」）。
	const pinnedVisible = await win.evaluate(() => {
		const mark = document.querySelector(".sidebar .task-item .task-pin-mark");
		if (mark === null) return null;
		const rect = mark.getBoundingClientRect();
		return { width: rect.width, height: rect.height };
	});
	assert.ok(pinnedVisible !== null, "深色下找不到置顶标记");
	assert.ok(pinnedVisible.width > 0 && pinnedVisible.height > 0, `置顶标记应有实际尺寸：${JSON.stringify(pinnedVisible)}`);

	await win.evaluate(() => {
		void window.kami?.setThemePreference?.("light");
		document.documentElement.setAttribute("data-theme", "light");
	});
	await waitUntil(() => win.evaluate(() => document.documentElement.dataset.theme === "light"), {
		timeout: 10_000,
		desc: "data-theme 切回 light",
	});
	await h.waitForSettled();
});

// ══ ⑩⑪⑫ 与既有能力的相互作用 ═════════════════════════════════
// 这三条覆盖的正是 docs/USAGE.md 对用户做出的承诺。它们不是「store 层的同义反复」：
// 归档会让行从侧栏消失、重命名会改标题、删除会移走文件 —— 每一件都可能把置顶弄丢。
// 走 IPC 而不是菜单，是因为这里验的是「置顶与它们的相互作用」，不是「菜单能不能点」。

await h.check("⑩ 归档：行收起但置顶记录保留；取消归档后置顶原样回来", async () => {
	await win.evaluate(async (path) => {
		await globalThis.kami.archiveSession(path, true);
	}, TASKS[6].path);
	await waitUntil(
		async () => {
			const layout = await readLayout();
			return layout.tasks.every((row) => row.title !== "会话7") ? layout : null;
		},
		{ timeout: 15_000, desc: "归档后「会话7」从侧栏消失" },
	);
	const archived = JSON.parse(readFileSync(PINS_FILE, "utf8"));
	assert.ok(typeof archived[TASKS[6].path] === "number", `归档不该动 pins.json：${JSON.stringify(archived)}`);

	await win.evaluate(async (path) => {
		await globalThis.kami.archiveSession(path, false);
	}, TASKS[6].path);
	const restored = await waitUntil(
		async () => {
			const layout = await readLayout();
			const first = layout.tasks[0];
			return first?.title === "会话7" && first.pinned === true ? layout : null;
		},
		{ timeout: 15_000, desc: "取消归档后「会话7」带钉标记回到最前" },
	);
	// 取消归档没有把别的东西弄乱：任务区仍是「置顶优先 + 最近活动」那一套。
	assert.deepEqual(
		restored.tasks.map((row) => row.title),
		["会话7", "会话1", "会话2", "会话3", "会话4"],
		`取消归档后的顺序应回到置顶优先：${JSON.stringify(restored.tasks.map((r) => r.title))}`,
	);
});

await h.check("⑪ 重命名：置顶跟着走（同一个会话文件，路径没变）", async () => {
	await win.evaluate(async (path) => {
		await globalThis.kami.renameSession(path, "改过名的会话七");
	}, TASKS[6].path);
	const layout = await waitUntil(
		async () => {
			const next = await readLayout();
			const first = next.tasks[0];
			return first?.title === "改过名的会话七" ? next : null;
		},
		{ timeout: 15_000, desc: "重命名后标题生效" },
	);
	assert.equal(layout.tasks[0].pinned, true, "重命名后钉标记应还在（path 没变，置顶记录仍命中）");
});

await h.check("⑫ 删除：会话消失、列表不抛错，置顶记录成为不显示的悬空项", async () => {
	// 「会话6」还在折叠窗口之外，先置顶（顺便验证了它本该露出来），再删除。
	await win.evaluate(async (path) => {
		await globalThis.kami.pinSession(path, true);
		await globalThis.kami.deleteSession(path);
	}, TASKS[5].path);

	const layout = await waitUntil(
		async () => {
			const next = await readLayout();
			return next.tasks.every((row) => row.title !== "会话6") ? next : null;
		},
		{ timeout: 15_000, desc: "删除后「会话6」从侧栏消失" },
	);
	// 列表整体仍然可用（deleteSession 没抛错、也没有把别的行带走）。
	assert.ok(layout.tasks.length > 0, "删除一条会话后，其余会话应仍正常渲染");
	assert.equal(
		layout.tasks.some((row) => row.title === "会话6"),
		false,
		"被删除的会话不应再出现在列表里",
	);
	// 悬空记录按设计**保留**（不自动清理：会话文件可能只是暂时不在，见 pin.js 文件头）。
	const index = JSON.parse(readFileSync(PINS_FILE, "utf8"));
	assert.ok(typeof index[TASKS[5].path] === "number", `置顶记录按设计保留：${JSON.stringify(index)}`);
});

await h.finish();
