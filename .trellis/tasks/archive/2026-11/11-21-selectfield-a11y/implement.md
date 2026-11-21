# 实施清单：SelectField 键盘与可访问名（#427）

1. 新建 `src/renderer/src/select-field-core.js`（design §1 四个纯函数）。
2. `SelectField`（app.js）：
   - `useId` 列表 id；`activeIndex` 状态与初始值；
   - 触发器补 `role=combobox`、`aria-controls`、`aria-activedescendant`、
     `aria-label=accessibleName(...)`；
   - 键盘：ArrowDown/Up、Home/End、Enter、Escape（焦点回触发器）、Tab 关闭；
   - 选项 `id` + `tabIndex=-1`，`aria-selected` 只给真正选中项；
     `.active` 高亮、hover 同步 activeIndex、移动后 `scrollIntoView({block:"nearest"})`；
   - 选项数量变化时夹紧 activeIndex。
3. `app.css`：`.provider-option.active { background: var(--bg-hover); }`（不改尺寸/颜色档）。
4. 单测 `tests/unit/select-field-core.test.mjs`（design §4）。
5. e2e：新 `tests/e2e/gui-select-keyboard.mjs`（或扩展能力库套件）覆盖
   聚焦 → ArrowDown → ArrowDown → Enter → aria/视觉断言 → Esc 焦点回落；
   亮暗截图；接进 `package.json` 的 `test:gui` 链。
6. 回归：`gui-settings`、`gui-expert-gallery`、`gui-library-gallery`、`gui-smoke`。
7. `CHANGELOG.md [Unreleased] 修复`：写清此前只能用鼠标、读屏听不到当前值。
8. 验证：
   - `npx vitest run tests/unit/select-field-core.test.mjs`
   - `npm test`；`npm run build`
   - 新 e2e、上述回归、`npm run check:unicode`、`npm run lint:all`
   - 反向验证：aria-label 改回裸值 → 断言红；ArrowDown 短路 → 键盘用例红；均还原。
9. 不 commit；完成后报告真实输出与截图。
