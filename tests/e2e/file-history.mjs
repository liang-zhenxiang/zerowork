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
/*
 * 第二版刻意写长（60 行）：预览的限高 `min(50vh, 420px)` 曾被 `.code-block pre`
 * 的 `60vh` 以特异性顶掉，而 36 B 的 fixture 永远看不出来（独立评审 P1-1）。
 * 长正文让「限高真的生效」变成可断言的事实：computed max-height 正确 **且**
 * 正文确实溢出、内部滚动（scrollHeight > clientHeight）。
 */
const V2_BODY = Array.from({ length: 60 }, (_, i) => `- 第 ${i + 1} 行：第二版正文`).join("\n");
const V2 = `# 周报\n\n第二版：VERSION-TWO\n\n${V2_BODY}\n`;
const V3 = "# 周报\n\n第三版：VERSION-THREE\n";
const FINAL_TEXT = "FILE_HISTORY_E2E_DONE";

/**
 * mock 每轮之间刻意停 1.1s。
 *
 * 这不是「用 sleep 盖竞态」（测试自己一律等信号）：它是**夹具的时间性质** ——
 * 版本只到秒，三轮写入必须落在**不同秒**上，「同一分钟里的多个版本要能分辨」
 * （评审 P1-3）才是一条确定的断言而不是碰运气。1.1s > 1s，因此两次记录必然
 * 落在不同秒。
 */
const ROUND_SPACING_MS = 1100;

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

			const toolResults = (parsed?.messages ?? []).filter((m) => m.role === "tool").length;
			const writes = [V1, V2, V3];
			const respond = () => {
				send({ role: "assistant", content: "" });
				if (toolResults < writes.length) {
					send({ tool_calls: [toolCall("write", { path: FILE_NAME, content: writes[toolResults] })] });
					send({}, "tool_calls");
				} else {
					for (const chunk of FINAL_TEXT.match(/.{1,8}/gu) ?? []) send({ content: chunk });
					send({}, "stop");
				}
				res.write("data: [DONE]\n\n");
				res.end();
			};

			// 写入轮之间拉开到不同秒（见 ROUND_SPACING_MS 的说明）。
			if (toolResults < writes.length) setTimeout(respond, ROUND_SPACING_MS);
			else respond();
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

/**
 * 在一张已解码的截图里采样「刻度槽那一列」，返回给定纵带内**每一行**的最深像素值。
 *
 * 用途是评审 P1-2 那条：时间轴主线必须跨过行内 padding、在相邻两行之间连着。
 * 竖线是 `--border`（亮色 #e6e6e6 = 230），行间空隙的底色是卡片的白（255）——
 * 于是「每一行都能采到 ≤249 的像素」等价于「主线没有断」。评审就是这么做实测的，
 * 这里把同一套方法固化成断言（只取 R 通道：线是中性灰，三个通道等值）。
 */
function darkestPerRow(img, { xDevice, yStart, yEnd, halfWidthDevice }) {
	const { width, height, channels, data } = img;
	const rows = [];
	for (let y = Math.max(0, yStart); y < Math.min(height, yEnd); y += 1) {
		let min = 255;
		for (let x = Math.max(0, xDevice - halfWidthDevice); x <= Math.min(width - 1, xDevice + halfWidthDevice); x += 1) {
			const value = data[(y * width + x) * channels];
			if (value < min) min = value;
		}
		rows.push(min);
	}
	return rows;
}

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
	const shot = await h.shoot("file-history-list-light");

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
	 * 时间必须带秒、且同一分钟里的两版真的能分开（独立评审 P1-3）：Agent 连写同一个文件
	 * 是常态，只到分钟时确认句会同时对应好几行，用户在按下确认前无法定位自己选的是哪一版。
	 * 夹具为此把两轮之间拉开到不同秒（见 ROUND_SPACING_MS）。
	 */
	for (const node of s.nodes) {
		assert.match(node.time, /^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, `节点身份行的时间应是 MM-DD HH:mm:ss：${JSON.stringify(node.time)}`);
	}
	assert.equal(
		new Set(s.nodes.map((n) => n.time)).size,
		s.nodes.length,
		`同一屏的版本必须两两可分辨（带秒后仍相同就说明夹具没拉开）：${JSON.stringify(s.nodes.map((n) => n.time))}`
	);
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
	assert.match(s.previewHead, /\d{2}-\d{2} \d{2}:\d{2}:\d{2}/, `预览头的时间应与节点同一格式：${JSON.stringify(s.previewHead)}`);

	// 选中态是双通道：行底 + 圆点。至少要能观察到「选中与未选中的圆点不一样」。
	assert.notEqual(s.nodes[0].dot, s.nodes[1].dot, "选中节点的圆点应与未选中的可分辨（不能只靠颜色深浅的都一样）");

	/*
	 * 预览限高必须真的是设计值 min(50vh, 420px)（独立评审 P1-1）。
	 * 数值本身与内容长度无关，所以先钉 computed 值，再钉「长正文确实溢出、内部滚动」——
	 * 后者才是「限高真的生效」的行为证据。
	 */
	const cap = await win.evaluate(() => {
		const pre = document.querySelector(".fh-preview-body");
		if (pre === null) return null;
		return {
			maxHeight: getComputedStyle(pre).maxHeight,
			clientHeight: pre.clientHeight,
			scrollHeight: pre.scrollHeight,
			expected: Math.min(window.innerHeight * 0.5, 420)
		};
	});
	assert.ok(cap !== null, "找不到 .fh-preview-body");
	assert.equal(
		Math.round(Number.parseFloat(cap.maxHeight)),
		Math.round(cap.expected),
		`预览体限高应为 min(50vh, 420px) = ${Math.round(cap.expected)}px，实际 ${cap.maxHeight}（被 .code-block pre 的 60vh 顶掉过）`
	);
	assert.ok(
		cap.scrollHeight > cap.clientHeight,
		`长正文应被限高并内部滚动：scrollHeight=${cap.scrollHeight} clientHeight=${cap.clientHeight}`
	);

	/*
	 * 时间轴主线必须跨过行内 padding、在相邻两行之间连着（独立评审 P1-2）。
	 * 方法就是评审那一套：沿刻度槽列逐行采样，看行间的 12px 空隙带里有没有线的像素。
	 */
	const markGeometry = await win.evaluate(() => {
		const nodes = [...document.querySelectorAll(".fh-timeline .fh-node")];
		const marks = nodes.map((n) => n.querySelector(".fh-node-mark").getBoundingClientRect());
		return {
			viewportWidth: window.innerWidth,
			markCenterX: marks.map((r) => (r.left + r.right) / 2),
			markBottom: marks.map((r) => r.bottom),
			markTop: marks.map((r) => r.top)
		};
	});
	const scale = shot.img.width / markGeometry.viewportWidth;
	const band = darkestPerRow(shot.img, {
		xDevice: Math.round(markGeometry.markCenterX[0] * scale),
		yStart: Math.ceil(markGeometry.markBottom[0] * scale),
		yEnd: Math.floor(markGeometry.markTop[1] * scale),
		halfWidthDevice: Math.max(1, Math.round(3 * scale))
	});
	assert.ok(band.length >= 8, `行间空隙带的采样高度异常：${band.length} 设备像素（期望 ~12 CSS px × ${scale.toFixed(2)}）`);
	assert.ok(
		Math.max(...band) <= 249,
		`主线在行间断开了：空隙带里最亮的那一行最深像素 ${Math.max(...band)}（≈255 = 只有卡片底色；主线是 ~230）`
	);
	/*
	 * 中间连起来的同时，**首末端仍必须裁掉**：线只在「节点之间」表示时间在流动，
	 * 越过首节点向上、越过末节点向下就变成了装饰。判据取语义而不是字面值 ——
	 * 首端 top 必须为正（线从圆点起，不是从槽顶起），末端必须给死高度且短于整个槽。
	 */
	const clip = await win.evaluate(() => {
		const marks = [...document.querySelectorAll(".fh-timeline .fh-node")].map((n) => n.querySelector(".fh-node-mark"));
		const read = (el) => {
			const cs = getComputedStyle(el, "::before");
			return { top: cs.top, bottom: cs.bottom, height: cs.height, markHeight: el.getBoundingClientRect().height };
		};
		return { first: read(marks[0]), last: read(marks[marks.length - 1]) };
	});
	assert.ok(
		Number.parseFloat(clip.first.top) > 0,
		`首节点的线上端应被裁掉（top > 0 = 它没有向上一行延伸），实际 top=${clip.first.top}`
	);
	/*
	 * 末节点的线必须**停在圆点中心**（圆点 margin-top 4 + 直径 10 → 中心在 9px），
	 * 而不是贯穿整个刻度槽。注意不能断言 computed `bottom === "auto"`：绝对定位元素
	 * 一旦给了 height，getComputedStyle 返回的是**用值**（实测 58.19px 这种），
	 * 不是声明值 —— 那是我第一版写错的判据，被这条断言自己抓出来了。
	 */
	const lastLineEnd = Number.parseFloat(clip.last.top) + Number.parseFloat(clip.last.height);
	assert.ok(
		lastLineEnd > 0 && lastLineEnd <= 12,
		`末节点的线下端应停在圆点中心（≈9px）：top=${clip.last.top} height=${clip.last.height} → 停在 ${lastLineEnd}px`
	);
	assert.ok(
		Number.parseFloat(clip.last.height) < clip.last.markHeight,
		`末节点的线不该贯穿整个刻度槽：height=${clip.last.height} markHeight=${clip.last.markHeight}`
	);

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
	const brokenShot = await h.shoot("file-history-broken-light");

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
		 * P0-1 的**像素级**判据（独立评审就是这么测的）：broken 行整行 opacity 0.55，
		 * 它那句「为什么不能还原」如果还走 --text-secondary，两次降档相乘会把亮色对比度
		 * 压到 1.96:1 —— 读不出来等于没写。沿变化行的字带取最深像素：走 --text 约 115，
		 * 走 --text-secondary 约 185，阈值 150 落在两者中间，且与「画面有没有渲染」无关。
		 */
		const changeBox = await win.evaluate(() => {
			const el = document.querySelector(".fh-timeline .fh-node.broken .fh-node-change");
			if (el === null) return null;
			const r = el.getBoundingClientRect();
			return { viewportWidth: window.innerWidth, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
		});
		assert.ok(changeBox !== null, "找不到 broken 节点的变化行");
		const brokenScale = brokenShot.img.width / changeBox.viewportWidth;
		let changeDarkest = 255;
		for (let y = Math.round(changeBox.top * brokenScale); y < Math.round(changeBox.bottom * brokenScale); y += 1) {
			for (let x = Math.round(changeBox.left * brokenScale); x < Math.round(changeBox.right * brokenScale); x += 1) {
				const value = brokenShot.img.data[(y * brokenShot.img.width + x) * brokenShot.img.channels];
				if (value < changeDarkest) changeDarkest = value;
			}
		}
		assert.ok(
			changeDarkest <= 150,
			`broken 节点变化行的文字太淡（0.55 的行级 opacity 叠在 --text-secondary 上）：最深像素 ${changeDarkest}（走 --text 约 115，走 --text-secondary 约 185）`
		);

		/*
		 * 不可激活：点它不换选中、也不换预览。
		 *
		 * 判据取**选中节点的下标 + 它的变化行文案**，而不是时间文案：时间在两条路径上
		 * 都可能撞车（带秒之前是同一分钟；带秒之后也只是概率小），下标与文案是这一屏里
		 * 唯一不会重合的两个量（第一版拿时间比，反向验证时就发现它会假过）。
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
/** 用户在确认条里锁定的那一版（⑤ 记下、⑥ 用它守「还原理应停在它身上」）。 */
let restoreTargetTime = "";
await h.check("⑤ 点「还原到此版本」→ 就地确认条（无模态）说清文件、时间点与「先存成一条新版本」", async () => {
	const beforeConfirm = await readView();
	const targetNode = beforeConfirm.nodes.find((n) => n.selected);
	assert.ok(targetNode !== undefined, "确认前应有选中的节点");
	restoreTargetTime = targetNode.time;

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
	assert.match(s.confirmText, /\d{2}-\d{2} \d{2}:\d{2}:\d{2}/, `确认句要说清退到哪个时间点（且带秒）：${JSON.stringify(s.confirmText)}`);
	/*
	 * 确认句里的时间点必须**就是**选中那一版的身份行时间（P1-3 的实质）：
	 * 同一分钟内连着改过几次时，只到分钟的那句话同时对应好几行，用户在按下确认前
	 * 无法定位自己选的是哪一版 —— 而那正是二次确认的全部价值。
	 */
	assert.ok(
		s.confirmText.includes(restoreTargetTime),
		`确认句的时间点应逐字等于选中节点的时间：确认句 ${JSON.stringify(s.confirmText)} / 选中行 ${JSON.stringify(restoreTargetTime)}`
	);
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
	// 同时等到正文就位（刷新会把预览短暂换回加载态），否则下面的比较会拿到 null。
	const s = await waitView(
		(v) => v.nodes.length === 3 && v.previewBody !== null && v.nodes.some((n) => n.selected),
		"还原之后时间轴变成 3 个节点、且预览正文就位"
	);
	await h.shoot("file-history-restored-light");
	assert.equal(s.nodes.length, 3, `还原之后应有 3 个节点（2 版历史 + 还原留的那一版）：${JSON.stringify(s.nodes.map((n) => n.change))}`);
	assert.ok(
		s.nodes[2].source.includes("restore"),
		`新留下的那一版来源应是 restore：${JSON.stringify(s.nodes[2].source)}`
	);
	// 左列清单也跟着刷新（版本数从 2 变 3），不是只刷了右列。
	const row = s.rows.find((r) => r.name === FILE_NAME);
	assert.equal(row?.count, "3 版", `还原之后清单里的版本数也要刷新：${JSON.stringify(row?.count)}`);

	/*
	 * P0-2 的守门断言（独立评审）：还原成功后**高亮与预览都必须停在用户刚还原的那一版**上。
	 *
	 * 曾经的实现是「刷新后一律选末位」，而末位恰好是刚刚被覆盖掉的旧内容 ——
	 * 于是同一屏里 toast 说「已还原到 …」、画面主体却显示旧字节，用户读到的是
	 * 「没还原成功」或「还原到别的版本去了」。保留选中之后，预览正文**就等于磁盘内容**，
	 * 那才是能自我证明的成功现场。
	 */
	const selected = s.nodes.find((n) => n.selected);
	assert.ok(selected !== undefined, "还原之后应有选中的节点");
	assert.equal(selected.time, restoreTargetTime, `还原之后的选中应停在用户刚还原的那一版：${JSON.stringify(selected.time)} vs ${JSON.stringify(restoreTargetTime)}`);
	assert.equal(
		s.nodes.findIndex((n) => n.selected),
		1,
		`选中不该跳到末尾那条还原快照：${JSON.stringify(s.nodes.map((n) => (n.selected ? "选中" : "-")))}`
	);
	assert.equal(
		s.previewBody,
		expectedContent,
		"还原之后的预览正文应逐字节等于被还原的那一版（不是刚被覆盖掉的旧内容）"
	);
	assert.equal(s.previewBody, disk, "还原之后的预览正文应逐字节等于磁盘上的当前内容（这是「还原成功」唯一能自我证明的现场）");
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
