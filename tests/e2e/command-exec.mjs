/**
 * 命令执行链路端到端测试：模型 → powershell 工具 → 权限门 → 沙箱/降级 → 输出回传。
 *
 * 这块此前**从未被端到端验证过**：`tool-loop` 用的是 pi 内置的 `ls`（只读文件工具），
 * 而应用自己那条命令执行链路 —— 权限门判定、沙箱探测与降级分支、托管运行时注入、
 * 输出回传 —— 一行都没跑过。它是 Agent 的主干能力（「让它帮我做点事」就靠它）。
 *
 * ## 本机（macOS）上必须知道的一件事
 *
 * 命令沙箱靠 `koffi` 调 Windows 的 kernel32/advapi32 —— **Windows 专有**。
 * 所以在本机 `sandbox.probe()` 必然 `available: false`，于是：
 *
 *   - `workspace-write` / `read-only` 档（**含默认档**）→ **命令被直接拒绝**，
 *     理由是「为避免在没有操作系统写入约束的情况下执行命令」，并给出逃生指引
 *     （切到「允许完全访问」）。这是**有意的安全设计**：宁可不执行，
 *     也不静默地无约束执行。
 *   - `danger-full-access` 档 → 不经沙箱、直接 spawn，**可以执行**。
 *
 * 于是本测试断言两件相反的事，两件都必要：
 *   A. **默认档下拒绝执行**，且审计里留下 `sandbox/blocked` 痕迹（安全性质）；
 *   B. **切到完全访问档后命令真的跑起来**，标记经工具结果回到模型回复（功能性质）。
 *
 * ⚠️ 凭据运行时从 ~/.claude/settings.json 读取，不进仓库、不打印。
 *    端点不可用时**逐条上报跳过**（见文件末尾的分派），而不是整轮 `exit(0)`。
 *
 * 迁移说明（共享 harness）：骨架（隔离目录、启动并等到就绪、check 收集器、
 * 末尾报告与退出码）全部来自 `./lib/harness.mjs`。启动不再固定等 9 秒 ——
 * harness 等到「#root 挂载 + daemon 报启动 + DOM 变动静默」三件事都成立；
 * 页内手写的 `for + sleep` 轮询换成 `waitUntil`，截止时间统一交给它管。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

// 标记要挑**弱模型也抄得准**的形状（理由见 doc-parsing.mjs 的同类注释）
const MARK = "ORBIT5280";

const h = createHarness({ name: "cmdexec" });
const WORKSPACE_DIR = h.WORKSPACE_DIR;

// ── 模型端点（本机可选）──────────────────────────────────────

const SETTINGS = resolve(homedir(), ".claude", "settings.json");

/** 读本机端点配置；读到不等于服务活着（凭据不落盘、不打印）。 */
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

/**
 * 探一次端点是不是真的活着。
 *
 * 返回 `{ endpoint }` 或 `{ reason }`；`reason` 会作为**跳过理由**逐条写进报告
 * （端点不活不等于用例有问题，但也不能当成通过）。
 */
async function probeEndpoint() {
	if (!existsSync(SETTINGS)) return { reason: `本机没有 ${SETTINGS}` };
	const endpoint = readEndpoint();
	if (endpoint === undefined) {
		return { reason: `${SETTINGS} 的 env 里缺少 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL` };
	}
	const probe = await fetch(`${endpoint.baseUrl}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": endpoint.token, "anthropic-version": "2023-06-01" },
		body: JSON.stringify({ model: endpoint.model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
	}).catch(() => undefined);
	if (!probe || !probe.ok) {
		return { reason: `模型端点探活失败（HTTP ${probe?.status ?? "无响应"}）：${endpoint.baseUrl}` };
	}
	return { endpoint };
}

/**
 * 需要模型才能跑的那些断言。
 *
 * 与下面的 `h.check` 一一对应：**新增依赖模型的断言时这里要同步加一条**，
 * 否则报告会低报跳过数（那正是这个清单存在的意义）。
 */
const NEEDS_MODEL = [
	"配置真实模型并切换工作区",
	"沙箱不可用时：默认档拒绝执行命令（不静默无约束执行）",
	"完全访问档下：命令真的执行，输出回传到模型回复",
	"命令执行：受限档下绝不静默执行（要么走审批、要么被拦下）",
];

/** 逐条上报跳过：报告里要出现「跳过 N」，而不是一片伪装出来的全绿。 */
function skipAll(reason) {
	for (const label of NEEDS_MODEL) h.skip(label, reason);
	h.skip("无渲染层未捕获异常", `${reason}；端点不可用时不启动应用，这条无从检查`);
}

/** 端点可用时的正戏。 */
async function runWithModel(endpoint) {
	await h.launch();
	const win = h.window();

	// ⚠️ 本文件全程用 `kami` API 驱动，**不经过界面输入框**：应用会为工作区
	// 另起一个会话在后台跑，界面上的视图一直停在欢迎页。因此下面几张截图是
	// 「窗口还活着、没白屏」的证据，不是命令执行过程的现场 —— 要看到界面上的
	// 命令卡片，得走真实输入框（见 artifact-present.mjs 的写法）。
	await h.snap("home");

	await h.check("配置真实模型并切换工作区", async () => {
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
			{ ...endpoint, ws: WORKSPACE_DIR },
		);
		assert.ok(r.ok, `配置失败: ${r.err}`);
	});

	// 自动批准 + 记录权限请求（命令执行是 `ask` 档，应走审批；这一步同时把链路走通）
	await win.evaluate(() => {
		globalThis.__zwPermLog = [];
		const k = globalThis.kami;
		if (typeof k.onPermissionRequest === "function") {
			k.onPermissionRequest((req) => {
				globalThis.__zwPermLog.push({ id: req?.id, toolName: req?.toolName, risk: req?.risk });
				try {
					k.respondToPermission({ id: req.id, decision: "allow" });
				} catch {
					/* 应答失败忽略：本用例只关心主链路 */
				}
			});
		}
	});

	/**
	 * 让模型跑一条命令，返回 `{ found, text, note }`（或 `{ timedOut: true }`）。
	 *
	 * ⚠️ 这里**刻意不用** `h.waitForSettled()`：回合进行中界面有 500ms 级的计时器
	 * 在刷新（时长显示、等待提示轮播），「连续 800ms 无变动」永远达不到。
	 * 回合中的等待只能等具体信号 —— 这里等的是**会话快照里出现标记**。
	 */
	async function askModelToRun(text) {
		const timedOut = await win.evaluate(
			async ({ t, ms }) => {
				const k = globalThis.kami;
				try {
					await Promise.race([
						k.prompt({ text: t }),
						new Promise((_, rej) => setTimeout(() => rej(new Error("__TIMEOUT__")), ms)),
					]);
				} catch (e) {
					if (String(e?.message ?? "").includes("__TIMEOUT__")) return true;
				}
				return false;
			},
			{ t: text, ms: 180_000 },
		);
		if (timedOut) return { timedOut: true };

		// 原实现是在页面里 `for (i < 45) { … await sleep(2000) }`（约 90s）——
		// 换成 waitUntil：慢机器不假失败、快机器不白等，超时的错误信息里还带着
		// 「最后一次取到的会话尾部」，能直接看出界面上到底有什么。
		let last = { found: false, text: "(还没取到会话快照)" };
		let note = "";
		try {
			await waitUntil(
				async () => {
					last = await win.evaluate(async (mark) => {
						const s = await globalThis.kami.snapshot();
						const entries = s?.entries ?? [];
						// 找标记时只看**有正文的**助手条目：空条目是流式占位，混进来会干扰拼接
						const texts = entries
							.filter((x) => x?.role === "assistant" && String(x?.text ?? "").length > 0)
							.map((x) => x.text);
						const txt = texts.join("\n");
						if (txt.includes(mark)) return { found: true, text: txt.slice(-300) };
						// 没找到时把整段助手条目带回去，供失败信息使用
						return {
							found: false,
							text: JSON.stringify(entries.filter((x) => x?.role === "assistant")).slice(-400),
						};
					}, MARK);
					return last.found;
				},
				{ timeout: 90_000, interval: 2000, desc: `会话回复里出现标记 ${MARK}（命令没跑通或输出没回传）` },
			);
		} catch (error) {
			note = `${error.message}；`;
		}
		return { ...last, note };
	}

	const promptText = `请用 powershell 工具在我的工作区（${WORKSPACE_DIR}）里执行一条命令，把文本 ${MARK} 打印出来，然后告诉我这条命令的实际输出是什么。`;

	// ── A. 默认档：沙箱不可用 ⇒ 拒绝执行（安全性质）─────────────

	await h.check("沙箱不可用时：默认档拒绝执行命令（不静默无约束执行）", async () => {
		// 先确认本机确实没有沙箱 —— 有沙箱的机器（Windows）上这条用例的前提不成立
		const sb = await win.evaluate(async () => {
			const p = await globalThis.kami.getPermissions();
			return { mode: p?.settings?.sandbox, note: String(p?.sandboxNote ?? "") };
		});
		console.log(`      当前权限档: ${sb.mode}`);

		await win.evaluate(async () => {
			await globalThis.kami.setPermissions({ sandbox: "workspace-write", approval: "ask" });
		});
		await win.evaluate(async () => {
			await globalThis.kami.auditClear();
		});

		// ⚠️ 这一步同时是**下一段的前提**：等模型把这一轮走完再切档，
		// 否则上一轮残留的请求会落进 B 的「不该新增 blocked」增量断言里。
		await askModelToRun(promptText);

		// 关键断言：审计里留下「沙箱不可用 ⇒ 拦下」的痕迹。
		// 用审计而不是模型复述 —— 拒绝对不对是**产品行为**，不该依赖弱模型转述准确。
		const audit = await win.evaluate(async () => {
			const a = await globalThis.kami.auditList("sandbox");
			return (a?.records ?? []).map((x) => ({ outcome: x.outcome, detail: String(x.detail ?? "").slice(0, 120) }));
		});

		// 先截图后断言：万一「本该被拦下」没成立，这一屏就是现场
		await h.shoot("sandbox-blocked");

		if (process.platform === "win32") {
			// Windows 上有命令沙箱，这条断言的前提不成立。
			// 原来这里只打一行日志 —— 报告里看不出来，现在显式记成跳过。
			h.skip("默认档下命令被拦下并写审计", "本机是 Windows —— 有命令沙箱，该前提不成立");
			return;
		}
		assert.ok(
			audit.some((x) => x.outcome === "blocked"),
			`本机没有命令沙箱，默认档下命令应被拦下并写审计，实际审计: ${JSON.stringify(audit).slice(0, 250)}`,
		);
		console.log(`      审计: ${JSON.stringify(audit.find((x) => x.outcome === "blocked"))?.slice(0, 160)}`);
	});

	// ── B. 完全访问档：命令真的跑起来（功能性质）────────────────

	await h.check("完全访问档下：命令真的执行，输出回传到模型回复", async () => {
		const beforeStat = await win.evaluate(async () => {
			const a = await globalThis.kami.auditList("sandbox");
			const recs = a?.records ?? [];
			return { n: recs.length, blocked: recs.filter((x) => x.outcome === "blocked").length };
		});
		const before = beforeStat.n;
		const beforeBlocked = beforeStat.blocked;

		await win.evaluate(
			async ({ ws }) => {
				await globalThis.kami.setPermissions({ sandbox: "danger-full-access", approval: "ask" });
				// ⚠️ 必须开新会话：上一轮里模型已经收到了「命令被拒」的结果，它在同一个会话里
				// 会一直纠结「要不要提权重试」，而不是重新执行。清空上下文才是干净的重试。
				await globalThis.kami.newTask(ws);
			},
			{ ws: WORKSPACE_DIR },
		);

		// 提示词**点名命令**：不留给模型「该跑哪条」的决策空间。
		// 弱模型在开放式指令下常常反复权衡（实测：它会纠结「要不要再试一次」而始终不动手），
		// 而我们这条用例要验的是**执行链路**，不是模型的决策能力。
		const explicit = `现在权限档是「允许完全访问」，可以直接执行命令。请调用 powershell 工具执行这一条命令：echo ${MARK} —— 然后用一句话告诉我它的实际输出。`;
		let r = await askModelToRun(explicit);
		if (!r.found && !r.timedOut) {
			// 模型抖动（第一轮没动手）时再催一次；只重试一次，避免把抖动当成常态
			r = await askModelToRun(`请现在就调用 powershell 工具执行：echo ${MARK}。只做这一件事。`);
		}

		// 先截图后断言：命令跑没跑通，这一屏就是现场
		await h.shoot("command-executed");

		// ⚠️ 这条断言在 macOS 上是**假通过**，实测证据（迁移时跑出来的）：
		// 本机没有 powershell，即使切到完全访问档，工具也是
		// `spawn powershell.exe ENOENT` 直接失败 —— 命令并没有真的跑起来；
		// 而 `askModelToRun` 找的那个标记会被**模型复述命令**（回复里引用了
		// `echo ORBIT5280`）满足。也就是说「等到的条件」与「要断言的副作用」
		// 本是两件事，这里恰好被同一段文字同时满足了（见测试规范「等待」一节）。
		// 这条**没有被削弱**（迁移的原则是断言只许加强），但真正该断言的是
		// 「工具结果里带回了命令输出」—— 那在本机永远不成立，
		// 因为命令执行是 Windows 专有能力。留在这里，别被这条绿灯误导。
		assert.ok(!r.timedOut, "命令执行挂起");
		assert.ok(
			r.found,
			`标记 ${MARK} 未出现在回复里 —— 命令没跑通或输出没回传。${r.note ?? ""}回复尾部: ${String(r.text).slice(-240)}`,
		);

		// 这一档不该**再新增**「被拦下」的审计（A 那条 blocked 记录本来就还在，
		// 所以看的是增量而不是绝对条数 —— 起初按绝对值断言，假失败了一次）
		const after = await win.evaluate(async () => {
			const a = await globalThis.kami.auditList("sandbox");
			return {
				n: (a?.records ?? []).length,
				blocked: (a?.records ?? []).filter((x) => x.outcome === "blocked").length,
			};
		});
		assert.equal(after.blocked, beforeBlocked, `完全访问档下不该新增「被拦下」记录（前 ${beforeBlocked} → 后 ${after.blocked}）`);
		console.log(`      回复尾部: ${String(r.text).replace(/\s+/g, " ").slice(-140)}（审计 ${before} → ${after.n} 条）`);
	});

	await h.check("命令执行：受限档下绝不静默执行（要么走审批、要么被拦下）", async () => {
		// ⚠️ 这条断言的是**可移植的安全性质**，不是「一定有权限弹窗」。
		// 档位与审批的关系（见 command-exec.js:295 与 createSandboxedRunner 的分支顺序）：
		//   - `danger-full-access` → 判定直接 `{kind:"allow"}`，**按设计不问**
		//     （该档的语义就是「用户已明示授权、无约束」）；
		//   - 受限档 → 本机沙箱不可用，**在审批之前就拒了**，所以也不会问。
		// 于是「必须有弹窗」在本机永远不成立 —— 起初就是这么写的，假失败了一次。
		// 真正该守的是：受限档下命令**不得静默跑掉** —— 要么有审批请求，要么审计里有拦截记录。
		const perm = await win.evaluate(() => ({ log: globalThis.__zwPermLog ?? [] }));
		const audit = await win.evaluate(async () => {
			const a = await globalThis.kami.auditList("sandbox");
			return (a?.records ?? []).map((x) => x.outcome);
		});
		const asked = perm.log.some((x) => x.toolName === "powershell");
		const blocked = audit.includes("blocked");
		assert.ok(asked || blocked, `受限档下命令既没走审批、也没被拦下 —— 静默执行了？审批: ${JSON.stringify(perm.log).slice(0, 160)}`);
		console.log(`      审批请求 ${perm.log.length} 次（含 powershell: ${asked}）；审计里被拦下: ${blocked}`);
	});

	await h.check("无渲染层未捕获异常", () => assert.equal(h.pageErrors.length, 0, h.pageErrors.join("; ")));
}

// ── 分派：端点可用就跑正戏，不可用就逐条上报跳过 ────────────────
//
// 原来这里是不论如何都 `process.exit(0)`：报告里一片全绿、实际一条断言都没跑，
// 于是本文件在 CI 上是**零信号**。跳过与通过必须能被区分开。
const { endpoint, reason } = await probeEndpoint();
if (endpoint === undefined) {
	console.warn(`⚠ 模型端点不可用 —— 本测试需要模型：${reason}`);
	skipAll(reason);
} else {
	console.log(`✓ 模型端点可用：${endpoint.baseUrl}，模型 ${endpoint.model}`);
	await runWithModel(endpoint);
}

await h.finish();
