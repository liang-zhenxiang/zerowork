# 技术设计:「值守」—— 任务级边界与交差报告

对应 `prd.md`。分层、契约、数据流、权衡与回滚。

## 1. 模块边界

```
src/main/daemon/watch-policy.js          新增·纯逻辑(不 import Electron,可被单测直接 import)
  ├ WATCH_LIMITS                         硬边界常量(导出,供单测钉住)
  ├ parseWatchPolicy(raw)                校验并规范化一条规矩;非法值抛错(响亮)
  ├ effectivePolicy(watch, globalTier)   ★只能更严的收敛:返回 {tier, scope, minutes, notes[]}
  ├ evaluateWatchBoundary(intent, policy) 判一次工具调用是否越界 → {allowed, rule, reason}
  └ summarizeRun(run)                     把一条运行记录收成结论文案(供界面直接用)
src/main/daemon/automation.js            parseTask 放行可选 watch 字段(向后兼容)
src/main/daemon/session-files.js         buildRunExtensions 接边界判定;
                                          AutomationScheduler.execute 加时限与中止;
                                          appendRun 调用点补 boundary
src/shared/ipc.js + src/preload/index.js 不新开通道(见 §3)
src/renderer/src/watch-policy-core.js    新增·纯逻辑(文案、结论一句话、老记录兜底)
src/renderer/src/app.js + app.css        规矩编辑区 + 可展开的交差报告
tests/unit/watch-policy.test.mjs         边界求值与收敛
tests/unit/watch-policy-core.test.mjs    文案与兜底
tests/e2e/watch-policy.mjs               端到端(真实启动 + 截图)
```

## 2. 数据形状与硬边界

### 2.1 规矩(`task.watch`,可选)

```js
watch: {
  minutes?: number,        // 1..WATCH_MAX_MINUTES(120);正整数
  tier?: "read-only" | "workspace-write" | "follow",   // 缺省 "follow"
  scope?: string[],        // 工作区内的相对子路径;缺省 = 整个工作目录
  stopOnExceed?: boolean   // 缺省 true = 越界即停整轮;false = 只拒这一次调用
}
```

> **`stopOnExceed` 的语义由 `watch-policy.js` 的 `onExceedAction` 唯一回答**
> （`false` → `"block"`，其余 → `"abort"`；见 `prd.md:2` 与 §3.3）。
> 界面文案与执行层都读它，**不允许哪一层自己再判一次** —— 两份判定必然漂移。
>
> ⚠️ 实现期发现：这个字段一度被 `parseWatchPolicy` 接受、被 `effectivePolicy`
> 原样带出，却**没有任何一处消费**（开关是摆设）。已修，并补了
> `tests/unit/watch-policy.test.mjs` 的第五条 describe 钉住语义。

| 常量 | 值 | 为什么是这个数 |
| --- | --- | --- |
| `WATCH_MAX_MINUTES` | 120 | 定时任务的上限先写死;超过两小时的无人值守本身就值得重新想 |
| `WATCH_MAX_SCOPE` | 16 | 可写范围最多 16 条 —— 再多应该去调工作区,不是列清单 |
| `WATCH_MAX_SCOPE_LEN` | 200 | 单条路径长度上限(与项目常驻指令同族量级) |

> **时限缺省的真值**:不设 `minutes` 时**不是不限时**,而是落到产品既有的
> 30 分钟内置保护(`RUN_TIMEOUT_MS`,见 `session-files.js`)。此处曾写作
> 「不填 = 不限时(与今天一致)」,与真实行为不符,已在 `prd.md` 与本文件改正。

> **不新增存储**:`watch` 跟着任务记录走,落在既有的 `automations.json` 里。
> 不需要新文件、不需要新的加载顺序 —— 这是 `AGENTS.md`「不引入新的存储」的直接应用。

### 2.2 运行记录的 `boundary`(只增字段)

```js
boundary: {
  exceeded: Array<{ at: number, tool: string, detail: string }>,  // 上限 20 条
  timedOut: boolean,
  readOnlyEnforced: boolean,   // 规矩确实比全局严、且真的生效了
  scoped: string[],            // 这次实际生效的可写范围(空数组 = 整个工作目录)
  notes: string[]              // 「规矩不生效」这类告警,如实留存
}
```

**向后兼容是本层的硬要求**:老运行记录**没有** `boundary` 字段。
`summarizeRun` 对它返回 `{ known: false, headline: "这条运行早于『值守』功能…" }`,
界面照常渲染这一行,只是报告区说一句实话 —— **不编一个空的 boundary 出来**
(编出来会让用户以为「这次运行有边界、只是没用上」)。

## 3. 契约

### 3.1 不新开 IPC 通道(关键决定)

规矩**本来就是任务的一部分**:读任务列表就已经把 `watch` 读回来了,
写任务就是保存 `watch`。新开 `automation:watch-*` 通道会让「任务」这个概念
在两个通道之间有**两份真相**,并制造出「改了规矩但没改任务」这种不可能状态。

所以本轮**零新增通道**,只做两件事:

1. `automation:list` 的返回**自然带着** `watch`(它与任务同源)
2. `automation:list` 的每条任务的 `runs[]` 里**自然带着** `boundary`

`src/shared/ipc.js` 与 `src/preload/index.js` 因此**不需要新增常量** ——
这既降低了「两张手工同步的表忘记改一张」的风险(spec/guides §二.1),
也让本轮的红线风险面更小。

### 3.2 「只能更严」的收敛(本功能的核心不变量)

```js
// watch-policy.js
const TIER_RANK = { "read-only": 0, "workspace-write": 1, "danger-full-access": 2 };

function effectivePolicy(watch, globalTier) {
  // 1. tier:取两者中更严的那个;规矩比全局宽时收严并记一条 note
  // 2. scope:全局不是可写档时,scope 无从生效 → scoped 为空、note 说明
  // 3. minutes:与全局无关,永远生效(它收紧的是「跑多久」)
}
```

**这条函数是三层里唯一做判定的一处**,界面层与执行层都调它 ——
不各写一份判定(两份判定的漂移正是「参数被接受却不生效」的温床)。

三条必须成立的断言(进单测,且是**可证伪**的):

| 输入 | 断言 |
| --- | --- |
| `watch.tier="workspace-write"`,全局 `read-only` | 结果 tier 是 `read-only`,且 `notes` 含「不会放宽」字样 |
| `watch.tier="workspace-write"`,全局 `danger-full-access` | 结果 tier 是 `workspace-write`(收严生效) |
| `watch` 缺省,全局 `workspace-write` | 结果与今天的行为**逐字段相同**(回归保护) |

### 3.3 边界求值

`evaluateWatchBoundary(intent, policy)` 的 `intent` 由 run 会话的工具层构造:

```js
{ tool: "write"|"edit"|"powershell"|..., kind: "read"|"write", path?: string }
```

判定顺序(**先判能力,再判范围**):

1. `kind === "read"` → 一律放行(只读不越任何界)
2. `policy.tier === "read-only"` → 拒绝,rule = `"tier"`
3. `policy.scoped.length > 0` 且 `path` 不在范围内 → 拒绝,rule = `"scope"`
4. 工作区之外 → 拒绝,rule = `"outside"`(即使 scope 为空)

**拒绝的理由必须带规矩原文**(如「本任务的『可写范围』只含 `reports/`,
`data/x.csv` 不在其中」),因为这条理由会**回给模型**,模型据此换路子 ——
这与 `unattended` 既有的「拒绝并把原因回给模型」同一条纪律。

### 3.4 与 `unattended` 的关系(不变量)

**`unattended` 的既有语义一个字都不改**:审批类操作仍然一律自动拒绝。

本功能插在它**之前**:`evaluateWatchBoundary` 先跑,它**只会拒绝得更多**,
永远不会把一次本该拒绝的调用变成放行。这是红线 4 在代码上的形状 ——
**新增的判定只能是合取项,不能是析取项**。

`buildRunExtensions` 的接线点:

```js
// 在 createPermissionGate 之前包一层,只做「额外拒绝」
createWatchBoundary({ policy, onExceed })   // 新增 extension
createPermissionGate({ /* ...原样不动... */ })
```

### 3.5 时限与中止

`AutomationScheduler.execute` 里:

```js
const timer = policy.minutes === undefined ? undefined
  : setTimeout(() => controller.abort("watch-timeout"), policy.minutes * 60_000);
try { outcome = await this.options.execute(task, { signal: controller.signal }); }
finally { clearTimeout(timer); }
```

- 中止**复用既有的 abort 通道**(不新开),只新增一个**中止原因** `watch-timeout`
- 被中止的运行 `boundary.timedOut = true`,且 `success: false` ——
  但**报告里的结论是「到 N 分钟被叫停」,不是「失败」**(两者对用户的含义不同)
- `AbortController` 由 scheduler 持有,`runNow` 的手动运行**同样受限时约束**
  (手动跑也是无人值守的,一视同仁)

## 4. 渲染层

- 纯逻辑抽到 `src/renderer/src/watch-policy-core.js`:
  - `boundaryHeadline(run)` —— 报告结论一句话(五态:跑完 / 越过界 / 超时 / 没跑起来 / 早于本功能)
  - `boundaryNoteText(note)` —— 收敛告警的中文措辞
  - `exceedLine(item)` —— 越界证人一行的措辞
  - `nextStepFor(error)` —— 「下一步怎么办」的引导(照 `classifyFailure` 的思路)
  全部可被 vitest 直接 import
- 规矩编辑区收进既有编辑面板;**只用既有 token**;
- 运行记录行的可展开报告:默认折叠,展开后是**一个内容卡级盒子**(遵守 `docs/DESIGN.md`
  §3.9 的盒子预算:一屏最多一个内容卡级主盒)
- **新动画需登记** `docs/DESIGN.md` §10.3 与 §10.3.1 的关停清单

## 5. 错误与降级(如实说,不装好)

| 情形 | 表现 |
| --- | --- |
| `watch` 字段缺失 / 老任务 | 按「今天的行为」跑,报告里说「这个任务没有设置值守规矩」 |
| 老运行记录没有 `boundary` | 报告如实说「这条运行早于『值守』功能」,**不编空对象** |
| `watch` 字段值非法(如 `minutes: -1`) | `parseTask` **抛错**(与既有 `parseTask` 同款响亮),不静默修正 |
| 规矩比全局宽 | 收严 + 界面**明说**不会放宽;不静默 |
| `scope` 里有工作区外的路径 | 校验期就拒绝保存(给原因),不留到运行期才发现 |
| 越界次数超 20 条 | 报告里说「另有 N 次未逐条列出」,**不静默截断** |

## 6. 测试计划

| 层 | 文件 | 覆盖 |
| --- | --- | --- |
| 单元 | `tests/unit/watch-policy.test.mjs` | 三档收敛(含「只能更严」的三条断言)、缺省回归、边界求值四条判定顺序、scope 通配、工作区外、非法值抛错、`summarizeRun` 五态 |
| 单元 | `tests/unit/watch-policy-core.test.mjs` | 结论文案五态、收敛告警措辞、越界行措辞、老记录兜底 |
| e2e | `tests/e2e/watch-policy.mjs` | 真实启动 → 建带规矩的任务 → 手动触发 → 运行报告出现 → 越界证人可见 → 浅色截图 + 暗色一张 |
| 静态 | `tests/e2e/gui-sections.mjs` | 自动化分区覆盖新面板 |
| 静态 | `scripts/check-daemon-graph.mjs` | 新增模块后 import 图不成环 |

反向验证(必须真跑并留下记录):

1. 把 `effectivePolicy` 的收敛改成「取更宽的那个」→
   「只能更严」的三条断言变红,e2e 的告警断言变红,其余不受影响
2. 注掉越界时的 `onExceed` 上报 → 越界证人相关的单测与 e2e 变红

## 7. 未采纳的方案(写进 `docs/ARCHITECTURE.md` 决策表)

| 方案 | 为什么否掉 |
| --- | --- |
| 做成全局「策略中心」 | 用户真正要区分的是「这一个任务」;全局配置无法表达「跑周报的那个只准读」 |
| 允许规矩放宽全局档位 | 直接违反红线 4。放宽是安全敏感变更,不应由一个任务的可选字段触发 |
| 新开 `automation:watch-*` 通道 | 规矩本就是任务的一部分,分开会制造两份真相与「改了规矩没改任务」的不可能状态 |
| 越界即**静默跳过**该次调用 | 静默跳过比拒绝更危险:模型以为做了,报告里也看不出来 |
| 越界即**整个任务失败退出** | 越界一次不等于整个任务失败;让模型换个路子继续是更合理的默认,所以是**记证人 + 拒绝该次调用** |
| 时限用「超时算失败」 | 「被叫停」与「跑失败了」对用户的含义不同 —— 前者可能是成功的,只是没跑完;两者必须可辨 |
| 把边界判定下放到提示词 | daemon 侧的判定必须独立于模型(spec/daemon §二)。模型无法通过「说这是安全的」绕过它 |
