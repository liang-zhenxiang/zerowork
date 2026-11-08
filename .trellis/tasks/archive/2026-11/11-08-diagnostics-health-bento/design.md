# 技术设计：诊断健康评分环 + 首页场景 Bento 卡

## 一、诊断健康评分环

### 数据来源（全部为现有 IPC，不新增后端）

| 分项 | 来源 | 字段 |
| --- | --- | --- |
| 模型可用 | `window.kami.settingsSnapshot()` | `activeModelId`、`models[]`；复用 `judgeModelReadiness()` |
| 内置运行时 | `window.kami.runtimesSnapshot()` | `master`、`runtimes[]`（`enabled`、`status.kind`） |
| 最近任务 | `window.kami.statsSnapshot()` | `runs[]`（`status: ok / running / error`） |
| 全局快捷键 | `window.kami.globalShortcutStatus()` | `{ kind: registered / failed, accelerator }` |

四项并行读取；单项失败只影响该项，其余照常计分。

### 评分规则（每项 0–25）

**模型可用**
- `ready` → 25
- `model-not-usable` → 10（有可用模型，但当前选中的不是它）
- `no-model-at-all` → 0
- 读取失败 → 0 且标记「无法判断」

**内置运行时**
- 总开关关闭 → 10（明确说明这是用户选择，不是故障）
- 否则：`round(25 × ready数 / 启用的运行时数)`；没有启用的运行时 → 25
- 读取失败 → 0 且标记「无法判断」

**最近任务成功率**
- 取 `runs` 中已结束（`status ≠ running`）的前 20 条
- 没有已结束任务 → 25（没有失败可扣，文案「还没有任务记录」）
- 否则 `round(25 × ok数 / 已结束数)`

**全局快捷键**
- `registered` → 25
- `failed` → 0（提示可能被占用）
- 查询失败 → 0 且标记「无法判断」

### 总分与建议

- 总分 = 四项之和（0–100）
- 档位：≥90 状态良好（`--ok`）、≥70 基本可用（`--accent`）、≥50 需要处理（`--warning`）、<50 存在问题（`--danger`）
- 建议取**扣分最多**的一项，输出一句可执行的话；并列时按 模型 → 运行时 → 任务 → 快捷键 的固定顺序，保证可复现
- 全项满分 → 「四项都正常，没有需要处理的项。」
- 有「无法判断」且它是最低分 → 建议改为「无法读取 X，点右上角刷新重试」

### 实现形态

- 新增纯模块 `src/renderer/src/health-score.js`：`computeHealth(input)`、`healthBand(score)`，全部纯函数，可直接单测
- `DiagnosticsView` 顶部新增 `<section className="settings-section health-section">`：
  - 左侧 SVG 环（`role="img"`，`aria-label` 带总分；中心数字 `tabular-nums`）
  - 右侧四行分项：名称 / 状态徽标 / `N / 25`；下方一行建议
  - 加载中显示 `LoadingState`；单项「无法判断」用 `--warning` 文案
- 评分随 `refresh()` 一起刷新（现有 10s 事件驱动刷新不变）

### 可访问性

- 环本身有 `aria-label`，屏幕阅读器不依赖图形
- 分数、分项、建议都是真实文本；颜色只做增强
- 不新增键盘交互，避免与诊断页既有焦点顺序冲突

## 二、首页场景 Bento 卡

### 数据

- 胶囊：`welcome.chips` **全量 8 个**（不再用 `chipsForScene` 过滤）
- 模板：
  - `playbook` 胶囊 → `welcome.cases` 全量按 `chipId` 过滤
  - `scene` 胶囊 → 胶囊自带的 `prompts`
- 现有 `itemsForChip(chip, cases)` 已实现上述分支，只需传入全量 cases
- 当某个胶囊被选中时，下方案例区也按全量 cases 过滤（`casesForChip(allCases, activeChipId)`），保证跨场景点击有内容

### 布局

- 保留 `.capability-row` 作为外层容器（`gui-smoke` 的垂直节奏断言依赖它的 24px 底边距）
- 内部新增 `.bento-grid`（4 列）+ `.bento-card`：
  - 第 1–2 张、第 7–8 张各跨 2 列；第 3–6 张各占 1 列 → `[2,2] [1,1,1,1] [2,2]`
  - `< 900px`：2 列，全部不跨列；`< 640px`：1 列
- 卡片内容：图标（18）、名称（14/600）、描述（12，`--text-faint` 两行截断）、右下模板数
- 选中态沿用 `.capability-chip.active` 的语义色，新增 `.bento-card.active`
- 样式追加到 `app.css` 末尾新段落，用 token；不改既有规则

### 交互

- 卡片仍是 `<button>`，`aria-haspopup="menu"` / `aria-expanded`
- 点击调用现有 `toggleChip(chip)`，下钻面板与 `pickChipItem` 完全复用
- 跨场景卡不切换场景，面板直接给出该胶囊的模板

## 三、测试

### 单元

- `tests/unit/health-score.test.mjs`：
  - 满分 / 各单项扣分 / 未知态 / 并列取建议 / 总分边界
  - 运行时比例与「无已结束任务」口径

### GUI（新增 `tests/e2e/gui-health-bento.mjs`，接入 `test:gui` 链）

- 首页：`.bento-card` 数量 = 8；默认场景下点 code 场景的「日常开发」→ 面板出现提示词
- 首页：`.capability-row` 的 `margin-bottom` 仍为 24px（防回归）
- 诊断：打开后环存在、`aria-label` 与四行分数之和一致；四行都有状态文本；建议非空
- 干净配置下模型项应为扣分，建议文本包含「模型」
- 浅色 / 暗色截图各一张

### 验证命令

```bash
npm run lint:all
npm test -- tests/unit/health-score.test.mjs
npm run build
npm run test:gui:health-bento
npm run test:gui:smoke          # 垂直节奏断言
npm run check:unicode
```

## 四、风险与取舍

- **上线首帧**：`welcome` 未到时 Bento 不渲染（沿用现有 `chips.length > 0` 条件），不会出现空网格
- **诊断页数据慢**：四项分别有独立错误态；任一读取失败不会让整页崩
- **评分「太严厉」**：干净配置（没配模型、运行时未装）会得到低分，这是**如实**的；
  建议文案必须给出下一步，而不是只显示红环
- **不新增后端探测**：数据目录可写等更深的健康项不在本次范围（Issue 的验收只要求可扫读与可行动）

## 五、回滚

纯渲染层改动 + 一个新纯模块；`git revert` 即可。不涉及数据迁移、不改 preferences 结构。
