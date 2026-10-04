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
    const paletteMemory = readPaletteMemory(record.paletteMemory);
    const styleId = typeof record.styleId === "string" ? record.styleId : void 0;
    const memoryEnabled = typeof record.memoryEnabled === "boolean" ? record.memoryEnabled : void 0;
    const agentTeamsEnabled = typeof record.agentTeamsEnabled === "boolean" ? record.agentTeamsEnabled : void 0;
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
      ...runtimes !== void 0 ? { runtimes } : {}
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
	SKILL_NAME_PATTERN,
	filterEnabledSkills,
	getEffectiveWorkspaceRoot,
	getPath$1,
	isSkillEnabled,
	isThemePreference,
	readPaletteMemory,
	readPermissions,
	readPreferences,
	readRuntimePrefs,
	readSkillOverrides,
	writePreferences,
};
