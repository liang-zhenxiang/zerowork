/**
 * 模型对比（「一问多答」）：同一个问题并行问 2–4 个模型，一屏并排看它们怎么答。
 *
 * ## 本文件为什么分两半
 *
 * **① 纯逻辑**（本文件现在的内容）：列参数校验、列状态归约、用量提取、耗时口径，
 * 以及「留为会话」的文件手术 / 标题 / 登记表（①b 节）。
 * 它不 import 任何宿主 / Electron / 文件系统相关模块，因此能被 vitest 直接 import
 * —— 而这些判断在界面上只表现为「数字不对」「两列串台」，恰是 GUI 断言最难说清、
 * 单测最容易钉死的一类。抽法与理由同 `library.js`（见该文件头部）。
 *
 * **② 编排**（`createCompareRunner`，见下文）：起 N 个 `SessionHost` 并行发问、
 * 事件按列打 `columnId`、超时与 abort、`finally` 里 dispose。骨架照
 * `command-exec.js` 的 `createSubagentRunner`（并发闸 + 队列 + 每列一个宿主
 * + 从 `assistant_done` 收文本）。它**复用**上面的纯逻辑：每发出一条列事件，
 * 编排层自己也用 `reduceColumn` / `accumulateTiming` 推进一份状态 ——
 * 于是 `run()` 的返回值与渲染层算出来的东西**同源同口径**。
 *
 * ## 一条绝不能破的边界：事件不走 `emitSessionEvent`
 *
 * 每列自带 `emit` 闭包，事件打上列 id 后由调用方经 `PUSH.compareEvent` 送走。
 * 一旦接进 `PUSH.sessionEvent`，三条硬后果立刻成立（`design.md` §二 有逐条
 * `file:line`）：用量单槽串台、`evictIdleHosts` 会 dispose 掉**别的桶**的宿主、
 * 渲染层不重渲染（那一句在界面上表现为「跑完了、屏幕上一动不动」）。
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

import { mkdirSync } from "node:fs";
import { parseModelKey } from "./auth.js";
import { SessionHost } from "./session-host.js";
import { SESSION_TITLE_MAX } from "./session-state.js";

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

/* ══════════════════════════════════════════════════════════════════════════
 * ①b 「留为会话」（INVOKE.compareKeep）的纯逻辑与登记表
 *
 * 对比屏的产品承诺是「不进侧栏、不进历史、不计入统计」，但用户会想把这轮
 * 问答收下来继续聊 —— 「留为会话」就是那个显式出口：把某一列分叉成一条**普通
 * 会话**。分叉与 IPC 的编排在 session-files.js（keepCompareColumn），本节放它
 * 依赖的三块**可单测**的东西：文件手术（纯函数）、标题（纯函数）、登记表。
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 对比列的溯源标记（`SessionHost.markCompareRun` 写进会话文件的那个 custom 类型）。
 * 手术要剔除的正是它；字面量与 session-host.js / session-files.js 的
 * `COMPARE_CUSTOM_TYPE` 是同一个，三处一起改。
 */
const COMPARE_RUN_CUSTOM_TYPE = "compare_run";

/**
 * 「留为会话」的文件手术（**纯函数**：jsonl 文本行进、文本行出，不碰 fs）。
 *
 * 对一个从对比列分叉出来的会话文件做三件事，缺一不可：
 *
 * 1. **剔除 `compare_run` 条目**。pi 的分叉会连 custom 条目整链复制，而列表的
 *    头部扫描（`readSessionHeadMarkers`）遇第一条 message 就停 —— 在文件末尾补
 *    任何「已保留」标记都无效，必须从头部删掉条目本身，否则新会话被列表与统计
 *    **双重过滤**，用户点完「留为会话」什么也看不到；
 * 2. **重接 parentId**。标记是第一条 user 消息的父节点（`appendCustomEntry` 挂在
 *    当时的 leaf 下并推进 leaf），只删行不重接会把 user 变孤儿 —— `getBranch`
 *    走不到根，resume 时整条对话**静默丢失**。重接目标是沿 parentId 向上、跳过
 *    所有被剔除的标记之后的**第一个存活祖先**（没有则为 null）；
 * 3. **改写 header.cwd**。compare 目录不是合法工作空间：留在 header 里会让侧栏
 *    凭空多出名为 `compare` 的空间组、resume 后接管默认工作空间（任务 prereq
 *    事实 2）。header 缺 cwd 字段时补上。
 *
 * 幂等：没有标记且 header.cwd 已等于目标值时返回**同一个数组引用**（调用方可
 * 据此跳过一次写盘）；坏行 / 空行原样保留在原位（pi 逐行解析，跳过它们）。
 * 其他 custom 条目（session_info / artifacts_presented 等）一律不动。
 *
 * @param {string[]} lines 会话文件的 jsonl 文本行（不含末尾空行）
 * @param {string} cwd 新会话的 cwd（用户当前工作空间）
 * @returns {string[]} 手术后的行；无需改动时返回同一引用
 */
function rewriteKeptSessionLines(lines, cwd) {
  if (!Array.isArray(lines)) return lines;
  const parsed = new Array(lines.length);
  /** compare_run 条目 id → 它自己的 parentId（null = 原本就是根）。 */
  const markerParents = new Map();
  let headerIndex = -1;
  let headerCwdMatches = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      entry = undefined;
    }
    if (entry === null || typeof entry !== "object") {
      parsed[index] = undefined;
      continue;
    }
    parsed[index] = entry;
    if (entry.type === "session" && headerIndex === -1) {
      headerIndex = index;
      headerCwdMatches = entry.cwd === cwd;
      continue;
    }
    if (entry.type === "custom" && entry.customType === COMPARE_RUN_CUSTOM_TYPE && typeof entry.id === "string") {
      markerParents.set(entry.id, typeof entry.parentId === "string" ? entry.parentId : null);
    }
  }
  if (markerParents.size === 0 && (headerIndex === -1 || headerCwdMatches)) return lines;
  /** 沿 parentId 向上找第一个**没被剔除**的祖先（一路都是标记则到 null）。 */
  const survivingAncestor = (parentId) => {
    let current = parentId;
    while (current !== null && markerParents.has(current)) {
      current = markerParents.get(current) ?? null;
    }
    return current;
  };
  const out = [];
  for (let index = 0; index < lines.length; index++) {
    const entry = parsed[index];
    if (entry === undefined) {
      out.push(lines[index]);
      continue;
    }
    if (
      entry.type === "custom" &&
      entry.customType === COMPARE_RUN_CUSTOM_TYPE &&
      typeof entry.id === "string" &&
      markerParents.has(entry.id)
    ) {
      // 剔除标记行本身。
      continue;
    }
    if (index === headerIndex && !headerCwdMatches) {
      out.push(JSON.stringify({ ...entry, cwd }));
      continue;
    }
    if (typeof entry.parentId === "string" && markerParents.has(entry.parentId)) {
      out.push(JSON.stringify({ ...entry, parentId: survivingAncestor(entry.parentId) }));
      continue;
    }
    out.push(lines[index]);
  }
  return out;
}

/** 模型展示名缺失时的兜底（与渲染层 describeModel 的回落同源：key 的 id 段）。 */
function keptModelLabel(modelKey, modelName) {
  if (typeof modelName === "string" && modelName.trim() !== "") return modelName.trim();
  if (typeof modelKey !== "string" || modelKey === "") return "未知模型";
  const slash = modelKey.indexOf("/");
  return slash === -1 ? modelKey : modelKey.slice(slash + 1);
}

/**
 * 留下会话的标题：`{模型展示名} · {问题前 N 字}`（N ≤ `SESSION_TITLE_MAX`）。
 *
 * 为什么不用 `branchTitleFor`：母会话（对比列）不在 `listSessions` 里，
 * `buildBranchTitle` 会产出《（空会话） · 分支》。模型名是这一功能里**唯一的
 * 区分维度** —— 多列都留下时，纯问题文本分不出谁是谁。
 *
 * @param {string} modelKey 该列的模型 key（`服务商/模型`）
 * @param {string | undefined} modelName 目录解析出的展示名（解析失败给 undefined）
 * @param {string} prompt 本轮对比的问题（start 时已 trim）
 * @returns {string} 标题（问题为空时只有模型名）
 */
function keptSessionTitle(modelKey, modelName, prompt) {
  const name = keptModelLabel(modelKey, modelName);
  const question = typeof prompt === "string" ? prompt.replace(/\s+/g, " ").trim() : "";
  if (question === "") return name;
  const summary =
    question.length > SESSION_TITLE_MAX ? `${question.slice(0, SESSION_TITLE_MAX)}…` : question;
  return `${name} · ${summary}`;
}

/**
 * 登记表上限：64 条 ≈ 最近 16 轮对比（每轮 ≤ 4 列）。条目只有三个短字符串，
 * 上限防的是「进程活很久、对比开很多」时的无界增长；被淘汰的那几轮只是**不能
 * 再留**（compareKeep 如实报「记录不在了」），不丢任何已留下的会话。
 */
const KEPT_COLUMN_REGISTRY_LIMIT = 64;

/**
 * 「留为会话」的登记表：`runId + columnId → { path, modelKey, prompt, keptPath }`。
 *
 * 为什么必须另立一份：runner 在 run 结束的 `finally` 里就 `runs.delete(runId)`
 * （编排层不留历史），而「跑完几十秒后再点留为会话」是正常节奏 —— 没有这份账，
 * compareKeep 拿不到那一列的会话文件路径，表现是「点了没反应」的静默失败。
 *
 * 生命周期与淘汰策略：
 *   · **进程级**，不落盘 —— 重启即丢（重启前的对比轮次不能再留，如实报错）；
 *   · 只登记**到达终态 done** 的列（failed / cancelled 列的文件可能还没落盘）；
 *   · 超过 `limit` 按**插入序**淘汰最老的（FIFO）；
 *   · `claim` 是**同步的检查并占位**：手术是 async，两次并发调用若都走「查了
 *     再写」会各自分叉出一条孪生会话；先占位、失败 `release`、成功 `complete`。
 *
 * 导出工厂（而不是只有单例）是为了单测能注入隔离实例；`createCompareRunner`
 * 的 `deps.keptRegistry` 同理。
 *
 * @param {number} [limit] 条目上限（缺省 `KEPT_COLUMN_REGISTRY_LIMIT`）
 */
function createKeptColumnRegistry(limit = KEPT_COLUMN_REGISTRY_LIMIT) {
  const cap = typeof limit === "number" && Number.isFinite(limit) && limit >= 1 ? limit : KEPT_COLUMN_REGISTRY_LIMIT;
  /** 键用 \0 分隔（runId / columnId 都不含它；同款写法见 sessionHeadMemo 的 memoKey）。 */
  const keyOf = (runId, columnId) => `${runId}\0${columnId}`;
  const entries = new Map();
  return {
    /** 登记（或覆写）一条可留的列。非字符串入参直接忽略（防御，不炸）。 */
    register(runId, columnId, info) {
      if (typeof runId !== "string" || runId === "" || typeof columnId !== "string" || columnId === "") return;
      const key = keyOf(runId, columnId);
      entries.set(key, {
        runId,
        columnId,
        path: info?.path,
        modelKey: info?.modelKey,
        prompt: info?.prompt,
        keptPath: undefined,
        claimed: false,
      });
      while (entries.size > cap) {
        const oldest = entries.keys().next().value;
        // 刚插入的那条不许被自己挤掉（cap ≥ 1 由构造保证，这里只是双保险）
        if (oldest === undefined || oldest === key) break;
        entries.delete(oldest);
      }
    },
    /** 按 runId+columnId 查（未命中 undefined）。 */
    lookup(runId, columnId) {
      if (typeof runId !== "string" || typeof columnId !== "string") return undefined;
      return entries.get(keyOf(runId, columnId));
    },
    /**
     * 检查并占位（同步、原子）。
     * @returns {{ status: "ok", entry: object } | { status: "missing" } |
     *           { status: "kept", keptPath: string } | { status: "busy" }}
     */
    claim(runId, columnId) {
      const entry = this.lookup(runId, columnId);
      if (entry === undefined) return { status: "missing" };
      if (entry.keptPath !== undefined) return { status: "kept", keptPath: entry.keptPath };
      if (entry.claimed) return { status: "busy" };
      entry.claimed = true;
      return { status: "ok", entry };
    },
    /** 手术成功：记下留下的会话路径（此后同一列再 claim 报 kept）。 */
    complete(runId, columnId, keptPath) {
      const entry = this.lookup(runId, columnId);
      if (entry === undefined || typeof keptPath !== "string" || keptPath === "") return;
      entry.keptPath = keptPath;
      entry.claimed = false;
    },
    /** 手术失败：释放占位（按钮回弹重试必须还能走通；已 kept 的不受影响）。 */
    release(runId, columnId) {
      const entry = this.lookup(runId, columnId);
      if (entry === undefined || entry.keptPath !== undefined) return;
      entry.claimed = false;
    },
  };
}

/** 进程级单例：session-files.js 的 compareKeep handler 与编排层共用这一份账。 */
const keptColumnRegistry = createKeptColumnRegistry();

/* ══════════════════════════════════════════════════════════════════════════
 * ② 编排：起 N 个宿主并行发问（createCompareRunner）
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 单列的运行上限。取值与 `command-exec.js` 的 `SUBAGENT_TIMEOUT_MS`（10 分钟）同档：
 * 那边是「一个子任务」，这边是「一个答案」，后者只会更快 —— 超了这个数基本等于
 * 连接卡死，让它响比让它挂着有用。
 */
const COMPARE_TIMEOUT_MS = 10 * 6e4;

/**
 * 宿主事件 → 列事件（**唯一**的翻译点）。
 *
 * 只认下面两种**流式增量**，其余**一律不转发** —— 包括 `session_state` /
 * `context_usage` / `session_stats` / `queue_changed` / `run_retry` / 工具卡片
 * （对比列不跑工具、没有会话面板，转发它们等于把一份渲染层不认识的协议塞进新通道），
 * 以及 `assistant_done`（它的转发时机是**刻意的**另一条路：暂存到 run 收尾才发，
 * 理由见 `createCompareRunner` 的注释 —— 失败与取消必须能压过它）。
 *
 * 字段名按 `session-host.js` 的 `translate()` 现核（不是猜的）：
 * - `assistant_text_delta` → `{ type, messageId, delta }`（`session-host.js:722`，
 *   由 `flushDeltas` 发出，`delta` 是已合批的拼接结果）
 * - `assistant_thinking_delta` → 同形（同上，`session-host.js:722` 的三元另一支）
 *
 * 不带 `at`：列事件里的时间一律由**收到它的那一侧**取（`accumulateTiming` 的
 * `now` 是显式入参），daemon 再补一个时间戳只会多出一个没人读、还可能对不上的字段。
 */
function toColumnEvent(columnId, hostEvent) {
  if (hostEvent.type === "assistant_text_delta") {
    return { columnId, kind: "text_delta", delta: hostEvent.delta, messageId: hostEvent.messageId };
  }
  if (hostEvent.type === "assistant_thinking_delta") {
    return { columnId, kind: "thinking_delta", delta: hostEvent.delta, messageId: hostEvent.messageId };
  }
  return undefined;
}

/** `run_finished` 里每列的读数摘要（不带正文 —— 正文渲染层已经有）。 */
function summarizeColumn(state) {
  return {
    columnId: state.columnId,
    modelKey: state.modelKey,
    status: state.status,
    ...state.elapsedMs === undefined ? {} : { elapsedMs: state.elapsedMs },
    ...state.usage === undefined ? {} : { usage: state.usage },
    ...state.error === undefined ? {} : { error: state.error },
  };
}

/**
 * 对比编排。
 *
 * ```js
 * const runner = createCompareRunner(deps);
 * const started = runner.start({ models, prompt, onEvent });   // 同步受理，回 runId
 * runner.abort(started.runId);                                  // 收掉所有列
 * const done = await runner.run({ models, prompt, onEvent });   // 或者等着跑完
 * ```
 *
 * ## 六条硬要求（都在下面兑现，逐条可指认）
 *
 * 1. **事件不走 `emitSessionEvent`**：每列的 `emit` 闭包打列 id 后交给 `onEvent`。
 * 2. **不跑工具**：`toolsOverride: []`（`session-host.js:257` —— 传空数组即
 *    「一个工具都不给」，这是装配层的关法，不是「没给工具提示词」）+ `extensions: []`
 *    （无权限门、无 web、无 spill、无 shell —— 那些都是工具的实现）。
 *    顺带消掉一个坑：无工具 ⇒ 不会产生权限审批 ⇒ 不存在「审批归属于哪一列」
 *    这个问题（`requestApproval(request, sessionId)` 的归属争议在这里不成立）。
 * 3. **额度另立**：只认本模块的 `COMPARE_MAX_COLUMNS`，**不碰**
 *    `SPAWN_BUDGET_PER_SESSION`（`session-state.js:703`）。
 * 4. **每列独立收尾**：一列失败 / 超时 / 取消都不影响别的列；每列**恰好一条**
 *    终态事件（`assistant_done` / `column_failed` / `column_cancelled`）——
 *    「一列永远停在 running」在界面上是流式尾巴一直转、用户没有入口收掉它。
 * 5. **整体 abort** 同时收掉所有列（含还在排队的：取消会把等待中的列直接放出闸）。
 * 6. **`finally` 里 dispose 每一个宿主**：对比宿主**不在 `bucketsById` 里**，
 *    `pickEvictions`（`session-state.js:739`）不会回收它 —— 不显式释放就是泄漏。
 *
 * ## 一处刻意的时序：`assistant_done` 攒到 run 收尾才转发
 *
 * `message_end` 一发生宿主就发 `assistant_done`（`session-host.js:979`），
 * 而**同一轮可能是失败的**：错误助手消息（stopReason "error"）照样走 message_end，
 * 失败在它的**下一拍**（`agent_end` → `run_error`，`session-host.js:832-836`）才揭晓。
 * 若即刻转发，失败列会先落进 `done`，而 `reduceColumn` 的纪律是「终态是终态」
 * ——随后的 `column_failed` 会被忽略，界面上那一列显示「已完成」却带着一句错误、
 * 正文还是空的。所以这里把 `assistant_done` 暂存，**成功收尾时才发**：
 * 失败 ⇒ 只发 `column_failed`；取消 ⇒ 只发 `column_cancelled`（已流出的正文留在
 * 状态里，与「取消保留已产出的正文」的既有语义一致）。
 *
 * @param {object} deps
 * @param {() => Promise<{ isUsable: (key: string) => boolean }>} deps.getCatalog 现读模型目录
 * @param {object} deps.resources 场景 / 交互模式描述（`SessionHost.create` 要它）
 * @param {() => (string | undefined)} deps.getThinkingLevel 全局默认推理档
 * @param {() => string} deps.getCwd 对比列的隔离工作目录（**由调用方给**，本模块不猜）
 * @param {(cwd: string) => boolean} deps.isTempCwd 任务区判定（进宿主状态，仅供展示）
 * @param {() => (number | undefined)} [deps.getTimeoutMs] 单列超时（缺省 `COMPARE_TIMEOUT_MS`）
 * @param {(message: string) => void} [deps.reportError] 观测上报（推送失败 / 意外中止）
 * @param {Function} [deps.createHost] 宿主工厂；缺省 `SessionHost.create`
 *        （**只为测试而留**：单测要覆盖「abort 收掉所有列」「一列失败不拖垮别列」
 *        「异常路径也 dispose」这些纯编排行为，起真宿主跑不了毫秒级单测）
 * @param {object} [deps.keptRegistry] 「留为会话」登记表；缺省用模块级单例
 *        （与 createHost 同一理由留给测试注入：隔离各用例的登记内容）
 */
function createCompareRunner(deps) {
  const createHost = deps.createHost ?? SessionHost.create;
  const keptRegistry = deps.keptRegistry ?? keptColumnRegistry;

  /**
   * 并发额度 = **同一时刻活着的对比列宿主数**。
   *
   * 上限取 `COMPARE_MAX_COLUMNS`（= 单轮列数上限）：一轮的列**全部**能同时跑，
   * 这是「一屏 N 列同时开始流式」的实现基础。超出的（例如同时开了两轮）排队等位。
   * 额度是进程级的、只服务对比 —— 子代理与团队成员的 20 格预算（按桶计）不受影响。
   */
  let running = 0;
  /** 等空位的列：`{ record, resolve }`，FIFO。 */
  const waiters = [];
  /** runId → 本轮记录。允许多轮同时在跑（额度在「列」这一级）。 */
  const runs = new Map();
  let sequence = 0;

  function pump() {
    while (running < COMPARE_MAX_COLUMNS && waiters.length > 0) {
      const waiter = waiters.shift();
      // 已取消的等待者不占额度：直接放它出闸，它拿到的答案是「没排上」。
      if (waiter.record.cancelled) {
        waiter.resolve(false);
        continue;
      }
      running += 1;
      waiter.resolve(true);
    }
  }

  function release() {
    if (running > 0) running -= 1;
    pump();
  }

  /** 取一个空位。`false` = 没排上（整轮已取消）——此时**不要**调 release。 */
  async function acquire(record) {
    if (record.cancelled) return false;
    if (running < COMPARE_MAX_COLUMNS) {
      running += 1;
      return true;
    }
    const granted = await new Promise((resolve) => waiters.push({ record, resolve }));
    if (granted !== true || record.cancelled) {
      // 空位到手却又立刻作废：还回去。额度只在「一次成功的 acquire」与
      // 「一次 release」之间守恒，漏还一格会让后续所有列都比额度少一格。
      if (granted === true) release();
      return false;
    }
    return true;
  }

  /** 取消一轮：排队中的列立刻出闸，已在跑的列逐列 abort。 */
  function cancelRun(record) {
    if (record.cancelled) return false;
    record.cancelled = true;
    for (const waiter of [...waiters]) {
      if (waiter.record !== record) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(false);
    }
    for (const abort of [...record.abortHandlers]) abort();
    return true;
  }

  /**
   * 发一条事件。**先推进编排层自己的那份状态**，再交给调用方 ——
   * 用的是与渲染层同一对纯函数（`reduceColumn` / `accumulateTiming`），
   * 于是 `run()` 的返回值就是渲染层会看到的东西（单测不必起界面就能断言文本与用量）。
   */
  function pushEvent(record, event) {
    if (event.columnId !== undefined) {
      record.states = record.states.map((state) => {
        const reduced = reduceColumn(state, event);
        return accumulateTiming(reduced, event, Date.now());
      });
    }
    try {
      record.onEvent?.(event);
    } catch (error) {
      // 事件是观测：推不出去不该毁掉一轮对比（答案本身还是算出来了）。
      // 但也不静默吞掉 —— 交给调用方的上报口（daemon 侧进 event-log）。
      deps.reportError?.(
        `对比事件推送失败（${event.kind}）：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /** 发一列的终态。**每列恰好一条**：重复调用是 no-op（契约见文件头硬要求 4）。 */
  function settle(record, columnId, event) {
    if (record.settled.has(columnId)) return;
    record.settled.add(columnId);
    pushEvent(record, { runId: record.runId, columnId, ...event });
  }

  async function runColumn(record, column, prompt) {
    const columnId = column.columnId;
    const emit = (event) => pushEvent(record, { runId: record.runId, columnId, ...event });
    let admitted = false;
    let host;
    let hostError;
    let aborted = false;
    /**
     * 本列是否以 done 收尾（「留为会话」的登记判据）。用局部旗标而不是回头读
     * record.states：登记点在 finally 里，旗标在唯一一条成功路径上置位，
     * 不依赖归约层的内部形态。
     */
    let settledDone = false;
    /** 最近一条 `assistant_done` 的 message（成功收尾时才转发，理由见函数头）。 */
    let lastDone;
    /**
     * 本列的取消接线。定义在最外层是为了**在 finally 里一定摘得掉** ——
     * 泄漏一根接线到整轮结束，就等于「取消一个已经跑完的列」；
     * 而宿主此刻已经 dispose，`abort()` 会抛（`void` 出去的 rejection 会走
     * daemon 的 unhandledRejection，那个把整个进程带走）。
     */
    const abortColumn = () => {
      const target = host;
      if (target === undefined) return;
      void target.abort().catch((error) => {
        deps.reportError?.(
          `对比列取消失败（${columnId}）：${error instanceof Error ? error.message : String(error)}`
        );
      });
    };
    try {
      admitted = await acquire(record);
      if (!admitted) {
        settle(record, columnId, { kind: "column_cancelled" });
        return;
      }

      const catalog = await deps.getCatalog();
      if (!catalog.isUsable(column.modelKey)) {
        settle(record, columnId, {
          kind: "column_failed",
          error: `模型「${column.modelKey}」当前不可用（不存在，或服务商还没配 API Key）。请到设置里检查后重选这一列。`,
        });
        return;
      }

      const cwd = deps.getCwd();
      // 宿主自己也会 mkdir；这里显式建一次是为了「目录建不出来」时给出可诊断的
      // 一句话，而不是 pi 内部的一句 ENOENT（错误要可诊断）。
      mkdirSync(cwd, { recursive: true });

      const emitHost = (event) => {
        // 三条记账各自只关心一种宿主事件；其余（工具卡片那一类）本装配根本不会产生，
        // 真产生了也在这里被丢掉 —— 对比列不转发任何非流式增量的东西。
        if (event.type === "run_error" && hostError === undefined) hostError = event.message;
        if (event.type === "run_finished" && event.outcome === "cancelled") aborted = true;
        if (event.type === "assistant_done") {
          // **暂存**而不是转发：这一轮可能是失败的（同一条 message_end 之后紧跟
          // 一个 run_error），转发出去就没有「失败」可汇报了（终态是终态）。
          lastDone = event.message;
          return;
        }
        const columnEvent = toColumnEvent(columnId, event);
        if (columnEvent !== undefined) emit(columnEvent);
      };

      host = await createHost({
        catalog,
        modelKey: column.modelKey,
        cwd,
        isTempTask: deps.isTempCwd(cwd),
        // 两轴只是占位（同子代理）：提示词不由这两轴组装 —— 本装配**不装扩展**，
        // 模型拿到的是 pi 的缺省系统提示词，没有任何本项目的工具说明。
        sceneId: "work",
        interactionId: "craft",
        emit: emitHost,
        resources: deps.resources,
        thinkingLevel: deps.getThinkingLevel(),
        // 不跑工具：装配层一个工具都不给（见函数头硬要求 2）。
        toolsOverride: [],
        extensions: [],
      });
      host.markCompareRun(column.modelKey);

      record.abortHandlers.add(abortColumn);
      // 建宿主窗口里就被取消了：连 prompt 都不要再发（abort 对未开始的会话无效，
      // 硬发出去只会让用户等一个已经不要了的答案）。
      if (record.cancelled) {
        settle(record, columnId, { kind: "column_cancelled" });
        return;
      }
      // 起点 = 「宿主就绪、请求即将发出」这一刻：排队等待与建宿主的开销都不算
      // 这一列的耗时（对比耗时的卖点是「这个模型自己有多慢」）。
      emit({ kind: "column_started", modelKey: column.modelKey });

      let timedOut = false;
      const timeoutMs = deps.getTimeoutMs?.() ?? COMPARE_TIMEOUT_MS;
      const timeout = setTimeout(() => {
        timedOut = true;
        abortColumn();
      }, timeoutMs);
      timeout.unref?.();
      try {
        await host.prompt(prompt);
      } finally {
        clearTimeout(timeout);
      }

      /*
       * 三个终态的判断顺序是有讲究的，别按「读起来顺」排：
       *   ① 整轮被取消 —— 用户的意思最清楚，压过一切（含同刻的超时）；
       *   ② **超时要在 aborted 之前判**：超时是「我们主动 abort 了它」，
       *      宿主那侧看到的是 outcome "cancelled"，与用户取消**长得一模一样**。
       *      先判 aborted 的话，一列真的卡死了却会显示「已取消」——
       *      用户去按取消却发现它本来就是自己超时的，这条错误归因够误导很久。
       *   ③ 其余取消（用户单独取消这一列时也走 record.cancelled，到不了这里）。
       */
      if (record.cancelled) {
        settle(record, columnId, { kind: "column_cancelled" });
        return;
      }
      if (timedOut) {
        settle(record, columnId, {
          kind: "column_failed",
          error: `这一列运行超时（${Math.round(timeoutMs / 6e4)} 分钟上限），已中断。可以单独重试这一列。`,
        });
        return;
      }
      if (aborted) {
        settle(record, columnId, { kind: "column_cancelled" });
        return;
      }
      if (hostError !== undefined) {
        settle(record, columnId, { kind: "column_failed", error: hostError });
        return;
      }
      if (lastDone === undefined) {
        // 跑完却没有助手消息：如实说「没有产出」，而不是把它记成 done（done 意味着
        // 界面上「已完成」，却没有一个字可看）。
        settle(record, columnId, {
          kind: "column_failed",
          error: "这一列没有产出任何回答（模型没有返回助手消息）",
        });
        return;
      }
      settledDone = true;
      settle(record, columnId, { kind: "assistant_done", message: lastDone });
    } catch (error) {
      // 一列的**任何**意外都在这里收口：并行最容易被做错的就是「一列失败拖垮全部」。
      settle(record, columnId, {
        kind: "column_failed",
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      record.abortHandlers.delete(abortColumn);
      if (host !== undefined) {
        /*
         * 「留为会话」登记：只有以 done 收尾的列登记（failed / cancelled 列的
         * 文件可能还没落盘 —— pi 的持久化守卫是「第一条 assistant 消息出现才写
         * 全部条目」，登记它们的路径等于给 compareKeep 一个不存在的文件）。
         * 必须在 dispose **之前**取 sessionFilePath（getter 走活会话对象）；
         * run 结束 runs.delete(runId) 是既有语义，不改 —— 登记表就是为它另立的账。
         */
        if (settledDone) {
          const path = host.sessionFilePath;
          if (typeof path === "string" && path !== "") {
            keptRegistry.register(record.runId, columnId, {
              path,
              modelKey: column.modelKey,
              prompt,
            });
          }
        }
        host.dispose();
      }
      if (admitted) release();
    }
  }

  async function execute(record, prompt) {
    const columns = [...record.states];
    const startedAt = Date.now();
    // 先登记全部列：渲染层收到第一条列事件就知道这一屏有几列，
    // 不必等逐个列启动才把列阵画出来。
    for (const column of columns) {
      pushEvent(record, {
        runId: record.runId,
        columnId: column.columnId,
        kind: "column_queued",
        modelKey: column.modelKey,
      });
    }
    await Promise.allSettled(columns.map((column) => runColumn(record, column, prompt)));
    // 兜底：万一某列连终态都没发出（runColumn 内部已经尽力收口），这里补一条 ——
    // 「一列永远停在 running」是不可接受的形态（流式尾巴一直转，用户收不掉）。
    for (const column of columns) {
      if (record.settled.has(column.columnId)) continue;
      settle(record, column.columnId, {
        kind: "column_failed",
        error: "该列意外中止，没有给出结果",
      });
    }
    const outcome = record.cancelled ? "cancelled" : "completed";
    pushEvent(record, {
      runId: record.runId,
      kind: "run_finished",
      outcome,
      elapsedMs: Date.now() - startedAt,
      columns: record.states.map(summarizeColumn),
    });
    return { runId: record.runId, outcome, columns: record.states };
  }

  /**
   * 受理一轮对比（**同步**返回受理结果，列在后台跑）。
   *
   * 为什么受理与执行分开：`INVOKE.compareStart` 必须**马上**回 `runId` ——
   * 一轮对比要跑几十秒，把它挂在 invoke 的返回值上等于让渲染层干等；
   * 各列的流式与终态本来就是经 `PUSH.compareEvent` 逐条来的。
   *
   * 可预期的失败（模型个数越界 / 重复模型 / 问题为空）**用返回值表达**，不 throw
   * —— 口径同 `settings:test-model`（跨 IPC 的预期失败用返回值，异常留给 bug）。
   *
   * @returns {{ ok: true, runId: string, done: Promise<object> } | { ok: false, error: string }}
   */
  function start(input) {
    const normalized = normalizeColumns(input?.models);
    if (!normalized.ok) return normalized;
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
    if (prompt === "") {
      return { ok: false, error: "请先输入一个问题（对比的就是「同一个问题」的多个答案）" };
    }
    const runId = `compare-${++sequence}`;
    const record = {
      runId,
      states: createColumnStates(normalized.models),
      cancelled: false,
      settled: new Set(),
      abortHandlers: new Set(),
      onEvent: input.onEvent,
    };
    runs.set(runId, record);
    const signal = input.signal;
    const onSignalAbort = () => {
      cancelRun(record);
    };
    if (signal !== undefined) {
      if (signal.aborted) cancelRun(record);
      else signal.addEventListener("abort", onSignalAbort, { once: true });
    }
    const done = execute(record, prompt)
      .catch((error) => {
        // 不该发生（每列的意外都在列内收口了）。真发生了也要让调用方拿到一句话，
        // 而不是一个无人处理的 rejection —— daemon 的 unhandledRejection 会杀掉整个进程。
        const message = error instanceof Error ? error.message : String(error);
        deps.reportError?.(`对比 run 意外中止：${message}`);
        return { runId, outcome: "failed", error: message, columns: record.states };
      })
      .finally(() => {
        signal?.removeEventListener("abort", onSignalAbort);
        runs.delete(runId);
      });
    return { ok: true, runId, done };
  }

  return {
    start,
    /**
     * 受理并等着跑完（`done` 的便利包装）。事件流与 `start` 完全一样，
     * 多出来的是返回值：**每列的终态摘要**（文本、用量、耗时、错误）。
     * 单测与端到端脚本用它断言「两列各收各的」最省事。
     */
    async run(input) {
      const started = start(input);
      if (!started.ok) return started;
      return { ok: true, ...(await started.done) };
    },
    /** 取消一轮：同时收掉所有列（含还在排队的）。runId 不认识时**如实报错**。 */
    abort(runId) {
      if (typeof runId !== "string" || runId === "") {
        return { ok: false, error: "取消对比需要一个 runId" };
      }
      const record = runs.get(runId);
      if (record === undefined) {
        return { ok: false, error: `没有正在进行的对比：${runId}（可能已经跑完了）` };
      }
      cancelRun(record);
      return { ok: true };
    },
    /** 收掉全部在跑的对比（进程收尾用）。 */
    abortAll() {
      for (const record of [...runs.values()]) cancelRun(record);
    },
  };
}

export {
  COMPARE_MAX_COLUMNS,
  COMPARE_MIN_COLUMNS,
  COMPARE_TIMEOUT_MS,
  accumulateTiming,
  createColumnStates,
  createCompareRunner,
  createKeptColumnRegistry,
  extractUsage,
  keptColumnRegistry,
  keptSessionTitle,
  normalizeColumns,
  reduceColumn,
  rewriteKeptSessionLines,
};