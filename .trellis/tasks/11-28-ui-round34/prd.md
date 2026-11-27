# PRD · 第三十四轮十连——「帮助与文档体系」

任务目录：`.trellis/tasks/11-28-ui-round34/`　分支：`feat/ui-round34`　issue：#508　日期：2026-11-28

## 十项清单（查重结论）

| # | 功能 | 查重 | 本轮落点 |
| --- | --- | --- | --- |
| 1 | 帮助主题分组 | **新做**：HelpSheet 条目按「入门/会话/模型/数据」分组渲染 | HelpSheet |
| 2 | 帮助搜索 | **新做**：浮层顶部搜索框过滤条目 | HelpSheet |
| 3 | 「如何」FAQ | **新做**：常见 8 问折叠组（details/summary 原生元素） | HelpSheet |
| 4 | 文档外链校验 | **查后定**：外链清单在 EXTERNAL_REQUESTS.md 已登记 | 查重达标 |
| 5 | 首次错误指引 | **新做**：连接失败 ErrorState 补「查看诊断」按钮（onOpenDiagnostics 已有链路） | ErrorState |
| 6 | 速查表可打印 | **新做**：HelpSheet「打印」按钮 → window.print + print CSS | HelpSheet |
| 7 | CHANGELOG 入口 | **新做**：关于页「查看完整更新日志」打开仓库 CHANGELOG.md 锚点 | AboutSection |
| 8 | 上下文帮助 | 部分组 title 已有 | 查重达标 |
| 9 | 引导视频 | **降级**（视频制作超出范围） | — |
| 10 | 帮助反馈入口 | **新做**：HelpSheet 底部「提 issue」外链 | HelpSheet |

## 硬约束

- 零新依赖；app.css 只追加 §62；HelpSheet 是浮层（shortcut-sheet 内），
  不动首页布局预算；打印 CSS 用 @media print 独立块
- 外链只在已有登记域名内；clipboard/toast 同步派发
- python 替换逐段+立即 build；check:unicode；小步提交
