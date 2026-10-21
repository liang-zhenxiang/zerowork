# 变更审阅页 UI/UX 评审

- 评审对象：`artifacts/review-desk/review-desk-diff-light.png`（待审阅 + 并排 diff）与 `review-desk-reviewed-light.png`（已阅）
- 对照：`docs/DESIGN.md`、`src/renderer/src/app.css` 的 `.rv-*` 段（12803 行起）、`src/renderer/src/review-core.js`、`src/renderer/src/app.js` 的 `ReviewView`、`.trellis/tasks/10-21-review-desk/prd.md`
- 限制：只有亮色截图；空态 / 错误态按代码判断；评审期间未改任何代码

## 维度速评

1. **信息层级**：左索引 + 右唯一内容卡的主从结构正确；但卡片内部连续四层 12px 次文（meta / `+2 −1` / 列头 / 尾注）把 diff 压成次要信息，页头“待审阅 1”也和 meta 一样安静。
2. **留白与节奏**：下方空白本身不是错误，主从布局就该顶端对齐、卡片按内容收高；做成满高反而违反 §3.9。真正显得没做完的是 `+2 −1` 孤行和以 12px 细则结尾。
3. **并排 diff**：行配对、等宽、`pre-wrap`、1.6 行高都对；问题是正文用了 12px meta 档，每列内容宽约 280px（约 23 个汉字/行），长行折行后左右子行对不齐。
4. **状态表达**：文字 + 圆点 + 颜色三通道方向对；但两态是同一个实心 6px 点，文字只差“待/已”，扫视实际仍靠颜色，§7.6 的形态通道没做出来。
5. **文案**：边界话术整体可诊断，但有空态事实错误、“已阅/已审阅”混用、`@@` 与 `write` 实现泄漏。
6. **对比度**：亮色下 `--text-secondary` 白底 3.95:1、`--bg-raised` 3.69:1，角标 3.75:1，均低于 AA 4.5:1；暗色 5.57:1 达标；待审阅 accent 与 diff 正文达标。
7. **一致性**：和“文件历史”明显同族（`.fh-card`、索引列、`.fh-card-head/meta/note`、`.mini-btn`、diff 底色），没有新色值；两处裂缝是加载态不在卡片里、窄窗没有文件历史的 picker（后者是有注释的取舍）。
8. **空态与边界**：真空 / 筛选空 / 加载 / 错误互斥且可辨；各边界都有话术并区分是否可重试。欠缺的是标记不可撤销、二进制 / 超大也能直接标记已阅、“现在”可能含后续命令改动却未说明。

## P0（必须改）

### P0-1 空态描述与实现不符

- 位置：`src/renderer/src/review-core.js:27-28`（`REVIEW_EMPTY_DESC`），原文“每次改动都会在这里列成一条待审阅的变更”。
- 问题：`src/main/daemon/version-store.js` 的 `listVersionFiles` 每个文件只取最后一条版本，`src/main/daemon/review.js` 的 `buildReviewEntries` 也是一文件一条；PRD 写的是“每个文件最近一次被覆盖 = 一条变更卡”。
- 为什么：用户同一文件改 5 次只看到 1 条，会以为漏列；也可能反过来误以为审 1 条等于审了全部 5 次——这是审阅队列的信任基础。
- 怎么改：改为“每个文件最近一次改动会在这里列成一条待审阅的变更；更早的改动会被新的覆盖。”保留命令改动那句，并同步更新钉住文案的单测。

### P0-2 diff 第一行是 git 黑话

- 位置：`src/renderer/src/app.js:69011` 渲染 `diffRow.header`；截图显示坐标约 (1020, 300) 的 `@@ -1,6 +1,6 @@`；样式 `.rv-diff-hunk`（`src/renderer/src/app.css:13062`）。
- 问题：目标是办公用户，这是主内容第一行、唯一一行区块头，不解释就是噪音；读屏还会念成“at at minus one comma six…”。
- 怎么改：在 `review-core.js` 增加 `formatHunkHeader`：只有一个 hunk 且从第 1 行开始时整行不渲染；否则显示“第 N 行起”（必要时“改前第 N 行起 / 现在第 M 行起”）。原始 `@@` 只放 `title` / `aria-label`；单测分别钉解析与格式化。

### P0-3 “标记已阅”是单行道，待审阅筛选下还会瞬间换卡

- 位置：`src/renderer/src/app.js:69018`（已阅后按钮消失）、`app.js:68901-68910`（就地更新与 toast）、`app.js:68836`（`activeKey` 回落到 `visibleEntries[0]`）。
- 问题：daemon 只有 `review:mark`，没有 unmark。误点一次，这条就从待审阅队列消失、侧栏角标减一，界面没有任何回退；在“待审阅”筛选下右区会立刻跳到下一条，toast 又只说“已标记为已阅”不说是哪个文件——与 `68901-68910` 注释“右区还停在同一条变更上”正好相反。
- 怎么改：(a) 已阅项保留“标为待审阅”（新增 `review:unmark`，或 `review:mark` 接受空 versionId 表示清除）；(b) toast 带文件名（如“已标记「周报.md」为已审阅”）并提供“撤销”；(c) 待审阅筛选下标记后先停在当前条显示已阅状态，下一次点击再跳。若本轮做不了 (a)，至少做 (b)(c) 并立即起 Issue 记录 (a)。

## P1（应该改）

### P1-1 卡片内 `+2 −1` 孤行

- 位置：`src/renderer/src/app.js:68988-68993`；截图约 (1010, 198)。
- 问题：整行只有一个无标签的 `+2 −1`，字体是正文字体（左列 `.rv-row-stats` 是 `--font-mono`），同一信息出现两次；diff 本身已逐行展示增删。
- 怎么改：删除；若坚持保留，并进 meta 行末尾（`· +2 −1`，用 `--font-mono`），不要单独占行。

### P1-2 “已阅 / 已审阅”混用 + 页头撞词

- 位置：`src/renderer/src/review-core.js:46`（已审阅）、`src/renderer/src/app.js:69018`（标记已阅）、`app.js:68910`（已标记为已阅）；页头计数 `app.js:69082` 紧接筛选 `69084-69085`（截图 x≈1488-1805, y≈50）。
- 问题：同一个状态两个词，违反“同一件事同一句话”；“待审阅 1 · 已审阅 0”紧接着“全部 / 待审阅”，40px 内同一个词出现两次、语义不同。
- 怎么改：统一为 待审阅 / 已审阅 + 标记为已审阅 + 已标记为已审阅；筛选标签改“只看待审阅”，或把计数移到筛选之后 / 左列区头。e2e 现有断言钉住了“标记已阅”，需同步改。

### P1-3 diff 正文用了副行字号，内层滚动上限浪费下半屏

- 位置：`src/renderer/src/app.css:13010-13020`，`.rv-diff { font-size: var(--text-meta); max-height: min(50vh, 420px) }`。
- 问题：这是本页唯一需要逐字读的内容，却和 meta 同级（12px），不符合 §3.4“列表正文用 `--text-list`”；长 diff 时下方还有半屏空白，却在 420px 盒子里滚，形成滚动套滚动。
- 怎么改：`font-size: var(--text-list)`；`max-height: min(70vh, 720px)`（或按可用高度），保留 sticky 列头。

### P1-4 亮色对比度不达标

- 位置：`--text-secondary`（`src/renderer/src/app.css:532`），影响 `.rv-row-dir`、`.rv-row-meta`、`.fh-card-meta`、`.rv-head-counts`、未选中 `.rv-filter-btn`、`.rv-diff-head span`、`.rv-diff-hunk`、已阅 `.rv-state`；`.nav-badge`（`app.css:13068`）在 chip 上。
- 数值：白底 3.95:1、`--bg-raised` 3.69:1、角标 3.75:1，均为 12px 正常字重，低于 AA 4.5:1；暗色 5.57:1 达标。
- 为什么：“已审阅”“来源会话已不在”“改前 / 现在”列头都是必须读得出的句子；选中行背景换成 `--bg-raised` 后次文更低。
- 怎么改：本页范围内把这些“必须读”的升到 `--text`；角标数字用 `--text`，或改成实心 accent 胶囊（白字 5.24:1）。全站把 0.5 提到 0.62 需单独一轮视觉回归，不建议塞进这个 PR。

### P1-5 状态形态通道没做出来

- 位置：`src/renderer/src/app.css:12935-12955`；截图左列右侧“● 待审阅 / ● 已审阅”。
- 问题：两态都是同尺寸实心点，文字只差“待/已”，12px 扫视实际靠蓝/灰区分，§7.6 要求的形态通道是空的。
- 怎么改：已阅改成对勾（复用 `IconCheck` 12px）或空心圆；待审阅保留实心 accent 点；左列与卡片头一起改。

## P2（可选）

- 加载态不在卡片里：`src/renderer/src/app.js:69061-69069` 右侧是裸 `LoadingState`，加载完带边框的 `.fh-card` 才出现；文件历史在加载时就保留卡片 + 骨架。建议包进 `.fh-card`（§4 的“同一片区域被填上”）。
- 尾注重复：`app.js:69057` 同时重复空态里的范围说明和还原确认里的话；把“命令改的文件…”移到左列区头一次，删掉还原那句（确认条已有）。
- 原始工具名：`review-core.js:95-100` 与 `src/renderer/src/file-history-core.js:131-136` 是同一段逻辑的复制，`write` 直接露给用户；映射 write→写入、edit→编辑，并复用同一个函数（两页一起改）。
- 角标可能过期：`app.js:71783-71800` 只在启动 / 打开 / 标记后拉取；Agent 在对话里改了文件，侧栏角标不会变，可能仍是 0。可在回合结束时刷新一次（不是每个事件）。
- 无障碍：`.rv-list` 的 `role="list"` 子节点是 `<button>`（没有 listitem），建议去掉 role 或加 listitem；选中用 `aria-pressed`，主从选择更适合 `aria-current`；diff 左右单元格会被读屏交叉朗读，考虑 table / `<th>` 或给单元格加“改前 / 现在”前缀。
- CSS 卫生：`.nav-badge`（`app.css:13068`）与 `.space-group-badge`（1487）/ `.settings-section-badge`（2059）值完全重复，按 §6 应复用修饰类；`.rv-card` 没有任何规则（空 hook）。另外 12811 行注释说复用 `.diff-add/.diff-del` 的文字色，实际被后面的 `.rv-diff-cell { color: var(--text) }` 覆盖成黑色——黑字反而对（18:1），但建议显式写成 `.rv-diff-cell.diff-add { color: var(--text) }` 并改注释，免得以后修 specificity 时把 2.17:1 的绿字放出来。
- “现在”的含义：右列读的是磁盘当前内容，之后的命令 / 外部编辑也会混进来却没有归属说明；可把列头改成“当前文件”并在 title 或边界文案里说明。
- 索引列宽：320px 对三行列表偏宽，缩到 280px 可给 diff 多 40px（可选）。代码 diff 建议 `tab-size: 4`。
- 只提供了亮色截图；暗色 token 数学上达标，但淡色 tint 需要实机再看一眼。

## 一句话总评

版式与“文件历史”同族、边界文案扎实，但主内容（并排 diff）被当成副行（12px + git 黑话），状态还有一个不可逆的单行道；这三处不改，它更像“变更列表”而不是“审阅台”。
