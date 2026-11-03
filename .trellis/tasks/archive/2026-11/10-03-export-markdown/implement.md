# 执行清单（导出为 Markdown）

## 一、落点与顺序

| # | 落点 | 改动 |
| --- | --- | --- |
| 1 | `src/main/daemon/session-markdown.js`（新增） | 纯渲染器：`renderSessionMarkdown` / `hasExportableContent` / `clamp` / `codeBlock` / `fenceFor` |
| 2 | `src/main/daemon/session-host.js` | 加只读窄出口 `branchEntries()`（当前分支的原始条目） |
| 3 | `src/main/daemon/session-view.js` | `buildExportPath(exportsDir, title, now, extension = ".html")` |
| 4 | `src/main/daemon/session-files.js` | `[INVOKE.sessionExportMarkdown]`：定位 → 恢复 → 取分支 → 判空 → 渲染 → 落盘 → `{ outputPath }` |
| 5 | `src/shared/ipc.js` + `src/preload/index.js` | 通道 `session:export-markdown`（两处都写）+ `exportSessionMarkdown` |
| 6 | `src/renderer/src/app.js` | 菜单「导出」→「导出为 HTML」+ 新增「导出为 Markdown」；App 加 `exportMarkdownTask` 并传下去 |
| 7 | `tests/unit/session-markdown.test.mjs`（新增） | 17 条：渲染各类条目 + 边界 + 截断（含**入参**）+ **真实 SessionManager 集成** |
| 8 | `tests/e2e/export-markdown.mjs`（新增） | GUI 四条（含菜单上翻）+ 截图 |
| 9 | `tests/e2e/ipc-functional.mjs` | 第 16 项：从 Node 侧读回导出文件 |
| 10 | `package.json` | `test:gui:export-markdown`，并挂进 `test:gui` 链 |
| 11 | 文档 | `CHANGELOG.md`（新增 / 变更 / 修复）、`docs/USAGE.md`（导出一节） |

## 二、动手前核实的四件事（都核实过）

1. **pi 有没有现成的 Markdown 导出** —— 没有（`core/session-export.js` 只有 JSONL，
   `core/export-html/` 是 HTML），所以渲染得自己写 ✅
2. **HTML 导出认得哪些条目** —— 逐类抄自 `export-html/template.js`，不自己发明 ✅
3. **条目从哪拿** —— 活宿主的 `sessionManager.getBranch()`（leaf 在内存里才是真值）✅
4. **现有导出落哪** —— `getEffectiveWorkspaceRoot()/exports` + `buildExportPath` ✅

## 三、环境限制（同上一轮，如实记下来）

**本机跑不了 GUI 测试**：沙箱不允许 Electron 启动（`Process failed to launch!`；
独立复现是 Electron 进程在 `HIServices _RegisterApplication` 处 SIGABRT）。
既有用例同样跑不了（改动之前 `node tests/e2e/gui-smoke.mjs` 就是同一个报错）。

本机**已执行**的验证：

```bash
npx vitest run                        # 15 文件 / 261 条（含本功能 17 条，含真实 SessionManager 集成）
npm run build && npm run check:renderer-assets   # 渲染层产物契约
node tools/check-daemon-graph.mjs                 # daemon 模块图闭合（43 个模块）
npm run lint:all                      # 12 通过 / 2 失败（见下）
U+FFFD 扫描                            # OK
```

`lint:all` 的两项失败与本改动无关：**随包体积契约**打的是本机 `release/mac` 里改动之前
就存在的陈旧产物；**zizmor** 需要 docker，本机 docker daemon 没起。

未执行、需要有图形环境的机器补跑：`npm run test:gui:export-markdown`、
`npm run test:gui:ipc`、以及全套 `npm run test:gui`（回归）。

## 四、已知风险（登记，别当成已完成）

- 菜单越界（会话行的 ⋯ 菜单落到侧栏可视区之外）**不在本 PR**：它随 #118 修掉
  （那边的置顶项把菜单推到更容易越界的位置，也是那边新增的可见区守卫把它抓出来的）。
- **同一秒导出两次会覆盖同名文件**：与 HTML 导出同口径（它也是这样）。要改就两种格式
  一起改（文件名加序号），属另一件事。
- 导出内容的**观感**（在 Obsidian / Notion / GitHub 里贴进去长什么样）需要人眼看一次：
  本机只能读到生成的文本（已人工看过一份完整样例，见 design.md 的条目对照表）。
