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
 */

import { _electron as electron } from 'playwright';
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
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
 * @param {boolean}[opts.reuseConfig]  复用配置目录（默认每个用例用干净的）
 */
export function createHarness(opts) {
	const name = opts.name;
	if (!name) throw new Error('createHarness 需要 name —— 它决定隔离目录与截图目录');

	const bootTimeout = opts.bootTimeout ?? 90_000;
	const fileTimeout = opts.fileTimeout ?? 12 * 60_000;

	const CONFIG_DIR = `/tmp/zerowork-e2e-${name}`;
	const WORKSPACE_DIR = `/tmp/zerowork-ws-${name}`;
	/**
	 * Electron 自己的用户数据目录（cookies / Local Storage / 单实例锁）。
	 *
	 * **为什么必须每个用例一个**：主进程调了 `app.requestSingleInstanceLock()`，
	 * 而这个锁落在 **userData 目录**里 —— 与 `ZEROWORK_CONFIG_DIR` 无关。
	 * 不隔离的话，一个用例的实例会立刻 `app.quit()` 掉另一个用例的实例，
	 * 表现为 playwright 报 `Target page, context or browser has been closed`。
	 *
	 * 症状有多像「随机 flake」：跑得慢的那个先起来，后面每个都立刻退出；
	 * 单独跑又全过。真凶要到「同一时刻 ps 里有另一个 ZeroWork 进程」才看得见。
	 *
	 * 隔离之后 e2e 才可以并行跑。注意这**不只是**为了并行 ——
	 * 一个用例写进 Local Storage 的东西也不该漏给下一个用例。
	 */
	const USER_DATA_DIR = `/tmp/zerowork-ud-${name}`;
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
	if (!opts.reuseConfig) {
		rmSync(CONFIG_DIR, { recursive: true, force: true });
		rmSync(WORKSPACE_DIR, { recursive: true, force: true });
		rmSync(USER_DATA_DIR, { recursive: true, force: true });
	}
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
				`\n${failed.length === 0 ? green(summary) : red(summary)}` +
					(skipped.length > 0 ? dim(`（跳过 ${skipped.length}）`) : '') +
					`\n截图: artifacts/${name}/\n`,
			);

			try {
				await app?.close();
			} catch {
				/* 已经关了 */
			}

			// 断言失败与「渲染层抛了未捕获异常」都要让退出码非零 ——
			// 后者是界面出问题最直接的信号，不能只记不报
			const exitCode = failed.length === 0 && pageErrors.length === 0 ? 0 : 1;
			if (failed.length === 0 && pageErrors.length > 0) {
				process.stdout.write(red(`\n渲染层有 ${pageErrors.length} 个未捕获异常，判为失败\n`));
				for (const e of pageErrors) process.stdout.write(`  ${e}\n`);
			}
			process.exit(exitCode);
		},
	};

	return h;
}
