# 技术设计：界面一致性 Top 5

## 1. `--text-faint`

`src/renderer/src/app.css` 亮色（约 :724）`rgba(10, 18, 32, 0.44)` → `0.58`；
暗色（约 :922）`rgba(234, 240, 248, 0.45)` → `0.52`。

- 计算（白底 / 暗色 `--bg #070b14`）：亮 ≈4.5:1、暗 ≈5.0:1
- `docs/DESIGN.md` §2.1 里的「30%」与对比度说明一并更新为实测值
- 新增 `tests/unit/theme-contrast.test.mjs`：
  - 从 `app.css` 解析 `--text-faint` / `--text-secondary` 的 `rgba(...)` 与 `--bg`、`--surface-1`、`--surface-2` 的 hex
  - 实现 WCAG 相对亮度与 alpha 混色，断言 faint ≥4.5、secondary ≥4.5（两种主题）
  - 找不到 token 时**失败**（防止改名后静默跳过）

## 2. 选中态

`app.css`：

```css
.mini-btn.active {          /* 约 :10592 */
  background: var(--primary-active);
  border-color: var(--primary-active);
  color: var(--primary-text);
  font-weight: 600;
}
.ex-cat.active, .ex-cat.active:hover {   /* 约 :9741 */
  background: var(--primary-active);
  border-color: var(--primary-active);
  color: var(--primary-text);
  font-weight: 600;
}
```

`app.js`：审计类别筛选与专家分类按钮补 `aria-pressed={active}`（渲染点用 grep 定位
`mini-btn` 类别筛选与 `.ex-cat`）。

## 3. 侧栏当前页

- `App` 已有 `view` state（值：home / skills / automations / library / search /
  file-history / diagnostics / stats / projects / chat…）。
- `Sidebar` 新增 prop `activeView`；`renderNavItem` 增加 `viewId` 参数：
  - `aria-current={current ? "page" : undefined}`
  - `className` 追加 ` nav-item-current`
- `NAV` 定义处（`app.js` 约 :14753 的调用与上方列表）按 label 映射 view id。
- CSS（`app.css` 约 :1333 附近）：

```css
.nav-item-current { background: var(--bg-raised); font-weight: 500; }
```

- `nav-item-pending` 不受影响（仍 disabled、`--text-secondary`）。

## 4. 资料库空态

`app.css` 约 :14688：

```css
/* 只有「空态是唯一子项」时才整块居中 */
.app > main.settings .settings-body:has(> .state-empty):not(:has(> .data-overview)) { …原规则… }

/* 有统计块时：统计在上，空态卡在下方居中 */
.app > main.settings .settings-body:has(> .data-overview) > .state-empty {
  margin-top: var(--space-6);
  align-self: center;
}
```

（需确认 `.settings-body` 默认是 column 还是普通块流，按实际调整；目标是
`empty.top >= overview.bottom` 且水平居中。）

## 5. 新功能状态

### hooks 注入卡（`app.js` 约 :67327 / `app.css` 约 :19318）

- summary 内追加：`<span className="hook-context-toggle">` 两个文本节点
  （`.when-closed`「查看内容」/ `.when-open`「收起」），以及一个 chevron（CSS 伪元素或现有 Icon）。
- CSS：
  ```css
  .hook-context-toggle .when-open { display: none; }
  .hook-context-card[open] .hook-context-toggle .when-open { display: inline; }
  .hook-context-card[open] .hook-context-toggle .when-closed { display: none; }
  .hook-context-card[open] .hook-context-chevron { transform: rotate(180deg); }
  .hook-context-chevron { transition: transform var(--dur-fast) var(--ease-standard); }
  ```
- 全局焦点环选择器列表（`app.css` 约 :13901）加入 `summary:focus-visible`。

### 回复长度（`app.js` 约 :67936 / `app.css` 约 :7764）

- 类名 `saved` → `is-selected`（`saved` 与「保存成功闪一下」的语义解耦）
- CSS：
  ```css
  .reply-length-btn.is-selected {
    background: var(--primary-active);
    border-color: var(--primary-active);
    color: var(--primary-text);
    font-weight: 600;
  }
  ```
- 胶囊行前加可见标签「回复长度」（12px / `--text-secondary`），与其它设置项的 label 同一样式。

## 测试

新建 `tests/e2e/gui-ui-audit.mjs`（挂进 `test:gui`）：

1. **资料库空态**：进入资料库（无产物）→ `.data-overview` 与 `.state-empty` 的 rect
   满足 `empty.top >= overview.bottom - 1`，且 `empty` 水平居中（左右留白差 ≤ 8px）；
   截图浅/暗
2. **侧栏当前页**：点「项目」→ 该 nav-item 有 `aria-current="page"` 与 `.nav-item-current`；
   其它项没有；截图
3. **选中态**：进入专家页，点一个分类 → `.ex-cat.active` 的 computed background 等于
   `getComputedStyle(document.documentElement).getPropertyValue('--primary-active')` 的换算值
   （或断言 `aria-pressed="true"` + 背景与未选中项不同）；截图
4. **回复长度**：个性化页点「简洁」→ 按钮有 `.is-selected`，背景与未选中项不同；截图
5. **注入卡**：复用 `hooks-inject` 的场景（或 seed 一条 `custom_message`）→
   `.hook-context-toggle` 存在且折叠时文本为「查看内容」，点击后 `<details open>`；
   `summary` 可聚焦（`tabIndex` 默认可聚焦，断言 `getComputedStyle` outline 在
   `:focus-visible` 下非 none —— 若无法稳定断言，改为截图 + 存在性）
6. 浅/暗截图进 `artifacts/ui-audit/`

单测：`tests/unit/theme-contrast.test.mjs`。

## 文档

- `docs/DESIGN.md` §2.1：faint 实测对比度与新 alpha
- `CHANGELOG.md` `[Unreleased]` → 修复（「此前对比度 2.94:1」「选中态两套颜色」等写清后果）
- `.trellis/spec/renderer/index.md`：补一条「当前页/选中态必须同时有视觉与 aria 两个通道」
  （若已有同类条目则合并）

## 风险与回滚

- 改 token 影响 96 处 faint 用法：只调透明度、不改结构；浅/暗截图复核层级没有被拉平
- 侧栏新增 class 不影响布局（仅底色与字重）
- 资料库 CSS 只动空态组合；有产物时规则不命中
- 全部是 UI 增量，回滚单文件即可
