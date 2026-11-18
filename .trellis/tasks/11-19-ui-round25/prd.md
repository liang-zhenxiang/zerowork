# PRD · 第二十五轮十连——「会话内导航与定位」

任务目录：`.trellis/tasks/11-19-ui-round25/`　分支：`feat/ui-round25`　issue：#432　日期：2026-11-19

## 背景

大部分导航原语已存在（大纲/回底/阅读位置/折叠/查找/锚点复制）。本轮补齐
「锚点跳转反馈」「TL;DR 跳转」「标尺点击定位」「最近编辑直达」四个缺口。

## 十项清单（查重结论）

| # | 功能 | 查重 | 本轮落点 |
| --- | --- | --- | --- |
| 1 | 轮次大纲 ⌘P | 已有（#312） | — |
| 2 | 回到底部 | 已有（round9） | — |
| 3 | 阅读位置记忆 | 已有（round9） | — |
| 4 | 工具调用折叠 | 已有（SegmentFold） | — |
| 5 | 代码块折叠 | 已有（round13） | — |
| 6 | 会话内查找 | 已有（#286） | — |
| 7 | 锚点跳转高亮 | heading 复制已有；**补**：带 #hash 打开会话时滚动+高亮目标标题 | ChatView |
| 8 | TL;DR 卡跳转 | TL;DR 已有；**补**：意图行点击 → 跳对应轮 + flash | TL;DR 卡 |
| 9 | 标尺点击定位 | 标尺显示已有；**补**：点击/拖动标尺按百分比滚动 | time-ruler |
| 10 | 最近编辑定位 | **新做**：任务行悬浮显示最后编辑文件，点击开预览 | Sidebar 行 |

## 验收标准

- 每项 build 过 + 真实 Electron 截图/DOM 断言 ≥1（tests/e2e/ui-round25-shots.mjs）
- lint:all / npm test / 既有 GUI 用例全绿
- CHANGELOG [Unreleased]；PR Closes #432；CI 绿合并；guard release；交付截图

## 硬约束（沿用二十四轮教训）

- 零新依赖；app.css 只追加 §54（合并后 grep 段号查重）；jsx(Comp, {}) 带第二参
- **unset ELECTRON_RUN_AS_NODE**；TDZ 声明序（tokenOverWindow 事故）；e2e 种子首条消息文本=期望标题
- header 高度是隐性契约（#431 ctx-meter 撑高事故）——新元素放 composer 工具行或 stream 内
- 侧栏自动翻页仅 wheel/touchstart 手势触发；--force-with-lease 仅限本轮临时分支
- python 替换逐段写入+立即 build 校验；check:unicode 必过；merge commit 标题用 chore:
