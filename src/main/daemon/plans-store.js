/**
 * 计划书（Plan Book）的本机存储：`<configDir>/plans/<sessionId>.json`。
 *
 * ## 为什么是独立文件、而不是写进会话文件
 *
 * 会话文件是 pi 的资产（同一文件出现两个活写者会互相覆盖 entries —— 见
 * `pin.js` 文件头的同款理由）。计划书要支持**版本、勾选、编辑**，如果塞进会话
 * 记录，每一次勾选都要经过活的 SessionManager，耦合与风险都不值得。
 *
 * 独立文件还有更好的失败形态：`plans/<id>.json` 坏了 / 被手改坏了，最坏后果是
 * 「这份计划书读不出来」（界面回到空态），会话本身一根汗毛都不会少。
 *
 * ## 读侧宽容、写侧严格
 *
 * - **读**：文件不存在 / JSON 损坏 / 形状不符 → 返回 `null`。空态是可见的，
 *   不需要抛错去打断界面。
 * - **写**：非法计划**响亮报错**（路径分隔符的 sessionId、空步骤、超长正文、
 *   未知来源……）。写进去的东西必须能原样读回来。
 *
 * ## 版本
 *
 * 每次保存（自动捕获或手动编辑）都把**保存后的快照**追加进 `versions`，
 * 最多 20 个，超出丢最旧。恢复旧版本 = 再保存一次旧内容 —— 于是「恢复」本身
 * 也形成新版本，历史只增不改。
 *
 * 写盘走「临时文件 + rename」（与 `pin.js` / `version-store.js` 同款手法），
 * 避免写到一半进程退出留下半个 JSON。
 *
 * 本模块**不 import Electron**：daemon 的 `session-files.js` 在模块顶层
 * `requireParentPort()`，把存储放那里等于放弃单测。这里只碰 node:fs / node:path。
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** 单份计划最多 50 步（与 renderer/plan-core.js 的 PLAN_STEP_MAX 同值）。 */
export const PLAN_MAX_STEPS = 50;

/** 单步正文上限 500 字（与 renderer/plan-core.js 同值）。 */
export const PLAN_MAX_TEXT = 500;

/** 标题上限 80 字（与 renderer/plan-core.js 同值）。 */
export const PLAN_MAX_TITLE = 80;

/** 最多保留 20 个版本（超出丢最旧）。 */
export const PLAN_MAX_VERSIONS = 20;

/** sessionId 只允许文件名安全字符：拒绝路径分隔符与 `..` 穿越。 */
export const PLAN_SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/u;

/** 步骤 id 的合法形状（renderer 生成的 `s-…` 与手改的普通标识都能过）。 */
const STEP_ID_RE = /^[A-Za-z0-9._-]{1,128}$/u;

const SOURCES = new Set(["agent", "manual"]);

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSessionId(sessionId) {
  if (typeof sessionId !== "string" || !PLAN_SESSION_ID_RE.test(sessionId)) {
    throw new Error(`会话 id 非法（只能包含字母、数字、点、下划线、连字符，且不含路径分隔符）：${String(sessionId)}`);
  }
}

function normalizeTitle(value) {
  if (value === void 0 || value === null) return "计划书";
  if (typeof value !== "string") throw new Error("计划书标题应为字符串");
  const trimmed = value.trim();
  if (trimmed === "") return "计划书";
  if (trimmed.length > PLAN_MAX_TITLE) {
    throw new Error(`计划书标题过长（最多 ${PLAN_MAX_TITLE} 字）：${trimmed.length} 字`);
  }
  return trimmed;
}

/** 写侧：校验并规范化步骤；缺失 id 时补一个。 */
function normalizeStepsForWrite(steps, now) {
  if (!Array.isArray(steps)) throw new Error("计划书步骤应为数组");
  if (steps.length === 0) throw new Error("计划书至少要有一步");
  if (steps.length > PLAN_MAX_STEPS) {
    throw new Error(`计划书步骤过多（最多 ${PLAN_MAX_STEPS} 步）：${steps.length} 步`);
  }
  return steps.map((step, index) => {
    if (!isPlainObject(step)) throw new Error(`第 ${index + 1} 步格式非法：应为对象`);
    if (typeof step.text !== "string") throw new Error(`第 ${index + 1} 步缺少正文`);
    const text = step.text.trim();
    if (text === "") throw new Error(`第 ${index + 1} 步正文为空`);
    if (text.length > PLAN_MAX_TEXT) {
      throw new Error(`第 ${index + 1} 步正文过长（最多 ${PLAN_MAX_TEXT} 字）：${text.length} 字`);
    }
    let id;
    if (step.id === void 0 || step.id === null || step.id === "") {
      id = `s-${now}-${index + 1}`;
    } else if (typeof step.id === "string" && STEP_ID_RE.test(step.id)) {
      id = step.id;
    } else {
      throw new Error(`第 ${index + 1} 步的 id 非法：${String(step.id)}`);
    }
    return { id, text, done: step.done === true };
  });
}

/** 读侧：宽松规范化单条步骤；坏条目返回 null（由调用方决定整份是否可用）。 */
function normalizeStoredStep(raw) {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.text !== "string") return null;
  const text = raw.text.trim();
  if (text === "" || text.length > PLAN_MAX_TEXT) return null;
  if (typeof raw.id !== "string" || !STEP_ID_RE.test(raw.id)) return null;
  return { id: raw.id, text, done: raw.done === true };
}

function normalizeStoredSteps(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > PLAN_MAX_STEPS) return null;
  const steps = [];
  for (const item of raw) {
    const step = normalizeStoredStep(item);
    if (step === null) return null;
    steps.push(step);
  }
  return steps;
}

function normalizeSource(value) {
  if (value === void 0 || value === null) return "manual";
  if (typeof value !== "string" || !SOURCES.has(value)) {
    throw new Error(`未知的计划书来源：${String(value)}（只接受 agent / manual）`);
  }
  return value;
}

function normalizeCapturedEntryId(value) {
  if (value === void 0 || value === null || value === "") return void 0;
  if (typeof value !== "string") throw new Error("capturedEntryId 应为字符串");
  if (value.length > 128) throw new Error("capturedEntryId 过长（最多 128 字符）");
  return value;
}

function normalizeStoredVersion(raw) {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.id !== "string" || raw.id === "") return null;
  const createdAt = raw.createdAt;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  const source = raw.source === "agent" ? "agent" : "manual";
  const title = typeof raw.title === "string" && raw.title.trim() !== "" ? raw.title.trim().slice(0, PLAN_MAX_TITLE) : "计划书";
  const steps = normalizeStoredSteps(raw.steps);
  if (steps === null) return null;
  return { id: raw.id, createdAt, source, title, steps };
}

/** 读侧整体规范化；任何核心字段不符 → null（空态可见，不抛错）。 */
function normalizeStored(raw, sessionId) {
  if (!isPlainObject(raw)) return null;
  const title = typeof raw.title === "string" && raw.title.trim() !== "" ? raw.title.trim().slice(0, PLAN_MAX_TITLE) : null;
  if (title === null) return null;
  const steps = normalizeStoredSteps(raw.steps);
  if (steps === null) return null;
  const updatedAt = raw.updatedAt;
  if (typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return null;
  const versions = [];
  if (Array.isArray(raw.versions)) {
    for (const item of raw.versions) {
      const version = normalizeStoredVersion(item);
      if (version !== null) versions.push(version);
    }
  }
  const plan = {
    sessionId,
    title,
    steps,
    updatedAt,
    versions: versions.slice(-PLAN_MAX_VERSIONS),
  };
  if (typeof raw.capturedEntryId === "string" && raw.capturedEntryId !== "") {
    plan.capturedEntryId = raw.capturedEntryId.slice(0, 128);
  }
  if (typeof raw.approvedAt === "number" && Number.isFinite(raw.approvedAt)) {
    plan.approvedAt = raw.approvedAt;
  }
  if (typeof raw.approvedVersionId === "string" && raw.approvedVersionId !== "") {
    plan.approvedVersionId = raw.approvedVersionId;
  }
  return plan;
}

function cloneSteps(steps) {
  return steps.map((step) => ({ id: step.id, text: step.text, done: step.done === true }));
}

function newVersionId() {
  return `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 批准态只跟「计划内容」走；勾选完成不改变内容，不算改计划。 */
function samePlanContent(plan, title, steps) {
  if (plan.title !== title) return false;
  if (plan.steps.length !== steps.length) return false;
  return plan.steps.every((step, index) => step.text === steps[index].text);
}

export class PlanStore {
  constructor(dir) {
    this.dir = dir;
  }

  dir;

  pathOf(sessionId) {
    return join(this.dir, `${sessionId}.json`);
  }

  /**
   * 读一份计划书。不存在 / 损坏 / 形状不符 → `null`。
   * sessionId 非法也返回 `null`（读路径不该因为一个坏 id 抛错）。
   */
  get(sessionId) {
    if (typeof sessionId !== "string" || !PLAN_SESSION_ID_RE.test(sessionId)) return null;
    let raw;
    try {
      raw = readFileSync(this.pathOf(sessionId), "utf8");
    } catch {
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    return normalizeStored(parsed, sessionId);
  }

  /**
   * 保存一份计划书。
   *
   * **版本只记录内容变化**（标题或步骤文本）。勾选完成 / 取消只是进度，
   * 不改标题也不改文本 —— 那种保存仍然更新 `steps` / `updatedAt` 并落盘，
   * 但**不追加版本**。否则「点几下勾选，版本号冲到 6」会污染历史，而用户
   * 想看的是「这份计划改过哪几稿」。
   *
   * `input`：`{ title?, steps, capturedEntryId?, source }`
   * 返回保存后的完整计划（内容变化时含新版本）。非法输入**抛错**并带上可读原因。
   */
  save(sessionId, input) {
    assertSessionId(sessionId);
    if (!isPlainObject(input)) throw new Error("计划书数据应为对象");
    const now = Date.now();
    const title = normalizeTitle(input.title);
    const steps = normalizeStepsForWrite(input.steps, now);
    const source = normalizeSource(input.source);
    const capturedEntryId = normalizeCapturedEntryId(input.capturedEntryId);
    const existing = this.get(sessionId);
    const existingVersions = existing?.versions ?? [];
    const latestVersion = existingVersions.at(-1);
    /* 没有历史时先落一条基线（手改过的文件可能 versions 为空）。 */
    const contentChanged = latestVersion === void 0 || !samePlanContent(latestVersion, title, steps);
    const versions = contentChanged
      ? [...existingVersions, { id: newVersionId(), createdAt: now, source, title, steps: cloneSteps(steps) }].slice(-PLAN_MAX_VERSIONS)
      : [...existingVersions];
    const approved = existing !== null && existing !== void 0 && existing.approvedAt !== void 0 && samePlanContent(existing, title, steps);
    const resolvedCaptured = capturedEntryId !== void 0 ? capturedEntryId : existing?.capturedEntryId;
    const plan = {
      sessionId,
      title,
      steps,
      updatedAt: now,
      versions,
      ...(resolvedCaptured !== void 0 ? { capturedEntryId: resolvedCaptured } : {}),
      ...(approved
        ? {
            approvedAt: existing.approvedAt,
            ...(existing.approvedVersionId !== void 0 ? { approvedVersionId: existing.approvedVersionId } : {}),
          }
        : {}),
    };
    this.write(plan);
    return plan;
  }

  /**
   * 批准当前版本（或指定版本）。`versionId` 缺省 = 最新一版。
   * 计划书不存在 / 指定版本不存在时抛错 —— 批准一个不存在的东西是配置错误。
   */
  approve(sessionId, versionId) {
    assertSessionId(sessionId);
    const existing = this.get(sessionId);
    if (existing === null) throw new Error("计划书不存在，无法批准");
    let target;
    if (versionId === void 0 || versionId === null || versionId === "") {
      const latest = existing.versions.at(-1);
      if (latest === void 0) throw new Error("计划书还没有任何版本，无法批准");
      target = latest.id;
    } else if (typeof versionId === "string" && existing.versions.some((version) => version.id === versionId)) {
      target = versionId;
    } else {
      throw new Error(`找不到要批准的版本：${String(versionId)}`);
    }
    const next = { ...existing, approvedAt: Date.now(), approvedVersionId: target };
    this.write(next);
    return next;
  }

  /** 删除一份计划书（幂等：文件不存在也返回 ok）。 */
  remove(sessionId) {
    assertSessionId(sessionId);
    rmSync(this.pathOf(sessionId), { force: true });
    return { ok: true };
  }

  write(plan) {
    mkdirSync(dirname(this.pathOf(plan.sessionId)), { recursive: true });
    const path = this.pathOf(plan.sessionId);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  }
}
