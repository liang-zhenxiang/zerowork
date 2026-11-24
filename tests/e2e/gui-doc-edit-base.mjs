/**
 * 修订模式底座（#456）的真实 Electron 用例：开启后 write 不落盘、建议可读、
 * 模型收到「不要原样重试」、工具卡与轨迹显示成待审而不是失败、关闭后状态撤下。
 *
 * 这里守的是「只有真跑起来才暴露」的接线：工具拦截在 daemon、状态推送经宿主、
 * 卡片状态在渲染层 —— 任何一处对不上，单测都是绿的。逐条接受/拒绝与写回的
 * 完整五条路径由 #459 在这个文件上扩展。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	DOCX_PART_DEFAULT,
	buildDocxProposal,
	buildProposal,
	saveProposal,
	sha256Bytes,
} from "../../src/main/daemon/doc-edits.js";
import { ROOT, createHarness, waitUntil } from "./lib/harness.mjs";

const runFile = promisify(execFile);

const FINAL_TEXT = "DOC_EDIT_PROBE_DONE";

function startWriteServer() {
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
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			const base = { id: `chatcmpl-doc-${Date.now()}`, object: "chat.completion.chunk", created: 0, model: "mock-model" };
			const send = (delta, finish = null) => {
				res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
			};
			send({ role: "assistant", content: "" });
			const messages = parsed?.messages ?? [];
			const hasToolResult = messages.some((message) => message.role === "tool");
			const lastUserIndex = messages.map((message) => message.role).lastIndexOf("user");
			const afterLastUser = lastUserIndex === -1 ? [] : messages.slice(lastUserIndex + 1);
			const userText = JSON.stringify(messages[lastUserIndex]?.content ?? "");
			const wantsNormalWrite = userText.includes("正常写入");
			/*
			 * 两条工具调用路径：
			 *   · 第一次请求：修订模式下的 write（被拦成建议）；
			 *   · 关闭修订模式后的「正常写入」：只有该用户消息之后**还没有** tool 结果时才发，
			 *     否则同一轮会无限重复调用。
			 */
			if (!afterLastUser.some((message) => message.role === "tool") && wantsNormalWrite) {
				send({
					tool_calls: [
						{
							index: 0,
							id: `call_normal_${requests.length}`,
							type: "function",
							function: { name: "write", arguments: JSON.stringify({ path: "normal-target.md", content: "正常写入成功\n" }) },
						},
					],
				});
				send({}, "tool_calls");
			} else if (!hasToolResult && requests.length === 1) {
				send({
					tool_calls: [
						{
							index: 0,
							id: "call_doc_1",
							type: "function",
							function: { name: "write", arguments: JSON.stringify({ path: "revise-target.md", content: "改后的内容\n" }) },
						},
					],
				});
				send({}, "tool_calls");
			} else {
				for (const chunk of FINAL_TEXT.match(/.{1,8}/gu) ?? []) send({ content: chunk });
				send({}, "stop");
			}
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			resolve({
				baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
				requests,
				close: () => new Promise((done) => server.close(done)),
			});
		});
	});
}

const h = createHarness({ name: "doc-edit-base" });
mkdirSync(h.WORKSPACE_DIR, { recursive: true });
const mock = await startWriteServer();
await h.launch();
// 关掉首启「新东西」侧栏：工作台截图要覆盖宽版双列，不能被它压到 620px 以下。
await h.dismissWhatsNew();
const win = h.window();

await h.check("注册 provider 并选中模型", async () => {
	const result = await win.evaluate(async ({ baseUrl }) => {
		const k = globalThis.kami;
		await k.saveCustomProvider(
			{
				id: "e2e-doc",
				name: "E2E Doc",
				baseUrl,
				api: "openai-completions",
				models: [{ id: "mock-model", name: "Mock Model", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 4096 }],
			},
			"sk-e2e-dummy",
		);
		await k.setModel("e2e-doc/mock-model");
		return true;
	}, { baseUrl: mock.baseUrl });
	assert.equal(result, true);
});

await h.check("开启修订模式并发送消息", async () => {
	const enabled = await win.evaluate(() => globalThis.kami.setDocEditMode(true));
	assert.deepEqual(enabled, { docEditMode: true });
	// 走真实 UI 路径：直接调 kami.prompt 不会切到会话视图，界面开关也就不会渲染。
	const box = win.locator('[aria-label="消息输入框"]');
	await box.waitFor({ state: "visible", timeout: 30_000 });
	await box.fill("把 revise-target.md 改一下");
	await box.press("Enter");
	await waitUntil(() => mock.requests.length >= 1, { timeout: 40_000, interval: 500, desc: "mock 收到第 1 轮请求" });
});

await h.check("模型拿到「已记录待审建议、不要原样重试」的工具结果", async () => {
	await waitUntil(() => mock.requests.length >= 2, { timeout: 40_000, interval: 500, desc: "mock 收到第 2 轮请求" });
	const second = mock.requests[1].body;
	const toolMessage = (second?.messages ?? []).find((message) => message.role === "tool");
	assert.ok(toolMessage, "第 2 轮请求里没有 tool 结果");
	const content = JSON.stringify(toolMessage);
	assert.match(content, /待审建议/);
	assert.match(content, /不要原样重试/);
});

await h.check("建议已落盘、目标文件没有出现（未落盘）", async () => {
	const entries = await win.evaluate(() => globalThis.kami.listDocEdits());
	assert.equal(entries.length, 1, `建议条数：${JSON.stringify(entries)}`);
	assert.equal(entries[0].name, "revise-target.md");
	const proposal = await win.evaluate((id) => globalThis.kami.readDocEdit(id), entries[0].id);
	assert.equal(proposal.path.startsWith(h.WORKSPACE_DIR), true, `path 不在工作区：${proposal.path}`);
	assert.equal(proposal.before, "");
	assert.equal(proposal.after, "改后的内容\n");
	assert.equal(proposal.toolName, "write");
	assert.ok(proposal.sessionId !== "", "建议没有来源会话");
	assert.ok(proposal.baseSha256.length === 64);
	assert.ok(proposal.hunks.length > 0);
	assert.equal(existsSync(proposal.path), false, "目标文件竟然被创建了");
});

await h.check("被拦下的写入不被画成失败（#456 评审 P0）", async () => {
	// 轨迹条在折叠之外：先确认它把这段画成 pending 而不是 bad。
	const trace = await waitUntil(
		() => win.evaluate(() => {
			const seg = document.querySelector(".trace-seg.pending");
			if (seg === null) return null;
			return {
				text: (seg.textContent || "").trim(),
				aria: seg.getAttribute("aria-label") ?? "",
				badNearby: [...document.querySelectorAll(".trace-seg.bad")].length,
			};
		}),
		{ timeout: 20_000, interval: 200, desc: "轨迹出现 pending 段" },
	);
	assert.match(trace.aria, /待审建议/);
	assert.equal(trace.badNearby, 0, "同回合出现了 bad 轨迹段");
	// 展开过程，工具卡也不该是红点/失败图标。
	await win.evaluate(() => document.querySelector(".turn-header.clickable")?.click());
	const card = await waitUntil(
		() => win.evaluate(() => {
			const entry = [...document.querySelectorAll(".entry.tool")].find((node) =>
				(node.textContent || "").includes("已存为待审建议"),
			);
			if (entry === undefined) return null;
			return {
				dot: entry.querySelector(".tool-dot")?.className ?? "",
				label: entry.querySelector(".tool-label")?.textContent ?? "",
				hasFailedIcon: entry.querySelector(".tool-icon.failed") !== null,
			};
		}),
		{ timeout: 10_000, interval: 200, desc: "展开后待审建议工具卡出现" },
	);
	assert.ok(card.dot.includes("pending"), `工具点不是 pending：${card.dot}`);
	assert.equal(card.label, "已存为待审建议");
	assert.equal(card.hasFailedIcon, false, "待审建议仍用了失败图标");
	await h.shoot("tool-card-pending");
});

await h.check("更多操作里有 role=switch 的开关与开启说明", async () => {
	await win.evaluate(() => document.querySelector('.composer-bar [aria-label="更多操作"]').click());
	await win.evaluate(async () => {
		const menu = document.querySelector(".plus-menu");
		await Promise.all([...menu.getAnimations({ subtree: true })].map((animation) => animation.finished));
	});
	await h.shoot("menu-open");
	const ui = await win.evaluate(() => {
		const menu = document.querySelector(".plus-menu");
		const toggle = menu === null ? null : menu.querySelector('[role="switch"]');
		if (toggle === null) return null;
		return {
			checked: toggle.getAttribute("aria-checked"),
			text: toggle.textContent,
			desc: menu.querySelector(".plus-menu-switch-desc")?.textContent ?? "",
			hint: document.querySelector(".doc-edit-hint")?.textContent ?? "",
			permissionHeight: Math.round(document.querySelector(".permission-menu-zone .context-chip").getBoundingClientRect().height),
		};
	});
	assert.ok(ui, "更多操作里找不到 role=switch");
	assert.equal(ui.checked, "true");
	assert.match(ui.text, /修订模式/);
	assert.match(ui.desc, /待审建议/);
	assert.match(ui.hint, /待审建议/);
	assert.equal(ui.permissionHeight, 32, "权限 chip 被挤到换行");
});

await h.check("点开关可关闭，状态回推且字段消失", async () => {
	await win.evaluate(() => {
		const menu = document.querySelector(".plus-menu");
		menu.querySelector('[role="switch"]').click();
	});
	await waitUntil(
		async () => {
			const snapshot = await win.evaluate(() => globalThis.kami.snapshot());
			return Object.prototype.hasOwnProperty.call(snapshot.state, "docEditMode") ? null : true;
		},
		{ timeout: 10_000, interval: 200, desc: "关闭后 snapshot 不再占 docEditMode" },
	);
	const checked = await win.evaluate(() => document.querySelector('.plus-menu [role="switch"]')?.getAttribute("aria-checked"));
	assert.equal(checked, "false");
});

/**
 * 写回（#458）：接受与过期两条**真实链路**（preload → IPC → daemon → 磁盘）。
 *
 * 单测把合并算法与三道闸钉在纯函数上；这里守的是接线：通道名、参数形状
 * （`[id, hunkIds]` 的解构）、`readDocEdit` 附带的新鲜度字段，以及「接受之后
 * 文件才变化」这个用户可感知的事实。
 *
 * 「版本可还原」要求建议基于**已存在的文件**（新建文件没有旧内容），而本用例的
 * 建议是 write 新建的 —— 所以这里断言的是配套的不变量：新建文件的建议**不许**
 * 留下一条空内容的历史版本。有旧内容时的还原路径由单测
 * `doc-edits-apply.test.mjs` 用临时目录钉住。
 */
await h.check("关闭修订模式后恢复正常写入（模型直接落盘）", async () => {
	await win.evaluate(() => document.querySelector(".ws-backdrop")?.click());
	const before = await win.evaluate(() => globalThis.kami.listDocEdits());
	// 直接走 daemon 的 prompt 通道：这一条只验证「开关关掉后写入正常落盘」，
	// 不依赖输入框的焦点与排队状态。
	await win.evaluate(() => globalThis.kami.prompt({ text: "正常写入一次，用 normal-target.md" }));
	/*
	 * 会话 cwd 可能是工作区下的任务子目录（工作区按任务分桶），所以按文件名
	 * 递归找工作区内的落点 —— 断言的是「真的写入磁盘」，不是某个拼死的绝对路径。
	 */
	const findNormalTarget = () => {
		try {
			const rel = readdirSync(h.WORKSPACE_DIR, { recursive: true })
				.map((entry) => String(entry))
				.find((entry) => entry.endsWith("normal-target.md"));
			if (rel === undefined) return null;
			const abs = join(h.WORKSPACE_DIR, rel);
			return readFileSync(abs, "utf8") === "正常写入成功\n" ? abs : null;
		} catch {
			return null;
		}
	};
	const written = await waitUntil(
		() => findNormalTarget(),
		{ timeout: 40_000, interval: 300, desc: "关闭修订模式后 write 直接落到磁盘" }
	);
	assert.ok(written.endsWith("normal-target.md"));
	const after = await win.evaluate(() => globalThis.kami.listDocEdits());
	assert.equal(after.length, before.length, "关闭修订模式后仍产生了待审建议");
	assert.equal(
		after.some((entry) => entry.name === "normal-target.md"),
		false,
		"关闭修订模式后的写入被错误地记成了建议"
	);
});

await h.check("接受建议：原文变过就拒绝，恢复到基准后才写回", async () => {
	const entries = await win.evaluate(() => globalThis.kami.listDocEdits());
	assert.equal(entries.length, 1, `建议条数：${JSON.stringify(entries)}`);
	const id = entries[0].id;
	const proposal = await win.evaluate((value) => globalThis.kami.readDocEdit(value), id);
	assert.equal(proposal.stale, false, "刚生成的建议不该是过期态");
	assert.equal(proposal.currentSha256, proposal.baseSha256, "新鲜度哈希与基准不一致");
	const hunkIds = proposal.hunks.map((hunk) => hunk.id);

	// ① 用户手动写了同一个文件 → 建议立刻过期，接受必须被拒且不覆盖手写内容。
	const manual = "用户手写的内容\n";
	writeFileSync(proposal.path, manual, "utf8");
	const staleAfterEdit = await win.evaluate((value) => globalThis.kami.readDocEdit(value), id);
	assert.equal(staleAfterEdit.stale, true, "原文被改后建议没有标过期");
	const rejection = await win.evaluate(
		async ({ proposalId, ids }) => {
			try {
				await globalThis.kami.applyDocEdit(proposalId, ids);
				return "";
			} catch (error) {
				return String(error?.message ?? error);
			}
		},
		{ proposalId: id, ids: hunkIds },
	);
	assert.match(rejection, /原文已变化/, `过期时没有拒绝：${rejection || "(没有报错)"}`);
	assert.equal(readFileSync(proposal.path, "utf8"), manual, "被拒的接受仍然改了文件");
	await h.shoot("apply-stale");

	// ② 回到建议的基准（文件不存在）再接受 → 这时才允许写回。
	rmSync(proposal.path);
	const applied = await win.evaluate(
		async ({ proposalId, ids }) => globalThis.kami.applyDocEdit(proposalId, ids),
		{ proposalId: id, ids: hunkIds },
	);
	assert.equal(applied.path, proposal.path);
	assert.equal(readFileSync(proposal.path, "utf8"), proposal.after, "写回内容与建议的 after 不一致");
	assert.deepEqual(await win.evaluate(() => globalThis.kami.listDocEdits()), [], "接受后建议没有删除");

	// 新建文件的建议没有「旧内容」可留 —— 文件历史里不该出现一条空版本。
	const history = await win.evaluate(() => globalThis.kami.listFileHistory());
	assert.equal(
		history.files.some((file) => file.path === proposal.path),
		false,
		"新建文件留下了虚假的历史版本",
	);

	// 建议已被删除：再删一次要报可读错误，而不是静默成功。
	const again = await win.evaluate(async (value) => {
		try {
			await globalThis.kami.deleteDocEdit(value);
			return "";
		} catch (error) {
			return String(error?.message ?? error);
		}
	}, id);
	assert.match(again, /找不到修订建议/);
	await h.shoot("apply-done");
});

/* ══════════════════════════════════════════════════════════════════════
 * 修订工作台（#457）：待修订队列 → 取消一段 → 接受；原文被手改 → 拒绝整条
 *
 * 建议由 `buildProposal` + `saveProposal`（daemon 的同一份实现）直接落种子，
 * 而不是再跑一轮 Agent：这一轮要钉的是「勾选 → 写回 → 文件字节」与「过期 → 禁用
 * → 拒绝 → 文件不变」，模型的输出不该为这几条断言引入运气成分。生成链路本身
 * 已由本文件上半段的真实工具调用覆盖。
 * ══════════════════════════════════════════════════════════════════════ */
const DOC_EDITS_DIR = join(h.CONFIG_DIR, "doc-edits");
const A_NAME = "工作台甲.md";
const B_NAME = "工作台乙.md";

/** 第 2 行与第 18 行各改一处 —— 相距超过上下文阈值，会分成两个 hunk。 */
const aBeforeLines = Array.from({ length: 20 }, (_, index) => `第 ${index + 1} 行：原文`);
aBeforeLines[1] = "第一处：原文";
aBeforeLines[17] = "第二处：原文";
const aAfterLines = [...aBeforeLines];
aAfterLines[1] = "第一处：改后";
aAfterLines[17] = "第二处：改后";
const aFirstOnlyLines = [...aBeforeLines];
aFirstOnlyLines[1] = "第一处：改后";
const A_BEFORE = `${aBeforeLines.join("\n")}\n`;
const A_AFTER = `${aAfterLines.join("\n")}\n`;
/** 只应用第 1 段时应落盘的内容（第 18 行仍是原文）。 */
const A_EXPECT = `${aFirstOnlyLines.join("\n")}\n`;

const B_BEFORE = "乙：原文\n第二行：不变\n";
const B_AFTER = "乙：改后\n第二行：不变\n";
const B_MANUAL = "用户手写的内容\n";

function seedDocEdit(fileName, before, after, at) {
	const absPath = join(h.WORKSPACE_DIR, fileName);
	writeFileSync(absPath, before, "utf8");
	const proposal = buildProposal({
		absPath,
		before,
		after,
		sessionId: "sess-doc-workbench-e2e",
		toolName: "edit",
		at
	});
	saveProposal(proposal, { dir: DOC_EDITS_DIR });
	return { proposal, absPath };
}

const seededA = seedDocEdit(A_NAME, A_BEFORE, A_AFTER, Date.now() - 60_000);
const seededB = seedDocEdit(B_NAME, B_BEFORE, B_AFTER, Date.now() - 120_000);
assert.equal(seededA.proposal.hunks.length, 2, "夹具应生成两段互不相邻的改动");

async function openReviewDeskFromChat() {
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
		() =>
			win.evaluate(() => {
				const btn = [...document.querySelectorAll("main.settings .settings-head button")].find((b) =>
					(b.textContent ?? "").trim().startsWith("变更审阅")
				);
				if (btn === undefined) return false;
				btn.click();
				return true;
			}),
		{ timeout: 15_000, desc: "文件历史页头出现「变更审阅」入口" }
	);
}

/** 读工作台的可见状态；页面还没切过去时返回 null（谓词必须能返回假值）。 */
function readDocView() {
	return win.evaluate(() => {
		const main = document.querySelector("main.settings");
		if (main === null) return null;
		const card = main.querySelector("[data-doc-edit-card]");
		return {
			tabs: [...main.querySelectorAll(".rv-tabs-btn")].map((b) => ({
				text: (b.textContent ?? "").trim(),
				active: b.getAttribute("aria-pressed") === "true"
			})),
			groups: [...main.querySelectorAll(".rv-proposal-group")].map((group) => ({
				name: (group.querySelector(".rv-row-name")?.textContent ?? "").trim(),
				dir: (group.querySelector(".rv-row-dir")?.textContent ?? "").trim(),
				rows: group.querySelectorAll("[data-doc-edit-entry]").length
			})),
			cardName: (card?.querySelector(".fh-card-name")?.textContent ?? "").trim(),
			/* docx（#482）：没有 hunk，主体是「替换前 / 替换后」两块只读对照。 */
			docx: card?.getAttribute("data-docx") === "true",
			docxPart: (card?.querySelector("[data-docx-part]")?.textContent ?? "").trim(),
			docxBefore: (card?.querySelector('[data-docx-block="before"] .rv-hunk-line')?.textContent ?? "").trim(),
			docxAfter: (card?.querySelector('[data-docx-block="after"] .rv-hunk-line')?.textContent ?? "").trim(),
			docxBeforeSign: card?.querySelector('[data-docx-block="before"] .rv-hunk-sign')?.textContent ?? "",
			docxBeforeSr: card?.querySelector('[data-docx-block="before"] .sr-only')?.textContent ?? "",
			docxAfterSign: card?.querySelector('[data-docx-block="after"] .rv-hunk-sign')?.textContent ?? "",
			docxAfterSr: card?.querySelector('[data-docx-block="after"] .sr-only')?.textContent ?? "",
			docxNote: (card?.querySelector("[data-docx-note]")?.textContent ?? "").trim(),
			hasCheckbox: card === null ? false : card.querySelector(".rv-hunk-head input[type=checkbox]") !== null,
			hunkToolButtons: card === null ? 0 : card.querySelectorAll(".rv-hunk-tools button").length,
			rowStats: [...main.querySelectorAll("[data-doc-edit-entry] .rv-row-stats")].map((s) => (s.textContent ?? "").trim()),
			hunkBoxes: card === null
				? []
				: [...card.querySelectorAll(".rv-hunk-head input[type=checkbox]")].map((box) => ({
						checked: box.checked,
						label: box.getAttribute("aria-label") ?? ""
					})),
			summary: (card?.querySelector(".rv-hunk-summary")?.textContent ?? "").trim(),
			stale: card?.getAttribute("data-stale") === "true",
			staleText: (card?.querySelector("[data-doc-edit-stale] .rv-boundary-text")?.textContent ?? "").trim(),
			actions: card === null
				? []
				: [...card.querySelectorAll(".rv-actions button")].map((b) => ({
						text: (b.textContent ?? "").trim(),
						disabled: b.disabled
					})),
			confirm: (card?.querySelector("[data-doc-edit-confirm] .fh-confirm-text")?.textContent ?? "").trim(),
			emptyTitle: (main.querySelector(".state-empty-title")?.textContent ?? "").trim(),
			toasts: [...document.querySelectorAll(".toast-text")].map((t) => (t.textContent ?? "").trim())
		};
	});
}

const waitDocView = async (pred, desc, timeout = 20_000) => {
	let last;
	try {
		return await waitUntil(async () => {
			last = await readDocView();
			return last !== null && pred(last) ? last : null;
		}, { timeout, desc });
	} catch (error) {
		throw new Error(`${desc} —— 最后读到的状态：${JSON.stringify(last).slice(0, 600)}`, { cause: error });
	}
};

async function clickInDocCard(label) {
	const ok = await win.evaluate((text) => {
		const card = document.querySelector("[data-doc-edit-card]");
		const btn = card === null
			? undefined
			: [...card.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === text);
		if (btn === undefined || btn.disabled) return false;
		btn.click();
		return true;
	}, label);
	assert.ok(ok, `找不到可点的「${label}」`);
}

async function clickReviewRefresh() {
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

/** 切主题走与应用同一条路：localStorage 镜像 + data-theme 属性 + 偏好真源落盘。 */
async function setTheme(pref) {
	await win.evaluate(async (value) => {
		const resolved = value === "system"
			? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
			: value;
		localStorage.setItem("zw:theme-pref", value);
		document.documentElement.setAttribute("data-theme", resolved);
		window.dispatchEvent(new CustomEvent("zw:theme-changed"));
		await window.kami.setThemePreference(value);
	}, pref);
	await waitUntil(
		() => win.evaluate((value) => {
			const resolved = value === "system"
				? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
				: value;
			return document.documentElement.getAttribute("data-theme") === resolved;
		}, pref),
		{ timeout: 10_000, desc: `主题切到 ${pref}` }
	);
}

await h.check("工作台默认进入待修订：按文件分组、默认全选", async () => {
	await openReviewDeskFromChat();
	const view = await waitDocView(
		(state) => state.tabs.length === 2 && state.groups.length === 2 && state.hunkBoxes.length === 2,
		"待修订队列渲染（两个文件、两段）"
	);
	await h.waitForSettled();
	await h.shoot("doc-edit-workbench-light");

	assert.deepEqual(view.tabs.map((tab) => tab.text), ["待修订 2", "已变更"], "模式按钮文字不对");
	assert.equal(view.tabs[0].active, true, "有建议时应默认停在「待修订」，而不是「已变更」");
	assert.deepEqual(
		view.groups.map((group) => group.name).sort(),
		[A_NAME, B_NAME].sort(),
		`队列应按文件分组：${JSON.stringify(view.groups)}`
	);
	assert.ok(view.groups.every((group) => group.dir.length > 0), "组头应显示目录（不能只剩文件名）");
	assert.equal(view.cardName, A_NAME, "应默认选中最新的一条建议");
	assert.equal(view.hunkBoxes.length, 2, "两条 hunk 应各有一个勾选框");
	assert.ok(view.hunkBoxes.every((box) => box.checked), "hunk 默认全选");
	assert.match(view.hunkBoxes[1].label, /应用第 2 段/, `第二段的读屏名称不对：${view.hunkBoxes[1].label}`);
	assert.match(view.summary, /已选 2 \/ 2 段/, `汇总不对：${JSON.stringify(view.summary)}`);

	/* 暗色也要看一遍：token 是属性驱动的，同一个界面换一套底即可。 */
	await setTheme("dark");
	await h.waitForSettled();
	await h.shoot("doc-edit-workbench-dark");
	await setTheme("light");
});

await h.check("取消第二段后接受：目标文件只写回选中的段", async () => {
	await win.evaluate(() => {
		const boxes = [...document.querySelectorAll("[data-doc-edit-card] .rv-hunk-head input[type=checkbox]")];
		boxes[1].click();
	});
	await waitDocView((state) => state.summary.includes("已选 1 / 2 段"), "取消第二段后汇总变成 1 / 2");
	// 勾选状态不只靠复选框：段头文字与丢弃提示必须同时说清。
	const offState = await win.evaluate(() => {
		const off = document.querySelector("[data-doc-edit-card] .rv-hunk.is-off");
		return {
			count: document.querySelectorAll("[data-doc-edit-card] .rv-hunk.is-off").length,
			state: off?.querySelector(".rv-hunk-state")?.textContent ?? "",
			discard: document.querySelector("[data-doc-edit-card] .rv-hunk-discard")?.textContent ?? "",
		};
	});
	assert.equal(offState.count, 1, "取消勾选后应有一段标成不应用");
	assert.equal(offState.state, "不应用");
	assert.match(offState.discard, /未勾选的 1 段会.*丢弃/);
	// 增删行有符号与读屏前缀，不只靠底色。
	const lineSemantics = await win.evaluate(() => {
		const del = document.querySelector("[data-doc-edit-card] .rv-hunk-line.diff-del");
		const add = document.querySelector("[data-doc-edit-card] .rv-hunk-line.diff-add");
		return {
			delSign: del?.querySelector(".rv-hunk-sign")?.textContent ?? "",
			delSr: del?.querySelector(".sr-only")?.textContent ?? "",
			addSign: add?.querySelector(".rv-hunk-sign")?.textContent ?? "",
			addSr: add?.querySelector(".sr-only")?.textContent ?? "",
		};
	});
	assert.equal(lineSemantics.delSign, "−");
	assert.equal(lineSemantics.delSr, "删除：");
	assert.equal(lineSemantics.addSign, "+");
	assert.equal(lineSemantics.addSr, "新增：");

	await clickInDocCard("接受选中（1 段）");
	const disk = await waitUntil(
		() => {
			const text = readFileSync(seededA.absPath, "utf8");
			return text === A_EXPECT ? text : null;
		},
		{ timeout: 20_000, interval: 200, desc: "目标文件只含第一处改动（第二段未写回）" }
	);
	assert.equal(disk, A_EXPECT, "写回内容与选中段不一致");
	assert.ok(disk.includes("第二处：原文"), "未选中的第二段被写回去了");
	assert.ok(!disk.includes("第二处：改后"), "未选中的第二段被写回去了");

	const after = await waitDocView((state) => state.tabs[0]?.text === "待修订 1", "接受后队列只剩乙");
	assert.ok(
		after.toasts.some((text) => text.includes("1 / 2 段") && text.includes("其余 1 段已丢弃")),
		`toast 应报段数与未勾选段的去向：${JSON.stringify(after.toasts)}`
	);
	assert.ok(
		after.toasts.some((text) => text.includes("+1") && text.includes("−1")),
		`toast 应报增删行数：${JSON.stringify(after.toasts)}`
	);
	assert.equal((await win.evaluate(() => globalThis.kami.listDocEdits())).length, 1, "接受后建议应被删除");
	await h.shoot("doc-edit-workbench-accepted");
});

await h.check("接受后可从文件历史还原到接受前", async () => {
	const history = await win.evaluate(() => globalThis.kami.listFileHistory());
	const file = history.files.find((entry) => entry.path === seededA.absPath);
	assert.ok(file, "文件历史里没有接受前留下的版本");
	const detail = await win.evaluate(({ key }) => globalThis.kami.readFileHistory({ key }), { key: file.key });
	assert.equal(detail?.ok, true, `读版本详情失败：${JSON.stringify(detail)}`);
	const versions = detail.versions ?? [];
	assert.ok(versions.length > 0, "接受前没有留下版本记录");
	// versions 旧→新；接受前的旧内容是最早的一版。
	const oldest = versions[0];
	const restored = await win.evaluate(
		({ key, id }) => globalThis.kami.restoreFileHistory({ key, id }),
		{ key: file.key, id: oldest.id }
	);
	assert.equal(restored?.ok, true, `还原失败：${JSON.stringify(restored)}`);
	assert.equal(readFileSync(seededA.absPath, "utf8"), A_BEFORE, "还原后内容不等于接受前");
});

await h.check("原文被手改 → 过期提示、接受禁用；Esc 取消拒绝", async () => {
	writeFileSync(seededB.absPath, B_MANUAL, "utf8");
	await clickReviewRefresh();
	const stale = await waitDocView(
		(state) => state.stale === true && state.cardName === B_NAME,
		"刷新后出现「原文已变化」"
	);
	assert.match(stale.staleText, /原文已变化/, `过期条文案不对：${JSON.stringify(stale.staleText)}`);
	assert.match(stale.staleText, /重新生成/, "过期条要给「重新生成」指引");
	const accept = stale.actions.find((action) => action.text.startsWith("接受选中"));
	assert.ok(accept !== undefined, "过期时仍应显示接受按钮（禁用而不是消失）");
	assert.equal(accept.disabled, true, "过期时接受按钮必须禁用");
	await h.shoot("doc-edit-workbench-stale");

	/* 拒绝仍可用：先打开二次确认，Esc 取消后文件与建议都必须原样。 */
	await clickInDocCard("拒绝整条");
	await waitDocView((state) => state.confirm !== "", "拒绝的二次确认条出现");
	await win.keyboard.press("Escape");
	await waitDocView((state) => state.confirm === "", "Esc 取消二次确认");
	assert.equal(readFileSync(seededB.absPath, "utf8"), B_MANUAL, "取消后文件不该变");
	assert.equal((await win.evaluate(() => globalThis.kami.listDocEdits())).length, 1, "取消后建议应仍在");
});

await h.check("确认拒绝：建议消失、计数归零、目标文件不变", async () => {
	await clickInDocCard("拒绝整条");
	await waitDocView((state) => state.confirm !== "", "再次出现确认条");
	await clickInDocCard("确认拒绝");
	const view = await waitDocView((state) => state.tabs[0]?.text === "待修订 0", "拒绝后待修订归零");
	assert.equal(readFileSync(seededB.absPath, "utf8"), B_MANUAL, "拒绝整条不该改动文件");
	assert.equal((await win.evaluate(() => globalThis.kami.listDocEdits())).length, 0, "拒绝后建议应被删除");

	const empty = await waitDocView((state) => state.emptyTitle !== "", "队列清空后出现「都处理完了」空态");
	assert.equal(empty.emptyTitle, "待修订的建议都处理完了", "空态应区分「都处理完了」与「还没有建议」");
	assert.equal(view.tabs[0].active, true, "清空队列后仍停在「待修订」，由空态给出下一步");
	await h.shoot("doc-edit-workbench-empty");
});

/* ══════════════════════════════════════════════════════════════════════
 * docx 文本替换建议（#482）：显示旧→新 → 接受（真实 python 引擎）→ 可还原；
 * 以及「原文已变化 → 接受禁用、拒绝不碰文件」。
 *
 * 建议同样由 `buildDocxProposal` + `saveProposal` 直接落种子（与 #481 生成侧
 * 同一份实现），目标是夹具 a-styles.docx 的副本 —— 这样断言的是「这一处文字
 * 真的被换掉了」，而不是模型输出碰巧长成什么样。
 *
 * 接受要内置 python 运行时：本机没装时**显式 skip**（报告里看得见，退出码按
 * 有无通过判定），完整安装与覆盖在 #483 统一处理。展示与过期两段不需要 python。
 * ══════════════════════════════════════════════════════════════════════ */
const DOCX_FIXTURE = join(ROOT, "tests/fixtures/docx-revision/a-styles.docx");
const DOCX_NAME = "季度报告.docx";
/* 夹具正文里「本季度营收」是一个 run 内的纯文本（「跨 run 的文本」被拆开了，不能用）。 */
const DOCX_FIND = "本季度营收";
const DOCX_REPLACE = "本季度净收入";
let docxSeed;

function seedDocxEdit(at) {
	const absPath = join(h.WORKSPACE_DIR, DOCX_NAME);
	copyFileSync(DOCX_FIXTURE, absPath);
	const bytes = readFileSync(absPath);
	const proposal = buildDocxProposal({
		absPath,
		baseSha256: sha256Bytes(bytes),
		find: DOCX_FIND,
		replace: DOCX_REPLACE,
		part: DOCX_PART_DEFAULT,
		sessionId: "sess-doc-workbench-e2e",
		toolName: "docx_replace",
		at
	});
	saveProposal(proposal, { dir: DOC_EDITS_DIR });
	return { proposal, absPath, originalBytes: bytes };
}

await h.check("docx 建议：显示替换前/后与目标部件，没有逐段勾选", async () => {
	docxSeed = seedDocxEdit(Date.now());
	await clickReviewRefresh();
	const view = await waitDocView((state) => state.docx === true, "docx 建议卡渲染");
	await h.waitForSettled();
	await h.shoot("docx-workbench-light");

	assert.equal(view.cardName, DOCX_NAME, "右区应显示 docx 文件名");
	assert.equal(view.tabs[0]?.text, "待修订 1", "docx 建议应计入待修订");
	assert.deepEqual(view.rowStats, ["1 处替换"], "左列对 docx 应显示「1 处替换」，而不是「1 段 · +1 −1」");
	assert.equal(view.docxPart, `目标部件：${DOCX_PART_DEFAULT}`, "应显示目标部件");
	assert.ok(view.docxBefore.includes(DOCX_FIND), `「替换前」没有旧文字：${JSON.stringify(view.docxBefore)}`);
	assert.ok(view.docxAfter.includes(DOCX_REPLACE), `「替换后」没有新文字：${JSON.stringify(view.docxAfter)}`);
	/* 前后不只靠底色：符号与读屏前缀是第二、第三通道。 */
	assert.equal(view.docxBeforeSign, "−");
	assert.equal(view.docxBeforeSr, "替换前：");
	assert.equal(view.docxAfterSign, "+");
	assert.equal(view.docxAfterSr, "替换后：");
	assert.match(view.docxNote, /v1 只替换正文里这一处文字/);
	assert.match(view.docxNote, /不保留 Word 原生修订痕迹/);
	assert.equal(view.hasCheckbox, false, "docx 建议不该出现逐段勾选框");
	assert.equal(view.hunkToolButtons, 0, "docx 建议不该有全选 / 全不选");
	const accept = view.actions.find((action) => action.text === "接受替换（1 处）");
	assert.ok(accept !== undefined, `接受按钮文案不对：${JSON.stringify(view.actions)}`);
	assert.equal(accept.disabled, false, "未过期时应可接受");

	await setTheme("dark");
	await h.waitForSettled();
	await h.shoot("docx-workbench-dark");
	await setTheme("light");
});

await h.check("docx 建议：接受后正文被替换、建议消失、版本可还原", async () => {
	const label = "docx 建议：接受后正文被替换、建议消失、版本可还原";
	const py = await win.evaluate(async () => {
		const s = await globalThis.kami.runtimesSnapshot();
		const item = (s?.items ?? []).find((x) => x.id === "python");
		return { kind: item?.status?.kind, exe: item?.executable };
	});
	if (py.kind !== "ready" || !py.exe) {
		h.skip(label, `Python 运行时未就绪（${py.kind ?? "未知"}）：docx 接受需要内置运行时，本机未安装时这条不跑（#483 统一处理安装与全覆盖）`);
	}

	await clickInDocCard("接受替换（1 处）");
	const afterBytes = await waitUntil(
		() => {
			try {
				const now = readFileSync(docxSeed.absPath);
				return sha256Bytes(now) !== sha256Bytes(docxSeed.originalBytes) ? now : null;
			} catch {
				return null;
			}
		},
		{ timeout: 60_000, interval: 300, desc: "接受后目标 docx 的字节发生变化" }
	);
	assert.ok(afterBytes.length > 0, "接受后文件不该为空");

	/*
	 * 「队列清空」与「toast 出现」是两件事：分两次等会让断言读到空州先到、
	 * toast 还没挂上的那一帧（spec/testing §4 的真实教训）。放进同一个完成条件。
	 */
	const view = await waitDocView(
		(state) =>
			state.emptyTitle !== "" &&
			state.toasts.some((text) => text.includes(`已替换「${DOCX_NAME}」正文中的 1 处文字`)),
		"接受后队列清空且 toast 说明替换了 1 处文字"
	);
	assert.ok(
		view.toasts.some((text) => text.includes(`已替换「${DOCX_NAME}」正文中的 1 处文字`)),
		`toast 应说明替换了 1 处文字：${JSON.stringify(view.toasts)}`
	);
	assert.deepEqual(await win.evaluate(() => globalThis.kami.listDocEdits()), [], "接受后建议应被删除");

	/* 解压 word/document.xml 直接看正文：文字真的被换掉了，而不只是「没报错」。 */
	const script = [
		"import json,sys,zipfile",
		'x=zipfile.ZipFile(sys.argv[1]).read("word/document.xml").decode("utf-8")',
		'print(json.dumps({"find": sys.argv[2] in x, "replace": sys.argv[3] in x}))'
	].join("\n");
	const { stdout } = await runFile(py.exe, ["-c", script, docxSeed.absPath, DOCX_FIND, DOCX_REPLACE], {
		encoding: "utf8",
		timeout: 60_000
	});
	const probed = JSON.parse(stdout.trim().split("\n").pop());
	assert.equal(probed.find, false, "替换前的文字仍在正文里");
	assert.equal(probed.replace, true, "替换后的文字没有写进正文");

	/* 版本可还原：接受前的那一版是二进制快照，逐字节还原后应等于原夹具副本。 */
	const history = await win.evaluate(() => globalThis.kami.listFileHistory());
	const file = history.files.find((entry) => entry.path === docxSeed.absPath);
	assert.ok(file, "文件历史里没有接受 docx 之前留下的版本");
	const detail = await win.evaluate(({ key }) => globalThis.kami.readFileHistory({ key }), { key: file.key });
	assert.equal(detail?.ok, true, `读版本详情失败：${JSON.stringify(detail)}`);
	const oldest = (detail.versions ?? [])[0];
	assert.ok(oldest !== undefined, "接受前没有留下版本记录");
	const restored = await win.evaluate(
		({ key, id }) => globalThis.kami.restoreFileHistory({ key, id }),
		{ key: file.key, id: oldest.id }
	);
	assert.equal(restored?.ok, true, `还原失败：${JSON.stringify(restored)}`);
	assert.deepEqual(readFileSync(docxSeed.absPath), docxSeed.originalBytes, "还原后字节不等于接受前");
});

await h.check("docx 建议：原文已变化 → 接受禁用、拒绝整条不碰文件", async () => {
	const seeded = seedDocxEdit(Date.now() + 1_000);
	/* 手动在副本尾部追加一个字节 —— zip 结构不变但字节哈希变了，正是哈希守卫的判据。 */
	const changedBytes = Buffer.concat([readFileSync(seeded.absPath), Buffer.from([0])]);
	writeFileSync(seeded.absPath, changedBytes);
	await clickReviewRefresh();

	const stale = await waitDocView(
		(state) => state.docx === true && state.stale === true,
		"docx 建议刷新后出现「原文已变化」"
	);
	assert.match(stale.staleText, /原文已变化/, `过期条文案不对：${JSON.stringify(stale.staleText)}`);
	assert.match(stale.staleText, /重新生成/, "过期条要给「重新生成」指引");
	const accept = stale.actions.find((action) => action.text.startsWith("接受替换"));
	assert.ok(accept !== undefined, "过期时仍应显示接受按钮（禁用而不是消失）");
	assert.equal(accept.disabled, true, "过期时 docx 接受按钮必须禁用");
	await h.shoot("docx-workbench-stale");

	await clickInDocCard("拒绝整条");
	await waitDocView((state) => state.confirm !== "", "docx 拒绝的二次确认条出现");
	await clickInDocCard("确认拒绝");
	await waitDocView((state) => state.tabs[0]?.text === "待修订 0", "拒绝后待修订归零");
	assert.deepEqual(readFileSync(seeded.absPath), changedBytes, "拒绝整条不该改动文件字节");
	assert.equal((await win.evaluate(() => globalThis.kami.listDocEdits())).length, 0, "拒绝后建议应被删除");
});

await mock.close();
await h.finish();
