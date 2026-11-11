# PRD：确定性 hooks（生命周期脚本与可阻断的工具门）

- Issue：#368
- 分支：`feat/deterministic-hooks`
- 日期：2026-11-11

## 背景

模型的指令是概率性的。本项目已有审计日志、权限阶梯与沙箱，但用户无法**确定性地**扩展边界：
提示词里写「不要外发未脱敏数据」，模型仍可能照做；要加一条「写文件前先跑格式检查」只能等我们发版。

竞品调研（`.trellis/tasks/archive/2026-11/10-16-competitive-landscape-research` GAP #2）：
Claude Code 约 35 个生命周期事件、Cursor 约 30 个。核心价值不是「再给模型一段提示」，
而是「某些动作**总是**发生」。

## 期望（MVP）

### 配置

- 工作区 `.zerowork/hooks.json`（随项目走）+ 用户级配置合并
- 合并规则：**用户级不能放宽工作区级**（同一次工具调用里，任一来源拒绝即拒绝）
- **工作区 hooks 默认不执行**：克隆一个仓库不等于执行它带的脚本。用户需在设置里
  显式「信任此工作区的 hooks」（按绝对路径记住）；未信任时文件被忽略且有可见说明，
  不静默执行。用户级 hooks 始终生效
- 单条 hook：`{ event, matcher?, command, timeoutMs? }`
  - `matcher`：工具名精确匹配、`*`（全部）或前缀 `name*`；不引入完整正则（避免 ReDoS 与非法正则边界）
  - `timeoutMs`：默认 5000，范围 1000–30000

### 事件（MVP 两个）

| 事件 | 触发点 | 可阻断 |
| --- | --- | --- |
| `PreToolUse` | 工具调用**之前、权限检查之前**；主会话 / 定时任务 / 子代理三处装配点都装 | 是（终局） |
| `PostToolUse` | 工具调用真正执行完之后（被 PreToolUse 拦下的不触发） | 否（只审计） |

> `SessionStart` / `UserPromptSubmit` / `Stop` 延后到后续 Issue：它们不阻断，
> 且每个会话/每条消息/每轮都起子进程有固定开销；先把「能拦住、能审计、
> 能试运行」的闭环做扎实。

### 执行语义

- hook 是子进程（`bash -lc` / `cmd /c`，按平台），stdin 收到 JSON 载荷，stdout/stderr 收进审计
- 退出码：`0` 放行；`2` 拒绝（stderr 作为原因）；其他非零 = 失败
- **启动失败 / 超时 / 非 0/2 退出：工具调用失败**（不再执行），除非该事件不可阻断
- `PreToolUse` 拒绝：写 `hook` 审计（outcome=blocked；工具名、hook、原因、耗时），返回可诊断错误
- 同一事件的多个 hook 按配置顺序执行；任一拒绝即停

### UI

- 设置 → 安全（或通用）新增「Hooks」分组：列表 + 新增/编辑/删除
- 展示事件、matcher、命令、超时；「试运行」弹窗显示载荷 JSON、退出码、stdout/stderr
- 运行失败在列表行内标红并给原因；不静默

### 审计

- 每次运行写一条 `audit` 记录：事件、hook id、耗时、退出码、是否拒绝
- 拒绝单独标记，可在审计中心按类别筛到

## 验收

- [ ] 工作区 + 用户级配置合并，且用户级不能放宽工作区级
- [ ] `PreToolUse` 在权限检查之前触发；主会话 / 定时任务 / 子代理三处都生效
- [ ] `PostToolUse` 只在工具真正执行后触发，只写审计、不改变结果
- [ ] 拒绝（exit 2）终止工具调用并留下 `hook` 审计（outcome=blocked）
- [ ] 启动失败 / 超时 / 非 0-2 退出同样终止（fail-closed），不静默跳过
- [ ] 工作区 hooks 未信任时不执行，且界面/审计能看出它被跳过
- [ ] 设置页可编辑与试运行；试运行展示载荷与输出
- [ ] 单测（匹配/决策/超时/合并）、daemon 集成测试、GUI 设置页测试与截图
- [ ] `lint:all`、`npm test`、全量 `npm run test:gui` 通过
- [ ] CHANGELOG `[Unreleased]`「安全」或「新增」；`SECURITY.md` 威胁模型同步

## 不在本轮

- `agent` 型 / `file` 型 hook；`SessionStart` / `UserPromptSubmit` / `Stop` 三个事件；hook 分享市场
- 跨平台 UI 自动化级别的屏幕捕获（另议）

## 硬约束

- 零新依赖；daemon 不 import electron
- 安全敏感（红线 4）：PR 必须说明放宽/收紧的影响面，并同步 `SECURITY.md`
- 不为了「看起来能用」而在沙箱不可用时静默放行
