/**
 * 变更审阅台的 GUI 端到端测试（任务 10-21-review-desk）。
 *
 * 数据面（已阅判定的版本 id 语义 / 排序计数 / 读当前文件的四条边界）已有单测
 * （`tests/unit/review.test.mjs`），页面纯逻辑（筛选 / 并排配对 / 边界措辞）也有单测
 * （`tests/unit/review-core.test.mjs`）。**本文件补的是只有真实启动 Electron 才暴露
 * 的那层**：种子版本存储 → 侧栏真的出现角标 → 页面真的画出变更卡与并排 diff →
 * 标记已阅真的写进 `review-state.json` → **真实重启后仍是已阅** → 文件再被改一次
 * 自动回到待审阅 → 还原真的把**磁盘字节**退回去。
 *
 * ## 种子为什么直接写版本存储，而不跑一轮 Agent
 *
 * 这一页读的是 `<config>/versions/<key>/meta.json` + `<id>.txt`（version-store.js 的
 * 布局）。直接按同一份布局落种子，能把「时间、来源、增删行数」全部钉死，不为
 * 「模型这一轮到底写了几行」留运气成分。真实写入路径的记录判据由 file-history.mjs
 * 与 version-store 的单测覆盖。
 *
 * ## 「标记已阅」与「还原」都验证到副作用
 *
 * 已阅看 `review-state.json` 里的 versionId（不看 toast）；还原则**直接读磁盘字节**，
 * 与版本文本逐字节比较（`.trellis/spec/testing/index.md` 第 5 条）。
 *
 * ## 等待
 *
 * 所有 `waitUntil` 的谓词都能返回假值（拿不到就返回 null）—— 不写恒真的对象字面量。
 * 页面加载 / 标记 / 刷新都是空闲态，可以用 `waitForSettled()`。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const FILE_NAME = "周报.md";
const SESSION_ID = "sess-review-desk-e2e";

const V1 = "# 周报\n\n第一版：REVIEW_BEFORE\n第二行：未改动\n第三行：未改动\n";
const V2 = "# 周报\n\n第二版：REVIEW_AFTER\n第二行：未改动\n新增：REVIEW_ADDED\n";
const V3 = "# 周报\n\n第三版：REVIEW_LATEST\n第二行：未改动\n新增：REVIEW_ADDED\n再新增：REVIEW_NEWER\n";

const h = createHarness({ name: "review-desk" });
mkdirSync(h.WORKSPACE_DIR, { recursive: true });
const WORKSPACE_FILE = join(h.WORKSPACE_DIR, FILE_NAME);
const VERSIONS_ROOT = join(h.CONFIG_DIR, "versions");
/** 与 version-store.js 的 versionKeyOf 同一算法：sha1(绝对路径) 前 16 位 hex。 */
const FILE_KEY = createHash("sha1").update(WORKSPACE_FILE).digest("hex").slice(0, 16);
const FILE_VERSIONS_DIR = join(VERSIONS_ROOT, FILE_KEY);
const STATE_FILE = join(h.CONFIG_DIR, "review-state.json");

const BASE_AT = Date.now() - 5 * 60 * 1000;
const T1 = BASE_AT;
const T2 = BASE_AT + 60 * 1000;

/** 按 version-store 的 meta 布局落一条版本（`versions` 旧→新）。 */
function seedVersion(id, at, content, extra = {}) {
	mkdirSync(FILE_VERSIONS_DIR, { recursive: true });
	writeFileSync(join(FILE_VERSIONS_DIR, `${id}.txt`), content, "utf8");
	return {
		id,
		at,
		size: Buffer.byteLength(content, "utf8"),
		sessionId: SESSION_ID,
		tool: "write",
		...extra
	};
}

function writeMeta(versions) {
	writeFileSync(
		join(FILE_VERSIONS_DIR, "meta.json"),
		`${JSON.stringify({ path: WORKSPACE_FILE, skipped: 0, versions }, null, 2)}\n`,
		"utf8"
	);
}

function readState() {
	try {
		return JSON.parse(readFileSync(STATE_FILE, "utf8"));
	} catch {
		return undefined;
	}
}

function readDisk() {
	try {
		return readFileSync(WORKSPACE_FILE, "utf8");
	} catch {
		return undefined;
	}
}

// 种子：V1 是「改前」（版本存储），V2 是当前磁盘内容。
writeFileSync(WORKSPACE_FILE, V2, "utf8");
writeMeta([seedVersion("v1", T1, V1, { added: 2, removed: 1 })]);

await h.launch();
let win = h.window();

/** 侧栏里「变更审阅」那一项（文本会带角标，所以按 aria-label 前缀找）。 */
/*
 * 入口：侧栏「文件历史」→ 页头「变更审阅」。
 *
 * 为什么不单开侧栏项：600px 高的窗口里侧栏本来就紧，多一行 nav 会把任务行的
 * ⋯ 菜单推出可视区（tests/e2e/session-pin.mjs ⑬ 会当场变红）。待审阅数做成
 * 「文件历史」nav 项的角标，入口放在同一份数据的另一页页头 —— 既不增加高度，
 * 也没丢发现性。
 */
async function clickReviewNav() {
	const opened = await win.evaluate(() => {
		const nav = [...document.querySelectorAll(".sidebar-nav button")].find((b) =>
			(b.getAttribute("aria-label") ?? "").startsWith("文件历史")
		);
		if (nav === undefined || nav.disabled) return false;
		nav.click();
		return true;
	});
	assert.ok(opened, "侧栏找不到可点的「文件历史」导航项");
	await waitUntil(
		async () =>
			win.evaluate(() => {
				const btn = [...document.querySelectorAll("main.settings .settings-head button")].find((b) =>
					(b.textContent ?? "").trim().startsWith("变更审阅")
				);
				if (btn === undefined) return false;
				btn.click();
				return true;
			}),
		{ timeout: 15_000, desc: "文件历史页头出现「变更审阅」入口" },
	);
}

function readView() {
	return win.evaluate(() => {
		/*
		 * 侧栏角标与导航项在**任何视图**下都要读得到（启动后首页不是 main.settings，
		 * 早期版本把这段放在 early-return 之后，于是「启动后角标 = 1」永远读成
		 * undefined —— 不是功能没生效，是断言读错了地方）。
		 */
		const navButton = [...document.querySelectorAll(".sidebar-nav button")].find((b) =>
			(b.getAttribute("aria-label") ?? "").startsWith("文件历史")
		);
		const badge = (document.querySelector(".sidebar-nav .nav-badge")?.textContent ?? "").trim();
		const navLabel = (navButton?.textContent ?? "").trim();
		const main = document.querySelector("main.settings");
		if (main === null) return { present: false, badge, navLabel };
		const rows = [...main.querySelectorAll("[data-review-desk] .rv-row")].map((row) => ({
			name: (row.querySelector(".rv-row-name")?.textContent ?? "").trim(),
			dir: (row.querySelector(".rv-row-dir")?.textContent ?? "").trim(),
			meta: (row.querySelector(".rv-row-meta")?.textContent ?? "").trim(),
			stats: (row.querySelector(".rv-row-stats")?.textContent ?? "").trim(),
			state: (row.querySelector(".rv-state")?.textContent ?? "").trim(),
			selected: row.classList.contains("selected")
		}));
		const card = main.querySelector("[data-review-card]");
		return {
			present: true,
			title: (main.querySelector("h1")?.textContent ?? "").trim(),
			empty: main.querySelector(".state-empty") !== null,
			emptyTitle: (main.querySelector(".state-empty .state-empty-title")?.textContent ?? "").trim(),
			loading: main.querySelector(".state-loading") !== null,
			error: main.querySelector(".state-error") !== null,
			counts: (main.querySelector("[data-review-counts]")?.textContent ?? "").trim(),
			rows,
			card: card === null
				? null
				: {
						name: (card.querySelector(".fh-card-name")?.textContent ?? "").trim(),
						meta: (card.querySelector(".fh-card-meta")?.textContent ?? "").trim(),
						state: (card.querySelector(".rv-state")?.textContent ?? "").trim(),
						note: (card.querySelector(".fh-card-note")?.textContent ?? "").trim(),
						actions: [...card.querySelectorAll(".rv-actions button")].map((b) => (b.textContent ?? "").trim()),
						boundary: (card.querySelector(".rv-boundary-text")?.textContent ?? "").trim(),
						confirm: (card.querySelector(".fh-confirm-text")?.textContent ?? "").trim(),
						hasConfirm: card.querySelector(".fh-confirm") !== null
					},
			diffHeads: [...main.querySelectorAll(".rv-diff-head span")].map((s) => (s.textContent ?? "").trim()),
			cells: [...main.querySelectorAll(".rv-diff-cell")].map((cell) => ({
				text: (cell.textContent ?? "").trim(),
				add: cell.classList.contains("diff-add"),
				del: cell.classList.contains("diff-del"),
				empty: cell.classList.contains("is-empty")
			})),
			badge,
			navLabel,
			toasts: [...document.querySelectorAll(".toast-text")].map((t) => (t.textContent ?? "").trim())
		};
	});
}

/**
 * 轮询直到 readView() 满足谓词（拿不到就返回 null —— 谓词必须能返回假值）。
 * 超时时把**最后一次读到的现场**带进错误信息，否则只有一句「等待超时」。
 */
const waitView = async (pred, desc, timeout = 20_000) => {
	let last;
	try {
		return await waitUntil(async () => {
			last = await readView();
			return pred(last) ? last : null;
		}, { timeout, desc });
	} catch (error) {
		throw new Error(`${desc} —— 最后读到的状态：${JSON.stringify(last).slice(0, 600)}`, { cause: error });
	}
};

/** 点内容卡里的动作按钮（按钮文字完全匹配）。 */
async function clickAction(label) {
	const ok = await win.evaluate((text) => {
		const card = document.querySelector("[data-review-card]");
		const btn = card === null ? undefined : [...card.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === text);
		if (btn === undefined || btn.disabled) return false;
		btn.click();
		return true;
	}, label);
	assert.ok(ok, `找不到可点的「${label}」`);
}

async function clickHeaderRefresh() {
	const ok = await win.evaluate(() => {
		const btn = [...document.querySelectorAll("main.settings .settings-head button")].find((b) =>
			(b.getAttribute("title") ?? "").includes("重新拉取变更清单")
		);
		if (btn === undefined) return false;
		btn.click();
		return true;
	});
	assert.ok(ok, "页头找不到「刷新」按钮");
}

async function clickFilter(label) {
	const ok = await win.evaluate((text) => {
		const btn = [...document.querySelectorAll("main.settings .rv-filter-btn")].find((b) => (b.textContent ?? "").trim() === text);
		if (btn === undefined) return false;
		btn.click();
		return true;
	}, label);
	assert.ok(ok, `找不到筛选按钮「${label}」`);
}

// ══ ① 启动后侧栏就有角标 ══════════════════════════════════════════
await h.check("① 启动后侧栏「文件历史」带待审阅角标 1（入口在页头）", async () => {
	const state = await waitUntil(async () => {
		const s = await readView();
		return s.badge === "1" ? s : null;
	}, { timeout: 20_000, desc: "侧栏角标显示 1" });
	assert.match(state.navLabel, /^文件历史/, `导航项文字应是「文件历史」，实际 ${JSON.stringify(state.navLabel)}`);
});

// ══ ② 变更卡 + 并排 diff ═════════════════════════════════════════
await h.check("② 页头计数、变更卡与并排对照都正确", async () => {
	await clickReviewNav();
	await waitView((s) => s.present && s.title === "变更审阅" && s.rows.length === 1 && s.cells.length > 0, "审阅页挂上并画出变更与 diff");
	await h.waitForSettled();
	await h.shoot("review-desk-diff-light");

	const s = await readView();
	assert.equal(s.title, "变更审阅", "页头标题不对");
	assert.equal(s.empty, false, "有变更时不该是空态");
	assert.equal(s.error, false, "不该是错误态");
	assert.equal(s.counts, "待审阅 1 · 已审阅 0", `页头计数不对：${JSON.stringify(s.counts)}`);

	const row = s.rows[0];
	assert.equal(row.name, FILE_NAME, "变更卡的文件名不对");
	assert.equal(row.stats, "+2 −1", `变更卡应显示种子里的增删行数：${JSON.stringify(row.stats)}`);
	assert.equal(row.state, "待审阅", "状态要有文字标签，不能只靠颜色");
	assert.ok(row.selected, "默认应选中第一条变更");
	assert.ok(row.dir.length > 0, "变更卡应显示目录");
	assert.match(row.meta, /分钟前|刚刚/, `第三行应是相对时间：${JSON.stringify(row.meta)}`);

	assert.ok(s.card !== null, "应渲染内容卡");
	assert.equal(s.card.name, FILE_NAME, "内容卡的标题不对");
	assert.match(s.card.meta, /写入/, `内容卡应写出来源工具（用户话术，不是 write）：${JSON.stringify(s.card.meta)}`);
	assert.match(s.card.meta, /\+2 −1/, `增删行数应并进 meta 行：${JSON.stringify(s.card.meta)}`);
	assert.ok(s.card.actions.includes("标记为已审阅"), "待审阅的变更应有「标记为已审阅」");
	assert.ok(!s.card.actions.includes("标为待审阅"), "待审阅时不该出现撤销入口");
	assert.ok(s.card.actions.includes("还原到改前"), "应有「还原到改前」");
	assert.ok(s.card.actions.includes("回到那次会话"), "有 sessionId 时应有「回到那次会话」");

	// 并排对照：左「改前」右「现在」。
	assert.deepEqual(s.diffHeads, ["改前", "现在"], `并排列头不对：${JSON.stringify(s.diffHeads)}`);
	// 单个、从第 1 行起的 hunk 不显示 git 坐标头（P0-2）：整份文件就是 diff。
	assert.equal(
		await win.evaluate(() => document.querySelectorAll(".rv-diff-hunk").length),
		0,
		"单段且从第 1 行起的 diff 不该出现 @@ 区头"
	);
	const beforeCell = s.cells.find((c) => c.text.includes("REVIEW_BEFORE"));
	assert.ok(beforeCell !== undefined, `左侧应出现改前内容：${JSON.stringify(s.cells.map((c) => c.text))}`);
	assert.equal(beforeCell.del, true, "改前的旧行应标为删除行（diff-del）");
	const afterCell = s.cells.find((c) => c.text.includes("REVIEW_AFTER"));
	assert.ok(afterCell !== undefined, "右侧应出现现在的内容");
	assert.equal(afterCell.add, true, "现在的新行应标为新增行（diff-add）");
	assert.ok(
		s.cells.some((c) => c.add && c.text.includes("REVIEW_ADDED")),
		"多出来的增行也应在右侧"
	);
	assert.ok(
		!s.cells.some((c) => c.text.includes("REVIEW_AFTER") && c.del),
		"「现在」的内容不应出现在删除侧"
	);
});

// ══ ③ 标记已审阅：状态、计数、角标、状态文件、toast、撤销入口 ═════
await h.check("③ 标记为已审阅后就地更新（计数 -1、角标消失、toast 带文件名、可撤销）", async () => {
	await clickAction("标记为已审阅");
	const s = await waitView(
		(state) => state.counts === "待审阅 0 · 已审阅 1" && state.rows[0]?.state === "已审阅" && state.badge === "",
		"标记后计数归零、行状态变已审阅、角标消失"
	);
	assert.equal(s.rows[0].state, "已审阅");
	assert.equal(s.card.state, "已审阅");
	assert.ok(!s.card.actions.includes("标记为已审阅"), "已审阅之后不应再显示「标记为已审阅」");
	assert.ok(s.card.actions.includes("标为待审阅"), "已审阅之后必须有回退入口「标为待审阅」（P0-3）");
	assert.ok(
		s.toasts.includes(`已标记「${FILE_NAME}」为已审阅`),
		`toast 应带文件名：${JSON.stringify(s.toasts)}`
	);
	await h.shoot("review-desk-reviewed-light");

	const state = readState();
	assert.ok(state !== undefined, "review-state.json 应已写入");
	assert.equal(state.files?.[FILE_KEY]?.versionId, "v1", `已阅标记应记下版本 id：${JSON.stringify(state)}`);
});

// ══ ④ 筛选：待审阅筛空要说清「都处理完了」 ═════════════════════════
await h.check("④ 切到「只看待审阅」时是筛选空态，不是「一条变更都没有」", async () => {
	await clickFilter("只看待审阅");
	const s = await waitView((state) => state.empty === true, "待审阅筛选后出现空态");
	await h.shoot("review-desk-pending-empty-light");
	assert.equal(s.emptyTitle, "待审阅的都处理完了", `空态标题不对：${JSON.stringify(s.emptyTitle)}`);
	assert.equal(s.rows.length, 0, "待审阅筛选下不该还有行");
	await clickFilter("全部");
	const back = await waitView((state) => state.rows.length === 1, "切回全部后变更卡回来");
	assert.equal(back.rows[0].state, "已审阅");
});

// ══ ⑤ 撤销已阅 → 回到待审阅（再标记一次供后面的重启验证）═══════════
await h.check("⑤ 「标为待审阅」撤销已阅：计数回到待审阅 1、状态文件清掉该键、角标回来", async () => {
	await clickAction("标为待审阅");
	const s = await waitView(
		(state) => state.counts === "待审阅 1 · 已审阅 0" && state.rows[0]?.state === "待审阅" && state.badge === "1",
		"撤销后回到待审阅、角标回来"
	);
	assert.equal(s.card.state, "待审阅");
	const state = readState();
	assert.notEqual(state?.files?.[FILE_KEY]?.versionId, "v1", `撤销后不该还留着已阅标记：${JSON.stringify(state)}`);

	// 再标记一次：下一条用例要验证「重启后仍是已审阅」。
	await clickAction("标记为已审阅");
	await waitView(
		(state) => state.counts === "待审阅 0 · 已审阅 1" && state.rows[0]?.state === "已审阅",
		"重新标记成功"
	);
});

// ══ ⑥ 真实重启后仍是已审阅 ═══════════════════════════════════════
await h.check("⑥ 真实重启后仍为已审阅（状态从 review-state.json 读回）", async () => {
	await h.app().close();
	await h.launch();
	win = h.window();
	await clickReviewNav();
	const s = await waitView(
		(state) => state.present && state.title === "变更审阅" && state.rows.length === 1 && state.rows[0].state === "已审阅",
		"重启后变更仍为已审阅",
		30_000
	);
	assert.equal(s.counts, "待审阅 0 · 已审阅 1", "重启后的计数不对");
	assert.equal(s.badge, "", "待审阅为 0 时侧栏不该有角标");
});

// ══ ⑦ 文件再被改一次 → 自动回到待审阅 ═══════════════════════════
await h.check("⑦ 文件又有了新改动（新版本）→ 自动回到待审阅，并给出新的对照", async () => {
	// 先落「改前 = V2」这一版，再把磁盘写成 V3 —— 与 version-store 的语义一致。
	writeMeta([
		seedVersion("v1", T1, V1, { added: 2, removed: 1 }),
		seedVersion("v2", T2, V2, { added: 1, removed: 0 })
	]);
	writeFileSync(WORKSPACE_FILE, V3, "utf8");

	await clickHeaderRefresh();
	/*
	 * 谓词必须把**两侧**都钉住，不能只等「新增侧出现 REVIEW_LATEST」：
	 * CI 上撞到过一份「旧版本 id + 新磁盘内容」的瞬时对照 —— 改前那一侧是更早的
	 * V1，新增侧却有 REVIEW_LATEST，弱谓词会当场放行，随后断言才红。
	 * daemon 现在对这种情况返回 stale，根本不会画出假对照；这条谓词是第二道。
	 */
	const s = await waitView(
		(state) =>
			state.counts === "待审阅 1 · 已审阅 0" &&
			state.rows[0]?.state === "待审阅" &&
			state.cells.some((c) => c.add && c.text.includes("REVIEW_LATEST")) &&
			state.cells.some((c) => c.del && c.text.includes("REVIEW_AFTER")),
		"刷新后回到待审阅，并画出以 V2 为改前的新对照"
	);
	assert.equal(s.rows[0].stats, "+1 −0", `新变更的增删行数应来自 v2：${JSON.stringify(s.rows[0].stats)}`);
	assert.equal(s.badge, "1", "角标应重新出现");
	assert.ok(
		s.cells.some((c) => c.del && c.text.includes("REVIEW_AFTER")),
		"新的对照应以 V2 为改前（REVIEW_AFTER 在删除侧）"
	);
	assert.ok(
		s.cells.some((c) => c.add && c.text.includes("REVIEW_LATEST")),
		"新的对照应以 V3 为现在（REVIEW_LATEST 在新增侧）"
	);
});

// ══ ⑧ 还原：二次确认 + Esc 取消 + 磁盘字节真的退回 ═══════════════
await h.check("⑧ 还原到改前：先二次确认，Esc 取消不落盘，确认后磁盘字节退回 V2", async () => {
	await clickAction("还原到改前");
	const confirm = await waitView((state) => state.card?.hasConfirm === true, "出现就地确认条");
	assert.match(confirm.card.confirm, /还原到/, `确认句要说清要做什么：${JSON.stringify(confirm.card.confirm)}`);

	// Esc 取消：确认条消失，磁盘不动。
	await win.keyboard.press("Escape");
	await waitView((state) => state.card?.hasConfirm === false, "Esc 取消确认条");
	assert.equal(readDisk(), V3, "取消之后磁盘内容不该变");

	// 再确认一次，这次真的还原。
	await clickAction("还原到改前");
	await waitView((state) => state.card?.hasConfirm === true, "再次出现确认条");
	await clickAction("确认还原");
	const disk = await waitUntil(() => {
		const text = readDisk();
		return text === V2 ? text : null;
	}, { timeout: 20_000, desc: "磁盘字节退回 V2（改前）" });
	assert.equal(disk, V2, "还原后的磁盘内容应与版本存储里的 V2 逐字节一致");
});

await h.finish();
