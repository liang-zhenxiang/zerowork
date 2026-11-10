# PRD · 第二十轮十连——「协作与知识沉淀」

任务目录：`.trellis/tasks/11-11-ui-round20/`　分支：`feat/ui-round20`　issue：#363　日期：2026-11-11

## 背景

十九轮后单机体验完整。第二十轮把会话产出变成可复用资产：片段、模板、导出物的
再组织与再利用。

## 十项清单（先逐项查重）

| # | 功能 | 说明 | 落点 |
| --- | --- | --- | --- |
| 1 | 片段插入直达 | ⌘K 搜片段已有（#316）；palette 片段条目 run 已复制——补「插入当前会话草稿」分支（会话打开时） | CommandPalette hitEntries/片段条目 |
| 2 | 模板排序 | zw:templates 加 lastUsedAt；Composer 模板 chips 按最近使用排序 | Composer templates |
| 3 | 会话清单 CSV | bulk-bar 加「导出清单」：多选会话导出 CSV（标题/消息数/最后活跃） | bulk-bar |
| 4 | 分享卡 v2 | drawStatsShareCard 加徽章行（已解锁徽章名列表） | drawStatsShareCard |
| 5 | 周报生成器 | StatsView「生成本周摘要」：7 天汇总文本复制到剪贴板（会话/消息/token/活跃天） | StatsView |
| 6 | 短语导入导出 | QuickChipsEditor 导入/导出 JSON（文件下载 + 文件选择） | QuickChipsEditor |
| 7 | 片段分类标签 | zw:snippets 条目从字符串升级 {text, tag?}；存片段浮条加可选标签输入；向后兼容旧字符串 | selection-bar + snippet-core |
| 8 | 模板变量 | 模板文本支持 {{date}}/{{workspace}}，applyChip 时替换 | Composer applyChip |
| 9 | 会话合集预览 | bulk-bar 加「合并预览」：按时间串联选中会话的只读浮层 | bulk-bar |
| 10 | 知识库聚合 | 资料库页头部加三区统计卡（片段数/模板数/导出物数） | LibraryView |

## 验收标准

- 每项：build 过 + 真实 Electron 截图 ≥1 张（tests/e2e/ui-round20-shots.mjs）
- lint:all / npm test / 既有 GUI 用例全绿
- CHANGELOG [Unreleased]；PR 正文 Closes #363；CI 全绿 squash 合并；guard release；截图内嵌交付

## 硬约束（沿用十九轮教训）

- 零新依赖；app.css 只追加 §40；jsx(Comp, {}) 永远带第二参
- **unset ELECTRON_RUN_AS_NODE** 再跑 build/e2e（DSH 注入变量，#345 硬坑）
- aria-label 唯一；TDZ：state 声明在引用之前；e2e 种子 assistant 带 model+usage
  （usage 缺失会触发 stats 空态 empty2，藏住统计页内容——#355 教训）
- python 替换逐段写入+即时校验；CSS 段追加后逐张 read_image 自查（#351 教训）
- check:unicode 必过；不推 main；不 force push；daemon 不 import("electron")
- pi 隐形契约：listAll 标题读 session_info 条目（appendSessionInfo），header.title 只是兜底
