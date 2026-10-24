import { describe, expect, it } from "vitest";
import { DEFAULT_REMOTE_TTL_MS, DEFAULT_TTL_MS, WIP_LABEL, decide, isLockStale, isPidAlive, isRemoteStale } from "../../scripts/next-feature-guard.mjs";

/**
 * 这道闸的判断一旦写反，症状不是报错，而是**两个 agent 同时改同一个仓库**。
 * 所以把判断抽成纯函数，把「该拦 / 该放 / 该清僵尸」三种情形钉死在这里。
 */

const HOST = "machine-a";
const NOW = Date.parse("2026-10-24T02:00:00Z");
const freshLock = { pid: 4242, host: HOST, startedAt: NOW - 60_000, heartbeatAt: NOW - 60_000 };
const alive = () => true;
const dead = () => false;

describe("isLockStale", () => {
	it("心跳新 → 不算过期（必须拦住第二个实例）", () => {
		expect(isLockStale(freshLock, { now: NOW, host: HOST })).toBe(false);
	});

	it("心跳超过 TTL → 过期（昨天那次已经跑挂了）", () => {
		const old = { ...freshLock, heartbeatAt: NOW - DEFAULT_TTL_MS - 1 };
		expect(isLockStale(old, { now: NOW, host: HOST })).toBe(true);
	});

	it("pid 已死但心跳还新 → **不算**过期（第一版就是在这里写错的）", () => {
		// 回归：acquire 记录的是它自己的 pid，那个进程判断完就退出；
		// 若拿 pid 判活当依据，锁会立刻被判过期，闸等于不存在。
		expect(isLockStale({ ...freshLock, pid: 2 ** 30 }, { now: NOW, host: HOST })).toBe(false);
	});

	it("锁是另一台机器留下的 → 过期（本机 pid 判活对别的机器没有意义）", () => {
		expect(isLockStale(freshLock, { now: NOW, host: "machine-b" })).toBe(true);
	});

	it("缺字段/坏数据一律按过期处理（宁可多起一次，也不要永远卡住）", () => {
		expect(isLockStale(null, { now: NOW, host: HOST })).toBe(true);
		expect(isLockStale({}, { now: NOW, host: HOST })).toBe(true);
		expect(isLockStale({ ...freshLock, heartbeatAt: "不是时间" }, { now: NOW, host: HOST })).toBe(true);
	});
});

describe("isRemoteStale", () => {
	const issue = { number: 7, title: "x", updatedAt: new Date(NOW - 3600_000).toISOString() };

	it("刚更新过的 WIP issue → 不过期（换机器跑也认得出）", () => {
		expect(isRemoteStale(issue, { now: NOW })).toBe(false);
	});

	it("超过远端 TTL 没动静 → 过期", () => {
		expect(isRemoteStale({ ...issue, updatedAt: new Date(NOW - DEFAULT_REMOTE_TTL_MS - 1).toISOString() }, { now: NOW })).toBe(true);
	});

	it("更新时间读不出来 → 过期", () => {
		expect(isRemoteStale({ number: 7 }, { now: NOW })).toBe(true);
	});
});

describe("decide", () => {
	it("本机在跑 → skip，且不清任何东西（清掉锁等于放第二个实例进来）", () => {
		const r = decide({ localLock: freshLock, remoteIssue: null, now: NOW, host: HOST });
		expect(r.verdict).toBe("skip");
		expect(r.cleanup).toEqual({ local: false, remote: false });
		expect(r.reason).toContain("本机");
	});

	it("只有远端在跑 → skip，并指出是哪个 issue", () => {
		const issue = { number: 42, title: "夜间开发", updatedAt: new Date(NOW - 60_000).toISOString() };
		const r = decide({ localLock: null, remoteIssue: issue, now: NOW, host: HOST });
		expect(r.verdict).toBe("skip");
		expect(r.reason).toContain("#42");
	});

	it("两边都过期 → go，且要求两边都清", () => {
		const staleLock = { ...freshLock, heartbeatAt: NOW - DEFAULT_TTL_MS - 1 };
		const staleIssue = { number: 9, title: "旧的", updatedAt: new Date(NOW - DEFAULT_REMOTE_TTL_MS - 1).toISOString() };
		const r = decide({ localLock: staleLock, remoteIssue: staleIssue, now: NOW, host: HOST });
		expect(r.verdict).toBe("go");
		expect(r.cleanup).toEqual({ local: true, remote: true });
	});

	it("干净启动 → go，什么都不用清", () => {
		const r = decide({ localLock: null, remoteIssue: null, now: NOW, host: HOST });
		expect(r.verdict).toBe("go");
		expect(r.cleanup).toEqual({ local: false, remote: false });
	});
});

describe("杂项", () => {
	it("isPidAlive 对本进程为真、对不存在的 pid 为假", () => {
		expect(isPidAlive(process.pid)).toBe(true);
		expect(isPidAlive(2 ** 30)).toBe(false);
	});

	it("WIP 标签名稳定（定时任务的 prompt 与 issue 上的标签必须是同一个字符串）", () => {
		expect(WIP_LABEL).toBe("agent-wip");
	});
});
