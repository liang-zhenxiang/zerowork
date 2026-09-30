/**
 * 首次运行引导（onboarding）端到端测试。
 *
 * 覆盖三件事，每一件都对应一处真实缺陷：
 *
 *   ① **案例卡要带上它绑定的专家**。`cases.json` 里 12 个案例 12 个都有 `expert`，
 *      但点击只填提示词、从来不动专家 —— 数据的设计意图被丢在路上。
 *      断言用 `cases.json` 的**真实数据**驱动：写死某个专家名的话，数据一变测试还绿。
 *   ② **首页三步清单**（工作空间 / 可用模型 / 第一条消息）。此前唯一的「下一步」
 *      指引只覆盖三项里的「有模型」，且做完就整块消失 —— 用户照它配好模型回来，
 *      清单没了、案例卡看起来能点了，但还没有工作空间，点了也发不出去。
 *   ③ **侧栏 4 个「敬请期待」是真禁用态**，不是「灰一点但摸起来还是按钮」。
 *
 * 用 mock 模型服务（`./mock-model-server.mjs`，同 model-roundtrip）：
 * 「发出第一条消息」这一项的判据是**存在会话文件**，只有真跑一轮才有；
 * 用假状态糊过去等于没测。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHarness, waitUntil, ROOT } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

/** 断言的事实来源是案例数据本身。 */
const CASES = JSON.parse(readFileSync(resolve(ROOT, "resources/welcome/cases.json"), "utf8"));

const mock = await startMockModelServer({ reply: "ONBOARDING_OK" });
const h = createHarness({ name: "onboarding" });
await h.launch();
const win = h.window();

// ── 读回界面的小工具 ─────────────────────────────────
//
// 「做完了没」的界面证据有两条，都取自 DOM 而不是内部状态：
//   - `actionCount`：每行只在**未完成**时渲染那个可点的去处按钮；
//   - `markShapes`：图标形态。三项各有一个语义图标（工作空间 / 钥匙 / 发送），
//     完成态一律换成对勾 —— 这样「做完了」不看颜色也读得出来（DESIGN.md §7.6）。
//     断言只要求「完成态三者相同、未完成态三者互不相同」，不写死任何 path 数据。
const readChecklist = () =>
	win.evaluate(() => {
		const guide = document.querySelector(".home-guide");
		const rows = guide === null ? [] : [...guide.querySelectorAll(".home-guide-row")];
		return {
			present: guide !== null,
			text: guide === null ? "" : guide.innerText,
			rowCount: rows.length,
			actionCount: guide === null ? 0 : guide.querySelectorAll(".mini-btn").length,
			markShapes: rows.slice(0, 3).map((row) => (row.querySelector(".home-guide-icon svg")?.innerHTML ?? "").length),
			recallLabels: [...document.querySelectorAll(".mini-btn")]
				.map((b) => b.textContent.trim())
				.filter((t) => t.includes("上手清单")),
		};
	});

/** 首页此刻长什么样（失败信息里用它交代现场）。 */
const readHome = () =>
	win.evaluate(() => ({
		homeMounted: document.querySelector(".home") !== null,
		settingsMounted: document.querySelectorAll(".settings-nav-item").length,
		toasts: document.querySelectorAll(".toast").length,
		expertChip: document.querySelector(".expert-chip") !== null,
		tail: (document.body.innerText || "").slice(-300),
	}));

/** 点「新建任务」回首页（侧栏在任何视图下都在）。 */
async function goHome() {
	await win.evaluate(() => {
		[...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("新建任务"))?.click();
	});
}

/** 点清单里某一行的「去处」按钮；用文案定位，不依赖行的下标。 */
async function clickChecklistAction(pattern) {
	const clicked = await win.evaluate((source) => {
		const re = new RegExp(source);
		const button = [...document.querySelectorAll(".home-guide .mini-btn")].find((b) => re.test(b.textContent));
		if (button === undefined) return false;
		button.click();
		return true;
	}, pattern);
	assert.ok(clicked, `清单里没有匹配 ${pattern} 的去处按钮`);
}

/** 侧栏里文本恰好等于 label 的导航项。 */
const readNavItem = (label) =>
	win.evaluate((text) => {
		const el = [...document.querySelectorAll(".sidebar-nav .nav-item")].find(
			(n) => (n.textContent || "").trim() === text,
		);
		if (el === undefined) return null;
		return {
			disabled: el.disabled === true,
			cursor: getComputedStyle(el).cursor,
			color: getComputedStyle(el).color,
			pending: el.classList.contains("nav-item-pending"),
		};
	}, label);

// ── ① 首次运行：清单出现，三项都还没完成 ───────────────
//
// 先截图、后断言：截图在前，断言失败时才有现场。
await h.shoot("home-first-run");

await h.check("首次运行出现三步清单（三项待办 + 一句本地优先）", async () => {
	await waitUntil(() => win.evaluate(() => document.querySelector(".home-guide") !== null), {
		timeout: 30_000,
		desc: "首页渲染出上手清单（.home-guide）",
	});
	const now = await readChecklist();
	assert.equal(now.rowCount, 4, `清单行数=${now.rowCount}；首页尾部：${(await readHome()).tail}`);
	assert.equal(
		now.actionCount,
		3,
		`可点的去处按钮数=${now.actionCount}（期望 3 —— 少一个就说明有一项被判成了已完成）；清单文案：${now.text}`,
	);
	assert.equal(new Set(now.markShapes).size, 3, "三项的图标形态相同，分不出是哪一项");
	for (const word of ["工作空间", "模型", "第一条消息"]) {
		assert.ok(now.text.includes(word), `清单里没有「${word}」：${now.text}`);
	}
	assert.ok(now.text.includes("本地优先"), `清单里没有本地优先说明：${now.text}`);
});

// ── ② 缺模型时推向设置页（这个行为保留）────────────────
await h.check("点清单里的模型去处，跳到设置页", async () => {
	await clickChecklistAction("模型|API Key");
	await waitUntil(() => win.evaluate(() => document.querySelectorAll(".settings-nav-item").length > 0), {
		timeout: 30_000,
		desc: "设置页渲染出左侧分区（.settings-nav-item）",
	});
	await h.shoot("settings-from-checklist");
});

await h.check("配好模型之前，清单不整块消失（另外两项还没完成）", async () => {
	await goHome();
	await waitUntil(() => win.evaluate(() => document.querySelector(".home-guide") !== null), {
		timeout: 30_000,
		desc: "回到首页且清单还在",
	});
	const now = await readChecklist();
	assert.equal(now.rowCount, 4, `清单行数=${now.rowCount}`);
	assert.equal(now.actionCount, 3, `可点的去处按钮数=${now.actionCount}`);
});

// ── ③ 案例卡：点一下，提示词与专家一起到位 ──────────────
const card = await win.evaluate(() => {
	const first = document.querySelector(".case-card");
	if (first === null) return null;
	return { title: (first.querySelector(".case-title")?.textContent ?? "").trim() };
});
// 拿界面上的卡片标题回查数据 —— 断的是「界面上这一张」，不是「数据里的某一张」
const cardData = CASES.find((c) => c.title === card?.title);

await h.check("案例卡对应 cases.json 里的一条真实数据，且它绑定了专家", () => {
	assert.ok(card !== null, "首页没有渲染出任何 .case-card");
	assert.ok(cardData !== undefined, `界面上的案例「${card?.title}」在 cases.json 里找不到`);
	assert.ok(
		typeof cardData.expert === "string" && cardData.expert !== "",
		`案例「${cardData.title}」没有 expert 字段，这条断言失去了前提`,
	);
});

await h.check("点案例卡 → 输入框里是它自己的提示词，且专家换成它绑定的那个", async () => {
	// 前置：点之前专家必须**不是**它 —— 否则「点完等于它」会恒真，测了个寂寞
	const expertBefore = await win.evaluate(async () => (await globalThis.kami.snapshot()).state.expertId);
	assert.notEqual(expertBefore, cardData.expert, "点之前专家就已经是案例绑定的那个了，这条断言会恒真");

	await win.evaluate(() => document.querySelector(".case-card").click());

	await waitUntil(
		() =>
			win.evaluate((expected) => {
				const box = document.querySelector('textarea[aria-label="消息输入框"]');
				return box !== null && box.value === expected;
			}, cardData.prompt),
		{ timeout: 30_000, desc: "输入框内容变成该案例的 prompt" },
	);
	// 专家断的是 daemon 的会话状态真值，不是「界面上有没有 chips」
	await waitUntil(
		async () => (await win.evaluate(async () => (await globalThis.kami.snapshot()).state.expertId)) === cardData.expert,
		{ timeout: 30_000, desc: `当前专家变成「${cardData.expert}」（案例绑定值）` },
	);
	assert.ok((await readHome()).expertChip, "专家已选中，但输入区没有渲染出专家 chip");
	await h.shoot("case-card-picked");
});

// ── ④ 清单的「选择工作空间」真的能把工作空间下拉顶开 ─────
await h.check("点清单里的工作空间去处，工作空间下拉被顶开", async () => {
	await clickChecklistAction("选择工作空间");
	await waitUntil(() => win.evaluate(() => document.querySelector(".ws-popover") !== null), {
		timeout: 30_000,
		desc: "工作空间下拉面板（.ws-popover）出现",
	});
});

await h.check("在下拉里新建一个工作空间，清单那一项随即变成已完成", async () => {
	// 走真实交互（playwright 的 fill / click），不用页面里造事件那套 ——
	// 受控输入靠手工 dispatchEvent 更容易写错，也测不出组件是不是真的接住了输入。
	await win.locator(".ws-action").filter({ hasText: "新建工作空间" }).click();
	const nameInput = win.locator(".ws-create input");
	await nameInput.waitFor({ state: "visible", timeout: 30_000 });
	await nameInput.fill("入职首个空间");
	await win.locator(".ws-create button").filter({ hasText: /^创建$/ }).click();

	// 先等真值（daemon 的工作空间列表）变了，再断界面 —— 界面是推导出来的
	await waitUntil(
		async () =>
			(await win.evaluate(async () => (await globalThis.kami.workspaceSnapshot()).workspaces)).some((w) =>
				w.includes("入职首个空间"),
			),
		{ timeout: 30_000, desc: "daemon 的工作空间列表里出现新建的空间" },
	);
	await waitUntil(async () => (await readChecklist()).actionCount === 2, {
		timeout: 30_000,
		desc: "清单里未完成的项从 3 变成 2（工作空间那项勾上了）",
	});
	const now = await readChecklist();
	assert.ok(now.text.includes("已有工作空间"), `工作空间那一项没有变成已完成：${now.text}`);
	await h.shoot("checklist-after-workspace");
});

await h.check("点清单里的「去写第一条」，焦点真的落到输入框上", async () => {
	await win.evaluate(() => document.activeElement?.blur?.());
	await clickChecklistAction("去写第一条");
	await waitUntil(
		() => win.evaluate(() => document.activeElement?.getAttribute("aria-label") === "消息输入框"),
		{ timeout: 30_000, desc: "焦点落在消息输入框上" },
	);
});

// ── ⑤ 配好模型 + 发出第一条消息 → 三项全完成，清单消失 ────
await h.check("配好模型并发出第一条消息", async () => {
	const registered = await win.evaluate(
		async ({ baseUrl }) => {
			try {
				await globalThis.kami.saveCustomProvider(
					{
						id: "onboarding-mock",
						name: "Onboarding Mock",
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
				await globalThis.kami.setModel("onboarding-mock/mock-model");
				return { ok: true };
			} catch (e) {
				return { ok: false, err: String(e?.message ?? e).slice(0, 200) };
			}
		},
		{ baseUrl: mock.baseUrl },
	);
	assert.ok(registered.ok, `配置 mock provider 失败：${registered.err}`);

	// 走真实 UI 路径发送（不是直接调 kami.prompt），顺带证明发送这一路可用
	const box = win.locator('textarea[aria-label="消息输入框"]');
	await box.waitFor({ state: "visible", timeout: 30_000 });
	await box.fill("随便问一句");
	await box.press("Enter");
	// 「发出去了没有」要验证到副作用：mock 真收到请求才算数
	await waitUntil(() => mock.requests.length >= 1, { timeout: 60_000, desc: "mock 模型服务收到第 1 轮请求" });
});

await h.check("三项全完成 → 清单消失，只留一个「上手清单」的回头路", async () => {
	// 发完消息会切到对话页，而清单只长在首页上 —— 先回首页
	await goHome();
	// 先等「清单组件画出了结果」这个正向信号：要么是清单本身，要么是回头路入口。
	// **不能**拿「.home-guide 不见了」当完成证据 —— 三个 IPC 还在路上时卡片本来
	// 就不存在，那样会假过。
	await waitUntil(
		() =>
			win.evaluate(
				() =>
					document.querySelector(".home-guide") !== null ||
					[...document.querySelectorAll(".mini-btn")].some((b) => b.textContent.trim() === "上手清单"),
			),
		{ timeout: 30_000, desc: "清单组件画出结果（清单本身或回头路入口）" },
	);
	await h.shoot("checklist-hidden");
	const now = await readChecklist();
	assert.equal(now.present, false, `三项都完成后清单没有消失：${now.text}`);
	assert.ok(
		now.recallLabels.some((t) => t === "上手清单"),
		`没有留下「上手清单」回头路入口：${JSON.stringify(now.recallLabels)}`,
	);
});

await h.check("点「上手清单」能再调出来，且三项都标成已完成", async () => {
	await win.evaluate(() => {
		[...document.querySelectorAll(".mini-btn")].find((b) => b.textContent.trim() === "上手清单")?.click();
	});
	await waitUntil(() => win.evaluate(() => document.querySelector(".home-guide") !== null), {
		timeout: 30_000,
		desc: "清单被重新调出来",
	});
	const now = await readChecklist();
	assert.equal(now.actionCount, 0, `已完成还留着可点的去处按钮：${now.text}`);
	assert.equal(new Set(now.markShapes).size, 1, "完成态三行的图标不是同一个（对勾），形态上读不出「都做完了」");
	for (const word of ["已有工作空间", "已选定可用模型", "已发出第一条消息"]) {
		assert.ok(now.text.includes(word), `清单里没有「${word}」：${now.text}`);
	}
	await h.shoot("checklist-all-done");

	// 收起 → 回到「不打扰老用户」的形态
	await win.evaluate(() => {
		[...document.querySelectorAll(".mini-btn")].find((b) => b.textContent.trim() === "收起上手清单")?.click();
	});
	await waitUntil(() => win.evaluate(() => document.querySelector(".home-guide") === null), {
		timeout: 30_000,
		desc: "清单收起后重新消失",
	});
});

// ── ⑥ 侧栏：4 个「敬请期待」是真禁用态 ──────────────────
await h.check("侧栏未就绪项带 disabled、指针不是 pointer、降灰那一档还在", async () => {
	for (const label of ["助理", "项目", "资料库", "更多"]) {
		const item = await readNavItem(label);
		assert.ok(item !== null, `侧栏没有「${label}」`);
		assert.equal(item.disabled, true, `「${label}」没有 disabled 属性`);
		assert.equal(item.cursor, "default", `「${label}」的指针是 ${item.cursor}`);
		assert.equal(item.pending, true, `「${label}」没有 nav-item-pending 类（降灰那一档会丢）`);
	}
	const ready = await readNavItem("专家·技能·连接器");
	assert.equal(ready.disabled, false, "「专家·技能·连接器」被误禁用了");
	assert.equal(ready.cursor, "pointer", `已就绪项的指针是 ${ready.cursor}`);

	// 颜色本来就是对的，不该被这次改动带坏：挂上 disabled 后浏览器 UA 会给
	// 禁用按钮一个默认色，必须确认它没有盖掉我们的弱文档。
	// 只断言「两者不同色」不写死色值 —— 档位本身归 app.css 的 :root 管。
	const pendingColor = (await readNavItem("助理")).color;
	assert.notEqual(pendingColor, ready.color, "未就绪项与已就绪项同色，降灰那一档丢了");
});

await h.check("程序化点未就绪项不会走任何去处（既不弹 toast 也不换页）", async () => {
	await win.evaluate(() => {
		document.querySelector(".sidebar-nav .nav-item-pending").click();
	});
	await h.waitForSettled();
	const after = await readHome();
	assert.equal(after.toasts, 0, "点未就绪项仍然弹出了 toast");
	assert.equal(after.settingsMounted, 0, "点未就绪项把界面带走了");
	assert.ok(after.homeMounted, `点未就绪项后首页不在了；页面尾部：${after.tail}`);
});

// 收尾顺序按 testing/spec §5.3：先关应用，再关 mock
// （反过来 server.close 会等 daemon 与 mock 之间还活着的长连接）。
await h.app().close();
await mock.close();
await h.finish();
