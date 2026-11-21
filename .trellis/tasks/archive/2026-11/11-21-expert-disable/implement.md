# 执行清单：专家停用与恢复（#426）

## 0. 开工

- [x] `.trellis/tasks/11-21-expert-disable` 创建并落盘 prd/design/implement
- [x] 分支 `feat/expert-disable`（从最新 main）
- [x] Issue #426 留言「我开始了」

## 1. 偏好与 IPC

- [x] `preferences.js`：`readDisabledExperts` + `readPreferences` 白名单 + 导出
- [x] `src/shared/ipc.js`：`setExpertDisabled: "experts:set-disabled"`
- [x] `src/preload/index.js`：INVOKE 常量 + `setExpertDisabled(expertId, disabled)`
- [x] `session-files.js`：handler、`isExpertDisabled`、`listExperts` 投影 `disabled`
- [x] `session-files.js`：`setExpert` 守卫
- [x] 单测 `expert-preferences.test.mjs` 先写（红）→ 实现（绿）

## 2. 提示词与宿主状态

- [x] composer 三个调用点：停用时 `expertId: undefined`
- [x] `toUseSkills` / `getExpertExtraTools` / `getExpertLabel` 停用即视为无专家
- [x] `session-host.js`：`isExpertDisabled` 选项 + `expertDisabled` state
- [x] 单测（跳过：setExpert 守卫由 e2e 覆盖）

## 3. 界面

- [x] `expert-gallery-core.js`：`filterExperts` 的 `includeDisabled`
- [x] `ExpertsView`：显示已停用开关、计数、卡片标记
- [x] `ExpertDetailModal`：停用/恢复、停用态主按钮与禁用说明
- [x] `PlusMenu` / 提示词预览 / 命令面板：过滤停用项
- [x] `ExpertChip`：已停用标记；HomeView/ChatView 传 `expertDisabled`
- [x] 样式：`.ex-card-disabled`、`.ex-chip-disabled`（只用既有 token）

## 4. 验证

- [x] `npx vitest run tests/unit/expert-preferences.test.mjs tests/unit/expert-gallery-core.test.mjs`
- [x] `npm run build`（e2e 跑构建产物，改 app.js 后必须重建）
- [x] 新 e2e `tests/e2e/gui-expert-disable.mjs` 真实 Electron 跑通
- [x] 反向验证两条（守卫 / 提示词跳过）均能变红，还原后复跑全绿
- [x] 回归 `gui-expert-gallery` / `gui-settings` / `gui-smoke` / `gui-hooks`
- [x] `npm test`、`npm run check:unicode`、`npm run check:renderer-assets`、`npm run lint:all`
- [x] 设计师子代理评审截图（亮/暗、停用态与详情）—— 3 处必修 + 6 条建议已全部处理

## 5. 收尾

- [x] `CHANGELOG` 新增条目（停用与卸载的区别、已绑定会话语义）
- [x] 文档：`docs/` 中专家/能力库相关段落补一段（若存在），`AGENTS.md` 不需要改
- [ ] 提交（`-F` 文件、无反引号）→ PR（正文含 `Closes #426`）→ `CI 总览` 绿 → squash
- [ ] 归档任务、更新 Roadmap、确认 beta 自动发布
