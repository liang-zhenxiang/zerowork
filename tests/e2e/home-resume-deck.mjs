/**
 * 首页「继续推进」续摊卡的核心增量端到端测试。
 *
 * gui-recent.mjs 已锁住「空态不渲染 / 出现 / 点击恢复 / 双主题」这条路径(选择器
 * 已随类名迁移过去);本文件只锁**本次新增的东西**——卡上那句「干到哪了」:
 *
 *   ① delivered 态:会话以交付收尾(present_files 后模型无文本)→ 摘要「已交付 …」;
 *   ② text 态:会话以文本收尾 → 摘要是末句;
 *   ③ fallback 态:纯工具流、无交付无文本 → 「最近 N 轮对话」(错误态不伪装成加载态);
 *   ④ running 链路:回合进行中回首页 → 卡带 is-running 与「进行中」文字;
 *      回合收尾后(sessionListPush → 重拉 digest)→ 信号消失、摘要为终态。
 *
 * mock 按每条会话的**首条 user 消息关键词**路由剧本(交付/静默/挂起/其他),
 * 不数请求数——多会话并发时请求数不可靠,消息内容才是会话身份。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

/** 各剧本的收尾标记(终态摘要里应出现的文本;静默剧本没有文本,用标记占位于注脚断言)。 */
const DELIVERED_FILE = "Q3-复盘.md";
const TEXT_TAIL = "复盘完成,收入增长 18%,详见交付文件";
const SILENT_NOTE = "note.txt";
const HANG_TASK = "挂起模式下帮我整理数据";

function startMockModel() {
	const requests = [];
	let callSeq = 0;
	/** 剧本 D 的放行闸:挂起响应的 res 暂存,外部 release() 后才写流。 */
	let pendingRes = null;
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
			requests.push({ url: req.url, body: parsed });
			// 首条 user 消息的文本:content 可能是字符串,也可能是分段数组
			// (UI 实发形态;第一版只按字符串取,剧本匹配全落空——所有会话都走了
			// 兜底分支,这是本文件首轮真跑抓出来的)。
			const firstUser = (parsed?.messages ?? []).find((m) => m.role === "user")?.content ?? "";
			const firstText = typeof firstUser === "string"
				? firstUser
				: Array.isArray(firstUser)
					? firstUser.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
					: "";
			const toolResults = (parsed?.messages ?? []).filter((m) => m.role === "tool").length;

			if (firstText.includes("挂起") && toolResults === 0 && pendingRes === null) {
				// 剧本 D:第一响应挂起,等外部放行(测试在首页断言完 running 态后 release)。
				pendingRes = res;
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const send = (delta, finish) => {
				const chunk = { id: "chatcmpl-deck", object: "chat.completion.chunk", choices: [{ index: 0, delta }] };
				if (finish !== undefined) chunk.choices[0].finish_reason = finish;
				res.write(`data: ${JSON.stringify(chunk)}\n\n`);
			};
			const callTool = (name, args) => {
				callSeq += 1;
				send({ tool_calls: [{ index: 0, id: `call_${name}_${callSeq}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
				send({}, "tool_calls");
			};
			send({ role: "assistant", content: "" });

			if (firstText.includes("交付")) {
				// 剧本 A:交付后**无文本收尾**(空 stop)→ delivered 态。
				if (toolResults === 0) callTool("present_files", { files: [resolve(WORKSPACE_DIR, DELIVERED_FILE)], explanation: "复盘交付" });
				else send({}, "stop");
			} else if (firstText.includes("静默")) {
				// 剧本 B:只读文件、无交付无文本 → fallback 态。
				if (toolResults === 0) callTool("read", { path: SILENT_NOTE });
				else send({}, "stop");
			} else if (firstText.includes("挂起")) {
				// 剧本 D 放行后的收尾:交付 + 文本(终态摘要取末句文本)。
				if (toolResults === 0) callTool("present_files", { files: [resolve(WORKSPACE_DIR, DELIVERED_FILE)], explanation: "数据已整理" });
				else {
					for (const c of "整理完成,数据表已生成".match(/.{1,6}/gu) ?? []) send({ content: c });
					send({}, "stop");
				}
			} else {
				// 剧本 C:纯文本两轮。
				for (const c of TEXT_TAIL.match(/.{1,6}/gu) ?? []) send({ content: c });
				send({}, "stop");
			}
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	return new Promise((ok) => {
		server.listen(0, "127.0.0.1", () =>
			ok({
				baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
				requests,
				release: () => {
					const res = pendingRes;
					pendingRes = null;
					if (res === null) return;
					res.writeHead(200, { "content-type": "text/event-stream" });
					res.write(`data: ${JSON.stringify({ id: "chatcmpl-deck", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "" } }] })}\n\n`);
					res.write(`data: ${JSON.stringify({ id: "chatcmpl-deck", object: "chat.completion.chunk", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_hang_${Date.now()}`, type: "function", function: { name: "present_files", arguments: JSON.stringify({ files: [resolve(WORKSPACE_DIR, DELIVERED_FILE)] }) } }] }, finish_reason: "tool_calls" }] })}\n\n`);
					res.write("data: [DONE]\n\n");
					res.end();
				},
			})
		);
	});
}

const h = createHarness({ name: "home-resume-deck" });
const WORKSPACE_DIR = h.WORKSPACE_DIR;
mkdirSync(WORKSPACE_DIR, { recursive: true });
writeFileSync(resolve(WORKSPACE_DIR, DELIVERED_FILE), "# Q3 复盘\n\n收入增长 18%。\n", "utf8");
writeFileSync(resolve(WORKSPACE_DIR, SILENT_NOTE), "静默剧本的预置文件\n", "utf8");

const mock = await startMockModel();
console.log(`✓ mock 模型服务已就绪:${mock.baseUrl}`);

await h.launch();
const win = h.window();

await h.check("注册指向 mock 的 provider 并切模型", async () => {
	const r = await win.evaluate(async ({ baseUrl, ws }) => {
		const k = globalThis.kami;
		try {
			await k.saveCustomProvider(
				{
					id: "mock-deck",
					name: "Mock Deck",
					baseUrl,
					api: "openai-completions",
					authHeader: true,
					models: [{ id: "deck-model", name: "deck-model", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }]
				},
				"mock-key"
			);
			await k.setModel("mock-deck/deck-model");
			await k.setWorkspace(ws);
			return { ok: true };
		} catch (e) {
			return { ok: false, err: String(e?.message ?? e).slice(0, 200) };
		}
	}, { baseUrl: mock.baseUrl, ws: WORKSPACE_DIR });
	assert.ok(r.ok, `配置失败:${r.err}`);
});

/** 发一条消息。回合收尾不在此处等——终态信号就是首页卡上的摘要本身(被测物),
 *  由各断言里的 waitForDeck 轮询;在会话视图里等正文标记会把「标记形态」(工具卡
 *  怎么渲染路径)耦合进来,那不是本文件要锁的东西。 */
async function sendTurn(prompt) {
	const box = win.locator('[aria-label="消息输入框"]');
	await box.waitFor({ state: "visible", timeout: 30_000 });
	await box.fill(prompt);
	await box.press("Enter");
}

/** 回首页后发消息会**继续 current 会话**(产品语义:回来再发=接着刚才的活干,
 *  与「继续推进」同一心智)。本文件要的是三个独立会话各验一种摘要态,
 *  所以每个剧本前先 newTask() 清掉 current,让首页输入框开新会话。 */
async function startFreshSession() {
	await win.evaluate(() => globalThis.kami.newTask());
}

async function backHome() {
	await waitUntil(() => win.evaluate(() => document.querySelector('[aria-label="返回首页"]') !== null), { timeout: 30_000, desc: "进入会话视图" });
	await win.evaluate(() => document.querySelector('[aria-label="返回首页"]').click());
	await waitUntil(() => win.evaluate(() => document.querySelector(".home") !== null), { timeout: 30_000, desc: "回到首页" });
}

/** 取首页续摊卡的投影(标题/摘要/注脚/运行态),供断言与失败诊断。 */
function deckProbe() {
	return win.evaluate(() => {
		const deck = document.querySelector(".home-resume");
		if (deck === null) return { present: false };
		const cards = [...deck.querySelectorAll(".home-resume-card")];
		return {
			present: true,
			cards: cards.map((card) => ({
				title: (card.querySelector(".home-resume-title")?.textContent ?? "").trim(),
				digest: (card.querySelector(".home-resume-digest")?.textContent ?? "").trim(),
				meta: (card.querySelector(".home-resume-meta")?.textContent ?? "").replace(/\s+/g, " ").trim(),
				running: card.classList.contains("is-running"),
				liveText: (card.querySelector(".home-resume-live")?.textContent ?? "").trim(),
				// 骨架态的探测:Skeleton 是纯 style 的 span(无类名),摘要位无文本即骨架。
				digestEmpty: (card.querySelector(".home-resume-digest")?.textContent ?? "").trim() === ""
			}))
		};
	});
}

async function waitForDeck(cond, desc, { timeout = 30_000 } = {}) {
	let last = null;
	try {
		return await waitUntil(async () => {
			last = await deckProbe();
			return cond(last) ? last : null;
		}, { timeout, interval: 400, desc });
	} catch (error) {
		throw new Error(`${error.message};deck 现状:${JSON.stringify(last)}`, { cause: error });
	}
}

// ── ① delivered 态 ────────────────────────────────────────────
await h.check("交付收尾的会话,摘要呈现「已交付」", async () => {
	await sendTurn("交付模式下出一份Q3复盘");
	await backHome();
	const deck = await waitForDeck(
		(d) => d.present && d.cards.some((c) => c.digest.includes("已交付") && c.digest.includes(DELIVERED_FILE)),
		"摘要出现「已交付 Q3-复盘.md」"
	);
	const card = deck.cards.find((c) => c.digest.includes(DELIVERED_FILE));
	assert.ok(card.meta.includes("条消息"), `注脚应以「条消息」为单位:${card.meta}`);
	/* 与上手清单的共存(评审 R2):清单若在,必在续摊区之前、输入卡之前——
	   composer-zone 的子序锁住「引导 → 导航 → 主角」的层级,续摊区不得挤掉清单。 */
	const order = await win.evaluate(() => [...(document.querySelector(".composer-zone")?.children ?? [])].map((c) => c.className.split(" ")[0]));
	const guideAt = order.indexOf("home-guide");
	const resumeAt = order.indexOf("home-resume");
	assert.ok(resumeAt !== -1, `续摊区应在 composer-zone 内:${order.join(",")}`);
	assert.ok(guideAt === -1 || guideAt < resumeAt, `清单应在续摊区之前:${order.join(",")}`);
	assert.equal(order[order.length - 1], "composer-slot", `输入卡应仍是 composer-zone 最后一位:${order.join(",")}`);
	await h.shoot("deck-delivered");
});

// ── ② text 态 ────────────────────────────────────────────────
await h.check("文本收尾的会话,摘要呈现末句", async () => {
	await startFreshSession();
	await sendTurn("文本模式下写一段复盘总结");
	await backHome();
	await waitForDeck(
		(d) => d.present && d.cards.some((c) => c.digest.includes("收入增长 18%")),
		"摘要出现末句文本"
	);
	await h.shoot("deck-text");
});

// ── ③ fallback 态 ────────────────────────────────────────────
await h.check("纯工具流的会话,摘要退化为「最近 N 条消息」而非骨架", async () => {
	await startFreshSession();
	await sendTurn("静默模式下读一下文件");
	await backHome();
	const deck = await waitForDeck(
		(d) => d.present && d.cards.some((c) => /最近 \d+ 条消息/.test(c.digest)),
		"摘要出现「最近 N 条消息」"
	);
	const card = deck.cards.find((c) => /最近 \d+ 条消息/.test(c.digest));
	assert.equal(card.digestEmpty, false, "fallback 不是骨架——错误/退化态不伪装成加载态");
	/* 注脚单位:messageCount 是 user+assistant 条数之和,不是轮数(评审 R1)——
	   「N 条消息」与摘要同源同量纲;0 条时注脚省略该项(R3),时间项永远在。 */
	assert.ok(card.meta.includes("条消息"), `注脚应以「条消息」为单位:${card.meta}`);
	assert.ok(card.meta.includes("·"), `注脚应保留时间项:${card.meta}`);
	await h.shoot("deck-fallback");
});

// ── ④ running 链路 ───────────────────────────────────────────
await h.check("回合进行中的会话,卡带 is-running 与「进行中」文字", async () => {
	await startFreshSession();
	await sendTurn(HANG_TASK);
	// 等 mock 收到挂起请求(说明回合真的在跑,而不是消息还没发出)。
	await waitUntil(() => mock.requests.some((r) => JSON.stringify(r.body ?? {}).includes("挂起")), { timeout: 30_000, interval: 300, desc: "mock 收到挂起剧本请求" });
	await backHome();
	const deck = await waitForDeck(
		(d) => d.present && d.cards.some((c) => c.running && c.liveText.includes("进行中")),
		"出现带进行中信号的卡"
	);
	const card = deck.cards.find((c) => c.running);
	assert.ok(card.title.length > 0, "running 卡应有标题");
	await h.shoot("deck-running");
});

await h.check("回合收尾后,进行中信号消失且摘要更新为终态", async () => {
	mock.release();
	await waitForDeck(
		(d) => d.present && d.cards.some((c) => c.title.length > 0 && !c.running && c.digest.includes("整理完成")),
		"信号消失、摘要为终态末句"
	);
	await h.shoot("deck-settled");
});

await h.finish();
