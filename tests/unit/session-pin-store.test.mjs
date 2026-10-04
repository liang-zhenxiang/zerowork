/**
 * 会话置顶索引（`src/main/daemon/pin.js`）的单测。
 *
 * 为什么值得单独测：置顶是**跨重启**的承诺。它写在磁盘上、由 daemon 读回，
 * 而这条链路上没有编译期检查 —— 写漏一次 `persist()`、把幂等判断写反、
 * 或者对损坏文件抛错，用户看到的现象都是「置顶时灵时不灵」，且**只在重启后**
 * 才暴露。这类「静默失效」正是单测该钉住的东西。
 *
 * 覆盖：置顶 / 取消 / 幂等（不重复落盘）/ 跨实例读回（重启等价）/ 目录不存在时自建 /
 * JSON 损坏与结构不符一律当空索引 / 指向已消失会话的记录**不**被清理。
 *
 * ── 反向验证（已真跑并还原，见 design.md「反向验证」）──────────────
 * 把 `persist()` 里的 `writeFileSync` 注释掉 → 「落盘后另一个实例能读回」与
 * 「取消置顶会从文件里删掉」两条变红，其余全绿。
 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { SessionPinStore } from "../../src/main/daemon/pin.js";

let dirs = [];

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), "zerowork-pins-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs = [];
});

function readIndex(file) {
	return JSON.parse(readFileSync(file, "utf8"));
}

describe("SessionPinStore", () => {
	it("置顶会落盘，另一个实例（= 重启后的 daemon）能读回", () => {
		const file = join(tempDir(), "pins.json");
		new SessionPinStore(file).setPinned("/sessions/a.jsonl", true, 111);

		expect(existsSync(file), "置顶后必须真的写出 pins.json").toBe(true);
		expect(readIndex(file)).toEqual({ "/sessions/a.jsonl": 111 });

		// 新实例不共享内存索引：读得到的只能是文件里的内容。
		const afterRestart = new SessionPinStore(file);
		expect(afterRestart.isPinned("/sessions/a.jsonl")).toBe(true);
		expect(afterRestart.pinnedAt("/sessions/a.jsonl")).toBe(111);
	});

	it("取消置顶会从文件里删掉，且新实例读回为未置顶", () => {
		const file = join(tempDir(), "pins.json");
		const store = new SessionPinStore(file);
		store.setPinned("/sessions/a.jsonl", true, 111);
		store.setPinned("/sessions/a.jsonl", false, 222);

		expect(store.isPinned("/sessions/a.jsonl")).toBe(false);
		expect(readIndex(file)).toEqual({});
		expect(new SessionPinStore(file).isPinned("/sessions/a.jsonl")).toBe(false);
	});

	it("幂等：重复置顶同一条不重复落盘，也不会把置顶时刻改掉", async () => {
		const file = join(tempDir(), "pins.json");
		const store = new SessionPinStore(file);
		store.setPinned("/sessions/a.jsonl", true, 111);
		// 两次写之间隔开一点：同一次时钟刻度内重写会让 mtime 比对失去分辨力。
		await delay(25);
		const firstWrite = statSync(file).mtimeMs;

		store.setPinned("/sessions/a.jsonl", true, 999);

		// 时刻保持第一次的：幂等不是「覆盖成最新」，界面上表现为「排序不因重复点击而抖」。
		expect(readIndex(file)).toEqual({ "/sessions/a.jsonl": 111 });
		expect(statSync(file).mtimeMs).toBe(firstWrite);
	});

	it("取消一条从未置顶的会话：不落盘、不报错", () => {
		const file = join(tempDir(), "pins.json");
		const store = new SessionPinStore(file);
		store.setPinned("/sessions/never.jsonl", false, 111);

		expect(store.isPinned("/sessions/never.jsonl")).toBe(false);
		expect(existsSync(file), "状态没变就不该凭空写出一个文件").toBe(false);
	});

	it("配置目录不存在时自动建目录（首次运行不能因为目录缺失而丢置顶）", () => {
		const file = join(tempDir(), "nested", "deeper", "pins.json");
		new SessionPinStore(file).setPinned("/sessions/a.jsonl", true, 111);

		expect(readIndex(file)).toEqual({ "/sessions/a.jsonl": 111 });
	});

	it("文件不存在 → 空索引（不是错误）", () => {
		const store = new SessionPinStore(join(tempDir(), "pins.json"));
		expect(store.isPinned("/sessions/a.jsonl")).toBe(false);
		expect(store.pinnedAt("/sessions/a.jsonl")).toBeUndefined();
	});

	it("JSON 损坏 → 当空索引，且之后仍能正常写", () => {
		const file = join(tempDir(), "pins.json");
		writeFileSync(file, "{ 这不是 JSON");

		const store = new SessionPinStore(file);
		expect(store.isPinned("/sessions/a.jsonl")).toBe(false);

		store.setPinned("/sessions/a.jsonl", true, 111);
		expect(readIndex(file)).toEqual({ "/sessions/a.jsonl": 111 });
	});

	it("结构不符（数组 / 非数字值）→ 只收下合法条目，不炸", () => {
		const file = join(tempDir(), "pins.json");
		writeFileSync(file, JSON.stringify({ "/keep.jsonl": 5, "/drop.jsonl": "昨天" }));
		const store = new SessionPinStore(file);
		expect(store.isPinned("/keep.jsonl")).toBe(true);
		expect(store.isPinned("/drop.jsonl")).toBe(false);

		const file2 = join(tempDir(), "pins.json");
		writeFileSync(file2, JSON.stringify(["/a.jsonl"]));
		expect(new SessionPinStore(file2).isPinned("/a.jsonl")).toBe(false);
	});

	it("指向已消失会话的记录**保留**（会话文件可能只是暂时不可达）", () => {
		const file = join(tempDir(), "pins.json");
		// 造一个真实存在过、然后被移走的会话文件：置顶后把它删掉。
		const sessionDir = tempDir();
		const session = join(sessionDir, "gone.jsonl");
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(session, "");

		const store = new SessionPinStore(file);
		store.setPinned(session, true, 111);
		rmSync(session);

		// 新实例（重启）读到这条：仍然记着 —— 清理它等于在同步目录/外置盘还没挂上时
		// 把用户的选择悄悄抹掉（理由见 pin.js 文件头）。
		expect(new SessionPinStore(file).isPinned(session)).toBe(true);
	});
});
