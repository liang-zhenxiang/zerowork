# PRD：SelectField 键盘交互与可访问名（#427）

## 背景

`SelectField` 是全站自绘下拉（设置页、模型选择器、能力库排序、资料库筛选都用它）。
现在只有鼠标路径：点触发器展开，再点选项；键盘用户打开后无法用方向键移动、
无法用 Enter 选择，Esc 只能关不能回到触发器。读屏侧，触发器的 `aria-label`
直接覆盖可见的当前值（除少数调用方自己把值拼进 label），听到的是「排序方式，按钮」
而不是「排序方式：名称」。

**对比度前提已核对并修正**：#421 评审给出的「深色占位符 4.1:1」来自
`[data-theme="dark"]` 块中先写的 `--text-faint: 0.45` 与 `--bg-raised: #26262a`，
这组值在同一 selector 后面已被 Aurora Ink 覆盖块（0.52 / #0e1624）取代，不是实际
生效值。按**生效 token** 计算：暗色 5.03:1（bg-raised）/ 4.96:1（surface-2），
亮色 4.63:1（bg-raised），均 ≥ AA 4.5:1。因此本轮不改 token，只补回归证据。

## 目标

1. **键盘**：方向键上下移动高亮；Home/End 跳到首/末；Enter 选择；
   Esc 关闭并把焦点还给触发器；Tab 关闭并正常离开。
2. **语义**：触发器是 `combobox`（`aria-haspopup="listbox"`、`aria-expanded`、
   `aria-controls`、`aria-activedescendant`）；可访问名包含当前值，
   且不重复（调用方已经拼了值的不再拼一次）。
3. **视觉**：高亮项用既有 `--bg-hover`，不改尺寸/颜色档；长列表自动把高亮项滚进可视区。
4. 不改任何调用方的数据契约（`value` / `options` / `onChange` 不变）。

## 非目标

- 不做多选、分组、搜索型 combobox。
- 不改原生 `<select>` 的禁用策略（DESIGN §6 仍禁止原生 select）。
- 不改任何 token / 对比度值。

## 约束

- 只改 `SelectField` 与其样式，以及必要的纯逻辑模块；不重排 app.js。
- 高亮不是选中：`aria-selected` 只给真正选中的项；高亮项用 class 与
  `aria-activedescendant` 表达，避免读屏把「移动中」当成「已选」。
- 现有鼠标行为与所有 `ariaLabel` 字符串保持不变（除「值重复拼接」的归一化）。

## 验收标准

- [ ] 关闭态：聚焦触发器，ArrowDown/Up 展开并把高亮放在当前选中项
      （无选中则首项/末项）。
- [ ] 展开态：ArrowDown/Up 循环移动高亮，Home/End 到首/末，Enter 选中并关闭，
      Esc 关闭且焦点回到触发器，Tab 关闭。
- [ ] 触发器的可访问名包含当前选项文案（如「排序方式：名称」），不重复拼接。
- [ ] 高亮项随移动自动滚进面板可视区；`.provider-option.active` 在亮暗下可辨。
- [ ] 单测：索引移动/循环/首末/无选项时的纯逻辑。
- [ ] e2e：真实 Electron 键盘走完整条链路（打开 → 移动 → Enter 选中 → Esc 关闭），
      并断言 `aria-expanded` / `aria-activedescendant` / aria-label 当前值；亮暗截图。
- [ ] 回归：`gui-settings`、`gui-expert-gallery`、`gui-library-gallery`、`gui-smoke`。
- [ ] `CHANGELOG` 记「修复」；无 token 改动，无需 DESIGN 数值变更。
