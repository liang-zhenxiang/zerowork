# PRD · 第二十六轮十连——「通知与提醒」

任务目录：`.trellis/tasks/11-20-ui-round26/`　分支：`feat/ui-round26`　issue：#439　日期：2026-11-20

## 背景

长任务跑完用户可能切走了窗口。本轮把「完成」从应用内 toast 升级为系统级闭环：
通知→免打扰→点击回跳→Badge→聚合。

## 十项清单（查重结论）

| # | 功能 | 查重 | 本轮落点 |
| --- | --- | --- | --- |
| 1 | 任务完成系统通知 | round17 toast 是应用内；**补**系统级 Notification（渲染层 new Notification()） | 任务完成钩子 |
| 2 | 免打扰时段 | 无既有 | 设置页时段选择（22:00-08:00 默认关） |
| 3 | 通知点击回跳 | 无既有 | Notification.onclick → 聚焦窗口 + 跳对应会话 |
| 4 | 后台 Badge | 无既有 | document.hidden 时 dock badge（main 进程 API） |
| 5 | 完成音效 | 无既有 | Web Audio 短音（可选开关，默认关） |
| 6 | 通知设置组 | 无既有 | 通知设置组（开关/免打扰/Badge/音效） |
| 7 | 流式超时提醒 | round17 有 stop 确认；**补**：流式 60s 无增量提示 | ChatView |
| 8 | 队列完成通知 | 无既有 | drainQueue 完成时通知 |
| 9 | 通知历史 | 无既有 | 通知中心面板（内存态最近 20 条） |
| 10 | 聚合通知 | 无既有 | 5 分钟内 ≥3 个任务完成 → 聚合为一条 |

## 技术要点

- 系统通知走渲染层 `new Notification()`（Electron 支持，免新 IPC 通道）
- 点击回跳：Notification.onclick → window.focus() + 自定义事件 zw:open-session（App 已有监听模式）
- Badge：main 进程 app.dock.setBadge（macOS），经既有 INVOKE 通道扩展或复用 setBadgeCount
- 免打扰判定：纯函数（时段跨零点），单测覆盖
- ⚠️ 第 25 轮教训：改动后立即小步提交；合并 main 后 grep 检查本轮改动是否被覆盖

## 验收标准

- 每项 build 过 + 真实 Electron 截图/DOM 断言 ≥1（tests/e2e/ui-round26-shots.mjs）
- lint:all / npm test / 既有 GUI 用例全绿
- CHANGELOG [Unreleased]；PR Closes #439；CI 绿合并；guard release；交付截图
