/**
 * 资料库：把各会话里「交付过的产物」聚合成一个跨会话列表。
 *
 * 产物数据来自每个会话 `.jsonl` 里 `customType: "artifacts_presented"` 的条目
 * （一条一行，`data.files[]` 存的是**绝对路径**，字段 path/size/html/kind），
 * 见 `research/feasibility.md` §1.4 的磁盘原文。
 *
 * 为什么单独一个模块（而不是就地加进 session-files.js）：
 * `session-files.js` 在**模块顶层**就 `requireParentPort()` 并 `loadResources()`，
 * 在 Electron utilityProcess 之外根本 import 不了（否则抛「daemon 必须在
 * Electron utilityProcess 中启动」）。把聚合逻辑放那里，等于让它**无法单测** ——
 * 而 design.md §4 要求解析 / 去重 / 截断是「可单测的纯逻辑」。
 * 这里刻意不复制 session-files.js 的私料：目录、读取、内部会话过滤都由调用方注入，
 * 于是纯逻辑（parse / aggregate）不碰文件系统，可直接对临时目录里的会话文件断言。
 *
 * `textOf` 直接复用 session-view.js 的导出（同一段「content → 纯文本」逻辑，
 * 本模块可独立 import 它，无循环依赖），不另写一份等价实现。
 */

import { basename, join } from "node:path";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { getSessionsDir } from "./config-paths.js";
import { deriveSessionTitle } from "./session-state.js";
import { textOf } from "./session-view.js";

/**
 * 聚合结果的上限。超过就按 `deliveredAt` 降序保留**最近的**这么多条并置
 * `truncated: true` —— 界面必须把「被截断」说出来（静默截断等于让用户
 * 以为「就这些」；本仓库对「静默丢东西」有明确纪律）。
 */
const LIBRARY_MAX_ITEMS = 500;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 逐行解析一个会话文件（**纯函数，不碰文件系统**）。
 *
 * 返回 `{ id, cwd, firstUserText, artifacts }`；没有会话头（非会话文件）返回
 * `undefined`。坏行（JSON.parse 失败）直接跳过 —— 坏行不能让整个会话文件作废。
 *
 * `artifacts[]` 每项是 `{ path, size, html, kind, deliveredAt }`，`deliveredAt`
 * 取条目的 `timestamp`（没有时间戳的条目跳过：无法参与「最近一次交付」的比较）。
 */
function parseLibrarySession(raw) {
  if (typeof raw !== "string") return undefined;
  let id;
  let cwd = "";
  let firstUserText;
  const artifacts = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isPlainObject(record)) continue;
    if (record.type === "session") {
      if (id === undefined && typeof record.id === "string" && record.id !== "") id = record.id;
      if (cwd === "" && typeof record.cwd === "string") cwd = record.cwd;
      continue;
    }
    if (record.type === "custom" && record.customType === "artifacts_presented") {
      const deliveredAt = typeof record.timestamp === "string" ? record.timestamp : undefined;
      if (deliveredAt === undefined) continue;
      const files = isPlainObject(record.data) && Array.isArray(record.data.files) ? record.data.files : [];
      for (const file of files) {
        if (!isPlainObject(file) || typeof file.path !== "string" || file.path === "") continue;
        artifacts.push({
          path: file.path,
          size: typeof file.size === "number" ? file.size : 0,
          html: file.html === true,
          // 交付对象只有本地文件与 URL 两类（见 present_files 的分类）。
          kind: file.kind === "url" ? "url" : "local",
          deliveredAt,
        });
      }
      continue;
    }
    if (firstUserText === undefined && record.type === "message") {
      const message = record.message;
      if (isPlainObject(message) && message.role === "user") {
        firstUserText = textOf(message.content);
      }
    }
  }
  if (id === undefined) return undefined;
  return { id, cwd, firstUserText, artifacts };
}

function timeOf(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * 把「每个会话解析出的产物条目」归并成资料库列表（**纯函数，不碰文件系统**）。
 *
 * 去重语义（design.md §1.3）：**全局按 path 合并**。同一路径只出一行；
 * 保留**最近一次交付**的 size/kind/html/deliveredAt（那是「这个文件现在长什么样」，
 * 比第一次更符合直觉）；`sessions` 记下交付过它的会话，**最近在前且去重**
 * （同一会话里先后交付两次只出现一次）。
 *
 * 输入 `sessions[]`：`{ id, path, title, cwd, modifiedAt, artifacts: [{path,size,html,kind,deliveredAt}] }`。
 * `exists` 不在这里算 —— 它要 statSync，属于 IO 层（见 `readLibraryArtifacts`）。
 */
function aggregateLibraryArtifacts(sessions, options = {}) {
  const maxItems = typeof options.maxItems === "number" ? options.maxItems : LIBRARY_MAX_ITEMS;
  const byPath = new Map();
  for (const session of sessions) {
    if (!isPlainObject(session)) continue;
    const sessionMeta = {
      id: session.id,
      path: session.path,
      title: session.title,
      cwd: session.cwd,
      modifiedAt: typeof session.modifiedAt === "number" ? session.modifiedAt : 0,
    };
    const artifacts = Array.isArray(session.artifacts) ? session.artifacts : [];
    for (const artifact of artifacts) {
      if (!isPlainObject(artifact) || typeof artifact.path !== "string" || artifact.path === "") continue;
      let entry = byPath.get(artifact.path);
      if (entry === undefined) {
        entry = {
          path: artifact.path,
          name: basename(artifact.path),
          kind: artifact.kind === "url" ? "url" : "local",
          html: artifact.html === true,
          size: typeof artifact.size === "number" ? artifact.size : 0,
          deliveredAt: artifact.deliveredAt,
          sessionsById: new Map(),
        };
        byPath.set(artifact.path, entry);
      } else if (timeOf(artifact.deliveredAt) > timeOf(entry.deliveredAt)) {
        entry.kind = artifact.kind === "url" ? "url" : "local";
        entry.html = artifact.html === true;
        entry.size = typeof artifact.size === "number" ? artifact.size : 0;
        entry.deliveredAt = artifact.deliveredAt;
      }
      // 同一会话交付两次只记一次：按会话 id 去重。
      if (!entry.sessionsById.has(sessionMeta.id)) entry.sessionsById.set(sessionMeta.id, sessionMeta);
    }
  }
  const artifacts = [];
  for (const entry of byPath.values()) {
    artifacts.push({
      path: entry.path,
      name: entry.name,
      kind: entry.kind,
      html: entry.html,
      size: entry.size,
      deliveredAt: entry.deliveredAt,
      sessions: [...entry.sessionsById.values()].sort((a, b) => b.modifiedAt - a.modifiedAt),
    });
  }
  artifacts.sort((a, b) => timeOf(b.deliveredAt) - timeOf(a.deliveredAt));
  const truncated = artifacts.length > maxItems;
  return { artifacts: truncated ? artifacts.slice(0, maxItems) : artifacts, truncated };
}

/**
 * `exists` 是**实时**判定（聚合那一刻 statSync），与 size/kind/html 的
 * 「交付时刻快照」语义不同 —— 一个答「现在还在不在」，一个答「当时多大」。
 *
 * URL 项不 stat（statSync 一个 http 地址必然失败），直接记 true：
 * 它不是一个「可能失效的本地文件」，标成失效会误导。
 */
function artifactExists(entry) {
  if (entry.kind === "url") return true;
  try {
    statSync(entry.path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 读取整个会话目录并聚合（IO 层，**整体不抛**）。
 *
 * 健壮性（design.md §1.6）：目录读不到 ⇒ 空列表；坏文件（权限 / 被删）跳过，
 * 只影响它自己；坏行在 `parseLibrarySession` 内跳过；没有会话头的文件不算会话。
 * 页面上不该出现「资料库坏了」。
 *
 * `isInternalSessionFile` 由调用方注入（`session-files.js` 的私有判据，
 * 用来跳过子会话 / 内置定时任务的会话），避免与 session-files.js 循环依赖。
 */
function readLibraryArtifacts(options = {}) {
  const sessionsDir = typeof options.sessionsDir === "string" ? options.sessionsDir : getSessionsDir();
  const shouldSkip = typeof options.isInternalSessionFile === "function" ? options.isInternalSessionFile : () => false;
  let dirents;
  try {
    dirents = readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return { artifacts: [], truncated: false };
  }
  const sessions = [];
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;
    if (!dirent.name.toLowerCase().endsWith(".jsonl")) continue;
    const filePath = join(sessionsDir, dirent.name);
    if (shouldSkip(filePath)) continue;
    let raw;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    const parsed = parseLibrarySession(raw);
    if (parsed === undefined) continue;
    let modifiedAt = 0;
    try {
      modifiedAt = statSync(filePath).mtimeMs;
    } catch {
      modifiedAt = 0;
    }
    sessions.push({
      id: parsed.id,
      path: filePath,
      title: deriveSessionTitle(undefined, parsed.firstUserText),
      cwd: parsed.cwd,
      modifiedAt,
      artifacts: parsed.artifacts,
    });
  }
  const { artifacts, truncated } = aggregateLibraryArtifacts(sessions);
  return {
    artifacts: artifacts.map((entry) => ({ ...entry, exists: artifactExists(entry) })),
    truncated,
  };
}

export { LIBRARY_MAX_ITEMS, aggregateLibraryArtifacts, parseLibrarySession, readLibraryArtifacts };
