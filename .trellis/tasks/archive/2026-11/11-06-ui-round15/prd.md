# PRD · 第十五轮十连——「性能感与可控性」

任务目录：`.trellis/tasks/11-06-ui-round15/`　分支：`feat/ui-round15`　issue：#335　日期：2026-11-06

## 背景

v0.18.0 已发布（ fourteen 轮迭代完成）。第十五轮聚焦两个「感觉」：
**性能感**（界面响应快不快的体感）与**可控性**（长列表/多会话时的批量掌控）。

## 十项清单（含查重结论）

| # | 功能 | 说明 | 状态 |
| --- | --- | --- | --- |
| 1 | 乐观 UI 发送 | 发送立即渲染本地气泡（不等 IPC 回执），失败回滚+toast | 新做 |
| 2 | 会话列表虚拟化 | 侧栏任务 >50 条窗口化渲染（可视区 ±10） | 新做 |
| 3 | 侧栏快速过滤语法 | `label:工作`、`running:true`、`>3d`（N 天未动） | 新做（现有 task-filter 只做纯文本包含） |
| 4 | 拖拽排序持久化 | 任务行拖拽重排，顺序存 preferences | 新做 |
| 5 | 全局 CLI 参数 | `--new "提问"` 直开新任务（second-instance） | 新做 |
| 6 | 会话行内统计条 | 任务行 hover 迷你条：轮数·token·最后活跃 | 复用 #310 的 stats.hoverExtras 模式 |
| 7 | 键盘完整导航 | 侧栏 ↑/↓ 移动、Enter 打开、Space 多选、Del 归档 | 新做（round13 F8 有 Shift+⌘ 点选，本轮补键盘轴） |
| 8 | 加载失败重试 | 统计/会话列表 IPC 失败显示重试按钮 | 新做 |
| 9 | 窗口布局记忆 | 侧栏宽度/面板开合持久化 | 查漏补全（部分已有） |
| 10 | 空闲内存回收 | 无操作 10 分钟卸载非当前会话缓存 | 新做 |

## 验收标准

- 每项：build 过 + 真实 Electron 截图 ≥1 张（tests/e2e/ui-round15-shots.mjs）
- 新逻辑补单测/e2e；lint:all / npm test / 既有 GUI 用例全绿
- CHANGELOG [Unreleased]；PR 正文 Closes #335；CI 全绿 squash 合并；guard release；截图内嵌交付

## 硬约束（沿用十四轮教训）

- 零新依赖；app.css 只追加 §32；手写 createElement；jsx(Comp, {}) 永远带第二参
- 懒渲染组件引用的 prop 名先 grep 核对（#329 教训）
- 矮视口铁律：CDP 1024×679 过 focus-mode（composerBottom≤home）
- python 替换逐段写入+即时校验；grep 具体标识符；check:unicode 必过；不推 main；不 force push
- daemon 环境变量注入（不用 import("electron")）；折叠/隐藏类用 CSS 方案（DOM 全量保留）
- shell heredoc 用引号定界符（<<'EOF'）防变量展开吃掉表格/管道符
