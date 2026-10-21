# 架构说明

## 进程模型

```
┌──────────────────────── Electron 主进程 (src/main/index.js) ────────────────────────┐
│                                                                                      │
│  createWindow()          主窗口（sandbox 渲染层）                                     │
│  installCsp()            按 dev/prod 下发 CSP                                        │
│  registerIpc()           IPC 路由：本地应答 + 转发 daemon                             │
│  startDaemon()           fork Agent 内核（Electron utilityProcess）                   │
│  setupGlobalShortcut()   全局快捷键（默认 Shift+Alt+W）                                │
│  appMenuTemplate()       应用菜单（macOS 走原生菜单栏）                                │
│                                                                                      │
└──────────────┬──────────────────────────────────────────┬────────────────────────────┘
               │ utilityProcess.fork                       │ ipcMain / ipcRenderer
┌──────────────▼───────────────────────┐   ┌──────────────▼──────────────────────────┐
│  daemon (src/main/daemon/index.js)    │   │  preload (src/preload/index.js)          │
│                                       │   │  contextBridge 暴露 60+ IPC 通道          │
│  · 会话生命周期与事件流                │   └──────────────┬──────────────────────────┘
│  · 模型目录与供应商凭据                │                  │
│  · MCP 连接器管理                     │   ┌──────────────▼──────────────────────────┐
│  · 自动化任务调度                     │   │  renderer (src/renderer, sandboxed)      │
│  · 会话归档 / 审计日志 / 运行账本      │   │  React 19 SPA                            │
│  · 沙箱调度（probe / start / run）     │   └─────────────────────────────────────────┘
│  · 资源加载（agents / skills / modes） │
└──────────────┬───────────────────────┘
               │
┌──────────────▼───────────────────────┐
│  sandbox worker (sandbox/index.js)    │
│  · 沙箱能力探测 (probeSandbox)         │
│  · 沙箱化执行 (startSandboxed / run)   │
│  · 失败分类 (classifyFailure)          │
└──────────────────────────────────────┘
```

### 为什么 daemon 是独立进程

Agent 内核需要 `await import` 整个 pi SDK，初始化耗时长，且作为执行不可信内容的
组件有崩溃风险。放进 utilityProcess 隔离：崩了不会带走界面，慢启动不会卡住窗口。

### daemon 启动竞态

daemon 就绪后向渲染层推送 `daemon:ready`。但**推送可能在渲染进程注册监听器之前
就发生**——双方完成时间取决于机器，谁快谁慢不确定。一旦推送早于监听器注册，
事件永久丢失，界面会卡在「正在启动」且无法恢复。

解法是 `INVOKE.daemonStatus`：渲染进程挂载后主动查询一次当前状态，
不依赖推送。这是个**必须保留**的通道，删掉会重新引入竞态。

## 目录职责

| 路径 | 职责 |
| --- | --- |
| `src/main/index.js` | 应用入口：窗口、菜单、快捷键、CSP、IPC 注册、daemon 拉起 |
| `src/main/daemon/` | Agent 内核，52 个领域模块（见下） |
| `src/main/sandbox/` | 沙箱探测与执行，独立 worker |
| `src/preload/index.js` | contextBridge 桥接层，定义渲染层可见的 IPC 面 |
| `src/shared/ipc.js` | IPC 通道常量与文档类型判定，主进程与 preload 共用 |
| `src/renderer/src/` | React SPA（chunk 粒度，见「渲染层现状」） |
| `resources/` | 运行时内容资源：场景、模式、专家、技能、样式、提示词、可视化规范 |
| `tools/` | 开发脚本（daemon 模块图检查等） |

### daemon 模块划分

daemon 共约 24,400 行，按领域拆为 52 个模块（两个数字都会随迭代漂移，
实时值以 `npm run check:daemon-graph` 的输出为准）。主要模块：

| 模块 | 职责 |
| --- | --- |
| `index.js` | 入口：模块装配、IPC 处理、启动流程 |
| `session-host.js` | 会话宿主：核心运行循环 |
| `session-view.js` | 会话视图投影：时间线、diff、文件呈现、对话条目 |
| `session-state.js` | 状态归约、宿主池、上下文用量、会话检索 |
| `session-files.js` | 会话文件读写、分支、用量统计、自动化调度 |
| `review.js` | 变更审阅台：按变更列队、已阅状态、并排 diff 读取（复用 `version-store.js`） |
| `command-exec.js` | 命令执行、权限闸门、危险模式匹配 |
| `permission-rules.js` | 命令与路径的权限判定 |
| `runtimes.js` | 运行时管理：安装、探测、环境注入、诊断 |
| `doc-extract.js` | 文档读取：PDF / Office / docx 转换 |
| `tool-factories.js` | 问卷、技能安装、后台任务、待办、可视化等工具工厂 |
| `mcp-client.js` / `mcp.js` | MCP 客户端连接与配置解析 |
| `prompt-compose.js` | 提示词组装：隐藏上下文、专家人设、风格、片段 |
| `prompt-templates.js` | 提示词模板与会话级模板列表 |
| `experts.js` / `skills.js` | 专家 / Agent / 技能的加载、导入、成本估算 |
| `ledger.js` | 运行账本（RunLedger） |
| `observability.js` | token 估算、缓存命中、会话统计 |
| `automation.js` / `automation-tools.js` | 自动化任务存储、调度与工具 |
| `audit.js` / `event-log.js` | 审计日志与事件日志 |
| `teams.js` / `mailbox.js` / `subagent.js` | 团队、会话邮箱、子 agent |
| `git-worktree.js` / `workspace.js` | Git worktree 与工作区管理 |
| `models.js` / `model-catalog.js` / `auth.js` | 模型、目录、凭据 |
| `config-paths.js` / `preferences.js` / `permissions.js` | 路径、偏好、权限预设 |
| `memory.js` / `schedule.js` / `archive.js` | 记忆系统、调度、归档 |
| `web-tools.js` / `preview-server.js` | 联网工具、预览服务 |

⚠️ **改动 daemon 时请留意跨模块的初始化期依赖**。43 个模块的顶层求值顺序
由 import 图决定；在顶层引入新的跨模块引用可能触发 TDZ 错误
（`Cannot access 'x' before initialization`）。

## 渲染层现状

**当前状态：chunk 粒度，不是组件粒度。**

`src/renderer/src/` 下的 30 个文件对应构建时的 chunk
（`app.js` / `workspace.js` / `code-preview.js` …），不是逐组件的源文件。
`app.js` 单个文件就有 68,152 行、1,724 个顶层声明（含 React 及其它内联库）。

### 为什么不拆到组件级

渲染层与 daemon 的情况不同：daemon 是应用自身逻辑，领域边界清晰；
渲染层这一个 chunk 里混了 React 运行时、各类第三方库和应用组件，
1724 个顶层声明构成一个连通块。自动区分「哪些是第三方库、哪些是应用代码、
哪些是组件」需要语义判断，无法靠工具可靠完成。**强行自动拆分会产出既不可读
也不可靠的模块划分，不如保持现状并说清限制。**

要拆到组件级，需要人工判断组件边界。已知的模块切分线索：

| 模块 | 作用 |
| --- | --- |
| `lib-chat-ui` | 对话 UI 组件库（`.cr-input-footer-item` 等 `cr-` 前缀类名） |
| `home` | 首页 |
| `ui-docs-viewer` | 文档查看器 |
| `safe-delete-events` | 安全删除事件处理 |

`app.css` 的注释引用这些模块里的类名来交代取值来由 —— 类名本身都还在
`app.css` 里，可直接搜索核对。

## 资源系统

`resources/` 下的内容是产品可配置性的来源，daemon 启动时加载：

| 目录 | 内容 |
| --- | --- |
| `scenes/` | 场景（代码开发 / 日常办公 …） |
| `modes/` | 交互模式（问答 / 创作 / 规划）。含 `tools` 白名单 |
| `experts/` | 专家角色，每个含技能与 agent 定义 |
| `skills/` | 技能（docx、前端设计、会议纪要…） |
| `agents/` | Agent 定义（planner / reviewer / scout / worker） |
| `styles/` | 回答风格 |
| `prompts/` | 提示词片段与语言、记忆系统提示 |
| `visualizer/` | 可视化规范（图表、配色、图表类型） |
| `welcome/` | 首屏案例与快捷入口 |
| `runtimes/` | 运行时（gitbash 等） |
| `plugins/` | 插件市场内容 |
| `bin/` | 随包分发的工具二进制（rg、fd、uv） |
| `docx-engine/` | 文档转换引擎（Python） |

资源目录通过 `ZEROWORK_RESOURCES_DIR` 环境变量可覆盖，
这使得把资源目录指向仓库外成为可能（开发模式依赖此项）。

## 沙箱与权限

两层控制：

1. **权限预设**（`PERMISSION_PRESETS` / `APPROVAL_POLICIES`）
   ——决定某些操作是否需要用户确认
2. **沙箱模式**（`SANDBOX_MODES`）——决定命令在何种隔离环境执行

沙箱能力在启动时探测（`probeSandbox`），探测失败会被分类
（`classifyFailure`）并降级，而不是让整个 daemon 挂掉。

审计日志记录四类事件：`command`、`sandbox`、`runtime`、`audit`。

## 类型检查

**当前状态：`checkJs` 关闭。**

原因：应用主体以 JS 提供，没有编译期类型信息。
只有 `typebox` 这一个**运行时**类型库（用于工具参数校验）。
直接开启 `checkJs` 会产生数以万计的 `noImplicitAny` 报错——这些报错
反映的是「类型还没补」，不是「代码有问题」，开着只会淹没真正的问题。

**渐进补类型的路径：**

1. 从 `src/shared/` 开始（体量小、被依赖广、契约价值最高）
2. 补完一个目录，就把对应路径从 `tsconfig.json` 的 `exclude` 里移出
3. 工具函数与纯逻辑优先（易验证），React 组件次之
4. 补到报错量可控时，开启 `checkJs` 并在 CI 中固化

**这个限制无法绕过**：编译期类型信息没有随代码保留下来，只能靠人补。

## 一条消息的生命周期

理解这条链路，等于理解了四个进程为什么这样分工。

```
① 渲染层            用户在「助理」里发送消息
   window.kami.prompt(...)          ← preload 通过 contextBridge 暴露的桥接方法
        │
② preload           把调用转成 IPC（通道常量在 src/shared/ipc.js，主进程与 preload 共用）
        │  ipcRenderer.invoke
③ 主进程 index.js   registerIpc() 路由：能在主进程本地应答的就地答
        │           （对话框、读取图片字节这类需要 Electron 能力的）
        │  utilityProcess 消息
④ daemon            会话构造 → 模型凭据 → MCP 连接 → 资源加载 → 提示词组装
        │           prompt-compose.js 组装系统提示词与上下文
        │           session-host.js 跑核心运行循环
        │  await import pi SDK
⑤ pi agent harness  HTTP + SSE
        │
⑥ 模型供应商        流式回包
        │
⑦ daemon           session-state.js 做状态归约；session-view.js 投影成时间线 / diff / 文件呈现
        │           session-files.js 落盘（会话记录、用量）
        │  push 事件
⑧ 渲染层            界面按投影结果重绘
```

几个由此而来的结论：

- **界面渲染的数据是「投影」，不是 daemon 的原始状态**。`session-view.js` 决定「什么值得显示」，
  所以那一层出错的表现是「数据区空白或停在加载态」而不是崩溃 —— 这类问题只有真正调一次
  IPC 才能发现（这就是 ⑤「IPC 功能性」那层测试存在的理由）
- **工具调用发生在 ④–⑤ 之间**，权限判定（`permission-rules.js`）在 ④ 侧、独立于模型 ——
  模型无法通过「说这是安全的」绕过它
- **落盘（⑦）先于界面更新（⑧）**，所以「界面上看到了」意味着「记录已经写下了」

### 跨进程状态与已知竞态

daemon 启动完成时会**推送**一条 ready 事件；而渲染层同时也在**注册监听器**。
谁先完成取决于机器 —— 推送早于注册就永久丢失，界面卡在「正在启动」。

解法是加一条**主动查询**通道（`INVOKE.daemonStatus`）：渲染进程挂载后主动查一次，
不依赖推送的到达顺序。这是一个通用模式：**跨进程的「就绪」状态用查询，不要只靠推送。**

## 设计决策与已否决方案

下面这些是已经定过的判断。**改代码之前先读这一节** —— 你会发现有些「看起来该改」的地方
是刻意这样的，理由都在这。

| 决策 | 结论 | 被否掉的方案 | 理由 |
| --- | --- | --- | --- |
| daemon 的进程模型 | 独立的 `utilityProcess` | 与主进程同进程 | 它要 `await import` 整个 pi SDK、初始化慢且作为执行不可信内容的组件有崩溃风险。隔离后崩了不带走界面、慢启动不卡窗口 |
| 渲染层拆分 | 保持 chunk 粒度 | 自动拆到组件级 | 见[上一节](#为什么不拆到组件级)：自动区分第三方库 / 应用代码 / 组件需要语义判断，工具做不到，强拆产出既不可读也不可靠 |
| 类型检查 | `checkJs` 关闭 | 直接开启 `checkJs` | 会产出数以万计的 `noImplicitAny` —— 那些报错反映「类型还没补」而不是「代码有问题」，开着只会淹没真问题 |
| 就绪状态传递 | 推送 **+ 主动查询** | 只靠推送 | 见上：推送可能早于监听器注册而永久丢失 |
| 命令沙箱不可用时 | **直接拒绝执行** | 降级为无约束执行 | 否则「受限档」就成了摆设 —— 用户以为有约束，实际没有。宁可不执行 |
| 元数据清理的归属 | 由还原/清理**工具**做，不手工改源码 | 源码里手工改 | 手工改会让源码与工具的输出漂移，下次重跑又回来 |
| 渲染层产物命名 | 无哈希的语义名 | Vite 默认的内容哈希 | 懒加载依赖表是**字面量字符串**，构建工具不改写它们；带哈希则全部断链，CSS 那条会让整个渲染层落进错误边界（真实事故） |
| 大块文件的行尾与格式 | `.gitattributes` 对它们标 `-text`｜格式检查排除 | 全仓统一格式化 | 行尾归一化与格式化重排都会产生淹没真实改动的巨型 diff |
| 本机服务的占位凭据 | 写进 `models.json` 条目的 `apiKey`（取值 `local-no-auth`） | ① 写进 `auth.json`；② 放宽 `isUsable`（让本机服务免凭据） | 不写凭据**根本行不通**：pi 的 `getProviderAuthStatus()` 判 `{configured:false}`，模型的 `available` 为 false，而 `setModel` 的第一道门就是 `isUsable()` —— 一键接入会建好服务商却**选不中模型**。**① 被否**：会把一个假凭据放进**凭据库**，且 `deleteCustomProvider` 只调 `runtime.removeRuntimeApiKey`、不调文件级的 `removeApiKey`，删服务商后占位会变成孤儿留在 `auth.json`。**② 被否**：直接违反「宁可拒绝，也不静默降级」—— `isUsable` 是「换了会报错的模型」的唯一守卫，放宽它会让用户选到真跑不通的服务商。写进条目则生命周期跟着服务商走（删服务商即删占位），且渲染层拿不到该字段。**渲染层拿不到 Key，但需要知道「这一行没有东西可换」**（#147：否则那里挂着一个没有东西可换的「更换 Key」）—— 所以 `toProviderInfo` 把它翻译成一个布尔事实 `placeholderCredential`（判据 = 凭据的值是否等于占位常量，见 `model-catalog.js` 的 `hasPlaceholderCredential`），凭据本身仍然不出 daemon |
| 文件历史版本的存法 | 存**全文**，落在配置目录 `versions/`（每文件 20 版 / 单版 1 MiB 上限） | ① 依赖 git；② 命令前后快照整个工作区；③ 存 diff | **① 被否**：办公目录常常不是 git 仓库，而「没有 git 也要能退回去」正是这个功能的立足点。**② 被否**：每次命令前后递归复制整个目录，代价与收益不成比例，还会撞上仓库体积红线（所以「Agent 通过命令改的文件」不在覆盖范围内，这是**写明的边界**不是遗漏）。**③ 被否**：还原要能把文件**逐字节**变回去，存 diff 需要一条可靠的逆应用链，坏一环整条历史失效；全文 + 上限已经封住了体积 |
| 文件历史版本的记录时机 | 工具**成功**回执处（`tool_execution_end`），且只在**覆盖**时记 | 在工具开始处记 | 开始处虽然已经有「改动前的内容」（`readOverwriteTarget()` 就在那里读的），但那时还不知道这次写入会不会失败 —— 失败时文件根本没变，记下来就是一条**假版本**。新建文件同样不记：没有旧版可留 |
| 值守规矩的归属 | **每个任务一份**，与全局档位收敛取严 | 做成全局配置 | 这一层管的是「无人值守时该怎么办」，而每个任务的答案本来就不同（汇总报告的与整理下载目录的不是一个边界）。做成全局等于让用户在**所有任务之间做一次共同的妥协** |
| 值守规矩的方向 | **只能收紧，不能放宽** | 允许任务规矩放宽全局档位 | 能放宽就意味着「任务里的一行配置可以绕过全局安全档」，那全局档位就不再是一道真的边界。用户的直觉是「我全局设了只读」，这个直觉不该被某个任务的配置悄悄推翻 |
| 够不到的值守选项 | UI 里 **`disabled` + 「不生效」徽标** | 可选，提交时静默折算回原值 | 折算的代价是**用户以为划了界、实际没有** —— 点了「可写」却按只读跑完，代价是白等一夜；看到它灰着并注明原因，代价只是多读一行字。碰不到的选项不会让人误会，能碰到却悄悄变卦的才会 |
| 老运行记录的报告体 | **不渲染**（无 `boundary` 即视为该功能上线前的记录） | 补一个空 `boundary` 再渲染 | 补空壳会让用户以为「这次有边界、只是没用上」，而事实是**那次运行根本没有边界这个概念**。宁可少一段 UI，也不给一个错误的既成事实 |
| `stopOnExceed` 的缺省 | 缺省与显式 `true` 都是**停整轮**；只有显式 `false` 才降级为「拒这一次调用」 | 缺省视为 `false` | 「越界就停」是安全侧缺省。把缺省解释成宽松，等于让**没配过这个字段**的老任务在越界后继续往下跑 —— 而用户从没同意过那个行为 |

> **新增决策时请补一行到这张表**，并写清「被否掉的方案」——
> 只写结论的决策记录，对后来者没有价值。
