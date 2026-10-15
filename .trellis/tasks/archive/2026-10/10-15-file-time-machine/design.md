# 技术设计:「时光机」—— 文件历史版本与还原

对应 `prd.md`。分层、契约、数据流、权衡与回滚。

## 1. 模块边界

```
src/main/daemon/version-store.js        新增·存储模块(不 import Electron,可被单测直接 import)
  ├ recordVersion(input)                写一条「改动前内容」
  ├ listVersionFiles()                  聚合清单(按最后改动时间倒序)
  ├ readVersionFile(key)                读一个文件的版本元数据 + 全部版本条目
  ├ readVersionContent(key, id)         读某一版的正文
  └ restoreVersion(key, id)             还原(内容校验 + 落盘)
src/main/daemon/session-host.js         write/edit 成功回执处调用 recordVersion
src/main/daemon/session-files.js        三个 IPC handler + 「会话在跑就拒绝」的判据注入
src/main/daemon/audit.js                新增 file 类别 / restored 结果
src/shared/ipc.js + src/preload/index.js   两张常量表(手工同步,见 spec/guides §二.1)
src/renderer/src/app.js + app.css        FileHistoryView + 侧栏入口
tests/unit/version-store.test.mjs       存储模块单测
tests/e2e/file-history.mjs              端到端(真实启动 + 截图)
```

## 2. 存储布局

```
<config>/versions/
  <key>/                              key = sha1(绝对路径) 取前 16 位 hex
    meta.json                         { path, skipped, versions: [ { id, at, size, sessionId, tool, added, removed } ] }
    <id>.txt                          该版本的正文(UTF-8 原文)
```

- `id` = 毫秒时间戳字符串;同一毫秒内重复时递增到不冲突为止
- `versions` 数组**旧→新**排序(与时间轴渲染方向一致)
- `meta.json` 原子落盘(临时文件 + rename),与 `pin.js` / `projects.js` 同款手法
- **不上锁**:写入来自 daemon 主循环,单线程串行;读取来自 IPC handler,
  读到半个 meta 时按「坏数据」降级(见 §5)

### 硬边界(写死在模块常量里并导出,便于单测钉住)

| 常量 | 值 | 行为 |
| --- | --- | --- |
| `VERSION_MAX_PER_FILE` | 20 | 超出时丢**最旧**的版本(含删内容文件) |
| `VERSION_MAX_BYTES` | 1 MiB | 旧内容超过它时**整条跳过**,`meta.skipped` 计数 +1 |
| `VERSION_BINARY_SNIFF` | 前 8 KiB 含 NUL | 判定为二进制,整条跳过 |
| `VERSION_LIST_MAX_FILES` | 200 | 清单上限,超出置 `truncated: true`(界面必须说出来) |

`skipped` 让界面能说「这个文件有 N 次改动没留下版本」——
不静默吞掉,与 `library.js` 的 `truncated` 是同一族做法。

## 3. 契约

### 3.1 IPC(三个通道,四地同步)

```js
INVOKE.fileHistoryList    = "versions:list"
INVOKE.fileHistoryRead    = "versions:read"
INVOKE.fileHistoryRestore = "versions:restore"
```

```ts
// versions:list  → { files: FileEntry[], truncated: boolean }
type FileEntry = {
  key: string; path: string; name: string; dir: string;   // dir 是绝对路径的父目录
  count: number; skipped: number; lastAt: number;
  lastSessionId?: string; lastTool?: string; exists: boolean;
};

// versions:read  → { ok: true, path, versions, content?, contentAt? } | { ok: false, reason, message }
// 入参 { key, id? };带 id 时额外返回该版正文
type VersionEntry = { id: string; at: number; size: number; sessionId?: string;
                      tool?: string; added?: number; removed?: number; broken?: boolean };

// versions:restore  → { ok: true, at, versions } | { ok: false, reason, message }
// 入参 { key, id }
```

- **失败一律用返回值表达,不 reject**(与 `forkSession` 的 `branchFail` 同族):
  `reason ∈ "unknown" | "missing" | "running" | "write-failed" | "no-such-version"`
- 单条坏数据不整体失败:某一版的正文读不出来时,该版标 `broken: true`,
  其余版本照常返回
- `preload` 在 `contextBridge` 的 `kami` 键下暴露三个方法:`listFileHistory` /
  `readFileHistory` / `restoreFileHistory`(照 `listLibrary` 的写法)

### 3.2 记录时机(关键决定)

**在工具「成功」回执处记,不在「开始」处记。**

开始处已经有 `oldContent`(`session-host.js:1023`),但那时还不知道这次写入会不会失败;
失败时文件没变,记下来就是一条**假的版本**。所以:

- 开始处:照旧只算 `added` / `removed` 放进 `pendingChanges`(既有行为不动)
- 成功回执处(`outcome === "ok"` 且 `changeType === "modified"`):
  调用 `recordVersion({ path, content: stash.oldContent, at, sessionId, tool, added, removed })`

> 为此 `pendingChanges` 的条目要多带 `path` 与 `oldContent`。
> **只增字段,不改既有消费点**(标签与 changeType 的用法不动)。

### 3.3 还原的拒绝判据

| 判据 | 结果 |
| --- | --- |
| `key` 不在存储里 / `id` 不在 meta 里 | `no-such-version` |
| 目标版本正文文件不存在或读失败 | `missing` |
| 该文件最近的 `sessionId` 对应的会话**正在运行** | `running` —— 拒绝,并说明「等它跑完再还原」 |
| 写盘失败 | `write-failed`,带原始错误摘要 |

「会话在跑」由 `session-files.js` 注入(`isSessionRunning(sessionId)`),
`version-store.js` 自己不碰会话桶 —— 保持它可被单测直接 import。

### 3.4 还原本身也留一版

还原前**先读当前磁盘内容**,作为一条新版本写进同一个 `key`(标 `tool: "restore"`),
然后才写回目标版本。顺序是「**先留后改**」——
与「落盘先于界面更新」同一条纪律:还原之后即便进程被杀,当前内容也没丢。

当前内容与目标版本**逐字节相同时**,不写新版本(避免还原成一个空操作却多一条噪音),
但仍如实返回成功与 `unchanged: true`。

### 3.5 审计

```js
// src/main/daemon/audit.js
AUDIT_CATEGORY_LABELS.file = "文件改动";      // 新增类别
AUDIT_OUTCOME_LABELS.restored = "已还原";     // 新增结果
AUDIT_CATEGORIES = [...既有的, "file"];       // 面板按此列出分类
```

详情文案:`clipAuditDetail("用户把 <文件名> 还原到 <时间>:当前内容已先存为一条新版本")`。

> ⚠️ 渲染层有一份**手工同步的副本**(`app.js` 约 65198 行的
> `AUDIT_CATEGORY_LABELS` / `AUDIT_OUTCOME_LABELS` / `AUDIT_CATEGORIES`),
> **两处都要改**,否则面板里这一条会被 `parseRecord` 静默丢掉。

## 4. 渲染层

- 纯逻辑抽到 `src/renderer/src/file-history-core.js`(照 `trace-core.js` /
  `projects-core.js` 的分工):清单排序、版本标签文案、相对时间、
  「这一版之后被 +X −Y 替换」的措辞、`skipped` 的提示语 —— 全部可被
  vitest 直接 import
- 视图是 `app.js` 里的 `FileHistoryView`,挂进 `App` 的 `view` 分支
  (照 `LibraryView` / `StatsView` 的写法),侧栏在 `NAV_ITEMS` 之外单独加一项
  「文件历史」(与「诊断」「统计」同款写法),排「资料库」之后
- 视觉遵守 `docs/DESIGN.md`:一个内容卡级的主盒子、三态齐备、
  只用既有 token;新页面若有**新动画**必须登记进 §10.3 并加入 §10.3.1 关停清单
- **具体版式以设计师的 `research/ux-proposal.md` 为准**

## 5. 错误与降级(如实说,不装好)

| 情形 | 表现 |
| --- | --- |
| 存储目录不存在 | 空态,不是错误 |
| 某文件 meta 损坏 | 该文件整条跳过、不出现在清单里(daemon 控制台留一条日志);不影响其它文件 |
| 某一版正文缺失 | 该版在时间轴上标「内容已不在」,不可还原 |
| 文件已被删除(`exists: false`) | 清单里照常显示并标注「文件已不在」,还原会**重新创建**它 |
| 清单超 200 条 | `truncated: true`,界面说出来 |

## 6. 测试计划

| 层 | 文件 | 覆盖 |
| --- | --- | --- |
| 单元 | `tests/unit/version-store.test.mjs` | 记录判据(成功/新建/二进制/超体积)、20 版裁剪、原子写、坏 meta、读回、还原、还原留一版、清单排序与 truncated |
| 单元 | `tests/unit/file-history-core.test.mjs` | 排序、文案、skipped 提示、相对时间 |
| e2e | `tests/e2e/file-history.mjs` | 真实启动 + mock 改两次同一文件 → 页面出现两条版本 → 还原 → **磁盘内容真的退回去** → 页面刷新 → 浅色截图 + 暗色一张 |
| 静态 | `tests/e2e/gui-sections.mjs` | 新页面登记进 `SECTIONS` |

反向验证(必须真跑并留下记录):

1. 把「成功才记」改成「开始就记」→ 相关单测与 e2e 变红,其余不受影响
2. 注掉还原处的审计写入 → 审计断言变红

## 7. 未采纳的方案(写进 `docs/ARCHITECTURE.md` 决策表)

| 方案 | 为什么否掉 |
| --- | --- |
| 依赖 git 做版本 | 办公目录常常不是 git 仓库;而「没有 git 也要能退」正是本功能的立足点 |
| 命令执行前后快照整个工作区 | 每次命令前后递归复制整个目录,代价与收益不成比例;且会撞上仓库体积红线 |
| 存 diff 而不是存全文 | 还原要能把文件**逐字节**变回去;存 diff 需要一条可靠的逆应用链,坏一环整条历史失效。1 MiB 上限 + 20 版已经封住了体积 |
| 记在会话文件里 | 会话文件是 Agent 上下文的载体,不能被版本数据撑大(`session:list` 是热路径);版本与文件的关系也跨会话 |
| 还原时不留当前版本 | 会把「还原」变成不可逆操作,与「清空前也留痕」的既有纪律相反 |
