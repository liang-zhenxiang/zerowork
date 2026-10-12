/**
 * 首页「继续推进」交接摘要的单测。
 *
 * 被测对象是 `src/main/daemon/session-digest.js` —— 刻意抽成一个**能在 Electron
 * 之外 import** 的纯模块（`session-files.js` 顶层就 `requireParentPort()` +
 * `loadResources()`，import 不了；理由见该模块文件头，与 library.js 同模式）。
 *
 * 覆盖 design.md §7「单元」清单的全部条目：三 kind 判定（交付在尾 / 文本在尾 /
 * 纯工具流 fallback）、交付后又说话按 text、截断与 markdown 清洗、names 上限与
 * extra 计数、timestamp 缺失 → at=0、坏条目跳过、空数组 → fallback、尾部窗口。
 *
 * ── 反向验证（已真跑并还原，记录见任务 research/ 与提交说明）──────────────
 * 1) 改坏优先级（把「交付后又说话 → 按 text」改成「交付永远赢」，即把判定
 *    `deliveredIdx > textIdx` 改成 `deliveredIdx !== -1`），实测**恰好**一条变红：
 *      - 「交付后又说话 → 按最后一句回复，不是 delivered」
 *    （「文本在尾」不红是正常的：该用例里没有交付条目，注入不影响它 ——
 *    那条防的是另一方向的坏法。）
 * 2) 把 cleanSummaryText 改成原样返回（不清洗），则「markdown 清洗」与
 *    「截断」两条会红（首尾符号与围栏噪声进入摘要文本）。
 */

import { describe, expect, it } from "vitest";
import {
	DIGEST_LARGE_FILE_BYTES,
	DIGEST_NAMES_MAX,
	DIGEST_TAIL_WINDOW,
	DIGEST_TEXT_MAX,
	summarizeLastActivity,
} from "../../src/main/daemon/session-digest.js";

/** 造一条 assistant 文本消息条目（content 是 text 块数组，pi 的落盘形态）。 */
const assistantText = (text, timestamp = "2026-10-02T12:00:00.000Z") => ({
	type: "message",
	id: `m-${text.length}`,
	parentId: null,
	timestamp,
	message: { role: "assistant", content: [{ type: "text", text }] },
});

/** 造一条用户消息条目（摘要算法只认 assistant 文本；用户文本不该顶掉交付）。 */
const userText = (text) => ({
	type: "message",
	id: `u-${text.length}`,
	parentId: null,
	timestamp: "2026-10-02T11:00:00.000Z",
	message: { role: "user", content: [{ type: "text", text }] },
});

/** 造一条工具结果消息条目（无 text 块，content 形态与 pi 落盘一致）。 */
const toolResult = () => ({
	type: "message",
	id: "t-1",
	parentId: null,
	timestamp: "2026-10-02T11:30:00.000Z",
	message: { role: "toolResult", content: [{ type: "text", text: "0 号文件已写入" }] },
});

/** 造一条交付条目（artifacts_presented，files 是绝对路径，见 library.js 同源解析）。 */
const delivered = (paths, timestamp = "2026-10-02T12:21:58.000Z") => ({
	type: "custom",
	customType: "artifacts_presented",
	id: "a-1",
	parentId: null,
	timestamp,
	data: { files: paths.map((path) => ({ path, size: 10, html: false, kind: "local" })) },
});

describe("summarizeLastActivity —— 三 kind 判定（纯函数）", () => {
	it("交付在尾（其后没有新的 assistant 文本）→ delivered，names 是 basename，at 取交付时间", () => {
		const digest = summarizeLastActivity([
			userText("整理周报"),
			assistantText("正在整理"),
			delivered(["/ws/周报.md", "/ws/数据.xlsx"]),
		]);
		expect(digest).toEqual({
			kind: "delivered",
			names: ["周报.md", "数据.xlsx"],
			extra: 0,
			at: Date.parse("2026-10-02T12:21:58.000Z"),
		});
	});

	it("交付后用户又发消息但模型未回 → 仍是 delivered（「其后」只看 assistant 文本）", () => {
		const digest = summarizeLastActivity([
			assistantText("做完了"),
			delivered(["/ws/周报.md"]),
			userText("再补一段总结"),
		]);
		expect(digest.kind).toBe("delivered");
	});

	it("交付后又说话 → 按最后一句回复，不是 delivered", () => {
		const digest = summarizeLastActivity([
			delivered(["/ws/周报.md"]),
			assistantText("还有一处口径要你确认"),
		]);
		expect(digest).toEqual({ kind: "text", text: "还有一处口径要你确认", at: Date.parse("2026-10-02T12:00:00.000Z") });
	});

	it("文本在尾：只有对话、没有交付 → text", () => {
		const digest = summarizeLastActivity([userText("写周报"), assistantText("写完了，等你过目")]);
		expect(digest.kind).toBe("text");
		expect(digest.text).toBe("写完了，等你过目");
	});

	it("纯工具流（用户 + 工具结果，没有 assistant 文本、没有交付）→ fallback", () => {
		expect(summarizeLastActivity([userText("跑一下"), toolResult()])).toEqual({ kind: "fallback" });
	});

	it("空数组 / 非数组输入 → fallback（不抛）", () => {
		expect(summarizeLastActivity([])).toEqual({ kind: "fallback" });
		expect(summarizeLastActivity(undefined)).toEqual({ kind: "fallback" });
	});

	it("坏条目（null / 字符串 / 无 type 的对象）跳过，不炸也不顶掉好条目", () => {
		const digest = summarizeLastActivity([
			null,
			"这不是条目",
			42,
			{ noType: true },
			delivered(["/ws/周报.md"]),
			{ type: "custom", customType: "artifacts_presented", data: {} },
		]);
		// 最后那条「交付条目」没有有效文件，不算交付；倒数第三条才是有效交付。
		expect(digest.kind).toBe("delivered");
		expect(digest.names).toEqual(["周报.md"]);
	});
});

describe("summarizeLastActivity —— delivered 的 names 与 extra", () => {
	it("超过 DIGEST_NAMES_MAX 个文件 → 只列前两个，其余进 extra 计数", () => {
		const digest = summarizeLastActivity([
			delivered(["/ws/a.md", "/ws/b.md", "/ws/c.md", "/ws/d.md"]),
		]);
		expect(digest.kind).toBe("delivered");
		expect(digest.names).toEqual(["a.md", "b.md"]);
		expect(digest.extra).toBe(2);
	});

	it("namesMax 可注入（IO 层不覆写，这里只为钉住选项语义）", () => {
		const digest = summarizeLastActivity([delivered(["/ws/a.md", "/ws/b.md", "/ws/c.md"])], { namesMax: 1 });
		expect(digest.names).toEqual(["a.md"]);
		expect(digest.extra).toBe(2);
	});
});

describe("summarizeLastActivity —— text 的清洗与截断", () => {
	it("超长文本截断到 DIGEST_TEXT_MAX 字 + 省略号", () => {
		const long = "数".repeat(DIGEST_TEXT_MAX + 40);
		const digest = summarizeLastActivity([assistantText(long)]);
		expect(digest.text).toBe(`${"数".repeat(DIGEST_TEXT_MAX)}…`);
		expect(digest.text.length).toBe(DIGEST_TEXT_MAX + 1);
	});

	it("代码围栏整段去掉（含未闭合的流式残段）", () => {
		const closed = summarizeLastActivity([
			assistantText("改好了\n```js\nconsole.log(1)\n```\n下一步等你确认"),
		]);
		expect(closed.text).toBe("改好了 下一步等你确认");
		const unclosed = summarizeLastActivity([assistantText("正在写\n```bash\nnpm run")]);
		expect(unclosed.text).toBe("正在写");
	});

	it("链接留文字去 URL，裸 URL 整个去掉", () => {
		const digest = summarizeLastActivity([
			assistantText("参考 [项目文档](https://example.com/docs/a?x=1) 与 https://example.com/raw 后再说"),
		]);
		expect(digest.text).toBe("参考 项目文档 与 后再说");
	});

	it("行首标题 / 列表标记与首尾 # * ` 及空白清掉，中间空白折叠", () => {
		const digest = summarizeLastActivity([
			assistantText("## 已完成\n- 第一步\n- 第二步\n\n**收尾中**"),
		]);
		expect(digest.text).toBe("已完成 第一步 第二步 收尾中");
		const quoted = summarizeLastActivity([assistantText("`npm test` 通过")]);
		expect(quoted.text).toBe("npm test 通过");
	});

	it("清洗后为空（整条都是围栏 / 标记）→ 不算有文本，落 fallback", () => {
		expect(summarizeLastActivity([userText("跑"), assistantText("```\nonly code\n```")])).toEqual({
			kind: "fallback",
		});
	});
});

describe("summarizeLastActivity —— at 与尾部窗口", () => {
	it("timestamp 缺失 / 坏值 → at = 0（渲染层退用会话 modifiedAt）", () => {
		const noStamp = { ...assistantText("好了"), timestamp: undefined };
		expect(summarizeLastActivity([noStamp]).at).toBe(0);
		const badStamp = { ...assistantText("好了"), timestamp: "不是时间" };
		expect(summarizeLastActivity([badStamp]).at).toBe(0);
	});

	it("窗口外的条目不参与：交付掉出尾部窗口 → 按窗口内最后一句回复", () => {
		const digest = summarizeLastActivity(
			[delivered(["/ws/老交付.md"]), assistantText("窗口内的最后一句")],
			{ tailWindow: 1 },
		);
		expect(digest.kind).toBe("text");
		expect(digest.text).toBe("窗口内的最后一句");
	});

	it("默认窗口是 DIGEST_TAIL_WINDOW 条", () => {
		const records = Array.from({ length: DIGEST_TAIL_WINDOW + 10 }, (_, i) =>
			i < DIGEST_TAIL_WINDOW + 9 ? toolResult() : assistantText("末句"),
		);
		// 末句assistant 在窗口内（最后一条），前面全是工具流 → text；
		// 再在窗口外放一次交付，确认它被窗口挡掉。
		records.unshift(delivered(["/ws/远古交付.md"]));
		const digest = summarizeLastActivity(records);
		expect(digest).toEqual({ kind: "text", text: "末句", at: Date.parse("2026-10-02T12:00:00.000Z") });
	});
});

describe("常量契约（IO 层 session-files.js 依赖这些值做超限判定）", () => {
	it("四个上限常量与 design.md §2/§3 一致", () => {
		expect(DIGEST_TEXT_MAX).toBe(60);
		expect(DIGEST_TAIL_WINDOW).toBe(200);
		expect(DIGEST_LARGE_FILE_BYTES).toBe(2 * 1024 * 1024);
		expect(DIGEST_NAMES_MAX).toBe(2);
	});
});
