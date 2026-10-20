# 会话检索：把「翻旧账」交还给人

关联 Issue：[#233](https://github.com/liang-zhenxiang/zerowork/issues/233)

## Goal

让使用者拥有与 Agent 同一套「会话全文检索」能力：输入关键词 → 按会话分组看到命中消息 →
点一条直接回到那条消息、并把它高亮出来。全部在本机完成，不联网。

## 背景：已核实的事实

| 项 | 结论 | 出处 |
| --- | --- | --- |
| 检索能力已存在，但只给了模型 | `searchSessionFiles(query, limit, options)` 扫 `<sessionId>.jsonl`，按 mtime 倒序、只扫最近 `SCAN_LIMIT=200` 个，AND 分词，每会话只返回第一条命中 | `src/main/daemon/session-files.js:327`、`src/main/daemon/session-state.js:968` |
| 纯函数可复用 | `deriveSessionTitle` / `entryText` / `extractSnippet` / `searchOneFile` 都在 `session-state.js`，无 electron 依赖，可单测 | `src/main/daemon/session-state.js:977-1030` |
| Agent 工具入口 | 工具名 `conversation_search`，`limit` 1..50，走 `deps.searchSessions` | `src/main/daemon/automation-tools.js:383`、`session-files.js:3240` |
| IPC 自动路由 | `Object.values(INVOKE)` 里不在 `MAIN_HANDLED` 的通道会自动 `ipcMain.handle` 到 daemon；daemon 只需在 `handlers` 表加同名 key | `src/main/index.js:377-386`、`src/main/daemon/session-files.js:4269`、`:5689` |
| 「定位到消息」已有实现 | `focusEntryInTurn(view, entryId)` 先展开 tool-group/process-fold 与回合折叠，两帧后滚动 + 加 `entry-flash` | `src/renderer/src/app.js:33049` |
| 会话文件与消息锚点 | 文件名即 sessionId；消息渲染带 `data-entry-id` | `src/main/daemon/session-files.js:2038`、`src/renderer/src/app.js:32064` |
| 页面壳与样式真源 | 页面复用 `.settings/.settings-head/.settings-body`；所有视觉值来自 `app.css` 的 `:root` | `src/renderer/src/app.js:68061`、`app.css` `:root` |

## Requirements

### R1 · daemon：一次扫描收集「多条命中」

- 在 `session-state.js` 新增纯函数 `searchFileHits(content, terms, { limit, radius })`：
  返回 `{ sessionId, title, totalHits, hits }`，`hits` 按出现顺序、每条含 `entryId`、
  `role`、`snippet`、`matches`（`matches` 是片段内高亮区间，换行折叠后重算过）；
  `limit` 控制每会话最多展开几条，`totalHits` 保留该会话真实命中总数。
- 新增独立模块 `src/main/daemon/session-search.js` 提供 `searchSessionMessages(query, options)`：
  - 与 `searchSessionFiles` 共用同一份候选清单（`listSessionCandidates`：读目录 → 按
    mtime 倒序），避免两套扫描慢慢漂移；
  - 返回 `{ query, scanned, scannedLimit, truncated, sessions }`，
    `sessions[]` 含 `{ sessionId, title, path, modifiedAt, totalHits, hits }`；
  - 空查询/纯空白直接返回空结果（不扫盘）；坏行、非法 JSON 跳过，不抛错。

### R2 · IPC：四处同步

`src/shared/ipc.js` 的 `INVOKE.sessionSearch = "sessions:search"`；
`src/preload/index.js` 的通道表加同名常量 + `window.kami.searchSessions(query, options)`；
daemon `handlers` 表加 `[INVOKE.sessionSearch]`；渲染层只经 `window.kami` 访问。

### R3 · 渲染层：检索页

- 侧栏「会话检索」（`IconSearch`）+ 命令面板动作，二者都打开 `search` 视图；
  页面用 `.settings` 壳，返回回到来处（聊天 / 首页）。
- 搜索框自动聚焦；输入 250ms 防抖发起检索（用递增序号丢弃过期响应）。
- 结果按会话分组：标题、相对时间、命中数；每条命中显示角色（「你问的」/「它答的」）
  与高亮片段（命中词用 `<mark>`，不拼 HTML）。
- 点击命中 → 先登记 `focusEntry` 请求（含 sessionId / entryId），再 `resumeTask(session.path)`
  打开会话：`ChatView` 挂载后自己等快照就绪，调 `focusEntryInTurn` 定位并高亮；
  找不到目标消息时如实提示「已打开会话，但没定位到那条消息」。
- 四态：加载骨架（与真实行同尺寸）、空结果（示例查询可点）、错误（就地重试）、
  正常；扫描上限 `truncated` 时如实说明。
- 键盘：`Enter` 打开选中项，`Esc` 有查询时清空、无查询时返回。

## Acceptance Criteria

- [x] `npm run test` 中新增单测通过：多条命中、AND 词序、大小写、空查询、坏行、每会话上限、扫描上限
- [x] `npm run test:gui` 中新增 e2e 通过：写入已知会话 → 检索 → 点结果 → 会话打开且目标消息带 `entry-flash`；亮/暗色截图各一张
- [x] `npm run lint:all` 全绿；`npm run check:unicode` 无 U+FFFD
- [x] 独立 UI/UX 设计师评审并根据意见迭代（P0 全部修完，记录见 `review.md`）
- [x] 真实启动 Electron 走一遍：检索、跳转、Esc/返回都通（`tests/e2e/session-search.mjs` 真实启动应用，截图在 `artifacts/session-search/`；检索为纯本地，不依赖网络）
- [x] CHANGELOG `[Unreleased]` 记一条「新增」；USAGE.md 补一节

## 约束

- 不动 `resources/**`；不新增运行时依赖；不改 `.claude/` 与发布流水线。
- 不重排 `src/renderer/src/app.js`（红线 6）；新增代码按现有文件风格插入。
- 检索只在主进程读 `sessionsDir`，渲染层拿不到任意路径读取权。
- 逐字沿用 Agent 工具的 AND 语义与 `SCAN_LIMIT`，避免两处说法不一。

## 非目标

- 不做跨文件（附件/产物）检索 —— 那是另一个索引问题，首版只搜会话正文。
- 不做增量索引 / 全文库 —— 200 个会话线性扫足够快，先验证需求。
- 不做「在当前会话内高亮全部命中」—— 定位一条已足够，全量高亮需要重排渲染树。

## 入手位置

`src/main/daemon/session-state.js` · `src/main/daemon/session-files.js` ·
`src/shared/ipc.js` · `src/preload/index.js` · `src/renderer/src/app.js` ·
`src/renderer/src/app.css` · `tests/unit/search-files.test.mjs` ·
`tests/e2e/search.mjs` · `package.json` · `docs/USAGE.md` · `CHANGELOG.md`

## 难度

中等。检索与定位都有现成实现，难点是「跨折叠定位」的时机控制与列表的键盘可达性。
