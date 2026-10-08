# 把对比满意的那一列收进会话（「留为会话」）

> 事实依据见 `research/prereq.md`（逐条 `file:line`）；视觉规范见 `research/design-spec.md`。
> 本文件只保留**结论、范围与验收标准**。

## Goal

对比屏上，每列的**完成态**给一个「**留为会话**」动作：点了之后，那一列的问答变成一条
**普通会话**——出现在侧栏、可以继续对话、标题带模型名与问题摘要。

对比屏「不进历史、不计入统计」的承诺**不变**：留下的是用户显式选择产生的**新会话**，
对比列本身依旧即弃。`docs/USAGE.md` 里「想留下成一条会话，现在还没有直接入口」那句从此作废。

## 背景：已核实的事实（全部来自 `research/prereq.md`）

### 事实 1：分叉原语现成，但**直接用会把新会话也藏起来**

- `materializeBranch`（`session-files.js:3690`）= 分叉到 entryId + 起标题 + 记 parentSession
- **但** `createBranchedSession` 会**连着 `compare_run` 标记一起复制**（prereq §B6 全链条核实）
  —— 新会话会被 `readSessionHeadMarkers`（`session-files.js:1405`）与统计聚合**双重过滤**，
  用户点完什么也看不到
- **且**「在文件末尾补一条 kept 标记来放行」这条路走不通：头部扫描遇第一条 message 就停
- **且** `compare_run` 是第一条 user 消息的**父节点**——只删那一行不重接 parentId，
  user 变孤儿，resume 时整条对话**静默丢失**

→ 必须：**从头部剔除 `compare_run` 条目并重接 parentId**（整文件重写，手法同
`setSessionParentSession`，`session-files.js:456-466`）。

### 事实 2：新会话的 cwd 不能是 compare 目录，否则两处污染

- 侧栏按 cwd 分组取 basename（`app.js:14034-14039`）→ 会凭空多出名为 `compare` 的空间组
- resume 后 `defaultWorkspaceDir` 被 compare 目录接管（`session-files.js:3556` + `1707-1709` 不归零）
  → 污染之后新任务的默认 cwd 与 WorkspacePicker 当前项

→ 新会话的 cwd = **发起对比时用户的当前工作空间**（`currentBucket.cwd`；为空回落 `tempTasksDir()`）。

### 事实 3：标题不能走 `branchTitleFor`

它会给《（空会话） · 分支》（prereq §B5）。要自起：**`{模型展示名} · {问题前 N 字}`**
（N ≤ 40，沿 `SESSION_TITLE_MAX`）。模型名是这一功能里唯一的区分维度——多列都留下时，
纯问题文本无法区分。

### 事实 4：runner 在 run 结束即丢（prereq §A3）

`runs.delete(runId)`（`compare.js:723`）——「几十秒后再点」必须另立一个**带上限**的登记表
（runId+columnId → 会话文件路径 / modelKey / prompt）。路径在 `finally` dispose **之前**取
（`host.sessionFilePath` 是现成 getter，prereq §A1）。

## Requirements

### R1 daemon：一条新 IPC `compare:keep`

- 入参 `[runId, columnId]`，返回 `{ ok:true, path, title } | { ok:false, error }`
  （与 `branchOk`/`branchFail` 同口径；**不借道 `PUSH.compareEvent`**，方向反了）
- 步骤：查登记表 → 取 leafId → 分叉 → **剔除 `compare_run` 并重接 parentId** →
  **改写 header.cwd** → 起标题（事实 3 的格式）→ 记 parentSession → `pushTaskListChanged()`
- **防重复**：同一 runId+columnId 只留一次，第二次返回明确的 `{ok:false, error}` 说明
- **只对 done 列受理**（登记表只记到达终态的列；failed/cancelled 列的文件可能还没落盘，
  prereq §A2）——不成立时如实报错，不静默

### R2 渲染层

- 每列**完成态**的操作行加「留为会话」按钮（槽位与形态照 `research/design-spec.md`）
- 保存中 / 已留（`.mini-btn.saved` disabled + 「已留为会话」）/ 失败（toast 带 daemon 真实原因）
- 已留的列给「去这条会话 →」跳转键
- **离开对比屏 = 状态重置**（已留标记不例外，prereq §D5）——这是既有行为，不新增持久化
- 同步修订 USAGE 与对比屏头注里「不进历史」的表述（写清「显式留下的是新会话」）

### R3 默认路径零影响

- 不改 `isInternalSessionFile` / `readSessionHeadMarkers` 的判据去「放行」任何东西
  （那会直接作用于「对比不进侧栏」这条产品承诺）
- 不把对比宿主注册进 `bucketsById`
- 不改 `branchTitleFor` / `materializeBranch` 本身（新逻辑放 compare 这一条链上）

## Acceptance Criteria

### 功能

- [ ] 真实启动：两列对比跑完 → 点某一列「留为会话」→ toast 出现 →
      **侧栏出现一条新会话**，标题形如 `{模型名} · {问题摘要}`
- [ ] 点「去这条会话 →」→ 进入那条会话，**能看到这轮问答**（用户的问题 + 该列的回答），
      并能**继续对话**（发一条消息能收到回复）
- [ ] 同一列再点一次 → 明确报「已留过」，**不产生孪生会话**
- [ ] 新会话**出现在侧栏、计入统计**（它是普通会话）；其余对比列**仍然不出现**
- [ ] 侧栏**不出现**名为 `compare` 的工作空间组
- [ ] failed / cancelled 列没有「留为会话」按钮

### 工程

- [ ] 单测：登记表的命中/上限/防重复、标题格式（含超长截断与模型名解析失败回落）、
      剔除 `compare_run` 后的文件**头部可读且 parentId 重接**（这条是核心，必须有）
- [ ] e2e（真实启动 + 截图）：留为会话 → 侧栏出现 → 跳进去能看到问答 → 再点被拒 →
      浅深两套截图；**反向验证**至少两条
- [ ] `npm run lint:all`、`npm test`、`npm run test:gui` 全绿，既有用例一条不少
- [ ] 新用例挂进 `test:gui` 链条；U+FFFD 扫描 OK
- [ ] `CHANGELOG.md` / `docs/USAGE.md` 同步

## 约束

- 不引入依赖；不改 `resources/**`；不放宽任何权限
- 界面只用既有 token 与既有类，不新增档位 / 动画 / 布局过渡例外
- 不为 lint 通过而重排 `app.js` / `app.css`

## 明确不做

| 项 | 理由 |
| --- | --- |
| 二次确认 | 既有分支动作就是一次点击 + toast；保留是增益动作，不构成「一键丢产出」级风险 |
| 「留多列」批量操作 | 一列一点，语义清晰；批量会把「哪条留了」变模糊 |
| 留下的会话与对比列建立双向关联 | parentSession 已记录来源，够用 |
| 对比屏记住「上次留过哪列」 | 离屏即重置是既有口径 |