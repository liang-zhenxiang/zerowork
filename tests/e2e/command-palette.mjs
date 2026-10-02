/**
 * 命令面板（⌘K / Ctrl+K）的 GUI 端到端测试。
 *
 * 覆盖 design.md §10「GUI」表的 12 条断言。面板是纯渲染层功能（不新增 IPC），
 * 数据全部来自 App() 已有 state 与既有 window.kami.*（技能/连接器/自动化首次打开
 * 时拉取）。排序优先级链由 command-palette-core.js 的单元测试钉死；本文件守的是
 * **把结果画出来、把键盘接上**这一段 —— 那只有真实启动 Electron 才暴露。
 *
 * 覆盖对照（design.md §10）：
 *   ① MOD+K 唤起：.command-palette 出现、role=dialog、输入框获焦
 *   ② 空查询有引导内容、且不含未开放项
 *   ③ 输入中文命中；↑/↓ 改变 aria-activedescendant（真实键盘）
 *   ④ Enter 执行：设置面板出现、面板消失（+ 非模态动作执行后焦点归还）
 *   ⑤ Esc 关闭且焦点归还唤起前元素
 *   ⑥ 未开放项（助理/项目/资料库/更多）不出现在结果里
 *   ⑦ 无结果时出现 role=status 空态，且不是加载态
 *   ⑧ 选中项不看颜色也可辨（断言字重 500，不只断言 class）
 *   ⑨ 侧栏入口点击能唤起
 *   ⑩ 浅色 + 深色两套主题截图 + 像素断言（开/关画面可区分）
 *   ⑪ 输入法组合期间 Enter 不提交
 *   ⑫ 行右侧的快捷键提示与真实键位一致（把提示里的键真的按一遍，不做假提示）
 *
 * 键盘一律走 Playwright 真实按键（win.keyboard.press），不用合成 KeyboardEvent
 * —— 合成事件需要浏览器全局、在 eslint 的 Node 视角是 no-undef，本项目踩过。
 * 唯一例外是 ⑪：输入法组合事件只能在页面里造（document 派发），详见该处注释。
 *
 * ⚠️ 已知既有事实（不为它写 workaround）：本应用当前所有模态的背板都是**不透明
 * 的 --bg 面板**，不是半透明遮罩（根因见 app.css:892 的 `.app > :not(…)` 特异性，
 * 已立 Issue #108 单独修，不在本 PR 范围）。因此面板打开时整窗变 --bg 底色、
 * 背面内容被完全盖住是**预期**，本文件不假设背板是 40% 遮罩。
 *
 * ## 反向验证记录（2026-10-03，本任务核心证据）
 *
 * 做法：临时注入缺陷 → `npm run build` → 跑本文件 → 记下哪些用例变红 → 复原重建。
 * （e2e 跑的是 out/ 产物，所以注入后必须重建，否则改动不生效。）
 *
 * 【验证 1】去掉「未开放项过滤」——在 paletteEntries 里额外把 NAV_ITEMS$1 中
 * ready:false 的四项映射成 kind:"settings" 的条目并混入返回数组：
 *   · 「未开放项（资料库/助理）不出现在结果里」（⑥）**变红** —— 搜「资料库」
 *     命中了该条目（报错原文：未开放项「资料库」不应出现在结果里，实际：资料库）。
 *   · ② **仍绿**（如实记录，与最初的预期不符）：空查询走的是 idleEntries，
 *     它只挑 kind==="action" 的动作 + 最近会话；注入的条目 kind 是 settings，
 *     不进引导集，所以②看不到它们。这意味着 ② 的「不含未开放项」只覆盖**引导集**，
 *     不覆盖搜索路径 —— 搜索路径由 ⑥ 覆盖，两条互补、都不空转。
 *   其余用例不受影响。复原后 13/13 恢复绿。
 *
 * 【验证 2】把 `open=false → return null` 改成常驻 DOM（删掉 CommandPalette 里的
 * `if (!mounted) return null;`，让组件始终渲染）→ **6 条变红**，正是「关闭/收尾」
 * 语义被破坏的直觉反应：
 *   · ⑤ 、④（「设置 · 通用」）、④（非模态动作）、⑨ 四条 —— 全部卡在
 *     「命令面板卸载」等待超时（面板不再卸载，`.command-palette` 永远在 DOM 里）；
 *   · ⑩ 浅色、⑩ 深色两条 —— 开/关两张截图的 diffGrids 变成 0.00
 *     （面板常驻，开关它画面不再变化），像素断言因此把「属性切了但画面没变」打红。
 *   这条验证同时证明了「面板消失」断言查的是**元素存在性**（真契约），不是可见性；
 *   复原后 13/13 恢复绿。
 */
import assert from "node:assert/strict";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { diffGrids } from "./lib/png.mjs";

const h = createHarness({ name: "command-palette" });
await h.launch();
const win = h.window();

// macOS 用 ⌘（Meta），Windows/Linux 用 Ctrl —— 与 app.js 的 PALETTE_MOD 同口径。
const MOD = process.platform === "darwin" ? "Meta" : "Control";

// ── DOM 探针 ──────────────────────────────────────────────────────────
const paletteOpen = () => win.evaluate(() => document.querySelector(".command-palette") !== null);
const optionTexts = () =>
	win.evaluate(() =>
		[...document.querySelectorAll('.command-palette [role="option"]')].map((el) => el.textContent ?? ""),
	);
const activeDescendant = () =>
	win.evaluate(() => document.querySelector(".command-palette-input")?.getAttribute("aria-activedescendant") ?? null);

/** 真实键盘按组合键唤起/关闭。preventDefault 行为也一并覆盖（修饰键原生行为被拦）。 */
const pressModK = () => win.keyboard.press(`${MOD}+k`);
const paletteInput = () => win.locator(".command-palette-input");

/** 等到面板真的挂上（open 后有一帧动画，用元素出现作为信号）。 */
const waitPaletteOpen = () =>
	waitUntil(paletteOpen, { timeout: 10_000, desc: "命令面板出现（.command-palette）" });

/** 等到面板真的卸载（关闭后有 --dur-fast 的退场动画，元素不是在 Esc 当帧就消失）。 */
const waitPaletteClosed = () =>
	waitUntil(async () => (await paletteOpen()) === false, { timeout: 10_000, desc: "命令面板卸载" });

/** 把焦点放到「新建任务」按钮上，作为「唤起前元素」用于焦点归还断言。 */
const focusNewTaskButton = () =>
	win.evaluate(() => {
		const btn = [...document.querySelectorAll(".new-task")].find((b) => (b.textContent ?? "").includes("新建任务"));
		if (btn === undefined) throw new Error("找不到「新建任务」按钮");
		btn.focus();
	});

// ══ ① 唤起 ══════════════════════════════════════════════════════════
await h.check("① ⌘K/Ctrl+K 唤起：面板出现、role=dialog、输入框获焦", async () => {
	await pressModK();
	await waitPaletteOpen();
	await h.waitForSettled();
	await h.shoot("palette-open-light");
	const role = await win.evaluate(() => document.querySelector(".command-palette")?.getAttribute("role") ?? null);
	assert.equal(role, "dialog", "面板应有 role=dialog");
	const focusedClass = await win.evaluate(() => document.activeElement?.className ?? "");
	assert.ok(
		focusedClass.includes("command-palette-input"),
		`输入框应自动获焦（useModalFocus 聚焦第一个可聚焦元素），实际 activeElement.class=${focusedClass}`,
	);
});

// ══ ② 空查询：引导内容 + 不含未开放项 ══════════════════════════════════
await h.check("② 空查询有引导内容且不含未开放项", async () => {
	// 上一轮没输过内容，query 仍是空 —— 走 idleEntries（常用动作 + 最近会话）。
	const texts = await optionTexts();
	assert.ok(texts.length >= 5, `空查询应显示引导条目（不是一片空白），实际 ${texts.length} 条`);
	const joined = texts.join("\n");
	for (const forbidden of ["助理", "项目", "资料库", "更多"]) {
		assert.ok(!joined.includes(forbidden), `未开放项「${forbidden}」不应出现在空查询引导里`);
	}
});

// ══ ③ 中文命中 + ↑↓ 走位 ══════════════════════════════════════════════
await h.check("③ 输入中文命中；↑↓ 改变 aria-activedescendant（真实键盘）", async () => {
	await paletteInput().fill("设置");
	await waitUntil(async () => (await optionTexts()).length > 0, {
		timeout: 10_000,
		desc: "输入「设置」后出现结果",
	});
	const texts = await optionTexts();
	assert.ok(texts.some((t) => t.includes("设置")), `结果应含设置相关条目，实际：${texts.join(" / ")}`);

	const first = await activeDescendant();
	assert.ok(
		first !== null && first.startsWith("palette-opt-"),
		`应有初始 aria-activedescendant，实际 ${first}`,
	);
	// 真实键盘：ArrowDown 应把选中下移一格（环形），activedescendant 随之前进。
	await win.keyboard.press("ArrowDown");
	await waitUntil(async () => (await activeDescendant()) !== first, {
		timeout: 5_000,
		desc: "ArrowDown 后 aria-activedescendant 变化",
	});
	const second = await activeDescendant();
	assert.notEqual(second, first, "ArrowDown 后选中项 id 应变化");
	// ArrowUp 回到原位（环形走位的反向也覆盖一次）。
	await win.keyboard.press("ArrowUp");
	await waitUntil(async () => (await activeDescendant()) === first, {
		timeout: 5_000,
		desc: "ArrowUp 后回到初始选中项",
	});
});

// ══ ⑧ 选中项不看颜色也可辨（字重） ══════════════════════════════════
await h.check("⑧ 选中项有非颜色状态载体（字重 500，非选中不是 500）", async () => {
	// ③ 结束时 query=「设置」、选中项已回到第一条，结果里有选中行也有其它行。
	await waitUntil(async () => (await optionTexts()).length > 1, {
		timeout: 10_000,
		desc: "结果至少两条（用于对比选中/非选中字重）",
	});
	const weights = await win.evaluate(() => {
		const opts = [...document.querySelectorAll('.command-palette [role="option"]')];
		const active = opts.find((el) => el.getAttribute("aria-selected") === "true");
		const other = opts.find((el) => el.getAttribute("aria-selected") !== "true");
		return {
			active: active === undefined ? null : getComputedStyle(active).fontWeight,
			other: other === undefined ? null : getComputedStyle(other).fontWeight,
		};
	});
	assert.equal(weights.active, "500", `选中行的字重应为 500（§3.6 允许的两档之一），实际 ${weights.active}`);
	assert.notEqual(weights.other, "500", `非选中行不应是 500，实际 ${weights.other}`);
});

// ══ ⑦ 无结果 = 空态，不是加载态 ══════════════════════════════════════
await h.check("⑦ 无结果显示 role=status 空态，不是加载指示", async () => {
	await paletteInput().fill("zzzzqqqq");
	await waitUntil(
		() => win.evaluate(() => document.querySelector('.command-palette .ac-item[role="status"]') !== null),
		{ timeout: 10_000, desc: "出现 role=status 空态" },
	);
	const statusText = await win.evaluate(
		() => document.querySelector('.command-palette .ac-item[role="status"]')?.textContent ?? "",
	);
	assert.ok(statusText.includes("没有匹配"), `空态文案应说明没有匹配项，实际「${statusText}」`);
	// 「无结果」不能被当成「加载中」：空态时不应出现转圈。
	const spinner = await win.evaluate(() => document.querySelector(".command-palette .spinner") !== null);
	assert.equal(spinner, false, "空态里不应出现加载转圈（§4：加载与空必须可辨）");
});

// ══ ⑥ 未开放项不出现 ══════════════════════════════════════════════════
await h.check("⑥ 未开放项（资料库/助理）不出现在结果里", async () => {
	for (const term of ["资料库", "助理"]) {
		await paletteInput().fill(term);
		// 等结果稳定：要么出现条目、要么出现空态，二者之一。
		await waitUntil(
			() =>
				win.evaluate(
					() =>
						document.querySelector('.command-palette [role="status"]') !== null ||
						document.querySelectorAll('.command-palette [role="option"]').length > 0,
				),
			{ timeout: 10_000, desc: `搜索「${term}」后结果就绪` },
		);
		const texts = await optionTexts();
		assert.ok(
			!texts.some((t) => t.includes(term)),
			`未开放项「${term}」不应出现在结果里，实际：${texts.join(" / ")}`,
		);
	}
});

// ══ ⑪ 输入法组合期间 Enter 不提交 ══════════════════════════════════
await h.check("⑪ 输入法组合期间 Enter 不提交（面板保持打开）", async () => {
	// 组合事件只能在页面里造：compositionstart 让 React 的 composingRef 置位，
	// 再派发一个 isComposing:true 的 keydown（两者任一为真即应视为组合中）。
	// 这里**不用** Playwright 的合成帮助，而是在页面里造 DOM 事件 —— 与真实输入法
	// 走的是同一条 React 事件通道。
	// 构造器走 globalThis 前缀：这段函数虽在页面里执行，但 eslint 只按 Node 视角
	// 静态检查，裸 KeyboardEvent / CompositionEvent 在 Node 全局里不存在 → no-undef
	// （正是本项目在合成事件上踩过的坑，这里用属性访问规避）。
	await paletteInput().fill("");
	await win.evaluate(() => {
		const input = document.querySelector(".command-palette-input");
		if (input === null) throw new Error("命令面板输入框不在");
		input.dispatchEvent(new globalThis.CompositionEvent("compositionstart", { bubbles: true }));
		input.dispatchEvent(
			new globalThis.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, isComposing: true }),
		);
	});
	// 给一帧时间让可能的关闭发生（若守失效，Enter 会执行并关闭面板）。
	await new Promise((r) => setTimeout(r, 300));
	assert.equal(await paletteOpen(), true, "组合期间按 Enter 不应提交、面板应保持打开");
	// 收尾：结束组合。
	await win.evaluate(() => {
		const input = document.querySelector(".command-palette-input");
		input?.dispatchEvent(new globalThis.CompositionEvent("compositionend", { bubbles: true }));
	});
});

// ══ ⑤ Esc 关闭 + 焦点归还 ══════════════════════════════════════════
await h.check("⑤ Esc 关闭面板，焦点归还唤起前元素", async () => {
	// 先把当前打开的面板关掉（⑪ 结束时它是开着的），拿到干净起点。
	await win.keyboard.press("Escape");
	await waitPaletteClosed();
	// 用「新建任务」按钮作为唤起前元素 —— 真实键盘 ⌘K 唤起时，useModalFocus 的
	// ref 回调会把 document.activeElement 记为 opener，关闭时归还给它（prd R1）。
	await focusNewTaskButton();
	await pressModK();
	await waitPaletteOpen();
	await win.keyboard.press("Escape");
	await waitPaletteClosed();
	await waitUntil(
		() =>
			win.evaluate(() => {
				const el = document.activeElement;
				return el !== null && el.classList.contains("new-task") && (el.textContent ?? "").includes("新建任务");
			}),
		{ timeout: 10_000, desc: "焦点归还到唤起前的「新建任务」按钮" },
	);
});

// ══ ④ Enter 执行 ══════════════════════════════════════════════════
await h.check("④ Enter 执行：「设置 · 通用」→ 设置面板出现、面板消失", async () => {
	await focusNewTaskButton();
	await pressModK();
	await waitPaletteOpen();
	await paletteInput().fill("设置 · 通用");
	await waitUntil(async () => (await optionTexts()).some((t) => t.includes("设置 · 通用")), {
		timeout: 10_000,
		desc: "出现「设置 · 通用」条目",
	});
	await win.keyboard.press("Enter");
	await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") !== null), {
		timeout: 15_000,
		desc: "设置面板出现（Enter 执行了设置动作）",
	});
	await waitPaletteClosed();
	// 收尾：关掉设置面板，回到主界面。
	await win.keyboard.press("Escape");
	await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") === null), {
		timeout: 10_000,
		desc: "设置面板关闭",
	});
});

await h.check("④ Enter 执行非模态动作后，焦点归还唤起前元素", async () => {
	// 说明：执行「打开设置」这类**会新开模态**的动作时，新模态按设计 §7「先关再执行」
	// 拿到焦点是预期行为（两个模态不嵌套）—— 那条路径的结束焦点在设置面板里，
	// 不是 opener。焦点归还的忠实断言因此放在**非模态动作**上（此处执行「检查更新」，
	// 不弹新模态），以及 ⑤ 的 Esc 路径上（对齐 prd R1）。设计 §10 ④ 把「焦点归还」
	// 与「设置面板出现」写进同一条断言其实互斥，这里按真实且正确的行为拆分。
	await focusNewTaskButton();
	await pressModK();
	await waitPaletteOpen();
	await paletteInput().fill("检查更新");
	await waitUntil(async () => (await optionTexts()).some((t) => t.includes("检查更新")), {
		timeout: 10_000,
		desc: "出现「检查更新」条目",
	});
	await win.keyboard.press("Enter");
	await waitPaletteClosed();
	await waitUntil(
		() =>
			win.evaluate(() => {
				const el = document.activeElement;
				return el !== null && el.classList.contains("new-task") && (el.textContent ?? "").includes("新建任务");
			}),
		{ timeout: 10_000, desc: "焦点归还到唤起前的「新建任务」按钮" },
	);
});

// ══ ⑨ 侧栏入口点击唤起 ══════════════════════════════════════════════
await h.check("⑨ 侧栏常驻入口点击能唤起（鼠标路径）", async () => {
	// 键盘快捷键不能是唯一入口（prd R1）：侧栏有「搜索或跳转」按钮。
	await win.evaluate(() => {
		const btn = [...document.querySelectorAll(".new-task")].find((b) => (b.textContent ?? "").includes("搜索或跳转"));
		if (btn === undefined) throw new Error("找不到侧栏「搜索或跳转」入口");
		btn.click();
	});
	await waitPaletteOpen();
	const ok = await paletteOpen();
	assert.equal(ok, true, "点击侧栏入口应唤起命令面板");
	await win.keyboard.press("Escape");
	await waitPaletteClosed();
});

// ══ ⑩ 浅色 + 深色像素断言 ══════════════════════════════════════════
await h.check("⑩ 浅色主题：面板开/关画面可区分（像素断言）", async () => {
	// 面板关闭态（此刻已关）。
	const closed = (await h.shoot("palette-closed-light")).grid;
	await pressModK();
	await waitPaletteOpen();
	await h.waitForSettled();
	const open = (await h.shoot("palette-open-light2")).grid;
	const diff = diffGrids(closed, open);
	assert.ok(diff > 3, `浅色下开/关面板的画面差异应显著 > 0，实际 ${diff.toFixed(2)} —— 属性切了但画面没变？`);
	await win.keyboard.press("Escape");
	await waitPaletteClosed();
});

await h.check("⑩ 深色主题：data-theme 真的变了，且开/关画面可区分", async () => {
	// 切深色：既走偏好通道（持久化真源），也显式设属性（渲染层唯一真源）。
	await win.evaluate(() => {
		void window.kami?.setThemePreference?.("dark");
		document.documentElement.setAttribute("data-theme", "dark");
	});
	await waitUntil(() => win.evaluate(() => document.documentElement.dataset.theme === "dark"), {
		timeout: 10_000,
		desc: "data-theme 切到 dark",
	});
	await h.waitForSettled();
	const closed = (await h.shoot("palette-closed-dark")).grid;
	await pressModK();
	await waitPaletteOpen();
	await h.waitForSettled();
	const open = (await h.shoot("palette-open-dark")).grid;
	const diff = diffGrids(closed, open);
	assert.ok(diff > 3, `深色下开/关面板的画面差异应显著 > 0，实际 ${diff.toFixed(2)}`);
	// 收尾：切回浅色，避免影响后续（本文件之后没有用例，但保持干净）。
	await win.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
});

// ══ ⑫ 快捷键提示必须是真的 ══════════════════════════════════════════
await h.check("⑫ 行右侧的快捷键提示与真实键位一致（不做假提示）", async () => {
	// 「把快捷键贴在命令右侧」是 VS Code 的做法，价值在于用户不用去别处查。
	// 反面是**假提示**：写了却没绑、或绑错了键 —— 用户照着按，什么也没发生，
	// 比不写更糟。所以这条不只断言「有 hint」，还把提示里的键**按一遍**，
	// 看它是否真的触发那件事。
	await win.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
	// 不假设起点是关着的：上一条用例（⑩ 深色）结束时面板仍开着，
	// 直接按 ⌘K 会把它**关掉**，于是后面等输入框就超时。
	if (await paletteOpen()) {
		await win.keyboard.press("Escape");
		await waitPaletteClosed();
	}
	await pressModK();
	await waitPaletteOpen();
	await h.waitForSettled();

	await paletteInput().fill("折叠侧栏");
	const row = await win.evaluate(() => {
		const opts = [...document.querySelectorAll('.command-palette [role="option"]')];
		const hit = opts.find((el) => (el.querySelector(".ac-label")?.textContent ?? "").includes("侧栏"));
		if (hit === undefined) return null;
		return { hint: hit.querySelector(".ac-hint")?.textContent ?? null };
	});
	assert.notEqual(row, null, "搜「折叠侧栏」应有对应条目");
	const expected = `${MOD === "Meta" ? "⌘" : "Ctrl"}+.`;
	assert.equal(row.hint, expected, `侧栏开合条目的提示应是 ${expected}，实际 ${row.hint}`);

	// 关掉面板，把提示里的键真的按一遍 —— 它必须真的折叠/展开侧栏。
	await win.keyboard.press("Escape");
	await waitPaletteClosed();
	const before = await win.evaluate(() => document.querySelector(".app")?.dataset.sidebar ?? null);
	await win.keyboard.press(`${MOD}+.`);
	await waitUntil(
		async () =>
			(await win.evaluate(() => document.querySelector(".app")?.dataset.sidebar ?? null)) !== before,
		{ timeout: 10_000, desc: "提示里的快捷键真的改变了侧栏状态" },
	);
	// 复原，便于人工看截图时界面是展开态。
	await win.keyboard.press(`${MOD}+.`);
});

await h.finish();
