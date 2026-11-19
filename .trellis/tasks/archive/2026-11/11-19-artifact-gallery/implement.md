# 实施清单：成果展厅（#423）

## 0. 准备

- 分支 `feat/artifact-gallery`，基线 main。
- 读 `.trellis/spec/renderer/index.md`、`.trellis/spec/testing/index.md`、`docs/DESIGN.md`。

## 1. 纯逻辑

新建 `src/renderer/src/library-gallery-core.js`（design §1 全部导出）。
复用 `case-cover.js` 的 `coverSeed/coverLines/coverBars/coverBarWidth`，不复制几何算法。

## 2. 视图

1. `LibraryView`：
   - 状态：`viewMode`（grid/list，默认 grid）、`type`、`sessionId`、`days`、`keyword`；
   - 筛选项由 `data.artifacts` 派生（来源会话去重、按标题排序）；
   - `visible = filterArtifacts(...)`；三态与筛选无结果分开；
   - 页头视图切换（`mini-btn` + `aria-pressed`）。
2. `LibraryCard`（网格卡）与 `LibraryDetail`（模态）：按 design §2。
   - 详情打开时懒加载 `listFileHistory()`，按 `versionKeyFor` 匹配；失败给可读提示。
   - 复制路径用 `navigator.clipboard`；失败 toast。
3. `FileHistoryView`：
   - 新增可选 prop `focusPath`；列表加载后按匹配 key 设 `selectedKey`。
   - 只在匹配成功时改选中；匹配不到不改当前选中（不吞用户操作）。

## 3. App 层

1. `continueArtifact(artifact)`：`sourceCwdFor` → `window.kami.newTask(cwd)` →
   `resyncSnapshot()` → `setPendingPrefill(continuePrompt)` → `setView("chat")`。
2. `openFileHistory(path?)` 记录 focus 并切视图；侧栏/命令面板不传参行为不变。
3. `LibraryView` 传入 `onContinue`、`onOpenHistory`、`onPreview`（既有）、`onReveal`。

## 4. 样式

- `.lib-toolbar` / `.lib-filter-chip` / `.lib-grid` / `.lib-card` / `.lib-cover`（按
  `data-type` 分色与画法）/ `.lib-card-badge` / `.lib-detail-*`；
- `grid: repeat(auto-fill, minmax(220px, 1fr))`，封面 96px；
- `@media (max-height: 760px)` 收紧；亮暗 Token；不新造字号/颜色档。

## 5. 测试

1. `tests/unit/library-gallery-core.test.mjs`（design §5 全矩阵）。
2. `tests/e2e/gui-library-gallery.mjs`：复用 `tests/e2e/library.mjs` 的交付物夹具思路
   （写会话 jsonl → 打开资料库）：
   - 网格与封面（亮/暗截图）、类型/时间/搜索筛选、无结果；
   - 切列表仍可看到 `.auto-row`；
   - 详情 → 版本历史（造一版 write/edit 历史）→ 文件历史选中该文件；
   - 继续修改 → 新会话 cwd 与 composer 预填断言；
   - 失效文件标记与禁用动作。
3. 更新 `tests/e2e/library.mjs`：若它依赖默认行视图，先点「列表」再断言；
   新增一条「默认是网格」的断言。
4. 反向验证：`sourceCwdFor` 恒 undefined → 继续修改用例必红；还原。

## 6. 验证

```bash
npx vitest run tests/unit/library-gallery-core.test.mjs
npm test
npm run build
node tests/e2e/gui-library-gallery.mjs
node tests/e2e/library.mjs
node tests/e2e/gui-smoke.mjs
npm run check:unicode
npm run lint:all
```

## 7. 提交拆分

1. `feat(renderer): 资料库画廊、筛选与详情`
2. `feat(renderer): 继续修改与版本历史定位`
3. `test(docs): 画廊单测、e2e 与文档`

合并后归档任务、更新 Roadmap。
