# macOS 应用内下载安装包更新 —— 执行清单

> 分支：`feat/mac-in-app-update`　PR 目标：`main`

## 1. 主进程下载实现

- [ ] `updates.js` 保存 `update-available` 事件里的 `info.files`（只留 `.dmg` 条目）
- [ ] 新增 `downloadDmg()`：
  - [ ] 目标路径 `join(app.getPath("temp"), "zerowork-updates", `ZeroWork-${version}.dmg`)`
  - [ ] 用 Electron `net` 的 `net.fetch` 下载（与渲染层同网络栈，代理设置自动覆盖）
  - [ ] 通过 `updates:event` 推送 `phase: "downloading"` 与 `percent`
  - [ ] 完成 → `phase: "downloaded"`，记录本地路径
  - [ ] 失败 → `phase: "error"`，错误含 HTTP 状态或网络原因
- [ ] 新增 `openDownloaded()`：`shell.openPath(path)`，失败时退回
      `shell.showItemInFolder(path)` 并给出可诊断提示
- [ ] IPC：`updates:download`、`updates:open-installer`
- [ ] 状态机新增阶段写进 `updates.js` 顶部注释

## 2. 渲染层

- [ ] `UpdatesSection`：
  - [ ] macOS + `available` → 「下载更新」
  - [ ] `downloading` → 禁用按钮 + 百分比
  - [ ] `downloaded`（mac）→ 「打开安装包」
  - [ ] 文案：下载完成后提示「已打开安装包，请拖入 Applications；首次打开请右键→打开」
- [ ] Windows 分支保持原样（「重启并安装」）

## 3. 测试

- [ ] `tests/e2e/gui-updates.mjs` 扩展：
  - [ ] mock feed 的 `files` 增加 `.dmg` 条目（本地 http）
  - [ ] 触发「下载更新」→ 断言临时文件存在且大小正确
  - [ ] 断言 `updates:open-installer` 调用了 shell 打开（可用环境变量开关替换为记录调用）
- [ ] 回归 `npm run test:gui:updates`

## 4. 文档

- [ ] `CHANGELOG.md [Unreleased]` → 「变更」
- [ ] 若 `docs/` 有更新说明段落，补充 macOS 步骤
- [ ] `npm run lint:all` + `npm run check:unicode`
