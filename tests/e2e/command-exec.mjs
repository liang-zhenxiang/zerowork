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
 *   - `danger-full-access` 档 → 不经沙箱、**直接 `spawn("powershell.exe")`**。
 *     ⚠️ 注意「不经沙箱」**不等于「能执行」**：本机没有 powershell.exe，
 *     这条路同样以 `ENOENT` 收场（下一节有实测）。原先的 B 条断言正是被
 *     这一点骗过去的。
 *
 * 于是本测试断言两件相反的事，两件都必要：
 *   A. **默认档下拒绝执行** —— 判据落在「**沙箱拒绝**」这个可观察副作用上
 *      （工具卡 `outcome` + 卡片正文里的沙箱标记 + 本轮审计里那条沙箱记录），
 *      并且**不**为「模型合法提权」这个正确行为判红（详解见「check A 的判据」一节）；
 *   B. **切到完全访问档后命令真的跑起来**（功能性质）—— 但见下面两节，
 *      这条在本机（macOS）上**不成立**，必须显式跳过而不是假通过。
 *
 * ⚠️ 凭据运行时从 ~/.claude/settings.json 读取，不进仓库、不打印。
 *    端点不可用时**逐条上报跳过**（见文件末尾的分派），而不是整轮 `exit(0)`。
 *
 * ## B 条的验收到底是什么（含被否掉的写法）
 *
 * 「命令真的执行了」是**副作用**，判据必须落在副作用上：
 *
 *   - ✅ **采纳**：`powershell` **工具卡**真的出现
 *     （snapshot 的 `entries` 里 `role:"tool"` 且 `toolName:"powershell"`），
 *     并且它的 `outcome` 是 `ok`、`detail` 里带回了命令的真实输出。
 *     这张卡由 daemon 在 `tool_execution_end` 时按**工具的真实返回值**构造
 *     （`session-host.js` 的 `toolOutcomeFrom` / `toolResultText`），
 *     模型复述不出它 —— 执行链路一断，卡要么没有、要么 `outcome !== "ok"`。
 *   - ❌ **已否掉**（原先的写法）：等「会话回复里出现标记 `ORBIT5280`」。
 *     那验的是「模型会不会把命令抄一遍」，与命令有没有执行是两件事。
 *     实测证据（本次修复前跑出来的）：本机切到完全访问档后，工具是
 *     `spawn powershell.exe ENOENT` 直接失败、命令根本没跑起来，
 *     而那条断言依然 PASS —— 因为模型在回复里引用了 `echo ORBIT5280`
 *     （尾部原话：「…现在就重新调用命令执行工具运行 echo ORBIT5280」）。
 *     把被测功能整个删掉它照样绿，属于测试规范第 5 条讲的**无法证伪**。
 *
 * ## 本机（macOS）上「命令真的执行」本身不成立 ⇒ 显式跳过
 *
 * 命令执行工具把二进制**硬编码**成 `spawn("powershell.exe", …)`：
 * 受限档走沙箱（`koffi` 调 Windows 的 kernel32 / advapi32，Windows 专有），
 * 完全访问档只是**绕过沙箱走到同一条直通 spawn**（`command-exec.js` 里
 * `createSandboxedRunner` 的 `danger-full-access` 分支调的 `options.fallback`
 * 就是那一句 `spawn("powershell.exe", …)`）。所以本机换哪个档位都跑不起来：
 *
 *   工具返回「无法启动 powershell.exe：spawn powershell.exe ENOENT…
 *   本工具依赖 Windows 自带的 PowerShell，当前环境不可用」；
 *   审计里那条沙箱记录的 detail 也写着「当前系统不是 Windows：当前平台是 darwin」。
 *
 * 于是 B 条拆成两半：
 *   - **平台无关的那半**照常断言：命令请求真的走到工具层（工具卡真的出现），
 *     且工具结果不是「被拦下」（完全访问档是真放行）；
 *   - **「命令真的执行」那半在非 Windows 上显式 `h.skip`**，理由写明 ——
 *     不再靠「模型复述命令」把它凑成绿的。
 *
 * 拆开的直接原因是这两半的前提不同；顺带也修掉了一条**会为正确行为判红**的旧断言：
 * 原先平台无关的那半断言「审计里不再新增 blocked 记录」，但模型若自带
 * `sandbox_permissions` 参数，完全访问档下会被「提权必须严格变宽」**正确**拒掉、
 * 审计**理应**多一条 blocked（实测抓到过）。详见 B1 处的注释。
 *
 * ## check C 验的到底是什么（含「沙箱拒绝 vs powershell 不存在」的区分）
 *
 * C 原先的判据是「审批请求里有 powershell」**或**「审计里有 blocked」，
 * 两个都不成立（Issue #55）：
 *
 *   - `asked` **恒为 false** —— C 跑的时候档位还停在 **B 留下的 `danger-full-access`**
 *     （C 自己从不切档），而该档的判定直接 `{kind:"allow"}`、按设计不问审批；
 *   - `blocked` **恒为 true** —— 判据读的是**审计**，而那条记录是 **check A 留下的**
 *     （A 开头 `auditClear()` 过，C 没清）。
 *
 * 于是它验的其实是「A 写过一条 blocked」：**把「受限档拒绝执行」这条链路整个删掉，
 * 它照样绿**。现在 C **自己切到受限档、自己清审计与审批日志、开新会话跑一轮**，
 * 只认本轮新增的副作用 —— 工具卡与审计记录。
 *
 * ### 沙箱拒绝 vs powershell 不存在（两者在本机都可能出现，语义相反）
 *
 * 本机（macOS）没有 powershell.exe，所以「结果不是 ok」**不能**当作判据 ——
 * 它既可能是「安全约束生效了」，也可能只是「环境里没有这个可执行文件」。
 * 两者实测可区分（判据来源见 `command-exec.js`）：
 *
 * | | 沙箱拒绝（要守的性质） | powershell 不存在（环境缺失） |
 * | --- | --- | --- |
 * | 发生在 | **执行之前**（`refuseCommand`） | 执行之中（`spawn` ENOENT） |
 * | 工具返回值 | `{blocked:true, category:"sandbox-unavailable"}` | **抛错**（`spawnFailureText`） |
 * | 卡片 `outcome` | `blocked`（按 `details.blocked` 判出） | `error`（按 `isError` 判出） |
 * | 卡片正文 | 「命令未执行：**本机的命令沙箱不可用**（…）」 | 「**无法启动 powershell.exe**：spawn … ENOENT…」 |
 * | 沙箱审计 | 多一条 `outcome:"blocked"`，detail 以「**沙箱不可用，命令未执行**」开头 | **不写** |
 *
 * 所以 C 同时钉三件事：卡片 `outcome` 是 `blocked`、卡片正文带沙箱拒绝的标记、
 * 本轮审计里有那条 `sandbox/blocked` 记录。三条标记都是文案常量，
 * 集中在文件上半部分的 `SANDBOX_REFUSAL_CARD_MARK` 一处。
 *
 * ## check A 的判据（含「模型合法提权」这个正确行为）
 *
 * A 原先只断言「审计里有 blocked 记录」，这一条有**两处**不成立：
 *
 *   1. **会为正确行为判红**（Issue #58）。模型若在该轮自带 `sandbox_permissions`
 *      + justification：受限档（workspace-write）→ 完全访问是**严格变宽**，
 *      属于**合法**提权（`permissions.js` 的 `canEscalate`），会走审批通道；
 *      本测试的审批处理器一律 allow，于是这一轮按「用户明示授权」绕过沙箱，
 *      最终以 `spawn("powershell.exe")` 的 ENOENT 收场 —— **产品行为完全正确**，
 *      审计里却一条 blocked 都没有。
 *      （可达性有实测支撑：跑这个文件时模型**两次**在 C 的第一轮里自作主张带了
 *      提权参数，审计里能看到「用户批准本次提权到「danger-full-access」」。）
 *   2. **判据太宽**：「提权申请被拒」同样会写一条 blocked（`planExecution`），
 *      拿它当证据等于把「提权被拒」误当成「受限档拒绝沙箱」。
 *
 * 现在与 C 用同一套手法：**收窄提示词**（明确不要传提权参数）+ **证据不是要找的
 * 那条就再催一次**（而不是干等到 90s 超时），判据落在**沙箱拒绝**这个可观察
 * 副作用上 —— 上面那张判别表的三行（卡片 `outcome`、卡片正文、审计 detail），
 * 而不是「审计里有没有 blocked」。
 *
 * 等待条件同样修过：原实现是 `await askModelToRun(promptText)` ——
 * 等的同样是「模型的那段文字」，而且返回值被丢弃（等没等到都不影响结论）。
 * 那段文字在这里只是**同步点**（等这一轮跑完再切档），不是断言对象 ——
 * 但用「模型复述」当同步点不可靠：模型不复述就只能干等到 90s 超时。
 * 现在等的是**真的动手了没有**（本轮 powershell 工具卡真的出现），
 * 失败信息里也带上了现场。
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

/**
 * 本机的命令执行工具到底能不能把命令跑起来？
 *
 * 工具的二进制在源码里**硬编码**为 `spawn("powershell.exe", …)`
 * （`src/main/daemon/command-exec.js` 的直通路径；完全访问档只是绕过沙箱走到
 * 同一条路径）。`powershell.exe` 是 Windows 专有的可执行文件名：非 Windows
 * 平台上没有它，于是**换哪个权限档都执行不了**。实测本机
 * `which powershell pwsh` 两个都没有，切到完全访问档后仍是 `ENOENT`。
 *
 * 所以「命令真的执行」这类断言的前提**只在本机是 Windows 时成立**；
 * 其余平台上必须显式跳过（见文件头「B 条的验收」一节）。
 */
const CAN_EXECUTE_COMMANDS = process.platform === "win32";

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

/** A 条：默认档下命令被拒绝执行（安全性质，只在**没有命令沙箱**的平台上可观察）。 */
const LABEL_DEFAULT_BLOCKED = "沙箱不可用时：默认档拒绝执行命令（不静默无约束执行）";
/** B 条的两半：**平台无关**的那半 / **命令真的执行**的那半（非 Windows 上跳过）。 */
const LABEL_TOOL_REACHED = "完全访问档下：命令请求真的走到工具层（工具结果不是「被拦下」）";
const LABEL_COMMAND_EXECUTED = "完全访问档下：命令真的执行、输出回传到工具结果";
/** C 条：受限档下命令被拒绝执行（安全性质，只在**没有命令沙箱**的平台上可观察）。 */
const LABEL_RESTRICTED_REFUSED = "命令执行：受限档下绝不静默执行（沙箱不可用时命令被拒绝）";

/**
 * 「命令被**沙箱**拒绝」与「本机没有 powershell.exe」是两件事，判据必须分开。
 *
 * 两者在本机（macOS）上都可能出现，而语义完全相反 —— 前者是**要守的安全性质**
 * （沙箱不可用 ⇒ 宁可不执行），后者只是**环境缺失**（换台 Windows 就没有）。
 * 如果只用「结果不是 ok」当判据，就会把「环境里没有 powershell」当成
 * 「安全约束生效了」，这正是本条用例此前**无法证伪**的一部分。
 *
 * 判定依据（源码位置，实测输出见文件头）：
 *   - **沙箱拒绝**：`createSandboxedRunner` 在**执行之前**调 `refuseCommand`
 *     （`command-exec.js` 的 `probe.available === false` 分支）→ 工具返回
 *     `{blocked:true, category:"sandbox-unavailable"}`，卡片的 `outcome` 由
 *     `ledger.js` 的 `toolOutcomeFrom` 按 `details.blocked` 判成 **"blocked"**；
 *     卡片正文以「命令未执行：本机的命令沙箱不可用」开头；
 *     审计里同时多一条 `category:"sandbox" / outcome:"blocked"` 的记录。
 *   - **powershell 不存在**：`danger-full-access` 分支绕过沙箱、直接
 *     `spawn("powershell.exe")`，ENOENT 让 `runCommand` **抛错**
 *     （`spawnFailureText`）→ 工具是**抛异常**退出，卡片是 **"error"** 而不是
 *     "blocked"，正文写「无法启动 powershell.exe：…」，**且不写沙箱审计**。
 *
 * 所以两者可以区分：`outcome` 不同（blocked vs error）、文案不同、审计有无不同。
 * 下面的断言把这条区分钉死成三条标记。
 */
const SANDBOX_REFUSAL_CARD_MARK = "本机的命令沙箱不可用";
const SANDBOX_REFUSAL_AUDIT_MARK = "沙箱不可用，命令未执行";
const POWERSHELL_MISSING_MARK = "无法启动 powershell.exe";

/** 非 Windows 上跳过「命令真的执行」的理由：要说清**为什么本机验不了**。 */
const NO_POWERSHELL_REASON =
	`本机平台是 ${process.platform}，没有 powershell.exe：命令执行工具把二进制硬编码成 ` +
	`spawn("powershell.exe")（Windows 专有），完全访问档也绕不过它 —— 命令在这里本来就跑不了，` +
	`「命令真的执行、输出回传」没有可观察的副作用可断言（此前这条靠「模型复述命令」假通过）`;

/**
 * 需要模型才能跑的那些断言。
 *
 * 与下面的 `h.check` 一一对应：**新增依赖模型的断言时这里要同步加一条**，
 * 否则报告会低报跳过数（那正是这个清单存在的意义）。
 */
const NEEDS_MODEL = [
	"配置真实模型并切换工作区",
	LABEL_DEFAULT_BLOCKED,
	LABEL_TOOL_REACHED,
	LABEL_COMMAND_EXECUTED,
	LABEL_RESTRICTED_REFUSED,
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
	 * 送一条提示词进去，等这一轮**跑完**（`kami.prompt` 在整轮 run 结束时才 resolve）。
	 *
	 * 只负责推进与同步，不解读结果 —— 要断言什么由调用方自己去取副作用。
	 * ⚠️ 这里**刻意不用** `h.waitForSettled()`：回合进行中界面有 500ms 级的计时器
	 * 在刷新（时长显示、等待提示轮播），「连续 800ms 无变动」永远达不到。
	 *
	 * @returns 整轮是否超过 `ms` 仍未结束（`true` = 挂住了）
	 */
	async function promptRound(text, ms = 180_000) {
		return await win.evaluate(
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
			{ t: text, ms },
		);
	}

	/** 已经出现过的 powershell 工具卡 id —— 催问时用来只认**新一轮**的卡。 */
	const seenToolCards = new Set();

	/**
	 * 让模型跑一条命令，并把这一轮的**可观察副作用**取回来：`powershell` 工具卡。
	 *
	 * ⚠️ 判据是**工具卡**（`role:"tool"` + `toolName:"powershell"`，终态带 `outcome`
	 * 与 `detail`），**不是模型回复里出现过那段命令** —— 后者验的是「模型会不会
	 * 复述」，与命令有没有执行是两件事（见文件头「B 条的验收到底是什么」）。
	 * 工具卡由 daemon 按工具的真实返回值构造，模型复述不出它。
	 *
	 * @returns `{ timedOut, card, tail, note }`；`card` 为 `undefined` 表示这一轮里
	 *          工具压根没被调用（弱模型可能不动手，调用方按需重试一次）。
	 */
	async function runOneCommandRound(text) {
		const timedOut = await promptRound(text);
		if (timedOut) return { timedOut: true, card: undefined, tail: "(整轮超时，没取到会话快照)", note: "整轮超时；" };

		let last = { card: undefined, tail: "(还没取到会话快照)", note: "" };
		try {
			await waitUntil(
				async () => {
					last = await win.evaluate(
						async ({ tool, exclude }) => {
							const s = await globalThis.kami.snapshot();
							const entries = s?.entries ?? [];
							// 助手正文只用于**失败时的现场**（末尾几句），不参与判定
							const tail = entries
								.filter((x) => x?.role === "assistant" && String(x?.text ?? "").length > 0)
								.map((x) => x.text)
								.join("\n")
								.slice(-300);
							// outcome 有值 = 这张卡已经到终态（tool_execution_end 回填的）
							const cards = entries.filter(
								(x) => x?.role === "tool" && x?.toolName === tool && x?.outcome !== undefined,
							);
							// 只认**这一轮新增**的卡：催问那一轮若立刻命中上一轮留下的旧卡，
							// 等于没等（会把「模型这次没动手」误判成动手了）。
							const card = cards.filter((x) => !exclude.includes(String(x.id))).at(-1);
							return card === undefined
								? {
										ids: cards.map((x) => String(x.id)),
										card: undefined,
										tail,
										note: "会话里还没有本轮的 powershell 工具卡 —— 模型没动手？",
									}
								: {
										ids: cards.map((x) => String(x.id)),
										card: {
											outcome: String(card.outcome),
											detail: String(card.detail ?? ""),
											label: String(card.label ?? ""),
										},
										tail,
										note: "",
									};
						},
						{ tool: "powershell", exclude: [...seenToolCards] },
					);
					return last.card !== undefined;
				},
				{ timeout: 90_000, interval: 2000, desc: `${MARK} 那一轮里出现新的 powershell 工具卡（工具没被调用？）` },
			);
		} catch (error) {
			last.note = `${error.message}；${last.note}`;
		}
		for (const id of last.ids ?? []) seenToolCards.add(id);
		return { timedOut: false, ...last };
	}

	/** 读本会话的 sandbox 审计（只取报告要用的字段）。 */
	async function readSandboxAudit() {
		return await win.evaluate(async () => {
			const a = await globalThis.kami.auditList("sandbox");
			return (a?.records ?? []).map((x) => ({ outcome: x.outcome, detail: String(x.detail ?? "").slice(0, 120) }));
		});
	}

	/**
	 * A 的提示词，**点名命令 + 明确不要传提权参数**（收窄模型的决策空间）。
	 *
	 * 后半句是 Issue #58 的修法（与 C 的提示词同一句）：模型若自作主张带
	 * `sandbox_permissions` + justification，受限档下那是一次**合法**的提权申请
	 * （严格变宽），本测试的审批处理器一律 allow —— 于是这一轮走的是
	 * 「用户明示授权到完全访问」，不再是「受限档拒绝」的证据。
	 * 详见文件头「check A 的判据」。
	 */
	const promptText =
		`请用 powershell 工具在我的工作区（${WORKSPACE_DIR}）里执行一条命令，把文本 ${MARK} 打印出来，` +
		`然后告诉我这条命令的实际输出是什么。不要传 sandbox_permissions / justification 参数。`;

	// ── A. 默认档：沙箱不可用 ⇒ 拒绝执行（安全性质）─────────────

	await h.check(LABEL_DEFAULT_BLOCKED, async () => {
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

		/** 这一轮拿到的，是不是**要找的那份证据**：被沙箱拒绝执行。 */
		const isSandboxRefusal = (r) =>
			r.card !== undefined && String(r.card.detail).includes(SANDBOX_REFUSAL_CARD_MARK);

		// ⚠️ 这一段同时是**下一段的前提**：等模型把这一轮走完再切档，
		// 否则这一轮的残留会落进 B 的判定里（B 会开新会话，但没跑完就切档的场面是
		// 两轮叠在一起，B 取到的工具卡可能不是它那一轮的）。
		//
		// 等的**不再**是「模型回复里出现标记」——那验的是模型会不会复述，而原写法
		// 连它的返回值都丢掉了（`void r`：等没等到都不影响结论）。这里等的是
		// 「模型真的动手了」这个信号（本轮的 powershell 工具卡真的出现），
		// 模型没动手时 `note` 会被下面的失败信息带出来，不会被静默吞掉。
		let round = await runOneCommandRound(promptText);

		// 再催一次的唯一情形：这一轮没取到**能当判据的**证据（与 C 同一手法）。
		// 三种可能，都不是判据：
		//   ① 模型压根没动手（没有本轮的 powershell 工具卡）；
		//   ② 模型自作主张带了 `sandbox_permissions` + justification —— 受限档 → 完全访问
		//      是**严格变宽**（`permissions.js` 的 `canEscalate`），属**合法**提权，会走审批；
		//      本测试的审批处理器一律 allow，于是这一轮按「用户明示授权」绕过了沙箱，
		//      最终失败在「本机没有 powershell.exe」——**产品行为完全正确**，
		//      拿它判红正是这条用例此前会犯的错（Issue #58）；
		//   ③ 别的形状（提权被拒、工具异常）—— 同样不是「受限档拒绝」的证据。
		// 它们**既不该拿来临绿**（旧写法只要审计里有 blocked 就绿），
		// **也不该拿来临红**（拿一个合法场景判红，等于换一种方式失去信号）。
		// 催问前**开新会话**：上一轮模型已经收到了那条命令的结果（「本机没有 powershell」），
		// 留在同一段上下文里它多半只复述结论而不再动手（B1 处同一条理由）；
		// 顺带把审计清零，让下面的判据只认**催问这一轮**。
		// 残余风险（如实记下）：**两轮**都带提权参数时，判据仍不是沙箱拒绝，A 会判红。
		// 这是小概率（本文件实测：模型只在 C 的第一轮里自发带过两次），且失败信息里
		// 会打出「第一轮不是「沙箱拒绝」」与现场的卡片正文 —— 是「本机没有
		// powershell.exe」还是「本机的命令沙箱不可用」，一眼能分辨。
		let retried = false;
		if (!isSandboxRefusal(round)) {
			retried = true;
			// 先解释「为什么这一轮不算数」并**留下这一轮的审计**（下面的清空会把它抹掉）：
			// 模型合法提权时，那条「用户批准本次提权到「danger-full-access」」就在里面，
			// 是这类轮次唯一的直接证据。
			const why =
				round.timedOut
					? "整轮超时"
					: round.card === undefined
						? "模型没动手（没有本轮的卡）"
						: String(round.card.detail).includes(POWERSHELL_MISSING_MARK)
							? "执行绕过了沙箱、败在「本机没有 powershell.exe」（提权被批准？）"
							: `卡片 outcome=${round.card.outcome}`;
			const firstAudit = await readSandboxAudit();
			console.log(`      第一轮不是「沙箱拒绝」（${why}），开新会话催问一次；该轮沙箱审计: ${JSON.stringify(firstAudit).slice(0, 240)}`);
			await win.evaluate(
				async ({ ws }) => {
					await globalThis.kami.newTask(ws);
					await globalThis.kami.auditClear();
				},
				{ ws: WORKSPACE_DIR },
			);
			round = await runOneCommandRound(
				`现在权限档是受限档（workspace-write），不需要也不要传 sandbox_permissions / justification 参数 —— 直接调用 powershell 工具执行：echo ${MARK}。只做这一件事。`,
			);
		}

		// 先截图后断言：万一「本该被拦下」没成立，这一屏就是现场
		await h.shoot("sandbox-blocked");

		if (process.platform === "win32") {
			// Windows 上有命令沙箱，这条断言的前提不成立。
			// 原来这里只打一行日志 —— 报告里看不出来，现在显式记成跳过。
			//
			// `h.skip` 在 check 回调里会**抛出哨兵中止这条 check**，由 h.check 改记为
			// SKIP（不再并列记一条 PASS），所以这里不需要 `return` —— 后面的断言到不了。
			// label 必须与外层 `h.check` 的一致（否则 h.skip 直接报错）：这样同一条 check
			// 在 Windows 与「端点不可用」两条路径下，报告里的名字是同一个。
			h.skip(LABEL_DEFAULT_BLOCKED, "本机是 Windows —— 有命令沙箱，该前提不成立");
		}

		// 审计已被本用例清空过（催过则是在催问前清的）——读到的都该是**这一轮**写的。
		// 判据是「沙箱拒绝」而不是「模型复述」，也不用「有没有 blocked」：
		// 拒绝对不对是**产品行为**，不该依赖弱模型转述准确，也不该被别的 blocked 冒名顶替。
		const audit = await readSandboxAudit();
		const blocked = audit.filter((x) => x.outcome === "blocked");
		console.log(
			`      沙箱审计 ${audit.length} 条（blocked ${blocked.length} 条）: ${JSON.stringify(audit).slice(0, 200)}`,
		);

		// 失败信息里带上现场：工具卡（模型动手了没有、工具怎么说的）+ 回复尾部 + 催过没有
		const scene =
			`本轮工具卡：${round.card === undefined ? "无（模型没动手）" : `outcome=${round.card.outcome} / ${String(round.card.detail).replace(/\s+/g, " ").slice(0, 160)}`}；` +
			`${round.note}${retried ? "（第一轮没取到沙箱拒绝的证据，已催问一次）" : ""}` +
			`回复尾部: ${String(round.tail).replace(/\s+/g, " ").slice(-140)}`;

		// ① 模型得真的动过手：**没取到证据 ≠ 没执行**，不能拿它当通过。
		assert.ok(
			round.card !== undefined,
			`默认档下没取到本轮的 powershell 工具卡 —— 模型没动手，这条用例就没有判据（不等于「没静默执行」）。${scene}`,
		);

		// ② **命令没有执行**这个可观察副作用：卡片到了终态，且是「被拦下」。
		//    （`outcome` 由 daemon 按工具真实返回值的 `details.blocked` 判出，
		//     模型复述不出来 —— 见文件头「B 条的验收」。）
		assert.equal(
			round.card.outcome,
			"blocked",
			`默认档下命令没有被拦下（工具结果 outcome=${round.card.outcome}）—— 静默执行了？${scene}`,
		);

		// ③ 拦下它的是**沙箱**，不是「本机没有 powershell.exe」。两者语义完全相反，
		//    判定依据集中在文件头的「沙箱拒绝 vs powershell 不存在」；这里两条一起钉。
		assert.ok(
			String(round.card.detail).includes(SANDBOX_REFUSAL_CARD_MARK),
			`默认档下命令是被拦下了，但理由不是「沙箱不可用」（工具结果里找不到「${SANDBOX_REFUSAL_CARD_MARK}」）—— 拦下它的可能是别的东西：${String(round.card.detail).replace(/\s+/g, " ").slice(0, 240)}${scene}`,
		);
		assert.ok(
			!String(round.card.detail).includes(POWERSHELL_MISSING_MARK),
			`默认档下这一轮的失败是「本机没有 powershell.exe」而不是「被沙箱拒绝」—— 执行绕过了沙箱那条路？${String(round.card.detail).replace(/\s+/g, " ").slice(0, 240)}${scene}`,
		);

		// ④ 审计里也要有**本轮**那条「沙箱不可用 ⇒ 命令未执行」的记录：
		//    卡片证的是「工具没跑这条命令」，审计证的是「这次拒绝被如实记了账」，两个角度都要。
		//    ⚠️ 判据从「有没有 blocked」收窄成「blocked 里有没有沙箱那条」：
		//    「提权申请被拒」同样会写一条 blocked（`planExecution`），
		//    它不是「受限档拒绝沙箱」的证据，此前会被误当成证据。
		assert.ok(
			blocked.some((x) => x.detail.includes(SANDBOX_REFUSAL_AUDIT_MARK)),
			`默认档下审计里没有本轮新增的「${SANDBOX_REFUSAL_AUDIT_MARK}」记录 —— 本轮的拒绝没被记账？` +
				`（审计已在本轮开头清空，读到的都该是本轮的）实际: ${JSON.stringify(audit).slice(0, 250)}。${scene}`,
		);
		console.log(
			`      本轮的拦截记录: ${JSON.stringify(blocked.find((x) => x.detail.includes(SANDBOX_REFUSAL_AUDIT_MARK)))?.slice(0, 200)}`,
		);
	});

	// ── B. 完全访问档：命令真的跑起来（功能性质）────────────────
	//
	// 拆成两半，因为它们的前提不一样：
	//   B1「命令请求真的走到工具层」—— **平台无关**，本机也该守（换档位后不该再被拦）；
	//   B2「命令真的执行、输出回传」—— 前提是**本机有 powershell.exe**，只在 Windows 上成立。
	// 两半共用同一轮模型调用（B1 把副作用取回来存在 `evidence` 里给 B2 用），
	// 所以不会多跑一轮。

	/** B1 取到的这一轮证据，给 B2 复用（两半共用一次模型调用，不额外多跑）。 */
	let evidence = null;

	await h.check(LABEL_TOOL_REACHED, async () => {
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
		evidence = await runOneCommandRound(
			`现在权限档是「允许完全访问」，可以直接执行命令。请调用 powershell 工具执行这一条命令：echo ${MARK} —— 然后用一句话告诉我它的实际输出。`,
		);
		// 两种情况再催一次（只催一次，避免把抖动当成常态）：
		//   ① 模型没动手 —— 会话里没有本轮的卡；
		//   ② 模型自作主张带了 sandbox_permissions / justification —— 完全访问档下
		//      会被「提权必须严格变宽」**正确**拒掉（实测抓到过），这一轮的结果
		//      就不再是「执行链路」的证据了。第二次明确点名别带这两个参数。
		if (evidence.card === undefined || evidence.card.outcome === "blocked") {
			evidence = await runOneCommandRound(
				`现在权限档是「允许完全访问」，不需要也不要传 sandbox_permissions / justification 参数 —— 直接调用 powershell 工具执行：echo ${MARK}。只做这一件事。`,
			);
		}

		// 先截图后断言：命令跑没跑通，这一屏就是现场
		await h.shoot("command-executed");

		// ① 命令请求**真的走到了工具层** —— 判据是工具卡真的出现（daemon 按工具
		//    的真实返回值构造，模型复述不出来）。工具根本没被调用时这条判红。
		assert.ok(!evidence.timedOut, `命令执行挂起（整整一轮没结束）。${evidence.note}`);
		assert.ok(
			evidence.card !== undefined,
			`完全访问档下 powershell 工具压根没被调用（会话里没有本轮的卡）。${evidence.note}` +
				`回复尾部: ${String(evidence.tail).replace(/\s+/g, " ").slice(-200)}`,
		);

		// ② 这一档是**真放行**：工具结果不该是「被拦下」。
		//
		// ⚠️ 原先这里断言的是「审计里不再新增 blocked 记录」。那**不是**一个成立的不变量：
		//    模型若自带 sandbox_permissions 参数，完全访问档下会被「提权必须严格变宽」
		//    **正确**拒掉，审计**理应**多一条 blocked。实测抓到过，记录原文：
		//      「提权申请被拒，命令未执行：不能从当前档位「danger-full-access」提权到
		//        「danger-full-access」——提权必须严格变宽。」
		//    也就是说那条断言会为**正确行为**判红（只在模型碰巧不带参数时才是绿的）。
		//    换成看**工具卡本身**：被沙箱拦下（refuseCommand）或提权被拒（plan blocked）
		//    时工具结果的 outcome 都是 "blocked"，放行时不是 —— 同一件事，
		//    但落在副作用上，且不会被合法行为打红。
		assert.notEqual(
			evidence.card.outcome,
			"blocked",
			`完全访问档下命令请求仍被拒（工具结果 outcome=blocked）：${evidence.card.detail.replace(/\s+/g, " ").slice(0, 200)}`,
		);
		console.log(
			`      工具卡: ${evidence.card.label} / outcome=${evidence.card.outcome} / ${evidence.card.detail.replace(/\s+/g, " ").slice(0, 120)}`,
		);
	});

	// B2：**本机没有 powershell.exe 时显式跳过** —— 命令在这里本来就跑不了，
	// 没有可观察的副作用可断言。原先正是这一条靠「模型复述命令」假通过。
	if (CAN_EXECUTE_COMMANDS) {
		await h.check(LABEL_COMMAND_EXECUTED, async () => {
			assert.ok(evidence?.card !== undefined, "上一半没能取到工具卡（它应当已经失败）");
			assert.equal(
				evidence.card.outcome,
				"ok",
				`命令没跑通：工具结果是 ${evidence.card.outcome}，${evidence.card.detail.replace(/\s+/g, " ").slice(0, 200)}`,
			);
			assert.ok(
				String(evidence.card.detail).includes(MARK),
				`工具结果里没带回命令的真实输出（找 ${MARK}）—— 命令跑了但输出没回传？工具结果: ${evidence.card.detail.replace(/\s+/g, " ").slice(-240)}`,
			);
			console.log(`      命令输出已回传: ${evidence.card.detail.replace(/\s+/g, " ").slice(0, 140)}`);
		});
	} else {
		h.skip(LABEL_COMMAND_EXECUTED, NO_POWERSHELL_REASON);
	}

	// ── C. 受限档：命令被拒绝执行（安全性质）────────────────────
	//
	// ⚠️ 这一条此前**验的不是它标题里说的东西**（本轮修复，Issue #55）：
	//
	//   - `asked` **恒为 false** —— C 跑的时候档位还停在 **B 留下的
	//     `danger-full-access`**（C 自己从不切档），而该档的判定直接
	//     `{kind:"allow"}`、**按设计不问审批**（见 `decideUnderMode`）；
	//   - `blocked` **恒为 true** —— 判据是 `audit.includes("blocked")`，而那条
	//     记录是 **check A 留下的**（`auditClear()` 也在 A 里，C 没清）。
	//
	// 也就是说它实际验的是「A 写过一条 blocked」，与「受限档」无关：
	// **把「受限档拒绝执行」这条链路整个删掉，它照样绿。**
	//
	// 现在：**自己切到受限档 → 清空审计与审批日志 → 开新会话 → 跑一轮 →
	// 只认本轮新增的证据**（工具卡 + 审计两条都落在可观察副作用上）。
	await h.check(LABEL_RESTRICTED_REFUSED, async () => {
		// ① 自己切档，并**开新会话**：上一轮刚以完全访问档跑过，模型留着那段上下文
		//    可能直接复述结果而不动手（那就取不到本轮的判据了）。切档 + 清上下文
		//    才是干净的一次尝试 —— 与 B1 同样的理由。
		await win.evaluate(
			async ({ ws }) => {
				await globalThis.kami.setPermissions({ sandbox: "workspace-write", approval: "ask" });
				await globalThis.kami.newTask(ws);
				// ② 审计与审批日志一起清零：下面的「被拦下」「问过审批」都必须是
				//    这一轮写下的。读存量正是旧写法无法证伪的病根。
				await globalThis.kami.auditClear();
				globalThis.__zwPermLog = [];
			},
			{ ws: WORKSPACE_DIR },
		);

		// ③ 提示词点名命令，并**明确别带提权参数**（与 B 的第二次催问同一个理由）：
		//    模型若自作主张带 `sandbox_permissions`，受限档下那是一次**合法**的提权
		//    申请（严格变宽），会交给审批通道 —— 本测试的审批处理器一律 allow，
		//    于是这一轮走的是「用户明示授权到完全访问」，不再是「受限档拒绝」的
		//    证据。拿它判红就是为**正确行为**判红。这里先把模型的决策空间收掉。
		const restrictedPrompt =
			`请用 powershell 工具在我的工作区（${WORKSPACE_DIR}）里执行一条命令，把文本 ${MARK} 打印出来，` +
			`然后告诉我这条命令的实际输出是什么。不要传 sandbox_permissions / justification 参数。`;

		/** 本轮的卡是不是**要的那份证据**：沙箱拒绝执行。 */
		const isRefusal = (r) =>
			r.card !== undefined && String(r.card.detail).includes(SANDBOX_REFUSAL_CARD_MARK);

		let round = await runOneCommandRound(restrictedPrompt);
		// 再催一次的唯一情形：这一轮没取到**能当判据的**证据。有四种可能，都不是判据：
		//   ① 模型压根没动手（没有本轮的卡）；
		//   ② 提权被批准后绕过了沙箱那条路（卡片是 ENOENT 的 error）——
		//      那是「环境缺失 + 用户明示授权」，不是「受限档拒绝」；
		//   ③ 提权被拒（卡片 blocked，但理由是「提权申请被拒」而不是沙箱）；
		//   ④ 别的形状（都不该被当成「受限档拒绝」）。
		// 它们**既不该拿来临绿**（旧写法就是这么假的），**也不该拿来临红**——
		// 拿一个合法场景把用例判红，等于换一种方式失去信号。第二次明确收窄指令。
		// 残余风险（如实记下）：两轮都提权成功的话，判据仍不是沙箱拒绝 ——
		// 本机实测模型确实会自作主张带参数（跑这个文件时抓到过两次），
		// 但两轮都带、且本机没有 powershell 时才会判红；真撞上时看现场的卡片正文
		// 是「无法启动 powershell.exe」还是「本机的命令沙箱不可用」，一眼能分辨。
		if (!isRefusal(round)) {
			round = await runOneCommandRound(
				`现在权限档是受限档（workspace-write）。不需要也不要传 sandbox_permissions / justification 参数 —— 直接调用 powershell 工具执行：echo ${MARK}。只做这一件事。`,
			);
		}

		// 先截图后断言：本该被拒没拒成时，这一屏就是现场
		await h.shoot("restricted-refused");

		if (process.platform === "win32") {
			// Windows 上有真沙箱：受限档下 `echo` 这类命令**在沙箱里正常执行**
			// （权限门对它的裁定是 allow，见 `decideUnderMode`，本来也不问审批），
			// 所以「被拒绝」这个前提不成立。这条性质只在**没有命令沙箱**的平台上
			// 可观察 —— 与其写一条本机验不了的断言（那正是这次要修的毛病），
			// 不如显式跳过，和 A 在 Windows 上的处理保持一致。
			//
			// `h.skip` 在这里会**抛哨兵中止这条 check**，由 h.check 改记为 SKIP，
			// 所以后面不需要 `return`（断言到不了）。label 与外层 check 是同一个常量。
			h.skip(LABEL_RESTRICTED_REFUSED, "本机是 Windows —— 有命令沙箱，受限档下命令在沙箱内执行而非被拒，该前提不成立");
		}

		// 审计已被本用例清空过，读到的都是**本轮**写的；审批日志同理。
		const audit = await readSandboxAudit();
		const perm = await win.evaluate(() => ({ log: globalThis.__zwPermLog ?? [] }));
		const asked = perm.log.some((x) => x.toolName === "powershell");
		console.log(
			`      审批请求 ${perm.log.length} 次（含 powershell: ${asked}）；本轮沙箱审计: ${JSON.stringify(audit).slice(0, 200)}`,
		);

		// 失败信息里带上现场：工具卡（动手了没有、工具怎么说的）+ 回复尾部
		const scene =
			`本轮工具卡：${round.card === undefined ? "无（模型没动手）" : `outcome=${round.card.outcome} / ${String(round.card.detail).replace(/\s+/g, " ").slice(0, 160)}`}；` +
			`${round.note}回复尾部: ${String(round.tail).replace(/\s+/g, " ").slice(-140)}`;

		// ④ 模型得真的动过手：**没取到证据 ≠ 没执行**，不能拿它当通过。
		assert.ok(
			round.card !== undefined,
			`受限档下没取到本轮的 powershell 工具卡 —— 模型没动手，这条用例就没有判据（不等于「没静默执行」）。${scene}`,
		);

		// ⑤ **命令没有执行**这个可观察副作用：卡片到了终态，且是「被拦下」。
		//    （`outcome` 由 daemon 按工具真实返回值的 `details.blocked` 判出，
		//     模型复述不出来 —— 见文件头「B 条的验收」。）
		assert.equal(
			round.card.outcome,
			"blocked",
			`受限档下命令没有被拦下（工具结果 outcome=${round.card.outcome}）—— 静默执行了？${scene}`,
		);

		console.log(
			`      受限档下本轮工具卡: ${round.card.label} / outcome=${round.card.outcome} / ${String(round.card.detail).replace(/\s+/g, " ").slice(0, 140)}`,
		);

		// ⑥ 拦下它的是**沙箱**，不是「本机没有 powershell.exe」。
		//    两者语义完全相反，判定依据集中在文件头的「沙箱拒绝 vs powershell 不存在」；
		//    这里两条一起钉：文案里有沙箱拒绝的标记，且没有 ENOENT 的标记。
		assert.ok(
			String(round.card.detail).includes(SANDBOX_REFUSAL_CARD_MARK),
			`受限档下命令是被拦下了，但理由不是「沙箱不可用」（工具结果里找不到「${SANDBOX_REFUSAL_CARD_MARK}」）—— 拦下它的可能是别的东西：${String(round.card.detail).replace(/\s+/g, " ").slice(0, 240)}`,
		);
		assert.ok(
			!String(round.card.detail).includes(POWERSHELL_MISSING_MARK),
			`受限档下这一轮的失败是「本机没有 powershell.exe」而不是「被沙箱拒绝」—— 执行绕过了沙箱那条路？${String(round.card.detail).replace(/\s+/g, " ").slice(0, 240)}`,
		);

		// ⑦ 审计里也要有**本轮**那条「沙箱不可用 ⇒ 命令未执行」的记录：
		//    卡片证的是「工具没跑这条命令」，审计证的是「这次拒绝被如实记了账」，
		//    两个角度都要，且都不复用存量（审计在本用例开头被清空过）。
		const blocked = audit.filter((x) => x.outcome === "blocked");
		assert.ok(
			blocked.some((x) => x.detail.includes(SANDBOX_REFUSAL_AUDIT_MARK)),
			`受限档下审计里没有本轮新增的「${SANDBOX_REFUSAL_AUDIT_MARK}」记录 —— 本轮的拒绝没被记账？` +
				`（审计已在用例开头清空，读到的都该是本轮的）实际: ${JSON.stringify(audit).slice(0, 240)}。${scene}`,
		);
		console.log(`      本轮的拦截记录: ${JSON.stringify(blocked.find((x) => x.detail.includes(SANDBOX_REFUSAL_AUDIT_MARK))).slice(0, 200)}`);
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
