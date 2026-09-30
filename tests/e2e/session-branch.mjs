/**
 * 会话分支端到端测试：从历史里的某条消息分叉出一条新会话。
 *
 * 这是一条**零覆盖**的用户功能：此前只测过「传不存在的路径会被明确拒绝」
 * （见 bridge-rest.mjs），也就是只验了失败分支。真正会用到的那条路 ——
 * 有会话、有历史、从中间某个点分叉出去 —— 一行都没跑过。
 *
 * 断言：
 *   ① 分叉返回 `{ ok: true, branchPath, branchTitle }`，且 `branchPath` 是**另一个文件**；
 *   ② 新会话**真的落盘**（会话列表从 1 条变 2 条，且两条路径不同）；
 *   ③ 分叉后当前会话切到分支上（这是该功能的语义：接着从分叉点往下走）；
 *   ④ 母会话**没有被改坏**——仍在列表里、仍能读快照。
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
// 一个只会出现在这条会话里的词，用来证明「母会话确实有历史」。
//
// ⚠️ 提示词**不要说「记住」**（最初写的是「请记住这个词」）：记忆系统的提示词
// 把用户级记忆的路径写成了字面量 `~/.zerowork/MEMORY.md`，并让模型**直接对那个
// 固定路径用 edit 写**。于是模型会绕过本测试设置的 ZEROWORK_CONFIG_DIR，
// 把测试残留写进**用户真实家目录**里 —— 既污染用户状态，也让下一次运行读到
// 「我已经记住过了」而改变行为。用具名痕迹的复述任务即可，别沾记忆语义。
const MARK = "CEDAR3140";

const h = createHarness({ name: "branch" });
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
	"配置真实模型并切换工作区，建出一条有历史的会话",
	"分叉：返回 ok + branchPath，且是另一个文件",
	"分叉：新会话落盘，会话列表可见两条且路径不同",
	"分叉：当前会话已切到分支上（这是该功能的语义）",
	"分叉：母会话未被改坏（仍能复开并读出条目）",
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

	// ⚠️ 本文件全程用 `kami` API 驱动，**不经过界面输入框**：会话在后台建、在后台分叉，
	// 界面上的视图一直停在欢迎页。因此下面几张截图是「窗口还活着、没白屏」的证据
	// （侧栏的会话列表会跟着变），不是会话内容的现场 —— 要看到界面上的消息流，
	// 得走真实输入框（见 artifact-present.mjs 的写法）。
	await h.snap("home");

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

	// 分叉只做一次，结果给下面几条用例共用 —— 分开各做一次会让「已切到分支」那条
	// 在分叉失败时反而**假通过**（它读的是母会话的快照，条目当然读得出来）。
	let branchRes = undefined;
	let motherPath = undefined;

	await h.check("配置真实模型并切换工作区，建出一条有历史的会话", async () => {
		const r = await win.evaluate(
			async ({ baseUrl, token, model, ws, mark }) => {
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
				} catch (e) {
					return { ok: false, err: String(e?.message ?? e).slice(0, 200) };
				}

				// 发一条消息 → 会话落盘（这一步是后续分叉的前提）
				try {
					await Promise.race([
						k.prompt({ text: `请把这一串字符原样复述一遍，不要做其他操作：${mark}` }),
						new Promise((_, rej) => setTimeout(() => rej(new Error("__TIMEOUT__")), 150_000)),
					]);
				} catch (e) {
					if (String(e?.message ?? "").includes("__TIMEOUT__")) return { ok: false, timedOut: true };
				}
				return { ok: true };
			},
			{ ...endpoint, ws: WORKSPACE_DIR, mark: MARK },
		);
		assert.ok(r.ok, `建会话失败：${r.err ?? "超时"}`);

		// 等会话**真正落盘**再往下走。
		// ⚠️ 不能只看 listSessions 有没有条目：它会返回「桶里已有、文件还没写下去」
		// 的 pending 条目（见 daemon 里组装列表时的 pending 分支），拿那种路径去分叉
		// 会因 `!existsSync` 得到 `no-file` —— 起初就是这么假失败了一次。
		// 原实现是页内 `for 30 × sleep(1s)`，换成 waitUntil。
		let last = undefined;
		let note = "";
		let landed = null;
		try {
			landed = await waitUntil(
				async () => {
					last = await win.evaluate(async () => {
						const list = await globalThis.kami.listSessions();
						const arr = Array.isArray(list) ? list : (list?.sessions ?? []);
						const real = arr.filter((s) => s?.isTempTask !== true && typeof s?.path === "string");
						// 优先取标了 current 的那条（它就是本条会话），再确认文件确实在磁盘上
						const pick = real.find((s) => s.current === true) ?? real[0];
						if (pick === undefined) return { found: false, count: real.length };
						const st = await globalThis.kami.statPath(pick.path).catch(() => undefined);
						return { found: st?.kind === "file", count: real.length, path: pick.path, kind: st?.kind };
					});
					return last.found ? last : null;
				},
				{
					timeout: 30_000,
					interval: 1000,
					desc: "会话文件落到磁盘（列表里的 pending 条目路径还不能用来分叉 —— 文件还没写下去）",
				},
			);
		} catch (error) {
			note = `${error.message}；最后一次探测：${JSON.stringify(last)}`;
		}

		// 先截图后断言：这一屏（带历史的会话）就是现场
		await h.shoot("session-with-history");

		assert.ok(landed !== null, `发消息后会话文件一直没落到磁盘。${note}`);
		motherPath = landed.path;
		assert.ok(motherPath, "会话路径为空");
		console.log(`      母会话: ${String(motherPath).split("/").pop()}（列表 ${landed.count} 条）`);
	});

	await h.check("分叉：返回 ok + branchPath，且是另一个文件", async () => {
		// ⚠️ 先等这一轮**真的结束**（running 变 false）再分叉。
		// 提示词 resolve 只说明「消息发出去了」，daemon 侧的桶可能还标着运行中，
		// 此时分叉会得到 `busy`（「正在生成，稍后再试」）—— 起初就是这么假失败了一次。
		// 原实现是页内 `for 60 × sleep(1s)`，换成 waitUntil。
		let probe = undefined;
		let mother = null;
		let note = "";
		try {
			mother = await waitUntil(
				async () => {
					probe = await win.evaluate(async () => {
						const list = await globalThis.kami.listSessions();
						const arr = Array.isArray(list) ? list : (list?.sessions ?? []);
						const real = arr.filter((s) => s?.isTempTask !== true && typeof s?.path === "string");
						const pick = real.find((s) => s.current === true) ?? real[0];
						return { found: pick !== undefined, path: pick?.path, running: pick?.running };
					});
					return probe.found && probe.running === false ? probe : null;
				},
				{
					timeout: 60_000,
					interval: 1000,
					desc: "母会话停止运行，可以分叉了（桶里还标着运行中时分叉会得到 busy）",
				},
			);
		} catch (error) {
			// 把原来那两条分支诊断原样保留下来
			const why = probe === undefined || !probe.found ? "找不到母会话" : "母会话一直在运行，等不到可分支的时刻";
			note = `${why}（${error.message}）`;
		}
		assert.ok(mother !== null, note);

		// 从第 1 条用户消息分叉，并把那一轮带上（includeTurn）—— 不带上会得到空会话，
		// 断言就退化成「生成了一个空文件」，验不出内容有没有正确截断
		const res = await win.evaluate(
			async (path) => await globalThis.kami.branchSessionFrom(path, 0, { includeTurn: true }),
			mother.path,
		);

		branchRes = res;
		motherPath = mother.path;

		// 先截图后断言：分叉完界面上的那一屏就是现场
		await h.shoot("branched-session");

		assert.equal(branchRes?.ok, true, `分叉失败：${branchRes?.message ?? JSON.stringify(branchRes).slice(0, 200)}`);
		assert.ok(typeof branchRes.branchPath === "string" && branchRes.branchPath !== "", "没返回 branchPath");
		assert.notEqual(branchRes.branchPath, motherPath, "分支路径与母会话相同 —— 没真的分叉");
		console.log(`      母会话: ${String(motherPath).split("/").pop()}`);
		console.log(`      分支:   ${String(branchRes.branchPath).split("/").pop()}  标题: ${branchRes.branchTitle ?? "（无）"}`);
	});

	await h.check("分叉：新会话落盘，会话列表可见两条且路径不同", async () => {
		assert.ok(branchRes?.ok, "上一步分叉没成功，本步无从验证");
		const r = await win.evaluate(async () => {
			const list = await globalThis.kami.listSessions();
			const arr = Array.isArray(list) ? list : (list?.sessions ?? []);
			return arr.filter((s) => s?.isTempTask !== true && typeof s?.path === "string").map((s) => s.path);
		});
		assert.ok(r.length >= 2, `分叉后会话数应 ≥2，实际 ${r.length}`);
		assert.equal(new Set(r).size, r.length, "会话列表里出现了重复路径");
		assert.ok(r.includes(branchRes.branchPath), "会话列表里找不到刚分叉出来的那个文件");
	});

	await h.check("分叉：当前会话已切到分支上（这是该功能的语义）", async () => {
		assert.ok(branchRes?.ok, "上一步分叉没成功，本步无从验证");
		const r = await win.evaluate(async () => {
			const list = await globalThis.kami.listSessions();
			const arr = Array.isArray(list) ? list : (list?.sessions ?? []);
			const cur = arr.find((s) => s.current === true);
			const entries = (await globalThis.kami.snapshot())?.entries ?? [];
			return { currentPath: cur?.path, userTurns: entries.filter((e) => e?.role === "user").length };
		});
		assert.equal(r.currentPath, branchRes.branchPath, `当前会话没切到分支上（当前是 ${String(r.currentPath).split("/").pop()}）`);
		// 分支带上了那一轮，所以它应该读得出这条用户消息
		assert.ok(r.userTurns >= 1, `分支应带上那一轮用户消息，实际 userTurns=${r.userTurns}`);
	});

	await h.check("分叉：母会话未被改坏（仍能复开并读出条目）", async () => {
		assert.ok(branchRes?.ok, "上一步分叉没成功，本步无从验证");
		const r = await win.evaluate(async (mother) => {
			try {
				await globalThis.kami.resumeSession(mother);
				const entries = (await globalThis.kami.snapshot())?.entries ?? [];
				return { ok: true, entries: entries.length };
			} catch (e) {
				return { ok: false, err: String(e?.message ?? e).slice(0, 160) };
			}
		}, motherPath);

		// 先截图后断言：母会话复开后的那一屏就是现场
		await h.shoot("mother-session-reopened");

		assert.ok(r.ok, `母会话无法复开：${r.err}`);
		assert.ok(r.entries > 0, "母会话复开后读不出条目 —— 被改坏了？");
		console.log(`      母会话复开后条目数 ${r.entries}`);
	});

	await h.check("无渲染层未捕获异常", () => assert.equal(h.pageErrors.length, 0, h.pageErrors.join("; ")));
}

// ── 分派：端点可用就跑正戏，不可用就逐条上报跳过 ────────────────
//
// 原来这里是不论如何都 `process.exit(0)`：报告里一片全绿、实际一条断言都没跑，
// 于是本文件在 CI 上是**零信号**。跳过与通过必须能被区分开。
const { endpoint, reason } = await probeEndpoint();
if (endpoint === undefined) {
	console.warn(`⚠ 模型端点不可用 —— 建会话需要模型：${reason}`);
	skipAll(reason);
} else {
	console.log(`✓ 模型端点可用：${endpoint.baseUrl}，模型 ${endpoint.model}`);
	await runWithModel(endpoint);
}

await h.finish();
