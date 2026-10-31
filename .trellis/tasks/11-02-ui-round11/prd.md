# PRD · 第十一轮十连——「长会话的可读性与掌控」

任务目录：`.trellis/tasks/11-02-ui-round11/`　分支：`feat/ui-round11`　issue：#312　日期：2026-11-02

## 背景

#310 审计确认了长会话的核心痛点是「信息过载 + 找不到」。本轮十项全部围绕**读长会话**这件事：

## 十项清单

| # | 功能 | 说明 | 主要落点 |
| --- | --- | --- | --- |
| 1 | 会话大纲浮层（⌘P） | 全部轮次的提问列表（编号+截断预览），点选平滑跳转；Esc 关闭 | ChatView keydown + OutlineSheet 组件 |
| 2 | 折叠全部/展开全部 | 会话工具条按钮，一键折叠所有 plan 过程组（turnFoldCache 批量写） | ChatView 工具条 |
| 3 | 会话内查找 | 工具条放大镜：输入词 → 全部命中 <mark> 高亮 + 「N 处」计数，Esc 清除 | ChatView + 复用 round9 walk TEXT_NODE 手法 |
| 4 | 超长回答折叠 | assistant 回复 >60 行默认收起为「已折叠 · 约 N 行」+ 展开/收起 toggle | renderEntry assistant 分支 |
| 5 | 阅读时间估计 | 长回答折叠条上显示「约 N 分钟」（中文 400 字/分钟，向上取整） | 同上 |
| 6 | 标题锚点 | markdown h2/h3 hover 出现 ⚓ 按钮，点击复制 `${sessionPath}#${slug}` | Markdown components.h2/h3 |
| 7 | 打印样式 | @media print：隐藏侧栏/输入框/工具条，正文白底黑字分页 | app.css §28 |
| 8 | 选中即操作条 | assistant 正文选中文字时浮出「复制」迷你条（去重 entry-toolbar 路径） | document selectionchange |
| 9 | 会话字号调节 | 会话工具条 A-/A+（13–18px 步进 1，localStorage zw:chat-font-size） | ChatView + CSS var |
| 10 | 已读位置灯 | 深色主题恢复阅读位时给目标行加 2s 的高亮渐隐（与 round9 toast 并存） | ChatView 恢复逻辑处 |

## 验收标准

- 每项：build 过 + 真实 Electron 截图 ≥1 张（tests/e2e/ui-round11-shots.mjs）
- 新逻辑补单测/e2e 断言；lint:all / npm test / 既有 GUI 用例全绿
- CHANGELOG [Unreleased]；PR 正文 Closes #312；CI 全绿 squash 合并；guard release；截图内嵌交付

## 硬约束

- 零新依赖；app.css 只追加 §28 段；手写 createElement
- 矮视口铁律：CDP 1024×679；同一信息只出现一次（#310 原则）
- grep 具体标识符；python 替换先 print(repr)；check:unicode 必过；不推 main；不 force push
