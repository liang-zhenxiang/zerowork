/**
 * 诊断健康评分环 + 首页场景 Bento（#268 剩余两项）。
 *
 * 两条链各自跨了「纯逻辑 → 渲染」两层，所以分工是：
 *   · 扣分规则与「建议指向谁」由 tests/unit/health-score.test.mjs 钉死；
 *   · 本文件只验「真实 Electron 里它真的接上了」：8 张卡真的都在、跨场景点开真的有
 *     内容、环上的总分与四行分数一致、建议真的存在且指向当前最低分那一项。
 *
 * ⚠️ **为什么不用 mock 状态来控制「建议指向谁」**：`window.kami` 是
 * contextBridge 暴露的（`Object.isFrozen` 为 true、属性不可写不可配置），
 * 渲染层进程里改不动它。所以这里改为**从渲染结果反推**：读四行的分数，
 * 自己算最低分那一项（并列时取文档顺序，正是产品里的固定顺序），再断言建议
 * 文本指向它。这条断言在「本机有环境变量给的模型」与「CI 上一个模型都没有」
 * 两种干净配置下都成立，不依赖这台机器碰巧配了什么。
 */
import assert from "node:assert/strict";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const h = createHarness({ name: "health-bento", shots: true });
await h.launch();
const win = h.window();

/** 首页 8 张 Bento 卡的可读摘要（名字 / 描述 / 计数 / 是否跨列 / 实际宽度）。 */
const bentoCards = () =>
	win.evaluate(() =>
		[...document.querySelectorAll(".bento-card")].map((card) => ({
			name: (card.querySelector(".bento-name")?.textContent ?? "").trim(),
			desc: (card.querySelector(".bento-desc")?.textContent ?? "").trim(),
			count: (card.querySelector(".bento-count")?.textContent ?? "").trim(),
			wide: card.classList.contains("bento-wide"),
			active: card.classList.contains("active"),
			expanded: card.getAttribute("aria-expanded"),
			width: Math.round(card.getBoundingClientRect().width),
		})),
	);

/** 点一张卡（按名字找，不用坐标 —— 页面可能已滚动）。 */
const clickBento = async (name) => {
	const ok = await win.evaluate((target) => {
		const card = [...document.querySelectorAll(".bento-card")].find(
			(node) => (node.querySelector(".bento-name")?.textContent ?? "").trim() === target,
		);
		if (card === undefined) return false;
		card.click();
		return true;
	}, name);
	assert.ok(ok, `首页找不到名为「${name}」的 Bento 卡`);
};

/** 当前展开的下钻面板里的条目文本（面板未开时为 null）。 */
const chipPanelItems = () =>
	win.evaluate(() => {
		const panel = document.querySelector(".chip-panel");
		if (panel === null) return null;
		return [...panel.querySelectorAll(".chip-panel-item")].map((node) => ({
			text: (node.textContent ?? "").trim(),
			prompt: node.getAttribute("title") ?? "",
		}));
	});

/** 当前选中的场景标签文字（Bento 是跨场景展示，点 code 卡不得切换场景）。 */
const activeSceneLabel = () =>
	win.evaluate(() => (document.querySelector(".mode-tab.active")?.textContent ?? "").trim());

/** 切主题（走渲染层唯一真源 html[data-theme]，与 dark-polish / projects 同口径）。 */
async function setTheme(value) {
	await win.evaluate((next) => document.documentElement.setAttribute("data-theme", next), value);
	await waitUntil(() => win.evaluate((next) => document.documentElement.getAttribute("data-theme") === next, value), {
		timeout: 10_000,
		desc: `data-theme 切到 ${value}`,
	});
	await h.waitForSettled();
}

// ══ ① 首页 Bento：全量 8 张卡 ══════════════════════════════════════

const EXPECTED_CHIPS = [
	"文档处理",
	"数据分析及可视化",
	"深度研究",
	"幻灯片",
	"日常开发",
	"网站开发",
	"CI/CD",
	"文档",
];

const cards = await waitUntil(
	async () => {
		const list = await bentoCards();
		return list.length === EXPECTED_CHIPS.length ? list : null;
	},
	{ timeout: 30_000, desc: "首页 8 张 Bento 卡渲染（welcome IPC 回包后）" },
);

// 显式切到浅色再拍：PRD 要的是「浅色 / 暗色各一张」。开机主题跟随 OS，
// 在深色桌面的机器上直接拍会得到一张「名不副实」的浅色图。
await setTheme("light");
await h.shoot("home-bento-light");

await h.check("首页 Bento 恰好 8 张卡，顺序与 chips.json 一致（work 4 + code 4）", () => {
	assert.deepEqual(
		cards.map((card) => card.name),
		EXPECTED_CHIPS,
		`实际卡片：${cards.map((card) => card.name).join(" / ")}`,
	);
});

await h.check("每张卡都有描述与模板 / 提示词数量", () => {
	for (const card of cards) {
		assert.ok(card.desc.length > 0, `「${card.name}」没有描述`);
		assert.match(card.count, /^\d+ 个(模板|提示词)$/, `「${card.name}」的计数文案=${card.count}`);
	}
	// 数量要真的是该卡自己的数据，不是同一个数字抄八遍。
	const counts = new Set(cards.map((card) => card.count));
	assert.ok(counts.size > 1, `八张卡的计数完全相同：${[...counts].join(" / ")} —— 没按卡取数据？`);
});

await h.check("不等宽 Bento：首张与末张跨 2 列，中间 6 张单列（5 列网格排成两行）", () => {
	assert.deepEqual(
		cards.map((card) => card.wide),
		[true, false, false, false, false, false, false, true],
		`跨列标记=${cards.map((card) => card.wide).join(",")}`,
	);
	const wideWidth = cards[0].width;
	const narrowWidth = cards[1].width;
	assert.ok(
		wideWidth > narrowWidth + 20,
		`跨列卡 ${wideWidth}px 不比单列卡 ${narrowWidth}px 宽 —— 网格没生效？`,
	);
});

await h.check("能力胶囊行的 24px 底边距保持（docs/DESIGN.md §3.8，gui-smoke 同款断言）", async () => {
	const metrics = await win.evaluate(() => {
		const row = document.querySelector(".capability-row");
		const grid = document.querySelector(".bento-grid");
		return {
			marginBottom: row === null ? null : getComputedStyle(row).marginBottom,
			columns: grid === null ? null : getComputedStyle(grid).gridTemplateColumns,
		};
	});
	assert.equal(metrics.marginBottom, "24px", `能力区底边距=${metrics.marginBottom}（期望 24 = --space-6）`);
	const columnCount = metrics.columns === null ? 0 : metrics.columns.split(" ").length;
	assert.equal(columnCount, 5, `Bento 网格列数=${columnCount}（期望 5，实际 ${metrics.columns}）`);
});

await h.check("输入卡完整落在 1280×860 首屏内（8 张 Bento 卡不得把它顶出去 —— docs/DESIGN.md §3.9）", async () => {
	const box = await win.evaluate(() => {
		const card = document.querySelector(".composer-card");
		const input = document.querySelector('[aria-label="消息输入框"]');
		const el = card ?? input;
		if (el === null) return null;
		const rect = el.getBoundingClientRect();
		return {
			target: card === null ? "消息输入框" : ".composer-card",
			top: Math.round(rect.top),
			bottom: Math.round(rect.bottom),
			viewport: window.innerHeight,
			scrollHeight: document.querySelector(".home")?.scrollHeight ?? null,
			gridRows: (() => {
				const grid = document.querySelector(".bento-grid");
				if (grid === null) return null;
				const rects = [...grid.children].map((node) => Math.round(node.getBoundingClientRect().top));
				return new Set(rects).size;
			})(),
		};
	});
	assert.ok(box !== null, "首页找不到 .composer-card / 消息输入框");
	assert.equal(box.gridRows, 2, `Bento 占 ${box.gridRows} 行（期望 2 行 —— 3 行会把输入卡顶出首屏）`);
	// 验收基准是 1280×860（PRD 的窗口）。**不能直接拿 window.innerHeight 当预算**：
	// CI 的窗口更矮（docs/DESIGN.md §21 记录 1280×679），在那里连改动前的首页都
	// 装不下输入卡（内容自顶部起排，位置与视口高无关）—— 用 innerHeight 会让这条
	// 断言在 CI 上因环境而红。取 max(实际视口, 860)：本机 860 时它就是 innerHeight，
	// 矮视口下仍守住 860 的设计预算，且位置本身与视口高无关。
	const budget = Math.max(box.viewport, 860);
	assert.ok(
		box.top >= 0,
		`${box.target} 顶 ${box.top} < 0，已被滚动/裁切（首页 scrollH=${box.scrollHeight}）—— 上半部分不可见`,
	);
	assert.ok(
		box.bottom <= budget,
		`${box.target} 底 ${box.bottom} > 首屏预算 ${budget}（视口 ${box.viewport}，首页 scrollH=${box.scrollHeight}）—— ` +
			"Bento 卡把输入卡顶出了 1280×860 首屏；docs/DESIGN.md §3.9 要求输入卡是首页唯一的视觉重点，必须一屏可见",
	);
});

// ══ ② 跨场景点击：work 场景下点 code 的卡 ═══════════════════════════

await h.check("跨场景点「日常开发」（work 场景下）：不切场景，面板列出它自己的提示词", async () => {
	const sceneBefore = await activeSceneLabel();
	assert.equal(sceneBefore, "日常办公", `默认场景应是 work（实际「${sceneBefore}」），否则这条不是跨场景`);

	await clickBento("日常开发");
	const items = await waitUntil(
		async () => {
			const list = await chipPanelItems();
			return list !== null && list.length > 0 ? list : null;
		},
		{ timeout: 15_000, desc: "「日常开发」下钻面板出现条目" },
	);
	assert.equal(items.length, 6, `「日常开发」应有 6 条提示词，实际 ${items.length}`);
	assert.ok(
		items.some((item) => item.text.includes("帮我")),
		`面板里不是提示词：${items.map((item) => item.text).join(" / ")}`,
	);

	const state = await win.evaluate(() => {
		const active = document.querySelector(".bento-card.active");
		return {
			scene: (document.querySelector(".mode-tab.active")?.textContent ?? "").trim(),
			activeName: (active?.querySelector(".bento-name")?.textContent ?? "").trim(),
			expanded: active?.getAttribute("aria-expanded") ?? null,
		};
	});
	assert.equal(state.scene, "日常办公", `点了 code 卡以后场景被切走了（${state.scene}）`);
	assert.equal(state.activeName, "日常开发", `选中态落到了「${state.activeName}」上`);
	assert.equal(state.expanded, "true", "选中卡应 aria-expanded=true");

	// 关掉面板，免得影响后续截图与点击。
	await win.evaluate(() => document.querySelector(".chip-panel") !== null && document.querySelector(".ws-backdrop")?.click());
	await waitUntil(() => win.evaluate(() => document.querySelector(".chip-panel") === null), {
		timeout: 10_000,
		desc: "下钻面板关闭",
	});
});

await h.check("点同场景的模板卡「文档处理」：面板列出带标题的模板", async () => {
	await clickBento("文档处理");
	const items = await waitUntil(
		async () => {
			const list = await chipPanelItems();
			return list !== null && list.length > 0 ? list : null;
		},
		{ timeout: 15_000, desc: "「文档处理」下钻面板出现条目" },
	);
	assert.equal(items.length, 3, `「文档处理」应有 3 个模板，实际 ${items.length}`);
	assert.ok(
		items.every((item) => item.text.length > 0 && item.prompt.length > 0),
		"模板条目应同时有标题文本与完整提示词（title）",
	);
	await win.evaluate(() => document.querySelector(".ws-backdrop")?.click());
	await waitUntil(() => win.evaluate(() => document.querySelector(".chip-panel") === null), {
		timeout: 10_000,
		desc: "下钻面板关闭",
	});
});

// ══ ③ 首页暗色截图 ═════════════════════════════════════════════════

await setTheme("dark");
await h.shoot("home-bento-dark");
await setTheme("light");

// ══ ④ 诊断页健康评分环 ═════════════════════════════════════════════

const openDiagnostics = async () => {
	const ok = await win.evaluate(() => {
		const button = [...document.querySelectorAll(".sidebar-nav button")].find(
			(node) => (node.textContent ?? "").trim() === "诊断",
		);
		if (button === undefined || button.disabled) return false;
		button.click();
		return true;
	});
	assert.ok(ok, "侧栏找不到可点的「诊断」");
	await waitUntil(
		() => win.evaluate(() => document.querySelectorAll(".health-row").length === 4),
		{ timeout: 30_000, desc: "诊断页健康评分四行渲染（四个 IPC 回包后）" },
	);
};

await openDiagnostics();
await h.shoot("diagnostics-health-light");

const readHealth = () =>
	win.evaluate(() => {
		const ring = document.querySelector(".health-ring svg");
		const card = document.querySelector(".health-card");
		const rowScore = (row) => {
			const text = (row.querySelector(".health-row-score")?.textContent ?? "").trim();
			const value = Number.parseInt(text, 10);
			return Number.isNaN(value) ? null : value;
		};
		return {
			aria: ring?.getAttribute("aria-label") ?? "",
			score: (document.querySelector(".health-ring-score")?.textContent ?? "").trim(),
			band: (document.querySelector(".health-band-label")?.textContent ?? "").trim(),
			cardClass: card?.className ?? "",
			rows: [...document.querySelectorAll(".health-row")].map((row) => ({
				name: (row.querySelector(".health-row-name")?.textContent ?? "").trim(),
				state: (row.querySelector(".health-row-state")?.textContent ?? "").trim(),
				score: rowScore(row),
			})),
			advice: (document.querySelector(".health-advice")?.textContent ?? "").trim(),
			firstSection: (document.querySelector(".settings-body > .settings-section h2")?.textContent ?? "").trim(),
		};
	});

const health = await readHealth();

await h.check("健康评分是诊断页的第一块（顶部评分环）", () => {
	assert.equal(health.firstSection, "健康评分", `第一块是「${health.firstSection}」`);
});

await h.check("四行分项齐全，且每行有真实的「正常 / 扣分 / 无法判断」状态文案", () => {
	assert.deepEqual(
		health.rows.map((row) => row.name),
		["模型可用", "内置运行时", "最近任务成功率", "全局快捷键"],
		`分项=${health.rows.map((row) => row.name).join(" / ")}`,
	);
	for (const row of health.rows) {
		assert.ok(
			["正常", "扣分", "无法判断"].includes(row.state),
			`「${row.name}」的状态文案=${JSON.stringify(row.state)}（状态不只靠颜色，必须有这三个词之一）`,
		);
		assert.ok(
			Number.isInteger(row.score) && row.score >= 0 && row.score <= 25,
			`「${row.name}」得分=${row.score}（期望 0–25 的整数）`,
		);
	}
});

await h.check("环上的总分 = 四行分数之和，且 aria-label 与画面上的数字一致", () => {
	const sum = health.rows.reduce((acc, row) => acc + row.score, 0);
	assert.equal(health.score, String(sum), `环中心=${health.score}，四行之和=${sum}`);
	assert.ok(health.aria.includes(`健康评分 ${sum} 分`), `aria-label=${health.aria} 没带上总分 ${sum}`);
	assert.ok(health.aria.length > 10, "环必须有 aria-label，屏幕阅读器不能只靠图形");
});

await h.check("档位与总分成对：≥90 状态良好 / ≥70 基本可用 / ≥50 需要处理 / 其余存在问题", () => {
	const total = Number(health.score);
	const expected = total >= 90 ? ["ok", "状态良好"] : total >= 70 ? ["accent", "基本可用"] : total >= 50 ? ["warning", "需要处理"] : ["danger", "存在问题"];
	assert.equal(health.band, expected[1], `总分 ${total} 的档位文案=${health.band}`);
	assert.ok(health.cardClass.includes(`health-band-${expected[0]}`), `总分 ${total} 的档位类=${health.cardClass}`);
});

await h.check("至少一项扣分时，建议指向扣分最多的那一项（扣分 → 建议的闭环）", () => {
	assert.ok(health.advice.length > 0, "建议是空字符串");
	// 从渲染结果反推最低分项：并列时取文档顺序（= 产品里的固定顺序）。
	let target = health.rows[0];
	for (const row of health.rows) {
		if (row.score < target.score) target = row;
	}
	if (target.state === "无法判断") {
		assert.ok(
			health.advice.includes("无法读取"),
			`最低分项「${target.name}」无法判断，建议却写着「${health.advice}」——应当提示刷新重试`,
		);
		return;
	}
	const keyword = {
		模型可用: "模型",
		内置运行时: "运行时",
		最近任务成功率: "任务",
		全局快捷键: "快捷键",
	}[target.name];
	assert.ok(
		health.advice.includes(keyword),
		`最低分项是「${target.name}」（${target.score}/25），建议却写着「${health.advice}」`,
	);
});

await h.check("干净配置下模型项必然是扣分（没选模型 / 没有可用模型）", () => {
	const model = health.rows.find((row) => row.name === "模型可用");
	assert.ok(model !== undefined, "缺少「模型可用」行");
	assert.ok(
		model.score <= 10,
		`干净配置下模型得分=${model.score}/25（既没选模型也没有可用模型时应 ≤10）`,
	);
	assert.equal(model.state, "扣分", `模型项状态=${model.state}（应如实显示「扣分」）`);
});

await h.check("建议不是一句空话：扣分时给出下一步动作", () => {
	const total = Number(health.score);
	if (total === 100) {
		assert.ok(health.advice.includes("没有需要处理的项"), `满分时的建议=${health.advice}`);
	} else {
		assert.ok(health.advice.length >= 10, `扣分时的建议太短：${health.advice}`);
	}
});

// 诊断页暗色截图 + 可读性（不只是切个属性就截图）。
await setTheme("dark");
await h.shoot("diagnostics-health-dark");
await h.check("暗色下评分环与四行文字仍可读（不是一片同色）", async () => {
	const dark = await readHealth();
	assert.equal(dark.rows.length, 4, "暗色下四行分项丢了");
	assert.equal(dark.score, health.score, "切主题不应改变分数");
	assert.ok(dark.advice.length > 0, "暗色下建议丢了");
	const colors = await win.evaluate(() => {
		const pick = (selector) => {
			const node = document.querySelector(selector);
			return node === null ? null : getComputedStyle(node).color;
		};
		return {
			name: pick(".health-row-name"),
			state: pick(".health-row-state"),
			advice: pick(".health-advice"),
		};
	});
	assert.ok(colors.name !== null && colors.advice !== null, "暗色下取不到文字颜色");
	assert.notEqual(colors.name, colors.advice, `主文与次文同色（${colors.name}）—— 暗色下层级塌了`);
});
await setTheme("light");

await h.finish();
