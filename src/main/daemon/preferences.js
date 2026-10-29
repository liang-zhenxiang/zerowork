import { accessSync } from "node:fs";
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
import { closeSync } from "node:fs";
import { constants } from "node:fs";
import { copyFileSync } from "node:fs";
import { createReadStream } from "node:fs";
import { createWriteStream } from "node:fs";
import { delimiter } from "node:path";
import { dirname } from "node:path";
import { existsSync } from "node:fs";
import { extname } from "node:path";
import { fstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { normalize as normalize$1 } from "node:path";
import { openSync } from "node:fs";
import { readdirSync } from "node:fs";
import { readFileSync } from "node:fs";
import { readSync } from "node:fs";
import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { renameSync } from "node:fs";
import { resolve } from "node:path";
import { URL } from "node:url";
import { rmSync } from "node:fs";
import { sep } from "node:path";
import { statSync } from "node:fs";
import { writeFileSync } from "node:fs";
import {
	getConfigDir,
	getWorkspaceDir,
} from "./config-paths.js";
import { isThinkingLevel } from "./ledger.js";
import {
	isApprovalPolicy,
	isSandboxMode,
	presetIdFor,
} from "./permissions.js";
import { normalizeStarters } from "../../shared/starter-prompts.js";

const SKILL_NAME_PATTERN = /^[a-z0-9-]+$/;

function isSkillEnabled(name, overrides) {
  return overrides?.[name] !== "off";
}

const THEMES = [
  "system",
  "light",
  "dark"
];

// 外观主题档位判定（严格枚举 + 严格类型）：与 ledger 的 isThinkingLevel 同构。
// 非法值一律 false——读侧（readPreferences）据此丢弃、写侧（handler）据此拒绝，
// 两头共用这一份枚举，不会出现「写入时合法、读回时被丢」的口径漂移。
function isThemePreference(value) {
  return typeof value === "string" && THEMES.includes(value);
}

/*
 * 更新渠道（stable / beta）：与 isThemePreference 同构 —— 读侧丢弃非法值、
 * 写侧拒绝非法值，两头共用这一份枚举，不会出现「写入时合法、读回时被丢」的
 * 口径漂移。
 *
 * 2026-10-26 修正（issue #283）：此前 readPreferences 的返回白名单漏了这个
 * 字段，于是 getUpdateChannel 永远回 stable；而 writePreferences 是整份覆写，
 * 任何其它偏好写入都会顺手把 updateChannel 抹掉。
 */
const UPDATE_CHANNELS = ["stable", "beta"];

function isUpdateChannel(value) {
  return typeof value === "string" && UPDATE_CHANNELS.includes(value);
}

/*
 * 网络代理（spec: proxy-settings）
 *
 * 三档：off（直连）/ system（跟随系统）/ manual（手动地址 + 可选认证）。
 * 读侧与写侧共用同一份判据（照 isThemePreference 的写法）：读侧丢弃非法值、
 * 写侧拒绝非法值，不会出现「写入时合法、读回时被丢」的口径漂移。
 *
 * 为什么 v1 不支持 SOCKS：undici 的 ProxyAgent 只处理 HTTP(S) CONNECT，
 * 接受一个 socks5 地址只会静默直连 —— 宁可明确拒绝，也不让用户以为它生效了。
 */
const PROXY_MODES = ["off", "system", "manual"];

function isProxyMode(value) {
  return typeof value === "string" && PROXY_MODES.includes(value);
}

/**
 * 规范化代理地址。合法返回 URL 字符串（去空白），非法返回 undefined。
 *
 * 只接受 http / https：见上方「为什么不支持 SOCKS」。
 * 不带端口的 `http://host` 是合法的（默认 80/443），由使用方决定。
 */
function normalizeProxyUrl(value) {
  if (typeof value !== "string" || value.trim() === "") return void 0;
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return void 0;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return void 0;
  if (parsed.hostname === "") return void 0;
  // 认证信息必须拆成独立字段落盘（否则整条 URL 被打印时密码跟着泄漏）。
  if (parsed.username !== "" || parsed.password !== "") return void 0;
  return parsed.toString();
}

/**
 * 写侧校验：返回 { ok: true, value } 或 { ok: false, message }。
 * 错误消息给用户看，要能指导下一步，而不是一句「格式错误」。
 */
function validateProxyInput(input) {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, message: "代理设置应为对象" };
  }
  const mode = input.mode;
  if (!isProxyMode(mode)) {
    return { ok: false, message: `未知的代理模式：${String(mode)}` };
  }
  if (mode !== "manual") {
    return { ok: true, value: { mode } };
  }
  const raw = typeof input.url === "string" ? input.url.trim() : "";
  if (raw === "") {
    return { ok: false, message: "手动代理需要填写地址，例如 http://127.0.0.1:7890" };
  }
  if (/^socks[45]:\/\//iu.test(raw)) {
    return {
      ok: false,
      message: "暂不支持 SOCKS 代理，请填写 HTTP 代理地址（多数代理客户端同时提供 HTTP 端口）"
    };
  }
  if (!/^https?:\/\//iu.test(raw)) {
    return { ok: false, message: "代理地址需要以 http:// 或 https:// 开头" };
  }
  const url = normalizeProxyUrl(raw);
  if (url === undefined) {
    return { ok: false, message: `代理地址无效：${raw}。请检查主机名与端口` };
  }
  const username = typeof input.username === "string" ? input.username : "";
  const password = typeof input.password === "string" ? input.password : "";
  return { ok: true, value: { mode, url, username, password } };
}

/** 读侧：整块非法就丢弃（与 skillOverrides 的口径一致），不留半个配置。 */
function readProxy(value) {
  if (value === void 0) return void 0;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    console.error("偏好文件的 proxy 应为对象（{ mode, url, username, password }），已忽略：", value);
    return void 0;
  }
  const mode = value.mode;
  if (!isProxyMode(mode)) return void 0;
  if (mode !== "manual") return { mode };
  const url = normalizeProxyUrl(value.url);
  if (url === void 0) return void 0;
  return {
    mode,
    url,
    username: typeof value.username === "string" ? value.username : "",
    password: typeof value.password === "string" ? value.password : ""
  };
}

// 命令面板记忆（收藏 + 常用分）的上限。与渲染层的
// `src/renderer/src/palette-memory.js` **同名常量必须同值** —— 那边管住正常写入，
// 这边管住手改过的文件；两边不一致的后果是「面板里明明还能收藏，重启后少一条」。
const PALETTE_FAVORITES_MAX = 20;
const PALETTE_USAGE_MAX = 200;

/**
 * 命令面板记忆的校验判据 —— **读侧与写侧共用这一份**（照 isThemePreference 的写法）：
 * 读侧据此丢弃非法值、写侧据此拒绝非法值，于是不会出现「写入时合法、读回时被丢」
 * 这种口径漂移。
 *
 * 形状：{ favorites: string[], usage: { [id]: { score: number, lastAt: number } } }
 *
 * 返回 undefined 表示「没有 / 整体不可用」；返回对象表示可用（可能为空对象）。
 * 局部脏数据（某一条分数是字符串）只丢那一条，不让整块记忆失效 —— 与
 * skillOverrides 的处理口径一致。
 */
function readPaletteMemory(value) {
  if (value === void 0) return void 0;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    console.error("偏好文件的 paletteMemory 应为对象（{ favorites, usage }），已忽略：", value);
    return void 0;
  }
  const record = value;
  const rawFavorites = Array.isArray(record.favorites) ? record.favorites : [];
  const favorites = [];
  const seen = /* @__PURE__ */ new Set();
  for (const id of rawFavorites) {
    if (typeof id !== "string" || id === "" || seen.has(id)) continue;
    seen.add(id);
    favorites.push(id);
    if (favorites.length >= PALETTE_FAVORITES_MAX) break;
  }
  const usage = {};
  const rawUsage = typeof record.usage === "object" && record.usage !== null && !Array.isArray(record.usage) ? record.usage : {};
  for (const [id, entry] of Object.entries(rawUsage)) {
    if (id === "" || typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const score = entry.score;
    if (typeof score !== "number" || !Number.isFinite(score) || score <= 0) continue;
    const lastAt = typeof entry.lastAt === "number" && Number.isFinite(entry.lastAt) ? entry.lastAt : 0;
    usage[id] = { score, lastAt };
    if (Object.keys(usage).length >= PALETTE_USAGE_MAX) break;
  }
  return { favorites, usage };
}

function filterEnabledSkills(skills, overrides) {
  return skills.filter((skill) => isSkillEnabled(skill.name, overrides));
}

const EMPTY = { activeModelKey: void 0 };

function getPath$1() {
  return join(getConfigDir(), "preferences.json");
}

function readPreferences() {
  let raw;
  try {
    raw = readFileSync(getPath$1(), "utf8");
  } catch {
    return EMPTY;
  }
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return EMPTY;
    const record = parsed;
    const key = typeof record.activeModelKey === "string" && record.activeModelKey !== "" ? record.activeModelKey : void 0;
    const defaultWorkspacePath = typeof record.defaultWorkspacePath === "string" && record.defaultWorkspacePath !== "" ? record.defaultWorkspacePath : void 0;
    const ws = record.webSearch;
    const webSearch = typeof ws === "object" && ws !== null ? {
      providerId: typeof ws.providerId === "string" ? ws.providerId : "",
      apiKey: typeof ws.apiKey === "string" ? ws.apiKey : ""
    } : void 0;
    const permissions = readPermissions(record.permissions);
    const thinkingLevel = isThinkingLevel(record.thinkingLevel) ? record.thinkingLevel : void 0;
    const theme = isThemePreference(record.theme) ? record.theme : void 0;
    // UI 缩放（#300 F10）：80–150 的整数百分比，非法/缺省 = 未写。
    const uiScaleRaw = record.uiScale;
    const uiScale = typeof uiScaleRaw === "number" && Number.isInteger(uiScaleRaw) && uiScaleRaw >= 80 && uiScaleRaw <= 150 ? uiScaleRaw : void 0;
    const updateChannel = isUpdateChannel(record.updateChannel) ? record.updateChannel : void 0;
    const paletteMemory = readPaletteMemory(record.paletteMemory);
    const styleId = typeof record.styleId === "string" ? record.styleId : void 0;
    const memoryEnabled = typeof record.memoryEnabled === "boolean" ? record.memoryEnabled : void 0;
    const agentTeamsEnabled = typeof record.agentTeamsEnabled === "boolean" ? record.agentTeamsEnabled : void 0;
    const proxy = readProxy(record.proxy);
    const rec = record;
    const optString = (k) => {
      const v = rec[k];
      return typeof v === "string" && v !== "" ? v : void 0;
    };
    const optBoolean = (k) => {
      const v = rec[k];
      return typeof v === "boolean" ? v : void 0;
    };
    const customInstructions = optString("customInstructions");
    // 提示词模板：读侧宽容（逐条丢掉坏的），与写侧的 assertTemplateList 成对。
    // 字段名用 promptTemplates 而不是 templates：preferences.json 是用户能打开看的
    // 文件，`templates` 太泛，将来加别的模板（会话模板/工作流模板）会撞名。
    const starterPrompts = normalizeStarters(rec["starterPrompts"]);
    const userNickname = optString("userNickname");
    const assistantName = optString("assistantName");
    const personaDescription = optString("personaDescription");
    const welcomeGreeting = optBoolean("welcomeGreeting");
    const showChangeDetails = optBoolean("showChangeDetails");
    const optPositiveInt = (k) => {
      const v = rec[k];
      return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : void 0;
    };
    const spawnBudget = optPositiveInt("spawnBudget");
    const subagentTimeoutMs = optPositiveInt("subagentTimeoutMs");
    const skillOverrides = readSkillOverrides(rec["skillOverrides"]);
    const runtimes = readRuntimePrefs(rec["runtimes"]);
    return {
      activeModelKey: key,
      ...webSearch !== void 0 && webSearch.providerId !== "" ? { webSearch } : {},
      ...permissions !== void 0 ? { permissions } : {},
      ...defaultWorkspacePath !== void 0 ? { defaultWorkspacePath } : {},
      ...thinkingLevel !== void 0 ? { thinkingLevel } : {},
      ...theme !== void 0 ? { theme } : {},
      ...uiScale !== void 0 ? { uiScale } : {},
      ...updateChannel !== void 0 ? { updateChannel } : {},
      ...paletteMemory !== void 0 ? { paletteMemory } : {},
      ...styleId !== void 0 ? { styleId } : {},
      ...memoryEnabled !== void 0 ? { memoryEnabled } : {},
      ...agentTeamsEnabled !== void 0 ? { agentTeamsEnabled } : {},
      ...spawnBudget !== void 0 ? { spawnBudget } : {},
      ...subagentTimeoutMs !== void 0 ? { subagentTimeoutMs } : {},
      ...customInstructions !== void 0 ? { customInstructions } : {},
      ...userNickname !== void 0 ? { userNickname } : {},
      ...assistantName !== void 0 ? { assistantName } : {},
      ...personaDescription !== void 0 ? { personaDescription } : {},
      ...welcomeGreeting !== void 0 ? { welcomeGreeting } : {},
      ...showChangeDetails !== void 0 ? { showChangeDetails } : {},
      ...skillOverrides !== void 0 ? { skillOverrides } : {},
      ...runtimes !== void 0 ? { runtimes } : {},
      ...proxy !== void 0 ? { proxy } : {},
      ...starterPrompts.length > 0 ? { starterPrompts } : {}
    };
  } catch {
    return EMPTY;
  }
}

function readPermissions(value) {
  if (typeof value !== "object" || value === null) return void 0;
  const record = value;
  if (typeof record.sandbox !== "string" || !isSandboxMode(record.sandbox)) return void 0;
  if (typeof record.approval !== "string" || !isApprovalPolicy(record.approval)) return void 0;
  const derived = presetIdFor(record.sandbox, record.approval);
  const presetId = typeof record.presetId === "string" && record.presetId === derived ? record.presetId : derived;
  return { sandbox: record.sandbox, approval: record.approval, presetId };
}

function readSkillOverrides(value) {
  if (value === void 0) return void 0;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    console.error(`偏好文件的 skillOverrides 应为对象（技能名 → "on" | "off"），已整块忽略：`, value);
    return void 0;
  }
  const out = {};
  for (const [name, state] of Object.entries(value)) {
    if (!SKILL_NAME_PATTERN.test(name)) {
      console.error(`skillOverrides 的键「${name}」不是合法技能名（小写字母/数字/连字符），已忽略该条`);
      continue;
    }
    if (state !== "on" && state !== "off") {
      console.error(`skillOverrides["${name}"] 的值应为 "on" 或 "off"，实际是 ${JSON.stringify(state)}，已忽略该条`);
      continue;
    }
    out[name] = state;
  }
  return Object.keys(out).length === 0 ? void 0 : out;
}

function readRuntimePrefs(value) {
  if (value === void 0) return void 0;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    console.error("偏好文件的 runtimes 应为对象（{ enabled, items }），已整块忽略：", value);
    return void 0;
  }
  const record = value;
  const enabled = typeof record.enabled === "boolean" ? record.enabled : void 0;
  let items;
  if (record.items !== void 0) {
    if (typeof record.items !== "object" || record.items === null || Array.isArray(record.items)) {
      console.error("偏好文件的 runtimes.items 应为对象（运行时 id → 布尔），已忽略：", record.items);
    } else {
      const kept = {};
      for (const [id, state] of Object.entries(record.items)) {
        if (typeof state !== "boolean") {
          console.error(`runtimes.items["${id}"] 应为布尔值，实际是 ${JSON.stringify(state)}，已忽略该条`);
          continue;
        }
        kept[id] = state;
      }
      items = Object.keys(kept).length === 0 ? void 0 : kept;
    }
  }
  if (enabled === void 0 && items === void 0) return void 0;
  return {
    ...enabled === void 0 ? {} : { enabled },
    ...items === void 0 ? {} : { items }
  };
}

function writePreferences(preferences) {
  const path = getPath$1();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(preferences, null, 2)}
`, "utf8");
}

function getEffectiveWorkspaceRoot() {
  const env = process.env["ZEROWORK_WORKSPACE_DIR"];
  if (env !== void 0 && env !== "") return env;
  const custom = readPreferences().defaultWorkspacePath;
  if (custom !== void 0 && custom.trim() !== "" && isAbsolute(custom)) return custom;
  return getWorkspaceDir();
}

export {
	EMPTY,
	PROXY_MODES,
	SKILL_NAME_PATTERN,
	filterEnabledSkills,
	normalizeProxyUrl,
	readProxy,
	validateProxyInput,
	getEffectiveWorkspaceRoot,
	getPath$1,
	isSkillEnabled,
	isThemePreference,
	isUpdateChannel,
	readPaletteMemory,
	readPermissions,
	readPreferences,
	readRuntimePrefs,
	readSkillOverrides,
	writePreferences,
};
