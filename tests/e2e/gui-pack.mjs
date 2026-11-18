/**
 * 能力包（zerowork-pack）的真实 Electron 端到端用例。
 *
 * 覆盖的是「只有真跑起来才暴露」的那条链：
 * 点「导入能力包…」→ 主进程文件框（stub）→ daemon 预览 → 安装 → 专家列表出现 →
 * 详情里的来源与移除 → 专家消失。
 *
 * 对话框用 `app.evaluate` 在主进程里换掉 `dialog.showOpenDialog`（同
 * `dialog-native.mjs` 的做法）：原生窗口本身无法自动化，但应用对返回值的处理
 * 是**我们的代码**，可以测。
 *
 * 截图：预览弹窗亮色 / 暗色各一张。暗色用 `data-theme` 属性直接驱动 ——
 * 它是 app.css 暗色 token 块的唯一真源（与设置页选择档位走同一条路），
 * 这里只是不额外导航一次设置页。
 */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const h = createHarness({ name: "pack" });
await h.launch();
const win = h.window();
const app = h.app();

const PACK_ID = "pack-e2e-minutes";
const DISPLAY_NAME = "会议纪要专家";
const SKILL_NAME = "pack-e2e-minutes-format";

/** 在隔离的工作区里造一个合法的能力包目录（目录来源，不需要打包 zip）。 */
function writeFixturePack() {
	const root = join(h.WORKSPACE_DIR, "pack-fixture");
	mkdirSync(join(root, "skills", "minutes-format"), { recursive: true });
	writeFileSync(
		join(root, "expert.md"),
		`---
name: ${PACK_ID}
description: 把会议记录整理成可执行纪要
displayName: ${DISPLAY_NAME}
profession: 会议纪要整理
displayDescription: 把录音转写与零散笔记整理成可执行的纪要
quickPrompts:
  - 把这段会议记录整理成纪要
  - 提取待办事项与负责人
  - 生成一封会后邮件
tags:
  - 会议
  - 纪要
  - 待办
expertType: expert
---
你是会议纪要专家。只做纪要，不编造事实。
`,
	);
	writeFileSync(
		join(root, "skills", "minutes-format", "SKILL.md"),
		`---
name: ${SKILL_NAME}
description: 会议纪要的标准结构
---
按「结论 / 待办 / 风险」三段整理。
`,
	);
	writeFileSync(join(root, "README.md"), "# 会议纪要专家\n");
	writeFileSync(
		join(root, "manifest.json"),
		`${JSON.stringify(
			{
				format: "zerowork-pack",
				formatVersion: 1,
				id: PACK_ID,
				version: "1.0.0",
				name: DISPLAY_NAME,
				description: "把录音转写整理成可执行的纪要",
				author: "e2e",
				domain: "日常办公",
				connectors: [{ id: "github", type: "http", description: "读取仓库 issue" }],
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

async function restoreDialog() {
	await app.evaluate(({ dialog }) => {
		delete dialog.showOpenDialog;
	});
}

const textOf = (selector) =>
	win.evaluate((sel) => document.querySelector(sel)?.innerText ?? "", selector);

const listExperts = () => win.evaluate(() => globalThis.kami.listExperts());

/**
 * 等主题切换触发的**有限时长过渡**结束再截图。
 *
 * 不能直接等「document 里没有 running 动画」：页面本来就有无限循环的呼吸点
 * （`iterations: Infinity`），那会一直等到超时。这里只等有确定结束时间的动画
 * （CSS transition / 一次性 animation），无限动画不影响截图取色。
 */
async function waitThemePaint() {
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

/**
 * 等节点上的入场动画真正结束再截图。
 *
 * 弹窗是条件挂载 + `pop-layer-in`；挂载那一刻截图会拍到半透明的中途帧
 * （规范里的原话：「截图要等入场动画结束」）。这里等所有动画
 * `playState !== "running"`，不靠固定时长。
 */
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

// ── ① 打开专家页 ───────────────────────────────────────────────

await h.check("专家页渲染出内置专家", async () => {
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
	await h.shoot("experts-initial");
});

// ── ② 导入 → 预览 ──────────────────────────────────────────────

await h.check("点「导入能力包…」后弹出预览，内容来自 daemon 回包", async () => {
	await stubOpenDialog([fixture]);
	const clicked = await win.evaluate(() => {
		const button = [...document.querySelectorAll(".ex-topbar button")].find((b) =>
			(b.textContent ?? "").includes("导入能力包"),
		);
		if (button === undefined) return false;
		button.click();
		return true;
	});
	assert.ok(clicked, "找不到「导入能力包…」按钮");
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".pack-preview") !== null),
		{ timeout: 20_000, desc: "能力包预览弹窗挂载" },
	);
	const text = await textOf(".pack-preview");
	assert.ok(text.includes(DISPLAY_NAME), `预览里没有专家名：${text.slice(0, 200)}`);
	assert.ok(text.includes(SKILL_NAME), `预览里没有技能清单：${text.slice(0, 200)}`);
	assert.ok(text.includes("连接器只声明"), "预览里没有「连接器只声明」的安全说明");
	assert.ok(text.includes("包内代码不会被执行"), "预览里没有「不执行代码」的安全说明");
	assert.ok(text.includes("github"), "预览里没有连接器 id");
	await waitAnimations(".ex-modal-mask");
	await h.shoot("pack-preview-light");
});

await h.check("预览弹窗暗色截图", async () => {
	await win.evaluate(() => {
		document.documentElement.setAttribute("data-theme", "dark");
	});
	/*
	 * 主题切换会触发整页颜色过渡；只等一帧会拍到「左半已重绘、右半还是旧色」
	 * 的中途帧（首版实测：遮罩右边留着一块浅色矩形）。等有限时长的过渡全部
	 * 结束再截图（无限循环的呼吸点不参与判定），证据才是暗色下的真实样子。
	 */
	await waitThemePaint();
	await waitUntil(
		() => win.evaluate(() => document.documentElement.getAttribute("data-theme") === "dark"),
		{ timeout: 10_000, desc: "data-theme 切到 dark" },
	);
	await h.shoot("pack-preview-dark");
	await win.evaluate(() => {
		document.documentElement.setAttribute("data-theme", "light");
	});
	await waitThemePaint();
});

// ── ③ 安装：成功后应直接打开详情（不能只有一条会消失的 toast） ──

await h.check("点「安装」后自动打开详情并显示能力包来源", async () => {
	const clicked = await win.evaluate(() => {
		const button = document.querySelector(".pack-preview-actions .primary-btn");
		if (button === null) return false;
		button.click();
		return true;
	});
	assert.ok(clicked, "找不到「安装」按钮");
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".toast-stack")?.innerText.includes("已安装能力包") ?? false),
		{ timeout: 20_000, desc: "安装成功 toast" },
	);
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".pack-preview") === null),
		{ timeout: 10_000, desc: "预览弹窗关闭" },
	);
	// 安装成功的落点是详情：来源行就是「装到哪了、怎么移除」的答案。
	const detail = await waitUntil(async () => {
		const text = await win.evaluate(
			() => document.querySelector(".ex-modal:not(.pack-preview)")?.innerText ?? "",
		);
		return text.includes(`能力包 ${PACK_ID}@1.0.0`) ? text : null;
	}, { timeout: 20_000, desc: "安装后自动打开详情并显示来源" });
	assert.ok(detail.includes(DISPLAY_NAME), `详情里没有专家名：${detail.slice(0, 200)}`);
	const installed = await waitUntil(async () => {
		const list = await listExperts();
		return list.find((entry) => entry.name === PACK_ID) ?? null;
	}, { timeout: 20_000, desc: "listExperts 里出现刚装的能力包" });
	assert.equal(installed.source, "pack", "来源应为 pack");
	assert.equal(installed.packId, PACK_ID);
	assert.equal(installed.packVersion, "1.0.0");
	await waitAnimations(".ex-modal-mask");
	await h.shoot("pack-installed-detail");
});

await h.check("关闭详情后卡片带「能力包」徽标，且「我的专家」里能找到", async () => {
	const closed = await win.evaluate(() => {
		const button = document.querySelector(".ex-modal:not(.pack-preview) .ex-modal-close");
		if (button === null) return false;
		button.click();
		return true;
	});
	assert.ok(closed, "找不到详情弹窗的关闭键");
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".ex-modal") === null),
		{ timeout: 10_000, desc: "详情弹窗关闭" },
	);
	const badge = await waitUntil(
		() => win.evaluate((name) => {
			const card = [...document.querySelectorAll(".ex-card")].find((node) =>
				(node.textContent ?? "").includes(name),
			);
			if (card === undefined) return null;
			const node = card.querySelector(".ex-source-badge");
			return node?.textContent === "能力包" ? node.textContent : null;
		}, DISPLAY_NAME),
		{ timeout: 20_000, desc: "新卡片出现「能力包」徽标" },
	);
	assert.equal(badge, "能力包");
	// 新装专家排在列表末尾：截图前滚到它，否则徽标只在 DOM 里、不在画面里。
	await win.evaluate((name) => {
		const card = [...document.querySelectorAll(".ex-card")].find((node) =>
			(node.textContent ?? "").includes(name),
		);
		card?.scrollIntoView({ block: "center" });
	}, DISPLAY_NAME);
	await h.waitForSettled();
	await h.shoot("pack-installed");

	// 「我的专家」= 用户能管理的那两档，能力包必须在里面，否则装完就找不到了。
	const mine = await win.evaluate(() => {
		const button = [...document.querySelectorAll(".ex-topbar-actions button")].find((node) =>
			(node.textContent ?? "").includes("我的专家"),
		);
		if (button === undefined) return false;
		button.click();
		return true;
	});
	assert.ok(mine, "找不到「我的专家」按钮");
	await waitUntil(
		() => win.evaluate((name) => {
			const card = [...document.querySelectorAll(".ex-card")].find((node) =>
				(node.textContent ?? "").includes(name),
			);
			return card?.querySelector(".ex-source-badge")?.textContent === "能力包" ? true : null;
		}, DISPLAY_NAME),
		{ timeout: 20_000, desc: "「我的专家」里出现能力包专家" },
	);
	const back = await win.evaluate(() => {
		const button = document.querySelector(".ex-back");
		if (button === null) return false;
		button.click();
		return true;
	});
	assert.ok(back, "找不到「全部专家」返回按钮");
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".ex-topbar-actions") !== null),
		{ timeout: 10_000, desc: "回到全部专家" },
	);
});

// ── ④ 详情里的来源与移除 ──────────────────────────────────────

await h.check("移除能力包后专家从列表消失", async () => {
	const opened = await win.evaluate((name) => {
		const card = [...document.querySelectorAll(".ex-card")].find((node) =>
			(node.textContent ?? "").includes(name),
		);
		if (card === undefined) return false;
		card.click();
		return true;
	}, DISPLAY_NAME);
	assert.ok(opened, "点不开刚安装的专家卡");
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".ex-modal:not(.pack-preview)") !== null),
		{ timeout: 10_000, desc: "专家详情弹窗挂载" },
	);
	const text = await textOf(".ex-modal:not(.pack-preview)");
	assert.ok(text.includes(`能力包 ${PACK_ID}@1.0.0`), `详情里没有来源：${text.slice(0, 200)}`);
	const asked = await win.evaluate(() => {
		const button = [...document.querySelectorAll(".ex-modal button")].find((node) =>
			(node.textContent ?? "").includes("移除能力包"),
		);
		if (button === undefined) return false;
		button.click();
		return true;
	});
	assert.ok(asked, "找不到「移除能力包」按钮");
	await waitUntil(
		() => win.evaluate(() =>
			[...document.querySelectorAll(".ex-modal button")].some((node) =>
				(node.textContent ?? "").includes("确认移除"),
			)),
		{ timeout: 10_000, desc: "二次确认按钮出现" },
	);
	// 确认块是独立一块：问句带专家名，边界说明不能被省略成「及其技能与成员」。
	const confirmText = await textOf(".ex-modal-confirm");
	assert.ok(confirmText.includes(DISPLAY_NAME), `确认块里没有专家名：${confirmText}`);
	assert.ok(
		confirmText.includes("原始 .zwpack 文件不受影响") && confirmText.includes("不可恢复"),
		`确认块缺少边界说明：${confirmText}`,
	);
	await waitAnimations(".ex-modal-mask");
	await h.shoot("pack-remove-confirm");
	const confirmed = await win.evaluate(() => {
		const button = [...document.querySelectorAll(".ex-modal button")].find((node) =>
			(node.textContent ?? "").includes("确认移除"),
		);
		if (button === undefined) return false;
		button.click();
		return true;
	});
	assert.ok(confirmed, "点不到「确认移除」");
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".ex-modal") === null),
		{ timeout: 10_000, desc: "详情弹窗关闭" },
	);
	const remaining = await waitUntil(async () => {
		const list = await listExperts();
		return list.some((entry) => entry.name === PACK_ID) ? null : list;
	}, { timeout: 20_000, desc: "listExperts 里不再有被移除的包" });
	assert.equal(remaining.some((entry) => entry.name === PACK_ID), false);
	await waitUntil(
		() => win.evaluate((name) =>
			![...document.querySelectorAll(".ex-card .ex-card-name")].some((node) => node.textContent === name),
			DISPLAY_NAME),
		{ timeout: 20_000, desc: "专家页不再显示被移除的专家卡" },
	);
	await h.shoot("pack-removed");
});

// ── ⑤ 安装失败：保留预览内容，主按钮变「重试安装」─────────────

await h.check("安装失败保留预览并给出「重试安装」", async () => {
	/*
	 * 造一个同名、但不是能力包的目录：预览能过（冲突提示会标出来），
	 * 但安装会被 daemon 拒绝。这样触发的是「安装失败」而不是「预览失败」。
	 */
	const blocker = join(h.CONFIG_DIR, "packs", PACK_ID);
	mkdirSync(blocker, { recursive: true });
	writeFileSync(join(blocker, "keep.txt"), "keep");
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
	const clicked = await win.evaluate(() => {
		const button = document.querySelector(".pack-preview-actions .primary-btn");
		if (button === null) return false;
		button.click();
		return true;
	});
	assert.ok(clicked, "找不到「安装」按钮");
	const failed = await waitUntil(async () => {
		const text = await win.evaluate(() => document.querySelector(".pack-preview")?.innerText ?? "");
		return text.includes("PACK_CONFLICT_NOT_PACK") ? text : null;
	}, { timeout: 20_000, desc: "安装失败给出冲突原因" });
	assert.ok(failed.includes(SKILL_NAME), "安装失败后预览内容不应消失");
	assert.ok(failed.includes("安装失败"), "没有「安装失败」的错误条");
	const primary = await win.evaluate(
		() => document.querySelector(".pack-preview-actions .primary-btn")?.textContent ?? "",
	);
	assert.ok(primary.includes("重试安装"), `主按钮应变为「重试安装」，实际「${primary}」`);
	await waitAnimations(".ex-modal-mask");
	await h.shoot("pack-preview-install-error");

	// 清掉阻塞目录后「重试安装」应当成功，并自动打开详情。
	rmSync(blocker, { recursive: true, force: true });
	const retried = await win.evaluate(() => {
		const button = document.querySelector(".pack-preview-actions .primary-btn");
		if (button === null) return false;
		button.click();
		return true;
	});
	assert.ok(retried, "找不到「重试安装」按钮");
	await waitUntil(
		() => win.evaluate(async (id) => {
			const list = await globalThis.kami.listExperts();
			return list.some((entry) => entry.name === id) ? true : null;
		}, PACK_ID),
		{ timeout: 20_000, desc: "重试安装后专家出现在 listExperts" },
	);
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".ex-modal:not(.pack-preview)") !== null),
		{ timeout: 20_000, desc: "重试安装后自动打开详情" },
	);
	const closedDetail = await win.evaluate(() => {
		const button = document.querySelector(".ex-modal:not(.pack-preview) .ex-modal-close");
		if (button === null) return false;
		button.click();
		return true;
	});
	assert.ok(closedDetail, "关闭重试安装后的详情失败");
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".ex-modal") === null),
		{ timeout: 10_000, desc: "详情弹窗关闭" },
	);
});

// ── ⑥ 失效态：目录被外部删除后，详情不能停在一个不存在的专家上 ──

await h.check("能力包目录被手工删除后：移除提示已失效并关闭详情", async () => {
	const opened = await win.evaluate((name) => {
		const card = [...document.querySelectorAll(".ex-card")].find((node) =>
			(node.textContent ?? "").includes(name),
		);
		if (card === undefined) return false;
		card.click();
		return true;
	}, DISPLAY_NAME);
	assert.ok(opened, "点不开能力包专家卡");
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".ex-modal:not(.pack-preview)") !== null),
		{ timeout: 10_000, desc: "专家详情弹窗挂载" },
	);
	// 模拟用户/外部工具直接删掉了安装目录：UI 上还留着旧数据。
	rmSync(join(h.CONFIG_DIR, "packs", PACK_ID), { recursive: true, force: true });
	const asked = await win.evaluate(() => {
		const button = [...document.querySelectorAll(".ex-modal button")].find((node) =>
			(node.textContent ?? "").includes("移除能力包"),
		);
		if (button === undefined) return false;
		button.click();
		return true;
	});
	assert.ok(asked, "找不到「移除能力包」按钮");
	await waitUntil(
		() => win.evaluate(() =>
			[...document.querySelectorAll(".ex-modal button")].some((node) =>
				(node.textContent ?? "").includes("确认移除"),
			)),
		{ timeout: 10_000, desc: "二次确认按钮出现" },
	);
	const confirmed = await win.evaluate(() => {
		const button = [...document.querySelectorAll(".ex-modal button")].find((node) =>
			(node.textContent ?? "").includes("确认移除"),
		);
		if (button === undefined) return false;
		button.click();
		return true;
	});
	assert.ok(confirmed, "点不到「确认移除」");
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".toast-stack")?.innerText.includes("已经不在了") ?? false),
		{ timeout: 20_000, desc: "提示能力包已失效" },
	);
	// 关键：失效态不能继续展示已不存在的专家与「使用专家」。
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".ex-modal") === null),
		{ timeout: 10_000, desc: "失效后详情自动关闭" },
	);
	await waitUntil(
		() => win.evaluate(async (id) => {
			const list = await globalThis.kami.listExperts();
			return list.some((entry) => entry.name === id) ? null : true;
		}, PACK_ID),
		{ timeout: 20_000, desc: "列表刷新后不再包含该包" },
	);
});

// ── ⑦ 错误态：缺 manifest 的包要能读懂、能重选 ──────────────

await h.check("缺 manifest 的包：整页错误 + 「重新选择…」且标题是所选文件名", async () => {
	const broken = join(h.WORKSPACE_DIR, "broken-fixture");
	mkdirSync(broken, { recursive: true });
	writeFileSync(join(broken, "README.md"), "# 没有 manifest\n");
	await stubOpenDialog([broken]);
	const clicked = await win.evaluate(() => {
		const button = [...document.querySelectorAll(".ex-topbar button")].find((b) =>
			(b.textContent ?? "").includes("导入能力包"),
		);
		if (button === undefined) return false;
		button.click();
		return true;
	});
	assert.ok(clicked, "找不到「导入能力包…」按钮");
	const text = await waitUntil(async () => {
		const inner = await win.evaluate(() => document.querySelector(".pack-preview")?.innerText ?? "");
		return inner.includes("PACK_MANIFEST_MISSING") ? inner : null;
	}, { timeout: 20_000, desc: "预览显示 manifest 缺失错误" });
	assert.ok(text.includes("无法导入这个能力包"), `没有错误标题：${text.slice(0, 200)}`);
	assert.ok(text.includes("README.md") || text.includes("manifest.json"), "错误里没有定位到文件");
	const title = await win.evaluate(
		() => document.querySelector(".pack-preview .ex-modal-name")?.textContent ?? "",
	);
	assert.equal(title, "broken-fixture", `标题应为所选文件名，实际「${title}」`);
	const primary = await win.evaluate(
		() => document.querySelector(".pack-preview-actions .primary-btn")?.textContent ?? "",
	);
	assert.ok(primary.includes("重新选择"), `主按钮应为「重新选择…」，实际「${primary}」`);
	await waitAnimations(".ex-modal-mask");
	await h.shoot("pack-preview-error");
	const closed = await win.evaluate(() => {
		const button = [...document.querySelectorAll(".pack-preview-actions .mini-btn")].find((node) =>
			(node.textContent ?? "").includes("取消"),
		);
		if (button === undefined) return false;
		button.click();
		return true;
	});
	assert.ok(closed, "找不到「取消」按钮");
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".pack-preview") === null),
		{ timeout: 10_000, desc: "错误弹窗关闭" },
	);
});

await restoreDialog();

await h.check("无渲染层未捕获异常", () => assert.equal(h.pageErrors.length, 0, h.pageErrors.join("; ")));

await h.finish();
