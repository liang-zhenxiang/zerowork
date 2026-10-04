/**
 * 「导出为 Markdown」的渲染逻辑单测（`src/main/daemon/session-markdown.js`）。
 *
 * 这块是**纯函数**：不碰 IO、不需要 Electron —— 导出功能最大的风险不是「文件写不出来」，
 * 而是**导出来的东西少了半截**（某一类条目没渲染、超长内容把文档撑爆、工具输出里的
 * 反引号把围栏提前闭合）。这些恰好都能在同一层钉死。
 *
 * 覆盖：文档骨架与元信息、用户（技能块 / 图片）、助手（正文 / 思考 / 工具调用 + 结果）、
 * 命令执行、压缩摘要、分支摘要、模型切换、扩展消息、产物交付、空会话判定、
 * 超长截断、围栏自洽、脏数据不崩。
 *
 * 最后一条是**集成**用例：真的写一个会话文件、真的用 pi 的 `SessionManager` 读它、
 * 把 `getBranch()` 的产物喂给渲染器 —— 这一条不需要 Electron，所以它在本机（CI 上也一样）
 * 是**真跑过**的，覆盖「我们的字段假设与 pi 的落盘格式是否对得上」这件事。
 *
 * ── 反向验证（已真跑并还原，见 design.md）──────────────────────────
 * 1) 让 `clamp()` 不再截断（直接返回原文）→「超长工具输出被截断」那条变红。
 * 2) 把 `fenceFor()` 写死返回三个反引号 →「内容里的反引号撑长围栏」那条变红。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
	clamp,
	codeBlock,
	fenceFor,
	formatStamp,
	hasExportableContent,
	renderSessionMarkdown,
} from "../../src/main/daemon/session-markdown.js";
import { DETAIL_LIMIT, TRUNCATED_MARK } from "../../src/main/daemon/session-view.js";

let dirs = [];

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), "zerowork-md-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs = [];
});

let seq = 0;

/** 造一条 message 条目。 */
function message(role, content, extra = {}) {
	seq += 1;
	return {
		type: "message",
		id: `e${seq}`,
		parentId: null,
		timestamp: "2026-10-03T10:00:00.000Z",
		message: { role, content, timestamp: Date.parse("2026-10-03T10:00:00.000Z"), ...extra },
	};
}

const header = { type: "session", version: 3, id: "s1", timestamp: "2026-10-03T10:00:00.000Z", cwd: "/ws/项目甲" };
const NOW = new Date("2026-10-03T12:34:56.000Z");

const render = (entries, extra = {}) =>
	renderSessionMarkdown({ title: "做一份销售看板", header, entries, now: NOW, ...extra });

describe("文档骨架与元信息", () => {
	it("标题、导出时间、工作空间、模型、消息计数都在", () => {
		const md = render([
			{ type: "model_change", id: "m1", parentId: null, timestamp: "2026-10-03T10:00:00.000Z", provider: "storefront", modelId: "model-x" },
			message("user", "帮我做一份看板"),
			message("assistant", [{ type: "text", text: "做好了。" }], { stopReason: "stop" }),
		]);

		expect(md.startsWith("# 做一份销售看板\n")).toBe(true);
		expect(md).toContain("- 工作空间：`/ws/项目甲`");
		expect(md).toContain("- 模型：storefront/model-x");
		expect(md).toContain("- 消息：你 1 条 / ZeroWork 1 条 / 工具调用 0 次");
		expect(md).toContain("## 你");
		expect(md).toContain("## ZeroWork");
		// 时间跟在标题后、纯文本（不用内联 HTML —— 导出的文档要能贴进任何 Markdown 环境）。
		expect(md).toMatch(/## 你 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
		expect(md, "不该出现内联 HTML").not.toContain("<sub>");
		expect(md.endsWith("\n"), "文档结尾应有一个换行").toBe(true);
	});

	it("标题为空时回落到「会话记录」，不产出空的一级标题", () => {
		const md = renderSessionMarkdown({ title: "   ", header, entries: [], now: NOW });
		expect(md.startsWith("# 会话记录\n")).toBe(true);
	});

	it("时间戳格式化：合法 ISO 出时间，脏值出空串（不抛）", () => {
		expect(formatStamp("2026-10-03T12:34:56.000Z")).toMatch(/^2026-10-03 \d{2}:\d{2}:\d{2}$/);
		expect(formatStamp("不是时间")).toBe("");
		expect(formatStamp(undefined)).toBe("");
	});
});

describe("用户消息", () => {
	it("技能调用渲染成一行说明；技能自己的注入正文与标签都不进导出", () => {
		// 磁盘上的真实形态（见 pi 的 parseSkillBlock）：标签里是技能**注入的指令**，
		// 标签之后才是用户真正打的那句话。
		const md = render([
			message("user", '<skill name="deep-research">（这里是技能注入的一大段指令）</skill>\n\n帮我查一下'),
		]);
		expect(md).toContain("> 调用了技能：deep-research");
		expect(md).toContain("帮我查一下");
		expect(md, "注入的指令属于应用的管道，不是用户的内容").not.toContain("技能注入的一大段指令");
		expect(md).not.toContain("<skill");
	});

	it("图片不内嵌 base64，只留一行占位（含类型与大致体积）", () => {
		const md = render([
			message("user", [
				{ type: "text", text: "看这张图" },
				{ type: "image", mimeType: "image/png", data: "a".repeat(4096) },
			]),
		]);
		expect(md).toContain("看这张图");
		expect(md).toContain("图片：image/png");
		expect(md, "base64 不该出现在导出内容里").not.toContain("a".repeat(64));
	});
});

describe("助手消息与工具", () => {
	it("正文、思考（引用块）、工具调用（入参 JSON）与结果按顺序渲染", () => {
		const md = render([
			message("assistant", [
				{ type: "text", text: "我先读文件。" },
				{ type: "thinking", thinking: "先看看这个目录" },
				{ type: "toolCall", id: "call-1", name: "read_file", arguments: { path: "a.txt" } },
			], { stopReason: "toolUse" }),
			message("toolResult", [{ type: "text", text: "文件内容" }], { toolCallId: "call-1", toolName: "read_file", isError: false }),
		]);

		const textAt = md.indexOf("我先读文件。");
		const thinkAt = md.indexOf("> 思考");
		const callAt = md.indexOf("**工具调用：read_file**");
		const resultAt = md.indexOf("文件内容");
		expect(textAt).toBeGreaterThan(-1);
		expect(thinkAt).toBeGreaterThan(textAt);
		expect(callAt).toBeGreaterThan(thinkAt);
		expect(resultAt).toBeGreaterThan(callAt);
		expect(md).toContain('"path": "a.txt"');
		// 结果挂在那次调用下，不另外起一段（否则同一件事会写两遍）。
		expect(md.match(/文件内容/g)).toHaveLength(1);
	});

	it("工具失败与轮次中止 / 出错都有明确标记", () => {
		const md = render([
			message("assistant", [{ type: "toolCall", id: "c1", name: "run", arguments: {} }], { stopReason: "aborted" }),
			message("toolResult", [{ type: "text", text: "炸了" }], { toolCallId: "c1", isError: true }),
			message("assistant", [{ type: "text", text: "没了" }], { stopReason: "error", errorMessage: "网络断了" }),
		]);
		expect(md).toContain("> 结果：**失败**");
		expect(md).toContain("> （这一轮被中止）");
		expect(md).toContain("> （这一轮出错：网络断了）");
	});

	it("正文与思考按 content 原序渲染（思考在它解释的那句话之前）", () => {
		// pi 常见的顺序就是 [thinking, text]；把思考一律挪到后面会让读者先读到结论、
		// 再读到「我当时在想什么」。与 HTML 导出的两遍结构（先 text/thinking 按序、
		// 再 toolCall）保持一致。
		const md = render([
			message("assistant", [
				{ type: "thinking", thinking: "先想想" },
				{ type: "text", text: "答案是 42" },
			], { stopReason: "stop" }),
		]);
		expect(md.indexOf("> 思考")).toBeLessThan(md.indexOf("答案是 42"));
	});

	it("工具**入参**也会截断：一条 write 调用不能把导出撑到几 MB", () => {
		// write 的 arguments 里装的是整个文件正文（pi 的 schema），这是最容易爆的一处。
		const big = "x".repeat(200_000);
		const md = render([
			message("assistant", [{ type: "toolCall", id: "w1", name: "write", arguments: { file_path: "big.txt", content: big } }], { stopReason: "toolUse" }),
		]);
		expect(md).toContain(TRUNCATED_MARK);
		expect(md).toContain("**工具调用：write**");
		expect(md.length, `入参没截断：文档 ${md.length} 字符`).toBeLessThan(DETAIL_LIMIT * 3);
	});

	it("命令执行渲染成 bash 块，带输出与退出码", () => {
		const md = render([
			message("bashExecution", [], { command: "npm test", output: "3 passed", exitCode: 0 }),
			message("bashExecution", [], { command: "false", output: "", exitCode: 1 }),
		]);
		expect(md).toContain("$ npm test");
		expect(md).toContain("3 passed");
		expect(md).toContain("> （退出码 1）");
	});
});

describe("其它条目", () => {
	it("压缩摘要、分支摘要、模型切换、扩展消息、产物交付各自有形态", () => {
		const md = render([
			{ type: "compaction", id: "c", parentId: null, timestamp: "2026-10-03T10:00:00.000Z", summary: "前面聊了预算", tokensBefore: 12000 },
			{ type: "branch_summary", id: "b", parentId: null, timestamp: "2026-10-03T10:00:00.000Z", summary: "从另一条分支来的" },
			{ type: "model_change", id: "m", parentId: null, timestamp: "2026-10-03T10:00:00.000Z", provider: "storefront", modelId: "model-y" },
			{ type: "custom_message", id: "x", parentId: null, timestamp: "2026-10-03T10:00:00.000Z", customType: "memory", content: "用户偏好简短", display: true },
			{ type: "custom", id: "a", parentId: null, timestamp: "2026-10-03T10:00:00.000Z", customType: "artifacts_presented", data: { files: [{ path: "/ws/out/看板.html", size: 2048 }] } },
			// 不参与展示的条目：不该出现在文档里
			{ type: "session_info", id: "i", parentId: null, timestamp: "2026-10-03T10:00:00.000Z", name: "内部名字" },
			{ type: "usage", id: "u", parentId: null, timestamp: "2026-10-03T10:00:00.000Z", kind: "cache_warm" },
			{ type: "custom_message", id: "x2", parentId: null, timestamp: "2026-10-03T10:00:00.000Z", customType: "hidden", content: "不该出现", display: false },
		]);
		expect(md).toContain("上下文已压缩");
		expect(md).toContain("前面聊了预算");
		expect(md).toContain("分支摘要");
		expect(md).toContain("切换模型：storefront/model-y");
		expect(md).toContain("memory");
		expect(md).toContain("用户偏好简短");
		expect(md).toContain("交付的产物");
		expect(md).toContain("/ws/out/看板.html");
		expect(md).toContain("2048 字节");
		expect(md, "usage / session_info 不是正文").not.toContain("cache_warm");
		expect(md, "display:false 的扩展消息不该被导出").not.toContain("不该出现");
	});
});

describe("截断与围栏", () => {
	it("超长工具输出被截断，并标明原长度（与界面同一口径）", () => {
		const long = "字".repeat(DETAIL_LIMIT + 500);
		const md = render([
			message("assistant", [{ type: "toolCall", id: "c1", name: "read", arguments: {} }], { stopReason: "toolUse" }),
			message("toolResult", [{ type: "text", text: long }], { toolCallId: "c1" }),
		]);
		expect(md).toContain(TRUNCATED_MARK);
		expect(md).toContain(`原 ${long.length} 字符`);
		expect(md.length, "文档不该把十万字符原样搬进来").toBeLessThan(long.length);
	});

	it("clamp 只在超过上限时截断", () => {
		expect(clamp("短").truncated).toBe(false);
		expect(clamp("x".repeat(DETAIL_LIMIT)).truncated).toBe(false);
		expect(clamp("x".repeat(DETAIL_LIMIT + 1)).truncated).toBe(true);
	});

	it("内容里的反引号会把围栏撑长（导出文档不会被内容截断）", () => {
		expect(fenceFor("普通内容")).toBe("```");
		expect(fenceFor("这里有 ``` 三个")).toBe("````");
		expect(codeBlock("a ``` b", "text")).toMatch(/^````text\n/);
	});
});

describe("脏数据不崩", () => {
	it("entries 不是数组 / 条目是 null / 消息缺 content 都安全", () => {
		expect(renderSessionMarkdown({ title: "t", header, entries: undefined, now: NOW })).toContain("# t");
		expect(() => render([null, { type: "message" }, { type: "message", message: { role: "assistant" } }, 42])).not.toThrow();
		const md = render([null, { type: "message" }, 42]);
		expect(md).toContain("# 做一份销售看板");
	});

	it("空会话判定的判据＝渲染出来的正文是不是空的（与渲染同源，两个方向都对）", () => {
		// 只有 metadata：没有可导出内容
		expect(hasExportableContent([{ type: "session_info", name: "x" }])).toBe(false);
		expect(hasExportableContent([])).toBe(false);
		expect(hasExportableContent(undefined)).toBe(false);
		expect(hasExportableContent([message("user", "你好")])).toBe(true);

		// 这些条目**渲染器明明认得**，早先那版手写判据把它们误判成「空」（HTML 导得出、
		// Markdown 导不出）—— 现在判据与渲染同源，两个方向一起消掉。
		expect(hasExportableContent([{ type: "compaction", id: "c", parentId: null, timestamp: "", summary: "压缩过" }])).toBe(true);
		expect(hasExportableContent([{ type: "branch_summary", id: "b", parentId: null, timestamp: "", summary: "分支" }])).toBe(true);
		expect(
			hasExportableContent([
				{ type: "custom", id: "a", parentId: null, timestamp: "", customType: "artifacts_presented", data: { files: [{ path: "/x.html" }] } },
			]),
		).toBe(true);

		// 反向：`display:false` 的扩展消息**不会被渲染**，所以不能算「有内容」
		//（否则会写出一篇光有标题的空文档 —— 正是这个判据要防的东西）。
		expect(
			hasExportableContent([
				{ type: "custom_message", id: "x", parentId: null, timestamp: "", customType: "hidden", content: "看不见", display: false },
			]),
		).toBe(false);
	});
});

describe("集成：真实会话文件 → pi 的 SessionManager → 渲染（本机真跑）", () => {
	it("预置的 .jsonl 能被读成条目，并按预期渲染成 Markdown", async () => {
		const dir = tempDir();
		const sessionsDir = join(dir, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		const file = join(sessionsDir, "2026-10-03T10-00-00-000Z_int.jsonl");
		const lines = [
			JSON.stringify({ type: "session", version: 3, id: "int-1", timestamp: "2026-10-03T10:00:00.000Z", cwd: dir }),
			JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "2026-10-03T10:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "读一下这个文件" }], timestamp: Date.parse("2026-10-03T10:00:01.000Z") } }),
			JSON.stringify({ type: "message", id: "a1", parentId: "u1", timestamp: "2026-10-03T10:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "好，我看看。" }, { type: "toolCall", id: "tc-1", name: "read_file", arguments: { path: "a.txt" } }], stopReason: "toolUse", timestamp: Date.parse("2026-10-03T10:00:02.000Z") } }),
			// 分叉出去的另一支（父节点仍是 u1）：它**写在当前分支之前**，所以不会被当成叶子。
			// 这条顺序是刻意排的 —— pi 打开会话文件时把「最后一条条目」认作当前叶子
			// （session-manager 的 _buildIndex），写成最后一行就等于把它当成当前分支了。
			JSON.stringify({ type: "message", id: "a2-other", parentId: "u1", timestamp: "2026-10-03T10:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "这条在另一个分支上" }], stopReason: "stop", timestamp: Date.parse("2026-10-03T10:00:03.000Z") } }),
			JSON.stringify({ type: "message", id: "r1", parentId: "a1", timestamp: "2026-10-03T10:00:04.000Z", message: { role: "toolResult", toolCallId: "tc-1", toolName: "read_file", content: [{ type: "text", text: "文件内容在这里" }], isError: false, timestamp: Date.parse("2026-10-03T10:00:04.000Z") } }),
		];
		writeFileSync(file, `${lines.join("\n")}\n`);

		const manager = SessionManager.open(file, sessionsDir);
		const entries = manager.getBranch();
		expect(entries.length, "getBranch 应拿到当前分支上的条目").toBeGreaterThan(0);

		const md = renderSessionMarkdown({ title: "集成用例", header: manager.getHeader(), entries, now: NOW });
		expect(md).toContain("## 你");
		expect(md).toContain("读一下这个文件");
		expect(md).toContain("**工具调用：read_file**");
		expect(md).toContain("文件内容在这里");
		expect(md).toContain("- 工作空间：`" + dir + "`");
		expect(md).toContain("工具调用 1 次");
		// 同一份会话文件里另有一条不在当前分支上的消息：导出必须只认当前分支。
		expect(md, "不在当前分支上的条目不该进导出").not.toContain("这条在另一个分支上");
	});
});
