import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// 只跑本工程的测试。
		// resources/ 下是插件市场的第三方内容（如 teams_marketplace），
		// 里面自带 .test.js，用默认的 include 会被 vitest 扫到并因语法不兼容而整体失败。
		include: ["tests/unit/**/*.test.mjs"],
		exclude: ["node_modules/**", "out/**", "resources/**", "artifacts/**", "release/**"],
		coverage: {
			provider: "v8",
			// 只统计**单测这一层该负责的代码**（issue #30）。
			//
			// 渲染层（src/renderer/**）不在这里：它由 e2e 那一层覆盖，而 e2e 跑在**另一个
			// Electron 进程**里，vitest 的覆盖率根本看不见它 —— 把它们算进来只会得到
			// 「1.78% 行覆盖」这种既看不出问题、又白等三分钟的数字（实测过）。
			// 主进程入口（src/main/index.js）同理：它是装配代码，e2e 才跑得到。
			include: ["src/main/daemon/**/*.js", "src/shared/**/*.js", "tools/**/*.mjs", "scripts/**/*.mjs"],
			// 报告：CI 日志里看得懂的摘要 + 给将来做徽章/对比用的 json
			reporter: ["text-summary", "json-summary"],
			// 阈值 = **实测基线**（2026-10-12，本机 macOS）：
			//   lines 15.66% / statements 15.45% / functions 12.46% / branches 15.98%
			// 留约 1 个点吸收平台差异（CI 在 ubuntu 与 windows 各跑一次，而覆盖率
			// 只在 ubuntu leg 上强制 —— 见 ci.yml 的单元测试 job）。
			//
			// 这个数字**刻意不好看**：daemon 是十几个大文件，单测只覆盖到其中一部分。
			// 它的作用是「不倒退」，不是「达标」—— 覆盖率涨上去时请把阈值一起抬，
			// 别让基线悄悄落后于现状。
			thresholds: {
				lines: 14.5,
				statements: 14.5,
				functions: 11.5,
				branches: 15,
			},
		},
	},
});
