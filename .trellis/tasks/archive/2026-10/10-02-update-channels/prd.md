# PRD：双渠道自动更新（beta 自动 / 稳定手工触发）

## 背景（用户原话拆解）

- **beta 渠道**：AI 自动开发的功能合并后 → beta 用户**自动收到**更新（纯自动化流水线）
- **稳定渠道**：维护者自己用 beta 觉得 OK → **手工触发**（打 tag）→ 稳定用户收到更新通知
- 设置里可选渠道；选了 beta 就吃 beta 更新
- 交付要求：流水线全配好 + **讲清楚稳定版怎么发**

## 现状核实

1. `electron-builder.yml`：mac dmg+zip（不签名）、win nsis、`publish: null`（刻意避免构建期网络）
2. `release.yml`：vX.Y.Z tag → 三段式发布说明 + 双平台安装包 + 溯源证明（**这已是稳定渠道的手工触发点**）
3. `package.json` 无 electron-updater；渲染层/主进程无任何更新基建
4. macOS 未签名：electron-updater 的 mac 自动安装不可行（Squirrel 要求签名）；
   Windows NSIS 未签名**可以**自动更新（latest.yml 的 sha512 校验）
5. 偏好存储：`preferences.json`（daemon 读写，主进程只读）——渠道偏好照此办理

## 期望

### A. CI：beta 自动发布流水线

- [ ] 新 workflow `.github/workflows/beta.yml`：push 到 main 且 `CHANGELOG.md` 的
      `[Unreleased]` 段**非空**时触发（也可 workflow_dispatch 手动）；或每日定时
      （有变更才发）——**取 push + 手动双触发**
- [ ] 版本号：`<下一版本>-beta.N`。下一版本 = package.json version 的 minor+1；
      N = 已有同名前缀 beta release 数 + 1（脚本算，幂等）
- [ ] 产物：electron-builder 双平台（`--config.extraMetadata.version` 覆盖，**不改仓库
      package.json**）；NSIS 因 prerelease 版本自动产 `beta.yml` channel 文件
- [ ] Release：`gh release create v0.4.0-beta.N --prerelease`（**必须 prerelease**——
      稳定渠道的 latest.yml 永远不被它污染）；附安装包 + beta.yml
- [ ] CI 门禁不跑（beta 是产物发布不是代码门禁；代码已过 CI 总览）

### B. 稳定渠道（复用现有流程，只补文档）

- [ ] 现有 release.yml 即稳定发布：AGENTS.md 第五章（CHANGELOG 归档 + version + tag）
- [ ] **操作手册**（MAINTAINER_GUIDE 新章节）：从「觉得某个 beta OK」到「稳定用户收到通知」
      的完整步骤（含把某 beta 的验证结论带进发布说明的做法）

### C. 应用内更新器

- [ ] **依赖**：`electron-updater` 进 dependencies（主进程运行时用）
- [ ] **主进程**：启动时按偏好 `setFeedURL({ provider: "github", owner, repo, channel })`；
      IPC 三条：`updates:get-state`（版本/渠道/上次检查）、`updates:check`、
      `updates:install`（仅 Windows：quitAndInstall）
- [ ] **渠道偏好**：`preferences.json` 的 `updateChannel`（`"stable"` | `"beta"`，缺省 stable）；
      渲染层改动即生效（重新 setFeedURL + 立即 check）
- [ ] **设置 UI**：设置 → 通用 →「更新」section：当前版本徽章、渠道选择（沿用
      AppearanceSection 的 SelectField 形态）、「检查更新」按钮 + 状态行
      （最新版 / 有新版本 vX.Y.Z[β] / 下载中 / 已就绪[重启安装] / 检查失败原因）
- [ ] **更新通知**：启动后台静默 check，发现新版本 → toast（点击直达设置更新区）
- [ ] macOS 行为如实降级：**检查 + 通知 + 跳 Release 页下载**（不自动安装——
      未签名限制写进 UI 文案与文档，不假装能装）
- [ ] e2e 环境（本地 file://）不误检：dev/e2e 态禁用自动检查（`app.isPackaged` 守卫）

### D. 测试

- [ ] 单元：下一版本号计算（脚本纯函数）、渠道枚举
- [ ] 静态契约：beta.yml 的安全红线（prerelease 标志、不写 latest.yml）写成脚本自检？
      ——放 workflow 自身 + actionlint；PR 里说明
- [ ] e2e：`gui-updates.mjs`——设置更新区渲染（渠道选择/版本徽章/按钮）；
      **mock feed 服务器**（本地 http 回假 latest.yml/beta.yml，主进程 setFeedURL
      指 mock）→ 断言「有新版本」状态出现 → 渠道切 beta 后断言改吃 beta.yml
- [ ] 回归：settings/theme 等全套

## 验收

1. beta 流水线：往 main 推一个带 [Unreleased] 内容的提交 → beta release 自动出现
   （prerelease + beta.yml + 安装包）
2. 应用内：mock feed 下检查出新版本、渠道切换生效、UI 状态机完整
3. `npm run test:all` 全绿
4. MAINTAINER_GUIDE 有「发稳定版」操作手册（用户能照着做）

## 约束（红线核对）

- workflow 里 `${{ }}` 不进 `run:`（env 中转）——beta.yml 遵守
- 新依赖 electron-updater 过 npm audit；进 dependencies（运行时需要）
- 不动沙箱/权限；macOS 不假装支持自动安装
