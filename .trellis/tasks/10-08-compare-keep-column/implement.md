# 执行清单：把对比满意的那一列收进会话

> 每阶段闭环就提交。实现交给子 agent；主会话派发与验收。

## 阶段 0（已完成）

- [x] 分支 `feat/compare-keep-column`、任务激活、research 两份落盘（prereq / design-spec）

## 阶段 1：daemon —— 登记表 + `compare:keep`

- [ ] **先写单测** `tests/unit/compare-keep.test.mjs`（TDD 先红后绿）
  - 登记表：命中 / 未命中（run 结束即丢的场景）/ 同 runId+columnId 重复
  - 标题格式：`{模型名} · {问题前 N 字}`、超长截断（≤ `SESSION_TITLE_MAX`）、
    模型名解析失败的回落、问题为空串
  - **剔除 `compare_run` 后的文件头部可读且 parentId 重接**（核心用例，
    夹具用手写的 jsonl 文本，不需要真起 pi）
  - cwd 改写：原 compare 目录 → 用户工作空间
- [ ] `src/main/daemon/compare.js`：`finally` dispose 前记 `host.sessionFilePath`；
      run 级登记表（带上限，见 prereq §A3 的约束）；只记**到达终态**的列
- [ ] `src/main/daemon/session-files.js`：`[INVOKE.compareKeep]` handler
      （分叉 → 剔标记重接 parentId → 改 cwd → 起标题 → parentSession → pushTaskListChanged）
- [ ] `src/shared/ipc.js` + `src/preload/index.js`：常量 + 两份副本 + 方法
- [ ] **反向验证**：去掉「剔除 `compare_run`」那一步 → 核心用例变红（新会话会被过滤）；
      去掉「重接 parentId」→ 对应用例变红

**验证**：`npm test`、`npm run check:daemon-graph`、`node scripts/lint.mjs`。

## 阶段 2：渲染层（照 `research/design-spec.md`）

- [ ] 完成态操作行加「留为会话」（含 title 提示）
- [ ] 保存中 / 已留（`.mini-btn.saved`）/ 失败 toast / 「去这条会话 →」
- [ ] 只对 done 列渲染；离开对比屏状态重置（既有行为，不新增持久化）
- [ ] 同步对比屏头注与 USAGE 里「不进历史」的表述
- [ ] `git diff --stat` 复核无重排

**验证**：build + `check:renderer-assets`、`lint:all`、既有 GUI 用例抽查（compare / settings / sections）。

## 阶段 3：e2e（真实启动 + 截图）

新增 `tests/e2e/compare-keep.mjs`，挂进 `test:gui` 链条：

- [ ] 两台 mock 跑完 → 点列 A「留为会话」→ toast → **侧栏出现新会话**
- [ ] 标题含该列的模型名与问题摘要
- [ ] 「去这条会话 →」→ 进入会话，**能看到这轮问答**（问题文本 + 列 A 的回答），
      **继续发一条消息能收到回复**
- [ ] 同列再点 → 明确被拒，侧栏会话数不变（无孪生）
- [ ] 列 B **不出现**在侧栏（对比列依旧即弃）
- [ ] 侧栏没有 `compare` 工作空间组
- [ ] 统计计数包含新会话（普通会话口径）
- [ ] 浅色 / 深色截图 + 像素断言
- [ ] 反向验证 ≥ 2（剔除标记 / 防重复）

**验证**：`npm run test:gui:compare-keep`、`npm run test:gui` 全链条。

## 阶段 4：文档 + PR

- [ ] CHANGELOG「新增」；USAGE 的「三条边界」与「怎么用」修订
- [ ] PR 正文 `--body-file`、`Closes #N`、CI 绿、squash 合并、复核远端