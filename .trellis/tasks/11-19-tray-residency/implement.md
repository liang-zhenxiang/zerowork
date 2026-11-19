# 实施清单：托盘值守（#422）

## 0. 准备

- 分支 `feat/tray-residency`，基线 main。
- 读 `.trellis/spec/main/index.md`、`.trellis/spec/renderer/index.md`、`.trellis/spec/testing/index.md`。

## 1. main 侧

1. `src/main/desktop-preferences.js`：默认值、校验、读、写（temp+rename）。
2. `src/main/desktop-behavior.js`：`shouldHideOnClose`、`shouldNotifyCompletion`、
   `addRunning`/`removeRunning`/`runningCount`（纯函数，无 Electron import）。
3. `src/main/index.js`：
   - import `Tray`/`Notification`/`nativeImage` 与上面两个模块；
   - 内嵌托盘图标（base64 PNG：macOS 黑色模板、其他平台白色/彩色）；
   - `ensureTray()` / `destroyTray()` / `refreshTrayMenu()`；
   - `window.on("close")` 按 `shouldHideOnClose` 决定 `preventDefault + hide`；
   - `showWindow()` 统一 `show + focus + restore`；
   - daemon `push` 旁路：sessionEvent 的 run_started/finished/error → 运行集合 + 通知；
     通知点击 → `showWindow` + `send(PUSH.notificationClick,{sessionId})`；
   - 启动时应用 `launchAtLogin`（`app.setLoginItemSettings`，win32/darwin）；
   - IPC `desktopPrefsGet` / `desktopPrefsSet`，写后即时应用并返回能力信息。
4. `src/shared/ipc.js` + `src/preload/index.js`：两条 invoke + `PUSH.notificationClick`
   + `onNotificationClick`。

## 2. 渲染层

1. 新增 `DesktopSection`（通用分组，Permission 之后）：
   - 三行开关（复用 `.skill-switch` 轨道/滑块）；
   - 乐观更新 + 失败回滚 toast；不支持项禁用并说明；
   - 说明文案写清「关窗后任务继续，从托盘恢复」「通知只在窗口不在前台时发」。
2. App 顶层：
   - `onNotificationClick` → `listSessions()` 按 id/path 找任务 → `resumeTask(path)`；
   - `onAppLaunch` 扩展 `{kind:"open-view", view}`，只接受白名单（`automations`）。
3. CSS：仅复用 `.skill-switch`；若需行布局，新增 `.desktop-toggle-row` 等少量类，
   全部走 Token，亮暗一致。

## 3. 测试

1. `tests/unit/desktop-behavior.test.mjs`（独立 `ZEROWORK_CONFIG_DIR`）：
   默认值 / 非法值 / 部分写 / 损坏文件 / 原子写；
   关闭决策四象限；通知决策全矩阵；running 集合去重与计数。
2. `tests/e2e/gui-tray.mjs`：
   - 设置页「后台与通知」三项渲染 + 截图（亮/暗）；
   - 开关关窗到托盘 → 主进程关窗 → `isVisible()===false`、`listExperts` 仍有回包；
   - `app.evaluate` stub `setLoginItemSettings`/`getLoginItemSettings` → 切换开机自启
     → 断言调用参数与开关状态；
   - 用例末尾恢复设置，避免影响其余套件（每个 e2e 独立 userData，但同一 harness）。
   - 注意：**不要真的让应用退出**；退出链路由既有 `before-quit` 单测/GUI 覆盖。
3. 反向验证：`shouldHideOnClose` 恒 false → 关窗用例必红；还原后绿。

## 4. 文档

- `CHANGELOG.md` `[Unreleased] 新增`：托盘值守 / 完成通知 / 开机自启（默认值写清）。
- `docs/USAGE.md`：设置 → 通用新增「后台与通知」；托盘菜单与退出语义；
  平台差异（macOS / Windows；Linux 不在支持范围）。

## 5. 验证

```bash
npx vitest run tests/unit/desktop-behavior.test.mjs
npm test
npm run build
node tests/e2e/gui-tray.mjs
node tests/e2e/gui-smoke.mjs
node tests/e2e/gui-expert-gallery.mjs
npm run check:unicode
npm run lint:all
```

## 6. 提交拆分

1. `feat(main): 托盘值守、完成通知与开机自启`
2. `feat(renderer): 设置里的后台与通知`
3. `test(docs): 决策单测、真机 e2e 与文档`

合并后归档任务、更新 Roadmap，并顺手处理仍挂着的 #429（归档 #421；runner 恢复后）。
