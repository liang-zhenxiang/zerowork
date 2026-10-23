# 网络代理设置 —— 执行清单

> 分支：`feat/network-proxy-settings`　PR 目标：`main`
> 一个功能闭环一次提交；每步验证通过再进下一步。

## 0. 开工前置

- [ ] `gh issue list` / `gh pr list` 确认无人在做
- [ ] 在本 Issue 里留言「我开始了」
- [ ] 读 `.trellis/spec/main/index.md`、`.trellis/spec/daemon/index.md`、`.trellis/spec/renderer/index.md`

## 1. 依赖与模型层（无 UI 可先行验证）

- [ ] `package.json` 增加 `"undici": "8.10.2"`（与 pi 同版本，确保去重为同一实例）
- [ ] `npm ls undici` 确认根节点为 8.10.2，pi 不再嵌套独立副本
- [ ] `preferences.js`：
  - [ ] `readProxy(value)` 校验函数（读侧丢弃非法值）
  - [ ] `readPreferences()` 增加 `proxy` 字段
  - [ ] 导出校验函数供写侧复用
- [ ] 单元测试：`tests/unit/preferences-proxy.test.mjs`（沿用现有测试目录命名）

**验证**：`npm run test -- proxy`

## 2. daemon 侧网络接管

- [ ] 新增 `src/main/daemon/network.js`：`installProxyDispatcher()`
- [ ] `src/main/daemon/index.js` 顶部调用（在任何 pi 动态 import 之前）
- [ ] `runtimes.js` 的 `requestOnce` 改用 `undici.request`，保持 range/重定向/中止语义
- [ ] 确认 MCP SDK 的 `fetch` 引用在 `undici.install()` 之后才被使用时生效
- [ ] 单测：runtimes 下载用例在 mock server 下仍通过

**验证**：`npm run test -- runtimes`

## 3. 主进程接线

- [ ] `src/shared/ipc.js` 增加 `getProxy` / `setProxy`
- [ ] `session-files.js` 增加 daemon handler（只校验与落盘）
- [ ] `index.js`：
  - [ ] 包装 `setProxy` handler：落盘 → 解析实际 URL → `session.setProxy` →
        `restartDaemon()`
  - [ ] `daemonEnv()` 注入 `ZEROWORK_PROXY_URL` 与 `NO_PROXY`
  - [ ] 新增 `restartDaemon()`（等 exit 再 fork）
  - [ ] 启动时按已存偏好应用一次代理（`app.whenReady` 后、`startDaemon` 前）
- [ ] `preload/index.js` 暴露两个新方法

**验证**：`npm run typecheck && npm run lint`

## 4. 渲染层设置页

- [ ] `GeneralSection` 增加「网络代理」区块：
  - [ ] 三档选择（直连 / 跟随系统 / 手动）
  - [ ] 手动模式展开地址、用户名、密码输入；密码显示为「已设置」占位
  - [ ] 保存按钮 + 内联错误（可诊断文案）
  - [ ] 保存成功 toast：「代理已更新，正在重连内核」
- [ ] 复用既有 `provider-row` / `mini-btn` / 表单样式，不新增视觉 token
- [ ] 暗色与浅色都人工检查一次

**验证**：`npm run test:gui:settings`，并手动跑 `npm run dev` 看效果

## 5. e2e

- [ ] 新增 `tests/e2e/gui-proxy.mjs`（本地 mock 代理）
- [ ] `package.json` 注册 `test:gui:proxy` 并加入 `test:gui` 串
- [ ] 断言：保存 → daemon 重启 → mock 代理收到请求 → 切回直连后不再收到
- [ ] 回归 `npm run test:gui:updates`

## 6. 文档与收尾

- [ ] `CHANGELOG.md [Unreleased]` → 「新增」条目（写清覆盖范围与 SOCKS 限制）
- [ ] `docs/TROUBLESHOOTING.md` 增加「需要代理才能连上模型」一节
- [ ] `npm run lint:all`
- [ ] `npm run check:unicode`
- [ ] PR 正文含 `Closes #<issue>`，用 `--body-file`

## 回滚点

- 第 1 步之后：纯数据模型，可单独回滚
- 第 2 步之后：daemon 行为变化，若发现问题回滚本步即可恢复直连
- 第 3 步之后：具备完整功能，后续步骤失败可保留功能、撤掉 UI
