/**
 * docx 引擎往返测试 + 运行时安装测试。
 *
 * 这两条链路此前没测过，而且**它们在本机是可测的**：
 *
 *   ① docx 引擎（Python 路径） —— docx_convert / docx_extract 是两个 agent
 *      工具，走 resources/docx-engine 的 Python 实现。Python 运行时是跨平台的，
 *      本机状态为 ready，所以可以真实跑通。
 *
 *      用**往返**验证最有力：HTML（埋标记）→ docx → HTML（取回标记）。
 *      标记能穿过两个方向，说明转换与提取两条路都正确 —— 单独测某一个方向
 *      都可能因为"转换时丢内容、提取时碰巧没丢"而假阳性。
 *
 *   ② 运行时安装 —— 原为平台硬编码（win-x64 + node.exe），在 macOS 上必然
 *      失败。现改为按 platform-arch 取规格，支持 win32-x64 / darwin-arm64 /
 *      darwin-x64，因此这里断言**真的能装上并跑通探针**。
 *      gitbash 仍是 Windows 专有（PortableGit），不在本测试范围。
 *
 * ⚠️ 凭据运行时从 ~/.claude/settings.json 读取，不进仓库、不打印。
 *
 * ── 迁移说明（共享 harness）────────────────────────────────
 *
 * 骨架（隔离目录、启动并等到就绪、check 收集器、末尾报告与退出码）全部来自
 * `./lib/harness.mjs`：不再手写固定路径 /tmp/zerowork-runtime*、不再 `rmSync`、
 * 不再固定等 9 秒、不再自建报告循环。
 *
 * 本文件**只有一部分**依赖模型端点（① 运行时安装与 ② 引擎往返都不依赖），
 * 所以端点不可用时不是整轮退出，而是启动照旧，把依赖模型的那三条**逐条 h.skip** ——
 * 报告会显示「跳过 3」，而不是伪装成全绿（那是改写前的行为：整轮 exit(0)）。
 *
 * 等待一律走信号：等的是「运行时快照真的变成 ready」「Python 进程真的退出」
 * 「产物真的落盘」「回复里真的出现标记」，没有一处固定 sleep。
 * ⚠️ 回合进行中不能用 `h.waitForSettled()`（渲染层有 500ms 级计时器在改 DOM，
 * 永远达不到 800ms 静默），所以模型回合等的是具体内容而不是「界面静止」。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { createHarness, waitUntil, ROOT } from "./lib/harness.mjs";

// 标记要挑**弱模型也抄得准**的形状（理由见 doc-parsing.mjs 的同类注释：
// 辅音串 + 数字会被抄错，可发音的词 + 数字转录稳定）。
const MARK = "MAPLE9643";

/**
 * 看门狗给得比默认（12 分钟）宽：本文件里有「下载安装 Node 运行时（上限 300s）」
 * 与两条真实模型回合（300s + 180s），再叠加两次产物落盘等待，
 * 慢机器上按默认值会被**误杀**成一个假的失败。
 * 25 分钟仍然远小于 CI 那个 45 分钟的 job 上限 —— 卡住时照样能被兜住。
 */
const h = createHarness({ name: "docx-runtime", fileTimeout: 25 * 60_000 });

// ── 模型端点（可选：缺了只跳过依赖模型的那部分）───────────────
const SETTINGS = resolve(homedir(), ".claude", "settings.json");

function readEndpoint() {
	if (!existsSync(SETTINGS)) return undefined;
	try {
		const env = JSON.parse(readFileSync(SETTINGS, "utf8"))?.env ?? {};
		const baseUrl = env.ANTHROPIC_BASE_URL;
		const token = env.ANTHROPIC_AUTH_TOKEN;
		const model = String(env.ANTHROPIC_MODEL ?? "").replace(/\[[^\]]*\]$/, "");
		return baseUrl && token && model ? { baseUrl, token, model } : undefined;
	} catch {
		return undefined;
	}
}

/** 端点可用性的判定与原因 —— 原因要能直接说明该去改什么。 */
async function resolveEndpoint() {
	if (!existsSync(SETTINGS)) {
		return { reason: `未找到 ${SETTINGS}（需要其中的 env.ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL）` };
	}
	const endpoint = readEndpoint();
	if (endpoint === undefined) {
		return { reason: `${SETTINGS} 的 env 里缺少 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL 中的某一项` };
	}
	const probe = await fetch(`${endpoint.baseUrl}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": endpoint.token, "anthropic-version": "2023-06-01" },
		body: JSON.stringify({ model: endpoint.model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
	}).catch(() => undefined);
	if (!probe || !probe.ok) {
		return { reason: `模型端点不可用（HTTP ${probe?.status ?? "无响应"}）：${endpoint.baseUrl}` };
	}
	return { endpoint };
}

const { endpoint, reason: endpointReason } = await resolveEndpoint();
console.log(endpoint ? `✓ 模型端点可用：${endpoint.baseUrl}` : `⚠ ${endpointReason} —— 仅跳过依赖模型的部分`);

/** 端点不可用时逐条留痕的跳过项（与下面的 h.check 一一对应）。 */
const MODEL_CHECKS = [
	"配置真实模型",
	"docx_convert：HTML → DOCX（产出文件落盘）",
	"docx_extract：DOCX → HTML 且标记存活",
];

// ── 准备夹具（工作区由 harness 按用例名隔离）────────────────
const SRC_HTML = resolve(h.WORKSPACE_DIR, "source.html");
writeFileSync(
	SRC_HTML,
	`<!doctype html><html><head><meta charset="utf-8"><title>RT</title></head>
<body><h1>往返测试</h1><p>标记：${MARK}</p><p>这段用于验证转换往返不丢内容。</p></body></html>`,
	"utf8",
);

await h.launch();
const win = h.window();

await h.check("启动后界面已渲染", async () => {
	// 先截图后断言：界面不对时图里能直接看出来
	await h.shoot("welcome");
});

// ── ① 运行时安装：跨平台可用性 ────────────────────────────
//
// 历史：这块原先硬编码 `win-x64.zip` + `node.exe`，在 macOS/Linux 上
// 必然失败（下载 Windows 包、然后在 probe 相位跑不起 node.exe）。
//
// 现已改为按 `process.platform-arch` 取规格（见 runtimes.js 的
// NODE_PLATFORM_SPECS），支持 win32-x64 / darwin-arm64 / darwin-x64。
// 因此本测试断言的是**真的能装上并跑通探针**，而不再是"优雅失败"。
//
// 两个 sha256 都在装的过程中校验：归档哈希（并与官方 SHASUMS256.txt
// 交叉核对）+ 解包后可执行文件哈希。任一不符都会中止。

await h.check("运行时：Node 在当前平台可安装并跑通探针", async () => {
	const before = await win.evaluate(async () => {
		const s = await globalThis.kami.runtimesSnapshot();
		return (s?.items ?? []).find((x) => x.id === "node")?.status?.kind ?? "unknown";
	});
	console.log(`      node 安装前：${before}`);

	if (before !== "ready") {
		const r = await win.evaluate(async () => {
			try {
				await Promise.race([
					globalThis.kami.runtimeInstall("node"),
					new Promise((_, rej) => setTimeout(() => rej(new Error("__TIMEOUT__")), 300_000)),
				]);
				return { ok: true };
			} catch (e) {
				const msg = String(e?.message ?? "");
				return { ok: false, err: msg.includes("__TIMEOUT__") ? "安装挂起 300 秒" : msg.slice(0, 240) };
			}
		});
		assert.ok(r.ok, `安装失败: ${r.err}`);
	}

	const after = await win.evaluate(async () => {
		const s = await globalThis.kami.runtimesSnapshot();
		const n = (s?.items ?? []).find((x) => x.id === "node");
		return { kind: n?.status?.kind, exe: n?.executable };
	});
	console.log(`      node 安装后：${after.kind}`);
	assert.equal(after.kind, "ready", `安装后状态应为 ready，实际 ${after.kind}`);
	// 探针跑通才会是 ready，所以这里已隐含"解出来的 node 真的能执行"
	assert.ok(after.exe === undefined || typeof after.exe === "string", "可执行文件路径异常");
});

await h.check("运行时：平台规格按架构取（不回落 Windows）", async () => {
	// 回归防护：规格表的键是 platform-arch。若有人把 darwin 的键写错、
	// 或让未知平台回落到 win32 规格，这里会露出来。
	const r = await win.evaluate(async () => {
		const s = await globalThis.kami.runtimesSnapshot();
		const n = (s?.items ?? []).find((x) => x.id === "node");
		return { dir: n?.activeDir ?? "", exe: n?.executable ?? "" };
	});
	// macOS 上解出来的可执行文件必须在 bin/ 下，且**不能**是 node.exe
	if (process.platform === "darwin") {
		assert.ok(!/node\.exe/i.test(r.exe + r.dir), `darwin 上不该出现 node.exe：${r.exe}`);
	}
});

await h.check("运行时：平台不适用的项不出现在清单里", async () => {
	// Git for Windows 的 PortableGit 是 Windows 专有产物（.7z.exe），
	// macOS/Linux 自带 bash、也不需要它。若不过滤，UI 会显示
	// 「bash 运行时：未安装」并给出安装按钮 —— 用户点下去会下载一个
	// 跑不起来的 .7z.exe。过滤发生在 runtimeDescriptors，UI 与 shell 注入
	// 都从那里派生，一处即可修好两处。
	const r = await win.evaluate(async () => {
		const s = await globalThis.kami.runtimesSnapshot();
		return { ids: (s?.items ?? []).map((x) => x.id) };
	});
	if (process.platform === "win32") {
		assert.ok(r.ids.includes("gitbash"), "Windows 上应有 gitbash 运行时");
	} else {
		assert.ok(!r.ids.includes("gitbash"), `非 Windows 上不该出现 gitbash：${r.ids.join(", ")}`);
	}
	// 跨平台的 Python / Node 各平台都应在
	assert.ok(r.ids.includes("python"), "缺少 python 运行时");
	assert.ok(r.ids.includes("node"), "缺少 node 运行时");
});

await h.check("运行时：诊断接口可读取", async () => {
	const r = await win.evaluate(async () => {
		try {
			const d = await globalThis.kami.runtimeDiagnostics("node");
			return { ok: true, has: d !== undefined };
		} catch (e) {
			return { ok: false, err: String(e?.message ?? e).slice(0, 160) };
		}
	});
	assert.ok(r.ok, `诊断调用失败: ${r.err}`);
});

// ── ② docx 引擎往返：确定性验证（不依赖模型）─────────────────
//
// 这一条才是「引擎能不能用」的**权威证据**。
//
// 为什么不能只靠模型驱动的用例：`docx_convert` 是**暴露给模型的工具**，
// 要模型主动调用才有产物。本机端点是一个能力较弱的模型，它经常把整个输出
// 预算耗在「这个任务该不该用 docx 技能 / 该不该先 present_files」这类
// 推理上，工具一次都不调 —— 于是用例报「模型未回报完成」，看起来像引擎坏了，
// 实际是模型没动手。（这一点已在**改写前的基线状态**复现，排除回归。）
//
// 所以这里按**应用自己的调用契约**直接跑引擎：
//   `python -m html_to_docx convert <in> -o <out>`，env 带 PYTHONPATH=<engineDir>
// （与 src/main/daemon/doc-extract.js 完全一致），然后反向 `-m docx_to_html extract`。
// 标记能双向穿过，就证明转换与提取两条路都对。

// ROOT 来自 harness（仓库根）—— 与它启动应用时给的 ZEROWORK_RESOURCES_DIR 同源，
// 保证测的就是随包分发的那份引擎。
const ENGINE_DIR = resolve(ROOT, "resources", "docx-engine");

const runFile = promisify(execFile);

await h.check("docx 引擎：HTML → DOCX → HTML 往返，标记双向存活（不依赖模型）", async () => {
	// 解释器取应用自己解析出来的那一个（托管 venv），而不是碰运气猜路径
	const py = await win.evaluate(async () => {
		const s = await globalThis.kami.runtimesSnapshot();
		const item = (s?.items ?? []).find((x) => x.id === "python");
		return { kind: item?.status?.kind, exe: item?.executable };
	});
	assert.equal(py.kind, "ready", `Python 运行时未就绪（${py.kind}），无法验证 docx 引擎`);
	assert.ok(py.exe, "运行时快照没给出解释器路径");

	// 等的是**子进程退出**这个信号，不是固定时长（原来用 execFileSync 同步阻塞：
	// 结果一样，但会把事件循环连同看门狗一起卡住；改成异步后看门狗仍然有效）。
	const run = async (args) => {
		const { stdout } = await runFile(py.exe, args, {
			env: { ...process.env, PYTHONPATH: ENGINE_DIR },
			encoding: "utf8",
			timeout: 180_000,
		});
		return JSON.parse(stdout.trim().split("\n").pop());
	};

	const srcHtml = resolve(h.WORKSPACE_DIR, "engine-src.html");
	const midDocx = resolve(h.WORKSPACE_DIR, "engine-out.docx");
	const backHtml = resolve(h.WORKSPACE_DIR, "engine-back.html");
	writeFileSync(
		srcHtml,
		`<!doctype html><html><head><meta charset="utf-8"><title>RT</title></head>
<body><h1>往返测试</h1><p>标记：${MARK}</p></body></html>`,
		"utf8",
	);

	// 正向
	const fwd = await run(["-m", "html_to_docx", "convert", srcHtml, "-o", midDocx]);
	assert.equal(fwd.success, true, `正向转换失败：${JSON.stringify(fwd).slice(0, 200)}`);
	assert.ok(existsSync(midDocx), "正向转换未产出 docx");

	// 反向
	const rev = await run(["-m", "docx_to_html", "extract", midDocx, "-o", backHtml]);
	assert.equal(rev.success, true, `反向转换失败：${JSON.stringify(rev).slice(0, 200)}`);

	// 标记必须穿过两个方向
	const back = readFileSync(backHtml, "utf8");
	assert.ok(back.includes(MARK), `标记 ${MARK} 未穿过往返 —— 转换或提取丢内容了`);
	console.log(`      往返 OK：docx ${statSync(midDocx).size} 字节 → html ${back.length} 字符，标记存活`);
});

// ── ③ docx 引擎往返（由真实模型触发工具，验证工具接线）────────
//
// 端点不可用时**逐条留痕**（而不是整轮 exit(0)）：这几条本来就没跑，
// 报告里要看得见「跳过 3」。

/**
 * ⚠️ 提示词的写法很要紧（踩过坑）。
 *
 * 早先这两条用例的提示词结尾是「完成后**只回复** CONVERT_DONE」「**不要加任何
 * 其它内容**」。这看起来只是让断言好写，实际制造了一个**提示词冲突**：
 * 系统提示词里的交付纪律要求「产出文件后必须把文件挂进交付清单并做过程叙述」，
 * 而用户这边要求「只回复某个串」。弱模型会卡在这个矛盾里反复权衡，
 * 把整个输出预算烧在推理上，工具一次都不调 —— 症状是回复被截断、
 * 断言报「模型未回报完成」。
 *
 * 所以提示词改成**顺着系统提示词的纪律走**：让模型按它平时的习惯交付，
 * 断言改落在**更强的证据**上 —— 产物文件本身（以及从中提取回的标记），
 * 而不是「模型说了某个魔法字符串」。
 */

/**
 * 发一条提示，等**回合结束**，再等回复里出现某个特征串。
 *
 * 两段都是信号：① 回合结束（工具调用发生在回合内部，回合没结束前回复还会追加）；
 * ② 快照里真的出现该内容。回合进行中不能用 `h.waitForSettled()`。
 */
async function promptAndWait(text, expectSubstring, timeoutMs = 180_000) {
	const turn = await win.evaluate(
		async ({ t, ms }) => {
			try {
				await Promise.race([
					globalThis.kami.prompt({ text: t }),
					new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT")), ms)),
				]);
				return { timedOut: false };
			} catch (e) {
				const msg = String(e?.message ?? e);
				return { timedOut: msg.includes("TIMEOUT"), err: msg.slice(0, 200) };
			}
		},
		{ t: text, ms: timeoutMs },
	);
	if (turn.timedOut) return { timedOut: true, found: false, text: "(回合未结束)", err: turn.err };

	// 原来是页面里 `for × 60 + sleep 2s` 的手写轮询，换成 waitUntil
	let state = null;
	let why = "";
	try {
		await waitUntil(
			async () => {
				state = await win.evaluate(async () => {
					const s = await globalThis.kami.snapshot();
					const a = (s?.entries ?? []).filter((x) => x?.role === "assistant" && String(x?.text ?? "").length > 0);
					return { text: a.map((x) => x.text).join("\n") };
				});
				return state.text.includes(expectSubstring);
			},
			{ timeout: 120_000, interval: 2000, desc: `模型的回复里出现 ${expectSubstring}` },
		);
		return { found: true, text: state.text };
	} catch (error) {
		why = error.message;
	}
	// 失败时的现场取法与改写前一致：全部 assistant 条目的尾部片段
	const tail = await win.evaluate(async () => {
		const s = await globalThis.kami.snapshot();
		const a = (s?.entries ?? []).filter((x) => x?.role === "assistant");
		return JSON.stringify(a).slice(-400);
	});
	return { found: false, text: tail || state?.text || "(没读到任何 assistant 条目)", why };
}

if (endpoint === undefined) {
	for (const label of MODEL_CHECKS) h.skip(label, endpointReason);
} else {
	await h.check("配置真实模型", async () => {
		const r = await win.evaluate(
			async ({ baseUrl, token, model, ws }) => {
				const k = globalThis.kami;
				try {
					await k.saveCustomProvider(
						{
							id: "local-proxy",
							name: "Local Proxy",
							baseUrl,
							api: "anthropic-messages",
							authHeader: true,
							// maxTokens 是**模型声明的输出上限**，会作为请求的 max_tokens 下发。
							// 这里原先写 4096 —— 对本用例太紧：要模型「读文件 → 调 docx_convert →
							// 回报完成」，而弱模型会先在推理里反复权衡系统提示词里的工具调用规则，
							// 4096 往往在它真正动手前就耗尽（症状：回复被截断、工具一次没调、
							// test 报「模型未回报完成」）。这是**测试配置过紧**，不是产品问题 ——
							// 已在改写前的基线状态复现同样失败。给足预算以匹配真实模型的输出能力。
							models: [{ id: model, name: model, reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }],
						},
						token,
					);
					await k.setModel(`local-proxy/${model}`);
					await k.setWorkspace(ws);
					return { ok: true };
				} catch (e) {
					return { ok: false, err: String(e?.message ?? e).slice(0, 200) };
				}
			},
			{ ...endpoint, ws: h.WORKSPACE_DIR },
		);
		assert.ok(r.ok, `配置失败: ${r.err}`);
	});

	let converted = false;

	await h.check("docx_convert：HTML → DOCX（产出文件落盘）", async () => {
		const out = resolve(h.WORKSPACE_DIR, "roundtrip.docx");
		// ⚠️ 先**等 prompt 整个跑完**，再去等产物落盘。
		// 之前写成「一看到模型有文字就返回、然后只等 30 秒文件」—— 错在
		// 模型的第一段输出通常只是叙述（「我先看一下工作区里的文件……」），
		// 那时工具还没调。结果是在工具真正执行前就开始倒计时，误判成没产出。
		const turn = await win.evaluate(
			async ({ src, dst, ms }) => {
				try {
					await Promise.race([
						globalThis.kami.prompt({ text: `请直接调用 docx_convert 工具（工具名就是 docx_convert；不要去读 docx 技能、也不要先做别的准备）把工作区里的 ${src} 转换成 ${dst}。` }),
						new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT")), ms)),
					]);
					return { timedOut: false };
				} catch (e) {
					const msg = String(e?.message ?? e);
					// 超时之外的错误（提供方报错、工具拒绝……）也要留下来 —— 否则现象
					// 只是「没产出文件」，真正的原因被吞掉了
					return { timedOut: msg.includes("TIMEOUT"), err: msg.slice(0, 200) };
				}
			},
			{ src: "source.html", dst: "roundtrip.docx", ms: 300_000 },
		);
		assert.ok(!turn.timedOut, `转换时挂起 300 秒${turn.err ? `（${turn.err}）` : ""}`);

		// 回合结束时工具应当已执行完；再等文件真的落盘（首次跑要起 venv python）。
		// 原来是 `for × 120 + sleep 1s` 的手写轮询 —— 换 waitUntil：
		// 同样的 120 秒预算，超时时把现场（模型回复尾部）搬进失败信息里。
		let why = "";
		try {
			await waitUntil(() => existsSync(out), {
				timeout: 120_000,
				interval: 1000,
				desc: `产物 ${out} 落盘（回合已结束 —— 工具没被调用，或写盘失败？）`,
			});
		} catch (error) {
			why = error.message;
		}

		// 先截图、后断言 —— 断言失败时图里才有出问题的那一屏
		await h.shoot("after-convert");

		if (!existsSync(out)) {
			const tail = await win.evaluate(async () => {
				const s = await globalThis.kami.snapshot();
				return JSON.stringify((s?.entries ?? []).filter((x) => x?.role === "assistant")).slice(-400);
			});
			assert.fail(`未生成产物 ${out}。回复尾部: ${tail}${turn.err ? `（回合报错：${turn.err}）` : ""}${why ? `（${why}）` : ""}`);
		}
		converted = true;
	});

	if (converted) {
		await h.check("docx_extract：DOCX → HTML 且标记存活", async () => {
			// 提示词用**自然的提问**，不提「只回复 X」——理由见上一条用例的注释
			const r = await promptAndWait(
				`请用 docx_extract 工具读取工作区里的 roundtrip.docx，告诉我在它提取出的正文里，那串标记（形如一个单词加四位数字）是什么？`,
				MARK,
			);
			await h.shoot("after-extract");
			assert.ok(!r.timedOut, `提取时挂起${r.err ? `（${r.err}）` : ""}`);
			assert.ok(r.found, `标记 ${MARK} 未穿过往返。回复尾部: ${r.text}${r.why ? `（${r.why}）` : ""}`);
		});
	} else {
		// 上一步没产出就没人可提取 —— 明写一条 SKIP，别让它静默消失
		h.skip("docx_extract：DOCX → HTML 且标记存活", "上一步没产出 roundtrip.docx（失败原因见上一条）");
	}
}

await h.check("无渲染层未捕获异常", () => assert.equal(h.pageErrors.length, 0, h.pageErrors.join("; ")));

await h.finish();
