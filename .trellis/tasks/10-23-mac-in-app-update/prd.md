# macOS 应用内下载安装包更新

## 背景

设置 → 通用 → 更新已经支持「检查更新 + 渠道切换」（`src/main/updates.js`，
spec: update-channels），但平台能力不对称：

- **Windows（NSIS）**：检查 → 自动下载 → 「重启并安装」全自动。
- **macOS**：未签名应用不支持 Squirrel.Mac 的自动安装，所以
  `autoDownload = false`，`update-available` 之后的全部动作就是显示一句
  「有新版本，请到发布页下载」+ 一个「打开发布页」按钮。

用户（2026-10-23）反馈的正是后者：明明应用内已经知道有新版本、也知道下载地址，
却还要跳去 GitHub 自己找版本、自己点资产、自己等浏览器下载。

「自动安装」受签名限制无法改变，但「应用内下载并打开安装包」完全可行，
能把用户从「发布页找版本 → 下载 → 打开」压缩成「点一下 → 等下载 → 拖进 Applications」。

## 期望

macOS 上 `update-available` 之后：

1. 显示「下载更新」按钮（点击后变为下载进度）
2. 应用内下载与该版本对应的 `.dmg` 到临时目录
3. 下载完成后**自动打开该 dmg**（Finder 挂载窗口，用户拖拽安装）
4. 明确提示：「macOS 未签名，需手动拖入 Applications；首次打开请右键→打开」

Windows 行为保持现状，不回归。

### 关键取舍

- **不使用 `autoUpdater.downloadUpdate()` 的产物**：macOS 上它下载的是 Squirrel 用的
  `.zip`，无法直接打开安装。必须从 `update-available` 的 `info.files` 中挑选 `.dmg`。
- **下载走 Electron `net`**：与渲染层/更新检查使用同一网络栈，因此代理设置
  （见 `10-23-network-proxy-settings`）对它同时生效；不要用 `node:https` 另起一套。
- **下载落点**：`app.getPath("temp")` 下的应用专属子目录，文件名带版本号；
  失败或取消时清理半成品。
- **不做「静默安装」的伪装**：文案必须说明仍需手动拖拽，避免用户以为已经更新完成。

## 验收标准

- [ ] macOS 打包态下：检查到新版本 → 点「下载更新」→ 进度可见 → 完成后自动打开 dmg
- [ ] 下载失败（断网 / 代理不可用 / 404）时显示可诊断的错误，且可重试
- [ ] 已下载完成后重复点击不会重复下载（按钮进入「已下载，打开安装包」状态）
- [ ] Windows 的「重启并安装」路径不受影响（既有 e2e 仍绿）
- [ ] `updates.js` 的状态机新增阶段有明确文档与事件口径（渲染层只做展示）
- [ ] 新增/更新 e2e：`tests/e2e/gui-updates.mjs` 覆盖「下载 → 打开」的调用路径
      （打开动作可 mock，不得在 CI 真的挂载 dmg）
- [ ] `CHANGELOG.md [Unreleased]` 的「变更」记录此项

## 入手位置

- `src/main/updates.js`：状态机、下载实现、IPC handler
- `src/shared/ipc.js`、`src/preload/index.js`：新增 `updates:download` 通道
- `src/renderer/src/app.js` 的 `UpdatesSection`：按钮与文案
- `tests/e2e/gui-updates.mjs`：既有测试扩展
- `docs/` 中描述更新行为的段落（若有）
