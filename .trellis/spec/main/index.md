# main（Electron 主进程）编码规范

> `src/main/index.js`、`src/main/sandbox/`、`src/preload/index.js`。
> **主进程是 Electron 能力的唯一持有者** —— 对话框、原生菜单、全局快捷键、CSP、窗口。

---

## 动手前的检查清单

- [ ] **改 IPC 通道了吗？** 要**同时**改四处：`src/shared/ipc.js`（常量）
      → `src/preload/index.js`（暴露）→ `src/main/index.js`（路由）→ 消费方
- [ ] **新增 `${{ }}` 表达式进工作流了吗？**（见 `AGENTS.md` 红线 1，与本节无关但同属安全红线）
- [ ] **是否引入了跨进程的「就绪」状态？** 那要用**查询**而不是只靠推送（见下）
- [ ] **应用级标识改动了吗？** 跑 `npm run check:app-id`
- [ ] **CSP 改动了吗？** dev 与 prod 是**两条不同**的路径，两条都要验

---

## 一、进程模型

```
主进程 (src/main/index.js)
  ├─ createWindow()        主窗口（sandbox 渲染层）
  ├─ installCsp()          按 dev/prod 下发 CSP
  ├─ registerIpc()         IPC 路由：本地应答 + 转发 daemon
  ├─ startDaemon()         fork Agent 内核（utilityProcess）
  ├─ setupGlobalShortcut() 全局快捷键（默认 Shift+Alt+W）
  └─ appMenuTemplate()     应用菜单（macOS 走原生菜单栏）
        │
        ├── utilityProcess.fork ──→ daemon（见 .trellis/spec/daemon/）
        └── contextBridge ────────→ renderer（见 .trellis/spec/renderer/）
```

### IPC 路由的分工原则

`registerIpc()` 里：**能在主进程本地应答的就地答**（对话框、读取图片字节这类需要
Electron 原生能力的），其余转发给 daemon。

不要把「业务逻辑」塞进主进程 —— 它只做**能力桥接**与**路由**。

---

## 二、就绪竞态：必须保留的通道

daemon 就绪后向渲染层**推送** `daemon:ready`。但推送**可能在渲染进程注册监听器
之前**就发生 —— 双方完成时间取决于机器，谁快谁慢不确定。一旦推送早于监听器注册，
事件**永久丢失**，界面会卡在「正在启动」且无法恢复。

解法是 `INVOKE.daemonStatus`：渲染进程挂载后**主动查询**一次当前状态，不依赖推送。

> **这是一个通用模式：跨进程的「就绪」状态用查询，不要只靠推送。**
> `daemonStatus` 通道是**必须保留**的，删掉会重新引入这个竞态。

---

## 三、应用标识（唯一性来源）

`electron-builder.yml` 的 `appId` 是安装器的身份，由它派生：

- macOS 的 `CFBundleIdentifier`（以及 6 个 helper 的 bundle id）
- Windows 的 Application User Model ID
- NSIS 升级用的 GUID

运行时那一半是 `src/main/index.js` 的 `APP_ID`，传给 `app.setAppUserModelId()`
与安装器对齐。**两者不一致时只会在 Windows 上出问题**（任务栏固定项与通知分组对不上），
而开发机多半是 macOS —— 这正是 `npm run check:app-id` 存在的理由。

标识形式是 `io.github.<owner>.<repo>`，owner/repo 与 `package.json` 的仓库地址一致。

---

## 四、打包相关的硬约束

- **`asar: false`** —— daemon 用 `utilityProcess.fork` 启动，fork 需要真实文件路径，
  打进 asar 会失败。**不要改成 `true`**
- **`files` 只收 `out/**` 与 `package.json`**，排除 `**/*.map`
- **`resources/` 通过 `extraResources` 整目录随包分发**（见 `.trellis/spec/resources/`）
- `beforePack` 钩子在 `scripts/before-pack.cjs`
- **不签名**：macOS 首次打开需要「右键 → 打开」，Windows 会有 SmartScreen 提示。
  这是已知且写进文档的现状，不是缺陷

---

## 五、禁止事项

- **不放宽权限默认值或沙箱约束**（`AGENTS.md` 红线 4）。放宽是安全敏感变更，
  PR 里必须说明理由与影响面，并同步更新 `SECURITY.md` 的威胁模型
- **不删除 `$1` `$2` 这类变量名后缀**（红线 7）
- **不在日志中输出凭据或内网地址**（红线 8）
- 不为了 lint 通过而大规模重排 `src/main/daemon/`（红线 6）

---

## 相关

- `docs/ARCHITECTURE.md` —— 进程模型与「一条消息的生命周期」
- `SECURITY.md` —— 威胁模型与信任边界
- `.trellis/spec/daemon/index.md`、`.trellis/spec/shared/index.md`
