# 执行清单：修订模式底座（#456）

## 0. 开工

- [x] 分支 `feat/doc-edit-mode`，任务目录与 prd/design/implement 落盘
- [x] Issue #456 留言「我开始了」，确认无并行 PR/分支

## 1. 纯逻辑与存储（先写单测）

- [x] `src/main/daemon/doc-edits.js`：白名单、路径、applyToolInput、lineOps、groupHunks、
      buildProposal、list/read/delete、id 校验、上限与裁剪
- [x] `tests/unit/doc-edits.test.mjs`：先红后绿，覆盖 PRD 列出的每条

## 2. 拦截扩展

- [x] `createDocEditExtension`（同文件或 `doc-edit-extension.js`，保持不 import Electron）
- [x] `session-files.js`：扩展排在权限门之后、spill 之前；`isEnabled` 读桶状态
- [x] 最小单测：fake pi 直接调 handler（关闭放行 / 开启 block + 建议落盘 + 原文不变）

## 3. 状态与 IPC

- [x] `session-host.js`：`docEditMode` 字段、`setDocEditMode`、state 可选字段
- [x] `session-files.js`：`docEditMode` 传入宿主；4 个 handler（set/list/read/delete）
- [x] `src/shared/ipc.js` + `src/preload/index.js`：常量与 bridge，注释写清语义
- [x] 单测：id 非法与存储层错误可直测；setter 校验由真实 Electron 探针验证（IPC 层）

## 4. 界面开关

- [x] `app.js`：「更多操作」里的修订模式开关（role=switch / aria-checked），说明文案与开启提示
- [x] `app.css`：只用既有 token；开关复用既有控件样式
- [x] 首页/对话状态同步（`docEditMode` 缺失即关）

## 5. 验证

- [x] `npx vitest run tests/unit/doc-edits.test.mjs`（全绿）
- [x] `npm test`
- [x] `npm run build`（e2e 跑产物）
- [x] 新增最小 e2e 或由 #459 覆盖（临时真实 Electron 探针 8/8，完整 e2e 归 #459）：开启后 mock 模型 write → 文件不变 + 建议可列出
- [x] 回归 `gui-smoke` / `gui-settings` / `gui-review`
- [x] `npm run check:unicode`、`check:renderer-assets`、`lint:all`
- [x] 设计师子代理评审（3 处必修 + 3 条建议已处理）与状态表达（截图亮/暗）

## 6. 收尾

- [x] `CHANGELOG` 新增条目（修订模式第一步）
- [ ] USAGE 简述修订模式与后续 #457/#458 的关系（随 #459 一起写，避免半成品说明）
- [ ] 提交 → PR（Closes #456）→ CI 总览绿 → squash
- [ ] 归档任务、更新 Roadmap 状态（#456 完成）
