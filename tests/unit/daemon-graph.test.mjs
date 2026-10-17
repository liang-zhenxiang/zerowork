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
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = join(ROOT, "tools", "check-daemon-graph.mjs");
const SESSION_FILES = join(ROOT, "src", "main", "daemon", "session-files.js");

/** 跑检查脚本，返回 `{ ok, stdout, stderr }` —— 不抛异常，让断言自己说结果。 */
function runCheck() {
	try {
		const stdout = execFileSync(process.execPath, [SCRIPT], {
			cwd: ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { ok: true, stdout, stderr: "" };
	} catch (error) {
		return {
			ok: false,
			stdout: error.stdout ?? "",
			stderr: error.stderr ?? "",
		};
	}
}

describe("check-daemon-graph —— 模块边界守卫本身", () => {
	it("在当前仓库状态下通过，且两条性质都真的跑过（不是提前 return）", () => {
		const { ok, stdout } = runCheck();
		expect(ok).toBe(true);
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
	let backup = null;

	afterEach(() => {
		if (backup !== null) {
			writeFileSync(SESSION_FILES, backup);
			backup = null;
		}
	});

	it("复现那次真实缺陷：删掉 onExceedAction / parseWatchPolicy 的 import 必须被抓住", () => {
		backup = readFileSync(SESSION_FILES, "utf8");
		const before = backup;
		// 精确地只摘掉这两个名字，其余不动 —— 与当初漏写 import 的形态一致。
		const after = before
			.replace(/^\t(onExceedAction|parseWatchPolicy),\n/gm, "");
		expect(after).not.toBe(before); // 若源码形态变了，这条用例要跟着改，而不是静默失效
		writeFileSync(SESSION_FILES, after);

		const { ok, stderr } = runCheck();
		expect(ok).toBe(false);
		expect(stderr).toContain("onExceedAction");
		expect(stderr).toContain("parseWatchPolicy");
		// 只报这两个：误报会让守卫失去可信度，比漏报更快被关掉。
		expect(stderr).not.toContain("command-exec.js");
		expect(stderr).not.toContain("config-paths.js");

		// 还原后必须重新变绿 —— 否则「检出问题」可能只是脚本坏了。
		writeFileSync(SESSION_FILES, backup);
		backup = null;
		expect(runCheck().ok).toBe(true);
	});

	it("不误报 import.meta 与 URI 内建全局", () => {
		// 这两类曾经各造成一批误报：`import.meta` 被拆成标识符 `import` + `meta`，
		// 而 encodeURIComponent 之类没进内建名单。它们现在都必须沉默。
		const { ok, stderr } = runCheck();
		expect(ok).toBe(true);
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

	const runCheckOn = (target) => {
		try {
			const stdout = execFileSync(process.execPath, [SCRIPT], {
				cwd: ROOT,
				encoding: "utf8",
				env: { ...process.env, ZW_DAEMON_DIR: target },
				stdio: ["ignore", "pipe", "pipe"],
			});
			return { ok: true, stderr: "", stdout };
		} catch (error) {
			return { ok: false, stderr: error.stderr ?? "", stdout: error.stdout ?? "" };
		}
	};

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
