/**
 * 设置页分组的 GUI 测试。
 *
 * 补的是一块**完全没被 GUI 覆盖过**的地方：`gui-sections.mjs` 覆盖的是**顶层导航**
 * 那几项（助理 / 项目 / 专家·技能·连接器 / 自动化 / 资料库 / 诊断 / 统计），
 * 而**设置对话框里的 9 个分组**（通用 / 个性化 / 记忆与进化 / 模型 / 内置运行时 /
 * 数据管理 / 审计中心 / 提示词预览 / 关于）此前没有任何测试导航过 ——
 * 全仓 grep 连这些标签都没出现过。
 *
 * 设置页是用户配置一切的地方，它渲染不出来（或某个分组点开是空白）属于
 * 「界面看着在、功能全挂」那一类，只断言文本存在是抓不到的。
 *
 * 断言：
 *   ① 齿轮能打开设置对话框（role=dialog）；
 *   ② 侧栏分组清单包含**已知的 9 个标签**（少了任何一个都会露出来）；
 *   ③ 逐个点开，每个分组的面板都渲染出**非空内容**，且没有渲染异常；
 *   ④ 每个分组都截图并做**像素断言**（不是一片纯色）—— 「元素都在但样式全丢」
 *      或「整块落进错误边界」是文本断言抓不到的。
 *
 * 迁移说明（共享 harness）：骨架（隔离目录、启动等待、check 收集器、末尾报告与
 * 退出码）全部来自 `./lib/harness.mjs`，本文件只剩「驱动界面 + 断言」。
 * 等待一律用信号：导航后用 `h.waitForSettled()`，对话框出现 / 消失用 `waitUntil`，
 * 不再用固定 `waitForTimeout`。
 */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createHarness, waitUntil } from "./lib/harness.mjs";

/**
 * 设置对话框里应有的分组（与渲染层 NAV_ITEMS 对齐；少一个就说明有分组不见了），
 * 以及每个分组截图用的语义化名字（截图目录 artifacts/settings/）。
 */
const EXPECTED = [
	["通用", "general"],
	["个性化", "personalization"],
	["记忆与进化", "memory"],
	["模型", "model"],
	["内置运行时", "runtimes"],
	["数据管理", "data"],
	["审计中心", "audit"],
	["提示词预览", "prompt-preview"],
	["关于", "about"],
];

const h = createHarness({ name: "settings" });
// harness 负责隔离与清空工作区根目录，目录本身要由用例建出来
mkdirSync(h.WORKSPACE_DIR, { recursive: true });

await h.launch();
const win = h.window();

await h.check("齿轮按钮能打开设置对话框", async () => {
	await win.evaluate(() => {
		const btn = document.querySelector('[aria-label="设置"]');
		if (btn === null) throw new Error('找不到设置按钮 [aria-label="设置"]');
		btn.click();
	});
	// 等对话框真的挂上，而不是等一个拍脑袋的固定时长
	await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") !== null), {
		timeout: 15_000,
		desc: "设置对话框挂上（.settings-card 出现）",
	});
});

const navLabels = await win.evaluate(() =>
	[...document.querySelectorAll(".settings-nav-item")].map((n) => (n.textContent || "").trim()),
);

await h.check("侧栏分组清单包含全部已知分组", async () => {
	assert.ok(navLabels.length > 0, "设置侧栏一个分组都没有");
	const missing = EXPECTED.map(([label]) => label).filter((l) => !navLabels.includes(l));
	assert.equal(missing.length, 0, `设置页缺少分组：${missing.join("、")}（现有：${navLabels.join("、")}）`);
	console.log(`      分组 ${navLabels.length} 个：${navLabels.join("、")}`);
});

/** 点开某个分组，返回面板与整卡的文本。 */
async function openGroup(label) {
	const clicked = await win.evaluate((text) => {
		const items = [...document.querySelectorAll(".settings-nav-item")];
		const hit = items.find((n) => (n.textContent || "").trim() === text);
		if (hit === undefined) return false;
		hit.click();
		return true;
	}, label);
	assert.ok(clicked, `设置侧栏里找不到分组「${label}」`);
	await h.waitForSettled();
	return win.evaluate(() => {
		const panel = document.querySelector(".settings-panel") ?? document.querySelector(".settings-body");
		return {
			panelText: (panel?.innerText ?? "").trim(),
			cardTextLen: (document.querySelector(".settings-card")?.innerText ?? "").trim().length,
			active: [...document.querySelectorAll(".settings-nav-item")].find((n) => n.classList.contains("active"))?.textContent?.trim(),
		};
	});
}

let panel = null;
for (const [label, slug] of EXPECTED) {
	const errBefore = h.pageErrors.length;

	panel = null;
	await h.check(`导航到设置分组「${label}」`, async () => {
		panel = await openGroup(label);
	});

	// 先截图、后断言：分组打开后就留现场，后面任何一条断言失败时都看得到那一屏。
	// 截图自带像素断言 —— DOM 规模够不等于画面不是一块纯色。
	await h.check(`「${label}」画面已渲染`, () => h.shoot(`settings-${slug}`));

	await h.check(`设置分组「${label}」渲染出内容`, async () => {
		assert.ok(panel !== null, `「${label}」没打开，无从断言内容`);
		// 面板必须有内容：空白面板说明这个分组没接上（或渲染时抛了）
		assert.ok(panel.panelText.length > 0, `「${label}」的面板是空的`);
		assert.ok(panel.cardTextLen > 40, `「${label}」整卡文本仅 ${panel.cardTextLen} 字符，疑似没渲染`);
		assert.equal(panel.active, label, `点开后高亮的分组是「${panel.active}」，不是「${label}」`);
		console.log(`      「${label}」面板 ${panel.panelText.length} 字符`);
	});

	await h.check(`设置分组「${label}」无渲染异常`, () => {
		const fresh = h.pageErrors.slice(errBefore);
		assert.equal(fresh.length, 0, fresh.join("; "));
	});
}

/*
 * 关于页的第三方组件注明（2026-10-05，#19 的可执行部分）。
 *
 * 为什么它必须**看得见**而不是「在 DOM 里」：MIT 与 Apache-2.0 要求分发副本里
 * 保留版权与许可声明 —— 用户手上是安装包，不是仓库，这条注明得真的显示出来。
 * 所以这里断言的是**渲染可见性**（getClientRects 非空 = 真的画出来了）与文本内容，
 * 而不是查询选择器命中（隐藏元素同样会被命中）。MiSans 已于 2026-09-20 移除，
 * 因此它**不该**出现在这里 —— 列了等于声称用了它，反而失实（反向断言在下面）。
 */
await h.check("「关于」页：第三方组件与许可注明真的渲染出来", async () => {
	await openGroup("关于");
	const r = await win.evaluate(() => {
		const section = document.querySelector(".settings-panel .settings-section");
		if (section === null) return { error: "找不到关于页的 section" };
		const visible = (el) => el !== null && el.getClientRects().length > 0;
		const rows = [...section.querySelectorAll(".provider-row")].map((row) => ({
			name: row.querySelector(".provider-name")?.textContent?.trim() ?? "",
			meta: row.querySelector(".provider-meta")?.textContent?.trim() ?? "",
			visible: visible(row),
		}));
		const subhead = [...section.querySelectorAll(".settings-subhead")].find((n) =>
			(n.textContent ?? "").includes("第三方组件"),
		);
		const foot = section.querySelector(".settings-foot a");
		return {
			rows,
			subheadVisible: visible(subhead ?? null),
			footText: foot?.textContent?.trim() ?? null,
			footVisible: visible(foot ?? null),
			text: section.innerText,
		};
	});
	assert.equal(r.error, undefined, r.error);
	assert.ok(r.subheadVisible, "「第三方组件」小节标题没渲染出来");
	assert.ok(r.footVisible, "指向完整清单的那一行没渲染出来");

	const byName = new Map(r.rows.map((row) => [row.name, row]));
	for (const name of ["ZeroWork", "许可", "KaTeX", "SheetJS Community Edition（xlsx）", "lodash", "JSZip", "PDF.js（pdfjs-dist）"]) {
		const row = byName.get(name);
		assert.ok(row !== undefined, `关于页缺少「${name}」这一行。现有：${r.rows.map((x) => x.name).join(" / ")}`);
		assert.ok(row.visible, `「${name}」那一行在 DOM 里但没渲染出来（getClientRects 为空）`);
	}
	// 许可标识要真的露出来（只写名字不写许可，等于没做归属）
	assert.match(byName.get("KaTeX").meta, /MIT/);
	assert.match(byName.get("SheetJS Community Edition（xlsx）").meta, /Apache-2\.0/);
	assert.match(byName.get("许可").meta, /Apache-2\.0/);
	assert.equal(r.footText, "THIRD_PARTY_NOTICES.md", `指向完整清单的链接文字应是文件名，实际「${r.footText}」`);
	// 反向：MiSans 已不随包（2026-09-20 移除），注明里**不该**出现它
	assert.ok(
		!r.text.includes("MiSans"),
		"关于页出现了 MiSans —— 它自 2026-09-20 起已从字体栈与随包内容中移除，列上等于声称用了它",
	);
	await h.shoot("settings-about-attribution");

	// 深色下同样要看得见（这一段是**义务**，不是装饰；深色是它最容易被吞掉的地方）
	await win.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
	await h.waitForSettled();
	const dark = await win.evaluate(() => {
		const section = document.querySelector(".settings-panel .settings-section");
		const rows = [...(section?.querySelectorAll(".provider-row") ?? [])];
		return {
			visible: rows.filter((row) => row.getClientRects().length > 0).length,
			text: section?.innerText ?? "",
		};
	});
	assert.ok(dark.visible >= 7, `深色下关于页的行没渲染出来（可见 ${dark.visible} 行）`);
	assert.ok(dark.text.includes("Apache-2.0"), "深色下许可注明不见了");
	await h.shoot("settings-about-attribution-dark");
	await win.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
});

await h.check("关闭设置后对话框消失", async () => {
	await win.evaluate(() => {
		const btn = document.querySelector('[aria-label="关闭设置"]');
		if (btn !== null) btn.click();
	});
	await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") === null), {
		timeout: 15_000,
		desc: "设置对话框关闭（.settings-card 消失）",
	});
});

await h.check("无渲染层未捕获异常", () => assert.equal(h.pageErrors.length, 0, h.pageErrors.join("; ")));

await h.finish();
