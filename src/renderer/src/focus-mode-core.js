/**
 * 专注模式的纯逻辑：存储值的读/写/校验、状态切换、DOM 属性写入、阅读列宽。
 *
 * 单独成模块的理由：这些判断**没法靠看界面确认**——比如「存了个坏值该按开还是按关」，
 * 界面在两种取值下都长得一样，只有把规则写成可断言的函数才守得住。
 * 副作用（localStorage / document）也从这里注入，所以单测不需要 DOM。
 */

/** localStorage 键。命名与既有 `zerowork.*` 一族同口径。 */
export const FOCUS_STORAGE_KEY = "zerowork.focusMode";
/** 落在 `<html>` 上的属性名。CSS 只认 `html[data-focus="on"]`。 */
export const FOCUS_ATTR = "data-focus";
/** 专注模式的阅读列宽（px）。比常规 832 窄，一行中文约 34–38 字。 */
export const FOCUS_CONTENT_WIDTH = 720;

/**
 * 把任意来源的值收敛成布尔。
 *
 * 只有明确的「开」才算开：`true` / `"on"` / `"1"` / `1`。
 * 其余（`null`、`"false"`、`"0"`、乱码、缺字段）一律按**关**处理 ——
 * 理由是这个模式的失败方向应当是「回到普通界面」，而不是把一个用户没要求的
 * 阅读态强加给他。
 */
export function normalizeFocus(value) {
	return value === true || value === 1 || value === "1" || value === "on";
}

/** 状态切换。入参可以是存储里的原始值，也可以已经是布尔。 */
export function toggleFocus(value) {
	return !normalizeFocus(value);
}

/** 读 localStorage。坏 JSON、隐私模式抛异常、没有这个键 —— 都按「关」。 */
export function readFocus(storage) {
	if (storage == null) return false;
	try {
		return normalizeFocus(JSON.parse(storage.getItem(FOCUS_STORAGE_KEY) ?? "false"));
	} catch {
		return false;
	}
}

/**
 * 写 localStorage。写不进去（配额满、隐私模式）不该让界面崩 ——
 * 这一轮的可见效果已经生效了，失败的只是「下次打开还记得」。
 */
export function persistFocus(storage, enabled) {
	if (storage == null) return false;
	try {
		storage.setItem(FOCUS_STORAGE_KEY, JSON.stringify(normalizeFocus(enabled)));
		return true;
	} catch {
		return false;
	}
}

/**
 * 写到 `<html>` 上。用属性而不是类名：`data-*` 不参与 class 的字符串拼接，
 * 将来别的状态（比如「阅读字号」）也能各占一个属性，互不覆盖。
 */
export function applyFocus(root, enabled) {
	if (root == null || typeof root.setAttribute !== "function") return;
	root.setAttribute(FOCUS_ATTR, normalizeFocus(enabled) ? "on" : "off");
}

/**
 * 专注模式下的会话列宽：**只收不扩**。
 *
 * 窗口本来就比 720 窄时保持原值 —— 专注模式是「让正文更好读」，不是「强行撑宽」，
 * 在窄窗口上再加宽会直接产生横向滚动条。
 */
export function focusContentWidth(baseWidth) {
	if (!Number.isFinite(baseWidth) || baseWidth <= 0) return FOCUS_CONTENT_WIDTH;
	return Math.min(baseWidth, FOCUS_CONTENT_WIDTH);
}
