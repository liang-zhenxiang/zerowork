# PRD：P1-① 偶发失败的测试稳定化（#443）

## 背景

`gui-ui-audit` 的 P1-① 在 800 高偶发失败（同一构建，随后重跑即绿）：
`cases.height=226.8` 而不是稳定的 `212.4`；预留 268 与「案例高 + 56」只差 0.4px，
于是重叠约 14px。

连续 8 批案例（含 2 行标题）在字体 `document.fonts.status === "loaded"` 后实测
高度都是 212.4 —— 说明**布局本身稳定，变化发生在字体尚未就绪的窗口期**。
`waitForSettled` 等的是 DOM 静默期，字体替换不会改动 DOM，不会重置静默计时。

## 目标

让 e2e 的「界面稳定」包含字体就绪，消除这类「同一构建偶尔量到不同高度」的假红。

## 非目标

- 不改 `--home-case-reserve`（268 在字体就绪后仍有 0.4px 余量，属既有标定）。
- 不放宽 P1-① 的断言容差。
- 不重构 harness 的其他等待语义。

## 约束

- 只在 `waitForSettled` 开始观察之前等待 `document.fonts.ready`；字体加载失败时
  该 promise 仍会 resolve，不能因此卡死。
- 不新增固定 sleep；不让测试依赖「本机字体是否已缓存」。

## 验收标准

- [ ] `waitForSettled` 返回时 `document.fonts.status === "loaded"`（新增断言或 e2e 证据）。
- [ ] 连续跑 `gui-ui-audit` 至少 3 次，P1-① 都绿；`gui-smoke` 不受影响。
- [ ] 不降低任何断言强度；`npm test`、`lint:all`、`check:unicode` 通过。
- [ ] `CHANGELOG` 记「修复」（测试稳定性）；在 #443 说明根因与修法。
