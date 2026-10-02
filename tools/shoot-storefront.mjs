#!/usr/bin/env node
/**
 * shoot-storefront.mjs —— 生成 README 门面截图（真机、可复现）
 *
 * ## 这个脚本为什么存在
 *
 * README 是桌面应用的**门面**：用户在下之前只能看到这一页。手截的图没人能重拍 ——
 * 界面一改图就过期，而过期的图没人知道该换成什么样。所以把它做成一条命令：
 * 真实启动 Electron、驱动到有代表性的状态、按 CSS 像素拍成固定的四张图，产物入库。
 * 这与 `tools/build-icons.mjs`（图标生成流水线）是同一套做法。
 *
 * ## 产出（文件名固定，README 引用它们）
 *
 *   docs/images/home-light.png        全新环境首页（浅色）
 *   docs/images/home-dark.png         同上，切深色
 *   docs/images/conversation.png      mock 模型跑一轮 + 右侧产物面板打开
 *   docs/images/command-palette.png   ⌘K 打开命令面板、输入有结果
 *
 * ## 什么时候该重跑
 *
 * **界面发生明显变化时**（首页/会话/命令面板的排版、配色、关键文案改动），
 * 以及**版本号 bump 之后**（侧栏品牌行会把仓库版本号拍进去）。
 * 跑完要提交的：`docs/images/` 下这四张 PNG。**产物契约由脚本自己断言** ——
 * 四张都存在、宽度正确、不是纯色（`imageStats` 的 `stdDev` / `distinctColors`）、
 * 彼此不同、总重不超标，任一条不成立就非零退出。一张全白/全黑的图被静默提交比不产出更糟。
 *
 * ⚠️ **重跑不是逐字节可复现的**：界面里有真实时间戳（会话卡上的最后活动时间、
 * 侧栏任务行的时间），所以两次运行的 PNG 会有几字节到几十字节的差。
 * 这不是缺陷，是「拍的是真机」的代价 —— 不要把它当成回归信号，
 * 也不要把这四张图设成固定的像素基线（那会与「门面图应该随设计变化」的目的相反）。
 *
 * ## 边界：会拍到什么、不会拍到什么
 *
 * - **不依赖任何真实模型端点**：会话内容用本地 mock 模型（OpenAI 兼容 SSE）现造，
 *   整条链路（渲染层 → IPC → daemon → pi → HTTP → 流式回传）是真跑的。
 * - **唯一会出网的是首页案例封面**（`static.workbuddy.cn`）：有网时拍出来才好看；
 *   断网时是图标兜底，**也是可接受的产出**，脚本不为此假装没有。
 * - 全程跑在 harness 的隔离目录里（配置 / 工作区 / userData 都是新临时目录），
 *   **不碰任何真实用户数据**；截图里因此也不会出现真实路径、姓名、API Key。
 *
 * ## 用法
 *
 *   node tools/shoot-storefront.mjs      # 需要先 npm run build（跑的是 out/ 产物）
 *
 * 退出码：0 全部产出且契约通过；非零见 harness 的三档语义。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHarness, waitUntil, ROOT } from "../tests/e2e/lib/harness.mjs";
import { decodePng, imageStats, downsample, diffGrids } from "../tests/e2e/lib/png.mjs";

// ── 尺寸与产物路径 ──────────────────────────────────────────────────────
//
// 以**笔记本常见宽度**为准，不拍 2560 宽的开发机尺寸 —— 图在 README 里会被缩放，
// 太宽只会让内容变小。`scale: "css"`（见 shoot()）保证输出就是这组 CSS 像素。
const VIEWPORT = { width: 1440, height: 900 };
const OUT_DIR = resolve(ROOT, "docs/images");

/** 四个产物文件名。README 引用它们，所以固定、不随运行变化。 */
const FILES = {
	homeLight: "home-light.png",
	homeDark: "home-dark.png",
	conversation: "conversation.png",
	palette: "command-palette.png",
};

const ARTIFACT_FILE = "sales-dashboard.html";
// 消息里带「统计」二字：命令面板那张图用一个能**同时命中动作与会话**的查询词，
// 与 README 的图注（「动作与会话同时出现在结果里」）对齐 —— 「统计」既命中动作
// 「打开统计」，也命中这条会话标题。
const USER_TEXT = "帮我把本月的销售数据做成一个统计看板，用 HTML 做得能直接看。";
const REPLY_TEXT =
	"做好了。我按样例数据生成了 sales-dashboard.html：顶部三张核心指标卡，下面是近 6 个月的销售额柱状图。右侧面板可以直接预览，也可以点右上角用浏览器打开。";

/** 会话里要交付的看板 HTML —— 自带样式、纯样例数据，不含任何真实信息。 */
const ARTIFACT_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>本月销售看板</title>
<style>
  :root { --ink: #1f2328; --muted: #6b7280; --line: #e6e8eb; --up: #12934f; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 26px 30px; color: var(--ink); background: #f6f7f9;
         font: 14px/1.6 -apple-system, "PingFang SC", "Segoe UI", Roboto, sans-serif; }
  h1 { font-size: 20px; margin: 0 0 2px; }
  .sub { color: var(--muted); font-size: 13px; margin: 0 0 20px; }
  .cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; margin-bottom: 22px; }
  .card { background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 15px 18px; }
  .card .k { color: var(--muted); font-size: 12px; }
  .card .v { font-size: 25px; font-weight: 600; margin-top: 6px; letter-spacing: .2px; }
  .card .d { font-size: 12px; color: var(--up); margin-top: 4px; }
  .panel { background: #fff; border: 1px solid var(--line); border-radius: 12px; padding: 18px 20px; }
  .panel h2 { font-size: 14px; font-weight: 600; margin: 0 0 18px; }
  .bars { display: flex; align-items: flex-end; gap: 20px; height: 148px; }
  .bar { flex: 1; display: flex; flex-direction: column; justify-content: flex-end;
         align-items: center; gap: 8px; height: 100%; }
  .bar i { display: block; width: 100%; border-radius: 6px 6px 0 0;
           background: linear-gradient(180deg, #5b8def, #2f6df6); }
  .bar span { font-size: 12px; color: var(--muted); }
</style>
</head>
<body>
  <h1>本月销售看板</h1>
  <p class="sub">2026-10 · 样例数据</p>
  <div class="cards">
    <div class="card"><div class="k">本月销售额</div><div class="v">¥ 1,284,500</div><div class="d">▲ 12.4% 环比</div></div>
    <div class="card"><div class="k">订单数</div><div class="v">3,182</div><div class="d">▲ 6.1% 环比</div></div>
    <div class="card"><div class="k">客单价</div><div class="v">¥ 403</div><div class="d">▲ 5.9% 环比</div></div>
  </div>
  <div class="panel">
    <h2>近 6 个月销售额</h2>
    <div class="bars">
      <div class="bar"><i style="height:48%"></i><span>5月</span></div>
      <div class="bar"><i style="height:62%"></i><span>6月</span></div>
      <div class="bar"><i style="height:55%"></i><span>7月</span></div>
      <div class="bar"><i style="height:74%"></i><span>8月</span></div>
      <div class="bar"><i style="height:68%"></i><span>9月</span></div>
      <div class="bar"><i style="height:88%"></i><span>10月</span></div>
    </div>
  </div>
</body>
</html>
`;

/**
 * 最小 OpenAI 兼容 mock 模型（与 mock-model-server 同族，但要按轮次返回工具调用）。
 *
 * 第 1 轮：调 `present_files` 交付看板（走绝对路径，这是工具契约要求的形态）。
 * 第 2 轮：流式吐出最终回复。
 *
 * 只要「模型真的被调到了」这条信号，不验证任何真实模型能力。
 */
function startStorefrontMock({ filePath, reply }) {
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
			requests.push({ url: req.url, body: parsed });

			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			const send = (delta, finish) => {
				const chunk = { id: "chatcmpl-storefront", object: "chat.completion.chunk", choices: [{ index: 0, delta }] };
				if (finish !== undefined) chunk.choices[0].finish_reason = finish;
				res.write(`data: ${JSON.stringify(chunk)}\n\n`);
			};

			send({ role: "assistant", content: "" });
			const msgs = parsed?.messages ?? [];
			const toolResults = msgs.filter((m) => m.role === "tool").length;

			if (toolResults === 0) {
				send({
					tool_calls: [
						{
							index: 0,
							id: "call_store_1",
							type: "function",
							function: {
								name: "present_files",
								arguments: JSON.stringify({ files: [filePath], explanation: "交付看板" }),
							},
						},
					],
				});
				send({}, "tool_calls");
			} else {
				// 【\s 不能少】`.` 不匹配换行，多行回复会在分片时丢掉换行（见 mock-model-server 注释）。
				for (const chunk of reply.match(/[\s\S]{1,8}/gu) ?? []) send({ content: chunk });
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
				close: () => new Promise((r) => server.close(r)),
			}),
		);
	});
}

mkdirSync(OUT_DIR, { recursive: true });

const harnessOpts = { name: "storefront" };
const h = createHarness(harnessOpts);

/**
 * 工作区目录用一个**得体的名字**，而不是 harness 的随机临时名。
 *
 * 侧栏「空间」显示的是工作区目录的**目录名**，而默认名（`zerowork-ws-storefront-XXXX`）
 * 会连带把测试脚手架的命名漏进门面截图里、还带一截随机串。这里在隔离目录下再建一层
 * 语义化子目录，并把 `ZEROWORK_WORKSPACE_DIR` 指过去 —— `opts.env` 在 `launch()` 时
 * 才读取，所以此刻赋值有效。子目录在 harness 的 WORKSPACE_DIR 之下，收尾时随它一并清掉。
 */
const WORKSPACE = resolve(h.WORKSPACE_DIR, "示例项目");
mkdirSync(WORKSPACE, { recursive: true });
harnessOpts.env = { ZEROWORK_WORKSPACE_DIR: WORKSPACE };

// 看板文件必须真实存在（present_files 会 stat 它，不存在的会被标 missing）。
const artifactPath = resolve(WORKSPACE, ARTIFACT_FILE);
writeFileSync(artifactPath, ARTIFACT_HTML, "utf8");

const mock = await startStorefrontMock({ filePath: artifactPath, reply: REPLY_TEXT });
console.log(`✓ mock 模型服务就绪：${mock.baseUrl}`);

await h.launch();
const win = h.window();

/**
 * 把窗口设成笔记本常见宽度。应用建窗口写的是 1280×860、**没有** bounds 持久化
 * （主进程不读也不写窗口位置/尺寸），所以这里改完不会被写回、也不会带到下次启动。
 */
await h.app().evaluate(({ BrowserWindow }, size) => {
	const w = BrowserWindow.getAllWindows()[0];
	if (w === undefined) throw new Error("没有可缩放的窗口");
	w.setContentSize(size.width, size.height);
}, VIEWPORT);
await h.waitForSettled();

/** 已产出图的清单，末尾统一做产物契约断言。 */
const shots = [];

/**
 * 按 **CSS 像素**截图（不是设备像素）。
 *
 * 这是整套方案的关键：本机 dpr=2，默认会拍成 2880×1800（单张数百 KB）；
 * `scale: "css"` 拍出来就是 1440×900，清晰度够 README 用、体积降一个数量级。
 * harness 的 `h.shoot()` 不暴露这个参数，所以直接调 `win.screenshot`。
 */
async function shoot(name) {
	const file = resolve(OUT_DIR, name);
	await win.screenshot({ path: file, scale: "css" });
	// 读一次、量一次，**不要 statSync 之后再 readFileSync**：那是典型的
	// TOCTOU（先探测存在/大小、再按探测结果去读），CodeQL 的 js/file-system-race
	// 会按高危报它（本仓库 src/main/index.js:501 有一条同规则的既有告警）。
	// 直接读成 Buffer，长度就是字节数 —— 顺带少一次系统调用。
	const buf = readFileSync(file);
	const bytes = buf.length;
	const img = decodePng(buf);
	const stats = imageStats(img);
	shots.push({ name, bytes, stats, grid: downsample(img) });
	console.log(
		`  ▸ docs/images/${name}  ${stats.width}×${stats.height}  ${(bytes / 1024).toFixed(0)} KB  ` +
			`（stdDev ${stats.stdDev.toFixed(1)} / 颜色 ${stats.distinctColors}）`,
	);
	return stats;
}

/** 等 mock 收到第 n 轮请求 —— 「模型真的被调到了」是比固定等待可靠的信号。 */
async function waitForRounds(n, why) {
	try {
		await waitUntil(() => mock.requests.length >= n, {
			timeout: 40_000,
			interval: 500,
			desc: `mock 收到第 ${n} 轮请求`,
		});
	} catch (error) {
		throw new Error(`mock 只收到 ${mock.requests.length} 轮请求（期望 ≥${n}）—— ${why}（${error.message}）`);
	}
}

/** 切主题：走与应用同一条路（localStorage 镜像 + data-theme 属性 + 真源落盘）。 */
async function setTheme(pref) {
	await win.evaluate(async (p) => {
		const resolved =
			p === "system" ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : p;
		localStorage.setItem("zw:theme-pref", p);
		document.documentElement.setAttribute("data-theme", resolved);
		window.dispatchEvent(new CustomEvent("zw:theme-changed"));
		await window.kami.setThemePreference(p);
	}, pref);
	await waitUntil(() => win.evaluate((p) => document.documentElement.dataset.theme === p, pref), {
		timeout: 10_000,
		desc: `data-theme 切到 ${pref}`,
	});
	await h.waitForSettled();
}

// ══ ① 首页（浅色）：全新环境 ══════════════════════════════════════════
await h.waitForSettled();
await shoot(FILES.homeLight);

// ══ ② 首页（深色）═══════════════════════════════════════════════════
await setTheme("dark");
await shoot(FILES.homeDark);
// 复原浅色，供后面的会话与命令面板截图（都是浅色）。
await setTheme("light");

// ══ ③ 会话 + 产物面板 ════════════════════════════════════════════════
await win.evaluate(
	async ({ id, baseUrl, ws }) => {
		const k = globalThis.kami;
		await k.saveCustomProvider(
			{
				id,
				name: "Storefront Mock",
				baseUrl,
				api: "openai-completions",
				models: [
					{
						id: "storefront-model",
						name: "storefront-model",
						reasoning: false,
						vision: false,
						contextWindow: 128000,
						maxTokens: 8192,
					},
				],
			},
			"sk-storefront-dummy",
		);
		await k.setModel(`${id}/storefront-model`);
		await k.setWorkspace(ws);
	},
	{ id: "storefront-mock", baseUrl: mock.baseUrl, ws: WORKSPACE },
);

// 走真实 UI 路径发送（在输入框里打字 + Enter）—— 绕过界面就切不到会话视图。
{
	const box = win.locator('[aria-label="消息输入框"]');
	await box.waitFor({ state: "visible", timeout: 30_000 });
	await box.fill(USER_TEXT);
	await box.press("Enter");
}
await waitForRounds(1, "消息没有发出去");

// 等产物卡片渲染出来（回合结束、artifacts 落到界面）。
await waitUntil(() => win.evaluate(() => document.querySelector(".artifact-card") !== null), {
	timeout: 40_000,
	interval: 500,
	desc: "会话里出现 .artifact-card",
});
await waitForRounds(2, "mock 收到工具结果后没有续跑");

// 点卡片 → 右侧产物面板打开（revealPanel("artifact") + openPreview）。
await win.evaluate(() => {
	const card = document.querySelector(".artifact-card");
	if (card === null) throw new Error("没有可点击的 .artifact-card");
	card.click();
});
await waitUntil(() => win.evaluate(() => document.querySelector(".preview-frame") !== null), {
	timeout: 30_000,
	interval: 300,
	desc: "产物面板打开（.preview-frame）",
});
// 等 iframe 内容**真的**渲染出来（看板标题可见）—— 光有 iframe 元素不等于内容到位。
await win
	.frameLocator(".preview-frame")
	.getByRole("heading", { name: "本月销售看板" })
	.waitFor({ state: "visible", timeout: 30_000 });
await h.waitForSettled();
await shoot(FILES.conversation);

// ══ ④ 命令面板（⌘K）══════════════════════════════════════════════════
// 回首页，让面板开在干净的底色上（而不是叠在会话上）。
await win.evaluate(() => {
	const btn = document.querySelector('[aria-label="返回首页"]');
	btn?.click();
});
await waitUntil(() => win.evaluate(() => document.querySelector(".composer-slot") !== null), {
	timeout: 30_000,
	interval: 300,
	desc: "回到首页（.composer-slot 出现）",
});
await h.waitForSettled();

const MOD = process.platform === "darwin" ? "Meta" : "Control";
await win.keyboard.press(`${MOD}+k`);
await waitUntil(() => win.evaluate(() => document.querySelector(".command-palette") !== null), {
	timeout: 15_000,
	interval: 300,
	desc: "命令面板出现",
});
const input = win.locator(".command-palette-input");
await input.fill("统计");
await waitUntil(() => win.evaluate(() => document.querySelectorAll('.command-palette [role="option"]').length > 0), {
	timeout: 15_000,
	interval: 300,
	desc: "命令面板出现搜索结果",
});
await h.waitForSettled();
await shoot(FILES.palette);

// ══ 产物契约（先截图、后断言）══════════════════════════════════════════
//
// 四张图都要存在、尺寸正确、不是纯色。纯色阈值沿用 harness 的口径
// （stdDev ≥ 3 / 颜色数 ≥ 12），它只抓「基本没渲染」，不承担「画面变了没」。
await h.check("四张图都存在", () => {
	for (const name of Object.values(FILES)) {
		assert.ok(existsSync(resolve(OUT_DIR, name)), `缺少 docs/images/${name}`);
	}
});

await h.check("四张图尺寸正确（1440×900 CSS 像素）", () => {
	for (const { name, stats } of shots) {
		assert.equal(stats.width, VIEWPORT.width, `${name} 宽 ${stats.width} ≠ ${VIEWPORT.width}`);
		assert.equal(stats.height, VIEWPORT.height, `${name} 高 ${stats.height} ≠ ${VIEWPORT.height}`);
		assert.ok(stats.width <= 1600, `${name} 宽 ${stats.width} 超过 1600`);
	}
});

await h.check("四张图都不是纯色（stdDev ≥ 3 且颜色数 ≥ 12）", () => {
	for (const { name, stats } of shots) {
		assert.ok(stats.stdDev >= 3, `${name} 亮度标准差 ${stats.stdDev.toFixed(2)} < 3 —— 几乎是纯色，没渲染出来？`);
		assert.ok(stats.distinctColors >= 12, `${name} 颜色数 ${stats.distinctColors} < 12 —— 几乎没有内容？`);
	}
});

await h.check("四张图互不相同（不是同一屏拍了四遍）", () => {
	for (let i = 0; i < shots.length; i += 1) {
		for (let j = i + 1; j < shots.length; j += 1) {
			const diff = diffGrids(shots[i].grid, shots[j].grid);
			assert.ok(diff > 1.5, `${shots[i].name} 与 ${shots[j].name} 差异仅 ${diff.toFixed(2)} —— 两张图几乎一样？`);
		}
	}
});

await h.check("图片总重 ≤ 1.5 MB（不要为了清晰把仓库撑大）", () => {
	const total = shots.reduce((n, s) => n + s.bytes, 0);
	assert.ok(total <= 1.5 * 1024 * 1024, `四张合计 ${(total / 1024 / 1024).toFixed(2)} MB > 1.5 MB，需降宽或换压缩`);
	console.log(`      合计 ${(total / 1024).toFixed(0)} KB`);
});

await h.check("无渲染层未捕获异常", () => assert.equal(h.pageErrors.length, 0, h.pageErrors.join("; ")));

// 先关应用再关 mock：应用一关，daemon 与 mock 之间的长连接才会断开，
// server.close() 才不会一直等在那儿。
await h.app().close();
await mock.close();
await h.finish();
