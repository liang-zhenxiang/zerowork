/**
 * 能力库画廊（#421）的真实 Electron 端到端用例。
 *
 * 覆盖六件「只有真跑起来才暴露」的事：
 *   ① 来源四档筛选与计数（与 `listExperts` 同源）；
 *   ② 「名称」排序（中文拼音序，与 core 的契约一致）；
 *   ③ 详情里的「包含技能」与团队规模、能力包版本与安装时间；
 *   ④ 拖放 `.zwpack`（合成 `DragEvent` + `text/uri-list`）→ 覆盖层 → 预览弹窗；
 *   ⑤ 非能力包拖入给可读 toast，不静默失败；
 *   ⑥ 亮色 / 暗色截图。
 *
 * 安装走与 `gui-pack` 相同的 UI 链路（stub 文件框 → 预览 → 安装），
 * 这样列表刷新由应用自己触发，不需要重载渲染层。
 *
 * 等待纪律见 `.trellis/spec/testing/index.md`：所有 `waitUntil` 谓词都能返回假值，
 * 不用固定 sleep；截图前等入场动画结束。
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const h = createHarness({ name: "expert-gallery" });
await h.launch();
const win = h.window();
const app = h.app();

const PACK_ID = "pack-gallery-demo";
const DISPLAY_NAME = "画廊演示专家";
const VERSION = "1.2.0";
const SKILL_OUTLINE = "gallery-skill-outline";
const SKILL_OUTLINE_DESC = "把零散材料整理成可评审的提纲";
const SKILL_REVIEW = "gallery-skill-review";
const SKILL_REVIEW_DESC = "按清单逐条复核交付物";
const MEMBER_NAME = "gallery-minute-taker";
/** 内置专家里技能最多的一位（resources/experts/equity-research，15 个技能）：
 *  用它验证「打开详情时弹窗不会被底部的使用按钮滚到底」。 */
const BUILTIN_MANY_SKILLS = "严估深";

/** 在隔离的工作区里造一个合法的能力包目录（目录来源，不需要打包 zip）。 */
function writeFixturePack() {
	const root = join(h.WORKSPACE_DIR, "gallery-fixture");
	mkdirSync(join(root, "skills", "outline"), { recursive: true });
	mkdirSync(join(root, "skills", "review"), { recursive: true });
	mkdirSync(join(root, "agents"), { recursive: true });
	writeFileSync(
		join(root, "expert.md"),
		`---
name: ${PACK_ID}
description: 把零散素材整理成可交付的成果
displayName: ${DISPLAY_NAME}
profession: 素材整理
displayDescription: 先列提纲，再按清单复核
quickPrompts:
  - 把这些材料整理成提纲
  - 按清单复核这份交付物
  - 写一段交付说明
tags:
  - 整理
  - 提纲
  - 复核
expertType: team
---
你是素材整理专家。先搭结构，再逐条复核。
`,
	);
	writeFileSync(
		join(root, "skills", "outline", "SKILL.md"),
		`---
name: ${SKILL_OUTLINE}
description: ${SKILL_OUTLINE_DESC}
---
先分三段：背景、结论、下一步。
`,
	);
	writeFileSync(
		join(root, "skills", "review", "SKILL.md"),
		`---
name: ${SKILL_REVIEW}
description: ${SKILL_REVIEW_DESC}
---
逐条核对事实与数字，缺证据的标出来。
`,
	);
	writeFileSync(
		join(root, "agents", `${MEMBER_NAME}.md`),
		`---
name: ${MEMBER_NAME}
description: 只做会议速记与待办提取
tools: [read, grep, ls]
---
你是速记成员：只记录事实与待办，不做判断。
`,
	);
	writeFileSync(join(root, "README.md"), "# 画廊演示专家\n");
	writeFileSync(
		join(root, "manifest.json"),
		`${JSON.stringify(
			{
				format: "zerowork-pack",
				formatVersion: 1,
				id: PACK_ID,
				version: VERSION,
				name: DISPLAY_NAME,
				description: "能力库画廊的端到端夹具",
				author: "e2e",
				domain: "日常办公",
				connectors: [],
			},
			null,
			2,
		)}\n`,
	);
	return root;
}

const fixture = writeFixturePack();

/** 主进程里把打开文件框换成固定返回值。 */
async function stubOpenDialog(filePaths) {
	await app.evaluate(({ dialog }, rv) => {
		dialog.showOpenDialog = async () => rv;
	}, { canceled: filePaths.length === 0, filePaths });
}

const listExperts = () => win.evaluate(() => globalThis.kami.listExperts());

/**
 * 等有限时长动画（CSS transition / 一次性 animation）结束再截图。
 * 无限循环的呼吸点不算 —— 否则会一直等到超时。
 *
 * 用于：主题切换、筛选 chip 的选中态过渡（截图曾拍到「旧选中还在褪色、
 * 新选中还没变深」的中途帧）。
 */
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
		{ timeout: 10_000, desc: "主题切换过渡结束" },
	);
}

/** 等节点上的入场动画真正结束再截图。 */
async function waitAnimations(selector) {
	await win.evaluate(
		() => new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve(null)))),
	);
	await waitUntil(
		async () => {
			const done = await win.evaluate((sel) => {
				const node = document.querySelector(sel);
				if (node === null) return false;
				return node.getAnimations({ subtree: true }).every((a) => a.playState !== "running");
			}, selector);
			return done ? true : null;
		},
		{ timeout: 10_000, desc: `${selector} 入场动画结束` },
	);
}

/**
 * 请求窗口尺寸并等它稳定，返回**实际** inner 尺寸。
 *
 * `resizeTo` 会被系统屏幕钳制：CI 的屏幕只有 1024×679，请求 700 高时窗口
 * 根本不会变高 —— 旧写法只等「高度与之前不同」，在 CI 上会等到超时
 * （真实红过一次）。这里接受两种成功：高度真的变了，或目标高度本来就不高于
 * 当前高度（已经被屏幕钳制）。调用方一律按返回的实测值断言。
 */
async function resizeWindow(width, height) {
	const before = await win.evaluate(() => window.innerHeight);
	await win.evaluate(({ w, h }) => window.resizeTo(w, h), { w: width, h: height });
	const size = await waitUntil(
		async () => {
			const actual = await win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
			const settled = actual.height !== before || actual.height <= height;
			return settled && actual.width > 0 ? actual : null;
		},
		{ timeout: 10_000, desc: `窗口尺寸请求 ${width}×${height}` },
	);
	await win.evaluate(
		() => new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve(null)))),
	);
	return size;
}

/** 当前网格里的卡片名（按 DOM 顺序）。 */
const cardNames = () =>
	win.evaluate(() => [...document.querySelectorAll(".ex-card .ex-card-name")].map((node) => node.textContent ?? ""));

// ── ① 打开专家页 ───────────────────────────────────────────────

await h.check("打开专家页并渲染画廊", async () => {
	const clicked = await win.evaluate(() => {
		const nodes = [...document.querySelectorAll("button, a, [role='button'], li, div")];
		const hits = nodes.filter((n) => (n.textContent || "").trim() === "专家·技能·连接器");
		if (hits.length === 0) return false;
		hits[hits.length - 1].click();
		return true;
	});
	assert.ok(clicked, "侧边栏找不到「专家·技能·连接器」");
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".ex-card .ex-card-name") !== null),
		{ timeout: 20_000, desc: "专家卡片渲染（listExperts 回包后）" },
	);
	// 画廊的四件新东西都在：来源行、排序行、封面色条、卡片 meta 行。
	// 底部 rail 的容器（.ex-card-meta）始终存在（空元素时不可见，但承担
	// margin-top:auto 的钉底）；有内容与否看文本，0 个技能不写「0 个技能」。
	// 所以这里按「至少一张卡有容器」判定，而不是钉死第一张卡。
	const chrome = await win.evaluate(() => {
		const card = document.querySelector(".ex-card");
		const open = card?.querySelector(".ex-card-open");
		return {
			sources: document.querySelectorAll(".ex-source-chip").length,
			sort: document.querySelector(".ex-tools-row .provider-select-trigger") !== null,
			cover: document.querySelector(".ex-card .ex-cover") !== null,
			meta: document.querySelectorAll(".ex-card .ex-card-meta").length > 0,
			labels: [...document.querySelectorAll(".ex-sort-label")].map((node) => (node.textContent ?? "").trim()),
			coverColor: document.querySelector(".ex-card .ex-cover")?.style.background ?? "",
			avatarColor: document.querySelector(".ex-card .ex-card-avatar")?.style.background ?? "",
			// 可访问性：外层不再是 role=button，键盘入口是卡内独立的「查看详情」。
			cardRole: card?.getAttribute("role") ?? null,
			cardTabIndex: card?.getAttribute("tabindex") ?? null,
			openTag: open?.tagName ?? "",
			openLabel: open?.getAttribute("aria-label") ?? "",
			sortLabel: document.querySelector(".ex-tools-row .provider-select-trigger")?.getAttribute("aria-label") ?? "",
			live: document.querySelector(".skills-body [role='status'][aria-live='polite']")?.textContent ?? "",
		};
	});
	assert.equal(chrome.sources, 4, "来源筛选应有四档");
	assert.ok(chrome.sort, "排序控件不在 .ex-tools-row");
	assert.ok(chrome.cover, "卡片缺少封面色条");
	assert.ok(chrome.meta, "卡片缺少 meta 行");
	// 两行 chip 各有一个「全部」，必须有可见小标签区分筛的是什么。
	assert.deepEqual([...chrome.labels].sort(), ["标签", "来源", "排序"].sort());
	// 封面色条与头像同一套身份色（同一张卡内直接比较内联色值）。
	assert.equal(chrome.coverColor, chrome.avatarColor, "封面色条与头像不是同一个颜色");
	assert.equal(chrome.cardRole, null, "外层 .ex-card 不应再是 role=button");
	assert.equal(chrome.cardTabIndex, null, "外层 .ex-card 不应再进 Tab 序列");
	assert.equal(chrome.openTag, "BUTTON", "卡片缺少独立的「查看详情」按钮");
	assert.ok(chrome.openLabel.startsWith("查看详情："), `查看详情按钮缺 aria-label：${chrome.openLabel}`);
	assert.ok(chrome.sortLabel.startsWith("排序方式："), `排序 aria-label 应带当前值：${chrome.sortLabel}`);
	assert.match(chrome.live, /找到 \d+ 位专家/, `结果数 aria-live 文案不对：${chrome.live}`);
	await h.waitForSettled();
	await waitFiniteAnimations();
	await h.shoot("gallery-light");
});

// ── ①·补 卡片键盘可达：Tab 到「查看详情」按 Enter 打开 ────────

await h.check("卡片的键盘入口「查看详情」可聚焦并回车打开", async () => {
	const focused = await win.evaluate(() => {
		const button = document.querySelector(".ex-card .ex-card-open");
		if (button === null) return false;
		button.focus();
		return document.activeElement === button;
	});
	assert.ok(focused, "「查看详情」按钮拿不到焦点");
	await win.keyboard.press("Enter");
	const opened = await waitUntil(
		() => win.evaluate(() => {
			const modal = document.querySelector(".ex-modal:not(.pack-preview)");
			return modal === null ? null : modal.getAttribute("aria-label");
		}),
		{ timeout: 10_000, desc: "回车后打开专家详情" },
	);
	assert.ok(opened?.startsWith("专家详情："), `回车打开的不是详情：${opened}`);
	await waitAnimations(".ex-modal-mask");
	await win.evaluate(() => {
		document.querySelector(".ex-modal:not(.pack-preview) .ex-modal-close")?.click();
	});
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".ex-modal") === null),
		{ timeout: 10_000, desc: "键盘打开的详情关闭" },
	);
});

// ── ①·补 标签行溢出：状态类渐隐，不是常驻遮罩 ──────────────────

await h.check("标签行溢出用状态类渐隐，滚到末尾切换", async () => {
	const initial = await waitUntil(
		() => win.evaluate(() => {
			const node = document.querySelector(".skills-body .ex-cats");
			if (node === null) return null;
			return {
				className: node.className,
				overflow: node.scrollWidth > node.clientWidth,
			};
		}),
		{ timeout: 10_000, desc: "标签行渲染" },
	);
	assert.ok(initial.overflow, "标签行没有溢出，无法验证渐隐");
	assert.ok(initial.className.includes("fade-right"), `溢出时应挂 fade-right：${initial.className}`);
	assert.equal(initial.className.includes("fade-left"), false, "未向左滚动时不该有 fade-left");

	await win.evaluate(() => {
		const node = document.querySelector(".skills-body .ex-cats");
		if (node !== null) node.scrollLeft = node.scrollWidth;
	});
	const atEnd = await waitUntil(
		() => win.evaluate(() => {
			const node = document.querySelector(".skills-body .ex-cats");
			if (node === null) return null;
			const className = node.className;
			return className.includes("fade-left") && !className.includes("fade-right") ? className : null;
		}),
		{ timeout: 10_000, desc: "滚到末尾后渐隐换边" },
	);
	assert.ok(atEnd.includes("fade-left"));

	// 回到开头，后续截图与筛选不受影响。
	await win.evaluate(() => {
		const node = document.querySelector(".skills-body .ex-cats");
		if (node !== null) node.scrollLeft = 0;
	});
	await waitUntil(
		() => win.evaluate(() => {
			const node = document.querySelector(".skills-body .ex-cats");
			if (node === null) return null;
			return node.className.includes("fade-right") && !node.className.includes("fade-left")
				? true
				: null;
		}),
		{ timeout: 10_000, desc: "滚回开头恢复 fade-right" },
	);
});

// ── ② 导入夹具能力包（复用 #420 的 UI 链路） ──────────────────

await h.check("通过界面导入带 2 个技能的能力包", async () => {
	await stubOpenDialog([fixture]);
	const picked = await win.evaluate(() => {
		const button = [...document.querySelectorAll(".ex-topbar button")].find((b) =>
			(b.textContent ?? "").includes("导入能力包"),
		);
		if (button === undefined) return false;
		button.click();
		return true;
	});
	assert.ok(picked, "找不到「导入能力包…」按钮");
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".pack-preview") !== null),
		{ timeout: 20_000, desc: "能力包预览弹窗挂载" },
	);
	const installed = await win.evaluate(() => {
		const button = document.querySelector(".pack-preview-actions .primary-btn");
		if (button === null) return false;
		button.click();
		return true;
	});
	assert.ok(installed, "找不到「安装」按钮");
	await waitUntil(
		() => win.evaluate((id) => {
			return [...document.querySelectorAll(".ex-card .ex-card-name")].some((node) =>
				(node.textContent ?? "") === id,
			) ? true : null;
		}, DISPLAY_NAME),
		{ timeout: 20_000, desc: "安装后专家卡片出现" },
	);
	// 安装成功会自动打开详情：关掉它，后续按界面状态做筛选与排序。
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".ex-modal:not(.pack-preview) .ex-modal-close") !== null),
		{ timeout: 10_000, desc: "安装后自动打开详情" },
	);
	await win.evaluate(() => {
		document.querySelector(".ex-modal:not(.pack-preview) .ex-modal-close")?.click();
	});
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".ex-modal") === null),
		{ timeout: 10_000, desc: "详情弹窗关闭" },
	);
	// 卡片 meta 行是「技能数 / 版本 / 安装日期」的唯一落点，三条都要真的出现。
	const meta = await waitUntil(
		() => win.evaluate(({ name, version }) => {
			const card = [...document.querySelectorAll(".ex-card")].find((node) =>
				(node.textContent ?? "").includes(name),
			);
			const text = card?.querySelector(".ex-card-meta")?.innerText ?? "";
			return text.includes("2 个技能") && text.includes(`v${version}`) ? text : null;
		}, { name: DISPLAY_NAME, version: VERSION }),
		{ timeout: 10_000, desc: "卡片 meta 行显示技能数与版本" },
	);
	assert.match(meta, /\d+\s*月\s*\d+\s*日安装/, `卡片 meta 行没有安装日期：${meta}`);
});

// ── ③ 来源四档筛选与计数 ──────────────────────────────────────

await h.check("来源四档的计数与 listExperts 一致，筛选后只剩该来源", async () => {
	const experts = await listExperts();
	const expected = {
		all: experts.length,
		builtin: experts.filter((entry) => entry.source === "builtin").length,
		user: experts.filter((entry) => entry.source === "user").length,
		pack: experts.filter((entry) => entry.source === "pack").length,
	};
	assert.equal(expected.pack, 1, "夹具包应当只有 1 个");
	const chips = await waitUntil(async () => {
		const list = await win.evaluate(() =>
			[...document.querySelectorAll(".ex-source-chip")].map((node) => ({
				text: (node.textContent ?? "").trim(),
				pressed: node.getAttribute("aria-pressed") === "true",
			})),
		);
		const ready = list.length === 4 && list.every((chip) => /\d+$/.test(chip.text));
		return ready ? list : null;
	}, { timeout: 20_000, desc: "四个来源 chip 渲染出计数" });
	assert.match(chips[0].text, new RegExp(`全部\\s+${expected.all}$`));
	assert.match(chips[1].text, new RegExp(`内置\\s+${expected.builtin}$`));
	assert.match(chips[2].text, new RegExp(`自建\\s+${expected.user}$`));
	assert.match(chips[3].text, new RegExp(`能力包\\s+${expected.pack}$`));
	assert.equal(chips.filter((chip) => chip.pressed).length, 1, "同一时刻只该有一档被按下");

	const clicked = await win.evaluate(() => {
		const button = [...document.querySelectorAll(".ex-source-chip")].find((node) =>
			(node.textContent ?? "").trim().startsWith("能力包"),
		);
		if (button === undefined) return false;
		button.click();
		return true;
	});
	assert.ok(clicked, "找不到「能力包」来源 chip");
	const onlyPack = await waitUntil(async () => {
		const names = await cardNames();
		return names.length === expected.pack ? names : null;
	}, { timeout: 10_000, desc: "筛选后只剩能力包卡片" });
	assert.deepEqual(onlyPack, [DISPLAY_NAME]);
	const pressed = await win.evaluate(() =>
		[...document.querySelectorAll(".ex-source-chip")].find(
			(node) => node.getAttribute("aria-pressed") === "true",
		)?.textContent ?? "",
	);
	assert.ok(pressed.trim().startsWith("能力包"), `选中态应在「能力包」，实际「${pressed}」`);
	await waitFiniteAnimations();
	await h.shoot("gallery-filter-pack");

	// 回到「全部」，后续排序与详情用完整列表。
	await win.evaluate(() => {
		const button = [...document.querySelectorAll(".ex-source-chip")].find((node) =>
			(node.textContent ?? "").trim().startsWith("全部"),
		);
		button?.click();
	});
	await waitUntil(
		() => win.evaluate(() => document.querySelectorAll(".ex-card").length > 1 ? true : null),
		{ timeout: 10_000, desc: "回到全部来源" },
	);
});

await h.check("「自建 0」的空态给出「创建专家」这一步", async () => {
	const clicked = await win.evaluate(() => {
		const button = [...document.querySelectorAll(".ex-source-chip")].find((node) =>
			(node.textContent ?? "").trim().startsWith("自建"),
		);
		if (button === undefined) return false;
		button.click();
		return true;
	});
	assert.ok(clicked, "找不到「自建」来源 chip");
	// 空态不是终点：来源筛选为空时，下一步就是「造一个」。
	// 选择器必须限定在 .skills-body：侧栏也有一个 .state-empty（暂无历史任务），
	// 全局取第一个会拿到它，谓词永远不成立。
	const empty = await waitUntil(
		() => win.evaluate(() => {
			const title = document.querySelector(".skills-body .state-empty-title")?.textContent ?? "";
			const action = document.querySelector(".skills-body .state-empty-action button")?.textContent ?? "";
			return title.includes("还没有自己的专家") && action.includes("创建专家")
				? { title, action }
				: null;
		}),
		{ timeout: 10_000, desc: "自建为空时的空态与「创建专家」动作" },
	);
	assert.ok(empty.action.includes("创建专家"), `空态动作不对：${empty.action}`);
	// 结果数与列表同步：筛选到 0 时 aria-live 也要说 0。
	const live = await waitUntil(
		() => win.evaluate(() => {
			const text = document.querySelector(".skills-body [role='status'][aria-live='polite']")?.textContent ?? "";
			return text.includes("找到 0 位专家") ? text : null;
		}),
		{ timeout: 10_000, desc: "结果数播报更新为 0" },
	);
	assert.match(live, /找到 0 位专家/);
	await waitFiniteAnimations();
	await h.shoot("gallery-empty-user");

	// 回到「全部」，后续排序与详情用完整列表。
	await win.evaluate(() => {
		const button = [...document.querySelectorAll(".ex-source-chip")].find((node) =>
			(node.textContent ?? "").trim().startsWith("全部"),
		);
		button?.click();
	});
	await waitUntil(
		() => win.evaluate(() => document.querySelectorAll(".ex-card").length > 1 ? true : null),
		{ timeout: 10_000, desc: "回到全部来源" },
	);
});

// ── ④ 排序：名称（中文拼音序） ────────────────────────────────

await h.check("切到「名称」后卡片顺序与中文排序一致", async () => {
	const opener = await win.evaluate(() => {
		const trigger = document.querySelector(".ex-tools-row .provider-select-trigger");
		if (trigger === null) return false;
		trigger.click();
		return true;
	});
	assert.ok(opener, "点不开排序控件");
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".provider-select-panel") !== null),
		{ timeout: 10_000, desc: "排序下拉展开" },
	);
	const picked = await win.evaluate(() => {
		const option = [...document.querySelectorAll(".provider-select-panel .provider-option")].find((node) =>
			(node.textContent ?? "").includes("名称"),
		);
		if (option === undefined) return false;
		option.click();
		return true;
	});
	assert.ok(picked, "找不到「名称」排序项");
	const experts = await listExperts();
	// 与 core 的契约一致：展示名按 zh-Hans-CN 排序，同分按 name。
	const expected = experts
		.map((entry) => entry.displayName)
		.sort((left, right) => left.localeCompare(right, "zh-Hans-CN"));
	const actual = await waitUntil(async () => {
		const names = await cardNames();
		return names.length === expected.length && names.every((name, index) => name === expected[index])
			? names
			: null;
	}, { timeout: 10_000, desc: "卡片按名称排序" });
	assert.deepEqual(actual, expected);
	const label = await win.evaluate(
		() => document.querySelector(".ex-tools-row .provider-select-label")?.textContent ?? "",
	);
	assert.equal(label.trim(), "名称");
	// 读屏拿不到「排序」小标签与当前值的关系，aria-label 必须自带当前档位。
	const sortAria = await win.evaluate(
		() => document.querySelector(".ex-tools-row .provider-select-trigger")?.getAttribute("aria-label") ?? "",
	);
	assert.equal(sortAria, "排序方式：名称");
});

// ── ⑤ 详情：技能清单 / 团队规模 / 来源版本与安装时间 ──────────

await h.check("详情显示技能清单、成员数与能力包来源", async () => {
	const opened = await win.evaluate((name) => {
		const card = [...document.querySelectorAll(".ex-card")].find((node) =>
			(node.textContent ?? "").includes(name),
		);
		if (card === undefined) return false;
		card.click();
		return true;
	}, DISPLAY_NAME);
	assert.ok(opened, "点不开能力包卡片");
	const detail = await waitUntil(async () => {
		const text = await win.evaluate(
			() => document.querySelector(".ex-modal:not(.pack-preview)")?.innerText ?? "",
		);
		return text.includes(DISPLAY_NAME) ? text : null;
	}, { timeout: 10_000, desc: "详情弹窗挂载" });
	assert.ok(detail.includes("包含技能（2）"), `详情里没有技能分区：${detail.slice(0, 300)}`);
	assert.ok(detail.includes(SKILL_OUTLINE), `详情里没有技能名 ${SKILL_OUTLINE}`);
	assert.ok(detail.includes(SKILL_OUTLINE_DESC), "详情里没有技能描述（提纲）");
	assert.ok(detail.includes(SKILL_REVIEW), `详情里没有技能名 ${SKILL_REVIEW}`);
	assert.ok(detail.includes(SKILL_REVIEW_DESC), "详情里没有技能描述（复核）");
	assert.ok(detail.includes("成员 1"), `团队型专家应显示「成员 1」：${detail.slice(0, 300)}`);
	assert.ok(
		detail.includes(`能力包 ${PACK_ID}@${VERSION}`),
		`详情里没有能力包来源：${detail.slice(0, 300)}`,
	);
	assert.match(detail, /\d+\s*月\s*\d+\s*日安装/, "详情里没有安装时间");
	// 技能分区在弹窗底部：滚到底再截图，证据里才看得到。
	await win.evaluate(() => {
		const modal = document.querySelector(".ex-modal");
		if (modal !== null) modal.scrollTop = modal.scrollHeight;
	});
	await waitAnimations(".ex-modal-mask");
	await waitFiniteAnimations();
	await h.shoot("gallery-detail-skills");
	await win.evaluate(() => {
		document.querySelector(".ex-modal:not(.pack-preview) .ex-modal-close")?.click();
	});
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".ex-modal") === null),
		{ timeout: 10_000, desc: "详情弹窗关闭" },
	);
});

// ── ⑤·补 详情打开位置：焦点在对话框、停在顶部 ─────────────────

await h.check("技能多的内置专家详情：焦点在对话框且弹窗停在顶部", async () => {
	/*
	 * 默认只渲染 5 条技能，这个弹窗在 860 高的窗口里可能刚好塞满 85vh
	 * （本机实测 709 / 709），scrollTop 恒为 0 会让断言失去意义。把窗口压到
	 * 13 寸笔记本的可用高度，让内容确定超过可视区；最后还原尺寸。
	 * resizeTo 会被系统钳制，下面按**实际** clientHeight 判定。
	 */
	const original = await win.evaluate(() => ({ width: window.outerWidth, height: window.outerHeight }));
	await resizeWindow(1000, 700);
	// 矮视口档（max-height: 760）收垂直节奏：.ex 的 gap 与 .skills-body 顶部 padding。
	const compact = await win.evaluate(() => ({
		gap: getComputedStyle(document.querySelector(".ex")).rowGap,
		paddingTop: getComputedStyle(document.querySelector(".skills-body")).paddingTop,
		innerHeight: window.innerHeight,
	}));
	assert.ok(compact.innerHeight <= 760, `窗口没有进入矮视口档：innerHeight=${compact.innerHeight}`);
	assert.equal(compact.gap, "8px", `矮视口下 .ex 的 gap 应收到 --space-3：${compact.gap}`);
	assert.equal(
		compact.paddingTop,
		"8px",
		`矮视口下 .skills-body 的顶部 padding 应收到 --space-3：${compact.paddingTop}`,
	);
	const opened = await win.evaluate((name) => {
		const card = [...document.querySelectorAll(".ex-card")].find((node) =>
			(node.textContent ?? "").includes(name),
		);
		if (card === undefined) return false;
		card.click();
		return true;
	}, BUILTIN_MANY_SKILLS);
	assert.ok(opened, `找不到内置专家「${BUILTIN_MANY_SKILLS}」的卡片`);
	const state = await waitUntil(async () => {
		const probe = await win.evaluate(() => {
			const modal = document.querySelector(".ex-modal:not(.pack-preview)");
			if (modal === null) return null;
			return {
				activeIsDialog: document.activeElement === modal,
				scrollTop: modal.scrollTop,
				skillRows: modal.querySelectorAll(".ex-skill-row").length,
				scrollHeight: modal.scrollHeight,
				clientHeight: modal.clientHeight,
				toggle: modal.querySelector(".ex-skill-toggle")?.textContent ?? "",
			};
		});
		// 等默认 5 条技能渲染出来（展开按钮同时出现）。
		return probe !== null && probe.skillRows === 5 && probe.toggle !== "" ? probe : null;
	}, { timeout: 20_000, desc: "技能多的内置专家详情挂载（默认 5 条）" });
	assert.equal(state.activeIsDialog, true, "初始焦点应在对话框容器（tabIndex=-1）上，而不是底部按钮");
	// 先确认内容真的超过 85vh —— 否则 scrollTop 恒为 0，下面那条断言没有意义。
	assert.ok(
		state.scrollHeight > state.clientHeight,
		`详情没有超出可视高度，滚底断言无从验证：${state.scrollHeight} / ${state.clientHeight}`,
	);
	assert.equal(state.scrollTop, 0, `详情被初始焦点滚到底了：scrollTop=${state.scrollTop}`);
	assert.ok(state.toggle.includes("展开全部（15）"), `展开按钮文案不对：${state.toggle}`);
	await waitAnimations(".ex-modal-mask");
	await waitFiniteAnimations();
	await h.shoot("gallery-detail-top");

	// 展开：默认只显示 5 条，展开后是全部 15 条，且按钮变成「收起」。
	await win.evaluate(() => {
		document.querySelector(".ex-skill-toggle")?.click();
	});
	const expanded = await waitUntil(
		() => win.evaluate(() => {
			const modal = document.querySelector(".ex-modal:not(.pack-preview)");
			if (modal === null) return null;
			const rows = modal.querySelectorAll(".ex-skill-row").length;
			const toggle = modal.querySelector(".ex-skill-toggle")?.textContent ?? "";
			return rows === 15 && toggle === "收起" ? { rows, toggle } : null;
		}),
		{ timeout: 10_000, desc: "技能展开为全部 15 条" },
	);
	assert.equal(expanded.rows, 15);
	await waitFiniteAnimations();
	await h.shoot("gallery-detail-skills-expanded");
	// 收起后回到 5 条（展开是就地切换，不是一次性放大）。
	await win.evaluate(() => {
		document.querySelector(".ex-skill-toggle")?.click();
	});
	await waitUntil(
		() => win.evaluate(() =>
			document.querySelectorAll(".ex-modal:not(.pack-preview) .ex-skill-row").length === 5 ? true : null,
		),
		{ timeout: 10_000, desc: "收起后回到 5 条" },
	);
	await win.evaluate(() => {
		document.querySelector(".ex-modal:not(.pack-preview) .ex-modal-close")?.click();
	});
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".ex-modal") === null),
		{ timeout: 10_000, desc: "详情弹窗关闭" },
	);
	// 还原窗口，后续拖放截图按原始尺寸取。
	await resizeWindow(original.width, original.height);
});

// ── ⑥ 拖放：覆盖层 → 预览 ─────────────────────────────────────

await h.check("拖入 .zwpack 出现覆盖层，松开后打开预览", async () => {
	const uri = `file://${fixture}`;
	// 长列表滚到底再拖：覆盖层文案必须锚定视口（若按内容居中，这里会落到首屏外）。
	const scrolled = await win.evaluate(() => {
		const body = document.querySelector(".skills-body");
		if (body === null) return false;
		body.scrollTop = body.scrollHeight;
		return body.scrollTop > 0;
	});
	assert.ok(scrolled, "专家页内容没有可滚动高度，无法验证覆盖层的视口锚定");
	const entered = await win.evaluate((value) => {
		const container = document.querySelector(".ex");
		if (container === null) return false;
		const transfer = new DataTransfer();
		transfer.setData("text/uri-list", value);
		window.__zwGalleryDrag = transfer;
		container.dispatchEvent(
			new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer }),
		);
		container.dispatchEvent(
			new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer }),
		);
		return true;
	}, uri);
	assert.ok(entered, "找不到 .ex 容器");
	const overlay = await waitUntil(
		() => win.evaluate(() => {
			const node = document.querySelector(".ex-drop-overlay");
			if (node === null) return null;
			const inner = node.querySelector(".ex-drop-inner");
			const title = node.querySelector(".ex-drop-title");
			if (inner === null || title === null) return null;
			const rect = title.getBoundingClientRect();
			return {
				text: node.innerText,
				innerPosition: getComputedStyle(inner).position,
				titleTop: rect.top,
				titleBottom: rect.bottom,
				viewport: window.innerHeight,
			};
		}),
		{ timeout: 10_000, desc: "拖放覆盖层出现" },
	);
	assert.ok(overlay.text.includes("松开以导入能力包"), `覆盖层文案不对：${overlay.text}`);
	assert.ok(overlay.text.includes(".zwpack"), `覆盖层没有格式说明：${overlay.text}`);
	assert.equal(overlay.innerPosition, "sticky", "覆盖层内部应 sticky 锚定视口");
	assert.ok(
		overlay.titleTop >= 0 && overlay.titleBottom <= overlay.viewport,
		`覆盖层文案不在视口内：${overlay.titleTop}..${overlay.titleBottom} / ${overlay.viewport}`,
	);
	await waitFiniteAnimations();
	await h.shoot("gallery-drop-overlay");

	const dropped = await win.evaluate(() => {
		const container = document.querySelector(".ex");
		const transfer = window.__zwGalleryDrag;
		if (container === null || transfer === undefined) return false;
		container.dispatchEvent(
			new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
		);
		delete window.__zwGalleryDrag;
		return true;
	});
	assert.ok(dropped, "drop 事件没发出去");
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".ex-drop-overlay") === null ? true : null),
		{ timeout: 10_000, desc: "drop 后覆盖层收起" },
	);
	const preview = await waitUntil(
		() => win.evaluate(() => document.querySelector(".pack-preview")?.innerText ?? null),
		{ timeout: 20_000, desc: "拖放后能力包预览挂载" },
	);
	assert.ok(preview.includes(DISPLAY_NAME), `预览里没有专家名：${preview.slice(0, 200)}`);
	assert.ok(preview.includes(SKILL_OUTLINE), `预览里没有技能清单：${preview.slice(0, 200)}`);
	await waitAnimations(".ex-modal-mask");
	await waitFiniteAnimations();
	await h.shoot("gallery-drop-preview");
	const closed = await win.evaluate(() => {
		const button = [...document.querySelectorAll(".pack-preview-actions button")].find((node) =>
			(node.textContent ?? "").trim() === "取消",
		);
		if (button === undefined) return false;
		button.click();
		return true;
	});
	assert.ok(closed, "找不到预览的「取消」");
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".pack-preview") === null),
		{ timeout: 10_000, desc: "预览弹窗关闭" },
	);
});

// ── ⑦ 非能力包：可读提示，不静默失败 ─────────────────────────

await h.check("拖入非 .zwpack 文件给出可读提示", async () => {
	const dropped = await win.evaluate(() => {
		const container = document.querySelector(".ex");
		if (container === null) return false;
		const transfer = new DataTransfer();
		transfer.setData("text/uri-list", "file:///tmp/definitely-not-a-pack.txt");
		container.dispatchEvent(
			new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
		);
		return true;
	});
	assert.ok(dropped, "drop 事件没发出去");
	const toast = await waitUntil(
		() => win.evaluate(() => {
			const text = document.querySelector(".toast-stack")?.innerText ?? "";
			return text.includes("请拖入 .zwpack 能力包") ? text : null;
		}),
		{ timeout: 10_000, desc: "非能力包拖入的提示 toast" },
	);
	assert.ok(toast.includes("能力包目录"), `提示里没有说明目录也可用：${toast}`);
	assert.equal(
		await win.evaluate(() => document.querySelector(".pack-preview") === null),
		true,
		"非能力包不该打开预览",
	);
});

// ── ⑧ 暗色截图 ────────────────────────────────────────────────

await h.check("能力库暗色截图", async () => {
	// 拖放用例把长列表滚到了底：截图前回到顶部，取的才是画廊本身。
	await win.evaluate(() => {
		const body = document.querySelector(".skills-body");
		if (body !== null) body.scrollTop = 0;
	});
	await win.evaluate(() => {
		document.documentElement.setAttribute("data-theme", "dark");
	});
	await waitFiniteAnimations();
	await waitUntil(
		() => win.evaluate(() => document.documentElement.getAttribute("data-theme") === "dark"),
		{ timeout: 10_000, desc: "data-theme 切到 dark" },
	);
	await h.shoot("gallery-dark");
	await win.evaluate(() => {
		document.documentElement.setAttribute("data-theme", "light");
	});
	await waitFiniteAnimations();
});

await h.finish();
