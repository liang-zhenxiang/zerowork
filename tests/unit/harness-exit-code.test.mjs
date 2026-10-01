/**
 * e2e harness 退出码判定的单测 —— 「全跳过不能算绿」的回归防线。
 *
 * ## 为什么要有这个文件
 *
 * `h.skip()` 让文本报告里出现「跳过 N」，但**门禁读的是退出码**。
 * 在此之前的判定是 `failed === 0 ? 0 : 1` —— 于是一个**一条断言都没跑**的
 * 测试文件（整轮跳过，正是本仓库 7 个依赖 `~/.claude/settings.json` 的脚本
 * 在 CI 上的形态）退出码是 0，门禁看到的还是绿的。
 *
 * 这个缺口被 3 个子 agent 各自独立报过一次，所以它值得一条**钉死的**防线：
 * 判定逻辑抽成纯函数 `classifyRun()`，这里逐档验证 ——
 * 断言写得再对，只要退出码还是 0，CI 就什么都不会发现。
 *
 * ## 为什么测纯函数而不是跑一次 finish()
 *
 * `finish()` 会 `process.exit()`，还会真的启动 Electron。判定本身不依赖这两样：
 * 把「算退出码」与「打印并退出」拆开，前者就能像这样毫秒级地覆盖到每个分支
 * —— 而分支覆盖恰恰是这条防线最容易退化的地方。
 *
 * ⚠️ **这个文件自己的前提是「有断言通过」**：它全是同步的纯函数调用，
 * 所以永远有 PASS，不会掉进它自己规定的「无信号」档。
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { classifyRun, EXIT_OK, EXIT_FAILED, EXIT_NO_SIGNAL } from "../e2e/lib/harness.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HARNESS_URL = pathToFileURL(resolve(ROOT, "tests/e2e/lib/harness.mjs")).href;

/**
 * 真的跑一次 harness，把**退出码**原样带回来。
 *
 * 上面那些纯函数断言只钉住「怎么判」，钉不住「有没有接上」—— 有人把
 * `finish()` 改回 `failed.length === 0 ? 0 : 1` 时，纯函数测试仍然全绿。
 * 所以这里起一个子进程，跑一段只记断言、**不启动 Electron** 的最小用例
 * （`finish()` 在没启动过应用时也走同一条判定路径），看真正的退出码。
 *
 * @param {string} body 子进程里 `createHarness` 之后要执行的内容
 */
function runFixture(body) {
	const source = `
		import { createHarness } from ${JSON.stringify(HARNESS_URL)};
		const h = createHarness({ name: "exit-code-fixture" });
		${body}
		await h.finish();
	`;
	return spawnSync(process.execPath, ["--input-type=module", "-e", source], {
		cwd: ROOT,
		encoding: "utf8",
	});
}

describe("退出码三档（语义不能混）", () => {
	it("三个码互不相同 —— 混成一个码会让 CI 日志误导人", () => {
		expect(new Set([EXIT_OK, EXIT_FAILED, EXIT_NO_SIGNAL]).size).toBe(3);
		expect(EXIT_OK).toBe(0);
		expect(EXIT_FAILED).toBe(1);
		expect(EXIT_NO_SIGNAL).toBe(2);
	});
});

describe("通过 → 0", () => {
	it("全部通过", () => {
		expect(classifyRun({ passed: 12, failed: 0 })).toEqual({ code: EXIT_OK, kind: "ok" });
	});

	// R2：不能误伤。有跳过**本身**不是问题，只有「一条都没通过」才是。
	it("有跑有跳（5 通过 / 1 跳过）仍然是绿的 —— 跳过不是失败", () => {
		expect(classifyRun({ passed: 5, failed: 0 })).toEqual({ code: EXIT_OK, kind: "ok" });
	});

	it("通过数远多于跳过数时也不受影响", () => {
		expect(classifyRun({ passed: 30, failed: 0, pageErrors: 0 })).toEqual({ code: EXIT_OK, kind: "ok" });
	});
});

describe("失败 → 1", () => {
	it("有断言失败", () => {
		expect(classifyRun({ passed: 4, failed: 1 })).toEqual({ code: EXIT_FAILED, kind: "failed" });
	});

	it("全失败（一条没过）算失败，不是无信号 —— 有可行动的缺陷时先报缺陷", () => {
		expect(classifyRun({ passed: 0, failed: 6 })).toEqual({ code: EXIT_FAILED, kind: "failed" });
	});

	it("渲染层未捕获异常也算失败（此前就是这么判的，不能退化）", () => {
		expect(classifyRun({ passed: 5, failed: 0, pageErrors: 2 })).toEqual({ code: EXIT_FAILED, kind: "failed" });
	});

	it("失败优先于无信号：既有失败又一条没通过时，报失败", () => {
		expect(classifyRun({ passed: 0, failed: 1, pageErrors: 3 })).toEqual({ code: EXIT_FAILED, kind: "failed" });
	});
});

describe("无信号 → 2（本轮补上的那一档）", () => {
	// 这条就是那个缺口本身：一个永远跳过的测试，与一个不存在的测试，
	// 在门禁上没有区别 —— 都不能算绿
	it("整轮跳过（0 通过 / 5 跳过）不再是绿色", () => {
		expect(classifyRun({ passed: 0, failed: 0 })).toEqual({ code: EXIT_NO_SIGNAL, kind: "no-signal" });
	});

	it("一条断言都没记（0 通过 / 0 跳过 / 0 失败）同样是无信号", () => {
		expect(classifyRun({ passed: 0, failed: 0, pageErrors: 0 })).toEqual({
			code: EXIT_NO_SIGNAL,
			kind: "no-signal",
		});
	});

	it("渲染层异常仍优先于无信号（那是失败）", () => {
		expect(classifyRun({ passed: 0, failed: 0, pageErrors: 1 })).toEqual({ code: EXIT_FAILED, kind: "failed" });
	});
});

// ── 端到端：退出码真的从 finish() 出来（不是只有纯函数对）──────────
describe("finish() 真的用上了这套判定（反向验证的自动化版）", () => {
	it(
		"整轮跳过的一次真实运行退出码是 2，且报告里写明「无信号」",
		() => {
			const r = runFixture(`h.skip("夹具断言", "夹具：刻意整轮跳过");`);
			expect(r.stdout).toContain("一条断言都没通过");
			expect(r.status).toBe(EXIT_NO_SIGNAL);
		},
		30_000,
	);

	it(
		"有跑有跳（1 通过 / 1 跳过）的一次真实运行退出码是 0 —— R2 不能误伤",
		() => {
			const r = runFixture(`
				await h.check("夹具通过", () => {});
				h.skip("夹具跳过", "夹具：这条只是被跳过");
			`);
			expect(r.stdout).toContain("通过 1/2（跳过 1）");
			expect(r.status).toBe(EXIT_OK);
		},
		30_000,
	);
});
