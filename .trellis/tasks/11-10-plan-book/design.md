# 技术设计：计划书（Plan Book）

## 一、总体结构

```
plan 模式一轮完成
  └─ renderer 捕获最后一条 assistant 文本
       └─ plan-core.parsePlanText()  → { title, steps[] }
            └─ IPC plans:save（daemon 校验 + 版本化 + 原子落盘）
                 └─ <configDir>/plans/<sessionId>.json
                      └─ PlanBook 抽屉读取 / 编辑 / 版本 / 执行
```

数据只在本机；不新增依赖；daemon 只做校验与落盘，不碰 Electron。

## 二、持久化与 IPC

### 文件

`<configDir>/plans/<sessionId>.json`（`getConfigDir()` 与 preferences 同源）：

```json
{
  "sessionId": "…",
  "title": "计划书",
  "steps": [{ "id": "s-…", "text": "…", "done": false }],
  "capturedEntryId": "entry-…",
  "updatedAt": 1790000000000,
  "approvedAt": 1790000000000,
  "approvedVersionId": "v-…",
  "versions": [
    { "id": "v-…", "createdAt": 1790000000000, "source": "agent|manual",
      "title": "…", "steps": [ … ] }
  ]
}
```

- 每次 `save` 把**保存后的**快照追加到 `versions`，最多保留 20 个（丢最旧）。
- 写盘用临时文件 + `rename`（同 pin/store 的原子写法）。
- 读盘损坏 / 形状不符 → 返回 `null`（空态可见），不抛错；写盘失败必须抛错，让 UI 显示原因。

### 校验（daemon）

| 字段 | 规则 |
| --- | --- |
| sessionId | `/^[A-Za-z0-9._-]{1,128}$/`，拒绝路径分隔符 |
| title | trim 后 1–80 字符，缺省「计划书」 |
| steps | 1–50 条；每条 text trim 后 1–500；done 布尔；id 可选（缺失时 daemon 生成 `s-<timestamp>-<n>`） |
| source | `agent` / `manual` |
| capturedEntryId | 可选，≤128 |

### IPC（`src/shared/ipc.js` → `preload` → daemon handler）

- `plans:get` `(sessionId)` → plan 或 null
- `plans:save` `(sessionId, input)` → 保存后的完整 plan
- `plans:approve` `(sessionId, versionId?)` → 更新 `approvedAt` / `approvedVersionId`
- `plans:delete` `(sessionId)` → `{ ok: true }`

`preload` 暴露：`getPlan` / `savePlan` / `approvePlan` / `deletePlan`。
非 `MAIN_HANDLED` 的 INVOKE 会自动转发 daemon，main 不需要改。

### 新增文件

- `src/main/daemon/plans-store.js`：`PlanStore` 类（`get/save/approve/remove`），
  构造函数接收目录，便于单测用临时目录。
- `src/main/daemon/session-files.js`：实例化 + 四个 handler。

## 三、渲染层纯逻辑（`src/renderer/src/plan-core.js`）

```js
parsePlanText(text)            // → { title, steps: string[] }
addStep(steps, text)           // 末尾追加（返回新数组）
updateStep(steps, id, text)
removeStep(steps, id)
moveStep(steps, id, delta)     // 上移 -1 / 下移 +1
toggleStep(steps, id)
stepStats(steps)               // { done, total, percent }
diffStepLists(a, b)            // LCS 行级差异：[{ kind: "same"|"add"|"del", text }]
planToMarkdown(title, steps)   // 导出文本
```

解析规则：

- 标题：第一行匹配 `计划[:：]`（可带 `#`）；否则「计划书」。
- 步骤：匹配 `^\s*\d+[.、)]\s+(.+)$`；去掉行内 `**`。
- 一条编号步骤都解析不到时：按空行切段，整段作为一步（不丢内容）。
- 上限 50 步，超出截断并在 UI 说明。

## 四、渲染层结构

### 状态与捕获（App 内新 hook `usePlanBook(conversation)`）

- 以 `conversation.state.sessionId` 为键加载计划；会话切换重新加载。
- 捕获条件：`interactionId === "plan" && !isStreaming`，取最后一条 `role === "assistant"`
  且 `text` 非空的条目；若 `entry.id !== plan.capturedEntryId` → `savePlan(source: "agent")`。
- 捕获成功后：更新本地 plan、`zw:toast` 一条「计划书已生成」+ 动作「查看计划书」
  （toast 的 `action.run` 已在 #342 支持）。
- 同一 entry 不重复捕获；手动编辑后 `capturedEntryId` 保持不变，避免下次渲染覆盖。

### 入口

- 会话页顶部工具条（`headerActions`）新增「计划书」按钮：
  - 有步骤 → 显示 `计划书 · N` 徽标；无计划 → 在 plan 模式下仍显示，点了进空态。
- 命令面板新增 `action:plan-book`「打开计划书」。
- 抽屉关闭时保留状态。

### 抽屉（`PlanBook`）

- 右侧滑出，`width: clamp(380px, 44vw, 560px)`，高度撑满内容区，玻璃面 + 阴影。
- 结构：
  ```
  计划书                         [草稿/已批准] [×]
  ────────────────────────────────
  ▓▓▓▓▓░░░  3 / 6 完成 · 刚刚更新
  ────────────────────────────────
  ① 读一遍现有文档          [✓] [编辑] [↑↓] [删除]
  ② 统一术语表              [ ] …
  [+ 新增一步]
  ────────────────────────────────
  [执行全部]  [复制 Markdown]  [版本 3]
  ```
- 步骤卡：序号徽标、正文、完成勾选；hover / focus 显示操作，键盘可达。
- 行内编辑：点正文或「编辑」→ **单行 input**；Enter 保存，Esc 取消。
  步骤正文在 `plan-core.cleanStepText` 里已经把换行折成空格（一条步骤 = 一行），
  所以不再用 textarea 的 `Shift+Enter` 换行承诺（2026-11-10 设计复检 P2-18）。
  空文本不静默回滚：留在编辑器里报原因，失焦也不关，按 Esc 才放弃。
- 版本：底部「版本 N」打开浮层，列出 `v3 · 11:32 · 手动编辑`；点条目看快照差异
  （新增绿 / 删除红 / 未变灰），可「恢复此版本」（恢复形成新版本）。
- 空态：说明「在计划模式下问一次，生成后自动出现在这里」+ 关闭。
- 错误态：读取/保存失败显示原因 + 重试，不静默。

### 执行

- **执行全部**：`changeInteraction("craft")` → `submit("按下面的计划开始执行：\n\n" + planToMarkdown(...))`
  （使用**编辑后**的计划文本，而不是聊天里的旧计划）。
- **执行这一步**：`changeInteraction("craft")` → `setPendingPrefill("执行计划第 N 步：" + text)`；
  由用户确认发送。
- **复制 Markdown**：`planToMarkdown` 写剪贴板，复用现有复制反馈。

## 五、样式（app.css 追加 §40）

- **内容面用实色 `--surface-1`，不用玻璃**：计划书是一份要逐条读的文档，
  按 `DESIGN.md §12` 的纸面处理；玻璃面继续留给侧栏 / 输入卡 / 命令面板。
  左侧 1px `--border` + `--shadow-lg` 保留抽屉的边界语言。
- 从工具条下缘开始：`top = env(titlebar-area-height, 0px) + 44px + --space-2 + 2px`
  （44 是标称 header 高，后两项是实测的 `.chat` 外边距与 17px 返回图标补偿）。
- 只用 token：`--surface-1` / `--border` / `--shadow-*` / `--accent` / `--ok` /
  `--danger` / `--text-*` / spacing token。
- 抽屉滑入只动 `transform` / `opacity`；`prefers-reduced-motion` 下关停。
- 暗色自动继承；步骤完成态用删除线 + `--text-secondary`，状态不只靠颜色。
- 窄窗（≤899px）：抽屉全宽。

## 六、测试

### 单元

- `tests/unit/plan-core.test.mjs`：解析（编号 / 无编号 / 标题 / 上限）、增删改移勾选、
  进度、Markdown、差异（增/删/不变/空）。
- `tests/unit/plans-store.test.mjs`：校验拒绝（路径穿越、超长、空步骤、非法 source）、
  版本上限 20、跨实例读回、损坏 JSON → null、删除。

### GUI（`tests/e2e/gui-plan-book.mjs`，接入 `test:gui`）

1. mock 模型 + 注册 provider；用 `/plan` 切到计划模式，发一条消息，mock 返回编号计划。
2. 断言：会话页出现「计划书」按钮且带步骤数；打开抽屉看到步骤卡。
3. 编辑第 2 步并保存 → 文本更新；版本号 +1；版本浮层能看到差异。
4. 勾选一步 → 进度变化；重启窗口（关闭再打开设置？）后仍在——用重新加载页面验证读回。
5. 「执行这一步」→ 输入框被填入该步骤；「执行全部」→ 切到创作模式并发出带计划文本的消息。
6. 浅色 / 暗色截图各一张。

### 回归

- `npm run lint:all`、`npm test`、`npm run test:gui`（全量）、`check:unicode`。

## 七、风险与取舍

- **捕获时机**：plan 模式下模型可能多轮工具调用后才出最终文本；仅取最后一条 assistant
  文本且不 streaming 时保存，避免中间态。
- **编辑与聊天记录分叉**：编辑后的计划书是「当前事实」，执行时显式发送编辑后的文本，
  不依赖聊天里的旧计划。
- **版本体积**：20 版 × 50 步 × 500 字上限 ≈ 500KB/会话，可接受；超过上限丢最旧。
- **不做跨会话计划列表**：v1 聚焦单会话；`plans:list` 留给后续「资料库」聚合。
