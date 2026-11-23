# 执行清单：修订工作台（#457）

## 0. 开工

- [x] 分支 `feat/doc-edit-workbench`，任务目录与 prd/design/implement 落盘
- [x] Issue #457 留言「我开始了」，确认无并行 PR/分支

## 1. 纯逻辑

- [x] `src/renderer/src/doc-edit-core.js`：分组 / 默认全选 / 全选切换 / 选中汇总
- [x] `tests/unit/doc-edit-core.test.mjs`：顺序、坏数据、空列表

## 2. 审阅台

- [x] `ReviewView`：模式切换（待修订 / 已变更）+ 计数 + aria-live
- [x] 左栏按文件分组的建议列表；选中态与键盘
- [x] 右栏：来源会话、过期条、hunk 勾选与 diff 行、全选/全不选
- [x] 接受选中 → `applyDocEdit`；拒绝整条 → 二次确认 + `rejectDocEdit`
- [x] 空态/加载/错误态；接受/拒绝后重拉
- [x] 样式复用 `.rv-*`，只新增必要类

## 3. 测试

- [x] 单测 `doc-edit-core`
- [x] e2e 扩展 `gui-doc-edit-base.mjs`：取消一段 → 接受 → 文件只含选中段；过期 → 接受禁用 → 拒绝
- [x] 回归 `review-desk` / `gui-smoke` / `file-history`

## 4. 验证

- [x] `npx vitest run tests/unit/doc-edit-core.test.mjs`
- [x] `npm test`、`npm run build`、`check:unicode`、`check:renderer-assets`、`check:daemon-graph`
- [x] `lint:all`（zizmor 环境项除外）
- [x] 设计师子代理评审（4 条 P1 + 5 条 P2 已处理：丢弃语义前置提示、增删符号与读屏、勾选段状态、过期逃生路径、宽版截图、选中行/字号/间距）

## 5. 收尾

- [x] `CHANGELOG` 新增条目（工作台可用）
- [ ] 提交 → PR（Closes #457）→ CI 绿 → squash
- [ ] 归档任务、更新 Roadmap
