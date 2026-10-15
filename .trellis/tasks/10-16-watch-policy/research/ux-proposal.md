# 视觉方案：「值守」—— 任务级边界与交差报告

> 任务：10-16-watch-policy | 状态：待评审
> 依据：`prd.md`（需求与边界，权威）、`design.md`（数据契约与已有决定）、
> `docs/DESIGN.md`（硬约束）、`app.css` 现状（`.auto-*` / `.field` / `.preset-item` /
> `.skill-chip` / `.mcp-switch` / `.state-*` / `.mini-btn` / `.auto-form-card`）与
> `app.js` 既有实现（`AutomationsView` / `AutomationRow` / `AutomationForm` /
> `FileHistoryView` / `PermissionSection`）。
> 本文中的「§」除特别注明外，均指 `docs/DESIGN.md`。

---

## 0. 一句话定位

**规矩编辑区不新开页面、不新开盒子**：它是既有 `AutomationForm` 弹层里
**紧跟「工作目录」之后的一个 `.field` 分组**；**运行报告是既有 `.auto-run-row` 的
就地可展开体**，展开后是一块**内框**（不是内容卡）。

全案的核心不是版式，是**一句话的设计立场**：

> **「只能更严」不是一条提示，是一个禁用态。** 用户碰不到的选项不会让他误会；
> 能碰到、但选完当场被折算回原值的选项才会。所以本方案把「比全局更宽」的三项
> **直接禁掉**（`.preset-item:disabled` / `.num-chip` 禁用），并在**同一位置**
> 用一行「实际会怎么执行」把折算结果说死 —— **禁用是主通道，告警是兜底**。

零新增间距 / 字号 / 颜色 / 圆角 / 阴影 / 时长档位，**零新增动画**（§10.3 无登记，
§10.3.1 关停清单不动）。

---

## 1. 规矩编辑区：布局与既有模式的复用

### 1.1 位置：`AutomationForm` 内，「工作目录」之后

`app.js:69050` 附近的 `AutomationForm` 现在是 6 个 `.field` 顺序排列：
名称 → 任务内容 → 调度 → （调度细项）→ 工作目录 → [error] → `.save-space-actions`。

值守规矩插在 **「工作目录」与 `error !== undefined && <ErrorState>` 之间**，整块包在
**一个 `.field`** 里（`app.js:69044` 那段工作目录的写法逐字照抄）：

```
名称            (.field)
任务内容        (.field)
调度            (.field)
（调度细项）    (.field ×N)
工作目录        (.field)
── 值守规矩 ──  (.field)   ← 新增，一个 .field 承载整组
[error]         ErrorState
[取消] [保存]   .save-space-actions
```

**为什么是一个 `.field` 而不是四个**：`.auto-form-card` 的 `gap` 是 `--space-4`(12)
（`app.css:10130`），是**表单项之间**的距离；规矩的四个声明是**同一件事的四个面**，
它们之间只该有 `--space-3`(8) —— `.field` 自身的 `gap: var(--space-1)`(4) 又太紧。
所以用一个 `.field` 收口，内部按 `.auto-toggle-row` 的 `gap: var(--space-2)`(6) 到
`--space-3`(8) 排。**这是既有的「分组变了间距要跟着分」（§3.8 推论）的直接应用**：
四个声明与外层字段不是一个分组。

### 1.2 四个声明各自的控件（全部复用既有类，无新造）

| 声明 | 控件 | 复用的既有模式 | 位置 |
| --- | --- | --- | --- |
| **时限** | `.num-chip` ×4（30 / 60 / 120 / 不限）+ `.field input[type="number"]` | `.num-chips` 容器（`app.css:8064`）；自定义分钟值走 1.3 的「自定义」chip | 第 1 行 |
| **能力** | `.preset-item` ×3（单选列表） | `PermissionSection` 的 `PERMISSION_PRESETS` 列表（`app.js:63177`）逐字同款 | 第 2 行 |
| **可写范围** | `.skill-chip`（可删）+ `.field input[type="text"]` | 输入卡已选技能条的 `.skill-chip` / `.skill-chip-remove`（`app.css:3218`、`app.css:3175`） | 第 3 行 |
| **越界即停** | `.mcp-switch` | 原生 checkbox + 轨道的开关（`app.css:10256`），`app.js:63232` 同款写法 | 第 4 行 |

#### 逐字 JSX 结构（照 `app.js` 既有写法）

```jsx
{/* 值守规矩：任务三要素之下的可选一组。不填 = 今天的行为，一个字都不变。 */}
<div className="field">
  <span className="field-label">值守规矩</span>
  <span className="field-hint">这些规矩只对定时运行生效，且只能比全局档位更严。不填就是今天的行为。</span>

  {/* ① 时限 */}
  <div className="field">
    <span className="field-label">时限</span>
    <div className="num-chips">
      {WATCH_MINUTE_CHIPS.map(({ value, label }) => (
        <button
          key={label}
          type="button"
          className={draft.watchMinutes === value ? "num-chip active" : "num-chip"}
          aria-pressed={draft.watchMinutes === value}
          onClick={() => patch({ watchMinutes: value })}
        >{label}</button>
      ))}
    </div>
    {/* 自定义档才出现的数字输入，与「间隔分钟数」(auto-interval) 同一写法 */}
    {customMinutes && (
      <input
        id="auto-watch-minutes"
        type="number" min={1} max={WATCH_MAX_MINUTES} step={1}
        value={draft.watchMinutes}
        onChange={(e) => patch({ watchMinutes: e.target.value })}
      />
    )}
    <span className="field-hint">{watchMinutesHint(draft.watchMinutes)}</span>
  </div>

  {/* ② 能力 —— 单选列表，逐字照 PermissionSection 的 preset-item */}
  <div className="field">
    <span className="field-label">能力</span>
    <div className="preset-list">
      {WATCH_TIER_ITEMS.map((item) => (
        <button
          key={item.id}
          type="button"
          className={`preset-item${draft.watchTier === item.id ? " active" : ""}`}
          disabled={item.widens}
          title={item.widens ? item.disabledReason : undefined}
          onClick={() => patch({ watchTier: item.id })}
        >
          <span className={`preset-dot${draft.watchTier === item.id ? " on" : ""}`} />
          <span className="preset-text">
            <span className="preset-label">{item.label}</span>
            <span className="preset-desc">{item.description}</span>
          </span>
          {item.widens && <span className="auto-badge">不生效</span>}
        </button>
      ))}
    </div>
    {/* ★「实际会怎么执行」—— 见 §2。仅当选择与全局收敛后才出现 */}
    <p className={effectiveDiffers ? "watch-effective watch-effective-narrowed"
                                     : "watch-effective"}>
      {effectiveLine}
    </p>
  </div>

  {/* ③ 可写范围 */}
  <div className="field">
    <span className="field-label" htmlFor="auto-watch-scope">可写范围</span>
    <div className="skill-chips">
      {draft.watchScope.map((p) => (
        <span className="skill-chip" key={p}>
          <span className="skill-chip-name" title={p}>{p}</span>
          <button
            type="button" className="skill-chip-remove"
            aria-label={`移除 ${p}`}
            onClick={() => patch({ watchScope: draft.watchScope.filter((x) => x !== p) })}
          >×</button>
        </span>
      ))}
    </div>
    <input
      id="auto-watch-scope" type="text"
      value={draft.scopeInput}
      placeholder="reports/"
      onChange={(e) => patch({ scopeInput: e.target.value })}
      onKeyDown={(e) => { if (e.key === "Enter") addScope(); }}
    />
    <span className="field-hint">留空 = 整个工作目录。按回车加一条，最多 16 条。</span>
    {scopeError && <span className="field-error" role="alert">{scopeError}</span>}
  </div>

  {/* ④ 越界即停 */}
  <div className="auto-toggle-row">
    <div className="watch-switch-text">
      <span className="field-label">越界即停</span>
      <span className="field-hint">碰到上面任何一条规矩就当场停下，这次运行记成「被叫停」。</span>
    </div>
    <label className="mcp-switch" title={draft.stopOnExceed ? "点击关闭" : "点击开启"}>
      <input
        type="checkbox"
        checked={draft.stopOnExceed}
        aria-label="越界即停"
        onChange={(e) => patch({ stopOnExceed: e.currentTarget.checked })}
      />
      <span className="mcp-switch-track"><span className="mcp-switch-thumb" /></span>
    </label>
  </div>
</div>
```

> **`stopOnExceed` 的开关语义要诚实**：契约里它是「越界即停」，但
> `design.md:2.2` 的判定是「拒绝该次调用 + 记证人」，**不是**中止整个 run。
> 所以副行文案**不许写「停下整个任务」**，只能写「停下这一次调用、这次运行记成被叫停」。
> 这一点写进 `watch-policy-core.js` 的常量，别在 JSX 里临时措辞。

### 1.3 文案（逐字）

| 位置 | 文案 |
| --- | --- |
| 组标题 | `值守规矩` |
| 组说明 | `这些规矩只对定时运行生效，且只能比全局档位更严。不填就是今天的行为。` |
| 时限 chip | `30 分钟` / `1 小时` / `2 小时` / `自定义` |
| 时限 hint（未设） | `不设时限时，运行到 30 分钟会被自动叫停（产品内置保护）。` |
| 时限 hint（已设） | `到 45 分钟时会被叫停；被叫停不算失败，报告里会写明。` |
| 能力 label | `能力` |
| 可写范围 label | `可写范围` |
| 可写范围 hint | `留空 = 整个工作目录。按回车加一条，最多 16 条。` |
| 越界即停 label | `越界即停` |
| 越界即停 hint | `碰到上面任何一条规矩就当场停下，这次运行记成「被叫停」。` |

> **时限 hint 的第一句是本案的必写项**：`design.md:2.1` 写「不填 = 不限时（与今天一致）」，
> 而 `app.js` 里今天**就有一条 30 分钟的内置保护**（任务书 A 段原文：「Absent = the
> product's built-in 30-minute guard」）。两者冲突时**以真实行为为准**（「如实说，不装好」），
> 文案必须写出这条 30 分钟，否则用户会以为不填就真的无限跑。
> 这一条与 §2 的收敛告警同源：**界面上任何一句关于「实际会怎样」的话，都必须来自
> `watch-policy-core.js` 的同一份判定**，不许 JSX 里另写一句。

---

## 2. 「只能更严」怎么变得可读 —— 本方案的核心

### 2.1 三个候选，和为什么选第三个

| 方案 | 做法 | 判断 |
| --- | --- | --- |
| A. 只给告警 | 四个选项都能点，选了「可写」后在下面出一行「不会放宽」 | **否**。用户已经点完了、心智上已经认为自己选了「可写」；告警是**事后更正**，而误会在点击那一刻就已经成立 |
| B. 只禁用 | 全局只读时把「可写」置灰 | **不够**。禁用不解释**为什么**，用户看到灰掉的「可写」只会以为界面坏了；而且直接禁掉后他**永远看不到**「我选的这个为什么不生效」这句关键信息 |
| **C. 禁用 + 就地折算说明（本方案）** | 禁用**是主通道**，同一位置再用一行「实际会怎么执行」把折算结果说死 | **选它** |

选 C 的理由是一条可检验的判据：

> **误会的成本高于困惑的成本。** 一个用户点「可写」而实际跑成只读，代价是他在
> 半夜让一个任务白跑、第二天回来才发现什么都没写；一个用户看到「可写」灰着、
> 下面写清楚「全局是只读档」，代价只是多读一行字。**本题要防的是前者**。

C 同时满足 §7.6（状态不只靠颜色）：禁用态由 **`disabled` + 副行文字 + 「不生效」徽标**
三路各自独立表达，颜色只是补充。

### 2.2 具体形态

**第一层：禁用。** 全局档位是「只读」时，「可写」与「跟随全局」之外的**更宽项**禁用。

`WATCH_TIER_ITEMS` 的构造是纯逻辑（进 `watch-policy-core.js`，可被 vitest 直测）：

```js
// 服务端只给三档中的「比全局更严或相等」的子集；follow 永远可用。
const TIER_RANK = { "read-only": 0, "workspace-write": 1, "danger-full-access": 2 };
// item.widens === true  →  disabled + 「不生效」徽标
```

- 全局 `read-only`：`只读` 可选、`跟随全局` 可选；**`可写` 禁用**（`widens: true`）
- 全局 `workspace-write`：`只读` / `跟随全局` 可选；**`可写` 可选**（它此刻不放宽，
  `danger-full-access` 也不出现在列表里）
- 全局 `danger-full-access`：三档**全部可选** —— 此时「跟随全局」意思是完全访问，
  但规矩选「只读」也合法，所以「跟随全局」的副行要如实写出它此刻等于什么

**第二层：就地折算说明（`.watch-effective` 一行）。** 紧贴列表下方，**只在
「选择 ≠ 实际生效」时才出现**：

```jsx
{effectiveDiffers && (
  <p className="watch-effective watch-effective-narrowed" role="status">{effectiveLine}</p>
)}
```

文案由 `watch-policy-core.js` 的 `effectiveLineText({ picked, effective, globalTier })` 产出，
**从 daemon 的 `notes[]` 原样翻译**（不许渲染层另判一遍，`design.md:3.2「两份判定的漂移
正是『参数被接受却不生效』的温床」`）。四条文案逐字：

| 情形 | 文案 |
| --- | --- |
| 规矩比全局宽，被收严 | `实际按「只读」执行 —— 全局档位是「只读」，本任务的「可写」不会放宽它。要真正可写，请先到「设置 → 权限」把全局档位改成「默认权限」。` |
| 规矩比全局宽，且已有 scope | `实际按「只读」执行 —— 全局档位是「只读」，本任务的「可写」与「可写范围」都不会放宽它。可写范围已保留，但本次运行不会写任何文件。` |
| 规矩与全局相等 | `实际按「可写」执行 —— 与本任务的声明一致。` |
| 规矩未设 | `实际按全局档位「只读」执行。` |
| 全局是 `danger-full-access` 而选了跟随 | `实际按「完全访问」执行 —— 这是全局档位，本任务没有收严它。` |

> 第一、二条里那句 **「要真正可写，请先到『设置 → 权限』」是必写的**：
> PRD 的「错误要可诊断」要求给出逃生指引；只说「不会放宽」是一个死胡同，
> 用户下一步不知道该干什么。这也是本条区别于普通告警的地方 —— 它给的是**出路**。

**第三层：视觉。** `.watch-effective` 用**一条既有色阶内的强调线**：

```css
/* 「实际会怎么执行」：禁用把选择挡在门外，这一行负责把「为什么」和「下一步」
   说清楚。它不是错误（没有东西坏了），所以**不用 --danger**；但它是本组里
   唯一必须读到的一句，所以给左轨 + 次文色之上的底气，靠**形态**（1px 左轨）
   而不是靠色相（§2.4 状态色只表状态、§7.6 状态不只靠颜色）。 */
.watch-effective {
	margin: 0;
	padding-left: var(--space-3);
	border-left: 2px solid var(--border);
	font-size: var(--text-meta);
	color: var(--text);
	line-height: 1.6;
}

/* 收严那一档才把左轨染上强调色：这条线是「这里发生过一次折算」。 */
.watch-effective-narrowed {
	border-left-color: var(--accent);
}
```

§3.4 的教训直接适用：这一行承担「**为什么这次运行不会写文件**」，
它是**必须读得出的那一句**，所以底色走 `--text`（不是 `--text-secondary`），
并且**不加任何 opacity 淡出**。

### 2.3 被禁用项上的「不生效」徽标

复用 `.auto-badge`（`app.css:9994`：`--bg-raised` 底 + `--text-secondary` 字，
中立、非状态色）：

```jsx
{item.widens && <span className="auto-badge">不生效</span>}
```

**为什么不禁用后就不管**：`disabled` 的 `preset-item` 有 `opacity: 0.55`
（`app.css:7874`），而 §3.4 明确「淡出是补充通道，不是替代」。徽标是**文字通道**，
保证「为什么不生效」在**不依赖透明度**的情况下也读得出来（§7.6）。

---

## 3. 可写范围编辑器

### 3.1 已选路径 = `.skill-chip` 可删胶囊

逐字复用输入卡「已选技能条」的 `.skill-chip` + `.skill-chip-remove`
（`app.css:3218`、`app.css:3175`），含那条**已经踩过坑的 hover 浮现规则**：

```css
.skill-chip:hover .skill-chip-remove,
.skill-chip:focus-within .skill-chip-remove { opacity: 1; }
```

`.skill-chip-remove` 已经是 `opacity: 0` + **`focus-within` 回补**（§7.9 的正确形态：
键盘 Tab 到删除钮时必须看得见）。**这一处不改一行 CSS，直接复用**。

已选的路径**必须常显**（不能 hover 才显示路径名）—— 因为「这个任务能写哪里」是
安全信息，用户扫一眼就要看到。所以 `.skill-chip-name` 显示路径原文，
`title` 挂全路径防省略号截断。

### 3.2 输入 = 回车加一条

一个 `.field input[type="text"]`（既有 `.field input[type="text"]` 档位，
`app.css:7952`），`placeholder="reports/"`。
- `Enter` → 校验并加入（校验见 3.4），成功后**清空输入框并把焦点留在框内**，可连续输入
- 输入框为空时按 `Enter` **不做事**（不报错 —— 空提交不是错误，是没提交）
- 输入框内为空时，右侧不渲染任何按钮；有内容时**不新增按钮**，
  靠 `Enter` 提交（本项目输入卡的发消息也是 `Enter` 语义，一致）

### 3.3 「空 = 整个工作目录」怎么读

**必须是一条视频级可见的说明 + 一个可见的「当前生效值」，不能只靠 placeholder。**

- 输入框下方 `.field-hint`：`留空 = 整个工作目录。按回车加一条，最多 16 条。`
- 当 `draft.watchScope.length === 0` 时，**胶囊区不显示「（空）」占位**，
  而在 3.2 的 hint 前面**多出一句**（同一 `<span>`，不新增元素）：

  > `现在没有限制：这次运行能写整个工作目录里的任何文件。按回车加一条，把它收窄到你放心的目录。`

  这条在**已有内容的任何一种情形下都不出现**，避免读成噪音。

**为什么不做成「空态胶囊」**：`design.md` 里「空数组 = 整个工作区」是一个**危险默认**
（安全语义上「没限制」不等于「没有配置」）。给它一块安静的区域会让人误以为
「这块还没填、所以不会有写入」，而事实**恰恰相反**。所以这里用的是**主动的句子**，
不是留白。这与 §4「数据到达前不得显示『无数据』类文案」是同一个精神：
**空不等于无**。

### 3.4 非法 / 越界路径：parser 抛错，界面不许吞

`watch-policy.js` 的 `parseWatchPolicy` 对越界路径**抛错**（`design.md:5`：
「校验期就拒绝保存（给原因），不留到运行期才发现」）。渲染层的处理是
**就地、当场、带原因**的三段式：

1. **输入框下方立刻出 `.field-error`**（既有类，`app.css:7975`，
   `color: var(--danger)` + `--text-meta`），`role="alert"`：

   | 触发 | 文案 |
   | --- | --- |
   | 路径向上逃逸 | `「../secrets」跑到了工作目录外面，这里只能填工作目录**之内**的相对路径。` |
   | 绝对路径 | `请填相对路径（如 reports/），不要从盘符或 / 开始。` |
   | 超过 16 条 | `最多 16 条。要覆盖更多目录，请直接调整任务的工作目录。` |
   | 单条超过 200 字 | `单条路径不能超过 200 个字符。` |
   | 重复 | 不报错，静默去重（重复不是错误，是没说完） |

2. **该条不进入胶囊列表**（不留一个「看起来加进去了」的坏值）。
3. **保存按钮保持可用**，但 `save()` 里再跑一次同样的校验 ——
   错误就地显示在 `ErrorState`（`app.js:69060` 那段既有写法）并**中止保存**。

**关键纪律：错误文案来自 `watch-policy.js` 抛出的 message，渲染层不做二次判断。**
`watch-policy-core.js` 只做「把 message 转成用户语」这一件事；转不了的时候
**原样透出 message**（宁可糙，不静默 —— 与 `trace-core.js` 未知工具落 `other` 同款）。

### 3.5 三态（§4）

可写范围是**用户当场输入的列表**，不是拉取的数据源，所以它**没有「加载中」态**。
按 §4 的判据严格对应：

| 态 | 判据 | 表现 |
| --- | --- | --- |
| 加载中 | **不适用**（同 §4 的首页上手清单：结构固定，非列表） | —— |
| 真空 | `watchScope.length === 0` | 3.3 的那句主动说明，**不是** `EmptyState` |
| 错误 | 校验失败 | 3.4 的 `.field-error` + `role="alert"` |

> **明确不写 `EmptyState`**：`EmptyState` 是一个**居中的大留白块**
> （`.state-empty` 有 `padding: var(--space-5) var(--space-4)` + 居中，
> `app.css:1158`），塞进一个 `.field` 里会把表单撑开一道沟。
> 「空 = 整个工作目录」是一句**行内说明**，不是一个空状态页。这是对 §4 的
> **正确应用**而非规避 —— §4 约束的是「三态不可混为一谈」，不是「必须有三个态」。

---

## 4. 运行报告：`.auto-run-row` 的就地展开

### 4.1 信息层级：结论一行常显，细节默认折叠

`AutomationRow` 现在把每条 run 渲染成 `.auto-run-row`（`app.js:68870`）。
本方案**不改行的骨架**，只做两件事：

1. **常显的那一格文案换成 `boundaryHeadline(run)`** —— 逐字照既有
   `{run.success ? "成功" : "失败"}` 的位置，仍是 `.auto-run-badge`，
   只把「成功 / 失败」升级成五态里的一态；
2. **当 `run.boundary` 存在时**，把 `.auto-run-row` 从 `<button>` 改成
   `<div class="auto-run-row auto-run-expandable">` + 一个内嵌的
   `<button class="auto-run-toggle">`（照 `.auto-row-expand` 的 chevron 语言），
   展开后在行**下方**渲染报告体。

> **为什么行本身不再是 `<button>`**：既有行点整行跳会话（`onOpenRun`）。
> 报告展开后行内会多出「越界证人」列表，整行可点会让「想选文字复制工具名」
> 变成跳走。所以展开行改成**行尾一个「看报告」按钮**做折叠开关，
> 跳会话仍走行首的一句话（`title="打开本次运行的会话"`，照抄既有语义）。

### 4.2 五态文案（逐字，全部由 `watch-policy-core.js` 的 `boundaryHeadline(run)` 产出）

`design.md:2.2` 的 `summarizeRun` 返回 `{known, state, exceededCount}`，
`state ∈ ok / exceeded / timedOut / failed / unknown`。五态一一对应：

| `state` | `.auto-run-badge` 类名 | 徽标文案 | 报告体首行（`.watch-report-head`） |
| --- | --- | --- | --- |
| `ok` | `ok` | `没越界` | `跑完了，一次都没越界。` |
| `exceeded` | `bad` | `越界 2 次` | `跑完了，但越了 2 次界 —— 下面逐条列出。` |
| `timedOut` | `bad` | `被叫停` | `到 45 分钟被叫停 —— 这不是失败，是到点收工。` |
| `failed` | `bad` | `没跑起来` | `这次没跑起来 — {error 的人话解释}` |
| `unknown` | **不加 `ok` / `bad`** | `无记录` | `这条运行早于「值守」功能，没有边界记录。` |

> **`timedOut` 的徽标必须是 `被叫停` 而不是 `失败`**（`design.md:3.5`：
> 「『被叫停』与『跑失败了』对用户的含义不同 —— 前者可能是成功的，只是没跑完；
> 两者必须可辨」）。注意 daemon 侧 `success: false` 仍然成立，所以徽标的红底
> 由 `.auto-run-badge.bad` 提供 —— **但文字是「被叫停」**。这正是 §7.6 要的：
> 颜色说「这不是正常完成」，文字说「为什么」。

**`ok` 态绝不能长得像错误。** `没越界` 走 `.auto-run-badge.ok`
（`--ok` 的 12% 混色底，`app.css:10107`），报告体首行那句
**`跑完了，一次都没越界。`** 里的「一次都没」是刻意写的 ——
它把「零」说成**一件完成的事**，而不是一个空的计数位。
报告体**不出现**「暂无越界记录」这类句式（那是错误态的语感）。

### 4.3 报告体：一块内框，不是内容卡

展开后是一块**内框**（`.auto-runs` 内部），遵守 §3.9 的盒子预算 ——
**它没有边框、底色走 `--bg-raised`**（§3.7：「次级辅助面走 `--bg-raised`，
这类面一律不带边框：边框是内容卡的身份，次级面靠底色区分」）：

```jsx
<div className="watch-report">
  <p className="watch-report-head">{headline}</p>
  <ul className="watch-report-lines">
    <li>运行时长 12 分 04 秒 · 到 45 分钟会被叫停</li>
    <li>实际权限：只读 · 可写范围：整个工作目录</li>
    {notes.map((n, i) => <li key={i} className="watch-report-note">{boundaryNoteText(n)}</li>)}
  </ul>
  {exceeded.length > 0 && (
    <>
      <p className="watch-report-sub">越界证人</p>
      <ul className="watch-report-exceed">
        {exceeded.map((item, i) => (
          <li key={i}>
            <span className="watch-exceed-time">{formatExceedTime(item.at)}</span>
            <span className="watch-exceed-tool">{item.tool}</span>
            <span className="watch-exceed-detail">{item.detail}</span>
          </li>
        ))}
      </ul>
    </>
  )}
  {boundary.overflow > 0 && (
    <p className="watch-report-tail">另有 {boundary.overflow} 次未逐条列出。</p>
  )}
</div>
```

**`exceeded` 每条三格**（时间 / 工具 / 原因），照既有 `.auto-run-row` 的
`flex` + `gap: var(--space-3)` 语言；`.watch-exceed-tool` 用等宽字体，
逐字照 `.permission-tool`（`app.css:8737`：`ui-monospace, "Cascadia Code", Consolas`）。

**`overflow` 明写**（`design.md:5`：「报告里说『另有 N 次未逐条列出』，
**不静默截断**」）。

### 4.4 各种状态的完整清单

| 情形 | 报告体 |
| --- | --- |
| `boundary` 缺失（老记录） | **不渲染报告体**，只在首行说 `这条运行早于「值守」功能，没有边界记录。` `design.md:2.2` 明确「**不编一个空的 boundary 出来**」—— 编出来会让用户以为「这次运行有边界、只是没用上」 |
| `boundary.exceeded = []` | 首行 `跑完了，一次都没越界。`，**无**「越界证人」小节（不出现空小节标题） |
| `boundary.timedOut = true` | 首行 `到 N 分钟被叫停 —— 这不是失败，是到点收工。`；`.watch-report-lines` 里追加 `被叫停时，已经做完的部分都在这次运行的会话里。` + 跳会话按钮 |
| `boundary.readOnlyEnforced = true` | `.watch-report-lines` 里有一行 `实际权限：只读（本任务的规矩比全局更严，已生效）` |
| `boundary.readOnlyEnforced = false` 且有 note | `实际权限：只读（全局档位，不是本任务的规矩）` —— **这两句必须可辨**，否则用户以为自己的规矩起了作用 |
| `boundary.scoped.length === 0` | `可写范围：整个工作目录` |
| `boundary.scoped.length > 0` | `可写范围：reports/、data/out/`（顿号连接，超过 3 条则 `reports/、data/out/ 等 5 个目录`） |
| `failed` | 首行 + `nextStepFor(error)` 的「下一步怎么办」一行，`role="alert"` |

### 4.5 从自动化事件 toast 可达

`app.js:70005` 的全局 `onAutomationEvent` 现在弹一句
`任务「X」已完成` / `运行失败`。本轮**把这句话换成 `boundaryHeadline` 的同一句**
（含越界次数），并给 toast 加一个动作：点击后 `openAutomations()` 并**自动展开
那条 run 的报告**（复用 `AutomationsView` 已有的 `expandedId` state，
再传一个 `focusRunAt` 把该行滚进视野）。

**为什么值得改**：`prd.md` 的痛点是「那半小时里到底发生了什么，用户回来只能翻台账看一行
成功/失败」。**toast 是用户回来的第一眼** —— 第一眼就该看到「跑完了但越了 2 次界」，
而不是「已完成」，否则他又要自己去翻。若实现成本超预算，
**这条是本案里第一个可以砍的**（PRD 只要求「可达」，没要求 toast 承载结论）。

---

## 5. 任务卡上的「值守」徽标

### 5.1 有规矩 vs 没规矩

在 `AutomationRow` 的 `.auto-row-title` 里，**`auto-row-name` 之后**，
与既有的 `已暂停` / `已错过` 徽标**并排**（`app.js:68840` 那段）：

```jsx
{task.watch !== undefined && (
  <span className="auto-badge watch-badge" title={watchBadgeTitle(task)}>
    <IconShieldCheck size={11} />
    值守
  </span>
)}
```

**§7.6「状态不只靠颜色」的落法**：有规矩的任务靠**三路**表达，缺一不可 ——

1. **有无**（形态）：有规矩才出现徽标，没规矩**什么都不显示**。这一条最关键 ——
   它是「存在性」信号，比任何颜色都强；
2. **图标**（形态）：一枚内联 SVG `IconShieldCheck`（一行式本地定义，
   照 `IconChart` / `IconHistory` 的写法，**不是 token、不进 §2 档位表**）；
3. **文字**（文字）：`值守` 两个字本身。

颜色**完全不用状态色**（不是成功、不是警告、不是错误），走
`.auto-badge` 的默认档（`--bg-raised` + `--text-secondary`）—— 与 `.auto-badge`
里既有的 `已暂停` 逐字同档，**零新增 CSS**。

### 5.2 hover 提示说清「这份规矩是什么」

`.auto-badge` 的 `title` 承载全部细节，由 `watchBadgeTitle(task)` 产出：

> `值守规矩：时限 45 分钟 · 能力 只读 · 可写范围 整个工作目录 · 越界即停`
> `值守规矩：能力 跟随全局（当前「只读」） · 未设时限 · 未限范围`

**为什么不把四要素摊在任务行上**：任务行的 meta 行已经有
「调度摘要 · 下次运行」，再加四段会把行撑成两屏（§3.8 的「分组变了间距没跟着分」
的反面 —— 这里是**信息分组溢出**）。任务的**身份**是名称与调度，
值守是**属性**，属性走徽标 + tooltip。

### 5.3 没规矩的任务

**什么也不显示。** 不写「无值守」—— 那是把「默认行为」说成一种缺失。
`prd.md` 明确「不填 = 今天的行为，一个字都不变」，界面上就不该有痕迹。

---

## 6. 四态与三态

### 6.1 每个新交互元素的四态

过渡**统一** `--dur-fast` + `--ease-standard`（§3），按压 `scale(.98)`（§3.1）。
**下列全部来自既有关联声明，逐字复用、不新写**：

| 元素 | rest | hover | focus | disabled |
| --- | --- | --- | --- | --- |
| `.num-chip`（时限） | `--bg` 底 / `--border` 边 / `--text-faint` 字（`app.css:8070`） | `border-color: var(--text-faint)`（`app.css:8085`） | 全局焦点环（`button` 天然） | 走 `.num-chip:disabled` ——**既有类没有这条**，需补 `opacity: .55; cursor: default`（照 `.preset-item:disabled`） |
| `.preset-item`（能力） | 透明底 + `border-bottom`（`app.css:7857`） | `--bg-hover`（`app.css:7866`） | 全局焦点环 | 既有 `opacity: .55; cursor: default`（`app.css:7874`）✅ |
| `.skill-chip-remove`（范围删除） | `opacity: 0`（`app.css:3175`） | `--bg-hover` 底 + `--text` 字（`app.css:3201`） | chip `:focus-within` → `opacity: 1`（`app.css:3191`，§7.9 已修） ✅ | 无 disabled 态（一条路径永远可删） |
| `.mcp-switch`（越界即停） | 轨道 `--border`（`app.css:10274`） | 无 hover（开关的反馈是滑块位移） | `outline: 2px solid var(--primary)` + `offset: 2px`（`app.css:10318`）✅ | `opacity: .5`（`app.css:10313`）✅ |
| `.auto-run-toggle`（看报告） | `--text-secondary`（照 `.auto-row-expand`，`app.css:9933`） | `--text`（`app.css:9940`） | 全局焦点环 | `--text-faint` + `cursor: default` |
| `.watch-effective` | 静态块（不可交互） | —— | —— | —— |
| `.field-error` | `--danger` 字（`app.css:7975`） | —— | —— | —— |

**唯一需要新写的一条**是 `.num-chip:disabled`。它必须存在 ——
`--danger-full-access` 之外的场景不会禁用它，但「时限」在
**`minutes` 已经是最大值 120** 时要禁掉「2 小时」以上的 chip（契约上限 120）。
加这一条是**补齐一个既有类的缺口**，不是新造控件（§6 禁止的是「新造类名 / 复制视觉值」，
这里是给既有类补一个它本就该有的伪类）。

### 6.2 列表的三态（§4）

**运行记录列表**（既有 `.auto-runs`）已经三态齐备，本轮**不降级**：

| 态 | 判据 | 现状 | 本轮 |
| --- | --- | --- | --- |
| 加载中 | `tasks === undefined` | `LoadingState`（`app.js:68729`）✅ | 不动 |
| 真空 | `runs.length === 0` | `EmptyState title="还没有运行记录"`（`app.js:68870`）✅ | 不动 |
| 错误 | IPC 抛错 | `ErrorState` + 重试（`app.js:68725`）✅ | 不动 |

**可写范围列表**（§3.5）：无加载态、真空走行内说明、错误走 `.field-error`。

**报告体内部**没有拉取动作（数据全在 `run.boundary` 里，随任务一起到），
所以**不需要三态** —— 但**必须**有 §4.4 那张表的每一行兜底。

---

## 7. 动效：明确不加

**本方案不新增任何动画。**

- 报告展开 / 收起的 `.watch-report` **不加入场动画**。理由：`.auto-runs` 本身
  已有 `animation: fold-in`（`app.css:10010`），报告体长在它**里面**；
  再叠一层入场就是「动画套动画」，两段节奏会打架。**同一处只保留既有的那一段。**
- 一次性高亮 / 呼吸点 / 扫光：**不用**。报告是静态信息，不是「正在发生的事」——
  呼吸点的既有语义是「还在跑」（§10.3 登记），拿来表示「越界了」会污染这条语言。
- 收严告警 `.watch-effective-narrowed` 的左轨**不做颜色过渡**：它是一个
  **静态事实**的呈现，不是一次状态变化。给它过渡反而暗示「刚发生了什么」。

**因此：§10.3 无新增登记条目，§10.3.1 的 `prefers-reduced-motion` 关停清单不动。
§5 受控例外表一条不碰（无布局属性过渡）。**

> 如果评审认为报告展开需要一个入场，那**必须先改设计意图**，再按 §10.3 登记、
> 并在 §10.3.1 第 ③ 组加一行（`animation: none`），终态停基础态即「正常可见」。
> **本方案的选择是不加** —— 折叠展开本身就是即时反馈，加淡入只是延迟信息到达。

---

## 8. Token 审计

**结论：零新增档位。** 逐类列出本方案用到的每一个值及其 `:root` 出处。

### 8.1 间距（7 档，用 5 档）

| 值 | token | 用在哪 |
| --- | --- | --- |
| 4px | `--space-1`（`app.css:616`） | `.field` 内部、`.skill-chip` 内 gap |
| 6px | `--space-2`（`app.css:617`） | `.num-chips` gap、`.auto-toggle-row` gap、`.mcp-switch` 相关 |
| 8px | `--space-3`（`app.css:618`） | 规矩组内四个声明之间、`.field-hint` 上距、`.watch-report` 内 gap |
| 12px | `--space-4`（`app.css:619`） | `.auto-form-card` 的 `gap`（既有）、`.preset-item` 内距（既有） |
| 16px | `--space-5`（`app.css:620`） | `.auto-form-card` 的 `padding`（既有） |

`--space-6`(24) / `--space-7`(32) **未使用**。

### 8.2 字号（5 档，用 3 档）

| 值 | token | 用在哪 |
| --- | --- | --- |
| 12px | `--text-meta`（`app.css:626`） | `.field-label`、`.field-hint`、`.field-error`、`.auto-badge`、`.auto-run-row`、`.watch-effective`、`.watch-exceed-*` |
| 13px | `--text-list`（`app.css:627`） | `.field input`（既有）、`.skill-chip`（既有）、`.auto-tpl-name` 同档 |
| 15px | `--text-emphasis`（`app.css:629`） | 不新增使用（`.save-space-title` 既有） |

`--text-body`(14) / `--text-display`(30) 未新增使用。

### 8.3 文字色（3 级 + 状态色）

| token | 出处 | 用在哪 |
| --- | --- | --- |
| `--text`（100%） | `app.css:531` | `.watch-effective` 正文（§3.4 的「必须读得出的那一句」）、`.auto-row-name` |
| `--text-secondary`（50%） | `app.css:532` | `.field-hint`、`.auto-badge` 字、`.watch-exceed-detail`、`.auto-run-time` |
| `--text-faint`（30%） | `app.css:534` | `.num-chip` 静态字（既有）、`.watch-report-tail` |
| `--danger` | `app.css` 状态色 | `.field-error`、`.auto-run-badge.bad`、`.watch-report-head` 的 failed 态 |
| `--ok` | `app.css` 状态色 | `.auto-run-badge.ok`（「没越界」） |
| `--accent` | `app.css:584` | `.watch-effective-narrowed` 的左轨（**唯一的新增使用**；`--accent` 的注释就是「可点标识」，这里语义是「这里发生过一次折算」，是它的近邻语义） |

**零颜色字面量、零 hex / rgb() / hsl()** —— `check:theme-tokens` 的第 2 项自动覆盖。

### 8.4 圆角（4 档，用 3 档）

| token | 出处 | 用在哪 |
| --- | --- | --- |
| `--radius-sm`（6px） | `app.css:634` | `.num-chip`、`.auto-run-row`、`.field input` |
| `--radius-md`（10px） | `app.css:635` | `.auto-row` 卡片（既有）、`.preset-item` 所属的 `preset-list` |
| `--radius-full`（999px） | `app.css:637` | `.skill-chip`、`.skill-chip-remove`、`.mcp-switch-track/thumb` |

5px 的 `.auto-badge` / `.auto-run-badge` 是**既有值**（`app.css:9994`、`app.css:10100`），
本方案**原样复用不重定义** —— 它不落在四档里，是既有的登记外事实，本轮不动它。

### 8.5 阴影 / 时长

| token | 用在哪 |
| --- | --- |
| `--shadow-lg` | `.auto-form-card`（既有，不动） |
| `--dur-fast` | 全部四态过渡（§3） |
| `--dur-base` | `.auto-runs` 的 `fold-in`（既有，不动） |
| `--ease-standard` | 全部变色过渡（§3.2） |
| `--ease-out` | `fold-in`（既有） |

**不新增 `--shadow-*`、不新增 `--dur-*`。**

### 8.6 需要新档位吗？—— 不需要

逐条回答「有没有哪个值落不进现有档位」：

- **报告体的内框**：无边框 + `--bg-raised` 底，用 §3.7 的原话即可，
  **不是新盒子**（没有 `border`、没有 `--shadow-*`）；
- **`.watch-effective` 的 2px 左轨**：与 `.fh-node` 的连接线、`.timeline` 的
  刻度**同性质** —— 是**组件尺寸**（一条线的粗细），不是间距 / 圆角 / 字号档位。
  逐字照 §9.2 在文件时光机方案里的论证（「节点圆点直径（10/12px）…… 是组件尺寸，
  与 `.tool-dot`（6px）同性质，**不是档位**，不进 §2 表」）；
- **`IconShieldCheck` 的 11px**：图标尺寸，与 `IconChevronDown` 的 13、
  `IconClose` 的 12/15 同类，**不是字号档位**。

---

## 9. 我刻意没做的事

| 被否掉的备选 | 否掉的理由 |
| --- | --- |
| **把「只能更严」做成一个只读的「实际生效值」预览卡** | 会变成 `AutomationForm` 里的**第二个内容卡**（§3.9 盒子预算）。而且「预览」暗示「你还没保存、这是预演」，而这一处要说的是**已经确定的事实**。改成紧贴列表的一行，不占盒子 |
| **在「能力」每一项后面加一枚彩色风险徽标（绿/黄/红）** | §2.4：状态色只表状态；「权限档」是**分类**不是状态，借状态色会把「只读 = 安全绿灯」这种暗示塞进界面，而本案的立场是「三档都是合法的，只是宽窄不同」 |
| **给「被收严」的选项加删除线 / 打叉** | 视觉噪音最大、信息量最小。用户要的不是「这个选项是错的」，是「**实际会怎样**」—— 那句话在下面那一行里 |
| **把四个声明摊成一行四列的 `grid`** | 每个声明需要的宽度差得远（时限 4 个 chip / 能力 3 行带描述 / 范围是输入框）。强排四列会让「能力」的 `preset-desc` 挤成三行。**纵向栈 + 各自的自然宽度**（照 `AutomationForm` 既有 6 个 `.field` 的节奏）更省心 |
| **`scope` 用「选文件夹」的原生目录选择器** | ① 契约是**工作区相对路径**，选出来的是绝对路径，要反向求相对 —— 多一层可能失败的转换；② 它会引入一个新的 IPC 通道（`dialog:showOpenDialog` 类），而 `design.md:3.1` 的核心决定就是**零新增通道**；③ 手写 `reports/` 比在深目录树里翻要快得多。**保持文本输入 + 回车** |
| **给「越界即停」一个 `.preset-item` 式的两行带描述单选（是/否）** | 一个 boolean 用两行列表是滥用：`mcp-switch` 是本站既有的 boolean 控件（且已是 4 处消费方），语义与形态 1:1 |
| **运行报告里加一个「越界次数」的进度条 / 环形图** | 分母是什么？「允许越界几次」这个概念不存在（`stopOnExceed` 是 boolean）。没有分母的图表是装饰 |
| **`unknown`（老记录）那条也用 `auto-run-badge` 的红/绿底** | 它既不是成功也不是失败，是**当时还没有这个功能**。给它状态色会让用户以为「那次运行出问题了」。走 `.auto-badge` 的中立档（`--bg-raised`） |
| **报告展开时给一整块进入的淡入** | §5.8 + §10.3 的登记负担，且与 `.auto-runs` 的 `fold-in` 打架（见 §7） |
| **在任务列表页顶部加一个「值守总览」统计条** | 越出 PRD 范围（非目标明确「不做跨任务的全局策略中心」）。而且它会成为任务列表页的第二个盒子 |
| **给 toast 加一个「查看报告」按钮** | toast 是 `.toast-stack` 里的纯文本 + 图标，加按钮要动 toast 的既有结构（4 个消费方）。**改成「点 toast 本身跳过去」**（§4.5），零结构改动 |

---

## 10. 截图清单

e2e `tests/e2e/watch-policy.mjs` 应捕获下列状态作为证据。**浅色为基准，暗色至少一张。**

### 10.1 规矩编辑区（`AutomationForm` 弹层）

| # | 状态 | 断言要点 | 主题 |
| --- | --- | --- | --- |
| S1 | 全局 `read-only`，规矩选 `可写`（**被禁用**） | 「可写」`.preset-item` 命中 `disabled`；其 `.auto-badge` 文本为 `不生效`；`.watch-effective` 存在且文本含 `不会放宽它` 与 `设置 → 权限` | 浅色 |
| S2 | 全局 `read-only`，规矩选 `跟随全局` | `.watch-effective` 文本含 `实际按「只读」执行` | 浅色 |
| S3 | 全局 `workspace-write`，规矩选 `可写` | **不出现** `.watch-effective-narrowed`（没有折算）；「可写」**可用** | 浅色 |
| S4 | 全局 `danger-full-access`，规矩全空 | 四个声明都是默认态；时限 hint 含 `30 分钟`（内置保护那句） | 浅色 |
| S5 | 可写范围：`reports/` + `data/out/` 两条胶囊 | 两条 `.skill-chip`；hint 为 `留空 = 整个工作目录…`（**不出现**「能写整个工作目录」那句主动说明） | 浅色 |
| S6 | 可写范围：空 | `.skill-chip` 数量 0；hint 含 `现在没有限制：这次运行能写整个工作目录里的任何文件` | 浅色 |
| S7 | 可写范围：输入 `../secrets` 回车 | `.field-error` 可见、`role="alert"`、文本含 `跑到了工作目录外面`；胶囊数**不增加** | 浅色 |
| S8 | 越界即停：关 | `.mcp-switch input` 的 `checked` 为 `false`；thumb 的 `transform` 非 `translateX(14px)` | 浅色 |
| S9 | 同 S1 | 同一断言的暗色对照 | **暗色** |

### 10.2 运行报告（`AutomationsView` 展开态）

| # | 状态 | 断言要点 | 主题 |
| --- | --- | --- | --- |
| S10 | `ok`（零越界） | 徽标文本 `没越界`、类名含 `ok`；报告体首行含 `一次都没越界`；**报告体文本不含** `暂无` / `无记录` | 浅色 |
| S11 | `exceeded`（2 次） | 徽标文本 `越界 2 次`；`.watch-report-exceed` 有 **2** 个 `li`；每 `li` 同时含时间、工具名、原因三格 | 浅色 |
| S12 | `exceeded` + `overflow` | 报告体尾部出现 `另有 3 次未逐条列出。` | 浅色 |
| S13 | `timedOut` | 徽标文本为 **`被叫停`**（**不是** `失败`）；首行含 `这不是失败，是到点收工` | 浅色 |
| S14 | `unknown`（老记录无 `boundary`） | 徽标文本 `无记录`；**不出现** `.watch-report` 元素；首行含 `这条运行早于「值守」功能` | 浅色 |
| S15 | 折叠态（默认） | 报告体**不在** DOM 里（默认折叠不占开场视线，PRD §4） | 浅色 |
| S16 | 同 S11 | 暗色对照：徽标底、`.watch-report` 的 `--bg-raised` 面、等宽工具名都仍可辨 | **暗色** |

### 10.3 任务卡徽标

| # | 状态 | 断言要点 | 主题 |
| --- | --- | --- | --- |
| S17 | 一条有规矩 + 一条无规矩的任务并排 | 有规矩的 `.watch-badge` 存在且文本为 `值守`；无规矩的**不存在任何**值守相关元素；两者的 `.auto-badge` 底色相同（没有借状态色） | 浅色 |

### 10.4 三态与可达性

| # | 状态 | 断言要点 |
| --- | --- | --- |
| S18 | 老记录（无 `boundary`）跑通全流程 | 报告区不崩、不出现空盒子（PRD 验收「老记录无 boundary 不崩」） |
| S19 | 键盘：Tab 进入可写范围的删除钮 | `.skill-chip-remove` 的 `opacity` 为 **1**（`:focus-within` 生效，§7.9） |
| S20 | `emulateMedia({ reducedMotion: 'reduce' })` | 本方案**无新增动画** → 只需回归既有断言（`.auto-runs` 的 `fold-in` 已在关停清单里） |

---

## 附：需要评审裁决的两处

1. **30 分钟内置保护 vs `design.md:2.1` 的「不填 = 不限时」**。
   任务书说「Absent = the product's built-in 30-minute guard」，
   `design.md:2.1` 的表格写「不填时：不限时（与今天一致）」。**两者矛盾**。
   本方案按**任务书**（真实行为）写文案，即「不设时限时，运行到 30 分钟会被自动叫停」。
   请裁决：若 daemon 侧确实无此保护，则 §1.3 那句 hint 要改成
   `不设时限时，这个任务会一直跑到自己结束。` —— **但无论哪一边，文案都必须与
   daemon 的真实行为一致**，这是本案里最容易写错的一句。

2. **`stopOnExceed` 的真实语义**。契约名是「越界即停」，`design.md:3.3` 的判定是
   「拒绝该次调用 + 记证人」，而 `prd.md:2` 又写「越界即停：run 会话的工具层……
   越界时拒绝该次调用并把理由回给模型」。**三处一致指向「停这一次调用」，
   `design.md:7` 的决策表还明确否掉了「越界即整个任务失败退出」**。
   所以 §1.2 的副行文案写「停下这一次调用」，不写「停下整个任务」。
   若产品意图确实是「整个 run 中止」，那 `design.md:7` 那一行与本条都需改写。
