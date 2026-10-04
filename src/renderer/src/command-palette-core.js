/**
 * 命令面板的纯逻辑内核：筛选、排序、截断。
 *
 * 不含 React、不碰 DOM、不 import 任何东西 —— 因此能被 vitest 直接 import，
 * 毫秒级锁住「顺序对不对」。渲染层此前只有 GUI 测试一条覆盖路径（要真实启动
 * Electron，分钟级），这是它的第一条单元测试路径。而排序优先级链在界面上
 * 只表现为「顺序有点怪」，恰是 GUI 断言最难说清、单测最容易钉死的一类判断。
 *
 * ## 排序链（四级，第三级是显式表达而非必需）
 *
 *   1. matchRank 升序   —— 匹配质量优先：精确 > 前缀 > 子串 > 子序列 > 副标题/关键词
 *   2. 类别权重升序     —— 同分时动作优先于实体（KIND_WEIGHT）
 *   3. 常用分降序       —— 同分同类时，用户用得多的在前（**可选**，见下）
 *   4. 原数组索引升序   —— 同分同类同热度时保持调用方给定的顺序
 *
 * 第四级：`Array.prototype.sort` 的稳定性自 **ES2019 起是 ECMAScript 规范强制要求**，
 * 不是各引擎的巧合。因此在当前实现（对命中项做一次 `.sort`）下，第三级与稳定排序
 * **行为等价** —— 写不写它，结果都一样。它仍保留，理由是把意图**显式化**：
 * 换成按 rank 分桶、或换掉 `.sort` 的写法时，这份「同分同类按调用方原序」的约定
 * 不必再重新推导。
 *
 * ⚠️ 这一级**没有被任何用例守**：砍掉它，下方 30 条断言仍全绿（实测）。本项目对
 * 「看起来被断言守住、其实删掉也没人发现」的代码零容忍，因此在此明说 ——
 * 它靠的是规范保证 + 显式意图，**不靠用例**。
 *
 * 第三级（常用分）的位置是**刻意的**：它在类别权重**之后**。frecency 永远不能
 * 压过匹配质量（「我打字了它还拿历史压我」是这类功能最讨厌的形态，Raycast 与
 * Obsidian 的取舍一致）；它也不能排到原索引之后，那等于没有。不传 `scoreOf` 时
 * 这一级恒为 0 —— 行为与加它之前**逐字节一致**（有一条回归锁守着）。
 *
 * 条目形状由调用方给：{ id, kind, title, subtitle?, keywords?, hint?, run }。
 * core 不认识 run，只负责「筛选 + 排序 + 截断」。
 */

/**
 * 类别权重：数值越小越靠前。动作（做某件事）优先于全部实体（跳到某个东西），
 * 实体之间按「越接近当前操作越靠前」的次序排列。
 */
export const KIND_WEIGHT = {
	action: 0,
	settings: 1,
	session: 2,
	workspace: 3,
	expert: 4,
	skill: 5,
	connector: 6,
	automation: 7,
};

/** 归一化：字符串去首尾空白 + 小写；非字符串一律当空串（不做宽容转换，避免误匹配）。 */
function normalize(value) {
	return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/** needle 的字符是否按序出现在 haystack 中（子序列 / 模糊匹配）。 */
function isSubsequence(needle, haystack) {
	let i = 0;
	for (let j = 0; j < haystack.length && i < needle.length; j += 1) {
		if (haystack[j] === needle[i]) i += 1;
	}
	return i === needle.length;
}

/** 单段文本的匹配等级：0 精确 / 1 前缀 / 2 子串 / 3 子序列 / null 不匹配。 */
function matchText(query, text) {
	if (text === query) return 0;
	if (text.startsWith(query)) return 1;
	if (text.includes(query)) return 2;
	if (isSubsequence(query, text)) return 3;
	return null;
}

/**
 * 条目对 query 的匹配等级：越小越优先；null 表示不匹配、应被过滤。
 *
 * 空 query 一律返回 null —— 「空查询显示什么」是调用方的产品判断（rankEntries
 * 在空查询时直接短路，不会走到这里）。core 不替它决定。
 */
export function matchRank(query, entry) {
	const q = normalize(query);
	if (q === "") return null;
	const titleRank = matchText(q, normalize(entry?.title));
	if (titleRank !== null) return titleRank;
	// 标题未命中时，副标题或关键词命中一律记 4 —— 不沿用它们内部的 0-3 等级，
	// 因为「标题优于副标题/关键词」正是这条排序链要表达的次序。
	if (matchText(q, normalize(entry?.subtitle)) !== null) return 4;
	const keywords = Array.isArray(entry?.keywords) ? entry.keywords : [];
	for (const keyword of keywords) {
		if (matchText(q, normalize(keyword)) !== null) return 4;
	}
	return null;
}

/** 类别权重；未知类别排到最后，不静默当成某一档。 */
function kindWeight(entry) {
	const weight = KIND_WEIGHT[entry?.kind];
	return typeof weight === "number" ? weight : Number.POSITIVE_INFINITY;
}

/**
 * 筛选 + 排序 + 截断。返回 { items, total }，total 是**截断前**的命中总数
 * （调用方据此提示「还有 N 条」）。
 *
 * 空 query：原样返回**未截断**的全部条目（total = 长度），顺序完全由调用方决定 ——
 * 空查询下要展示「常用动作 + 最近会话」是产品判断，core 不做。
 */
export function rankEntries(entries, query, { limit = 50, scoreOf } = {}) {
	const list = Array.isArray(entries) ? entries : [];
	if (normalize(query) === "") {
		return { items: list.slice(), total: list.length };
	}
	// 常用分查询函数：不传就是「人人 0 分」，排序链退化成加它之前的三级。
	const scoreFor = typeof scoreOf === "function" ? scoreOf : () => 0;
	const scored = [];
	for (let index = 0; index < list.length; index += 1) {
		const rank = matchRank(query, list[index]);
		if (rank === null) continue;
		const score = scoreFor(list[index]);
		scored.push({
			entry: list[index],
			rank,
			weight: kindWeight(list[index]),
			score: typeof score === "number" && Number.isFinite(score) ? score : 0,
			index,
		});
	}
	scored.sort(
		(a, b) => a.rank - b.rank || a.weight - b.weight || b.score - a.score || a.index - b.index,
	);
	return {
		items: scored.slice(0, limit).map((hit) => hit.entry),
		total: scored.length,
	};
}
