# 执行计划:首页「继续推进」工作台

前置:prd.md(需求)、design.md(技术方案)、research/ux-proposal.md(视觉合流稿)。
顺序执行,每步有验证;步骤 1-2 可与视觉定稿并行,步骤 4 依赖视觉稿。

## 步骤

### 1. daemon 纯模块 + 单测(先行,零依赖)

- [ ] 新建 `src/main/daemon/session-digest.js`:
  `summarizeLastActivity(records, opts)` + 常量 `DIGEST_TEXT_MAX=60` /
  `DIGEST_TAIL_WINDOW=200` / `DIGEST_LARGE_FILE_BYTES=2MB` / `DIGEST_NAMES_MAX=2`
- [ ] 新建 `tests/unit/session-digest.test.mjs`(design.md §7 单元清单全覆盖,
  含反向验证一条)
- 验证:`npx vitest run tests/unit/session-digest.test.mjs`
- 回滚点:纯新增文件,独立可弃

### 2. IPC 契约 + IO 编排

- [ ] `src/shared/ipc.js`:INVOKE 加 `sessionDigest: "session:digest"`,
  JSDoc 注明「按需拉取、不进 sessionList 热路径」的原因
- [ ] `src/main/daemon/session-files.js`:`sessionDigest(paths)` 处理器
  (stat 超限退化 / open+getEntries 尾窗 / ENOENT→error;并发 4;入参上限 8)
- [ ] `src/preload/index.js`:`sessionDigest: (paths) => ipcRenderer.invoke(...)`
- [ ] `src/main/index.js` **不动**:非 MAIN_HANDLED 的通道由 registerIpc 批量转发
  给 daemon(已核实,main/index.js:381),无需登记路由
- [ ] `tests/unit/ipc.test.mjs` 补契约条目(INVOKE 名存在、唯一)
- 验证:`npx vitest run tests/unit/ipc.test.mjs && npm run lint:all`

### 3. 渲染层组件与数据流(视觉未定稿前先出结构,样式类名按方案稿)

- [ ] `app.js`:新增 `HomeResumeDeck`(props: sessions/digests/onResume;
  无会话返回 null;摘要缺失位留白不跳动);`recentForHome` 的 slice 数按定稿调整
- [ ] `app.js` App 数据流:`useEffect[recentForHome]` 拉_digests(失败整体降级),
  替换 HomeRecentSessions 调用点(位置:composer-zone 内清单正下方,不动)
- [ ] 删除 `HomeRecentSessions` 组件与 `home-recent*` 相关引用(避免死代码)
- 验证:`npm run build` 过 + 现有 `onboarding.mjs` e2e 不红

### 4. 视觉落地(依赖 ux-proposal 合流稿)

- [ ] `app.css`:按合流稿实现(档位纪律、四态、暗色同构;
  running 信号形态+文字)
- [ ] 与 UI/UX 设计师 subagent 迭代:截图 → 评审意见 → 修改,记录进
  research/(至少一轮)
- 验证:`npm run check:theme-tokens` 绿;截图目检浅暗两态

### 5. e2e

- [ ] 新建 `tests/e2e/home-resume-deck.mjs`(design.md §7 e2e 五节;
  照 turn-trace / artifact-present 的 mock 形态)
- [ ] 真跑通过 + 截图归档;反向验证一条(改坏摘要优先级 → 对应断言变红 → 还原)
- 验证:`node tests/e2e/home-resume-deck.mjs` 退出码 0

### 6. 文档与收尾

- [ ] `docs/USAGE.md`:首页段落补「继续推进」说明
- [ ] `CHANGELOG.md` [Unreleased] 新增条目
- [ ] 全量:`npm run lint:all && npm run test && npm run test:gui`
- [ ] Trellis:spec 若有新沉淀(workflow/testing 层面)更新;归档任务走 finish-work

## 评审门

- 步骤 2 后:主会话自查契约与热路径隔离(ipc.js 注释口径)
- 步骤 4 中:设计师评审(硬要求,意见留痕)
- 步骤 5 后:反向验证记录写进任务目录

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| 首页布局与上手清单打架 | 组件位置不动;e2e 回归 onboarding;骨架纪律(摘要位留白) |
| digest 拉取抖动(频繁触发) | 依赖数组用 recentForHome 引用;sessionListPush 频率本就低 |
| 大会话读文件慢 | 2MB 阈值 + 尾窗 200 条;超限 fallback 不读 |
| app.js 大文件手术风险 | 只动三处:新组件插入、调用点替换、数据流 hook;不动周边 |
