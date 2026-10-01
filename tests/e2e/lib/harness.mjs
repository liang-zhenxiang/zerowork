/**
 * e2e 测试的公共骨架。
 *
 * ## 为什么要有这个文件
 *
 * 此前 21 个 e2e 脚本各自复制了同一套骨架：清隔离目录 → 启动 Electron →
 * 收集 stdout → `check()` 收集器 → 末尾打报告 → `process.exit`。
 * 后果有两个，都很实际：
 *
 *   1. **改一处要改 21 个文件**。比如要调整启动等待策略，就得全改一遍，
 *      漏掉一个就埋一颗不一致的地雷
 *   2. **新用例的成本高**，于是没人愿意写新用例 —— 这才是真正的代价
 *
 * 这里把骨架收拢成一处，用例只剩「驱动界面 + 断言」。
 *
 * ## 用法
 *
 * ```js
 * import { createHarness } from "./lib/harness.mjs";
 *
 * const h = createHarness({ name: "smoke" });   // name 决定隔离目录与截图目录
 * const app = await h.launch();                 // 启动 + 等到界面真的就绪
 * const win = h.window();
 *
 * await h.shoot("home");                        // 先截图，再断言 —— 失败才有现场
 * await h.check("标题正确", async () => { ... });
 *
 * await h.finish();                             // 汇总 + 收尾 + 设置退出码
 * ```
 *
 * ## 两条刻意设计的纪律
 *
 * - **先截图后断言**：断言失败时截图里才有出问题的那一屏。截在断言之后，
 *   失败时反而什么都留不下 —— 这是本项目真实踩过的
 * - **失败时自动补拍**：`finish()` 在有任何 FAIL 时会再截一张 `_failure.png`，
 *   哪怕用例自己忘了截图
 *
 * ## 退出码是三档，不是一个布尔值
 *
 * `finish()` 结束时不再只回答「绿/红」，而是分三种情形（判定逻辑集中在
 * `classifyRun()`，单测钉在 `tests/unit/harness-exit-code.test.mjs`）：
 *
 * | 退出码 | 含义 | 触发条件 |
 * | --- | --- | --- |
 * | `0` | 通过 | 至少有一条 PASS，且没有 FAIL、没有渲染层未捕获异常 |
 * | `1` | 失败 | 有 FAIL，或有渲染层未捕获异常 |
 * | `2` | **无信号** | 一条都没通过：整轮跳过，或压根没记过任何断言 |
 *
 * 为什么要单分出 `2`：**一个永远跳过的测试，和一个不存在的测试，在门禁上
 * 没有区别** —— 两者提供的信号都是零。把它们混进「失败」会让 CI 日志误导人
 * （看起来像断言挂了），所以刻意给不同的码：`1` 是「有东西坏了」，
 * `2` 是「什么都没验」。
 *
 * **注意 `2` 是刻意的，不是 bug**：本仓库有若干脚本依赖本机 `~/.claude/settings.json`
 * 的模型端点，端点在 CI 上永远探不到 —— 于是它们在 CI 上永远拿 `2`。
 * 那正是事实：**这些文件在 CI 上没有信号**。正确处置是别把它们当成 CI 的覆盖，
 * 而不是把这里的判定调松。
 */

import { _electron as electron } from 'playwright';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, downsample, imageStats, renderGrid, diffGrids } from './png.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (USE_COLOR ? `\u001b[${code}m${text}\u001b[0m` : text);
const green = (t) => paint('32', t);
const red = (t) => paint('31', t);
const yellow = (t) => paint('33', t);
const dim = (t) => paint('2', t);

/**
 * 退出码。**三档，不是一个布尔值** —— 语义见文件头的表。
 *
 * - `EXIT_OK`（0）：至少一条 PASS，且没有 FAIL / 渲染层异常
 * - `EXIT_FAILED`（1）：有东西坏了（断言挂了、渲染层抛了）
 * - `EXIT_NO_SIGNAL`（2）：什么都没验（整轮跳过，或没记过任何断言）
 *
 * 刻意不复用 `1`：`1` 在 CI 日志里的意思是「断言失败」，而「全跳过」不是
 * 断言失败 —— 混成一个码会让人去查一个根本不存在的缺陷。
 */
export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_NO_SIGNAL = 2;

/**
 * 依据一轮运行的计数判定退出码。**纯函数** —— 判定逻辑单独可测
 * （`tests/unit/harness-exit-code.test.mjs`），不依赖真的启动 Electron。
 *
 * ## 为什么「一条都没通过」要单独成一档
 *
 * 回到那个问题：**一个永远跳过的测试，和一个不存在的测试，区别是什么？**
 *
 * 在门禁这一层，**没有区别** —— 两者都没有让任何断言真的跑过，提供的信号都是零。
 * 既然「不在 CI 里跑的测试等于没有测试」（见 `.trellis/spec/testing/` 第 10 条），
 * 那么「跑了但一条都没通过」同样是零信号，**不能算绿**。
 *
 * 这条规则严格落在「**没有一条通过**」上，而不是「有跳过」上：
 * `passed > 0 && skipped > 0`（例如 5 通过 / 1 跳过）仍然是绿 ——
 * 有跳过本身不是问题，**跳过掩盖了「什么都没验」才是**。
 *
 * 优先级：失败 > 无信号 > 通过。有 FAIL 时先报 FAIL，因为那才是可行动的缺陷。
 *
 * ⚠️ **`skipped` 刻意不作为判定输入**。判定只看「有没有通过」，不看「跳过了几条」：
 * 「跳过了 N 条」可以是完全正常的（平台不适用、上游没产出），拿它当失败条件是误伤；
 * 真正致命的只有「一条都没通过」。所以调用方传不传 `skipped` 都不影响结果，
 * 它只是报告里的一个数字。
 *
 * @param {{passed: number, failed: number, pageErrors?: number}} counts
 * @returns {{code: number, kind: 'ok' | 'failed' | 'no-signal'}}
 */
export function classifyRun({ passed, failed, pageErrors = 0 }) {
	// 有失败就是失败 —— 哪怕同时也有跳过
	if (failed > 0) return { code: EXIT_FAILED, kind: 'failed' };
	// 渲染层未捕获异常同样算失败（界面出问题最直接的信号）
	if (pageErrors > 0) return { code: EXIT_FAILED, kind: 'failed' };
	// 一条都没通过：整轮跳过（passed 0 / skipped N）或压根没记断言（0/0/0）。
	// 两者都与「本文件不存在」等价，不能算绿。
	if (passed === 0) return { code: EXIT_NO_SIGNAL, kind: 'no-signal' };
	return { code: EXIT_OK, kind: 'ok' };
}

/**
 * 轮询等待条件成立。
 *
 * 刻意**不**用固定 `waitForTimeout`：固定等待在慢机器上不够、在快机器上白等，
 * 两头都错。轮询把「够不够久」交给实际状态来回答。
 */
export async function waitUntil(fn, { timeout = 30_000, interval = 250, desc = '条件' } = {}) {
	const deadline = Date.now() + timeout;
	let lastError = null;
	while (Date.now() < deadline) {
		try {
			const value = await fn();
			if (value) return value;
		} catch (error) {
			lastError = error;
		}
		await new Promise((r) => setTimeout(r, interval));
	}
	const suffix = lastError ? `（最后一次尝试抛出：${lastError.message}）` : '';
	throw new Error(`等待超时 ${timeout}ms：${desc}${suffix}`);
}

/**
 * 建一个用例的 harness。
 *
 * @param {object} opts
 * @param {string} opts.name        用例名，决定隔离目录与截图目录（必需，且需在仓内唯一）
 * @param {number} [opts.bootTimeout]  等到界面就绪的上限
 * @param {number} [opts.fileTimeout]  整个文件的上限；超时会被强制终止并留下诊断
 * @param {object} [opts.env]          额外的环境变量
 */
export function createHarness(opts) {
	const name = opts.name;
	if (!name) throw new Error('createHarness 需要 name —— 它决定隔离目录与截图目录');

	const bootTimeout = opts.bootTimeout ?? 90_000;
	const fileTimeout = opts.fileTimeout ?? 12 * 60_000;

	/**
	 * 每个用例三份独立目录：应用配置、工作区、Electron 的 userData。
	 *
	 * **用 `mkdtempSync` 而不是拼一个固定路径**，有两个理由：
	 *
	 * 1. **安全**。系统临时目录是全局可写的，固定路径意味着别的本地进程可以
	 *    抢先创建一个同名符号链接，把我们的写入导向它选定的位置。
	 *    `mkdtempSync` 生成随机后缀并以 `0700` 建目录，这条路走不通。
	 *    （这条正是 CodeQL 的 `js/insecure-temporary-file` 报的 —— 它报得对。）
	 * 2. **隔离**。固定路径在同一台机器上多用户/多进程会互相踩；
	 *    随机后缀让并行跑天然安全。
	 *
	 * 名字里仍保留用例名作前缀，一是便于人工在 /tmp 里辨认，
	 * 二是有些用例会断言「返回的路径里含某个特征串」。
	 */
	const freshTmpDir = (prefix) => mkdtempSync(join(tmpdir(), prefix));
	const CONFIG_DIR = freshTmpDir(`zerowork-e2e-${name}-`);
	const WORKSPACE_DIR = freshTmpDir(`zerowork-ws-${name}-`);
	/**
	 * userData（cookies / Local Storage / **单实例锁**）。
	 *
	 * **为什么必须每个用例一个**：主进程调了 `app.requestSingleInstanceLock()`，
	 * 而这个锁落在 userData 目录里 —— 与 `ZEROWORK_CONFIG_DIR` 无关。
	 * 不隔离的话，一个用例的实例会立刻 `app.quit()` 掉另一个用例的实例，
	 * 表现为 playwright 报 `Target page, context or browser has been closed`。
	 *
	 * 症状有多像「随机 flake」：跑得慢的那个先起来，后面每个都立刻退出；
	 * 单独跑又全过。真凶要到「同一时刻 ps 里有另一个 ZeroWork 进程」才看得见。
	 */
	const USER_DATA_DIR = freshTmpDir(`zerowork-ud-${name}-`);
	const SHOT_DIR = resolve(ROOT, 'artifacts', name);

	const results = [];
	const procLines = [];
	const pageErrors = [];

	let app = null;
	let win = null;
	let finished = false;

	// ── 看门狗 ─────────────────────────────────────────────
	//
	// 此前没有这个：脚本卡住时**本地不会自己退出**，只能靠 CI 的 45 分钟
	// timeout-minutes 兜底。那意味着本地跑一次要人工盯着。加到这里的代价很小。
	const watchdog = setTimeout(() => {
		const where = results.length > 0 ? `已跑 ${results.length} 条断言` : '尚未产出任何断言结果';
		process.stderr.write(
			`\n${red(`[看门狗] ${name} 超过 ${Math.round(fileTimeout / 1000)}s 未结束，强制终止`)}\n` +
				`  ${where}\n` +
				`  多半是在等一个永远不会到达的状态 —— 检查最近的断言与等待条件\n` +
				`  进程日志尾部：\n${procLines.slice(-15).map((l) => `    ${l}`).join('\n')}\n`,
		);
		try {
			app?.close();
		} catch {
			/* 关不掉也要退出 */
		}
		process.exit(1);
	}, fileTimeout);
	watchdog.unref?.();

	// ── 隔离目录 ───────────────────────────────────────────
	// 目录由 mkdtempSync 现建，本来就是干净的 —— 不需要再删一遍。
	mkdirSync(SHOT_DIR, { recursive: true });

	const h = {
		name,
		CONFIG_DIR,
		WORKSPACE_DIR,
		SHOT_DIR,
		procLines,
		pageErrors,

		/** 逐条记录断言结果。**不因单条失败中断整轮** —— 一次跑完拿到完整清单。 */
		async check(label, fn) {
			try {
				await fn();
				results.push(['PASS', label, '']);
				return true;
			} catch (error) {
				results.push(['FAIL', label, String(error?.message ?? error).slice(0, 400)]);
				return false;
			}
		},

		/** 跳过一条断言，但**在报告里留痕** —— 静默跳过会让「全绿」失去意义。 */
		skip(label, reason) {
			results.push(['SKIP', label, reason]);
		},

		/**
		 * 启动应用并等到界面**真的就绪**。
		 *
		 * 「就绪」的判据不是固定时长，而是三个可观察的条件都成立：
		 * `#root` 挂上了子节点、样式表加载了、daemon 报过启动。
		 */
		async launch() {
			try {
				return await this._launch();
			} catch (error) {
				// 启动阶段失败时给一份**可诊断**的报告，而不是抛一个裸栈出去 ——
				// 裸栈只有 playwright 的 `Target page, context or browser has been closed`，
				// 对定位毫无帮助（真凶可能是启动了几十秒后 daemon 才超时，
				// 也可能是别的实例抢了单实例锁）。
				process.stderr.write(`\n${red(`[启动失败] ${name}`)}\n  ${error?.message ?? error}\n`);
				if (procLines.length > 0) {
					process.stderr.write(`\n  进程日志（共 ${procLines.length} 行，尾部 20 行）：\n`);
					for (const line of procLines.slice(-20)) process.stderr.write(`    ${line}\n`);
				}
				if (pageErrors.length > 0) {
					process.stderr.write(`\n  渲染层异常：\n`);
					for (const e of pageErrors) process.stderr.write(`    ${e}\n`);
				}
				process.stderr.write(
					dim(
						`\n  排查方向：① 是否已有另一个 ZeroWork 实例在跑（单实例锁是按 userData 目录生效的，\n` +
							`  本 harness 已为每个用例指定独立的 --user-data-dir，若仍冲突说明有别处未隔离）；\n` +
							`  ② out/ 构建产物是否过期（先 npm run build）；③ daemon 是否在超时内报启动。\n`,
					),
				);
				results.push(['FAIL', '启动应用', String(error?.message ?? error)]);
				// 走 finish() 收尾，保证退出码非零且报告里留下这一条
				await h.finish();
				throw error; // finish 已经 exit，这里只是让类型收窄
			}
		},

		async _launch() {
			app = await electron.launch({
				args: [ROOT, `--user-data-dir=${USER_DATA_DIR}`],
				env: {
					...process.env,
					ZEROWORK_CONFIG_DIR: CONFIG_DIR,
					ZEROWORK_RESOURCES_DIR: resolve(ROOT, 'resources'),
					// 工作区根目录也要隔离：只隔 CONFIG_DIR 的话，工作区仍会落进
					// 用户真实家目录下的 ~/ZeroWork
					ZEROWORK_WORKSPACE_DIR: WORKSPACE_DIR,
					...(opts.env ?? {}),
				},
				timeout: bootTimeout,
			});

			app.process().stdout?.on('data', (b) => procLines.push(String(b).trimEnd()));
			app.process().stderr?.on('data', (b) => procLines.push(String(b).trimEnd()));

			win = await app.firstWindow({ timeout: bootTimeout });
			win.on('pageerror', (e) => pageErrors.push(String(e)));
			await win.waitForLoadState('domcontentloaded');

			await waitUntil(
				() => win.evaluate(() => (document.getElementById('root')?.childElementCount ?? 0) > 0),
				{ timeout: bootTimeout, desc: 'React 挂载到 #root' },
			);
			await this.waitForDaemon(bootTimeout);
			await this.waitForSettled();
			return app;
		},

		/**
		 * 等到界面**停止变化**。
		 *
		 * 为什么不靠固定时长：React 挂载完成 ≠ 界面就绪。首页的场景标签、案例卡
		 * 等内容要等 daemon 起来后通过 IPC 异步取回 —— 挂载那一刻它们还不在。
		 * 固定等 9 秒在快机器上白等、在慢机器上不够。
		 *
		 * 用 DOM 变动静默期作为判据：连续 `quietMs` 毫秒没有任何节点/文本/属性变化，
		 * 就认为这一屏已经稳定。它对内容无感知，对动画有容忍（动画不停时靠 timeout 兜底）。
		 */
		async waitForSettled({ quietMs = 800, timeout = 60_000 } = {}) {
			const settled = await win.evaluate(
				async ({ quietMs, timeout }) => {
					return await new Promise((resolve) => {
						let quietTimer = null;
						let observer = null;
						const finish = (ok) => {
							clearTimeout(quietTimer);
							clearTimeout(hardTimer);
							observer?.disconnect();
							resolve(ok);
						};
						observer = new MutationObserver(() => {
							clearTimeout(quietTimer);
							quietTimer = setTimeout(() => finish(true), quietMs);
						});
						observer.observe(document.body, {
							childList: true,
							subtree: true,
							characterData: true,
							attributes: true,
						});
						const hardTimer = setTimeout(() => finish(false), timeout);
						quietTimer = setTimeout(() => finish(true), quietMs);
					});
				},
				{ quietMs, timeout },
			);
			if (!settled) {
				throw new Error('界面在超时内始终在变动，没能稳定下来 —— 可能有持续动画或渲染死循环');
			}
			return settled;
		},

		window() {
			if (!win) throw new Error('还没启动应用 —— 先 await h.launch()');
			return win;
		},

		app() {
			if (!app) throw new Error('还没启动应用 —— 先 await h.launch()');
			return app;
		},

		/** 等 daemon 子进程报启动 —— 单测里没有的东西，只有真启动才有。 */
		async waitForDaemon(timeout = 60_000) {
			await waitUntil(() => procLines.some((l) => l.includes('daemon 启动')), {
				timeout,
				desc: 'daemon 报启动',
			});
		},

		/**
		 * 截图并**立即做像素断言**。
		 *
		 * 这是本 harness 与「只存一张图」的关键区别：图存下来没人看等于没测。
		 * 默认断言「不是一片纯色」—— 空白页、整块错误边界、崩溃后的白屏都能被它抓住。
		 *
		 * **阈值的来由（实测，不是拍脑袋）**：跑遍本仓库现有截图后量得，
		 * 真实界面的最小值是**标准差 12.23 / 颜色数 85**（`sections/stats.png`，
		 * 那是最简的一屏空状态）；而纯白图的实测值是**标准差 0.00 / 颜色数 1**。
		 * 取 3 与 12 是留了 4~7 倍余量，**只用来抓「基本没渲染」**，
		 * 不承担「画面变了没」的职责 —— 后者交给基线 diff，且不做自动门禁。
		 *
		 * 已知的误报场景（真出现时调阈值，别调断言）：一屏**没有文字、且用平涂色块**
		 * 的界面，颜色数会很低。真实应用界面因为文字抗锯齿会产生大量颜色，碰不到这条。
		 */
		async shoot(label, { assert = true, minStdDev = 3, minColors = 12 } = {}) {
			const file = resolve(SHOT_DIR, `${label}.png`);
			await win.screenshot({ path: file });
			const img = decodePng(readFileSync(file));
			const stats = imageStats(img);
			const grid = downsample(img);

			if (assert) {
				const problems = [];
				if (stats.stdDev < minStdDev) {
					problems.push(`画面几乎是纯色（亮度标准差 ${stats.stdDev.toFixed(2)} < ${minStdDev}）`);
				}
				if (stats.distinctColors < minColors) {
					problems.push(`颜色过少（${stats.distinctColors} < ${minColors}）`);
				}
				if (problems.length > 0) {
					throw new Error(`${label} 截图不像渲染出来的界面：${problems.join('；')}\n${renderGrid(grid)}`);
				}
			}
			return { file, stats, grid, img };
		},

		/** 只截图不断言 —— 用于「变化中的中间态」这类不该断言画面的地方。 */
		async snap(label) {
			const file = resolve(SHOT_DIR, `${label}.png`);
			await win.screenshot({ path: file });
			return file;
		},

		/** 读回一张已存在的截图做统计，用于跨版本的粗略比对。 */
		readShot(label) {
			const file = resolve(SHOT_DIR, `${label}.png`);
			return existsSync(file) ? imageStats(decodePng(readFileSync(file))) : null;
		},

		/** 把降采样网格存成基线，供后续 diff（人工审查用，不做自动门禁）。 */
		saveBaseline(label) {
			const file = resolve(SHOT_DIR, `${label}.baseline.json`);
			const grid = downsample(decodePng(readFileSync(resolve(SHOT_DIR, `${label}.png`))));
			writeFileSync(file, JSON.stringify({ cols: grid.cols, rows: grid.rows, cells: [...grid.cells] }));
			return file;
		},

		/** 与已存基线比差异，返回 0–255 的平均绝对差。 */
		diffBaseline(label) {
			const file = resolve(SHOT_DIR, `${label}.baseline.json`);
			if (!existsSync(file)) return null;
			const saved = JSON.parse(readFileSync(file, 'utf8'));
			const now = downsample(decodePng(readFileSync(resolve(SHOT_DIR, `${label}.png`))));
			return diffGrids({ cols: saved.cols, rows: saved.rows, cells: Float64Array.from(saved.cells) }, now);
		},

		/** 汇总 → 补拍失败现场 → 收尾 → 设退出码。 */
		async finish() {
			if (finished) return;
			finished = true;
			clearTimeout(watchdog);

			const failed = results.filter(([s]) => s === 'FAIL');
			const skipped = results.filter(([s]) => s === 'SKIP');
			const passed = results.filter(([s]) => s === 'PASS');

			// 有失败就补一张现场图 —— 用例自己忘了截也有据可查
			if (failed.length > 0 && win) {
				try {
					await win.screenshot({ path: resolve(SHOT_DIR, '_failure.png') });
				} catch {
					/* 截图失败不该掩盖真正的失败 */
				}
			}

			process.stdout.write(`\n═══ ${name} ═══\n`);
			for (const [status, label, msg] of results) {
				const tag = status === 'PASS' ? green('[PASS]') : status === 'SKIP' ? yellow('[SKIP]') : red('[FAIL]');
				process.stdout.write(`  ${tag} ${label}${msg ? `  —— ${msg}` : ''}\n`);
			}
			const summary = `通过 ${passed.length}/${results.length}`;
			process.stdout.write(
				`\n${failed.length === 0 && passed.length > 0 ? green(summary) : red(summary)}` +
					(skipped.length > 0 ? dim(`（跳过 ${skipped.length}）`) : '') +
					`\n截图: artifacts/${name}/\n`,
			);

			try {
				await app?.close();
			} catch {
				/* 已经关了 */
			}

			// 成功时清掉本用例的临时目录（目录名是随机的，留着只会堆满 /tmp）。
			// **失败时保留** —— 那里面是现场：应用配置、工作区、会话记录，
			// 排查问题时往往比截图更有用。路径会随报告一起打出来。
			if (failed.length === 0) {
				for (const dir of [CONFIG_DIR, WORKSPACE_DIR, USER_DATA_DIR]) {
					try {
						rmSync(dir, { recursive: true, force: true });
					} catch {
						/* 清理是尽力而为，清不掉不该让用例失败 */
					}
				}
			} else {
				process.stdout.write(
					dim(`留作现场：\n  ${CONFIG_DIR}\n  ${WORKSPACE_DIR}\n  ${USER_DATA_DIR}\n`),
				);
			}

			// 退出码三档，判定集中在 classifyRun()（单测钉住它，本函数只负责打印与 exit）。
			//
			// 断言失败、渲染层未捕获异常、以及「一条都没通过」都要非零 ——
			// 最后这条是本轮补上的：全跳过的运行此前退出码是 0，于是**一个一条都没跑的
			// 测试文件在 CI 上表现为绿色**。它和「文件不存在」没有区别，不能算绿。
			const verdict = classifyRun({
				passed: passed.length,
				failed: failed.length,
				pageErrors: pageErrors.length,
			});

			if (failed.length === 0 && pageErrors.length > 0) {
				process.stdout.write(red(`\n渲染层有 ${pageErrors.length} 个未捕获异常，判为失败\n`));
				for (const e of pageErrors) process.stdout.write(`  ${e}\n`);
			}

			if (verdict.kind === 'no-signal') {
				// 说清「为什么非零」与「这不是失败」——退出码 2 与 1 的含义不同，
				// 混为一谈会让人去查一个不存在的缺陷
				process.stdout.write(
					red(`\n一条断言都没通过（通过 ${passed.length} / 跳过 ${skipped.length}）—— 判为「无信号」\n`) +
						dim(
							`  全跳过的运行与「本文件不存在」在门禁上没有区别：都没有让任何断言真的跑过。\n` +
								`  这不是本文件的断言失败（那不是退出码 1），而是**本文件在当前环境没有信号** ——\n` +
								`  跳过原因见上面每一条 [SKIP]。若不是有意为之，请修复它依赖的前置条件。\n`,
						),
				);
			}

			process.exit(verdict.code);
		},
	};

	return h;
}
