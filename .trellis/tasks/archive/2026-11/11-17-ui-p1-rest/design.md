# 技术设计：UI 剩余 P1 四项

## 1. 首页矮视口

`app.css`（约 :14066 / :14075）：

```css
.home-inner {
  max-width: 900px;
  min-height: max(680px, 100%);
  --home-case-reserve: 268px;   /* 案例区预留，§3.8 的配比由它决定 */
}

.home-main {
  padding-bottom: var(--home-case-reserve);
  …
}

@media (max-height: 720px) {
  .home-inner { --home-case-reserve: 170px; min-height: 100%; }
}
```

- 只改「矮视口」这一档，不动 860 高下的 268；变量名自解释
- 若 `.cases` 因资源加载失败不渲染，268 的预留仍在（后续可单独优化，本轮不做）

**测试**：在 `gui-ui-audit.mjs` 加 `resizeWindow(1024, 679)`（照 `gui-plan-book.mjs`
的 helper；CI 屏幕会钳制，因此断言用**实际** innerHeight），回到首页后量
`.composer-slot` 与 `.home` 的 rect：`composer.bottom <= home.bottom` 且
`composer.top >= home.top`。测完恢复原尺寸。

## 2. 统计页头部

`app.js` 的 StatsView 头部：

- 数据类动作（分享卡 / 本周摘要 / 导出 CSV）加 `!empty2 &&` 条件
- 「重试首页」去掉 `IconRefresh`（保留文字，避免两枚相同图标）；`刷新` 保留图标
- `empty2` 定义已在渲染前，直接用

**测试**：`gui-ui-audit` 新增：进入统计（空数据夹具）→ 头部不存在「分享卡 / 本周摘要 /
导出 CSV」；「刷新」存在；「重试首页」存在但内部 **无 svg**。

## 3. 记忆空态可点

`app.js` 的 `profile-view`（约 :68686）：

```jsx
<div
  className={`profile-textarea profile-view${editing ? "" : " is-clickable"}`}
  role={editing ? undefined : "button"}
  tabIndex={editing ? undefined : 0}
  onClick={editing ? undefined : () => setEditing(true)}
  onKeyDown={editing ? undefined : (e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setEditing(true); }
  }}
>
```

- 仅在**非编辑态**挂 button 语义；编辑态是 textarea，避免嵌套交互
- CSS：`.profile-view.is-clickable { cursor: text; }` + `:focus-visible` 用全局 `--ring`
  （类名要进全局焦点环选择器或在本地补）
- 文案保留「暂无内容，点击编辑添加」（现在承诺成立）

**测试**：进入设置 → 记忆与进化 → 空态块 `role=button`、点击后出现 textarea（编辑态）。

## 4. 侧栏空间组名两行

`app.js`（约 :14428）结构改为：

```jsx
<button className="space-group-header-main" …>
  <span className="space-group-title-row">
    <IconFolder/><IconChevronDown/>
    <span className="space-group-name">{group.name}</span>
    {isCurrent && <span className="space-group-badge">当前</span>}
  </span>
  <span className="space-group-sub-row">{n} 会话{…}</span>
</button>
```

`app.css`：

```css
.space-group-header-main { flex-direction: column; align-items: stretch; gap: 2px; }
.space-group-title-row { display: flex; align-items: center; gap: var(--space-1); min-width: 0; }
.space-group-name { flex: 1 1 auto; }          /* 已有省略号三件套 */
.space-group-sub-row { padding-left: 18px; font-size: 11px; color: var(--text-secondary); }
.space-group-meta { margin-left: 0; }           /* 原 nowrap 保留 */
```

- 操作区 `.space-group-actions` 仍是组头（外层 flex row）的兄弟，位置不动
- 未就绪/折叠逻辑不变

**测试**：`gui-ui-audit` 里预置一个空间（session cwd 指向工作区），断言
`.space-group-sub-row` 与名称**不同行**（sub.top > name.bottom），且名称可见宽度
大于一个阈值（比如 ≥ 60px，具体按实际侧栏宽）；hover 不再需要 title 才能辨认。

## 测试与文档

- `tests/e2e/gui-ui-audit.mjs` 扩四组检查 + 浅/暗截图到 `artifacts/ui-audit/`
- 反向验证：把 reserve 改回固定 268 → 矮视口用例红；去掉空态可点 → 记忆用例红
- `CHANGELOG.md`「修复」四项各一句
- `.trellis/spec/renderer/index.md`：补充「矮视口必须先量 composer 几何」到第九节（若合适）

## 回滚

CSS 与渲染层小改，逐项可独立回滚；不改数据与 IPC。
