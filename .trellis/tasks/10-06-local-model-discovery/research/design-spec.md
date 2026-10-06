# 本机模型服务：两处界面的设计规范

> 面向实现（可落到 CSS / JSX 级别）。依据：`docs/DESIGN.md`（§2 档位 / §3.7 次级面 / §3.9 盒子预算 /
> §4 三态 / §6 禁止清单 / §7.6 状态不只靠颜色 / §7.9 hover 控件）、`.trellis/spec/renderer/index.md`、
> `src/renderer/src/app.css`（token 单一真源）、`artifacts/design-review/` 的三张截图
> （`home-light-empty.png` / `home-dark-empty.png` / `settings-model-light.png`）、
> 任务内的 `prd.md` 与 `research/model-access.md`（尤其 §Z-1 那条「不写凭据会直接跑不通」）。
>
> **本文不新增任何 token、不新增任何视觉档位、不新增任何颜色。**

## 0. 一句话结论

- **首页那处不加盒子、不加类名、不加 loading** —— 命中时只在既有 `.home-guide` 的次级面里换一行文案与一个按钮，
  未命中时**一字不改**（探测中是"看不见"的状态）。
- **设置页那处不新造类名族** —— 整块照抄「服务商」区的行语言（`.provider-list` / `.provider-row` /
  `.provider-main` / `.provider-dot` / `.provider-name` / `.provider-meta` / `.bar-spacer` / `.mini-btn`），
  新区块看起来应当像"一直就在那儿"。
- **唯一需要动的 CSS 是两处既有名的追加**：给从未被引用的死类 `.settings-hint` 补一条 margin；
  把 `.home-guide-row-action` 加进既有的「按下加深底色」名单与过渡名单。两处都只引用既有档位。

---

## 一、诊断

### 首页上手清单（`OnboardingChecklist`，`app.js:15195`；渲染 `15276-15317`；样式 `app.css:2124-2190`）

**D1【P1】第 2 步的动作落点与它对用户承诺的事不匹配。**
`guideText()`（`app.js:15165`）只有两种说法，判据 `judgeModelReadiness()`（`app.js:15159`）**只看
`model.available`**，与"本机有没有现成的服务"完全无关；`rg '11434|Ollama' src/` 全仓仅 1 处命中
（`app.js:63540` 的一句 hint 文案）。后果：一个已经跑着 Ollama 的用户，在首屏看到的是
「还没有选定要用哪个模型 → 去选一个模型」，点进去落在 `settings("models")`，
页面顶部是 1495 张云端模型卡（见 `settings-model-light.png`）。**他知道答案才填得对 —— 这正是要替他做的事。**
这就是本任务要解决的问题本身。

**D2【P0 / 交互，非视觉】整行可点 + 行内按钮 = 同一个动作触发两次。**
`app.js:15286-15312`：行 `<div role="button" tabIndex=0 onClick=row.go onKeyDown=Enter/Space→row.go>`，
行内又是 `<button className="mini-btn" onClick=row.go>`。
- 鼠标点按钮：按钮的 click 触发 → 冒泡到行 → 行 click 再触发一次；
- 键盘在按钮上按 Enter/Space：按钮原生 click + keydown 同样冒泡到行 → 行 `onKeyDown` 再触发一次。

今天无害（`onOpenSettings` 幂等）。**一旦这个动作变成「写配置 + 选中模型」，它就会并发跑两遍。**
必须在实现里消除（见 §2.1 F 项）。

**D3【P2】整行可点，但按下去没有任何反馈。**
`.home-guide-row-action`（`app.css:2155`）只有 hover 底（`--bg-hover`），**不在**
`app.css:10820-10854` 那批「整行可点 → 按下加深一档底色」的名单里。缺按下反馈会让人怀疑"没点上"从而连点 ——
与 D2 叠加成真实的重复写入风险。「接入」是有后果的一次性动作，这个缺口应当补（代价：见 §2.1 G 项，2 行）。

**D4【不是问题】清单的视觉层级与节奏。**
`--bg-raised` 次级面、无边框（§3.7）、待办行 13px `--text-list`、行距 `--space-3`、
`--accent` 只给未完成行的图标（`app.css:2124-2190` 的注释逐条写了来由）；
`home-light-empty.png` 与 `home-dark-empty.png` 对比看，深色下清单与输入卡的层次由
`#26262a` vs `#1c1c1e` 承担，未塌陷。**本任务不新增盒子、不改字号、不改间距、不动 `.home-guide` 的任何既有声明。**

**D5【P2 / 观察项，本轮不改】清单读取失败时整块消失。**
`app.js:15222`：`if (error !== undefined || snapshot === undefined || ...) return null;`
—— 失败、加载中、空三者都渲染成"什么都不显示"。与 §4「错误就地呈现，并给出重试动作」不符；
用户读成"这个应用没有引导"，而不是"读不到"。**与本任务无关的既有缺陷，建议另开 Issue。**
本轮不动它的理由：修它就要在首屏加一块错误框，与 §3.9（唯一视觉重点是输入卡）冲突，需要单独权衡。

### 设置 → 模型（`ModelsSection`，`app.js:64213`）

**D6【P1】页面上没有任何「本机」入口。**
两个既有区（「当前模型」/「服务商」）**都只表达"已经配置了什么"**：一个是已可用模型的网格，
一个是已配置服务商的行列表。用户装了 Ollama 时，`settings-model-light.png` 整页找不到任何东西告诉他
「它就在 `127.0.0.1:11434`」。这就是要新增的区块解决的问题（PRD R4）。

**D7【不是问题】「服务商」区的行语言已经够用。**
`.provider-list`（盒）+ `.provider-main`（行）+ `provider-dot` / `provider-name` / `provider-tag` /
`provider-meta` / `.bar-spacer` / 右侧 `.mini-btn` —— 已经能完整表达「一个服务 + 它的状态 + 一个动作」。
新区块**照抄这套行语言**，一个字都不新造。

**D8【不是问题】`.settings-hint` 是一个死类。**
`app.css:8817` 定义（`--text-meta` + `--text-secondary` + `font-weight: 400`），
`grep -rn settings-hint src/renderer/` **只有定义处**、全仓零引用。
它的语义（设置页内的说明文字）正好是"隐私边界那一句"要的东西。**复用它，而不是新造 `.local-service-note`。**

---

## 二、设计规范

### 2.0 共同约束（先说三条决定的边界）

**（1）零新增 token / 零新增档位 / 零新增颜色。** 全文只引用：
颜色 `--bg` `--bg-raised` `--bg-hover` `--border` `--text` `--text-secondary` `--accent` `--ok` `--danger`；
间距 `--space-1`(4) `--space-2`(6) `--space-3`(8) `--space-4`(12) `--space-5`(16) `--space-6`(24)；
字号 `--text-meta`(12) `--text-list`(13) `--text-body`(14)；
圆角 `--radius-sm`(6) `--radius-md`(10) `--radius-full`；
时长 `--dur-fast`(150ms)；缓动 `--ease-standard`；阴影 `--shadow-md`（只在既有组件内部，不新写）。

**（2）盒子预算（§3.9）：首页那处一个新盒子都不加。**
首页主列的"唯一内容卡"是输入卡。命中时第 2 步的改动发生在**既有 `.home-guide` 这个次级面内部**
（换文案 + 换按钮文字），**盒子的数量、位置、尺寸一个都没变**；未命中时更是零变化。
设置页那处新增的是**同级的第二个列表区**，与「服务商」的 `.provider-list` 同一种盒子语言
（`--radius-md` + `--border`，§3.7 的内容卡级别）——它不是"新开一个盒子层"，而是"同一类区多了一个"。
而且它**在未命中/首次探测时只渲染一句话或一段骨架**，页面盒子数只在"真有东西可接"时才 +1。
一个页面两个列表区，与「服务商 + 当前模型」今天的形态同级，不违反盒子预算。

**（3）本设计不引入任何新动画，§10.3.1 的关停清单不需要新增条目。**
无新 `@keyframes`、无新的一次性入场、无新时长档。验收断言：新增代码里不得出现
`animation:` / 非 `--dur-fast` 的 `transition:`。

---

### 2.1 ① 首页上手清单的第 2 步

#### A. 状态表（`OnboardingChecklist` 的 `rows[1]`）

| # | 状态 | 判据 | 行文案（`.home-guide-text`） | 右侧动作 | 图标 |
| --- | --- | --- | --- | --- | --- |
| A1 | 未命中 | 探测结果里没有任何"可达且有 ≥1 模型"的候选 | `还没有选定要用哪个模型` | `.mini-btn`「去选一个模型 →」 | `IconKey`（`--accent`） |
| A2 | 探测中（首屏异步，未回来） | 探测 promise 未 settle | **同 A1，逐字相同** | 同 A1 | 同 A1 |
| A3 | 命中但零模型（全部候选都 reachable 且 0 模型） | 见 A4 的选取规则取不到 | **同 A1，逐字相同** | 同 A1 | 同 A1 |
| A4 | 命中 | 存在 reachable 且 `models.length > 0` 的候选 | `本机 {label} 正在运行（{n} 个模型）` | `.mini-btn`「接上 →」 | `IconKey`（`--accent`） |
| A5 | 接入中 | 本次接入的 pending 标志为真 | 同 A4 不变 | `.mini-btn` disabled「接入中…」 | 同 A4 |
| A6 | 已接入（且已选定） | `judgeModelReadiness(...).kind === "ready"` | `已选定可用模型` | **无按钮** | `IconCheck`（`--text-secondary`） |
| A7 | 接入失败 | 接入 promise reject | 回到 A4 | 回到 A4（可再点） | 同 A4 |

**A2/A3 与 A1 逐字相同是有意的，且不违反 §4。**
- §4 的禁令是「**数据到达前不得显示「无数据」类文案**」。A1 的「还没有选定要用哪个模型」不是"本机服务的无数据文案"，
  它是 `judgeModelReadiness()` 已经拿到的**确定事实**（`snapshot.models` 早已回来），与探测无关。
- 首屏**不得**出现「正在探测本机模型服务…」这类 loading 行：探测结果没回来时这一步显示现在的样子，
  回来后**原地更新**。理由：绝大多数用户本来就没有本机服务，一句 1 秒后自我撤销的加载文字，
  会在 95% 的用户首屏上凭空制造"页面在加载什么"的错觉 —— 而 §3.9 要求首屏只有一个视觉重点是输入卡。
- 原地更新**不加任何入场动画**（要加就得进 §10.3 登记，收益为零，且会让首屏"跳出一样东西"）。

**A4 的选取规则（必须写死，否则多服务时行为不确定）**：在所有"可达且模型数 > 0"的候选里，
取**模型数最多**的一个；并列时取候选表顺序靠前的一个（稳定、可预期）。
这条与设置页的排序规则（§2.2 C 项）**同源** —— 首页推荐的那条，永远是设置页列表的第一行。

**A4 的行文案**：`label` 只写**服务自己的名字**（`Ollama` / `LM Studio` / `vLLM` / `LocalAI` / `Jan`），
「本机」二字由界面承担。所以是「本机 Ollama 正在运行（4 个模型）」而不是「本机本机 Ollama…」。
（对照：写进 models.json 的 provider `name` 用「本机 Ollama」—— 它要在「服务商」列表里与云端服务商并列，
需要自我说明。**两个字段分工不同，不要统一。**）

按钮文案固定 `接上 →`，**不写服务名**（「接上 Ollama →」被否）：服务名长短不一（`LM Studio` 9 字符），
会把按钮宽度撑得浮动，反过来挤压 `.home-guide-text` 的换行位置；而服务名就在按钮左边同一行，不存在歧义。

**A6 无按钮、图标换对勾**：这就是现状的 done 形态，**零新增**（`app.js:15296` 的 `row.done ? IconCheck : row.icon`）。
注意 done 行不挂 `.home-guide-row-action`，因此图标自动从 `--accent` 回到 `--text-secondary` —— 既有机制，不用管。
另外注意：**用户已经有可用模型时（例如已配好 Anthropic），这一步本来就是 done，即使本机 Ollama 在跑也不会出现「接上」**
—— 因为"模型这一步"已经完成了。这条不用额外写代码，`judgeModelReadiness` 天然保证。

#### B. 为什么图标仍然是 `IconKey`

行图标是**步骤的身份**（工作空间 = `IconWorkspace`、模型 = `IconKey`、消息 = `IconSend`），
不是"用哪种方式接入"的说明。同一个步骤不该因为换了接入路径就换一张脸。
（曾考虑命中时换成 `IconTerminal` / `IconDatabase` 表达"本机"——**否**，见 §五。）

#### C. 交互四态

| 态 | 行 | 行内按钮 |
| --- | --- | --- |
| normal | 透明底 | `.mini-btn`：`--bg` 底 + `--border` 描边 |
| hover | `.home-guide-row-action:hover` → `background: var(--bg-hover)`（**既有**，`app.css:2160`） | `.mini-btn:hover:not(:disabled)` → `--bg-hover`（**既有**） |
| active | **新增**：`.home-guide-row-action:active` → `background: color-mix(in srgb, var(--text) 8%, transparent)`（与 `app.css:10848` 那批整行可点控件**同一个值**，不新造） | `.mini-btn:active:not(:disabled)` → `transform: scale(0.98)`（**既有**，`app.css:10757` 名单） |
| focus | 全局 `[role="button"]:focus-visible`（`app.css:852-858`）→ `outline: 2px solid var(--text-secondary); outline-offset: 2px`（**既有**，行已有 `role="button"`，自动生效） | 全局 `button:focus-visible`（同上） |
| disabled | **不设行级禁用**（见下） | `.mini-btn:disabled` → `color: var(--text-secondary)`（**既有**）；文案「接入中…」 |

**接入中为什么不把整行灰掉**：`.home-guide-row-action .home-guide-icon` 的 `--accent` 是挂在**行类**上的，
一旦摘掉行类，图标会同步掉回 `--text-secondary` —— 读成"这一步停了"，方向是错的；
而给"接入中"再加一个类名会让这一步在 1 秒内闪一次残废态，比保持原样更差。
重复触发由 **F 项的守卫**消除，不靠视觉禁用。**因此接入中的唯一视觉变化是按钮文案与 disabled 色。**

#### D. 键盘可达性

现状已具备：行进 Tab 序（`tabIndex: 0`）、Enter/Space 走 `onKeyDown`，焦点环由全局规则给到。
**不新增任何焦点样式**（§7.1：焦点指示用 `--text-secondary`，与全局同色 —— 已经如此）。
新增的**唯一**义务是 F 项：让同一动作在"行 + 按钮"两条路径上**只跑一次**。

#### E. `prefers-reduced-motion`

**不需要管。** 本处不引入任何动画；`--dur-fast` 的过渡由既有名单承担，已在 §10.3.1 的语境之外
（第 ④ 组只关过渡型入场，本处不是入场）。验收时确认没有新 `@keyframes` 即可。

#### F.【必做】消除双触发 —— 两条一起做

1. **动作函数内加进行中守卫**（必需，兜住"行 + 按钮"两条路径、兜住连点）：
   ```js
   if (pendingRef.current) return;      // 接入进行中：忽略任何再次触发
   pendingRef.current = true;
   try { … } finally { pendingRef.current = false; }
   ```
2. **行内按钮的 onClick 加 `event.stopPropagation()`**（推荐，消除同一次鼠标点击的二次冒泡；
   仓库已有先例：`ModelCard` 里「测试」按钮就是这么写的，`app.js:63863`）。
   只做第 2 条不够 —— 键盘在按钮上按 Enter 时，keydown 仍会冒泡到行的 `onKeyDown`。

#### G.【P2 / 2 行】补上按下反馈

把 `.home-guide-row-action` 追加进两处既有名单（**只追加选择器，不改任何值**）：
- `app.css:10820-10850` 那批的末尾（`background: color-mix(in srgb, var(--text) 8%, transparent)`，`.timeline-row.clickable:active` 之后）；
- `app.css:10853` 起那批「有状态变化的交互类统一在这里声明过渡」的末尾（走 `--dur-fast` + `--ease-standard`）。

#### H. 接入失败落在哪

**走 `HomePage` 既有的 `onError` 通道**（`app.js:16082` 已是 `HomePage` 的 prop，`16272` 已传给 `PermissionMenu`；
源头是 `showToast`），文案：`接入失败：{原因}`。
- 为什么不是就地一块错误框：首页往里塞 `ErrorState`（带 `--danger` 描边的盒子）会在**无边框的次级面里嵌一个带边框的盒子**
  （§3.7：次级面一律不带边框，边框是内容卡的身份），并且会把首屏注意力从输入卡上拽走（§3.9）；
- 为什么不新增一个 `.home-guide-note.danger`：为了 2.2 秒的瞬时反馈新造一个色值用法不划算；
- 为什么会话级失败（`OnboardingChecklist` 自己拉 snapshot 失败）不在这里处理：那是 D5，另开 Issue。

---

### 2.2 ② 设置 → 模型 → 「本机模型服务」

#### A. 位置与结构

新建一个 `settings-section`，插在**「当前模型」之后、「服务商」之前**：

> 当前模型（我在用什么）→ 本机模型服务（这台机器上现成的）→ 服务商（全部可配的来源）

理由：它是一块**动作**区（"你要接哪个"），不是**记录**区（"你已经配了哪些"）。
塞进「服务商」区内部（用 `.settings-subhead`）会让「已配置」与「可接入」两种语义混在同一个列表里，
并且拿不到自己的 `.settings-section-head` —— 而头部需要一个「重新探测」按钮（与「当前模型」头的
「刷新模型目录」是同一位置、同一形态的既有做法）。

```jsx
<section className="settings-section">
  <header className="settings-section-head">
    <h2>本机模型服务</h2>
    <button type="button" className="mini-btn" disabled={probing}
            onClick={reprobe}>
      <IconRefresh size={13} />{probing ? "探测中…" : "重新探测"}
    </button>
  </header>

  <div className="settings-hint">隐私边界那一句（见 §三）</div>

  {/* body：S0~S5，见 B 项 */}

  {/* 仅在"有模型可接"或"已接入"时出现 */}
  <div className="settings-hint">占位凭据那一句（见 §三）</div>
</section>
```

#### B. 状态表（body 的六种形态）

| # | 条件 | body | 头部按钮 |
| --- | --- | --- | --- |
| S0 | `probe === undefined`（首次探测未回） | **骨架**：`.provider-list` + 3 个 `.provider-row` / `.provider-main`，`role="status"` `aria-label="正在探测本机模型服务"` | disabled ·「探测中…」 |
| S1 | 探测整体失败（IPC 断，daemon 抛错） | `ErrorState`（`message` + `onRetry`） | 可用 ·「重新探测」 |
| S2 | 命中集合非空（S3 是其特例） | `.provider-list`：**全部命中项**（有模型的在前、按模型数降序、并列按候选表顺序；零模型的按候选表顺序排在后） | 可用 ·「重新探测」 |
| S3 | 命中集合非空但**全部零模型** | 同 S2 的容器，行内容换成"已探到，但还没有模型"+ 指引 | 可用 ·「重新探测」 |
| S4 | 命中集合为空 | `EmptyState`（title + description，**不传 icon**） | 可用 ·「重新探测」 |
| S5 | 未命中候选数 > 0（S2/S3/S4 都可能叠） | 其下一行 `.mini-btn`「查看其余 {N} 个未探到的服务」；展开后在**下方**渲染第二个 `.provider-list` | — |

三条关键判断：

- **S0 用骨架而不是一行 spinner。** §4 明文：「结构已知的等待场景用骨架屏 —— 骨架行与真行同尺寸、同类名，
  使列表到达时是「同一片区域被填上」，而不是整块替换」。候选表是**写死的固定表**，结构确实已知。
  一行文字的形态会被随后的 3~7 行列表**整块替换**（并且高度跳变），正是 §4 要避免的形状。
  这是**兜底路径**：多数用户从首页进来时（首页已在 mount 时触发过探测）探测已完成，进设置页直接看到结果；
  但路径必须定义 —— S0 绝不能渲染成 S4 的「没有探到本机模型服务」，那是 §4 的直接违反。
- **S3 与 S4 必须可辨**（PRD 验收项 + §4 同族纪律）：
  S3 = **一行绿点 + 「已探到，但还没有模型」+ 一句指引**；S4 = **空态句「没有探到本机模型服务」**。
  前者是"服务在，缺模型"，后者是"什么都没有"。**两者都不是错误**，因此都不使用 `--danger`、不出现 ✗
  （§2.4：状态色只表状态；「没探到」不是状态也不是错误）。
- **S5 默认折叠成一行按钮**（PRD R4：「未探到的候选项折叠在一句话之后，不摊成一片红叉」）。
  它的价值是**可诊断**：让用户相信应用真的探了，并且知道"我那个冷门端口不在覆盖范围里"——
  这解释了为什么没探到。展开是用户显式要的，此时多一个盒子是信息的容器，不是装饰。

#### C. 行结构（S2 / S3 / S5 共用同一套类名）

```jsx
// 命中 · 有模型（可接入）
<div className="provider-row">
  <div className="provider-main">
    <span className="provider-dot on" />
    <span className="provider-name">Ollama</span>
    <span className="provider-meta">127.0.0.1:11434 · 4 个模型</span>
    <span className="bar-spacer" />
    <button type="button" className="mini-btn" disabled={busy}
            aria-label="接入本机 Ollama">接入</button>
  </div>
</div>

// 命中 · 零模型（无接入按钮 —— 不许给一个点了必然失败的按钮）
<div className="provider-row">
  <div className="provider-main">
    <span className="provider-dot on" />
    <span className="provider-name">Ollama</span>
    <span className="provider-meta">127.0.0.1:11434 · 已探到，但还没有模型</span>
    <span className="bar-spacer" />
    <span className="provider-hint">先在本机服务里下载一个模型，再点「重新探测」</span>
  </div>
</div>

// 已接入（同一行，动作位换成标签）
    <span className="provider-tag">已接入</span>

// 未探到（只在展开后出现，灰点）
<div className="provider-row">
  <div className="provider-main">
    <span className="provider-dot" />
    <span className="provider-name">Jan</span>
    <span className="provider-meta">127.0.0.1:1337 · 未探到</span>
  </div>
</div>
```

四个选择及理由：

- **灰点 / 绿点复用 `.provider-dot` 与 `.provider-dot.on`**（`app.css:7331/7339`）。
  `--ok` 的 token 注释原文是「成功：完成态、**已连接**」—— 一个可达的本机服务就是"已连接"，
  所以 S3（可达但没有模型）**也用绿点**：绿色说的是"服务在"，"没模型"由**文字**承担。
  这既避免了给点新增第三种状态（新档位），又正好满足 §7.6（状态不只靠颜色，文字独立承担）。
  未探到的灰点 `background: var(--border)` 是既有值，不加任何东西。
- **「已接入」用 `.provider-tag`（chip）而不是 `.provider-hint`（提示语）**：它是这条服务的**性质标注**
  （与「自建」同族），不是"这里不需要你操作"的说明；而且 S3 那一行已经用了 `.provider-hint` 装**指引语**，
  两个不同的东西用两个不同的类，语义分得开。**不使用 `--ok` 上色** —— 绿点已经说了"连着"，
  文字已经说了"已接入"，颜色再压一层就重复了（§2.1：状态已由位置或文字独立承担时，颜色不必再压）。
- **「接入」用 `.mini-btn`，不用 `.primary-btn`**：这一页的**行内动作**一律是 `.mini-btn`
  （「更换 Key」/「编辑」/「清除」）。`.primary-btn` 在设置页只属于表单的「保存」。
  接入虽然是本区块的主操作，但它坐在一个行里，用实心黑按钮会让这一行比整页任何一行都重。
- **`provider-meta` 里放 `127.0.0.1:11434`**：区块要回答的正是"探的是哪儿"，端口是最直接的证据。
  文案分隔符用 `·`，与「服务商」行（`来源 · N 个模型`）一致。
  **首页那处不写端口**（首屏不给技术细节）。

**「已接入」的判据（实现要求）**：把探测项的 `baseUrl` 规范化后与 `snapshot.providers` 中
`custom === true` 的服务商 `baseUrl` 逐一比对，相等即视为已接入 —— **不按名字比**（用户可以改名）。
判据写反的后果是"没接入的行显示已接入、且拿不到接入按钮"，必须有一条反向验证用例专门盯它。

**「重新探测」不清空已有结果**：用户点它时，body **保持上一次的结果**，只有头部按钮变「探测中…」。
（与「刷新模型目录」一致：刷新不该让正在看的东西先消失。）骨架只在 S0（首次、无结果）出现。

#### D. S0 骨架的具体形状

```jsx
<div className="provider-list" role="status" aria-label="正在探测本机模型服务">
  {[0, 1, 2].map((i) => (
    <div className="provider-row" key={i}>
      <div className="provider-main">
        <Skeleton width={7}  height={7}  radius="var(--radius-full)" />   {/* 点 */}
        <Skeleton width={96} height={13} />                               {/* 服务名 */}
        <Skeleton width={168} height={12} />                              {/* meta */}
        <span className="bar-spacer" />
        <Skeleton width={56} height={29} />                               {/* 按钮位 */}
      </div>
    </div>
  ))}
</div>
```

- **同类名**：`.provider-row` / `.provider-main` / `.bar-spacer` 与真行逐字相同 → "同一片区域被填上"。
- **同尺寸**：`.mini-btn` 的盒高 = 12px × 行高 1.6 + 4×2 padding + 1×2 border ≈ **29px**，占位块取 29；
  其余块取真行对应元素的字号（13 / 12）。GUI 用例断言骨架行与真行的高度差 ≤ 2px；
  若字体栈变化导致 1~2px 漂移，**调这个数字，不要改类名、不要加类**。
- **3 行**是个数字（不是档位），3 行足够示意"这里会有一串行"，比 5 行少闪一半面积。
- `Skeleton`（`app.js:13213`）是既有组件，走的 `color-mix(in srgb, var(--text) 8%, transparent)` 在深浅两套下都成立，
  不引入新颜色。它自带 `aria-hidden`，语义由容器的 `role="status"` 承担（§4 明文）。

#### E. `.settings-hint` 的两处用法与唯一需要补的 CSS

`.settings-hint` 今天没有 margin（`app.css:8817`），作为 `<div>` 直接放进去会与相邻块贴死。
**补一条 `margin: var(--space-3) 0;`**（在 `app.css:8817` 的 `.settings-hint` 块内追加，不动其它声明）：

- 该类全仓**从未被引用**，补 margin 的回归风险为零；
- 相邻兄弟的垂直 margin 会**折叠**：头部 `.settings-section-head` 的 `margin-bottom: var(--space-3)`
  与它的 `margin-top: var(--space-3)` 折叠成 8px，与 `.provider-list` 之间也是 8px ——
  两处都是 `--space-3`，与页面上其它"标题 → 内容"的节奏一致，**不产生档外值**。
- 被否的替代：复用 `.settings-foot`（它的 `margin: var(--space-6) 0 0` 在区块内太大，
  且名字与位置是"页面脚"）；新造 `.local-service-note`（既有类够用，§6 禁止复制视觉值）。

#### F. 交互四态

| 态 | 行 | 按钮 |
| --- | --- | --- |
| normal | `.provider-list` 盒 + `.provider-row` 分隔线；行本体**不响应 hover**（`.provider-main` 无 hover 规则） | `.mini-btn` 既有 |
| hover | 同 normal（**本区块的行不是可点行** —— 只有右侧按钮是动作，不给行加 hover 底，避免"整行可点"的错觉） | `.mini-btn:hover:not(:disabled)` → `--bg-hover` 既有 |
| active | — | `.mini-btn:active:not(:disabled)` → `scale(0.98)` 既有 |
| focus | — | 全局 `button:focus-visible` → `2px solid var(--text-secondary)` 既有 |
| disabled | — | `.mini-btn:disabled` → `color: var(--text-secondary)`；文案「接入中…」 |

> ⚠️ **不要用 `.provider-row:hover .provider-main { background: var(--bg-sidebar) }`**（`app.css:7326`）。
> 那条规则是给「服务商」行用的，而那些行……今天的语义是"整行是个跳转面"。本区块的行**只有按钮是动作**，
> 挂上行 hover 会让人去点行本身。**若将来给本区块的行也做成整行可点，才复用它。**
> 这一条要在实现时显式确认 —— `.provider-row` 本身不带 hover，带 hover 的是**后代选择器**，
> 一旦本区块的容器也用 `.provider-list`，那条规则**会自动作用于本区块**。**这是本规范里唯一一处必须手动对抗的既有样式**：
> 加一条更具体的选择器把本区块的行 hover 底关掉（如 `[data-local-services] .provider-row:hover .provider-main { background: transparent }`），
> 或让本区块的容器不用 `.provider-list`/`.provider-row` 而另择（**不推荐**：那要新造类名，代价更大）。
> 采用前者：新增一个属性选择器（不是类名），0 个新视觉值。**反向验证**：把该覆盖删掉，截图里本区块的行 hover 应当变灰。

#### G. 深浅两套主题

**逐项核对，全部自动成立**（所有取值都走 token 或既有组件，无需任何新增暗色覆盖）：

| 元素 | 浅色 | 深色 | 结论 |
| --- | --- | --- | --- |
| `.provider-list` 边框 | `--border` `#e6e6e6` | `rgba(255,255,255,.12)` | ✅ |
| `.provider-dot`（未探到） | `--border` `#e6e6e6` on `#ffffff` —— 很淡 | 12% 白 on `#1c1c1e` —— 比浅色**更可见** | ✅ 不对称但不构成问题（它是装饰，语义由文字承担） |
| `.provider-dot.on` | `--ok` `#0cbf5f` | `--ok` `#32d74b` | ✅ |
| `.provider-tag`「已接入」 | `--bg-raised` `#f7f7f7` | `#26262a` | ✅ 与「自建」标签同款，已实测 |
| `.mini-btn` / `.settings-hint` / `EmptyState` | 既有 | 既有 | ✅ |
| `Skeleton` | `--text` 8% | `--text` 8% | ✅ |
| 首页 `.home-guide` 命中行 | `--bg-hover` 5% 黑 | 7% 白 | ✅ |

`npm run check:theme-tokens` 对本设计**不需要任何新条目**：没有新增颜色 token，也没有 token 块之外的颜色字面量。

---

## 三、文案（全部最终中文，可直接抄进实现）

### 首页上手清单第 2 步

| 场景 | 文案 |
| --- | --- |
| 未命中 / 探测中 / 命中但零模型 | 行：`还没有选定要用哪个模型`　按钮：`去选一个模型 →`（**现状，一字不改**） |
| 命中 | 行：`本机 Ollama 正在运行（4 个模型）`（`{label}` 为服务名、`{n}` 为模型数）　按钮：`接上 →` |
| 接入中 | 按钮：`接入中…`（disabled） |
| 已接入 | 行：`已选定可用模型`（现状 done 文案） |
| 接入失败 | toast：`接入失败：{原因}` |

### 设置 → 模型 → 本机模型服务

| 位置 | 文案 |
| --- | --- |
| 区块标题 | `本机模型服务` |
| 头部按钮 | `重新探测` / `探测中…` |
| **隐私边界（常驻，标题下方）** | `只探测这台机器的回环地址（127.0.0.1）上的常见模型服务端口，不扫描网络、不出网。` |
| 命中行 · 有模型 | 名：`Ollama`　meta：`127.0.0.1:11434 · 4 个模型`　按钮：`接入` |
| 命中行 · 零模型 | meta：`127.0.0.1:11434 · 已探到，但还没有模型`　右侧：`先在本机服务里下载一个模型，再点「重新探测」` |
| 已接入 | 动作位：`已接入`（`.provider-tag`） |
| 未命中空态 | 标题：`没有探到本机模型服务`　说明：`这台机器上没有正在运行的本机模型服务。装好并启动 Ollama、LM Studio 之类之后再点「重新探测」。` |
| 折叠开关 | `查看其余 {N} 个未探到的服务` / `收起` |
| 未探到行 | meta：`127.0.0.1:1337 · 未探到` |
| **占位凭据（仅"有模型可接"或"已接入"时出现）** | `本机服务一般不校验密钥；接入时应用会替你写一个占位值，好让它的模型能被选中（不是你的账号信息）。` |
| 探测整体失败 | `ErrorState`：`{daemon 返回的原因}` + 按钮 `重试` |
| 探测中（骨架） | `aria-label="正在探测本机模型服务"`（无可见文字） |

### 关于「占位凭据」那句话

`research/model-access.md` §Z-1 实测：**不写任何凭据时，`setModel` 一定失败、模型在 UI 里标为不可用**
（`isUsable() === false`，因为 pi 的 `configuredApiKey` 取不到值）。所以一键接入**必然**要写一个非空占位值。
用户需要知道的只有三件事：**为什么会有这个值**（不是我们多此一举）、**它是什么**（占位值）、
**它不是什么**（不是他的账号信息）。上面那句话把三件事都说了，且不含"为了安全"这类含糊说法。

**放在哪、什么时候出现**：它是**接入动作的副作用说明**，因此只在"有东西要接入"（S2）
或"已经接入了"时出现；S3（零模型）与 S4（未命中）时**不出现** —— 那时没有东西会被写进磁盘，讲它是噪音。
它与隐私句不合并成一段：两句说的是两件事（**探什么** vs **写什么**），合并后一句话干两件事，读起来更含糊。

**不做的事**：不写「为了安全」、不写「应用会自动管理凭据」（不准确）、不写"本机服务免 Key"
（`docs/USAGE.md:109` 与 `app.js:63655` 的「留空即可」**已经是错的**，见 §Z-1；
本任务不改它们，但要避免在本设计里复制同一句错误）。

---

## 四、Top 5 视觉提案（按「视觉冲击力 / 成本」排序）

1. **首页第 2 步原地变身**（冲击力 ★★★★★ / 成本 ≈0）
   一行文案 + 一个按钮文字，**零新增盒子、零新增类名、零新增 token**。
   这是整个功能用户唯一会"啊"一下的地方，也是唯一会被截图传播的地方。**必做，优先级最高。**

2. **设置页新区块照抄「服务商」的行语言**（冲击力 ★★★★ / 成本 ≈0）
   `.provider-list` / `.provider-row` / `.provider-main` / `.provider-dot` / `.provider-name` /
   `.provider-meta` / `.bar-spacer` / `.mini-btn` 全部复用。
   效果不是"新功能很漂亮"，而是**"新功能看起来一直就在那儿"** —— 这比漂亮值钱得多。

3. **「已接入」用 `.provider-tag` 标签，而不是让按钮静默消失**（冲击力 ★★★ / 成本 ≈0）
   静默消失会被读成"点了没用"；一个 chip 明确说"这件事已经完成了"。
   它是 `.provider-tag`「自建」的同族用法，零新样式。

4. **未命中时不摆红叉，摆一句空态 + 一个折叠开关**（冲击力 ★★★ / 成本 ≈0）
   大盘用户（没装本机服务）看到的是**一片安静**，不是一片失败。
   这决定了这个功能对 95% 的人是"没感觉"还是"这软件怎么老报错"。

5. **探测中用 3 行骨架而不是一行 spinner**（冲击力 ★★ / 成本 小）
   结果到达时是"同一片区域被填上"而非"整块替换 + 高度跳变"（§4 明文）。
   出现概率低（首页通常已先探完），但**必须定义** —— 否则探测未完成时就会掉进"显示没探到"，那是 §4 的直接违反。

---

## 五、明确不做

| 想法 | 理由 |
| --- | --- |
| 首页加一行「正在探测本机模型服务…」 | 95% 的用户首屏会闪一句 1 秒后自我撤销的话，凭空制造"页面在加载什么"的错觉（§3.9：首屏唯一视觉重点）。PRD 也明文要求不得阻塞首屏。 |
| 命中时把图标换成 `IconTerminal` / `IconDatabase` | 行图标是**步骤的身份**（模型 = 钥匙），不是接入方式的说明。同一步骤换脸会让清单读起来像变了结构。 |
| 首页展示端口号（`127.0.0.1:11434`） | 首屏不给技术细节。端口在设置页那一行里才是有用的证据。 |
| 首页把"探到了但零模型"也讲出来 | 它**不改变用户能做的动作**（都是"去选一个模型"），只增加一句与他无关的话。差异在设置页讲清楚就够了。若后续实测发现"装了 Ollama 没 pull 模型"是高频路径，再加半句也不迟。 |
| 首页命中时列出多个服务（下拉/多行） | 清单一行只能挂一个动作。取模型数最多的那个（规则见 §2.1 A），其余是设置页的活。 |
| 接入成功弹 toast | 变化就发生在这行本身（对勾 + 文案），而**当前模型名 24px 下方的输入卡 footer chip 里就有**（`shortModelName`，`app.js:14976`）。首屏再压一层全局浮层，与"唯一视觉重点是输入卡"反向。 |
| 给本机服务行加「本机」chip | 区块标题已经写了「本机模型服务」，meta 已经给了 `127.0.0.1`。再加一个 tag 是纯噪音。 |
| 新造 `.local-service-*` 类名族 | 全套既有类够用。唯一"新"的是**复用**一个从未被引用的既有类 `.settings-hint`。 |
| 用状态色表达"探到 / 没探到"（绿点/红叉之外的第三条路：黄） | 「没探到」不是状态也不是错误（§2.4）。而且 `--warning` 的语义是"连接中/待确认"，用在"没有这个服务"上是错的。 |
| 给未命中折叠区做计数徽章（`.settings-section-badge`） | 折叠态下"还有 4 个没探到"是**负信息**；把它包装成一个带数字的徽章，会读成"你还有 4 个待办"。 |
| 给新区块加入场动画 / 数字滚动 / 呼吸点 | 要进 §10.3 登记，收益为零，且与"探测是背景行为、不该抢注意力"相反。 |
| 为区块做独立插画 / 空态插图 | §3.9 盒子预算与既有空态语言（`EmptyState` 不传 icon）都不支持；`--text-faint`(30%) 的线稿图标在浅色下几乎看不见（§2.1 已登记过同款事故）。 |
| 把「本机模型服务」塞进「服务商」区的 `.settings-subhead` 之下 | 「已配置」与「可接入」混进同一个列表，语义污染；且拿不到自己的头部按钮位。 |
| 改「服务商」区：给本机接入的 provider 换掉「更换 Key」按钮 | **本轮不做**，但它是一个真实后果：走 §Z-1 的占位凭据后，该服务商会在「服务商」列表里带一个「更换 Key」按钮，而它没有 Key 可换。**建议随实现一并决定**（例如给该行换成 `.provider-hint`「本机服务，无需 Key」），但那是第三个界面，超出本规范的两处范围。 |
| 首页清单读取失败时补错误态（D5） | 既有缺陷、与本任务无关；修它要给首屏加一块错误框，与 §3.9 冲突，需要单独权衡。**建议另开 Issue。** |
| 一键下载 / 安装 Ollama 或模型 | PRD 已列为"明确不做"（联网下载大体积产物 + 模型分发）。 |
| 探测局域网内其它机器 | PRD 已列为"明确不做"（隐私边界从回环扩到内网，与威胁模型冲突）。 |

---

## 附：验收时应当能一眼核对的清单

- [ ] 首页新增代码里**没有任何新 className**（改动只在既有类的组合与文案）
- [ ] 首页 `OnboardingChecklist` 里**没有** `Spinner` / `LoadingState` / `Skeleton`
- [ ] 「接上」按钮从鼠标点击与键盘 Enter **各只触发一次**（反向验证：去掉守卫，必须有一条用例变红）
- [ ] 「已接入」判据写反 → 恰好那条用例变红，其余不受影响
- [ ] 未命中时全页**不出现** `--danger` / ✗ / 「失败」字样
- [ ] S3（探到但零模型）与 S4（没探到）截图**可辨**（一行带绿点的行 vs 一块空态）
- [ ] 探测未完成时**不渲染** S4 的空态文案（§4）
- [ ] 深浅两套截图各两张（首页命中 / 设置页 S3 + S4）
- [ ] `npm run check:theme-tokens` 无新增条目即通过
- [ ] 新增代码里没有新 `@keyframes`、没有非 `--dur-fast` 的 `transition:`
- [ ] Tab 到首页第 2 步时焦点环可见（全局 `[role="button"]:focus-visible`）
- [ ] 设置页本区块的行 hover **没有**背景变灰（`app.css:7326` 的副作用已被显式覆盖）