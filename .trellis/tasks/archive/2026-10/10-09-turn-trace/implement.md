# 执行清单：工作轨迹（Turn Trace）

前置：分支 `feat/turn-trace`（自最新 `main` 切出）。

## 步骤

1. [x] **侦察核对**（写码前，防设计假设漂移）
   - [x] 核对真实工具名全集：`grep` 主进程 tool-factories / pi 内核默认工具，
         修正 trace-core 分类表（`search` 类的真实成员）
   - [x] 读 `app.css` `:root` token 清单（状态色 / 间距 / 圆角 / 字号 / 时长的现成名）
   - [x] 读 DESIGN.md §10.3（animation 登记格式）
   - [x] 看 `tests/e2e/lib/harness.mjs` 的 `shoot` 像素断言契约与 mock 模型模式
         （`tests/e2e/widget-render.mjs` 是范本）
2. [x] **trace-core.js 纯函数** + 单测 `tests/unit/trace-core.test.mjs`（先测后接 UI）
   - [x] 分类 / 合并 / 状态 / 空输入 / 未知工具 / 保序 / title
   - [x] `node scripts/lint.mjs`（或对应单测命令）到绿
3. [x] **渲染接线**（app.js，最小侵入）
   - [x] `buildTurnViews` 里挂 `trace: buildTurnTrace(content2)`
   - [x] `TurnTraceBar` 组件 + turn-group 内插入（TurnHeader 之后）
   - [x] `onFocusEntry` 定位逻辑（展开折叠组 → scrollIntoView → flash）
   - [x] `ToolEntry` 根节点加 `data-entry-id`
4. [x] **样式**（app.css）：token 化、双主题、四态、连接符、flash 动画登记
   - [x] `npm run check:theme-tokens` 绿
5. [x] **e2e** `tests/e2e/turn-trace.mjs`（mock 模型：read+write → bash(被拦) → 终文本）
   - [x] 五组断言（存在/类别计数、bad 段、点击定位、折叠后仍在、截图浅+深）
6. [x] **UI/UX 评审**：真实截图（浅/深/折叠/长回合四张）派资深 UI/UX subagent
   - [x] 按意见迭代，复截屏复核
7. [ ] **全量验证**：`npm run lint:all` && `npm test` && `npm run build &&
   npm run check:renderer-assets` && `npm run test:gui`
8. [x] **文档**：`docs/USAGE.md` 助理一节 + `CHANGELOG.md` [Unreleased] 新增条目
9. [ ] 提交（约定式提交，正文写为什么；`git commit -F`）→ PR（`--body-file`，
   正文含 `Closes` 无需——无对应 Issue，正文写清验收）→ CI 总览绿 → squash 合并

## 验证命令速查

```bash
npx vitest run tests/unit/trace-core.test.mjs   # 单测
node tests/e2e/turn-trace.mjs                   # e2e（真实启动）
npm run lint:all                                # 全量静态
```

## 回滚点

- 每步一个提交；渲染接线（步骤 3）与样式（步骤 4）可独立回滚。
- 最终回滚 = revert 合并提交，无存储/迁移残留。

## 评审门

- 步骤 6 的 UI/UX 意见必须闭环（采纳或书面理由）后才进步骤 7。
