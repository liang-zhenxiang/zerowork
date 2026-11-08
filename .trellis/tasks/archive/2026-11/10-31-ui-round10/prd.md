# PRD · 第十轮十连——「协作与内容的最后一公里」

任务目录：`.trellis/tasks/10-31-ui-round10/`　分支：`feat/ui-round10`　issue：#304　日期：2026-10-31

## 背景

九轮迭代已完成界面体系（见 docs/DESIGN.md §11–§26）。第十轮聚焦把会话产出送进真实工作流：代码→任务、结论→摘要、清单→可勾选、会话→图片。

## 十项清单

| # | 功能 | 说明 | 主要落点 |
| --- | --- | --- | --- |
| 1 | 代码块一键新建任务 | CodeBlockCard 工具条加「用此代码新建任务」：把代码存 sessionStorage `zw:task-seed`，回首页打开 composer 自动填入围栏代码块 | CodeBlockCard + HomeView composer |
| 2 | 会话摘要卡 | ≥5 轮会话头部折叠出 TL;DR 卡：前 3 条 user 意图截断 + 最后一条 assistant 结论句 | ChatView sessionStats 处扩展 |
| 3 | 待办清单交互化 | markdown `- [ ]` 渲染可勾选 checkbox；勾选态存 localStorage `zw:todos:<sessionId>`；纯前端不影响原文 | Markdown components.li 递归检测 |
| 4 | diff 着色 | 代码块语言为 diff 时按行首 +/- 染绿/红底 | CodeBlockCard highlight 层 |
| 5 | 图片预览 | 会话内 img 点击→lightbox（90vw、Esc/点击关闭、滚轮缩放 0.5–3x） | ChatView 全局 Lightbox 组件 |
| 6 | J/K 任务跳转 | 全局 keydown：非输入焦点时 J/K 切换侧栏选中任务行（复用 task 行 onClick）；输入框/textarea focus 时不劫持 | App keydown |
| 7 | 常用分组置顶 | 命令面板收藏条目（favorites 已有）聚合成「常用」组置顶（空 query 时显示） | paletteIdleEntries |
| 8 | 截当前会话为 PNG | ⌘⇧S：SVG foreignObject 包 .chat 内层 → canvas → PNG 落 exports/（零依赖；跨域资源降级 toast 说明） | ChatView keydown + IPC 复用 statsShare kind:"session" |
| 9 | 翻译悬停入口 | assistant 段落 hover「译」按钮（占位 IPC：toast「翻译通道未配置」；后续接 provider） | Markdown p 组件 |
| 10 | 版本差异摘要 | 设置→关于：首次安装版本（preferences.firstVersion）与当前版本的功能条目对照（读 CHANGELOG 解析两版本间新增条数） | AboutSection + daemon preferences |

## 验收标准

- 每项 build 过 + 真实 Electron 截图 ≥1 张（tests/e2e/ui-round10-shots.mjs → artifacts/ui-round10-shots/）
- 新逻辑补单测/e2e；lint:all / npm test / 既有 GUI 用例全绿
- CHANGELOG [Unreleased]；PR 正文 Closes #304；CI 全绿 squash 合并；guard release；截图内嵌交付

## 硬约束（沿用九轮教训）

- 零新依赖；app.css 只追加 §27；手写 createElement
- 矮视口铁律：CDP 1024×679 探针过 focus-mode（composerBottom≤home）
- grep 用具体标识符；python 替换先 print(repr) 核锚点；行级替换最稳
- 中文改动 check:unicode 必过；不推 main；不 force push
