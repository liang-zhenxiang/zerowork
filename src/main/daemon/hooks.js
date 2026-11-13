/**
 * 确定性 hooks —— 让「某些动作总是发生」成为可配置的事实，而不是提示词里的愿望。
 *
 * ## 为什么是独立模块（与 watch-policy.js / permission-rules.js 同一套理由）
 *
 * `session-files.js` 在模块顶层就 `requireParentPort()` 并 `loadResources()`，
 * 在 Electron utilityProcess 之外根本 import 不了。把配置解析、匹配、子进程执行、
 * 退出码判定放在那里等于放弃单测。本模块**只碰 node 内置模块**（fs / path /
 * child_process），vitest 能直接 import，把「任一来源拒绝即拒绝」这条安全性质、
 * 退出码判定与超时回收一路钉死。
 *
 * ## 三条不能破的性质
 *
 *  1. **hook 只有「放行（无意见）」与「拒绝」两种返回值，没有 allow。**
 *     于是「用户级不能放宽工作区级」不是靠合并算法，而是靠类型设计：
 *     用户级无论怎么写，都只能**增加**拒绝，不能撤销工作区级的拒绝。
 *     （与 watch-policy 的「只收不放」同一条性质，但这里更简单。）
 *  2. **配置损坏时 fail-closed。** 已生效的来源（用户级 / 已信任的工作区）
 *     结构非法时，PreToolUse 直接拒绝并说明文件与原因 —— 不能让用户以为
 *     有约束、实际没有（daemon spec 的「宁可拒绝，也不静默降级」）。
 *  3. **无命中 hook 时不 spawn 任何进程。** 空配置/未命中即零成本：
 *     一次工具调用不该为一个没配 hook 的事件付子进程开销。
 *
 * ## 工作区 hooks 默认不执行
 *
 * `.zerowork/hooks.json` 随仓库分发，内容会被执行 —— 等价于「克隆即执行代码」。
 * 所以它默认**不生效**，必须由用户在设置里按**绝对路径**显式信任；
 * 未信任时只读展示、记一条 `hook/skipped` 审计，不 spawn。
 *
 * ## 事件边界
 *
 * 五个事件，分两类：
 *
 * **工具事件**（matcher 比工具名）
 *   - `PreToolUse`  —— 工具调用之前、权限检查之前；可阻断（终局）。
 *   - `PostToolUse` —— 工具真正执行之后；只写审计，不改变工具结果。
 * 被 PreToolUse 拦下的调用不会触发 PostToolUse（pi 的 agent-loop 直接返回）。
 *
 * **生命周期事件**（没有工具名，不可阻断）
 *   - `SessionStart`     ← pi 的 `session_start`（startup / reload / new / resume / fork）
 *   - `UserPromptSubmit` ← pi 的 `before_agent_start`，且 `messageType === "user"`
 *   - `Stop`             ← pi 的 `agent_settled`（无自动重试 / 压缩 / 排队续跑之后）
 *
 * 生命周期事件**永不改变会话结果**：hook 的 exit 2 也只是「拒绝（未阻断）」，
 * stdout **不进入提示词**（不做上下文注入，见 SECURITY.md 与 design §二）——
 * 本地脚本的输出静默进入提示词等于新增一条提示注入面，且与「只是跑了个脚本」
 * 的心智不符。
 *
 * 注意 `Stop` 用 `agent_settled` 而不是 `agent_end`：当前 pi 的 `AgentEndEvent`
 * 没有 `willRetry`，一次模型失败的重试也会先发 `agent_end` —— 那不是「一轮结束」。
 */
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/** 支持的事件。顺序即设置页下拉的顺序。 */
const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit", "Stop"];

/** 按工具名匹配的事件。matcher 只对这两类有意义。 */
const TOOL_EVENTS = /* @__PURE__ */ new Set(["PreToolUse", "PostToolUse"]);

/**
 * 生命周期事件。**都不可阻断**（`BLOCKING_EVENTS` 只含 PreToolUse），
 * 且没有工具名 —— matcher 必须是缺省 / `""` / `"*"`（见 normalizeHook）。
 */
const LIFECYCLE_EVENTS = /* @__PURE__ */ new Set(["SessionStart", "UserPromptSubmit", "Stop"]);

/** 可阻断的事件。只有这一类会把 hook 的拒绝变成工具调用的终局。 */
const BLOCKING_EVENTS = /* @__PURE__ */ new Set(["PreToolUse"]);

/** 单条 hook 的缺省超时（毫秒）。 */
const HOOK_TIMEOUT_DEFAULT = 5000;

/** 超时下限 —— 低于一秒的命令基本只能做常量判断，起进程本身就不止。 */
const HOOK_TIMEOUT_MIN = 1000;

/** 超时上限 —— 再长就不该是「工具调用前的门」，而是后台任务。 */
const HOOK_TIMEOUT_MAX = 30000;

/** 单份配置最多几条 hook（与 watch-policy 的 WATCH_MAX_* 同族）。 */
const HOOKS_MAX_COUNT = 32;

/** 单条命令长度上限（字符）。 */
const HOOK_COMMAND_MAX = 2000;

/** matcher 长度上限。matcher 只支持精确名 / `*` / `前缀*`，不引入正则。 */
const HOOK_MATCHER_MAX = 200;

/** stdout / stderr 各自保留的字符数（审计另按 240 字截断）。 */
const HOOK_OUTPUT_MAX = 8 * 1024;

/** 工作区 hooks 文件大小上限：配置文件不该长到读起来有成本。 */
const HOOK_CONFIG_MAX_BYTES = 256 * 1024;

/** 信任名单最多记多少个工作区（防止偏好文件被无限追加）。 */
const TRUSTED_WORKSPACES_MAX = 64;

/**
 * 导入文件大小上限。
 *
 * 与工作区配置同族的判据（「配置不该长到读起来有成本」），但取更严的一档：
 * 工作区文件是本机里用户自己的东西，导入文件则是**外来输入**。
 */
const HOOK_IMPORT_MAX_BYTES = 128 * 1024;

/** 超时后等待 close 的兜底时长：SIGKILL 之后仍要回收，但不能无限等。 */
const HOOK_KILL_GRACE_MS = 1000;

/**
 * `PostToolUse` 的载荷里 `ok` 的判据：工具结果被标记为错误即 false。
 * 这里只做形状判断，不解读内容。
 */
function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * matcher 匹配。只支持三种写法（PRD 明确不做正则，避免 ReDoS 与非法正则边界）：
 *   - `undefined` / `""` / `"*"` → 全部
 *   - `"write*"`                → 工具名前缀
 *   - `"write"`                 → 精确名
 *
 * 含多个 `*` 或 `*` 不在末尾的写法一律按精确名处理（匹配不到就匹配不到，
 * 不猜用户意图）—— 静默把 `wr*te` 当成正则才是更坏的行为。
 */
function matchTool(matcher, toolName) {
	if (matcher === undefined || matcher === null || matcher === "" || matcher === "*") return true;
	if (typeof matcher !== "string" || typeof toolName !== "string") return false;
	if (matcher.endsWith("*") && !matcher.slice(0, -1).includes("*")) {
		return toolName.startsWith(matcher.slice(0, -1));
	}
	return matcher === toolName;
}

/**
 * 这个 hook 是否对该事件 / 工具生效。
 *
 * matcher **只对工具事件有意义**；生命周期事件忽略 matcher
 *（写侧也不许给它写工具名，见 normalizeHook —— 接受一个永不生效的
 * matcher 比报错更坏）。
 */
function matchesEvent(hook, event, toolName) {
	if (hook.event !== event) return false;
	if (TOOL_EVENTS.has(event)) return matchTool(hook.matcher, toolName);
	return true;
}

/**
 * 校验并规范化一条 hook。**非法值抛错，不静默修正** ——
 * 「参数被接受却不生效」比报错更危险（与 watch-policy.parseWatchPolicy 同一姿态）。
 *
 * @returns {{id: string, event: string, matcher: string|undefined, command: string, timeoutMs: number}}
 */
function normalizeHook(raw, index = 0) {
	if (!isPlainObject(raw)) throw new Error("hook 必须是一个对象");
	const event = raw.event;
	if (typeof event !== "string" || !HOOK_EVENTS.includes(event)) {
		throw new Error(`hook 的事件只能是 ${HOOK_EVENTS.join(" / ")}，实际是 ${JSON.stringify(event)}`);
	}
	const command = raw.command;
	if (typeof command !== "string" || command.trim() === "") {
		throw new Error("hook 的命令不能为空");
	}
	if (command.length > HOOK_COMMAND_MAX) {
		throw new Error(`hook 的命令最长 ${HOOK_COMMAND_MAX} 个字符`);
	}
	let matcher;
	if (raw.matcher !== undefined && raw.matcher !== null && raw.matcher !== "") {
		if (typeof raw.matcher !== "string") throw new Error("hook 的 matcher 必须是字符串");
		if (raw.matcher.length > HOOK_MATCHER_MAX) {
			throw new Error(`hook 的 matcher 最长 ${HOOK_MATCHER_MAX} 个字符`);
		}
		matcher = raw.matcher;
	}
	/*
	 * 生命周期事件没有工具名可比。接受一个 `"write*"` 只会得到一条**永不生效**
	 * 的配置（matchesEvent 会忽略 matcher），用户以为有筛选、其实没有 ——
	 * 与 watch-policy 的「接受却不生效比报错更坏」同一姿态。
	 */
	if (LIFECYCLE_EVENTS.has(event) && matcher !== undefined && matcher !== "*") {
		throw new Error(
			`hook 的事件 ${event} 没有工具名，matcher 只能留空或写 *（实际是 ${JSON.stringify(matcher)}）`
		);
	}
	let timeoutMs = HOOK_TIMEOUT_DEFAULT;
	if (raw.timeoutMs !== undefined && raw.timeoutMs !== null) {
		if (!Number.isInteger(raw.timeoutMs)) throw new Error("hook 的超时必须是整数毫秒");
		if (raw.timeoutMs < HOOK_TIMEOUT_MIN || raw.timeoutMs > HOOK_TIMEOUT_MAX) {
			throw new Error(`hook 的超时必须在 ${HOOK_TIMEOUT_MIN}–${HOOK_TIMEOUT_MAX} 毫秒之间`);
		}
		timeoutMs = raw.timeoutMs;
	}
	let id = `auto-${index + 1}`;
	if (raw.id !== undefined && raw.id !== null && raw.id !== "") {
		if (typeof raw.id !== "string") throw new Error("hook 的 id 必须是字符串");
		if (raw.id.length > 80) throw new Error("hook 的 id 最长 80 个字符");
		id = raw.id;
	}
	return { id, event, ...(matcher === undefined ? {} : { matcher }), command, timeoutMs };
}

/**
 * 宽容解析一份配置（读侧）。单条坏数据只丢该条，**不整块失效**；
 * 只有结构本身坏掉（不是对象 / hooks 不是数组）才是 fatal。
 *
 * @param {unknown} raw 配置值（数组，或 `{ version, hooks: [] }`）
 * @param {string} source 来源名（"user" / "workspace"），只用于错误文案
 * @returns {{hooks: object[], errors: object[], fatal: boolean, fatalMessage: string|undefined}}
 */
function parseHookConfig(raw, source = "user") {
	const empty = { hooks: [], errors: [], fatal: false, fatalMessage: void 0 };
	if (raw === undefined || raw === null) return empty;
	let list;
	if (Array.isArray(raw)) {
		list = raw;
	} else if (isPlainObject(raw) && Array.isArray(raw.hooks)) {
		list = raw.hooks;
	} else {
		return {
			...empty,
			fatal: true,
			fatalMessage: `${source} 的 hooks 配置必须是数组，或 { version, hooks: [...] } 对象`
		};
	}
	if (list.length > HOOKS_MAX_COUNT) {
		return {
			...empty,
			fatal: true,
			fatalMessage: `${source} 的 hooks 最多 ${HOOKS_MAX_COUNT} 条（实际 ${list.length} 条）`
		};
	}
	const hooks = [];
	const errors = [];
	for (const [index, entry] of list.entries()) {
		try {
			hooks.push(normalizeHook(entry, index));
		} catch (error) {
			errors.push({ index, message: errorText(error) });
		}
	}
	return { hooks, errors, fatal: false, fatalMessage: void 0 };
}

/**
 * 写侧校验：任何一条非法都抛错（读侧宽容、写侧严格，写进去的必须能原样读回来）。
 * 同时拒绝重复 id —— 删除/试运行按 id 定位，重复会让行为不确定。
 *
 * @returns {object[]} 规范化后的 hook 数组
 */
function assertHookConfig(raw) {
	const parsed = parseHookConfig(raw, "hooks");
	if (parsed.fatal) throw new Error(parsed.fatalMessage ?? "hooks 配置非法");
	if (parsed.errors.length > 0) {
		const first = parsed.errors[0];
		throw new Error(`第 ${first.index + 1} 条 hook 非法：${first.message}`);
	}
	const seen = new Set();
	for (const hook of parsed.hooks) {
		if (seen.has(hook.id)) throw new Error(`hook id 重复：${hook.id}`);
		seen.add(hook.id);
	}
	return parsed.hooks;
}

/**
 * 导入文本 → JSON 值。
 *
 * 与 `readWorkspaceHookConfig` 的区别：那里读的是**本机文件**，错误折进 fatal
 * 供界面展示；这里是**不可信输入**，任何问题都必须抛一句能解释「为什么不行」
 * 的错误 —— 调用方要么拿到完整值，要么拿到可诊断的原因，没有中间态。
 *
 * 大小按 **UTF-8 字节**算，不是字符数：中文命令按字符数判会放过三倍体积的文件。
 */
function parseHookImportText(text) {
	if (typeof text !== "string") throw new Error("导入内容必须是文本");
	const bytes = Buffer.byteLength(text, "utf8");
	if (bytes > HOOK_IMPORT_MAX_BYTES) {
		throw new Error(`导入文件超过 ${HOOK_IMPORT_MAX_BYTES} 字节上限（实际 ${bytes} 字节）`);
	}
	try {
		return JSON.parse(text);
	} catch (error) {
		throw new Error(`导入文件不是合法 JSON：${errorText(error)}`);
	}
}

/**
 * 按 id 合并两份**已规范化**的 hooks：同 id 覆盖原位置，新 id 追加。
 *
 * 不整份替换：导入一份只含一条的文件时，用户原有的其余 hooks 不该消失。
 * 覆盖而不是并存：id 是删除 / 试运行 / 执行时的定位键，重复会让行为不确定
 * （写侧的 `assertHookConfig` 也会拒绝重复 id）。
 *
 * 纯函数：返回新数组与新条目对象，入参的数组与元素都不被修改。
 */
function mergeHookConfigs(existing, incoming) {
	const out = (Array.isArray(existing) ? existing : []).map((hook) => ({ ...hook }));
	const indexById = new Map(out.map((hook, index) => [hook.id, index]));
	for (const hook of Array.isArray(incoming) ? incoming : []) {
		const copy = { ...hook };
		const at = indexById.get(copy.id);
		if (at === void 0) {
			indexById.set(copy.id, out.length);
			out.push(copy);
		} else {
			out[at] = copy;
		}
	}
	return out;
}

/**
 * 导入预览：把「文件里有什么」与「合并后会变成什么」一次算清楚，**不写盘**。
 *
 * 复用读侧的 `parseHookConfig` —— 宽严必须与真正落盘时一致，否则会出现
 * 「预览说没问题、点导入却被拒」。逐条错误保留**原始 index**（用户对着文件数行）；
 * 重复 id 额外报一条：读侧不查重、写侧查重，预览必须提前说清，不能等用户
 * 点了「导入」才看到错误。
 *
 * `mergedError` 是**合并后才成立**的那一类判据（今天只有条数上限）：
 * 两份配置各自合法，合在一起却越界。它不属于任何一条导入条目，所以
 * 不能塞进 `errors`（那条会被渲染成「第 N 条」，而文件里并没有那条）。
 *
 * @returns {{fatal?: string, mergedError?: string, incoming: object[], merged: object[], errors: {index: number, message: string}[]}}
 */
function previewHookImport(raw, existing = []) {
	const parsed = parseHookConfig(raw, "导入文件");
	if (parsed.fatal) {
		return {
			fatal: parsed.fatalMessage ?? "导入文件的结构非法",
			incoming: [],
			merged: mergeHookConfigs(existing, []),
			errors: []
		};
	}
	const errors = parsed.errors.map((entry) => ({ ...entry }));
	/*
	 * 重复 id 的下标要落在**文件里的位置**上：`parseHookConfig` 的 `hooks` 只保留
	 * 合法条目，原始下标已经丢了。这里按同一份列表再走一遍，只为建 id → index
	 * 的映射（非法条目会抛，跳过即可 —— 它们已经在上面的 errors 里）。
	 */
	const list = Array.isArray(raw) ? raw : isPlainObject(raw) && Array.isArray(raw.hooks) ? raw.hooks : [];
	const firstIndexById = new Map();
	for (const [index, entry] of list.entries()) {
		let id;
		try {
			id = normalizeHook(entry, index).id;
		} catch {
			continue;
		}
		if (firstIndexById.has(id)) {
			errors.push({ index, message: `导入文件里有重复 id：${id}` });
		} else {
			firstIndexById.set(id, index);
		}
	}
	errors.sort((a, b) => a.index - b.index);
	const merged = mergeHookConfigs(existing, parsed.hooks);
	/*
	 * 合并后的条数只能在**这里**判：`parseHookConfig` 只看导入文件自己（≤32 条），
	 * 而「原有 20 条 + 导入 20 条」是两份各自合法的配置、合并后却越界 ——
	 * 落盘侧会被 `assertHookConfig` 拒掉。预览必须提前说清，否则正是设计里
	 * 点名要避免的「预览说没问题、点导入却被拒」。
	 *
	 * 归到 `mergedError` 而不是 `errors`：它不属于文件里的任何一条，渲染成
	 * 「第 N 条：…」会让用户去文件里找一条并不存在的错误。
	 */
	let mergedError;
	if (merged.length > HOOKS_MAX_COUNT) {
		const kept = Array.isArray(existing) ? existing.length : 0;
		mergedError = `合并后共 ${merged.length} 条，超过 ${HOOKS_MAX_COUNT} 条上限（现有 ${kept} 条 + 导入 ${parsed.hooks.length} 条）—— 请先删掉一些旧的再导入`;
	} else {
		// 兜底：将来若合并后才暴露别的写侧判据，预览也跟着一起严。
		try {
			assertHookConfig(merged);
		} catch (error) {
			mergedError = errorText(error);
		}
	}
	return {
		incoming: parsed.hooks,
		merged,
		errors,
		...(mergedError === void 0 ? {} : { mergedError })
	};
}

/**
 * 规范化信任名单（读侧宽容）：非数组整块忽略，逐条丢掉非法值并去重。
 * 返回 undefined 表示「没有写这个键」。
 */
function normalizeTrustedWorkspaceHooks(raw) {
	if (raw === undefined) return void 0;
	if (!Array.isArray(raw)) {
		console.error("偏好文件的 trustedWorkspaceHooks 应为字符串数组，已整块忽略：", raw);
		return void 0;
	}
	const out = [];
	const seen = new Set();
	for (const entry of raw) {
		if (typeof entry !== "string" || entry.trim() === "") continue;
		const normalized = normalizeWorkspacePath(entry);
		if (seen.has(normalized)) continue;
		seen.add(normalized);
		out.push(normalized);
		if (out.length >= TRUSTED_WORKSPACES_MAX) break;
	}
	return out.length === 0 ? void 0 : out;
}

/**
 * 工作区路径的规范形：**绝对且真实**的路径。
 *
 *  - `resolve` 先把 `..` / 相对片段消掉；
 *  - `realpath` 把符号链接展开。这一条是必需的：macOS 上 `/tmp` 与 `/var`
 *    都是链接（`/tmp/ws` 与 `/private/tmp/ws` 是同一个目录），Windows 上的
 *    目录联接同理。两边不统一时，用户「信任了」但会话 cwd 走的是另一个写法，
 *    信任静默不生效 —— 用户以为规则在跑，其实没有；
 *  - Windows 上大小写不敏感，统一小写后比较。
 *
 * 目录不存在或没有权限时退回 `resolve` 的结果（`realpath` 会抛），
 * 此时它本来也无从「被执行」。
 */
function normalizeWorkspacePath(path) {
	let absolute = resolve(path);
	try {
		absolute = realpathSync(absolute);
	} catch {
		/* 路径还不存在：按 resolve 的写法比较 */
	}
	return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

/** 目标是否在工作区根之内（含根本身不算「文件在根内」）。 */
function isPathInside(root, target) {
	const rel = relative(resolve(root), resolve(target));
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function isWorkspaceTrusted(workspaceRoot, trustedWorkspaceHooks) {
	if (!Array.isArray(trustedWorkspaceHooks)) return false;
	const target = normalizeWorkspacePath(workspaceRoot);
	return trustedWorkspaceHooks.some((entry) => typeof entry === "string" && normalizeWorkspacePath(entry) === target);
}

/**
 * hooks 的查找根（纯函数，便于单测）。
 *
 * 优先级：
 *   1. worktree 的**源仓库**（`sourceCwd`）—— worktree 路径每次都新，
 *      按路径信任永远命中不了；用源仓库根，用户在那个仓库上信任的规则才生效，
 *      也避免把另一个已信任工作区的规则套到无关项目上。
 *   2. 临时任务 / 自动会话目录（cwd 为空或任务区）→ 生效工作区根。
 *   3. 普通会话 → cwd 本身。
 */
function chooseWorkspaceRoot({ cwd, sourceCwd, isTask, effectiveRoot }) {
	if (typeof sourceCwd === "string" && sourceCwd !== "") return sourceCwd;
	if (cwd === "" || isTask === true) return effectiveRoot;
	return cwd;
}

/** 工作区 hooks 文件的约定位置。 */
function workspaceHooksPath(workspaceRoot) {
	return join(workspaceRoot, ".zerowork", "hooks.json");
}

/**
 * 读工作区配置（**不判断信任**：信任是「是否执行」的问题，读出来是为了
 * 设置页能只读展示与审计能说清为什么跳过）。
 *
 * @returns {{path: string, exists: boolean, config: object}}
 */
function readWorkspaceHookConfig(workspaceRoot) {
	const path = workspaceHooksPath(workspaceRoot);
	const empty = { hooks: [], errors: [], fatal: false, fatalMessage: void 0 };
	if (!existsSync(path)) return { path, exists: false, config: empty };

	/*
	 * 符号链接防线：`.zerowork` 可能是仓库里的一条链接，把 hooks.json 指到
	 * 工作区之外。读到的内容本身不会执行（未信任时），但「工作区配置」的
	 * 语义会被绕过，所以在读取前先比 realpath。
	 */
	let real = path;
	try {
		real = realpathSync(path);
	} catch {
		/* 读不到 realpath 就按原路径继续，下面的 readFileSync 会给出可诊断错误 */
	}
	let rootReal;
	try {
		rootReal = realpathSync(workspaceRoot);
	} catch {
		rootReal = resolve(workspaceRoot);
	}
	if (!isPathInside(rootReal, real)) {
		return {
			path,
			exists: true,
			config: {
				...empty,
				fatal: true,
				fatalMessage: `hooks.json 不在工作区之内（可能是指向别处的符号链接）：${real}`
			}
		};
	}

	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		return {
			path,
			exists: true,
			config: { ...empty, fatal: true, fatalMessage: `读取 hooks.json 失败：${errorText(error)}` }
		};
	}
	if (text.length > HOOK_CONFIG_MAX_BYTES) {
		return {
			path,
			exists: true,
			config: {
				...empty,
				fatal: true,
				fatalMessage: `hooks.json 超过 ${HOOK_CONFIG_MAX_BYTES} 字节上限`
			}
		};
	}
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return {
			path,
			exists: true,
			config: { ...empty, fatal: true, fatalMessage: `hooks.json 不是合法 JSON：${errorText(error)}` }
		};
	}
	return { path, exists: true, config: parseHookConfig(parsed, "工作区") };
}

/**
 * 合并来源：
 *   - 用户级 hooks 始终生效；
 *   - 工作区 hooks 只有在**按绝对路径被明确信任**时才进入可执行集合；
 *   - 顺序固定为用户级 → 工作区级（任一拒绝即停，报第一个拒绝）。
 *   - 未信任的工作区配置仍然解析出来（只读展示），但不进入 hooks。
 *
 * fatal 只累计**已生效来源**的结构性错误：未信任的工作区配置坏了不该拦住
 * 每一次工具调用（它本来就不执行），但已在设置页红字说明。
 */
function resolveHookSet({ user, workspaceRoot, trustedWorkspaceHooks }) {
	const userConfig = user ?? { hooks: [], errors: [], fatal: false, fatalMessage: void 0 };
	const workspace = readWorkspaceHookConfig(workspaceRoot);
	const trusted = isWorkspaceTrusted(workspaceRoot, trustedWorkspaceHooks);

	const hooks = [...userConfig.hooks];
	const errors = userConfig.errors.map((entry) => ({ ...entry, source: "user" }));
	const fatal = [];
	if (userConfig.fatal) fatal.push({ source: "user", message: userConfig.fatalMessage });

	if (workspace.exists && trusted) {
		const config = workspace.config;
		if (config.fatal) {
			fatal.push({ source: "workspace", path: workspace.path, message: config.fatalMessage });
		}
		hooks.push(...config.hooks);
		errors.push(...config.errors.map((entry) => ({ ...entry, source: "workspace", path: workspace.path })));
	}

	return {
		hooks,
		errors,
		fatal,
		skippedWorkspace: workspace.exists && !trusted,
		workspace: {
			path: workspace.path,
			exists: workspace.exists,
			trusted,
			hooks: workspace.exists ? workspace.config.hooks : [],
			errors: workspace.exists ? workspace.config.errors : [],
			fatalMessage: workspace.exists ? workspace.config.fatalMessage : void 0
		}
	};
}

/**
 * 试运行入口的**纵深防御**：只接受「已保存 hook 的 id」。
 *
 * 渲染层传什么都只取 id，命令与事件一律从 `config.hooks` 里取 ——
 * 否则 `hooks:test` 就成了「执行任意命令」的第二条入口（与保存一条 hook
 * 再等它生效不同，这条是立即执行）。未知 id 直接拒绝，绝不回退到
 * 「按传入内容执行」。
 *
 * @param {{hooks: object[]}} config `readHooksConfig().config`
 * @param {unknown} input 字符串 id，或带 id 的对象（其余字段读都不读）
 * @returns {object} 已保存的那条 hook
 */
function resolveSavedHook(config, input) {
	const id =
		typeof input === "string"
			? input
			: isPlainObject(input) && typeof input.id === "string"
				? input.id
				: "";
	if (id === "") throw new Error("试运行需要已保存 hook 的 id");
	const hook = config.hooks.find((entry) => entry.id === id);
	if (hook === void 0) {
		throw new Error(`未知的 hook id：${id}（请先在设置里保存这条 hook 再试运行）`);
	}
	return hook;
}

/**
 * 退出码 → 判定。`allow` 是「无意见」，不是「允许一切」：
 * 拒绝与失败在 PreToolUse 都是阻止，区别只在审计 outcome 与文案。
 */
function decideVerdict({ exitCode, timedOut, spawnError }) {
	if (spawnError !== undefined && spawnError !== null && spawnError !== "") return "fail";
	if (timedOut) return "fail";
	if (exitCode === 0) return "allow";
	if (exitCode === 2) return "deny";
	return "fail";
}

/**
 * 按平台拼 shell 调用。**用显式参数而不是 `shell: true`**：
 * 后者的引号/转义由 Node 各平台自行解释，行为不可控；显式传
 * `["/bin/sh", "-lc", command]` / `["cmd.exe", "/d", "/s", "/c", command]`
 * 至少让「跑的是哪个 shell」是代码里写死的事实。
 *
 * `windowsVerbatimArguments` 是 Windows 上**必需**的那一半，不是可选优化：
 *
 *  - 交给 Node 自动加引号会把命令里的 `"` 转义成 `\"` —— cmd.exe 不认反斜杠
 *    转义，于是 `"C:\Program Files\node.exe" hook.js` 这种最常见的 Windows
 *    写法会被拆坏（路径带空格就必现）；
 *  - 自己拼成 `["/d","/s","/c", command]` 也不行：`/s` 的规则是「命令串以引号
 *    开头且以引号结尾时剥掉最外一层」，用户命令正好以引号开头结尾时会被剥错。
 *
 * 所以正确的组合是「verbatim + 自己再套一层引号」：cmd 剥掉我们加的这对，
 * 剩下的逐字就是用户写的那条命令。不加引号的简单命令（`node x.js`）同样正确。
 */
function shellInvocation(command, platform) {
	if (platform === "win32") {
		const comspec = process.env["ComSpec"];
		const file = typeof comspec === "string" && comspec !== "" ? comspec : "cmd.exe";
		return {
			file,
			args: ["/d", "/s", "/c", `"${command}"`],
			windowsVerbatimArguments: true
		};
	}
	return { file: "/bin/sh", args: ["-lc", command], windowsVerbatimArguments: false };
}

/** 超时后杀进程树：Windows 用 taskkill /T，POSIX 杀整个进程组。 */
function killProcessTree(child, platform, spawnFn) {
	if (child === undefined || child === null || typeof child.pid !== "number") return;
	if (platform === "win32") {
		try {
			spawnFn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true
			}).on("error", () => {
				/* taskkill 本身失败时退回 child.kill */
			});
		} catch {
			/* 退回 child.kill */
		}
		try {
			child.kill();
		} catch {
			/* 已经退出 */
		}
		return;
	}
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch {
		try {
			child.kill("SIGKILL");
		} catch {
			/* 已经退出 */
		}
	}
}

function appendCapped(current, chunk) {
	if (current.length >= HOOK_OUTPUT_MAX) return current;
	const next = current + chunk;
	return next.length > HOOK_OUTPUT_MAX ? next.slice(0, HOOK_OUTPUT_MAX) : next;
}

/**
 * 执行一条 hook。**判定与 spawn 分离**：单测注入假的 `deps.spawn`
 * 就能覆盖超时 / 启动失败 / 退出码 / 输出截断，不依赖 bash / PowerShell 存在
 * （单测在 ubuntu 与 windows 两个 job 上跑）。
 *
 * @returns {Promise<{verdict: string, exitCode: number|undefined, timedOut: boolean,
 *   spawnError: string|undefined, stdout: string, stderr: string, durationMs: number}>}
 */
function runHook(hook, payload, deps = {}) {
	const spawnFn = deps.spawn ?? nodeSpawn;
	const platform = deps.platform ?? process.platform;
	const now = deps.now ?? Date.now;
	const startedAt = now();
	const invocation = shellInvocation(hook.command, platform);

	return new Promise((resolvePromise) => {
		let child;
		try {
			child = spawnFn(invocation.file, invocation.args, {
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
				// 见 shellInvocation：Windows 上必须 verbatim，否则内层引号会被拆坏。
				windowsVerbatimArguments: invocation.windowsVerbatimArguments,
				// POSIX 上 detached 让子进程自成一个进程组 —— 超时时能整组杀掉，
				// 不会留下 hook 自己起的孙进程。
				detached: platform !== "win32"
			});
		} catch (error) {
			resolvePromise({
				verdict: "fail",
				exitCode: void 0,
				timedOut: false,
				spawnError: errorText(error),
				stdout: "",
				stderr: "",
				durationMs: now() - startedAt
			});
			return;
		}

		let settled = false;
		let timedOut = false;
		let exitCode;
		let stdout = "";
		let stderr = "";
		let spawnError;
		let timer;
		let killGraceTimer;

		const finish = () => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) clearTimeout(timer);
			if (killGraceTimer !== undefined) clearTimeout(killGraceTimer);
			const verdict = decideVerdict({ exitCode, timedOut, spawnError });
			resolvePromise({
				verdict,
				exitCode,
				timedOut,
				spawnError,
				stdout,
				stderr,
				durationMs: now() - startedAt
			});
		};

		/*
		 * 子进程完全可能不读 stdin（例如只做常量判断的脚本）。写入失败会触发
		 * EPIPE —— 必须吞掉，否则 daemon 会把它记成 unhandledRejection/fatal。
		 */
		child.stdin?.on?.("error", () => {});
		try {
			child.stdin?.end?.(JSON.stringify(payload), "utf8");
		} catch {
			/* 见上：stdin 不可写不是 hook 的失败 */
		}

		child.stdout?.on?.("data", (chunk) => {
			stdout = appendCapped(stdout, String(chunk));
		});
		child.stderr?.on?.("data", (chunk) => {
			stderr = appendCapped(stderr, String(chunk));
		});
		child.on?.("error", (error) => {
			spawnError = errorText(error);
			finish();
		});
		child.on?.("close", (code) => {
			if (typeof code === "number") exitCode = code;
			finish();
		});

		timer = setTimeout(() => {
			timedOut = true;
			killProcessTree(child, platform, spawnFn);
			/*
			 * SIGKILL 之后正常情况下会收到 close。若没有（被别的进程接管、
			 * 或平台行为差异），也不能让一次工具调用永远挂在这里 ——
			 * 兜底结束，并保留 timedOut 让审计说清原因。
			 */
			killGraceTimer = setTimeout(finish, HOOK_KILL_GRACE_MS);
		}, hook.timeoutMs);
	});
}

/**
 * 顺序执行一组 hook。
 *   - 可阻断事件：第一条不是 `allow` 的就停（deny / fail 都是终局）。
 *   - 不可阻断事件：全部跑完，各自记结果（PostToolUse 只审计）。
 *
 * 没有命中时返回空数组；调用方据此**不 spawn**（本函数对空数组也不会 spawn）。
 */
async function runHooks(hooks, payload, event, deps = {}) {
	const results = [];
	const blockable = BLOCKING_EVENTS.has(event);
	for (const hook of hooks) {
		const result = await runHook(hook, payload, deps);
		results.push({ hook, result });
		if (blockable && result.verdict !== "allow") break;
	}
	return results;
}

/** PreToolUse 载荷。**不含密钥**：只有事件、工具名/入参、会话 id/cwd、时间。 */
function payloadForPreToolUse({ toolName, input, sessionId, cwd, now = Date.now }) {
	return {
		event: "PreToolUse",
		tool: { name: toolName, input },
		session: { id: sessionId ?? "", cwd: cwd ?? "" },
		timestamp: now()
	};
}

/**
 * PostToolUse 载荷：在 Pre 的形状上追加执行结果。
 *
 * `input` 故意**不截断**：hook 的常见用法就是检查这次写入/执行的内容，
 * 截断会让「检查了前半段就放行」变成一个说不清的行为。`error` 不同 ——
 * 它是状态摘要，不是被检查的对象，所以按输出上限收（否则一次失败的工具
 * 结果可能把几百 KB 灌进 hook 的 stdin）。
 */
function payloadForPostToolUse({ toolName, input, sessionId, cwd, ok, error, now = Date.now }) {
	const errorSummary = typeof error === "string" && error !== "" ? error : void 0;
	return {
		event: "PostToolUse",
		tool: { name: toolName, input },
		session: { id: sessionId ?? "", cwd: cwd ?? "" },
		ok: ok === true,
		...(errorSummary === void 0
			? {}
			: { error: errorSummary.length > HOOK_OUTPUT_MAX ? `${errorSummary.slice(0, HOOK_OUTPUT_MAX)}…` : errorSummary }),
		timestamp: now()
	};
}

/**
 * 生命周期事件的三个载荷。形状与工具事件一致（`event` / `session` / `timestamp`），
 * 只是把「工具」换成各自的事实。
 *
 * `prompt` **不截断**：hook 的常见用法就是看用户到底说了什么，截断会造成
 * 「只检查了前半段就放行」。它由用户本地代码消费，不上传。三个载荷都不含密钥。
 */
function payloadForSessionStart({ sessionId, cwd, reason, now = Date.now }) {
	return {
		event: "SessionStart",
		session: { id: sessionId ?? "", cwd: cwd ?? "" },
		reason: typeof reason === "string" && reason !== "" ? reason : "startup",
		timestamp: now()
	};
}

function payloadForUserPromptSubmit({ sessionId, cwd, prompt, now = Date.now }) {
	return {
		event: "UserPromptSubmit",
		session: { id: sessionId ?? "", cwd: cwd ?? "" },
		prompt: typeof prompt === "string" ? prompt : "",
		timestamp: now()
	};
}

function payloadForStop({ sessionId, cwd, aborted, now = Date.now }) {
	return {
		event: "Stop",
		session: { id: sessionId ?? "", cwd: cwd ?? "" },
		aborted: aborted === true,
		timestamp: now()
	};
}

/** 审计 detail 的局部截断（audit.js 的上限是 240，这里先按同一口径收）。 */
function clip(text, max = 240) {
	const oneLine = String(text).replace(/\s+/g, " ").trim();
	return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

function stderrSummary(result) {
	const text = result.stderr.trim();
	if (text !== "") return clip(text, 160);
	if (result.spawnError !== undefined) return `启动失败：${clip(result.spawnError, 140)}`;
	if (result.timedOut) return "超时";
	if (result.exitCode !== undefined) return `退出码 ${result.exitCode}`;
	return "无输出";
}

/**
 * 一条 hook 运行结果的审计 detail（≤240 字）。
 *
 * `blockable` 影响措辞：不可阻断的事件（PostToolUse 与三个生命周期事件）写
 * 「拒绝 / 失败（未阻断）」—— 只写「拒绝」会让人误以为那次调用真的被拦下了。
 *
 * `toolName` 对生命周期事件**不存在**，此时省略这一段（写成 `undefined`
 * 会把审计变成一条读不懂的记录）。
 */
function auditDetail({ event, hook, toolName, result, blockable = true }) {
	const verdictText =
		result.verdict === "allow"
			? "放行"
			: result.verdict === "deny"
				? blockable
					? "拒绝"
					: "拒绝（未阻断）"
				: blockable
					? "失败"
					: "失败（未阻断）";
	const subject = typeof toolName === "string" && toolName !== "" ? ` ${toolName}` : "";
	return clip(
		`${event} ${verdictText}${subject}（hook ${hook.id}，${result.durationMs}ms，${stderrSummary(result)}）`
	);
}

/**
 * 拒绝理由（回给模型）：说清**哪个 hook、为什么、下一步怎么办**。
 * 与既有拒绝文案同一条纪律 —— 模型据此换路子，而不是原样重试。
 */
function refusalReason({ event, hook, toolName, result }) {
	const head = `${event} hook「${hook.id}」拦下了 ${toolName}`;
	if (result.verdict === "deny") {
		const reason = result.stderr.trim();
		return clip(
			`${head}（退出码 2）。${reason === "" ? "hook 没有给出原因。" : `原因：${reason}。`}这不是权限提示，无法通过重试绕过；请调整做法或让用户修改 hooks 配置。`,
			900
		);
	}
	const why = result.timedOut
		? `超时（${hook.timeoutMs}ms）`
		: result.spawnError !== undefined
			? `启动失败：${result.spawnError}`
			: `退出码 ${result.exitCode}（只接受 0 放行 / 2 拒绝）`;
	// 失败也要带上 stderr：hook 自己写的诊断往往正是修它的线索。
	const detail = result.stderr.trim() === "" ? "" : `；输出：${clip(result.stderr.trim(), 200)}`;
	return clip(
		`${head}，hook 执行失败：${why}${detail}。按 fail-closed 策略本次调用被阻止；请修好 hook 或让用户停用它，不要原样重试。`,
		900
	);
}

function fatalReason(fatal, toolName) {
	const first = fatal[0];
	const where = first.source === "workspace" ? first.path ?? "工作区 hooks.json" : "用户级 hooks 配置";
	return clip(
		`hooks 配置无效，已按 fail-closed 拒绝 ${toolName}：${where} —— ${first.message}。修好配置或在设置里停用后再试，不要原样重试。`,
		900
	);
}

/**
 * PreToolUse 扩展。**必须插在 extensions 数组最前面**（权限门之前）：
 * pi 按注册顺序跑 tool_call 监听器，第一条 `{block:true}` 即终止，
 * 于是 hook 拒绝是终局，权限门 / 检查器 / 沙箱都不会再跑。
 */
function createPreToolUseHookExtension(options) {
	return (pi) => {
		const set = options.hookSet;
		/*
		 * 未信任的工作区 hooks：每个会话记一条 skipped 审计（不是每次工具调用）。
		 * 设置页另有一份可见说明；审计是「它确实被跳过了」的证人。
		 */
		if (set.skippedWorkspace) {
			options.onAudit?.({
				category: "hook",
				outcome: "skipped",
				detail: clip(`工作区 hooks 未信任，已跳过：${set.workspace.path}`)
			});
		}
		pi.on("tool_call", async (event) => {
			const toolName = event.toolName;
			if (set.fatal.length > 0) {
				options.onAudit?.({
					category: "hook",
					outcome: "failed",
					detail: clip(`hooks 配置无效，已拒绝 ${toolName}：${set.fatal[0].message}`)
				});
				return { block: true, reason: fatalReason(set.fatal, toolName) };
			}
			const hooks = set.hooks.filter((hook) => matchesEvent(hook, "PreToolUse", toolName));
			// 无命中：零成本（不 spawn）。
			if (hooks.length === 0) return void 0;
			let sessionId = "";
			try {
				sessionId = options.getSessionId?.() ?? "";
			} catch {
				sessionId = "";
			}
			let results;
			try {
				const payload = payloadForPreToolUse({
					toolName,
					input: event.input,
					sessionId,
					cwd: options.cwd
				});
				results = await runHooks(hooks, payload, "PreToolUse", options.deps);
			} catch (error) {
				// 本模块不该抛，但真抛了也不能静默放行（fail-closed）。
				options.onAudit?.({
					category: "hook",
					outcome: "failed",
					detail: clip(`PreToolUse 执行异常，已拒绝 ${toolName}：${errorText(error)}`)
				});
				return {
					block: true,
					reason: `PreToolUse hook 执行异常，本次调用被阻止：${errorText(error)}。请修好 hooks 配置，不要原样重试。`
				};
			}
			for (const { hook, result } of results) {
				options.onAudit?.({
					category: "hook",
					outcome: result.verdict === "allow" ? "allowed" : result.verdict === "deny" ? "blocked" : "failed",
					detail: auditDetail({ event: "PreToolUse", hook, toolName, result })
				});
			}
			const blocked = results.find(({ result }) => result.verdict !== "allow");
			if (blocked === void 0) return void 0;
			return {
				block: true,
				reason: refusalReason({ event: "PreToolUse", hook: blocked.hook, toolName, result: blocked.result })
			};
		});
	};
}

/**
 * PostToolUse 扩展。**必须注册在 tool_result 链的最后**（spill / 团队产出之后）：
 * 后一个 handler 看到的是前一个改过的 content，排最后才是「模型最终看到的内容」。
 *
 * 只写审计，**永不改变工具结果**；自身异常一律吞掉（pi 会把 handler 抛错
 * 改写成错误文本，不能让一条观测钩子污染结果）。
 */
function createPostToolUseHookExtension(options) {
	return (pi) => {
		pi.on("tool_result", async (event) => {
			const set = options.hookSet;
			if (set.fatal.length > 0) return void 0;
			const hooks = set.hooks.filter((hook) => matchesEvent(hook, "PostToolUse", event.toolName));
			if (hooks.length === 0) return void 0;
			try {
				let sessionId = "";
				try {
					sessionId = options.getSessionId?.() ?? "";
				} catch {
					sessionId = "";
				}
				const payload = payloadForPostToolUse({
					toolName: event.toolName,
					input: event.input,
					sessionId,
					cwd: options.cwd,
					ok: event.isError !== true,
					error: event.isError === true ? contentText(event.content) : void 0
				});
				const results = await runHooks(hooks, payload, "PostToolUse", options.deps);
				for (const { hook, result } of results) {
					options.onAudit?.({
						category: "hook",
						// PostToolUse 不可阻断：exit 2 只说明 hook 不同意，并未真的拦下什么。
						// 记 blocked 会让审计中心出现一条「已拦截」而工具其实执行了。
						outcome: result.verdict === "allow" ? "allowed" : "failed",
						detail: auditDetail({ event: "PostToolUse", hook, toolName: event.toolName, result, blockable: false })
					});
				}
			} catch {
				/* 观测不应改变结果（见本函数头注释） */
			}
			return void 0;
		});
	};
}

/**
 * 生命周期扩展：`SessionStart` / `UserPromptSubmit` / `Stop`，**全部不可阻断**。
 *
 * 这个工厂刻意**不返回任何东西**：即使手滑改成 `{ block }` / `{ message }` /
 * `{ systemPrompt }`，pi 的那三个事件也不消费它 —— 但这里连写都不写，
 * 让「非阻断事件永远不能改变会话结果」是代码形状而不是约定
 *（PRD 的硬约束）。
 *
 * 三条执行纪律：
 *  1. `hookSet.fatal.length > 0` → **直接返回，不写审计**。工具事件已被
 *     fail-closed 拦下且每条调用留证；生命周期事件在每条消息上都重复记同一条
 *     配置错误，只会淹没审计（理由见 design §五）。
 *  2. 无命中 → 不 spawn（与工具事件同一条「空配置零成本」）。
 *  3. 整体 try/catch：异常写一条 failed 审计后吞掉 —— hook 是本地脚本，
 *     它的失败不该让会话或消息失败。
 *
 * **未信任工作区的 skipped 审计不由这里记**：那条记录归 PreToolUse 扩展，
 * 每个会话一条（design §六），重复记只会让审计出现两条同样的跳过。
 *
 * `UserPromptSubmit` 在用户等待路径上：最坏延迟 = 命中条数 × 超时。
 */
function createLifecycleHookExtension(options) {
	return (pi) => {
		const set = options.hookSet;
		/*
		 * 会话 id：先问装配点（主会话 / 子代理在 adopt 之后都能读到真值），
		 * 空时回落到 pi 的 `ctx.sessionManager`。
		 *
		 * **回落是 `SessionStart` 唯一有效的来源**：它发生在宿主被 adopt 之前
		 * （`SessionHost.create` 末尾的 `bindExtensions`），那一刻装配点的
		 * `bucket.sessionId` / `getHost2()?.state.sessionId` 还是空串；而 pi 的
		 * manager 此刻已经有 id（`AgentSession.sessionId` 就是
		 * `sessionManager.getSessionId()`）。不回落的话载荷里的 `session.id`
		 * 恒为空，hook 就没法把「这次会话」与后续两条事件的行关联起来。
		 */
		const sessionIdOf = (ctx) => {
			try {
				const fromOptions = options.getSessionId?.() ?? "";
				if (fromOptions !== "") return fromOptions;
			} catch {
				/* 装配点的 getter 坏了不该让事件失败 —— 继续试 pi 的那一份 */
			}
			try {
				return ctx?.sessionManager?.getSessionId?.() ?? "";
			} catch {
				return "";
			}
		};
		const run = async (event, buildPayload, ctx) => {
			if (set.fatal.length > 0) return void 0;
			const hooks = set.hooks.filter((hook) => matchesEvent(hook, event));
			if (hooks.length === 0) return void 0;
			try {
				const results = await runHooks(hooks, buildPayload(sessionIdOf(ctx)), event, options.deps);
				for (const { hook, result } of results) {
					options.onAudit?.({
						category: "hook",
						// 非阻断事件**只有** allowed / failed 两种结果：exit 2 也只说明
						// 这个 hook 不同意，并没有真的拦下会话或消息。
						outcome: result.verdict === "allow" ? "allowed" : "failed",
						detail: auditDetail({ event, hook, result, blockable: false })
					});
				}
			} catch (error) {
				options.onAudit?.({
					category: "hook",
					outcome: "failed",
					detail: clip(`${event} 执行异常（未阻断）：${errorText(error)}`)
				});
			}
			return void 0;
		};

		pi.on("session_start", (event, ctx) =>
			run(
				"SessionStart",
				(sessionId) => payloadForSessionStart({ sessionId, cwd: options.cwd, reason: event?.reason }),
				ctx
			)
		);
		pi.on("before_agent_start", (event, ctx) => {
			/*
			 * 只认用户提交。`custom`（`sendMessage({triggerTurn})` 唤醒）不是
			 * 「用户提交了一条消息」—— 把它算进来会让系统自发的一轮也触发
			 * 用户的 pre-message hook，语义就对不上了。
			 */
			if (event?.messageType !== "user") return void 0;
			return run(
				"UserPromptSubmit",
				(sessionId) => payloadForUserPromptSubmit({ sessionId, cwd: options.cwd, prompt: event.prompt }),
				ctx
			);
		});
		pi.on("agent_settled", (event, ctx) =>
			run(
				"Stop",
				(sessionId) => payloadForStop({ sessionId, cwd: options.cwd, aborted: event?.aborted === true }),
				ctx
			)
		);
	};
}

/** 工具结果里的纯文本（PostToolUse 的 error 字段用），失败返回空串。 */
function contentText(content) {
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => (block !== null && typeof block === "object" && block.type === "text" ? String(block.text ?? "") : ""))
		.join("\n")
		.trim();
}

export {
	BLOCKING_EVENTS,
	HOOKS_MAX_COUNT,
	HOOK_COMMAND_MAX,
	HOOK_CONFIG_MAX_BYTES,
	HOOK_EVENTS,
	HOOK_IMPORT_MAX_BYTES,
	HOOK_KILL_GRACE_MS,
	HOOK_MATCHER_MAX,
	HOOK_OUTPUT_MAX,
	HOOK_TIMEOUT_DEFAULT,
	HOOK_TIMEOUT_MAX,
	HOOK_TIMEOUT_MIN,
	LIFECYCLE_EVENTS,
	TOOL_EVENTS,
	TRUSTED_WORKSPACES_MAX,
	assertHookConfig,
	auditDetail,
	chooseWorkspaceRoot,
	clip,
	contentText,
	createLifecycleHookExtension,
	createPostToolUseHookExtension,
	createPreToolUseHookExtension,
	decideVerdict,
	isPathInside,
	isWorkspaceTrusted,
	matchTool,
	matchesEvent,
	mergeHookConfigs,
	normalizeHook,
	normalizeTrustedWorkspaceHooks,
	normalizeWorkspacePath,
	parseHookConfig,
	parseHookImportText,
	payloadForPostToolUse,
	payloadForPreToolUse,
	payloadForSessionStart,
	payloadForStop,
	payloadForUserPromptSubmit,
	previewHookImport,
	readWorkspaceHookConfig,
	refusalReason,
	resolveHookSet,
	resolveSavedHook,
	runHook,
	runHooks,
	shellInvocation,
	workspaceHooksPath
};
