# PRD · 第十九轮十连——「会话的治理与归档」

任务目录：`.trellis/tasks/11-10-ui-round19/`　分支：`feat/ui-round19`　issue：#354　日期：2026-11-10

## 背景

十八轮后单会话体验完整。第十九轮聚焦**会话全生命周期的治理**：创建→活跃→沉寂→归档，
每个阶段都有整理工具与状态可见性。

## 十项清单（先逐项查重）

| # | 功能 | 说明 | 查重结论/落点 |
| --- | --- | --- | --- |
| 1 | 会话年龄分组 | 任务区按活跃时间分组：今天/本周/本月/更早（可折叠，zw:age-collapsed 持久化） | Sidebar 任务区 |
| 2 | 沉寂会话提示 | >30 天未活跃：行菜单「归档」项旁加「久未活跃」提示文字 | renderTaskRow 菜单 |
| 3 | 会话统计徽章 | 查重：#315 F3 侧栏气泡已做（task-item-count「N 条」）→ **换题**：置顶会话排序记忆已有，改做「未读消息区分」→ 已有 unreadIds。**换题确定**：会话行内「最后活跃 relative time」悬浮提示（title 已有 path，补活跃时间） | renderTaskRow title |
| 4 | 批量归档选中 | 多选浮条（round8 F6 bulk-bar 已有归档？）查重后补缺 | bulk-bar |
| 5 | 归档区搜索 | 数据管理归档列表按标题过滤 | DataManagementSection |
| 6 | 会话复制 | daemon 复制会话文件（重写 header.id + title +「(副本)」）→ INVOKE.sessionCopy + 行菜单 | session-files.js |
| 7 | 空会话清理 | 0 条消息的临时会话：数据管理「清理空会话」带确认摘要（列数量） | DataManagementSection + daemon |
| 8 | 会话导入标记 | 复制产生的副本行显示「副本」小标（依赖 #6） | renderTaskRow |
| 9 | 活跃日历 | 统计页热力图粒度查重后升级或换题（活跃小时分布） | StatsView |
| 10 | 批量导出 | 多选会话「导出为 Markdown」逐个落 exports/（无 ZIP 依赖，串联逐个导） | bulk-bar + IPC 循环 |

## 验收标准

- 每项：build 过 + 真实 Electron 截图 ≥1 张（tests/e2e/ui-round19-shots.mjs）
- lint:all / npm test / 既有 GUI 用例全绿
- CHANGELOG [Unreleased]；PR 正文 Closes #354；CI 全绿 squash 合并；guard release；截图内嵌交付

## 硬约束（沿用十八轮教训）

- 零新依赖；app.css 只追加 §39；jsx(Comp, {}) 永远带第二参
- **跑 build/e2e 前必须 unset ELECTRON_RUN_AS_NODE**（DSH 注入的环境变量，#345 硬坑）
- aria-label 唯一；懒渲染 prop 先 grep；TDZ：state 声明在引用它的 effect 之前
- e2e 种子 cwd=join(WORKSPACE_DIR,"临时任务",auto)；组选择按组名找 index
- python 替换逐段写入+即时校验；CSS 段追加后**必须逐张 read_image 自查**（#351 教训：
  选择器无样式不报错，shots 只断言 DOM 存在拦不住样式丢失）
- check:unicode 必过；不推 main；不 force push；daemon 不 import("electron")
