/**
 * 文件时光机（侧栏「文件历史」）的 GUI 端到端测试（任务 10-15-file-time-machine）。
 *
 * 数据面（`src/main/daemon/version-store.js` 的记录判据 / 裁剪 / 还原）已有单测
 * （`tests/unit/version-store.test.mjs`），文案与排序有单测
 * （`tests/unit/file-history-core.test.mjs`）。**本文件补的是只有真实启动 Electron
 * 才暴露的那层**：write 工具真的把文件改了 → daemon 真的留了版本 → 侧栏真的能进
 * 这一页 → 时间轴真的画出了两个节点 → 点「还原」真的把**磁盘上的字节**退回去了。
 *
 * ## 关键算术：出现 2 个版本节点，需要连续写 3 次
 *
 * 版本只在**覆盖**时记录（新建不记，design.md §3.2）。所以：
 *
 *   第 1 次写（文件原本不存在）→ 新建，**不记**
 *   第 2 次写 → 记下第 1 次写的内容 = 版本 1
 *   第 3 次写 → 记下第 2 次写的内容 = 版本 2
 *
 * 这一步错了会表现成「永远等不到节点」，**不是报错** —— 所以断言给的是明确条数。
 * mock 的 `tool_calls.id` **跨轮唯一**（live 视图按 id 整卡替换，复用会把前一张卡顶掉，
 * 是 tests/e2e/turn-trace.mjs 里记过的坑）。
 *
 * ## 「发送成功了没有」要验证到副作用
 *
 * 还原那一步不看 toast、不看按钮变灰 —— 直接 `readFileSync` 读工作区里的文件，
 * 并把它与**版本存储里那一版的正文**逐字节比较（`.trellis/spec/testing/index.md` 第 5 条）。
 * 只刷新不落盘的实现会在这里当场变红（反向验证 ① 记录在文件末尾）。
 *
 * ## 反向验证（已真跑并还原，两次）
 *
 *   ① 把「确认还原」接的动作改成只 `refresh()`（不调 restoreFileHistory 也不落盘）
 *      → 「还原后磁盘内容退回到那一版」与「还原之后时间轴多一条」变红，其余全绿。
 *   ② 注掉版本节点上的 `broken` 禁用判据（`if (isBroken) return;`）
 *      → 「broken 节点点了不换选中」变红，其余全绿。
 *
 * ## 等待
 *
 * 所有 `waitUntil` 的谓词**都能返回假值**（见 `.trellis/spec/testing/index.md`）——
 * 不写 `() => win.evaluate(() => ({...}))` 那种恒真形态。模型回合进行中不用
 * `waitForSettled()`（回合里每 500ms 有计时器改 DOM，那个条件永远达不到）。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const FILE_NAME = "周报.md";
const V1 = "# 周报\n\n第一版：VERSION-ONE\n";
const V2 = "# 周报\n\n第二版：VERSION-TWO\n";
const V3 = "# 周报\n\n第三版：VERSION-THREE\n";
const FINAL_TEXT = "FILE_HISTORY_E2E_DONE";

/**
 * mock 模型：按「请求里已经出现过几条 role:"tool"」决定这一轮干什么。
 *
 * 数 tool 条数而不是数请求数 —— 数请求数会把「工具结果没回传」误判成下一轮，
 * 于是三条 write 变成同一轮的三条重复调用（turn-trace.mjs 记过的同一个理由）。
 */
function startMockModel() {
	const requests = [];
	let callSeq = 0;
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

			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const send = (delta, finish) => {
				const chunk = { id: "chatcmpl-file-history", object: "chat.completion.chunk", choices: [{ index: 0, delta }] };
				if (finish !== undefined) chunk.choices[0].finish_reason = finish;
				res.write(`data: ${JSON.stringify(chunk)}\n\n`);
			};
			// 同一轮里也只有一条 tool_call，所以 index 恒为 0；id 里的序号跨轮递增。
			const toolCall = (name, args) => ({
				index: 0,
				id: `call_${name}_${(callSeq += 1)}`,
				type: "function",
				function: { name, arguments: JSON.stringify(args) }
			});

			send({ role: "assistant", content: "" });
			const toolResults = (parsed?.messages ?? []).filter((m) => m.role === "tool").length;
			const writes = [V1, V2, V3];

			if (toolResults < writes.length) {
				send({ tool_calls: [toolCall("write", { path: FILE_NAME, content: writes[toolResults] })] });
				send({}, "tool_calls");
			} else {
				for (const chunk of FINAL_TEXT.match(/.{1,8}/gu) ?? []) send({ content: chunk });
				send({}, "stop");
			}

			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	return new Promise((ok) => {
		server.listen(0, "127.0.0.1", () =>
			ok({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests, close: () => new Promise((r) => server.close(r)) })
		);
	});
}

const h = createHarness({ name: "file-history" });
mkdirSync(h.WORKSPACE_DIR, { recursive: true });
const WORKSPACE_FILE = join(h.WORKSPACE_DIR, FILE_NAME);
const VERSIONS_ROOT = join(h.CONFIG_DIR, "versions");

const mock = await startMockModel();
console.log(`✓ mock 模型服务已就绪：${mock.baseUrl}`);

await h.launch();
const win = h.window();

// ── 测量工具 ────────────────────────────────────────────────

/** 读工作区里那个文件的当前内容；读不到返回 undefined（不抛）。 */
function readDisk() {
	try {
		return readFileSync(WORKSPACE_FILE, "utf8");
	} catch {
		return undefined;
	}
}

/** 版本存储里那一个 key 目录（本用例只改过一个文件，所以只有它）。 */
function versionKeyDir() {
	const dirs = readdirSync(VERSIONS_ROOT, { withFileTypes: true })
		.filter((d) => d.isDirectory() && /^[0-9a-f]{16}$/.test(d.name))
		.map((d) => d.name);
	assert.equal(dirs.length, 1, `版本目录应恰好一个，实际 ${JSON.stringify(dirs)}`);
	return join(VERSIONS_ROOT, dirs[0]);
}

function readVersionsMeta() {
	return JSON.parse(readFileSync(join(versionKeyDir(), "meta.json"), "utf8"));
}

/** 版本存储里某一版的正文（还原后的磁盘内容应与它逐字节相同）。 */
function readStoredVersion(id) {
	return readFileSync(join(versionKeyDir(), `${id}.txt`), "utf8");
}

/** 当前界面上时间轴的节点快照（一次求值拿全，避免多次往返）。 */
function readView() {
	return win.evaluate(() => {
		const main = document.querySelector("main.settings");
		if (main === null) return { present: false };
		const nodes = [...main.querySelectorAll(".fh-timeline .fh-node")].map((node) => ({
			time: (node.querySelector(".fh-node-time")?.textContent ?? "").trim(),
			source: (node.querySelector(".fh-node-source")?.textContent ?? "").trim(),
			change: (node.querySelector(".fh-node-change")?.textContent ?? "").trim(),
			ago: (node.querySelector(".fh-node-ago")?.textContent ?? "").trim(),
			selected: node.classList.contains("selected"),
			broken: node.classList.contains("broken"),
			ariaDisabled: node.getAttribute("aria-disabled"),
			disabledAttr: node.hasAttribute("disabled"),
			opacity: Number(getComputedStyle(node).opacity),
			cursor: getComputedStyle(node).cursor,
			dot: getComputedStyle(node.querySelector(".fh-node-dot")).backgroundColor
		}));
		return {
			present: true,
			title: (main.querySelector("h1")?.textContent ?? "").trim(),
			empty: main.querySelector(".state-empty") !== null,
			loading: main.querySelector(".state-loading") !== null,
			error: main.querySelector(".state-error") !== null,
			rows: [...main.querySelectorAll(".fh-index .fh-file-row")].map((row) => ({
				name: (row.querySelector(".fh-file-name")?.textContent ?? "").trim(),
				count: (row.querySelector(".fh-file-count")?.textContent ?? "").trim(),
				dir: (row.querySelector(".fh-file-dir")?.textContent ?? "").trim(),
				note: (row.querySelector(".fh-file-note")?.textContent ?? "").trim(),
				borderWidth: getComputedStyle(row).borderTopWidth,
				selected: row.classList.contains("selected")
			})),
			nodes,
			notes: [...main.querySelectorAll(".fh-card-note")].map((p) => (p.textContent ?? "").trim()),
			previewHead: (main.querySelector(".fh-preview-head .code-block-lang")?.textContent ?? "").trim(),
			previewBody: main.querySelector(".fh-preview-body")?.textContent ?? null,
			confirmText: (main.querySelector(".fh-confirm .fh-confirm-text")?.textContent ?? "").trim(),
			hasConfirm: main.querySelector(".fh-confirm") !== null,
			hasDialog: document.querySelector('[role="dialog"]') !== null,
			restoreButton: [...main.querySelectorAll(".fh-preview-actions button")].some(
				(b) => (b.textContent ?? "").trim() === "还原到此版本"
			)
		};
	});
}

/** 轮询直到 readView() 满足谓词（谓词必须能返回假值 —— 拿不到就返回 null）。 */
const waitView = (pred, desc) =>
	waitUntil(async () => {
		const state = await readView();
		return pred(state) ? state : null;
	}, { timeout: 20_000, desc });

const clickNav = async (label) => {
	const ok = await win.evaluate((text) => {
		const btn = [...document.querySelectorAll(".sidebar-nav button")].find((b) => (b.textContent ?? "").trim() === text);
		if (btn === undefined || btn.disabled) return false;
		btn.click();
		return true;
	}, label);
	assert.ok(ok, `侧栏找不到可点的「${label}」导航项`);
};

// ══ ① 配置 mock 模型 + 工作区 ══════════════════════════════════
await h.check("① 注册指向 mock 的 provider、切模型、把工作区指到隔离目录", async () => {
	const r = await win.evaluate(async ({ baseUrl, ws }) => {
		const k = globalThis.kami;
		try {
			await k.saveCustomProvider(
				{
					id: "mock-file-history",
					name: "Mock File History",
					baseUrl,
					api: "openai-completions",
					authHeader: true,
					models: [
						{
							id: "fh-model",
							name: "fh-model",
							reasoning: false,
							vision: false,
							contextWindow: 128000,
							maxTokens: 8192
						}
					]
				},
				"mock-key"
			);
			await k.setModel("mock-file-history/fh-model");
			await k.setWorkspace(ws);
			return { ok: true };
		} catch (e) {
			return { ok: false, err: String(e?.message ?? e).slice(0, 200) };
		}
	}, { baseUrl: mock.baseUrl, ws: h.WORKSPACE_DIR });
	assert.ok(r.ok, `配置失败：${r.err}`);
});

// ══ ② Agent 真的写三次同一个文件（走真实 UI 路径 + 真实 write 工具）══
await h.check("② 走真实 UI 让 Agent 连写三次同一个文件（磁盘上最终是第三版）", async () => {
	const box = win.locator('[aria-label="消息输入框"]');
	await box.waitFor({ state: "visible", timeout: 30_000 });
	await box.fill("把周报.md 改三次，每次换一版内容");
	await box.press("Enter");

	// 信号等待（不是固定 sleep）：mock 真的收到第 4 轮请求 = 三条 write 都已回传结果。
	try {
		await waitUntil(() => mock.requests.length >= 4, {
			timeout: 60_000,
			interval: 500,
			desc: "mock 收到第 4 轮请求（三条 write 都执行完）"
		});
	} catch (error) {
		throw new Error(`mock 只收到 ${mock.requests.length} 轮请求（期望 ≥4）—— 三次写入没有走完（${error.message}）`, {
			cause: error
		});
	}

	// 等到磁盘上真的是第三版（回合结束 + 落盘都完成的直接证据）。
	const disk = await waitUntil(() => {
		const text = readDisk();
		return text?.includes("VERSION-THREE") ? text : null;
	}, { timeout: 20_000, desc: "磁盘上的周报.md 变成第三版" });
	assert.ok(disk.includes("VERSION-THREE"), `第三次写入没有落到磁盘：${JSON.stringify(disk)}`);

	/*
	 * 版本只在覆盖时记录（新建不记）—— 三次写 = 两个版本。这条同时是下面
	 * 「时间轴恰好 2 个节点」那条断言的前提证据：写进来的是 3 条 tool 结果。
	 */
	const toolResults = mock.requests.at(-1)?.body?.messages?.filter((m) => m.role === "tool").length ?? 0;
	assert.equal(toolResults, 3, `最后一轮请求里应有 3 条 tool 结果（三条 write），实际 ${toolResults}`);
});

// ══ ③ 侧栏进入「文件历史」：清单 + 时间轴两个节点 ══════════════
await h.check("③ 侧栏进入「文件历史」：清单里出现那个文件，时间轴恰好 2 个版本节点", async () => {
	await clickNav("文件历史");
	await waitView((s) => s.present && s.title === "文件历史" && s.nodes.length >= 2, "文件历史视图挂上并出现 2 个节点");
	await h.waitForSettled();
	await h.shoot("file-history-list-light");

	const s = await readView();
	assert.equal(s.title, "文件历史", "页头标题不对");
	assert.equal(s.empty, false, "有版本时不该是空态");
	assert.equal(s.error, false, "不该是错误态");

	const row = s.rows.find((r) => r.name === FILE_NAME);
	assert.ok(row !== undefined, `左列清单里应有「${FILE_NAME}」：${JSON.stringify(s.rows.map((r) => r.name))}`);
	assert.equal(row.count, "2 版", `清单应标出 2 版（三次写 = 两个版本），实际 ${JSON.stringify(row.count)}`);
	assert.ok(row.note.length > 0, "清单第三行（时间 · 来源会话）不该为空");
	assert.ok(row.selected, "默认应选中清单里的第一个文件");
	// 无边框索引列：它是导航，不是第二个盒子（验收口径 §11.1）。
	assert.equal(row.borderWidth, "0px", `清单行不该有边框，实际 ${row.borderWidth}`);

	assert.equal(s.nodes.length, 2, `时间轴应恰好 2 个节点（写 3 次、新建不记）：${JSON.stringify(s.nodes.map((n) => n.change))}`);
	/*
	 * 契约里 added / removed 是「替换掉这一版的那次改动」的增删行数（design.md §3.1），
	 * 所以：旧的那一版有数字，**最新一版没有**（它之后没有已记录的改动）。
	 */
	assert.match(s.nodes[0].change, /^被一次 \+\d+ −\d+ 的改动替换$/, `旧节点应报出增删行数：${JSON.stringify(s.nodes[0].change)}`);
	assert.equal(s.nodes[1].change, "这是最近一次改动之前的样子", "最新一版不给不存在的数字，给一句说明");
	assert.match(s.nodes[1].ago, /前$|^刚刚$/, `节点第三行应是相对时间：${JSON.stringify(s.nodes[1].ago)}`);
	assert.ok(s.nodes[1].selected, "默认应选中最新一版");
	assert.ok(s.nodes[1].source.length > 0, "节点应带来源（工具 · 会话）");
	assert.equal(s.restoreButton, true, "预览头应有「还原到此版本」");
	assert.equal(s.hasDialog, false, "这一页不该出现模态对话框");
	assert.ok(s.previewHead.includes("只读"), `预览头应标「只读」：${JSON.stringify(s.previewHead)}`);

	// 选中态是双通道：行底 + 圆点。至少要能观察到「选中与未选中的圆点不一样」。
	assert.notEqual(s.nodes[0].dot, s.nodes[1].dot, "选中节点的圆点应与未选中的可分辨（不能只靠颜色深浅的都一样）");

	/*
	 * 预览的是**这一版存下来的内容**，不是磁盘上的当前内容：第三版是「当前」，
	 * 不在历史里（ux-proposal §3.1 的方向说明说的就是这件事）。
	 */
	assert.ok(s.previewBody !== null, "只读预览应有正文");
	assert.ok(s.previewBody.includes("VERSION-TWO"), `最新一版（= 改动前的内容）应是第二版：${JSON.stringify(s.previewBody)}`);
	assert.ok(!s.previewBody.includes("VERSION-THREE"), "历史预览里不该出现当前磁盘上的第三版");
	assert.ok(
		s.notes.some((n) => n.includes("每一版都是某次改动之前的内容")),
		`时间轴下方应有方向说明：${JSON.stringify(s.notes)}`
	);
});

// ══ ④ 版本正文缺失（broken）→ 节点不可激活但仍可聚焦 ═════════════
let expectedContent = "";
await h.check("④ 删掉最旧一版的正文文件 → 该节点标 broken、点了不换选中、键盘仍够得着", async () => {
	const meta = readVersionsMeta();
	assert.equal(meta.versions.length, 2, `版本元数据里应有 2 条：${JSON.stringify(meta.versions)}`);
	const oldestId = meta.versions[0].id;
	const newestId = meta.versions[1].id;
	// 还原的目标（默认选中的最新一版）的正文：待会儿用它逐字节比磁盘。
	expectedContent = readStoredVersion(newestId);
	assert.ok(expectedContent.includes("VERSION-TWO"), `最新一版的正文应是第二版：${JSON.stringify(expectedContent)}`);
	// 制造「坏数据」：删掉最旧那一版的内容文件（meta 不动）。
	rmSync(join(versionKeyDir(), `${oldestId}.txt`), { force: true });

	await win.evaluate(() => {
		const btn = [...document.querySelectorAll("main.settings .settings-head .mini-btn")].find(
			(b) => (b.textContent ?? "").trim() === "刷新"
		);
		if (btn === undefined) throw new Error("文件历史页头找不到「刷新」按钮");
		btn.click();
	});
	const s = await waitView((v) => v.nodes.length === 2 && v.nodes[0].broken === true, "最旧一版被标成 broken");
	await h.shoot("file-history-broken-light");

	const broken = s.nodes[0];
	/*
	 * 复位放进 finally：这一条 check 若红了，尾部的复位也要照跑 —— 否则「点了不换选中」
	 * 一旦被改坏，选中会停在 broken 节点上，后面 ⑤/⑥ 会连着红（反向验证要的是
	 * 「哪几条真的相关」，被连带打红的那些会把现场搅浑）。复位本身失败不覆盖原始断言。
	 */
	try {
	assert.equal(broken.broken, true, "最旧一版应是 broken");
	assert.equal(broken.disabledAttr, false, "broken 的节点不能用 disabled 属性（那会把键盘入口整个吃掉）");
	assert.equal(broken.ariaDisabled, "true", "broken 的节点应以 aria-disabled 告知不可激活");
	assert.ok(broken.opacity < 1, `broken 节点应淡出（只改透明度），实际 opacity=${broken.opacity}`);
	assert.equal(broken.cursor, "default", `broken 节点不该有可点暗示，实际 cursor=${broken.cursor}`);
	assert.equal(broken.change, "内容已不在，这一版不能还原", "broken 节点自身要说清不可还原（不静默）");
	assert.ok(
		s.notes.some((n) => n.includes("不能还原") && n.includes("1 版")),
		`时间轴上方应有 broken 说明行：${JSON.stringify(s.notes)}`
	);

	/*
	 * 不可激活：点它不换选中、也不换预览。
	 *
	 * 判据取**选中节点的下标**而不是它的时间文案：本用例里两个节点是同一分钟写下的，
	 * 时间串相等会让「时间没变」这条假过（第一版就是这么写的，反向验证时才发现）。
	 */
	const selectedProbe = () =>
		win.evaluate(() => {
			const nodes = [...document.querySelectorAll(".fh-timeline .fh-node")];
			return {
				selectedIndex: nodes.findIndex((n) => n.classList.contains("selected")),
				selectedChange: (nodes.find((n) => n.classList.contains("selected"))?.querySelector(".fh-node-change")?.textContent ?? "").trim(),
				preview: document.querySelector(".fh-preview-body")?.textContent ?? ""
			};
		});
	const before = await selectedProbe();
	/*
	 * 用页内 .click()（不经过 Playwright 的 actionability 检查）：Playwright 把
	 * `aria-disabled="true"` 当作「不可点」而拒绝点击 —— 那正是这里刻意选的语义
	 * （要保留键盘可达，就不能用 disabled 属性）。所以这里要验的是「真实点击事件
	 * 打上去也不换选中」，而不是「Playwright 允不允许点」。
	 */
	await win.evaluate(() => {
		const node = document.querySelector(".fh-timeline .fh-node.broken");
		if (node === null) throw new Error("找不到 .fh-node.broken");
		node.click();
	});
	const after = await selectedProbe();
	assert.equal(after.selectedIndex, before.selectedIndex, "点 broken 节点不该改变选中（它不可激活）");
	assert.equal(after.selectedChange, before.selectedChange, "点 broken 节点不该改变选中的那一版");
	assert.equal(after.preview, before.preview, "点 broken 节点不该改变预览内容");

	// 但它必须还在键盘序列里：能聚焦 = 键盘用户看得见「这个文件丢了一版」。
	const focused = await win.evaluate(() => {
		const node = document.querySelector(".fh-timeline .fh-node.broken");
		if (node === null) return { focusable: false, reason: "没有 .fh-node.broken" };
		node.focus();
		return { focusable: document.activeElement === node, reason: `activeElement=${document.activeElement?.className ?? "null"}` };
	});
	assert.ok(focused.focusable, `broken 节点必须可聚焦（键盘用户得看得见它丢了）：${focused.reason}`);
	} finally {
		/* 把选中重新落回最新一版，让这一条 check 结束时状态确定。 */
		try {
			await win.evaluate(() => {
				document.querySelector(".fh-timeline .fh-node.last:not(.broken)")?.click();
			});
			await waitUntil(() => win.evaluate(() => document.querySelector(".fh-preview-body") !== null), {
				timeout: 15_000,
				desc: "复位后预览正文重新出现"
			});
		} catch {
			/* 复位失败不该覆盖这一条真正的失败现场。 */
		}
	}
});

// ══ ⑤ 还原：就地确认条（不是模态）说全三件事 ═════════════════════
await h.check("⑤ 点「还原到此版本」→ 就地确认条（无模态）说清文件、时间点与「先存成一条新版本」", async () => {
	const clicked = await win.evaluate(() => {
		const btn = [...document.querySelectorAll(".fh-preview-actions button")].find(
			(b) => (b.textContent ?? "").trim() === "还原到此版本"
		);
		if (btn === undefined || btn.disabled) return false;
		btn.click();
		return true;
	});
	assert.ok(clicked, "找不到可点的「还原到此版本」按钮");

	const s = await waitView((v) => v.hasConfirm, "出现就地确认条");
	await h.shoot("file-history-confirm-light");
	assert.equal(s.hasDialog, false, "确认必须是就地的，不许出现 role=dialog 的模态");
	assert.ok(s.confirmText.includes(`「${FILE_NAME}」`), `确认句要说清哪个文件：${JSON.stringify(s.confirmText)}`);
	assert.match(s.confirmText, /\d{2}-\d{2} \d{2}:\d{2}/, `确认句要说清退到哪个时间点：${JSON.stringify(s.confirmText)}`);
	assert.ok(s.confirmText.includes("先存成一条新版本"), `确认句要说清当前内容会先留一版：${JSON.stringify(s.confirmText)}`);
	// 「取消」必须在，且取消后磁盘不变（下一步验证落盘之前先证否一次）。
	const cancelled = await win.evaluate(() => {
		const btn = [...document.querySelectorAll(".fh-confirm button")].find((b) => (b.textContent ?? "").trim() === "取消");
		if (btn === undefined) return false;
		btn.click();
		return true;
	});
	assert.ok(cancelled, "确认条里应有「取消」");
	await waitUntil(() => win.evaluate(() => document.querySelector(".fh-confirm") === null), {
		timeout: 10_000,
		desc: "取消后确认条消失"
	});
	assert.ok(readDisk().includes("VERSION-THREE"), "点「取消」后磁盘内容必须原样不动");
});

// ══ ⑥ 确认还原 → 磁盘真的退回去 + 时间轴多一条（还原也留一版）═══
await h.check("⑥ 确认还原 → 磁盘内容退回到那一版（副作用验证）+ 时间轴多出一条", async () => {
	const opened = await win.evaluate(() => {
		const btn = [...document.querySelectorAll(".fh-preview-actions button")].find(
			(b) => (b.textContent ?? "").trim() === "还原到此版本"
		);
		if (btn === undefined || btn.disabled) return false;
		btn.click();
		return true;
	});
	assert.ok(opened, "第二次点击「还原到此版本」失败");
	await waitView((v) => v.hasConfirm, "再次出现就地确认条");

	const confirmed = await win.evaluate(() => {
		const btn = [...document.querySelectorAll(".fh-confirm button")].find((b) => (b.textContent ?? "").trim() === "确认还原");
		if (btn === undefined || btn.disabled) return false;
		btn.click();
		return true;
	});
	assert.ok(confirmed, "确认条里应有可点的「确认还原」");

	/*
	 * 副作用验证：不看 toast、不看按钮状态，直接读磁盘 —— 并且与版本存储里那一版的
	 * 正文**逐字节**比较（「发送成功了没有」要验到副作用，见测试规范第 5 条）。
	 */
	const disk = await waitUntil(() => {
		const text = readDisk();
		return text === expectedContent ? text : null;
	}, { timeout: 20_000, desc: "磁盘上的周报.md 逐字节退回到第二版" });
	assert.equal(disk, expectedContent, "磁盘内容没有退回到目标版本");
	assert.ok(disk.includes("VERSION-TWO"), "退回的应当是第二版");

	// 还原本身也留一版：时间轴末尾应多出「你还原之前的内容」那一条。
	const s = await waitView((v) => v.nodes.length === 3, "还原之后时间轴变成 3 个节点");
	await h.shoot("file-history-restored-light");
	assert.equal(s.nodes.length, 3, `还原之后应有 3 个节点（2 版历史 + 还原留的那一版）：${JSON.stringify(s.nodes.map((n) => n.change))}`);
	assert.ok(
		s.nodes[2].source.includes("restore"),
		`新留下的那一版来源应是 restore：${JSON.stringify(s.nodes[2].source)}`
	);
	// 左列清单也跟着刷新（版本数从 2 变 3），不是只刷了右列。
	const row = s.rows.find((r) => r.name === FILE_NAME);
	assert.equal(row?.count, "3 版", `还原之后清单里的版本数也要刷新：${JSON.stringify(row?.count)}`);
});

// ══ ⑦ 命令面板也能直达（侧栏是入口之一，不是唯一入口）═══════════
await h.check("⑦ 命令面板里有「打开文件历史」，点它能直达这一页", async () => {
	// 先离开这一页（回欢迎页），这样「从面板进来」才是真的切换视图而不是原地不动。
	await win.evaluate(() => {
		[...document.querySelectorAll("main.settings .settings-head button")]
			.find((b) => b.getAttribute("aria-label") === "返回")
			?.click();
	});
	await waitUntil(() => win.evaluate(() => document.querySelector("main.settings") === null), {
		timeout: 15_000,
		desc: "已离开文件历史页"
	});

	// 走真实键盘路径：唤起 → 输入标题 → Enter 执行（条目的选择走 onMouseDown，
	// 用页内 .click() 打不到，command-palette.mjs 的既有用例也是 fill + Enter）。
	const label = process.platform === "darwin" ? "Meta+K" : "Control+K";
	await win.keyboard.press(label);
	const input = win.locator(".command-palette-input");
	await input.waitFor({ state: "visible", timeout: 15_000 });
	await input.fill("打开文件历史");
	const active = await waitUntil(
		() =>
			win.evaluate(() => {
				const hit = [...document.querySelectorAll('.command-palette [role="option"]')].find(
					(el) => el.getAttribute("aria-selected") === "true"
				);
				return hit === undefined || !(hit.textContent ?? "").includes("打开文件历史")
					? null
					: { text: hit.textContent ?? "" };
			}),
		{ timeout: 15_000, desc: "「打开文件历史」成为命令面板的选中项" }
	);
	assert.ok(active.text.includes("打开文件历史"), `条目标题不对：${JSON.stringify(active.text)}`);
	await win.keyboard.press("Enter");

	// 直达的证据：面板卸载 + 文件历史页真的挂上（不是「点了没反应也过」）。
	const state = await waitView((v) => v.present && v.title === "文件历史", "命令面板跳转后进入文件历史");
	assert.equal(state.title, "文件历史", "命令面板没有把我们带到文件历史页");
	/*
	 * 面板的退场是「先播 --dur-fast 的淡出、再卸载」（docs/DESIGN.md §10.3），
	 * 所以「视图已挂上」与「面板已卸载」是两件事 —— 等它，别立刻断言（测试规范第 4 条）。
	 */
	await waitUntil(() => win.evaluate(() => document.querySelector(".command-palette") === null), {
		timeout: 15_000,
		desc: "执行条目后命令面板卸载"
	});
});

// ══ ⑧ 暗色主题截图 ════════════════════════════════════════════
await h.check("⑧ 暗色主题下文件历史仍正常渲染（截图 + 像素断言）", async () => {
	await win.evaluate(() => {
		void window.kami?.setThemePreference?.("dark");
		document.documentElement.setAttribute("data-theme", "dark");
	});
	await waitUntil(() => win.evaluate(() => document.documentElement.dataset.theme === "dark"), {
		timeout: 10_000,
		desc: "data-theme 切到 dark"
	});
	await h.waitForSettled();
	const dark = await h.shoot("file-history-dark");
	assert.ok(dark.stats.stdDev > 3, `暗色截图不像渲染出来的界面（stdDev=${dark.stats.stdDev.toFixed(2)}）`);

	// 暗色下「选中 vs 未选中」仍然可辨（不能出现两者同色）。
	const s = await readView();
	const nodes = s.nodes ?? [];
	const selected = nodes.find((n) => n.selected);
	const other = nodes.find((n) => !n.selected && !n.broken);
	if (selected !== undefined && other !== undefined) {
		assert.notEqual(selected.dot, other.dot, "暗色下选中与未选中的圆点不应同色");
	}

	await win.evaluate(() => {
		void window.kami?.setThemePreference?.("light");
		document.documentElement.setAttribute("data-theme", "light");
	});
	await waitUntil(() => win.evaluate(() => document.documentElement.dataset.theme === "light"), {
		timeout: 10_000,
		desc: "data-theme 切回 light"
	});
});

// ══ ⑨ 窄窗口：清单收成「文件选择条」，时间轴与预览全宽在下 ═══════
await h.check("⑨ 窄窗口（容器 <620px）左列收起成文件选择条，时间轴与预览仍全宽在下", async () => {
	// 窗口宽不是可用宽：左侧栏占 264px、设置页还有 48px 内边距，
	// 所以 640 的窗口宽度（可用宽 ≈ 328px）落在容器的 <620px 档里。
	const browserWindow = await h.app().browserWindow(win);
	await browserWindow.evaluate((w) => w.setSize(640, 860));

	const narrow = await waitUntil(
		() =>
			win.evaluate(() => {
				const index = document.querySelector(".fh-index");
				const picker = document.querySelector(".fh-picker-wrap");
				if (index === null || picker === null) return null;
				const indexHidden = getComputedStyle(index).display === "none";
				const pickerShown = getComputedStyle(picker).display !== "none";
				return indexHidden && pickerShown ? { indexHidden, pickerShown } : null;
			}),
		{ timeout: 15_000, desc: "窄容器下左列收起、文件选择条出现" }
	);
	assert.equal(narrow.pickerShown, true, "窄窗下应出现「文件选择条」");
	await h.shoot("file-history-narrow");

	// 选择条点开的是既有 .pop-menu（不是原生 select），并真的能切换文件。
	await win.evaluate(() => document.querySelector(".fh-picker")?.click());
	const menu = await waitUntil(
		() =>
			win.evaluate(() => {
				const box = document.querySelector(".fh-picker-menu");
				if (box === null) return null;
				const items = [...box.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
				return items.length > 0 ? { items } : null;
			}),
		{ timeout: 10_000, desc: "文件选择条弹出菜单" }
	);
	assert.deepEqual(menu.items, [FILE_NAME], `选择条菜单应列出那个文件：${JSON.stringify(menu.items)}`);
	await win.evaluate(() => {
		const item = document.querySelector(".fh-picker-menu button");
		if (item === null) throw new Error("文件选择条菜单里没有条目");
		item.click();
	});
	await waitUntil(() => win.evaluate(() => document.querySelector(".fh-picker-menu") === null), {
		timeout: 10_000,
		desc: "选择后菜单收起"
	});

	// 单列下时间轴与预览照常全宽渲染（不是「窄了就没内容」）。
	const s = await readView();
	assert.equal(s.loading, false, "窄窗下不该停在加载态");
	assert.ok((s.nodes?.length ?? 0) >= 2, `窄窗下时间轴仍应渲染：${JSON.stringify(s.nodes?.length)}`);
	assert.ok(s.previewBody !== null, "窄窗下只读预览仍应渲染");

	// 还原窗口宽度（后续人工看截图与本机使用都基于默认尺寸）。
	await browserWindow.evaluate((w) => w.setSize(1280, 860));
});

await h.check("无渲染层未捕获异常", () => assert.equal(h.pageErrors.length, 0, h.pageErrors.join("; ")));

await h.app().close();
await mock.close();
await h.finish();
