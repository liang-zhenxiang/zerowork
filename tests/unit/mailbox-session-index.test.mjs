/**
 * mailbox 会话索引的**负缓存**回归测试。
 *
 * `memberSessionPath()` 先用 `${sessionId}.jsonl` 试一条快路，走不到就去查
 * 「会话目录里所有 `.jsonl` 的 id → 路径」索引，而这个索引有 1 秒 TTL。
 * 问题出在**未命中**上：索引可能是在「成员会话文件还不存在」的时刻建出来的，
 * 而旧实现在未命中时**不重建** —— 那个「没有这个 id」的空结论会活满整个 TTL，
 * 期间任何读取都解析不到刚刚落盘的文件。
 *
 * 症状与产品自己的注释直接矛盾：`readMemberOutput` 附近写着
 * 「产出写进成员会话的那一刻就算交付，没有『投递』这个可能失败的环节」——
 * 这个负缓存就是那个会失败的环节。它**不偶发**：落在窗口内必然失败。
 *
 * 所以这一条的验收方式是：**文件落盘后立刻读，不 sleep、不等 TTL**。
 * 一旦有人把负缓存写回来（或者用「调小 TTL」这类只把窗口变窄的做法糊过去），
 * 这里就会红 —— 因为断言与「索引何时建」之间没有任何时间余量。
 *
 * 每个用例一个全新的配置目录：`index.dir !== dir` 必定触发重建，
 * 于是第一条查询**一定**发生在「文件还不存在」的那一刻，现场可复现、不看运气。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getSessionsDir } from "../../src/main/daemon/config-paths.js";
import {
	memberSessionPath,
	readMemberTranscriptView,
} from "../../src/main/daemon/mailbox.js";

/** 真实落盘的成员会话文件名带时间戳前缀 —— 快路 `${sessionId}.jsonl` 因此走不到。 */
const stamped = (sessionsDir, sessionId) => join(sessionsDir, `20260101T000000_${sessionId}.jsonl`);

let configDir;
let previousConfigDir;

beforeEach(() => {
	previousConfigDir = process.env["ZEROWORK_CONFIG_DIR"];
	configDir = mkdtempSync(join(tmpdir(), "zerowork-mailbox-index-"));
	process.env["ZEROWORK_CONFIG_DIR"] = configDir;
	mkdirSync(getSessionsDir(), { recursive: true });
});

afterEach(() => {
	if (previousConfigDir === undefined) delete process.env["ZEROWORK_CONFIG_DIR"];
	else process.env["ZEROWORK_CONFIG_DIR"] = previousConfigDir;
	rmSync(configDir, { recursive: true, force: true });
});

describe("memberSessionPath 的负缓存", () => {
	it("索引建在文件出现之前时，文件一落盘就立刻能解析到", () => {
		const sessionsDir = getSessionsDir();
		const sessionId = "member-early-read";

		// ① 文件还不存在就先查一次 —— 索引正好在这一刻建出来，
		//    结论是「没有这个 id」。这就是负缓存产生的现场。
		expect(memberSessionPath(sessionId)).toBeUndefined();

		// ② 文件落盘。
		const file = stamped(sessionsDir, sessionId);
		writeFileSync(file, '{"type":"message","message":{"role":"assistant","content":"hello"}}\n');

		// ③ 立刻再查。**不 sleep、不等 TTL** —— 落盘即交付。
		//    旧实现会让 ① 建出的空索引活满 1 秒，这里拿到 undefined。
		expect(memberSessionPath(sessionId)).toBe(file);
	});

	it("为未命中重建索引时，已有条目不受影响（重建不是清空）", () => {
		const sessionsDir = getSessionsDir();
		const existing = stamped(sessionsDir, "member-keep");
		writeFileSync(existing, "{}\n");
		expect(memberSessionPath("member-keep")).toBe(existing);

		// 索引已建好且不含 member-late —— 又落在负缓存的窗口里。
		const later = stamped(sessionsDir, "member-late");
		writeFileSync(later, "{}\n");
		expect(memberSessionPath("member-late")).toBe(later);

		// 触发重建之后，原来那条还得在。
		expect(memberSessionPath("member-keep")).toBe(existing);
	});

	it("确实不存在的会话仍然返回 undefined（未命中重建后依旧是空的，不硬造路径）", () => {
		expect(memberSessionPath("nobody-at-all")).toBeUndefined();
		expect(memberSessionPath("nobody-at-all")).toBeUndefined();
	});
});

describe("readMemberTranscriptView 的负缓存", () => {
	it("产出落盘后立刻读得到 —— <team_output> 自动投递走的就是这条路径", () => {
		const sessionsDir = getSessionsDir();
		const sessionId = "member-output";

		// 建索引的时机同样早于文件（此时什么都读不到）。
		expect(readMemberTranscriptView(sessionId).output).toBeUndefined();

		const file = stamped(sessionsDir, sessionId);
		writeFileSync(
			file,
			`${JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "完成：42" }],
					stopReason: "endTurn",
				},
			})}\n`,
		);

		// 立刻读：不 sleep、不等 TTL。
		const view = readMemberTranscriptView(sessionId);
		expect(view.output).toBe("完成：42");
		expect(view.status).toBe("completed");
	});
});
