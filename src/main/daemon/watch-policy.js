/**
 * 「值守」—— 给无人值守的定时任务一套**可声明**的边界，并如实记账。
 *
 * ## 为什么是独立模块（与 version-store.js / permission-rules.js 同一套理由）
 *
 * `session-files.js` 在模块顶层就 `requireParentPort()` 并 `loadResources()`，
 * 在 Electron utilityProcess 之外根本 import 不了 —— 把边界求值放那里等于放弃单测。
 * 这里**不 import Electron**（只碰 node:path），于是 vitest 能直接 import 这个模块，
 * 把「只能更严」这条不变量、四条判定顺序、五态结论一路钉死。
 *
 * ## 这个模块要解决的真问题
 *
 * 今天 run 会话的权限门是**硬编码的** `unattended: true`（`session-files.js` 的
 * `buildRunExtensions`），于是审批类操作**一律自动拒绝**。拒绝是对的，但它是一刀切的：
 * 用户没有地方说「这个任务只准读」「这个任务可以往 reports/ 里写」。面对的真实选择
 * 只有两个 —— 把**全局**档位切到 `danger-full-access`（整个应用跟着放宽），
 * 或者这个任务什么也干不了。
 *
 * 本模块让**单个任务**能声明自己的边界。三条不能破的性质：
 *
 *  1. **只能更严，不能更宽。** `effectivePolicy` 取「规矩」与「全局档位」中更严的
 *     那一个。规矩比全局宽时**收严并记一条 note**，绝不反向放宽 —— 这是红线 4
 *     （不放宽权限默认值或沙箱约束）在代码上的形状。
 *  2. **判定是一处，不是三处。** 界面层与执行层都调 `effectivePolicy`／
 *     `evaluateWatchBoundary`，不各写一份。两份判定的漂移正是「参数被接受却不生效」
 *     的温床。
 *  3. **拒绝得越多可以，放行得越多不行。** 本模块接在既有 `unattended` 语义**之前**，
 *     它的判定只能是**合取项**（额外拒绝），不能是析取项（额外放行）。
 *
 * ## 四条判定顺序（design.md §3.3）
 *
 *   1. 只读意图            → 放行（只读不越任何界）
 *   2. 档位是 read-only    → 拒，rule = "tier"
 *   3. scope 非空且不在内  → 拒，rule = "scope"
 *   4. 工作区之外          → 拒，rule = "outside"
 *
 * ## 三个硬边界（写死在常量里并导出，便于单测钉住）
 *
 *   WATCH_MAX_MINUTES     120   时限上限（分钟）
 *   WATCH_MAX_SCOPE       16    可写范围最多几条
 *   WATCH_MAX_SCOPE_LEN   200   单条路径长度上限
 *   WATCH_MAX_EXCEEDED    20    报告里逐条列出的越界上限，超出只报计数
 */
import { isAbsolute, relative, resolve, sep } from "node:path";

/** 时限上限（分钟）。超过两小时的无人值守本身就值得重新想。 */
const WATCH_MAX_MINUTES = 120;

/** 可写范围最多几条 —— 再多应该去调工作区，不是列清单。 */
const WATCH_MAX_SCOPE = 16;

/** 单条路径长度上限（与项目常驻指令同族量级）。 */
const WATCH_MAX_SCOPE_LEN = 200;

/** 运行报告里逐条列出的越界上限；超出只报计数（不静默截断）。 */
const WATCH_MAX_EXCEEDED = 20;

/**
 * 档位的宽严序。**数值越大越宽**。
 * 只在 effectivePolicy 里用一次 —— 这是「只能更严」唯一的实现处。
 */
const TIER_RANK = { "read-only": 0, "workspace-write": 1, "danger-full-access": 2 };

/** 规矩里 tier 允许的取值。"follow" = 跟随全局（缺省，即今天的行为）。 */
const WATCH_TIERS = new Set(["read-only", "workspace-write", "follow"]);

/** 全局档位缺省（与 permission-rules.js 的既有缺省一致）。 */
const DEFAULT_GLOBAL_TIER = "workspace-write";

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rankOf(tier) {
  return TIER_RANK[tier] ?? TIER_RANK[DEFAULT_GLOBAL_TIER];
}

/**
 * 更严的那一个。**这是「只能更严」的全部实现** —— 只有这一处做这个比较，
 * 界面与执行层都经过它，不各写一份。
 */
function stricterTier(a, b) {
  return rankOf(a) <= rankOf(b) ? a : b;
}

/**
 * 校验并规范化一条规矩。**非法值抛错，不静默修正** ——
 * 「参数被接受却不生效」比报错更危险，所以宁可响亮（与 automation.js 的
 * parseTask 同一姿态）。
 *
 * @returns {{minutes?: number, tier: string, scope: string[], stopOnExceed: boolean}}
 */
function parseWatchPolicy(raw) {
  if (raw === undefined || raw === null) {
    return { tier: "follow", scope: [], stopOnExceed: true };
  }
  if (!isPlainObject(raw)) throw new Error("值守规矩必须是一个对象");

  const out = { tier: "follow", scope: [], stopOnExceed: true };

  if (raw.minutes !== undefined) {
    const minutes = raw.minutes;
    if (typeof minutes !== "number" || !Number.isInteger(minutes)) {
      throw new Error("值守规矩的时限必须是整数分钟");
    }
    if (minutes < 1) throw new Error("值守规矩的时限至少 1 分钟");
    if (minutes > WATCH_MAX_MINUTES) {
      throw new Error(`值守规矩的时限最长 ${WATCH_MAX_MINUTES} 分钟`);
    }
    out.minutes = minutes;
  }

  if (raw.tier !== undefined) {
    if (typeof raw.tier !== "string" || !WATCH_TIERS.has(raw.tier)) {
      throw new Error("值守规矩的能力只能是「只读」「可写」或「跟随全局」");
    }
    out.tier = raw.tier;
  }

  if (raw.scope !== undefined) {
    if (!Array.isArray(raw.scope)) throw new Error("值守规矩的可写范围必须是一个列表");
    if (raw.scope.length > WATCH_MAX_SCOPE) {
      throw new Error(`值守规矩的可写范围最多 ${WATCH_MAX_SCOPE} 条`);
    }
    const cleaned = [];
    for (const item of raw.scope) {
      if (typeof item !== "string") throw new Error("值守规矩的可写范围里只能放路径字符串");
      const path = item.trim();
      if (path === "") throw new Error("值守规矩的可写范围里不能有空路径");
      if (path.length > WATCH_MAX_SCOPE_LEN) {
        throw new Error(`值守规矩的单条路径最长 ${WATCH_MAX_SCOPE_LEN} 个字符`);
      }
      if (isAbsolute(path)) {
        throw new Error("值守规矩的可写范围只能是工作区内的相对路径");
      }
      // 归一化：把 `a/../b`、`./x`、`a//b`、尾部斜杠这类写法收敛掉。
      // **不能直接用 resolve** —— resolve('/') 会把 `..` 在根上悄悄吸收掉
      // （`resolve('/', '../secrets')` 得 `/secrets`），逃逸就查不出来了。
      // 所以自己按段走一遍：遇到 `..` 弹栈，栈空时说明它要往上跑出工作区。
      const segments = [];
      let escaped = false;
      for (const segment of path.replace(/\\/gu, "/").split("/")) {
        if (segment === "" || segment === ".") continue;
        if (segment === "..") {
          if (segments.length === 0) {
            escaped = true;
            break;
          }
          segments.pop();
          continue;
        }
        segments.push(segment);
      }
      if (escaped || segments.length === 0) {
        throw new Error("值守规矩的可写范围不能跑到工作区之外");
      }
      const normalized = segments.join("/");
      cleaned.push(normalized);
    }
    // 去重但保序：重复条目会让报告里的范围读起来像噪音
    out.scope = [...new Set(cleaned)];
  }

  if (raw.stopOnExceed !== undefined) {
    if (typeof raw.stopOnExceed !== "boolean") {
      throw new Error("值守规矩的「越界即停」必须是开关值");
    }
    out.stopOnExceed = raw.stopOnExceed;
  }

  return out;
}

/**
 * ★ 核心不变量：把「任务规矩」与「全局档位」收敛成**实际生效**的一份策略。
 *
 * 三条规则：
 *   - `tier`：取更严的。规矩比全局宽时收严，并在 `notes` 里**如实说出来**
 *     （界面必须显示这条 —— 用户以为放宽了、实际没有，是静默失效）
 *   - `scope`：全局不是「可写」档时范围无从生效，`scoped` 收敛为空并记 note
 *   - `minutes`：与全局档位无关，**永远生效**（它收紧的是「跑多久」，不是「能做什么」）
 *
 * @param {object|undefined} watch  parseWatchPolicy 的产物（或原始对象）
 * @param {string|undefined} globalTier  全局权限档
 * @returns {{tier: string, scoped: string[], minutes?: number,
 *            stopOnExceed: boolean, notes: string[], warnings: string[]}}
 */
function effectivePolicy(watch, globalTier) {
  const parsed = parseWatchPolicy(watch);
  const global = TIER_RANK[globalTier] === undefined ? DEFAULT_GLOBAL_TIER : globalTier;
  const notes = [];
  const warnings = [];

  // ── 能力：只能更严 ────────────────────────────────────────────────
  const declared = parsed.tier === "follow" ? global : parsed.tier;
  const tier = stricterTier(declared, global);
  if (rankOf(parsed.tier) > rankOf(global) && parsed.tier !== "follow") {
    warnings.push(
      `本任务声明的「${
        parsed.tier === "workspace-write" ? "可写" : "只读"
      }」比当前全局档位更宽，不会放宽它 —— 实际按「${
        global === "read-only" ? "只读" : "只能改工作区"
      }」执行。要真正放宽，请去设置里改全局档位。`,
    );
  }

  // ── 范围：只有真的可写时才谈得上 ──────────────────────────────────
  const scoped = tier === "read-only" ? [] : parsed.scope;
  if (parsed.scope.length > 0 && tier === "read-only") {
    notes.push("本任务当前是不可写档位，声明的「可写范围」不生效（没有东西可写）。");
  }

  return {
    tier,
    scoped,
    ...(parsed.minutes === undefined ? {} : { minutes: parsed.minutes }),
    stopOnExceed: parsed.stopOnExceed,
    notes,
    warnings,
  };
}

/** 把路径归一成 `/` 分隔、无前导斜杠的形式，好和 scope 里的条目比。 */
function normalizeForCompare(path) {
  return path.replace(/\\/gu, "/").replace(/^\.\//u, "").replace(/^\/+/u, "");
}

/**
 * 路径是否落在可写范围内。空范围 = 整个工作目录（放行）。
 *
 * 边界按**路径段**比，不按字符串前缀 —— 否则 `reports-old/x` 会被
 * `reports` 这条误放行（`permission-rules.js` 的 `isPathContained` 同款考量）。
 */
function isInsideScope(path, scope) {
  if (scope.length === 0) return true;
  const target = normalizeForCompare(path);
  for (const entry of scope) {
    const base = normalizeForCompare(entry).replace(/\/+$/u, "");
    if (base === "") return true;
    if (target === base) return true;
    if (target.startsWith(`${base}/`)) return true;
    // 通配：`reports/*` 等价于 `reports` 本身及其下所有内容
    if (base.endsWith("/*") && target.startsWith(`${base.slice(0, -1)}`)) return true;
  }
  return false;
}

/**
 * 判一次工具调用是否越了本任务声明的界。**纯函数**，无副作用。
 *
 * 判定顺序见文件头。返回 `{allowed: true}` 或
 * `{allowed: false, rule, reason}` —— `reason` 会**回给模型**，所以要带上
 * 规矩原文（模型据此换路子，与 unattended 既有的「拒绝并说明」同一条纪律）。
 *
 * @param {{tool?: string, kind: "read"|"write", path?: string}} intent
 * @param {object} policy  effectivePolicy 的产物
 * @param {string} [workspaceDir]  工作目录绝对路径（判「工作区之外」用）
 */
function evaluateWatchBoundary(intent, policy, workspaceDir) {
  if (!isPlainObject(intent)) return { allowed: true };

  // 1. 只读一律放行 —— 只读不越任何界
  if (intent.kind !== "write") return { allowed: true };

  // 2. 档位
  if (policy.tier === "read-only") {
    return {
      allowed: false,
      rule: "tier",
      reason:
        "本任务设置了「只读」值守规矩：不允许修改任何文件。如果这次运行确实需要写入，" +
        "请把这个定时任务的「能力」改成「可写」，或把全局权限档位放宽到「只能改工作区」。",
    };
  }

  const path = typeof intent.path === "string" ? intent.path : undefined;

  // 3. 可写范围（只在确实声明了范围时才判）
  if (path !== undefined && !isInsideScope(path, policy.scoped)) {
    return {
      allowed: false,
      rule: "scope",
      reason:
        `本任务的「可写范围」只含 ${policy.scoped.join("、")}，` +
        `${path} 不在其中。请改写路径，或让用户把这个目录加进任务的可写范围。`,
    };
  }

  // 4. 工作区之外（即使没声明范围也不许跑出去）
  if (path !== undefined && workspaceDir !== undefined && path !== "") {
    const abs = isAbsolute(path) ? path : resolve(workspaceDir, path);
    const rel = relative(resolve(workspaceDir), resolve(abs));
    if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) {
      return {
        allowed: false,
        rule: "outside",
        reason: `本任务只能在它的工作目录内改动文件，${path} 在工作目录之外。`,
      };
    }
  }

  return { allowed: true };
}

/**
 * 往 boundary 里追加一条越界证人。**超过上限只记计数，不静默丢** ——
 * 报告里会说「另有 N 次未逐条列出」（design.md §5）。
 */
function appendExceed(boundary, item) {
  const next = { ...boundary, exceeded: [...boundary.exceeded] };
  if (next.exceeded.length < WATCH_MAX_EXCEEDED) {
    next.exceeded.push(item);
  } else {
    next.overflow = (boundary.overflow ?? 0) + 1;
  }
  return next;
}

/** 一条空白的 boundary（运行开始时建立）。 */
function emptyBoundary() {
  return { exceeded: [], timedOut: false, readOnlyEnforced: false, scoped: [], notes: [] };
}

/** 从 effectivePolicy 的产物建一条运行开始时的 boundary。 */
function boundaryFor(policy) {
  return {
    exceeded: [],
    timedOut: false,
    readOnlyEnforced: policy.tier === "read-only",
    scoped: [...policy.scoped],
    notes: [...policy.notes, ...policy.warnings],
  };
}

/**
 * 把一条运行记录收成**一句读得懂的结论**。五态互斥（design.md §3／PRD §3）：
 *
 *   "unknown"    这条运行早于「值守」功能 —— 没有 boundary 字段。
 *                **不编一个空的出来**：编出来会让用户以为「有边界、只是没用上」
 *   "timedOut"   到点被叫停。**不是「失败」** —— 它可能已经把活儿干完了
 *   "exceeded"   跑完了，但越了 N 次界
 *   "failed"     没跑起来
 *   "ok"         跑完了
 */
function summarizeRun(run) {
  if (!isPlainObject(run)) return { known: false, state: "unknown" };
  const boundary = run.boundary;
  if (!isPlainObject(boundary)) return { known: false, state: "unknown" };

  const exceededCount = (boundary.exceeded?.length ?? 0) + (boundary.overflow ?? 0);

  /*
   * 判定顺序是有讲究的：**越界停在失败之前**。
   *
   * 「越界即停」的运行 `success` 也是 false（那一轮确实没跑完），但
   * 它和「模型报错 / 环境炸了」是两件完全不同的事 —— 前者是**规矩按设计
   * 生效了**，后者才是真的出了问题。先说成「失败」会让用户以为功能坏了。
   */
  if (boundary.timedOut === true) {
    return { known: true, state: "timedOut", exceededCount };
  }
  if (boundary.stoppedByBoundary === true) {
    return { known: true, state: "stopped", exceededCount };
  }
  if (run.success !== true) {
    return { known: true, state: "failed", exceededCount };
  }
  if (exceededCount > 0) {
    return { known: true, state: "exceeded", exceededCount };
  }
  return { known: true, state: "ok", exceededCount };
}

/**
 * 越界之后该怎么办。**由调用方（工具层闸门）用来决定是「停这一次调用」
 * 还是「停整轮运行」。**
 *
 * 这里是**唯一**回答这个问题的函数 —— 界面文案与执行层都读它，
 * 不允许哪一层自己再判一次（design.md §3.2：两份判定必然漂移）。
 *
 * @returns {"block"|"abort"} `block` = 拒掉这次工具调用、把理由回给模型继续跑；
 *                             `abort` = 拒绝之外还要把整轮叫停。
 */
function onExceedAction(policy) {
  return policy.stopOnExceed === false ? "block" : "abort";
}

export {
  DEFAULT_GLOBAL_TIER,
  TIER_RANK,
  WATCH_MAX_EXCEEDED,
  WATCH_MAX_MINUTES,
  WATCH_MAX_SCOPE,
  WATCH_MAX_SCOPE_LEN,
  WATCH_TIERS,
  appendExceed,
  boundaryFor,
  effectivePolicy,
  emptyBoundary,
  evaluateWatchBoundary,
  isInsideScope,
  normalizeForCompare,
  onExceedAction,
  parseWatchPolicy,
  summarizeRun,
};
