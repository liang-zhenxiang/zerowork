#!/usr/bin/env node
/**
 * check-resources.mjs —— 随包内容完整性检查
 *
 * 这个仓库**已经因为 `.gitignore` 吃掉随包文件出过两次事故**（记在 `.gitignore` 开头的注释里）：
 *
 *   ① `work/` 这个不带前导斜杠的模式在**任意层级**都匹配，把 `resources/scenes/work/`
 *      一起吞了 —— 于是 `resources/scenes/work/prompt.md` 没进库，
 *      别人克隆下来**应用直接起不来**（`loadResources()` 在场景目录缺 prompt.md 时抛错）。
 *   ② `*.exe` 吞掉了 `resources/bin/{fd,rg,uv}.exe` —— 三个二进制的 README 与许可 NOTICE
 *      都在库里，二进制却不在，**打包时会静默丢件**。
 *
 * 两次的共同点：**文件在本地是好的，只有克隆下来或打包时才发现少了东西**。
 * 所以这条检查同时验两件事：
 *
 *   · 关键文件**存在**（本地）
 *   · 关键文件**被 git 跟踪**（克隆得下来）—— 后者才是真正守住 .gitignore 回归的那一条
 *
 * 用法：node scripts/check-resources.mjs
 * 退出码：0 全部就位，1 有缺失或未被跟踪的关键文件。
 */

import { existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 关键随包文件。缺任何一个都会导致「克隆下来跑不起来」或「打包静默丢件」。
 * 加新资源目录时，把它的入口文件补到这里 —— 这份清单本身就是那两次事故的教训。
 */
const REQUIRED = [
	// 场景入口：缺了 loadResources() 直接抛错，应用起不来
	'resources/scenes/work/prompt.md',
	'resources/scenes/code/prompt.md',
	// 模式与风格：界面上的可选项
	'resources/modes/ask.md',
	'resources/modes/craft.md',
	'resources/modes/plan.md',
	'resources/styles/style-professional.md',
	'resources/styles/style-efficient.md',
	// 内置 agent 定义
	'resources/agents/planner.md',
	'resources/agents/reviewer.md',
	'resources/agents/scout.md',
	'resources/agents/worker.md',
	// 提示词片段
	'resources/prompts/language.md',
	'resources/prompts/memory-system.md',
	// 随包二进制：三个都要在，缺了 find / grep / uv 会退化成「本机找不到就联网下」
	// （那条路在国内网络下经常不通，且每次失败白等 10 秒，见 resources/bin/README.md）
	'resources/bin/fd.exe',
	'resources/bin/rg.exe',
	'resources/bin/uv.exe',
	// 二进制的来源与许可声明必须与二进制同时存在
	'resources/bin/README.md',
	'resources/bin/UV-NOTICE.md',
	// docx 引擎
	'resources/docx-engine/pyproject.toml',
	// MCP 示例配置
	'resources/mcp-example.json',
	// 随包字体的来源与许可说明（字体二进制本身刻意不入库，见该 README）
	'resources/fonts/README.md',
];

/** 二进制文件的体积下限（字节）。设下限是为了抓「文件在但内容被截断/占位」这类情况。 */
const MIN_SIZE = {
	'resources/bin/fd.exe': 1_000_000,
	'resources/bin/rg.exe': 1_000_000,
	'resources/bin/uv.exe': 10_000_000,
};

const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (USE_COLOR ? `\u001b[${code}m${text}\u001b[0m` : text);
const green = (t) => paint('32', t);
const red = (t) => paint('31', t);
const dim = (t) => paint('2', t);

/** 一次性取出全部被跟踪的文件，避免逐个 spawn git。 */
function trackedFiles() {
	try {
		const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' });
		return new Set(out.split('\0').filter(Boolean));
	} catch {
		return null; // 不是 git 仓库（例如被当成普通目录嵌进别处）
	}
}

function main() {
	const tracked = trackedFiles();
	const problems = [];

	for (const rel of REQUIRED) {
		const abs = path.join(ROOT, rel);

		if (!existsSync(abs)) {
			problems.push(`${rel} —— 文件不存在`);
			continue;
		}

		if (tracked && !tracked.has(rel)) {
			problems.push(
				`${rel} —— 文件在本地存在但**没有被 git 跟踪**（.gitignore 回归？克隆下来会缺）`,
			);
			continue;
		}

		const min = MIN_SIZE[rel];
		if (min !== undefined) {
			const size = statSync(abs).size;
			if (size < min) {
				problems.push(
					`${rel} —— 体积 ${size} 字节，低于下限 ${min}（内容被截断或换成了占位文件？）`,
				);
			}
		}
	}

	process.stdout.write('\n随包内容完整性\n');
	process.stdout.write(`  检查了 ${REQUIRED.length} 个关键文件`);
	process.stdout.write(tracked ? '（含 git 跟踪状态）\n' : dim('（非 git 环境，跳过跟踪状态）\n'));

	if (problems.length === 0) {
		process.stdout.write(`  ${green('✓')} 全部存在且已被跟踪\n`);
		return 0;
	}

	process.stdout.write(`\n${red('缺失或未跟踪：')}\n`);
	for (const problem of problems) process.stdout.write(`  ✗ ${problem}\n`);
	process.stdout.write(
		dim('  这类问题的特点是「本地是好的，克隆或打包时才暴露」—— 所以两头都要验。\n'),
	);
	return 1;
}

process.exit(main());
