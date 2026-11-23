# 执行清单：修订写回（#458）

## 0. 开工

- [x] 分支 `feat/doc-edit-apply`，任务目录与 prd/design/implement 落盘
- [x] Issue #458 留言「我开始了」，确认无并行 PR/分支

## 1. 合并算法与读写

- [x] `mergeSelectedHunks`（纯函数）+ 单测（全选 / 部分 / 非法 id）
- [x] `checkFreshness`（当前哈希 vs base）+ 单测
- [x] `applyProposal`：哈希守卫 → 版本快照 → 原子写 → 审计 → 删建议
- [x] `rejectProposal`：审计 → 删建议，不碰目标文件
- [x] 版本记录 io-error 时中止写回；单测钉住

## 2. IPC 与读取增强

- [x] `session:apply-doc-edit` / `session:reject-doc-edit` 常量 + preload
- [x] `readDocEdit` 返回 `stale` / `currentSha256`
- [x] handler 校验 id / hunkIds，错误可操作

## 3. 测试

- [x] `tests/unit/doc-edits-apply.test.mjs`：全部/部分接受、原文改动、拒绝零副作用、
      版本可还原、审计不含正文、非法输入、成功后删除建议
- [x] 扩展现有 `gui-doc-edit-base.mjs` 一条「过期拒绝 + 接受写回」（完整五条归 #459）。
      本用例的建议是 write 新建的，没有旧内容 → e2e 断言「新建文件不留空版本」；
      「有旧内容时版本可还原」由单测钉住

## 4. 验证

- [x] `npx vitest run tests/unit/doc-edits*.test.mjs`（52 通过）
- [x] `npm test`（68 文件 / 1537 通过）
- [x] `npm run build`；`check:unicode` / `check:renderer-assets` / `check:daemon-graph`
- [x] 回归 `gui-smoke`（23/23）/ `review-desk`（8/8）/ `gui-file-history`（10/10）
- [x] `lint:all`（仅 zizmor 失败：本机 Docker 未运行；actionlint / yamllint 未安装属跳过）
- [x] 反向验证（真跑并还原）：去掉哈希守卫 → 过期用例变红（单测 1 条 + e2e 1 条）；
      未选中的 `+` 也追加 → 部分接受 3 条变红；版本失败不中止 → io-error 用例变红

## 5. 收尾

- [x] `CHANGELOG` 新增条目（写回能力，用户可见是「接受后文件才变化」）
- [ ] 提交 → PR（Closes #458）→ CI 绿 → squash
- [ ] 归档任务、更新 Roadmap

## 6. 建议的规格回写（交给主会话统一处理）

- `.trellis/spec/daemon/index.md` §十（改写工具行为的拦截）之后补一节「修订写回的三道闸」：
  哈希守卫（原文变了不写）、版本先行（留不下旧版本就不写）、审计不含正文；
  以及「新建文件的建议不记空版本」这条判据
