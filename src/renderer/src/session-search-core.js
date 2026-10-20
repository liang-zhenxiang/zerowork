/**
 * 会话检索页的**展示逻辑**（纯函数，无 React / 无 window）。
 *
 * 这些函数之所以单独放一层：高亮区间来自 daemon（片段可能被裁剪、合并过），
 * 一旦切错位置就是「红字标在无关的字上」，而这类错误在 GUI 测试里很难看出来。
 * 放在纯函数里，单测能逐段断言。
 */

/** 角色标签：检索结果里不该出现 user/assistant 这种内部词。 */
export function roleLabel(role) {
	return role === "user" ? "你问的" : "它答的";
}

/**
 * 把合并过的命中区间切成「普通段 / 高亮段」，供渲染层逐段 `<mark>`。
 *
 * 容错策略：区间越界、反向、零长度一律忽略（daemon 裁剪片段后区间可能刚好贴边），
 * 全部忽略时退化成整段普通文本 —— 宁可不标，也不要标错。
 */
export function buildHighlightSegments(snippet, matches) {
	const text = typeof snippet === "string" ? snippet : "";
	if (text === "") return [];
	const ranges = [];
	if (Array.isArray(matches)) {
		for (const match of matches) {
			if (match === null || typeof match !== "object") continue;
			const start = Math.max(0, Math.min(text.length, Number(match.start)));
			const end = Math.max(0, Math.min(text.length, Number(match.end)));
			if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
			if (end <= start) continue;
			ranges.push({ start, end });
		}
	}
	if (ranges.length === 0) return [{ text, hit: false }];
	ranges.sort((a, b) => a.start - b.start || a.end - b.end);
	const merged = [];
	for (const range of ranges) {
		const prev = merged[merged.length - 1];
		if (prev !== undefined && range.start <= prev.end) {
			prev.end = Math.max(prev.end, range.end);
		} else {
			merged.push({ ...range });
		}
	}
	const segments = [];
	let cursor = 0;
	for (const range of merged) {
		if (range.start > cursor) segments.push({ text: text.slice(cursor, range.start), hit: false });
		segments.push({ text: text.slice(range.start, range.end), hit: true });
		cursor = range.end;
	}
	if (cursor < text.length) segments.push({ text: text.slice(cursor), hit: false });
	return segments;
}

/**
 * 把「按会话分组」的结果摊平成一条导航序列（键盘上下移动 / 高亮当前项用）。
 * 每条都带上会话上下文，因为点下去要同时知道「打开哪个会话」和「定位哪条消息」。
 */
export function flattenSearchHits(sessions) {
	const rows = [];
	if (!Array.isArray(sessions)) return rows;
	sessions.forEach((session, sessionIndex) => {
		if (session === null || typeof session !== "object") return;
		const hits = Array.isArray(session.hits) ? session.hits : [];
		hits.forEach((hit, hitIndex) => {
			if (hit === null || typeof hit !== "object") return;
			rows.push({
				key: `${session.sessionId ?? ""}:${hit.entryId ?? hitIndex}`,
				sessionIndex,
				hitIndex,
				sessionId: session.sessionId,
				title: session.title,
				path: session.path,
				modifiedAt: session.modifiedAt,
				entryId: hit.entryId,
				role: hit.role,
				snippet: hit.snippet,
				matches: hit.matches,
			});
		});
	});
	return rows;
}

/**
 * 结果摘要的数字口径：会话数 / 命中总数 / 扫了多少 / 是否有没扫到的。
 * 会话数按「真有命中的会话」算；命中总数按 daemon 给的 totalHits 累加
 *（每会话只带回前几条片段，但总数是完整的 —— 摘要不能只数可见条数）。
 */
export function summarizeSearch(result) {
	const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
	let hitCount = 0;
	for (const session of sessions) {
		const total = Number(session?.totalHits);
		hitCount += Number.isFinite(total) && total > 0 ? total : Array.isArray(session?.hits) ? session.hits.length : 0;
	}
	const scanned = Number.isFinite(Number(result?.scanned)) ? Number(result.scanned) : 0;
	const scannedLimit = Number.isFinite(Number(result?.scannedLimit)) ? Number(result.scannedLimit) : 0;
	return {
		sessionCount: sessions.length,
		hitCount,
		scanned,
		scannedLimit,
		truncated: result?.truncated === true,
	};
}

/**
 * 摘要文案。上限必须如实说出来 —— 「只扫了最近 200 个会话」和「搜遍全库」
 * 是两种承诺，界面不该混用。
 */
export function describeSearchSummary(result) {
	const { sessionCount, hitCount, scanned, scannedLimit, truncated } = summarizeSearch(result);
	if (sessionCount === 0) return `在最近 ${scanned} 个会话里没有找到匹配`;
	const head = `在最近 ${scanned} 个会话里找到 ${sessionCount} 个会话、${hitCount} 处命中`;
	if (!truncated) return head;
	const window = scannedLimit > 0 ? scannedLimit : scanned;
	return `${head}；更早的会话没有扫（每次最多看最近 ${window} 个），换个更具体的词试试`;
}
