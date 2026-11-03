# 命令面板记住你：收藏置顶 + 常用项自动上浮

## Goal

命令面板（⌘K / Ctrl+K，#109 / PR #109）已经能用，但它是**无记忆的**：同一个条目
每次打开都排在同一位置。于是「我天天用它，它却天天躲在第五屏」——面板给了「一跳直达」，
这层能力却被「每次都要重新找」抵消掉一半。

本轮让它记住两件事：

1. **收藏**（显式、可预测）：用户主动钉住的条目，空查询时置顶；
2. **常用项自动上浮**（frecency）：用得多的条目自己往上走，但**永远不压过匹配质量**。

这也是命令面板那一版 `design.md` §11 明确留下的后续项（当时不做，理由是持久化
需要动 daemon 与 IPC，是独立任务）。本任务就是那一步。

## 背景：已核实的事实

| 项 | 结论 | 出处 |
| --- | --- | --- |
| 面板现状 | 纯渲染层功能，**不新增任何 IPC**；数据全部来自 `App()` 已有 state 与既有 `window.kami.*` | `src/renderer/src/app.js` 的 `CommandPalette` 附近注释 |
| 排序链现状 | `matchRank` 升序 → 类别权重升序 → 原数组索引升序（第三级由稳定排序保证） | `src/renderer/src/command-palette-core.js` 文件头 |
| 条目 id | **已经稳定**：动作 `action:*` / 设置 `settings:*` / 会话 id / 工作空间路径 / 专家与技能名 / 连接器与自动化 id | `paletteActionEntries`、`paletteEntries` 的构造处 |
| 持久化的正确落点 | `preferences.json`（单一真源）；`localStorage` 只做首帧镜像，不是真源 | `.trellis/tasks/.../10-03-command-palette/design.md` §11、`src/main/index.js` 的注释 |
| 读写校验的模板 | `isThemePreference`：读侧丢弃、写侧拒绝，**共用一份枚举**，不会出现「写入时合法、读回时被丢」 | `src/main/daemon/preferences.js`、`session-files.js` 的 `get/set-theme` |
| 空查询的渲染结构 | 结果列表**按 kind 分组**渲染（`paletteGroups`），组序 = 最佳 rank → KIND_WEIGHT；空查询下退化成纯类别权重（动作组永远在最上） | `paletteGroups` |
| 同类产品做法 | Raycast 排序链末位是 frecency 且给 Reset；Obsidian「最近使用」只在**没输入时**生效；Cherry Studio 可把常用项固定 | `.trellis/tasks/archive/2026-10/10-03-command-palette/research/competitor-gaps.md` §一 |

## Requirements

### R1 纯逻辑（可单测，不碰 DOM / 不 import Electron）

- 新模块 `src/renderer/src/palette-memory.js`：
  - `EMPTY_MEMORY` / `normalizeMemory`：形状是 `{ favorites: string[], usage: Record<id, { score, lastAt }> }`；
    非法/缺字段一律降级成空，不抛错。
  - `recordUse(memory, id, now)`：**衰减在写入时算**（`score = score · 2^(-elapsed/halfLife) + 1`），
    读取侧是纯查表。
  - `toggleFavorite(memory, id)`：返回**新对象** + 结果（成功 / 已达上限 / 不存在）。
  - `evict(memory)`：按规模淘汰（收藏与 usage 各有上限），**不按 id 是否存在清理**。
  - `orderIdle(entries, memory, opts)`：空查询的排序 —— 收藏（按收藏顺序）→ 其余按常用分降序 → 原顺序。
- `command-palette-core.js` 的 `rankEntries` 增加**可选** `scoreOf`：插入第四级
  「常用分降序」，位置在类别权重**之后**、原索引之前。不传时行为与现在逐字节一致。

### R2 持久化（照主题偏好那条路的模板）

- `preferences.json` 新增 `paletteMemory` 字段，由 daemon 校验并落盘。
- 新 IPC 两枚：`settings:get-palette-memory` / `settings:set-palette-memory`
  （`src/shared/ipc.js` 与 `src/preload/index.js` 两处都登记）。
- 校验判据**读侧与写侧共用一份**：非法值读取时丢弃、写入时抛错。
- 渲染层：打开面板时读一次；每次收藏切换 / 执行条目时写回（读改写，不丢其他键）。

### R3 界面

- **收藏**：键盘（⌘D / Ctrl+D）与鼠标（行尾星标可点）两条路径都能切换；
  收藏行带**非颜色**标记（实心星形 + 屏读文本「已收藏」）。
- **收藏伪分组**：空查询且有收藏时，列表最上方出现「收藏」组（跨类别，按收藏顺序）。
  理由：结果按 kind 分组，不这样做的话一个被收藏的会话会被类别权重压在动作组下面，
  「置顶」名不副实。
- **空查询的常用上浮**：同组内按常用分降序（稳定）。
- **有查询时**：匹配质量 → 类别权重 → 常用分 → 原顺序（frecency **不压**匹配质量）。
- 底部键位提示写上收藏键（不做假提示）。

## Acceptance Criteria

- [x] `npm run lint:all` / `npx vitest run` 全绿，既有用例一条不少（261 → 更多）
- [x] **单元**：衰减、记录、淘汰、收藏上限、空查询排序、有查询时 frecency 不压匹配质量、
      非法输入丢弃、`rankEntries` 不传 `scoreOf` 时行为不变（回归锁）
- [x] **e2e/GUI**（真实启动 Electron + 截图）：
  - 收藏一个条目 → 关掉重开面板，它在「收藏」组里且带标记
  - 执行一个条目 → 它上浮（同组内位置前移）
  - **真实重启应用** → 收藏与使用记录仍在（daemon 真的落了盘）
  - 不收藏的干净配置下，空查询与现状一致（不引入噪声）
  - ⌘D 的提示与真实键位一致（把提示里的键真的按一遍）
  - 浅色 / 深色两套主题截图
- [x] **反向验证**：至少两条 —— ① 把记忆接进排序的那一处摘掉 → e2e 变红；
      ② 把衰减去掉（写入时不清算旧分）→ 单测变红。两条都真跑并记录
- [x] `CHANGELOG.md` 的 `[Unreleased] → 新增`；`docs/USAGE.md` 的命令面板一节同步
- [x] 中文内容 U+FFFD 扫描通过

## 约束

- **不动 `resources/**`**，不新增第三方依赖。
- **不放宽安全约束**：新通道只读写 `preferences.json`，不接受任意路径。
- 渲染层改动外科手术式（红线 6：`app.js` 是近 7 万行的 chunk 文件）。
- 收藏/使用记录**不按 id 存在性清理**（与「会话置顶」同一条纪律）：条目可能只是暂时
  不可见，那时把用户的选择抹掉才是真的丢东西。清理策略 = 规模淘汰（见 R1 的 `evict`）。

## 非目标（首版不做，写进 design.md 免得下一轮重新论证）

- 搜索时给收藏加权（AC 的排序链里没有它）
- 「Reset Ranking」按钮（Raycast 有，但我们的数据量级不需要；清空只需删一个键）
- 收藏的分组顺序 / 拖拽排序 / 分组上限
- 面板外的 frecency（首页最近会话、侧栏顺序）
- 跨设备同步（本项目本地优先）

## 入手位置

- 新建 `src/renderer/src/palette-memory.js`
- `src/renderer/src/command-palette-core.js`（`rankEntries` 加可选 `scoreOf`）
- `src/renderer/src/app.js`（`CommandPalette`：星标、⌘D、收藏组；`App()`：读写记忆）
- `src/renderer/src/app.css`（星标样式，复用既有 token）
- `src/main/daemon/preferences.js`（校验判据）、`session-files.js`（两枚 handler）
- `src/shared/ipc.js` + `src/preload/index.js`
- `tests/unit/palette-memory.test.mjs`、`tests/unit/command-palette-core.test.mjs`（补），
  `tests/e2e/palette-memory.mjs`（新）、`tests/e2e/bridge-rest.mjs`（补两枚通道）

## 难度

中高。逻辑本身不难，难的是**排序链的位置**：frecency 该排在哪一级是这轮唯一的判断题，
排错就是「我打字了它还拿历史压我」；所以两级排序（有查询 / 空查询）各由一组单测钉死，
且「不传 scoreOf 时行为不变」有一条回归锁。
