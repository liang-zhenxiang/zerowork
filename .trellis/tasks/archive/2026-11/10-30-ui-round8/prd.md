# PRD · 第八轮十连——「空间感与效率」

任务目录：`.trellis/tasks/10-30-ui-round8/`　分支：`feat/ui-round8`　issue：#300　日期：2026-10-30

## 背景

七轮迭代后界面已有完整的视觉体系（Aurora Ink）与微交互层。第八轮主题定为
**空间感与效率**：吸收 Raycast（键盘优先）、Linear（层级面包屑）、Arc（空格分区）
的空间导航语言，让熟练用户的操作密度上一个台阶。

## 十项清单

| # | 功能 | 说明 | 查重结论 |
| --- | --- | --- | --- |
| 1 | 面板命中字符高亮 | ⌘K 结果里把 query 命中的字符加高亮（matchRank 已算出区间） | 新做 |
| 2 | ⌘1-9 数字直达侧栏 | 数字键直接切到侧栏第 N 项（与 ⌘K 不冲突） | 新做 |
| 3 | 面包屑路径条 | 会话视图顶部显示「项目 / 任务 / 会话标题」可点层级 | 新做 |
| 4 | 侧栏任务即时过滤 | 任务区过滤框，>3 条任务时出现，过滤时全量展示 | 查重：分组折叠已存在（collapsedCwds + localStorage）；pin 也已存在（session-pin）→ 换此题 |
| 5 | 拖拽排序任务行 | 侧栏任务行拖拽重排，顺序持久化 | 新做 |
| 6 | 多选批量归档 | 任务行多选（⌘点/Shift 点）后批量归档 | 新做 |
| 7 | ⌘E 最近会话快速切换 | 弹出最近 8 条会话，回车直达 | 已有近似（⌘K 最近会话分组），改为：⌘E 直开该分组并聚焦 |
| 8 | 空态键盘引导 | 首页空态下方列出当前可用的 4 个核心快捷键 | 新做（round4 的 home-quick 是胶囊入口，此条是键位说明行） |
| 9 | 多任务运行聚合指示 | ≥2 任务运行时侧栏底部显示「N 个任务运行中」聚合条，点击展开列表 | 新做 |
| 10 | UI 缩放记忆 | Ctrl+=/Ctrl+- 缩放界面，webFrame.setZoomLevel 持久化到 preferences | 新做（查 daemon preferences 是否已有 zoom 字段，有则复用） |

## 验收标准

- 每项：build 过 + 真实 Electron 截图 ≥1 张（harness shots，输出 artifacts/ui-round8-shots/）
- 新交互逻辑补单测/e2e（command-palette/nav/keyboard 各域至少 1 条）
- lint:all / npm test / 焦点用例（focus-mode、route-crawl、dark-polish、offline-covers、stats-share、ui-round7-shots）全绿
- CHANGELOG [Unreleased] 记录
- PR 正文带 Closes #300；CI 全绿 squash 合并；guard release
- 最终回复内嵌全部截图

## 硬约束

- 零新依赖；app.css 只在末尾追加 §25 段；app.js 手写 createElement
- 中文检查 check:unicode 必过；不直接推 main；不 force push
- 教训沿用：矮视口(679)下 hero 任何新增行都要先过 CDP 1024x679 探针；
  app.js grep 用具体标识符；python 替换先 print(repr) 核锚点
