/**
 * 变更审阅台：把「文件时光机」按**文件**组织的版本历史，重新按**变更**列成队列。
 *
 * 文件历史回答的是「这个文件被改过几次」；审阅台回答的是「AI 昨晚改了我的东西，
 * 我确认过没有」。每个文件只取**最后一条版本**（= 最近一次覆盖前留下的那份内容）
 * 作为一条变更，配一个「已阅」标记，文件再被改一次就自动回到待审阅。
 *
 * ## 为什么独立成模块
 *
 * 与 version-store.js 同一套理由：`session-files.js` 在顶层就 `requireParentPort()`，
 * 在 utilityProcess 之外根本 import 不了。这里**不 import Electron**，只碰
 * node:fs、version-store（版本存储）与 session-view（diff）—— 于是 vitest 能直接
 * import，把「已阅判定 / 排序计数 / 读当前文件的三条边界」一路钉死。
 *
 * ## 状态文件：`<config>/review-state.json`
 *
 *   { "files": { "<key>": { "versionId": "0000000012", "at": 1760000000000 } } }
 *
 * **已阅判定用版本 id，不用时间戳**：文件再被改一次，最后一条版本的 id 就变了，
 * 自然回到待审阅。没有时钟比较、没有时钟偏差，也不需要清理历史。
 *
 * 坏 JSON / 结构不对 → **当空**（与 pin.js / projects.js 同口径）：最坏后果是丢
 * 那几个「已阅」标记，不会崩，也不会连带作废版本存储。写入走「临时文件 + rename」，
 * 与 projects.js / version-store 的 meta 同款。
 *
 * ## 读取当前文件的安全边界（design.md §4）
 *
 * `review:read` 是本模块新增的**唯一**「读任意路径」入口，因此必须自限：
 *
 *   REVIEW_MAX_BYTES  256 KiB  超过就**不读**，返回 too-large（界面只给增删行数）
 *   二进制            8 KiB   前 8 KiB 含 NUL → binary（复用 version-store 的判据）
 *   符号链接          不跟随   lstat 判定 → symlink（不让审阅页成为读任意路径的跳板）
 *   文件不存在        不抛     → no-after（被删除/移走是正常状态，界面如实说）
 *
 * **不做路径白名单**：版本存储只记录 Agent 实际写过的路径，天然受工作区约束；
 * 再加白名单会误伤「工作区外但用户明确让 Agent 改」的合法场景（design.md §4）。
 */
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getConfigDir, versionsDir } from "./config-paths.js";
import { computeLineDiff } from "./session-view.js";
import { looksBinary, readVersionContent, readVersionFile } from "./version-store.js";

/** 「当前文件」的读取上限：与 VERSION_MAX_BYTES 同量级，超过就不给 diff。 */
const REVIEW_MAX_BYTES = 256 * 1024;

const REVIEW_STATE_FILE = "review-state.json";

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 审阅状态文件的绝对路径（`dir` 是配置目录，不是 versions/）。 */
function reviewStatePath(dir) {
  return join(dir, REVIEW_STATE_FILE);
}

/**
 * 读审阅状态（**IO 层**）。文件不存在 / JSON 损坏 / 顶层结构不符 → `{ files: {} }`。
 *
 * 单条坏记录丢它自己，其余照常 —— 与 version-store 的「单条坏条目不作废整份 meta」
 * 同口径：一个手写坏的键不该让整页标记消失。
 */
function readReviewState(dir = getConfigDir()) {
  let raw;
  try {
    raw = readFileSync(reviewStatePath(dir), "utf8");
  } catch {
    return { files: {} };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { files: {} };
  }
  if (!isPlainObject(parsed) || !isPlainObject(parsed.files)) return { files: {} };
  const files = {};
  for (const [key, value] of Object.entries(parsed.files)) {
    if (!isPlainObject(value)) continue;
    if (typeof value.versionId !== "string" || value.versionId === "") continue;
    files[key] = {
      versionId: value.versionId,
      at: typeof value.at === "number" && Number.isFinite(value.at) ? value.at : 0,
    };
  }
  return { files };
}

/**
 * 写审阅状态（**原子**：临时文件 + rename，与 projects.js 同款）。
 *
 * 返回 `{ ok:true }` 或 `{ ok:false, message }` —— **不抛**：标记已阅失败不该
 * 让 IPC 调用方拿到一个 rejected promise（本仓库「失败用返回值表达」的既有约定）。
 */
function writeReviewState(dir, state) {
  const path = reviewStatePath(dir);
  try {
    mkdirSync(dir, { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

/** 这一版是否已被标记为已阅（**纯函数**）。versionId 必须非空才算数。 */
function isReviewed(state, key, versionId) {
  if (typeof key !== "string" || key === "") return false;
  if (typeof versionId !== "string" || versionId === "") return false;
  const record = state?.files?.[key];
  return isPlainObject(record) && record.versionId === versionId;
}

/**
 * 把版本清单折成审阅队列（**纯函数**）。
 *
 * 输入是 `listVersionFiles().files`（每条已带最后一条版本的 `versionId / at / …`），
 * 按 `at` 降序排，并给每条打上 `reviewed`。**没有版本的条目直接排除**：那只是
 * 「某次改动被跳过（二进制/超大）」，没有旧内容可审；它们由 `skippedTotal` 汇总说明，
 * 不伪装成一条可打开的变更。
 */
function buildReviewEntries(files, state) {
  const entries = [];
  for (const file of Array.isArray(files) ? files : []) {
    if (!isPlainObject(file)) continue;
    if (typeof file.versionId !== "string" || file.versionId === "") continue;
    const entry = {
      key: file.key,
      path: file.path,
      name: file.name,
      dir: file.dir,
      versionId: file.versionId,
      at: typeof file.at === "number" && Number.isFinite(file.at) ? file.at : 0,
      exists: file.exists === true,
      reviewed: isReviewed(state, file.key, file.versionId),
    };
    if (file.tool !== undefined) entry.tool = file.tool;
    if (file.sessionId !== undefined) entry.sessionId = file.sessionId;
    if (file.added !== undefined) entry.added = file.added;
    if (file.removed !== undefined) entry.removed = file.removed;
    entries.push(entry);
  }
  // 同一毫秒的两次改动按 key 兜底排序，保证结果稳定（不依赖 readdir 的顺序）。
  entries.sort((a, b) => b.at - a.at || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const pending = entries.filter((entry) => !entry.reviewed).length;
  return { entries, pending, reviewed: entries.length - pending };
}

/**
 * 记一条「已阅」（**纯函数**，**不改入参**，返回新 state）。
 *
 * `at` 是标记时刻（默认当前时间，测试可注入）。这里**不校验** versionId 是否仍是
 * 最新：那是调用方（session-files 的 handler）的职责 —— 它要先确认「用户审阅的
 * 这一版仍是文件当前的最新改动」，否则会把旧版本标成已阅而新改动被静默跳过。
 */
function markReviewed(state, key, versionId, at = Date.now()) {
  const files = isPlainObject(state?.files) ? state.files : {};
  return { files: { ...files, [key]: { versionId, at } } };
}

/**
 * 撤销一条「已阅」（**纯函数**，**不改入参**，返回新 state）。
 *
 * 为什么需要它：「标记已阅」是一次误点就会把变更从队列里拿走的动作，而队列的
 * 价值全在「我确认过」这句话上 —— 没有回退通道，用户只能靠还原文件才能把它
 * 弄回待审阅，那是用破坏性的动作修一个非破坏性的误操作。这里只删标记，
 * 不碰版本存储、不碰目标文件。
 */
function unmarkReviewed(state, key) {
  const files = isPlainObject(state?.files) ? state.files : {};
  if (!Object.prototype.hasOwnProperty.call(files, key)) return { files: { ...files } };
  const next = { ...files };
  delete next[key];
  return { files: next };
}

/**
 * 读一条变更的「改前 / 现在」并算 diff（design.md §2 的 `review:read`）。
 *
 * 入参 `{ key, versionId, versionsDir?, maxBytes? }`。返回：
 *   `{ ok:true, hunks, before, after, added, removed, truncated }`
 *   或 `{ ok:false, reason }`，reason ∈ unknown / no-such-version / missing /
 *   binary / too-large / no-after / symlink。
 *
 * `truncated:true` 表示 diff 触顶了 `DIFF_CELL_BUDGET`（`computeLineDiff` 只给
 * 增删行数、不给 `diff`）：界面必须降级为「改动过大，只给行数」，**不能**把空
 * hunks 显示成「没有改动」。
 */
function readReviewDiff(input = {}) {
  const key = typeof input.key === "string" ? input.key : "";
  const versionId = typeof input.versionId === "string" ? input.versionId : "";
  const dir = input.versionsDir ?? versionsDir();
  const maxBytes = typeof input.maxBytes === "number" && Number.isFinite(input.maxBytes) && input.maxBytes > 0
    ? input.maxBytes
    : REVIEW_MAX_BYTES;

  const before = readVersionContent(key, versionId, { dir });
  if (!before.ok) return { ok: false, reason: before.reason };

  const file = readVersionFile(key, { dir });
  if (file === undefined) return { ok: false, reason: "unknown" };

  // lstat 而不是 stat：符号链接**不跟随**。审阅台只该看 Agent 写过的那份文件本身，
  // 跟随链接会把这个页面变成「读链接指向的任意路径」的跳板（design.md §4）。
  let stat;
  try {
    stat = lstatSync(file.path);
  } catch {
    return { ok: false, reason: "no-after" };
  }
  if (stat.isSymbolicLink()) return { ok: false, reason: "symlink" };
  if (!stat.isFile()) return { ok: false, reason: "no-after" };
  if (stat.size > maxBytes) return { ok: false, reason: "too-large" };

  let after;
  try {
    after = readFileSync(file.path, "utf8");
  } catch {
    return { ok: false, reason: "no-after" };
  }
  // 与 versions 用同一个判据（looksBinary 读前 8 KiB 找 NUL），不另写一套。
  if (looksBinary(after)) return { ok: false, reason: "binary" };

  const diff = computeLineDiff(before.content, after);
  // diff === undefined = 行数乘积超过 DIFF_CELL_BUDGET；"" = 两版逐行相同。
  const truncated = typeof diff.diff !== "string";
  return {
    ok: true,
    hunks: typeof diff.diff === "string" ? diff.diff : "",
    before: before.content,
    after,
    added: diff.added,
    removed: diff.removed,
    truncated,
  };
}

export {
  REVIEW_MAX_BYTES,
  REVIEW_STATE_FILE,
  buildReviewEntries,
  isReviewed,
  markReviewed,
  readReviewDiff,
  readReviewState,
  reviewStatePath,
  unmarkReviewed,
  writeReviewState,
};
