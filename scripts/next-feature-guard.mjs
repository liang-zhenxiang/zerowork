#!/usr/bin/env node
/**
 * 夜间自动开发的**互斥闸**。
 *
 * 定时任务是「每天」触发的，但一次 next-feature 流程可能跑几小时甚至跨夜。
 * 如果昨天那次还在跑，今天 02:00 再起一个，两个 agent 会同时改同一个仓库 ——
 * 那不是「多干一点活」，而是互相覆盖工作区、抢分支、重复开 PR。所以必须有闸。
 *
 * 闸有两道，缺一不可：
 *
 *   ① **本地锁**（`.trellis/.runtime/next-feature.lock/`）：同一台机器上的快路径。
 *      进程还活着、心跳还新 → 直接跳过，一个网络请求都不用发。
 *   ② **GitHub 上的 WIP 标记**：任何开着、且带 `agent-wip` 标签的 issue 都算「有人在
 *      干活」。它解决本地锁解决不了的两件事 —— 换了一台机器跑、或者上一次是本机
 *      但进程已经死了（锁成了僵尸）。同时它还是**给人看的信号**：在 issue 列表里
 *      一眼就能看到「现在 agent 正在做这个」。
 *
 * 僵尸处理：锁里的 pid 已经不在，或心跳超过 TTL，就算过期，自动让路；
 * GitHub 那条用 issue 的 `updatedAt` 判过期（超时就评论说明并关掉，再继续）。
 *
 * 用法（定时任务的 prompt 里照抄）：
 *   node scripts/next-feature-guard.mjs acquire      # 打印 GO 或 SKIP …；SKIP 时退出码 3
 *   node scripts/next-feature-guard.mjs mark --issue 123
 *   node scripts/next-feature-guard.mjs heartbeat    # 流程中途可反复调用
 *   node scripts/next-feature-guard.mjs release
 *   node scripts/next-feature-guard.mjs status       # 只读：给人看当前状态
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";

export const WIP_LABEL = "agent-wip";
const LOCK_DIR = resolve(process.cwd(), ".trellis/.runtime/next-feature.lock");
const OWNER_FILE = resolve(LOCK_DIR, "owner.json");
/** 心跳超过它就认为上一次运行已经死掉。一次完整流程通常 1–3 小时，12h 足够宽。 */
export const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
/** GitHub 那条的 TTL 更长：issue 的 updatedAt 只在我动它时才变，给足余量。 */
export const DEFAULT_REMOTE_TTL_MS = 20 * 60 * 60 * 1000;

/**
 * 本地锁是否还该拦人。两个条件任一成立即视为过期：
 * 心跳超过 TTL / 记录的机器名不是本机（换机器了，本地锁没有意义）。
 *
 * **pid 不参与判定** —— 这是第一版写错的地方：`acquire` 记录的是它自己的 pid，
 * 而那个进程做完判断就退出了，于是下一次检查立刻读到「pid 已死 → 锁过期」，
 * 闸等于不存在。真正的活性信号是 `heartbeatAt`（流程中途由 `heartbeat` 刷新）。
 *
 * TTL 取 12h 是有意的：定时任务每天 02:00 跑一次，所以「昨天那次崩了」最迟
 * 到明天早上就自然过期，不会把下一次永久挡住；而在同一天内它一定拦得住。
 */
export function isLockStale(owner, { now, ttlMs = DEFAULT_TTL_MS, host = hostname() } = {}) {
	if (owner === null || typeof owner !== "object") return true;
	if (typeof owner.host === "string" && owner.host !== host) return true;
	const beat = Number(owner.heartbeatAt ?? owner.startedAt ?? 0);
	if (!Number.isFinite(beat) || beat <= 0) return true;
	return now - beat > ttlMs;
}

/** GitHub 上的 WIP issue 是否过期（只按它最后一次被改动的时间算）。 */
export function isRemoteStale(issue, { now, ttlMs = DEFAULT_REMOTE_TTL_MS } = {}) {
	const at = Date.parse(String(issue?.updatedAt ?? issue?.createdAt ?? ""));
	if (!Number.isFinite(at)) return true;
	return now - at > ttlMs;
}

/** 进程是否还在（`kill(pid, 0)` 只探活，不发信号）。 */
export function isPidAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM"; // 存在但不属于我 —— 仍然算活着
	}
}

/**
 * 闸的裁决。纯函数，单测锁的就是它 —— 真跑一次 gh 的成本太高，而这里的判断
 * 一旦写反，症状是「两个 agent 同时改仓库」，不会当场报错。
 *
 * @returns {{verdict: "go"|"skip", reason: string, cleanup: {local: boolean, remote: boolean}}}
 */
export function decide({ localLock, remoteIssue, now, ttlMs = DEFAULT_TTL_MS, remoteTtlMs = DEFAULT_REMOTE_TTL_MS, host = hostname() } = {}) {
	const localStale = localLock == null ? true : isLockStale(localLock, { now, ttlMs, host });
	const remoteStale = remoteIssue == null ? true : isRemoteStale(remoteIssue, { now, ttlMs: remoteTtlMs });
	const cleanup = { local: localStale === false ? false : localLock != null, remote: remoteStale === false ? false : remoteIssue != null };

	if (localLock != null && !localStale) {
		return { verdict: "skip", reason: `本机上一次运行还在跑（pid ${localLock.pid ?? "?"}，心跳 ${new Date(Number(localLock.heartbeatAt ?? 0)).toISOString()}）`, cleanup: { local: false, remote: false } };
	}
	if (remoteIssue != null && !remoteStale) {
		return { verdict: "skip", reason: `GitHub 上还有在做的任务 #${remoteIssue.number}「${remoteIssue.title ?? ""}」（最后更新 ${remoteIssue.updatedAt ?? "?"}）`, cleanup: { local: false, remote: false } };
	}
	const reasons = [];
	if (cleanup.local) reasons.push("清掉过期的本地锁");
	if (cleanup.remote) reasons.push(`关掉过期的 WIP issue #${remoteIssue.number}`);
	return { verdict: "go", reason: reasons.length > 0 ? reasons.join("；") : "没有其他运行中的任务", cleanup };
}

/** 同步小睡：脚本是 CLI，用 async 会把调用点全变成 await，不值得。 */
function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function gh(args) {
	const out = spawnSync("gh", args, { encoding: "utf8" });
	return { code: out.status ?? 1, stdout: (out.stdout ?? "").trim(), stderr: (out.stderr ?? "").trim() };
}

function readOwner() {
	if (!existsSync(OWNER_FILE)) return null;
	try {
		return JSON.parse(readFileSync(OWNER_FILE, "utf8"));
	} catch {
		return null;
	}
}

function writeOwner(owner) {
	mkdirSync(LOCK_DIR, { recursive: true });
	writeFileSync(OWNER_FILE, `${JSON.stringify(owner, null, 2)}\n`, "utf8");
}

function findRemoteWip() {
	// 网络抖动是常态（这条链路要过代理）：重试三次再下结论。
	let r = { code: 1, stdout: "", stderr: "" };
	for (let attempt = 0; attempt < 3; attempt += 1) {
		r = gh(["issue", "list", "--label", WIP_LABEL, "--state", "open", "--json", "number,title,updatedAt", "--limit", "5"]);
		if (r.code === 0) break;
		sleepSync(2000);
	}
	if (r.code !== 0) {
		throw new Error(`查询 GitHub WIP 失败：${r.stderr || `gh 退出码 ${r.code}`}`);
	}
	const list = JSON.parse(r.stdout === "" ? "[]" : r.stdout);
	return Array.isArray(list) && list.length > 0 ? list[0] : null;
}

function cmdAcquire(ttlHours) {
	const now = Date.now();
	const ttlMs = ttlHours > 0 ? ttlHours * 3600_000 : DEFAULT_TTL_MS;
	let remote = null;
	let remoteError = null;
	try {
		remote = findRemoteWip();
	} catch (error) {
		remoteError = error.message;
	}
	const { verdict, reason, cleanup } = decide({ localLock: readOwner(), remoteIssue: remote, now, ttlMs });

	if (verdict === "skip") {
		console.log(`SKIP ${reason}`);
		return 3;
	}
	// 过期的东西必须先清掉，否则下一次还会读到它。
	if (cleanup.local) renameSync(LOCK_DIR, `${LOCK_DIR}.stale-${now}`);
	if (cleanup.remote && remote !== null) {
		gh(["issue", "comment", String(remote.number), "--body", `上一次运行超过 ${Math.round(DEFAULT_REMOTE_TTL_MS / 3600_000)} 小时没有动静，判定为中断；本次夜间任务继续，这个标记已释放。`]);
		gh(["issue", "edit", String(remote.number), "--remove-label", WIP_LABEL]);
		gh(["issue", "close", String(remote.number), "--reason", "not planned"]);
	}
	writeOwner({ pid: process.pid, host: hostname(), startedAt: now, heartbeatAt: now, issue: null });
	console.log(`GO ${reason}`);
	if (remoteError !== null) console.log(`注：${remoteError}（仅按本地锁判断）`);
	return 0;
}

function cmdMark(issue) {
	const owner = readOwner();
	if (owner === null) {
		console.error("没有本地锁 —— 先跑 acquire");
		return 2;
	}
	if (issue !== undefined) {
		const r = gh(["issue", "edit", String(issue), "--add-label", WIP_LABEL]);
		if (r.code !== 0) {
			console.error(`打标签失败：${r.stderr || r.code}`);
			return 2;
		}
		owner.issue = Number(issue);
	}
	owner.heartbeatAt = Date.now();
	writeOwner(owner);
	console.log(`marked${owner.issue === null ? "" : ` #${owner.issue}`}`);
	return 0;
}

function cmdHeartbeat() {
	const owner = readOwner();
	if (owner === null) return 2;
	owner.heartbeatAt = Date.now();
	writeOwner(owner);
	console.log("heartbeat");
	return 0;
}

function cmdRelease() {
	const owner = readOwner();
	if (owner?.issue !== undefined && owner?.issue !== null) {
		gh(["issue", "edit", String(owner.issue), "--remove-label", WIP_LABEL]);
	}
	if (existsSync(LOCK_DIR)) rmSync(LOCK_DIR, { recursive: true, force: true });
	console.log("released");
	return 0;
}

function cmdStatus() {
	const owner = readOwner();
	const remote = (() => {
		try {
			return findRemoteWip();
		} catch {
			return null;
		}
	})();
	console.log(
		JSON.stringify(
			{
				local: owner,
				localStale: owner === null ? null : isLockStale(owner, { now: Date.now() }),
				remote,
				remoteStale: remote === null ? null : isRemoteStale(remote, { now: Date.now() })
			},
			null,
			2
		)
	);
	return 0;
}

const [, , command, ...rest] = process.argv;
if (import.meta.url === `file://${process.argv[1]}`) {
	const issueAt = rest.indexOf("--issue");
	const ttlAt = rest.indexOf("--ttl-hours");
	const issue = issueAt >= 0 ? rest[issueAt + 1] : undefined;
	const ttlHours = ttlAt >= 0 ? Number(rest[ttlAt + 1]) : 0;
	const table = { acquire: () => cmdAcquire(ttlHours), mark: () => cmdMark(issue), heartbeat: cmdHeartbeat, release: cmdRelease, status: cmdStatus };
	const run = table[command];
	if (run === undefined) {
		console.error("用法：next-feature-guard.mjs <acquire|mark --issue N|heartbeat|release|status>");
		process.exit(2);
	}
	process.exit(run());
}
