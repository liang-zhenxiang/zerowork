# 设计：成果展厅（#423）

## 1. 纯函数：`src/renderer/src/library-gallery-core.js`

与 `command-palette-core.js` 同模式（不 import DOM，vitest 直接测）。

```
ARTIFACT_TYPES = [{id:"all",label:"全部"},{id:"doc",label:"文档"},…]

artifactType(artifact) -> "doc" | "sheet" | "slide" | "pdf" | "image" |
                          "markdown" | "html" | "code" | "url" | "other"
typeLabel(id)
artifactCover(artifact) -> { barWidth, lines:number[3], bars:number[3] }  // 复用 case-cover
pathWithinCwd(cwd, path) -> boolean
sourceCwdFor(artifact) -> string | undefined      // 第一个包含该路径的来源会话 cwd
filterArtifacts(artifacts, { type, sessionId, days, keyword }) -> artifact[]
continuePrompt(artifact) -> string
versionKeyFor(files, path) -> string | undefined  // 文件历史按归一化路径匹配 key
```

- 类型由扩展名判定（小写）；URL 一律 `url`；未知扩展名 `other`。
- 封面几何用 `case-cover.js` 的 `coverSeed/coverLines/coverBars/coverBarWidth`，
  以 `artifact.path` 为种子 —— 同一文件永远同一张封面；类型只决定**画法**。
- `filterArtifacts` 四条件为**与**关系；`days` 按 `deliveredAt` 与当前时间比较
  （0/缺省 = 全部）；`keyword` 匹配 name（大小写不敏感）。
- `continuePrompt`：
  `我正在继续完善这份交付物：<path>\n\n先读这个文件，确认它当前的结构与内容，然后按我接下来的要求修改。不要移动文件位置，也不要改动来源工作区之外的文件。`
- `sourceCwdFor` 只认 `artifact.sessions[].cwd`；没有匹配就返回 undefined
  （界面据此禁用「继续修改」并说明原因）。

## 2. 资料库视图（`LibraryView` + 新组件）

```
LibraryView
├─ 页头：返回 / 资料库 / 视图切换（网格·列表）/ 刷新
├─ 统计卡（保留片段 / 模板 / 产物）
├─ 筛选行：类型 chip（全部/文档/表格/幻灯片/图片/PDF/代码/链接/其他）
│         · 来源会话 select（全部 + 有产物的会话）
│         · 时间 select（全部 / 7 天 / 30 天）
│         · 文件名搜索
├─ 网格：LibraryCard[]  |  列表：现有 LibraryRow[]
└─ 详情：LibraryDetail（模态抽屉）
```

- **默认网格**；切到列表时保留筛选与搜索。两种视图共用同一份 `visible` 数组。
- 搜索为本地过滤（数据 ≤500 条），不需要防抖。
- 无结果：`EmptyState` + 「清除筛选」；**只有真的没有任何产物**时才显示原有的
  「还没有交付过产物」空态与「新建任务」。
- 筛选行在加载 / 错误态不渲染（与能力库同一纪律）。
- 筛选项的计数不做（产物可能很多，动态计数会诱导用户以为「只有这些」）。

### 卡片 `LibraryCard`

- `<button className="lib-card" data-type=…>`（整卡可点，回车/空格打开详情）。
- 封面 `.lib-cover`：纯 CSS 盒子 + 由 core 给的三条线/三根柱/色条；
  类型→`--cat-N`（文档 1 / 表格 4 / 幻灯片 5 / 研究笔记 2 / 其他中性）。
  `aria-hidden`，不参与可读名。
- 文件名校验用 `title` 保留完整路径；失效文件加「文件已不在」徽标并降饱和。
- meta：类型 · 大小（交付快照）· 交付时间 · 来源会话标题。

### 详情 `LibraryDetail`

- `role="dialog"` + `aria-modal` + `useModalFocus({ preventScroll: true })`，
  初始焦点在对话框容器（同 #421 的教训）。
- 内容：封面缩略、文件名（完整路径次行）、类型 / 大小 / 交付时间 / 来源会话列表。
- 动作：
  - **预览**（本地且 `exists`）：调现有 `onPreview(sessionPath, path)`；
  - **版本历史**：若 `listFileHistory()` 能按路径匹配到 key → `onOpenHistory(path)`；
    匹配不到则按钮禁用并说明「这个文件没有留下版本」（不假装有）；
  - **在文件夹中显示**（现有 `onReveal(cwd)`）；
  - **复制路径**：`navigator.clipboard.writeText` + toast；
  - **继续修改**：`sourceCwdFor` 有值且 `exists` 时可用；调 `onContinue(artifact)`。
    在来源工作区外 / 文件已不在时禁用并在按钮下方写明原因。
- URL 产物：只提供「打开链接」与复制链接；不显示版本历史/继续修改。

## 3. App 层接线

- `continueArtifact(artifact)`：
  ```js
  const cwd = sourceCwdFor(artifact);
  const prompt = continuePrompt(artifact);
  window.kami.newTask(cwd).then(() => {
    resyncSnapshot();
    setPendingPrefill(prompt);
    setView("chat");
  }).catch(toast)
  ```
  `cwd` 必须在来源会话 cwd 内（core 已判定），不新增读任意路径通道。
- **版本历史定位**：
  - App 新增 `fileHistoryFocus`（path）与 `openFileHistory(path?)`；
  - `FileHistoryView` 收 `focusPath`，列表加载后按 `versionKeyFor` 选中对应文件；
  - 侧栏/命令面板调用不带参数 → 行为不变。
- 既有 `previewLibraryArtifact` 原样复用（切来源会话再开预览面板）。

## 4. 样式

- 新增 `.lib-toolbar`、`.lib-filter-chip`、`.lib-grid`、`.lib-card`、`.lib-cover`、
  `.lib-detail*`；全部 Token，分类色只用 `--cat-1..6`。
- 网格：`repeat(auto-fill, minmax(220px, 1fr))`，卡片高度一致（封面固定 96px）。
- 列表切换按钮用 `.mini-btn` + `aria-pressed`；视图状态必须有两个通道。
- 矮视口（≤760）收紧封面与间距；亮暗两套截图检查。

## 5. 测试

- 单测 `tests/unit/library-gallery-core.test.mjs`：
  类型矩阵（含大写扩展名 / 无扩展名 / URL）、封面稳定且与文件一一对应、
  筛选四条件叠加、时间边界、路径归属（Windows 分隔符与大小写不敏感）、
  `continuePrompt` 含路径、`versionKeyFor` 归一化匹配。
- e2e `tests/e2e/gui-library-gallery.mjs`（真实 Electron，造 3 个交付物）：
  - 默认网格 + 封面 + 类型标签；亮/暗截图；
  - 类型/时间/搜索筛选与无结果空态；
  - 切列表视图仍能看到原有行；
  - 详情 → 版本历史跳转（用文件历史夹具造一版）→ 选中对应文件；
  - 继续修改：断言新任务 cwd 等于来源 cwd（通过 `window.kami.snapshot()` 或会话列表）
    且 composer 预填包含文件路径；
  - 失效文件：标记 + 预览/继续修改禁用。
- 回归：`tests/e2e/library.mjs`（若有选择器依赖默认行视图，切到列表后再断言）、
  `gui-smoke`。
- 反向验证：`sourceCwdFor` 恒 undefined → 继续修改用例必红。

## 6. 取舍

- **封面是类型示意图，不是缩略图**：不跑 Office 渲染、不截图，保持零依赖与零出网。
- **默认网格、列表可切**：既给「成果感」，又不丢原有逐行操作；既有 e2e 改为先切列表。
- **继续修改只认来源 cwd**：不为「改任意文件」开新通道；工作区外产物只能定位回会话。
- **版本历史匹配不到就禁用**：文件历史只覆盖 write/edit，命令改的文件没有版本；
  如实说「没有留下版本」，不做一个点了没反应的按钮。
