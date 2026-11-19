# 设计：托盘值守（#422）

## 1. 设置落盘（main 独占）

新模块 `src/main/desktop-preferences.js`：

```js
DESKTOP_DEFAULTS = { closeToTray: false, notifyOnComplete: true, launchAtLogin: false }
readDesktopPreferences() -> { ...defaults, ...validBooleans }
writeDesktopPreferences(patch) -> 完整对象
desktopPreferencesPath() -> join(configDir, "desktop.json")
```

- `configDir` 解析与 `index.js` 的代理读取同源：`ZEROWORK_CONFIG_DIR` 优先，否则
  `~/.zerowork`（不 import daemon 的 `config-paths`，主进程本来就不依赖它）。
- 只接受布尔值；未知键丢弃；文件不存在/损坏按默认值（写回时保留合法项）。
- 写入用 temp + rename（Windows 上 rename 不能覆盖：先删再改名，同 packs 的写法）。
- **不进 `preferences.json`**：daemon 是那份文件的唯一写入方，主进程另起一份，
  避免两个进程写同一份 JSON。

## 2. 纯决策（可单测）

新模块 `src/main/desktop-behavior.js`：

```js
shouldHideOnClose({ closeToTray, quitting }) -> boolean
shouldNotifyCompletion({ enabled, focused, eventType, outcome }) -> "completed"|"failed"|null
addRunning(runs:Set, runId) / removeRunning(runs, runId) / runningCount(runs)
```

- `shouldNotifyCompletion` 只在 `run_finished`（completed）或 `run_error` 且
  `enabled && !focused` 时返回类型；`cancelled` 不通知（用户自己停的）。
- 运行中集合按 `runId` 去重；`run_finished` / `run_error` 移除。

## 3. 主进程接线（`src/main/index.js`）

### 3.1 启动

- `app.whenReady` 后：读设置；`applyLoginItem(launchAtLogin)`（仅 win32/darwin，
  其他平台记录不支持）；若 `closeToTray` 为真，`ensureTray()`。

### 3.2 托盘

- 图标：**内嵌 base64 PNG**（16×16，macOS 用黑色模板图 `setTemplateImage(true)`，
  Windows 用白色描边图），不新增打包资源；`build/icon.png` 不进安装包，不能依赖。
- `Tray` 单例：`ensureTray()` / `destroyTray()`；左键 `showWindow()`；右键菜单：
  - 显示 ZeroWork
  - 运行中 N 个任务（N>0 才出现，disabled）
  - 打开自动化（`showWindow()` + `send(PUSH.appLaunch,{kind:"open-view",view:"automations"})`）
  - 分隔线
  - 退出 ZeroWork（`quitting=true; app.quit()`）
- 菜单在运行任务集合变化时 `setContextMenu` 重建。

### 3.3 关窗

```js
window.on("close", (event) => {
  if (shouldHideOnClose({ closeToTray: prefs.closeToTray, quitting: quitStarted })) {
    event.preventDefault();
    window.hide();
    ensureTray();
  }
});
```

- 关闭设置后：关窗恢复原行为（windows/linux 退出，macOS 关窗留进程）。
- `before-quit` 逻辑**一字不改**；托盘「退出」只触发 `app.quit()`。
- 显式退出前 `quitting` 置位由既有 `quitStarted` 承担，不新增第二套闸。

### 3.4 完成通知

- `child.on("message")` 的 `push` 分支里，对 `PUSH.sessionEvent` 的
  `event.type` 做旁路处理（原样 `send` 不变）：
  - `run_started` → 加入 running 集合；刷新托盘菜单；
  - `run_finished` / `run_error` → 移出；按 `shouldNotifyCompletion` 决定是否通知；
  - 通知 body：完成「任务已完成」；失败「任务执行失败」。**不带会话正文/标题**
    （标题在 daemon，旁路拿不到；也不该为通知多拉一次全量列表）。
  - `Notification.isSupported()` 为假时不发，`console.warn` 一次；设置页另行提示
    （`desktopPrefsGet` 返回 `notificationsSupported`）。
  - 点击：`showWindow()`；`send(PUSH.notificationClick, { sessionId })`。

### 3.5 IPC

- `src/shared/ipc.js`：`desktopPrefsGet` / `desktopPrefsSet` / `desktopOpenAutomations`？
  不需要打开自动化的专用通道 —— 复用 `PUSH.appLaunch`。
- `MAIN_HANDLED` 增加两条；handler 读/写设置并即时应用（tray / login item），
  返回 `{ prefs, notificationsSupported, loginItemSupported }`。
- `PUSH.notificationClick` 新通道；preload 暴露 `onNotificationClick`。
- preload 增加 `getDesktopPrefs` / `setDesktopPrefs`。

## 4. 渲染层

### 4.1 设置 → 通用 → 后台与通知（新 `DesktopSection`）

放在 `PermissionSection` 之后、`HooksSection` 之前（同属「这台机器怎么运行」）。

三行开关（复用 `.skill-switch` 的轨道/滑块与焦点环）：

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| 关闭窗口时最小化到托盘 | 关 | 关闭后窗口隐藏，任务继续；从托盘可恢复 |
| 完成任务时通知 | 开 | 窗口不在前台时发系统通知；点击回到会话 |
| 开机自启 | 关 | 登录时自动启动；平台不支持时禁用并说明 |

- 读取失败显示错误与重试；切换即时落盘（乐观更新，失败回滚并 toast）。
- `notificationsSupported === false` 时第二项禁用并写「当前系统不支持系统通知」。
- `loginItemSupported === false` 时第三项禁用并说明。

### 4.2 通知点击与托盘「打开自动化」

- `onNotificationClick(({ sessionId }) => …)`：
  `listSessions()` 找 `id === sessionId || path === sessionId` 的任务 →
  `resumeTask(path)`；找不到只显示窗口（主进程已显示）。
- `onAppLaunch` 已有监听：扩展 `payload.kind === "open-view"` → `setView(payload.view)`
  （仅接受白名单视图 id，避免任意字符串进 state）。

## 5. 测试

- 单测 `tests/unit/desktop-behavior.test.mjs`：
  - 设置默认值/非法值/部分写/损坏 JSON；
  - `shouldHideOnClose` 四象限；`shouldNotifyCompletion` 全矩阵（前台/后台/开关/
    completed/error/cancelled）；
  - running 集合去重与计数。
- e2e `tests/e2e/gui-tray.mjs`：
  - 打开设置 → 「后台与通知」三项存在 → 截图（亮/暗）；
  - 开启关窗到托盘 → 主进程 `BrowserWindow...close()` → 等窗口 `isVisible()===false`，
    进程与 daemon 仍活（`listExperts` 有回包）；
  - 再次显示窗口 → 关闭开关 → 关窗 → 窗口被销毁/应用退出（用独立的第二个 harness
    或放到用例最后）；
  - 开机自启：主进程 stub `app.setLoginItemSettings` / `getLoginItemSettings`，
    切换开关后断言调用参数；
  - 通知决策：单测覆盖，不在 e2e 里造假 daemon 帧。
- 截图：设置区亮/暗。
- 反向验证：把 `shouldHideOnClose` 恒返回 false → e2e 关窗用例必红。

## 6. 取舍

- **不做「暂停值守」**：daemon 没有全局调度暂停；逐个改任务状态会污染用户配置。
  托盘菜单改为「打开自动化」。
- **通知不带会话标题**：标题在 daemon 的会话文件里；为一条通知多拉全量列表不划算，
  也不该让主进程读会话正文。点击后用 `sessionId` 回会话。
- **托盘图标内嵌**：`build/` 不进安装包，新增打包资源要动 electron-builder 与体积
  检查，收益不抵成本。
- **默认全保守**：关窗到托盘、开机自启默认关；通知默认开（不改变窗口行为）。
