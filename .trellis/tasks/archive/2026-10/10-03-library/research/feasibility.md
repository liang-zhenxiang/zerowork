# Research: 资料库页面可行性 —— 产物数据从哪来、代价多大、有没有现成的路

- **Query**: 为「资料库」页面查清产物数据来源、聚合成本、可复用界面与边界风险
- **Scope**: internal（源码 + 本机会话文件实测）
- **Date**: 2026-10-03
- **工作目录**: `/Users/liangyuxiang/Documents/work/yu-project/zerowork`

> 本文只描述**已存在的事实**，不做实现建议以外的评判。所有结论带 `文件:行号` 或实测命令输出。

---

## 1. 产物事件存在哪、长什么样

### 1.1 `present_files` 工具与 `onPresent`

`src/main/daemon/command-exec.js:1511-1567`

- 工具名 `present_files`，参数 `files: string[]`（绝对路径或 http(s) URL）+ 可选 `explanation`（1519-1527）。
- 执行时先 `classifyPresentedFiles(params.files, sizeOf)`（1541），再调 `options.onPresent({ files, focusFile })`（1547）。
  - 传给 `onPresent` 的 `files` 是**对象数组**（`{path,size,html,kind}`），不是字符串数组。
- 工具**返回**给模型的是文本化的 `present_files_result`（1548-1563）：
  ```
  { type: "present_files_result", files: [<path 字符串>], previewed, explanation, message: "已交付", warnings? }
  ```

### 1.2 侧栏/渲染层收到的事件

- daemon 发事件：`src/main/daemon/session-files.js:2761`
  ```js
  emitSessionEvent(bucket, { type: "artifacts_presented", files, focusFile });
  ```
  `files` 即分类后的对象数组。此路径是**用户会话**（有人看）用的，同时还会 `host.persistArtifacts(...)`（2765）。
- 渲染层 reducer：`src/renderer/src/app.js:12889-12893`
  ```js
  case "artifacts_presented":
    return { ...view, artifacts: mergePresentedArtifacts(view.artifacts, event.files, Date.now()) };
  ```
- daemon 侧同形 reducer：`src/main/daemon/session-state.js:660-664`。
- `classify()` 把该条目标为 `"exempt"`（不参与折叠）：`src/renderer/src/app.js:16540`。
- 自动展开面板：`src/renderer/src/app.js:67934-67935`（收到 `artifacts_presented` → `revealPanel("artifact")`）。

`mergePresentedArtifacts(current, files, at)`：**按 path 去重，新的覆盖旧的**，并把 `at` 时间戳补上。
- 两处副本：`src/renderer/src/app.js:12547-12551`、`src/main/daemon/session-view.js:338-342`。
  ```js
  const fresh = new Set(files.map((f) => f.path));
  const kept = current.filter((a) => !fresh.has(a.path));
  return [...kept, ...files.map((f) => ({ path: f.path, size: f.size, at }))];
  ```

### 1.3 落到磁盘的哪里

- 持久化入口：`src/main/daemon/session-host.js:445-447`
  ```js
  persistArtifacts(files, focusFile) {
    this.session.sessionManager.appendCustomEntry("artifacts_presented", { files, focusFile });
  }
  ```
- 读文件方式：`src/main/daemon/session-files.js:334` `parseSessionFile$1` —— `readFileSync(path,"utf8").split("\n")` 后逐行 `JSON.parse`（335-351）。
- 恢复历史会话时重建：`src/main/daemon/session-view.js:783-795`（`buildConversationEntries` 尾部）——
  遍历 `entry.type==="custom" && entry.customType==="artifacts_presented"`，产出 `role:"artifacts_presented"` 条目；
  再经 `artifactsFromEntries`（`src/main/daemon/session-state.js:692-699`）合并成 `artifacts`。
  调用点：`src/main/daemon/session-files.js:3509`（`applyRebuiltConversation`）。

### 1.4 实测：会话文件里的形态（原文，含真实绝对路径）

命令（只读，不读内容处理）：

```bash
cd ~/.zerowork/sessions && grep -h "artifacts_presented" *.jsonl | head
```

原文（一条，未改动结构）：

```json
{"type":"custom","customType":"artifacts_presented","data":{"files":[{"path":"/Users/liangyuxiang/ZeroWork/2026-10-02-20-21-21/工作负荷周报-演示.md","size":2876,"html":false,"kind":"local"}],"focusFile":"/Users/liangyuxiang/ZeroWork/2026-10-02-20-21-21/工作负荷周报-演示.md"},"id":"8c24f1ec","parentId":"f79a975f","timestamp":"2026-10-02T12:21:58.641Z"}
```

要点：

- **路径是绝对路径**（会话文件里存的就是绝对路径，实测确认）。
- 每项字段：`path` / `size`（交付时刻 stat 的字节数）/ `html`（是否 `.html?`，见 `session-view.js:136,157`）/ `kind`（`"local"`；URL 项为 `"url"`，见 `session-view.js:145,158`）。
- 条目级额外字段：`data.focusFile`、`id`、`parentId`、`timestamp`。
- 实测同一文件被两次交付（尺寸 2876 → 2896），是**两条独立条目**（`01a0fc9a` 的 L17 与 L28），不是覆盖。去重只发生在渲染层/恢复层的 `mergePresentedArtifacts`。

实测脚本（按 kind/文件名/尺寸汇总，跨全部会话）：只有 2 个会话文件含**真**产物条目，均指向同一文件；第三个 grep 命中是**别处会话内容被 `read` 工具读入**后的文本，不是产物条目。

---

## 2. 有没有现成的聚合路

### 2.1 `listSessions()` —— 现成的全量会话扫描

`src/main/daemon/session-files.js:3304-3373`

- 第 3308 行调 `SessionManager.listAll(getSessionsDir())`。
- 返回字段（3351-3372）：`id / path / title / name / cwd / isTempTask / parentSession / createdAt / modifiedAt / messageCount / current / running / archived`。
- **不含任何产物信息**。
- 已被多处复用：`INVOKE.sessionList`（4070）、推送 `pushTaskListChanged`（1906-1916）、工作空间分组（3389）、`workspaceReveal` 白名单（4697）。

### 2.2 关键代价事实：`listAll` 本来就**全量读每个文件**

`node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js`

- `listAll`（1460）→ `buildSessionInfosWithConcurrency` → `buildSessionInfo`（492）。
- `buildSessionInfo` 用 `createReadStream` + `readline` **逐行遍历整个文件**（501-505），以统计 `messageCount`、`firstMessage`、`name`、`lastActivityTime`。
- 结论：`listSessions()` 目前**不是**只读头部，而是把每个会话文件整份流式读完。它在每个 run 边界都会被调（`pushTaskListChanged`）——即「全量扫盘」在当前代码里已经是常态。
- `findMostRecentSession`（445-465）用 `statSync(path).mtimeMs` 排序（mtime 先例，但不是缓存短路）。

### 2.3 其他扫描/聚合骨架（可参考）

| 模块 | 位置 | 做法 |
|---|---|---|
| `ledger.js` | `src/main/daemon/ledger.js:75-104` | `listLedgerFiles` = `readdirSync(dir).filter(.jsonl)`；`readLedgerEntries` = `readFileSync` + 逐行 JSON.parse（解析失败静默跳过） |
| `archive.js` | `src/main/daemon/archive.js`（`SessionArchive`） | JSON 索引文件 + 内存 `Map` + `ensureLoaded()` 一次加载（`loaded` 标志），坏文件当空索引 |
| `observability.js` | `src/main/daemon/observability.js` | 会话级统计卡片（`sessionCard`），依赖 `ledger.js`；有 `CACHE_TTL_MS` 但用于「缓存命中率归因」，非扫盘缓存 |
| `session-files.js` | `:334 parseSessionFile$1` | 通用会话文件逐行解析 |

**mtime 缓存先例**：本工程 daemon 内**未发现**「用 mtime 判脏、跳过重扫」的缓存骨架。最接近的是 `archive.js` 的「加载一次进内存」与 `SessionManager.listAll` 的 mtime 排序。→ 记为「不确定」，见第 6 节。

### 2.4 `listSessions` 里有没有产物

没有（字段清单见 2.1）。产物只在**单会话视图**里重建（`artifactsFromEntries`，`session-state.js:692`；`session-files.js:3509`）。

---

## 3. 代价实测

配置目录：`getConfigDir()`（`src/main/daemon/config-paths.js:16-18`）= `$ZEROWORK_CONFIG_DIR` 或 `~/.zerowork`。

实测命令与输出：

```bash
cd ~/.zerowork
ls sessions | wc -l        # 14
find sessions -name "*.jsonl" | wc -l   # 14
du -sh sessions            # 3.3M
```

- 会话目录**无嵌套子目录**（`find sessions -type d` 只返回 `sessions` 本身）。
- 单文件最大 852KB，其余多为 4–348KB。
- 只有 2 个文件含真产物条目（共 3 条）。

判断：本机 14 个文件、3.3M，全量逐行 JSON.parse 一遍在**数十毫秒级**；`listSessions` 本身已经在每个 run 边界做同样的全量流式读，所以「再扫一遍拿产物」不会引入新的数量级代价。但会话数与文件大小会随使用增长，且产物聚合若挂在热路径（每次 run 边界）会被反复触发。

---

## 4. 界面侧要复用什么

### 4.1 产物面板与预览

- 右侧产物面板组件：`ArtifactPanel`，`src/renderer/src/app.js:60680`。
- 面板内的「产物列表」形态：`OverviewView`，`src/renderer/src/app.js:60484-60526` —— 就是一个 `artifacts.map(...)` 列表 + 空态 `EmptyState { title: "暂无内容" }`（60496）；区分 URL（外部打开）与本地文件（预览/转正）。**可直接照抄的「列表 + 空态」形态**。
- 预览类型判定：`kindOf(path)`，`src/renderer/src/app.js:60252-60265` → `html / markdown / image / pdf / office(xlsx|pptx|…)/ video / audio / code / text / unsupported`。
  - 扩展名集合：`IMAGE_EXTS`（60212）、`PDF_EXTS`（60213）、`OFFICE_FORMATS`（60214）。
  - `docs/USAGE.md:305` 承诺的支持类型（xlsx/pptx/js/json/PDF/图片）是 `kindOf` 能力的**子集**。
- 打开预览：`openPreview2({ kind:"file", path })`（如 68858、68865）；外部打开/URL 走 `openArtifact`（68855）。
- 预览静态服务：`previewBaseUrl` ← `window.kami.previewBaseUrl(cwd)`（preload `index.js:567`；daemon `session-files.js:4675`）；服务实现 `src/main/daemon/preview-server.js`（`PreviewServer`，`baseUrl` = `http://127.0.0.1:<随机端口>`，`resolveWithinRoot` 防越界，119）。
- 文本读取：`window.kami.readArtifact(path)` → daemon `readSessionArtifact`（`prompt-templates.js:102`）；存在性：`window.kami.statPath(path)` → `statSessionArtifact`（`:116`）。

### 4.2 导航项挂真页面

- 导航表：`NAV_ITEMS$1`，`src/renderer/src/app.js:13234-13241`；资料库项 `{ icon: IconLibrary, label: "资料库", ready: false }`（13239）。
- 渲染：已就绪项 `NAV_ITEMS$1.filter(ready).map(renderNavItem)`（13706）；未就绪项成组 + 「规划中」标题（13727-13730）；`ready:false` 时按钮 `disabled` + `nav-item-pending`（13663-13665）。
- 点击分派按 **label 字符串**（`src/renderer/src/app.js:13666-13669`）：
  ```js
  if (label === "专家·技能·连接器") onOpenSkills();
  else if (label === "自动化") onOpenAutomations();
  ```
  → 挂真页面 = 把该行改 `ready:true` 并在此处加 `else if (label === "资料库") onOpenLibrary()`。
- 「切到某个视图」机制：`view` 状态 + `setView`；现有 handler `onOpenSkills: () => setView("skills")`（68785）、`onOpenAutomations: openAutomations`（68786）；视图渲染在 68890 起（`view === "skills"` 等），`returnView` 用于返回。

### 4.3 列表 + 空态 + 错误态现成形态

- `EmptyState`（`app.js:13206-13218`）、`LoadingState`（13219-13224）、`ErrorState`（13225-13233）。
- **整页 list 页模板**：`AutomationsView`（`app.js:67041`，`load()` 走 IPC + `setError` + 列表 + 运行态）与 `SkillsView`（65651，同形：`load`/`error`/`busy`/空态）。

### 4.4 「定位到来源会话」

- `resumeTask(path)`：`src/renderer/src/app.js:68401-68427` → `window.kami.resumeSession(path)` 后 `setView("chat")`。
- IPC：`INVOKE.sessionResume`（preload `index.js:542`）。

---

## 5. 风险与边界

### 5.1 产物已删除 / 已移动

- 存在性：`statSessionArtifact(cwd, path)`，`src/main/daemon/prompt-templates.js:116-124` —— 失败返回 `{kind:"missing"}`（**不抛错**，与 AGENTS.md「反直觉但刻意的行为」一致）。
- 内容读取：`readSessionArtifact`（`:102-114`）：**路径超出 cwd 抛错**「路径超出当前工作区」；文件 > 512KB（`ARTIFACT_TEXT_MAX`，`prompt-templates.js:87`）返回 `{size, text: undefined}`。
- 外部打开：`openArtifact` → `shell.openPath`，失败抛错（`src/main/index.js:401-404`）。
- 渲染层降级：`useArtifactText`（`app.js:60266-60296`）—— 失败 `setFailed(...)`、超大 `oversized`、给「重试」；`ARTIFACT_PREVIEW_MAX_BYTES = 10*1024*1024`（`app.js:12536`）。
- 产物卡本身不校验存在性：`mergePresentedArtifacts` 只按 path 去重，路径失效后仍留在列表里（`session-view.js:338`）。

### 5.2 ⚠️ 跨会话产物的**工作区边界**问题（最大边界）

`readSessionArtifact` / `statSessionArtifact` 的 `cwd` 参数取自 `currentBucket.cwd`（`session-files.js:4727-4728`）。
对**资料库**这种「汇总所有会话产物」的页面，条目可能来自**其它**会话的 cwd；若直接用当前会话 cwd 去 `resolve(cwd, path)`，会落到 `abs.startsWith(cwd + sep)` 之外而**抛「路径超出当前工作区」/ 返回 missing**。
→ 资料库若要预览跨工作区产物，需要独立于「当前会话 cwd」的读取路径（这是需要拿主意的点，见第 6 节）。

### 5.3 与「本地优先」冲突？

无网络面。预览服务只监听 `127.0.0.1` 随机端口，且已在 `EXTERNAL_REQUESTS.md` 第 5 节登记为「可控 ✅ 只监听本机回环地址，不出网」。汇总产物只读本地会话文件与本地文件，不产生出网请求。

### 5.4 `resources/**` 与登记约束

- 只要不触碰 `resources/**` 就不受「整目录排除工具链」约束（AGENTS.md 红线 5）。
- 若新增任何出网行为，需同步 `EXTERNAL_REQUESTS.md`；当前方案（本地读 + 回环预览）**不需要**新增条目。

---

## 6. 建议的实现形状（不含代码）

> 以下是「形状」，非代码；最终设计由 design.md 决定。

**数据来源**：单一事实来源 = 各会话文件里的 `customType:"artifacts_presented"` 条目
（磁盘原文见 1.4；路径为绝对路径，字段 `path/size/html/kind` + `focusFile` + `timestamp`）。

**聚合位置**：daemon 侧新增一个跨会话聚合函数（可挂在 `session-files.js`，与 `listSessions` 同层复用 `getSessionsDir()` 与逐行解析骨架）。每个产物条目补上**来源会话**信息（`path` 会话文件路径、`title`、`cwd`、`modifiedAt`）——这些 `listSessions` 已有；sessionId 可由会话文件首行 header 取。

**要不要缓存**：
- 本机 14 文件 / 3.3M，单次全量解析在数十毫秒级；作为一个「用户主动打开的页面」按需拉取（invoke）即可，**不必**每 run 边界推。
- 若要挂推送/高频刷新，再加缓存；mtime 短路在本工程**无先例**（2.3），属新增设计，需在 design.md 里说明。

**新 IPC 大概长什么样**：
- 一个 `INVOKE.libraryList` 之类的拉式 invoke，返回 `{ artifacts: [{ path,name,size,kind,focusFile,at, sessionId, sessionTitle, sessionPath, cwd }], skipped? }`。
- 命名与登记对齐现有约定：channel 常量写在 `src/shared/ipc.js`（见 `artifact:*`、`session:*` 段），preload 暴露在 `src/preload/index.js`，daemon 侧 handler 落在 `session-files.js` 的 INVOKE 表（4700+ 段）。

**渲染层复用**：
- 新 `view`（如 `"library"`），照 `SkillsView` / `AutomationsView` 的「load + error + 列表 + 空态」骨架；列表项形态照 `OverviewView`（`60484`）。
- 预览复用 `openPreview2` + `previewBaseUrl` + `kindOf`；外部打开复用 `openArtifact`。
- 导航把 `NAV_ITEMS$1` 里「资料库」改 `ready:true`，并在 `app.js:13666-13669` 的 label 分派里加分支。
- 「定位来源会话」直接复用 `resumeTask(sessionPath)`（`68401`）。

---

## 7. 不确定的 / 需要拿主意的

1. **跨工作区产物的读取边界**（5.2）：资料库条目来自不同 `cwd`，而 `readArtifact`/`statPath` 以**当前会话 cwd** 为边界。是「切到来源会话再预览」、还是「给资料库一条独立于 cwd 的读取通道」、还是「只暴露所在会话的产物」——本调研**不做选择**。
   - 相关事实：`present_files` 允许交付**工作区外**路径（sizeOf 返回 `"outside"`，`command-exec.js:1531-1534`，size 记 0），所以真实产物路径不保证落在任何会话 cwd 内。
2. **产物是否只在「用户会话」产生**：无人值守 run 会话也调 `persistArtifacts`（`session-files.js:1025-1027`），但**不发事件**。资料库要不要包含 run 会话（定时任务）的产物，未定。
3. **`size` 是交付时刻快照**，文件之后可能变化；是否要在列表里显示实时 `statPath` 结果，未定。同理 `html`/`kind` 是交付时刻判定。
4. **缓存与失效策略**：无工程内 mtime 缓存先例（2.3），是否需要、以什么为失效键，需在 design.md 定。
5. **`docs/USAGE.md:299` 写的是「工作空间文件与产物」**（比 prd 的「产物」宽）。资料库到底只列产物、还是也列工作空间文件，属需求口径问题，未定。
6. **去重语义**：同一路径被多个会话交付时，是每个会话各一卡，还是全局按 path 合并（现 `mergePresentedArtifacts` 是**会话内**去重）——未定。
