/**
 * 计划书（Plan Book）端到端测试 —— 不需要真实模型，本地 mock SSE 服务按剧本回一段编号计划。
 *
 * 验的是「单测覆盖不到的那一段」：**渲染层与 daemon 真的接上了**。
 *   plan 模式跑完 → 自动捕获并落盘 → 顶栏出现带步骤数的「计划书」→ 抽屉打开
 *   → 编辑 / 勾选 / 删除撤销 → 版本浮层与差异 → 执行这一步 / 执行全部
 *   → 重载后读回 → 50 步时只有一个滚动容器。
 *
 * 关键等待全部是**具体元素 / 状态**（无固定 sleep）：
 *   - 内容版本数只在**保存回包**之后才变（乐观更新不会改 versions 数组）；
 *   - 勾选不产生版本，所以勾选后直接读 daemon 的 getPlan 等落盘；
 *   - mock 收到带「按下面的计划开始执行」的请求，才证明执行全部走的是**编辑后**的计划。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const TITLE = "整理季度复盘";
const STEP_1 = "收集本季度所有周报";
const STEP_2 = "汇总完成项与延期项";
const STEP_2_EDITED = "汇总完成项、延期项与风险";
const STEP_3 = "写出下季度改进建议";
const PLAN_TEXT = `计划：${TITLE}\n\n1. ${STEP_1}\n2. ${STEP_2}\n3. ${STEP_3}`;

function startMockModel() {
	const requests = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			let parsed;
			try {
				parsed = JSON.parse(body);
			} catch {
				parsed = undefined;
			}
			requests.push({ url: req.url, body: parsed });
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const send = (delta, finish) => {
				const chunk = { id: "chatcmpl-plan", object: "chat.completion.chunk", choices: [{ index: 0, delta }] };
				if (finish !== undefined) chunk.choices[0].finish_reason = finish;
				res.write(`data: ${JSON.stringify(chunk)}\n\n`);
			};
			send({ role: "assistant", content: "" });
			// 用 [\s\S] 而不是 `.`：`.` 不匹配换行，会把计划文本里的空行与换行吞掉，
			// 于是标题与编号步骤粘成一行 —— 解析器只能回退成「一整段一步」。
			for (const piece of PLAN_TEXT.match(/[\s\S]{1,8}/gu) ?? []) send({ content: piece });
			send({}, "stop");
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	return new Promise((ok) => {
		server.listen(0, "127.0.0.1", () =>
			ok({
				baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
				requests,
				close: () => new Promise((resolve) => server.close(resolve))
			})
		);
	});
}

/**
 * 从一条 OpenAI 兼容请求里取**所有** user 文本。
 *
 * 不能只取最后一条 user：daemon 会在用户消息之后追加 hidden context，而它在
 * 请求体里可能同样是 role:"user"（按段拼的）—— 只取最后一条会拿到那段背景，
 * 于是「按下面的计划开始执行」永远找不到（2026-11-10 实测）。
 */
function userTexts(request) {
	const messages = request?.body?.messages ?? [];
	return messages
		.filter((message) => message.role === "user")
		.map((message) => {
			const content = message.content;
			if (typeof content === "string") return content;
			if (Array.isArray(content)) return content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("\n");
			return "";
		});
}

const h = createHarness({ name: "plan-book" });
mkdirSync(h.WORKSPACE_DIR, { recursive: true });
/* 工作空间用可读子目录：截图里的面包屑不该是临时目录名（评审 P2-20）。 */
const WORKSPACE = join(h.WORKSPACE_DIR, "季度复盘");
mkdirSync(WORKSPACE, { recursive: true });

const mock = await startMockModel();
console.log(`✓ mock 模型服务已就绪：${mock.baseUrl}`);

await h.launch();
const win = h.window();

async function clickInStep(index, label) {
	await win.locator(".plan-book-step").nth(index).hover();
	await win.locator(`[aria-label="${label}"]`).click();
}

/** 等「版本历史 · N」—— 它只在 daemon 的保存回包替换了乐观 plan 之后才变。 */
async function waitVersions(count) {
	return waitUntil(
		async () => {
			const value = await win.evaluate(() => {
				const target = document.querySelector(".plan-book-foot .plan-book-version-btn");
				return target === null ? "" : (target.textContent ?? "").trim();
			});
			const parsed = Number(value.replace(/\D/gu, ""));
			return parsed === count ? value : null;
		},
		{ timeout: 30_000, desc: `版本数变成 ${count}` }
	);
}

async function waitStepText(index, expected) {
	return waitUntil(
		async () => {
			const value = await win.evaluate(
				({ index: i }) => {
					const rows = [...document.querySelectorAll(".plan-book-step")];
					const text = rows[i]?.querySelector(".plan-book-step-text");
					return text === undefined || text === null ? "" : (text.textContent ?? "").trim();
				},
				{ index }
			);
			return value === expected ? value : null;
		},
		{ timeout: 30_000, desc: `第 ${index + 1} 步变成「${expected}」` }
	);
}

async function waitStepCount(count) {
	return waitUntil(
		async () => {
			const value = await win.evaluate(() => document.querySelectorAll(".plan-book-step").length);
			return value === count ? value : null;
		},
		{ timeout: 30_000, desc: `步骤数变成 ${count}` }
	);
}

async function waitProgress(text) {
	return waitUntil(
		async () => {
			const value = await win.evaluate(() => (document.querySelector(".plan-book-progress-text")?.textContent ?? "").trim());
			return value.includes(text) ? value : null;
		},
		{ timeout: 30_000, desc: `进度变成「${text}」` }
	);
}

/** 读 daemon 的当前计划（等待某一侧真的落盘时用）。 */
async function readDaemonPlan() {
	return win.evaluate(async () => {
		const snapshot = await window.kami.snapshot();
		return window.kami.getPlan(snapshot?.state?.sessionId);
	});
}

/** 等 daemon 里的步骤数与文本都到位（勾选不产生版本，没有别的保存信号）。 */
async function waitDaemonSteps(count, expectedLastText) {
	return waitUntil(
		async () => {
			const plan = await readDaemonPlan();
			if (plan === null || plan === undefined || plan.steps.length !== count) return null;
			if (expectedLastText !== void 0 && plan.steps.at(-1)?.text !== expectedLastText) return null;
			return plan;
		},
		{ timeout: 20_000, desc: `daemon 里是 ${count} 步` }
	);
}

/** 等抽屉的入场动画真正跑完（opacity 到 1、transform 归位）。 */
async function waitPlanBookSettled() {
	return waitUntil(
		async () => {
			const value = await win.evaluate(() => {
				const book = document.querySelector(".plan-book");
				if (book === null) return null;
				const style = getComputedStyle(book);
				return { opacity: style.opacity, transform: style.transform };
			});
			if (value === null) return null;
			const identity = value.transform === "none" || value.transform === "matrix(1, 0, 0, 1, 0, 0)";
			return value.opacity === "1" && identity ? value : null;
		},
		{ timeout: 10_000, desc: "计划书入场动画结束" }
	);
}

/**
 * 等抽屉里的**所有动画**真正结束（入场滑入 + 进度条过渡）。
 * `getAnimations().finished` 是强信号；2s 的 race 只是兜底。
 */
async function waitPlanBookAnimations() {
	return waitUntil(
		async () => {
			const done = await win.evaluate(async () => {
				const book = document.querySelector(".plan-book");
				if (book === null) return true;
				const animations = book.getAnimations({ subtree: true });
				if (animations.length === 0) return true;
				await Promise.race([
					Promise.all(animations.map((animation) => animation.finished.catch(() => undefined))),
					new Promise((resolve) => setTimeout(resolve, 2000))
				]);
				return book.getAnimations({ subtree: true }).every((animation) => animation.playState !== "running");
			});
			return done ? true : null;
		},
		{ timeout: 10_000, desc: "计划书抽屉动画结束" }
	);
}

/** 截图卫生：等 toast 全部消失，别让「计划书已生成」压住抽屉（评审 P2-20）。 */
async function waitNoToasts() {
	await waitUntil(
		async () => ((await win.evaluate(() => document.querySelectorAll(".toast").length)) === 0 ? true : null),
		{ timeout: 12_000, desc: "toast 全部消失" }
	);
}

async function shootPlanBook(label) {
	await waitNoToasts();
	await waitPlanBookAnimations();
	await h.shoot(label);
}

async function openPlanBook() {
	await win.locator('[aria-label="打开计划书"]').click();
	await waitUntil(async () => (await win.evaluate(() => document.querySelector(".plan-book") !== null)) ? true : null, {
		timeout: 15_000,
		desc: "计划书抽屉打开"
	});
	await waitPlanBookSettled();
}

async function ensurePlanBookOpen() {
	const open = await win.evaluate(() => document.querySelector(".plan-book") !== null);
	if (!open) await openPlanBook();
}

async function openPlanBookFromPalette() {
	await win.evaluate(() => window.dispatchEvent(new CustomEvent("zw:palette-open")));
	const input = win.locator(".command-palette-input");
	await input.waitFor({ state: "visible", timeout: 15_000 });
	await input.fill("计划书");
	await waitUntil(
		async () => {
			const found = await win.evaluate(() =>
				[...document.querySelectorAll(".ac-item")].some((item) => (item.textContent ?? "").includes("打开计划书"))
			);
			return found ? true : null;
		},
		{ timeout: 15_000, desc: "命令面板出现「打开计划书」" }
	);
	// 面板用的是 onMouseDown（不是 onClick），必须用真实鼠标事件点。
	await win.locator(".ac-item").filter({ hasText: "打开计划书" }).first().click();
	await waitUntil(async () => (await win.evaluate(() => document.querySelector(".plan-book") !== null)) ? true : null, {
		timeout: 15_000,
		desc: "命令面板动作打开计划书抽屉"
	});
	await waitPlanBookSettled();
}

/**
 * 请求一个窗口尺寸，返回**实际**尺寸。
 *
 * CI 的屏幕只有 1024×679：`resizeTo(1280, 860)` 会被系统钳制，永远等不到目标值。
 * 因此这里不要求精确命中，只等尺寸稳定（连续两帧不变）后返回实际值，由调用方
 * 按实际尺寸断言几何。两步之间用 resize 事件把「稳定」计数清零，避免在动画
 * 中途误判。
 */
async function resizeWindow(width, height) {
	return win.evaluate(
		({ w, h }) =>
			new Promise((resolve) => {
				window.resizeTo(w, h);
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
		{ w: width, h: height }
	);
}

/** 抽屉必须在 .chat-header 下缘之下，且顶栏的「计划书」按钮仍然可点。 */
async function assertDrawerBelowHeader() {
	const geometry = await win.evaluate(() => {
		const book = document.querySelector(".plan-book");
		const header = document.querySelector(".chat-header");
		const toggle = document.querySelector(".plan-book-toggle");
		if (book === null || header === null || toggle === null) return null;
		const bookRect = book.getBoundingClientRect();
		const headerRect = header.getBoundingClientRect();
		const toggleRect = toggle.getBoundingClientRect();
		const hit = document.elementFromPoint(toggleRect.left + toggleRect.width / 2, toggleRect.top + toggleRect.height / 2);
		return {
			bookTop: bookRect.top,
			headerBottom: headerRect.bottom,
			toggleWidth: toggleRect.width,
			toggleHeight: toggleRect.height,
			toggleHit: hit === toggle || toggle.contains(hit),
			viewport: { width: window.innerWidth, height: window.innerHeight }
		};
	});
	assert.ok(geometry !== null, "抽屉 / 顶栏 / 入口按钮不在 DOM 里");
	assert.ok(
		geometry.bookTop >= geometry.headerBottom - 0.5,
		`抽屉压住了工具栏：book.top=${geometry.bookTop} < header.bottom=${geometry.headerBottom}`
	);
	assert.ok(geometry.toggleWidth > 0 && geometry.toggleHeight > 0, "顶栏「计划书」按钮不可见");
	assert.ok(geometry.toggleHit, "顶栏「计划书」按钮被抽屉盖住、点不到");
	return geometry;
}

await h.check("注册指向 mock 的 provider 并切模型", async () => {
	const result = await win.evaluate(
		async ({ baseUrl, ws }) => {
			const k = globalThis.kami;
			try {
				await k.saveCustomProvider(
					{
						id: "mock-plan",
						name: "Mock Plan",
						baseUrl,
						api: "openai-completions",
						authHeader: true,
						models: [{ id: "plan-model", name: "plan-model", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }]
					},
					"mock-key"
				);
				await k.setModel("mock-plan/plan-model");
				await k.setWorkspace(ws);
				return { ok: true };
			} catch (error) {
				return { ok: false, err: String(error?.message ?? error).slice(0, 200) };
			}
		},
		{ baseUrl: mock.baseUrl, ws: WORKSPACE }
	);
	assert.ok(result.ok, `配置失败：${result.err}`);
});

await h.check("空态：一句话说明，非 plan 模式给「切到计划模式」主按钮", async () => {
	await openPlanBookFromPalette();
	// 首次打开时先经过一帧「正在读取」，等空态真正落下来再断言。
	await waitUntil(
		async () => ((await win.evaluate(() => (document.querySelector(".plan-book-empty-title")?.textContent ?? "").trim())) !== "" ? true : null),
		{ timeout: 15_000, desc: "空态渲染完成" }
	);
	const empty = await win.evaluate(() => ({
		kicker: (document.querySelector(".plan-book-kicker")?.textContent ?? "").trim(),
		title: (document.querySelector(".plan-book-empty-title")?.textContent ?? "").trim(),
		desc: (document.querySelector(".plan-book-empty-desc")?.textContent ?? "").trim(),
		hasHeaderTitle: document.querySelector(".plan-book-title") !== null,
		switchLabel: (document.querySelector(".plan-book-empty .primary-btn")?.textContent ?? "").trim()
	}));
	assert.equal(empty.kicker, "计划书");
	assert.ok(!empty.hasHeaderTitle, "空态不该在头部再显示一个重复标题");
	assert.equal(empty.title, "还没有计划书");
	assert.ok(empty.desc.includes("切到『计划』模式"), `空态文案不对：${empty.desc}`);
	assert.equal(empty.switchLabel, "切到计划模式");
	await win.locator(".plan-book-empty .primary-btn").click();
	await waitUntil(
		async () => {
			const label = await win.evaluate(() => (document.querySelector(".mode-chip-label")?.textContent ?? "").trim());
			return label === "计划" ? label : null;
		},
		{ timeout: 20_000, desc: "空态主按钮切到计划模式" }
	);
	await win.locator('.plan-book [aria-label="关闭计划书"]').click();
	await waitUntil(async () => (await win.evaluate(() => document.querySelector(".plan-book") !== null)) ? null : true, {
		timeout: 10_000,
		desc: "空态抽屉关闭"
	});
});

await h.check("切到计划模式并发送一条消息（真实 UI 路径）", async () => {
	await waitUntil(
		async () => {
			const label = await win.evaluate(() => (document.querySelector(".mode-chip-label")?.textContent ?? "").trim());
			return label === "计划" ? label : null;
		},
		{ timeout: 20_000, desc: "模式 chip 变成「计划」" }
	);
	const box = win.locator('[aria-label="消息输入框"]');
	await box.waitFor({ state: "visible", timeout: 30_000 });
	await box.fill("帮我制定季度复盘计划");
	await box.press("Enter");
	await waitUntil(() => mock.requests.length >= 1, { timeout: 40_000, desc: "mock 收到计划请求" });
});

await h.check("计划跑完后自动捕获：顶栏出现带步骤数的「计划书」", async () => {
	await waitUntil(
		async () => {
			const text = await win.evaluate(() => (document.querySelector(".plan-book-toggle .plan-book-badge")?.textContent ?? "").trim());
			return text === "3" ? text : null;
		},
		{ timeout: 40_000, desc: "计划书按钮出现且带 3 步徽标（自动捕获完成）" }
	);
});

await h.check("抽屉：实色阅读面、无 backdrop-filter、在工具栏下方、打开即聚焦关闭键", async () => {
	await openPlanBook();
	const state = await win.evaluate(() => {
		const book = document.querySelector(".plan-book");
		const style = getComputedStyle(book);
		const active = document.activeElement;
		const close = document.querySelector('.plan-book [aria-label="关闭计划书"]');
		return {
			title: (document.querySelector(".plan-book-title")?.textContent ?? "").trim(),
			steps: [...document.querySelectorAll(".plan-book-step")].map((row) => (row.querySelector(".plan-book-step-text")?.textContent ?? "").trim()),
			progress: (document.querySelector(".plan-book-progress-text")?.textContent ?? "").trim(),
			status: (document.querySelector(".plan-book-status")?.textContent ?? "").trim(),
			backgroundColor: style.backgroundColor,
			backdropFilter: style.backdropFilter,
			webkitBackdropFilter: style.webkitBackdropFilter,
			focusOnClose: close !== null && (active === close || close.contains(active))
		};
	});
	assert.equal(state.title, TITLE);
	assert.deepEqual(state.steps, [STEP_1, STEP_2, STEP_3]);
	assert.ok(state.progress.includes("0 / 3 完成"), `进度不对：${state.progress}`);
	assert.equal(state.status, "草稿");
	// 实色：rgb(...) 没有 alpha 通道；backdrop-filter 必须是 none（含 -webkit）。
	assert.match(state.backgroundColor, /^rgb\(\s*\d+,\s*\d+,\s*\d+\s*\)$/u, `抽屉底色不是实色：${state.backgroundColor}`);
	assert.equal(state.backdropFilter, "none", "抽屉不该再有 backdrop-filter");
	// Chromium 的 `webkitBackdropFilter` 可能是 undefined（属性名不存在），
	// 只要不是 blur(...) 即可；标准属性已在上一行断言 none。
	assert.ok(
		state.webkitBackdropFilter === undefined || state.webkitBackdropFilter === "" || state.webkitBackdropFilter === "none",
		`-webkit-backdrop-filter 未关：${state.webkitBackdropFilter}`
	);
	assert.ok(state.focusOnClose, "打开抽屉后焦点应在关闭按钮上");
	await assertDrawerBelowHeader();
});

await h.check("当前窗口与最小窗口下抽屉都在工具栏下方；899px 窄窗全宽规则在位", async () => {
	await assertDrawerBelowHeader();
	const before = await win.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
	const small = await resizeWindow(900, 700);
	assert.ok(
		small.width < before.width || before.width <= 900,
		`窗口没有缩到 900 宽：${before.width} → ${small.width}`
	);
	await assertDrawerBelowHeader();
	// 最小窗口（900）下抽屉取 clamp 下限 420：文本列仍需 ≥210px。
	const narrowText = await win.evaluate(() => {
		const row = document.querySelector(".plan-book-step");
		return {
			drawer: document.querySelector(".plan-book")?.getBoundingClientRect().width ?? 0,
			text: row?.querySelector(".plan-book-step-text")?.getBoundingClientRect().width ?? 0
		};
	});
	assert.ok(narrowText.text >= 210, `最小窗口下文本列应 ≥210px：${JSON.stringify(narrowText)}`);
	// BrowserWindow 的 minWidth 是 900，窗口本身到不了 899 以下 —— 窄窗规则
	// 用 CSSOM 验在位（它是对「更窄的嵌入/未来放宽 minWidth」的承诺）。
	const breakpoint = await win.evaluate(() => {
		for (const sheet of document.styleSheets) {
			let rules;
			try {
				rules = sheet.cssRules;
			} catch {
				continue;
			}
			for (const rule of rules) {
				// 鸭子类型而不是 `instanceof CSSMediaRule`：测试脚本的 ESLint
				// 环境没有浏览器全局，直接引用会触发 no-undef。
				if (typeof rule.conditionText !== "string" || rule.cssRules === undefined) continue;
				if (!rule.conditionText.includes("899px")) continue;
				const text = [...rule.cssRules].map((child) => child.cssText).join("\n");
				if (text.includes(".plan-book") && text.includes("width: 100%")) return true;
			}
		}
		return false;
	});
	assert.ok(breakpoint, "缺少 max-width: 899px 的抽屉全宽规则");
	// 恢复到进入本用例前的尺寸；CI 上同样可能被屏幕钳制，按实际值断言即可。
	await resizeWindow(before.width, before.height);
	await assertDrawerBelowHeader();
});

await h.check("单圆圈：序号与勾选合并成 24px 的一个控件", async () => {
	const checks = await win.evaluate(() => {
		const rows = [...document.querySelectorAll(".plan-book-step")];
		return {
			stepNoCount: document.querySelectorAll(".plan-book-step-no").length,
			rows: rows.map((row) => {
				const buttons = [...row.querySelectorAll(".plan-book-check")];
				const rect = buttons[0]?.getBoundingClientRect();
				return {
					count: buttons.length,
					width: rect?.width ?? 0,
					height: rect?.height ?? 0,
					text: (buttons[0]?.textContent ?? "").trim(),
					role: buttons[0]?.getAttribute("role") ?? ""
				};
			})
		};
	});
	assert.equal(checks.stepNoCount, 0, "不该再有单独的 .plan-book-step-no");
	assert.deepEqual(checks.rows.map((row) => row.count), [1, 1, 1], "每行只应有一个圆形控件");
	assert.ok(checks.rows.every((row) => row.width >= 24 && row.height >= 24), "圆形控件应 ≥24×24");
	assert.ok(checks.rows.every((row) => row.role === "checkbox"), "圆形控件应是 checkbox");
	assert.equal(checks.rows[0].text, "1", "未完成时圆圈里应显示序号");
	const uncheckedBorder = await win.evaluate(() => getComputedStyle(document.querySelector(".plan-book-check")).borderColor);
	assert.ok(
		uncheckedBorder === "transparent" || uncheckedBorder.includes("rgba(0, 0, 0, 0)"),
		`未完成圆圈不该有低对比描边：${uncheckedBorder}`
	);
	// 行内操作瘦身：总宽 ≤80px、文本列 ≥210px、Tab 顺序 check → 执行 → 编辑 → 更多。
	const ops = await win.evaluate(() => {
		const row = document.querySelector(".plan-book-step");
		const opsNode = row?.querySelector(".plan-book-step-ops");
		const textNode = row?.querySelector(".plan-book-step-text");
		return {
			opsWidth: opsNode?.getBoundingClientRect().width ?? 0,
			textWidth: textNode?.getBoundingClientRect().width ?? 0,
			labels: row === null || row === undefined ? [] : [...row.querySelectorAll("button")].map((button) => button.getAttribute("aria-label") ?? "")
		};
	});
	assert.ok(ops.opsWidth <= 80.5, `行内操作总宽应 ≤80px：${ops.opsWidth}`);
	assert.ok(ops.textWidth >= 210, `文本列应 ≥210px：${ops.textWidth}`);
	assert.deepEqual(
		ops.labels,
		["第 1 步未完成", "执行第 1 步", "编辑第 1 步", "第 1 步的更多操作"],
		`Tab 顺序不对：${JSON.stringify(ops.labels)}`
	);
});

await h.check("「新增一步」紧贴最后一步（同一个滚动体）", async () => {
	const gap = await win.evaluate(() => {
		const rows = [...document.querySelectorAll(".plan-book-step")];
		const add = document.querySelector(".plan-book-add");
		if (rows.length === 0 || add === null) return null;
		const last = rows[rows.length - 1].getBoundingClientRect();
		return add.getBoundingClientRect().top - last.bottom;
	});
	assert.ok(gap !== null && gap <= 12.5, `新增按钮离最后一步太远：${gap}px`);
	await shootPlanBook("plan-book-light");
});

await h.check("Esc 焦点规则：焦点在抽屉外不关，在里面才关；关闭后焦点还给入口", async () => {
	// 焦点在抽屉外（输入框）：Esc 不关抽屉。
	await win.locator('[aria-label="消息输入框"]').focus();
	await win.keyboard.press("Escape");
	const stillOpen = await win.evaluate(() => document.querySelector(".plan-book") !== null);
	assert.ok(stillOpen, "焦点在抽屉外时 Esc 不该关抽屉");
	// 焦点在抽屉内（关闭键）：Esc 关闭。
	await win.locator('.plan-book [aria-label="关闭计划书"]').focus();
	await win.keyboard.press("Escape");
	await waitUntil(async () => (await win.evaluate(() => document.querySelector(".plan-book") !== null)) ? null : true, {
		timeout: 10_000,
		desc: "Esc 关闭抽屉"
	});
	const focusBack = await win.evaluate(() => (document.activeElement?.className ?? "").includes("plan-book-toggle"));
	assert.ok(focusBack, "关闭抽屉后焦点应还给顶栏入口");
	await openPlanBook();
});

await h.check("删除可撤销：更多菜单删除第 3 步，toast 撤销后原样回来", async () => {
	await win.locator(".plan-book-step").nth(2).hover();
	await win.locator('[aria-label="第 3 步的更多操作"]').click();
	await win.locator(".plan-book-menu .plan-book-menu-item").filter({ hasText: "删除" }).click();
	await waitStepCount(2);
	await waitUntil(
		async () => {
			const text = await win.evaluate(() => [...document.querySelectorAll(".toast")].map((toast) => toast.textContent ?? "").join("\n"));
			return text.includes("已删除第 3 步") ? text : null;
		},
		{ timeout: 10_000, desc: "出现删除 toast" }
	);
	await win.locator(".toast", { hasText: "已删除第 3 步" }).locator(".toast-action").click();
	await waitStepCount(3);
	await waitStepText(2, STEP_3);
	await waitDaemonSteps(3, STEP_3);
	await waitVersions(3);
});

await h.check("编辑第 2 步：单行输入、保存后版本 +1", async () => {
	await clickInStep(1, "编辑第 2 步");
	const input = win.locator('input[aria-label="编辑第 2 步"]');
	await input.waitFor({ state: "visible", timeout: 15_000 });
	assert.equal(await win.evaluate(() => document.querySelector('[aria-label="编辑第 2 步"]')?.tagName ?? ""), "INPUT", "编辑应是单行 input");
	await input.fill(STEP_2_EDITED);
	await shootPlanBook("plan-book-edit");
	await input.press("Enter");
	await waitStepText(1, STEP_2_EDITED);
	await waitVersions(4);
});

await h.check("空编辑不静默回滚：留在编辑器里报原因，Esc 放弃", async () => {
	await clickInStep(2, "编辑第 3 步");
	const input = win.locator('input[aria-label="编辑第 3 步"]');
	await input.waitFor({ state: "visible", timeout: 15_000 });
	await input.fill("");
	await input.press("Enter");
	await waitUntil(
		async () => (await win.evaluate(() => document.querySelector(".plan-book-edit-error") !== null)) ? true : null,
		{ timeout: 10_000, desc: "空文本时出现错误文案" }
	);
	const kept = await win.evaluate(() => ({
		hasInput: document.querySelector('input[aria-label="编辑第 3 步"]') !== null,
		error: (document.querySelector(".plan-book-edit-error")?.textContent ?? "").trim()
	}));
	assert.ok(kept.hasInput, "空文本时编辑器不该静默关闭");
	assert.ok(kept.error.includes("步骤不能为空"), `错误文案不对：${kept.error}`);
	// 清空后失焦：仍保持编辑器打开并显示原因。
	await win.locator(".plan-book-title").click();
	assert.ok(await win.evaluate(() => document.querySelector('input[aria-label="编辑第 3 步"]') !== null), "空文本失焦后编辑器仍在");
	assert.ok(await win.evaluate(() => document.querySelector(".plan-book-edit-error") !== null), "空文本失焦后错误文案仍在");
	await win.keyboard.press("Escape");
	await waitUntil(async () => (await win.evaluate(() => document.querySelector('input[aria-label="编辑第 3 步"]') !== null)) ? null : true, {
		timeout: 10_000,
		desc: "Esc 放弃编辑"
	});
	await waitStepText(2, STEP_3);
	await waitVersions(4);
});

await h.check("勾选第 1 步：进度变化，但不新增版本", async () => {
	await win.locator('[aria-label="第 1 步未完成"]').click();
	await waitProgress("1 / 3 完成");
	const saved = await waitUntil(
		async () => {
			const plan = await readDaemonPlan();
			return plan !== null && plan !== undefined && plan.steps[0]?.done === true ? plan : null;
		},
		{ timeout: 20_000, desc: "勾选状态已经落盘" }
	);
	assert.equal(saved.versions.length, 4, `勾选不应新增版本（当前 ${saved.versions.length} 版）`);
});

await h.check("版本浮层：不改变步骤区高度；选中 v1 看差异（vN 在头部）", async () => {
	const beforeHeight = await win.evaluate(() => document.querySelector(".plan-book-steps")?.clientHeight ?? -1);
	await win.locator(".plan-book-version-btn").click();
	await waitUntil(async () => (await win.evaluate(() => document.querySelector(".plan-book-versions") !== null)) ? true : null, {
		timeout: 15_000,
		desc: "版本浮层打开"
	});
	const afterHeight = await win.evaluate(() => document.querySelector(".plan-book-steps")?.clientHeight ?? -1);
	assert.equal(afterHeight, beforeHeight, "版本浮层打开不应挤压步骤区");
	const rows = await win.evaluate(() =>
		[...document.querySelectorAll(".plan-book-version-row")].map((row) => (row.querySelector(".plan-book-version-no")?.textContent ?? "").trim())
	);
	assert.deepEqual(rows, ["v4", "v3", "v2", "v1"], `版本顺序应是新 → 旧：${JSON.stringify(rows)}`);
	await win.evaluate(() => {
		const target = [...document.querySelectorAll(".plan-book-version-row")].find(
			(row) => (row.querySelector(".plan-book-version-no")?.textContent ?? "").trim() === "v1"
		);
		target?.click();
	});
	const diff = await waitUntil(
		async () => {
			const value = await win.evaluate(() => ({
				head: (document.querySelector(".plan-book-diff-head span")?.textContent ?? "").trim(),
				del: [...document.querySelectorAll(".plan-book-diff-line.del .plan-book-diff-text")].map((node) => (node.textContent ?? "").trim()),
				add: [...document.querySelectorAll(".plan-book-diff-line.add .plan-book-diff-text")].map((node) => (node.textContent ?? "").trim()),
				same: [...document.querySelectorAll(".plan-book-diff-line.same .plan-book-diff-text")].map((node) => (node.textContent ?? "").trim())
			}));
			return value.del.length > 0 && value.add.length > 0 ? value : null;
		},
		{ timeout: 15_000, desc: "差异视图出现新增 / 删除行" }
	);
	assert.match(diff.head, /^v1 · \d{2}:\d{2}:\d{2} · 自动捕获$/u, `差异头应含 vN / 时:分:秒 / 来源：${diff.head}`);
	const selectedShadow = await win.evaluate(() => {
		const row = document.querySelector(".plan-book-version-row.active");
		return row === null ? "" : getComputedStyle(row).boxShadow;
	});
	assert.ok(selectedShadow.includes("inset"), `选中行应有左侧强调边：${selectedShadow}`);
	assert.ok(diff.del.includes(STEP_2), `删除行应含旧的第 2 步：${JSON.stringify(diff)}`);
	assert.ok(diff.add.includes(STEP_2_EDITED), `新增行应含新的第 2 步：${JSON.stringify(diff)}`);
	assert.ok(diff.same.includes(STEP_1) && diff.same.includes(STEP_3), `未变行应含第 1 / 3 步：${JSON.stringify(diff)}`);
	await shootPlanBook("plan-book-diff");
});

await h.check("恢复 v1：内容回退、形成新版本、toast 带版本号", async () => {
	await win.locator(".plan-book-diff-head .mini-btn").filter({ hasText: "恢复此版本" }).click();
	const toast = await waitUntil(
		async () => {
			const text = await win.evaluate(() => [...document.querySelectorAll(".toast")].map((node) => node.textContent ?? "").join("\n"));
			return text.includes("已恢复到 v1（已保存为新版本）") ? text : null;
		},
		{ timeout: 8_000, desc: "恢复成功 toast" }
	);
	assert.ok(toast.includes("已恢复到 v1"), "恢复 toast 文案不对");
	await waitStepText(1, STEP_2);
	await waitVersions(5);
	const state = await win.evaluate(() => ({
		progress: (document.querySelector(".plan-book-progress-text")?.textContent ?? "").trim(),
		versionsOpen: document.querySelector(".plan-book-versions") !== null
	}));
	assert.ok(state.progress.includes("0 / 3 完成"), `恢复旧版本应一并回到未勾选：${state.progress}`);
	assert.equal(state.versionsOpen, false, "恢复后版本浮层应收起");
});

await h.check("重新编辑并勾选（执行要用编辑后的计划，而不是聊天里的旧计划）", async () => {
	await clickInStep(1, "编辑第 2 步");
	const input = win.locator('input[aria-label="编辑第 2 步"]');
	await input.waitFor({ state: "visible", timeout: 15_000 });
	await input.fill(STEP_2_EDITED);
	await input.press("Enter");
	await waitStepText(1, STEP_2_EDITED);
	await waitVersions(6);
	await win.locator('[aria-label="第 1 步未完成"]').click();
	await waitProgress("1 / 3 完成");
	const saved = await waitUntil(
		async () => {
			const plan = await readDaemonPlan();
			return plan !== null && plan !== undefined && plan.steps[0]?.done === true ? plan : null;
		},
		{ timeout: 20_000, desc: "第二次勾选已经落盘" }
	);
	assert.equal(saved.versions.length, 6, `勾选不应新增版本（当前 ${saved.versions.length} 版）`);
});

await h.check("执行这一步 → 切回创作模式并把该步骤填进输入框", async () => {
	await clickInStep(1, "执行第 2 步");
	await waitUntil(
		async () => {
			const value = await win.evaluate(() => document.querySelector('[aria-label="消息输入框"]')?.value ?? "");
			return value.includes(`执行计划第 2 步：${STEP_2_EDITED}`) ? value : null;
		},
		{ timeout: 20_000, desc: "输入框被填入第 2 步" }
	);
	await waitUntil(
		async () => {
			const label = await win.evaluate(() => (document.querySelector(".mode-chip-label")?.textContent ?? "").trim());
			return label === "" ? true : null;
		},
		{ timeout: 15_000, desc: "切回创作模式（计划 chip 消失）" }
	);
	const drawer = await win.evaluate(() => document.querySelector(".plan-book") !== null);
	assert.equal(drawer, false, "执行这一步后抽屉应关闭，让用户看到输入框");
});

await h.check("执行全部 → 发出的是编辑后的计划（不是聊天里的旧计划）", async () => {
	await openPlanBook();
	await win.locator(".plan-book-foot .primary-btn").filter({ hasText: "执行全部" }).click();
	const request = await waitUntil(
		() => {
			const hit = mock.requests.find((item) => userTexts(item).some((text) => text.includes("按下面的计划开始执行")));
			return hit ?? null;
		},
		{ timeout: 40_000, desc: "mock 收到「按下面的计划开始执行」" }
	);
	const text = userTexts(request).find((value) => value.includes("按下面的计划开始执行")) ?? "";
	assert.ok(text.includes(STEP_2_EDITED), `执行全部应带编辑后的第 2 步：${text.slice(0, 300)}`);
	assert.ok(!text.includes(STEP_2), "执行全部不该带被编辑掉的旧第 2 步");
	assert.ok(text.includes(STEP_1) && text.includes(STEP_3), "执行全部应带完整计划");
});

await h.check("执行全部会批准当前版本：状态徽标「已批准」+ 对勾", async () => {
	await ensurePlanBookOpen();
	const status = await waitUntil(
		async () => {
			const value = await win.evaluate(() => {
				const node = document.querySelector(".plan-book-status");
				if (node === null) return null;
				return { text: (node.textContent ?? "").trim(), hasIcon: node.querySelector("svg") !== null };
			});
			return value !== null && value.text.includes("已批准") ? value : null;
		},
		{ timeout: 20_000, desc: "状态徽标变成已批准" }
	);
	assert.ok(status.hasIcon, "已批准徽标应带对勾");
});

await h.check("版本浮层：已批准文字走 --text-secondary（绿色只留对勾）、右缘对齐、点外关闭", async () => {
	await win.locator(".plan-book-version-btn").click();
	await waitUntil(async () => (await win.evaluate(() => document.querySelector(".plan-book-versions") !== null)) ? true : null, {
		timeout: 15_000,
		desc: "版本浮层打开"
	});
	const result = await win.evaluate(() => {
		const label = document.querySelector(".plan-book-version-approved");
		const icon = label?.querySelector("svg");
		const panel = document.querySelector(".plan-book-versions")?.getBoundingClientRect();
		const button = document.querySelector(".plan-book-version-btn")?.getBoundingClientRect();
		const probe = document.createElement("span");
		document.body.appendChild(probe);
		probe.style.color = "var(--text-secondary)";
		const secondary = getComputedStyle(probe).color;
		probe.style.color = "var(--ok)";
		const ok = getComputedStyle(probe).color;
		probe.remove();
		return {
			textColor: label === null ? "" : getComputedStyle(label).color,
			iconColor: icon === undefined || icon === null ? "" : getComputedStyle(icon).color,
			secondary,
			ok,
			rightGap: panel === undefined || button === undefined ? null : Math.abs(panel.right - button.right)
		};
	});
	assert.equal(result.textColor, result.secondary, `已批准文字应是 --text-secondary：${result.textColor}`);
	assert.equal(result.iconColor, result.ok, `对勾应保留 --ok：${result.iconColor}`);
	assert.ok(result.rightGap !== null && result.rightGap <= 1, `版本浮层右缘未与按钮对齐：${result.rightGap}`);
	// 点外部（抽屉标题）关闭浮层。
	await win.locator(".plan-book-title").click();
	await waitUntil(async () => (await win.evaluate(() => document.querySelector(".plan-book-versions") !== null)) ? null : true, {
		timeout: 10_000,
		desc: "点外关闭版本浮层"
	});
});

await h.check("暗色截图", async () => {
	await win.evaluate(() => {
		void window.kami?.setThemePreference?.("dark");
		document.documentElement.setAttribute("data-theme", "dark");
	});
	await waitUntil(
		async () => (await win.evaluate(() => document.documentElement.getAttribute("data-theme"))) === "dark",
		{ timeout: 10_000, desc: "data-theme 切到 dark" }
	);
	// 关掉再打开：暗色下的抽屉从暗色 token 建起来。
	await win.locator('.plan-book [aria-label="关闭计划书"]').click();
	await waitUntil(async () => (await win.evaluate(() => document.querySelector(".plan-book") !== null)) ? null : true, {
		timeout: 10_000,
		desc: "抽屉关闭"
	});
	await openPlanBook();
	await shootPlanBook("plan-book-dark");
	await win.evaluate(() => {
		void window.kami?.setThemePreference?.("light");
		document.documentElement.setAttribute("data-theme", "light");
	});
});

await h.check("重载后从 daemon 读回：编辑 / 勾选 / 批准都还在", async () => {
	await win.reload();
	await waitUntil(
		() => win.evaluate(() => (document.getElementById("root")?.childElementCount ?? 0) > 0),
		{ timeout: 60_000, desc: "React 重新挂载" }
	);
	const persisted = await waitUntil(
		async () => {
			const value = await win.evaluate(async () => {
				try {
					const snapshot = await window.kami.snapshot();
					const sessionId = snapshot?.state?.sessionId;
					if (typeof sessionId !== "string" || sessionId === "") return null;
					const plan = await window.kami.getPlan(sessionId);
					if (plan === null || plan === undefined) return null;
					return {
						title: plan.title,
						steps: plan.steps.map((step) => ({ text: step.text, done: step.done === true })),
						versions: plan.versions.length,
						approved: plan.approvedAt !== undefined
					};
				} catch {
					return null;
				}
			});
			return value !== null && value.steps.length === 3 ? value : null;
		},
		{ timeout: 40_000, desc: "重载后读回计划书" }
	);
	assert.equal(persisted.title, TITLE);
	assert.equal(persisted.steps[1].text, STEP_2_EDITED, "编辑后的第 2 步应仍在");
	assert.equal(persisted.steps[0].done, true, "第 1 步的勾选状态应仍在");
	assert.ok(persisted.versions >= 6, `版本历史应保留（实际 ${persisted.versions} 版）`);
	assert.equal(persisted.approved, true, "批准态应仍在");
});

await h.check("50 步时只有 .plan-book-body 一个滚动容器", async () => {
	// 直接写 50 步（不走 UI 加 47 次），再重载让渲染层读回。
	await win.evaluate(async () => {
		const snapshot = await window.kami.snapshot();
		const sessionId = snapshot?.state?.sessionId;
		const steps = Array.from({ length: 50 }, (_, index) => ({
			id: `s-fifty-${index + 1}`,
			text: `第 ${index + 1} 步：复盘事项`,
			done: false
		}));
		await window.kami.savePlan(sessionId, { title: "50 步检查", steps, source: "manual" });
	});
	await win.reload();
	await waitUntil(
		() => win.evaluate(() => (document.getElementById("root")?.childElementCount ?? 0) > 0),
		{ timeout: 60_000, desc: "重载后 React 重新挂载" }
	);
	await openPlanBookFromPalette();
	await waitUntil(
		async () => ((await win.evaluate(() => document.querySelectorAll(".plan-book-step").length)) === 50 ? true : null),
		{ timeout: 30_000, desc: "读回 50 步" }
	);
	const scroll = await win.evaluate(() => {
		const book = document.querySelector(".plan-book");
		const steps = document.querySelector(".plan-book-steps");
		const scrollers = [...book.querySelectorAll("*")]
			.filter((element) => {
				const style = getComputedStyle(element);
				return (style.overflowY === "auto" || style.overflowY === "scroll") && element.scrollHeight > element.clientHeight + 1;
			})
			.map((element) => element.className);
		return {
			title: (document.querySelector(".plan-book-title")?.textContent ?? "").trim(),
			stepsOverflow: steps === null ? "" : getComputedStyle(steps).overflowY,
			scrollers
		};
	});
	assert.equal(scroll.title, "50 步检查");
	assert.equal(scroll.stepsOverflow, "visible", "步骤列表自身不该是滚动容器");
	assert.deepEqual(scroll.scrollers, ["plan-book-body"], `只应有 body 一个滚动容器：${JSON.stringify(scroll.scrollers)}`);
});

await h.check("50 步滚到底：最后一步的「更多」菜单不被裁切、三项都可命中", async () => {
	await win.evaluate(() => {
		const body = document.querySelector(".plan-book-body");
		body.scrollTop = body.scrollHeight;
	});
	await waitUntil(
		async () => {
			const visible = await win.evaluate(() => {
				const body = document.querySelector(".plan-book-body")?.getBoundingClientRect();
				const rows = [...document.querySelectorAll(".plan-book-step")];
				const last = rows[rows.length - 1]?.getBoundingClientRect();
				if (body === undefined || last === undefined) return false;
				return last.top >= body.top - 0.5 && last.bottom <= body.bottom + 0.5;
			});
			return visible ? true : null;
		},
		{ timeout: 10_000, desc: "最后一步滚进视口" }
	);
	await win.locator(".plan-book-step").last().hover();
	await win.locator('[aria-label="第 50 步的更多操作"]').click();
	await waitUntil(async () => (await win.evaluate(() => document.querySelector(".plan-book-menu") !== null)) ? true : null, {
		timeout: 10_000,
		desc: "更多菜单打开"
	});
	const items = await win.evaluate(() => {
		const body = document.querySelector(".plan-book-body")?.getBoundingClientRect();
		const menuNode = document.querySelector(".plan-book-menu");
		return [...document.querySelectorAll(".plan-book-menu-item")].map((item) => {
			const rect = item.getBoundingClientRect();
			const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
			return {
				text: (item.textContent ?? "").trim(),
				disabled: item.disabled,
				insideBody:
					body !== undefined &&
					rect.top >= body.top - 0.5 &&
					rect.bottom <= body.bottom + 0.5 &&
					rect.left >= body.left - 0.5 &&
					rect.right <= body.right + 0.5,
				hit: hit === item || item.contains(hit),
				hitTag: hit?.tagName ?? "",
				hitClass: typeof hit?.className === "string" ? hit.className : "",
				menuPointerEvents: menuNode === null ? "" : getComputedStyle(menuNode).pointerEvents
			};
		});
	});
	assert.equal(items.length, 3, `菜单应有 3 项：${JSON.stringify(items)}`);
	for (const item of items) {
		assert.ok(item.insideBody, `菜单项「${item.text}」落在 body 可视区外：${JSON.stringify(item)}`);
		assert.ok(item.hit, `菜单项「${item.text}」点不到：${JSON.stringify(item)}`);
	}
	// 最后一步的「下移」按设计禁用；「上移」可点，点了真的交换最后两步。
	assert.ok(items.find((item) => item.text === "下移")?.disabled === true, "最后一步的「下移」应禁用");
	await win.locator(".plan-book-menu-item").filter({ hasText: "上移" }).click();
	await waitUntil(async () => (await win.evaluate(() => document.querySelector(".plan-book-menu") !== null)) ? null : true, {
		timeout: 10_000,
		desc: "菜单关闭"
	});
	await waitUntil(
		async () => {
			const lastText = await win.evaluate(() => {
				const rows = [...document.querySelectorAll(".plan-book-step-text")];
				return (rows[rows.length - 1]?.textContent ?? "").trim();
			});
			return lastText === "第 49 步：复盘事项" ? lastText : null;
		},
		{ timeout: 20_000, desc: "第 50 步已上移" }
	);
});

await h.check("无渲染层未捕获异常", () => assert.equal(h.pageErrors.length, 0, h.pageErrors.join("; ")));

await h.app().close();
await mock.close();
await h.finish();
