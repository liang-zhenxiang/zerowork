/**
 * 修订模式（#456）跨层共用的小常量。
 *
 * 为什么单独放 shared：拦截发生在 daemon（doc-edits.js），但「这条工具结果是不是
 * 修订模式拦下的」要在**回放**（session-view.js）与界面（app.js / trace-core.js）
 * 两处再判一次 —— 而 doc-edits.js 已经 import 了 session-view.js，反向 import 会成环。
 *
 * 判据是**原因前缀**而不是 outcome：pi 的 tool_call `block` 会以 `isError:true`
 * 结束，outcome 与真正的失败无法区分；只有 daemon 自己写的那条原因能把它认出来。
 * 前缀必须与 doc-edits.js 的返回完全一致 —— 这是字符串协议，改动要同步两处，
 * 单测里用同一条常量断言（见 tests/unit/doc-edits.test.mjs）。
 */
export const DOC_EDIT_BLOCK_PREFIX = "修订模式已开启：";

/** 这段工具结果文本是否是修订模式拦下的（而不是真正的写入失败）。 */
export function isDocEditBlockText(text) {
	return typeof text === "string" && text.startsWith(DOC_EDIT_BLOCK_PREFIX);
}
