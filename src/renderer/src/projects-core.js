/**
 * 项目视图的纯逻辑（零依赖，vitest 毫秒级直测——session-pin.js 同模式）。
 *
 * 视图模型把「项目引用的会话路径」翻译成两件渲染层要用的东西：
 *  · **卡片行**：最近活动（项目里会话的 modifiedAt 最大值）、有效会话数；
 *  · **详情行**：路径 → 会话的映射，映射不到的（已归档 / 文件暂时不在磁盘上）
 *    **不静默吞掉**——汇成 unresolvedPaths 由视图降级展示（「静默丢东西」是
 *    本仓库的明确禁区，store 层不清理引用的理由见 projects.js 文件头）。
 *
 * 会话列表数据源是既有推送（taskListChanged），**不另拉**；产物数据源是
 * 资料库的拉式缓存，过滤是纯函数（projects 视图不建自己的索引）。
 */

/** 色号 → CSS 变量。--cat-1..6 是既有分类色 token，项目色不引入新颜色。负数取模后归位（脏数据防御）。 */
export function projectColorVar(colorIndex) {
	return `var(--cat-${(((colorIndex % 6) + 6) % 6) + 1})`;
}

/**
 * 卡片视图模型：最近活动优先（活跃项目在前）；从未有会话的按创建时间。
 * sessionsByPath: Map<path, session>（渲染层由 taskList 建立，键为 path 原样）。
 */
export function projectCardModel(project, sessionsByPath) {
	let lastActivity = 0;
	let resolved = 0;
	for (const path of project.sessionPaths) {
		const session = sessionsByPath.get(path);
		if (session === undefined) continue;
		resolved += 1;
		const at = typeof session.modifiedAt === "number" ? session.modifiedAt : 0;
		if (at > lastActivity) lastActivity = at;
	}
	return {
		...project,
		resolvedSessionCount: resolved,
		unresolvedCount: project.sessionPaths.length - resolved,
		lastActivity: lastActivity > 0 ? lastActivity : project.createdAt,
		hasInstructions: (project.instructions ?? "").trim() !== ""
	};
}

/** 卡片墙排序：最近活动降序；并列（含都无会话）时创建时间降序。 */
export function sortProjectCards(projects, sessionsByPath) {
	return projects
		.map((p) => projectCardModel(p, sessionsByPath))
		.sort((a, b) => b.lastActivity - a.lastActivity || b.createdAt - a.createdAt);
}

/**
 * 详情的会话行：按会话自身的 modifiedAt 降序。映射不到的路径不丢弃，
 * 汇成 unresolvedPaths（视图给一行降级说明）。
 */
export function projectSessionRows(project, sessionsByPath) {
	const rows = [];
	const unresolvedPaths = [];
	for (const path of project.sessionPaths) {
		const session = sessionsByPath.get(path);
		if (session === undefined) {
			unresolvedPaths.push(path);
			continue;
		}
		rows.push(session);
	}
	rows.sort((a, b) => (b.modifiedAt ?? 0) - (a.modifiedAt ?? 0));
	return { rows, unresolvedPaths };
}

/**
 * 项目产物行：资料库条目按「来源会话 ∈ 项目」过滤。
 * library entry 的 sessions[] 是交付过它的会话（[{path,…}]，见 library.js 的聚合），
 * 任一来源会话在项目里即命中。
 */
export function projectArtifactRows(libraryEntries, project) {
	const owned = new Set(project.sessionPaths);
	return libraryEntries.filter((entry) => (entry.sessions ?? []).some((s) => owned.has(s.path)));
}

/** 指令编辑状态：字数与超限判定（上限来自 daemon 的同一常量，这里独立成一份纯逻辑）。 */
export const INSTRUCTIONS_LIMIT = 2000;

export function instructionsStatus(text) {
	const count = typeof text === "string" ? text.length : 0;
	return { count, over: count > INSTRUCTIONS_LIMIT, remaining: INSTRUCTIONS_LIMIT - count };
}
