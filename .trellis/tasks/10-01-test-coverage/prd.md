# 测试体系补强与截图验证

## Goal

建立一道**真正挡得住回归**的防线：后面每加一个功能，都不能悄悄弄坏老功能。
要求全自动、可复现、失败时留得下现场。

## 背景（现状勘察的结论）

现有 23 个 e2e + 5 个单测，覆盖面不小，但**防线有明确的洞**：

| # | 问题 | 证据 |
| --- | --- | --- |
| 1 | **21 个 e2e 文件之间零共享代码** —— 启动块、`check()` 收集器、报告块、`process.exit` 各复制一遍 | `gui-smoke.mjs:38-49` 与其余 20 个文件逐字重复 |
| 2 | **7 个脚本在 CI 上静默 `exit(0)`** —— 依赖本机 `~/.claude/settings.json` 的模型端点，探活失败就整轮跳过，**CI 全绿但一行没跑** | `real-model.mjs:51,72`、`doc-parsing.mjs:56,65`、`command-exec.mjs:65`、`session-branch.mjs:63`、`automation-run.mjs:52` |
| 3 | **截图只覆盖 6/21 个文件**，且 `gui-smoke.mjs:112` 的截图在断言**之后** —— 失败时反而没有现场 | 全仓 `capturePage` 零命中 |
| 4 | **零覆盖率工具** —— 无法量化「哪块在裸奔」 | `package.json` / `vitest.config.mjs` 里 c8/nyc/istanbul 零命中 |
| 5 | **daemon 40 个模块里 28 个没有任何针对性断言** | 最典型的对比：`permission-rules.js` 有 22 条单测，而真正执行权限落地的 `permissions.js` 一条没有 |
| 6 | **沙箱核心无测试** —— `src/main/sandbox/index.js` 与 `prepare-worker.js` 零引用 | 而沙箱是本项目安全模型的核心 |
| 7 | **无 per-file 超时、无重试** —— 本地跑卡住不会自己退出，只靠 CI 的 45 分钟兜底 | — |
| 8 | **等待靠固定 sleep**（冷启动 9s、导航 2.5s），既慢又 flaky | `waitForTimeout(9000)` 在 21 个文件里一致 |

## Requirements

- R1 抽取**共享 helper 模块**（启动、断言收集、报告、收尾），消灭 21 份复制粘贴
- R2 `startMockModelServer` 被内联重写过 6 遍 → 统一到一处
- R3 **GUI 用例带截图断言**：不只看「没抛异常」，还要断言关键区域真的渲染出来了
  （不是全白/全黑、元素非零尺寸）
- R4 **失败时留下现场**：截图必须在断言**之前**拍
- R5 接入**覆盖率度量**，基线取**当前实际值**（不设达不到的理想值），CI 里不倒退
- R6 补 daemon 的关键纯逻辑单测，**优先级**：`permissions.js`（权限落地）>
  `session-view.js`（投影，界面的数据来源）> `memory.js` / `preferences.js`
- R7 7 个「CI 上静默跳过」的脚本：**要么让它们在 CI 上有真实信号（用 mock 替代真实模型端点），
  要么在 CI 里明确标为「不适用」而不是静默绿**
- R8 给 e2e 加 per-file 超时，卡住要自己退出并报错

## Acceptance Criteria

- [ ] **反向验证**：注释掉任意一个核心源码的关键函数，测试**必须变红**（防止测试是空壳）
- [ ] 干净环境下 `npm run test:all` 全绿
- [ ] CI 的 GUI job 有截图 artifact 可下载，且**失败时也有**
- [ ] 覆盖率有数字，且已写进文档（不写无法复现的数字）
- [ ] e2e 文件数量与 `package.json` 脚本映射一致，无遗漏

## 约束

- **不改动 `resources/**`**（不参与本项目工具链）
- 不为覆盖率而写**同义反复的测试** —— 判断标准：把被测功能整个删掉，测试**必须**失败
- 不因为「测试难写」而放宽被测代码的约束
- 测试脚本用 **Node 写，不用 bash** —— 用户会在 Windows/macOS/Linux 上跑

## 非目标

- 不追求 100% 覆盖率。目标是**关键路径有断言**，不是数字好看

## Notes

- GUI 测试在 CI 上只跑 macOS（脚本硬编码 POSIX 路径）；Linux 需 xvfb + `--no-sandbox`
- 反向验证是本任务的**验收核心** —— 没有它的测试防线是假的
