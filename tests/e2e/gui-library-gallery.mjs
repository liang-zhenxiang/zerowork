/**
 * 资料库「成果展厅」（#423）的 GUI 端到端测试。
 *
 * 纯逻辑（类型 / 封面 / 筛选 / 路径归属 / 提示 / 版本 key）有单测
 * （`tests/unit/library-gallery-core.test.mjs`）。**本文件补的是只有真实启动
 * Electron 才暴露的那层**：侧栏能进、IPC 真通、网格真的画出来、筛选真的作用在
 * DOM 上、详情里的「版本历史」真的跳到文件历史并选中那个文件、「继续修改」
 * 真的把新会话开在**来源 cwd** 并预填提示。
 *
 * ## 夹具
 *
 * 三个交付物（两个会话、两个工作区）：
 *   · 季度复盘.md  —— 会话 A（cwd = wsA），1 小时前交付，**另造一版文件历史**
 *   · 销售数据.csv —— 会话 A，10 天前交付
 *   · 方案.pptx    —— 会话 B（cwd = wsB），40 天前交付
 *
 * 时间跨度用来验「最近 7 天 / 30 天」两档真的在筛；文件历史直接按 daemon 的
 * 磁盘契约写 `versions/<sha1(path)>/meta.json + <id>.txt`，不跑模型回合
 * （版本记录的写入路径已有 `tests/e2e/file-history.mjs` 覆盖）。
 *
 * ## 反向验证（已真跑并还原）
 *
 * 把 `sourceCwdFor` 改成恒返回 undefined → 「继续修改」变红（按钮禁用），
 * 其余断言不受影响；还原后全绿。注入必须打在**生效的判据**上：详情按钮的
 * disabled 与 App 的 continueArtifact 都读 sourceCwdFor，前者先命中。
 *
 * ## 等待
 *
 * 所有 `waitUntil` 谓词都能返回假值（`.trellis/spec/testing/index.md` 第 1 条）。
 * 导航 / 筛选后是空闲态可以用 `h.waitForSettled()`；**不要**在模型回合里用它。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const h = createHarness({ name: "library-gallery" });
await h.launch();
const win = h.window();
await h.dismissWhatsNew();


const SESSIONS_DIR = join(h.CONFIG_DIR, "sessions");
const VERSIONS_DIR = join(h.CONFIG_DIR, "versions");
const WS_A = join(h.WORKSPACE_DIR, "wsA");
const WS_B = join(h.WORKSPACE_DIR, "wsB");
mkdirSync(WS_A, { recursive: true });
mkdirSync(WS_B, { recursive: true });

const MD_PATH = join(WS_A, "季度复盘.md");
const CSV_PATH = join(WS_A, "销售数据.csv");
const DECK_PATH = join(WS_B, "方案.pptx");

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.now();
const delivered = (msAgo) => new Date(NOW - msAgo).toISOString();

let sessionSeq = 0;
function sessionFile({ id, cwd, firstText, artifacts }) {
	sessionSeq += 1;
	const name = `2026-11-19T12-00-${String(sessionSeq).padStart(2, "0")}-000Z_${id}.jsonl`;
	const lines = [
		JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd }),
		JSON.stringify({
			type: "message",
			id: `${id}-m0`,
			parentId: null,
			timestamp: new Date().toISOString(),
			message: { role: "user", content: [{ type: "text", text: firstText }] },
		}),
	];
	for (const [index, artifact] of artifacts.entries()) {
		lines.push(
			JSON.stringify({
				type: "custom",
				customType: "artifacts_presented",
				data: { files: [{ path: artifact.path, size: artifact.size, html: false, kind: "local" }], focusFile: artifact.path },
				id: `${id}-a${index}`,
				parentId: `${id}-m0`,
				timestamp: artifact.deliveredAt,
			}),
		);
	}
	writeFileSync(join(SESSIONS_DIR, name), `${lines.join("\n")}\n`);
}

/** 按 daemon 的文件历史磁盘契约造一版 md 的历史（key = sha1(绝对路径) 前 16 位）。 */
function seedVersion() {
	mkdirSync(VERSIONS_DIR, { recursive: true });
	const absPath = resolve(MD_PATH);
	const key = createHash("sha1").update(absPath).digest("hex").slice(0, 16);
	const dir = join(VERSIONS_DIR, key);
	mkdirSync(dir, { recursive: true });
	const at = NOW - 2 * HOUR;
	const id = String(at);
	const content = "# 季度复盘\n\n这是被改动前的一版。\n";
	writeFileSync(join(dir, `${id}.txt`), content);
	writeFileSync(
		join(dir, "meta.json"),
		`${JSON.stringify({ path: absPath, skipped: 0, versions: [{ id, at, size: Buffer.byteLength(content), tool: "write" }] }, null, 2)}\n`,
	);
}

function seedAll() {
	mkdirSync(SESSIONS_DIR, { recursive: true });
	writeFileSync(MD_PATH, "# 季度复盘\n\n这是最终交付的版本。\n");
	writeFileSync(CSV_PATH, "月份,销售额\n1,100\n2,120\n");
	writeFileSync(DECK_PATH, "fake-pptx-bytes");
	sessionFile({
		id: "11111111-1111-7111-8111-111111111111",
		cwd: WS_A,
		firstText: "帮我写季度复盘",
		artifacts: [
			{ path: MD_PATH, size: 46, deliveredAt: delivered(HOUR) },
			{ path: CSV_PATH, size: 2048, deliveredAt: delivered(10 * DAY) },
		],
	});
	sessionFile({
		id: "22222222-2222-7222-8222-222222222222",
		cwd: WS_B,
		firstText: "做销售方案",
		artifacts: [{ path: DECK_PATH, size: 14, deliveredAt: delivered(40 * DAY) }],
	});
	seedVersion();
}

// ── DOM 工具 ────────────────────────────────────────────────────

const clickNav = async (label) => {
	const ok = await win.evaluate((text) => {
		const btn = [...document.querySelectorAll(".sidebar-nav button")].find((b) => (b.textContent ?? "").trim() === text);
		if (btn === undefined || btn.disabled) return false;
		btn.click();
		return true;
	}, label);
	assert.ok(ok, `侧栏找不到可点的「${label}」导航项`);
};

const waitLibrary = () =>
	waitUntil(
		() => win.evaluate(() => document.querySelector("main.settings h1")?.textContent === "资料库"),
		{ timeout: 15_000, desc: "进入资料库视图" },
	);

const readCards = () =>
	win.evaluate(() => {
		const grid = document.querySelector("main.settings .lib-grid");
		if (grid === null) return null;
		return [...grid.querySelectorAll(".lib-card")].map((card) => {
			const cover = card.querySelector(".lib-cover");
			return {
				name: (card.querySelector(".lib-card-name")?.textContent ?? "").trim(),
				type: card.getAttribute("data-type") ?? "",
				meta: (card.querySelector(".lib-card-meta")?.textContent ?? "").trim(),
				source: (card.querySelector(".lib-card-source")?.textContent ?? "").trim(),
				badge: (card.querySelector(".lib-cover-badge")?.textContent ?? "").trim(),
				typeLabel: (card.querySelector(".lib-card-type")?.textContent ?? "").trim(),
				shape: cover === null ? "" : [...cover.classList].find((name) => name.startsWith("lib-cover-")) ?? "",
				missed: card.classList.contains("lib-card-missed"),
				cover: cover !== null,
			};
		});
	});

const waitCards = (pred, desc) =>
	waitUntil(
		async () => {
			const cards = await readCards();
			return cards !== null && pred(cards) ? cards : null;
		},
		{ timeout: 15_000, desc },
	);

const clickCard = async (name) => {
	const ok = await win.evaluate((text) => {
		const card = [...document.querySelectorAll("main.settings .lib-card")].find(
			(node) => (node.querySelector(".lib-card-name")?.textContent ?? "").trim() === text,
		);
		if (card === undefined) return false;
		card.click();
		return true;
	}, name);
	assert.ok(ok, `网格里找不到「${name}」卡片`);
};

const waitDetail = (name) =>
	waitUntil(
		() =>
			win.evaluate((text) => {
				const dialog = document.querySelector(".lib-detail");
				if (dialog === null) return null;
				const title = (dialog.querySelector(".lib-detail-name")?.textContent ?? "").trim();
				return title === text ? { title } : null;
			}, name),
		{ timeout: 15_000, desc: `打开「${name}」的详情` },
	);

const clickTypeChip = (label) =>
	win.evaluate((text) => {
		const btn = [...document.querySelectorAll("main.settings .lib-filter-chip")].find(
			(node) => (node.textContent ?? "").trim() === text,
		);
		if (btn === undefined) throw new Error(`资料库找不到类型 chip「${text}」`);
		btn.click();
	}, label);

/** 打开工具栏里的自定义下拉（aria-label 前缀），并选一项。 */
const pickOption = async (labelPrefix, optionText) => {
	const opened = await win.evaluate((prefix) => {
		const trigger = [...document.querySelectorAll("main.settings .lib-toolbar .provider-select-trigger")].find((node) =>
			(node.getAttribute("aria-label") ?? "").startsWith(prefix),
		);
		if (trigger === undefined) return false;
		trigger.click();
		return true;
	}, labelPrefix);
	assert.ok(opened, `找不到「${labelPrefix}」下拉`);
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".lib-toolbar .provider-select-panel") !== null),
		{ timeout: 5_000, desc: "下拉面板打开" },
	);
	const picked = await win.evaluate((text) => {
		const option = [...document.querySelectorAll(".lib-toolbar .provider-option")].find(
			(node) => (node.textContent ?? "").trim() === text,
		);
		if (option === undefined) return false;
		option.click();
		return true;
	}, optionText);
	assert.ok(picked, `下拉里找不到「${optionText}」`);
};

/** 往文件名搜索框写值（React 受控 input 要走原生 setter + input 事件）。 */
const setSearch = (text) =>
	win.evaluate((value) => {
		const input = document.querySelector('main.settings [aria-label="按文件名搜索产物"]');
		if (input === null) throw new Error("资料库找不到文件名搜索框");
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
		setter.call(input, value);
		input.dispatchEvent(new window.Event("input", { bubbles: true }));
	}, text);

const clickView = (label) =>
	win.evaluate((text) => {
		const btn = [...document.querySelectorAll("main.settings .lib-view-switch button")].find(
			(node) => (node.textContent ?? "").trim() === text,
		);
		if (btn === undefined) throw new Error(`资料库找不到「${text}」视图按钮`);
		btn.click();
	}, label);

/**
 * 截图前等入场动画结束（`.trellis/spec/testing/index.md` 第 9 条）。
 *
 * 弹窗是 `backdrop-in` + `pop-layer-in` 两条 animation；截在动画中途会拍到
 * 「半透明详情叠在网格上」的幽灵画面，评审会据此误判成弹窗背景没做。
 */
const waitAnimations = (selector) =>
	waitUntil(
		async () => {
			const done = await win.evaluate((sel) => {
				const node = document.querySelector(sel);
				if (node === null) return false;
				if (typeof node.getAnimations !== "function") return true;
				return node.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running");
			}, selector);
			return done ? true : null;
		},
		{ timeout: 5_000, desc: `动画结束：${selector}` },
	);

/**
 * 请求窗口尺寸并等它连续两帧稳定，返回**实际**尺寸。
 *
 * 与 gui-ui-audit / gui-plan-book 同款：CI runner 的屏幕会把请求钳制，
 * 断言按实际 innerWidth 做，不写死请求值。
 */
async function resizeWindow(width, height) {
	return win.evaluate(
		({ w, h: h2 }) =>
			new Promise((resolve) => {
				window.resizeTo(w, h2);
				let last = "";
				let stable = 0;
				const onResize = () => {
					stable = 0;
				};
				const tick = () => {
					const now = `${window.innerWidth}x${window.innerHeight}`;
					stable = now === last ? stable + 1 : 0;
					last = now;
					if (stable >= 2) {
						window.removeEventListener("resize", onResize);
						resolve({ width: window.innerWidth, height: window.innerHeight });
						return;
					}
					window.requestAnimationFrame(tick);
				};
				window.addEventListener("resize", onResize);
				window.requestAnimationFrame(tick);
			}),
		{ w: width, h: height },
	);
}

const clickDetailButton = (label) =>
	win.evaluate((text) => {
		const btn = [...document.querySelectorAll(".lib-detail button")].find((node) => (node.textContent ?? "").trim() === text);
		if (btn === undefined) return { found: false };
		const disabled = btn.disabled;
		if (!disabled) btn.click();
		return { found: true, disabled };
	}, label);

const readDetail = () =>
	win.evaluate(() => {
		const dialog = document.querySelector(".lib-detail");
		if (dialog === null) return null;
		const buttons = [...dialog.querySelectorAll("button")].map((node) => ({
			text: (node.textContent ?? "").trim(),
			disabled: node.disabled,
		}));
		return {
			title: (dialog.querySelector(".lib-detail-name")?.textContent ?? "").trim(),
			path: (dialog.querySelector(".lib-detail-path")?.textContent ?? "").trim(),
			pathTitle: dialog.querySelector(".lib-detail-path")?.getAttribute("title") ?? "",
			meta: (dialog.querySelector(".lib-detail-meta")?.textContent ?? "").trim(),
			notes: [...dialog.querySelectorAll(".lib-detail-note")].map((node) => (node.textContent ?? "").trim()),
			badge: dialog.querySelector(".auto-badge-missed") !== null,
			buttons,
			// 初始焦点应在对话框容器（不是底部按钮），长详情不被滚到底。
			focusIsDialog: document.activeElement === dialog,
			// 详情内容是独立滚动区，动作条固定在底部。
			scrollTop: dialog.querySelector(".lib-detail-scroll")?.scrollTop ?? -1,
			hasFooter: dialog.querySelector(".lib-detail-footer") !== null,
		};
	});

// ── 前置：配置一个可用模型（「继续修改」的 newTask 走 applyWorkspace + 后续会话）──
await h.check("准备：配置一个可用模型与工作区", async () => {
	const r = await win.evaluate(async ({ ws }) => {
		const k = globalThis.kami;
		try {
			await k.saveCustomProvider(
				{
					id: "mock-library-gallery",
					name: "Mock Gallery",
					baseUrl: "http://127.0.0.1:9/v1",
					api: "openai-completions",
					authHeader: true,
					models: [{ id: "gallery-model", name: "gallery-model", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }],
				},
				"mock-key",
			);
			await k.setModel("mock-library-gallery/gallery-model");
			await k.setWorkspace(ws);
			return { ok: true };
		} catch (e) {
			return { ok: false, err: String(e?.message ?? e).slice(0, 300) };
		}
	}, { ws: WS_A });
	assert.ok(r.ok, `配置模型失败：${r.err}`);
});

// ══ ① 默认网格：三张卡、类型封面、元信息与来源会话 ═══════════════════
await h.check("① 默认是网格：三张卡都有类型封面、类型 / 大小 / 时间与来源会话", async () => {
	seedAll();
	await clickNav("资料库");
	await waitLibrary();
	await h.waitForSettled();
	const cards = await waitCards((list) => list.length === 3, "三个交付物各出一张卡");
	await h.shoot("gallery-grid-light");

	assert.equal(cards.length, 3, `应有 3 张卡，实际 ${cards.length}`);
	assert.ok(cards.every((card) => card.cover), "每张卡都应有第一方封面");
	const types = cards.map((card) => card.type).sort();
	assert.deepEqual(types, ["markdown", "sheet", "slide"], `类型判定不对：${JSON.stringify(types)}`);
	const md = cards.find((card) => card.name === "季度复盘.md");
	assert.ok(md !== undefined, "网格里应有「季度复盘.md」");
	assert.equal(md.typeLabel, "研究笔记", `封面的类型标签应是「研究笔记」：${JSON.stringify(md.typeLabel)}`);
	assert.equal(md.badge, "MD", `封面角标应是扩展名 MD：${JSON.stringify(md.badge)}`);
	assert.equal(md.shape, "lib-cover-portrait", `文档类封面应是竖版：${JSON.stringify(md.shape)}`);
	assert.equal(md.meta.includes("46 B"), false, `<1 KB 不显示大小：${JSON.stringify(md.meta)}`);
	assert.ok(md.source.startsWith("来源 · "), `来源行应有「来源 · 」前缀：${JSON.stringify(md.source)}`);
	assert.ok(md.source.includes("帮我写季度复盘"), `md 卡应标出来源会话：${JSON.stringify(md.source)}`);

	const csv = cards.find((card) => card.name === "销售数据.csv");
	assert.ok(csv !== undefined, "网格里应有「销售数据.csv」");
	assert.equal(csv.badge, "CSV");
	assert.equal(csv.shape, "lib-cover-bars", `表格封面应是柱状：${JSON.stringify(csv.shape)}`);
	assert.ok(csv.meta.includes("2.0 KB"), `≥1 KB 仍显示大小：${JSON.stringify(csv.meta)}`);

	const deck = cards.find((card) => card.name === "方案.pptx");
	assert.ok(deck !== undefined, "网格里应有「方案.pptx」");
	assert.equal(deck.badge, "PPTX");
	assert.equal(deck.shape, "lib-cover-landscape", `幻灯片封面应是横版：${JSON.stringify(deck.shape)}`);

	const summary = await win.evaluate(() => document.querySelector("main.settings .lib-summary")?.innerText ?? "");
	assert.ok(summary.includes("3 份交付物"), `摘要应显示交付物数：${JSON.stringify(summary)}`);
	assert.ok(summary.includes("来自 2 个会话"), `摘要应显示来源会话数：${JSON.stringify(summary)}`);
});

// ══ ② 筛选：类型 / 时间 / 搜索 / 来源四档可叠加，无结果给「清除筛选」 ═══
await h.check("② 类型筛选：点「表格」只剩销售数据", async () => {
	await clickTypeChip("表格");
	const cards = await waitCards((list) => list.length === 1 && list[0].name === "销售数据.csv", "只剩「销售数据.csv」");
	assert.equal(cards[0].type, "sheet");
	await clickTypeChip("全部");
	await waitCards((list) => list.length === 3, "类型回到全部后三张卡");
});

await h.check("②b 时间范围：最近 7 天只剩 md，最近 30 天多出 csv", async () => {
	await pickOption("时间范围筛选", "最近 7 天");
	const week = await waitCards((list) => list.length === 1 && list[0].name === "季度复盘.md", "7 天内只剩「季度复盘.md」");
	assert.equal(week.length, 1);
	await pickOption("时间范围筛选", "最近 30 天");
	const month = await waitCards((list) => list.length === 2, "30 天内剩 md + csv");
	assert.deepEqual(month.map((card) => card.name).sort(), ["季度复盘.md", "销售数据.csv"]);
	await pickOption("时间范围筛选", "全部时间");
	await waitCards((list) => list.length === 3, "时间回到全部后三张卡");
});

await h.check("②c 文件名搜索 + 来源会话筛选，并与类型是「与」关系", async () => {
	await setSearch("复盘");
	await waitCards((list) => list.length === 1 && list[0].name === "季度复盘.md", "搜索「复盘」只剩 md");
	await setSearch("");
	await waitCards((list) => list.length === 3, "清空搜索后三张卡");

	await pickOption("来源会话筛选", "做销售方案");
	await waitCards((list) => list.length === 1 && list[0].name === "方案.pptx", "来源 B 只剩 pptx");
	await clickTypeChip("表格");
	// 来源 B × 表格 = 空：两种空态必须可辨（这里是「筛选无结果」，不是「没有产物」）。
	const empty = await waitUntil(
		() =>
			win.evaluate(() => {
				const main = document.querySelector("main.settings");
				if (main === null) return null;
				const title = (main.querySelector(".state-empty-title")?.textContent ?? "").trim();
				if (title === "") return null;
				return {
					title,
					desc: (main.querySelector(".state-empty-desc")?.textContent ?? "").trim(),
					clear: [...main.querySelectorAll(".state-empty-action button")].some(
						(node) => (node.textContent ?? "").trim() === "清除筛选",
					),
				};
			}),
		{ timeout: 15_000, desc: "筛选无结果空态" },
	);
	await h.shoot("gallery-filtered-empty");
	assert.ok(empty.title.includes("没有符合条件的交付物"), `无结果空态标题不对：${JSON.stringify(empty.title)}`);
	assert.ok(empty.clear, "无结果空态应提供「清除筛选」");
	const cleared = await win.evaluate(() => {
		const btn = [...document.querySelectorAll("main.settings .state-empty-action button")].find(
			(node) => (node.textContent ?? "").trim() === "清除筛选",
		);
		if (btn === undefined) return false;
		btn.click();
		return true;
	});
	assert.ok(cleared, "点不到「清除筛选」");
	await waitCards((list) => list.length === 3, "清除筛选后回到三张卡");
});

// ══ ③ 网格 / 列表切换保留筛选与搜索 ══════════════════════════════════
await h.check("③ 切到列表仍保留搜索，切回网格仍在", async () => {
	await setSearch("复盘");
	await waitCards((list) => list.length === 1, "搜索后只剩一张卡");
	await clickView("列表");
	const rows = await waitUntil(
		() =>
			win.evaluate(() => {
				const nodes = [...document.querySelectorAll("main.settings .auto-row")];
				if (nodes.length !== 1) return null;
				return [(nodes[0].querySelector(".auto-row-name")?.textContent ?? "").trim()];
			}),
		{ timeout: 15_000, desc: "列表视图里只剩搜索命中的一行" },
	);
	assert.deepEqual(rows, ["季度复盘.md"], `切换视图后搜索应保留：${JSON.stringify(rows)}`);
	// 列表行本身可点开同一个详情；键盘 / 读屏走行尾的「详情」按钮（行不冒充按钮）。
	await win.evaluate(() => {
		const row = document.querySelector("main.settings .auto-row");
		if (row === null) throw new Error("列表视图里没有行");
		const detail = [...row.querySelectorAll(".auto-row-ops button")].find(
			(button) => (button.textContent ?? "").trim() === "详情",
		);
		if (detail === undefined) throw new Error("列表行缺少「详情」按钮");
		detail.focus();
	});
	await win.keyboard.press("Enter");
	await waitDetail("季度复盘.md");
	await win.evaluate(() => {
		const close = document.querySelector(".lib-detail .ex-modal-close");
		if (close === null) throw new Error("详情没有关闭按钮");
		close.click();
	});
	await waitUntil(
		() => win.evaluate(() => (document.querySelector(".lib-detail") === null ? true : null)),
		{ timeout: 10_000, desc: "关闭详情回到列表" },
	);
	await clickView("网格");
	await waitCards((list) => list.length === 1, "切回网格仍是同样一张");
	await setSearch("");
	await waitCards((list) => list.length === 3, "清空搜索后三张卡");
});

// ══ ④ 详情：封面 / 完整路径 / 元信息 / 来源会话 / 初始焦点 ═══════════════
await h.check("④ 打开详情：焦点在容器、路径与元信息可读、动作齐全", async () => {
	await clickCard("季度复盘.md");
	await waitDetail("季度复盘.md");
	// 版本历史懒加载完成前，先把画面等稳（这是详情打开后的异步读取）。
	await waitUntil(
		() =>
			win.evaluate(() => {
				const dialog = document.querySelector(".lib-detail");
				if (dialog === null) return null;
				const notes = [...dialog.querySelectorAll(".lib-detail-note")].map((n) => (n.textContent ?? "").trim());
				const btn = [...dialog.querySelectorAll("button")].find((n) => (n.textContent ?? "").trim() === "查看版本历史");
				// 有版本：按钮可用且详情不出现任何说明行；没版本 / 读失败：说明行不再停在「正在读取」。
				const settled = notes.some((text) => !text.includes("正在读取版本历史"));
				return btn !== undefined && (btn.disabled === false || settled) ? true : null;
			}),
		{ timeout: 15_000, desc: "版本历史读取完成" },
	);
	await h.waitForSettled();
	await waitAnimations(".ex-modal-mask");
	await h.shoot("gallery-detail-light");
	const detail = await readDetail();
	assert.ok(detail !== null, "详情没有打开");
	assert.ok(detail.focusIsDialog, "初始焦点应在对话框容器上（不在底部按钮）");
	assert.equal(detail.scrollTop, 0, "详情应从顶部读起（初始焦点不得把弹窗滚到底）");
	assert.ok(detail.hasFooter, "详情应有固定在底部的动作条");
	assert.equal(detail.path, "wsA / 季度复盘.md", `详情副标题应是「工作区名 / 相对路径」：${JSON.stringify(detail.path)}`);
	assert.equal(detail.pathTitle, MD_PATH, `完整路径应保留在 title 里：${JSON.stringify(detail.pathTitle)}`);
	assert.equal(detail.path.includes(WS_A), false, "副标题里不应出现绝对路径");
	assert.ok(detail.meta.includes("研究笔记"), `详情元信息应含类型：${JSON.stringify(detail.meta)}`);
	assert.ok(detail.meta.includes("46 B"), `详情元信息应含大小：${JSON.stringify(detail.meta)}`);
	const labels = detail.buttons.map((b) => b.text);
	for (const label of ["继续修改", "预览", "在文件夹中显示", "复制路径", "查看版本历史"]) {
		assert.ok(labels.includes(label), `详情缺少动作「${label}」：${JSON.stringify(labels)}`);
	}
	const history = detail.buttons.find((b) => b.text === "查看版本历史");
	assert.equal(history.disabled, false, "这个文件有版本，历史按钮应可用");
	const continueBtn = detail.buttons.find((b) => b.text === "继续修改");
	assert.equal(continueBtn.disabled, false, "产物在来源 cwd 内，继续修改应可用");
});

// ══ ⑤ 版本历史：跳到文件历史，并选中这个文件 ════════════════════════
await h.check("⑤ 点「查看版本历史」→ 文件历史页选中「季度复盘.md」", async () => {
	const history = await clickDetailButton("查看版本历史");
	assert.ok(history.found, "详情里找不到「查看版本历史」");
	assert.equal(history.disabled, false);
	await waitUntil(
		() =>
			win.evaluate(() => {
				const title = document.querySelector("main.settings h1")?.textContent;
				const selected = document.querySelector(".fh-file-row.selected .fh-file-name")?.textContent?.trim();
				return title === "文件历史" ? { selected } : null;
			}),
		{ timeout: 15_000, desc: "进入文件历史并出现选中行" },
	);
	const selected = await waitUntil(
		() =>
			win.evaluate(() => {
				const name = document.querySelector(".fh-file-row.selected .fh-file-name")?.textContent?.trim();
				return name === "季度复盘.md" ? name : null;
			}),
		{ timeout: 15_000, desc: "文件历史选中「季度复盘.md」" },
	);
	assert.equal(selected, "季度复盘.md");
	await h.shoot("gallery-file-history-selected");
});

// ══ ⑥ 继续修改：在来源 cwd 开新会话，预填提示包含文件路径 ══════════════
await h.check("⑥ 继续修改：新会话 cwd = 来源 cwd，输入框预填提示", async () => {
	await clickNav("资料库");
	await waitLibrary();
	await waitCards((list) => list.length === 3, "回到网格");
	await clickCard("季度复盘.md");
	await waitDetail("季度复盘.md");
	const btn = await clickDetailButton("继续修改");
	assert.ok(btn.found, "详情里找不到「继续修改」");
	assert.equal(btn.disabled, false, "「继续修改」不应被禁用");
	await waitUntil(
		() => win.evaluate(() => document.querySelector('[aria-label="消息输入框"]') !== null),
		{ timeout: 20_000, desc: "切到对话视图（输入框出现）" },
	);
	const prefill = await waitUntil(
		() =>
			win.evaluate(() => {
				const input = document.querySelector('[aria-label="消息输入框"]');
				if (input === null) return null;
				const value = typeof input.value === "string" ? input.value : "";
				return value.includes("继续完善这份交付物：季度复盘.md") ? value : null;
			}),
		{ timeout: 20_000, desc: "输入框预填了含相对路径的提示" },
	);
	assert.ok(prefill.includes("先读这个文件"), `预填提示缺少「先读这个文件」：${JSON.stringify(prefill.slice(0, 120))}`);
	assert.ok(prefill.includes("不要移动文件位置"), "预填提示应写明不要移动文件位置");
	assert.equal(prefill.includes(WS_A), false, "预填提示里不应出现绝对路径（应使用来源工作区内的相对路径）");
	const cwd = await waitUntil(
		async () => {
			const value = await win.evaluate(async () => {
				const conversation = await window.kami.snapshot();
				return conversation?.state?.cwd ?? null;
			});
			return value === WS_A ? value : null;
		},
		{ timeout: 20_000, desc: `新会话 cwd 应为来源 cwd（${WS_A}）` },
	);
	assert.equal(cwd, WS_A);
	await h.shoot("gallery-continue-chat");
});

// ══ ⑦ 失效文件：卡片标记、详情禁用动作并说明原因 ═══════════════════════
await h.check("⑦ 文件已不在：卡片与详情都标出来，预览 / 继续修改禁用并说明", async () => {
	rmSync(DECK_PATH, { force: true });
	await clickNav("资料库");
	await waitLibrary();
	await win.evaluate(() => {
		const btn = document.querySelector('main.settings .settings-head [aria-label="刷新"]');
		if (btn === null) throw new Error("资料库找不到「刷新」");
		btn.click();
	});
	const cards = await waitCards(
		(list) => list.some((card) => card.name === "方案.pptx" && card.missed),
		"「方案.pptx」被标为失效",
	);
	const deck = cards.find((card) => card.name === "方案.pptx");
	assert.ok(deck !== undefined, "失效产物不应从网格消失");
	assert.ok(deck.missed, "失效卡应带 .lib-card-missed");
	// 失效只降封面：文件名与 meta 保持可读（不是整卡变淡）。
	const dim = await win.evaluate(() => {
		const card = [...document.querySelectorAll("main.settings .lib-card")].find(
			(node) => (node.querySelector(".lib-card-name")?.textContent ?? "").trim() === "方案.pptx",
		);
		if (card === undefined) return null;
		return {
			coverFilter: getComputedStyle(card.querySelector(".lib-cover")).filter,
			nameOpacity: getComputedStyle(card.querySelector(".lib-card-name")).opacity,
			borderLeft: getComputedStyle(card).borderLeftWidth,
		};
	});
	assert.ok(dim !== null, "找不到失效卡片");
	assert.match(dim.coverFilter, /grayscale/, `失效封面应变灰：${JSON.stringify(dim.coverFilter)}`);
	assert.equal(dim.nameOpacity, "1", "失效卡的文件名不应整体变淡");
	assert.equal(dim.borderLeft, "3px", `失效卡应有 3px 左侧标记：${JSON.stringify(dim.borderLeft)}`);

	await clickCard("方案.pptx");
	await waitDetail("方案.pptx");
	await waitUntil(
		() =>
			win.evaluate(() => {
				const notes = [...document.querySelectorAll(".lib-detail .lib-detail-note")].map((n) => (n.textContent ?? "").trim());
				return notes.some((text) => !text.includes("正在读取版本历史")) ? true : null;
			}),
		{ timeout: 15_000, desc: "pptx 详情的版本历史读取完成" },
	);
	const detail = await readDetail();
	assert.ok(detail.badge, "详情应标出「文件已不在」");
	const byText = (text) => detail.buttons.find((b) => b.text === text);
	assert.equal(byText("回到来源会话重新生成")?.disabled, false, "失效文件的主按钮应是「回到来源会话重新生成」且可用");
	assert.equal(byText("继续修改")?.disabled, true, "失效文件的「继续修改」应禁用");
	assert.equal(byText("预览")?.disabled, true, "失效文件的「预览」应禁用");
	assert.equal(byText("查看版本历史")?.disabled, true, "没有留下版本时历史按钮应禁用");
	assert.ok(
		detail.notes.some((text) => text === "文件已不在磁盘上，无法预览或继续修改。"),
		`失效说明应合并成一句：${JSON.stringify(detail.notes)}`,
	);
	assert.ok(
		detail.notes.some((text) => text.includes("当 Agent 修改过这份文件之后")),
		`没有版本时应说明版本记录何时出现：${JSON.stringify(detail.notes)}`,
	);
	await waitAnimations(".ex-modal-mask");
	await h.shoot("gallery-detail-missing");
});

// ══ ⑧ 窄窗：类型 chip 行收成同高下拉（筛选能力不丢） ═══════════════════
await h.check("⑧ 窄窗：类型 chip 行隐藏，出现同高的「类型」下拉", async () => {
	// 先关掉 ⑦ 打开的详情，窄窗截图才看得见筛选行。
	await win.evaluate(() => {
		const close = document.querySelector(".lib-detail .ex-modal-close");
		if (close !== null) close.click();
	});
	await waitUntil(
		() => win.evaluate(() => (document.querySelector(".lib-detail") === null ? true : null)),
		{ timeout: 10_000, desc: "关闭详情" },
	);
	const before = await win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
	const actual = await resizeWindow(860, before.height);
	try {
		if (actual.width > 900) {
			// CI 的物理屏可能把窗口钳制在 900 以上 —— 这不是产品缺陷，这一档没验到。
			h.skip("⑧ 窄窗：类型 chip 行隐藏，出现同高的「类型」下拉", `窗口被钳制到 ${actual.width}px，> 900px 断点`);
		}
		const state = await win.evaluate(() => {
			const chips = document.querySelector("main.settings .lib-type-chips");
			const select = document.querySelector("main.settings .lib-type-select");
			return {
				chips: chips === null ? "missing" : getComputedStyle(chips).display,
				select: select === null ? "missing" : getComputedStyle(select).display,
			};
		});
		assert.equal(state.chips, "none", `窄窗下应隐藏类型 chip 行：${JSON.stringify(state.chips)}`);
		assert.notEqual(state.select, "none", `窄窗下应显示「类型」下拉：${JSON.stringify(state.select)}`);
		assert.notEqual(state.select, "missing", "找不到窄窗的「类型」下拉容器");
		await h.waitForSettled();
		await h.shoot("gallery-narrow");
	} finally {
		await resizeWindow(before.width, before.height);
	}
});

// ══ ⑨ 深色主题 ═══════════════════════════════════════════════════════
await h.check("⑨ 深色主题下画廊与详情仍正常渲染（截图 + 像素断言）", async () => {
	// 重新打开失效产物的详情，用来验暗色下「灰掉的封面 + 固定动作条」。
	await clickCard("方案.pptx");
	await waitDetail("方案.pptx");
	await waitAnimations(".ex-modal-mask");
	await win.evaluate(() => {
		void window.kami?.setThemePreference?.("dark");
		document.documentElement.setAttribute("data-theme", "dark");
	});
	await waitUntil(() => win.evaluate(() => document.documentElement.dataset.theme === "dark"), {
		timeout: 10_000,
		desc: "data-theme 切到 dark",
	});
	await h.waitForSettled();
	await waitAnimations(".ex-modal-mask");
	const detail = await h.shoot("gallery-detail-dark");
	assert.ok(detail.stats.stdDev > 3, `深色详情截图不像渲染出来的界面（stdDev=${detail.stats.stdDev.toFixed(2)}）`);

	// 关掉详情，对网格再拍一张（暗色下封面底与分类色都应该跟随）。
	await win.evaluate(() => {
		const close = document.querySelector(".lib-detail .ex-modal-close");
		if (close !== null) close.click();
	});
	const grid = await waitUntil(
		async () => {
			const cards = await readCards();
			return cards !== null && cards.length === 3 ? cards : null;
		},
		{ timeout: 15_000, desc: "回到网格（暗色）" },
	);
	assert.equal(grid.length, 3);
	await h.waitForSettled();
	const shot = await h.shoot("gallery-grid-dark");
	assert.ok(shot.stats.stdDev > 3, `深色画廊截图不像渲染出来的界面（stdDev=${shot.stats.stdDev.toFixed(2)}）`);

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

await h.check("无渲染层未捕获异常", () => assert.equal(h.pageErrors.length, 0, h.pageErrors.join("; ")));

await h.finish();
