/**
 * 修订模式底座（#456）的真实 Electron 用例：开启后 write 不落盘、建议可读、
 * 模型收到「不要原样重试」、工具卡与轨迹显示成待审而不是失败、关闭后状态撤下。
 *
 * 这里守的是「只有真跑起来才暴露」的接线：工具拦截在 daemon、状态推送经宿主、
 * 卡片状态在渲染层 —— 任何一处对不上，单测都是绿的。逐条接受/拒绝与写回的
 * 完整五条路径由 #459 在这个文件上扩展。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHarness, waitUntil } from "./lib/harness.mjs";

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
			if (!hasToolResult && requests.length === 1) {
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

await mock.close();
await h.finish();
