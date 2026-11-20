# 实施清单：首页窄宽 860 高（#437）

1. `src/renderer/src/app.css`：把 `@media (max-width: 900px)` 的 `.bento-grid`
   两列规则替换为横向 flex 单行（见 design §2）；隐藏滚动条，保留横向滚动。
2. `tests/e2e/gui-ui-audit.mjs` P1-①：
   - 完整档断言不变；
   - 新增窄宽分支：`resizeWindow(900, 860)`（高度被钳制到 ≤840 时 `h.skip`），
     断言 composer 不溢出、grid `display=flex`、`scrollWidth>clientWidth`、
     卡片数 8；`finally` 还原尺寸。
3. `docs/DESIGN.md` §3.8.1 补宽度档；`CHANGELOG.md` 记「修复」。
4. 验证：
   - `node tests/e2e/gui-ui-audit.mjs`（本机 860 高；完整档 + 窄宽档）
   - `node tests/e2e/gui-smoke.mjs`
   - `npm run build`、`npm run check:unicode`、`npm run lint:all`
   - 反向验证：把规则改回 2 列 → 窄宽分支必红；还原后绿。
5. 不 commit；完成后报告真实输出与截图（`artifacts/ui-audit/` 的首页窄宽）。
