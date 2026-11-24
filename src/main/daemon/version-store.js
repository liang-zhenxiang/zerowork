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
 *       <id>.txt                          文本版本的正文（UTF-8 原文）
 *       <id>.bin                          二进制版本的原文（docx / zip 等，逐字节）
 *
 * `versions` **旧→新**排序（与时间轴渲染方向一致）。`meta.json` 走「临时文件 + rename」
 * 原子落盘（与 pin.js / projects.js 同款手法）；坏 meta 一律当「这个文件没有历史」——
 * 最坏后果是丢那个文件的版本，不影响其它文件，也不抛错。
 *
 * **不 import Electron、不碰会话桶**：记录时机由 session-host 在成功回执处驱动；
 * 「会话在跑就拒绝还原」由 session-files 通过 `restoreVersion` 的 `isSessionRunning`
 * 选项注入（会话桶在那一层）。本模块因此可以被单测直接调用。
 *
 * ## 两条记录通道（不混类型）
 *
 *   recordVersion        文本（`content` 是 string），沿用「前 8 KiB 含 NUL 判二进制」跳过
 *   recordBinaryVersion  二进制（`bytes` 是 Buffer / Uint8Array），逐字节保存
 *
 * 二进制 meta 带 `binary:true` 与 `sha256`；**旧 meta 没有 binary 字段一律按文本读**
 * （向后兼容），内容文件仍是 `<id>.txt`。文本 diff（review.js）只认文本：二进制版本
 * 由 `readVersionContent` 返回 `reason:"binary"`，不进文本预览。
 *
 * ## 五个硬边界（写死在常量里并导出，便于单测钉住）
 *
 *   VERSION_MAX_PER_FILE      20      超出丢**最旧**的（连内容文件一起删）
 *   VERSION_MAX_BYTES         1 MiB   文本旧内容超过它**整条跳过**，meta.skipped +1
 *   VERSION_MAX_BINARY_BYTES  20 MiB  二进制旧内容超过它**整条跳过**，meta.skipped +1
 *   VERSION_BINARY_SNIFF      8 KiB   文本通道：前 8 KiB 含 NUL 判为二进制，整条跳过
 *   VERSION_LIST_MAX_FILES    200     清单上限，超出置 truncated:true（界面必须说出来）
 *
 * `skipped` 让界面能说「这个文件有 N 次改动没留下版本」——不静默吞掉，与 library.js
 * 的 `truncated` 是同一族做法（本仓库对「静默丢东西」有明确纪律，见 AGENTS.md）。
 */
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { versionsDir } from "./config-paths.js";
import { clipAuditDetail, formatAuditTime } from "./audit.js";

/** 单文件历史上限：超出丢最旧的（含删内容文件）。 */
const VERSION_MAX_PER_FILE = 20;

/** 单版体积上限（字节）：文本旧内容超过它整条跳过（不假装记下了）。 */
const VERSION_MAX_BYTES = 1024 * 1024;

/** 单版体积上限（字节）：二进制（docx / zip）内容超过它整条跳过。 */
const VERSION_MAX_BINARY_BYTES = 20 * 1024 * 1024;

/** 二进制嗅探窗口（字节）：前这么多字节里出现 NUL 就判为二进制。 */
const VERSION_BINARY_SNIFF = 8 * 1024;

/** 清单上限：超出的文件不返回，置 truncated:true。 */
const VERSION_LIST_MAX_FILES = 200;

const META_FILE = "meta.json";
const TEXT_CONTENT_EXT = ".txt";
const BINARY_CONTENT_EXT = ".bin";
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

function contentPathOf(fileDir, id, binary = false) {
  return join(fileDir, `${id}${binary ? BINARY_CONTENT_EXT : TEXT_CONTENT_EXT}`);
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
  // 旧 meta 没有 binary 字段 = 文本版本（向后兼容）。只有显式 true 才算二进制，
  // 免得 `binary:"true"` 这类脏值把内容扩展名指到 .bin 上去。
  if (raw.binary === true) entry.binary = true;
  if (typeof raw.sha256 === "string" && /^[0-9a-f]{64}$/.test(raw.sha256)) entry.sha256 = raw.sha256;
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

/** 字节版的同一判据（还原时判断「当前磁盘内容该走哪条记录通道」）。 */
function bufferLooksBinary(buffer) {
  const end = Math.min(buffer.length, VERSION_BINARY_SNIFF);
  for (let i = 0; i < end; i += 1) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function byteLength(content) {
  return Buffer.byteLength(content, "utf8");
}

/** Buffer / Uint8Array → Buffer；其它形态返回 undefined（recordBinaryVersion 入参校验）。 */
function toBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return undefined;
}

function sha256OfBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 跳过一条记录：`meta.skipped` +1 并落 meta（不留下半条版本）。
 *
 * 为什么连「没记成」都要落盘：界面据此说「这个文件有 N 次改动没留下版本」——
 * 静默吞掉会让用户以为文件从没被改过（与 library.js 的 truncated 同一纪律）。
 */
function skipVersion(dir, absPath, reason, extra = {}) {
  const fileDir = versionDirOf(absPath, dir);
  // 坏 meta 当空（与 pin.js / projects.js 同口径）：最坏后果是丢这个文件的历史。
  const meta = readMeta(fileDir) ?? { path: absPath, skipped: 0, versions: [] };
  meta.path = absPath;
  meta.skipped += 1;
  writeMeta(fileDir, meta);
  return { recorded: false, skipped: true, reason, count: meta.versions.length, ...extra };
}

/**
 * 把一条已通过校验/上限检查的版本写进存储（文本与二进制共用）。
 *
 * `payload` 是 string（文本，按 UTF-8 写）或 Buffer（二进制，逐字节写）。
 * 顺序固定：**内容先落、meta 后落** —— 反过来的话崩溃会留下「meta 指向不存在的内容文件」。
 * 裁剪时先写 meta 再删旧内容文件，崩在中间也不会丢「仍被引用」的版本。
 */
function commitVersion({ dir, absPath, at, size, binary, payload, from }) {
  const fileDir = versionDirOf(absPath, dir);
  const meta = readMeta(fileDir) ?? { path: absPath, skipped: 0, versions: [] };
  meta.path = absPath;
  const id = nextVersionId(meta.versions, at);
  mkdirSync(fileDir, { recursive: true });
  if (binary) writeFileSync(contentPathOf(fileDir, id, true), payload);
  else writeFileSync(contentPathOf(fileDir, id, false), payload, "utf8");
  const entry = { id, at, size };
  if (binary) {
    entry.binary = true;
    entry.sha256 = sha256OfBytes(payload);
  }
  if (typeof from.sessionId === "string" && from.sessionId !== "") entry.sessionId = from.sessionId;
  if (typeof from.tool === "string" && from.tool !== "") entry.tool = from.tool;
  if (typeof from.added === "number" && Number.isFinite(from.added)) entry.added = from.added;
  if (typeof from.removed === "number" && Number.isFinite(from.removed)) entry.removed = from.removed;
  meta.versions.push(entry);

  const dropped = [];
  while (meta.versions.length > VERSION_MAX_PER_FILE) dropped.push(meta.versions.shift());
  writeMeta(fileDir, meta);
  // meta 已经不再引用它们，这时才删内容文件 —— 崩在中间也不会丢「仍被引用」的版本。
  for (const stale of dropped) {
    try {
      rmSync(contentPathOf(fileDir, stale.id, stale.binary === true), { force: true });
    } catch {
      // 删不掉旧内容文件不影响新版本已成立；下一次裁剪会再试。
    }
  }
  return { recorded: true, skipped: false, id, at, count: meta.versions.length, dropped: dropped.length };
}

/**
 * 记一版「改动前内容」（**文本通道**）。
 *
 * 入参：`{ path, content, at, sessionId, tool, added, removed }`。返回
 * `{ recorded, skipped, reason? }`（**不抛**：记录失败不能打断 Agent 的运行）。
 *
 * 边界行为：
 * - 前 8 KiB 含 NUL / 超 1 MiB → **不落内容**，`meta.skipped` +1，返回 `skipped:true`；
 *   二进制请走 `recordBinaryVersion`（显式 API，不把字符串与字节混在一个参数里）；
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
    if (looksBinary(input.content)) return skipVersion(dir, absPath, "binary");
    const size = byteLength(input.content);
    if (size > VERSION_MAX_BYTES) return skipVersion(dir, absPath, "too-large", { size });

    const at = typeof input.at === "number" && Number.isFinite(input.at) ? input.at : Date.now();
    return commitVersion({ dir, absPath, at, size, binary: false, payload: input.content, from: input });
  } catch (error) {
    return { recorded: false, skipped: false, reason: "io-error", message: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 记一版「改动前内容」（**二进制通道**，docx / zip 等）。
 *
 * 入参：`{ path, bytes, at, sessionId, tool, added, removed }`，`bytes` 是 Buffer /
 * Uint8Array（显式分开，避免与文本的 string 混类型）。返回形态与 `recordVersion` 一致。
 *
 * 边界行为：
 * - 超过 `VERSION_MAX_BINARY_BYTES`（20 MiB）→ **不落内容文件**，`meta.skipped` +1；
 * - 超 20 版 → 丢最旧的（连 `.bin` 一起删；`meta.binary` 决定扩展名，混存也不会删错）；
 * - 坏 meta → 当「这个文件没有历史」，从头开始，不抛。
 */
function recordBinaryVersion(input, options = {}) {
  try {
    if (!isPlainObject(input)) return { recorded: false, skipped: false, reason: "bad-input" };
    if (typeof input.path !== "string" || input.path === "") {
      return { recorded: false, skipped: false, reason: "no-path" };
    }
    const bytes = toBytes(input.bytes);
    if (bytes === undefined) return { recorded: false, skipped: false, reason: "no-bytes" };
    const dir = options.dir ?? versionsDir();
    const absPath = resolve(input.path);
    const size = bytes.byteLength;
    if (size > VERSION_MAX_BINARY_BYTES) return skipVersion(dir, absPath, "too-large", { size });

    const at = typeof input.at === "number" && Number.isFinite(input.at) ? input.at : Date.now();
    return commitVersion({ dir, absPath, at, size, binary: true, payload: bytes, from: input });
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
      // 二进制标记（新增字段，文本条目不出现在这里 = 缺省即文本）：界面据此
      // 不为这一条请求文本预览。既有字段一个都不动。
      if (last.binary === true) entry.binary = true;
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
 * 其余版本照常返回（单条坏数据不整体失败）。条目带 `binary:true` 的版本，正文在
 * `<id>.bin`；**旧条目没有该字段 = 文本**，正文在 `<id>.txt`。
 */
function readVersionFile(key, options = {}) {
  if (typeof key !== "string" || !KEY_RE.test(key)) return undefined;
  const dir = options.dir ?? versionsDir();
  const fileDir = join(dir, key);
  const meta = readMeta(fileDir);
  if (meta === undefined) return undefined;
  const versions = meta.versions.map((entry) => ({
    ...entry,
    broken: !exists(contentPathOf(fileDir, entry.id, entry.binary === true)),
  }));
  return { key, path: meta.path, skipped: meta.skipped, versions };
}

/**
 * 读某一版的文本正文（**文本通道**）。
 *
 * 返回 `{ ok:true, content, at }` 或 `{ ok:false, reason }`，reason ∈
 * `"unknown" | "no-such-version" | "missing" | "binary"`。失败用返回值表达、不 reject
 * （与 forkSession 的 branchFail 同族）。
 *
 * **二进制版本一律 `reason:"binary"`**：把 docx 按 UTF-8 解出来的是乱码，
 * 「看起来有内容」比直接说读不了更危险。需要字节请走 `readVersionBytes`。
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
  if (entry.binary === true) return { ok: false, reason: "binary" };
  try {
    return { ok: true, content: readFileSync(contentPathOf(fileDir, id, false), "utf8"), at: entry.at };
  } catch {
    return { ok: false, reason: "missing" };
  }
}

/**
 * 读某一版的原始字节（**二进制通道**；文本版本返回其 UTF-8 字节）。
 *
 * 返回 `{ ok:true, bytes: Buffer, at }` 或 `{ ok:false, reason }`，
 * reason ∈ `"unknown" | "no-such-version" | "missing"`。不做解码 —— 还原写回
 * 依赖的是逐字节一致。
 */
function readVersionBytes(key, id, options = {}) {
  if (typeof key !== "string" || !KEY_RE.test(key)) return { ok: false, reason: "unknown" };
  if (typeof id !== "string" || id === "") return { ok: false, reason: "no-such-version" };
  const dir = options.dir ?? versionsDir();
  const fileDir = join(dir, key);
  const meta = readMeta(fileDir);
  if (meta === undefined) return { ok: false, reason: "unknown" };
  const entry = meta.versions.find((v) => v.id === id);
  if (entry === undefined) return { ok: false, reason: "no-such-version" };
  try {
    return {
      ok: true,
      bytes: readFileSync(contentPathOf(fileDir, id, entry.binary === true)),
      at: entry.at,
    };
  } catch {
    return { ok: false, reason: "missing" };
  }
}

/** 还原失败：统一形态，reason 是 design.md §3.1 的闭集。 */
function restoreFail(reason, message) {
  return { ok: false, reason, message };
}

/**
 * 二进制还原的原子写：同目录临时文件 + rename（与 doc-edits.writeAtomically 同款）。
 *
 * - 临时文件必须与目标**同目录**：跨目录 rename 会退化成复制 + 删除，不再原子；
 * - 目标已存在时沿用它的权限位（`mode & 0o777`）；不存在则用默认权限；
 * - 失败先删临时文件再抛 —— 目标文件保持还原前的样子（写坏一半的只可能是临时文件）。
 */
function writeBytesAtomically(absPath, bytes) {
  const dir = dirname(absPath);
  mkdirSync(dir, { recursive: true });
  let mode;
  try {
    mode = statSync(absPath).mode & 0o777;
  } catch {
    mode = void 0; // 目标不存在：还原会重新创建它，用默认权限。
  }
  const tmp = join(dir, `.${basename(absPath)}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, bytes, mode === void 0 ? void 0 : { mode });
    renameSync(tmp, absPath);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // 临时文件删不掉不影响「目标文件没被改」这个事实；下次写入用自己的临时名。
    }
    throw error;
  }
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
 * **按 `meta.binary` 分支**：二进制版本读 `<id>.bin` 的字节，写回走
 * 「同目录临时文件 + rename」（保留原 mode，失败不破坏当前文件）；文本版本沿用
 * 原来的 utf8 读写路径。旧条目没有 `binary` 字段 = 文本（向后兼容）。
 *
 * 还原本身也留一版：**先读当前磁盘内容**存成一条新版本（`tool:"restore"`），
 * 再写回目标版本（「先留后改」，与「落盘先于界面更新」同一纪律）。当前内容与
 * 目标版本逐字节相同时不写新版本，返回 `unchanged:true`，此时**不写审计**（没
 * 发生任何改动，那句「当前内容已先存为新版本」会是不实信息）。
 *
 * 当前内容的记录通道按**内容本身**判：目标版本是二进制或当前文件前 8 KiB 含 NUL
 * 就走 `recordBinaryVersion`（逐字节），否则走 `recordVersion`。只在目标类型上判
 * 会在「文件从文本变成 docx」时把当前内容按 UTF-8 解成乱码再当文本存 —— 那样的
 * 版本退不回去，等于没有留。
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
  const targetBinary = target.binary === true;
  let targetContent;
  let targetBytes;
  try {
    if (targetBinary) targetBytes = readFileSync(contentPathOf(fileDir, id, true));
    else targetContent = readFileSync(contentPathOf(fileDir, id, false), "utf8");
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

  let currentBytes;
  try {
    currentBytes = readFileSync(meta.path);
  } catch {
    currentBytes = undefined; // 文件已被删除：还原会重新创建它（design.md §5）。
  }

  const identical = currentBytes !== undefined && (
    targetBinary ? currentBytes.equals(targetBytes) : currentBytes.toString("utf8") === targetContent
  );

  if (!identical) {
    // 先留后改：当前内容先存成一条新版本，再写回目标版本。
    if (currentBytes !== undefined) {
      const at = Date.now();
      if (targetBinary || bufferLooksBinary(currentBytes)) {
        recordBinaryVersion(
          { path: meta.path, bytes: currentBytes, at, sessionId: recentSessionId, tool: "restore" },
          { dir },
        );
      } else {
        recordVersion(
          { path: meta.path, content: currentBytes.toString("utf8"), at, sessionId: recentSessionId, tool: "restore" },
          { dir },
        );
      }
    }
    try {
      if (targetBinary) {
        writeBytesAtomically(meta.path, targetBytes);
      } else {
        mkdirSync(dirname(meta.path), { recursive: true });
        writeFileSync(meta.path, targetContent, "utf8");
      }
    } catch (error) {
      return restoreFail("write-failed", `写入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!identical && typeof options.onAudit === "function") {
    const name = basename(meta.path);
    const when = formatAuditTime(target.at);
    const detail =
      currentBytes !== undefined
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
  VERSION_MAX_BINARY_BYTES,
  VERSION_MAX_BYTES,
  VERSION_MAX_PER_FILE,
  // 变更审阅台读「当前磁盘文件」时复用同一个二进制判据（前 8 KiB 含 NUL），
  // 不能各写一套 —— 两处判据一旦分叉，同一个文件会在两个页面里有两种说法。
  looksBinary,
  listVersionFiles,
  readVersionBytes,
  readVersionContent,
  readVersionFile,
  recordBinaryVersion,
  recordVersion,
  restoreVersion,
  shouldRecordVersion,
  versionKeyOf,
};
