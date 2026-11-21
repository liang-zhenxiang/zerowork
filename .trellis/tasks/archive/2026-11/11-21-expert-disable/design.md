# 设计：专家停用与恢复（#426）

## 1. 偏好层（`src/main/daemon/preferences.js`）

- 新增 `readDisabledExperts(value)`：
  - 非数组 → `undefined`（整块忽略并 `console.error`，与 `readSkillOverrides` 同口径）；
  - 逐项只收非空字符串，去重；全是坏值 → `undefined`。
- `readPreferences` 白名单加 `disabledExperts`（**漏加就是「写进去读不回」**，
  这是本项目踩过的 `updateChannel` 事故，单测要钉住往返）。
- 空数组不落键：写侧删除键（与 `setSkillEnabled` 的读改写同款）。

## 2. IPC（`src/shared/ipc.js` + `src/preload/index.js` + `session-files.js`）

- `INVOKE.setExpertDisabled = "experts:set-disabled"`，payload `[expertId, disabled]`。
- 校验：`expertId` 必须是非空字符串且**存在于当前专家库**（用 `loadExpertsNow()`），
  否则抛错（防止偏好里散落不存在的 id）。
- 写入：读改写 preferences，停用则加入（去重），恢复则移除；空数组删键。
- 返回 `{ disabledExperts: string[] }`（新的完整清单，界面不必再拉一次）。
- 写入后：遍历 `bucketsById`，对 `conversation.state.expertId === expertId` 的桶，
  若宿主已建则 `host.setExpert(expertId)` 重新应用工具面并 emit state
  （人格/技能的跳过由下面的读路径即时生效）。
  宿主未建时只 `updateStateLocally(bucket, {})`？—— 不需要改状态，emit 由下次挂载带上。

## 3. 专家投影与守卫（`session-files.js`）

- `isExpertDisabled(expertId)`：`readPreferences().disabledExperts?.includes(id) === true`。
- `listExperts` 映射：`...expert.disabled ? { disabled: true } : {}`。
- `setExpert`：`id !== undefined && isExpertDisabled(id)` → 抛
  `专家「<id>」已停用，请先在能力库恢复后再使用`；恢复后走原路径。
- `composeSystemPrompt` 的调用点（`buildConversationForBucket`、prompt-switch 的
  `compose`、预览）：停用时传 `expertId: undefined`，于是人格与私有技能段都不进提示词。
  预览页对停用专家也应显示「不含专家人格」——同样传 undefined，并在界面标注。
- `toUseSkills(...)`、`getExpertExtraTools`、`getExpertLabel` 闭包：停用时分别
  视为无专家技能 / 无追加工具 / 无专家行（不把停用专家写给模型）。
- 子代理与团队成员不经过这些闭包（按定义解析），不受影响。

## 4. 宿主状态（`session-host.js`）

- 新增选项 `isExpertDisabled?: () => boolean`。
- `get state()`：`expertId` 存在且停用时加 `expertDisabled: true`（常态不占字段）。
- 渲染层据此在专家 chip 上标「已停用」。

## 5. 界面

### 能力库（`ExpertsView` / `ExpertDetailModal`）

- `expert-gallery-core.js` 的 `filterExperts` 增加选项 `includeDisabled`（默认 false）：
  默认排除 `disabled` 项；计数同源。
- 工具栏加一个开关按钮：「显示已停用（N）」，`aria-pressed`；无停用项时不渲染。
- 卡片：停用项加 `.ex-card-disabled`（降饱和/虚线边 + 角标「已停用」），仍可打开详情。
- 详情：动作区加「停用专家 / 恢复专家」按钮；停用项底部主按钮改为「恢复专家」，
  「使用专家」与快捷提示禁用并说明原因；停用说明文案写明「不删除文件，
  已绑定会话下一轮起不再注入人格，恢复后自动继续」。

### 选择器

- `PlusMenu`（首页与对话共用）、设置里的提示词预览、命令面板：过滤 `disabled`。
- 当前会话绑定的专家被停用时：`ExpertChip` 显示「已停用」小标；
  对话/首页把 `conversation.state.expertDisabled` 传下去。
- 提示词预览：若当前会话专家已停用，选择器回落「不使用专家」，并给一行说明。

## 6. 测试

### 单测

- `tests/unit/expert-preferences.test.mjs`：`readDisabledExperts` 的合法/非法/去重；
  `readPreferences` 往返不丢 `disabledExperts`；空清单不落键（写侧辅助函数若抽出）。
- `tests/unit/expert-gallery-core.test.mjs`：`filterExperts` 默认排除停用项、
  `includeDisabled` 时包含；计数一致。
- 若 `setExpert` 守卫抽成纯函数（`assertExpertSelectable(experts, disabled, id)`），
  单测覆盖；否则由 e2e 覆盖。

### e2e（`tests/e2e/gui-expert-disable.mjs`）

真实 Electron，接进 `test:gui`：

1. 打开能力库详情 → 点「停用专家」→ toast + 卡片标记；
2. 关闭能力库 → 打开专家菜单，断言停用项消失；
3. 恢复 → 菜单重新出现；
4. 选中该专家 → 停用 → 断言 `session_state.expertDisabled === true` 且 chip 标「已停用」；
   发一轮消息（mock 模型）→ 捕获系统提示词，断言不含该专家人格正文；
5. 恢复 → 新消息的系统提示词重新包含人格；
6. 反向验证：临时让 `setExpert` 不检查停用 → 对应断言必红；还原。

### 回归

`gui-expert-gallery`（12）、`gui-settings`（41）、`gui-smoke`（23）、`gui-hooks`（14）。

## 7. 取舍

- **保留绑定而不是清空**：停用是「先不用」，恢复即续；清空绑定会丢失用户的选择，
  且恢复后还要重新选。人格与技能在读路径跳过，做到「绑定还在、能力不进模型」。
- **不把 disabled 写进专家定义**：定义是磁盘上的内容，偏好是用户层的投影；
  `listExperts` 在投影时叠加。
- **不在 `loadExpertsNow` 过滤**：画廊与「显示已停用」需要看到它们；过滤发生在
  选择器与提示词组装两处读路径。
