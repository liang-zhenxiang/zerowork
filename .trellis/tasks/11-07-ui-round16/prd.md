# PRD · 第十六轮十连——「空间组的整理与多选掌控」

任务目录：`.trellis/tasks/11-07-ui-round16/`　分支：`feat/ui-round16`　issue：#338　日期：2026-11-07

## 背景

十五轮后侧栏「任务」区已有过滤语法/键盘导航/拖拽排序，但「空间」组（按工作区分组）还停留在只读列表。第十六轮把整理能力补齐到空间组：折叠、重命名、排序、颜色、组内搜索、跨组移动。

## 十项清单

| # | 功能 | 说明 | 主要落点 |
| --- | --- | --- | --- |
| 1 | 空间组折叠 | 组头 chevron 可折叠，`zw:space-collapsed`（map cwd→bool）持久化 | renderSpaceGroup |
| 2 | 空间组重命名 | 组头 ⋯ 菜单「重命名」→ window.prompt，写 `zw:space-names`（displayName 已渲染优先） | 组头菜单 |
| 3 | 空间组拖拽排序 | 组头拖动调整组间顺序，`zw:space-order`（cwd 数组）持久化 | 组头 draggable |
| 4 | 任务跨组移动 | 任务行菜单「移动到空间…」→ 组列表浮层，选中后改会话头 cwd（需 daemon IPC） | 行菜单 + IPC |
| 5 | 空间组颜色标记 | 组头色点八色循环，`zw:space-colors` 持久化 | 组头 |
| 6 | 组内搜索 | 组头放大镜 → 组内标题过滤（复用 round15 filterPred 单组版） | 组头 |
| 7 | 空间组统计 | 组头右侧「N 会话 · M 运行中」小字 | 组头 meta |
| 8 | 批量移动 | 多选态（round15）菜单加「移动到空间…」批量 | 多选 bar |
| 9 | 未分组兜底 | cwd 为空的会话归「未分组」组而非散落 | groupSessions |
| 10 | 空间组排序记忆 | 与 #3 同一存储；本轮明确「组顺序跨启动持久」验收 | localStorage |

> #4/#8 依赖 daemon 侧改会话头 cwd 的 IPC（sessionUpdateCwd）。若 daemon 侧改动超预算，
> 降级方案：移动=「记录偏好映射 zw:space-move（sessionPath→cwd）」，渲染层按映射归组展示，
> daemon 头不动（零风险，但重装后映射仍在 localStorage）。

## 验收标准

- 每项：build 过 + 真实 Electron 截图 ≥1 张（tests/e2e/ui-round16-shots.mjs）
- 新逻辑补单测/e2e；lint:all / npm test / 既有 GUI 用例全绿
- CHANGELOG [Unreleased]；PR 正文 Closes #338；CI 全绿 squash 合并；guard release；截图内嵌交付

## 硬约束（沿用十五轮教训）

- 零新依赖；app.css 只追加 §33；手写 createElement；jsx(Comp, {}) 永远带第二参
- 懒渲染组件引用的 prop 名先 grep 核对；新 state 声明在引用它的 effect 之前（TDZ）
- 矮视口铁律：CDP 1024×679 过 focus-mode（composerBottom≤home）
- python 替换逐段写入+即时校验；grep 具体标识符；check:unicode 必过；不推 main；不 force push
- daemon 环境变量注入（不用 import("electron")）；折叠/隐藏类用 CSS 方案（DOM 全量保留）
- e2e 种子会话 cwd 必须是 join(WORKSPACE_DIR,"临时任务",auto) 形态（进任务区且 resume 校验通过）
- resumeSession 需已选模型；等异步 IPC 用 waitUntil「.home 消失」判据
