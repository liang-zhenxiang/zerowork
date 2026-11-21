# 设计：SelectField 键盘交互与可访问名（#427）

## 1. 纯逻辑：`src/renderer/src/select-field-core.js`

```js
initialActiveIndex(options, value) -> number      // 选中项下标；无匹配时 0（空列表 0）
moveActiveIndex(index, delta, count, wrap = true) -> number
edgeActiveIndex(edge, count) -> number             // "home" | "end"
accessibleName(label, displayText) -> string        // 已包含则原样；否则 `${label}：${text}`
```

- 循环移动（首项向上到末项、末项向下到首项），`count === 0` 时返回 0；
- `accessibleName` 用 `label.includes(displayText)` 判断，避免调用方已拼值时出现
  「排序方式：名称：名称」；
- 纯函数、无 DOM，vitest 直测。

## 2. 组件（`SelectField`）

状态：`open`、`activeIndex`。`useId()` 生成 `listId`，选项 id 为 `${listId}-${index}`。

### 关闭态 → 展开

- 触发器补：`role="combobox"`、`aria-controls={listId}`、`aria-activedescendant`
  （展开时才有）、`aria-label={accessibleName(ariaLabel, 当前文案)}`。
- 点击：`open(true)`，`activeIndex = initialActiveIndex(options, value)`。
- 键盘（焦点在触发器时）：
  - ArrowDown：展开，并高亮当前选中项（没有则首项）；**若已展开**则下移；
  - ArrowUp：展开并高亮选中项（没有则末项）；已展开则上移；
  - Home/End：展开时跳首/末；
  - Enter：展开时选中高亮项并关闭；关闭时展开（等价点击）；
  - Escape：关闭并把焦点还给触发器（stopPropagation，避免关掉外层弹窗）；
  - Tab：关闭，不拦截（正常移走焦点）。

### 展开态

- 面板保持 `role="listbox"` + `id`；选项 `role="option"` + `id` +
  `aria-selected`（仅真正选中项）；高亮项加 `.active` class（视觉）。
- 选项改为 `div`（或保留 button 但去掉可 Tab 到的行为？）——**保持 button 以兼容
  现有鼠标与 e2e**，但 `tabIndex={-1}`：焦点始终留在触发器，由
  `aria-activedescendant` 指向高亮项，避免焦点在面板与触发器之间跳。
- `onMouseEnter` 同步 `activeIndex`；点击仍直接选择并关闭。
- 移动后用 `document.getElementById(activeId)?.scrollIntoView({ block: "nearest" })`
  把高亮滚进可视区（不需要 ref 数组）。
- 点击外部关闭（保留现有 mousedown 监听），关闭时清 `aria-activedescendant`。
- 选项数量变化时把 `activeIndex` 夹到合法范围。

## 3. 样式

```css
.provider-option.active { background: var(--bg-hover); }
.provider-select-trigger[aria-expanded="true"] { /* 如需，加既有 ring */ }
```

- 不改尺寸、颜色档；亮暗都用既有 `--bg-hover`。
- 触发器与选项的焦点环现状不变（`combobox` 仍走全局 focus-visible）。

## 4. 测试

### 单测 `tests/unit/select-field-core.test.mjs`

- `initialActiveIndex`：命中/未命中/空列表；
- `moveActiveIndex`：常规、两端循环、count 0/1、delta 大于 1；
- `edgeActiveIndex`：home/end/空；
- `accessibleName`：未包含 → 追加；已包含 → 不重复；空 label。

### e2e（扩展 `tests/e2e/gui-expert-gallery.mjs` 或新 `gui-select-keyboard.mjs`）

用能力库排序（默认/名称/最近安装）做真实链路：

1. 聚焦排序触发器 → 断言 `role=combobox`、`aria-expanded=false`、
   aria-label 含「默认」；
2. ArrowDown → 面板打开、`aria-expanded=true`、`aria-activedescendant` 指向「默认」；
3. ArrowDown → 高亮「名称」，`.provider-option.active` 文案为「名称」；
4. Enter → 排序实际变化（卡片顺序变）、面板关闭、aria-label 含「名称」；
5. 再打开 → Escape → 关闭且 `document.activeElement` 是触发器；
6. 亮暗截图（展开态高亮项）。

若扩展既有套件会让文件过长，新开 `gui-select-keyboard.mjs` 并接进 `test:gui`。

### 回归

`gui-settings`、`gui-expert-gallery`、`gui-library-gallery`、`gui-smoke`；
鼠标路径（点触发器/点选项/点外部关闭）必须仍绿。

### 反向验证

把 `aria-label` 临时改回裸 `ariaLabel` → e2e 的「含当前值」断言必红；
把 ArrowDown 处理短路 → 键盘用例必红。均还原。

## 5. 取舍

- **焦点留在触发器 + aria-activedescendant**，而不是把焦点移进 listbox：
  少一套焦点回收逻辑，也更接近 WAI-ARIA combobox 模式。
- **选项保留 button**：现有 e2e 与鼠标路径都按 button 找元素；加 `tabIndex=-1`
  即可避免多一个 Tab 停点。
- **不改 token**：对比度按生效值已达标（暗 5.03 / 亮 4.63），报告里的 4.1 来自被
  覆盖的旧块；在 PR 与 #427 写明核算依据，避免后人再改一遍。
