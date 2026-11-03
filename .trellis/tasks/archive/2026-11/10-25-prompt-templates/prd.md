# 提示词模板库

## 背景

首页「不知道做什么，试试最佳实践案例」是四张写死的卡片：`CASES` 常量 + 「换一批」翻页。
四张卡片的文案、封面、提示词都在源码里，用户既不能改、也不能加。而「每天开工的第一句话」
恰恰是最私人、最重复的东西：同一个人反复用的可能是「把今天的会议纪要整理成待办」
「按上周的模板写周报」「审一遍这个 PR」。现在他每次都得重新打一遍，或者去翻历史会话。

同类产品（Claude 的 prompt library、Raycast 的 snippet、Notion AI 的模板）都提供了
「可编辑的开局」；我们没有，首页那四张卡就只是一块演示物。

## 期望

- 首页案例区变成**模板库**：内置 4 条保持现状，用户可以新增自己的模板（标题 + 提示词）。
- 卡片点击仍把提示词填进输入框；自定义模板的卡片可以被编辑、删除。
- 设置 → 通用新增「模板库」分组：列表 + 新增 / 编辑 / 删除 / 恢复默认。
- 模板跟随本机保存（`preferences.json`），重开应用仍在；不联网、不占仓库。
- 空态要可读：全部删掉时，首页那一区显示「还没有模板，去设置里加一条」而不是空白。

## 验收标准

- [ ] `npm run test` 覆盖：模板校验（标题/提示词空、超长、非法字符归一）、数量上限、去重
- [ ] `npm run test:gui:prompt-templates` 用真实 Electron 验证：新增 → 首页出现 → 点击填空 →
      编辑 → 删除 → 重启后仍在
- [ ] 截图（亮/暗、列表/编辑态）落 `artifacts/prompt-templates/`
- [ ] `npm run lint:all`、`check:theme-tokens`、`check:unicode` 全绿
- [ ] 设计师 subagent 评审一轮，按其意见迭代

## 入手位置

- `src/shared/templates.js`（新增，纯函数 + 内置数据）
- `src/main/daemon/preferences.js`（校验与落盘）、`src/main/daemon/session-files.js`（IPC）
- `src/preload/index.js`（桥接）
- `src/renderer/src/app.js`（首页案例区 + 设置分组 + 编辑弹层）
- `src/renderer/src/app.css`（模板管理列表与编辑态样式）
- `tests/unit/templates.test.mjs`、`tests/e2e/prompt-templates.mjs`

## 难度

中。主要是跨层（shared → daemon → preload → renderer）接线，加一个管理弹层的交互；
没有新的模型调用，也没有设计 token 改动。
