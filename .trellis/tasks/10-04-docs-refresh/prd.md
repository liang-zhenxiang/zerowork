# README 门面截图与文档里的 daemon 规模重新对齐

## Goal

README 门面四张截图是 #112 时拍的，侧栏信息架构此后动过两轮（资料库从「规划中」进「就绪」、组标题改「规划中」），首页展示的是已经不存在的界面；文档里 daemon 规模停在 40 个模块 / 19,467 行（实际 43 / 约 24,400）。用 tools/shoot-storefront.mjs 重拍四图，并把模块数与行数在 AGENTS.md、CONTRIBUTING.md、docs/ARCHITECTURE.md、.trellis/ 两处与检查工具注释里改齐、注明实时值以 npm run check:daemon-graph 为准。

## 背景：已核实的事实

| 项 | 结论 | 怎么核实的 |
| --- | --- | --- |
| 门面截图拍于何时 | #112「README 从自述改成看得见的样子」那一轮 | `CHANGELOG.md` 的该条 + `docs/images/*.png` 的提交历史 |
| 之后信息架构动过什么 | 「资料库」从「规划中」组挪进「就绪」组；组标题「即将开放」改「规划中」；侧栏新增「统计」 | 读当前 `src/renderer/src/app.js` 与截图对比 |
| daemon 实际规模 | **43 个模块 / 24,370 行** | `npm run check:daemon-graph` 输出 + `find src/main/daemon -name '*.js' \| wc -l` |
| 文档写的是多少 | 40 个模块 / 19,467 行 | 改前的 `AGENTS.md`、`docs/ARCHITECTURE.md`、`CONTRIBUTING.md`、`.trellis/workflow.md`、`.trellis/spec/daemon/index.md`、`tools/check-daemon-graph.mjs` 注释 |
| 截图怎么重拍 | 仓库自带 `tools/shoot-storefront.mjs`：本地 mock 模型跑完整条链路后按 CSS 像素拍 1440×900 | 读脚本 + 实跑一次（脚本自断言 6/6 通过） |

## Requirements

- **R1 四张门面图重拍**：`docs/images/home-light.png`、`home-dark.png`、`conversation.png`、
  `command-palette.png` 全部用 `node tools/shoot-storefront.mjs` 重新生成，1440×900，
  内容与当前界面一致（侧栏「资料库」在就绪组、「规划中」只剩助理 / 项目 / 更多）。
- **R2 daemon 规模数字改齐**：把「40 个模块」改成实际值，「19,467 行」改成量级值，
  在 `AGENTS.md`、`CONTRIBUTING.md`、`docs/ARCHITECTURE.md`、`.trellis/workflow.md`、
  `.trellis/spec/daemon/index.md` 与 `tools/check-daemon-graph.mjs` 的注释里同步；
  并在文档里**注明实时值以 `npm run check:daemon-graph` 为准**（数字会漂，取数方式不会）。
- **R3 顺手改掉同族的写死数字**：`app.js` 的「6.8 万行」改成「近 7 万行」（实测 69,479 行），
  避免下一轮又来一次。
- **R4 CHANGELOG**：`[Unreleased] → 变更` 记一条，写清「此前 README 展示的是已经不存在的界面」。

## 约束

- **不为了改文档动任何运行时代码**：只有 `tools/check-daemon-graph.mjs` 的**注释**一行，
  脚本行为不变（改完仍要跑一次确认输出一样）。
- 不改 `resources/**`；不新增依赖。
- 历史 `CHANGELOG.md` 条目里的旧数字**不改**（那是当时的记录）。

## Acceptance Criteria

- [ ] `node tools/shoot-storefront.mjs` 实跑，脚本自断言全过（四张都在 / 尺寸对 / 非纯色 /
      彼此不同 / 总重不超标）
- [ ] 四张新图**人工看过**：侧栏与当前界面一致（「资料库」在就绪组）
- [ ] `npm run check:daemon-graph` 输出与文档里的数字一致（43 个模块）
- [ ] `npx vitest run` 全绿、既有用例一条不少
- [ ] `npm run lint:all` 中与本改动相关的检查项全绿
      （已知无关失败：本机陈旧 `release/` 产物、docker 未起导致 zizmor 跳过）
- [ ] 中文内容 U+FFFD 扫描通过
- [ ] `CHANGELOG.md` 的 `[Unreleased] → 变更` 有条目

## Notes

- 轻量任务，PRD-only，不另写 `design.md` / `implement.md`。
- 这轮没有代码行为改动，因此不新增单元 / GUI 用例；截图工具自身带的产物断言就是
  这一轮的「GUI 测试」（它真实启动 Electron 并按像素出图）。
