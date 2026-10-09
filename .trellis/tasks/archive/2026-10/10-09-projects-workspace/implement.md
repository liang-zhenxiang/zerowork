# 执行清单：项目工作区 Projects

> 顺序即依赖序；每步的验证命令跑绿才进下一步。提交粒度：一个小闭环一个 commit
>（本任务预计 5–6 个 commit，最后一个统一挂 PR）。

## A. daemon 层（存储 + IPC + 注入）

- [ ] A1 `config-paths.js` 加 `getProjectsFile()`；`projects.js`：store 类
      （ensureLoaded/persist 原子写/CRUD/assignSession 跨项目去重/instructionsFor 反查）
- [ ] A2 单测 `tests/unit/projects-store.test.mjs`：CRUD、坏文件当空、结构校验拒收、
      assignSession 从旧项目移除、会话引用不清理、色轮转
- [ ] A3 IPC 四处登记（shared/ipc.js INVOKE ×7 → session-files.js handlers（参数逐个
      校验）→ preload 暴露）；listSessions 增量字段 projectId
- [ ] A4 指令注入四处小改（prompt-compose / command-exec getCurrent / session-files
      compose 回调 / resources 透传）+ 单测（含「无指令与现状逐字节一致」快照）
- [ ] 验证：`npx vitest run tests/unit/projects-store.test.mjs` +
      compose 相关单测；`npm run check:daemon-graph`

## B. 渲染层（逻辑 → 视图 → 侧栏）

- [ ] B1 `projects-core.js` 视图模型纯逻辑 + 单测（卡片排序、产物按会话过滤、
      色轮转、指令字数校验）
- [ ] B2 `projects-view.js`：ProjectView（L1 卡片墙 / L2 详情），三态纪律照
      LibraryView；先接 ux-designer 方案收敛视觉再动手写样式
- [ ] B3 `app.css` 追加 projects 区段（全走 token；亮暗双查过 check:theme-tokens）
- [ ] B4 `app.js` 追加：NAV ready + onClick 分发 + onOpenProjects（照 openLibrary
      记 returnView）+ view 装配 + Sidebar 传 prop + 会话行 ⋯ 菜单「归入项目」子菜单
      + 会话行项目色点
- [ ] 验证：`npm run build` 后手动 dev 打开过一遍（截图自查看三态）

## C. 端到端（GUI 用例 + 截图）

- [ ] C1 `tests/e2e/projects.mjs`（挂进 test:gui 链）：
  - 建项目 → 空态→卡片墙（浅/深截图+像素断言）
  - 会话归入（⋯ 菜单）→ 详情看到会话 → 点开 resume 成功
  - 指令注入：编辑指令 → 发消息 → mock 收到的 systemPrompt 含指令段
  - 删除项目 → 会话仍在侧栏
- [ ] C2 反向验证（真跑并还原）：去掉注入段的 push，C1 指令断言变红；
      去掉 assignSession 去重，store 单测变红
- [ ] 验证：`node tests/e2e/projects.mjs` 全绿；全量 `npm run test:gui` 31+1 套件

## D. 收尾

- [ ] D1 `npm run lint:all`（16 项+新检查过）+ `npm test`（全量单测）
- [ ] D2 中文 U+FFFD 扫描（脚本见 AGENTS.md）
- [ ] D3 CHANGELOG `[Unreleased]` 新增条目；docs/USAGE.md 增「项目」一节
      （含概念边界表：工作空间 vs 项目）
- [ ] D4 视觉终审：浅/深主题截图对照设计师方案复核，确认「精品」
- [ ] D5 提交（约定式提交、-F 文件、无反引号）→ push → PR（--body-file 含
      Closes 语句）→ `gh pr checks` 只认 CI 总览 → squash 合并 → 核对 Issue 关闭

## 回滚点

- A 步任意失败：revert daemon commit，渲染层未动
- B 步样式不满意：app.css/projects-view.js 独立 commit，可单独重做
- C 步注入断言失败：优先查 compose 回调链（design.md §3 的 4 处），不动 store
