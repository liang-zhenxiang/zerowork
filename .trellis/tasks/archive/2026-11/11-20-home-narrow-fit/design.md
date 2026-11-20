# 设计：首页窄宽 860 高（#437）

## 1. 根因（实测）

| 窗口 | `.bento-grid` | 能力宫格高 | composer 底 |
| --- | --- | --- | --- |
| 1280×860 | 5 列 2 行 | 151.2 | 833.4（首屏内） |
| 1024×860 | 5 列 2 行 | 151.2 | 844.2（首屏内，余 9.8） |
| 920×860 | 5 列 2 行 | 151.2 | 844.2 |
| **900×860** | **2 列 4 行** | **286.4** | **979.4（溢出 125）** |

`app.css` 的 `@media (max-width: 900px)` 把宫格退回 2 列（原意是窄窗别把描述压没），
但窗口最小宽度正好是 900（`index.js` 的 `minWidth: 900`），在 860 高下这块
多出来的 135px 直接把输入卡顶出首屏。高度档（≤840/≤800）管不到 860。

## 2. 修法

把 `@media (max-width: 900px)` 的 2 列规则换成**横向可滚单行**：

```css
@media (max-width: 900px) {
  .bento-grid {
    display: flex;
    gap: var(--space-3);
    overflow-x: auto;
    /* 与 .capability-row / .ex-cats 同口径：隐藏滚动条，保留触摸板横滑与键盘 */
    scrollbar-width: none;
  }
  .bento-grid::-webkit-scrollbar { display: none; }
  .bento-card { flex: 0 0 210px; }
  .bento-card.bento-wide { flex-basis: 280px; }
}
```

- 卡片仍保留名称 / 描述 / 计数三段（描述本来就 `nowrap + ellipsis`），单行高约 60px；
  能力宫格总高从 286 → ~84，composer 底 776.6，留 77px 余量。
- 8 张卡的 DOM 全在，横向滚动即可看全；首张与末张的 `bento-wide` 只影响宽度。
- 宽度 ≥901 的 5 列布局与所有高度档不变；`--home-case-reserve` 不动。

## 3. 测试

- `tests/e2e/gui-ui-audit.mjs` 的 P1-①：
  - 完整档断言保持（1280×860 5 列、宫格可见、composer 不溢出）；
  - 新增窄宽分支：请求 900×860（高度被物理屏钳制到 ≤840 时显式 SKIP），
    断言 composer 不溢出、`.bento-grid` 的计算 `display === "flex"`、
    `scrollWidth > clientWidth` 且 `.bento-card` 数量为 8；测完还原尺寸。
- 反向验证：把这条媒体规则改回 2 列 → 窄宽分支必红（实测 slot 底 979）。

## 4. 文档

- `docs/DESIGN.md` §3.8.1 的表格补一列/一行：窄宽（≤900）单行横向滚动；
  说明「高度档管竖、宽度档管横」。
- `CHANGELOG [Unreleased] 修复`：写清此前 900×860 输入卡被顶出首屏的后果。
