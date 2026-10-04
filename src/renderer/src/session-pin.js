/**
 * 会话置顶的纯逻辑内核：置顶优先的排序 + 任务区的折叠窗口。
 *
 * 不含 React、不碰 DOM、不 import 任何东西 —— 因此能被 vitest 直接 import（毫秒级），
 * 把两条判断钉死：
 *
 *   1. **排序**：置顶的排在各分区最前，置顶区内部沿用「最近活动在前」。
 *      注意比较器**不再新写一套时间口径** —— 置顶只是把同一批会话分成两段，
 *      每段内部的顺序都与全站一致（侧栏、⌘K、首页最近会话都是 modifiedAt 倒序）。
 *
 *   2. **折叠窗口**：任务区默认只显示 5 行（`TASKS_COLLAPSED_COUNT`），
 *      而「置顶了却在『查看更多』后面」正是这个功能最容易出的失效形态 ——
 *      所以置顶项**不参与那 5 个名额的竞争**，它们永远在窗口内。
 *      这条判据在界面上只表现为「置顶的行恰好没被折叠」，是 GUI 断言最难说清、
 *      纯函数最容易钉死的那类规则。
 *
 * ## 为什么稳定排序是硬要求
 *
 * `Array.prototype.sort` 自 ES2019 起规范强制稳定，所以「同分保持输入顺序」不需要
 * 我们额外写第三级比较。但它**要求我们不去破坏它**：`modifiedAt` 相同的两条会话
 * （批量导入、同秒创建）必须保持 daemon 给的顺序，否则侧栏会在每次刷新时抖。
 * 这里只用两级比较键，稳定性交给 `.sort` 的规范行为 —— 与 command-palette-core.js
 * 里那条「第三级与稳定排序行为等价，写它是为了把意图显式化」是同一个判断。
 *
 * ## 置顶字段缺省
 *
 * `pinned` 由 daemon 的 `listSessions()` 下发。缺省（旧的快照对象、测试里手造的
 * 会话）一律按**未置顶**处理 —— 不认识这个字段就当没置顶，绝不把 `undefined`
 * 当成真值把一行莫名其妙顶到最前面。
 */

/** 是否置顶。非 `true` 一律按未置顶（见文件头「置顶字段缺省」）。 */
export function isPinned(session) {
	return session.pinned === true;
}

/**
 * 两级比较键：置顶优先，其次最近活动在前。
 *
 * 置顶区内部**仍然**是 `modifiedAt` 倒序，不按置顶时刻排 —— 这是有意的：
 * 「置顶」的语义是「这条要一直在手边」，不是「我要给它们定序」。
 * 用置顶时刻排会让刚聊过的置顶会话藏在另一个置顶会话下面，
 * 而用户对列表的既有预期是「最近动过的在上面」。
 */
export function compareSessionsByPin(a, b) {
	const pinnedA = isPinned(a) ? 1 : 0;
	const pinnedB = isPinned(b) ? 1 : 0;
	if (pinnedA !== pinnedB) return pinnedB - pinnedA;
	return b.modifiedAt - a.modifiedAt;
}

/** 置顶优先排序，返回新数组（不改调用方的数据）。 */
export function sortSessionsByPin(sessions) {
	return [...sessions].sort(compareSessionsByPin);
}

/**
 * 任务区的显示窗口：折叠时显示哪些行。
 *
 * 规则：**置顶项全部占位在前，剩余名额给非置顶项**。
 * 于是 `limit` 是「非置顶项最多显示几个」而不是「总共显示几个」——
 * 置顶超过 `limit` 时窗口会变长，这是刻意的：**宁可多显示，也不能让用户
 * 钉住的那条藏进「查看更多」**（置顶的全部意义就是它在手边）。
 *
 * 入参不必预先排好序（内部会排），返回值里的 `visible` 已是最终显示顺序。
 */
export function taskListWindow(sessions, limit) {
	const ordered = sortSessionsByPin(sessions);
	const pinned = ordered.filter(isPinned);
	const rest = ordered.filter((session) => !isPinned(session));
	const visible = pinned.concat(rest.slice(0, Math.max(0, limit - pinned.length)));
	return { visible, hiddenCount: ordered.length - visible.length };
}
