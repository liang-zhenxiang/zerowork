# 执行清单:「值守」

对应 `prd.md` / `design.md`。按顺序做,每步可独立验收。

## 阶段 0:准备(已完成)

- [x] 任务目录与规划产物落盘
- [ ] 从最新 `main` 切分支 `feat/watch-policy`
- [ ] 建 GitHub Issue,拿编号回填到本文件与 PR 正文

## 阶段 1:daemon 地基(纯逻辑,可毫秒级单测)

- [ ] `src/main/daemon/watch-policy.js`
  - [ ] `WATCH_LIMITS` 常量(120 分钟 / 16 条 scope / 200 字符)
  - [ ] `TIER_RANK` 与 `effectivePolicy(watch, globalTier)` —— **只能更严的收敛**
  - [ ] `parseWatchPolicy(raw)` —— 非法值抛错,不静默修正
  - [ ] `evaluateWatchBoundary(intent, policy)` —— 四条判定顺序
  - [ ] `summarizeRun(run)` —— 五态结论
  - [ ] `appendExceed(boundary, item)` —— 上限 20 条 + 溢出计数
- [ ] `tests/unit/watch-policy.test.mjs` —— 先写测试再写实现(TDD)
  - [ ] **「只能更严」三条断言**(本功能的核心不变量)
  - [ ] 缺省时与今天逐字段相同(回归保护)
  - [ ] 边界求值四条判定顺序各一条
- [ ] 跑 `npm test -- watch-policy` 确认绿

## 阶段 2:daemon 接线

- [ ] `automation.js` 的 `parseTask` 放行可选 `watch`(调 `parseWatchPolicy` 校验)
- [ ] `session-files.js`:
  - [ ] `createWatchBoundary` extension —— **包在 `createPermissionGate` 之前**,
        只做额外拒绝(合取项,不是析取项)
  - [ ] `buildRunExtensions` 接入(需要把 policy 传进来)
  - [ ] `AutomationScheduler.execute` 加时限 + `AbortController` + 中止原因 `watch-timeout`
  - [ ] `appendRun` 调用点补 `boundary`
- [ ] `npm run check:daemon-graph` 确认 import 图不成环
- [ ] **真实启动一次应用**(daemon 顶层求值顺序的坑只在真实启动时暴露)

## 阶段 3:渲染层

- [ ] `src/renderer/src/watch-policy-core.js` —— 纯逻辑(文案 / 结论 / 老记录兜底)
- [ ] `tests/unit/watch-policy-core.test.mjs`
- [ ] `app.js` 的规矩编辑区(收进既有编辑面板)
- [ ] `app.js` 的可展开交差报告
- [ ] `app.css` 视觉(只用既有 token)
- [ ] 若有新动画 → 登记 `docs/DESIGN.md` §10.3 与 §10.3.1

## 阶段 4:UI/UX 评审

- [ ] 派 UI/UX 设计师 subagent 出稿 `research/ux-proposal.md`
- [ ] 实现后派同一个角色评审 → `research/ux-review.md`
- [ ] 意见逐条处置并在 `research/ux-review.md` 里记「采纳 / 不采纳 + 理由」

## 阶段 5:端到端

- [ ] `tests/e2e/watch-policy.mjs`(真实启动 + mock 模型)
- [ ] `tests/e2e/gui-sections.mjs` 的自动化分区补断言
- [ ] `package.json` 的 `test:gui` 链条登记新用例
- [ ] 浅色截图 + 暗色至少一张

## 阶段 6:反向验证(注入 → 变红 → 还原 → 复绿)

- [ ] 注 1:`effectivePolicy` 改成取更宽 → 确认恰好相关用例变红
- [ ] 注 2:注掉 `onExceed` 上报 → 确认越界证人相关用例变红
- [ ] 两次都记录「改了哪一行 / 哪些用例变红 / 还原后复绿」

## 阶段 7:质量门槛与文档

- [ ] `npm run lint:all`
- [ ] `npm run test`
- [ ] `npm run test:gui`
- [ ] `npm run check:unicode`(中文内容必扫)
- [ ] `CHANGELOG.md` 的 `[Unreleased]` → 「新增」
- [ ] `docs/USAGE.md` §自动化 扩写 + §权限与命令执行 补一段
- [ ] `docs/ARCHITECTURE.md` 决策表补两行
- [ ] `.trellis/spec/daemon/index.md` 权限一节补「第三条线」

## 阶段 8:提交与 PR

- [ ] 小批量提交(daemon 地基 / daemon 接线 / 渲染层 / 测试与文档)
- [ ] 提交信息走约定式,**正文写为什么**,不用反引号(shell 替换风险)
- [ ] PR 正文写进临时文件用 `--body-file`,含 `Closes #N`
- [ ] `gh pr checks` 等 `CI 总览` 绿
- [ ] `gh pr merge --squash --delete-branch`
- [ ] **复核 Issue 真的关闭了**
- [ ] 归档 Trellis 任务 + 写会话日志
