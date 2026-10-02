# 技术设计：双渠道自动更新

## 0. 渠道模型（一张图）

```
main 合并（AI 的功能 PR）                    维护者决策「这个 beta OK 了」
        │                                            │
        ▼                                            ▼
  beta.yml（workflow）                    AGENTS.md 第五章发布流程
  版本 0.4.0-beta.N                       （CHANGELOG 归档+version+tag vX.Y.Z）
  gh release --prerelease                          │
        │                                          ▼
        └──────────► GitHub Releases ◄──── release.yml（稳定）
                           │
                           ▼
        应用内 electron-updater setFeedURL(channel)
        ├─ updateChannel=stable → 拉 latest.yml（由稳定 Release 提供）
        └─ updateChannel=beta   → 拉 beta.yml（由 beta Release 提供）
```

**关键不变量**：稳定渠道的 `latest.yml` **只**由 vX.Y.Z 正式 release 携带；
beta release 永远 `--prerelease` 且携带 `beta.yml`——两个 channel 文件物理隔离，
一个 beta 发布不可能污染稳定渠道（electron-updater 只认自己 channel 的 yml）。

## 1. 版本号与 beta.yml 的生成机制

- electron-builder 对含 prerelease 的版本（`0.4.0-beta.3`）自动把 NSIS 的
  channel 文件命名为 `beta.yml`（channel = prerelease 的第一段）；
  稳定版本产 `latest.yml`。**不需要额外配置**。
- 覆盖版本不打进仓库：`electron-builder --config.extraMetadata.version=<ver>`
  （产物内 package.json 的 version 被覆盖；仓库文件不动，避免 beta 序号弄脏 main）。
- 下一版本计算（workflow 内脚本）：`next = <pkg.minor+1>.0.0-beta.<N>`，
  N = 该前缀已有 release 的数量+1。**幂等重跑**：重跑同一 run 覆盖同一 tag。

## 2. beta.yml（workflow）设计

```yaml
name: Beta 发布
on:
  push: { branches: [main], paths: ['CHANGELOG.md', 'src/**', 'resources/**'] }
  workflow_dispatch: {}
```

步骤：checkout → 脚本判断 [Unreleased] 非空（空则 skip 退出）→ 算版本 →
build → electron-builder 双平台（extraMetadata.version）→ 打 tag →
gh release create --prerelease（env 中转 tag 名）→ 上传产物 + 溯源证明。

红线遵守：`run:` 里无 `${{ }}`；secrets 不落日志；permissions 最小
（contents: write 打 tag/release，与 release.yml 同级）。

并发：concurrency group=beta，cancel-in-progress=false（排队不并发，避免 tag 竞态）。

## 3. 主进程更新器（`src/main/updates.js` 新模块）

```js
import electronUpdater from "electron-updater";  // esm 兼容性核实点①
const { autoUpdater } = electronUpdater;
```

- 初始化（app.whenReady 后、窗口创建后）：`!app.isPackaged` 直接 return（dev/e2e 免疫）
- `configure(channel)`：`autoUpdater.setFeedURL({ provider: "github", owner: "liang-zhenxiang", repo: "zerowork", channel })`
  + `autoUpdater.channel = channel`
- 偏好读取：与 applyInitialTheme 同模式（主进程只读 preferences.json，
  写走 daemon）——渠道变更由渲染层 invoke `settings:set-update-channel` →
  daemon 落盘 + **主进程 handler 直连**（同 setThemePreference 的拆通道模式：
  落盘 + autoUpdater 重配一次完成）
- IPC（preload INVOKE 双表同步！）：
  - `updates:get-state` → { version: app.getVersion(), channel, lastCheck?, lastResult? }
  - `updates:check-now` → 触发 autoUpdater.checkForUpdates()，事件流回报
  - `updates:install` → win32: quitAndInstall()；darwin: 返回 {kind:"manual"}，
    渲染层展示 Release 页链接（shell.openExternal 白名单已有）
- autoUpdater 事件 → webContents.send("updates:event", {...})：
  checking-for-update / update-available / update-not-available /
  download-progress / update-downloaded / error
- **dev feed 覆盖**（e2e 用）：环境变量 `ZEROWORK_UPDATE_FEED=<url>` 存在时
  setFeedURL({ provider: "generic", url })——测试不碰 GitHub
- 自动检查：启动后 10s 静默 check + 每 24h 一次（channel 变更立即 check）

## 4. 渲染层

- 设置 → 通用 → `UpdatesSection`（AppearanceSection 同构）：
  版本徽章（`__APP_VERSION__` 已有）+ 渠道 SelectField（稳定/beta）+
  「检查更新」按钮 + 状态行；Windows 且 downloaded 时「重启并安装」主按钮
- 更新 toast：updates:event 的 update-available → showToast（带「查看」动作
  直达设置更新区）；设置页开着时不 toast（就地状态行已表达）
- 事件桥：preload 的 EVENT 表加 `onUpdateEvent`

## 5. 测试设计

| 层 | 内容 |
| --- | --- |
| 单元 | `tests/unit/update-version.test.mjs`：workflow 用的版本计算脚本纯函数（下一版本、beta 序号、[Unreleased] 判空）——脚本本身放 `scripts/next-beta-version.mjs` 供 workflow 与测试共用 |
| e2e | `tests/e2e/gui-updates.mjs`：mock feed（node http 服务回 latest.yml/beta.yml，版本比当前高）+ `ZEROWORK_UPDATE_FEED` 启动 → ① 设置更新区渲染（版本/渠道/按钮）② 触发检查 → 断言「有新版本」状态 ③ 切 beta → 断言 fetch 命中 beta.yml ④ macOS 不显示安装按钮（平台断言） |
| 回归 | settings/theme/smoke 全套 |

**e2e 的 autoUpdater 环境**：`ZEROWORK_UPDATE_FEED` 覆盖 + `app.isPackaged` 守卫
冲突（e2e 是打包态？不——e2e 跑的是 out/ 未打包目录，`app.isPackaged` false！）。
**解法**：守卫条件放宽为 `isPackaged || ZEROWORK_UPDATE_FEED`（显式喂了 feed 的
环境就是测试意图），dev 无此变量仍免疫。

## 6. 兼容与回滚

- 新依赖仅主进程；渲染层零新依赖
- 渠道缺省 stable + 无 feed 配置时行为 = 现状（无更新检查）——**保守默认**：
  `preferences.json` 无 `updateChannel` 时不自动检查？——不，静默检查是
  低风险只读操作，缺省也查（用户不设置也有更新通知，这正是「其他人收到
  更新通知」的诉求）。只读检查不装任何东西。
- 回滚：整个功能独立模块（updates.js + workflow + UI section），revert 即回现状

## 7. 未决（实现中核实）

① electron-updater 的 ESM 导入形态（它是 CJS，主进程 bundle 需 externalize——
  electron.vite 的 externalizeDepsPlugin 已处理 dependencies ✓ 理论可行，实测兜底）
② NSIS 的 beta.yml 是否真按 prerelease 命名（文档如此，实测确认；不对则
  构建后 mv latest.yml beta.yml——workflow 脚本兜底）
