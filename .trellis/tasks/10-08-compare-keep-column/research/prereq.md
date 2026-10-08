# Research: 「把对比满意的那一列收进会话」的前提调研

- **Query**: 对比屏每列完成态给「留下来」动作，把该列会话分叉成普通会话进侧栏；核实编排层信息、materializeBranch 适配、界面交互与测试先例
- **Scope**: internal
- **Date**: 2026-10-08
- **基线**: main @ 9e59259（v0.5.0）

---

## A. 编排层手里有没有「那一列的会话文件路径」

### A1. 拿得到：`SessionHost.sessionFilePath` 是现成 getter

`src/main/daemon/session-host.js:503-505`：

```js
get sessionFilePath() {
  return this.session.sessionManager.getSessionFile();
}
```

注释（499-502）：「当前会话文件名。daemon 用它标会话列表的 current、判定 rename/delete 的目标是不是这个活会话」。底层是 pi 的 `getSessionFile()`——**路径在 `SessionManager.create` 时就已分配**，不依赖文件落盘（pi `node_modules/.../session-manager.js:711-715`，`newSession()` 内 `this.sessionFile = join(...)`）。

`compare.js` 的 `runColumn` 里 host 就在作用域内（`compare.js:549` 创建、`compare.js:565` 调 `markCompareRun`），随时可取 `host.sessionFilePath`。

### A2. dispose 不删文件；但 `run_finished` 现在不带路径，落盘时机有讲究

**dispose 后文件还在**。`session-host.js:440-446`：

```js
dispose() {
  if (this.pendingDeltas !== void 0) { clearTimeout(this.pendingDeltas.timer); ... }
  this.session.dispose();
}
```

只清计时器与释放会话对象，不碰磁盘。会话文件与 cwd 无关地落在 sessions 目录（`session-host.js:484-489` 注释：「对比会话与主会话**同落 sessions 目录**」）。

**文件何时真正写盘**：pi 的 `_persist` 有 no-assistant guard（pi `session-manager.js:785-813`）——**第一条 assistant 消息出现时才把全部条目（header + compare_run + user + assistant）一次性写盘**，之前只攒内存。因此「留下来」只对 `status === "done"` 的列开放即可保证文件必然在盘上。

**`run_finished` 与摘要都不带会话路径**。`compare.js:332-342`：

```js
function summarizeColumn(state) {
  return { columnId: state.columnId, modelKey: state.modelKey, status: state.status,
    ...state.elapsedMs === undefined ? {} : { elapsedMs: state.elapsedMs }, ... };
}
```

`execute` 的返回值 `columns: record.states`（`compare.js:673`）同样只是展示态。`record` 上也没有任何文件路径字段。

**在哪记最自然**：`runColumn` 的 `finally`（`compare.js:635-639`）里、`host.dispose()`（637 行）之前——此刻 host 引用仍在，`host.sessionFilePath` 一定可读；写进 record 的一个新字段（如 `record.files[columnId] = host.sessionFilePath`）。放在 `markCompareRun`（565 行）旁边也可，但那时文件还没落盘（见上），存路径本身没问题、只是不能立刻用。

### A3. run 一结束编排层就丢——「几十秒后再点」必须另立存放处

`compare.js:721-724`：

```js
.finally(() => {
  signal?.removeEventListener("abort", onSignalAbort);
  runs.delete(runId);
});
```

`runs` Map 在 run 完成的 finally 里**立刻删除**，runner 不保留任何历史。渲染层 `compareReducer` 也只留展示状态（`compare-view.js:119-133`：runId/phase/columns 的文本与用量，**没有会话路径**）。

⇒ 结论：daemon 需要把「runId + columnId → 会话路径」存到 `runs` 之外的地方（compare.js 模块级一个带上限的 Map，或 daemon 装配层自记），并明确失效策略（进程重启即丢是自然边界；是否限量防膨胀由设计定）。

---

## B. 分叉原语的适配

### B4. `materializeBranch` 三入参在对比场景下的实况

`session-files.js:3690-3696`：

```js
async function materializeBranch(motherPath, motherCwd, entryId) {
  const path = entryId === null ? await createEmptySessionFile(motherCwd, motherPath) : await extractBranchFile(motherPath, entryId);
  const title = await branchTitleFor(motherPath);
  await setSessionName(path, title);
  ensureParentSession(path, motherPath);
  return { path, title };
}
```

**`motherPath`**：列的会话文件路径，直接给。

**`motherCwd`：在「有内容」的分叉路径上根本不被使用**。`entryId !== null` 时走 `extractBranchFile` → `createBranchedSessionFile`（`session-files.js:449-454`）：

```js
const temp = SessionManager.open(sourcePath, getSessionsDir());
return temp.createBranchedSession(leafId);
```

`SessionManager.open` 无 cwdOverride，cwd 取自源文件 header。而新 header 的 cwd 字段直接写 `this.cwd`（pi `session-manager.js:1238-1245`：`cwd: this.cwd`）。fallback 路径 `createSessionFileFromPrefix`（`session-files.js:493-501`）同样用 `newSessionHeader(sourceHeader.cwd, sourcePath)`。**两条路径产出的新会话 cwd 都 = 源文件 header.cwd = compare 目录**：

`session-files.js:1687-1689`：

```js
function compareCwd() {
  return join(tempTasksDir(), "compare");
}
```

即 `<生效工作空间根>/临时任务/compare`。

**普通会话的 cwd 怎么决定**：用户在 WorkspacePicker 选工作空间，或未选时首次执行分配时间戳目录（`session-host.js:252` 建宿主时注入 cwd）。**侧栏分组**：`app.js:14004-14040` 的 `groupSessions`——`session.isTempTask === true` 进「任务」区；否则按 `session.cwd` 分组成空间组，组名 = workspace displayName ?? `basename(cwd)`（`app.js:14037`）。

**关键事实：compare 目录不会被 `isTempCwd` 判成任务区**。`session-state.js:755-767`：

```js
function isTaskPrivateCwd(cwd, configDir) {
  const name = basename(cwd);
  return isAutoSessionDirName(name) || name === LEGACY_TEMP_TASKS_DIR_NAME || cwd === join(configDir, "playground") || isWorktreePath(cwd);
}
function isTaskCwd(cwd, configDir) {
  return cwd === "" || isTaskPrivateCwd(cwd, configDir);
}
```

`basename('<root>/临时任务/compare')` 是 `"compare"`——不匹配自动目录名正则 `^\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}$`（`git-worktree.js:93-95`）、不等于字面量「临时任务」、不是 playground、不是 worktree ⇒ `isTempCwd` = **false**。（对比列自己被列表过滤了所以平时暴露不出来；`compare.js:553` 的 `isTempTask: deps.isTempCwd(cwd)` 在这条路径上实际是 false。）

**沿用 compare cwd 的后果**（我的判断依据）：
1. 侧栏会多出一个名为 `compare` 的独立空间组（`groupSessions` 按 cwd 分组、组名取 basename），一个用户从未选择过的「工作空间」。
2. resume 该会话后 `defaultWorkspaceDir` 被它接管：`session-files.js:3556` `defaultWorkspaceDir = defaultCwdAfterResume(nextCwd)`，而 `defaultCwdAfterResume`（`session-files.js:1707-1709`）只对 taskPrivate cwd 归零——compare 目录不归零 ⇒ 之后「新任务」的默认 cwd、WorkspacePicker 的当前项都会指向 compare 目录。
3. 用户在这条会话里继续对话时，工具的 cwd（若普通会话装工具）落在 compare 目录，与「这是我的工作会话」的预期不符。

⇒ 新会话的 cwd **应该显式改写**（见文末结论）。改写的可行先例：`setSessionParentSession`（`session-files.js:456-466`）就是「parse 出 headerLine → 改一个字段 → writeSessionFileLines 整文件重写」的同款手法。

**`entryId`（最后一条消息的 id）**：宿主 dispose 后不能问宿主；对文件现开现读最稳——`SessionManager.open(path, getSessionsDir()).getLeafId()`（pi 同名 API，`session-host.js:537-538` 有既有用法 `this.session.sessionManager.getLeafId()`）。对比列会话是线性树（无分叉），leaf 即最后一条 assistant 消息。不建议用「文件最后一行」猜（行序≠链序，虽然本场景恰好一致）。

### B5. `branchTitleFor` 在对比场景直接产出《（空会话） · 分支》——标题部分不能直接用

`session-files.js:3677-3682`：

```js
async function branchTitleFor(motherPath) {
  const sessions = await listSessions();
  const resolved = resolve(motherPath);
  const motherTitle = sessions.find((session) => resolve(session.path) === resolved)?.title ?? "";
  return buildBranchTitle(motherTitle, sessions.map((session) => session.title));
}
```

`listSessions` 在 3418 行把 compare_run 会话全部过滤（见 B6），**母会话（对比列）不在列表里** ⇒ `motherTitle = ""` ⇒ `buildBranchTitle("", ...)`（`session-files.js:550-560`）取 `EMPTY_TITLE_PLACEHOLDER = "（空会话）"`（546 行）⇒ 标题变成 **《（空会话） · 分支》**。

对比列会话现状没有任何 setSessionName/renameSession 调用（`compare.js` 全文只有 `markCompareRun`），即无标题；若它可见，`deriveSessionTitle`（`session-state.js:973-980`）会取首条用户消息（=对比的问题）截断到 `SESSION_TITLE_MAX = 40` 字。

「标题带模型名与问题摘要」离现状的距离：`materializeBranch` 内部把起标题写死为 `branchTitleFor`，对比场景需要**绕开它、自起标题再 `setSessionName`**（`session-files.js:468-474` 是独立可调的）。材料齐备：daemon 侧有 modelKey（record.states）；问题文本 prompt 在 `start(input)` 入参里（`compare.js:691`），但**record 没存 prompt**——要留下标题摘要需把它一并记进 record。

### B6. 成败判据：分叉**必然**复制 `compare_run` 标记，新会话会被列表与统计双重过滤

这是全功能最重要的一条，链条逐环验证如下。

**环 1：custom 条目是树的真实节点，且在链上。** pi `session-manager.js:901-912`：

```js
appendCustomEntry(customType, data) {
  const entry = { type: "custom", customType, data, id: generateId(this.byId), parentId: this.leafId, ... };
  this._appendEntry(entry);
```

`_appendEntry`（815-820）置 `this.leafId = entry.id`——即 compare_run append 后成为 leaf，**随后的 user 消息挂在它下面**。对比列的条目链因此是：

```
header → compare_run(parentId=null) → user(parentId=compare_run) → assistant(parentId=user)
```

（markCompareRun 的调用时机硬约束「建好宿主后、prompt 前」见 `session-host.js:490-494`，保证它在第一条 user message 之前。）

**环 2：`createBranchedSession` 复制整条祖先链、含 custom。** pi `session-manager.js:1201-1203`：

```js
createBranchedSession(leafId) {
  const previousSessionFile = this.sessionFile;
  const path = this.getBranch(leafId);
```

`getBranch`（1062-1072）从 leaf 沿 parentId 走到根，注释明说 "**Includes all entry types** (messages, compaction, model changes, etc.)"。复制时只有 label（重建）与 compaction（重接 parent）被特殊处理，**custom 条目原样进入新文件**（1231 行 `{ ...entry, parentId: pathParentId }` 的默认分支）。

**环 2b：fallback 路径同样复制。** `sessionPrefixLines`（`session-files.js:399-419`）沿 parentId 链取条目行，`parseSessionFile$1`（352-392）收**所有带 id 的行**（含 custom）⇒ `createSessionFileFromPrefix`（493-501）把 compare_run 行一并写进新文件。

**环 3：带标记 ⇒ 列表与统计双双过滤。** `session-files.js:1363-1413` 的 `readSessionHeadMarkers` 扫文件开头（**遇到第一条 message 就停**，1405 行），看到 `compare_run` 置 `childSession = true`；`isInternalSessionFile`（1415-1419）据此在 `listSessions`（3418 行）里跳过整个文件。统计是**另一处独立过滤**：`readUsageStats` 的全量扫描按 `COMPARE_CUSTOM_TYPE` 置 `isCompare`（695 行），聚合时**整条跳过**（755-765 行注释：「对比会话**整条跳过**（含 token / 花费 / 模型排行）」）。

⇒ **直接用 `materializeBranch` 分叉对比列，产出的是一条永远不可见、不进统计的会话**——侧栏不会出现、用户点完「留下来」等于什么都没发生。实现必须给新文件**摘掉 compare_run 条目**；且因为它是 user 消息的父节点（环 1），剔除时必须把 user 的 parentId 重接到 null，否则链断、恢复时条目丢失。另注意：**在文件末尾追加任何「已保留」标记都无效**——头部扫描遇第一条 message 就停（`session-host.js:492-493` 的注释正是讲的这个性质）。

---

## C. 界面与既有交互

### C7. 对比屏完成态操作条现状

每列正文由 `renderAnswerEntry` 渲染，操作条是 `AssistantActions` 且**只传了 text**（`app.js:68731-68737`）：

```js
/* ... */ jsxRuntimeExports.jsx(AssistantActions, { text: entry.text })
// 注释：操作条只留「复制」……不传 metrics：读数已搬到列头
```

`AssistantActions` 本身**已有** `showBranch` / `onBranch` props（`app.js:31942-31996`），按钮文案「分支出新会话」，title「分支出新会话（从这一轮之前另起一条，母会话不动）」，图标 `IconBranch`——「留下来」可直接复用这套形态。

但 CompareView 的头注明确写着不传它们的理由（`app.js:68531-68532`）：

> 操作条**不传** `onRestart` / `onBranch` —— 本屏的产品承诺是「不进侧栏、不进历史、不计入统计」，一个「分支出新会话」的按钮会把这条承诺当场作废；

以及屏头常驻文案（`app.js:68774`）：`只问答：不跑工具、不动文件、不进历史、不计入统计`。本功能落地**必须同步修订这两处文字**（承诺本身不变——留下的是用户显式选择产生的新会话，但「当场作废」的表述与 hint 文案要改），否则文档与行为打架（本项目纪律：改了行为不改文档等于没有改）。

按钮位置的两个自然候选：列头 `compare-col-head`（`app.js:68864-68871`，已有模型名 + 耗时 + bar-spacer + RunMetricsBar，done 态挂尾部）；或正文尾部的 `AssistantActions` 位置。**「已留过」防重复**：给 `compareReducer` 加一个本地 action（如 `{type:"kept", columnId, path}`）把该列标成已保存态，按钮转禁用/「已保存」；daemon 侧也应防重（同一 runId+columnId 二次调用会真的再分叉出一条重复会话，见结论）。

### C8. 侧栏通知是推式；resumeSession 与「跳过去」的先例

**推式**。daemon：`pushTaskListChanged()`（`session-files.js:1970-1980`）= `listSessions()` 全量 + `post(PUSH.taskListChanged)`；契约注释在 `src/shared/ipc.js:602-614`（「daemon 是列表真相的持有者，变了就推是单向数据流……全量替换与重拉等价但少一次往返」）。渲染层：`window.kami.onTaskListChanged`（`preload/index.js:739`；`app.js:68988` 订阅后直接替换 taskList state）。**不需要渲染层主动拉**——`forkSession` 的既有收尾就是 `pushTaskListChanged()`（`session-files.js:3786`）。

**resumeSession 签名**：preload `resumeSession: (path) => ipcRenderer.invoke(INVOKE.sessionResume, path)`（`preload/index.js:616`）。渲染层包装 `resumeTask`（`app.js:69503-69531`）**返回 promise**，成功后清未读、`setView("chat")`——注释明说这个 promise 就是给「切过去之后再做事」的调用方用的。

**点完要不要跳：两派先例**。
- 资料库「定位到来源会话」=**跳**：按钮（`app.js:67610`，`onLocate(latestSession.path)`）→ `previewLibraryArtifact`（`app.js:69539-69545`）`resumeTask(sessionPath).then(() => {...})`。
- 对话页「分支出新会话」=**不跳**：`branchFromUserMessage`（`app.js:69639-69674`）只 `resyncSnapshot()` + toast，不 setView；但注意 daemon 侧 `forkSession` 其实 `setCurrentBucket(bucket)` 切了 current（`session-files.js:3774-3784`），e2e 也把「当前会话已切到分支上」断言为该功能语义（`tests/e2e/session-branch.mjs:275-287`）。

### C9. 既有「分支出新会话」的文案与确认形态

**无二次确认、无确认弹窗**，一次点击直接调 IPC（`app.js:69646-69652`）；成功 toast：`后续内容已存为分支会话《${branchTitle}》`（`app.js:69660-69663`）；失败 toast `result.message`（69656）。返回形状 `{ ok, branchPath, branchTitle }` / `{ ok:false, message }`（`session-files.js:562-576` 的 `branchOk` / `branchFail`，`FAIL_MESSAGES` 定了 busy/no-file/no-such-entry/write-failed 四种Reason）。「留下来」沿这套口径即可；对比屏内唯一带二次确认的动作是「停止生成」（arm + 窗口内再点，`app.js:68822-68834`），那是因为「一键丢掉 N 列产出」代价大——保留一列是增益型动作，不需要 arm。

---

## D. 测试

### D10. e2e 先例

**最接近「点按钮 → 侧栏出现新会话」的断言**是 `tests/e2e/session-branch.mjs:263-273`（不查 DOM，直接查列表 RPC）：

```js
const r = await win.evaluate(async () => {
  const list = await globalThis.kami.listSessions();
  const arr = Array.isArray(list) ? list : (list?.sessions ?? []);
  return arr.filter((s) => s?.isTempTask !== true && typeof s?.path === "string").map((s) => s.path);
});
assert.ok(r.length >= 2, `分叉后会话数应 ≥2，实际 ${r.length}`);
assert.ok(r.includes(branchRes.branchPath), "会话列表里找不到刚分叉出来的那个文件");
```

（同文件 210-261 还有「等 running 变 false 再分叉，否则 busy」的前置经验，`tests/e2e/session-branch.mjs:211-214` 有注释。）

**资料库「定位到来源会话」那条**（`tests/e2e/library.mjs:332-358`）是「点击后跳进会话」的断言形态：DOM 找按钮（`textContent === "定位到来源会话"`）→ click → `waitUntil` 断言 `[aria-label="消息输入框"]` 出现 + 页面含首条消息文本。且它有一条**实测踩坑注释**（301-306 行）：「定位到来源会话」走 resumeSession，现场会 `createHost`，**没配可用模型会假红**——「留下来」若带跳转同样受此约束。

**对比屏自己的 e2e**（`tests/e2e/multi-model-compare.mjs`）已有 ⑧「对比不进统计、不进侧栏」（675-694 行，`usageStats()` + `listSessions()` 前后相等断言，且带「前提非恒真」的两条辅助断言）。本功能落地后这条要**区分场景**：没点「留下来」时照旧一条不多；点了之后 listSessions **恰好多一条**、且新会话可 resume——后者正好是 B6 成败判据的 e2e 守卫（标记没摘掉时这条必红）。前置设施（四台 mock 模型服务）该文件已备好。

### D11. 单测现状与「不带 compare_run」在哪层测

- **`materializeBranch` / `createBranchedSessionFile` 没有任何单测**（全 tests/ 搜过，仅 e2e `session-branch.mjs` 覆盖行为面）。原因结构性：`session-files.js` 顶层就 `requireParentPort()`，单测无法 import（`tests/unit/library-aggregate.test.mjs:5` 注释原话：「`session-files.js` 在顶层就 requireParentPort() + ……」，因此可测的部分都抽去了纯模块）。
- 现有相关单测：`compare-runner.test.mjs`（用 `deps.createHost` 注入 mock 宿主，毫秒级覆盖编排：80 行起 `createHost: async (options) => { ... }`，mock 出 markCompareRun/prompt/emit/dispose）；`compare-core.test.mjs`（纯归约）；`compare-view.test.mjs` 有一组**契约测试**（74-85 行）——读 `src/shared/ipc.js` 注释里的 kind 清单与 `COMPARE_HANDLED_KINDS` 比对，「谁加了没同步都要红」。
- **「新会话不带 compare_run 标记」最稳的测试层是 e2e**（multi-model-compare.mjs 扩展：点「留下来」→ listSessions 出现新会话；标记没摘时这条红，正好钉死成败判据）。若把「剔除 compare_run + 重接 parentId 链」抽成纯函数（行数组进、行数组出，不碰 fs——抽法先例：`library.js` / `compare.js` 文件头都写了理由），则可在单测层钉死「重接后 user.parentId===null」「链完整」「其他 custom 保留」这些 e2e 说不清的细节。`readSessionHeadMarkers` 的行为（遇第一条 message 停）也可以在纯函数层用真实行序列钉一条。

---

## 结论：做法与风险

### 推荐实现路径

**IPC 形状**：新增一条 invoke `INVOKE.compareKeep`（`"compare:keep"`），入参 `[runId, columnId]`（渲染层两样都有：state.runId 与列的 columnId），返回 `{ ok:true, path, title }` / `{ ok:false, error }`——与 `branchOk`/`branchFail`（`session-files.js:562-576`）同口径。**不要**借道 `PUSH.compareEvent`（那是 daemon→renderer 的列事件流，方向反了；且 kind 清单契约测试会要求两端同步，无谓扩大面）。

**daemon 侧改三处**：
1. `compare.js` `runColumn`：`finally` 里 dispose 之前把 `host.sessionFilePath` 记进 record（`compare.js:637` 前一行最自然）；同时 `start` 时把 prompt 记进 record（起标题要用）；`runs.delete(runId)`（723 行）保持原语义，另设一个模块级、带上限的「最近完成 run 的 runId+columnId → {path, modelKey, prompt}」登记表供 compareKeep 查询。
2. `session-files.js` 新增 `[INVOKE.compareKeep]` handler：查登记表 → `SessionManager.open(path).getLeafId()` 取 entryId → 分叉（`createBranchedSessionFile` 或其变体）→ **剔除 compare_run 条目并重接 parentId**（writeSessionFileLines 整文件重写，手法同 `setSessionParentSession`，`session-files.js:456-466`）→ **改写 header.cwd**（同款手法）→ 自起标题 `setSessionName` → `ensureParentSession(path, motherPath)`（`session-files.js:3684-3688`）→ `pushTaskListChanged()`。对「已 keep 过」的 runId+columnId 返回明确的 `{ok:false}`（防重复分叉出孪生会话）。
3. `branchTitleFor` **不要用于此场景**（B5：会产出《（空会话） · 分支》）。

**渲染层改三处**：
1. `CompareView`：done 列加「留下来」按钮（复用 `AssistantActions` 的 showBranch/onBranch 形态或列头独立按钮），点击 → `window.kami.compareKeep(runId, columnId)`；成功 toast 沿 `后续内容已存为分支会话《…》` 风格，失败 toast error。
2. `compareReducer` 加本地 action 记「该列已留」（不涉及 `COMPARE_HANDLED_KINDS`——那是推送 kind 契约，本地 action 不用它），按钮转「已保存」禁用态。
3. 修订 `app.js:68531-68532` 的头注与 `app.js:68774` 的屏头文案（「不进历史」的承诺表述要写清「显式留下的是新会话」）。

**新会话的 cwd 应该是什么（明确建议）**：**发起对比时用户的当前工作空间**——即 `currentBucket.cwd`（daemon 侧 compareKeep 执行时可直接读），若它为空串（未选工作空间）则回落到 `tempTasksDir()`。理由：(a) compare 目录不是合法工作空间选择，留在 header 里会让侧栏凭空多出名为 `compare` 的空间组（`groupSessions` 按 cwd 分组取 basename，`app.js:14034-14039`）；(b) resume 后 `defaultWorkspaceDir` 会被 compare 目录接管（`session-files.js:3556` + 1707-1709 不归零），污染之后新任务的默认 cwd 与 WorkspacePicker 当前项；(c) 这条会话的价值是「继续对话」，继续对话的 cwd 应该是用户自己的地盘。改写手法现成：parse headerLine → 改 `cwd` 字段 → writeSessionFileLines（`setSessionParentSession` 同款）。**不要**让新 cwd 指向 compare 目录的任何变体。

**标题建议格式**：`{模型展示名} · {问题前 N 字}`（N ≤ 40，沿 `SESSION_TITLE_MAX`），例如 `Claude 4.5 · 怎么写周报`。模型展示名 daemon 侧可从 catalog 解析（渲染层 `describeModel` 同源数据），问题文本来自 record 里存的 prompt。纯问题文本（deriveSessionTitle 现状）在多列留下时无法区分——模型名是这一功能里唯一的区分维度，必须在标题里。

### 三个最容易踩的坑

1. **compare_run 随链复制 → 新会话永不可见**（B6 全链条）。且「在文件末尾补一条 kept 标记」这条路**走不通**——`readSessionHeadMarkers` 遇第一条 message 就停（`session-files.js:1405`），必须从头部剔除条目本身。
2. **剔除 compare_run 必须重接 parentId**。它是 user 消息的父节点（pi `appendCustomEntry` 挂 leaf 下并推进 leaf），只删行不重接会把 user 变孤儿——`getBranch` 走不到根，resume 时整条对话丢失，而且是静默丢。
3. **「点了没反应」的静默失败面**：runner 在 run 结束即 `runs.delete`（A3）——登记表没建，compareKeep 拿不到路径；标题走 `branchTitleFor` 产出《（空会话） · 分支》（B5）；文件落盘要等第一条 assistant（A2）——对 failed/cancelled 列开放 keep 会拿到还没落盘的路径。三者都表现为「点了按钮、什么都没发生」，必须逐一用前置条件挡住（只对 done 列开放 + 登记表命中才受理 + 错误如实返回）。

### 明确不建议做的

- **不要改 `isInternalSessionFile` / `readSessionHeadMarkers` 的判据去「放行」新会话**（比如「parentSession 存在就放行」）——那会同时放行所有对比列（每个对比列文件的 header.parentSession 都未必有，但任何判据放宽都直接作用于「对比不进侧栏」这条产品承诺本身）；正确方向是让新会话**天然不带**标记。
- **不要把对比列宿主注册进 `bucketsById`** 来「复用 forkSession」——`forkSession` 以 bucket 存在为前提（`session-files.js:3761-3762`），而对比宿主不入桶是 `compare.js` 文件头硬要求 6（「对比宿主不在 bucketsById 里……不显式释放就是泄漏」）与事件边界设计（`PUSH.compareEvent` 注释三条理由）的根。
- **不要给「留下来」加二次确认**——既有分支动作就是一次点击 + toast（C9），保留是增益型动作，不构成「一键丢掉产出」级别的风险。
- **不要在 `compareEvent` 通道里加「keep 结果」kind**（方向反了，且会触发 kind 清单契约测试的两端同步要求）。

## Caveats / Not Found

- pi 包源码引的是 `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js`（构建产物，带 JSDoc），行为以它为准；未查上游源仓库。
- `SessionHost.create` 内 `createAgentSession` 是否在 compare_run 之前写别的条目（如 thinking_level_change）未逐行核——不影响「compare_run 在链上」的结论（无论前面有什么，markCompareRun 都在第一条 user message 之前入链）。
- 「登记表」的具体失效策略（只留最近 N 轮 vs 进程生命周期）属设计决策，本报告只给约束（A3）。
