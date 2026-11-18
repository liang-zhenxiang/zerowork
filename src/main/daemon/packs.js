/**
 * 能力包（zerowork-pack v1）：校验、预览、安装、卸载、列表与导出。
 *
 * ## 为什么单独一个模块
 *
 * `session-files.js` 已经是大文件，能力包是一整块新能力（格式 + 安全边界 +
 * 五个操作），塞进去只会让「改 A 误伤 B」更难排查。本模块只依赖
 * `experts.js`（复用全部专家规则）与 `config-paths.js`，没有顶层跨模块副作用
 * （daemon 的初始化顺序纪律见 `.trellis/spec/daemon/index.md`）。
 *
 * ## 安全边界（与 GUI 无关，全部在这里）
 *
 * - **不执行包内任何代码**：只接受扩展名白名单内的声明式内容；
 * - 拒绝绝对路径、`..`、盘符、NUL、反斜杠分隔、Windows 非法字符；
 * - 拒绝符号链接、隐藏条目、超出文件数 / 单文件 / 总体积上限的包；
 * - zip 先按声明大小预检（防 zip bomb），解压后再按实际字节复核；
 * - 校验一律在 staging 目录或只读遍历上做，失败不碰安装目录；
 * - 连接器只做声明，**绝不写 mcp.json**，也不携带任何凭据。
 *
 * ## 失败形态
 *
 * 对外一律返回 `{ ok: false, errors: [{ code, message, file? }] }` —— 调用方
 * （渲染层）要能逐条显示「哪个文件、哪条规则、怎么修」，而不是一句「导入失败」。
 */
import { createHash } from "node:crypto";
import { copyFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { lstatSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { readdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import { renameSync } from "node:fs";
import { rmSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { dirname } from "node:path";
import { extname } from "node:path";
import { join } from "node:path";
import { relative } from "node:path";
import { resolve } from "node:path";
import { sep } from "node:path";
import JSZip from "jszip";
import { getAppDir, getBuiltinSkillDirs, getConfigDir, getResourcesDir } from "./config-paths.js";
import {
  EXPERT_FILE,
  loadAgents,
  loadExpertDir,
  loadExperts,
  parseFrontmatter,
  reasonOf,
} from "./experts.js";

export const PACK_FORMAT = "zerowork-pack";
export const PACK_FORMAT_VERSION = 1;
export const PACK_META_FILE = "_pack.json";

/** 安全上限。数值本身是产品决定：一个「专家 + 几个技能」远到不了这些值。 */
export const PACK_MAX_ENTRIES = 200;
export const PACK_MAX_FILE_BYTES = 1024 * 1024;
export const PACK_MAX_TOTAL_BYTES = 5 * 1024 * 1024;

/** 只允许声明式内容与图片；任何脚本 / 可执行文件都不在名单里。 */
export const PACK_ALLOWED_EXTENSIONS = new Set([
  ".md",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".pdf"
]);

/** 顶层只允许这五项；`prompts/` 单独给「v1 不支持」的提示。 */
const TOP_LEVEL_ALLOWED = new Set(["manifest.json", "expert.md", "README.md", "skills", "agents"]);

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
/**
 * 单个路径段里不允许出现的字符。
 *
 * `:` 单独列出来是因为 Windows 上文件名不能含冒号；`*?"<>|` 同理。
 * 这些字符在 zip 里可以存在（zip 规范不限制），解压到 Windows 才会失败 ——
 * 与其在用户机器上报一个 `EINVAL`，不如在预览阶段就说清楚。
 */
const ILLEGAL_SEGMENT_CHARS = /[\u0000-\u001f<>:"|?*]/;
/** Windows 保留设备名（带扩展名也算：`con.md` 打不开）。 */
const WINDOWS_RESERVED = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9"
]);

/** 带 code 的校验错误。用异常在递归遍历里短路，外层统一翻成结果对象。 */
class PackError extends Error {
  constructor(error) {
    super(error.message);
    this.packError = error;
  }
}

function fail(code, message, file) {
  return new PackError(
    file === undefined ? { code, message } : { code, message, file }
  );
}

function invalidManifest(message) {
  return fail("PACK_MANIFEST_INVALID", message, "manifest.json");
}

function failure(error) {
  const record =
    error instanceof PackError
      ? error.packError
      : { code: "PACK_IO_ERROR", message: reasonOf(error) };
  return { ok: false, errors: [record] };
}

function packsDir() {
  return join(getConfigDir(), "packs");
}

function stagingRoot() {
  return join(getConfigDir(), ".pack-staging");
}

/** 每次操作一个独立 staging 子目录；进程号 + 时间戳 + 随机后缀避免并发撞名。 */
function newStagingDir(prefix) {
  return join(
    stagingRoot(),
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  );
}

function isSafeId(id) {
  if (typeof id !== "string" || id === "" || id.length > 64) return false;
  if (id === "." || id === "..") return false;
  if (id.startsWith(".") || id.endsWith(".") || id.endsWith(" ")) return false;
  if (/[\\/:]/.test(id) || ILLEGAL_SEGMENT_CHARS.test(id)) return false;
  const stem = id.split(".")[0].toLowerCase();
  return !WINDOWS_RESERVED.has(stem);
}

function requireSafeId(id) {
  if (!isSafeId(id)) {
    throw fail(
      "PACK_ID_INVALID",
      `能力包 id「${String(id)}」不是合法的目录名：不能为空、不能含路径分隔符或 Windows 非法字符，且不能以点开头`
    );
  }
  return id;
}

/**
 * 校验并归一化一个包内相对路径。
 *
 * 输入使用 `/` 分隔（zip 规范与 manifest 的写法）；返回去掉首尾 `/` 的路径。
 * 目录条目允许以 `/` 结尾。任何可能导致越界或平台不兼容的形状都在这里拒绝。
 */
function normalizeEntryPath(raw, { directory = false } = {}) {
  if (typeof raw !== "string" || raw === "") {
    throw fail("PACK_PATH_INVALID", "包内路径为空", String(raw));
  }
  if (raw.includes("\0")) throw fail("PACK_PATH_INVALID", "包内路径含 NUL 字符", raw);
  if (raw.includes("\\")) {
    throw fail("PACK_PATH_INVALID", "包内路径必须用 / 分隔，不能使用反斜杠", raw);
  }
  if (raw.startsWith("/")) throw fail("PACK_PATH_INVALID", "包内路径不能是绝对路径", raw);
  if (/^[A-Za-z]:/.test(raw)) throw fail("PACK_PATH_INVALID", "包内路径不能带盘符", raw);
  let trimmed = raw;
  if (directory || trimmed.endsWith("/")) trimmed = trimmed.replace(/\/+$/, "");
  if (trimmed === "") throw fail("PACK_PATH_INVALID", "包内路径为空", raw);
  const segments = trimmed.split("/");
  for (const segment of segments) {
    if (segment === "") throw fail("PACK_PATH_INVALID", "包内路径含空段（连续的 /）", raw);
    if (segment === "." || segment === "..") {
      throw fail("PACK_PATH_INVALID", "包内路径不能包含 . 或 .. 段", raw);
    }
    if (ILLEGAL_SEGMENT_CHARS.test(segment)) {
      throw fail(
        "PACK_PATH_INVALID",
        `包内路径含平台不支持的字符（${segment}）：文件名不能含 < > : " | ? * 或控制字符`,
        raw
      );
    }
    if (segment.startsWith(".")) {
      throw fail("PACK_HIDDEN_ENTRY", "包内不允许隐藏文件或目录（以 . 开头）", raw);
    }
    const stem = segment.split(".")[0].toLowerCase();
    if (WINDOWS_RESERVED.has(stem)) {
      throw fail("PACK_PATH_INVALID", `包内路径使用了 Windows 保留名「${stem}」`, raw);
    }
  }
  return segments.join("/");
}

function requireAllowedExtension(relPath) {
  const ext = extname(relPath).toLowerCase();
  if (!PACK_ALLOWED_EXTENSIONS.has(ext)) {
    throw fail(
      "PACK_EXTENSION_NOT_ALLOWED",
      `不允许的文件类型${ext === "" ? "（没有扩展名）" : `「${ext}」`}：能力包只接受声明式内容与图片`,
      relPath
    );
  }
}

function requireAllowedTopLevel(relPath) {
  const first = relPath.split("/")[0];
  if (first === "prompts") {
    throw fail(
      "PACK_PROMPTS_UNSUPPORTED",
      "能力包 v1 不支持提示词模板（prompts/）：模板是全局命名空间，需要额外的归属与卸载追踪，本轮明确拒绝而不是静默忽略",
      relPath
    );
  }
  if (!TOP_LEVEL_ALLOWED.has(first)) {
    throw fail(
      "PACK_TOP_LEVEL_NOT_ALLOWED",
      `顶层只允许 manifest.json、expert.md、README.md、skills/ 与 agents/，不允许「${first}」`,
      relPath
    );
  }
}

function sha256OfFile(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * 只读遍历一个目录来源，收集并校验全部文件。
 *
 * `exclude` 用于导出：安装目录里的 `_pack.json` 是本地元数据，不属于包内容。
 * 返回的 `byPath` / `byLowerPath` 都指向同一条记录，后者用于大小写不敏感判重。
 */
function walkPackDir(root, options = {}) {
  const exclude = options["exclude"] ?? new Set();
  const skipHidden = options["skipHidden"] === true;
  const files = [];
  let totalBytes = 0;
  const byPath = new Map();
  const byLowerPath = new Map();

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name);
      const rel = relative(root, absolute).split(sep).join("/");
      if (exclude.has(rel)) continue;
      if (entry.name.startsWith(".")) {
        if (skipHidden) continue;
        throw fail(
          "PACK_HIDDEN_ENTRY",
          "包内不允许隐藏文件或目录（以 . 开头）",
          rel
        );
      }
      const info = lstatSync(absolute);
      if (info.isSymbolicLink()) {
        throw fail(
          "PACK_SYMLINK",
          "包内不允许符号链接：链接可能指向包外的任意路径",
          rel
        );
      }
      if (info.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!info.isFile()) {
        throw fail("PACK_PATH_INVALID", "包内只允许普通文件与目录", rel);
      }
      const normalized = normalizeEntryPath(rel);
      requireAllowedTopLevel(normalized);
      requireAllowedExtension(normalized);
      if (info.size > PACK_MAX_FILE_BYTES) {
        throw fail(
          "PACK_FILE_TOO_LARGE",
          `单文件超过上限：${info.size} 字节 > ${PACK_MAX_FILE_BYTES} 字节`,
          normalized
        );
      }
      totalBytes += info.size;
      if (totalBytes > PACK_MAX_TOTAL_BYTES) {
        throw fail(
          "PACK_TOO_LARGE",
          `解压后总体积超过上限：已累计 ${totalBytes} 字节 > ${PACK_MAX_TOTAL_BYTES} 字节`
        );
      }
      if (files.length + 1 > PACK_MAX_ENTRIES) {
        throw fail(
          "PACK_TOO_MANY_FILES",
          `文件数超过上限：${files.length + 1} > ${PACK_MAX_ENTRIES}`
        );
      }
      const record = { path: normalized, size: info.size, absolute };
      const lower = normalized.toLowerCase();
      const clash = byLowerPath.get(lower);
      if (clash !== undefined) {
        throw fail(
          "PACK_PATH_DUPLICATE",
          `包内路径在大小写归一后重复：「${clash.path}」与「${normalized}」（Windows 上会互相覆盖）`,
          normalized
        );
      }
      byPath.set(normalized, record);
      byLowerPath.set(lower, record);
      files.push(record);
    }
  };

  walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, totalBytes, byPath, byLowerPath };
}

function optionalNonEmptyString(record, key) {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidManifest(`字段「${key}」应为非空字符串`);
  }
  return value;
}

function normalizeConnectors(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalidManifest("字段「connectors」应为数组");
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw invalidManifest(`connectors 第 ${index + 1} 条应为对象`);
    }
    const id = item.id;
    if (typeof id !== "string" || id.trim() === "") {
      throw invalidManifest(`connectors 第 ${index + 1} 条缺少字符串字段「id」`);
    }
    const connector = { id };
    if (item.type !== undefined) {
      if (typeof item.type !== "string" || item.type.trim() === "") {
        throw invalidManifest(`connectors 第 ${index + 1} 条的「type」应为非空字符串`);
      }
      connector.type = item.type;
    }
    if (item.description !== undefined) {
      if (typeof item.description !== "string") {
        throw invalidManifest(`connectors 第 ${index + 1} 条的「description」应为字符串`);
      }
      connector.description = item.description;
    }
    return connector;
  });
}

function normalizeFileList(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw invalidManifest("字段「files」应为数组");
  const seen = new Set();
  return value.map((item, index) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw invalidManifest(`files 第 ${index + 1} 条应为对象`);
    }
    if (typeof item.path !== "string") {
      throw invalidManifest(`files 第 ${index + 1} 条缺少字符串字段「path」`);
    }
    const path = normalizeEntryPath(item.path);
    if (typeof item.sha256 !== "string" || !SHA256_PATTERN.test(item.sha256.toLowerCase())) {
      throw invalidManifest(
        `files 第 ${index + 1} 条的「sha256」应为 64 位十六进制字符串（${path}）`
      );
    }
    if (
      typeof item.size !== "number" ||
      !Number.isInteger(item.size) ||
      item.size < 0
    ) {
      throw invalidManifest(`files 第 ${index + 1} 条的「size」应为非负整数（${path}）`);
    }
    const lower = path.toLowerCase();
    if (seen.has(lower)) {
      throw invalidManifest(`files 里路径在大小写归一后重复：${path}`);
    }
    seen.add(lower);
    return { path, sha256: item.sha256.toLowerCase(), size: item.size };
  });
}

function readManifest(root) {
  const file = join(root, "manifest.json");
  if (!existsSync(file)) {
    throw fail(
      "PACK_MANIFEST_MISSING",
      "能力包缺少 manifest.json —— 包根目录必须有这个文件（格式说明见 docs/USAGE.md 的「能力包」一节）",
      "manifest.json"
    );
  }
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw fail(
      "PACK_MANIFEST_INVALID",
      `manifest.json 不是合法 JSON：${reasonOf(error)}`,
      "manifest.json"
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw fail("PACK_MANIFEST_INVALID", "manifest.json 顶层必须是对象", "manifest.json");
  }
  if (raw.format !== PACK_FORMAT) {
    throw fail(
      "PACK_FORMAT_INVALID",
      `manifest.format 应为「${PACK_FORMAT}」，实际是「${String(raw.format)}」`,
      "manifest.json"
    );
  }
  if (raw.formatVersion !== PACK_FORMAT_VERSION) {
    throw fail(
      "PACK_FORMAT_INVALID",
      `manifest.formatVersion 只支持 ${PACK_FORMAT_VERSION}，实际是「${String(raw.formatVersion)}」`,
      "manifest.json"
    );
  }
  const id = raw.id;
  if (typeof id !== "string" || !isSafeId(id)) {
    throw fail(
      "PACK_ID_INVALID",
      "manifest.id 缺失或不是合法的目录名（不能为空、不能含路径分隔符或 Windows 非法字符）",
      "manifest.json"
    );
  }
  const version = raw.version;
  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw fail(
      "PACK_VERSION_INVALID",
      `manifest.version 应为语义化版本（如 1.0.0），实际是「${String(version)}」`,
      "manifest.json"
    );
  }
  const name = raw.name;
  if (typeof name !== "string" || name.trim() === "") {
    throw fail("PACK_MANIFEST_INVALID", "manifest.name 应为非空字符串", "manifest.json");
  }
  const manifest = {
    format: PACK_FORMAT,
    formatVersion: PACK_FORMAT_VERSION,
    id,
    version,
    name,
    connectors: normalizeConnectors(raw.connectors),
    files: normalizeFileList(raw.files)
  };
  const description = optionalNonEmptyString(raw, "description");
  if (description !== undefined) manifest.description = description;
  const author = optionalNonEmptyString(raw, "author");
  if (author !== undefined) manifest.author = author;
  const domain = optionalNonEmptyString(raw, "domain");
  if (domain !== undefined) manifest.domain = domain;
  const minAppVersion = optionalNonEmptyString(raw, "minAppVersion");
  if (minAppVersion !== undefined) {
    if (!VERSION_PATTERN.test(minAppVersion)) {
      throw fail(
        "PACK_VERSION_INVALID",
        `manifest.minAppVersion 应为语义化版本（如 0.24.0），实际是「${minAppVersion}」`,
        "manifest.json"
      );
    }
    manifest.minAppVersion = minAppVersion;
  }
  return manifest;
}

function parseVersionParts(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a, b) {
  const left = parseVersionParts(a);
  const right = parseVersionParts(b);
  if (left === undefined || right === undefined) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

let cachedAppVersion;
/**
 * 当前应用版本。读不到时返回 undefined 并**跳过** minAppVersion 检查 ——
 * 宁可少拦一次，也不要因为一次文件读取失败让所有包都装不上。
 */
function currentAppVersion() {
  if (cachedAppVersion !== undefined) return cachedAppVersion === "" ? undefined : cachedAppVersion;
  try {
    const pkg = JSON.parse(readFileSync(join(getAppDir(), "package.json"), "utf8"));
    const version = typeof pkg.version === "string" ? pkg.version : "";
    cachedAppVersion = VERSION_PATTERN.test(version) ? version : "";
  } catch {
    cachedAppVersion = "";
  }
  return cachedAppVersion === "" ? undefined : cachedAppVersion;
}

function requireMinAppVersion(manifest) {
  if (manifest.minAppVersion === undefined) return;
  const current = currentAppVersion();
  if (current === undefined) return;
  if (compareVersions(current, manifest.minAppVersion) < 0) {
    throw fail(
      "PACK_APP_VERSION_TOO_LOW",
      `这个能力包要求 ZeroWork ${manifest.minAppVersion} 或更高版本，当前是 ${current}。请先升级应用`,
      "manifest.json"
    );
  }
}

function verifyManifestFiles(manifest, walked) {
  for (const entry of manifest.files) {
    const found = walked.byLowerPath.get(entry.path.toLowerCase());
    if (found === undefined) {
      throw fail(
        "PACK_FILE_MISSING",
        `manifest.files 声明的文件不在包里：${entry.path}`,
        entry.path
      );
    }
    if (found.size !== entry.size) {
      throw fail(
        "PACK_HASH_MISMATCH",
        `文件大小与 manifest.files 声明不符：${found.size} 字节 ≠ ${entry.size} 字节`,
        entry.path
      );
    }
    const actual = sha256OfFile(found.absolute);
    if (actual !== entry.sha256) {
      throw fail(
        "PACK_HASH_MISMATCH",
        "文件哈希与 manifest.files 声明不符（包可能在传输中被修改）",
        entry.path
      );
    }
  }
}

function readExpertIdentity(root) {
  const file = join(root, EXPERT_FILE);
  if (!existsSync(file)) {
    throw fail(
      "PACK_EXPERT_INVALID",
      "能力包缺少 expert.md —— 一个包就是一个专家，专家定义必须在包根目录",
      EXPERT_FILE
    );
  }
  try {
    const doc = parseFrontmatter(readFileSync(file, "utf8"), EXPERT_FILE);
    const name = doc.frontmatter.name;
    return typeof name === "string" ? name : "";
  } catch (error) {
    throw fail("PACK_EXPERT_INVALID", reasonOf(error), EXPERT_FILE);
  }
}

function skillDescriptions(loaded) {
  return loaded.skills.map((ref) => {
    let description = "";
    try {
      const doc = parseFrontmatter(readFileSync(ref.file, "utf8"), ref.file);
      if (typeof doc.frontmatter.description === "string") description = doc.frontmatter.description;
    } catch {
      // loadExpertDir 已经通过 pi 校验过技能 frontmatter；这里读不到只影响预览描述，
      // 不影响安装（安装仍会按同一份校验结果执行）。
    }
    return { name: ref.name, description };
  });
}

function readInstalledMeta(id) {
  const file = join(packsDir(), id, PACK_META_FILE);
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}

function previewOf(root, manifest, walked, loaded) {
  const target = join(packsDir(), manifest.id);
  const existing = existsSync(target);
  const existingMeta = existing ? readInstalledMeta(manifest.id) : undefined;
  const existingVersion =
    typeof existingMeta?.manifest?.version === "string" && existingMeta.manifest.version !== ""
      ? existingMeta.manifest.version
      : undefined;
  return {
    manifest,
    expert: {
      id: loaded.def.name,
      name: loaded.def.name,
      displayName: loaded.def.displayName,
      profession: loaded.def.profession,
      description: loaded.def.description,
      displayDescription: loaded.def.displayDescription,
      expertType: loaded.def.expertType,
      tags: loaded.def.tags
    },
    skills: skillDescriptions(loaded),
    agents: loaded.def.agents.length,
    files: walked.files.length,
    bytes: walked.totalBytes,
    connectors: manifest.connectors,
    conflicts: {
      existing,
      existingIsPack: existing ? existsSync(join(target, PACK_META_FILE)) : false,
      overridesBuiltin: existsSync(join(getResourcesDir(), "experts", manifest.id)),
      // 冲突提示要可执行：版本让用户判断是升级还是降级，路径让「同名文件夹」
      // 这条提示能被照着去处理。没有冲突时不带这两个字段（不留空壳）。
      ...existing ? { existingPath: target } : {},
      ...existingVersion === void 0 ? {} : { existingVersion }
    }
  };
}

/**
 * 校验一个已落盘的包目录（目录来源或 zip 解压后的 staging）。
 * 返回 `{ manifest, files, totalBytes, preview }`。
 */
function analyzePack(root) {
  const manifest = readManifest(root);
  // `_pack.json` 是本应用写在安装目录里的元数据，不属于包内容：重复导入一个
  // 已安装目录、或导出时都可能遇到它，静默忽略比报「顶层不允许」更合理。
  const walked = walkPackDir(root, { exclude: new Set([PACK_META_FILE]) });
  if (walked.files.length === 0) {
    throw fail("PACK_EMPTY", "能力包里没有任何文件");
  }
  requireMinAppVersion(manifest);
  verifyManifestFiles(manifest, walked);
  const expertName = readExpertIdentity(root);
  if (expertName !== manifest.id) {
    throw fail(
      "PACK_ID_MISMATCH",
      `manifest.id「${manifest.id}」与 expert.md 的 name「${expertName}」不一致 —— 两者必须相同，安装目录名也取自 id`,
      EXPERT_FILE
    );
  }
  let loaded;
  try {
    loaded = loadExpertDir(root, manifest.id, "pack");
  } catch (error) {
    throw fail("PACK_EXPERT_INVALID", `专家定义不合法：${reasonOf(error)}`, EXPERT_FILE);
  }
  return {
    manifest,
    files: walked.files,
    totalBytes: walked.totalBytes,
    preview: previewOf(root, manifest, walked, loaded)
  };
}

/**
 * 把来源物化为一个可分析的根目录。
 * - 目录来源：就地分析（不复制，预览因此不会写盘）；
 * - `.zwpack` / `.zip`：解压到 `config/.pack-staging` 下的临时目录，调用方负责清理。
 */
async function materializeSource(sourcePath) {
  if (typeof sourcePath !== "string" || sourcePath.trim() === "") {
    throw fail("PACK_SOURCE_MISSING", "没有提供能力包路径");
  }
  const source = resolve(sourcePath);
  if (!existsSync(source)) {
    throw fail("PACK_SOURCE_MISSING", `路径不存在：${source}`, source);
  }
  const info = lstatSync(source);
  if (info.isSymbolicLink()) {
    throw fail("PACK_SYMLINK", "能力包来源不能是符号链接", source);
  }
  if (info.isDirectory()) {
    return { root: source, temporary: false, cleanup() {} };
  }
  if (!info.isFile()) {
    throw fail("PACK_SOURCE_UNSUPPORTED", "能力包来源必须是目录或 .zwpack 文件", source);
  }
  const ext = extname(source).toLowerCase();
  if (ext !== ".zwpack" && ext !== ".zip") {
    throw fail(
      "PACK_SOURCE_UNSUPPORTED",
      `不支持的来源类型「${ext}」：请选择能力包目录或 .zwpack 文件`,
      source
    );
  }
  const root = newStagingDir("extract");
  try {
    await extractZip(source, root);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    temporary: true,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function zipEntryMode(entry) {
  if (typeof entry.unixPermissions === "number") return entry.unixPermissions;
  const attributes = entry._data?.externalFileAttributes;
  if (typeof attributes !== "number") return undefined;
  return attributes >>> 16;
}

/**
 * 解压 `.zwpack`。
 *
 * 先按 zip 里**声明**的解压后大小预检（真正的 zip bomb 会在这一步被挡下），
 * 解压后再按实际字节复核 —— 声明值可以撒谎，两道都要有。
 */
async function extractZip(source, destRoot) {
  let zip;
  try {
    zip = await JSZip.loadAsync(readFileSync(source));
  } catch (error) {
    throw fail(
      "PACK_ZIP_INVALID",
      `.zwpack 不是合法的 zip 文件：${reasonOf(error)}`,
      source
    );
  }
  const entries = Object.values(zip.files);
  const fileEntries = entries.filter((entry) => !entry.dir);
  if (fileEntries.length === 0) {
    throw fail("PACK_EMPTY", "能力包 zip 里没有任何文件", basename(source));
  }
  if (fileEntries.length > PACK_MAX_ENTRIES) {
    throw fail(
      "PACK_TOO_MANY_FILES",
      `文件数超过上限：${fileEntries.length} > ${PACK_MAX_ENTRIES}`
    );
  }
  let declaredTotal = 0;
  const seen = new Map();
  const targets = [];
  for (const entry of entries) {
    const mode = zipEntryMode(entry);
    if (mode !== undefined && (mode & 0o170000) === 0o120000) {
      throw fail(
        "PACK_SYMLINK",
        "zip 里不允许符号链接条目：链接可能指向包外的任意路径",
        entry.name
      );
    }
    // JSZip 在 loadAsync 时会把 `..`／绝对路径**净化**成包内路径，清洗后的
    // `entry.name` 看起来完全合法（例如 `skills/../agents/x.md` → `agents/x.md`）。
    // 只校验 `entry.name` 会让这类包被静默接受 —— 原样名放在 `unsafeOriginalName`
    // 里，必须优先用它来做路径判定。
    const rawName =
      typeof entry.unsafeOriginalName === "string" && entry.unsafeOriginalName !== ""
        ? entry.unsafeOriginalName
        : entry.name;
    const rel = normalizeEntryPath(rawName, { directory: entry.dir });
    requireAllowedTopLevel(rel);
    if (!entry.dir) requireAllowedExtension(rel);
    const lower = rel.toLowerCase();
    const clash = seen.get(lower);
    if (clash !== undefined) {
      throw fail(
        "PACK_PATH_DUPLICATE",
        `zip 内路径在大小写归一后重复：「${clash}」与「${rel}」（Windows 上会互相覆盖）`,
        rel
      );
    }
    seen.set(lower, rel);
    if (entry.dir) continue;
    const declared = entry._data?.uncompressedSize;
    if (typeof declared === "number") {
      if (declared > PACK_MAX_FILE_BYTES) {
        throw fail(
          "PACK_FILE_TOO_LARGE",
          `单文件声明大小超过上限：${declared} 字节 > ${PACK_MAX_FILE_BYTES} 字节`,
          rel
        );
      }
      declaredTotal += declared;
      if (declaredTotal > PACK_MAX_TOTAL_BYTES) {
        throw fail(
          "PACK_TOO_LARGE",
          `声明解压后总体积超过上限：已累计 ${declaredTotal} 字节 > ${PACK_MAX_TOTAL_BYTES} 字节`
        );
      }
    }
    targets.push({ entry, rel });
  }
  mkdirSync(destRoot, { recursive: true });
  let actualTotal = 0;
  for (const { entry, rel } of targets) {
    let buffer;
    try {
      buffer = await entry.async("nodebuffer");
    } catch (error) {
      throw fail("PACK_ZIP_INVALID", `解压失败（${rel}）：${reasonOf(error)}`, rel);
    }
    if (buffer.byteLength > PACK_MAX_FILE_BYTES) {
      throw fail(
        "PACK_FILE_TOO_LARGE",
        `单文件超过上限：${buffer.byteLength} 字节 > ${PACK_MAX_FILE_BYTES} 字节`,
        rel
      );
    }
    actualTotal += buffer.byteLength;
    if (actualTotal > PACK_MAX_TOTAL_BYTES) {
      throw fail(
        "PACK_TOO_LARGE",
        `解压后总体积超过上限：已累计 ${actualTotal} 字节 > ${PACK_MAX_TOTAL_BYTES} 字节`
      );
    }
    const absolute = join(destRoot, ...rel.split("/"));
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, buffer);
  }
}

/** 预览：不安装、不改动用户配置，只返回「将会发生什么」。 */
export async function inspectPack(sourcePath) {
  let material;
  try {
    material = await materializeSource(sourcePath);
  } catch (error) {
    return failure(error);
  }
  try {
    const analysis = analyzePack(material.root);
    return { ok: true, preview: analysis.preview };
  } catch (error) {
    return failure(error);
  } finally {
    material.cleanup();
  }
}

/** 把校验过的文件复制进 staging（目录来源与 zip 来源安装时走同一条路）。 */
function copyValidatedFiles(root, destRoot, files) {
  mkdirSync(destRoot, { recursive: true });
  for (const file of files) {
    const destination = join(destRoot, ...file.path.split("/"));
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(file.absolute, destination);
  }
}

/**
 * 用**真实加载路径**把整个专家库读一遍。
 *
 * `loadExperts` 会拒绝技能名 / 成员名与全局库重名。那些冲突只在整库加载时
 * 才看得见 —— 单个 `loadExpertDir` 发现不了。装完再检查一次，冲突时回滚，
 * 避免「装上一个包，整个专家列表从此加载失败」。
 */
function expertLibraryError() {
  try {
    loadExperts(
      join(getResourcesDir(), "experts"),
      [
        { dir: packsDir(), source: "pack" },
        { dir: join(getConfigDir(), "experts"), source: "user" },
      ],
      getBuiltinSkillDirs(),
      loadAgents(join(getResourcesDir(), "agents"), join(getConfigDir(), "agents")),
    );
    return undefined;
  } catch (error) {
    return reasonOf(error);
  }
}

/**
 * 安装能力包。
 *
 * 冲突规则（设计 §3）：
 * - 目标目录里有 `_pack.json` → 视为旧版本，原子替换（失败回滚）；
 * - 目标目录存在但不是能力包 → 拒绝，绝不覆盖用户手工放置的专家。
 */
export async function installPack(sourcePath) {
  let material;
  try {
    material = await materializeSource(sourcePath);
  } catch (error) {
    return failure(error);
  }
  const staging = newStagingDir("install");
  try {
    const analysis = analyzePack(material.root);
    const baselineError = expertLibraryError();
    const id = analysis.manifest.id;
    const target = join(packsDir(), id);
    let replacing = false;
    if (existsSync(target)) {
      if (!existsSync(join(target, PACK_META_FILE))) {
        throw fail(
          "PACK_CONFLICT_NOT_PACK",
          `目标目录「${target}」已存在，但它不是能力包（缺少 ${PACK_META_FILE}）。请先手动处理这个目录，导入不会覆盖它`,
          id
        );
      }
      replacing = true;
    }
    copyValidatedFiles(material.root, staging, analysis.files);
    const meta = {
      manifest: analysis.manifest,
      installedAt: Date.now(),
      source: resolve(sourcePath),
      files: analysis.files.map((file) => ({
        path: file.path,
        sha256: sha256OfFile(file.absolute),
        size: file.size
      }))
    };
    writeFileSync(
      join(staging, PACK_META_FILE),
      `${JSON.stringify(meta, null, 2)}\n`,
      "utf8"
    );
    mkdirSync(packsDir(), { recursive: true });
    // 备份必须放在 `packs/` **之外**：放在里面会被 loadExpertsDir 当成另一个
    // 专家目录扫描（目录名与 frontmatter name 不一致 → 整库加载报错）。
    const backup = join(stagingRoot(), `${id}.old-${process.pid}-${Date.now()}`);
    let backedUp = false;
    try {
      if (replacing) {
        renameSync(target, backup);
        backedUp = true;
      }
      renameSync(staging, target);
    } catch (error) {
      if (backedUp) {
        try {
          rmSync(target, { recursive: true, force: true });
          renameSync(backup, target);
        } catch (restoreError) {
          throw fail(
            "PACK_IO_ERROR",
            `安装失败且回滚也失败了：${reasonOf(error)}；原目录在 ${backup}（${reasonOf(restoreError)}）`,
            id
          );
        }
      }
      throw fail("PACK_IO_ERROR", `安装失败：${reasonOf(error)}`, id);
    }
    /*
     * 装完做一次整库加载检查：技能 / 成员与全局库重名只在**整库**加载时暴露。
     * 没有这个问题时再删备份；有问题就回滚到安装前 —— 一个包不能把整页专家
     * 变成「加载失败」。基线本来就坏时跳过这条（无法归因，也不该拦住安装）。
     */
    if (baselineError === undefined) {
      const afterError = expertLibraryError();
      if (afterError !== undefined) {
        try {
          rmSync(target, { recursive: true, force: true });
          if (backedUp) renameSync(backup, target);
        } catch (rollbackError) {
          throw fail(
            "PACK_IO_ERROR",
            `能力包与现有专家库冲突（${afterError}），且回滚失败：${reasonOf(rollbackError)}；原目录在 ${backup}`,
            id
          );
        }
        throw fail(
          "PACK_CONFLICT_GLOBAL",
          `能力包与现有专家库冲突，已回滚：${afterError}`,
          id
        );
      }
    }
    if (backedUp) rmSync(backup, { recursive: true, force: true });
    return {
      ok: true,
      id,
      version: analysis.manifest.version,
      expert: analysis.preview.expert
    };
  } catch (error) {
    return failure(error);
  } finally {
    rmSync(staging, { recursive: true, force: true });
    material.cleanup();
  }
}

/** 卸载：只接受带 `_pack.json` 的目录，绝不误删用户手工专家。 */
export function uninstallPack(id) {
  try {
    requireSafeId(id);
  } catch (error) {
    return failure(error);
  }
  const dir = join(packsDir(), id);
  if (!existsSync(dir)) return { ok: false, id, reason: "not-installed" };
  if (!existsSync(join(dir, PACK_META_FILE))) {
    return { ok: false, id, reason: "not-a-pack" };
  }
  try {
    rmSync(dir, { recursive: true, force: true });
    return { ok: true, id };
  } catch (error) {
    return failure(error);
  }
}

/** 已安装能力包列表（`packs/*` 里带 `_pack.json` 的目录）。 */
export function listPacks() {
  const root = packsDir();
  if (!existsSync(root)) return { packs: [] };
  const packs = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const meta = readInstalledMeta(entry.name);
    if (meta === undefined) continue;
    const manifest = typeof meta.manifest === "object" && meta.manifest !== null ? meta.manifest : {};
    packs.push({
      id: entry.name,
      ...(typeof manifest.version === "string" ? { version: manifest.version } : {}),
      ...(typeof manifest.name === "string" ? { name: manifest.name } : {}),
      ...(typeof meta.installedAt === "number" ? { installedAt: meta.installedAt } : {}),
      ...(typeof meta.source === "string" ? { source: meta.source } : {})
    });
  }
  packs.sort((a, b) => a.id.localeCompare(b.id));
  return { packs };
}

function exportSourceOf(name) {
  const userDir = join(getConfigDir(), "experts", name);
  if (existsSync(userDir)) return { dir: userDir, kind: "user" };
  const packDir = join(packsDir(), name);
  if (existsSync(packDir) && existsSync(join(packDir, PACK_META_FILE))) {
    return { dir: packDir, kind: "pack" };
  }
  return undefined;
}

function hashEntriesOf(files) {
  return files.map((file) => ({
    path: file.path,
    sha256: sha256OfFile(file.absolute),
    size: file.size
  }));
}

function writeFileAtomic(destination, buffer) {
  const temp = `${destination}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temp, buffer);
    try {
      renameSync(temp, destination);
    } catch (error) {
      // Windows 上 rename 不能覆盖已存在的文件；先删再改名。
      if (!existsSync(destination)) throw error;
      rmSync(destination, { force: true });
      renameSync(temp, destination);
    }
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

/**
 * 导出用户自己的专家（或已安装能力包）为 `.zwpack`。
 *
 * **内置专家明确拒绝**：`resources/experts/**` 含第三方内容，再分发授权未确认
 * （见 THIRD_PARTY_NOTICES.md），不能打包分享。
 */
export async function exportPack(request) {
  const input = typeof request === "object" && request !== null ? request : {};
  const name = input["name"];
  const destPath = input["destPath"];
  try {
    if (typeof name !== "string" || !isSafeId(name)) {
      throw fail("PACK_ID_INVALID", "导出时没有给出合法的专家名");
    }
    if (typeof destPath !== "string" || destPath.trim() === "") {
      throw fail("PACK_DEST_INVALID", "导出时没有给出目标文件路径");
    }
    const source0 = exportSourceOf(name);
    if (source0 === undefined) {
      if (existsSync(join(getResourcesDir(), "experts", name))) {
        throw fail(
          "PACK_EXPORT_BUILTIN",
          "内置专家可能包含第三方内容，再分发授权确认之前不支持导出（见 THIRD_PARTY_NOTICES.md）",
          name
        );
      }
      throw fail("PACK_EXPORT_NOT_FOUND", `找不到专家「${name}」`, name);
    }
    const walked = walkPackDir(source0.dir, {
      // `_pack.json` 是本地元数据；`manifest.json` 由这次导出重新生成 ——
      // 两者都不能进 files 清单（后者会自相矛盾）。
      exclude: new Set([PACK_META_FILE, "manifest.json"]),
      skipHidden: true
    });
    if (walked.files.length === 0) {
      throw fail("PACK_EXPORT_EMPTY", `专家「${name}」目录里没有可打包的文件`, name);
    }
    const unsupported = walked.files.filter(
      (file) => !PACK_ALLOWED_EXTENSIONS.has(extname(file.path).toLowerCase())
    );
    if (unsupported.length > 0) {
      const listed = unsupported
        .slice(0, 5)
        .map((file) => file.path)
        .join("、");
      throw fail(
        "PACK_EXPORT_UNSUPPORTED_FILE",
        `有些文件不能进能力包（只允许声明式内容与图片）：${listed}${unsupported.length > 5 ? ` 等 ${unsupported.length} 个` : ""}。请先移除它们再导出`,
        unsupported[0].path
      );
    }
    if (walked.files.length > PACK_MAX_ENTRIES) {
      throw fail(
        "PACK_TOO_MANY_FILES",
        `文件数超过上限：${walked.files.length} > ${PACK_MAX_ENTRIES}`,
        name
      );
    }
    const meta = source0.kind === "pack" ? readInstalledMeta(name) : undefined;
    const stored = typeof meta?.manifest === "object" && meta.manifest !== null ? meta.manifest : {};
    const expertDoc = parseFrontmatter(
      readFileSync(join(source0.dir, EXPERT_FILE), "utf8"),
      EXPERT_FILE
    );
    const displayName =
      typeof expertDoc.frontmatter.displayName === "string" &&
      expertDoc.frontmatter.displayName !== ""
        ? expertDoc.frontmatter.displayName
        : name;
    const description =
      typeof expertDoc.frontmatter.description === "string" &&
      expertDoc.frontmatter.description !== ""
        ? expertDoc.frontmatter.description
        : undefined;
    const manifest = {
      format: PACK_FORMAT,
      formatVersion: PACK_FORMAT_VERSION,
      id: name,
      version: typeof stored["version"] === "string" ? stored["version"] : "1.0.0",
      name: typeof stored["name"] === "string" ? stored["name"] : displayName
    };
    if (description !== undefined) manifest.description = description;
    if (typeof stored["author"] === "string") manifest.author = stored["author"];
    if (typeof stored["domain"] === "string") manifest.domain = stored["domain"];
    if (typeof stored["minAppVersion"] === "string") manifest.minAppVersion = stored["minAppVersion"];
    if (Array.isArray(stored["connectors"])) manifest.connectors = stored["connectors"];
    manifest.files = hashEntriesOf(walked.files);

    const zip = new JSZip();
    for (const file of walked.files) {
      zip.file(file.path, readFileSync(file.absolute));
    }
    zip.file("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
    const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    const destination = resolve(destPath);
    if (!existsSync(dirname(destination))) {
      throw fail(
        "PACK_DEST_INVALID",
        `目标目录不存在：${dirname(destination)}`,
        destination
      );
    }
    writeFileAtomic(destination, buffer);
    return { ok: true, path: destination, files: walked.files.length };
  } catch (error) {
    return failure(error);
  }
}
