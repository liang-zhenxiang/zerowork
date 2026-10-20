/**
 * `tools/check-daemon-graph.mjs` 自身的回归测试。
 *
 * 为什么要测一个「检查工具」：它是 `src/main/daemon/**` 唯一的模块边界守卫 ——
 * 那个目录在 ESLint 配置里是**整目录排除**的（eslint.config.mjs 的 ignores），
 * 所以 `no-undef` / `no-unused-vars` 从来不检查它。工具一旦自己悄悄失效
 * （遍历写坏、误报多到没人看、或者被谁把 exit code 改掉），
 * 下次再漏一个 import 就又只剩「无人值守的定时任务跑到一半抛 ReferenceError」。
 *
 * 这条检查的**由来是一次真实缺陷**：给 `session-files.js` 加值守边界时，
 * `onExceedAction` 与 `parseWatchPolicy` 被调用却忘了写进 import。
 * 单元测试全绿（它们不 import daemon 模块）、构建成功（ESM 的具名绑定
 * 在真正求值前不报错）、ESLint 不看这个目录 —— 三个关口同时漏过。
 * 下面的用例把那次缺陷原样钉住。
 *
 * 测试方式是**跑真进程**（`node tools/check-daemon-graph.mjs`），
 * 与 CI 完全同一条路径：断言它的退出码，而不是断言它的内部函数。
 *
 * 反向验证**不能拿仓库里的源码开刀**：vitest 默认并行跑测试文件，而至少 8 个
 * 单测会读 `src/main/daemon/session-files.js`。改写期间别的文件恰好读到一份
 * 少了两行 import 的源码，就会在一个与被测对象无关的用例上报错 —— 症状指向
 * 错误的位置，而且只在并行时序撞上时出现。所以下面把模块图复制到临时目录再动手，
 * 真实源码全程只读，用例结尾用 sha256 把这条性质钉住。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "tools", "check-daemon-graph.mjs");
const DAEMON_DIR = join(ROOT, "src", "main", "daemon");
const SANDBOX_DIR = join(ROOT, "src", "main", "sandbox");
const SHARED_DIR = join(ROOT, "src", "shared");
const SESSION_FILES = join(DAEMON_DIR, "session-files.js");

/**
 * 跑检查脚本，返回 `{ ok, stdout, stderr }` —— 不抛异常，让断言自己说结果。
 * 传 `target` 时经 `ZW_DAEMON_DIR` 让脚本扫描它（临时副本靠这条既有入口）；
 * 不传则扫描仓库里真实的 daemon 目录。
 */
function runCheckOn(target) {
	const env =
		target === undefined ? process.env : { ...process.env, ZW_DAEMON_DIR: target };
	try {
		const stdout = execFileSync(process.execPath, [SCRIPT], {
			cwd: ROOT,
			encoding: "utf8",
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { ok: true, stdout, stderr: "" };
	} catch (error) {
		return {
			ok: false,
			stdout: error.stdout ?? "",
			stderr: error.stderr ?? "",
			// 子进程**根本没起来**时 stdout/stderr 都是空的（例如并发过高时
			// 的 EAGAIN）—— 那样只看 `ok: false` 会把环境问题误判成模块图问题。
			reason: error.code === undefined ? "" : `${error.code}: ${error.message}`,
		};
	}
}

const runCheck = () => runCheckOn(undefined);

/** 文件的 sha256 —— 用来把「真实源码全程只读」从口头约定变成可执行断言。 */
function sha256(file) {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * 把 daemon 的模块图复制到临时根目录，保持同样的相对布局。
 *
 * 检查脚本会跟随 `../../shared/ipc.js` 与 `../sandbox/index.js` 走出 daemon 目录，
 * 少复制任何一层都会产生「模块不存在」的假报错 —— 那样反向验证就失去意义了。
 */
function copyModuleGraph(tmpRoot) {
	const daemonCopy = join(tmpRoot, "src", "main", "daemon");
	cpSync(DAEMON_DIR, daemonCopy, { recursive: true });
	cpSync(SANDBOX_DIR, join(tmpRoot, "src", "main", "sandbox"), { recursive: true });
	cpSync(SHARED_DIR, join(tmpRoot, "src", "shared"), { recursive: true });
	return daemonCopy;
}

describe("check-daemon-graph —— 模块边界守卫本身", () => {
	it("在当前仓库状态下通过，且两条性质都真的跑过（不是提前 return）", () => {
		const { ok, stdout, stderr, reason } = runCheck();
		expect(ok, `检查脚本没跑通：${reason || stderr}`).toBe(true);
		// 两行成功输出缺一不可：只看「有没有报错」无法区分
		//「检查通过」与「检查被短路/删掉了」。
		expect(stdout).toContain("模块图闭合");
		expect(stdout).toContain("无自由变量");
		// 确认它真的遍历到了模块，而不是一个都没读。
		const matched = /daemon 模块：(\d+) 个/.exec(stdout);
		expect(matched).not.toBeNull();
		expect(Number(matched[1])).toBeGreaterThan(40);
	});
});

describe("check-daemon-graph —— 自由变量（反向验证的自动化版）", () => {
	let tmpRoot = null;

	afterEach(() => {
		if (tmpRoot !== null) {
			rmSync(tmpRoot, { recursive: true, force: true });
			tmpRoot = null;
		}
	});

	it("复现那次真实缺陷：删掉 onExceedAction / parseWatchPolicy 的 import 必须被抓住", () => {
		// 先钉住真实源码 —— 这条用例的所有改写都只发生在临时副本上。
		const sourceBefore = sha256(SESSION_FILES);

		tmpRoot = mkdtempSync(join(tmpdir(), "zw-graph-copy-"));
		const daemonCopy = copyModuleGraph(tmpRoot);
		const sessionFilesCopy = join(daemonCopy, "session-files.js");
		// 副本本身没缺文件才能让「红」归因到那两行 import，否则红得没有意义。
		const pristine = runCheckOn(daemonCopy);
		expect(
			pristine.ok,
			`未改动的副本应当通过 —— 否则说明副本的相对布局缺了文件或脚本没起来：${
				pristine.reason || pristine.stderr
			}`,
		).toBe(true);

		const before = readFileSync(sessionFilesCopy, "utf8");
		// 精确地只摘掉这两个名字，其余不动 —— 与当初漏写 import 的形态一致。
		const after = before.replace(/^\t(onExceedAction|parseWatchPolicy),\n/gm, "");
		expect(after).not.toBe(before); // 若源码形态变了，这条用例要跟着改，而不是静默失效
		writeFileSync(sessionFilesCopy, after);

		const { ok, stderr } = runCheckOn(daemonCopy);
		expect(ok).toBe(false);
		expect(stderr).toContain("onExceedAction");
		expect(stderr).toContain("parseWatchPolicy");
		// 只报这两个：误报会让守卫失去可信度，比漏报更快被关掉。
		expect(stderr).not.toContain("command-exec.js");
		expect(stderr).not.toContain("config-paths.js");

		// 还原副本后必须重新变绿 —— 否则「检出问题」可能只是脚本坏了。
		writeFileSync(sessionFilesCopy, before);
		const restored = runCheckOn(daemonCopy);
		expect(restored.ok, `副本还原后应当重新通过：${restored.reason || restored.stderr}`).toBe(
			true,
		);

		// 全程只读真实源码：运行前后字节完全一致。
		expect(sha256(SESSION_FILES)).toBe(sourceBefore);
		// 这条要复制整张模块图，再起**三次**真实子进程（每次都要解析 50 个模块）。
		// 单文件跑约 1s，但全量时 40 个 worker 并发会让它超过默认的 5s ——
		// 超时是假红，不是缺陷；按最坏合法耗时放宽，并保留足够余量。
	}, 60_000);

	it("不误报 import.meta 与 URI 内建全局", () => {
		// 这两类曾经各造成一批误报：`import.meta` 被拆成标识符 `import` + `meta`，
		// 而 encodeURIComponent 之类没进内建名单。它们现在都必须沉默。
		const { ok, stderr, reason } = runCheck();
		expect(ok, `检查脚本没跑通：${reason || stderr}`).toBe(true);
		expect(stderr).not.toContain("import");
		expect(stderr).not.toContain("encodeURIComponent");
		expect(stderr).not.toContain("DOMException");
	});
});

describe("check-daemon-graph —— 既有两条性质（模块不存在 / 导出对不上）", () => {
	/**
	 * 这两条性质原本没有回归测试。用 `ZW_DAEMON_DIR` 把扫描目标指向临时目录，
	 * 就能在最小输入上驱动真脚本 —— 不必碰仓库里的 50 个模块。
	 */
	const writeModule = (dir, name, body) => {
		writeFileSync(join(dir, name), body);
	};

	let dir = null;
	afterEach(() => {
		if (dir !== null) {
			rmSync(dir, { recursive: true, force: true });
			dir = null;
		}
	});

	it("import 指向不存在的模块 → 报错", () => {
		dir = mkdtempSync(join(tmpdir(), "zw-graph-"));
		writeModule(dir, "a.js", 'import { x } from "./missing.js";\nexport const a = x;\n');
		const { ok, stderr } = runCheckOn(dir);
		expect(ok).toBe(false);
		expect(stderr).toContain("不存在的模块");
	});

	it("具名 import 在对方没有导出 → 报错", () => {
		dir = mkdtempSync(join(tmpdir(), "zw-graph-"));
		writeModule(dir, "a.js", 'import { nope } from "./b.js";\nexport const a = nope;\n');
		writeModule(dir, "b.js", "export const yep = 1;\n");
		const { ok, stderr } = runCheckOn(dir);
		expect(ok).toBe(false);
		expect(stderr).toContain("但对方没有导出它");
	});

	it("干净的两个模块 → 通过（证明上面两条不是因为脚本恒失败）", () => {
		dir = mkdtempSync(join(tmpdir(), "zw-graph-"));
		writeModule(dir, "a.js", 'import { yep } from "./b.js";\nexport const a = yep;\n');
		writeModule(dir, "b.js", "export const yep = 1;\n");
		const { ok, stdout } = runCheckOn(dir);
		expect(ok).toBe(true);
		expect(stdout).toContain("无自由变量");
	});
});
