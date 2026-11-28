# PRD · 第三十五轮十连——「效率快捷键与检索匹配」

任务目录：`.trellis/tasks/11-29-ui-round35/`　分支：`feat/ui-round35`　issue：#512　日期：2026-11-29

## 背景

原定「空间与工作区管理」查重后十项全为 round16 已有实现——改选
**效率快捷键补全**（新快捷键 + 键盘路由单测 + 拼音首字母匹配回填）。

## 十项清单

| # | 功能 | 落点 |
| --- | --- | --- |
| 1 | ⌘⇧C 复制最后回复 | 键盘路由 + clipboard |
| 2 | ⌘⇧A 归档当前会话 | 键盘路由 + archiveTask |
| 3 | ⌘G 跳到最新消息 | 键盘路由 + scrollTo bottom |
| 4 | ⌘L 聚焦输入框 | 键盘路由 + textareaRef.focus |
| 5 | Esc 清空任务过滤 | task-filter 的 Esc 已有（查重达标，双语义已有） |
| 6 | 拼音首字母匹配 | session-search-core 零依赖小字表（常用 100 字） |
| 7 | ⌘⇧N 新建任务别名 | 查重（⌘N 已有则达标） |
| 8 | 速查表更新 | SHORTCUT_SHEET 加新条目 |
| 9 | 快捷键冲突检测 | 新键注册前查重（console.warn） |
| 10 | 键盘路由单测 | 键盘决策纯函数 |

## 硬约束

- 零新依赖；app.css §63；拼音字表放 session-search-core.js（纯函数可单测）
- 键盘路由改动必须过 command-palette/focus-mode 回归（键盘监听密集）
- 小步提交；check:unicode；合并 main 后 grep 覆盖检查
