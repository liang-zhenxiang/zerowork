# 执行清单（会话置顶）

## 一、落点与顺序

| # | 落点 | 改动 |
| --- | --- | --- |
| 1 | `src/main/daemon/config-paths.js` | 加 `getPinsFile()`（`getArchiveFile` 旁边） |
| 2 | `src/main/daemon/pin.js`（新增） | `SessionPinStore`：惰性加载 / 幂等 / 原子落盘 / 损坏当空索引 |
| 3 | `src/main/daemon/session-files.js` | 实例化 store；`listSessions` 两条分支各加 `pinned` 字段；加 `[INVOKE.sessionPin]` 分支（写索引 + `pushTaskListChanged`） |
| 4 | `src/shared/ipc.js` + `src/preload/index.js` | 通道 `session:pin`（**两处都要写**——preload 有自己的一份通道表）+ `pinSession(path, pinned)` |
| 5 | `src/renderer/src/session-pin.js`（新增） | 纯函数：`isPinned` / `compareSessionsByPin` / `sortSessionsByPin` / `taskListWindow` |
| 6 | `src/renderer/src/app.js` | import 纯函数；`groupSessions` 改用置顶优先排序；`IconPin`；`renderTaskRow` 加钉标记 + 菜单项；`taskListWindow` 换掉内联切片；App 加 `pinTask` 回调并传下去 |
| 7 | `src/renderer/src/app.css` | `.task-pin-mark`（与 `.task-branch-mark` 共用一条规则）；`.task-item-ops` / `.space-group-actions` 的隐藏手法改为 `opacity` + `pointer-events` |
| 8 | `tests/unit/session-pin-*.test.mjs`（2 个新增） | 纯逻辑 + 索引 |
| 9 | `tests/e2e/session-pin.mjs`（新增）+ `ipc-functional.mjs`（追加） | GUI 十二条 + IPC 往返 |
| 10 | `package.json` | `test:gui:pin`，并挂进 `test:gui` 链 |
| 11 | 文档 | `CHANGELOG.md`（新增 / 修复）、`docs/USAGE.md`（会话的几件事）、`docs/DESIGN.md` §7.9、`.trellis/spec/renderer/index.md` 禁止清单 |

## 二、动手前必须核实的三个前提（都核实过）

1. **`listSessions` 的 `pinned` 从哪来** —— 必须是 daemon 组装好的展示字段
   （与 `archived` 同层），渲染层不自己推导 ✅
2. **侧栏排序只有一处**（`groupSessions`）—— 若别处还有排序，改一处会出现两套口径 ✅
3. **行内操作钮的既有决定**（`.task-item-ops` 只留一个「⋯」）—— 决定了入口形态 ✅

## 三、环境限制（必须如实记下来）

**本机跑不了 GUI 测试**：这个会话的沙箱不允许 Electron 启动 —— `electron.launch()`
稳定报 `Process failed to launch!`，独立复现是
`Electron.app/Contents/MacOS/Electron <app>` 直接 `SIGABRT`，
崩溃报告里 faulting thread 停在 `HIServices _RegisterApplication`
（渲染层 / 窗口服务那一路被沙箱挡住）。**既有用例同样跑不了**
（`node tests/e2e/gui-smoke.mjs` 在改动之前就是同一个报错），所以这是环境限制、
不是本次改动引入的。

因此本轮的**已执行**验证是：

```bash
npm run build && npm run check:renderer-assets   # 渲染层产物契约（含新模块被正确打包）
node tools/check-daemon-graph.mjs                # daemon 模块图闭合
npx vitest run                                   # 全部单元测试（含新增 19 条）
npm run lint:all                                 # 12 通过；2 项失败与本改动无关（见下）
```

`lint:all` 的两项失败：**随包体积契约**打的是本机 `release/mac` 里**改动之前**就存在的
陈旧产物（加改动之前跑同一条命令也是这两项失败）；**zizmor** 需要 docker，
本机 docker daemon 没起。两项都与本次改动无关，已在 PR 里标注。

未执行、需要有图形环境的机器补跑：`npm run test:gui:pin`、
`npm run test:gui:ipc`、以及全套 `npm run test:gui`（回归）。

## 四、验收对照

| prd 验收项 | 状态 |
| --- | --- |
| 置顶 → 移到分区最前 + 钉标记；取消 → 回到时间序 | 单元 + GUI 用例已写（GUI 未能在本机实跑） |
| 重启后仍是置顶 | 单元（跨实例读回）+ GUI（真实重启）已写 |
| 被折叠的第 6+ 条置顶后可见 | 单元（折叠窗口）+ GUI ⑤ 已写 |
| 归档 / 删除 / 重命名不牵连、不崩 | GUI ⑩⑪⑫（真实 IPC + DOM 断言）+ 单元（悬空记录保留）+ design.md §二 的键与生命周期口径 |
| 坏的 `pins.json` 不炸列表 | 单元（损坏 / 结构不符） |
| 浅深两套主题截图 | GUI ⑨ 已写（本机未跑） |
| 反向验证两条 | 单元层**已真跑并记录**（design.md §七）；GUI 层做法已写明 |
| CHANGELOG / USAGE / DESIGN / spec 同步 | 已完成；**Roadmap（Issue #21）需联网更新**，本机无网络 |
| U+FFFD 扫描 | 见下 |
