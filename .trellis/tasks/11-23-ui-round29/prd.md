# PRD · 第二十九轮十连——「会话管理细节」

任务目录：`.trellis/tasks/11-23-ui-round29/`　分支：`feat/ui-round29`　issue：#463　日期：2026-11-23

## 背景

侧栏与任务行的高频微操作打磨。多数原语已有（重命名/拖拽/置顶/空间/折叠记忆），
本轮补真正缺失的三项：复制全文、行级字数、悬浮操作按钮组。

## 十项清单（查重结论）

| # | 功能 | 查重 | 本轮落点 |
| --- | --- | --- | --- |
| 1 | 会话重命名入口 | 行菜单已有 | 查重达标 |
| 2 | 复制会话内容 | **新做**：行菜单「复制全文」——纯文本拼接全文进剪贴板 | daemon handler + 行菜单 |
| 3 | 会话字数气泡 | **新做**：行悬浮 title 补「共 N 字」 | 行 title |
| 4 | 批量置顶 | 查重（⌘多选已有批量归档） | 查重达标 |
| 5 | 拖拽排序提示 | round15 已有 | 查重达标 |
| 6 | 归档批量恢复 | 数据管理页已可恢复；**补**：归档页行内恢复按钮 | 归档页 |
| 7 | 分组折叠记忆 | #379 已有 zw:age-collapsed | 查重达标 |
| 8 | 空间快速切换 | 空间组已有 | 查重达标 |
| 9 | 会话行双击重命名 | **新做**：双击行 = 打开重命名输入 | Sidebar |
| 10 | 行悬浮操作按钮 | **新做**：悬浮显示归档/置顶/复制全文三按钮 | 行 hover |

## 验收标准

- 每项 build 过 + 真实 Electron 截图/DOM 断言 ≥1（tests/e2e/ui-round29-shots.mjs）
- lint:all / npm test / 既有 GUI 用例全绿
- CHANGELOG [Unreleased]；PR Closes #463；CI 绿合并；guard release；交付截图

## 硬约束（沿用各轮教训）

- 零新依赖；app.css 只追加 §57（合并后 grep 段号查重）
- **unset ELECTRON_RUN_AS_NODE**；e2e 种子首条消息文本=期望标题；assistant 带 model
- 首页/侧栏新增 DOM 查 gui-ui-audit/gui-health-bento/focus-mode 预算契约
- clipboard 反馈同步派发 toast；desktop.json 键同步 test fixture
- 合并 main 后 grep 检查改动是否被覆盖；改动后小步提交
- python 替换逐段写入+立即 build 校验；check:unicode 必过
