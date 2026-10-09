/**
 * Agent 团队端到端测试：`team_create` → 成员以**独立长会话**后台起跑 → 产出落盘。
 *
 * 补的是一处零覆盖：团队（`team_create` / `team_send` / `team_read` …）是应用的
 * 头牌能力之一，此前**没有任何测试调用过它**。
 *
 * 有两个容易漏掉的前提，测试里都显式处理了：
 *
 *   ① **团队工具只在「Agent 团队」开启时才注册**（工厂里有 `if (!deps.isEnabled()) return;`）
 *      —— 默认关着，不先打开就根本调不到。
 *   ② `team_create` **不等成员完成**（它自己说「本工具不等它们完成」）：成员在后台跑，
 *      产出留在**自己的会话记录**里，要 `team_read` 才取回。
 *      所以断言不能只看「工具被调用了」，得等成员那轮真的跑完。
 *
 * 做法（确定性，用 mock 模型）：mock 按内容特征分流 ——
 *   - 带**成员任务文本**、且**没有工具结果** ⇒ 成员会话的首轮 → 返回成员标记；
 *   - 带 `role:"tool"` ⇒ 主代理收尾轮 → 返回最终文本；
 *   - 其余（第一条）⇒ 主代理首轮 → 返回 `team_create` 工具调用。
 *
 * 「没有工具结果」这个条件是必须的：主代理收尾轮里也带着成员任务文本
 * （它在 `team_create` 的 toolCall 参数里），只靠文本分不开两方。
 *
 * 断言：**成员会话真的跑起来了、产出落到自己的会话文件里、且与主代理上下文隔离**
 * （直接读 sessions 目录的 JSONL，认 `team_member` 记录 + 成员的 assistant 回复），
 * 以及主代理收尾正常。
 *
 * 迁移说明（共享 harness）：骨架（清隔离目录、启动并等到就绪、check 收集器、
 * 末尾报告与退出码）全部来自 `./lib/harness.mjs`。启动不再固定等 9 秒；
 * 「发送后等 3 秒」改为等 **mock 真的收到请求**；四处 `for + sleep` 轮询
 * 分别换成 `waitUntil`（成员那一轮、成员会话落盘、自动投递快照、team_read 回执）
 * 与页面探针封装；最终回复的截图换成带像素断言的 `h.shoot`。
 *
 * ⚠️ 这里**刻意不用** `h.waitForSettled()`：断言全部发生在**模型回合进行中**，
 * 而回合中界面有 500ms 级的计时器在刷新（时长显示、等待提示轮播），
 * 永远达不到「800ms 静默」——用了只会等到超时。
 *
 * ⚠️ 最后两条（`<team_output>` 自动投递、`team_read` 取回）曾经会**假失败**，
 * 根因不在用例，而在 `src/main/daemon/mailbox.js` 的 `memberSessionPath()` ——
 * 会话文件的目录索引带 1000ms 的 TTL（`SESSION_FILE_INDEX_TTL_MS`），
 * 且**命中失败时不会重建**：只要成员 spawn 时的某次读取把索引建在
 * 「成员会话文件还不存在」之前，接下来 1 秒内的所有读取都会解析不到该文件，于是
 * `readMemberTranscriptView().output === undefined` → 自动投递不注入、
 * team_read 回一句「成员「scout1」暂无产出可读」。
 *
 * **该缺陷已在产品侧修掉**（索引未命中时重建一次目录索引，不再是负缓存），
 * 回归防线在单测 `tests/unit/mailbox-session-index.test.mjs`
 * （文件落盘后**立刻**读，不 sleep、不等 TTL）。这两条之所以留在 e2e 里，
 * 是因为它们同时覆盖了「自动投递真的注入了领导请求」这层端到端行为。
 * **用例侧永远不要加回 sleep** —— 那只是把窗口盖住。
 *
 * 历史：迁移前这条用例之所以是绿的，是因为它把「发送第二条消息」压在**固定 3 秒**
 * 之后，3s > 1s 的 TTL —— 固定等待恰好跨过了这个窗口。按本仓库「用信号等待」的
 * 规范去掉固定等待后，修复前实测 8/10（恰好是上面两条红），修复后 10/10。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const TEAM_NAME = "探针团队";
const MEMBER_NAME = "scout1";
// 注意：任务文本里**不能**内嵌成员标记。
// 否则「会话文件里含标记」会被成员那条**用户消息**（= 任务本身）满足，
// 断言就成了空断言 —— 成员哪怕一个字没回也照样通过。
const MEMBER_TASK = "你是侦察兵：确认收到后只回复一行确认标记，不要写别的字。";
const MEMBER_MARK = "TEAM_MEMBER_OK_9183";
const FINAL_TEXT = "TEAM_CREATE_DONE";

// 第二段：成员的产出**不会自动送到领导那里**，要主动 team_read 取回。
// 这条回收链路是团队功能的日常用法，单独验一遍。
const READ_REQUEST = "把成员的产出读回来汇总一下";
const FINAL_TEXT_2 = "TEAM_READ_DONE";

function startMockModel() {
	const requests = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			let parsed;
			try {
				parsed = JSON.parse(body);
			} catch {
				parsed = undefined;
			}
			// 同时留 body（解析后，用于**读文本内容**）与 raw（原始文本，用于**快速找候选轮**）。
			// 注意别拿 raw 去匹配含引号的片段 —— body 是 JSON，里面的引号是转义的（`\"`）。
			requests.push({ url: req.url, body: parsed, raw: body });

			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const send = (delta, finish) => {
				const chunk = { id: "chatcmpl-team", object: "chat.completion.chunk", choices: [{ index: 0, delta }] };
				if (finish !== undefined) chunk.choices[0].finish_reason = finish;
				res.write(`data: ${JSON.stringify(chunk)}\n\n`);
			};
			const asText = (s) => {
				for (const chunk of s.match(/.{1,8}/gu) ?? []) send({ content: chunk });
				send({}, "stop");
			};

			send({ role: "assistant", content: "" });
			const msgs = parsed?.messages ?? [];
			const flat = JSON.stringify(msgs);

			const hasToolResult = msgs.some((m) => m.role === "tool");
			const toolResultCount = msgs.filter((m) => m.role === "tool").length;
			// 成员会话 = **隔离上下文**：首轮只有那份任务，且没有任何工具结果。
			// 主代理的收尾轮虽然也带着任务文本（在 team_create 的 toolCall 参数里），
			// 但它有 role:"tool"，用这一条把两者分开。
			const isMemberTurn = flat.includes(MEMBER_TASK) && !hasToolResult;
			// 不能用「最后一条 user 消息」判断用户说了什么 —— 请求里排在最后的是
			// 运行时快照（`<system-reminder data-role="additional-data">`），
			// 用户真正说的话在它前面。所以在**全部** user 消息里找。
			const anyUserText = msgs
				.filter((m) => m.role === "user")
				.map((m) => JSON.stringify(m.content ?? ""))
				.join("\n");
			const askedForRead = anyUserText.includes(READ_REQUEST);

			if (isMemberTurn) {
				// 成员的第一轮 → 回答标记
				asText(MEMBER_MARK);
			} else if (askedForRead && toolResultCount < 2) {
				// 领导被要求取回产出 → 调 team_read
				send({
					tool_calls: [
						{
							index: 0,
							id: "call_team_read",
							type: "function",
							function: { name: "team_read", arguments: JSON.stringify({ to: MEMBER_NAME }) },
						},
					],
				});
				send({}, "tool_calls");
			} else if (askedForRead) {
				asText(FINAL_TEXT_2);
			} else if (hasToolResult) {
				// 主代理拿回了 team_create 的回执 → 收尾
				asText(FINAL_TEXT);
			} else if (requests.length === 1) {
				send({
					tool_calls: [
						{
							index: 0,
							id: "call_team_1",
							type: "function",
							function: {
								name: "team_create",
								arguments: JSON.stringify({
									name: TEAM_NAME,
									members: [{ name: MEMBER_NAME, agent: "scout", task: MEMBER_TASK }],
								}),
							},
						},
					],
				});
				send({}, "tool_calls");
			} else {
				asText(FINAL_TEXT);
			}
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	return new Promise((ok) => {
		server.listen(0, "127.0.0.1", () =>
			ok({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests, close: () => new Promise((r) => server.close(r)) }),
		);
	});
}

const h = createHarness({ name: "team" });
const SESSIONS_DIR = join(h.CONFIG_DIR, "sessions");
// harness 负责隔离与清空工作区根目录，目录本身要由用例建出来
mkdirSync(h.WORKSPACE_DIR, { recursive: true });

const mock = await startMockModel();
console.log(`✓ mock 模型服务已就绪：${mock.baseUrl}`);

await h.launch();
const win = h.window();

await h.snap("home");

// ── 会话文件读取（两段共用）──────────────────────────────
const readSessions = () =>
	(existsSync(SESSIONS_DIR) ? readdirSync(SESSIONS_DIR).filter((x) => x.endsWith(".jsonl")) : []).map((f) => {
		const lines = readFileSync(join(SESSIONS_DIR, f), "utf8").trim().split("\n");
		const records = lines.flatMap((l) => {
			try {
				return [JSON.parse(l)];
			} catch {
				return [];
			}
		});
		return { file: f, records };
	});

const byRole = (recs, role) =>
	recs
		.filter((r) => r.type === "message" && r.message?.role === role)
		.flatMap((r) => r.message.content ?? [])
		.filter((c) => c.type === "text" || c.type === "toolResult" || typeof c.text === "string")
		.map((c) => c.text ?? "")
		.join("\n");

const assistantText = (recs) => byRole(recs, "assistant");
const toolResultText = (recs) => byRole(recs, "toolResult");

let memberFile = undefined; // 成员会话文件名（第一段确定，第二段复用）

/** 等 mock 收到第 n 轮请求 —— 「模型真的被调到了」是比固定等待可靠的信号。 */
async function waitForRounds(n, why) {
	try {
		await waitUntil(() => mock.requests.length >= n, {
			timeout: 40_000,
			interval: 500,
			desc: `mock 收到第 ${n} 轮请求`,
		});
	} catch (error) {
		throw new Error(`mock 只收到 ${mock.requests.length} 轮请求（期望 ≥${n}）—— ${why}（${error.message}）`, { cause: error });
	}
}

/**
 * 在页面里轮询探针，直到它报告 `found`。
 *
 * 取代原来「在页面里 for 循环 + sleep」的写法：截止时间交给 `waitUntil` 统一管，
 * 慢机器不假失败、快机器不白等；超时时把**页面尾部内容**带进错误里，
 * 失败信息才能直接看出界面上到底有什么。
 */
async function waitForFound(desc, probe, { arg, timeout = 30_000 } = {}) {
	let last = null;
	try {
		return await waitUntil(
			async () => {
				last = await win.evaluate(probe, arg);
				return last?.found ? last : null;
			},
			{ timeout, interval: 500, desc },
		);
	} catch (error) {
		throw new Error(`${error.message}；界面尾部：${String(last?.sample ?? "(未取到)").slice(-300)}`, { cause: error });
	}
}

// 团队/成员执行时会请求权限；全部放行，否则用例会卡在权限确认上
await win.evaluate(() => {
	const k = globalThis.kami;
	if (typeof k.onPermissionRequest === "function") {
		k.onPermissionRequest((req) => {
			try {
				k.respondToPermission({ id: req.id, decision: "allow" });
			} catch {
				/* 忽略 */
			}
		});
	}
});

await h.check("配置 mock 模型、工作区，并**开启 Agent 团队**", async () => {
	// 团队工具只在开关打开时才注册（工厂里 `if (!deps.isEnabled()) return;`），
	// 不先打开就根本调不到 —— 这一步是前提，不是可选项。
	const r = await win.evaluate(
		async ({ baseUrl, ws }) => {
			const k = globalThis.kami;
			try {
				await k.saveCustomProvider(
					{
						id: "mock-team",
						name: "Mock Team",
						baseUrl,
						api: "openai-completions",
						authHeader: true,
						models: [{ id: "team-model", name: "team-model", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }],
					},
					"mock-key",
				);
				await k.setModel("mock-team/team-model");
				await k.setWorkspace(ws);
				await k.setAgentTeamsEnabled(true);
				return { ok: true, teamsEnabled: await k.getAgentTeamsEnabled() };
			} catch (e) {
				return { ok: false, err: String(e?.message ?? e).slice(0, 200) };
			}
		},
		{ baseUrl: mock.baseUrl, ws: h.WORKSPACE_DIR },
	);
	assert.ok(r.ok, `配置失败：${r.err}`);
	const enabled = typeof r.teamsEnabled === "object" ? r.teamsEnabled.enabled : r.teamsEnabled;
	assert.equal(enabled, true, `Agent 团队开关没打开：${JSON.stringify(r.teamsEnabled)}`);
});

await h.check("在输入框里输入并发送（走真实 UI 路径）", async () => {
	const box = win.locator('[aria-label="消息输入框"]');
	await box.waitFor({ state: "visible", timeout: 30_000 });
	await box.fill("请建一个团队把这件事办了");
	await box.press("Enter");
	// 原来是固定等 3 秒。改成等 mock 真收到请求 —— 发送有没有走通，这是直接证据
	await waitForRounds(1, "消息没有发出去");
});

await h.check("成员会话真的被起了（mock 收到带成员任务的那一轮）", async () => {
	await waitForRounds(3, "建团可能只发了工具调用、没真起成员会话");
	// 成员那一轮的判据同 mock：带任务文本、且**没有任何工具结果**
	// （主代理的收尾轮也带着任务文本，但它在 team_create 的 toolCall 参数里）。
	const memberReq = mock.requests.find((r) => {
		const msgs = r.body?.messages ?? [];
		return JSON.stringify(msgs).includes(MEMBER_TASK) && !msgs.some((m) => m.role === "tool");
	});
	assert.ok(
		memberReq,
		`没看到成员会话的请求 —— 建团可能只发了工具调用。共收到 ${mock.requests.length} 轮`,
	);
	console.log(`      成员那轮消息数 ${(memberReq.body?.messages ?? []).length}（独立长会话）`);
});

await h.check("成员的产出落到它自己的会话文件里（真的跑完了）", async () => {
	// `team_create` **不等成员完成**，产出留在成员自己的会话记录里。
	// 所以直接读 sessions 目录的 JSONL —— 这是「成员真的跑完」最硬的证据。
	//
	// 断言落在**成员那条 assistant 消息**上，而不是「文件里出现过这串字符」：
	// 后者会被任何一处提及满足，等于什么都没验。同时认 `team_member` 记录，
	// 确认这确实是**成员自己的**会话，不是主代理把任务回显了一遍。
	let all = [];
	let member;
	try {
		member = await waitUntil(
			() => {
				all = readSessions();
				return (
					all.find(
						(s) =>
							s.records.some((r) => r.type === "custom" && r.customType === "team_member" && r.data?.member === MEMBER_NAME) &&
							assistantText(s.records).includes(MEMBER_MARK),
					) ?? null
				);
			},
			{ timeout: 40_000, interval: 1_000, desc: `出现「标记为 ${MEMBER_NAME} 的成员会话 + 它的 assistant 回复含 ${MEMBER_MARK}」` },
		);
	} catch (error) {
		throw new Error(
			`没找到「标记为 ${MEMBER_NAME} 的成员会话 + 它的 assistant 回复含 ${MEMBER_MARK}」的组合 —— ` +
				`成员没跑完、产出没落盘，或落盘的不是成员自己的会话。现有会话文件：\n` +
				all
					.map((s) => `  ${s.file}: 记录 ${s.records.length} 条，assistant 文本 ${JSON.stringify(assistantText(s.records).slice(0, 80))}`)
					.join("\n") +
				`（${error.message}）`,
			{ cause: error },
		);
	}
	memberFile = member.file;
	const size = readFileSync(join(SESSIONS_DIR, member.file), "utf8").length;
	console.log(`      成员会话 ${member.file}（${size} 字节）的回复里含标记 ${MEMBER_MARK}`);

	// 反向确认：主代理自己的会话里**不该**出现这个标记 ——
	// 出现了说明它俩其实是同一个上下文，成员并没有真正独立。
	const others = all.filter((s) => s.file !== member.file);
	assert.ok(others.length >= 1, "只看到一个会话文件 —— 成员没有独立会话（和主代理挤在一起了）");
	for (const s of others) {
		assert.ok(
			!assistantText(s.records).includes(MEMBER_MARK),
			`主代理会话 ${s.file} 的 assistant 消息里也出现了成员标记 —— 两者的上下文没隔离`,
		);
	}
	console.log(`      主代理与成员各有独立会话（共 ${all.length} 个），上下文未串`);
});

await h.check("主代理收尾正常（最终回复渲染到界面上）", async () => {
	const r = await waitForFound(
		"界面上出现最终回复",
		(mark) => {
			const text = document.body.innerText || "";
			return text.includes(mark) ? { found: true } : { found: false, sample: text.slice(-200) };
		},
		{ arg: FINAL_TEXT, timeout: 25_000 },
	);
	// 先截图、后断言：主代理收尾这一屏先留现场
	await h.shoot("final-reply");
	assert.ok(r.found, `界面上找不到最终回复 ${FINAL_TEXT}。尾部：${r.sample}`);
});

await h.check("团队状态可读（建团后团队登记存在）", async () => {
	const r = await win.evaluate(async () => {
		try {
			const s = await globalThis.kami.snapshot();
			return { ok: true, hasTeam: JSON.stringify(s).includes("探针团队") };
		} catch (e) {
			return { ok: false, err: String(e?.message ?? e).slice(0, 160) };
		}
	});
	assert.ok(r.ok, `会话快照不可读：${r.err}`);
	assert.ok(r.hasTeam, "会话快照里找不到刚建的团队（团队登记没进去）");
});

await h.check("领导下一轮会**自动**收到未见过的成员产出（<team_output> 快照）", async () => {
	// 第二段先验**自动投递**：成员产出不必等领导主动取 —— 领导的下一次请求里
	// 就会带上 `<team_output team="…"><member_output member="…">` 快照，
	// 且按内容指纹去重（同一份产出只投一次）。
	//
	// 这条与产品文案不符：工具描述、promptSnippet 与 4 份专家人设都写着
	// 「产出不会自动送到你这里」。实际实现是**延迟到下一轮自动投递**（超长截断，
	// 提示用 team_read 取全文）。文案与行为的这处出入已记入 EXTERNAL_REQUESTS.md
	// 的待审计项，此处只如实断言**观测到的行为**。
	//
	// 断言落在 mock 收到的**请求体**上 —— 那正是「产出进了领导上下文」的直接证据，
	// 不用靠我们的推测。
	const box = win.locator('[aria-label="消息输入框"]');
	await box.waitFor({ state: "visible", timeout: 30_000 });
	await box.fill(READ_REQUEST);
	await box.press("Enter");

	let injected;
	try {
		injected = await waitUntil(
			() => mock.requests.find((r) => r.raw.includes("<team_output") && r.raw.includes(MEMBER_MARK)) ?? null,
			{
				timeout: 40_000,
				interval: 500,
				desc: "领导的请求里出现含成员产出的 <team_output> 快照（自动投递没发生？）",
			},
		);
	} catch (error) {
		throw new Error(
			`领导的请求里没看到含成员产出的 <team_output> 快照 —— 自动投递没发生。` +
				`共 ${mock.requests.length} 轮请求（${error.message}）`,
			{ cause: error },
		);
	}
	// 断言用**解析后的消息文本**（模型真正读到的内容），不用原始 JSON 文本 ——
	// 后者里引号是转义的（`\"`），拿含引号的片段去匹配会一直匹配不到。
	const injectedText = (injected.body?.messages ?? [])
		.map((m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => c.text ?? "").join("\n")))
		.join("\n");
	assert.ok(
		injectedText.includes(`<member_output member="${MEMBER_NAME}">`),
		`快照里没有 <member_output member="${MEMBER_NAME}"> 段落：` +
			`${injectedText.slice(Math.max(0, injectedText.indexOf("<team_output")), injectedText.indexOf("<team_output") + 300)}`,
	);
	console.log(`      <team_output> 快照已随领导请求投递（含 ${MEMBER_NAME} 的产出正文）`);
});

await h.check("team_read 也能显式取回同一份产出正文", async () => {
	// 自动投递之外，`team_read` 仍是有用的显式路径（快照超长会被截断，
	// 截断提示就写着「全文用 team_read 取回」）。这条验它确实返回**成员正文**。
	const leaderToolTexts = () => readSessions().filter((s) => s.file !== memberFile).map((s) => toolResultText(s.records));
	let leaderToolText;
	try {
		leaderToolText = await waitUntil(() => leaderToolTexts().find((t) => t.includes(MEMBER_MARK)) ?? null, {
			timeout: 40_000,
			interval: 1_000,
			desc: `领导会话的工具结果里出现成员产出 ${MEMBER_MARK}（team_read 没取回正文？）`,
		});
	} catch (error) {
		leaderToolText = leaderToolTexts().join("\n");
		throw new Error(
			`领导会话的工具结果里找不到成员产出 ${MEMBER_MARK} —— team_read 没取回正文。` +
				`领导会话工具结果尾部：${JSON.stringify(leaderToolText.slice(-200))}（${error.message}）`,
			{ cause: error },
		);
	}
	// 取回的是**成员正文**，不是一句「已读取」的空回执
	assert.ok(
		leaderToolText.includes(`成员「${MEMBER_NAME}」的产出`),
		`取回的文本不是 team_read 的产出正文格式：${JSON.stringify(leaderToolText.slice(0, 200))}`,
	);
	console.log(`      team_read 回执含成员正文（toolResult ${leaderToolText.length} 字符）`);
});

await h.check("取回后主代理收尾正常（渲染到界面上）", async () => {
	const r = await waitForFound(
		"界面上出现取回后的最终回复",
		(mark) => {
			const text = document.body.innerText || "";
			return text.includes(mark) ? { found: true } : { found: false, sample: text.slice(-200) };
		},
		{ arg: FINAL_TEXT_2, timeout: 25_000 },
	);
	// 先截图、后断言：取回这一段收尾这一屏也留现场
	await h.shoot("team-read-reply");
	assert.ok(r.found, `界面上找不到取回后的最终回复 ${FINAL_TEXT_2}。尾部：${r.sample}`);
});

await h.check("无渲染层未捕获异常", () => assert.equal(h.pageErrors.length, 0, h.pageErrors.join("; ")));

// 先关应用再关 mock：应用一关，daemon 与 mock 之间的长连接才会断开，
// server.close() 才不会一直等在那儿（原实现的顺序就是这样）。
await h.app().close();
await mock.close();
console.log(`（mock 共收到 ${mock.requests.length} 轮请求）`);
await h.finish();
