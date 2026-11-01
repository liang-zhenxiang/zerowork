# PRD · 第十二轮十连——「导出与复用」

任务目录：`.trellis/tasks/11-02-ui-round12/`　分支：`feat/ui-round12`　issue：#315　日期：2026-11-02

## 背景

v0.16.0（长会话可读性）之后，会话内的内容「读」的问题已解决。第十二轮解决「带走」的问题：
结论、表格、代码、图要能顺畅变成文档、文件、片段，而不是困在对话流里。

## 十项清单

| # | 功能 | 说明 | 主要落点 |
| --- | --- | --- | --- |
| 1 | .md 导出增强 | 导出的 Markdown 头部加目录（从标题行生成）+ 轮次分隔线（---） | session-files.js exportMarkdown 组装处 |
| 2 | 选中存为片段 | 会话选中操作条加「存为片段」：文本+标签进片段库（daemon preferences 存储），⌘K 可搜、可一键粘贴 | 选中操作条 + snippet-core.js（新）+ CommandPalette |
| 3 | 表格复制 CSV | markdown 表格 hover「复制 CSV」：表头+行逗号转义 | Markdown components.table |
| 4 | 代码块存为文件 | code-block-card 菜单「存为文件」：按语言映射扩展名（js/ts/py/json/…），落 exports/ | CodeBlockCard + 复用 statsShare IPC 通道 kind:"file" |
| 5 | 会话海报 | 会话工具条「生成海报」：复用 drawStatsShareCard 画布风格（标题+轮数+前 3 条提问），落 exports/ | ChatView 工具条 + canvas |
| 6 | 导出纯文本 .txt | 会话菜单加「导出为纯文本」：无格式正文 | session-files.js |
| 7 | blockquote 统一 | 会话 markdown blockquote 样式（左 accent 竖条 + 弱底）统一到 §29，导出 md 保持 > 原样 | app.css |
| 8 | exports 可视化 | 设置→数据加「导出产物」区：列 exports/ 内文件（名/大小/时间），点击打开 | DataSection + IPC listExports |
| 9 | 快速短语管理 | 设置→个性化加 quick-chips 编辑器（增删改，≤4 条，localStorage） | PersonalizationSection |
| 10 | 导出水印 | 导出 HTML/海报页脚自动带「由 ZeroWork 生成 · vX.Y.Z」 | 导出组装处 + package.json version 读取 |

## 验收标准

- 每项：build 过 + 真实 Electron 截图 ≥1 张（tests/e2e/ui-round12-shots.mjs）
- 新逻辑补单测（CSV 转义/slug/片段存储至少各 1 条）；lint:all / npm test / 既有 GUI 用例全绿
- CHANGELOG [Unreleased]；PR 正文 Closes #315；CI 全绿 squash 合并；guard release；截图内嵌交付

## 硬约束（沿用十一轮教训）

- 零新依赖；app.css 只追加 §29；手写 createElement
- 矮视口铁律：CDP 1024×679；同一信息只出现一次（#310 原则）
- python 替换逐段写入+即时校验（整段脚本末尾 assert 失败会整体回滚）；新 state 声明必须在引用它的 effect 之前（TDZ 白屏三连）
- grep 具体标识符；check:unicode 必过；不推 main；不 force push
- 折叠/隐藏类功能一律 CSS 方案（DOM 全量保留），不条件渲染正文
