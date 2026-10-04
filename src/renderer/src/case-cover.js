/**
 * 首屏「最佳实践案例」封面的几何内核：**第一方生成**，不碰网络。
 *
 * ## 为什么把封面改成生成的（#104）
 *
 * 这 12 张封面此前直接引第三方 CDN（`static.workbuddy.cn`，`EXTERNAL_REQUESTS.md`
 * §6 登记为「不可控」）。数据面没问题，但**体验面破功**：一个把「本地优先」当卖点的
 * 产品，第一次打开就向第三方域名发请求 —— 用户装它正是因为不想让数据出去，而第一屏
 * 就在出网。深色主题落地后这件事更显眼：暗色首页里最亮的四块矩形是别人的实拍图，
 * 视线先被吸走再回到输入卡，与 docs/DESIGN.md §3.9「唯一的视觉重点是输入卡」相反。
 *
 * 那批图**随包分发属于再分发**，须先确认授权（红线 9，与 #19 同类）—— 授权没确认
 * 之前不能走这条路。于是封面改为按**交付物类型**画的示意图：文档 / 图表 / 幻灯片 /
 * 研究笔记四种形态，配色复用既有分类色板。代价是丢掉「实拍成品预览」的信息量，
 * 换回来的是：不出网、不涉授权、深浅两套自动一致、体积为零。
 *
 * ## 为什么这些函数在这里而不是组件里
 *
 * 「同类目下三条不能长成三张一样的瓷砖」靠的是**由案例 id 派生的确定性几何**。
 * 这件事只有两种情况：要么同一个 id 永远给同一组宽度（可复现），要么不 ——
 * 后者会让每次重渲染的封面都不同（视觉抖动），前者是一个纯函数，能毫秒级单测。
 */

/**
 * 交付物形态 → 画法。`chipId` 来自 `cases.json`，与 `chips.json` 的胶囊一一对应。
 * 未知 chipId 落到 `doc`（**确定的缺省**，不是随机的）：案例数据加了新类目、
 * 而这里还没跟上时，界面显示一张正常的文档示意，不会开天窗。
 */
const VARIANTS = {
	"doc-processing": "doc",
	"data-viz": "chart",
	slides: "slide",
	"deep-research": "note",
};

/**
 * 类目 → 分类色板槽位（`--cat-1..6`）。**不新造颜色**：
 * 这六槽已同时定义在亮色与暗色两个 token 块里（`check-theme-tokens` 覆盖），
 * 因此主题切换自动跟随，不需要为本功能新增任何 token。
 */
const ACCENTS = {
	"doc-processing": "var(--cat-1)",
	"data-viz": "var(--cat-4)",
	slides: "var(--cat-5)",
	"deep-research": "var(--cat-2)",
};

/** 画法变体；未知类目回 `doc`。 */
export function coverVariant(chipId) {
	return VARIANTS[chipId] ?? "doc";
}

/** 强调色（分类色板的变量引用）；未知类目回第一槽。 */
export function coverAccent(chipId) {
	return ACCENTS[chipId] ?? "var(--cat-1)";
}

/**
 * 由 id 派生一个稳定的正整数（FNV-1a 的 32 位变体）。
 *
 * 为什么不用 `Math.random()` 或数组下标：随机数每次渲染都变（封面会抖），
 * 下标则让「第 1 条永远最宽、第 3 条永远最窄」——三条并排时规律太明显，像手滑。
 */
export function coverSeed(id) {
	const text = typeof id === "string" ? id : "";
	let hash = 0x811c9dc5;
	for (let i = 0; i < text.length; i += 1) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash >>> 0;
}

/** 把种子的一段映射到 [min, max] 的整数（种子不同段取，避免三处宽度联动手抖）。 */
function pick(seed, shift, min, max) {
	const span = max - min + 1;
	return min + (((seed >>> shift) % span) + span) % span;
}

/**
 * 内容线的宽度（百分比，从左往右）。三条线的宽度由 id 决定 ——
 * 同一类目的三条案例因此像**同一套排版下的不同文档**，而不是三张复制的瓷砖。
 */
export function coverLines(id) {
	const seed = coverSeed(id);
	return [pick(seed, 0, 52, 78), pick(seed, 7, 68, 96), pick(seed, 13, 38, 66)];
}

/** 图表的三个柱子高度（百分比，越高越靠前）。 */
export function coverBars(id) {
	const seed = coverSeed(id);
	return [pick(seed, 3, 34, 58), pick(seed, 11, 50, 76), pick(seed, 19, 62, 96)];
}

/**
 * 纸面顶部那条类目色短条的宽度（百分比）。
 *
 * 为什么它也要按 id 派生：同一个类目下的三条案例内容线本来就不同，但**色条**是
 * 第一眼看到的东西 —— 写死 38% 的话，三张卡片在余光里是同一张图。
 */
export function coverBarWidth(id) {
	return pick(coverSeed(id), 23, 26, 58);
}

/**
 * 一张封面的**整体签名**（题头长度 + 内容几何）。这才是「两张封面是不是同一张图」
 * 的判据 —— 单看某一项会碰撞（哈希本来就会），但同一类目下三条整体相同就是真的
 * 复制粘贴。界面测试也按这个签名比对（那边是从 DOM 里读出来的）。
 */
export function coverSignature(id) {
	return [coverBarWidth(id), ...coverLines(id)].join("/");
}
