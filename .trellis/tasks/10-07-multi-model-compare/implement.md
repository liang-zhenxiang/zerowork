# 执行清单：一问多答（多模型并排对比）

> 每个阶段**闭环就提交**。阶段末尾的「验证」是门禁，不过不进下一段。
> 实现由子 agent 完成；主会话派发与验收（`.trellis/spec/workflow/index.md`）。

---

## 阶段 0：准备（主会话）

- [ ] `git checkout -b feat/multi-model-compare`（从最新 `main`）
- [ ] `python3 ./.trellis/scripts/task.py start .trellis/tasks/10-07-multi-model-compare`
- [ ] 填 `implement.jsonl` / `check.jsonl`

---

## 阶段 1：纯逻辑（先写测试）

- [ ] **先写** `tests/unit/compare-core.test.mjs`（TDD：先红后绿）
  - `normalizeColumns`：0 / 1 / 5 个模型**明确拒绝**并给出原因；2–4 通过；重复模型要去重还是拒绝（**定一个口径并写进注释**）
  - `createColumnStates` / `reduceColumn`：全状态机的合法转移；**非法转移要能拒绝或明确忽略**
  - **列间隔离**：把 A 列的事件喂给归约器，B 列的状态**必须一字不变**（这是「不串台」的根）
  - `extractUsage`：有 `usage` / 缺 `usage` / 畸形 `usage`
  - `accumulateTiming`：耗时**从该列自己开始跑那一刻起算**（不是整体开始）
- [ ] 实现 `src/main/daemon/compare.js` 的纯逻辑部分（不含宿主创建）
- [ ] **反向验证**：把「列 id 不匹配就丢弃」的判据去掉 → 确认列间隔离那条**恰好**变红

**验证**：`npx vitest run tests/unit/compare-core.test.mjs` 全绿；`npm run check:daemon-graph` 通过。

---

## 阶段 2：编排（真起宿主）

- [ ] `createCompareRunner(deps)`：并发闸、每列一个宿主、事件打列 id、超时、abort、**`finally` 里 dispose**
- [ ] **额度另立**（不占 `SPAWN_BUDGET_PER_SESSION`）
- [ ] **不装扩展**（不跑工具）；做不到就回落只读档并在报告里说明
- [ ] `session-host.js` 只加 `markCompareRun(...)`（照 `markSubagentRun`）
- [ ] `CHILD_SESSION_CUSTOM_TYPES` 加 `compare_run`
- [ ] **单测补**：并发闸行为、异常路径也会 dispose、abort 能同时收掉所有列

**验证**：单测全绿；`npm run check:daemon-graph`；
**判据**：`git diff src/main/daemon/session-host.js` 里不得出现 `prompt(` / `translate` / `ablate`。

---

## 阶段 3：IPC 与 preload

- [ ] `src/shared/ipc.js`：`compare:start` / `compare:abort` / `compare:event` + 契约注释
      （**注释里要写清「为什么不复用 `sessionEvent`」**，把三条理由搬进去）
- [ ] `src/preload/index.js`：两份手工副本 + 3 个方法（含 `onCompareEvent`）
- [ ] `src/main/daemon/session-files.js`：注册 handler，把 deps 喂给编排模块
- [ ] **确认 main 不需要改**（`src/main/index.js` 的 `ipcMain.handle` 是通配转发）

**验证**：`npm test`（含 `tests/unit/ipc.test.mjs` 的通道名规范）、`npm run check:daemon-graph`、`node scripts/lint.mjs`。

---

## 阶段 4：渲染层（视觉规范见 `research/design-spec.md`）

- [ ] 新建 `src/renderer/src/compare-view.js`：视图本体、N 列、每列 state、自算耗时用量
- [ ] `app.js` 定点改：`view` 取值、挂载点、⌘K 动作、模型菜单入口
- [ ] `app.css`：只加必要样式，**只用既有 token，尽量复用既有类名，不新增档位与布局过渡例外**
- [ ] **不重排、不格式化**；`git diff --stat src/renderer/src/app.js` 复核改动规模并写进报告

**验证**：`npm run lint:all`、`npm run build && npm run check:renderer-assets`、
`npm run check:theme-tokens`、`npm run check:design-exceptions`。

---

## 阶段 5：e2e（真实启动 + 截图）

新增 `tests/e2e/multi-model-compare.mjs`，挂进 `package.json` 的 `test:gui` 链条：

- [ ] 起**两台** mock（端口不同、`reply` 不同、`models` 不同）→ 配两个 provider
- [ ] 从 ⌘K 打开对比视图 → 选 2 个模型 → 提一条问题
- [ ] **两列各自收到自己的回复**（判据：两列渲染出的文本分别等于两台 mock 的 `reply`；
      **不是**「界面没报错」）
- [ ] **两列各自的耗时/用量独立**（不是同一个数字复制两份）
- [ ] **一列失败另一列成功**（一台 mock 返回 500）—— 失败列的失败态可辨，成功列照常
- [ ] 第 5 个模型被**明确拒绝**（有可见反馈，不是静默忽略）
- [ ] **默认路径回归**：对比跑完之后，单模型对话仍能发消息并收到回复
- [ ] **不计入统计**：对比前后 `usageStats` 总量一致
- [ ] **不进侧栏**：`listSessions()` 里没有对比会话
- [ ] 浅色 / 深色各一张截图 + 像素断言；空态一张
- [ ] **反向验证**：至少三条，各自**恰好**相关用例变红
      （列间串台 / 一列失败拖垮全部 / 用量串进全局统计）

**验证**：`npm run test:gui:multi-model-compare` 通过；`npm run test:gui` 全链条通过；
确认用例真的在 `ci.yml` 的调用链里。

---

## 阶段 6：文档

- [ ] `CHANGELOG.md` `[Unreleased]` → 「新增」
- [ ] `docs/USAGE.md`：补「模型对比」一节，写明**不跑工具、不产生文件、不进侧栏、不计入统计**
- [ ] `docs/ARCHITECTURE.md`：若「专用通道」成为长期决策，补一行到决策表
- [ ] 全仓 U+FFFD 扫描

---

## 阶段 7：PR

- [ ] `npm run lint:all && npm test && npm run test:gui`
- [ ] PR 正文用 `--body-file`，含 `Closes #<issue>`
- [ ] 创建后复核 `Closes #N` 真的在正文里
- [ ] 等 `CI 总览` 绿 → squash 合并 → 复核 Issue 关闭与远端真实状态

---

## 回滚点

| 点 | 回滚动作 |
| --- | --- |
| 阶段 2 之后 | daemon 侧新模块可整文件删除；`session-host.js` 的那个标记方法可单独 revert |
| 阶段 4 之后 | 渲染层改动集中在**新文件** + `app.js` 的几处挂载点，可定点 revert |
| 任何阶段 | 未合并前 `git reset --hard` 到阶段起点；已合并的走新 PR 修复，不 force push `main` |