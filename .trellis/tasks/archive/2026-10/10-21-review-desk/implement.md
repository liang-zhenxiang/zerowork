# 执行清单

## A. daemon 侧

- [ ] `src/main/daemon/version-store.js`
  - [ ] `listVersionFiles` 的每条补 `versionId / at / tool? / sessionId? / added? / removed?`
        （**只增字段**，既有 `count/lastAt/...` 一个都不动）
  - [ ] 若 `looksBinary` 未导出，导出它（供 review 复用同一判据）
- [ ] 新建 `src/main/daemon/review.js`
  - [ ] `reviewStatePath(dir)`、`readReviewState(dir)`（坏文件当空）、`writeReviewState(dir, state)`（原子）
  - [ ] `isReviewed(state, key, versionId)`
  - [ ] `buildReviewEntries(files, state)` → 纯函数，排序 + reviewed 标记 + 计数
  - [ ] `markReviewed(state, key, versionId)` → 纯函数，返回新 state（不改入参）
  - [ ] `readReviewDiff({ key, versionId, versionsDir, maxBytes })` → 边界判定 + 调 `computeLineDiff`
- [ ] `src/shared/ipc.js` 新增 `reviewList / reviewRead / reviewMark`
- [ ] `src/preload/index.js` 同名字面量映射 + `window.kami.reviewList / reviewRead / reviewMark`
- [ ] `src/main/daemon/session-files.js`（或 index.js 的 handler 装配处）注册三条 handler
- [ ] `tests/unit/review.test.mjs`
  - [ ] 坏状态文件当空
  - [ ] 版本 id 变化 → 回到待审阅（核心语义）
  - [ ] 排序按 at 降序、筛选计数正确
  - [ ] `readReviewDiff`：二进制 / 超大 / 文件不存在 / 正常 四条
- [ ] `tests/unit/version-store.test.mjs` 补「清单新增字段」断言（不破坏既有）

## B. 渲染层

- [ ] `app.js`：`ReviewView` 页 + 侧栏 nav-item（排在「文件历史」旁）+ 角标
- [ ] `app.css`：只复用既有 token；全页只有一个内容卡（DESIGN §3.9）
- [ ] 三态：加载 / 空 / 错误；空态写清「还没有需要审阅的变更」并说明只覆盖写入/编辑工具
- [ ] diff 着色：+/- 行用既有 `.code-block` token
- [ ] 动作：标记已阅（就地更新 + 角标）、还原（二次确认，复用 `restoreFileHistory`）、回到会话
- [ ] 状态不只靠颜色（DESIGN §7.6）：待审阅有文字标签

## C. e2e（`tests/e2e/review-desk.mjs`）

- [ ] 种子：`versions/` 目录 + 目标文件各写一份（V1 改前、当前内容 V2）
- [ ] 真实启动 Electron，侧栏进入「变更审阅」
- [ ] 断言：变更卡出现、`+N −M` 正确、点开有并排 diff
- [ ] 标记已阅 → 待审阅计数 -1；**重启 harness 后仍为已阅**
- [ ] 再写一次文件（或直接改 versions meta）→ 回到待审阅
- [ ] 还原 → **直接读磁盘字节**断言退回（不看 toast）
- [ ] 截图入 `artifacts/`
- [ ] 接进 `package.json` 的 `test:gui` 链与 `test:gui:review` 脚本

## D. 文档

- [ ] `CHANGELOG.md` `[Unreleased]` → `新增`
- [ ] `docs/ARCHITECTURE.md` 模块表补 `review.js`（一句话）
- [ ] `src/shared/ipc.js` 的注释按同风格写清契约与边界

## E. 验收

- [ ] `npm run test`
- [ ] `npm run test:gui`（真实 Electron）
- [ ] `npm run lint:all`（zizmor 需本机 Docker，已知例外）
- [ ] 反向验证至少两条（如：已阅判定改成恒真、diff 不读当前文件）→ 对应用例必须红
