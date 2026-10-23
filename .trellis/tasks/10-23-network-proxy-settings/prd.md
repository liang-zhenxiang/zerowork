# 设置通用页新增网络代理

## 背景

用户（2026-10-23）要求「通用设置里增加代理功能」。当前应用**没有任何应用级代理入口**：

- 模型请求由 daemon（独立 utilityProcess）内的 pi 内核发出
- 更新检查与下载由主进程的 `electron-updater`（Chromium 网络栈）发出
- 内置运行时（Node / Git Bash 等）由 daemon 的 `node:https` 发出

三处网络栈互相独立，用户只能改系统代理或手动设环境变量，且改一处未必全局生效。
对需要代理才能访问模型 API 的用户，应用内没有任何可诊断的入口。

## 期望

设置 → 通用 → 新增「网络代理」区块，提供三种模式：

| 模式 | 行为 |
| --- | --- |
| 直连（默认） | 不使用代理；保持当前行为不变 |
| 跟随系统 | 读取操作系统的代理设置（macOS `scutil --proxy`、Windows Internet Settings、Linux 环境变量） |
| 手动 | 填写代理地址（`http://` / `https://`）+ 可选用户名密码；**不支持 SOCKS**（undici 的 ProxyAgent 只处理 HTTP(S)，接受 socks5 只会静默直连） |

### 覆盖范围

- 模型请求（daemon 内的 pi 内核，含 SSE 流式响应）
- 更新检查与更新包下载（主进程更新器）
- 内置运行时下载（daemon 的 `runtimes.js`）
- MCP 的 http/sse 连接器（daemon 内）

### 不覆盖

- 本地回环地址（`127.0.0.1` / `localhost` / `::1`）一律直连
- 已经建立的连接不中断；新请求生效

### 生效时机

- 主进程 / 更新器：保存后立即生效（`session.setProxy`）
- daemon：保存后**自动重启内核**（模型请求的 dispatcher 在进程启动时构造），
  界面明确提示「代理已更新，正在重连内核」，不假装「无感」

## 验收标准

- [ ] 设置 → 通用 出现「网络代理」区块，三档切换、手动地址与认证可填写
- [ ] 校验非法地址（缺 scheme、端口非法）时给出可诊断的中文错误，不落盘
- [ ] 「直连」下行为与改动前完全一致（默认值不改写存量用户）
- [x] 「手动」模式下 daemon 的请求确实走代理（单测用本地 mock 代理验证；
      e2e 覆盖配置链路：保存 → 落盘 → daemon 重启）。更新检查与运行时下载与
      daemon 共用同一套配置，由同一份单测覆盖其网络层
- [ ] 代理不可达时，错误信息能指向「请检查代理设置」，而不是笼统的「网络错误」
- [ ] 代理密码不出现在日志、审计事件、错误消息与 daemon 的 stderr 中
- [ ] 切换模式后 daemon 自动重启，会话数据不丢（既有会话历史仍可打开）
- [ ] `CHANGELOG.md [Unreleased]` 的「新增」记录本功能
- [ ] `docs/` 补充代理配置说明（排错入口）

## 入手位置

- `src/main/daemon/preferences.js`：`proxy` 字段的读写与校验
- `src/main/daemon/session-files.js`：`getProxy` / `setProxy` IPC handler
- `src/main/index.js`：`daemonEnv()` 注入代理环境变量、daemon 重启、`session.setProxy`
- `src/main/updates.js`：更新器沿用主进程网络栈（确认无需额外改动）
- `src/main/daemon/runtimes.js`：下载请求的代理支持
- `src/shared/ipc.js`、`src/preload/index.js`：新增通道
- `src/renderer/src/app.js`：`GeneralSection` 中的新区块

## Notes

- 技术细节、错误口径与测试方案见同目录 `design.md` 与 `implement.md`。
- 依赖关系：与 `10-23-mac-in-app-update` 共用主进程网络栈，但互不阻塞。
