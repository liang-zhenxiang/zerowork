/**
 * 自绘下拉（`SelectField`）的键盘交互与可访问名的真实 Electron 端到端用例（#427）。
 *
 * 纯逻辑（索引移动 / 循环 / 首末 / 可访问名归一化）有单测
 * （`tests/unit/select-field-core.test.mjs`）。**本文件补的是只有真跑起来才暴露的
 * 那层**：`aria-*` 真的挂到 DOM 上、键盘真的走完整条链路（方向键 → 高亮 →
 * Enter 选中 → 关闭 → 焦点回触发器）、Esc 不会把外层设置弹窗一起关掉、
 * 长列表的高亮真的被滚进面板可视区。
 *
 * ## 两处选择器
 *
 *   · 能力库的「排序」下拉（3 项）：主链路 + 亮暗截图；
 *   · 设置 → 提示词预览的「专家」下拉（17 项）：长列表，验证高亮自动滚进可视区，
 *     以及 Esc 的 stopPropagation（设置弹窗必须还在）。
 *
 * ## 等待纪律
 *
 * 所有 `waitUntil` 谓词都能返回假值（`.trellis/spec/testing/index.md` 第 1 条）；
 * 导航后是空闲态，可以用 `h.waitForSettled()`；截图前等入场动画结束。
 */
import assert from "node:assert/strict";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const h = createHarness({ name: "select-keyboard" });
await h.launch();
const win = h.window();

/** 等有限时长的入场动画结束（主题切换、面板展开）。 */
async function waitFiniteAnimations() {
	await win.evaluate(
		() => new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve(null)))),
	);
	await waitUntil(
		async () => {
			const done = await win.evaluate(
				() =>
					document
						.getAnimations()
						.filter((a) => a.playState === "running")
						.filter((a) => {
							const timing = a.effect?.getComputedTiming?.();
							return timing !== undefined && Number.isFinite(timing.endTime);
						}).length === 0,
			);
			return done ? true : null;
		},
		{ timeout: 10_000, desc: "有限时长动画结束" },
	);
}

/** 侧栏导航到能力库（专家页）。 */
async function openExpertGallery() {
	const clicked = await win.evaluate(() => {
		const nodes = [...document.querySelectorAll("button, a, [role='button'], li, div")];
		const hits = nodes.filter((n) => (n.textContent || "").trim() === "专家·技能·连接器");
		if (hits.length === 0) return false;
		hits[hits.length - 1].click();
		return true;
	});
	assert.ok(clicked, "侧边栏找不到「专家·技能·连接器」");
	await waitUntil(
		() => win.evaluate(() => (document.querySelector(".ex-card .ex-card-name") !== null ? true : null)),
		{ timeout: 20_000, desc: "专家卡片渲染（listExperts 回包后）" },
	);
}

/** 能力库「排序」触发器的语义快照。 */
const sortSnapshot = () =>
	win.evaluate(() => {
		const trigger = document.querySelector(".ex-tools-row .provider-select-trigger");
		if (trigger === null) return null;
		const panel = document.querySelector(".ex-tools-row .provider-select-panel");
		const activeId = trigger.getAttribute("aria-activedescendant");
		const active = activeId === null ? null : document.getElementById(activeId);
		return {
			role: trigger.getAttribute("role"),
			expanded: trigger.getAttribute("aria-expanded"),
			label: trigger.getAttribute("aria-label"),
			controls: trigger.getAttribute("aria-controls"),
			panelId: panel?.id ?? null,
			panelRole: panel?.getAttribute("role") ?? null,
			activeId,
			activeText: active?.textContent?.trim() ?? null,
			activeClassText: document.querySelector(".ex-tools-row .provider-option.active")?.textContent?.trim() ?? null,
			selectedTexts: [...document.querySelectorAll(".ex-tools-row .provider-option[aria-selected='true']")].map(
				(node) => (node.textContent ?? "").trim(),
			),
			focusedIsTrigger: document.activeElement === trigger,
		};
	});

/** 聚焦排序触发器。 */
const focusSort = () =>
	win.evaluate(() => {
		const trigger = document.querySelector(".ex-tools-row .provider-select-trigger");
		if (trigger === null) return false;
		trigger.focus();
		return document.activeElement === trigger;
	});

// ── ① 关闭态语义：combobox + 可访问名带当前值 ─────────────────

await h.check("排序下拉的触发器是 combobox，可访问名包含当前值", async () => {
	await openExpertGallery();
	const focused = await focusSort();
	assert.ok(focused, "排序触发器拿不到焦点");
	const state = await sortSnapshot();
	assert.ok(state !== null, "排序触发器不在 .ex-tools-row");
	assert.equal(state.role, "combobox", `触发器 role 应为 combobox：${state.role}`);
	assert.equal(state.expanded, "false", "未展开时 aria-expanded 应为 false");
	assert.equal(state.panelId, null, "未展开时不该渲染面板");
	assert.ok(
		state.label?.includes("默认"),
		`可访问名应包含当前值「默认」：${state.label}`,
	);
	assert.match(state.label, /^排序方式：默认$/, `可访问名不应重复拼接：${state.label}`);
});

// ── ② ArrowDown 展开：高亮落在选中项，aria 三件套对齐 ─────────

await h.check("ArrowDown 展开并把高亮放在当前选中项", async () => {
	await win.keyboard.press("ArrowDown");
	await waitUntil(
		() => win.evaluate(() => (document.querySelector(".ex-tools-row .provider-select-panel") !== null ? true : null)),
		{ timeout: 5_000, desc: "排序面板展开" },
	);
	const state = await sortSnapshot();
	assert.equal(state.expanded, "true", "展开后 aria-expanded 应为 true");
	assert.equal(state.panelRole, "listbox", "面板应是 listbox");
	assert.ok(state.panelId !== null, "面板缺少 id");
	assert.equal(state.controls, state.panelId, "aria-controls 应指向面板 id");
	assert.ok(state.activeId !== null, "展开后应有 aria-activedescendant");
	assert.equal(state.activeText, "默认", `高亮应落在当前选中项「默认」：${state.activeText}`);
	assert.equal(state.activeClassText, "默认", `高亮 class 应是「默认」：${state.activeClassText}`);
	assert.deepEqual(state.selectedTexts, ["默认"], "aria-selected 只给真正选中的项");
	assert.ok(state.focusedIsTrigger, "焦点应留在触发器上");
});

// ── ③ ArrowDown 移动高亮：高亮 ≠ 选中 ──────────────────────────

await h.check("ArrowDown 移动高亮，选中态不跟着变", async () => {
	await win.keyboard.press("ArrowDown");
	await waitUntil(
		() => win.evaluate(() => {
			const active = document.querySelector(".ex-tools-row .provider-option.active");
			return active?.textContent?.trim() === "名称" ? true : null;
		}),
		{ timeout: 5_000, desc: "高亮移到「名称」" },
	);
	const state = await sortSnapshot();
	assert.equal(state.activeText, "名称", `aria-activedescendant 应指向「名称」：${state.activeText}`);
	assert.equal(state.activeClassText, "名称", `高亮 class 应是「名称」：${state.activeClassText}`);
	assert.deepEqual(state.selectedTexts, ["默认"], "移动高亮不应改动 aria-selected");
	const activeSelected = await win.evaluate(
		() => document.querySelector(".ex-tools-row .provider-option.active")?.getAttribute("aria-selected") ?? null,
	);
	assert.equal(activeSelected, "false", "高亮项本身不是选中项");
});

// ── ④ Enter 选中：关闭、值生效、焦点回触发器 ──────────────────

await h.check("Enter 选中「名称」并关闭，焦点回到触发器", async () => {
	const experts = await win.evaluate(() => window.kami.listExperts());
	const expected = experts
		.map((entry) => entry.displayName)
		.sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
	await win.keyboard.press("Enter");
	const state = await waitUntil(async () => {
		const snapshot = await sortSnapshot();
		return snapshot.expanded === "false" ? snapshot : null;
	}, { timeout: 5_000, desc: "Enter 后面板关闭" });
	assert.equal(state.panelId, null, "选中后面板应卸载");
	assert.equal(state.activeId, null, "关闭后不该保留 aria-activedescendant");
	assert.ok(state.label.includes("名称"), `可访问名应更新为当前值「名称」：${state.label}`);
	assert.match(state.label, /^排序方式：名称$/, `可访问名不应重复拼接：${state.label}`);
	assert.ok(state.focusedIsTrigger, "选中后焦点应回到触发器");
	const names = await waitUntil(async () => {
		const current = await win.evaluate(() =>
			[...document.querySelectorAll(".ex-card .ex-card-name")].map((node) => node.textContent ?? ""),
		);
		return current.length === expected.length && current.every((name, index) => name === expected[index])
			? current
			: null;
	}, { timeout: 10_000, desc: "卡片按名称排序" });
	assert.deepEqual(names, expected, "Enter 之后列表应真的按名称重排");
});

// ── ④b Space 与 Enter 等价：选中高亮项并关闭 ──────────────────

await h.check("展开态 Space 选中高亮项并关闭", async () => {
	await win.keyboard.press("ArrowDown");
	await waitUntil(
		() => win.evaluate(() => (document.querySelector(".ex-tools-row .provider-select-panel") !== null ? true : null)),
		{ timeout: 5_000, desc: "排序面板展开" },
	);
	await win.keyboard.press("ArrowDown");
	await waitUntil(
		() =>
			win.evaluate(() =>
				document.querySelector(".ex-tools-row .provider-option.active")?.textContent?.trim() === "最近安装" ? true : null,
			),
		{ timeout: 5_000, desc: "高亮移到「最近安装」" },
	);
	await win.keyboard.press(" ");
	const state = await waitUntil(async () => {
		const snapshot = await sortSnapshot();
		return snapshot.expanded === "false" ? snapshot : null;
	}, { timeout: 5_000, desc: "Space 后面板关闭" });
	assert.ok(state.label.includes("最近安装"), `可访问名应更新为当前值「最近安装」：${state.label}`);
	assert.ok(state.focusedIsTrigger, "Space 选中后焦点应回到触发器");
	// 重新展开确认选中真的落到高亮项（而不是「只关不选」），再恢复「默认」供后续用例
	await win.keyboard.press("ArrowDown");
	await waitUntil(
		() => win.evaluate(() => (document.querySelector(".ex-tools-row .provider-select-panel") !== null ? true : null)),
		{ timeout: 5_000, desc: "重新展开排序面板" },
	);
	const reopened = await sortSnapshot();
	assert.deepEqual(reopened.selectedTexts, ["最近安装"], "Space 应真正改变选中值，而不只是关闭");
	await win.keyboard.press("Home");
	await win.keyboard.press("Enter");
	await waitUntil(async () => {
		const snapshot = await sortSnapshot();
		return snapshot.expanded === "false" ? snapshot : null;
	}, { timeout: 5_000, desc: "恢复「默认」后关闭" });
});

// ── ⑤ Home / End：跳到首末 ────────────────────────────────────

await h.check("Home / End 跳到首项 / 末项", async () => {
	await win.keyboard.press("ArrowDown");
	await waitUntil(
		() => win.evaluate(() => (document.querySelector(".ex-tools-row .provider-select-panel") !== null ? true : null)),
		{ timeout: 5_000, desc: "再次展开排序面板" },
	);
	await win.keyboard.press("End");
	await waitUntil(
		() => win.evaluate(() => {
			const active = document.querySelector(".ex-tools-row .provider-option.active");
			return active?.textContent?.trim() === "最近安装" ? true : null;
		}),
		{ timeout: 5_000, desc: "End 跳到末项「最近安装」" },
	);
	await win.keyboard.press("Home");
	await waitUntil(
		() => win.evaluate(() => {
			const active = document.querySelector(".ex-tools-row .provider-option.active");
			return active?.textContent?.trim() === "默认" ? true : null;
		}),
		{ timeout: 5_000, desc: "Home 跳回首项「默认」" },
	);
});

// ── ⑥ 展开态亮暗截图（高亮项可见） ───────────────────────────

await h.check("展开态高亮项在亮色下可辨", async () => {
	// 让高亮停在中间一项，截图里同时能看到「高亮」与「选中」两种状态。
	await win.keyboard.press("ArrowDown");
	await waitUntil(
		() => win.evaluate(() => {
			const active = document.querySelector(".ex-tools-row .provider-option.active");
			return active?.textContent?.trim() === "名称" ? true : null;
		}),
		{ timeout: 5_000, desc: "高亮移到「名称」" },
	);
	await waitFiniteAnimations();
	const colors = await win.evaluate(() => {
		const active = document.querySelector(".ex-tools-row .provider-option.active");
		const normal = document.querySelector(
			".ex-tools-row .provider-option:not(.active):not([aria-selected='true'])",
		);
		return {
			active: active === null ? null : getComputedStyle(active).backgroundColor,
			normal: normal === null ? null : getComputedStyle(normal).backgroundColor,
		};
	});
	assert.ok(colors.active !== null && colors.normal !== null, "找不到高亮项 / 普通项");
	assert.notEqual(colors.active, colors.normal, `高亮项底色应与普通项不同：${colors.active} vs ${colors.normal}`);
	await h.shoot("select-keyboard-light");
});

await h.check("展开态高亮项在暗色下可辨", async () => {
	await win.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
	await waitFiniteAnimations();
	await waitUntil(
		() => win.evaluate(() => document.documentElement.getAttribute("data-theme") === "dark"),
		{ timeout: 10_000, desc: "data-theme 切到 dark" },
	);
	const colors = await win.evaluate(() => {
		const active = document.querySelector(".ex-tools-row .provider-option.active");
		const normal = document.querySelector(
			".ex-tools-row .provider-option:not(.active):not([aria-selected='true'])",
		);
		return {
			active: active === null ? null : getComputedStyle(active).backgroundColor,
			normal: normal === null ? null : getComputedStyle(normal).backgroundColor,
		};
	});
	assert.ok(colors.active !== null && colors.normal !== null, "暗色下找不到高亮项 / 普通项");
	assert.notEqual(colors.active, colors.normal, `暗色下高亮项底色应与普通项不同：${colors.active} vs ${colors.normal}`);
	await h.shoot("select-keyboard-dark");
	await win.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
	await waitFiniteAnimations();
});

// ── ⑦ Escape 关闭并把焦点还给触发器 ──────────────────────────

await h.check("Escape 关闭面板并把焦点还给触发器", async () => {
	await win.keyboard.press("Escape");
	const state = await waitUntil(async () => {
		const snapshot = await sortSnapshot();
		return snapshot.expanded === "false" ? snapshot : null;
	}, { timeout: 5_000, desc: "Escape 后面板关闭" });
	assert.equal(state.panelId, null, "Escape 后面板应卸载");
	assert.ok(state.focusedIsTrigger, "Escape 后焦点应在触发器上");
});

// ── ⑧ Tab 关闭并正常离开 ─────────────────────────────────────

await h.check("Tab 关闭面板并移走焦点", async () => {
	await win.keyboard.press("ArrowDown");
	await waitUntil(
		() => win.evaluate(() => (document.querySelector(".ex-tools-row .provider-select-panel") !== null ? true : null)),
		{ timeout: 5_000, desc: "再次展开排序面板" },
	);
	await win.keyboard.press("Tab");
	const state = await waitUntil(async () => {
		const snapshot = await sortSnapshot();
		return snapshot.expanded === "false" ? snapshot : null;
	}, { timeout: 5_000, desc: "Tab 后面板关闭" });
	assert.equal(state.focusedIsTrigger, false, "Tab 应把焦点移出触发器");
});

// ── ⑨ 设置弹窗里的长列表：高亮自动滚进可视区 + Esc 不外溢 ────

/** 设置 → 提示词预览里的「专家」下拉触发器（17 项，足以溢出 280px 面板）。 */
const previewExpertTrigger = () =>
	win.evaluate(() => {
		const fields = [...document.querySelectorAll(".settings-card .preview-field")];
		const field = fields.find(
			(node) => (node.querySelector(".preview-field-label")?.textContent ?? "").trim() === "专家",
		);
		const trigger = field?.querySelector(".provider-select-trigger") ?? null;
		if (trigger === null) return null;
		trigger.focus();
		return {
			focused: document.activeElement === trigger,
			label: trigger.getAttribute("aria-label"),
			role: trigger.getAttribute("role"),
		};
	});

await h.check("设置 → 提示词预览：长列表高亮自动滚进面板可视区", async () => {
	const opened = await win.evaluate(() => {
		const btn = document.querySelector('[aria-label="设置"]');
		if (btn === null) return false;
		btn.click();
		return true;
	});
	assert.ok(opened, "找不到设置按钮");
	await waitUntil(
		() => win.evaluate(() => (document.querySelector(".settings-card") !== null ? true : null)),
		{ timeout: 15_000, desc: "设置对话框挂上" },
	);
	const clicked = await win.evaluate(() => {
		const item = [...document.querySelectorAll(".settings-nav-item")].find(
			(node) => (node.textContent ?? "").trim() === "提示词预览",
		);
		if (item === undefined) return false;
		item.click();
		return true;
	});
	assert.ok(clicked, "设置侧栏找不到「提示词预览」");
	// 专家列表要等 listExperts 回包后才渲染出下拉。
	const ready = await waitUntil(
		async () => {
			const fields = await win.evaluate(() =>
				[...document.querySelectorAll(".settings-card .preview-field")].map(
					(node) => (node.querySelector(".preview-field-label")?.textContent ?? "").trim(),
				),
			);
			return fields.includes("专家") ? fields : null;
		},
		{ timeout: 20_000, desc: "提示词预览的专家下拉渲染" },
	);
	assert.ok(ready.includes("专家"), `预览区缺少「专家」字段：${ready.join("、")}`);
	const state = await previewExpertTrigger();
	assert.ok(state !== null, "找不到专家下拉触发器");
	assert.equal(state.role, "combobox", "预览专家触发器也应是 combobox");
	assert.ok(state.focused, "专家下拉触发器拿不到焦点");
	assert.ok(state.label?.includes("不选专家"), `可访问名应包含当前值：${state.label}`);

	await win.keyboard.press("ArrowDown");
	const openedPanel = await waitUntil(
		() => win.evaluate(() => {
			const panel = document.querySelector(".settings-card .provider-select-panel");
			if (panel === null) return null;
			const labels = [...panel.querySelectorAll(".provider-option")].map((node) => (node.textContent ?? "").trim());
			return labels.length > 8 ? { count: labels.length, last: labels[labels.length - 1] } : null;
		}),
		{ timeout: 10_000, desc: "专家面板展开且选项足够长" },
	);
	assert.ok(openedPanel.count > 8, `专家选项太少，无法验证滚动：${openedPanel.count}`);

	await win.keyboard.press("End");
	const scrolled = await waitUntil(
		() => win.evaluate(() => {
			const panel = document.querySelector(".settings-card .provider-select-panel");
			const active = document.querySelector(".settings-card .provider-option.active");
			if (panel === null || active === null) return null;
			const panelRect = panel.getBoundingClientRect();
			const activeRect = active.getBoundingClientRect();
			const inView = activeRect.top >= panelRect.top - 1 && activeRect.bottom <= panelRect.bottom + 1;
			return inView ? { scrollTop: panel.scrollTop, activeText: active.textContent?.trim() ?? "" } : null;
		}),
		{ timeout: 10_000, desc: "End 后末项滚进面板可视区" },
	);
	assert.ok(scrolled.scrollTop > 0, `面板应被滚动（scrollTop=${scrolled.scrollTop}）`);
	assert.equal(scrolled.activeText, openedPanel.last, `End 应高亮末项「${openedPanel.last}」：${scrolled.activeText}`);

	// Esc 只关下拉，不关设置弹窗 —— 这是 stopPropagation 的验收点。
	await win.keyboard.press("Escape");
	await waitUntil(
		() => win.evaluate(() => (document.querySelector(".settings-card .provider-select-panel") === null ? true : null)),
		{ timeout: 5_000, desc: "Escape 关掉下拉面板" },
	);
	const stillOpen = await win.evaluate(() => document.querySelector(".settings-card") !== null);
	assert.ok(stillOpen, "Escape 只应关下拉，不应把外层设置弹窗一起关掉");
});

await h.finish();
