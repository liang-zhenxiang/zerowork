/**
 * 文件时光机：把 Agent 用 write / edit 工具**覆盖过**的文件，留下「改动前的那一版」。
 *
 * ## 为什么是独立模块（与 library.js / session-digest.js 同一套理由）
 *
 * `session-files.js` 在模块顶层就 `requireParentPort()` 并 `loadResources()`，
 * 在 Electron utilityProcess 之外根本 import 不了 —— 把存储逻辑放那里等于放弃单测。
 * 这里**不 import Electron**（只碰 node:fs / node:crypto / 本目录的 config-paths、audit），
 * 于是 vitest 能直接 import 这个模块，用临时目录把记录判据、裁剪、还原一路钉死。
 *
 * ## 布局（design.md §2）
 *
 *   <config>/versions/
 *     <key>/                              key = sha1(绝对路径) 前 16 位 hex
 *       meta.json                         { path, skipped, versions: [ { id, at, size, ... } ] }
 *       <id>.txt                          该版本的正文（UTF-8 原文）
 *
 * `versions` **旧→新**排序（与时间轴渲染方向一致）。`meta.json` 走「临时文件 + rename」
 * 原子落盘（与 pin.js / projects.js 同款手法）；坏 meta 一律当「这个文件没有历史」——
 * 最坏后果是丢那个文件的版本，不影响其它文件，也不抛错。
 *
 * **不 import Electron、不碰会话桶**：记录时机由 session-host 在成功回执处驱动；
 * 「会话在跑就拒绝还原」由 session-files 通过 `restoreVersion` 的 `isSessionRunning`
 * 选项注入（会话桶在那一层）。本模块因此可以被单测直接调用。
 *
 * ## 四个硬边界（写死在常量里并导出，便于单测钉住）
 *
 *   VERSION_MAX_PER_FILE  20      超出丢**最旧**的（连内容文件一起删）
 *   VERSION_MAX_BYTES     1 MiB   旧内容超过它**整条跳过**，meta.skipped +1
 *   VERSION_BINARY_SNIFF  8 KiB   前 8 KiB 含 NUL 判为二进制，整条跳过
 *   VERSION_LIST_MAX_FILES 200    清单上限，超出置 truncated:true（界面必须说出来）
 *
 * `skipped` 让界面能说「这个文件有 N 次改动没留下版本」——不静默吞掉，与 library.js
 * 的 `truncated` 是同一族做法（本仓库对「静默丢东西」有明确纪律，见 AGENTS.md）。
 */
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { versionsDir } from "./config-paths.js";
import { clipAuditDetail, formatAuditTime } from "./audit.js";

/** 单文件历史上限：超出丢最旧的（含删内容文件）。 */
const VERSION_MAX_PER_FILE = 20;

/** 单版体积上限（字节）：旧内容超过它整条跳过（不假装记下了）。 */
const VERSION_MAX_BYTES = 1024 * 1024;

/** 二进制嗅探窗口（字节）：前这么多字节里出现 NUL 就判为二进制。 */
const VERSION_BINARY_SNIFF = 8 * 1024;

/** 清单上限：超出的文件不返回，置 truncated:true。 */
const VERSION_LIST_MAX_FILES = 200;

const META_FILE = "meta.json";
const CONTENT_EXT = ".txt";
const KEY_RE = /^[0-9a-f]{16}$/;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 绝对路径 → key（sha1 前 16 位 hex）。先 resolve 归一，好让同义写法只占一条。 */
function versionKeyOf(path) {
  return createHash("sha1").update(path).digest("hex").slice(0, 16);
}

/**
 * 是否该为这次工具调用记一版（**纯函数**，session-host 在成功回执处调）。
 *
 * 为什么要这一层：记录时机是设计里最容易写错的一处 —— 在「开始」处记录会把
 * 失败/被拦截的写入也记成版本（文件根本没变，是一条**假版本**），新建文件也没有
 * 旧内容可留。判据（design.md §3.2）：工具**成功**（outcome === "ok"）且是
 * **覆盖**（changeType === "modified"）。
 *
 * 抽成导出的纯函数，正是为了让「成功才记 / 新建不记」能被单测直接钉住
 * （session-host 依赖 Electron，单测够不到）。
 */
function shouldRecordVersion(input) {
  if (!isPlainObject(input)) return false;
  return input.outcome === "ok" && input.changeType === "modified";
}

/** 目标文件的绝对路径 → 该文件的版本目录。 */
function versionDirOf(absPath, dir) {
  return join(dir, versionKeyOf(absPath));
}

function contentPathOf(fileDir, id) {
  return join(fileDir, `${id}${CONTENT_EXT}`);
}

function exists(path) {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

/** 校验单条版本条目（形态不对返回 undefined，跳过它自己、不作废整份 meta）。 */
function parseVersion(raw) {
  if (!isPlainObject(raw)) return undefined;
  if (typeof raw.id !== "string" || raw.id === "") return undefined;
  if (typeof raw.at !== "number" || !Number.isFinite(raw.at)) return undefined;
  const entry = { id: raw.id, at: raw.at, size: typeof raw.size === "number" && Number.isFinite(raw.size) ? raw.size : 0 };
  if (typeof raw.sessionId === "string" && raw.sessionId !== "") entry.sessionId = raw.sessionId;
  if (typeof raw.tool === "string" && raw.tool !== "") entry.tool = raw.tool;
  if (typeof raw.added === "number" && Number.isFinite(raw.added)) entry.added = raw.added;
  if (typeof raw.removed === "number" && Number.isFinite(raw.removed)) entry.removed = raw.removed;
  return entry;
}

/**
 * 读一个版本目录的 meta（**IO 层**）。
 *
 * 返回 `{ path, skipped, versions: [...] }`；文件不存在 / JSON 损坏 / 顶层结构不符
 * 一律返回 `undefined`（= 这个文件没有可用的历史）。单条坏条目丢掉它自己，其余照常。
 */
function readMeta(fileDir) {
  let raw;
  try {
    raw = readFileSync(join(fileDir, META_FILE), "utf8");
  } catch {
    return undefined;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed)) return undefined;
  if (typeof parsed.path !== "string" || parsed.path === "") return undefined;
  const versions = [];
  const list = Array.isArray(parsed.versions) ? parsed.versions : [];
  for (const item of list) {
    const entry = parseVersion(item);
    if (entry !== undefined) versions.push(entry);
  }
  const skipped = typeof parsed.skipped === "number" && Number.isFinite(parsed.skipped) && parsed.skipped >= 0 ? parsed.skipped : 0;
  return { path: parsed.path, skipped, versions };
}

/** meta 原子落盘（临时文件 + rename，与 pin.js / projects.js 同款）。 */
function writeMeta(fileDir, meta) {
  mkdirSync(fileDir, { recursive: true });
  const tmp = join(fileDir, `${META_FILE}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  renameSync(tmp, join(fileDir, META_FILE));
}

/** 同一毫秒内重复时把 id 递增到不冲突为止（design.md §2）。 */
function nextVersionId(versions, at) {
  const used = new Set(versions.map((v) => v.id));
  let id = String(at);
  let bump = 0;
  while (used.has(id)) {
    bump += 1;
    id = String(at + bump);
  }
  return id;
}

/** 前 VERSION_BINARY_SNIFF 个字符里出现 NUL 即判为二进制。 */
function looksBinary(content) {
  const head = content.length > VERSION_BINARY_SNIFF ? content.slice(0, VERSION_BINARY_SNIFF) : content;
  return head.includes("\0");
}

function byteLength(content) {
  return Buffer.byteLength(content, "utf8");
}

/**
 * 记一版「改动前内容」。
 *
 * 入参：`{ path, content, at, sessionId, tool, added, removed }`。返回
 * `{ recorded, skipped, reason? }`（**不抛**：记录失败不能打断 Agent 的运行）。
 *
 * 边界行为：
 * - 二进制 / 超 1 MiB → **不落内容**，`meta.skipped` +1，返回 `skipped:true`；
 * - 超出 20 版 → 丢最旧的（连内容文件一起删）；
 * - 坏 meta → 当「这个文件没有历史」，从头开始，不抛。
 */
function recordVersion(input, options = {}) {
  try {
    if (!isPlainObject(input)) return { recorded: false, skipped: false, reason: "bad-input" };
    if (typeof input.path !== "string" || input.path === "") {
      return { recorded: false, skipped: false, reason: "no-path" };
    }
    if (typeof input.content !== "string") {
      return { recorded: false, skipped: false, reason: "no-content" };
    }
    const dir = options.dir ?? versionsDir();
    const absPath = resolve(input.path);
    const fileDir = versionDirOf(absPath, dir);
    // 坏 meta 当空（与 pin.js / projects.js 同口径）：最坏后果是丢这个文件的历史。
    const meta = readMeta(fileDir) ?? { path: absPath, skipped: 0, versions: [] };
    meta.path = absPath;

    if (looksBinary(input.content)) {
      meta.skipped += 1;
      writeMeta(fileDir, meta);
      return { recorded: false, skipped: true, reason: "binary", count: meta.versions.length };
    }
    const size = byteLength(input.content);
    if (size > VERSION_MAX_BYTES) {
      meta.skipped += 1;
      writeMeta(fileDir, meta);
      return { recorded: false, skipped: true, reason: "too-large", size, count: meta.versions.length };
    }

    const at = typeof input.at === "number" && Number.isFinite(input.at) ? input.at : Date.now();
    const id = nextVersionId(meta.versions, at);
    mkdirSync(fileDir, { recursive: true });
    // 内容先落、meta 后落：反过来的话崩溃会留下「meta 指向不存在的内容文件」。
    writeFileSync(contentPathOf(fileDir, id), input.content, "utf8");
    const entry = { id, at, size };
    if (typeof input.sessionId === "string" && input.sessionId !== "") entry.sessionId = input.sessionId;
    if (typeof input.tool === "string" && input.tool !== "") entry.tool = input.tool;
    if (typeof input.added === "number" && Number.isFinite(input.added)) entry.added = input.added;
    if (typeof input.removed === "number" && Number.isFinite(input.removed)) entry.removed = input.removed;
    meta.versions.push(entry);

    const dropped = [];
    while (meta.versions.length > VERSION_MAX_PER_FILE) dropped.push(meta.versions.shift());
    writeMeta(fileDir, meta);
    // meta 已经不再引用它们，这时才删内容文件 —— 崩在中间也不会丢「仍被引用」的版本。
    for (const stale of dropped) {
      try {
        rmSync(contentPathOf(fileDir, stale.id), { force: true });
      } catch {
        // 删不掉旧内容文件不影响新版本已成立；下一次裁剪会再试。
      }
    }
    return { recorded: true, skipped: false, id, at, count: meta.versions.length, dropped: dropped.length };
  } catch (error) {
    return { recorded: false, skipped: false, reason: "io-error", message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 聚合清单（**按最后改动时间倒序**，design.md §3.1 的 FileEntry）。
 *
 * 目录不存在 → 空清单（空态，不是错误）；坏 meta 的文件整条跳过，不影响别的文件；
 * 超过 VERSION_LIST_MAX_FILES → 只留最近的这么多个并置 truncated:true。
 */
function listVersionFiles(options = {}) {
  const dir = options.dir ?? versionsDir();
  let dirents;
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return { files: [], truncated: false };
  }
  const files = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory() || !KEY_RE.test(dirent.name)) continue;
    const meta = readMeta(join(dir, dirent.name));
    if (meta === undefined) continue;
    const last = meta.versions.length > 0 ? meta.versions[meta.versions.length - 1] : undefined;
    const entry = {
      key: dirent.name,
      path: meta.path,
      name: basename(meta.path),
      dir: dirname(meta.path),
      count: meta.versions.length,
      skipped: meta.skipped,
      lastAt: last === undefined ? 0 : last.at,
      exists: exists(meta.path),
    };
    if (last !== undefined && last.sessionId !== undefined) entry.lastSessionId = last.sessionId;
    if (last !== undefined && last.tool !== undefined) entry.lastTool = last.tool;
    // 变更审阅台（review.js）需要「最近这次改动」的完整描述才能列队：版本 id 用来
    // 判定「已阅的到底是哪一版」，at 用来排序，tool / sessionId / 行数变化直接展示。
    // **只增字段**：上面的既有字段（含 lastAt / lastTool / lastSessionId）一个都不动，
    // 文件历史页还在读它们。
    if (last !== undefined) {
      entry.versionId = last.id;
      entry.at = last.at;
      if (last.tool !== undefined) entry.tool = last.tool;
      if (last.sessionId !== undefined) entry.sessionId = last.sessionId;
      if (last.added !== undefined) entry.added = last.added;
      if (last.removed !== undefined) entry.removed = last.removed;
    }
    files.push(entry);
  }
  files.sort((a, b) => b.lastAt - a.lastAt);
  const truncated = files.length > VERSION_LIST_MAX_FILES;
  return { files: truncated ? files.slice(0, VERSION_LIST_MAX_FILES) : files, truncated };
}

/**
 * 读一个文件的版本元数据 + 全部版本条目。
 *
 * key 不存在 / meta 损坏 → `undefined`；某版正文文件缺失时给该版标 `broken:true`，
 * 其余版本照常返回（单条坏数据不整体失败）。
 */
function readVersionFile(key, options = {}) {
  if (typeof key !== "string" || !KEY_RE.test(key)) return undefined;
  const dir = options.dir ?? versionsDir();
  const fileDir = join(dir, key);
  const meta = readMeta(fileDir);
  if (meta === undefined) return undefined;
  const versions = meta.versions.map((entry) => ({
    ...entry,
    broken: !exists(contentPathOf(fileDir, entry.id)),
  }));
  return { key, path: meta.path, skipped: meta.skipped, versions };
}

/**
 * 读某一版的正文。
 *
 * 返回 `{ ok:true, content, at }` 或 `{ ok:false, reason }`，reason ∈
 * `"unknown" | "no-such-version" | "missing"`。失败用返回值表达、不 reject
 * （与 forkSession 的 branchFail 同族）。
 */
function readVersionContent(key, id, options = {}) {
  if (typeof key !== "string" || !KEY_RE.test(key)) return { ok: false, reason: "unknown" };
  if (typeof id !== "string" || id === "") return { ok: false, reason: "no-such-version" };
  const dir = options.dir ?? versionsDir();
  const fileDir = join(dir, key);
  const meta = readMeta(fileDir);
  if (meta === undefined) return { ok: false, reason: "unknown" };
  const entry = meta.versions.find((v) => v.id === id);
  if (entry === undefined) return { ok: false, reason: "no-such-version" };
  try {
    return { ok: true, content: readFileSync(contentPathOf(fileDir, id), "utf8"), at: entry.at };
  } catch {
    return { ok: false, reason: "missing" };
  }
}

/** 还原失败：统一形态，reason 是 design.md §3.1 的闭集。 */
function restoreFail(reason, message) {
  return { ok: false, reason, message };
}

/**
 * 还原到某一版（design.md §3.3 / §3.4）。
 *
 * 拒绝判据（任一命中即返回 `{ ok:false, reason, message }`，**不抛**）：
 *   - key 不在存储里 / id 不在 meta 里 → `no-such-version`（key 未知归 `unknown`）
 *   - 目标版本正文文件不存在或读失败 → `missing`，带逃生指引
 *   - 该文件最近一条版本所属会话**正在运行** → `running`（判据由 session-files 注入）
 *   - 写盘失败 → `write-failed`，带原始错误摘要
 *
 * 还原本身也留一版：**先读当前磁盘内容**存成一条新版本（`tool:"restore"`），
 * 再写回目标版本（「先留后改」，与「落盘先于界面更新」同一纪律）。当前内容与
 * 目标版本逐字节相同时不写新版本，返回 `unchanged:true`，此时**不写审计**（没
 * 发生任何改动，那句「当前内容已先存为新版本」会是不实信息）。
 *
 * 审计走 `options.onAudit`（默认 no-op）——沿用 command-exec / background-jobs
 * 注入 `writeAuditRecord` 的既有模式，本模块因此不 import 会话桶、也不写日志文件。
 */
function restoreVersion(key, id, options = {}) {
  if (typeof key !== "string" || !KEY_RE.test(key)) {
    return restoreFail("unknown", "这个文件的版本记录不在（可能已被清理）。");
  }
  if (typeof id !== "string" || id === "") {
    return restoreFail("no-such-version", "没有指定要还原到哪一版。");
  }
  const dir = options.dir ?? versionsDir();
  const fileDir = join(dir, key);
  const meta = readMeta(fileDir);
  if (meta === undefined) {
    return restoreFail("unknown", "这个文件的版本记录不在（可能已被清理）。");
  }
  const target = meta.versions.find((v) => v.id === id);
  if (target === undefined) {
    return restoreFail("no-such-version", `这一版（${id}）不在历史里。`);
  }
  let targetContent;
  try {
    targetContent = readFileSync(contentPathOf(fileDir, id), "utf8");
  } catch {
    return restoreFail("missing", "这一版的内容文件已经不在磁盘上了，无法还原。可以挑更早或更晚的一版试试。");
  }

  // 会话在跑就拒绝 —— 判据由 session-files 注入（会话桶在那一层，本模块不碰）。
  const recentSessionId = meta.versions.length > 0 ? meta.versions[meta.versions.length - 1].sessionId : undefined;
  if (
    typeof options.isSessionRunning === "function" &&
    typeof recentSessionId === "string" &&
    recentSessionId !== "" &&
    options.isSessionRunning(recentSessionId) === true
  ) {
    return restoreFail("running", "这条文件所属的会话正在运行，等它跑完再还原，避免与正在进行的写入打架。");
  }

  let currentContent;
  try {
    currentContent = readFileSync(meta.path, "utf8");
  } catch {
    currentContent = undefined; // 文件已被删除：还原会重新创建它（design.md §5）。
  }

  const identical = typeof currentContent === "string" && currentContent === targetContent;

  if (!identical) {
    // 先留后改：当前内容先存成一条新版本，再写回目标版本。
    if (typeof currentContent === "string") {
      recordVersion(
        { path: meta.path, content: currentContent, at: Date.now(), sessionId: recentSessionId, tool: "restore" },
        { dir },
      );
    }
    try {
      mkdirSync(dirname(meta.path), { recursive: true });
      writeFileSync(meta.path, targetContent, "utf8");
    } catch (error) {
      return restoreFail("write-failed", `写入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!identical && typeof options.onAudit === "function") {
    const name = basename(meta.path);
    const when = formatAuditTime(target.at);
    const detail =
      typeof currentContent === "string"
        ? `用户把 ${name} 还原到 ${when}：当前内容已先存为一条新版本`
        : `用户把 ${name} 还原到 ${when}：文件此前已不在，已按该版本重新创建`;
    options.onAudit({ category: "file", outcome: "restored", detail: clipAuditDetail(detail) });
  }

  const after = readVersionFile(key, { dir });
  return {
    ok: true,
    at: target.at,
    unchanged: identical,
    versions: after === undefined ? [] : after.versions,
  };
}

export {
  VERSION_BINARY_SNIFF,
  VERSION_LIST_MAX_FILES,
  VERSION_MAX_BYTES,
  VERSION_MAX_PER_FILE,
  // 变更审阅台读「当前磁盘文件」时复用同一个二进制判据（前 8 KiB 含 NUL），
  // 不能各写一套 —— 两处判据一旦分叉，同一个文件会在两个页面里有两种说法。
  looksBinary,
  listVersionFiles,
  readVersionContent,
  readVersionFile,
  recordVersion,
  restoreVersion,
  shouldRecordVersion,
  versionKeyOf,
};
