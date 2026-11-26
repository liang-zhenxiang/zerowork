# PRD · 第三十三轮十连——「审计中心增强」

任务目录：`.trellis/tasks/11-27-ui-round33/`　分支：`feat/ui-round33`　issue：#503　日期：2026-11-27

## 十项清单（查重结论）

| # | 功能 | 查重 | 本轮落点 |
| --- | --- | --- | --- |
| 1 | 工具名筛选 | **新做**：AuditSection 顶部下拉（distinct 工具名） | AuditSection |
| 2 | 风险等级筛选 | 查后定（审计行有 risk 字段则做） | AuditSection |
| 3 | 时间范围筛选 | **新做**：今天 / 7 天 / 全部 | AuditSection |
| 4 | 命中计数 | **新做**：筛选后「共 N 条」 | AuditSection |
| 5 | 单条展开 | 查后定（已有展开则查重达标） | — |
| 6 | 导出 JSON | **新做**：下载 audit-export.json | Blob 下载 |
| 7 | 导出 CSV | **新做**：同源 CSV | Blob 下载 |
| 8 | 清空确认摘要 | **补**：确认框显示当前条数 | 清空流 |
| 9 | 空态文案 | EmptyState 已有 | 查重达标 |
| 10 | 分页 | **新做**：每次 200 条「加载更多」 | AuditSection |

## 硬约束

- 零新依赖；app.css 只追加 §61；审计中心是独立页面，不触首页预算契约
- CSV 导出须转义逗号/引号/换行（RFC 4180）；导出走 Blob+URL.createObjectURL（26 轮 F9 同款）
- python 替换逐段+立即 build；check:unicode；小步提交
