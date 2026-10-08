# 模型对比：一屏 N 列的设计规范

> 面向实现（可落到 CSS / JSX 级别）。依据：`docs/DESIGN.md`（§2 档位纪律 / §2.1 文字三级 /
> §2.4 状态色只表状态 / §3.7 次级面 / §3.8 分组节奏 / §3.9 盒子预算 / §4 三态 / §5 受控例外 /
> §5.8 进出场不对称 / §6 禁止清单 / §7.6 状态不只靠颜色 / §7.9 hover 控件 / §10.3 动效登记）、
> `.trellis/spec/renderer/index.md`、`src/renderer/src/app.css` 的 `:root` 与 `[data-theme="dark"]`
> （token 单一真源）、本任务的 `prd.md` 与 `research/feasibility.md`（C 节 + 结论 + 三个坑）、
> 以及 `artifacts/design-review/` 的四张截图（`conversation-light` / `home-dark-empty` /
> `conversation-panel-light` / `settings-model-light`）。
>
> **本文不新增任何 token、不新增任何视觉档位、不新增任何颜色、不新增任何动画、
> 不申请任何 §5 受控例外。**
> 新造的类名**只有 3 个**（`.compare-grid` / `.compare-col` / `.compare-col-head`），
> 每个都在 §2.1 写了「为什么既有类不够用」；其余全部是既有类与既有类的作用域覆盖。

## 0. 一句话结论

- **这一屏的结构是「一张白卡 + N 条灰通道」**：输入卡是全屏唯一的内容卡级主盒子（§3.9），
  N 条通道是**不带边框的 `--bg-raised` 次级面**（§3.7）。白卡问问题，灰面给回答。
- **每个通道 = 一条普通的助手回合，只是身份从「ZeroWork」换成了模型名**。
  所以列头逐字复用回合头的身份语言（`.turn-agent` + `.turn-duration`），
  用量读数逐字复用本轮读数语言（`.run-metrics` 的 `↑ ↓`）。
- **通道左缘 2px 分类色条**（`--cat-1..4`）是这一屏唯一的"新"视觉装置 —— 它让截图一眼可读成
  「四路赛道」，并且滚到长答案中段时仍认得出是哪条通道。
- **柱状的所有读数（模型名 / 耗时 / 用量）都落在同一条水平线上**：横向可比是本屏的全部意义，
  这也是「不能原样复用回合头」的唯一硬理由（见 D3）。

---

## 一、诊断

### D1【不是问题】既有的「加载 / 空 / 错误」三态组件够用

`.state-empty` / `.state-loading` / `.state-error`（`app.css:1158-1215`）与组件
`EmptyState` / `LoadingState` / `ErrorState`（`app.js:13232-13260`）形态齐全：

| 本屏需要 | 用哪个既有形态 | 判据 |
| --- | --- | --- |
| 通道还没发问 | `EmptyState`（只给 `title`，不给 icon / action） | 不是加载、也不是"无数据"，是"还没开始"（§4 的禁令是**数据到达前不得显示「无数据」文案**，不适用于"用户还没提问"） |
| 模型菜单未回 | `LoadingState` | 与既有 `ModelMenu` 同一处理 |
| 某一列失败 | `ErrorState`（`message` + `onRetry`） | §4 明文「错误就地呈现，并给出重试动作」 |
| 某一列排队中 | **不是三态之一** —— 排队是"已受理、未开始"，见 §2.4 | 用死类 `.stream-queue`（见 D2） |

**一处需要知道、但不需要改**：`.state-error` 的底色是
`color-mix(in srgb, var(--danger) 8%, var(--bg))`（`app.css:1196`），混的是 `--bg` 而不是
`--bg-raised`；本屏的通道面是 `--bg-raised`。核过两个主题：浅色下 `danger 8% + #fff` 是淡粉底、
落在 `#f7f7f7` 上是**更深的粉**；深色下 `danger 8% + #1c1c1e` 比通道面 `#26262a` **更暗**。
两个主题都靠那条 1px `--danger` 描边兜底，**可辨**。不改它。

### D2【真问题，但代价极小】`.stream-queue` 是一个死类，而它的语义与形态正是「排队中」需要的

全仓引用只有两处：定义本身（`app.css:10577`）与一句把它当作视觉语言参照的注释
（`app.css:6665`）。它的形态是**12px 次级灰 chip**（`display:inline-flex` + `padding:2px 8px` +
`--radius-sm` + `--bg-raised` 底 + `align-self:flex-start`）。

两条判断：

1. **复用它，不新造「排队」chip** —— 类名与语义完全吻合（它就是"排队"），且零引用 ⇒ 零回归。
   （上一轮复用死类 `.settings-hint` 是同一个先例，`app.css:8825` 的注释记着那次账。）
2. **抬升面上必须换底**：`--bg-raised` 的 chip 坐在 `--bg-raised` 的通道里 = 没有底。
   按 token 自己的语义换成 `--bg-chip`（"内容 chip 的静态底色"），
   **不换 `--bg-hover`** —— token 注释（`app.css:551-553`）明文写着它是 hover 专用档，
   「气泡里的胶囊是只读的、没有 hover 语义」，排队 chip 是只读的。

### D3【真问题，本设计最核心的一条】原样复用回合渲染会让三件事同时出错

`buildTurnViews`（`app.js:30674`）与它下游的 turn 渲染（`app.js:32969-33013`）是可行的复用层
（`feasibility.md` C11 已核），但**原样渲染**会带来三个错误：

| # | 原样渲染的后果 | 依据 | 本设计的处置 |
| --- | --- | --- | --- |
| ① | 四列各渲染一个 24px 应用 logo 头像 + 「ZeroWork」名字 | `TurnHeader`，`app.js:32384-32390` | **不渲染 `TurnHeader`**，身份由列头承担（模型名） |
| ② | 每列的用量读数落在**各自的 y 位置**（正文下方的常驻操作条 `.entry-toolbar-left` 里） | `app.js:31959` 的 `RunMetricsBar` | **把读数提到列头**，让它与其它列落在同一条水平线上 —— 这是"可比"的前提 |
| ③ | 操作条里带着**会话级**动作：「重新开始」「分支出新会话」 | `app.js:31841-31872`（`target !== undefined && branchable` 才渲染） | 传 `branchable: false` 且不传 `onRestart / onBranch` —— 本屏没有会话，这两个键是谎按钮 |

**③ 尤其不能妥协**：本屏的产品承诺是"不进侧栏、不进历史、不计入统计"，
一个能"分支出新会话"的按钮会把这条承诺当场作废。

### D4【真问题】`.turn-agent` 今天没有任何溢出处理

`.turn-agent`（`app.css:3950`）只有 `font-size` 与 `font-weight`；`.turn-duration`（`:3955`）
是 `inline-flex`。对话页的发言者是常量 `"ZeroWork"`，永远不会溢出；本屏要放
`org/model-name:tag` 这类名字，**必须**补 `min-width: 0` + 溢出省略，否则名字会把那一列撑宽。

这与 `app.css:3295` 那条注释记录的是**同一类事故**（`.case-grid` 的列定义必须是
`minmax(0,1fr)`，否则"谁的封面宽谁列宽"，卡片不再等宽）——本屏同理：
**通道必须 `min-width: 0`，栅格必须 `minmax(0,1fr)`**。

长名字的正确取值见 §2.3。

### D5【不是问题】命令面板（⌘K）加一条动作，零设计成本

`paletteActionEntries`（`app.js:68177`）的每条动作只有
`{ id, title, subtitle, keywords, run }` 五项，注释明文「每条都是既有入口的『换一个入口』，
`run` 只调用既有 `setState` 或既有 `window.kami.*`，不新增通道」；行排版、`kind` 图标
（`PALETTE_KIND_ICONS.action`）与选中态全是既有的。**本设计对这条入口没有任何视觉要求**，
只给文案（§三）。

### D6【真问题 / 交互非视觉】既有的 `ModelMenu` 是单选且"点完即关"，不能改它

`ModelMenu.pick`（`app.js:15014-15022`）点一条就 `setOpen(false)` + `window.kami.setModel(key)`——
那是**会话级单模型**的权威写入点。多选若做进它，会污染默认路径的模型状态
（`feasibility.md` 的「明确不建议做」第 3 条）。

**处置**：本屏写一个**平行的多选菜单**，复用同一套外壳与行语言
（`.pop-menu.model-menu` + `.model-menu-item` / `.model-menu-name` / `.model-menu-meta` /
`.model-menu-check`，含它现成的三态：`ErrorState` / `LoadingState` / `.model-menu-goto`
「去设置里填 API Key →」，`app.js:15068-15085`），只把 `pick` 的行为从「选中并关闭」
改成「切换选中、不关闭」。**类名与样式一个都不新造。**

### D7【不是问题】输入卡下方的 `.session-stats` 正好是「约束提示」的既有位置

`.session-stats`（`app.css:2284`）是输入卡下方那行 12px 次级灰读数（对话页放本轮读数）。
本屏的读数搬进了列头，这一行空出来给**可执行的约束**（「至少选 2 个模型才能开始对比」）。
形态（居中 / 单行 / 省略号）与语义位都现成，**不改样式**。

---

## 二、设计规范

### 2.0 共同约束（先说四条边界）

1. **零新增 token / 零新增档位 / 零新增颜色。** 全文只引用：
   颜色 `--bg` `--bg-raised` `--bg-chip` `--border` `--text` `--text-secondary` `--danger`
   `--cat-1` `--cat-2` `--cat-3` `--cat-4`；
   间距 `--space-1`(4) `--space-2`(6) `--space-3`(8) `--space-4`(12) `--space-5`(16)
   `--space-6`(24) `--space-7`(32)；
   字号 `--text-meta`(12) `--text-list`(13) `--text-body`(14) `--text-emphasis`(15)；
   圆角 `--radius-sm` `--radius-md` `--radius-full`；
   阴影 `--shadow-input`（只在既有输入卡内部）；
   时长/缓动 `--dur-fast` + `--ease-standard`（只在既有控件的四态过渡里）；
   层级 `--z-overlay`（模型菜单，既有）`--z-base`（sticky 列头）。
2. **零新增动画。** 无新 `@keyframes`、无新的一次性入场、无新时长档 ⇒
   `docs/DESIGN.md` §10.3 与 §10.3.1 的关停清单**不需要任何新条目**。
   验收断言：本屏新增代码里不得出现 `animation:` 或非 `--dur-fast` 的 `transition:`。
3. **零新增 §5 例外。** 本屏**不使用任何 `width` / `height` 过渡**——
   折列、通道出现消失、列数变化**全部是瞬时重排**（§5.1 默认禁止，本屏不申请放行）。
4. **新类名 3 个**，全部在 §2.1 有「既有类为什么不够」的一句。

### 2.1 结构：DOM 层级与复用的既有类名

```jsx
<main className="settings" data-compare="true">
  {/* 整页壳：与 stats / diagnostics / automations / library 同一个（app.css:6926） */}
  <header className="settings-head">
    <button type="button" className="bar-btn" aria-label="返回" onClick={onClose}>
      <IconBack size={17} />
    </button>
    <h1>模型对比</h1>
    <span className="settings-hint">只问答：不跑工具、不动文件、不进历史、不计入统计</span>
    <span className="bar-spacer" />
  </header>

  <div className="settings-body" data-compare="true">
    <div className="compare-grid" data-cols={participants.length}>
      {/* ── 第 0 行：输入卡（本屏唯一的内容卡级主盒子） ── */}
      <div className="composer-zone">
        <div className="composer-slot">
          <div className="composer-card">
            <textarea rows={2} placeholder="想问所有模型同一个问题…" … />
            <div className="composer-bar">
              <span className="bar-spacer" />
              <ModelMultiMenu />          {/* 触发钮 .bar-btn.bar-btn-text.model-chip + .pop-menu.model-menu */}
              {running
                ? <button className="send-btn stop" aria-label="停止" …>…</button>
                : <button className="send-btn" aria-label="开始对比" …><IconSend size={16} /></button>}
            </div>
          </div>
        </div>
        {hint !== undefined && <div className="session-stats">{hint}</div>}
      </div>

      {/* ── 第 1..N 行：通道 ── */}
      {participants.map((m, i) => (
        <section
          className="compare-col"
          key={m.key}
          data-status={col.status}                      /* queue | streaming | done | failed | cancelled */
          aria-label={`${m.name} 的对比结果`}
          style={{ "--lane-accent": `var(--cat-${i + 1})` }}>
          <div className="compare-col-head">
            <span className="turn-agent" title={`${m.providerName}/${m.id}`}>{m.name}</span>
            <span className="turn-duration">{stateText(col)}</span>   {/* 「已处理 12s」… */}
            <span className="bar-spacer" />
            {col.running && (
              <button type="button" className="bar-btn" aria-label="取消这一列" title="取消这一列">
                <IconStop size={14} />
              </button>
            )}
            <RunMetricsBar items={col.metrics} />          {/* ↑1.2K · ↓3.9K（既有组件） */}
          </div>
          {/* 列体：见 §2.4 的五种形态 */}
        </section>
      ))}
    </div>
  </div>
</main>
```

**3 个新类名，各自的一句理由：**

| 新类名 | 用途 | 既有类为什么不够 |
| --- | --- | --- |
| `.compare-grid` | N 列栅格容器（列数 = 参与模型数）+ 输入区那一行 | `.case-grid`（`app.css:3289`）是**固定 4 列**且语义是案例封面；`.model-grid`（`:7221`）是 `auto-fill`，**列数由宽度裁决**——本屏列数必须等于参与模型数，宽度不得决定它 |
| `.compare-col` | 单条通道（次级面 + 内部竖向结构） | 既有类里没有"抬升面通道"。`.provider-list`（`:7301`）是**白底细边列表盒**（带 `--border` 外框），与 §3.7「次级面一律不带边框」直接冲突；`.case-cover`（`:3315`）是内容封面（带 0.5px 描边 + 分类色渐变），语义与形态都不是"承载一段文字流的面" |
| `.compare-col-head` | 列头（sticky + 底色 + 底部分隔线 + 两行排布） | 要 sticky 就必须有一个**能承载不透明底色**的元素；`.turn-header`（`:3903`）无底色、有 `margin: 12px 0`、且它的 `.turn-meta` 是**纵向堆叠**（名字一行、耗时一行），本屏要把"名字 + 耗时"放在同一行以节省通道高度。改 `.turn-header` 会连带改对话页的回合头（同类名、同屏存在） |

**其余全部复用**（逐个点名，便于 review 时核对）：
`.settings` `settings-head` `settings-body` `settings-hint` `bar-btn` `bar-spacer` `mini-btn`
`send-btn` `send-btn.stop` `stop-confirm-kbd` `composer-zone` `composer-slot` `composer-card`
`composer-bar` `bar-btn-text.model-chip` `pop-menu` `model-menu` `model-menu-item`
`model-menu-name` `model-menu-meta` `model-menu-check` `model-menu-goto`
`turn-agent` `turn-duration` `run-metrics` `state-empty` `state-error` `state-error-text`
`state-loading` `stream-queue` `stream-pending` `text-shimmer` `user-cancelled` `spinner`
`entry` `entry.assistant` `markdown` `provider-meta`。

> 一处**刻意不新造**：列头第一行没有再用一层 `<div>` 包「名字 + 耗时 + 占位 + 动作」——
> 靠 `.compare-col-head` 自己的 `flex-wrap` + `.run-metrics { width: 100% }` 让它独占第二行（§2.3）。

### 2.2 布局

#### A. 栅格策略：列数 = 参与模型数，等宽

```css
.compare-grid {
	display: grid;
	gap: var(--space-5) var(--space-3);
}

.compare-grid[data-cols="2"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.compare-grid[data-cols="3"] { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.compare-grid[data-cols="4"] { grid-template-columns: repeat(4, minmax(0, 1fr)); }

.compare-grid > .composer-zone { grid-column: 1 / -1; }
```

三条取值理由：

- **`minmax(0, 1fr)` 而不是 `1fr`**：`app.css:3295` 的注释记着 `.case-grid` 的事故——
  `1fr` 的隐式下限是 `min-width: auto`，内容的固有宽度（那边的远程封面、这里的
  `org/model-name:tag` 与长 URL）会把列顶宽，"谁的宽谁列宽"。本屏再加一道
  `.compare-col { min-width: 0 }` 兜底。
- **`data-cols` 用属性而不是内联 CSS 变量**：与仓库既有的属性驱动同一手法
  （`data-theme` / `data-collapsed` / `data-closing` / `data-dragging` / `data-status`），
  且 2/3/4 三档显式可读，不依赖 `repeat(var(--n))` 能否解析。
- **行距 16 > 列距 12**：输入行 → 通道行是「控制 → 结果」的**分组边界**，
  通道之间是同级并排。这与 §3.8 的分组逻辑同源（间隙跟着分组走，不是数错了）。

**等宽是硬要求。** 不做「当前列加宽 / 主列」：对比的对象是对等的，非对称会立刻读成"有个主答案"；
而且加宽必然要过渡宽度（§5 新例外），本屏不申请。

#### B. 窄窗口：折成 2 列（容器查询，2 条规则）

```css
.settings-body[data-compare] {
	container-type: inline-size;   /* 查询的是"可用宽度"，不是窗口宽 —— 侧栏开合会改它 */
	max-width: none;               /* 900px 是设置页的阅读列宽口径，本屏不适用 */
}

/* 容不下「每列 210px」时折列。210 与 .model-grid 的 auto-fill 下限同值
   （既有栅格语言，不是新尺寸）；折成 2 列而不是 1 列 —— 1 列就不再是"并排"。 */
@container (max-width: 880px) {
	.compare-grid[data-cols="4"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@container (max-width: 660px) {
	.compare-grid[data-cols="3"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
```

- **阈值怎么来的**：`n` 列放下需要 `n × 210 + (n−1) × 12`。
  n=4 → 876（取 880）；n=3 → 654（取 660）。
- **n=2 不写折列规则，因为那条是死的**：主进程 `minWidth: 900`（`src/main/index.js:249`），
  最窄时可用宽 = `900 − 侧栏 264 − 内边距 48 ≈ 588`，仍 > `2×210+12 = 432`。**永不触发。**
  为了不写死代码，n=2 从不折列。
- **为什么用容器查询而不是媒体查询**：可用宽度由侧栏开合改变（264px 的摆动），
  窗口宽与它是两个量 —— 这正是 `app.css:3546` 用容器查询的同一动机。
- **⚠️ 实现时必须实测一条**：`container-type: inline-size` 挂在**滚动容器自身**上
  （`.settings-body` 有 `overflow-y: auto`）。请实测**滚动时 sticky 列头仍吸附**。
  若失效，退回「`.app[data-sidebar]` + 媒体查询」两级断点（`.app` 上已有 `data-sidebar="collapsed"`
  属性可用），**不要新造第三套机制**。
- **折列之后不再追求"一屏一列"**：2×2 也满足"并排看"；4 列挤成 150px 宽才是真的失败
  （14px 正文下一行只剩 10 个汉字）。

#### C. 明确不用 `width` / `height` 过渡（§5.1）

栅格的行列变化、通道的出现与消失、输入行与通道行之间的重排，**全部瞬时**。
理由：这些都是"重排"而不是"让位"（§5 例外③④的语义是"面板/侧栏把内容推开"），
`transform` 表达不了，登记一条 `width` 过渡的唯一效果是让四列在换阵时一起抽搐。
**§5 表不动。**

#### D. 列宽策略与内容宽口径

- 通道宽度 = 栅格均分；**不做逐列独立滚动容器**（见 §五）。
- **不移植 `--chat-content-width` 的 832 上限**：那一档是"单列阅读"的口径（对话页与输入卡），
  本屏列宽由参与模型数与可用宽度裁决。给整屏套 832 会让 4 列在宽屏上挤在中间、两侧空一大片。

### 2.3 列头：模型名 + 耗时 + 用量 + 每列动作

#### A. 排布（两行，第一行吸附不了的东西不放第一行）

```
┌──────────────────────────────────────────┐
│ Qwen3-32B                    已完成 12s  ⏹│   ← 行 1：身份 + 耗时 + 占位 + 每列动作
│ ↑1,204 · ↓3,890                          │   ← 行 2：用量（独占一行）
├──────────────────────────────────────────┤   1px --border 分隔线
```

```jsx
<div className="compare-col-head">
  <span className="turn-agent" title={`${m.providerName}/${m.id}`}>{m.name}</span>
  <span className="turn-duration">{stateText}</span>
  <span className="bar-spacer" />
  {col.running && <button type="button" className="bar-btn" aria-label="取消这一列">…</button>}
  <RunMetricsBar items={col.metrics} />       {/* 既有组件，items = ["↑1.2K", "↓3.9K"] */}
</div>
```

**为什么用量必须独占一行**：四列的名次信息（谁快、谁省）只有在**同一条水平线上**才读得出来。
放在行 1 的右端会在窄通道里被挤掉（名字是身份，不许它是被省略的那一个）。

**为什么耗时与名字同字号**：逐字沿用回合头的判断（`app.css:3950-3970` 的注释：
「12px 的写法把它压成了『附注』，正是它不像回合头的原因」）。
用量是**支撑读数**，走 12px 的 `--text-meta`（`.run-metrics` 自带），层级差是有意的。

#### B. 长模型名（`org/model-name:tag`）怎么办——三层处置

1. **显示用 `model.name`，不用 id**：这是菜单里用户选人时看到的那一个字段
   （`.model-menu-name` 用的也是它，`app.js:15090`），列头与菜单因此逐字一致。
2. **`title` 挂完整键** `{providerName}/{model.id}`：想知道"到底是哪个 provider 的哪个 id"
   的人 hover 就有。
3. **溢出处理**（CSS，4 条，因为 `.turn-agent` 今天一条都没有 —— 见 D4）：

```css
.compare-col-head .turn-agent {
	flex: 0 1 auto;        /* 可压缩，但不抢空间 */
	min-width: 0;          /* 没有它，text-overflow 不生效 */
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
```

#### C. 列头本身

```css
.compare-col-head {
	display: flex;
	flex-wrap: wrap;                 /* 让 width:100% 的用量行换到第二行 */
	align-items: center;
	column-gap: var(--space-3);
	row-gap: var(--space-1);
	padding: var(--space-3) var(--space-4) var(--space-2);
	border-bottom: 1px solid var(--border);       /* 表头与正文的分界（阅读用，不是卡片边界） */
	border-radius: var(--radius-md) var(--radius-md) 0 0;

	/* 吸附：滚进长答案时，身份与计时仍在。z-index 必需 ——
	   .entry 是 position: relative（它自己的操作条锚点），是本行的**后绘兄弟**，
	   不给列头抬升就会被正文盖住。层级取 --z-base，它的注释原文就写着
	   「页面内抬升：刻度轨、sticky 头、激活描边」。 */
	position: sticky;
	top: 0;
	z-index: var(--z-base);
	background: var(--bg-raised);                 /* 必须不透明：正文要从它下面滑过 */
}

.compare-col-head .run-metrics {
	width: 100%;                     /* flex-wrap 下等于"强制换行"，不必再套一层 div */
}
```

**折列时 sticky 仍然成立**（这一条我推演过，请实现者按此核对）：两个行组的列头不会叠在同一条
吸附线上 —— 第 1 行通道的底边在换行间隔（16px）之后就是第 2 行通道的顶边，
当第 2 行的列头开始吸附时，第 1 行的列头已被自己通道的下边界推出去（它被 clamp 到
"通道底边 − 自身高度"）。(若实测发现两个行组同时吸附，才需要补折列态的 `position: static`。)

**明确不做**：sticky 列头**不加浮动阴影**。它一旦有阴影就从"表头"变成"浮层"，
与通道是同一个面的事实相矛盾；底色 + 1px 分隔线已经足够。

### 2.4 每个状态的形态（五个状态，两套信号：文字 + 形态）

| 状态 | `data-status` | 列头（耗时位） | 列体形态 | 颜色 |
| --- | --- | --- | --- | --- |
| **排队中** | `queue` | `排队中`（**不带秒数**） | 左上角一枚 `.stream-queue` chip，文案 `排队中` | 无状态色（`.turn-duration` 默认 `--text-secondary`） |
| **流式中**（首 token 未到） | `streaming` | `已处理 12s` | 一行 `.stream-pending` + `.text-shimmer`：`等待模型响应…` | 无状态色（扫光承担"进行中"） |
| **流式中**（已在出字） | `streaming` | `已处理 12s` | 正文本身在长（`.entry.assistant` + `.markdown`） | 无状态色 |
| **已完成** | `done` | `已完成 12s` | 正文静止，无附加行 | **不用 `--ok`**（见下） |
| **失败** | `failed` | `失败 3s` | `ErrorState`：`{daemon 原因}` + `.mini-btn`「重试」 | 耗时文字 `--danger` + 错误框的 `--danger` 描边 |
| **已取消** | `cancelled` | `已取消 12s` | 已产出的部分正文 + 末尾一行 `.user-cancelled`：`已取消` | 无状态色 |

四条判断：

- **`已完成` 不用绿色。** 四列同时变绿是纯噪声，而且 §2.1 明文：
  「当状态已经由位置或文字独立承担时，颜色不必再往深处压」——文字已经写着「已完成」。
  这一档**与对话页的回合头逐字一致**，越一致越像"一直就在那儿"。
- **失败只用一处状态色，但用两遍（文字 + 描边）**，这是 §2.4「状态色只表状态」下的
  合法用法：`--danger` 在这里表达的确实就是失败。**不改通道左缘色条的颜色** ——
  那条色条属于"这一列是谁"（分类），把失败也压上去等于两条语义共用一条通道（见 §五）。
- **排队不带秒数的理由**：耗时是本功能的核心读数，它必须等于"这个模型自己的延迟"。
  把排队等待算进去会污染对比数据 —— 那正好是这个功能存在的全部理由。
  所以排队期间**不显示秒数**，只显示状态词；计时从本列真正开始跑那一刻起。
- **`排队` 与 `空` 必须可辨**（§4 同族纪律）：空通道是**居中的** `EmptyState`「等待提问」，
  排队是**左上角的一枚 chip**。位置 + 形态 + 文字三重不同。
- **取消保留已产出的正文**：与既有语义一致（`.user-cancelled` 在对话页里就是"中断在消息流里
  留下的痕迹"）。列头已经写了「已取消 12s」，正文末尾那一行是"正文在这个位置断了"的标记。

### 2.5 输入区

#### A. 卡片（本屏唯一的内容卡级主盒子）

```jsx
<div className="composer-zone">
  <div className="composer-slot">
    <div className="composer-card">
      <textarea rows={2} placeholder="想问所有模型同一个问题…" … />
      <div className="composer-bar">
        <span className="bar-spacer" />
        <ModelMultiMenu />
        <button className="send-btn" aria-label="开始对比" disabled={…}><IconSend size={16} /></button>
      </div>
    </div>
  </div>
  {hint !== undefined && <div className="session-stats">{hint}</div>}
</div>
```

- **底栏只有右组**：本屏没有「+」附件、没有「默认权限」、没有技能 chip —— 因为**不跑工具、
  不带文件**。左边那三个挂件在别的页是"我能做什么"的入口，在这里每一个都是谎。
- **模型钮在右组（贴右）**：与首页/对话页同位置（`.composer-bar` 的 `trailing`），
  而且**必须是右组** —— `.composer-bar .model-menu`（`app.css:8711`）把菜单定位成
  「触发钮上方 + 右对齐」，钮若放左组，菜单会对齐到卡片右缘、离触发钮几百像素远。
- **模型钮的类**：`className="bar-btn bar-btn-text model-chip"`（既有组合）。
- **运行中冻结参赛名单**：模型钮 `disabled` + `title="这一轮已经开始，下一轮可以改"`。
  理由：通道与名单必须一致，中途增删列既让人看不懂，也要真的去中断请求。
- **`rows={2}`**：答案区比输入框的"气派"重要；2 行 15px/1.75 ≈ 52px。
- **不做"发问后把输入卡收起"**：那会多出一个折叠态要设计（而且收起来之后改问题要两步），
  收益不抵成本（§五）。

#### B. 多选菜单（复用 `ModelMenu` 的整套外壳与行语言，只改 `pick` 的行为）

```jsx
<div className="pop-menu model-menu" role="menu" aria-multiselectable="true">
  {error ? <ErrorState message={error} onRetry={reload} />
   : snapshot === undefined ? <LoadingState text="正在读取模型…" />
   : available.length === 0 ? <div className="model-menu-goto" …>去设置里填 API Key →</div>
   : <div className="model-menu-list">
       {available.map((model) => {
         const key = `${model.providerId}/${model.id}`;
         const picked = pickedKeys.includes(key);
         return (
           <button type="button" role="menuitemcheckbox" aria-checked={picked}
                   className={`model-menu-item${picked ? " active" : ""}`}
                   onClick={() => toggle(key)}>
             <span className="model-menu-name">{model.name}</span>
             <span className="model-menu-meta">{providerName} · {contextK}K</span>
             {picked && <IconCheck size={14} className="model-menu-check" />}
           </button>
         );
       })}
     </div>}
</div>
```

- **选中态两个信号**：`.model-menu-item.active` 的 `--bg-raised` 底 **+** `.model-menu-check`
  的 `--ok` 对勾。§7.6（状态不只靠颜色）由对勾这个**形态**承担，颜色只是加成。
- **点选不关闭**：这是与既有 `ModelMenu` 唯一的**行为**差异（类名、样式、三态处理全同）。
- **零新增菜单样式**：包括"已满 4 个"的提示也不做常驻脚注（理由见 §五）。
- **不做原生 `<select>`**（§6 禁止清单第 1 条）。

#### C. 2–4 个数量与「第 5 个被明确拒绝」

| 情形 | 表现 |
| --- | --- |
| 已选 0–1 个 | 卡下 `.session-stats`：`至少选 2 个模型才能开始对比`；发送键 disabled；空通道只有已选的那些（0 个 = 通道区为空） |
| 已选 2–4 个 | 卡下不显示提示；发送键可用（问题非空时） |
| 已选 4 个时点第 5 个 | **该项不进入选中**，并弹 toast：`最多同时对比 4 个模型 —— 先在菜单里移除一个，再加新的`（走既有的 `showToast` 通道，与首页「接入失败」同一条路） |
| 已选 4 个（未点第 5 个） | 模型钮文案已经写着`对比 4 个模型`；上限由越界那一刻的 toast 说明，不做常驻警告 |

**为什么用 toast 而不是把剩余项置灰**：置灰要让 1495 行的列表里**绝大多数**变灰，
用户第一反应是"这个功能坏了"而不是"我选满了"；而且 CSS 的 `:hover` 对 disabled 元素照样命中
（仓库为 `.bar-btn` 专门写过 `:not(:disabled)` 守卫），还得再补一条守卫。
toast 在**越界那一刻**说清楚原因，信息量与时机都对。

#### D. 开始 / 取消

| 控件 | 未运行 | 运行中 |
| --- | --- | --- |
| 卡内右端按钮 | `.send-btn`，`aria-label="开始对比"`，`disabled = n<2 || 问题为空` | `.send-btn.stop`（**同一个位置换成停止键**，与对话页输入卡同款），`aria-label="停止"`，`title` 在 arm 后变「再按一次确认停止」，arm 期间显示既有 `.stop-confirm-kbd`「Esc」徽章 |
| 键盘 | `Enter` 发送 / `Shift+Enter` 换行 | `Esc` 取消全部（与 `handleComposerKeyDown` 逐条一致，`app.js:14775-14860`） |
| 列头 | — | 每列一枚 `.bar-btn` + `IconStop`，`aria-label="取消这一列"`（**不设二次确认**，见下） |

- **整体取消沿用既有的二次确认**（`stopConfirmIdle`，`app.js:14620`）：一次点击只 arm。
  理由逐字沿用它的注释——「没有中断入口时…必须有的逃生门」，但"一键丢掉 N 列的全部产出"
  是一次性代价很大的动作，需要 arm。
- **单列取消不设二次确认**：只丢一列，而且取消之后原地就有「重试」/重新提问，
  代价不对等 —— 与整体取消的差别是有意的，不是遗漏。
- **不再往头部加第二个取消入口**：`settings-head` 保持「返回 + 标题 + 说明 + 占位」，
  与 stats / diagnostics 同一最小形态。运行中要停，去输入卡那颗键（用户刚点过的位置）。

### 2.6 空态（第一次进来看到的）

**空态 = 输入卡 + N 条只写了模型名的空通道。**

```
┌────────────────────────────────────────────────────────┐
│ 想问所有模型同一个问题…                                 │
│                             [对比 3 个模型 ▾]   ( ↑ )   │
└────────────────────────────────────────────────────────┘
   至少选 2 个模型才能开始对比
┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│▍Qwen3-32B    │ │▍Claude Fable │ │▍GPT-5.1      │
│              │ │              │ │              │
│   等待提问    │ │   等待提问   │ │   等待提问    │
└──────────────┘ └──────────────┘ └──────────────┘
```

四条理由，缺一条这个形态就不成立：

1. **它把"这一屏会变成什么"直接画出来** —— 第一次进来就知道这是"N 路作答"，不是"一个对话框"。
2. **选模型这个动作因此有即时反馈**：在菜单里勾第 3 个，第 3 条通道当场出现。
   （这也是**不做**卡内"参赛胶囊"行 的理由：名单已经画在下面了，卡里再来一行是重复。）
3. **与运行态同构**：§4 的骨架逻辑是「使列表到达时是『同一片区域被填上』而不是整块替换」——
   这里更彻底：空态就是运行态的骨架，发问只是把「等待提问」换成队列/等待/正文。
4. **通道的出入不播动画**：加一条淡入就得进 §10.3 登记，而且三列一起淡入像页面在抖。
   四态与内容的切换全是瞬时（§5.8 只在"有退场动画"时才适用）。

**空通道的列体**：`<EmptyState title="等待提问" />`（只给 `title`，不给 `icon` / `description` /
`action`）。用组件而不是手写 div —— 空态要永远只有一处实现。

**「等待提问」不是 §4 意义上的"无数据文案"**：§4 禁的是「数据到达前显示『无数据』」，
而这里是"用户还没有提出请求"，不存在"数据在途中"。这一条与 10-06 那份设计里
A1/A2 逐字相同的判断同源。

### 2.7 用到的 token 与档位（逐个写明为什么取这一档）

| 用途 | token | 为什么是这一档 |
| --- | --- | --- |
| 页面底、输入卡底 | `--bg` | 输入卡是内容卡（§3.7：内容卡 = `--radius-md` + `--bg`），页面底与它同值是既有口径 |
| 通道面 | `--bg-raised` | token 注释原文「抬升面：**次级卡片**、选中底、代码块底」。通道是次级辅助面 → §3.7「一律不带边框」 |
| 排队 chip 底 | `--bg-chip` | token 注释原文「内容 chip 的**静态底色**」。**不用 `--bg-hover`** —— 那是 hover 专用档，只读 chip 不许借 |
| 列头分隔线、输入卡 0.5px 描边 | `--border` | 全站唯一常规边框 |
| 正文 | `--text` | 主文 |
| 耗时、用量、排队 chip、取消行、约束提示 | `--text-secondary` | 次文（次级信息一律这一档；§2.1：降**一档**就是它，不往 `--text-faint` 压） |
| 失败 | `--danger` | 真状态（§2.4），`--warning` 的语义是"连接中/待确认"，用在这里是错的 |
| 通道左缘色条 | `--cat-1..4` | 分类色板 6 槽，最多 4 列 ⇒ 够用。它是**分类**（这一列是谁），不是状态（§2.4），语义正当 |
| 通道内竖向外间距 | `--space-1`(4) 列头两行之间 / `--space-3`(8) 列头项之间 / `--space-4`(12) 通道内左右缩进、栅格列距 / `--space-5`(16) 栅格行距、通道底部留白 / `--space-6`(24) 页面内边距（`.settings-body` 既有）/ `--space-7`(32) 页面底部留白（既有） | 全部是既有档位的既有语义位；**不新增第 8 档** |
| 模型名 | `--text-emphasis`(15) + 字重 600 | 逐字沿用 `.turn-agent`（对话页的发言者身份档）。600 是既有偏离（§3.6）且已有注释 |
| 耗时 | `--text-emphasis`(15) | 逐字沿用 `.turn-duration` 的理由（12px 会把它压成附注） |
| 用量 | `--text-meta`(12) | `.run-metrics` 既有；它是支撑读数，与耗时差一档是有意的层级 |
| 排队 chip、约束提示 | `--text-meta`(12) | 同上 |
| 通道、输入卡、chip 圆角 | `--radius-md` / `--radius-sm` / `--radius-full` | 通道是"卡片"档（与 `.provider-list` 同档）；chip 与小控件 `sm`；无 |
| 输入卡阴影 | `--shadow-input` | 既有输入卡专用档（首页/对话页同值） |
| 菜单层级 | `--z-overlay` | 既有（`.pop-menu` 一族） |
| 列头层级 | `--z-base` | token 注释原文「页面内抬升：刻度轨、**sticky 头**、激活描边」——正对着用 |
| 四态过渡时长/缓动 | `--dur-fast` / `--ease-standard` | §3 统一口径；且**全部落在文件末尾既有的两批共享规则里**（`app.css:10725-10760` 的按下态、`:10892-10990` 的过渡）——本屏不新增交互控件，所以**这两批一条都不用追加** |

**档外但既有、且有据可依的两个数**：`210px`（栅格下限，与 `.model-grid` 的 auto-fill 同值）
与 `2px`（通道左缘色条宽度，与全站焦点环同宽）。都不是新档位。

### 2.8 交互四态 + 键盘可达性 + `prefers-reduced-motion`

**四态：本屏不新增任何需要四态的控件。** 全部按钮（`.bar-btn` / `.mini-btn` / `.send-btn` /
`.send-btn.stop` / `.bar-btn-text.model-chip`）与菜单项（`.model-menu-item`）都是既有类，
四态与过渡都在既有规则里。**验收断言：新增 CSS 里没有 `transition`。**

**通道本体不加 hover 底**：它不是可点面（照 `.provider-list` 那段"行不是跳转面"的既有判断，
`app.css:7326` 的注释）。通道内的正文 hover 浮现的操作条是 `.entry` 自带的既有机制
（`.entry:hover .entry-toolbar-right`，§7.9 合规：`opacity` + `pointer-events`，不是 `visibility`）。

**键盘可达性**：

| 步 | 元素 | 说明 |
| --- | --- | --- |
| 1 | `.bar-btn` 返回 | 全局焦点环（`2px solid --text-secondary`） |
| 2 | 模型多选钮 | 同上；菜单内方向键/Enter 的既有键位照抄 `ModelMenu` 的菜单键位 |
| 3 | 发送 / 停止 | 同上 |
| 4 | 逐列的「取消这一列」（仅运行时） | 同上 |
| 5 | 正文里 hover 浮现的「复制」 | `:focus-within` 也让它浮现（既有），**键盘够得着** |

**不做 `role="status"`**：列头的耗时位每 500ms 刷新一次（`TurnHeader` 的既有节奏），
挂 `role="status"` 会变成**每半秒一条播报**——比不播报糟得多。终态（失败）本身有可见文本
与错误框，屏读用户 Tab 到该列即读到；`aria-label="{模型名} 的对比结果"` 让通道成为
可按名字跳转的 landmark。**这一条是有意为之，不是漏。**

**`prefers-reduced-motion`：不需要任何新增。** 本屏不引入 `@keyframes`、不引入新动画宿主；
用到的动效（`.spinner` / `.text-shimmer`）与整页入场（`page-in`，`.settings` 自带）
都已在 §10.3.1 的四组关停清单里。计时文字每秒变化**不是动画**，与对话页同口径。
验收：确认新增代码里没有 `animation:`。

### 2.9 深浅两套主题（每个新元素都要两套都成立）

| 元素 | 浅色 | 深色 | 结论 |
| --- | --- | --- | --- |
| 通道面 `--bg-raised` | `#f7f7f7` on `#ffffff` | `#26262a` on `#1c1c1e` | ✅ 两套都靠底色区分（§3.7 无边框的前提） |
| 列头底 + 分隔线 | `--bg-raised` + `--border` `#e6e6e6` | `#26262a` + `rgba(255,255,255,.12)` | ✅ |
| 模型名 `.turn-agent` | `--text`（黑） | `rgba(255,255,255,.92)` | ✅ |
| 耗时 / 用量 `.run-metrics` | `--text-secondary`（50% 黑） | 55% 白 | ✅ |
| 通道左缘色条 `--cat-1..4` | `#3b82f6` / `#8b5cf6` / `#ca8a04` / `#0891b2` | `#5b9dff` / `#a487ff` / `#d9a83a` / `#2fb0cc` | ✅ 暗色块已逐槽覆盖（色相不变、提亮） |
| 排队 chip `--bg-chip` | 6% 黑 on `#f7f7f7` ≈ `#e8e8e8` | 10% 白 on `#26262a` | ✅ |
| 失败：耗时 `--danger` + `.state-error` | `#f64041`；底 `danger 8% + #fff` | `#ff6b6c`；底 `danger 8% + #1c1c1e`（比通道更暗） | ✅ 靠 1px `--danger` 描边兜底（见 D1） |
| 空态 `.state-empty` | `--text-secondary` | 同 | ✅ |
| `.stream-pending` / `.text-shimmer` | `--shimmer-color: --text-secondary` | 同（token 派生） | ✅ |
| `.user-cancelled` | `--text-emphasis` + `--text-secondary` | 同 | ✅ |
| 输入卡（槽渐变 + 0.5px 描边 + `--shadow-input`） | 既有 | 既有（暗色版已接线） | ✅ 零改动 |

`npm run check:theme-tokens` 对本设计**不需要任何新条目**：没有新增颜色 token，
也没有 token 块之外的颜色字面量（连 `color-mix` 都只在既有声明里）。

### 2.10 与 §3.9 盒子预算的关系

**这一屏有 1 个「内容卡级的主盒子」**：输入卡（`.composer-card`，唯一白底 + 唯一
`--shadow-input` + 唯一的渐变槽）。

**N 条通道不是盒子层的叠加，是同一个次级面上的 N 份**（`--bg-raised`、无边框、无阴影）。
其余元素要么是细边 chip（排队）、要么是纯排版（模型名、耗时、用量、空态、取消行）。

这条不是审美偏好而是"没有视觉重点"的处方：如果通道做成 N 张白卡细边盒，这一屏就有
5 个同重的盒子，输入卡不再是对焦点，整页会读成"没做完"。**灰面承载 N 路回答、白卡承载
唯一的问题**，是这个屏一眼就成立的层级。

**加新盒子之前先问「能不能不加」**（本次已经因此砍掉三样：卡内参赛胶囊行、空态三行说明面、
菜单里的常驻"最多 4 个"脚注 —— 三样都在 §五列了理由）。

### 2.11 完整 CSS 草案（可直接抄进 `app.css` 末尾附近）

```css
/* ── 模型对比（spec: 10-07-multi-model-compare）─────────────────────
 * 盒子预算：一个内容卡级主盒子（输入卡，既有 .composer-card）+ N 个次级面（通道）。
 * 新类名只有 3 个，各自都写下「为什么既有类不够」；其余全是既有类的作用域覆盖。
 * 本屏不新增 token / 档位 / 颜色 / 动画 / 布局属性过渡（§5.1 默认禁止）。
 */

/* 整页壳用 .settings（stats / diagnostics / automations / library 同款）。
   两条覆盖：900px 是设置页的阅读列宽口径，本屏内容是 N 列通道；
   容器查询锚在"可用宽度"上（侧栏开合会改它，窗口宽是另一个量）。 */
.settings-body[data-compare] {
	max-width: none;
	container-type: inline-size;
}

/* ① N 列栅格：列数 = 参与模型数（2–4）。 */
.compare-grid {
	display: grid;
	/* 行距 > 列距：输入行 → 通道行是「控制 → 结果」的分组边界，通道之间是同级并排。 */
	gap: var(--space-5) var(--space-3);
}

.compare-grid[data-cols="2"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.compare-grid[data-cols="3"] { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.compare-grid[data-cols="4"] { grid-template-columns: repeat(4, minmax(0, 1fr)); }

/* 输入区 = 第 0 行：它与 N 条通道共用同一条栅格线（对齐不是巧合）。 */
.compare-grid > .composer-zone { grid-column: 1 / -1; }

/* 窄容器折列：容不下「每列 210px」时折成 2 列（210 与 .model-grid 的 auto-fill 下限同值）。
   折成 2 列而不是 1 列 —— 1 列就不再是"并排"。
   n=2 不写规则：最窄可用宽 ≈ 900 − 264 − 48 = 588 > 2×210+12 = 432，那条规则是死的。 */
@container (max-width: 880px) {
	.compare-grid[data-cols="4"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@container (max-width: 660px) {
	.compare-grid[data-cols="3"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

/* ② 单条通道（次级面）：§3.7 —— 抬升面一律不带边框，边框是内容卡的身份。 */
.compare-col {
	display: flex;
	flex-direction: column;
	/* 长模型名 / 长 URL / 长代码行不得把列撑宽（.case-grid 记录过同类事故）。 */
	min-width: 0;
	padding-bottom: var(--space-5);
	background: var(--bg-raised);
	border-radius: var(--radius-md);
	/* 左缘 2px 分类色条（这一列是谁）。不用 border-left —— 它占布局宽度，
	   会把栏内文字的 12px 缩进推成 14px，与输入卡边缘错开 2px；inset 阴影不参与布局。
	   色号由每列内联给出：style={{ "--lane-accent": `var(--cat-${i + 1})` }}。 */
	box-shadow: inset 2px 0 0 var(--lane-accent, var(--cat-1));
}

/* ③ 列头：身份 + 耗时 + 每列动作（第一行），用量读数（第二行）。 */
.compare-col-head {
	display: flex;
	flex-wrap: wrap;            /* 让 width:100% 的用量行换到第二行，不必再套一层 div */
	align-items: center;
	column-gap: var(--space-3);
	row-gap: var(--space-1);
	padding: var(--space-3) var(--space-4) var(--space-2);
	border-bottom: 1px solid var(--border);
	border-radius: var(--radius-md) var(--radius-md) 0 0;
	/* 吸附：滚进长答案时身份与计时仍在。
	   z-index 必需 —— .entry 是 position: relative（正文操作条的锚点）且是本行的
	   后绘兄弟，不给列头抬升就会被正文盖住。层级取 --z-base（它的注释原文就写着
	   "页面内抬升：刻度轨、sticky 头、激活描边"）。 */
	position: sticky;
	top: 0;
	z-index: var(--z-base);
	background: var(--bg-raised);   /* 必须不透明：正文要从它下面滑过 */
}

/* 用量独占一行 → 四列的用量落在同一条水平线上（横向可比是本屏的全部意义）。 */
.compare-col-head .run-metrics { width: 100%; }

/* 模型名可能很长（org/model-name:tag）：.turn-agent 今天一条溢出处理都没有
   （对话页的发言者是常量 "ZeroWork"，永远不会溢出）。 */
.compare-col-head .turn-agent {
	flex: 0 1 auto;
	min-width: 0;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}

/* 失败列的耗时用状态色（§2.4：只有真状态用状态色）。
   完成态**不用** --ok：四列同时变绿是噪声，且文字已经写着"已完成"（§2.1）。 */
.compare-col[data-status="failed"] .turn-duration { color: var(--danger); }

/* 排队 chip 落在抬升面上：.stream-queue 的 --bg-raised 底在这里等于没有底。
   按 token 自己的语义换成"内容 chip 的静态底色" --bg-chip
   （--bg-hover 是 hover 专用档，只读 chip 不许借它）。 */
.compare-col .stream-queue {
	margin-inline: var(--space-4);
	background: var(--bg-chip);
}

/* 通道内的独立状态块与正文同一条 12px 缩进线
   （正文的 12px 来自 .entry.assistant 自带的 padding: 0 var(--space-4)）。 */
.compare-col > .stream-pending { padding: 0 var(--space-4); }
.compare-col > .state-error { margin: 0 var(--space-4) var(--space-3); }
```

**新增声明共 9 条**（不含注释），其中 6 条是纯布局、3 条是引用既有 token 的覆盖面；
`app.css` 末尾那两批共享的四态/过渡规则**一条都不用追加**（本屏不新增交互控件）。

### 2.12 实现时**必须**处理的既有耦合（都是"会出真 bug"的项）

| # | 项 | 要求 |
| --- | --- | --- |
| 1 | 逐列只渲染**助手**的 entry | 列内不出现用户那条问题（4 列各显一遍是纯噪声；问题属于页面上方的输入卡） |
| 2 | 逐列**不渲染** `TurnHeader` | 身份搬进列头；不渲染就不会出现 4 个 ZeroWork 头像 |
| 3 | 操作条传 `branchable: false`，不传 `onRestart` / `onBranch` | 否则「重新开始」「分支出新会话」出现，与"不进会话"的承诺当场矛盾（`app.js:31841` 的判据是 `target !== undefined && branchable`） |
| 4 | 保留 `useImeGuard` | 中文产品必需（`app.js:68320` 明文：「输入法组合期间不响应 Enter / ↑ / ↓」）。**不复用 `Composer` 组件本体**（它绑草稿持久化 / @ / 补全 / 图片粘贴 / 字符上限 —— 本屏没有附件与技能引用），但要复用它的**键位口径**与这个守卫 |
| 5 | 停止键沿用 `stopConfirmIdle` | 一次点击只 arm，二次确认/`Esc` 才真的取消（`.send-btn.stop` + `.stop-confirm-kbd`） |
| 6 | 菜单三态照抄 | `ErrorState` / `LoadingState` / `.model-menu-goto`「去设置里填 API Key →」（`app.js:15068-15085`）——§4 的三态因此是免费的 |
| 7 | 计时与用量在渲染层**按列自算** | 这是 `feasibility.md` 坑①②③的落点（必须绕开 `emitSessionEvent` 与 `ObservabilityStore.currentRun` 单槽）；列头读的就是这两个本地累计值 |
| 8 | 折列的容器查询要实测 sticky | 见 §2.2 B 的告警与兜底方案 |
| 9 | 整轮起不来（daemon 拒绝 / 额度） | 走既有 toast：`对比没能开始：{原因}`（与首页「接入失败」同一条通道），**不**在通道区摆一块错误框（那时还没有"哪一列"可言） |

---

## 三、文案（最终中文，可直接抄进实现）

### 页面与输入区

| 位置 | 文案 |
| --- | --- |
| 视图标题（`h1`） | `模型对比` |
| 头部说明（常驻，`settings-hint`） | `只问答：不跑工具、不动文件、不进历史、不计入统计` |
| 输入框 placeholder | `想问所有模型同一个问题…` |
| 模型钮（已选 ≥2） | `对比 {n} 个模型` |
| 模型钮（已选 0–1） | `选择对比模型` |
| 模型钮 `title`（运行中） | `这一轮已经开始，下一轮可以改` |
| 发送键 `aria-label` | `开始对比` |
| 停止键 | 既有：`aria-label="停止"` / `title="停止生成"` → arm 后 `再按一次确认停止` / arm 徽章 `Esc` |
| 卡下约束（已选 <2） | `至少选 2 个模型才能开始对比` |
| 菜单空态 | 既有：`去设置里填 API Key →` |
| 菜单读取中 | 既有：`正在读取模型…` |

### 通道

| 状态 | 列头（耗时位） | 列体 |
| --- | --- | --- |
| 空（还没发问） | 只有模型名，无耗时位 | `等待提问` |
| 排队中 | `排队中` | `.stream-queue` chip：`排队中` |
| 流式（首 token 未到） | `已处理 {n}s` | `等待模型响应…`（既有串 + 既有扫光） |
| 流式（出字中） | `已处理 {n}s` | 正文 |
| 已完成 | `已完成 {n}s` | 正文 |
| 失败 | `失败 {n}s` | `{daemon 给出的原因}` + 按钮 `重试` |
| 已取消 | `已取消 {n}s` | 已产出的正文 + 末尾 `已取消` |
| 每列动作 | `取消这一列`（`aria-label` 与 `title` 同文） | — |
| 通道 `aria-label` | `{模型名} 的对比结果` | — |

### 拒绝与失败

| 场景 | 文案 |
| --- | --- |
| 已选 4 个时点第 5 个（toast） | `最多同时对比 4 个模型 —— 先在菜单里移除一个，再加新的` |
| 整轮没能启动（toast） | `对比没能开始：{原因}` |
| 某一列失败 | **只有** daemon 的真实原因 + `重试`。**不写「其它列不受影响」**（理由见 §五） |

`{n}s` 一律走既有的 `formatDuration$1`（`app.js:32354`，输出 `12s` / `1m2s`）；
用量一律走既有 `RunMetricsBar` + `formatTokenCount`（`1.2K` / `1.4M`）。
**不要在对比视图里另写一套格式化** —— 否则同一个数在两个页面显示成两种写法。

### ⌘K 的一条动作

| 字段 | 值 |
| --- | --- |
| `id` | `action:compare-models` |
| `title` | `对比多个模型` |
| `subtitle` | `同一个问题，并排问 2–4 个模型` |
| `keywords` | `["对比", "多模型", "并排", "比较", "compare", "multi"]` |
| `kind` | `action`（既有图标 `IconArrowRight`，零新增） |

### 输入卡的模型菜单里那条入口

| 位置 | 文案 |
| --- | --- |
| 模型菜单底部（`.model-menu-goto`） | `对比多个模型…` |

与既有那条 `去设置里填 API Key →` 同位置、同形态（`.model-menu-goto`，`app.js:15080`），
点击后进入本屏并把当前会话模型预选为第一个参赛模型。

---

## 四、Top 5 视觉提案（按「视觉冲击力 / 成本」排序）

1. **N 列同时逐字流式 + 各自跳动的耗时（承担「第一眼」）** —— 冲击力 ★★★★★ / 成本 ≈0。
   它就是功能本身：四列同时出字、四个计时器各走各的、谁先答完一眼可见。
   这一处**不需要任何新增样式**（`.turn-duration` 的 `tabular-nums` 已经在防"每秒抖行宽"）。
   截图能不能传播，全看这一帧。
2. **空态就是 N 条只写了名字的空通道** —— ★★★★★ / 成本 ≈0。第一次进来的那一屏：
   用户立刻就懂"这是 N 路作答"，而且在菜单里勾一个就当场多一条通道。
   （用 `EmptyState` + 既有通道样式，零新样式。）
3. **通道左缘的 2px 分类色条** —— ★★★★ / 成本 1 条声明 + 1 个内联变量。
   白卡 + 4 条彩色赛道的构图一眼可读；滚到长答案中段也认得出是哪条通道。
   色号直接复用 `--cat-1..4`（6 槽装 4 列，深浅两套现成）。
4. **用量读数落在同一条水平线上** —— ★★★★ / 成本 0（把既有 `RunMetricsBar` 搬进列头 +
   一条 `width: 100%`）。这是"并排可比"这件事的视觉证明：
   四组 `↑ ↓` 对齐成一行，读起来就是一张对比表而不是四段各自的脚注。
5. **失败列的孤立红框** —— ★★★ / 成本 0。三列继续跳字、只有一列的列头变红、
   列体是一块 `--danger` 描边的错误框 + 「重试」。产品承诺"一列失败不影响其它列"
   靠这一帧自证，不需要文字解释。

---

## 五、明确不做

| 想法 | 理由 |
| --- | --- |
| 给通道做「排名 / 冠军 / 最快」标记 | 快 ≠ 好。本功能的产品定位是**看清差异**，不是判胜负；一个冠军徽章会把"哪个答案更好"这个判断替用户下了 |
| 逐列独立滚动容器（Msty 式） | ① 嵌套滚动容器 + 滚轮捕获；② 一旦某一列被单独滚动，四列的横向对齐**永久错位**——而"同一位置横向对照"正是并排的唯一好处；③ 仓库的滚动基线（`scrollbar-gutter: stable`）是按"单一滚动容器"写的 |
| 列头吸附时加浮动阴影 | 一加阴影它就从"表头"变成"浮层"，与通道是同一个面的事实矛盾。底色 + 1px 分隔线够了 |
| 失败时把通道左缘色条改成红色 | 色条是**分类**（这一列是谁），`--danger` 是**状态**（这一列怎么了）。压在同一条通道上，失败之后这条通道就丢了身份 |
| 在失败列里写「其它列不受影响」 | 这是**视觉**该承担的事（其它列还在跳字）。写成文字是用一句自我辩解代替设计，而且会与 daemon 的真实原因抢同一行 |
| 空态摆一块三行说明面（"怎么用 / 边界 / 出口"）或插图 | §3.9 盒子预算：本屏唯一的内容卡是输入卡。"怎么用"由 placeholder 与空通道承担，"边界"由头部那一行常驻说明承担——已经是三处各自最合适的位置 |
| 卡内再加一行"参赛模型胶囊" | 名单已经画成 N 条通道了，卡里再来一行是同一件事说两遍；而且可点胶囊必然带 hover 与移除交互，成本翻倍 |
| 菜单里放一行常驻的「最多 4 个」脚注 | 既有没有"不带 hover 语义"的菜单脚注类（`.model-menu-goto` 是个按钮，`div` 用它会在 hover 时变亮 = 谎）；为一行说明新造类或加作用域覆盖都不划算。上限在**越界那一刻**用 toast 说更及时 |
| 给通道做入场动画 / 数字滚动 / 呼吸点 | 要进 §10.3 登记，收益为零；四列一起淡入读起来像"页面在抖" |
| 移植 `--chat-content-width` 的 832 上限 | 那一档是"单列阅读"的口径（对话页 + 输入卡）。本屏列宽由参与模型数与可用宽度裁决，套 832 会让 4 列在宽屏上挤在中间、两侧空一大片 |
| 复用 `Composer` 组件本体 | 它绑了草稿持久化、@ 文件补全、/ 技能补全、图片粘贴、字符上限——本屏没有附件也没有技能引用。只复用它的**类名、结构与键位口径**（外加 `useImeGuard`，那条是中文产品必需） |
| 改既有 `ModelMenu` 支持多选 | 它的 `pick` 直连 `window.kami.setModel`，是**会话级单模型**的权威写入点。把多选做进去会污染默认路径（`feasibility.md` 明确不建议） |
| 把对比做成右侧面板的第 4 种内容（`panelContent === "compare"`） | 面板是**让位栏**，栏宽（默认 ~440）装不下 3–4 列；它需要的是全屏，不是让位。`feasibility.md` 也把这条列为"稍大一点"的备选，本设计取全屏 |
| 发问后把输入卡折叠成一行摘要 | 多一个折叠态要设计，且折叠后改问题要两步。本屏输入卡在上、通道在下已经够用（§2.6 的空通道还依赖它在位） |
| 逐列做"收进会话 / 存为对比记录" | v1 范围外（`prd.md` 的最小可用形态只做 A 半；B 半的"收进会话"是第二批），且它需要动会话文件与侧栏，与本屏"不进历史"的承诺是两件事 |
| 在本屏渲染用户那条问题（每列一遍） | 问题属于页面上方的输入卡。4 列各显示一遍问题是纯噪声，还会把"同一问题"这个前提视觉上稀释 |
| 让通道高度跟随各自内容（不等高） | 等高是"这是一张对比表"的形态基础；不等高时四列的正文起点相同、终点参差，读起来像四个独立卡片。栅格的 `align-items: stretch` 免费给到，别关 |
| 给列头加 `role="status"` | 耗时位 500ms 刷一次，屏读会变成每半秒一条播报。终态有可见文本，Tab 到该列即可读到（§2.8） |
| 新造 `.compare-*` 类名族（body / row / status / usage / actions …） | 只留 3 个（grid / col / col-head），其余全部落在既有类上；族越大，越难在下次改动时判断"这个类是不是可以删" |

---

## 附：验收时应当能一眼核对的清单

- [ ] 新增 CSS 里的新类名**只有 3 个**（`.compare-grid` / `.compare-col` / `.compare-col-head`）
- [ ] 新增代码里**没有** `@keyframes`、**没有** `animation:`、**没有** `transition:`
- [ ] `docs/DESIGN.md` §5 的例外表**一字未改**；`npm run check:design-exceptions` 通过
- [ ] `npm run check:theme-tokens` **无新增条目**即通过（无新颜色 token、无块外颜色字面量）
- [ ] 这一屏内容卡级主盒子**只有 1 个**（输入卡）；通道无 `--border`、无 `--shadow-*`
- [ ] 4 个模型的截图里，四组 `↑ ↓` 用量**落在同一条水平线上**
- [ ] 某一列失败时，**只有那一列**出现 `--danger`（其它三列的耗时仍是 `--text-secondary`）
- [ ] 失败列里**不出现**「重新开始 / 分支出新会话」（传了 `branchable: false` 的反向验证：
      去掉它，这两个按钮必须出现 = 用例变红）
- [ ] 中文输入法组合期间按 Enter **不发送**（反向验证：去掉 `useImeGuard`，必须有一条用例变红）
- [ ] 窄窗口（900 + 侧栏展开）下 4 列折成 **2×2**，每列 ≥ 210px（14px 正文不挤成 10 字/行）
- [ ] 滚动长答案时列头**吸附**可见（若失效，见 §2.2 B 的兜底，**不要**新造第三套机制）
- [ ] `prefers-reduced-motion: reduce` 下：无新增动画需要关停；列头吸附、文字与计时照常
- [ ] 深浅两套截图各两张（空态 + 4 列完成态），逐项过 §2.9
- [ ] ⌘K 里能搜到「对比多个模型」，执行后进入本屏且当前模型已预选
- [ ] 输入卡的模型菜单里「对比多个模型…」与「去设置里填 API Key →」同位置同形态
- [ ] 已选 4 个时点第 5 个：**不进入选中**，且出现 toast（不是静默失败）