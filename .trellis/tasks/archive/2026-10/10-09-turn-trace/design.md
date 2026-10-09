# 技术设计：工作轨迹（Turn Trace）

## 1. 边界与数据流

**纯渲染层特性，零主进程 / IPC / ledger 改动。**

```
conversation.entries（既有）
  └─ buildTurnViews(entries)（app.js:30768，既有，已在 useMemo 内）
       └─ 新增：trace: buildTurnTrace(content2)   ← trace-core.js 纯函数
            └─ <TurnTraceBar trace={view.trace} onFocusEntry={...} />
                 渲染于 turn-group 内、TurnHeader 之后、plan.items 之前
```

- `content2` 是该回合的全部 entry（user 之后到下一个 user 之前），与
  `buildFoldPlan(content2, state)` 同源——**轨迹与折叠计划看同一份数据**，
  不会出现「轨迹有、正文没有」的分歧。
- live 生长免费获得：entries 流式追加 → useMemo 重算 → 新节点出现。
- 不把 entries 塞进 view（保持 view 轻量），只挂聚合结果。

## 2. trace-core.js（新模块，纯函数）

```js
// 输入：turn 的 entries 数组（元素含 role/toolName/outcome/change/label/summary…）
// 输出：
{
  empty: boolean,          // 无工具动作 → 调用方不渲染
  segments: [{
    kind,                  // read|write|command|search|deliver|subagent|other
    label,                 // 类别中文名（读/写/命令/检索/交付/子代理/其他）
    count,                 // 相邻同类合并后的调用数
    entryIds,              // 该段全部 entry id（定位用，保序）
    status,                // "ok" | "bad" | "running"
                            //   bad = 段内含 error/blocked
                            //   running = 段内最后一个 outcome === undefined
    title,                 // 原生 tooltip 文本：每条调用的 label+summary 摘要
  }],
  totals: { calls, bad }   // 调用总数 / 失败数（aria 摘要用）
}
```

### 分类表（toolName → kind）

| kind | label | toolName（normalize 后） |
| --- | --- | --- |
| read | 读 | `read` |
| write | 写 | `write` `edit` |
| command | 命令 | `bash` `powershell` |
| search | 检索 | `web_search` `grep` `glob` `fetch`（实现时按真实工具名核对） |
| deliver | 交付 | entry.role === `"artifacts_presented"`（present_files 的产物事件） |
| subagent | 子代理 | `task` `team_*` 前缀 |
| other | 其他 | 其余全部（含 todo_write、show_widget、MCP `mcp__*`、问卷…） |

设计约束：

- **相邻同类才合并**（`读 读 写 读` → `读×2 / 写 / 读` 两段读），保序；
  乱序合并会毁掉「按发生顺序排列」的叙事。
- 分类表是**数据不是逻辑**：表驱动，新增工具只改表；未知工具落到 other，
  tooltip 仍显示其真实 label/summary——宁可信息糙，不静默丢。
- `todo_write` / `show_widget` 本轮归 other（它们是「表达」不是「动作」，
  单独开类的依据留给真实使用反馈）。

## 3. 渲染与交互（app.js）

### 3.1 组件

`TurnTraceBar`（放在 ToolEntry 组件附近定义）：

- 根 `nav.turn-trace`（`aria-label="本轮工作轨迹"`）+ 段按钮 `.trace-seg`。
- 段内容：类别图标（复用 `toolIconOf` 映射，按 kind 取代表工具名）+ label +
  `×N`（count>1）；`status === "bad"` 时加 IconAlert 与状态色（形态+文字并存，
  遵守 DESIGN.md §7.6「不看颜色也读得出」）；`status === "running"` 用既有
  `text-shimmer` 微光，段尾追加省略样式。
- 段间连接：`.trace-seg + .trace-seg::before` 画短横线连接符；容器
  `flex-wrap: wrap`——长回合换行可接受，横向滚动不可接受（滚动套滚动）。
- 不出场：`trace.empty` 时不渲染任何 DOM（纯文本回合零变化）。

### 3.2 点击定位（onFocusEntry）

在 Conversation 组件作用域实现（能拿到 foldOpen / turnFolds 状态与 setter）：

1. 在 `view.plan.items` 里找包含目标 entryId 的 item：
   - `tool-group` / `process-fold` → `toggleFold(item.id)` 展开该组；
   - `turn-folded` 且该回合折叠 → `toggleTurn(turnId)`；
2. `requestAnimationFrame` 后 `stream` 容器内 `querySelector('[data-entry-id="…"]')`
   → `scrollIntoView({ block: "center", behavior: "smooth" })` + 加 `.entry-flash`
   类（一次性动画，animationend 移除）。
3. ToolEntry 根节点补 `data-entry-id={card.id}`（定位锚点，无样式含义）。

### 3.3 无障碍与键盘

- 段是 `<button>`，天然可 Tab / Enter；`title` 提供段内逐条摘要。
- 根节点 `aria-label`；段 `aria-label="读，2 次调用"`（计数读得出）。

## 4. 样式（app.css）

- 新类：`.turn-trace` `.trace-seg`（+ `ok|bad|running` 修饰）`.trace-seg-x`
  `.trace-conn` `.entry-flash`。
- **全 token**：颜色 / 间距 / 圆角 / 字号 / 时长全部走 `:root` 既有档，
  暗色块同步覆盖（check-theme-tokens 守护）。分类色**不引入**（§2.4：
  分类不是状态，不许借状态色；段默认中性，仅 bad/running 表状态）。
- hover / active 四态齐（active 叠 `scale(.98)`，与 chip 同档）。
- `.entry-flash` 是 animation（非交互触发的动画）——按 DESIGN.md §10.3
  登记（时长用既有档；实现时先读 §10.3 确认登记格式）。

## 5. 取舍与风险

| 决策 | 理由 | 风险与对策 |
| --- | --- | --- |
| 轨迹条在折叠态也渲染 | 折叠正是「只要全貌」的时刻，这是本功能的灵魂 | 与 turn-folded 隐藏正文不冲突（轨迹在 items 之前，不受 fold 影响） |
| 相邻合并且不跨段合并 | 保序叙事；跨段合并会让点击定位语义含糊 | 段数上限可控（典型回合 ≤ 8 段）；wrap 兜底 |
| present_files 用 artifacts_presented 事件计数 | 它是唯一可靠的「交付」信号，与资料库同源 | 该 entry 渲染为 null（正文不显示），轨迹里出现正好补位 |
| 不加设置开关 | 先看反馈；YAGNI | 若反馈噪音，后续加 preferences 项（有 palette-memory 先例） |
| 不记录每步耗时 | entries 无每步 startedAt/endedAt（只有回合级 timings）；伪造数据违反「可诊断」原则 | 每步耗时需要主进程改数——超出本轮「纯渲染层」边界，不做 |

已知嵌入风险（都来自往 68k 行渲染流里插东西）：

1. **流式滚动锚定**：turn-group 多一个子节点理论上影响 `anchor-space` 布局——
   轨迹条不参与锚定计算（不在 anchors/plan 里），高度固定一行起，风险低；
   e2e 用流式中的截图断言兜底。
2. **TurnNav / jump-to-bottom**：与轨迹无交集（它们按 turn-group 定位）。
3. **对比视图（compare-view）**：注释明说「每列只渲染助手正文，不渲染
   TurnHeader」——轨迹同样**不进对比列**（对比的承诺：只问答、不动工具）。

## 6. 兼容与回滚

- 纯增量：不改任何既有 DOM 结构（除 ToolEntry 加 data-entry-id）。
  `trace.empty` 分支保证纯文本回合字节级不变。
- 回滚 = revert 单个提交；无数据迁移、无存储格式变化。

## 7. 测试设计

- **单元**（`tests/unit/trace-core.test.mjs`）：分类表命中 / 前缀匹配 /
  相邻合并与不跨段 / bad 聚合 / running 判定 / empty / 未知工具落 other /
  artifacts_presented 计数 / entryIds 保序 / title 生成。
- **e2e**（`tests/e2e/turn-trace.mjs`，harness 骨架）：mock 模型脚本——
  第 1 轮 tool_calls：read（预置文件）+ write；第 2 轮：bash（macOS 上受限档
  被拒 → blocked 段，天然拿到 bad 节点）；第 3 轮最终文本。断言：
  1. 轨迹条存在、段数/类别/计数正确；
  2. bad 段存在且带 ⚠；
  3. 点击段 → 目标工具行进入视口 + flash 类出现；
  4. 折叠回合过程后轨迹仍在、正文隐藏；
  5. 浅 / 深截图 + 像素断言（h.shoot 契约）。
- 全量：`npm run lint:all`（含 check-theme-tokens / renderer-assets）、
  `npm test`、`npm run test:gui`。
