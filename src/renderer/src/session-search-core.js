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
		capped: result?.capped === true,
	};
}

/**
 * 摘要文案。上限必须如实说出来 —— 「只扫了最近 200 个会话」和「搜遍全库」
 * 是两种承诺，界面不该混用。
 */
export function describeSearchSummary(result) {
	const { sessionCount, hitCount, scanned, scannedLimit, truncated, capped } = summarizeSearch(result);
	if (sessionCount === 0) {
		const miss = `已检索最近 ${scanned} 个会话，没有匹配`;
		return truncated && !capped ? `${miss}；更早的会话未查` : miss;
	}
	const head = `已检索 ${scanned} 个会话 · ${sessionCount} 个会话命中 ${hitCount} 处`;
	// 两种「没搜全」要分开说：capped 是「命中太多、只列前几条会话」，文件还有没读的；
	// truncated 是「扫到 200 个上限就停」。混成一句会把显示上限误报成扫描上限。
	if (capped) return `${head}；命中较多，只列出前 ${sessionCount} 个会话`;
	if (truncated) {
		const window = scannedLimit > 0 ? scannedLimit : scanned;
		return `${head}；更早的会话未查（单次最多扫最近 ${window} 个）`;
	}
	return head;
}

/* ── #493 第三十五轮 F6：拼音首字母匹配（零依赖小字表） ─────────────────
   常用词首字母表：只覆盖检索场景高频词（约 100 条）。用户输入「hyj」能命中
   「会议纪要」。表外汉字不匹配（宁缺毋假）。 */
const PINYIN_INITIALS = {
	会: "h", 议: "y", 纪: "j", 要: "y",
	整: "z", 理: "l", 组: "z", 织: "z", 讨: "t", 论: "l",
	项: "x", 目: "m", 复: "f", 盘: "p", 总: "z", 结: "j",
	计: "j", 划: "h", 任: "r", 务: "w", 清: "q", 单: "d",
	周: "z", 报: "b", 告: "g", 文: "w", 档: "d", 记: "j",
	录: "l", 摘: "z", 测: "c", 试: "s", 部: "b", 署: "s",
	发: "f", 布: "b", 版: "b", 本: "b", 归: "g", 档: "d",
	研: "y", 究: "j", 分: "f", 析: "x", 数: "s", 据: "j",
	可: "k", 视: "s", 化: "h", 图: "t", 表: "b", 指: "z",
	标: "b", 曲: "q", 线: "x", 预: "y", 算: "s", 成: "c",
	本: "b", 收: "s", 入: "r", 支: "z", 出: "c", 客: "k",
	户: "h", 合: "h", 同: "t", 发: "f", 票: "p", 付: "f",
	款: "k", 供: "g", 应: "y", 商: "s", 采: "c", 购: "g",
	流: "l", 程: "c", 规: "g", 范: "f", 说: "s", 明: "m",
	书: "s", 手: "s", 册: "c", 教: "j", 程: "c", 用: "y",
	户: "h", 指: "z", 南: "n", 快: "k", 速: "s", 入: "r",
	门: "m", 示: "s", 例: "l", 演: "y", 配: "p", 置: "z",
	安: "a", 装: "z", 升: "s", 级: "j", 更: "g", 新: "x",
	备: "b", 份: "f", 恢: "h", 复: "f", 迁: "q", 移: "y",
	同: "t", 步: "b", 行: "h", 动: "d", 里: "l", 程: "c",
	碑: "b", 甘: "g", 特: "t", 图: "t", 风: "f", 险: "x",
	评: "p", 估: "g", 问: "w", 题: "t", 故: "g", 障: "z",
	排: "p", 查: "c", 日: "r", 志: "z", 错: "c", 误: "w",
	警: "j", 告: "g", 设: "s", 置: "z", 修: "x", 订: "d",
	反: "f", 馈: "k", 帮: "b", 助: "z", 搜: "s", 索: "s",
	引: "y", 擎: "q", 命: "m", 中: "z", 高: "g", 亮: "l",
	模: "m", 型: "x", 密: "m", 钥: "y", 供: "g", 应: "y",
	商: "s", 运: "y", 行: "x", 时: "s", 间: "j", 逗: "d",
	号: "h", 分: "f", 享: "x", 导: "d", 出: "c", 入: "r"
};
/** 「hyj」→ 判断 target 是否可能命中（首字母序列前缀匹配）。 */
export function matchPinyinInitials(input, target) {
	const initials = [...target].map((ch) => PINYIN_INITIALS[ch]).filter((v) => v !== void 0).join("");
	if (initials === "") return false;
	return initials.toLowerCase().startsWith(input.toLowerCase());
}
