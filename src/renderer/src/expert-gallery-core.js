/**
 * 能力库画廊的纯逻辑内核：来源筛选、排序、计数、拖放路径解析。
 *
 * 与 `command-palette-core.js` / `plan-core.js` 同一模式：不 import 任何东西、
 * 不碰 DOM，因此能被 vitest 直接 import。界面上这些判断只表现为「顺序有点怪」
 * 「筛选数不对」，恰是 GUI 断言最难说清、单测最容易钉死的一类。
 *
 * 条目形状由调用方给（daemon 的 `listExperts` 投影）：
 * `{ name, displayName, profession, description, displayDescription, tags,
 *    source: "builtin" | "user" | "pack", expertType, packVersion?, packInstalledAt? }`。
 * core 不认识 React，也不猜测缺失字段的语义 —— 缺字段一律按「没有」处理，
 * 不伪造安装时间或描述。
 */

/** 来源四档。`id` 与专家的 `source` 值一一对应（`all` 是不过滤）。
 *  `user` 显示为「自建」：顶部还有一个「我的专家」入口（含能力包），
 *  两者口径不同，不能共用一个词。 */
export const SOURCE_FILTERS = [
	{ id: "all", label: "全部" },
	{ id: "builtin", label: "内置" },
	{ id: "user", label: "自建" },
	{ id: "pack", label: "能力包" },
];

/** 排序三档。`default` 保持 daemon 给的顺序（内置 → 能力包 → 我的）。 */
export const SORT_MODES = [
	{ id: "default", label: "默认" },
	{ id: "name", label: "名称" },
	{ id: "recent", label: "最近安装" },
];

const SOURCE_IDS = new Set(SOURCE_FILTERS.map((filter) => filter.id));

function textOf(value) {
	return typeof value === "string" ? value.toLowerCase() : "";
}

/** 搜索口径：名称 / 职称 / 描述（长短两版都算），与既有 `matchKeyword` 一致。 */
function matchesKeyword(expert, keyword) {
	if (keyword === "") return true;
	return [expert.name, expert.displayName, expert.profession, expert.description, expert.displayDescription].some(
		(field) => textOf(field).includes(keyword),
	);
}

/**
 * 来源 × 标签 × 关键词三者是**与**关系。
 *
 * 此前界面在有关键词时直接忽略标签（`if (kw !== "") ... else ...`），
 * 于是「搜索里再也选不了分类」。这里统一成可叠加的过滤，调用方不必再记分支。
 */
export function filterExperts(experts, { source = "all", tag, keyword = "" } = {}) {
	const list = Array.isArray(experts) ? experts : [];
	const wanted = SOURCE_IDS.has(source) && source !== "all" ? source : undefined;
	const kw = typeof keyword === "string" ? keyword.trim().toLowerCase() : "";
	return list.filter((expert) => {
		if (wanted !== undefined && expert?.source !== wanted) return false;
		if (tag !== undefined && !(Array.isArray(expert?.tags) && expert.tags.includes(tag))) return false;
		return matchesKeyword(expert ?? {}, kw);
	});
}

/** 名称比较统一走 zh-Hans-CN；同分按 `name`，保证结果与运行环境无关。 */
function compareName(a, b) {
	const left = typeof a?.displayName === "string" && a.displayName !== "" ? a.displayName : String(a?.name ?? "");
	const right = typeof b?.displayName === "string" && b.displayName !== "" ? b.displayName : String(b?.name ?? "");
	const byDisplay = left.localeCompare(right, "zh-Hans-CN");
	if (byDisplay !== 0) return byDisplay;
	return String(a?.name ?? "").localeCompare(String(b?.name ?? ""), "zh-Hans-CN");
}

function hasInstalledAt(expert) {
	return typeof expert?.packInstalledAt === "number" && Number.isFinite(expert.packInstalledAt);
}

/**
 * 排序。返回新数组，**不改调用方的数组**（React 状态可能被别处共享）。
 *
 * `recent` 只对能力包按安装时间降序；没有 `packInstalledAt` 的条目
 * （内置 / 我的 / 装上时还没记录安装时间的旧包）排在后面按名称排 ——
 * 不给它们编一个时间，否则「最近安装」会变成一个说不清的口径。
 */
export function sortExperts(experts, mode) {
	const list = Array.isArray(experts) ? experts : [];
	if (mode === "name") return [...list].sort(compareName);
	if (mode !== "recent") return [...list];
	const installed = [];
	const rest = [];
	for (const expert of list) {
		if (hasInstalledAt(expert)) installed.push(expert);
		else rest.push(expert);
	}
	installed.sort((a, b) => {
		const delta = b.packInstalledAt - a.packInstalledAt;
		return delta !== 0 ? delta : compareName(a, b);
	});
	rest.sort(compareName);
	return [...installed, ...rest];
}

/** 四档计数（含「全部」）。未知 `source` 只计入「全部」。 */
export function sourceCounts(experts) {
	const counts = { all: 0, builtin: 0, user: 0, pack: 0 };
	for (const expert of Array.isArray(experts) ? experts : []) {
		counts.all += 1;
		const source = expert?.source;
		if (source === "builtin" || source === "user" || source === "pack") counts[source] += 1;
	}
	return counts;
}

/**
 * 从拖放载荷里取本地路径。
 *
 * 输入是 `text/uri-list`（RFC 2483：一行一个 URI，`#` 开头是注释）或
 * `text/plain`。只接受 `file:` URI —— 渲染层**不猜路径**，其它协议与解析失败的
 * 行直接丢弃。结果去重保序。
 *
 * `file:///C:/x` → `C:/x`（Windows 盘符去前缀斜杠）；`file:///Users/x` → `/Users/x`；
 * `file://server/share/x` → `//server/share/x`（UNC）。
 */
export function pathsFromDropText(text) {
	const paths = [];
	const seen = new Set();
	for (const raw of String(text ?? "").split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		let url;
		try {
			url = new URL(line);
		} catch {
			continue;
		}
		if (url.protocol !== "file:") continue;
		let path;
		try {
			path = decodeURIComponent(url.pathname);
		} catch {
			continue;
		}
		if (url.hostname !== "" && url.hostname !== "localhost") path = `//${url.hostname}${path}`;
		if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
		if (path === "" || seen.has(path)) continue;
		seen.add(path);
		paths.push(path);
	}
	return paths;
}

/**
 * 拖入的路径是否**可能是**能力包：`.zwpack` / `.zip`，或没有扩展名
 * （通常是目录，daemon 支持目录来源）。
 *
 * 这里只做「要不要交给 daemon 去校验」的初筛，**不做安全判定** ——
 * 真正的路径 / 符号链接 / 体积检查全部在 daemon 侧（packs.js）。
 */
export function isPackDropPath(path) {
	const value = String(path ?? "").trim();
	if (value === "") return false;
	const base = value.split(/[\\/]/).filter((part) => part !== "").pop() ?? "";
	if (base === "") return false;
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return true;
	const ext = base.slice(dot).toLowerCase();
	return ext === ".zwpack" || ext === ".zip";
}
