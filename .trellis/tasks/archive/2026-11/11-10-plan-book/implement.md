# 执行清单

> 按提交闭环推进；每步完成即跑对应测试。

## 1. 渲染层纯逻辑

- [ ] 新建 `src/renderer/src/plan-core.js`（按 design §三 的导出）
- [ ] 新建 `tests/unit/plan-core.test.mjs`
- [ ] `npm test -- tests/unit/plan-core.test.mjs`

## 2. 存储层

- [ ] 新建 `src/main/daemon/plans-store.js`（`PlanStore`）
- [ ] 新建 `tests/unit/plans-store.test.mjs`（临时目录、版本上限、损坏文件、路径穿越）
- [ ] `npm test -- tests/unit/plans-store.test.mjs`

## 3. IPC 接线

- [ ] `src/shared/ipc.js`：`getPlan/savePlan/approvePlan/deletePlan` 四条 + 注释
- [ ] `src/preload/index.js`：暴露并写 JSDoc 形状
- [ ] `src/main/daemon/session-files.js`：实例化 `PlanStore` + 四个 handler
- [ ] 检查 `tests/unit/ipc.test.mjs` 是否需要更新（通道清单）

## 4. 渲染层 UI

- [ ] App 内 `usePlanBook(conversation)`：加载 / 捕获 / 保存 / 批准 / 删除
- [ ] `PlanBook` 抽屉组件：标题、进度、步骤卡、行内编辑、新增/删除/排序/勾选
- [ ] 版本浮层：列表、差异、恢复
- [ ] 空态 / 错误态 / 加载态
- [ ] 执行全部 / 执行这一步 / 复制 Markdown
- [ ] 入口：会话页顶部按钮（徽标）、命令面板动作、捕获后 toast 动作
- [ ] `app.css` 追加 §40（含 reduced-motion、窄窗全宽）

## 5. 测试与留档

- [ ] 新建 `tests/e2e/gui-plan-book.mjs`（按 design §六）
- [ ] `package.json` 增加 `test:gui:plan-book` 并接入 `test:gui` 链
- [ ] 跑 `npm run test:gui:plan-book`
- [ ] 截图：`artifacts/plan-book/`（浅色 / 暗色 / 编辑态 / 版本差异）
- [ ] 资深 UI/UX 设计师 subagent 评审截图与交互，按意见迭代
- [ ] `CHANGELOG.md` `[Unreleased]` →「新增」

## 6. 回归与提交

- [ ] `npm run lint:all`（zizmor 需本机 Docker；缺失时如实说明）
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run test:gui`（全量，证明未破坏老功能）
- [ ] `npm run check:unicode`
- [ ] 分支 `feat/plan-book` → PR（正文含验收对照与截图说明），CI 绿后 squash 合并
- [ ] 合并后核对 Issue / CHANGELOG / 里程碑

## 回滚点

- 纯新增模块 + 追加式 UI；daemon 只新增文件与通道，不改既有通道行为。
- 删除 `plans/` 目录即可回到「没有计划书」的状态。
