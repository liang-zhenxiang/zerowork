# PRD · 第二十七轮十连——「首启体验与引导」

任务目录：`.trellis/tasks/11-21-ui-round27/`　分支：`feat/ui-round27`　issue：#446　日期：2026-11-21

## 背景

大部分首启引导原语已存在（#409 三步清单/引导整理、⌘/ 速查表、EmptyState、帮助浮层、
开局模板）。本轮补齐「新功能速览浮层」「模型配置引导」「示例任务」与跳过持久化。

## 十项清单（查重结论）

| # | 功能 | 查重 | 本轮落点 |
| --- | --- | --- | --- |
| 1 | 首启清单 | #409 已有 | 查重达标 |
| 2 | 模型配置引导 | 诊断页已有；**补**：无模型时首页顶部提示条「配置模型 → 直达设置/模型」 | HomeView |
| 3 | 示例任务 | 开局模板已有；**补**：模板卡上的「运行示例」按钮（一键填入并演示） | QuickChips |
| 4 | 新功能速览浮层 | **新做**：版本更新后一次性浮层（读 localStorage zw:seen-version，缺当前版本号则弹） | App |
| 5 | 快捷键卡 | ⌘/ 已有 | 查重达标 |
| 6 | 空状态插画/文案 | EmptyState 已有；**补**：侧栏任务空态文案与首页一致性（统一「新建第一个任务」措辞） | Sidebar |
| 7 | 帮助文档链接 | 帮助浮层已有 | 查重达标 |
| 8 | 引导跳过持久化 | **新做**：速览浮层「不再显示」按钮（写 zw:seen-version=当前版本） | 浮层内 |
| 9 | 首启性能感知 | **新做**：首启动 loading 分步提示（按耗时切换文案：<1s「启动中」、>2s「首次启动要准备运行时…」） | 启动遮罩 |
| 10 | 引导完成奖励 | #409 清单完成态已有 | 查重达标 |

## 验收标准

- 每项 build 过 + 真实 Electron 截图/DOM 断言 ≥1（tests/e2e/ui-round27-shots.mjs）
- lint:all / npm test / 既有 GUI 用例全绿
- CHANGELOG [Unreleased]；PR Closes #446；CI 绿合并；guard release；交付截图

## 硬约束（沿用各轮教训）

- 零新依赖；app.css 只追加 §55（合并后 grep 段号查重）；jsx(Comp, {}) 带第二参
- **unset ELECTRON_RUN_AS_NODE**；e2e 种子首条消息文本=期望标题；assistant 带 model
- header 高度是隐性契约（#431 事故）；markdown class 会被重渲染吞（#433 overlay 教训）
- desktop.json 加键必须同步 desktop-behavior.test.mjs 的 fixture（#440 教训）
- 合并 main 后 grep 检查本轮改动是否被覆盖（#433 教训）；改动后小步提交（#433 checkout 事故）
- python 替换逐段写入+立即 build 校验；check:unicode 必过；merge commit 标题用 chore:
