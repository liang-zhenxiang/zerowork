/**
 * 模型对比（「一问多答」）：同一个问题并行问 2–4 个模型，一屏并排看它们怎么答。
 *
 * ## 本文件为什么分两半
 *
 * **① 纯逻辑**（本文件现在的内容）：列参数校验、列状态归约、用量提取、耗时口径。
 * 它不 import 任何宿主 / Electron / 文件系统相关模块，因此能被 vitest 直接 import
 * —— 而这些判断在界面上只表现为「数字不对」「两列串台」，恰是 GUI 断言最难说清、
 * 单测最容易钉死的一类。抽法与理由同 `library.js`（见该文件头部）。
 *
 * **② 编排**（`createCompareRunner`，见 `implement.md` 阶段 2）：起 N 个
 * `SessionHost` 并行发问、事件按列打 `columnId`、超时与 abort、`finally` 里 dispose。
 * 骨架照 `command-exec.js` 的 `createSubagentRunner`（并发闸 + 队列 + 每列一个宿主
 * + 从 `assistant_done` 收文本）。届时纯逻辑原样复用，只是多一个真起宿主的调用方。
 *
 * ## 两条硬约定（编排层与渲染层的共同契约）
 *
 * 1. **列与列之间不共享任何可变状态。** 每个事件都带 `columnId`，归约只认自己那一列：
 *    `event.columnId !== state.columnId` ⇒ 原样返回**同一引用**。
 *    「A 列的事件进了 B 列」是并行功能最经典的一类缺陷（界面上是「一列显示了另一列
 *    的内容」，甚至只是「两列数字一样」），而它在这里就是一句判据。
 * 2. **不适应的事件一律原样返回同一引用**：终态之后迟到的 delta、未知 kind、
 *    畸形事件、顺序错了的事件，既不改状态也不记标记。理由：终态是终态 ——
 *    一条迟到的 delta 不能把一列「复活」；返回同一引用还能让上层用 `Object.is`
 *    做快速路径。诊断靠编排层的事件流，不靠往 UI 状态里塞计数。
 *
 * ## 耗时口径
 *
 * **从该列自己开始跑那一刻起算**（`startedAt` = 它自己的 `column_started`），
 * 不是整轮对比的开始时刻 —— 排队等待的时间不算这一列的耗时，A、B 两列的耗时
 * 本来就不该相等。计时与状态机是两个函数（`accumulateTiming` / `reduceColumn`），
 * 作用字段不重叠，因此两者以任意顺序应用结果相同。
 */

import { parseModelKey } from "./auth.js";

/** 下限 2：只有一个模型就不叫「对比」了（那是普通对话）。 */
const COMPARE_MIN_COLUMNS = 2;
/** 上限 4：并发上限就是它（不占 `SPAWN_BUDGET_PER_SESSION`，见 design.md 事实 5）。 */
const COMPARE_MAX_COLUMNS = 4;

/** 会让一列收尾的事件种类（整体信号 `run_finished` 不在其中）。 */
const SETTLING_KINDS = new Set(["assistant_done", "column_failed", "column_cancelled"]);

/**
 * `extractUsage` 认的字段（对齐 `session-view.js` 的 `toTokenUsage` 产出，
 * 也就是 `assistant_done.message.usage` 的实际形状）。只取能直接展示的标量；
 * `costBreakdown` 那层嵌套留给诊断页，对比列头不显示它。
 */
const USAGE_FIELDS = [
  "input",
  "output",
  "cacheRead",
  "cacheWrite",
  "totalTokens",
  "cost",
  "reasoning",
  "cacheWrite1h",
];

/**
 * 校验并规整「参与对比的模型列表」。这是**用户输入**的入口，所以宁可明确拒绝
 * 也不静默降级：
 *
 * - 少于 2 个 / 多于 4 个都**拒绝并说明原因与数量** —— 静默截断到 4 个会让
 *   用户以为「我选的都跑上了」；
 * - 不符合「服务商/模型」形状的 key 拒绝。判据直接复用 `auth.js` 的
 *   `parseModelKey`（**唯一的口径来源**，不在这里另写一套切分规则；
 *   它在第一个 `/` 处切、两侧都必须非空，所以模型 id 里带 `/` 是合法的）；
 * - **重复的模型拒绝，而不是去重**：界面上用户是从列表里多选，重复只可能来自
 *   程序化的调用；静默去重会让「选了 2 个」变成「屏幕上 1 列」，而用户不知道
 *   少的那一列去哪了 —— 那正是「静默丢东西」，本仓库对此有明确纪律。
 *
 * @param {unknown} models
 * @returns {{ ok: true, models: string[] } | { ok: false, error: string }}
 */
function normalizeColumns(models) {
  if (!Array.isArray(models)) return reject("对比需要一个模型列表（收到的不是数组）");
  if (models.length < COMPARE_MIN_COLUMNS) {
    return reject(`至少选 ${COMPARE_MIN_COLUMNS} 个模型才能对比（当前 ${models.length} 个）`);
  }
  if (models.length > COMPARE_MAX_COLUMNS) {
    return reject(`一次最多对比 ${COMPARE_MAX_COLUMNS} 个模型（当前 ${models.length} 个），请先去掉几个再试`);
  }
  const keys = [];
  for (const raw of models) {
    if (typeof raw !== "string") return reject("模型 key 必须是字符串");
    // 用户从别处粘进来的 key 常带空白；两侧统一 trim，避免「看着一样却对不上」。
    const key = raw.trim();
    if (key === "") return reject("模型 key 不能为空");
    if (parseModelKey(key) === undefined) return reject(`模型 key 不是「服务商/模型」的形式：${key}`);
    if (keys.includes(key)) return reject(`同一个模型被选了两次：${key}`);
    keys.push(key);
  }
  return { ok: true, models: keys };
}

function reject(error) {
  return { ok: false, error };
}

/**
 * 由（已规整的）模型列表造出各列的初始状态。
 *
 * `columnId` 只在**一次 run 内**有意义（事件信封里另有 `runId`），所以用序号即可：
 * 它是确定性的 —— 单测能直接断言，渲染层也能靠它把事件分派到对应的列。
 * `modelKey` 让渲染层不必回查快照就知道这一列是谁。
 *
 * 入参不是数组时给空列表而不是抛错：调用方是编排层，输入已经过
 * `normalizeColumns`；把一个不可能发生的内部错误变成一次 run 的崩溃没有收益。
 *
 * @param {unknown} models 已规整的模型 key 列表（来自 `normalizeColumns`）
 */
function createColumnStates(models) {
  if (!Array.isArray(models)) return [];
  return models.map((modelKey, index) => ({
    columnId: `col-${index}`,
    modelKey,
    status: "queued",
    text: "",
    thinking: "",
    // 还没跑：用量、错误、耗时一律缺席，而不是编一个 0 出来。
    usage: undefined,
    error: undefined,
    startedAt: undefined,
    endedAt: undefined,
    elapsedMs: undefined,
  }));
}

/**
 * 列状态归约：`queued → running → (done | failed | cancelled)`，另有
 * `queued → (failed | cancelled)`（还没轮到就失败 / 被整体取消）。
 *
 * 只吃**带匹配 `columnId`** 的列级事件；`run_finished` 是整体信号（不带 columnId），
 * 由编排层与渲染层各自处理，不进这里。
 *
 * 每列的终态事件由编排层保证（`done` / `failed` / `cancelled` 三选一），
 * 所以「一列永远停在 running」不该发生；真发生了，界面上的流式尾巴会一直转，
 * 那是编排层的缺陷，不该靠归约层猜。
 *
 * @param {object} state 该列的当前状态
 * @param {object} event `{ columnId, kind, ... }`
 * @returns {object} 新状态；不适应的事件返回**同一个对象引用**
 */
function reduceColumn(state, event) {
  if (state === undefined || state === null || event === undefined || event === null) return state;
  // 列间隔离的根：不是自己那一列的事件，一个字都不许改。
  if (event.columnId !== state.columnId) return state;
  switch (event.kind) {
    case "column_queued":
      // `createColumnStates` 已经置为 queued，这里只是把列「登记」出来
      // （顺带采纳 modelKey，渲染层靠它认列）。
      return adoptModelKey(state, event);
    case "column_started":
      if (state.status !== "queued") return state;
      return adoptModelKey({ ...state, status: "running" }, event);
    case "text_delta":
      return appendDelta(state, "text", event);
    case "thinking_delta":
      return appendDelta(state, "thinking", event);
    case "assistant_done":
      return settleDone(state, event);
    case "column_failed":
      if (state.status !== "queued" && state.status !== "running") return state;
      return { ...state, status: "failed", error: failureText(event) };
    case "column_cancelled":
      if (state.status !== "queued" && state.status !== "running") return state;
      return { ...state, status: "cancelled" };
    default:
      return state;
  }
}

/** 采纳事件里带的 `modelKey`（没有、或与现状相同就不动）。 */
function adoptModelKey(state, event) {
  const modelKey = event.modelKey;
  if (typeof modelKey !== "string" || modelKey === "" || modelKey === state.modelKey) return state;
  return { ...state, modelKey };
}

/**
 * 追加流式片段。
 *
 * 只接受 `running` 列的片段：事件顺序由编排层保证（`column_started` 先于第一条
 * delta），顺序错了就丢弃 —— 静默接受会把一个顺序错误变成界面上看不见的错位文本。
 */
function appendDelta(state, field, event) {
  if (state.status !== "running") return state;
  const delta = event.delta;
  if (typeof delta !== "string" || delta === "") return state;
  return { ...state, [field]: state[field] + delta };
}

/**
 * `assistant_done`：整段文本是权威值，**覆盖**流式累积的结果
 * （流式期间可能有修正、也可能漏帧）；`thinking` 只在事件带了非空值时才替换。
 */
function settleDone(state, event) {
  if (state.status !== "running") return state;
  const message = event.message;
  if (typeof message !== "object" || message === null) return state;
  const text = typeof message.text === "string" ? message.text : state.text;
  const thinking =
    typeof message.thinking === "string" && message.thinking !== "" ? message.thinking : state.thinking;
  return { ...state, status: "done", text, thinking, usage: extractUsage(event) };
}

/**
 * 失败原因必须是可读的一句话（错误要可诊断）：编排层给字符串（跨 IPC 传递的
 * 形态），本地路径可能给 `Error`；两者都拿不到时给一句说明**为什么没有原因**，
 * 而不是「操作失败」四个字。
 */
function failureText(event) {
  const error = event.error;
  if (typeof error === "string" && error.trim() !== "") return error.trim();
  if (error instanceof Error && error.message !== "") return error.message;
  return "该列运行失败，但没有给出原因";
}

/**
 * 从 `assistant_done` 事件里取出可展示的用量。
 *
 * 形状先去 `session-host.js` 核实过：`assistant_done.message.usage` 是
 * `toTokenUsage(message.usage)`（`session-view.js`）的产出 —— 标量字段
 * `input` / `output` / `cacheRead` / `cacheWrite` / `totalTokens` / `cost`
 * （外加可选的 `reasoning` / `cacheWrite1h`）与嵌套的 `costBreakdown`。
 *
 * **缺失或畸形时如实返回 `undefined`，不编一个 0**：0 是有含义的数（真的没花钱），
 * 与「没拿到」是两回事；编 0 会让「用量没回来」在界面上看不出来。
 * 单个字段畸形就剔除那一个，其余照收 —— 部分可用比整块丢弃有用。
 *
 * @param {object} assistantDoneEvent `{ message: { usage? } }`
 * @returns {object | undefined}
 */
function extractUsage(assistantDoneEvent) {
  if (assistantDoneEvent === undefined || assistantDoneEvent === null) return undefined;
  const message = assistantDoneEvent.message;
  if (typeof message !== "object" || message === null) return undefined;
  const usage = message.usage;
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return undefined;
  const picked = {};
  for (const field of USAGE_FIELDS) {
    const value = usage[field];
    if (typeof value === "number" && Number.isFinite(value)) picked[field] = value;
  }
  return Object.keys(picked).length === 0 ? undefined : picked;
}

/**
 * 计时：`column_started` 记这一列**自己**的起点，终态记终点与耗时。
 *
 * 三处刻意的行为：
 *
 * - **起点只认自己的 `column_started`**（不是整轮的开始）。排队等待不算这一列的耗时，
 *   否则「先跑的那列」与「排队 3 秒才轮到的列」会显示出同一个数字 —— 而对比耗时
 *   正是这个功能的卖点之一。
 * - **还没轮到就被取消 → 不记耗时**：`startedAt` 缺席时连 `endedAt` 也不写。
 *   那标的是「排队中被取消」，没有「跑了多久」可言；界面按「已取消」呈现即可。
 * - **`now` 不是有限数就什么都不记**，时钟回拨则耗时取 0：绝不把 `NaN` 或负数
 *   写进耗时（那会让列头显示「NaN 秒」）。
 *
 * @param {object} state 该列的当前状态
 * @param {object} event `{ columnId, kind }`
 * @param {number} now 这一列记时的当前时刻（毫秒）
 * @returns {object} 新状态；不适用时返回**同一个对象引用**
 */
function accumulateTiming(state, event, now) {
  if (state === undefined || state === null || event === undefined || event === null) return state;
  if (event.columnId !== state.columnId) return state;
  if (typeof now !== "number" || !Number.isFinite(now)) return state;
  if (event.kind === "column_started") {
    if (state.startedAt !== undefined) return state;
    return { ...state, startedAt: now };
  }
  if (!SETTLING_KINDS.has(event.kind)) return state;
  if (state.endedAt !== undefined) return state;
  if (state.startedAt === undefined) return state;
  const elapsed = now - state.startedAt;
  return { ...state, endedAt: now, elapsedMs: elapsed >= 0 ? elapsed : 0 };
}

export {
  COMPARE_MAX_COLUMNS,
  COMPARE_MIN_COLUMNS,
  accumulateTiming,
  createColumnStates,
  extractUsage,
  normalizeColumns,
  reduceColumn,
};