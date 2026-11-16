# PRD：界面一致性 Top 5

- 来源：2026-11-16 UI/UX 评审（35 张截图 + `docs/DESIGN.md` + 代码逐条核实）
- 分支：`fix/ui-top5`
- 日期：2026-11-16

## 背景

评审结论：没有 P0；问题集中在**状态可见性**、**可读性**与两个局部布局。
用户选择先修 Top 5（单点收益最大、彼此独立）：

1. `--text-faint` 对比度不达标，却承载「3 个模板」「1 会话」「由本地 hook 生成」等必须读到的信息
2. 「已选中」有两套颜色语言（首页极光青 / 专家·审计墨黑），暗色下同一控件还会翻色；筛选胶囊无 `aria-pressed`
3. 侧栏 8 个二级页面没有任何「当前页」标记（视觉与读屏都没有）
4. 资料库空态：`:has(> .state-empty)` 的 flex 居中把统计块与空态卡挤成左右并排
5. 两个新功能没有可见状态：hooks 注入卡折叠后无可展开提示；「回复长度」三枚胶囊完全没有选中态样式

## 需求（每项验收）

### 1. `--text-faint` 对比度

- 亮色 alpha `0.44 → 0.58`、暗色 `0.45 → 0.52`；对 `--bg` / `--surface-1` / `--surface-2` 的对比度 **≥ 4.5:1**
- 新增单测：解析 `app.css` 的 token，按 alpha 混色计算对比度并断言（防止后人调回去）
- `docs/DESIGN.md` §2.1 的旧数值与说明同步更新

### 2. 选中态统一

- `.mini-btn.active` 与 `.ex-cat.active` 改用 `--primary-active` + `--primary-text` + `font-weight: 600`（与 `.mode-tab.active` 同一语言）
- 审计类别筛选、专家分类胶囊补 `aria-pressed`
- 暗色下同一控件不再因为 `--primary` 换色而翻转

### 3. 侧栏当前页

- 侧栏导航项按当前 `view` 输出 `aria-current="page"` 与 `.nav-item-current`
- 样式用「抬升面 + 字重」（`--bg-raised` / 500），不引入新颜色；未就绪项保持禁用与 `--text-secondary`
- 8 个二级页面各自命中（projects / skills / automations / library / search / file-history / diagnostics / stats）

### 4. 资料库空态排版

- 居中规则只作用于「没有 `.data-overview` 兄弟」的空态
- 有统计块时：统计块居上，空态卡在下方居中，不与统计块并排
- 保持「数据区不管空不空都显示」的产品决定（#363 F10）

### 5. 新功能状态可见

- hooks 注入卡：标题行加 chevron 与「查看内容 / 收起」提示；`details[open]` 时旋转箭头；`<summary>` 纳入全局焦点环
- 「回复长度」：选中类改为 `.is-selected` 并有可见样式；胶囊行左侧加可见标签「回复长度」；保留 `role="group"` / `aria-pressed`

## 验收

- [ ] 五项都有 GUI 断言（真实 Electron），不只截图
- [ ] 空态布局用**元素矩形关系**断言（不是「看起来对」）
- [ ] 对比度单测覆盖两种主题的 faint / secondary
- [ ] `lint:all`、`npm test`、`build` + 相关 GUI 套件、`check:unicode`
- [ ] 截图：资料库空态、侧栏当前页、专家选中态、回复长度、注入卡（浅/暗）
- [ ] `CHANGELOG.md` 记「修复」

## 不在本轮

P1 其余 7 项与 P2 11 项（首页矮视口几何、Finder 文案、hooks 设置散文、记忆空态可点等）；
留到下一批，评审证据已记录。
