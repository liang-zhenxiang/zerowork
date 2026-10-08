/**
 * 模型对比（「一问多答」）视图的纯逻辑内核：N 列状态机 + 每列的读数口径。
 *
 * ## 为什么这些判断要抽成一个不碰 React 的模块
 *
 * 这一屏最可能出、也最难在截图里说清的缺陷是三类：「两列显示了同一个数字」、
 * 「一列的事件进了另一列」、「一列一直停在流式中」。它们的共同点是**界面上不报错**，
 * 只表现为「数字不对」—— GUI 断言只看得到最终像素，而单测能逐条钉在状态机的转移上。
 * 抽法与理由同 `case-cover.js`（见那份文件头的「为什么这些函数在这里而不是组件里」）。
 *
 * ## 与 daemon 侧那份归约器的关系：镜像，不是复用
 *
 * `src/main/daemon/compare.js` 里有同名的 `reduceColumn` / `accumulateTiming` /
 * `extractUsage`，本文件是它的**渲染层镜像**，口径与它逐条一致。不复用有两条硬理由：
 *
 *   1. 那个模块 import `node:fs` 与 `SessionHost`，渲染层不可能（也不该）import 它；
 *   2. 渲染层本来就有自己的一份归约器副本 —— `app.js` 的 `conversationReducer` 与
 *      daemon 的 `session-state.js` 同样是两份手工同步的镜像。
 *
 * 所以**改其中一份时另一份要一起改**，这条纪律与上面那对镜像同源。
 * 与 daemon 那份唯一的差异：这里多一个 `empty` 状态（「已选进名单、还没发问」），
 * daemon 侧没有「还没开始」这个阶段。
 *
 * ## 三条贯穿本文件的口径
 *
 * 1. **列与列之间不共享任何可变状态。** 归约只认 `columnId` 与自己相同的事件，
 *    其余一律原样返回**同一引用**。这是「A 列的事件绝不进 B 列」的实现根。
 * 2. **只吃自己那一轮的事件。** 事件信封带 `runId`；不是本轮的一律丢弃 ——
 *    上一轮迟到的终态不能把新一轮的状态改掉（用户在旧轮收尾时立刻发了新一轮，
 *    这条判据就是唯一的分界）。
 * 3. **适应不了的事件一律原样返回同一引用**：终态之后迟到的增量、未知 kind、
 *    畸形事件都不改状态。终态是终态，一条迟到的增量不能把一列「复活」。
 */

/** 下限 2：只有一个模型就不叫「对比」了（那是普通对话）。与 daemon 侧同值。 */
export const COMPARE_MIN_MODELS = 2;
/** 上限 4：并发上限就是它（见 `src/shared/ipc.js` 的 compareStart 注释）。 */
export const COMPARE_MAX_MODELS = 4;

/** 已选满 4 个时再点第 5 个的提示（toast 的唯一文案来源）。 */
export const COMPARE_FULL_HINT = `最多同时对比 ${COMPARE_MAX_MODELS} 个模型 —— 先在菜单里移除一个，再加新的`;
/** 已选不满 2 个时的约束提示（挂在输入卡下方那行既有读数位上）。 */
export const COMPARE_MIN_HINT = `至少选 ${COMPARE_MIN_MODELS} 个模型才能开始对比`;

/**
 * 渲染层归约器认得的 kind 全集。
 *
 * **这是与 `src/shared/ipc.js` 的 `PUSH.compareEvent` 注释之间的契约**：
 * 注释里列了几种 kind，这里就得有几种（单测比对两份清单，谁加了没同步都要红）。
 * 意义是「新增一种 kind 却忘了处理」这件事在本次改动的形态里是**静默**的 ——
 * 界面上表现为「某一列卡住没反应」，没有任何报错。
 */
export const COMPARE_HANDLED_KINDS = new Set([
  "column_queued",
  "column_started",
  "text_delta",
  "thinking_delta",
  "assistant_done",
  "column_failed",
  "column_cancelled",
  "run_finished",
]);

/** 会让一列收尾的 kind（整体信号 `run_finished` 不在其中）。与 daemon 侧同集。 */
const SETTLING_KINDS = new Set(["assistant_done", "column_failed", "column_cancelled"]);

/** 还在跑的列状态：只有它们能被「失败 / 取消」收掉。 */
const ACTIVE_STATUSES = new Set(["queued", "running"]);

/**
 * `usage` 里认得的字段（对齐 `session-view.js` 的 `toTokenUsage` 产出，
 * 也就是 `assistant_done.message.usage` 的实际形状）。只取能直接展示的标量；
 * 嵌套的 `costBreakdown` 留给诊断页，对比列头不显示它。
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

/** 一列在「还没发问」时的形态：名单里有它，但没有任何请求发生过。 */
function emptyColumn(modelKey, index) {
  return {
    columnId: `col-${index}`,
    modelKey,
    status: "empty",
    text: "",
    thinking: "",
    // 还没跑：用量、错误、耗时一律缺席，而不是编一个 0 出来。
    usage: undefined,
    error: undefined,
    startedAt: undefined,
    endedAt: undefined,
    elapsedMs: undefined,
    // 「留为会话」的保存子状态（**本地 UI 态**，不来自任何推送事件）：
    // idle（没在留）| saving（已点击、IPC 未回，第一拍就禁用防双击）| kept（已留成，
    // keptPath/keptTitle 是 daemon 回的新会话路径与标题）。失败回 idle —— 按钮可点
    // 即天然的重试入口。`begin`（新一轮）重建列阵时随之归零，与「离屏即重置」同口径。
    keepPhase: "idle",
    keptPath: undefined,
    keptTitle: undefined,
  };
}

/**
 * 名单 → 列阵。**顺序即列序**，`columnId` 用序号，与 daemon 侧
 * `createColumnStates` 的取值一致 —— 事件里的 `columnId` 因此能直接对上。
 */
function columnsFor(models, status) {
  if (!Array.isArray(models)) return [];
  return models.map((modelKey, index) => ({
    ...emptyColumn(modelKey, index),
    status,
  }));
}

/**
 * 视图的初始状态。`picked` 是已选模型 key（顺序即列序），来自入口：
 * ⌘K 动作给空名单，输入卡模型菜单那条入口把当前会话模型预选成第一个。
 */
export function initialCompareState(picked = []) {
  const keys = Array.isArray(picked) ? picked.filter((key) => typeof key === "string") : [];
  return {
    runId: undefined,
    /** idle（还没发问）| running（有一轮在跑）| finished（这一轮收了尾）。 */
    phase: "idle",
    /** `"completed" | "cancelled"`，来自 `run_finished`。 */
    outcome: undefined,
    /** 整轮墙钟耗时，来自 `run_finished`（列头显示的是**各列自己**的耗时）。 */
    elapsedMs: undefined,
    picked: keys,
    /** 最近一次「被明确拒绝」的加选（见 `compareReducer` 的 `toggle`）。 */
    lastReject: undefined,
    columns: columnsFor(keys, "empty"),
  };
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** 采纳事件里带的 `modelKey`（没有、或与现状相同就不动，保持引用相等）。 */
function adoptModelKey(state, event) {
  const modelKey = event.modelKey;
  if (typeof modelKey !== "string" || modelKey === "" || modelKey === state.modelKey) return state;
  return { ...state, modelKey };
}

/** 追加流式片段。只接受 `running` 列：顺序错了就丢弃，不猜。 */
function appendDelta(state, field, event) {
  if (state.status !== "running") return state;
  const delta = event.delta;
  if (typeof delta !== "string" || delta === "") return state;
  return { ...state, [field]: state[field] + delta };
}

/**
 * `assistant_done`：整段文本是权威值，**覆盖**流式累积的结果（流式期间可能有
 * 修正、也可能漏帧）；`thinking` 只在事件带了非空值时才替换。
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
 * 失败原因必须是可读的一句话（错误要可诊断）：daemon 侧给字符串（跨 IPC 的形态），
 * 本地路径可能给 `Error`；两者都拿不到时说明**为什么没有原因**，
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
 * **缺失或畸形时如实返回 `undefined`，不编一个 0**：0 是有含义的数（真的没花钱），
 * 与「没拿到」是两回事；编 0 会让「用量没回来」在界面上看不出来。
 * 单个字段畸形就剔除那一个，其余照收 —— 部分可用比整块丢弃有用。
 */
export function extractUsage(assistantDoneEvent) {
  if (assistantDoneEvent === undefined || assistantDoneEvent === null) return undefined;
  const message = assistantDoneEvent.message;
  if (typeof message !== "object" || message === null) return undefined;
  const usage = message.usage;
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return undefined;
  const picked = {};
  for (const field of USAGE_FIELDS) {
    if (finite(usage[field])) picked[field] = usage[field];
  }
  return Object.keys(picked).length === 0 ? undefined : picked;
}

/**
 * 一列的状态归约：`empty → queued → running → (done | failed | cancelled)`，
 * 另有 `queued → (failed | cancelled)`（还没轮到就失败 / 被取消）。
 *
 * 不适应的事件返回**同一个对象引用** —— 上层据此判断「这一条事件有没有动到状态」。
 */
export function reduceColumn(state, event) {
  if (state === undefined || state === null || event === undefined || event === null) return state;
  // 列间隔离的根：不是自己那一列的事件，一个字都不许改。
  if (event.columnId !== state.columnId) return state;
  switch (event.kind) {
    case "column_queued":
      // 已经把列画出来了（`begin` 时就置为 queued），这里只是采纳 modelKey。
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
      if (!ACTIVE_STATUSES.has(state.status)) return state;
      return { ...state, status: "failed", error: failureText(event) };
    case "column_cancelled":
      if (!ACTIVE_STATUSES.has(state.status)) return state;
      return { ...state, status: "cancelled" };
    default:
      return state;
  }
}

/**
 * 计时：`column_started` 记这一列**自己**的起点，终态记终点与耗时。
 *
 * 三处刻意的行为（与 daemon 侧逐条一致）：
 *
 * - **起点只认自己的 `column_started`**（不是整轮的开始）。排队等待不算这一列的耗时，
 *   否则「先跑的那列」与「排队 3 秒才轮到的列」会显示出同一个数字 ——
 *   而「这个模型自己有多慢」正是这一屏的卖点。
 * - **还没轮到就被取消 → 不记耗时**：没有「跑了多久」可言，界面按「已取消」呈现即可。
 * - **时钟回拨则耗时取 0**（绝不把负数或 NaN 写进耗时 —— 那会让列头显示「NaN 秒」）。
 */
export function accumulateTiming(state, event, now) {
  if (state === undefined || state === null || event === undefined || event === null) return state;
  if (event.columnId !== state.columnId) return state;
  if (!finite(now)) return state;
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

/**
 * 「留为会话」三拍（begin → done / fail）对一列的子状态转移。
 *
 * 这三个是**本地 action**：`COMPARE_HANDLED_KINDS` 是 `PUSH.compareEvent` 的推送 kind
 * 契约清单（单测拿它与 `src/shared/ipc.js` 的注释比对），本地 action 不属于它，
 * 加在这里不会（也不该）触发那份契约测试。
 *
 * runId 的守卫在 `compareReducer` 里（见下），本函数只管一列内的转移；
 * 不认识的形态（对非 idle 列 begin、对非 saving 列 fail）原样返回同一引用。
 */
function reduceKeep(column, action) {
  if (action.type === "keep_begin") {
    // 只认 idle：已留（kept）是终态，迟到/重复的点击不许把它退回去。
    return column.keepPhase === "idle" ? { ...column, keepPhase: "saving" } : column;
  }
  if (action.type === "keep_done") {
    return {
      ...column,
      keepPhase: "kept",
      keptPath: typeof action.path === "string" && action.path !== "" ? action.path : undefined,
      keptTitle: typeof action.title === "string" ? action.title : undefined,
    };
  }
  // keep_fail：saving → idle（按钮回弹）。kept 不受影响（那条会话已经落在盘上了）。
  return column.keepPhase === "saving" ? { ...column, keepPhase: "idle" } : column;
}

/**
 * 整轮与各列的状态归约（`useReducer` 的 reducer 本体）。
 *
 * 动作：
 *   `{ type: "toggle", key }`         名单里加减**一个**模型（只认 idle / finished 两态）
 *   `{ type: "begin", models }`       本轮已受理，列阵按发出去的名单重建
 *   `{ type: "accept", runId }`       拿到 daemon 受理回来的 runId
 *   `{ type: "failed" }`             本轮没起得来（daemon 拒绝），回到 idle
 *   `{ type: "event", event, now }`  一条 `PUSH.compareEvent`
 *   `{ type: "keep_begin", runId, columnId }`                「留为会话」已点击（列转 saving）
 *   `{ type: "keep_done", runId, columnId, path, title }`    留成了一条新会话（列转 kept）
 *   `{ type: "keep_fail", runId, columnId }`                 没留成（列回 idle，toast 由组件弹）
 *
 * ## 为什么名单动作是**相对**的（`toggle key`），不是绝对列表（`pick models`）
 *
 * 这条是**修出来的**，不是洁癖。原先组件里的处理器写的是
 * `togglePickedModel(state.picked, key)` —— `state.picked` 来自**这次渲染的闭包**，
 * 而同一任务里派发两条 `pick` 时两条都读到**同一份**旧 state：第二条把第一条的结果
 * 整个覆盖掉。症状是「连着点两个模型，只选中了后一个」，且**只在连点（同一帧内）时出现**
 * —— 手点两次（中间隔着一次重渲染）完全正常，所以它看起来像手速问题。
 * （React 会把同一任务里的多次 dispatch 排进队列，但闭包里的 state 不会因此变新。）
 *
 * 改成相对动作之后，**由归约器按最新状态算**：两条 `toggle` 依次作用在对方的结果上，
 * 连点与分开点得到同一个名单。这一条在 e2e 里有一条专门的断言
 * （同一任务里连点两个模型，两个都要在名单里）。
 *
 * ## 越界（第 5 个）的「原因」怎么带回给界面
 *
 * 归约器必须是**纯的**，弹 toast 是副作用，不能写在这里。做法是把原因记进
 * `state.lastReject = { hint, seq }`：组件用一个 effect 盯着这个字段弹提示。
 *
 * - **不直接用返回的名单差集去推原因**：`{keys: 旧名单, error}` 的形状让调用方
 *   在闭包里比较两份名单才知道发生了什么，而「点了没反应」与「明确拒绝」在界面上
 *   必须可辨（本仓库对「静默丢东西」有明确纪律）。
 * - **`seq` 是单调计数**：effect 的依赖是这一个字段的对象引用，连着越界两次若对象
 *   不变、效果就不会再跑，第二次点击又成了「点了没反应」。计数让每一次拒绝都是
 *   一份新的对象（理由与 `app.js` 里 toast id 用 `Date.now()+random` 同源）。
 * - 成功的加减把整份状态换成 `initialCompareState(...)`，`lastReject` 随之清空。
 *
 * 为什么 `begin` 要收 `models` 而不是读 `state.picked`：发出去的就是它，
 * 列阵以它为准，渲染层与 daemon 的列序因此不可能对不上。
 *
 * 为什么受理要拆成 `begin` + `accept` 两步（**这条不是洁癖，是一个真实竞态**）：
 * daemon 在 `compareStart` 的处理器**返回之前**就已经把各列的 `column_queued`
 * push 出来了（它同步登记列阵），跨进程的两条消息（invoke 应答 / push）没有先后保证
 * —— 等 runId 回来才进 running 的话，先到的那几条列事件会被「不在跑」这条判据丢掉，
 * 最坏情况是丢掉 `column_started`（那一列的时间从此算不出来）。
 * 所以先按乐观值进 running，拿到 runId 再登记；登记之前不比较 runId，
 * 登记之后**严格比对**（上一轮迟到的终态因此进不来）。
 */
export function compareReducer(state, action) {
  if (state === undefined) return state;
  switch (action?.type) {
    case "toggle": {
      if (state.phase === "running") return state;
      const result = togglePickedModel(state.picked, action.key);
      if (result.error !== undefined) {
        // 名单**原样不动**（越界就是没加进去），只记下一次拒绝供界面弹提示。
        // 理由见本函数头注「越界（第 5 个）的『原因』怎么带回给界面」。
        return { ...state, lastReject: { hint: result.error, seq: (state.lastReject?.seq ?? 0) + 1 } };
      }
      return initialCompareState(result.keys);
    }
    case "begin": {
      const models = Array.isArray(action.models) ? action.models : state.picked;
      return {
        ...state,
        runId: typeof action.runId === "string" ? action.runId : undefined,
        phase: "running",
        outcome: undefined,
        elapsedMs: undefined,
        columns: columnsFor(models, "queued"),
      };
    }
    case "accept": {
      if (state.phase !== "running" || state.runId !== undefined) return state;
      if (typeof action.runId !== "string" || action.runId === "") return state;
      return { ...state, runId: action.runId };
    }
    case "failed":
      // 整轮没起得来：回到「已选好名单、还没发问」，界面立刻可再次发问。
      return initialCompareState(state.picked);
    case "keep_begin":
    case "keep_done":
    case "keep_fail": {
      /*
       * runId 必须**逐字匹配本轮**：保存中用户又发起了新一轮时，`begin` 已把 runId
       * 换掉（未 accept 时是 undefined）、列阵也重建过 —— 迟到的 keep 回包若不带
       * 这道守卫，会落在新一轮**同名列**上（col-0 又是 col-0），把一条没留过的列
       * 标成已留。这是「终态不被迟到事件改动」那条口径在本地 action 上的同款。
       */
      if (typeof action.runId !== "string" || action.runId !== state.runId) return state;
      if (typeof action.columnId !== "string" || action.columnId === "") return state;
      let touched = false;
      const columns = state.columns.map((column) => {
        if (column.columnId !== action.columnId) return column;
        const next = reduceKeep(column, action);
        if (next === column) return column;
        touched = true;
        return next;
      });
      return touched ? { ...state, columns } : state;
    }
    case "event": {
      const event = action.event;
      if (event === undefined || event === null) return state;
      // 只有跑着的那一轮吃事件；runId 一旦登记，不是本轮的（上一轮迟到的终态）一律不理。
      if (state.phase !== "running") return state;
      if (state.runId !== undefined && event.runId !== state.runId) return state;
      if (event.kind === "run_finished") {
        const run = event;
        return {
          ...state,
          phase: "finished",
          outcome: run.outcome === "cancelled" ? "cancelled" : "completed",
          elapsedMs: finite(run.elapsedMs) ? run.elapsedMs : undefined,
        };
      }
      if (typeof event.columnId !== "string" || event.columnId === "") return state;
      let touched = false;
      const columns = state.columns.map((column) => {
        if (column.columnId !== event.columnId) return column;
        const reduced = reduceColumn(column, event);
        const timed = accumulateTiming(reduced, event, action.now);
        if (reduced !== column || timed !== reduced) touched = true;
        return timed;
      });
      return touched ? { ...state, columns } : state;
    }
    default:
      return state;
  }
}

/* ══════════════════════════════════════════════════════════════════════════
 * 展示口径（列头读数 / 列体形态 / 名单与按钮文案）
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 模型 key → 展示用的三段（名字 / 服务商 / 模型 id）。
 *
 * **名字用 `model.name` 而不是 id**：那是用户在模型菜单里选人时看到的那一个字段，
 * 列头与菜单因此逐字一致（`.model-menu-name` 用的也是它）。快照还没回来时
 * 回落到 key 里 `/` 之后的那一段 —— 缺省是确定的，不是空白。
 */
export function describeModel(modelKey, snapshot) {
  const models = Array.isArray(snapshot?.models) ? snapshot.models : [];
  const providers = Array.isArray(snapshot?.providers) ? snapshot.providers : [];
  const model = models.find((item) => `${item.providerId}/${item.id}` === modelKey);
  const slash = modelKey.indexOf("/");
  const fallbackId = slash === -1 ? modelKey : modelKey.slice(slash + 1);
  const provider = model === undefined ? undefined : providers.find((item) => item.id === model.providerId);
  return {
    key: modelKey,
    name: model?.name ?? fallbackId,
    modelId: model?.id ?? fallbackId,
    providerName: provider?.name ?? model?.providerId ?? (slash === -1 ? "" : modelKey.slice(0, slash)),
  };
}

/**
 * 第 i 列的分类色槽（`--cat-1..4`）。**它是「这一列是谁」，不是状态**：
 * 失败列不换色（把失败压到这条通道上，这一列就丢了身份）。
 * 槽位只有 4 个而列数上限就是 4，故不需要取模 —— 超出时钳到最后一槽。
 */
export function laneAccentVar(index) {
  const slot = Math.min(Math.max(0, Math.trunc(index)), COMPARE_MAX_MODELS - 1) + 1;
  return `var(--cat-${slot})`;
}

/**
 * 列头耗时位上的一行字。五种状态 + 「还没发问」：
 *
 * | 状态 | 文案 |
 * | --- | --- |
 * | empty | `undefined`（不发问就不显示秒数，也没别的可说） |
 * | queued | `排队中`（**不带秒数**：排队不计入耗时，否则对比数据被污染） |
 * | running | `已处理 {n}s` |
 * | done | `已完成 {n}s` |
 * | failed | `失败 {n}s`（排队中就被取消/失败的那种没有秒数可言，只显示状态词） |
 * | cancelled | `已取消 {n}s`（同上） |
 *
 * `formatDuration` 由调用方注入（`app.js` 的 `formatDuration$1`）——
 * 本模块**不另写一套格式化**，否则同一个数在两个页面会显示成两种写法。
 */
export function columnStatusText(column, now, formatDuration) {
  if (column === undefined || column === null) return undefined;
  switch (column.status) {
    case "empty":
      return undefined;
    case "queued":
      return "排队中";
    case "running": {
      const elapsed = column.startedAt === undefined || !finite(now) ? 0 : Math.max(0, now - column.startedAt);
      return `已处理 ${formatDuration(elapsed)}`;
    }
    case "done":
      return `已完成 ${formatDuration(finite(column.elapsedMs) ? column.elapsedMs : 0)}`;
    case "failed":
      return finite(column.elapsedMs) ? `失败 ${formatDuration(column.elapsedMs)}` : "失败";
    case "cancelled":
      return finite(column.elapsedMs) ? `已取消 ${formatDuration(column.elapsedMs)}` : "已取消";
    default:
      return undefined;
  }
}

/**
 * 列体该画成哪一种形态。**这是渲染分支的唯一判据**（组件里不再二次判断），
 * 五种状态各自可辨、互斥：
 *
 *   empty     居中「等待提问」（还没发问，不是「无数据」）
 *   queued    左上角一枚「排队中」chip
 *   waiting   一行扫光「等待模型响应…」（已受理、首个字节还没到）
 *   streaming 正文本身在长
 *   done      正文静止
 *   failed    错误框 + 重试
 *   cancelled 已产出的正文 + 末尾一行「已取消」
 */
export function columnBodyKind(column) {
  if (column === undefined || column === null) return "empty";
  switch (column.status) {
    case "empty":
      return "empty";
    case "queued":
      return "queued";
    case "running":
      return column.text === "" && column.thinking === "" ? "waiting" : "streaming";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "empty";
  }
}

/**
 * 一列的用量读数（交给既有 `RunMetricsBar` 渲染，就是对话页那一套 `↑ ↓`）。
 *
 * 上行与对话页**同一个口径**（`billedInputTokens` = `input + cacheRead + cacheWrite`），
 * 于是同一份回答在两处显示同一个数；下行是输出 token。
 * **没有用量就返回空数组**（不编 0，也不显示一个空读数位）。
 *
 * `formatTokenCount` 同样由调用方注入（理由同 `columnStatusText`）。
 */
export function columnMetricItems(column, formatTokenCount) {
  const usage = column?.usage;
  if (usage === undefined) return [];
  const items = [];
  let billed;
  for (const field of ["input", "cacheRead", "cacheWrite"]) {
    if (finite(usage[field])) billed = (billed ?? 0) + usage[field];
  }
  if (billed !== undefined) items.push(`↑${formatTokenCount(billed)}`);
  if (finite(usage.output)) items.push(`↓${formatTokenCount(usage.output)}`);
  return items;
}

/**
 * 一列 → 时间线条目（喂给 `buildTurnViews` 的形状）。
 *
 * 两处**刻意**的取舍（对应 `design-spec.md` §2.12 的第 1、2 条）：
 *
 * - **只有助手条目，没有用户那条问题**：问题属于页面上方的输入卡，
 *   4 列各显示一遍是噪声，还会把「同一个问题」这个前提视觉上稀释。
 * - **还没有正文时返回空数组**（而不是塞一条空文本的助手条目）：
 *   `classify()` 会把「有 role 没文本」的助手条目归进工具折叠组，
 *   而对比列没有任何工具 —— 空数组让折叠逻辑连碰都不碰它。
 *   思考内容由列体单独渲染（`ThinkingBlock`），不进这里。
 */
export function columnEntries(column) {
  if (column === undefined || column === null || typeof column.text !== "string" || column.text === "") {
    return [];
  }
  return [
    {
      id: `${column.columnId}-answer`,
      role: "assistant",
      text: column.text,
      ...(finite(column.startedAt) ? { at: column.startedAt } : {}),
    },
  ];
}

/**
 * 名单里加/减一个模型。返回新的名单；越界（第 5 个）时**原样返回旧名单并给出原因**
 * —— 界面据此弹 toast 说明，而不是静默忽略（静默忽略读起来就是「点了没反应」）。
 */
export function togglePickedModel(picked, key) {
  const list = Array.isArray(picked) ? picked : [];
  if (typeof key !== "string" || key === "") return { keys: list };
  if (list.includes(key)) return { keys: list.filter((item) => item !== key) };
  if (list.length >= COMPARE_MAX_MODELS) return { keys: list, error: COMPARE_FULL_HINT };
  return { keys: [...list, key] };
}

/** 输入卡下方那行约束提示（够 2 个时不显示 —— 不写「一切正常」式的常驻噪声）。 */
export function compareHint(picked) {
  const count = Array.isArray(picked) ? picked.length : 0;
  return count < COMPARE_MIN_MODELS ? COMPARE_MIN_HINT : undefined;
}

/** 模型钮上的文案：选了 2 个以上就报数，否则是「去选」的动作。 */
export function modelButtonText(picked) {
  const count = Array.isArray(picked) ? picked.length : 0;
  return count >= COMPARE_MIN_MODELS ? `对比 ${count} 个模型` : "选择对比模型";
}

/** 发送键的可否：名单 2–4 个、且问题非空。 */
export function canStartCompare(picked, prompt) {
  const count = Array.isArray(picked) ? picked.length : 0;
  if (count < COMPARE_MIN_MODELS || count > COMPARE_MAX_MODELS) return false;
  return typeof prompt === "string" && prompt.trim() !== "";
}
