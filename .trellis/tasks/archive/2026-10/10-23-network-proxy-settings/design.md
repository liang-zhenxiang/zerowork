# 网络代理设置 —— 技术设计

## §0 结论先行

共三条网络栈，各自接管，互不假装统一：

| 栈 | 谁在发请求 | 接管方式 |
| --- | --- | --- |
| Chromium 网络栈 | 渲染层、`electron-updater` | `session.defaultSession.setProxy()` |
| daemon 的 `fetch`（模型、MCP http） | pi 内核 / MCP SDK | daemon 启动时 `undici.setGlobalDispatcher(new EnvHttpProxyAgent(...))` + `undici.install()` |
| daemon 的 `node:https` | `runtimes.js` 运行时下载 | 改为 `undici.request`（与上一条共用 dispatcher） |

「跟随系统」不需要自己解析注册表/`scutil`：主进程用 Electron 的
`session.resolveProxy(url)` 得到系统代理的权威解析结果，再注入 daemon 环境变量。
**这正是 Chromium 自己会用的答案**，比自己解析三套平台格式可靠。

## §1 数据契约

### 偏好形状（`~/.zerowork/preferences.json`）

```jsonc
{
  "proxy": {
    "mode": "off",              // off | system | manual
    "url": "http://127.0.0.1:7890",  // 仅 manual
    "username": "",             // 仅 manual，可空
    "password": ""              // 仅 manual，可空
  }
}
```

- 缺省（字段不存在）= `off`。**存量用户升级后行为不变**。
- 读侧与写侧共用同一份校验函数（照 `isThemePreference` 的写法）：
  - `mode` 必须是三个枚举之一，否则读侧丢弃、写侧拒绝
  - `url` 必须能被 `new URL()` 解析，协议限 `http:` / `https:`，且带非空 `host`
  - `username` / `password` 必须是字符串；只允许出现在 `manual`
- v1 **不支持 SOCKS**：undici 的 `ProxyAgent` 只处理 HTTP(S) CONNECT。
  UI 对 `socks5://` 给出明确提示「暂不支持 SOCKS，请使用 HTTP 代理端口」，
  而不是接受后静默直连。

### IPC 契约（`src/shared/ipc.js`）

| 通道 | 入参 | 返回 |
| --- | --- | --- |
| `INVOKE.getProxy` | — | `{ mode, url, username, hasPassword }`（**不回传密码明文**） |
| `INVOKE.setProxy` | `{ mode, url?, username?, password? }` | `{ ok: true }` |

- `getProxy` 不回传密码：设置页显示「已设置」而不是回显。写回时
  `password === undefined` 表示「保持不变」，空字符串表示「清除」。
- IPC 通道名由 `session-files.js` 的 daemon handler 实现存储与校验；
  **主进程在 daemon handler 之上再包一层**，因为保存后要触发
  `session.setProxy` 与 daemon 重启（daemon 不碰 Electron API）。

### 错误口径

| 情形 | 消息 |
| --- | --- |
| 地址缺 scheme | `代理地址需要以 http:// 或 https:// 开头` |
| 协议是 socks5 | `暂不支持 SOCKS 代理，请填写 HTTP 代理地址（多数代理客户端同时提供 HTTP 端口）` |
| 端口非法 | `代理地址的端口无效：<原值>` |
| daemon 重启失败 | `代理已保存，但内核重启失败：<原因>。请重启应用后再试` |

## §2 生效流程

```
渲染层「保存」
  → INVOKE.setProxy（主进程包装层）
      1. 调 daemon 的 setProxy 校验并落盘（失败即返回，不进入下一步）
      2. 解析出「实际代理 URL」：
         - off    → undefined
         - manual → proxy.url
         - system → session.resolveProxy("https://github.com") 的结果
      3. session.defaultSession.setProxy(...)（渲染层与更新器立即生效）
      4. restartDaemon({ proxyUrl })（模型请求、MCP、运行时下载生效）
      5. 返回 { ok, daemonRestarted }
```

### daemon 重启

当前 `startDaemon()` 只创建一次，没有重启路径。新增：

```js
async function restartDaemon() {
  const child = daemon;
  daemon = undefined;
  daemonStatus = { kind: "starting" };
  // 复用既有退出清理：pending 全 reject、daemonDown 推送
  child?.kill();
  // 等 exit 事件真正发生后再 fork，避免两个 daemon 同时写同一份配置
  await once(child, "exit");
  startDaemon();
}
```

- 重启期间界面收到 `daemon:down` → `daemon:ready`，**沿用既有降级 UI**，
  不新增一种「内核重启中」的临时状态（减少状态机分支）。
- 进行中的模型请求会中断：这是显式设置代理的代价，设置页在保存前用
  `confirm` 文案说明「正在进行的对话会被中断」。

## §3 daemon 侧实现

### 3.1 统一 dispatcher（`src/main/daemon/network.js`，新增）

daemon 入口 `index.js` 的**最顶部**（任何 `import("@earendil-works/pi-coding-agent")` 之前）：

```js
import { installProxyDispatcher } from "./network.js";
installProxyDispatcher(); // 读 process.env.ZEROWORK_PROXY_URL
```

```js
import * as undici from "undici";

export function installProxyDispatcher() {
  const proxyUrl = process.env.ZEROWORK_PROXY_URL?.trim();
  const dispatcher = new undici.EnvHttpProxyAgent({
    allowH2: false,
    proxyTunnel: true,
    connect: { autoSelectFamilyAttemptTimeout: 2000 },
  });
  undici.setGlobalDispatcher(dispatcher);
  // 与 pi 的 http-dispatcher.js 同一手法：把全局 fetch 换成 undici 的实现，
  // 保证 fetch 与 dispatcher 来自同一个 undici 实例。
  undici.install?.();
}
```

- `EnvHttpProxyAgent` 自带读写 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 的能力。
  没有代理环境变量时它等价于直连，因此 `off` 模式也走同一条路径 ——
  **不引入「有代理/无代理」两套分支**。
- 必须把 `undici` 加进 `package.json` dependencies，并锁到与 pi 相同的
  `8.10.2`，让 npm 去重为同一实例（否则 `setGlobalDispatcher` 设的是 A 实例、
  模型 SDK 用的是 B 实例，表现为「设置生效了，但请求还是直连」）。
- `NO_PROXY` 默认包含 `127.0.0.1,localhost,::1`，保证本地预览服务永不被代理。

### 3.2 运行时下载（`runtimes.js`）

`requestOnce` 现在直接用 `node:http/https` 的 `get`，不认代理。改为
`undici.request`：

- 保留既有语义：`range` 头、重定向、`status 200/206`、`content-length`、`AbortSignal`
- `request` 返回 `body` 是 `Readable`，与现有 `for await (const chunk of response.body)`
  的写法兼容
- 走全局 dispatcher，因此与模型请求共用同一份代理配置

**注意**：`undici.request` 的错误类型与 `node:https` 不同。现有
`DownloadError` 的分类（`http` / `io` / `size` / `sha256`）要映射过去，
不要让代理失败变成未分类的裸错误。

### 3.3 MCP http 连接器

`@modelcontextprotocol/sdk` 的 StreamableHTTP / SSE transport 使用全局 `fetch`。
`undici.install()` 之后自动经过 dispatcher，**无需改 MCP 代码**。
风险点：SDK 若缓存了 `fetch` 引用，需要在 MCP 连接器创建时确认；实现阶段核实。

## §4 「跟随系统」的解析

主进程：

```js
const resolved = await session.defaultSession.resolveProxy("https://github.com");
// 返回示例："PROXY 127.0.0.1:7890; DIRECT" / "DIRECT" / "SOCKS5 127.0.0.1:7891"
```

- `DIRECT` → 无代理
- `PROXY host:port` → `http://host:port`
- `SOCKS5 ...` → 取第一条 `PROXY`；没有则视为「系统使用了不支持的代理类型」，
  在主进程日志记一条 **不含凭据** 的说明，行为退回直连并在 UI 显示提示

这条解析只在 daemon 重启时做一次（不在每次请求时做），失败不影响应用启动。

## §5 安全

- **密码只进 preferences.json（0600）**，与既有 `webSearch.apiKey` 同级。
  不写入：
  - 任何 IPC 返回值（`getProxy` 只回 `hasPassword`）
  - 事件日志 / 审计 / daemon stderr
  - 错误消息（校验失败时只报字段名，不回显值）
- **URL 中的凭据**：允许 `http://user:pass@host:port` 形式，但落盘前拆成
  `url` / `username` / `password` 三字段，避免密码混在 URL 里被整体打印。
- **代理不改变沙箱与权限模型**：本功能只影响出站网络路径，不触及命令沙箱。
  PRD 验收里保留「直连下行为与改动前完全一致」一条，防止误伤。

## §6 测试

### 单元（vitest）

- `proxy` 偏好校验：合法三档、非法协议、缺端口、socks5、密码不回传
- `resolveProxyResultToUrl()` 纯函数：`DIRECT` / `PROXY` / `SOCKS5` 三种输入

### e2e（`tests/e2e/gui-proxy.mjs`，新增）

1. 启动一个本地 HTTP mock 代理（记录收到的 CONNECT/请求）
2. 设置 → 通用 → 代理选「手动」→ 填 `http://127.0.0.1:<mockPort>` → 保存
3. 断言：`session.setProxy` 被调用（通过主进程调试通道或日志断言）
4. 断言：daemon 重启（`daemon:down` → `daemon:ready`）
5. 断言：mock 代理确实收到了来自 daemon 的出站请求
   （用一个假的模型 baseUrl 指向被代理的地址）
6. 切回「直连」→ 断言 mock 代理不再收到请求

### 回归

- `test:gui:updates` 必须仍绿（更新器与代理共用 `session`）
- `test:unit` 中 runtimes 下载相关用例改成 `undici` 之后仍绿

## §7 取舍与已知限制

| 取舍 | 理由 |
| --- | --- |
| 不做 SOCKS | undici 无原生支持；引入 `socks-proxy-agent` 是新依赖 + 新测试面，v1 先不做 |
| 不做「按请求类型分别代理」（模型走 A、更新走 B） | 用户选择的是「跟随系统 + 手动」；分项覆盖是另一个产品决策，等真实需求 |
| 代理变更重启 daemon | 模型 dispatcher 在进程启动时构造，热切换需要 pi 暴露 API（它没有）；重启是最小可靠路径 |
| 密码明文落盘 | 与既有 `webSearch.apiKey` 一致；要加密需 `safeStorage`，但 daemon 读不到 —— 留给后续独立任务 |

## §8 回滚

- 代码回滚：删除 `network.js`、恢复 `runtimes.js` 的 `node:https`、
  移除 IPC 与 UI 区块。偏好里的 `proxy` 字段对旧版本是无害的多余键
  （`readPreferences` 会忽略未识别字段）。
- 功能回滚（不发版）：设置页切回「直连」，daemon 重启后即恢复旧行为。
