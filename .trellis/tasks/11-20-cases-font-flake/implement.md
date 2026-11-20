# 实施清单：P1-① 测试稳定化（#443）

1. `tests/e2e/lib/harness.mjs` 的 `waitForSettled`：在启动 MutationObserver 之前
   `await win.evaluate(async () => { await document.fonts?.ready; })`。
   注释写清：字体替换不改 DOM、静默计时不会重置；布局测量必须等字体就绪。
2. `tests/e2e/gui-ui-audit.mjs` P1-①：在 `waitForSettled` 后补一条显式断言
   `document.fonts.status === "loaded"`（把修法本身钉住，而不是只靠注释）。
3. `CHANGELOG.md [Unreleased] 修复`：测试稳定性一条，不写成产品行为变化。
4. 验证：
   - 连续 3 次 `node tests/e2e/gui-ui-audit.mjs`，P1-① 全绿（记录每次结果）
   - `node tests/e2e/gui-smoke.mjs`
   - `npm test`、`npm run check:unicode`、`npm run lint:all`
   - 可选反向验证：临时把字体等待挪到观察之后 → 注释说明，不必制造假红
5. 不 commit；完成后报告真实输出（含 3 次的 P1-① 结果）。
