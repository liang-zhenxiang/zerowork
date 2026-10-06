/**
 * 本机模型服务（探测 + 一键接入）的 GUI 端到端测试。
 *
 * 覆盖的是**只有真实启动 Electron 才暴露的那一层**：探测 IPC 真的通、首页上手清单
 * 第 2 步真的会原地变身、点一下真的建好服务商并选中模型、发一条消息真的走通、
 * 设置页的六种形态真的互斥可辨。纯函数那部分（候选表形状、响应归类、baseUrl 规范化、
 * provider 构造、超时与并发上限）在 `tests/unit/local-endpoints*.test.mjs`，
 * 不在这里重复。
 *
 * ## 五个候选位全部由本用例自己占住 —— 为什么不直接用默认端口
 *
 * 真实机器上 11434 可能真的跑着 Ollama，那「未命中」这条路径就**不可复现**了。
 * 做法：先各绑一个临时端口拿到号、随即释放；这五个号在应用启动时**没人听**，
 * 于是「未命中」天然成立。之后要在某个位上起 mock 时，用同一个号 bind 回去即可
 * （`ZEROWORK_LOCAL_ENDPOINTS` 只覆盖端口，不新增候选、也不能改主机名 ——
 * 所以「只探回环、只探固定几项」这两条性质不因为可测而失效）。
 *
 * ## 「接入只发生一次」是怎么判的
 *
 * 判据是 **mock 侧 `/models` 的请求增量**，不是「界面看起来没报错」：
 * `connectLocalEndpoint` 每被调用一次，daemon 就会**重新探一次**那个端点
 * （不信任渲染层传来的模型清单）—— 于是「接入发生了 N 次」在 mock 上留下
 * N 条 `/models` 请求。这是可观察的副作用，无法伪造（测试规范 §三.5）。
 *
 * 刻意**不**用「models.json 里的模型数翻倍」当判据：重复接入写的是同一个服务商 id，
 * `upsertCustomProvider` 是覆盖式写入，模型数**不会**翻倍 —— 拿它当判据是一条
 * 永远绿的假断言。
 *
 * ## 「探测未完成」那个窗口怎么取证 —— 确定性握手，不是采样
 *
 * 那个窗口只存在于「探测的 promise 还没 settle」这一段：正常路径（端口没人听）
 * 几十毫秒就回来了，靠轮询去抓必然 flaky。本用例的做法是**不抓它，而是控制它**：
 *
 *   ① 在 ollama 那个位上起一个「接着但**不**回话」的服务（`startHangingServer`）。
 *      它把每个 `/models` 请求一直挂住，**直到测试显式 `release()`** ——
 *      于是「探测未完成」这一段有多长由测试决定，而不是由 daemon 那 800ms 超时决定；
 *   ② 点「模型」之后在**页内**（同一个 JS 任务里）读到区块挂载那一刻的形态：骨架在不在、
 *      空态文案在不在。页内轮询用 setTimeout，**不用 rAF** —— 窗口被遮挡时 Chromium
 *      会暂停 rAF，而 DOM 与定时器不受影响；
 *   ③ 断言完「挂载那一刻」再 `release()` 让探测收口，然后等空态真的出现。
 *
 * 每一步都由一个**可观察的条件**推进：没有逐帧采样、没有 sleep（测试规范 §三.1）。
 * 前两版分别是 rAF 逐帧采样与 MutationObserver 全量记录，都假红过（「一帧骨架都没采到，
 * 共 99 帧」「emptyFrames = 0」）—— 两者都是「事后去翻一份记录」的形态：只要记录器的
 * 开停与真实状态之间有一拍错位，断言就会指向错误的方向。**时序要由测试握着，不要靠采样。**
 *
 * ## 反向验证记录
 *
 * 本轮（把时序钉死之后）真跑并逐条还原。注入面都在 `src/renderer/src/app.js`，
 * **每次注入与还原都要 `npm run build`** —— e2e 跑的是 `out/` 的构建产物，
 * 不重建等于什么都没注入（第一次做这轮验证时就白跑过一轮）。
 *
 * （1）去掉首页接入的进行中守卫（`connectGuard.current ||` 那半句）→
 *      **恰好一条**变红：「连点两下「接上」只接入一次」，实测增量 2 ≠ 1，其余 14 条全绿。
 *      （顺带证实「模型数翻倍」那条判据是假的 —— 第二次接入是覆盖式写入。）
 * （2）把设置页的 `probe === void 0`（骨架分支）改成 `false`，让「探测未回来」落进
 *      空态分支 → **恰好一条**变红：「探测未完成时设置页是骨架」，实测现场
 *      `{"clicked":true,"mounted":true,"skeleton":false,"empty":true}`，其余 14 条全绿。
 *      这条比原来的采样版更强：它读的是**区块挂载那一刻**的 DOM，而不是
 *      「某次记录里有没有出现过」——而且失败信息直接就是「加载态与空态混了」那个形状。
 *
 * 历史记录（改动面与这两条无关，本轮未复跑）：把 `connectLocalEndpoint` 的成功分支改成
 * 「不真写配置、直接回 ok:true」→ 4 条变红：连点守卫那条 + 「接入后这一步变成已完成」
 * + 「接入后发一条消息真的走通」+ 「接入后设置页同一行显示「已接入」」。
 *
 * ⚠️ 还原时踩到过一次：`cp 备份 源文件` 之后紧接着用基于缓存缓冲区的编辑器改同一个文件，
 * 编辑器把**还原前的注入**又写了回去 —— 于是那一次的反向验证多红了一条，结论被污染。
 * 还原后一定要 `diff 备份 源文件` 核对，别只看 sha256（那次 sha 是对的，内容却是旧的）。
 *
 * ## 回归（改完时序之后）
 *
 * 连跑 **10 次全绿**（改完后 5 次 + 反向验证还原构建后再 5 次），单次约 12 秒。
 * 改之前同一份用例连跑 4 次拿到 3 种结果：11/15、15/15、14/15、14/15。
 *
 * ## ⚠️ 关于等待
 *
 * 所有 `waitUntil` 的谓词都**能返回假值**（测试规范 §三.1）。导航后、进入视图后
 * 是空闲态，可以用 `waitForSettled()`；但**模型回合进行中不要用**它
 * （回合中有 500ms 级计时器在改 DOM，永远达不到「连续静默」）。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { createHarness, waitUntil } from "./lib/harness.mjs";
import { startMockModelServer } from "./mock-model-server.mjs";

/** 候选表的五个 id，顺序与 `src/main/daemon/local-endpoints.js` 的候选表一致。 */
const CANDIDATE_IDS = ["ollama", "lmstudio", "vllm", "localai", "jan"];

/**
 * 预留 `count` 个「现在没人听」的空闲端口：各绑一个临时端口拿到号，随即释放。
 * 释放后系统看来它就是空闲的（connect 立刻被拒）—— 这正是「未命中」要的前提。
 */
async function reserveFreePorts(count) {
	const servers = await Promise.all(
		Array.from(
			{ length: count },
			() =>
				new Promise((resolve) => {
					const server = createServer();
					server.listen(0, "127.0.0.1", () => resolve(server));
				}),
		),
	);
	const ports = servers.map((server) => server.address().port);
	await Promise.all(servers.map((server) => new Promise((r) => server.close(r))));
	return ports;
}

/**
 * 一个「接着但**不**回话」的 HTTP 服务：每个请求都被挂住，直到测试调用 `release()`。
 *
 * 用途只有一个 —— 把「探测还没回来」那个窗口变成**由测试握着**的一段。
 * `release()` 之前一定没有任何响应会被写回去，所以「区块挂载那一刻是骨架」这条断言
 * 不依赖时钟、不依赖采样、也不依赖 daemon 那 800ms 超时（超时之前就断言完了）。
 *
 * `release()` 回 503：四态归类里它是 `unreachable`（非 2xx 且不是 401/403），
 * 于是放开之后界面会收口到「没有探到本机模型服务」空态 —— 正是本条要等的那个终态。
 */
function startHangingServer(port) {
	const held = [];
	const sockets = new Set();
	const server = createServer((_req, res) => {
		/* 刻意不写任何响应：这就是「未完成」本身 */
		res.on("error", () => {
			/* 客户端先断开时（daemon 那 800ms 上限比我们早到）别让它升级成未捕获异常 */
		});
		held.push(res);
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	return new Promise((resolve) => {
		server.listen(port, "127.0.0.1", () => {
			resolve({
				port,
				/** 还被挂着的请求数 —— 「探测真的卡在未完成态」的直接证据 */
				heldCount: () => held.length,
				/** 放开全部挂起的请求：回 503（归类为 unreachable），探测随之收口。 */
				release: () => {
					for (const res of held.splice(0)) {
						try {
							res.writeHead(503, { "content-type": "application/json" });
							res.end(JSON.stringify({ error: { message: "held by test" } }));
						} catch {
							/* 客户端已经先断开（daemon 的 800ms 上限比 release 早到）：
							   那一条不影响结论 —— 探测同样会收口成 unreachable。 */
						}
					}
				},
				close: () =>
					new Promise((r) => {
						for (const socket of sockets) socket.destroy();
						server.close(r);
					}),
			});
		});
	});
}

const ports = await reserveFreePorts(CANDIDATE_IDS.length);
const PORT = Object.fromEntries(CANDIDATE_IDS.map((id, index) => [id, ports[index]]));
const ENDPOINT_ENV = CANDIDATE_IDS.map((id) => `${id}=${PORT[id]}`).join(",");

/**
 * mock 在 `/models` 上宣称的模型。**断言里的模型数取自 `mockOllama.modelIds.length`**，
 * 不写死一个数字再让 mock 去凑 —— 那样数据一改测试还是绿。
 * 三个（不是一两个）是为了让「N 个模型」那个 N 不是恒等于 1 的巧合。
 */
const OLLAMA_MODELS = ["llama3.2", "qwen2.5:7b", "gemma3:4b"];

const h = createHarness({
	name: "local-model-discovery",
	env: { ZEROWORK_LOCAL_ENDPOINTS: ENDPOINT_ENV },
});
// harness 负责隔离与清空工作区根目录，目录本身要由用例建出来
mkdirSync(h.WORKSPACE_DIR, { recursive: true });

await h.launch();
const win = h.window();

/**
 * 中途起来的 mock 全部登记在这里（ollama 位一个、后来换成空清单的又一个、
 * lmstudio 位一个要鉴权的）。**只在收尾时按顺序关掉**，以及骨架那一段整体关掉 ——
 * 漏关会让后面的 `close()` 挂在 daemon 与 mock 之间还活着的长连接上。
 */
const mocks = [];
async function startMock(opts) {
	const mock = await startMockModelServer(opts);
	mocks.push(mock);
	return mock;
}

/* ══ 读回界面的小工具 ═══════════════════════════════════════════════════ */

/** 首页上手清单每行的正文 / 按钮 / 图标形态 / 是否可点。第 2 行是「模型」那一步。 */
const readGuideRows = () =>
	win.evaluate(() =>
		[...document.querySelectorAll(".home-guide-row")].map((row) => {
			const button = row.querySelector(".mini-btn");
			return {
				text: (row.querySelector(".home-guide-text")?.textContent ?? "").trim(),
				action: button === null ? null : (button.textContent ?? "").trim(),
				iconLen: (row.querySelector(".home-guide-icon svg")?.innerHTML ?? "").length,
				clickable: row.classList.contains("home-guide-row-action"),
				disabled: button?.disabled === true,
			};
		}),
	);

/** 按钮文案去掉尾部的「 →」。 */
const buttonLabel = (action) => (action === null ? null : action.replace(/\s*→\s*$/, "").trim());

/**
 * 「改动之前的现状」有**两对**（文案, 按钮）—— 未命中本机服务时，第 2 步必须
 * **恰好**落到其中一对，不许混搭（新文案配旧按钮同样是错的）。
 *
 * ## 为什么是两对而不是一对
 *
 * 出现哪一句由 `judgeModelReadiness()` 决定，而它看的是**这台机器配没配服务商**，
 * 与本功能毫无关系：
 *
 * | 判据 | `guideText()` 给出 |
 * | --- | --- |
 * | 一个 `available` 模型都没有 → `{kind:"no-model-at-all"}` | 第一对 |
 * | 有可用模型但没选中它 → `{kind:"model-not-usable"}` | 第二对 |
 *
 * 判据在 `src/renderer/src/app.js:15159`（`no-model-at-all` 在 `:15161`、
 * `model-not-usable` 在 `:15163`），文案在 `app.js:15165` 的 `guideText()`。
 *
 * 两条真实环境各走一边，**写死一对必然在另一边红**（这是 PR #149 在 CI 上红的根因）：
 *   - CI runner：没有任何服务商 → `available` 为空 → 第一对
 *   - 本机开发机：`ANTHROPIC_AUTH_TOKEN` 让 Anthropic 可用 → 第二对
 *
 * 复现 CI 那一侧：`env -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_API_KEY npm run test:gui:local-model-discovery`
 *
 * ⚠️ 改 `guideText()` 时这里要同步；两对都改掉而这条测试仍绿，说明判据被削成了同义反复。
 */
const CURRENT_GUIDE_PAIRS = [
	{ text: "还没有可用模型，现在还不能开始对话", action: "去设置里填 API Key" },
	{ text: "还没有选定要用哪个模型", action: "去选一个模型" },
];

/** 「本机模型服务」区块的全部可读形态。 */
const readLocalSection = () =>
	win.evaluate(() => {
		const section = document.querySelector("[data-local-services]");
		if (section === null) return null;
		return {
			heading: (section.querySelector("h2")?.textContent ?? "").trim(),
			privacy: (section.querySelector(".settings-hint")?.textContent ?? "").trim(),
			text: section.innerText,
			emptyTitle: (section.querySelector(".state-empty-title")?.textContent ?? "").trim(),
			skeleton: section.querySelector('[aria-label="正在探测本机模型服务"]') !== null,
			rowCount: section.querySelectorAll(".provider-row").length,
			buttons: [...section.querySelectorAll(".mini-btn")].map((b) => (b.textContent ?? "").trim()),
			rows: [...section.querySelectorAll(".provider-row")].map((row) => ({
				name: (row.querySelector(".provider-name")?.textContent ?? "").trim(),
				meta: (row.querySelector(".provider-meta")?.textContent ?? "").trim(),
				hint: (row.querySelector(".provider-hint")?.textContent ?? "").trim(),
				tag: (row.querySelector(".provider-tag")?.textContent ?? "").trim(),
				button: row.querySelector(".mini-btn") === null ? null : (row.querySelector(".mini-btn").textContent ?? "").trim(),
				green: row.querySelector(".provider-dot.on") !== null,
			})),
		};
	});

/** 按服务名取一行（行的顺序会按模型数变，所以不按下标取）。 */
const localRow = (section, name) => (section?.rows ?? []).find((row) => row.name === name) ?? null;

/**
 * 扫一个区域里有没有 danger 色的元素。
 *
 * 做法：临时挂一个探针元素读 `var(--danger)` 的**计算值**（token 的单一真源在 app.css，
 * 深浅两套不同，不能写死 rgb），再逐个元素比对 color / background / 四边 border。
 * 比「有没有红点」这种肉眼判断可证伪得多。
 *
 * `nth` 取第几个匹配元素（默认 0，与 `querySelector` 同义）；传入下标才能把范围收到
 * 清单里的**某一行**上，失败信息才指得准。
 */
const scanDanger = (selector, nth = 0) =>
	win.evaluate(({ sel, index }) => {
		const scope = document.querySelectorAll(sel)[index] ?? null;
		if (scope === null) return { present: false, danger: [] };
		const probe = document.createElement("span");
		probe.setAttribute("aria-hidden", "true");
		probe.style.cssText = "position:absolute;left:-9999px;color:var(--danger);background-color:var(--danger)";
		document.body.appendChild(probe);
		const style = getComputedStyle(probe);
		const danger = { color: style.color, bg: style.backgroundColor };
		probe.remove();
		const hits = [];
		for (const el of [scope, ...scope.querySelectorAll("*")]) {
			const s = getComputedStyle(el);
			const matched =
				s.color === danger.color ||
				s.backgroundColor === danger.bg ||
				[s.borderTopColor, s.borderRightColor, s.borderBottomColor, s.borderLeftColor].includes(danger.color);
			if (!matched) continue;
			const cls = typeof el.className === "string" ? el.className : "";
			hits.push(`${el.tagName.toLowerCase()}.${cls} —— ${(el.textContent ?? "").trim().slice(0, 40)}`);
		}
		return { present: true, danger: hits };
	}, { sel: selector, index: nth });

/**
 * 首页首屏（清单 + 输入区）的可见文字与 toast 数。
 *
 * 范围**刻意限定**在这两块：案例卡的说明文字里本来就出现过「错误」二字
 * （`resources/welcome/cases.json` 实测 1 处），扫整屏会得到一条与本次改动无关的假红。
 */
const readHomeSurface = () =>
	win.evaluate(() => {
		const zones = [".home-guide", ".composer-zone"]
			.map((sel) => document.querySelector(sel))
			.filter((el) => el !== null);
		return {
			text: zones.map((el) => el.innerText).join("\n"),
			toasts: document.querySelectorAll(".toast").length,
		};
	});

/* ══ 导航 ═══════════════════════════════════════════════════════════════ */

/** 打开设置对话框（SettingsView 是条件挂载的，关掉即卸载 —— 下次打开会重新探测）。 */
async function openSettingsDialog() {
	await win.evaluate(() => document.querySelector('[aria-label="设置"]')?.click());
	await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") !== null), {
		timeout: 20_000,
		desc: "设置对话框挂上（.settings-card）",
	});
}

/** 点设置侧栏里的「模型」分组。 */
const clickModelsTab = () =>
	win.evaluate(() => {
		const item = [...document.querySelectorAll(".settings-nav-item")].find((n) => (n.textContent || "").trim() === "模型");
		if (item === undefined) return false;
		item.click();
		return true;
	});

/**
 * 打开设置 → 模型 页，并等区块收口。
 *
 * 只用于「区块该显示什么」那几条 —— 它末尾会 `waitForSettled()`（导航后是空闲态，
 * 安全），骨架那条**不能**走这里：`waitForSettled` 会一路等到探测收口之后，
 * 挂载那一刻的形态就再也看不到了。那条走 `openModelsTabAndReadMount`。
 */
async function openSettingsModels() {
	await openSettingsDialog();
	assert.ok(await clickModelsTab(), "设置侧栏里找不到「模型」分组");
	await waitUntil(() => win.evaluate(() => document.querySelector("[data-local-services]") !== null), {
		timeout: 20_000,
		desc: "「本机模型服务」区块挂上（[data-local-services]）",
	});
	await win.evaluate(() => document.querySelector("[data-local-services]")?.scrollIntoView({ block: "center" }));
	// 对话框是**渐入**的（--dur-fast 的透明度过渡）：不等它静下来截，图是半透明的
	// —— 像素断言过得去（不是纯色），但那张图作为 review 现场没有价值。
	// 这里是导航后的空闲态，用 waitForSettled 是安全的（模型回合中才不能用）。
	await h.waitForSettled();
}

/**
 * 点「模型」并在**页内**等到区块挂载，返回挂载那一刻的形态。
 *
 * 三个刻意的做法：
 *   - 挂载检测与形态读取在**同一个 JS 任务**里完成（两行之间没有 await），所以读到的
 *     一定是「区块挂载后的第一份 DOM」—— 这就是 docs/DESIGN.md §4 那条
 *     「数据到达前不得显示无数据类文案」的直接证据，且是确定的；
 *   - 不在 Node 侧轮询：harness 的 waitUntil 默认间隔 250ms，会比挂载晚最多 250ms
 *     才看到区块，白白吃掉窗口；
 *   - 页内轮询用 setTimeout，**不用 rAF**（窗口被遮挡时 Chromium 会暂停 rAF）。
 */
const openModelsTabAndReadMount = () =>
	win.evaluate(async () => {
		const item = [...document.querySelectorAll(".settings-nav-item")].find((n) => (n.textContent || "").trim() === "模型");
		if (item === undefined) return { clicked: false, mounted: false };
		item.click();
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			const section = document.querySelector("[data-local-services]");
			if (section !== null) {
				return {
					clicked: true,
					mounted: true,
					skeleton: section.querySelector('[aria-label="正在探测本机模型服务"]') !== null,
					empty: (section.querySelector(".state-empty-title")?.textContent ?? "").includes("没有探到本机模型服务"),
				};
			}
			await new Promise((r) => setTimeout(r, 10));
		}
		return { clicked: true, mounted: false };
	});

/** 关掉设置对话框（SettingsView 是条件挂载的，关掉即卸载 —— 下次打开会重新探测）。 */
async function closeSettings() {
	await win.evaluate(() => document.querySelector('[aria-label="关闭设置"]')?.click());
	await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") === null), {
		timeout: 20_000,
		desc: "设置对话框关闭（.settings-card 消失）",
	});
}

/** 回首页（侧栏「新建任务」在任何视图下都在）。 */
async function goHome() {
	await win.evaluate(() => {
		[...document.querySelectorAll("button")].find((b) => (b.textContent || "").includes("新建任务"))?.click();
	});
	await waitUntil(() => win.evaluate(() => document.querySelector(".home-guide") !== null), {
		timeout: 30_000,
		desc: "首页上手清单挂上（.home-guide）",
	});
}

/** 切主题（截图用）。切完等属性真的落上再截。 */
async function setTheme(theme) {
	await win.evaluate((value) => {
		void window.kami?.setThemePreference?.(value);
		document.documentElement.setAttribute("data-theme", value);
	}, theme);
	await waitUntil(() => win.evaluate((value) => document.documentElement.dataset.theme === value, theme), {
		timeout: 10_000,
		desc: `data-theme 切到 ${theme}`,
	});
	await h.waitForSettled();
}

/* ══════════════════════════════════════════════════════════════════════
 * ① 未命中：应用刚起来，五个候选端口一个都没人听
 * ══════════════════════════════════════════════════════════════════════ */

// 先截图、后断言：截图在前，断言失败时才有现场
await waitUntil(() => win.evaluate(() => document.querySelector(".home-guide") !== null), {
	timeout: 30_000,
	desc: "首页上手清单挂上（.home-guide）",
});
await h.shoot("home-unmatched-light");

await h.check("未命中：首页第 2 步恰好是「现状」两对文案之一，且不出现命中形态", async () => {
	const rows = await readGuideRows();
	assert.ok(rows.length >= 3, `清单行数=${rows.length}，读不到三步`);
	const model = rows[1];
	const action = buttonLabel(model.action);
	/*
	 * 未命中本机服务时**不得**出现命中形态 —— 这才是这条断言真正要守的东西：
	 * 我们加了探测功能，但不许它把未命中的第 2 步改样（冒出「正在探测」、
	 * 冒出「没探到」、或者没探到却给出「接上」按钮）。
	 * （`本机 … 正在运行` 与按钮 `接上` 同源于 app.js 的 `connectable`，
	 *   后者只在 `!modelReady` 且探测命中时才挂上。）
	 *
	 * 这一条**排在整对匹配之前**：一个「未命中却显示命中形态」的缺陷同时会让下面那条
	 * 断言也失败，先跑这里，失败信息才指向真正的原因（而不是「不在那两对里」）。
	 */
	assert.ok(
		!model.text.includes("正在运行") && action !== "接上",
		`未命中本机服务，第 2 步却是命中形态：text=${JSON.stringify(model.text)} action=${JSON.stringify(action)}`,
	);
	/*
	 * 整对匹配（见 `CURRENT_GUIDE_PAIRS` 的注释）：两对里的**任意一对**都合法，
	 * 但必须整对 —— 新文案配旧按钮同样是错的，所以不拆成两条各判一半。
	 */
	const allowed = CURRENT_GUIDE_PAIRS.map((pair) => `${pair.text} / ${pair.action}`).join("　或　");
	assert.ok(
		CURRENT_GUIDE_PAIRS.some((pair) => pair.text === model.text && pair.action === action),
		`未命中时第 2 步不是「现状」的任何一对：text=${JSON.stringify(model.text)} ` +
			`action=${JSON.stringify(action)}；允许的是 ${allowed}`,
	);
	assert.ok(model.clickable, "未完成的第 2 步应当是整行可点的（.home-guide-row-action）");
	// 探测未命中不是错误：这一行不许挂 danger 色（`--danger` 的计算值随深浅主题变，不能写死）
	const danger = await scanDanger(".home-guide-row", 1);
	assert.ok(danger.present, "读不到清单第 2 行，无从断言它有没有 danger 色");
	assert.deepEqual(danger.danger, [], `未命中时第 2 步出现了 danger 色元素：${danger.danger.join("；")}`);
});

await h.check("未命中：首屏不出现「没探到 / 未探到 / 失败 / 错误」字样，也没有 danger 色元素", async () => {
	const surface = await readHomeSurface();
	for (const word of ["没探到", "未探到", "失败", "错误"]) {
		assert.ok(!surface.text.includes(word), `未命中时首屏出现了「${word}」：${surface.text.slice(-300)}`);
	}
	assert.equal(surface.toasts, 0, "未命中时弹出了 toast（那不是错误，不该打扰用户）");
	const danger = await scanDanger(".home-guide");
	assert.ok(danger.present, "首页清单不在，无从断言（前一条已经挂了？）");
	assert.deepEqual(danger.danger, [], `未命中时清单里出现了 danger 色元素：${danger.danger.join("；")}`);
});

await h.check("未命中：设置页是空态，未探到的候选折叠在一句话之后（不是一片红叉）", async () => {
	await openSettingsModels();
	await waitUntil(async () => (await readLocalSection())?.emptyTitle === "没有探到本机模型服务", {
		timeout: 20_000,
		desc: "设置页落回「没有探到本机模型服务」空态",
	});
	const section = await readLocalSection();
	await h.shoot("settings-unmatched-light");
	assert.ok(section !== null, "「本机模型服务」区块没挂上");
	assert.equal(section.heading, "本机模型服务", `区块标题是「${section.heading}」`);
	assert.ok(
		section.privacy.includes("127.0.0.1") && section.privacy.includes("不扫描网络、不出网"),
		`隐私边界那句话不对：${JSON.stringify(section.privacy)}`,
	);
	assert.equal(section.emptyTitle, "没有探到本机模型服务", `未命中时不是空态：${JSON.stringify(section.emptyTitle)}`);
	assert.equal(section.rowCount, 0, `未命中时不该直接摊出候选行，实际 ${section.rowCount} 行`);
	assert.ok(
		section.buttons.includes(`查看其余 ${CANDIDATE_IDS.length} 个未探到的服务`),
		`缺少折叠入口：${JSON.stringify(section.buttons)}`,
	);
});

await h.check("未命中：展开折叠后才出现 5 行「未探到」（灰点），且全程没有 danger 色", async () => {
	const opened = await win.evaluate((label) => {
		const button = [...document.querySelectorAll("[data-local-services] .mini-btn")].find(
			(b) => (b.textContent || "").trim() === label,
		);
		if (button === undefined) return false;
		button.click();
		return true;
	}, `查看其余 ${CANDIDATE_IDS.length} 个未探到的服务`);
	assert.ok(opened, "找不到折叠入口按钮");
	await waitUntil(
		async () => ((await readLocalSection())?.rowCount ?? 0) === CANDIDATE_IDS.length,
		{ timeout: 15_000, desc: `展开后出现 ${CANDIDATE_IDS.length} 行未探到的候选` },
	);
	const section = await readLocalSection();
	await h.shoot("settings-unmatched-expanded-light");
	for (const id of CANDIDATE_IDS) {
		const name = { ollama: "Ollama", lmstudio: "LM Studio", vllm: "vLLM", localai: "LocalAI", jan: "Jan" }[id];
		const row = localRow(section, name);
		assert.ok(row !== null, `展开后没有「${name}」那一行：${JSON.stringify(section.rows)}`);
		assert.ok(row.meta.includes("未探到"), `「${name}」那行没有标「未探到」：${JSON.stringify(row.meta)}`);
		assert.equal(row.green, false, `「${name}」没探到却挂了绿点`);
	}
	const danger = await scanDanger("[data-local-services]");
	assert.deepEqual(danger.danger, [], `未探到的候选被画成了危险色：${danger.danger.join("；")}`);
});

/* ══════════════════════════════════════════════════════════════════════
 * ② 命中：把 mock 起在 ollama 那个位上（**没有**关掉上面那台应用）
 * ══════════════════════════════════════════════════════════════════════ */

const mockOllama = await startMock({ port: PORT.ollama, models: OLLAMA_MODELS, reply: "LOCAL_MODEL_OK" });

await closeSettings();
await waitUntil(() => win.evaluate(() => document.querySelector(".home-guide") !== null), {
	timeout: 30_000,
	desc: "关掉设置后回到首页（清单重新挂载 → 会重新探一次）",
});

await h.check("命中：设置页列出本机 Ollama、N 个模型，动作位是「接入」", async () => {
	await openSettingsModels();
	// 载入后区块会先探一次（挂载时自动探）；等那一行真的落上再断言
	await waitUntil(
		async () => localRow(await readLocalSection(), "Ollama") !== null,
		{ timeout: 20_000, desc: "设置页列出本机 Ollama 那一行" },
	);
	const section = await readLocalSection();
	await h.shoot("settings-hit-light");
	assert.ok(section !== null, "「本机模型服务」区块没挂上");
	const row = localRow(section, "Ollama");
	assert.equal(
		row.meta,
		`127.0.0.1:${PORT.ollama} · ${mockOllama.modelIds.length} 个模型`,
		`那一行的状态不对：${JSON.stringify(row.meta)}（期望模型数取自 mock.modelIds.length）`,
	);
	assert.equal(row.button, "接入", `未接入时动作位应当是「接入」，实际 ${JSON.stringify(row.button)}`);
	assert.equal(row.green, true, "探到了却没挂绿点（「服务在」这个状态读不出来）");
	assert.equal(row.tag, "", "还没接入就标了「已接入」");
	const danger = await scanDanger("[data-local-services]");
	assert.deepEqual(danger.danger, [], `命中态出现了 danger 色：${danger.danger.join("；")}`);
});

await h.check("命中：设置页的「本机模型服务」在深色下也正常渲染（截图 + 像素断言）", async () => {
	await setTheme("dark");
	await h.shoot("settings-hit-dark");
	await setTheme("light");
});

await closeSettings();

await h.check("命中：首页第 2 步变成「接上本机 Ollama（N 个模型）」", async () => {
	// 关掉设置 → 首页重新挂载 → 重新探一次；等文案真的变过来
	await waitUntil(
		async () => ((await readGuideRows())[1]?.text ?? "").includes("本机 Ollama 正在运行"),
		{ timeout: 20_000, desc: "首页第 2 步变成「本机 Ollama 正在运行」" },
	);
	await h.shoot("home-hit-light");
	const rows = await readGuideRows();
	const model = rows[1];
	assert.equal(
		model.text,
		`本机 Ollama 正在运行（${mockOllama.modelIds.length} 个模型）`,
		`命中时第 2 步文案不对：${JSON.stringify(model.text)}`,
	);
	assert.equal(buttonLabel(model.action), "接上", `命中时按钮应当是「接上」，实际 ${JSON.stringify(model.action)}`);
	assert.ok(model.clickable, "命中时第 2 步应当仍然整行可点");
});

await h.check("命中：首页命中态在深色下也正常渲染（截图 + 像素断言）", async () => {
	await setTheme("dark");
	await h.shoot("home-hit-dark");
	await setTheme("light");
});

/* ══════════════════════════════════════════════════════════════════════
 * ③ 接入：连点两下只发生一次（进行中守卫），一步变成已完成
 * ══════════════════════════════════════════════════════════════════════ */

const iconBefore = ((await readGuideRows())[1] ?? {}).iconLen;

await h.check("连点两下「接上」只接入一次（mock 侧 /models 请求增量 = 1）", async () => {
	/*
	 * 点击之前先把「这一行**此刻**真的处于命中态」等出来。
	 *
	 * 文案与按钮同源于同一个 `connectable`（见 app.js 的 rows[1]）：只有两者同时成立，
	 * `connectLocal` 才不会因为 `connectable === undefined` 直接 return。等到了就**紧挨着**
	 * 派发点击，不给出「点在过期的界面上」的窗口 —— 这条断言的时序自此与界面的重渲染解耦。
	 */
	await waitUntil(
		async () => {
			const row = (await readGuideRows())[1];
			return (
				row?.text === `本机 Ollama 正在运行（${mockOllama.modelIds.length} 个模型）` &&
				buttonLabel(row.action) === "接上"
			);
		},
		{ timeout: 30_000, interval: 100, desc: "点击前第 2 步处于命中态（命中文案 + 「接上」按钮）" },
	);
	const probesBefore = mockOllama.probeRequests.length;

	/*
	 * 一次性派发**两下点击**：第一下是正常的一击，第二下是「用户真的连点两下」。
	 * 两下都在同一个 JS 任务里派发，所以不存在「第一轮已经跑完了」的窗口 ——
	 * 这条断言于是是确定性的，不靠手速，也不靠 sleep。
	 * 点的是行内的 `.home-guide-text`（行本体在接入中**不**禁用，这正是要兜的场景：
	 * 行与行内按钮是两条通往同一动作的路径）。
	 */
	const clicked = await win.evaluate(() => {
		const row = document.querySelectorAll(".home-guide-row")[1];
		const target = row?.querySelector(".home-guide-text");
		if (target === null || target === undefined) return false;
		target.click();
		target.click();
		return true;
	});
	assert.ok(clicked, "找不到首页第 2 步的行内文字节点");

	// ① 先等**对端的副作用**：点击真的走到了 daemon（每次接入它都会重新探一次端点）。
	//    与下一步分开，失败时一眼能看出断的是哪一段：这一段红 = 点击没落到动作上；
	//    这一段绿、下一段红 = 动作发生了但配置/选中没走通。
	await waitUntil(() => mockOllama.probeRequests.length > probesBefore, {
		timeout: 30_000,
		desc: "点击后 mock 收到接入时的重新探测（说明点击真的走到了 connectLocalEndpoint）",
	});
	// ② 再等界面收口
	try {
		await waitUntil(async () => (await readGuideRows())[1]?.text === "已选定可用模型", {
			timeout: 30_000,
			desc: "接入完成后第 2 步变成「已选定可用模型」",
		});
	} catch (error) {
		// 把现场读出来再抛：这几种形态指向的原因完全不同（toast 里有 daemon 给的原因，
		// usable 里有没有那个模型键则区分「配置没写成」与「写成了但判据没认」）。
		const scene = await win.evaluate(async () => {
			const rows = [...document.querySelectorAll(".home-guide-row")].map((row) =>
				(row.querySelector(".home-guide-text")?.textContent ?? "").trim(),
			);
			const toasts = [...document.querySelectorAll(".toast")].map((t) => (t.textContent ?? "").trim());
			const snapshot = await window.kami.settingsSnapshot().catch(() => void 0);
			return {
				rows,
				toasts,
				activeModelId: snapshot?.activeModelId,
				usable: (snapshot?.models ?? []).filter((m) => m.available).map((m) => `${m.providerId}/${m.id}`),
			};
		});
		throw new Error(`${error.message}｜失败现场：${JSON.stringify(scene)}`);
	}
	const delta = mockOllama.probeRequests.length - probesBefore;
	assert.equal(
		delta,
		1,
		`连点两下发生了 ${delta} 次接入（期望 1）。每次接入 daemon 都会重新探一次端点，` +
			`所以 /models 的增量就是接入次数 —— 增量 2 说明进行中守卫没兜住`,
	);
});

await h.check("接入后首页第 2 步变成已完成（文案 + 对勾 + 不见按钮）", async () => {
	await h.shoot("home-connected-light");
	const rows = await readGuideRows();
	const model = rows[1];
	assert.equal(model.text, "已选定可用模型", `接入后第 2 步文案不对：${JSON.stringify(model.text)}`);
	assert.equal(model.action, null, `已完成的行还留着动作按钮：${JSON.stringify(model.action)}`);
	assert.equal(model.clickable, false, "已完成的行不该再挂 .home-guide-row-action");
	assert.notEqual(
		model.iconLen,
		iconBefore,
		"接入后行图标没有换成对勾（innerHTML 长度与接入前一致）—— 这一步看上去没完成",
	);
});

await h.check("接入后发一条消息真的走通：mock 收到 /chat/completions，且用的就是被接入的那个模型", async () => {
	const box = win.locator('textarea[aria-label="消息输入框"]');
	await box.waitFor({ state: "visible", timeout: 30_000 });
	await box.fill("本机模型在吗");
	await box.press("Enter");
	// 「发出去了没有」要验证到**对端的副作用**，不能只看「没报错」
	await waitUntil(() => mockOllama.requests.some((q) => q.url?.includes("/chat/completions")), {
		timeout: 60_000,
		desc: "mock 本机模型服务收到 /chat/completions 请求",
	});
	await h.snap("home-message-sent-light");
	const chat = mockOllama.requests.find((q) => q.url?.includes("/chat/completions"));
	assert.equal(
		chat.body?.model,
		OLLAMA_MODELS[0],
		`发出去的请求用的模型是 ${JSON.stringify(chat.body?.model)}，不是接入时选中的 ${OLLAMA_MODELS[0]}`,
	);
	// 请求**只可能**来自 mockOllama —— 它单独监听着 PORT.ollama，收到就说明打对了端点。
	// 这一条补的是 baseUrl 规范化：接入时探的是 `…/v1/models`，对话必须落在 `…/v1/chat/completions`
	// 那一层（填到根路径的话这里会变成 `/chat/completions`）。
	assert.equal(chat.url, "/v1/chat/completions", `请求路径不对（baseUrl 没规范化到 /v1 那一层）：${chat.url}`);
});

/* ══════════════════════════════════════════════════════════════════════
 * ④ 已接入状态 + 两种「探到了但不是 ready」的形态
 * ══════════════════════════════════════════════════════════════════════ */

await h.check("接入后设置页同一行变成「已接入」，且不再给接入按钮", async () => {
	await goHome();
	await openSettingsModels();
	await waitUntil(async () => localRow(await readLocalSection(), "Ollama")?.tag === "已接入", {
		timeout: 20_000,
		desc: "设置页那一行标上「已接入」",
	});
	await h.shoot("settings-connected-light");
	const row = localRow(await readLocalSection(), "Ollama");
	assert.ok(row.meta.includes("个模型"), `已接入那行的模型数丢了：${JSON.stringify(row.meta)}`);
	assert.equal(row.button, null, `已接入的行还在给「接入」按钮：${JSON.stringify(row.button)}`);
});

await h.check("探到但零模型：显示「已探到，但还没有模型」+ 指引语，且**没有**接入按钮", async () => {
	await mockOllama.close();
	await startMock({ port: PORT.ollama, models: OLLAMA_MODELS, modelsEmpty: true });
	const reprobe = await win.evaluate(() => {
		const button = [...document.querySelectorAll("[data-local-services] .mini-btn")].find(
			(b) => (b.textContent || "").trim() === "重新探测",
		);
		if (button === undefined) return false;
		button.click();
		return true;
	});
	assert.ok(reprobe, "设置页没有「重新探测」按钮");
	await waitUntil(async () => (await readLocalSection())?.text.includes("已探到，但还没有模型") === true, {
		timeout: 20_000,
		desc: "重新探测后 Ollama 那行变成「已探到，但还没有模型」",
	});
	await h.shoot("settings-local-empty-light");
	const row = localRow(await readLocalSection(), "Ollama");
	assert.ok(row.green, "零模型那行应当是绿点（绿点说的是「服务在」，不是「有模型」）");
	assert.ok(row.meta.includes("已探到，但还没有模型"), `那一行的状态不对：${JSON.stringify(row.meta)}`);
	assert.ok(row.hint.includes("下载一个模型"), `缺少「去它的界面里拉一个模型」的指引：${JSON.stringify(row.hint)}`);
	assert.equal(row.button, null, "零模型的行不该给一个点了必然失败的「接入」按钮");
	assert.equal(row.tag, "", "零模型的行被误标成了「已接入」");
});

await h.check("探到但要鉴权：显示鉴权说明，且**没有**接入按钮", async () => {
	await startMock({ port: PORT.lmstudio, modelsAuthRequired: true });
	const reprobe = await win.evaluate(() => {
		const button = [...document.querySelectorAll("[data-local-services] .mini-btn")].find(
			(b) => (b.textContent || "").trim() === "重新探测",
		);
		if (button === undefined) return false;
		button.click();
		return true;
	});
	assert.ok(reprobe, "设置页没有「重新探测」按钮");
	await waitUntil(
		async () => localRow(await readLocalSection(), "LM Studio")?.meta.includes("要求鉴权") === true,
		{ timeout: 20_000, desc: "重新探测后 LM Studio 那行变成「已探到，但要求鉴权」" },
	);
	await h.shoot("settings-local-auth-light");
	const section = await readLocalSection();
	const row = localRow(section, "LM Studio");
	assert.ok(row.meta.includes("已探到，但要求鉴权"), `那一行的状态不对：${JSON.stringify(row.meta)}`);
	assert.ok(row.hint.includes("鉴权"), `缺少鉴权说明：${JSON.stringify(row.hint)}`);
	assert.equal(row.button, null, "要鉴权的行不该给「接入」按钮（本功能不碰密钥）");
	// 两种「探到了但不是 ready」必须**在文字上**可辨（不是靠颜色深浅）
	assert.notEqual(
		localRow(section, "Ollama")?.meta,
		row.meta,
		`「零模型」与「要鉴权」两种形态的文案一样了（都是 ${JSON.stringify(row.meta)}），界面上分不出来`,
	);
	const danger = await scanDanger("[data-local-services]");
	assert.deepEqual(
		danger.danger,
		[],
		`「探到了但不是 ready」被画成了危险色（那不是错误）：${danger.danger.join("；")}`,
	);
});

/* ══════════════════════════════════════════════════════════════════════
 * ⑤ 探测未完成 → 骨架，不是「没有探到本机模型服务」空态
 * ══════════════════════════════════════════════════════════════════════ */

await h.check("探测未完成时设置页是骨架，不是「没有探到本机模型服务」空态", async () => {
	// 把这一位换成「接着但不回话」的服务：探测**一直**挂在未完成态，直到我们 release()
	for (const mock of mocks) await mock.close();
	mocks.length = 0;
	const hang = await startHangingServer(PORT.ollama);

	try {
		await closeSettings();
		// 分开做（不走 openSettingsModels）：末尾那记 waitForSettled 会一路等到探测收口
		// 之后才返回，挂载那一刻的形态就再也看不到了。
		await openSettingsDialog();
		const atMount = await openModelsTabAndReadMount();
		assert.equal(atMount.clicked, true, "设置侧栏里找不到「模型」分组");
		assert.equal(atMount.mounted, true, "点了「模型」之后 15 秒内「本机模型服务」区块都没挂上");

		// 这一行是**证据**：探测请求已经打在那台被挂住的服务上、而且还没有任何响应写回去。
		// 没有它，下面两条断言只是「此刻界面上是什么」，而不是「探测确实还没回来时是什么」。
		assert.ok(
			hang.heldCount() >= 1,
			`探测请求没被挂住（heldCount=${hang.heldCount()}）—— 这一段根本不是「探测未完成」`,
		);
		assert.equal(atMount.skeleton, true, `区块挂载那一刻没有骨架：${JSON.stringify(atMount)}（挂载即应处于探测中）`);
		assert.equal(
			atMount.empty,
			false,
			"区块刚挂载（探测还没回来）就显示了「没有探到本机模型服务」—— 加载态与空态被混为一谈" +
				"（docs/DESIGN.md §4：数据到达前不得显示「无数据」类文案）",
		);

		// 显式放开：探测立刻收口（503 → unreachable），界面落回空态。
		// 这一步不再依赖 daemon 那 800ms 超时 —— 顺序完全由测试决定。
		hang.release();
		await waitUntil(async () => (await readLocalSection())?.emptyTitle === "没有探到本机模型服务", {
			timeout: 20_000,
			desc: "放开响应后落回「没有探到本机模型服务」空态",
		});
		// 断言「挂载那一刻」时**不能**等静默（会一路等到探测收口），但这里已经收口了，
		// 可以等 —— 对话框是 --dur-fast 渐入的，不等就截出一张半透明的图，
		// 像素断言过得去、作为 review 现场却没有价值。
		await h.waitForSettled();
		const settled = await readLocalSection();
		await h.shoot("settings-probing-settled-light");
		assert.equal(settled.skeleton, false, "探测收口后骨架还在（加载态没有退场）");
		assert.equal(settled.rowCount, 0, `收口后不该直接摊出候选行，实际 ${settled.rowCount} 行`);
	} finally {
		await hang.close();
	}
});

// 收尾顺序按 testing/spec §5.3：先关应用，再关 mock
// （反过来 server.close 会等 daemon 与 mock 之间还活着的长连接断开）。
await h.app().close();
for (const mock of mocks) await mock.close();
await h.finish();