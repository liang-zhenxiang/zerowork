# 会话置顶：把常用的会话钉在最上面

## Goal

侧栏的会话列表**只有一种顺序：最近活动在前**（`groupSessions` 的 `byModifiedDesc`）。
于是有一个必然结果：**你越常用的会话，越会被新会话挤下去**。

具体到用户身上有两处真实的摩擦：

1. **每次都要翻**。同时开着三五个项目时，「接着上次那件事做」要先在列表里扫一遍标题
2. **会被折叠藏起来**。任务分区只显示 5 行（`TASKS_COLLAPSED_COUNT`），
   第 6 条起收进「查看更多」—— 常用的那条一旦掉出前 5，就要多点一次才看得见

本轮给会话加**置顶**：置顶的会话排在各分区最前、行上带钉标记、状态跨重启保持。
它解决的是「我有一个长期在做的会话，我要它一直在手边」，而不是「我要自己排列表」。

## 背景：已核实的事实（全部一手读代码，非转述）

| 项 | 结论 | 出处 |
| --- | --- | --- |
| 会话列表数据 | `listSessions()` 返回 `{id, path, title, name, cwd, isTempTask, createdAt, modifiedAt, messageCount, current, running, archived}` | `src/main/daemon/session-files.js:3305` |
| 侧栏怎么分区 | `groupSessions(summaries, metas)` 分「任务（`isTempTask`）/ 空间（按 cwd 分组）」，各自 `byModifiedDesc` | `src/renderer/src/app.js:13850` |
| 归档怎么持久化 | 配置目录的 `archive.json` 索引（path → 时间戳），**只动索引、不动会话文件** | `src/main/daemon/archive.js` |
| 归档怎么刷新界面 | `INVOKE.sessionArchive` → `pushTaskListChanged()` → 推送 `PUSH.taskListChanged` → 侧栏重读 | `session-files.js:4090`、`app.js:67990` |
| 行内操作钮 | **只有一个「⋯」**，动作全收进 `.task-op-menu`（2026-09-16 的刻意决定：四个 20px 图标并排在窄栏里挤成一簇） | `app.css:1346` 的注释 |
| 扇出通道 | `src/main/index.js:380` 对 `Object.values(INVOKE)` 统一转发，**不需要**逐通道注册 | `src/main/index.js:380` |
| 置顶是否已存在 | **不存在**。`置顶` 在渲染层只出现在「当前工作空间置顶」（issue #73），与会话无关 | `app.js:13640` |

## Requirements

### R1 数据（daemon）

- 新增**独立索引** `pins.json`（path → 置顶时刻），与 `archive.json` 同形态：
  不碰会话文件、不改 pi 的条目、损坏/缺失一律当空索引
- 目录不存在时**自动创建**；写入走 `临时文件 + rename`，避免半截 JSON
- 幂等：反复置顶同一条不重复落盘；取消一条未置顶的也不落盘
- `listSessions()` 的每个元素带 `pinned`，**不改动既有字段的语义**

### R2 接口

- 新通道 `session:pin`，入参 `(path, pinned)`；`shared/ipc.js` 与 `preload/index.js`
  **两处都要登记**（这是本仓库既有的双写形态，`preload` 有自己的一份通道表）
- 变更后推 `taskListChanged`，侧栏即时重排（复用归档那条通路，不新造推送）

### R3 界面（渲染层）

- 置顶的会话在**各自分区内**排到最前（任务区、每个空间区各自生效），
  分区之间（空间组的先后）**保持既有规则不变**
- 置顶行有**可扫读的标记**；标记承担状态，**不靠新增颜色**（DESIGN.md §2.1 / §7.6）
- 切换置顶的入口放进既有的 `⋯` 菜单（`.task-op-menu`），文案随状态切换
  （未置顶显示「置顶」，已置顶显示「取消置顶」）——
  **不加第二个 hover 浮现的行内按钮**：那会推翻 `app.css:1346` 记录的刻意决定
- 置顶后行会移动，用户要能立刻确认发生了什么（标记出现在行上 + 行移到最前）

## Acceptance Criteria

- [ ] `npm run lint:all` / `npm test` / `npm run test:gui` 全绿，既有用例**一条不少**
- [ ] 置顶 → 该会话移到所在分区最前，行上出现钉标记；取消置顶 → 回到按最近活动排序
- [ ] **重启应用后仍是置顶**（`pins.json` 落盘为证）
- [ ] **被折叠的第 6 条会话置顶后可见**（置顶与 5 行折叠的相互作用是明确的）
- [ ] 归档 / 删除 / 重命名**不牵连**置顶记录，且不会因此崩（边界情形逐条有用例）
- [ ] 坏的 `pins.json`（非法 JSON / 非对象）**不炸列表**，按「没有置顶」处理
- [ ] 浅色 + 深色两套主题截图各一张（`h.shoot` 像素断言），人工看过
- [ ] **反向验证**：把排序里的置顶优先去掉 → 对应用例恰好变红；
      把 `pins.json` 的落盘去掉 → 重启持久化用例变红（两条都真跑并记录）
- [ ] `CHANGELOG.md` 的 `[Unreleased] → 新增`、`docs/USAGE.md` 的会话一节、Roadmap（Issue #21）同步
- [ ] 中文内容 U+FFFD 扫描通过

## 约束

- **不放宽任何安全约束**：`pins.json` 只是路径索引，不新增任何「按路径读文件」的通道
- **不动 `resources/**`**，不新增第三方依赖
- 渲染层改动**外科手术式**（`app.js` 是 6.8 万行的 chunk 文件，红线 6）
- 不新增设计 Token 档位；确需新 token 时先改 `docs/DESIGN.md` 写明理由

## 非目标（明确不做，写下来避免下一轮重新论证）

- **手动拖拽排序**：置顶回答的是「这几条要一直在手边」，自由排序是另一个功能
  （要处理顺序持久化、跨设备、分组内部一致性），本轮不做
- **命令面板 / 首页最近会话体现置顶**：那是另一处排序口径，本轮不摊开
- **置顶分区标题**：侧栏只有 236px 且已有一层「任务 / 空间」分组，
  再加一层分组标题换来的收益不抵视觉重量（同 §2.1「状态由形态与位置承担」的思路）

## 入手位置

- `src/main/daemon/config-paths.js`（`getArchiveFile` 旁边加 `getPinsFile`）
- 新建 `src/main/daemon/pin.js`（照 `archive.js` 的形态）
- `src/main/daemon/session-files.js:1740`（实例化）、`:3305`（`listSessions` 加字段）、`:4090`（加 INVOKE 分支）
- `src/shared/ipc.js`（`INVOKE.sessionPin`）+ `src/preload/index.js`（同名通道 + `pinSession`）
- 新建 `src/renderer/src/session-pin.js`（纯函数：置顶优先的稳定排序，供单测直接 import）
- `src/renderer/src/app.js:13850`（`groupSessions` 用纯函数排序）、`:13296`（行渲染）、`:68921`（传回调）
- `src/renderer/src/app.css:1253` 附近（`.task-item*` 一段）与 `:1596`（`.task-unread-dot` / `.task-branch-mark` 同伴）
- `tests/unit/`、`tests/e2e/session-pin.mjs`、`package.json` 的 `test:gui:*` 链

## 难度

中。逻辑本身不复杂，难在**边界**（归档/删除/重命名/损坏索引/折叠 5 行）
与**不推翻既有刻意决定**（行内只留一个 ⋯）。
