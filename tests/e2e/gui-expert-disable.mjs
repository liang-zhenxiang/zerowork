/**
 * 专家停用与恢复（#426）的真实 Electron 端到端用例。
 *
 * 覆盖的是「只有真跑起来才暴露」的那几件事 —— 停用如果只把卡片藏起来，
 * 下面每一条都还能绿，所以这里逐条钉住「假的停用」会漏掉的路径：
 *   ① 能力库详情可停用 → 卡片带停用标记，默认视图不再显示它；
 *   ② 「显示已停用」把它放回来，计数与列表同源；
 *   ③ 首页 / 对话共用的专家菜单里它消失，恢复后又回来；
 *   ④ `setExpert(停用 id)` 被拒绝，错误可操作（指向能力库恢复）；
 *   ⑤ 已绑定会话**保留绑定**，下一轮系统提示词不含人格与私有技能，
 *      state 下发 `expertDisabled: true`，专家 chip 标「已停用」；
 *   ⑥ 恢复后下一轮的系统提示词重新包含人格与私有技能。
 *
 * ⑤⑥ 的证据取自 mock 模型服务收到的 system 消息 —— 「提示词里到底有没有」
 * 只能从对端看，不能从界面猜（同 projects.mjs 的常驻指令用例）。
 *
 * 夹具是一个**用户自建专家**（写在隔离的配置目录里），不是内置专家：
 * 人格正文与私有技能描述都是本用例独有的标记，断言不会依赖 `resources/**`
 * 的文案（那些是第三方内容，随时可能被替换）。
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

const EXPERT_NAME = "e2e-toggle-expert";
const EXPERT_DISPLAY_NAME = "停用演示专家";
const PERSONA_MARKER = "E2E_PERSONA_MARKER_426";
const SKILL_NAME = "e2e-disable-private-skill";
const SKILL_MARKER = "E2E_PRIVATE_SKILL_MARKER_426";
/** 技能正文（`/skill:` 手动展开时进的是用户消息，不是系统提示词的技能清单段）。 */
const SKILL_BODY_MARKER = "E2E_SKILL_BODY_426";
const REPLY_TEXT = "MOCK_REPLY_已收到你的消息";
const USER_TEXT = "你好，请回复";

const PROVIDER_ID = "e2e-expert-disable";
const MODEL_ID = "mock-model";
const MODEL_KEY = `${PROVIDER_ID}/${MODEL_ID}`;

const h = createHarness({ name: "expert-disable" });

/* ── 夹具：配置目录里的一位用户自建专家（带一个私有技能） ── */
function writeFixtureExpert() {
	const root = join(h.CONFIG_DIR, "experts", EXPERT_NAME);
	mkdirSync(join(root, "skills", SKILL_NAME), { recursive: true });
	writeFileSync(
		join(root, "expert.md"),
		`---
name: ${EXPERT_NAME}
description: 端到端用的可停用专家
displayName: ${EXPERT_DISPLAY_NAME}
profession: 演示
displayDescription: 停用与恢复的端到端夹具
quickPrompts:
  - 用这位专家写一段话
  - 用这位专家改一段话
  - 用这位专家检查一段话
tags:
  - 停用演示
  - 端到端
  - 夹具
expertType: expert
---

你是停用演示专家。${PERSONA_MARKER}
`,
		"utf8",
	);
	writeFileSync(
		join(root, "skills", SKILL_NAME, "SKILL.md"),
		`---
name: ${SKILL_NAME}
description: ${SKILL_MARKER}
---

${SKILL_BODY_MARKER} 先分段，再逐条核对。
`,
		"utf8",
	);
	mkdirSync(h.WORKSPACE_DIR, { recursive: true });
	return root;
}

writeFixtureExpert();

const mock = await startMockModelServer({ reply: REPLY_TEXT });
console.log(`✓ mock 模型服务已就绪：${mock.baseUrl}`);

await h.launch();
const win = h.window();
await h.dismissWhatsNew();

/* ── 工具函数 ─────────────────────────────────────────────── */

const listExperts = () => win.evaluate(() => globalThis.kami.listExperts());
const fixtureOf = (list) => list.find((entry) => entry.name === EXPERT_NAME);

/** 从一轮请求里取 system 消息全文（openai-completions 形状）。 */
function systemTextOf(request) {
	const messages = request?.body?.messages ?? [];
	const system = messages.find((message) => message.role === "system");
	return typeof system?.content === "string" ? system.content : "";
}

/** 一条消息的文本（字符串或 part 数组两种形状）。 */
function messageText(message) {
	if (typeof message?.content === "string") return message.content;
	if (Array.isArray(message?.content)) {
		return message.content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
	}
	return "";
}

/**
 * 一轮请求里**承载 `/skill:` 的那条 user 消息**。
 *
 * 不能取「最后一条 user」：pi 会在消息列表尾部再挂一条 hidden context 快照
 * （`<system-reminder data-role="user-context">`），它永远排在真正的用户消息之后。
 * 技能展开后用户消息以 `<skill …>` 开头，未展开时保留 `/skill:` 字面量 ——
 * 两种形态都能定位到。
 */
function skillPromptTextOf(request) {
	const messages = request?.body?.messages ?? [];
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message?.role !== "user") continue;
		const text = messageText(message);
		if (text.includes("/skill:") || text.includes("<skill ")) return text;
	}
	return "";
}

/** 等有限时长动画（CSS transition / 一次性 animation）结束再截图。 */
async function waitFiniteAnimations() {
	await win.evaluate(
		() => new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve(null)))),
	);
	await waitUntil(
		async () => {
			const done = await win.evaluate(() =>
				document
					.getAnimations()
					.filter((a) => a.playState === "running")
					.filter((a) => {
						const timing = a.effect?.getComputedTiming?.();
						return timing !== undefined && Number.isFinite(timing.endTime);
					})
					.length === 0,
			);
			return done ? true : null;
		},
		{ timeout: 10_000, desc: "动画结束" },
	);
}

/** 打开能力库（专家页）。 */
async function openGallery() {
	const clicked = await win.evaluate(() => {
		const nodes = [...document.querySelectorAll("button, a, [role='button'], li, div")];
		const hits = nodes.filter((node) => (node.textContent || "").trim() === "专家·技能·连接器");
		if (hits.length === 0) return false;
		hits[hits.length - 1].click();
		return true;
	});
	assert.ok(clicked, "侧边栏找不到「专家·技能·连接器」");
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".ex-card .ex-card-name") !== null ? true : null),
		{ timeout: 20_000, desc: "能力库卡片渲染" },
	);
}

/** 回到首页（能力库左上角「返回」）。 */
async function backHome() {
	const clicked = await win.evaluate(() => {
		const button = document.querySelector(".skills-head button[aria-label='返回']");
		if (button === null) return false;
		button.click();
		return true;
	});
	assert.ok(clicked, "能力库找不到返回按钮");
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".skills-head") === null ? true : null),
		{ timeout: 10_000, desc: "离开能力库" },
	);
}

/** 打开首页「更多操作 ▸ 专家」子菜单，返回其中列出的专家名。 */
async function openExpertMenu() {
	// 视图切换是异步的：backHome 只等到能力库卸载，首页输入卡与工具栏可能还差一拍。
	// 等触发按钮本身出现再点，别拿「上一屏刚消失」当就绪信号。
	await waitUntil(
		() => win.evaluate(() => document.querySelector('[aria-label="更多操作"]') !== null ? true : null),
		{ timeout: 15_000, desc: "首页「更多操作」按钮就绪" },
	);
	const opened = await win.evaluate(() => {
		const trigger = document.querySelector('[aria-label="更多操作"]');
		if (trigger === null) return false;
		trigger.click();
		return true;
	});
	assert.ok(opened, "找不到「更多操作」按钮");
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".plus-menu") !== null ? true : null),
		{ timeout: 10_000, desc: "更多操作菜单展开" },
	);
	const expanded = await win.evaluate(() => {
		// 行文本是「专家 ▸」（图标 + 标签 + 插入符），不能用全等匹配。
		const item = [...document.querySelectorAll(".plus-menu .plus-menu-item")].find(
			(node) => (node.textContent || "").trim().startsWith("专家"),
		);
		if (item === undefined) return false;
		item.click();
		return true;
	});
	assert.ok(expanded, "更多操作菜单里找不到「专家」子菜单");
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".plus-menu .plus-menu-sub") !== null ? true : null),
		{ timeout: 10_000, desc: "专家子菜单展开" },
	);
	return win.evaluate(() =>
		[...document.querySelectorAll(".plus-menu .plus-menu-sub .plus-menu-mode-item .plus-menu-mode-label")].map(
			(node) => (node.textContent || "").trim(),
		),
	);
}

async function closePlusMenu() {
	await win.evaluate(() => {
		document.querySelector(".ws-backdrop")?.click();
	});
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".plus-menu") === null ? true : null),
		{ timeout: 10_000, desc: "更多操作菜单收起" },
	);
}

/** 在能力库卡片网格里找某位专家的卡片（返回其 class 与角标文本）。 */
const cardOf = (name) =>
	win.evaluate((displayName) => {
		const card = [...document.querySelectorAll(".ex-card")].find((node) =>
			(node.textContent || "").includes(displayName),
		);
		if (card === undefined) return null;
		return {
			className: card.className,
			badges: [...card.querySelectorAll(".ex-source-badge")].map((node) => (node.textContent || "").trim()),
			hasUse: card.querySelector(".ex-card-use") !== null,
		};
	}, name);

/** 把某张卡片滚到可视区中央 —— 截图要拍到的是那张卡，不是上一屏。 */
async function scrollCardIntoView(name) {
	await win.evaluate((displayName) => {
		const card = [...document.querySelectorAll(".ex-card")].find((node) =>
			(node.textContent || "").includes(displayName),
		);
		card?.scrollIntoView({ block: "center" });
	}, name);
}

/** 打开某位专家的详情（点整卡）。 */
async function openDetail(name) {
	const opened = await win.evaluate((displayName) => {
		const card = [...document.querySelectorAll(".ex-card")].find((node) =>
			(node.textContent || "").includes(displayName),
		);
		if (card === undefined) return false;
		card.click();
		return true;
	}, name);
	assert.ok(opened, `点不开「${name}」的卡片`);
	await waitUntil(
		() => win.evaluate((displayName) => {
			const modal = document.querySelector(".ex-modal:not(.pack-preview)");
			if (modal === null) return null;
			return (modal.getAttribute("aria-label") || "").includes(displayName) ? modal.innerText : null;
		}, name),
		{ timeout: 10_000, desc: "专家详情挂载" },
	);
}

async function clickInDetail(text) {
	const clicked = await win.evaluate((label) => {
		const button = [...document.querySelectorAll(".ex-modal:not(.pack-preview) button")].find(
			(node) => (node.textContent || "").trim() === label,
		);
		if (button === undefined) return false;
		button.click();
		return true;
	}, text);
	assert.ok(clicked, `详情里找不到「${text}」按钮`);
}

async function closeDetail() {
	await win.evaluate(() => {
		document.querySelector(".ex-modal:not(.pack-preview) .ex-modal-close")?.click();
	});
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".ex-modal") === null ? true : null),
		{ timeout: 10_000, desc: "专家详情关闭" },
	);
}

/* ── 准备：注册 mock 提供方并选中模型 ──────────────────────── */
await h.check("准备：注册 mock 提供方、设置 Key 并选中模型", async () => {
	const r = await win.evaluate(
		async ({ id, baseUrl, modelKey }) => {
			try {
				const k = globalThis.kami;
				await k.saveCustomProvider(
					{
						id,
						name: "E2E Expert Disable",
						baseUrl,
						api: "openai-completions",
						models: [
							{
								id: "mock-model",
								name: "Mock Model",
								reasoning: false,
								vision: false,
								contextWindow: 128000,
								maxTokens: 4096,
							},
						],
					},
					"sk-e2e-dummy",
				);
				await k.setApiKey(id, "sk-e2e-dummy");
				await k.setModel(modelKey);
				return { ok: true };
			} catch (e) {
				return { ok: false, err: String(e?.message ?? e).slice(0, 300) };
			}
		},
		{ id: PROVIDER_ID, baseUrl: mock.baseUrl, modelKey: MODEL_KEY },
	);
	assert.ok(r.ok, `准备失败：${r.err}`);
});

/* ── ① 能力库：fixture 在默认视图里 ────────────────────────── */
await h.check("① 能力库默认视图列出夹具专家，卡上是「自建」而不是「已停用」", async () => {
	await openGallery();
	const card = await cardOf(EXPERT_DISPLAY_NAME);
	assert.ok(card, "默认视图里找不到夹具专家");
	assert.equal(card.className.includes("ex-card-disabled"), false, "未停用却有停用样式");
	assert.ok(card.badges.includes("自建"), `卡片缺少「自建」徽标：${card.badges.join(" / ")}`);
	assert.ok(card.hasUse, "未停用的卡片应有「使用」按钮");
	const list = await listExperts();
	assert.equal(fixtureOf(list)?.disabled, undefined, "listExperts 不该给未停用的专家带 disabled");
});

/* ── ② 详情停用 → 卡片标记 → 默认视图隐藏 ─────────────────── */
await h.check("② 详情「停用专家」→ 卡片带标记，默认视图不再显示它", async () => {
	await openDetail(EXPERT_DISPLAY_NAME);
	const initial = await win.evaluate(() => {
		const modal = document.querySelector(".ex-modal:not(.pack-preview)");
		return {
			note: modal?.querySelector(".ex-modal-disabled-note") !== null,
			main: modal?.querySelector(".ex-modal-use")?.textContent?.trim() ?? "",
		};
	});
	assert.equal(initial.note, false, "未停用时不该显示停用说明");
	assert.equal(initial.main, "使用专家");

	await clickInDetail("停用专家");
	// 等 daemon 落盘并回推：详情里的说明与主按钮先变。
	await waitUntil(
		() => win.evaluate(() => {
			const modal = document.querySelector(".ex-modal:not(.pack-preview)");
			if (modal === null) return null;
			const note = modal.querySelector(".ex-modal-disabled-note")?.textContent ?? "";
			const main = modal.querySelector(".ex-modal-use")?.textContent?.trim() ?? "";
			return note.includes("不删除任何文件") && main === "恢复专家" ? true : null;
		}),
		{ timeout: 15_000, desc: "详情切到停用态" },
	);
	// 动作行的「停用专家」此刻已卸载：焦点必须落到新出现的「恢复专家」，
	// 否则会掉回 body，下一次 Tab 从关闭键重新开始（#426 设计评审）。
	await waitUntil(
		() => win.evaluate(() => {
			const active = document.activeElement;
			return active?.classList.contains("ex-modal-use") === true &&
				(active.textContent || "").trim() === "恢复专家"
				? true
				: null;
		}),
		{ timeout: 5_000, desc: "焦点落在「恢复专家」上" },
	);
	// 读屏入口的可访问名也要带状态：徽标是视觉文本，Tab 进来只听到标题不够。
	const modalLabel = await win.evaluate(
		() => document.querySelector(".ex-modal:not(.pack-preview)")?.getAttribute("aria-label") ?? "",
	);
	assert.ok(modalLabel.includes("已停用"), `弹窗可访问名没带停用状态：${modalLabel}`);
	// 列表也真的读到 disabled（不是只在弹窗里改了个本地标记）。
	const list = await waitUntil(async () => {
		const entries = await listExperts();
		return fixtureOf(entries)?.disabled === true ? entries : null;
	}, { timeout: 10_000, desc: "listExperts 带 disabled: true" });
	assert.equal(fixtureOf(list).disabled, true);
	// 其它字段不变（只增不改）。
	assert.equal(fixtureOf(list).displayName, EXPERT_DISPLAY_NAME);
	assert.equal(fixtureOf(list).source, "user");

	await waitFiniteAnimations();
	await h.shoot("detail-disabled");
	await closeDetail();

	// 默认视图收起停用项；卡片上的停用样式在「显示已停用」打开后才看得到。
	await waitUntil(
		() => win.evaluate((name) => {
			const card = [...document.querySelectorAll(".ex-card")].find((node) =>
				(node.textContent || "").includes(name),
			);
			return card === undefined ? true : null;
		}, EXPERT_DISPLAY_NAME),
		{ timeout: 10_000, desc: "停用后卡片从默认视图消失" },
	);
	const toggle = await win.evaluate(() => {
		const button = [...document.querySelectorAll(".ex-tools-row .mini-btn")].find((node) =>
			(node.textContent || "").includes("显示已停用"),
		);
		return button === undefined
			? null
			: { text: (button.textContent || "").trim(), pressed: button.getAttribute("aria-pressed") };
	});
	assert.ok(toggle, "停用后应出现「显示已停用」开关");
	assert.match(toggle.text, /显示已停用（\d+）/);
	assert.equal(toggle.pressed, "false");
});

/* ── ③ 「显示已停用」：卡片回来并带标记，计数同源 ──────────── */
await h.check("③ 打开「显示已停用」→ 卡片回来并带标记，来源计数把它算进去", async () => {
	const before = await win.evaluate(() =>
		[...document.querySelectorAll(".ex-source-chip")].find((node) =>
			(node.textContent || "").trim().startsWith("自建"),
		)?.textContent ?? "",
	);
	const clicked = await win.evaluate(() => {
		const button = [...document.querySelectorAll(".ex-tools-row .mini-btn")].find((node) =>
			(node.textContent || "").includes("显示已停用"),
		);
		if (button === undefined) return false;
		button.click();
		return true;
	});
	assert.ok(clicked, "点不到「显示已停用」");
	const disabledCard = await waitUntil(
		async () => {
			const probe = await win.evaluate((name) => {
				const entry = [...document.querySelectorAll(".ex-card")].find((node) =>
					(node.textContent || "").includes(name),
				);
				if (entry === undefined) return null;
				return {
					className: entry.className,
					badges: [...entry.querySelectorAll(".ex-source-badge")].map((node) => (node.textContent || "").trim()),
					hasUse: entry.querySelector(".ex-card-use") !== null,
					openLabel: entry.querySelector(".ex-card-open")?.getAttribute("aria-label") ?? "",
				};
			}, EXPERT_DISPLAY_NAME);
			return probe !== null && probe.badges.includes("已停用") ? probe : null;
		},
		{ timeout: 10_000, desc: "打开「显示已停用」后卡片回来并带标记" },
	);
	assert.ok(disabledCard.className.includes("ex-card-disabled"), "停用卡片缺少 .ex-card-disabled");
	assert.equal(disabledCard.hasUse, false, "停用卡片不该渲染「使用」按钮");
	assert.ok(disabledCard.openLabel.includes("已停用"), `卡片详情入口的可访问名没带停用状态：${disabledCard.openLabel}`);
	const after = await win.evaluate(() =>
		[...document.querySelectorAll(".ex-source-chip")].find((node) =>
			(node.textContent || "").trim().startsWith("自建"),
		)?.textContent ?? "",
	);
	assert.notEqual(after, before, `来源计数应把停用项计入：${before} -> ${after}`);
	const pressed = await win.evaluate(() => {
		const button = [...document.querySelectorAll(".ex-tools-row .mini-btn")].find((node) =>
			(node.textContent || "").includes("显示已停用"),
		);
		return button?.getAttribute("aria-pressed") ?? "";
	});
	assert.equal(pressed, "true");
	await scrollCardIntoView(EXPERT_DISPLAY_NAME);
	await waitFiniteAnimations();
	await h.shoot("gallery-disabled-visible");
});

/* ── ④ 选择器：菜单里消失 ─────────────────────────────────── */
await h.check("④ 停用后首页专家菜单不再列出它", async () => {
	await backHome();
	const names = await openExpertMenu();
	assert.equal(names.includes(EXPERT_DISPLAY_NAME), false, `菜单里仍有停用专家：${names.join(" / ")}`);
	await closePlusMenu();
});

/* ── ⑤ 选中守卫：setExpert 拒绝，消息可操作 ────────────────── */
await h.check("⑤ setExpert(停用 id) 被拒绝，错误指向能力库恢复", async () => {
	const r = await win.evaluate(async (id) => {
		try {
			await globalThis.kami.setExpert(id);
			return { ok: true };
		} catch (e) {
			return { ok: false, message: String(e?.message ?? e) };
		}
	}, EXPERT_NAME);
	assert.equal(r.ok, false, "停用的专家不应能被重新选中");
	assert.ok(r.message.includes("已停用"), `错误消息没说明停用：${r.message}`);
	assert.ok(r.message.includes("能力库"), `错误消息没给出恢复路径：${r.message}`);
});

/* ── ⑥ 恢复：卡片与菜单都回来 ─────────────────────────────── */
await h.check("⑥ 在详情里恢复 → 卡片与菜单重新出现", async () => {
	await openGallery();
	// 重新进入能力库后开关复位为关：先打开「显示已停用」。
	await waitUntil(
		() => win.evaluate(() => {
			const button = [...document.querySelectorAll(".ex-tools-row .mini-btn")].find((node) =>
				(node.textContent || "").includes("显示已停用"),
			);
			return button !== undefined ? true : null;
		}),
		{ timeout: 10_000, desc: "「显示已停用」开关出现" },
	);
	await win.evaluate(() => {
		const button = [...document.querySelectorAll(".ex-tools-row .mini-btn")].find((node) =>
			(node.textContent || "").includes("显示已停用"),
		);
		button?.click();
	});
	await waitUntil(
		() => win.evaluate((name) => {
			const card = [...document.querySelectorAll(".ex-card")].find((node) =>
				(node.textContent || "").includes(name),
			);
			return card !== undefined && card.className.includes("ex-card-disabled") ? true : null;
		}, EXPERT_DISPLAY_NAME),
		{ timeout: 10_000, desc: "停用卡片重新出现" },
	);
	await openDetail(EXPERT_DISPLAY_NAME);
	const restore = await win.evaluate(() => {
		const modal = document.querySelector(".ex-modal:not(.pack-preview)");
		return modal?.querySelector(".ex-modal-use")?.textContent?.trim() ?? "";
	});
	assert.equal(restore, "恢复专家", "停用态的主按钮应是「恢复专家」");
	await clickInDetail("恢复专家");
	await waitUntil(
		() => win.evaluate(() => {
			const modal = document.querySelector(".ex-modal:not(.pack-preview)");
			if (modal === null) return null;
			return modal.querySelector(".ex-modal-disabled-note") === null &&
				modal.querySelector(".ex-modal-use")?.textContent?.trim() === "使用专家"
				? true
				: null;
		}),
		{ timeout: 15_000, desc: "详情切回可用态" },
	);
	const list = await waitUntil(async () => {
		const entries = await listExperts();
		return fixtureOf(entries)?.disabled === undefined ? entries : null;
	}, { timeout: 10_000, desc: "listExperts 不再带 disabled" });
	assert.equal(fixtureOf(list).disabled, undefined);
	await closeDetail();
	await backHome();
	const names = await openExpertMenu();
	assert.ok(names.includes(EXPERT_DISPLAY_NAME), `恢复后菜单里应重新出现：${names.join(" / ")}`);
	// 从菜单选中它（走真实的选择路径，验证恢复后确实可选中）。
	const picked = await win.evaluate((displayName) => {
		const item = [...document.querySelectorAll(".plus-menu .plus-menu-sub .plus-menu-mode-item")].find(
			(node) => (node.textContent || "").includes(displayName),
		);
		if (item === undefined) return false;
		item.click();
		return true;
	}, EXPERT_DISPLAY_NAME);
	assert.ok(picked, "点不到恢复后的专家项");
	await waitUntil(
		() => win.evaluate(async (id) => {
			const snapshot = await globalThis.kami.snapshot();
			return snapshot?.state?.expertId === id ? true : null;
		}, EXPERT_NAME),
		{ timeout: 10_000, desc: "选中恢复后的专家" },
	);
});

/* ── ⑦ 已绑定会话：保留绑定、停用生效、状态标记 ─────────────── */
await h.check("⑦ 绑定会话停用后：状态带 expertDisabled，chip 标「已停用」", async () => {
	const r = await win.evaluate(async (id) => {
		try {
			await globalThis.kami.setExpertDisabled(id, true);
			return { ok: true };
		} catch (e) {
			return { ok: false, message: String(e?.message ?? e) };
		}
	}, EXPERT_NAME);
	assert.ok(r.ok, `停用失败：${r.message}`);
	const state = await waitUntil(
		() => win.evaluate(async (id) => {
			const snapshot = await globalThis.kami.snapshot();
			const value = snapshot?.state ?? {};
			return value.expertId === id ? value : null;
		}, EXPERT_NAME),
		{ timeout: 10_000, desc: "会话状态回推" },
	);
	// 绑定保留 + 标记已停用：两者必须同时成立（清空绑定是另一个产品决定）。
	assert.equal(state.expertId, EXPERT_NAME);
	assert.equal(state.expertDisabled, true);
	const chip = await waitUntil(
		() => win.evaluate(() => {
			const node = document.querySelector(".expert-chip.expert-chip-disabled");
			if (node === null) return null;
			return {
				text: (node.textContent || "").trim(),
				badge: node.querySelector(".expert-chip-badge")?.textContent ?? "",
				// role=status 的整段文本里要有恢复路径（sr-only 也在这里）。
				announcement: node.textContent || "",
			};
		}),
		{ timeout: 10_000, desc: "专家 chip 标出「已停用」" },
	);
	assert.ok(chip.text.includes(EXPERT_DISPLAY_NAME), `chip 上不是目标专家：${chip.text}`);
	assert.equal(chip.badge, "已停用");
	assert.ok(chip.announcement.includes("显示已停用"), `chip 没给出恢复路径：${chip.announcement}`);
	await waitFiniteAnimations();
	await h.shoot("home-chip-disabled");
});

/* ── ⑦·补 设置 → 提示词预览：下拉里也不出现，并说明按「不选专家」组装 ── */
await h.check("⑦·补 设置 → 提示词预览不列出停用专家", async () => {
	await win.evaluate(() => {
		const button = document.querySelector('[aria-label="设置"]');
		if (button === null) throw new Error("找不到设置按钮");
		button.click();
	});
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".settings-card") !== null ? true : null),
		{ timeout: 15_000, desc: "设置对话框挂上" },
	);
	const navigated = await win.evaluate(() => {
		const item = [...document.querySelectorAll(".settings-nav-item")].find(
			(node) => (node.textContent || "").trim() === "提示词预览",
		);
		if (item === undefined) return false;
		item.click();
		return true;
	});
	assert.ok(navigated, "设置侧栏找不到「提示词预览」");
	// 预览段异步拉 snapshot / listExperts：等触发器与「已停用」说明都就绪。
	await waitUntil(
		() => win.evaluate(() => {
			const trigger = document.querySelector('[aria-label^="预览专家"]');
			const note = [...document.querySelectorAll(".provider-meta")].some((node) =>
				(node.textContent || "").includes("已停用"),
			);
			return trigger !== null && note ? true : null;
		}),
		{ timeout: 20_000, desc: "提示词预览的专家下拉与停用说明就绪" },
	);
	const labels = await win.evaluate(async () => {
		const trigger = document.querySelector('[aria-label^="预览专家"]');
		trigger.click();
		await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)));
		return [...document.querySelectorAll(".provider-select-panel .provider-option")].map((node) =>
			(node.textContent || "").trim(),
		);
	});
	assert.equal(labels.includes(EXPERT_DISPLAY_NAME), false, `预览下拉仍列出停用专家：${labels.join(" / ")}`);
	assert.ok(labels.includes("不选专家"), `预览下拉缺少「不选专家」：${labels.join(" / ")}`);
	await win.keyboard.press("Escape");
	await win.evaluate(() => {
		document.querySelector('[aria-label="关闭设置"]')?.click();
	});
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".settings-card") === null ? true : null),
		{ timeout: 10_000, desc: "设置对话框关闭" },
	);
});

/**
 * 发一条消息，并返回 mock 为**这一条**新收到的请求。
 *
 * 慢 runner 上的真实竞态（#491）：上一条发出后界面可能仍在流式，此时 Enter 的
 * 语义是「并进当前轮 / 排队」—— 不会产生一次新的模型请求，mock 就永远等不到
 * 第 2、3 条，⑧·补 / ⑨ 于是 40s 超时（本地快、CI 慢，只在这个窗口里暴露）。
 * 所以先等界面回到「没有运行中的轮次」，再填、再发。判据用流式期间才存在的
 * 停止按钮（`aria-label="停止"`），而不是输入框占位文案 —— 占位文案在首页是
 * 轮播示例、在会话里是「继续追问…」，按文案判断会把「首页」误当成「忙碌」。
 *
 * 请求按**发送前的基线**取，不用绝对下标：任何多余请求都不该让断言取错条目。
 * Enter 被吞（焦点被抢 / 重渲染）时草稿还留在框里 —— 补按一次，而不是干等 40s；
 * 已经发出的那条会立即清空草稿，因此不会重复发送。
 */
async function sendAndExpectRequest(text, desc) {
	const box = win.locator('[aria-label="消息输入框"]');
	await box.waitFor({ state: "visible", timeout: 30_000 });
	await waitUntil(
		() =>
			win.evaluate(() =>
				document.querySelector('[aria-label="停止"]') === null ? true : null,
			),
		{ timeout: 40_000, desc: `${desc}：等上一轮归位` },
	);
	const before = mock.requests.length;
	await box.fill(text);
	await waitUntil(async () => ((await box.inputValue()) === text ? true : null), {
		timeout: 10_000,
		desc: `${desc}：草稿进入输入框`,
	});
	await box.press("Enter");
	await waitUntil(
		async () => {
			if (mock.requests.length > before) return true;
			if ((await box.inputValue()) === text) await box.press("Enter");
			return null;
		},
		{ timeout: 40_000, desc: `${desc}：mock 收到新请求` },
	);
	return mock.requests[before];
}

/* ── ⑧ 提示词：停用后不含人格与私有技能；恢复后重新包含 ────── */
await h.check("⑧ 停用后下一轮系统提示词不含人格与私有技能", async () => {
	const request = await sendAndExpectRequest(`${USER_TEXT}（停用中）`, "mock 收到停用后的第 1 轮");
	const system = systemTextOf(request);
	assert.ok(!system.includes(PERSONA_MARKER), "停用后系统提示词仍含专家人格正文");
	assert.ok(!system.includes(SKILL_MARKER), "停用后系统提示词仍含专家私有技能");
	// 反向对照：人格缺席不是因为整段提示词没组装出来。
	assert.ok(system.length > 0, "系统提示词为空，这条断言没有意义");
});

await h.check("⑧·补 停用后手动 /skill: 也展不开它的私有技能", async () => {
	const request = await sendAndExpectRequest(
		`/skill:${SKILL_NAME} 停用中手动调用`,
		"mock 收到停用后的手动技能请求",
	);
	const userText = skillPromptTextOf(request);
	// 技能没被展开：正文标记不出现，命令原样留给模型（与未知技能同一形态）。
	assert.ok(!userText.includes(SKILL_BODY_MARKER), "停用后手动调用仍展开了私有技能正文");
	assert.ok(userText.includes(`/skill:${SKILL_NAME}`), `未展开时命令应原样保留：${userText.slice(0, 200)}`);
});

await h.check("⑨ 恢复后下一轮系统提示词重新包含人格与私有技能", async () => {
	const r = await win.evaluate(async (id) => {
		try {
			await globalThis.kami.setExpertDisabled(id, false);
			return { ok: true };
		} catch (e) {
			return { ok: false, message: String(e?.message ?? e) };
		}
	}, EXPERT_NAME);
	assert.ok(r.ok, `恢复失败：${r.message}`);
	await waitUntil(
		() => win.evaluate(async () => {
			const snapshot = await globalThis.kami.snapshot();
			return snapshot?.state?.expertDisabled === undefined ? true : null;
		}),
		{ timeout: 10_000, desc: "状态里的 expertDisabled 撤下" },
	);
	const request = await sendAndExpectRequest(
		`/skill:${SKILL_NAME} 已恢复手动调用`,
		"mock 收到恢复后的第 3 轮",
	);
	const system = systemTextOf(request);
	assert.ok(system.includes(PERSONA_MARKER), "恢复后系统提示词里没有人格正文");
	assert.ok(system.includes(SKILL_MARKER), "恢复后系统提示词里没有私有技能描述");
	// 手动 /skill: 的展开也恢复：正文进了用户消息。
	assert.ok(skillPromptTextOf(request).includes(SKILL_BODY_MARKER), "恢复后手动 /skill: 没有展开私有技能正文");
	const chip = await waitUntil(
		() => win.evaluate(() => {
			const node = document.querySelector(".expert-chip");
			if (node === null) return null;
			return { className: node.className, badge: node.querySelector(".expert-chip-badge")?.textContent ?? "" };
		}),
		{ timeout: 10_000, desc: "专家 chip 回到常态" },
	);
	assert.equal(chip.className.includes("expert-chip-disabled"), false, "恢复后 chip 仍带停用样式");
	assert.equal(chip.badge, "", "恢复后 chip 仍带「已停用」标记");
});

/* ── ⑩ 暗色截图 ───────────────────────────────────────────── */
await h.check("⑩ 停用态暗色截图", async () => {
	/*
	 * 再停用一次，截到的才是「停用卡片」本身（⑨ 已经把它恢复了）。
	 * 走**界面**而不是 IPC：能力库的列表来自 App 的 experts state，
	 * 只有详情里的 onReload 会刷新它 —— 直接调 IPC 的话界面上的标记不会更新。
	 */
	await openGallery();
	await openDetail(EXPERT_DISPLAY_NAME);
	await clickInDetail("停用专家");
	await waitUntil(
		() => win.evaluate(() => {
			const modal = document.querySelector(".ex-modal:not(.pack-preview)");
			return modal?.querySelector(".ex-modal-disabled-note") !== null ? true : null;
		}),
		{ timeout: 15_000, desc: "再次停用生效" },
	);
	await closeDetail();
	await waitUntil(
		() => win.evaluate(() => {
			const button = [...document.querySelectorAll(".ex-tools-row .mini-btn")].find((node) =>
				(node.textContent || "").includes("显示已停用"),
			);
			return button !== undefined ? true : null;
		}),
		{ timeout: 10_000, desc: "「显示已停用」开关出现" },
	);
	await win.evaluate(() => {
		const button = [...document.querySelectorAll(".ex-tools-row .mini-btn")].find((node) =>
			(node.textContent || "").includes("显示已停用"),
		);
		button?.click();
	});
	await waitUntil(
		() => win.evaluate((name) => {
			const card = [...document.querySelectorAll(".ex-card")].find((node) =>
				(node.textContent || "").includes(name),
			);
			return card !== undefined && card.className.includes("ex-card-disabled") ? true : null;
		}, EXPERT_DISPLAY_NAME),
		{ timeout: 10_000, desc: "停用卡片出现在暗色截图里" },
	);
	await scrollCardIntoView(EXPERT_DISPLAY_NAME);
	await win.evaluate(() => {
		document.documentElement.setAttribute("data-theme", "dark");
	});
	await waitFiniteAnimations();
	await waitUntil(
		() => win.evaluate(() => document.documentElement.getAttribute("data-theme") === "dark" ? true : null),
		{ timeout: 10_000, desc: "切到暗色" },
	);
	await h.shoot("gallery-disabled-dark");
	await win.evaluate(() => {
		document.documentElement.setAttribute("data-theme", "light");
	});
	await waitFiniteAnimations();
});

await h.check("无渲染层未捕获异常", () => assert.equal(h.pageErrors.length, 0, h.pageErrors.join("; ")));

// 先关应用再关 mock（同 model-roundtrip：应用先关，长连接才会断开）。
await h.app().close();
await mock.close();
await h.finish();
