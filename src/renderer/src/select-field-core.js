/**
 * 自绘下拉（`SelectField`）的纯逻辑：高亮索引的移动与可访问名归一化。
 *
 * 与 `command-palette-core.js` / `expert-gallery-core.js` 同一模式：不 import
 * 任何东西、不碰 DOM，因此能被 vitest 直接 import。界面上这些判断只表现为
 * 「方向键跳了一格 / 跳到了末尾」「读屏多念了一遍当前值」——恰是 GUI 断言最
 * 说不清、单测最容易钉死的一类。
 *
 * 三条约定（`docs/DESIGN.md` §7.9 与 `.trellis/spec/renderer/index.md` §九）：
 *   · 高亮不是选中：这里只算「焦点该停在哪一项」，`aria-selected` 由组件按
 *     真实 `value` 决定，两者不能互相顶替；
 *   · 循环移动：首项向上回末项、末项向下回头项，不把边界当成「卡住」；
 *   · 可访问名不重复拼接：调用方已经把当前值写进 `ariaLabel` 时（如
 *     「排序方式：名称」）原样返回，避免读成「排序方式：名称：名称」。
 */

/**
 * 打开面板时初始高亮的项：当前选中项的下标；没有匹配时回到首项。
 *
 * 空列表返回 0 —— 组件据此不渲染 `aria-activedescendant`（没有可指向的项），
 * 而不是把 `undefined` 漏进 DOM 属性。
 *
 * @param {Array<{ value: unknown }>} options
 * @param {unknown} value
 * @returns {number}
 */
export function initialActiveIndex(options, value) {
	if (!Array.isArray(options) || options.length === 0) return 0;
	const index = options.findIndex((option) => option.value === value);
	return index === -1 ? 0 : index;
}

/**
 * 移动高亮项。`wrap` 为真时循环（越过两端回到另一端），否则夹在边界内。
 *
 * `count === 0` 时返回 0：没有选项就没有「第几项」可言，调用方据此跳过渲染。
 *
 * @param {number} index 当前下标（可能越界或非数字，按 0 处理）
 * @param {number} delta 移动量（方向键 ±1，允许更大步长）
 * @param {number} count 选项总数
 * @param {boolean} [wrap=true]
 * @returns {number}
 */
export function moveActiveIndex(index, delta, count, wrap = true) {
	if (!Number.isInteger(count) || count <= 0) return 0;
	const base = Number.isInteger(index) ? index : 0;
	const step = Number.isInteger(delta) ? delta : 0;
	const next = base + step;
	if (wrap) return ((next % count) + count) % count;
	return Math.min(count - 1, Math.max(0, next));
}

/**
 * Home / End 的高亮下标。`edge` 只认 `"end"`，其余（含 `"home"`）回到首项。
 *
 * @param {"home" | "end"} edge
 * @param {number} count
 * @returns {number}
 */
export function edgeActiveIndex(edge, count) {
	if (!Number.isInteger(count) || count <= 0) return 0;
	return edge === "end" ? count - 1 : 0;
}

/**
 * 触发器的可访问名：标签 + 当前值，且**不重复**。
 *
 * 部分调用方（排序、资料库筛选）已经把当前值拼进了 `ariaLabel`，再拼一次会
 * 读成「排序方式：名称：名称」。判据是「标签里已包含这段文案」——按子串判断，
 * 而不是要求完全相等，这样「类型筛选：全部」这类带前缀的写法也能命中。
 *
 * 两侧都为空时返回空串：组件据此退回 `placeholder`，不渲染空 `aria-label`。
 *
 * @param {string | undefined} label
 * @param {string | undefined} displayText
 * @returns {string}
 */
export function accessibleName(label, displayText) {
	const name = typeof label === "string" ? label.trim() : "";
	const text = typeof displayText === "string" ? displayText.trim() : "";
	if (name === "") return text;
	if (text === "") return name;
	if (name.includes(text)) return name;
	return `${name}：${text}`;
}
