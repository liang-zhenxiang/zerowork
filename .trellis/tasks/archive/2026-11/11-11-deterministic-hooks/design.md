# 技术设计：确定性 hooks（MVP：PreToolUse / PostToolUse）

> 集成点以 `research/integration-map.md` 为准（含行号）。本文只定契约与取舍。

## 一、模块与依赖

新增 `src/main/daemon/hooks.js`，**不 import electron**，由三部分组成：

```js
parseHookConfig(raw)        // 校验/规范化单份配置；非法抛带原因的错误
mergeHookSources(user, ws)  // 合并；返回 {hooks, errors}
matchTool(matcher, toolName)// 精确 / * / 前缀 name*
decide(exitCode, timedOut, spawnError) // allow | deny | fail
runHooks(hooks, payload, deps) // 顺序执行；注入 spawn 便于单测
payloadForPreToolUse(...) / payloadForPostToolUse(...)
```

`deps.spawn` 默认 `node:child_process.spawn`；单测注入假 runner，不依赖 bash / PowerShell。

## 二、配置

### 形状

```json
{
  "version": 1,
  "hooks": [
    { "id": "h-…", "event": "PreToolUse", "matcher": "write*",
      "command": "node check.js", "timeoutMs": 5000 }
  ]
}
```

### 来源与合并

| 来源 | 位置 | 是否默认生效 |
| --- | --- | --- |
| 用户级 | `preferences.hooks`（读侧白名单必须加） | 是 |
| 工作区级 | `<cwd>/.zerowork/hooks.json` | **否，需显式信任** |

- 信任按**绝对路径**记在 `preferences.trustedWorkspaceHooks: string[]`（规范化后比较）
- 执行顺序：用户级 → 工作区级（任一 `deny` 即停，报第一个拒绝）
- 「用户级不能放宽工作区级」由「所有 hook 都跑 + deny 终局」结构性保证
- 未信任：工作区文件不执行，写一条 `hook` 审计 outcome=`skipped`，设置页可见
- **配置损坏 fail-closed**：用户级或「已信任的工作区」配置非法时，PreToolUse 直接拒绝，
  错误里写明文件与原因（与「宁可拒绝，不静默降级」一致）
- 没有命中 hook 时**不 spawn 任何进程**（空配置零成本）

## 三、执行语义

- 命令按平台起 shell：`win32 → cmd.exe /d /s /c`，其余 → `/bin/sh -lc`
- stdin：JSON 载荷；stdout/stderr 各截断到 8KB 存入返回值（审计 detail 另截 240 字）
- 超时：默认 5000ms，范围 1000–30000；超时 `SIGKILL`，视为 fail
- 退出码：`0` allow；`2` deny（stderr 为原因）；其他 = fail
- **fail 与 deny 对 PreToolUse 都是「阻止」**：deny 文案用 stderr，fail 文案写明
  超时/启动失败/退出码，不能静默跳过
- PostToolUse 的 fail/deny 只写审计，不改变工具结果

### 载荷（不含密钥）

```json
{ "event": "PreToolUse", "tool": { "name": "write", "input": { … } },
  "session": { "id": "…", "cwd": "…" }, "timestamp": 1790000000000 }
```

PostToolUse 追加 `{ "ok": true|false, "error": "…" }`。

## 四、接入点（三处装配点都要）

1. **主会话**：`session-files.js` 主会话 extensions 数组**最前面**插入
   `createHooksExtension(...)`，位于 `createPermissionGate` 之前（pi 按注册顺序执行，
   第一个 `{block:true}` 终止）
2. **定时任务**：同文件自动化会话的两处 extensions
3. **子代理 / 团队成员**：`command-exec.js` 的成员装配点

扩展同时注册：

- `tool_call` → PreToolUse（可阻断）
- `tool_result` → PostToolUse（只审计；被拦下的不触发）

会话 id / cwd 由装配点传入；配置在扩展创建时读取并按会话缓存（设置改动对新会话生效，
在 UI 文案里说明）。

## 五、审计

- `audit.js` 新增类别 `hook`（与现有 `command/sandbox/runtime/audit/file` 并列）
- outcome：`allowed` / `blocked` / `failed` / `skipped`
- 字段：`event`、`hookId`、`tool`、`durationMs`、`exitCode?`、`detail`（≤240）
- **两份手工副本都要改**：daemon `audit.js` 的类别表 + renderer 审计中心的类别筛选
- 完整 stdout/stderr 只在「试运行」里展示，审计不承载全文

## 六、IPC 与设置页

- `hooks:get` → `{ user: Hook[], workspace: { path, exists, trusted, hooks, error? } }`
- `hooks:set-user` → 校验并落 preferences，返回规范化结果
- `hooks:set-trusted` → `(cwd, boolean)`，写 `trustedWorkspaceHooks`
- `hooks:test` → `(hook, samplePayload)` 跑一次，返回 `{exitCode, stdout, stderr, durationMs}`
- 设置页放在「通用」里 `PermissionSection` 之后（没有「安全」一级导航）：
  - 用户级：列表 + 新增/编辑/删除（删除二次确认）+ 试运行
  - 工作区级：路径、是否存在、信任开关、只读列表；未信任时写明「不会执行」
  - 交互照抄 `StarterTemplatesSection` 的列表/内联编辑/二次确认
- 样式追加 §45，只用 token

## 七、安全

- 用户级 hooks 是用户显式配置的本机代码；工作区 hooks **默认不执行**，克隆即执行不成立
- PreToolUse 在权限门前；拒绝终局；失败也阻止
- 审计记录 hook 运行与跳过，但不记录完整命令输出
- `SECURITY.md` 增加「Hooks」威胁模型段：谁能写、何时执行、如何关闭、审计在哪
- 红线 4：PR 里写明影响面（新增本地代码执行入口）与默认安全姿态

## 八、测试

### 单元（`tests/unit/hooks.test.mjs`）

- matcher：精确 / `*` / `prefix*` / 不匹配
- 配置校验：缺字段、非法事件、超时越界、命令为空
- 合并：用户 + 工作区；任一 deny 终局；未信任只跑用户级
- 决策：0 / 2 / 其他 / 超时 / spawn error
- 注入假 runner：顺序、短路、stdout/stderr 截断；无命中不 spawn

### daemon 集成（`tests/e2e/hooks-block.mjs`）

- mock 模型发一个 `write` 工具调用
- 用户级 hook：`PreToolUse` + `write*` + 一个 `node` 脚本（读 stdin，exit 2，stderr 文案）
- 断言：工具结果是被拒绝的、目标文件没写、审计里有 outcome=blocked
- 同一套再用 exit 1 验证 fail-closed；无 hook 时工具正常执行

### GUI（`tests/e2e/gui-hooks.mjs`）

- 设置页出现 Hooks 分组；新增一条用户级 hook；点「试运行」看到退出码与输出
- 工作区卡片：未信任时显示「不会执行」，打开信任后状态变化
- 浅色 / 暗色截图各一张

## 九、风险与取舍

- **跨平台引用**：命令由用户填写，测试用 `node <fixture>` 避免 shell 方言
- **长会话开销**：仅当命中 hook 才 spawn；PostToolUse 默认不配置
- **配置热更新**：v1 按会话缓存，设置页注明「对新会话生效」
- **truncation**：detail 240 字，试运行看全文

## 十、安全复核后的补充决策（2026-11-12）

### 工作区根的优先级（含 worktree）

`chooseWorkspaceRoot` 是**唯一**的根判定（`src/main/daemon/hooks.js`）：

1. **worktree → 源仓库的 `sourceCwd`**。worktree 路径每次都是新的
   （`<配置目录>/worktrees/<仓库名>/<分支 id>`），按绝对路径信任永远命中不了；
   若回退到「生效工作区根」，还会出现两个错误：源仓库上已信任的规则静默不生效
   （fail-open），以及另一个已信任工作区的规则被套到无关项目上。
2. **临时任务 / 自动会话目录 → 生效工作区根**。
3. **普通会话 → cwd**。

`sourceCwd` 的来源：
- 创建时 `createWorktree(...)` 直接返回；
- resume 时 `worktreeInfoFromCwd(cwd)` 读 worktree 的 `.git`（内容是
  `gitdir: <源仓库>/.git/worktrees/<id>`）反推源仓库；读不到则不抛错、回退旧行为。

**三处装配点必须用同一个 root**：主会话把 `hooksRootFor(cwd, bucket.worktree)`
放进子代理 / 团队成员的派生请求（`hooksRoot`），`buildSubagentExtensions`
只消费传入的 root（`deps.hooksFor?.(cwd, hooksRoot)`），不自行按 worktree cwd 猜。
否则会出现「主会话更严、委派更松」的旁路。定时任务没有 worktree 上下文，
按 `task.cwd` 走同一优先级。

### `hooks:test` 只接受已保存 hook 的 id

试运行是「立即让 daemon 起子进程」的通道，不能成为执行任意命令的第二入口。
契约收紧为 `testHook(id)`：

- daemon 用 `resolveSavedHook(readHooksConfig().config, input)` 从**用户级已保存配置**
  里取命令；传入对象时只读 `id`，`command` / `event` 等字段一律忽略；
- 未知 id 直接拒绝（不回退到「按传入内容执行」）；
- 试运行仍写一条 `hook` 审计（`allowed` / `failed`），detail 只写 id、判定、
  耗时与退出码，**不写命令原文**；
- UI 的「试运行」本来就只出现在已保存行上，交互不变。

### 配置读取时机（准确说法）

- 主会话：在扩展创建（`createHost`）时读一次；
- 子代理 / 团队成员 / 定时任务：在**派生时**读一次。

因此设置页文案是「对新创建的会话与之后派生的子代理生效」，不是「仅新会话」；
已创建的会话沿用创建时的规则。
