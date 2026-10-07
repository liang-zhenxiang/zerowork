/**
 * 模型对比**编排**（`createCompareRunner`）的单元测试。
 *
 * 纯逻辑（列状态机 / 用量 / 耗时 / 列数校验）在 `compare-core.test.mjs`，这里不重复。
 * 这一份盯的是编排层那几条**只有并行才会错**的性质：
 *
 * 1. **一列失败不拖垮别列** —— 并行最经典的缺陷；这里用「一列抛错、一列正常」与
 *    「一列上游 500、一列正常」两条路径各钉一次；
 * 2. **abort 能同时收掉所有列**，含**还在排队等空位**的那些（没排上的列不建宿主）；
 * 3. **每列恰好一条终态** —— 「一列永远停在 running」在界面上是流式尾巴一直转、
 *    用户没有入口收掉它，属于不可接受形态；
 * 4. **异常路径也 dispose** —— 对比宿主不在 `bucketsById` 里，`pickEvictions` 不会
 *    回收它，漏一次就是常态泄漏；
 * 5. **并发闸真的在闸** —— 额度另立（不占 `SPAWN_BUDGET_PER_SESSION`），上限 4。
 *
 * ## 为什么可以不起真宿主
 *
 * 编排层真正用到宿主的地方只有四处：`prompt` / `abort` / `dispose` / `markCompareRun`。
 * 这四处之外的全部判断（闸、终态、事件分流、超时归因）都是编排自己的逻辑，
 * 而起一个真 `SessionHost` 要 `await import` 整个 pi SDK —— 那属于端到端用例该付的成本。
 * 所以 `deps.createHost` 是留给测试的注入口（真实现是 `SessionHost.create`），
 * 不为了可测性去改编排的行为。
 *
 * ## 反向验证（已真跑并还原，实际结果如下）
 *
 * 两次注入都只改 `src/main/daemon/compare.js`。单测直接 import 源码，
 * **不需要 `npm run build`** —— 「注入后必须重建」那条要求针对的是跑 `out/` 产物的 e2e。
 *
 * 1) **抹掉交付事件的列 tag**（`pushEvent` 里改成 `record.onEvent?.({ ...event, columnId: undefined })`
 *    —— 即「渲染层收不到 columnId」）⇒ **恰好 3 条变红**，全是按列分流这一类：
 *    「两列各收各的文本与用量，事件按列打 tag」（实测
 *    `expected [ undefined, undefined ] to deeply equal [ 'col-0', 'col-1' ]`）、
 *    「abort() 收掉在跑的列」（按 columnId 找终态，找到 0 条）、
 *    「取消也收掉还在排队等空位的列」（`expected [ undefined ] to deeply equal [ 'col-0' ]`）；
 *    `compare-core.test.mjs` 的 52 条一条不受影响。
 * 2) **去掉「排队中被取消的列也要收尾」那一支**（`if (!admitted)` 里不再 settle）⇒
 *    **恰好 1 条变红**：「取消也收掉还在排队等空位的列」，实测
 *    `expected [ 'cancelled', 'failed', 'failed' ] to deeply equal [ 'cancelled', 'cancelled', 'cancelled' ]`
 *    —— 末尾那条兜底把「漏发的终态」补成了 `failed`，正是它该做的事；其余 14 条全绿。
 *
 * 两次都是 `cp` 备份 → 注入 → 跑 → `cp` 还原 → `diff -q` 核对一致 → 重跑全绿。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { createCompareRunner } from "../../src/main/daemon/compare.js";

/** 一个真实存在的目录：编排层会 `mkdirSync(cwd)`（`getCwd` 由调用方给）。 */
const CWD = mkdtempSync(join(tmpdir(), "compare-runner-"));

/**
 * 造一个编排环境：假宿主工厂 + 事件收集 + 宿主生命周期台账。
 *
 * `scripts` 是「模型 key → 这一列的剧本」：
 *   - `ok`    正常答完（`text` / `usage` 可配）
 *   - `error` 上游报错：`assistant_done`（空的错误助手消息）→ `run_error`，**没有**
 *             `run_finished` —— 这是 `session-host.js:832-836` 的真实顺序
 *   - `throw` `prompt` 直接抛（宿主层崩了）
 *   - `hang`  一直挂着，直到被 `abort` 才收尾（模拟卡死的连接）
 */
function buildEnv({ scripts = {}, unusable = [], getTimeoutMs } = {}) {
	const events = [];
	const log = [];
	/**
	 * 宿主台账：`created`（建过几个宿主）、`alive`（同时活着几个，收尾时必须是 0）、
	 * `inPrompt` / `maxInPrompt`（**同时有几列在跑**——并发闸真正的观测量）。
	 */
	const state = { created: 0, alive: 0, maxAlive: 0, inPrompt: 0, maxInPrompt: 0 };

	const runner = createCompareRunner({
		getCatalog: async () => ({ isUsable: (key) => !unusable.includes(key) }),
		resources: { modes: [] },
		getThinkingLevel: () => undefined,
		getCwd: () => CWD,
		isTempCwd: () => true,
		...(getTimeoutMs === undefined ? {} : { getTimeoutMs }),
		reportError: (message) => log.push(`error ${message}`),
		createHost: async (options) => {
			state.created += 1;
			state.alive += 1;
			state.maxAlive = Math.max(state.maxAlive, state.alive);
			const script = scripts[options.modelKey] ?? { kind: "ok" };
			let aborted = false;
			let release;
			const host = {
				modelKey: options.modelKey,
				disposed: false,
				markCompareRun(key) {
					log.push(`mark ${key}`);
				},
				async prompt(text) {
					log.push(`prompt ${options.modelKey} ${text}`);
					state.inPrompt += 1;
					state.maxInPrompt = Math.max(state.maxInPrompt, state.inPrompt);
					try {
						// 让出一次事件循环：真宿主在这里是几毫秒到几十秒的 await，
						// 而编排的取消与超时都建立在这段等待能被打断之上。
						await Promise.resolve();
						if (script.kind === "throw") throw new Error(script.error ?? "宿主崩了");
						if (script.kind === "hang") {
							// 卡住之前先流一段（真宿主也这样：请求发出去了、正文来了一半才断）
							options.emit({ type: "assistant_text_delta", messageId: "m", delta: script.delta ?? "片段" });
							await new Promise((resolve) => { release = resolve; });
						}
						if (aborted) {
							// 被中断时 pi 的形态：部分正文的 assistant_done + run_finished cancelled。
							options.emit({
								type: "assistant_done",
								message: { id: "m", role: "assistant", text: script.partial ?? "半个回答", at: 0 },
							});
							options.emit({ type: "run_finished", runId: "r", outcome: "cancelled" });
							return;
						}
						if (script.kind === "error") {
							options.emit({
								type: "assistant_done",
								message: { id: "m", role: "assistant", text: "", at: 0 },
							});
							options.emit({ type: "run_error", runId: "r", message: script.error ?? "上游 500" });
							return;
						}
						options.emit({ type: "assistant_text_delta", messageId: "m", delta: script.delta ?? "片段" });
						options.emit({
							type: "assistant_done",
							message: {
								id: "m",
								role: "assistant",
								text: script.text ?? "答案",
								...(script.usage === undefined ? {} : { usage: script.usage }),
								at: 0,
							},
						});
						options.emit({ type: "run_finished", runId: "r", outcome: "completed" });
					} finally {
						state.inPrompt -= 1;
					}
				},
				async abort() {
					aborted = true;
					log.push(`abort ${options.modelKey}`);
					release?.();
				},
				dispose() {
					if (host.disposed) return;
					host.disposed = true;
					state.alive -= 1;
					log.push(`dispose ${options.modelKey}`);
				},
			};
			return host;
		},
	});
	return { runner, events, log, state };
}

/** 收事件的闭包（每个用例都传它）。 */
function collect(env) {
	return (event) => env.events.push(event);
}

/** 某一列的终态事件（`assistant_done` / `column_failed` / `column_cancelled`）。 */
const TERMINAL_KINDS = new Set(["assistant_done", "column_failed", "column_cancelled"]);

function terminalsOf(events, columnId) {
	return events.filter((e) => e.columnId === columnId && TERMINAL_KINDS.has(e.kind));
}

describe("createCompareRunner —— 两列并行", () => {
	it("两列各收各的文本与用量，事件按列打 tag", async () => {
		const env = buildEnv({
			scripts: {
				"a/one": { kind: "ok", text: "甲的回答", usage: { input: 10, output: 20 } },
				"b/two": { kind: "ok", text: "乙的回答", usage: { input: 30, output: 40 } },
			},
		});
		const done = await env.runner.run({
			models: ["a/one", "b/two"],
			prompt: "同一个问题",
			onEvent: collect(env),
		});

		expect(done.ok).toBe(true);
		expect(done.columns.map((c) => c.status)).toEqual(["done", "done"]);
		// 内容不串台：两列的正文是各自的，用量也是各自的
		expect(done.columns.map((c) => c.text)).toEqual(["甲的回答", "乙的回答"]);
		expect(done.columns.map((c) => c.usage)).toEqual([
			{ input: 10, output: 20 },
			{ input: 30, output: 40 },
		]);
		// 每一条事件都带 runId 与 columnId（渲染层就靠这两样分流）
		for (const event of env.events) {
			expect(event.runId).toBe(done.runId);
		}
		const deltas = env.events.filter((e) => e.kind === "text_delta");
		expect(deltas.map((e) => e.columnId).sort()).toEqual(["col-0", "col-1"]);
		// 每列恰好一条终态
		expect(terminalsOf(env.events, "col-0")).toHaveLength(1);
		expect(terminalsOf(env.events, "col-1")).toHaveLength(1);
		// 两列都发过 column_started（耗时的起点）
		expect(env.events.filter((e) => e.kind === "column_started")).toHaveLength(2);
		// 宿主全部释放
		expect(env.state.alive).toBe(0);
		expect(env.log.filter((line) => line.startsWith("dispose"))).toHaveLength(2);
	});

	it("整轮收尾只发一条 run_finished，且带每列的读数摘要", async () => {
		const env = buildEnv({
			scripts: {
				"a/one": { kind: "ok", text: "甲", usage: { output: 7 } },
				"b/two": { kind: "error", error: "上游返回 500" },
			},
		});
		const done = await env.runner.run({
			models: ["a/one", "b/two"],
			prompt: "问题",
			onEvent: collect(env),
		});

		const finished = env.events.filter((e) => e.kind === "run_finished");
		expect(finished).toHaveLength(1);
		expect(finished[0].columnId).toBeUndefined();
		expect(finished[0].outcome).toBe("completed");
		expect(finished[0].columns.map((c) => c.status)).toEqual(["done", "failed"]);
		expect(finished[0].columns[1].error).toBe("上游返回 500");
		// 摘要不带正文（正文渲染层自己有；带上是白占带宽）
		expect(finished[0].columns[0].text).toBeUndefined();
		expect(done.runId).toBe(finished[0].runId);
	});
});

describe("createCompareRunner —— 一列失败不影响其它列", () => {
	it("上游报错的那一列变 failed，另一列照常答完", async () => {
		const env = buildEnv({
			scripts: {
				"a/one": { kind: "error", error: "上游返回 500" },
				"b/two": { kind: "ok", text: "乙完整答完了" },
			},
		});
		const done = await env.runner.run({
			models: ["a/one", "b/two"],
			prompt: "问题",
			onEvent: collect(env),
		});

		expect(done.outcome).toBe("completed");
		expect(done.columns[0].status).toBe("failed");
		expect(done.columns[0].error).toBe("上游返回 500");
		expect(done.columns[1].status).toBe("done");
		expect(done.columns[1].text).toBe("乙完整答完了");
		// 失败列**不能**被记成 done（它先发了一条空的 assistant_done）
		expect(done.columns[0].text).toBe("");
	});

	it("宿主在 prompt 里直接抛，也只让那一列失败", async () => {
		const env = buildEnv({
			scripts: {
				"a/one": { kind: "throw", error: "连接被重置" },
				"b/two": { kind: "ok", text: "乙没事" },
			},
		});
		const done = await env.runner.run({
			models: ["a/one", "b/two"],
			prompt: "问题",
			onEvent: collect(env),
		});

		expect(done.columns[0].status).toBe("failed");
		expect(done.columns[0].error).toBe("连接被重置");
		expect(done.columns[1].status).toBe("done");
	});

	it("异常路径上每一列都 dispose 了宿主（含失败那一列）", async () => {
		const env = buildEnv({
			scripts: {
				"a/one": { kind: "throw" },
				"b/two": { kind: "error" },
				"c/three": { kind: "ok" },
			},
		});
		await env.runner.run({
			models: ["a/one", "b/two", "c/three"],
			prompt: "问题",
			onEvent: collect(env),
		});

		expect(env.state.created).toBe(3);
		expect(env.state.alive).toBe(0);
		expect(env.log.filter((line) => line.startsWith("dispose")).sort()).toEqual([
			"dispose a/one",
			"dispose b/two",
			"dispose c/three",
		]);
	});

	it("模型不可用：那一列失败且**根本不建宿主**", async () => {
		const env = buildEnv({
			unusable: ["b/two"],
			scripts: { "a/one": { kind: "ok" } },
		});
		const done = await env.runner.run({
			models: ["a/one", "b/two"],
			prompt: "问题",
			onEvent: collect(env),
		});

		expect(done.columns[1].status).toBe("failed");
		expect(done.columns[1].error).toContain("不可用");
		expect(done.columns[0].status).toBe("done");
		expect(env.state.created).toBe(1);
		expect(env.events.some((e) => e.columnId === "col-1" && e.kind === "column_started")).toBe(false);
	});
});

describe("createCompareRunner —— 超时", () => {
	it("超时的那一列记 failed（不是 cancelled），另一列不受影响", async () => {
		const env = buildEnv({
			scripts: { "a/one": { kind: "hang" }, "b/two": { kind: "ok", text: "乙答完了" } },
			getTimeoutMs: () => 30,
		});
		const done = await env.runner.run({
			models: ["a/one", "b/two"],
			prompt: "问题",
			onEvent: collect(env),
		});

		expect(done.columns[0].status).toBe("failed");
		expect(done.columns[0].error).toContain("超时");
		expect(done.columns[1].status).toBe("done");
		// 归因必须是「超时」而不是「已取消」：宿主那侧看到的同样是 outcome cancelled，
		// 编排放错判断顺序的话这一列会显示成「已取消」——用户去按取消只会更困惑。
		expect(env.events.some((e) => e.columnId === "col-0" && e.kind === "column_cancelled")).toBe(false);
		expect(env.state.alive).toBe(0);
	});
});

describe("createCompareRunner —— 取消", () => {
	it("abort() 收掉在跑的列，run 的 outcome 记 cancelled", async () => {
		const env = buildEnv({
			scripts: { "a/one": { kind: "hang" }, "b/two": { kind: "hang" } },
		});
		const started = env.runner.start({
			models: ["a/one", "b/two"],
			prompt: "问题",
			onEvent: collect(env),
		});
		expect(started.ok).toBe(true);
		// 等两列都真的开始跑（发过 column_started）再取消 —— 否则测的是「还没起就跑完了」
		await waitFor(() => env.events.filter((e) => e.kind === "column_started").length === 2);
		expect(env.runner.abort(started.runId)).toEqual({ ok: true });

		const done = await started.done;
		expect(done.outcome).toBe("cancelled");
		expect(done.columns.map((c) => c.status)).toEqual(["cancelled", "cancelled"]);
		// 取消保留**已流出的**正文（与既有语义一致：中断在消息流里留下痕迹），
// 但宿主在 abort 时补的那条 assistant_done（"半个回答"）不作数 ——
// 终态是 cancelled，不该被一条「答完了」的事件改写成 done。
		expect(done.columns[0].text).toBe("片段");
		expect(env.log.filter((line) => line.startsWith("abort")).length).toBe(2);
		expect(env.state.alive).toBe(0);
		for (const column of done.columns) {
			expect(terminalsOf(env.events, column.columnId)).toHaveLength(1);
			expect(terminalsOf(env.events, column.columnId)[0].kind).toBe("column_cancelled");
		}
	});

	it("取消也收掉还在排队等空位的列（它们不建宿主）", async () => {
		const env = buildEnv({
			scripts: {
				"a/1": { kind: "hang" },
				"a/2": { kind: "hang" },
				"a/3": { kind: "hang" },
				"b/1": { kind: "hang" },
				"b/2": { kind: "hang" },
				"b/3": { kind: "hang" },
			},
		});
		const first = env.runner.start({ models: ["a/1", "a/2", "a/3"], prompt: "问题一", onEvent: collect(env) });
		const second = env.runner.start({ models: ["b/1", "b/2", "b/3"], prompt: "问题二", onEvent: collect(env) });
		expect(first.ok && second.ok).toBe(true);

		// 额度 4：第二轮只有 1 列能跑，另 2 列排队。等那个空位真的被用上再取消。
		await waitFor(() => env.state.created === 4);
		expect(env.runner.abort(second.runId)).toEqual({ ok: true });

		const done = await second.done;
		expect(done.outcome).toBe("cancelled");
		expect(done.columns.map((c) => c.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
		// 排队的两列从未建过宿主，也从未发过 column_started。
		// （columnId 只在**一轮内**唯一，两份 run 都有 col-0/1/2 —— 判据必须连 runId 一起看。）
		expect(env.state.created).toBe(4);
		const startedOfRun2 = env.events
			.filter((e) => e.runId === second.runId && e.kind === "column_started")
			.map((e) => e.columnId);
		expect(startedOfRun2).toEqual(["col-0"]);
		// 第二轮放开之后，第一轮的空位被还了回去：它仍然跑得完
		expect(env.runner.abort(first.runId)).toEqual({ ok: true });
		expect((await first.done).outcome).toBe("cancelled");
		expect(env.state.alive).toBe(0);
	});

	it("abort 一个跑完/不存在的 runId 如实报错，不静默成功", async () => {
		const env = buildEnv({ scripts: { "a/one": { kind: "ok" }, "b/two": { kind: "ok" } } });
		const done = await env.runner.run({
			models: ["a/one", "b/two"],
			prompt: "问题",
			onEvent: collect(env),
		});
		const after = env.runner.abort(done.runId);
		expect(after.ok).toBe(false);
		expect(after.error).toContain(done.runId);
		expect(env.runner.abort("").ok).toBe(false);
	});

	it("start({ signal }) 上的 abort 与 abort(runId) 等价", async () => {
		const env = buildEnv({ scripts: { "a/one": { kind: "hang" }, "b/two": { kind: "hang" } } });
		const controller = new AbortController();
		const started = env.runner.start({
			models: ["a/one", "b/two"],
			prompt: "问题",
			signal: controller.signal,
			onEvent: collect(env),
		});
		await waitFor(() => env.events.filter((e) => e.kind === "column_started").length === 2);
		controller.abort();
		const done = await started.done;
		expect(done.outcome).toBe("cancelled");
		expect(env.state.alive).toBe(0);
	});
});

describe("createCompareRunner —— 并发闸", () => {
	it("额度 4：第 5 列起排队，同一时刻最多 4 列在跑", async () => {
		const hanging = ["a/1", "a/2", "a/3", "b/1", "b/2", "b/3", "c/1", "c/2", "c/3", "c/4"];
		const env = buildEnv({ scripts: Object.fromEntries(hanging.map((key) => [key, { kind: "hang" }])) });
		const first = env.runner.start({ models: ["a/1", "a/2", "a/3"], prompt: "一", onEvent: collect(env) });
		const second = env.runner.start({ models: ["b/1", "b/2", "b/3"], prompt: "二", onEvent: collect(env) });

		await waitFor(() => env.state.created === 4);
		// 到这一刻为止只有 4 个宿主被建出来（第 5、6 列还在等空位）
		expect(env.state.created).toBe(4);
		expect(env.state.maxInPrompt).toBe(4);
		expect(env.events.filter((e) => e.kind === "column_queued")).toHaveLength(6);
		expect(env.events.filter((e) => e.kind === "column_started")).toHaveLength(4);

		env.runner.abort(first.runId);
		env.runner.abort(second.runId);
		await Promise.all([first.done, second.done]);
		expect(env.state.alive).toBe(0);

		// 额度守恒：全部收尾之后没有残留的空位占用 —— 再开一轮，4 列必须**同时**在跑。
		// 用「挂着不答」的剧本判定：漏还一格的话这一轮只会跑起 3 列，峰值停在 3，
		// 于是下面那句等待超时并抛出实际的数字（不是一句「等条件成立超时」）。
		env.state.maxInPrompt = 0;
		const fresh = env.runner.start({
			models: ["c/1", "c/2", "c/3", "c/4"],
			prompt: "三",
			onEvent: () => {},
		});
		try {
			await waitFor(() => env.state.maxInPrompt === 4, { timeout: 500 });
		} catch {
			throw new Error(`额度没有全部还回来：同一时刻只有 ${env.state.maxInPrompt} 列在跑（应为 4）`);
		}
		env.runner.abort(fresh.runId);
		expect((await fresh.done).outcome).toBe("cancelled");
	});
});

describe("createCompareRunner —— 输入校验", () => {
	it("0 / 1 / 5 个模型都明确拒绝（回返回值，不抛）", async () => {
		const env = buildEnv();
		for (const models of [[], ["a/one"], ["a/1", "a/2", "a/3", "a/4", "a/5"]]) {
			const result = await env.runner.run({ models, prompt: "问题", onEvent: () => {} });
			expect(result.ok).toBe(false);
			expect(result.error).toContain("个");
		}
		expect(env.state.created).toBe(0);
	});

	it("重复模型 / 空问题 / 畸形 key 都拒绝，且不建宿主", async () => {
		const env = buildEnv();
		const duplicated = await env.runner.run({
			models: ["a/one", "a/one"],
			prompt: "问题",
			onEvent: () => {},
		});
		expect(duplicated.ok).toBe(false);
		expect(duplicated.error).toContain("两次");

		const empty = await env.runner.run({ models: ["a/one", "b/two"], prompt: "   ", onEvent: () => {} });
		expect(empty.ok).toBe(false);
		expect(empty.error).toContain("问题");

		const malformed = await env.runner.run({ models: ["a/one", "nope"], prompt: "问题", onEvent: () => {} });
		expect(malformed.ok).toBe(false);
		expect(malformed.error).toContain("nope");
		expect(env.state.created).toBe(0);
	});

	it("start() 同步回 runId（受理与执行分开的契约）", () => {
		const env = buildEnv({ scripts: { "a/one": { kind: "ok" }, "b/two": { kind: "ok" } } });
		const started = env.runner.start({ models: ["a/one", "b/two"], prompt: "问题", onEvent: () => {} });
		expect(typeof started.runId).toBe("string");
		expect(started.runId.startsWith("compare-")).toBe(true);
		// runId 是唯一且递增的（渲染层靠它把事件分派到正确的那一轮）
		const second = env.runner.start({ models: ["a/one", "b/two"], prompt: "问题", onEvent: () => {} });
		expect(second.runId).not.toBe(started.runId);
		env.runner.abortAll();
	});
});

/** 轮询等一个条件成立（不引睡等：条件本身就是信号）。 */
async function waitFor(predicate, { timeout = 2_000, interval = 5 } = {}) {
	const deadline = Date.now() + timeout;
	for (;;) {
		if (predicate()) return;
		if (Date.now() > deadline) throw new Error("等条件成立超时");
		await delay(interval);
	}
}