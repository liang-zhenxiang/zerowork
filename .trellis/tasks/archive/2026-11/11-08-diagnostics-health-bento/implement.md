# 执行清单

> 实现顺序即提交顺序：每个闭环单独提交，便于 review 与回滚。

## 1. 健康评分纯模块

- [ ] 新建 `src/renderer/src/health-score.js`：`computeHealth(input)`、`healthBand(score)`、`HEALTH_MAX_PER_ITEM = 25`
- [ ] 新建 `tests/unit/health-score.test.mjs`，覆盖：
  - 四项全满 → 100 / 状态良好
  - 模型未配置 → 模型 0，建议指向模型
  - 运行时 `master: false` → 10 且文案说明是用户选择
  - 任务：无已结束记录 → 25；10 成功 10 失败 → 13
  - 快捷键 `failed` → 0
  - 某维度读取失败 → 0 且 status = unknown，建议提到「无法判断」
  - 并列最低分 → 按固定顺序取建议
- [ ] `npm test -- tests/unit/health-score.test.mjs` 通过

## 2. 诊断页评分环

- [ ] `src/renderer/src/app.js` 顶部 import 新模块
- [ ] `DiagnosticsView` 并行加载四项数据，单项失败不影响其余
- [ ] 顶部新增评分环区块（SVG + 四行分项 + 一句建议）
- [ ] `app.css` 末尾追加评分环样式（只用 token）
- [ ] 暗色 / 浅色目测检查（截图见第 4 步）

## 3. 首页 Bento

- [ ] `HomeView`：胶囊取 `welcome.chips` 全量；`itemsForChip` 传全量 cases
- [ ] 选中胶囊时下方案例按全量 cases 过滤
- [ ] 渲染：`.capability-row` 内嵌 `.bento-grid`，8 张 `.bento-card`
- [ ] 卡片点击复用 `toggleChip`；保留 `aria-haspopup` / `aria-expanded`
- [ ] `app.css` 末尾追加 Bento 样式与响应式断点
- [ ] 确认 `.capability-row` 的 `margin-bottom` 仍是 24px

## 4. 测试与留档

- [ ] 新建 `tests/e2e/gui-health-bento.mjs`
- [ ] `package.json` 增加 `test:gui:health-bento`，并接入 `test:gui` 链（放在 `prompt-templates` 之后即可）
- [ ] 跑 `npm run test:gui:health-bento`
- [ ] 跑 `npm run test:gui:smoke`（垂直节奏）
- [ ] 截图落到 `artifacts/health-bento/`（浅色 / 暗色 / 诊断页 / 首页）
- [ ] `CHANGELOG.md` 的 `[Unreleased]` →「新增」两条（评分环、Bento）

## 5. 收尾

- [ ] `npm run lint:all`（zizmor 需要本机 Docker；环境缺失时在 PR 里如实说明）
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run check:unicode`
- [ ] 分支 `feat/diagnostics-health-bento` → PR，正文含 `Closes #268`
- [ ] CI 绿后 squash 合并，核对 Issue 关闭

## 回滚点

- 纯渲染层 + 一个纯模块；任一提交可独立 revert
- 不写 preferences、不改 IPC、不动 `resources/**`
