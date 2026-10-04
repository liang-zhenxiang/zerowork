/**
 * 命令面板「记忆」（收藏 + 常用项）的 GUI 端到端测试。
 *
 * 排序与衰减的**规则**由 `tests/unit/palette-memory.test.mjs` 与
 * `tests/unit/command-palette-core.test.mjs` 毫秒级钉死；本文件守的是**接线**：
 * 键盘/鼠标两条路径真的通、状态真的过了 IPC、重启后真的读得回来、
 * 以及**收藏组真的排在列表最前**（那是「置顶」这个词的唯一证据）。
 *
 * 覆盖：
 *   ① 干净配置：没有「收藏」组、没有已收藏标记 —— 新功能不给老用户的首屏加噪声
 *   ② ⌘D/Ctrl+D 收藏当前选中项：出现「收藏」组、实心星、屏读名含「已收藏」、面板不关
 *   ③ 关掉重开仍在，且 preferences.json 里**真的落了盘**（读文件，不看界面）
 *   ④ **真实重启** → 收藏仍在（daemon 从 preferences.json 读回）
 *   ⑤ 鼠标点星标 = 取消收藏（第二条切换路径）
 *   ⑥ 未收藏行上，星标那一格**等于点整行**（执行条目），不是「误触收藏」；
 *      已收藏行上点星标才是取消收藏（⑤）
 *   ⑦ 执行过的条目在同分组内上浮（frecency），且**改变主题**是可独立观测的副作用
 *   ⑧ 浅色 / 深色两套主题截图（含「收藏」组）
 *   ⑨ 收藏上限：到顶时**明确拒绝并提示**（toast），不静默失败；悬空收藏 id 不产生幽灵行
 *
 * ## 反向验证记录（2026-10-04）
 *
 * 做法：临时注入缺陷 → `npm run build` → 跑本文件 → 记下哪些用例变红 → 复原重建。
 * （e2e 跑的是 out/ 产物，注入后必须重建，否则改动不生效。）
 *
 * 【验证 1】把 `rankEntries` 的 `scoreOf` 接线摘掉（`{ limit, scoreOf }` 改回只传 limit）
 *   · ⑦ 变红：「执行过的条目应上浮到同组第一，实际 切换外观：浅色」——
 *     frecency 完全没参与排序。其余用例不受影响（它们只依赖收藏）。
 * 【验证 2】把点击分派里的 `favorited &&` 前置判断删掉（点星标一律切换收藏）
 *   · ⑥ 变红：点未收藏行的星标那一格**没有**执行条目（面板仍开着），
 *     而且那条被误加了收藏 —— 正是这条规则要防的事故。
 * 附带结论（如实记录）：把 `.palette-star` 的 `pointer-events` 规则删掉后，
 * 行为**没有变化**（冒泡到行，判定仍走 `favorited`），只有悬停变淡的反馈生效
 * 与否不同 —— 所以那两条 `pointer-events` 声明最终没有写进实现，⑥ 也不再断言它。
 *
 * 【两条踩到的坑，都已修】
 *   1. **失败会把状态留脏**：第一次注入时 ⑦ 失败后，它的收尾（把主题切回浅色）
 *      没跑到，⑧ 跟着假红。修法是让每个用例**自证起点**（⑧ 先查那一条是不是
 *      已收藏再决定要不要按 ⌘D），而不是假设上一条成功。否则一条真失败会
 *      拖出一串假失败，掩盖信号。
 *   2. **⌘K 是切换键**：上面失败后面板可能还开着，再按 ⌘K 会把它关掉，
 *      而退场动画期间「等面板出现」的谓词会在卸载前那次轮询里为真 →
 *      后续按键全部落空。修法是 `openPaletteClean` 先确认它是关的。
 * 复原后全绿。
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { diffGrids } from "./lib/png.mjs";

const h = createHarness({ name: "palette-memory" });
let app = await h.launch();
let win = h.window();

// macOS 用 ⌘（Meta），Windows/Linux 用 Ctrl —— 与 app.js 的 PALETTE_MOD 同口径。
const MOD = process.platform === "darwin" ? "Meta" : "Control";
const MOD_LABEL = MOD === "Meta" ? "⌘" : "Ctrl";

// ── DOM 探针 ──────────────────────────────────────────────────────────
const paletteOpen = () => win.evaluate(() => document.querySelector(".command-palette") !== null);
const paletteInput = () => win.locator(".command-palette-input");
const groupTitles = () =>
	win.evaluate(() =>
		[...document.querySelectorAll(".command-palette .ac-group-title")].map((el) => el.textContent ?? ""),
	);
const optionTexts = () =>
	win.evaluate(() =>
		[...document.querySelectorAll('.command-palette [role="option"]')].map((el) => el.textContent ?? ""),
	);
/** 每行的标题 + 收藏标记（data-on）+ 屏读名。 */
const optionRows = () =>
	win.evaluate(() =>
		[...document.querySelectorAll('.command-palette [role="option"]')].map((el) => {
			const star = el.querySelector(".palette-star");
			return {
				label: el.querySelector(".ac-label")?.textContent ?? "",
				starred: star?.getAttribute("data-on") === "true",
				starOpacity: star === null ? null : getComputedStyle(star).opacity,
				ariaLabel: el.getAttribute("aria-label"),
			};
		}),
	);
/** 星标的可点坐标（CSS 像素，与 Playwright 的鼠标坐标同口径）。 */
const starBoxOf = (match) =>
	win.evaluate((text) => {
		const opts = [...document.querySelectorAll('.command-palette [role="option"]')];
		const hit = opts.find((el) => (el.querySelector(".ac-label")?.textContent ?? "").includes(text));
		if (hit === undefined) return null;
		const star = hit.querySelector(".palette-star");
		if (star === null) return null;
		const rect = star.getBoundingClientRect();
		return {
			x: rect.x + rect.width / 2,
			y: rect.y + rect.height / 2,
			starred: star.getAttribute("data-on") === "true",
			opacity: getComputedStyle(star).opacity,
			pointerEvents: getComputedStyle(star).pointerEvents,
		};
	}, match);

const waitPaletteOpen = () =>
	waitUntil(paletteOpen, { timeout: 15_000, desc: "命令面板出现（.command-palette）" });
const waitPaletteClosed = () =>
	waitUntil(async () => (await paletteOpen()) === false, { timeout: 15_000, desc: "命令面板卸载" });

/** 点一条结果的**行**（真实鼠标，走 onMouseDown → 执行该条目）。 */
const clickRow = async (match) => {
	const box = await win.evaluate((text) => {
		const opts = [...document.querySelectorAll('.command-palette [role="option"]')];
		const hit = opts.find((el) => (el.querySelector(".ac-label")?.textContent ?? "").includes(text));
		if (hit === undefined) return null;
		const rect = hit.getBoundingClientRect();
		return { x: rect.x + 12, y: rect.y + rect.height / 2, label: hit.querySelector(".ac-label")?.textContent ?? "" };
	}, match);
	assert.notEqual(box, null, `应能找到含「${match}」的结果行`);
	await win.mouse.click(box.x, box.y);
	return box.label;
};

/**
 * 打开面板并把鼠标挪到角落，避免「悬停行」干扰星标的可见性断言。
 *
 * **先确保它是关的**：⌘K 是切换键，上一节失败时面板可能还开着 ——
 * 那时直接按 ⌘K 会把它关掉，而 `.command-palette` 的退场动画有 150ms，
 * 「等它出现」的谓词会在卸载前的那一次轮询里为真，于是后面的按键全部落空
 * （真实踩到：反向验证时 ⑦ 失败后 ⑧ 跟着假红）。
 */
const openPaletteClean = async () => {
	await win.mouse.move(4, 4);
	if (await paletteOpen()) {
		await win.keyboard.press("Escape");
		await waitPaletteClosed();
	}
	await win.keyboard.press(`${MOD}+k`);
	await waitPaletteOpen();
	await h.waitForSettled();
};

/** 直接读 daemon 落盘的偏好文件 —— 「真的落盘了」的唯一证据。 */
const readPrefs = () => {
	try {
		return JSON.parse(readFileSync(join(h.CONFIG_DIR, "preferences.json"), "utf8"));
	} catch {
		return {};
	}
};

// ══ ① 干净配置：不给老用户的首屏加噪声 ═══════════════════════════════
await h.check("① 干净配置：没有「收藏」组、没有已收藏标记、底栏提示里有收藏键", async () => {
	await openPaletteClean();
	const titles = await groupTitles();
	assert.ok(!titles.includes("收藏"), `干净配置下不应出现「收藏」组，实际组序：${titles.join(" / ")}`);
	const rows = await optionRows();
	assert.ok(rows.length >= 5, `空查询应有引导条目，实际 ${rows.length} 条`);
	assert.equal(
		rows.filter((row) => row.starred).length,
		0,
		"干净配置下不应有任何已收藏标记（starred）",
	);
	const foot = await win.evaluate(() => document.querySelector(".command-palette-foot")?.textContent ?? "");
	assert.ok(foot.includes(`${MOD_LABEL}+D`), `底栏应写出收藏键 ${MOD_LABEL}+D，实际「${foot}」`);
	assert.ok(foot.includes("收藏"), `底栏应说明这个键是做什么的，实际「${foot}」`);
});

// ══ ② ⌘D 收藏当前选中项 ══════════════════════════════════════════════
await h.check("② ⌘D 收藏当前选中项：出现「收藏」组 + 实心星 + 屏读名，且面板不关", async () => {
	const before = await win.evaluate(
		() => document.querySelector('.command-palette [role="option"][aria-selected="true"] .ac-label')?.textContent ?? "",
	);
	assert.notEqual(before, "", "应先有选中的条目");
	await win.keyboard.press(`${MOD}+d`);
	// 收藏是整理动作，收起面板会让「连着钉几个」变成反复唤起 —— 断言它不关。
	await waitUntil(async () => (await groupTitles()).includes("收藏"), {
		timeout: 10_000,
		desc: "出现「收藏」组",
	});
	assert.equal(await paletteOpen(), true, "收藏后面板应保持打开");
	const titles = await groupTitles();
	assert.equal(titles[0], "收藏", `「收藏」组必须排在**最前**（置顶的视觉证据），实际组序：${titles.join(" / ")}`);
	const rows = await optionRows();
	const favorited = rows.filter((row) => row.starred);
	assert.equal(favorited.length, 1, `应恰好一条已收藏，实际 ${favorited.length} 条`);
	assert.equal(favorited[0].label, before, `收藏的应是刚才选中的「${before}」`);
	assert.ok(
		(favorited[0].ariaLabel ?? "").includes("已收藏"),
		`已收藏行的屏读名应含「已收藏」，实际「${favorited[0].ariaLabel}」`,
	);
});

// ══ ③ 关掉重开仍在 + 真的落盘 ══════════════════════════════════════
await h.check("③ 关掉重开仍在；preferences.json 里真的落了盘", async () => {
	await win.keyboard.press("Escape");
	await waitPaletteClosed();
	// 写回是 fire-and-forget，给磁盘一点时间（断言的是「最终落盘」，不是「同一帧落盘」）。
	await waitUntil(() => (readPrefs().paletteMemory?.favorites ?? []).length === 1, {
		timeout: 10_000,
		desc: "preferences.json 里出现 1 条收藏",
	});
	const memory = readPrefs().paletteMemory;
	assert.equal(memory.favorites.length, 1, "收藏应恰好一条");
	assert.ok(
		Array.isArray(memory.favorites) && memory.favorites[0].startsWith("action:"),
		`收藏的应是动作条目（id 以 action: 开头），实际 ${JSON.stringify(memory.favorites)}`,
	);

	await openPaletteClean();
	const titles = await groupTitles();
	assert.equal(titles[0], "收藏", "重开面板后「收藏」组仍应在最前");
	const rows = await optionRows();
	assert.equal(rows.filter((row) => row.starred).length, 1, "重开面板后星标应还在");
});

// ══ ④ 真实重启 ══════════════════════════════════════════════════════
await h.check("④ 真实重启后收藏仍在（daemon 从 preferences.json 读回）", async () => {
	await app.close();
	app = await h.launch();
	win = h.window();
	await openPaletteClean();
	await waitUntil(async () => (await groupTitles()).includes("收藏"), {
		timeout: 30_000,
		desc: "重启后「收藏」组回来",
	});
	const rows = await optionRows();
	assert.equal(rows.filter((row) => row.starred).length, 1, "重启后应恰好一条收藏");
});

// ══ ⑤ 鼠标点星标 = 取消收藏 ═════════════════════════════════════════
await h.check("⑤ 鼠标点星标取消收藏（第二条切换路径）", async () => {
	const box = await starBoxOf("新建任务");
	assert.notEqual(box, null, "应能找到「新建任务」那一行的星标");
	assert.equal(box.starred, true, "它此刻应是已收藏状态");
	await win.mouse.click(box.x, box.y);
	await waitUntil(async () => (await groupTitles()).includes("收藏") === false, {
		timeout: 10_000,
		desc: "取消收藏后「收藏」组消失",
	});
	assert.equal(await paletteOpen(), true, "收藏切换不应关闭面板");
	// 写回是 fire-and-forget：等它落到 0，而不是假设某一帧磁盘是什么样。
	await waitUntil(() => (readPrefs().paletteMemory?.favorites ?? []).length === 0, {
		timeout: 10_000,
		desc: "取消收藏也写回了磁盘",
	});
});

// ══ ⑥ 看不见的星标不吞点击 ═══════════════════════════════════════════
await h.check("⑥ 未收藏行上星标那一格等于点整行：执行条目，不误加收藏", async () => {
	// 上一条刚取消收藏，此刻没有任何收藏。鼠标已被挪到角落（openPaletteClean），
	// 所以没有任何行处于 hover —— 这条断言才是确定的。
	const box = await starBoxOf("检查更新");
	assert.notEqual(box, null, "应能找到「检查更新」那一行的星标");
	assert.equal(box.starred, false, "它此刻应是未收藏状态");
	assert.equal(box.opacity, "0", `未收藏且未悬停的星标应不可见（opacity 0），实际 ${box.opacity}`);
	// 点下去应该命中「行」这件事 —— 星标本身对未收藏的行没有动作，判定走
	// app.js 的 `favorited &&`（不是 CSS 的 pointer-events，见该处注释）。
	await win.mouse.click(box.x, box.y);
	try {
		await waitPaletteClosed();
	} catch {
		const rows = await optionRows();
		assert.fail(
			"点那个看不见的星标应当执行条目（面板关闭），实际面板仍开着 —— " +
				`不可见的星标接住了点击。当前收藏标记：${JSON.stringify(rows.map((r) => [r.label, r.starred]))}`,
		);
	}
	// 面板关闭 = 执行了条目（这就是「没被星标吞掉」的证据）。
	// 再等一拍确认那一下**没有**顺手加一条收藏（写回是异步的，注入缺陷时会看到 1）。
	await h.waitForSettled();
	assert.equal(
		(readPrefs().paletteMemory?.favorites ?? []).length,
		0,
		"点那个不可见的星标不应改变收藏",
	);
});

// ══ ⑦ frecency：执行过的条目上浮 ════════════════════════════════════
await h.check("⑦ 执行过的条目在同分组内上浮（frecency 真的有接线）", async () => {
	await win.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
	await openPaletteClean();
	await paletteInput().fill("切换外观");
	await waitUntil(async () => (await optionTexts()).some((t) => t.includes("切换外观")), {
		timeout: 10_000,
		desc: "出现「切换外观」相关条目",
	});
	const before = (await optionRows()).map((row) => row.label);
	assert.equal(before[0], "切换外观：浅色", `基线应保持原顺序，实际首条是「${before[0]}」`);

	// 执行「深色」那一条：它是非模态动作，副作用（data-theme=dark）可独立观测。
	const clicked = await clickRow("深色");
	assert.ok(clicked.includes("深色"), `点到的应是「深色」那一条，实际「${clicked}」`);
	await waitPaletteClosed();
	await waitUntil(() => win.evaluate(() => document.documentElement.dataset.theme === "dark"), {
		timeout: 10_000,
		desc: "执行「切换外观：深色」后主题真的变了（证明该条目真的跑了）",
	});

	await openPaletteClean();
	await paletteInput().fill("切换外观");
	await waitUntil(async () => (await optionTexts()).some((t) => t.includes("深色")), {
		timeout: 10_000,
		desc: "再次搜索出现结果",
	});
	const after = (await optionRows()).map((row) => row.label);
	assert.equal(
		after[0],
		"切换外观：深色",
		`执行过的条目应上浮到同组第一，实际 首条「${after[0]}」（顺序：${after.join(" / ")}）`,
	);

	// 收尾：把主题切回浅色（同样走面板，顺便证明这一条也是真的）。
	await paletteInput().fill("切换外观：浅色");
	await waitUntil(async () => (await optionTexts()).some((t) => t.includes("浅色")), {
		timeout: 10_000,
		desc: "出现「浅色」条目",
	});
	await win.keyboard.press("Enter");
	await waitPaletteClosed();
	await waitUntil(() => win.evaluate(() => document.documentElement.dataset.theme === "light"), {
		timeout: 10_000,
		desc: "主题切回浅色",
	});
});

// ══ ⑧ 浅色 / 深色截图 ══════════════════════════════════════════════
await h.check("⑧ 浅色主题：收藏组可见（截图）", async () => {
	// 收藏一条**确定**的条目让截图里有「收藏」组。幂等：先看它的状态，
	// 没收藏才按 ⌘D —— 这样即使上一条用例失败把状态留脏，这里也不会
	// 变成「把已收藏的取消掉」，从而不会用一条假红遮住真实的失败信号。
	await openPaletteClean();
	await paletteInput().fill("切换外观：浅色");
	await waitUntil(async () => (await optionTexts()).some((t) => t.includes("浅色")), {
		timeout: 10_000,
		desc: "出现「切换外观：浅色」条目（用于截图）",
	});
	if ((await optionRows())[0]?.starred !== true) await win.keyboard.press(`${MOD}+d`);
	// 「收藏」组只在**空查询**下出现（有查询时收藏仍留在各自的类别组里，
	// 见 paletteGroups 的注释）—— 清空查询才能看到它。
	await paletteInput().fill("");
	await waitUntil(async () => (await groupTitles()).includes("收藏"), {
		timeout: 10_000,
		desc: "出现「收藏」组（用于截图）",
	});
	await h.waitForSettled();
	await h.shoot("palette-memory-light");
});

await h.check("⑧ 深色主题：收藏组可见（截图）", async () => {
	await win.keyboard.press("Escape");
	await waitPaletteClosed();
	await win.evaluate(() => {
		void window.kami?.setThemePreference?.("dark");
		document.documentElement.setAttribute("data-theme", "dark");
	});
	await waitUntil(() => win.evaluate(() => document.documentElement.dataset.theme === "dark"), {
		timeout: 10_000,
		desc: "data-theme 切到 dark",
	});
	await openPaletteClean();
	const dark = (await h.shoot("palette-memory-dark")).grid;
	await win.keyboard.press("Escape");
	await waitPaletteClosed();
	// 深浅两张必须真的不同（否则说明主题没生效、截图是同一张）。
	await win.evaluate(() => {
		void window.kami?.setThemePreference?.("light");
		document.documentElement.setAttribute("data-theme", "light");
	});
	await openPaletteClean();
	const light = (await h.shoot("palette-memory-light2")).grid;
	const diff = diffGrids(dark, light);
	assert.ok(diff > 3, `深浅两套主题的画面差异应显著，实际 ${diff.toFixed(2)}`);
	await win.keyboard.press("Escape");
	await waitPaletteClosed();
});

// ══ ⑨ 上限 + 悬空 id ════════════════════════════════════════════════
await h.check("⑨ 收藏到上限时明确拒绝并提示；悬空收藏 id 不产生幽灵行", async () => {
	// 手写一份「收藏已经满 20 条、且这 20 个 id 都不对应任何真实条目」的偏好文件，
	// 再给「打开自动化」记一笔高分，然后重启。一次覆盖三件事：上限行为、
	// 悬空 id 不渲染、以及**常用分真的从磁盘读回来参与排序**
	// （最后这条是「使用记录跨重启仍在」的正面证据 —— 只断言文件里有它不够，
	// 要看得见的顺序才对）。
	const dangling = Array.from({ length: 20 }, (_, i) => `action:ghost-${i}`);
	const prefs = readPrefs();
	prefs.paletteMemory = {
		favorites: dangling,
		usage: { ...(prefs.paletteMemory?.usage ?? {}), "action:automations": { score: 100, lastAt: Date.now() } },
	};
	writeFileSync(join(h.CONFIG_DIR, "preferences.json"), `${JSON.stringify(prefs, null, 2)}\n`, "utf8");
	await app.close();
	app = await h.launch();
	win = h.window();

	// 先装一个 toast 记录器：toast 只活 2.2s，轮询会整段错过（既有教训）。
	await win.evaluate(() => {
		globalThis.__toasts = [];
		const observer = new globalThis.MutationObserver(() => {
			for (const el of document.querySelectorAll(".toast-text")) {
				const text = el.textContent ?? "";
				if (text !== "" && !globalThis.__toasts.includes(text)) globalThis.__toasts.push(text);
			}
		});
		observer.observe(document.body, { childList: true, subtree: true });
	});

	await openPaletteClean();
	const rows = await optionRows();
	assert.ok(rows.length > 0, "悬空收藏不应把列表清空（真实条目照常显示）");
	assert.equal(
		rows.filter((row) => row.label.startsWith("ghost-")).length,
		0,
		"悬空的收藏 id 不应渲染成幽灵行",
	);
	assert.equal(rows.filter((row) => row.starred).length, 0, "悬空 id 不应让任何真实条目显示成已收藏");
	assert.equal(
		rows[0]?.label,
		"打开自动化",
		`重启后常用分应从磁盘读回并参与排序（「打开自动化」分数最高应排第一），实际首条「${rows[0]?.label}」`,
	);

	// 对当前选中（第一条，未收藏）按 ⌘D：已达上限 → 拒绝 + 提示。
	await win.keyboard.press(`${MOD}+d`);
	const toasts = await waitUntil(
		() =>
			win.evaluate(() => (globalThis.__toasts.length > 0 ? globalThis.__toasts.join(" | ") : null)),
		{ timeout: 10_000, desc: "出现收藏已满的提示" },
	);
	assert.ok(toasts.includes("收藏已满"), `应明确提示收藏已满，实际「${toasts}」`);
	// 拒绝 = 磁盘上的收藏**没有被改动**（不是静默挤掉一条）。
	const favorites = readPrefs().paletteMemory?.favorites ?? [];
	assert.deepEqual(favorites, dangling, "被拒绝后磁盘上的收藏应保持原样（不挤掉、不丢）");
});

await h.finish();
