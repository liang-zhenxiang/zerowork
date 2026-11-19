/**
 * 资料库画廊（成果展厅）的纯逻辑：类型判定、封面几何、路径归属、筛选、继续修改提示。
 *
 * 与 `command-palette-core.js` / `expert-gallery-core.js` 同模式：不 import 任何东西、
 * 不碰 DOM，因此能被 vitest 直接 import。界面上这些判断只表现为「卡片类型不对」
 * 「筛选结果少一条」「继续修改按钮灰着」——那正是 GUI 断言最说不清、单测最容易钉死
 * 的一类。
 *
 * 数据形状来自 daemon 的 `library:list` 投影：
 * `{ path, name, kind: "local" | "url", size, html, deliveredAt, exists,
 *    sessions: [{ id, path, title, cwd, modifiedAt }] }`。
 * core 只认识这些字段，**不猜测**缺失字段的语义：没有 cwd 就是「没有来源工作区」，
 * 不会替它伪造一个可写的目录。
 */

import { coverBarWidth, coverBars, coverLines } from "./case-cover.js";

/**
 * 类型档位（筛选 chip 也读这一份）。`all` 是不筛选。
 *
 * 类型只由扩展名 / kind 判定（见 `artifactType`），**不看大小或内容** ——
 * 画廊不跑 Office 渲染、不做缩略图，类型是文件名带来的事实。
 */
export const ARTIFACT_TYPES = [
	{ id: "all", label: "全部" },
	{ id: "doc", label: "文档" },
	{ id: "sheet", label: "表格" },
	{ id: "slide", label: "幻灯片" },
	{ id: "markdown", label: "研究笔记" },
	{ id: "image", label: "图片" },
	{ id: "pdf", label: "PDF" },
	{ id: "code", label: "代码" },
	{ id: "html", label: "网页" },
	{ id: "url", label: "链接" },
	{ id: "other", label: "其他" }
];

/** 时间范围三档。`days: 0` = 全部（不按时间筛）。 */
export const TIME_RANGES = [
	{ days: 0, label: "全部时间" },
	{ days: 7, label: "最近 7 天" },
	{ days: 30, label: "最近 30 天" }
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** 扩展名 → 类型。键一律小写；判定前 `extOf` 已转小写。 */
const EXT_TYPES = {
	doc: "doc",
	docx: "doc",
	rtf: "doc",
	odt: "doc",
	pages: "doc",
	xls: "sheet",
	xlsx: "sheet",
	csv: "sheet",
	tsv: "sheet",
	ods: "sheet",
	numbers: "sheet",
	ppt: "slide",
	pptx: "slide",
	key: "slide",
	odp: "slide",
	pdf: "pdf",
	png: "image",
	jpg: "image",
	jpeg: "image",
	gif: "image",
	webp: "image",
	svg: "image",
	bmp: "image",
	ico: "image",
	avif: "image",
	heic: "image",
	tif: "image",
	tiff: "image",
	md: "markdown",
	markdown: "markdown",
	mdx: "markdown",
	html: "html",
	htm: "html",
	js: "code",
	jsx: "code",
	mjs: "code",
	cjs: "code",
	ts: "code",
	tsx: "code",
	json: "code",
	jsonc: "code",
	yaml: "code",
	yml: "code",
	toml: "code",
	xml: "code",
	css: "code",
	scss: "code",
	sass: "code",
	less: "code",
	sh: "code",
	bash: "code",
	zsh: "code",
	fish: "code",
	py: "code",
	rb: "code",
	go: "code",
	rs: "code",
	java: "code",
	c: "code",
	cpp: "code",
	cc: "code",
	cxx: "code",
	h: "code",
	hpp: "code",
	cs: "code",
	php: "code",
	sql: "code",
	vue: "code",
	svelte: "code",
	kt: "code",
	kts: "code",
	swift: "code",
	lua: "code",
	r: "code",
	pl: "code",
	pm: "code",
	ini: "code",
	cfg: "code",
	conf: "code",
	gradle: "code",
	ipynb: "code"
};

/** URL 判定：kind 是 daemon 的权威字段；没有 kind 的老数据按 scheme 兜底。 */
function isUrlArtifact(artifact) {
	if (artifact?.kind === "url") return true;
	const path = typeof artifact?.path === "string" ? artifact.path : "";
	return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(path);
}

/** 取扩展名（小写、去查询串 / 片段）。`README`、`.gitignore` 一律没有扩展名。 */
function extOf(path) {
	const text = typeof path === "string" ? path : "";
	const withoutQuery = text.split(/[?#]/, 1)[0];
	const name = withoutQuery.split(/[\\/]/).pop() ?? "";
	const dot = name.lastIndexOf(".");
	if (dot <= 0 || dot === name.length - 1) return "";
	return name.slice(dot + 1).toLowerCase();
}

/**
 * 产物类型。
 *
 * - URL 一律 `url`（哪怕 path 以 `.html` 结尾 —— 它是链接不是本地网页文件）；
 * - 其余按扩展名判定，未知扩展名 / 无扩展名 → `other`；
 * - 判定**只读 path**，不 stat 文件（失效文件也照样有自己的类型）。
 */
export function artifactType(artifact) {
	if (isUrlArtifact(artifact)) return "url";
	const type = EXT_TYPES[extOf(artifact?.path)];
	return type ?? "other";
}

/** 类型的中文标签；未知 id 回「其他」，不把内部 id 铺到界面上。 */
export function typeLabel(id) {
	return ARTIFACT_TYPES.find((type) => type.id === id)?.label ?? "其他";
}

/**
 * 封面几何（线宽 / 柱高 / 顶部色条），以 `artifact.path` 为种子。
 *
 * 复用 `case-cover.js` 的纯函数：同一个文件永远同一张封面（重渲染不抖），
 * 不同文件在同一类型下也长得不一样。**回归防线在 case-cover 自己的单测**，
 * 这里只负责把「哪个种子」定下来。
 */
export function artifactCover(artifact) {
	const seed =
		typeof artifact?.path === "string" && artifact.path !== "" ? artifact.path : String(artifact?.name ?? "");
	// 动态 import 会让这个文件在 vitest 里变成异步；几何函数是零依赖纯函数，
	// 直接静态引用即可（case-cover.js 本身不 import 任何东西）。
	return {
		barWidth: coverBarWidth(seed),
		lines: coverLines(seed),
		bars: coverBars(seed)
	};
}

/**
 * 类型 → 封面的**画法**（纸面上的内容形态）。
 *
 * 这里刻意只有四种画法（与 `case-cover.js` 的既有语汇一致）：类型之间的差异
 * 由**颜色 + 类型标签**承担，不为每种类型新造一套 CSS 几何 —— 那会让封面语言
 * 变成十种互不相干的图案。
 */
export function artifactCoverVariant(type) {
	if (type === "sheet") return "chart";
	if (type === "slide" || type === "image") return "slide";
	if (type === "markdown") return "note";
	return "doc";
}

/**
 * 封面纸片的**形状**（设计评审 2026-11-19）：竖版 / 横版 / 柱状。
 *
 * 为什么必须分家：只换颜色时，文档、幻灯片、表格在余光里都是「一张纸」，
 * 网格看起来像同一块模板重复。形状是比颜色更早被读到的线索：
 * 文档类竖版、演示 / 图片横版、表格保持柱状。
 */
export function artifactCoverShape(type) {
	if (type === "sheet") return "bars";
	if (type === "slide" || type === "image") return "landscape";
	return "portrait";
}

/**
 * 封面右上角的扩展名角标：`MD` / `PDF` / `链接` / `文件`。
 *
 * 类型标签说的是「这是哪一类」，角标说的是「它具体是什么文件」——
 * 两者一起才能第一眼分辨「一份 docx 报告」与「一个 md 笔记」。
 */
export function artifactBadge(artifact) {
	if (isUrlArtifact(artifact)) return "链接";
	const ext = extOf(artifact?.path);
	return ext === "" ? "文件" : ext.toUpperCase();
}

/**
 * 类型 → 分类色板槽位（`--cat-1..6`）。**不新造颜色 token**：
 * 这六槽同时定义在亮色与暗色两个块里，主题切换自动跟随。
 * `other` 返回 undefined —— 中性类型不借分类色，由调用方落到中性灰。
 */
export function typeAccent(type) {
	switch (type) {
		case "doc":
		case "html":
			return "var(--cat-1)";
		case "markdown":
		case "url":
			return "var(--cat-2)";
		case "pdf":
			return "var(--cat-3)";
		case "sheet":
		case "code":
			return "var(--cat-4)";
		case "slide":
			return "var(--cat-5)";
		case "image":
			return "var(--cat-6)";
		default:
			return undefined;
	}
}

/**
 * 路径归一化：统一正斜杠、去掉末尾斜杠、转小写。
 *
 * 为什么大小写也统一：Windows 路径大小写不敏感，同一文件可能是 `C:\WS\a.md`
 * 与 `c:/ws/A.md` 两种写法；不统一的话「产物是否在来源 cwd 内」会因写法不同
 * 判成 false，界面上表现为「明明在会话目录里却没有预览按钮」。
 * 代价是 POSIX 上 `A` 与 `a` 会被视为同一路径 —— 对**同一台机器上的产物归属**
 * 这个判定足够，且比漏判安全（漏判会让动作消失）。
 */
function normalizePath(value) {
	if (typeof value !== "string") return "";
	let text = value.trim().replace(/\\/g, "/");
	text = text.replace(/\/{2,}/g, "/");
	if (text.length > 1) text = text.replace(/\/+$/, "");
	return text.toLowerCase();
}

/**
 * `path` 是否落在 `cwd` 之内（含 cwd 自身）。
 *
 * 兄弟目录不算：`/ws` 与 `/ws2/file` 的共同前缀是 `/ws`，但 `ws2` 不是 `ws` 的子目录 ——
 * 判据必须是「相等或 `base + "/"` 前缀」，不是裸 `startsWith`。
 */
export function pathWithinCwd(cwd, path) {
	const base = normalizePath(cwd);
	const target = normalizePath(path);
	if (base === "" || target === "") return false;
	if (base === "/") return target.startsWith("/");
	return target === base || target.startsWith(`${base}/`);
}

/**
 * 产物的**来源工作目录**：第一个（最近交付的）包含该路径的来源会话 cwd。
 *
 * 返回 undefined 时界面必须**禁用**「继续修改」并说明原因 —— 本项目不为
 * 「改任意路径的文件」新开读通道（`AGENTS.md` 红线 4）。URL 产物同样没有 cwd。
 */
export function sourceCwdFor(artifact) {
	const path = artifact?.path;
	if (typeof path !== "string" || path === "" || isUrlArtifact(artifact)) return undefined;
	const sessions = Array.isArray(artifact?.sessions) ? artifact.sessions : [];
	for (const session of sessions) {
		const cwd = session?.cwd;
		if (typeof cwd === "string" && cwd !== "" && pathWithinCwd(cwd, path)) return cwd;
	}
	return undefined;
}

/** 文件名（用于搜索时，产物缺 name 也仍能按路径末段匹配）。 */
function nameOf(artifact) {
	if (typeof artifact?.name === "string" && artifact.name !== "") return artifact.name;
	const path = typeof artifact?.path === "string" ? artifact.path : "";
	return path.split(/[\\/]/).pop() ?? "";
}

/** 路径切段（同时认正反斜杠，丢弃空段）。用于展示与相对路径计算，保留原始大小写。 */
function pathSegments(value) {
	return String(value ?? "")
		.trim()
		.split(/[\\/]+/)
		.filter((segment) => segment !== "");
}

/**
 * `path` 相对 `cwd` 的展示路径（保留原始大小写，统一用 `/`）。
 *
 * 与 `pathWithinCwd` 共用同一套归属判据；不在 cwd 内或就是 cwd 本身时返回
 * undefined —— 调用方据此回退到文件名，**不把绝对路径铺到界面上**。
 */
export function relativePathWithin(cwd, path) {
	if (!pathWithinCwd(cwd, path)) return undefined;
	const base = pathSegments(cwd);
	const target = pathSegments(path);
	if (target.length <= base.length) return undefined;
	return target.slice(base.length).join("/");
}

/**
 * 详情的路径副标题：`<来源 cwd 的 basename> / <相对路径>`，完整路径只放 `title`。
 *
 * 隐私考虑（设计评审 2026-11-19）：绝对路径会带出用户名与临时目录名，
 * 投屏 / 截图时是没必要的暴露面。产物在来源工作区之外（或没有来源会话）时
 * 连相对路径都算不出来，就只显示文件名。
 */
export function displayPathFor(artifact) {
	const full = typeof artifact?.path === "string" ? artifact.path : "";
	const cwd = sourceCwdFor(artifact);
	if (cwd === undefined || full === "") return { text: nameOf(artifact) || full, title: full };
	const relative = relativePathWithin(cwd, full);
	if (relative === undefined) return { text: nameOf(artifact) || full, title: full };
	const segments = pathSegments(cwd);
	const base = segments.length > 0 ? segments[segments.length - 1] : "";
	return { text: base === "" ? relative : `${base} / ${relative}`, title: full };
}

/**
 * 「继续修改」的预填提示。
 *
 * 新任务的 cwd 已经切到产物所属的来源工作区，所以提示里用**相对路径**
 * （设计评审 2026-11-19）：既避免把绝对路径写进对话与截图，也让模型读到的是
 * 「相对当前工作区的位置」这一件它真正需要的事实。
 * 提示里明确「不要移动文件」「不要改来源工作区之外的文件」，让第一步就把边界读进去。
 */
export function continuePrompt(artifact, cwd = sourceCwdFor(artifact)) {
	const path = typeof artifact?.path === "string" ? artifact.path : "";
	const relative = cwd === undefined ? undefined : relativePathWithin(cwd, path);
	const shown = relative !== undefined ? relative : nameOf(artifact) || path;
	return `我正在继续完善这份交付物：${shown}\n\n先读这个文件，确认它当前的结构与内容，然后按我接下来的要求修改。不要移动文件位置，也不要改动来源工作区之外的文件。`;
}

/**
 * 四条件筛选，**一律是与关系**（类型 × 来源会话 × 时间 × 文件名）。
 *
 * - `type: "all"` / `sessionId: "all"` / `days: 0` / `keyword: ""` 表示该维不过滤；
 * - 时间按 `deliveredAt` 与 `now` 比较；时间戳无法解析的产物在按时间筛选时
 *   **不出现**（无法证明它在范围内，不能拿它凑数）；不按时间筛时照常出现；
 * - 关键词只匹配**文件名**（大小写不敏感，满足 PRD 的「只搜文件名」非目标）。
 */
export function filterArtifacts(artifacts, options = {}) {
	const list = Array.isArray(artifacts) ? artifacts : [];
	const { type = "all", sessionId = "all", days = 0, keyword = "", now = Date.now() } = options;
	const kw = typeof keyword === "string" ? keyword.trim().toLowerCase() : "";
	const rangeDays = typeof days === "number" && Number.isFinite(days) && days > 0 ? days : 0;
	return list.filter((artifact) => {
		if (type !== "all" && artifactType(artifact) !== type) return false;
		if (sessionId !== "all") {
			const sessions = Array.isArray(artifact?.sessions) ? artifact.sessions : [];
			if (!sessions.some((session) => session?.path === sessionId)) return false;
		}
		if (rangeDays > 0) {
			const at = Date.parse(artifact?.deliveredAt ?? "");
			if (!Number.isFinite(at) || now - at > rangeDays * DAY_MS) return false;
		}
		if (kw !== "" && !nameOf(artifact).toLowerCase().includes(kw)) return false;
		return true;
	});
}

/**
 * 在文件历史清单里找到与 `path` 对应的条目 key。
 *
 * daemon 的 key 是「绝对路径的 sha1」，但渲染层不该重算哈希（路径归一化口径
 * 必须与 daemon 一致才安全）。这里改成**按清单里的 path 反查** ——
 * 清单本身就带着每条记录的绝对路径，比较两侧都用同一个 `normalizePath`。
 * 匹配不到返回 undefined：界面据此说「没有留下版本」，不假装有。
 */
export function versionKeyFor(files, path) {
	const target = normalizePath(path);
	if (target === "") return undefined;
	const list = Array.isArray(files) ? files : [];
	const hit = list.find((file) => normalizePath(file?.path) === target);
	return typeof hit?.key === "string" && hit.key !== "" ? hit.key : undefined;
}
