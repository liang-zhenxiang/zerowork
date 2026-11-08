# PRD · 第九轮十连——「沉浸的对话体验」

任务目录：`.trellis/tasks/10-31-ui-round9/`　分支：`feat/ui-round9`　issue：#302　日期：2026-10-31

## 背景

八轮迭代后首页与导航已完成体系化（Aurora Ink / 空间效率）。第九轮把火力集中在**会话页**——用户停留最久的界面。三件事：读回复的质感、发消息的顺手、翻历史的效率。

## 十项清单

| # | 功能 | 说明 | 主要落点 |
| --- | --- | --- | --- |
| 1 | 会话内全文高亮定位 | ⌘K「正文命中」跳回时，除 entry-flash 外把命中词加 <mark> 高亮（复用 round8 的 matchIndices，从 searchFocus 带 query 进 ChatView） | app.js ChatView focusEntry effect |
| 2 | 阅读进度记忆 | 会话滚动位置持久化（localStorage `zw:readpos:<sessionId>`，防抖 800ms），重开自动恢复并 toast「已定位到上次位置」；滚到底视为读完并清除 | ChatView scroll handler + resumeTask 后恢复 |
| 3 | 消息内表格增强 | .md-table 横向可滚（wrapper overflow-x）+ 斑马纹 + hover 行底色 | app.css §26 |
| 4 | 代码块语言徽标 | code-block-card 左上角 lang + 行数徽标（数据已在 CodeBlockCard props） | app.js CodeBlockCard |
| 5 | 复制整轮对话 | turn-group 工具条加「复制本轮」（user+assistant 拼接） | turn-group 渲染处 |
| 6 | 引用上一条回复 | assistant 工具条加「引用回复」（> 前缀填草稿，同 round6 F2 链路 quoteReply） | AssistantActions |
| 7 | 会话统计 | ChatView 头部 meta 行显示 轮数·字数·时长（turnViews 派生，useMemo） | ChatView header |
| 8 | 流式滚动跟随开关 | streaming 时默认跟底；用户上翻 >80px 即暂停 + jump-to-bottom 按钮带「跟随」态；点按恢复 | ChatView scroll（已有 showJumpToBottom 基础） |
| 9 | 夜间自动降亮 | 22:00–6:00 且主题为 light 时首页极光 opacity×0.6（token 层 --aurora-alpha），设置→个性化加「夜间自动柔化」开关（localStorage zw:night-dim，缺省 on） | app.css :root + HomeView |
| 10 | 会话导出 Markdown | 会话工具条加「导出 .md」：frontmatter（标题/日期/模型）+ 分轮正文；kami.sessionExport 已有 HTML 链路，新增 kind:"markdown"（主进程拼字符串落 exports/，零新依赖） | preload + session-files.js + 渲染层按钮 |

## 验收标准

- 每项：build 过 + 真实 Electron 截图 ≥1 张（tests/e2e/ui-round9-shots.mjs → artifacts/ui-round9-shots/）
- 新逻辑补单测（matchIndices 复用已有；session md 导出加 1 条单测）与 e2e 断言
- lint:all / npm test / 既有 GUI 用例（focus-mode、route-crawl、dark-polish、offline-covers、stats-share、prompt-templates、ui-round7/8-shots、command-palette）全绿
- CHANGELOG [Unreleased] 逐条记录；PR 正文带 Closes #302；CI 全绿 squash 合并；guard release；截图内嵌交付用户

## 硬约束（沿用八轮教训）

- 零新依赖；app.css 只追加 §26 段；手写 createElement 无 JSX
- 矮视口铁律：会话页任何新增行先过 CDP 1024×679 探针（focus-mode composerBottom≤home）
- app.js grep 用具体标识符（防 Chart.js 压缩行爆炸）；python 替换先 print(repr) 核锚点；行级替换最稳
- 中文改动后 check:unicode 必过；不推 main、不 force push
