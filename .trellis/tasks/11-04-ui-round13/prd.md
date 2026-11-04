# PRD · 第十三轮十连——「团队协作与自动化入口」

任务目录：`.trellis/tasks/11-04-ui-round13/`　分支：`feat/ui-round13`　issue：#327　日期：2026-11-04

## 背景

v0.18.0-beta.3 之后单机体验完整。第十三轮聚焦**多会话并行与自动化**：Agent 场景下常同时跑多个任务、重复相似提问、需要回顾历史。本轮解决「并行不乱、重复不烦、历史可挖」。

## 十项清单（先逐项查重，已有者标注并替换）

| # | 功能 | 说明 | 主要落点 |
| --- | --- | --- | --- |
| 1 | 任务并行面板 | ≥2 任务运行中时顶部「并行」胶囊弹面板：任务名+状态+进度，点击切换 | Sidebar/taskList |
| 2 | 会话模板 | 会话行菜单「存为模板」；新任务时选模板预填首条提问 | daemon preferences |
| 3 | 批量提问队列 | 输入框「---」分隔多问：发送后排队逐个自动发（可取消） | Composer submit |
| 4 | 历史相似提示 | 新任务首条提问与历史标题相似时 toast「已有相似会话」 | submit 入口 |
| 5 | 会话标签系统 | 会话行彩色小标签（名字+颜色，preferences），侧栏按标签过滤 | preferences schema + Sidebar |
| 6 | 运行时长提醒 | 任务运行 >5 分钟 toast 提醒（可关闭） | taskList effect |
| 7 | 定时会话入口 | 会话菜单「从会话创建定时任务」快捷入口 | 会话菜单 |
| 8 | 会话比较 | Ctrl 点选两个会话 →「比较」：并排显示提问/结论长度/耗时 | Sidebar + 比较浮层 |
| 9 | 归档恢复摘要卡 | 数据管理归档区「恢复」前显示会话摘要卡预览 | DataSection |
| 10 | 会话备注 | 会话行菜单「添加备注」，显示在会话详情头部 | preferences + ChatView header |

## 验收标准

- 每项：build 过 + 真实 Electron 截图 ≥1 张（tests/e2e/ui-round13-shots.mjs）
- 新逻辑补单测/e2e；lint:all / npm test / 既有 GUI 用例全绿
- CHANGELOG [Unreleased]；PR 正文 Closes #327；CI 全绿 squash 合并；guard release；截图内嵌交付

## 硬约束（沿用十二轮教训）

- 零新依赖；app.css 只追加 §30；手写 createElement；jsx(Comp, {}) 永远带第二参
- daemon 是 utilityProcess：不用 import("electron")，版本/路径走 daemonEnv 环境变量
- 折叠/隐藏类用 CSS 方案（DOM 全量保留）；新 state 声明在引用它的 effect 之前（TDZ）
- python 替换逐段写入+即时校验；grep 具体标识符；check:unicode 必过；不推 main；不 force push
