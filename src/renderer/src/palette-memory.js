/**
 * 命令面板的「记忆」：收藏 + 常用项（frecency）的纯逻辑。
 *
 * 不碰 DOM、不 import 任何东西 —— 因此能被 vitest 直接 import，毫秒级钉住
 * 「分数怎么变、排序排在哪一级」这类在界面上只表现为「顺序有点怪」的判断。
 *
 * ## 形状
 *
 *   { favorites: string[], usage: { [id]: { score: number, lastAt: number } } }
 *
 * ## 为什么存「已经衰减好的分数」而不是 count + lastAt
 *
 * 每条使用记录在**写入时**就把旧分数按 `2 ** (-elapsed / HALF_LIFE_MS)` 衰减一次，
 * 再给这一次 +1。读取侧于是只是纯查表：
 *
 *   · 排序不依赖「现在几点」—— 同一个 preferences.json 在任何时刻读出的顺序相同；
 *   · 衰减的含义可以单测（给定两个时间戳，断言分数），不必伪造时钟。
 *   反例（count + lastAt、读取时现算）会让「排序结果」与「读的时刻」耦合，
 *   在界面上表现为「同一份数据，上午排出来的和下午不一样」。
 *
 * ## 不按 id 是否存在清理
 *
 * 与「会话置顶」（pins.json）同一条纪律：条目可能只是**暂时**不可见（会话文件在
 * 外置盘 / 同步中 / 该层数据还没拉回来），那时把用户的选择抹掉才是真的丢东西。
 * 悬空 id 的后果只有一个：查不到对应条目，于是不渲染。清理策略只有规模淘汰
 * （FAVORITES_MAX / USAGE_MAX），不按存在性。
 */

/** 半衰期：7 天不用，旧分数减半（每周把「上次的热度」折一半）。 */
export const HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 收藏上限。到顶之后**拒绝新增**并明确告知（不静默丢弃、不挤掉最老的那条）：
 * 收藏是用户自己的短名单，悄悄挤掉一条比拒绝更糟。
 */
export const FAVORITES_MAX = 20;

/** 使用记录上限（按分数淘汰最低的）。不是性能问题，是 preferences.json 会整体重写。 */
export const USAGE_MAX = 200;

export const EMPTY_MEMORY = Object.freeze({ favorites: [], usage: {} });

function isPlainObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把任意输入规整成合法记忆。
 *
 * **降级而不是抛错**：面板记忆是体验增强，坏数据不该让面板打不开。
 * 但也不是「宽容转换」—— 非字符串的收藏项、非有限数的分数一律**丢弃**，
 * 不做 `String(...)` 之类的猜测（猜错比丢掉更糟，而且不可诊断）。
 */
export function normalizeMemory(raw) {
	const source = isPlainObject(raw) ? raw : {};
	const rawFavorites = Array.isArray(source.favorites) ? source.favorites : [];
	const favorites = [];
	const seen = new Set();
	for (const id of rawFavorites) {
		if (typeof id !== "string" || id === "" || seen.has(id)) continue;
		seen.add(id);
		favorites.push(id);
		if (favorites.length >= FAVORITES_MAX) break;
	}
	const usage = {};
	const rawUsage = isPlainObject(source.usage) ? source.usage : {};
	for (const [id, entry] of Object.entries(rawUsage)) {
		if (id === "" || !isPlainObject(entry)) continue;
		const score = entry.score;
		if (typeof score !== "number" || !Number.isFinite(score) || score <= 0) continue;
		const lastAt = typeof entry.lastAt === "number" && Number.isFinite(entry.lastAt) ? entry.lastAt : 0;
		usage[id] = { score, lastAt };
	}
	return { favorites, usage };
}

/** 某条目的常用分；没有记录就是 0（不是 undefined —— 排序比较里 0 参与运算更安全）。 */
export function scoreOf(memory, id) {
	const entry = isPlainObject(memory) ? memory.usage?.[id] : undefined;
	return isPlainObject(entry) && typeof entry.score === "number" && Number.isFinite(entry.score)
		? entry.score
		: 0;
}

/** 衰减因子：距今 elapsed 毫秒的旧分数还剩多少（elapsed ≤ 0 时不放大）。 */
export function decayFactor(elapsed) {
	if (typeof elapsed !== "number" || !Number.isFinite(elapsed) || elapsed <= 0) return 1;
	return 2 ** (-elapsed / HALF_LIFE_MS);
}

/**
 * 记一次使用：**先给全部旧分数清算衰减，再给这一次 +1**（写入时算，见文件头）。
 *
 * now 由调用方给（不在这里调 Date.now()）：纯函数才能被单测，且同一批写入
 * 共用同一个时刻，不会出现「同一毫秒内两条记录的时间戳互相打架」。
 */
export function recordUse(memory, id, now) {
	if (typeof id !== "string" || id === "") return normalizeMemory(memory);
	const base = normalizeMemory(memory);
	const usage = {};
	for (const [key, entry] of Object.entries(base.usage)) {
		const decayed = entry.score * decayFactor(now - entry.lastAt);
		// 衰减到极小（但 > 0）的条目留着：它的分数已经低到排不上来，
		// 留着只为「同一条目再次被用到时能接着涨」，删掉的收益是零。
		usage[key] = { score: decayed, lastAt: entry.lastAt };
	}
	const previous = usage[id];
	usage[id] = {
		score: (previous?.score ?? 0) + 1,
		lastAt: typeof now === "number" && Number.isFinite(now) ? now : 0,
	};
	return evict({ ...base, usage });
}

/**
 * 切换收藏。返回 { memory, ok, reason }：
 *   · ok=false / reason="limit"   收藏已达上限（调用方据此给出明确反馈，而不是静默失败）
 *   · ok=false / reason="missing" id 不合法
 * 其余情况 ok=true，memory 是**新对象**（不改入参）。
 */
export function toggleFavorite(memory, id) {
	const base = normalizeMemory(memory);
	if (typeof id !== "string" || id === "") {
		return { memory: base, ok: false, reason: "missing" };
	}
	if (base.favorites.includes(id)) {
		return { memory: { ...base, favorites: base.favorites.filter((item) => item !== id) }, ok: true };
	}
	if (base.favorites.length >= FAVORITES_MAX) {
		return { memory: base, ok: false, reason: "limit" };
	}
	return { memory: { ...base, favorites: [...base.favorites, id] }, ok: true };
}

/**
 * 规模淘汰：使用记录按分数保留前 USAGE_MAX 条（分数相同保留更近使用的）。
 * 收藏只做上限截断 —— 正常路径下 toggleFavorite 已经挡住了，这里是防御手改文件。
 */
export function evict(memory) {
	const base = normalizeMemory(memory);
	const entries = Object.entries(base.usage);
	if (entries.length <= USAGE_MAX) return base;
	entries.sort((a, b) => b[1].score - a[1].score || b[1].lastAt - a[1].lastAt);
	const usage = {};
	for (const [id, entry] of entries.slice(0, USAGE_MAX)) usage[id] = entry;
	return { ...base, usage };
}

/**
 * 空查询的排序：**收藏（按收藏顺序）在前，其余按常用分降序，同分保持原顺序**。
 *
 * 返回新数组，不改入参。没有收藏、也没有使用记录时**原样返回**调用方给的顺序 ——
 * 干净配置下的首屏必须与没有这个功能时一模一样（新功能不给老用户加噪声）。
 */
export function orderIdle(entries, memory) {
	const list = Array.isArray(entries) ? entries : [];
	const base = normalizeMemory(memory);
	const favoriteRank = new Map();
	base.favorites.forEach((id, index) => favoriteRank.set(id, index));
	const decorated = list.map((entry, index) => ({
		entry,
		index,
		favorite: favoriteRank.has(entry?.id) ? favoriteRank.get(entry.id) : Number.POSITIVE_INFINITY,
		score: scoreOf(base, entry?.id),
	}));
	decorated.sort((a, b) => {
		if (a.favorite !== b.favorite) return a.favorite - b.favorite;
		if (a.score !== b.score) return b.score - a.score;
		return a.index - b.index;
	});
	return decorated.map((item) => item.entry);
}

/** 常用分查询函数（给 command-palette-core 的 rankEntries 用）。 */
export function scorerOf(memory) {
	const base = normalizeMemory(memory);
	return (entry) => scoreOf(base, entry?.id);
}
