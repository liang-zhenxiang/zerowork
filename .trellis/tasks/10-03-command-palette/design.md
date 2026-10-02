# 技术设计：命令面板（⌘K）

> 需求见 `prd.md`。同类产品调研见 `research/competitor-gaps.md`。
> 视觉纪律的事实来源是 `docs/DESIGN.md`，本文件不重复它。

---

## 1. 边界与职责

**这是一个纯渲染层功能，不新增任何 IPC 通道。** 面板要的数据全都已经能取到：

| 数据 | 来源 | 现状 |
| --- | --- | --- |
| 会话列表 | `App()` 的 `taskList`（`window.kami.listSessions`） | 已在 state 里 |
| 工作空间分组 | `groupMetas`（`listWorkspaceGroups`） | 已在 state 里 |
| 专家 | `experts`（`listExperts`） | 已在 state 里 |
| 技能 | `window.kami.skillsSnapshot()` | 设置页在用（`app.js` 65640 附近） |
| 连接器 | `window.kami.mcpConfigGet()` | 设置页在用（`app.js` 64934 附近） |
| 自动化 | `window.kami.listAutomations()` | 导航页在用（`app.js` 62942 附近） |

后三项在**首次打开面板时**拉取并缓存在 `useRef`，不在每次打开时重取。

## 2. 模块切分（本设计最重要的一条）

```
src/renderer/src/command-palette-core.js   ← 纯逻辑：不打分 DOM、不含 React
src/renderer/src/app.js                    ← 组件、动作表、快捷键接线
```

**为什么把纯逻辑单独放一个模块**：渲染层此前**只靠 GUI 测试覆盖**，而 GUI 测试要真实启动
Electron、慢且贵。把「排序对不对」这类判断从 DOM 里拿出来，就能在毫秒级锁住它。
`tests/unit/` 目前只测 `src/main/daemon/**` —— **这是本项目第一条渲染层单元测试路径**，
也是本设计里唯一的结构性主张。

`app.js` 用**静态 import** 引入（与 `app.js:29537` 引入 `../vendor-katex.js` 同款写法）。
静态 import 会被 Rollup 内联进 `app.js`，**不产生新的产物文件**，
所以 `scripts/check-renderer-assets.mjs` 的产物契约不受影响。

## 3. 模块契约（`command-palette-core.js`）

```js
/** 条目由调用方构造；core 不认识 run，只负责「筛选 + 排序 + 截断」。 */
// { id, kind, title, subtitle?, keywords?: string[], hint?: string, run: () => void }

export const KIND_WEIGHT = { action: 0, settings: 1, session: 2, workspace: 3, expert: 4, skill: 5, connector: 6, automation: 7 };

/** 返回匹配等级（见 R3 排序链）或 null（不匹配）。等级越小越优先。 */
export function matchRank(query, entry) -> number | null

/** 排序 + 截断。返回 { items, total }；total 是截断前的命中总数。 */
export function rankEntries(entries, query, { limit = 50 } = {}) -> { items, total }
```

### 匹配等级（对 `prd.md` R3 的可执行化）

| 等级 | 判据 |
| --- | --- |
| 0 | `title` 与 query 完全相等（大小写不敏感，去首尾空白后比较） |
| 1 | `title` 以 query 开头 |
| 2 | `title` 包含 query（子串） |
| 3 | query 的字符按序出现在 `title` 中（子序列，即模糊匹配） |
| 4 | `subtitle` 或 `keywords` 中任一项命中（等级 0-3 的任一档） |
| `null` | 都不命中 → 过滤掉 |

**排序键（三级，缺一不可）**：`matchRank` 升序 → `KIND_WEIGHT[kind]` 升序 → **原数组索引升序**。

> 第三条是**显式实现**的，不依赖 `Array.prototype.sort` 在实现上的稳定性。
> 这是本模块唯一「不写出来就会静默出错」的地方，因此单测里有一条专门的反向验证
> （把三级键砍成两级，用例必须变红）。

### 空 query

`rankEntries(entries, "")` → 原样返回（截断前），`total` = 长度。
「空查询显示什么」由调用方决定（见 §5），core 不做产品判断。

## 4. 组件结构（`app.js`）

```
App()
 └─ <CommandPalette open onClose entries />
      ├─ .modal-backdrop                     ← 复用既有类；onMouseDown 点背板关闭
      └─ .command-palette  role="dialog" aria-modal="true" aria-label="命令面板"
           ref={useModalFocus}
           ├─ input.command-palette-input     ← 自动聚焦；role="combobox"
           │                                     aria-expanded / aria-controls / aria-activedescendant
           ├─ div.ac-menu[role=listbox]       ← 复用补全菜单的分组与行（见 §6）
           │    └─ .ac-group[role=group] > .ac-group-title + .ac-item[role=option]
           └─ footer.command-palette-foot     ← 键位提示 + 结果计数（aria-live="polite"）
```

**复用既有基建，不另起一套**：

| 需要的能力 | 复用什么 | 出处 |
| --- | --- | --- |
| 焦点陷阱 / 背景 `inert` / 关闭后焦点归还 | `useModalFocus()` | `app.js:16693` |
| 模态背板（含「拖选文本滑出到背板不误关」的 mousedown 判定） | `.modal-backdrop` | 设置面板同款 |
| 候选列表的分组 / 行 / 图标位 / 右侧提示 | `.ac-menu` `.ac-group` `.ac-group-title` `.ac-item` `.ac-label` `.ac-icon` `.ac-hint` | 输入框的 `@` / `/` 补全下拉 |
| 键盘上下的循环走位 | 补全菜单的 `ArrowUp/ArrowDown + % items.length` 写法 | `app.js:14064` 附近 |
| 输入法组合期判定 | 补全菜单的 `composingRef` + `onCompositionStart/End` 写法 | 同上 |

> **`.ac-*` 是这次设计的关键发现**：输入框的补全下拉已经把「分组标题 + 行 + 左侧图标 +
> 右侧提示」做完了，而这正是命令面板列表需要的同一件东西。**面板的行读作同一个对象**，
> 因此不新造行样式、不复制视觉值（`docs/DESIGN.md` §6 与 `.trellis/spec/renderer` 的
> 「优先用既有类」）。新增的只有**面板外壳**（`.command-palette` 及其输入行、页脚）——
> 那是一个居中的模态盒子，与绝对定位在输入框上方的 `.ac-menu` 不是同一个容器。

## 5. 状态与数据流

```
open=false
  └─ 渲染 null（不常驻 DOM，避免给每次按键加一个隐藏的监听者）

open=true
  ├─ 首次：拉 skills / mcp / automations（缓存进 ref；失败置空数组并记 error）
  ├─ entries = useMemo(现有 state + 缓存)     ← 声明式动作表 + 实体映射
  ├─ query = useState("")，随输入更新
  └─ { items, total } = rankEntries(entries, query, { limit })
```

**三种形态互斥且可辨**（`docs/DESIGN.md` §4）：

| 形态 | 判据 | 显示 |
| --- | --- | --- |
| 空查询 | `query === ""` | 常用动作 + 最近会话（分组）：**引导态**，不是空白 |
| 有结果 | `items.length > 0` | 分组列表 |
| 无结果 | `query !== "" && items.length === 0` | 一行 `role="status"` 的空态文案（**不是**「加载中」） |

> 实体数据可能还没回来（`undefined`）——此时**不显示「没有结果」**，
> 只显示已经就绪的那部分条目（§4 的「数据到达前不得显示无数据类文案」）。

## 6. 视觉规范（token 级）

新增的类只有三个，全部只用 `app.css` 的既有 token：

| 类 | 关键值 | 依据 |
| --- | --- | --- |
| `.command-palette` | 宽 `min(640px, 100vw - var(--space-7) * 2)`；`max-height: 60vh`；水平居中、顶距 `12vh`；`background: var(--bg)`；`border: 1px solid var(--border)`；`border-radius: var(--radius-lg)`；`box-shadow: var(--shadow-lg)`；`z-index: var(--z-modal)` | 圆角按用途归档 —— **模态级走 `--radius-lg`**（§2.7）；阴影走**模态档 `--shadow-lg`**；层级走 `--z-modal`（`--z-toast` 留给 toast，不被面板占用） |
| `.command-palette-input` | `padding: var(--space-5)`；`font-size: var(--text-emphasis)`；`background: transparent`；无边框（分隔靠下一行的 `--border`） | 15px 与用户气泡/清单行同档（§2 字号五档） |
| `.command-palette-foot` | `padding: var(--space-2) var(--space-5)`；`border-top: 1px solid var(--border)`；`font-size: var(--text-meta)`；`color: var(--text-secondary)` | 与 `.ac-hint` / `.ac-group-title` 同口径（meta 档 + 次文色） |
| `.command-palette .ac-menu` | 去掉 `.ac-menu` 的绝对定位与自身边框/阴影/圆角（外壳已承担），只保留 `overflow-y: auto` 与 `padding: var(--space-1)` | 同一个列表对象，容器不同 |

**选中态**：沿用 `.ac-item.active` 的 `--bg-hover` 底，并额外给选中行
`font-weight: 500` —— 这是 §7.6「状态不只靠颜色」的载体（**字重**是第二个独立信号），
且 500 是 §3.6 允许的两档之一。
**不用** `.settings-nav-item.active` 的 600：那是一次未登记的字重偏离，不扩散它。

**图标**：动作行给 `--text-secondary`（同 `.ac-icon`）；选中行随字重变化即可，不额外换色。

**动效**（走既有三档，不新增时长）：

| 方向 | 值 | 依据 |
| --- | --- | --- |
| 入场 | `opacity 0→1` + `translateY(-4px)→0`，`var(--dur-base) var(--ease-out)` | 与 widget 定稿入场同族（§10.3 已登记的「4px 上浮淡入」手法） |
| 退场 | 只用 `opacity`，`var(--dur-fast)` | §5.8 进出场不对称（离场更快，且不做位移） |

- **只过渡 `opacity` 与 `transform`**，不碰 `width` / `height`（§5.1，无需登记例外）
- `prefers-reduced-motion: reduce` 下**关停两条动效**，并**登记进 `docs/DESIGN.md` §10.3.1 的关停清单**
- §10.3 登记一条：命令面板的入场动效

## 7. 键盘与交互

| 键 | 行为 |
| --- | --- |
| `⌘K` / `Ctrl+K`（全局） | 打开 / 关闭。`preventDefault`（部分环境这是浏览器的搜索键） |
| `↑` / `↓` | 环形移动选中项（到头回绕） |
| `Enter` | 执行选中项 |
| `Esc` | 关闭（**有输入内容也直接关**，不做「先清空」两级 —— 首版取简，写进 `docs/USAGE.md`） |
| 鼠标悬停 | `onMouseEnter` 同步选中（与补全菜单同一处教训：只做 `onMouseDown` 会出现「高亮停在键盘那条」的错位） |
| 鼠标点击 | `onMouseDown` + `preventDefault`，等同 `Enter`（与补全菜单同款，避免按下瞬间面板消失导致 click 丢失） |

**输入法**：`onKeyDown` 里先判组合态，组合中**不响应 `Enter` / `↑` / `↓`**。
判据用补全菜单已在用的 `composingRef`（`compositionstart` / `compositionend`），
**不依赖 `event.isComposing` 单独**——两者都判，任一为真即视为组合中。

**执行动作的次序**：先 `onClose()` 再 `run()`。
理由是面板关闭会归还焦点与解除背景 `inert`；**先关再执行**能让被打开的目标
（如设置面板）拿到干净的前置状态，避免两个模态互相嵌套。
首版据此**不支持面板里执行后仍停留在面板**（没有「连续执行」语义）。

**全局监听的挂法**：挂在 `App()` 的 `window` keydown 上，写法照 `⌘.` 那一处
（`app.js` 67854 附近）：判修饰键 → 判 `altKey/shiftKey` 不参与 → `preventDefault` → 切换。

## 8. 无障碍

| 要求 | 做法 |
| --- | --- |
| 模态语义 | `role="dialog"` + `aria-modal="true"` + `aria-label="命令面板"` |
| 焦点 | `useModalFocus()` 自动聚焦第一个可聚焦元素（=输入框）并归还焦点 |
| 组合框语义 | 输入框 `role="combobox"` + `aria-expanded="true"` + `aria-controls=<listbox id>` + `aria-activedescendant=<选中项 id>` |
| 列表语义 | 容器 `role="listbox"`；分组 `role="group"` + `aria-label`；条目 `role="option"` + `aria-selected` |
| 组标题 | `aria-hidden="true"`（组名已由 `role="group"` 的 `aria-label` 给出，不重复播报）—— 照补全菜单的既有做法 |
| 结果数播报 | 页脚计数容器 `aria-live="polite"`，只播报数量本身，不播报整列表 |
| 状态不只靠颜色 | 选中项除底色外还有**字重**变化（§7.6） |
| 焦点环不得被抹掉 | 不写 `outline: none`；聚焦指示用 `--text-secondary`（§7.1） |

## 9. 兼容与回归风险

| 风险 | 判断 / 处置 |
| --- | --- |
| `⌘K` 与既有快捷键冲突 | **已核实无冲突**：`app.js` 里 `command-palette` / `⌘K` / `Ctrl+K` 命中均为 0；现有修饰键处理只有 `⌘.`、`Ctrl+O`、`Ctrl+T`。**用例里仍要有一条断言它没被别处吃掉** |
| 与设置面板嵌套 | 见 §7「先关再执行」，首版不允许嵌套 |
| 面板常驻 DOM 影响首屏 | `open=false` 时返回 `null`，不常驻 |
| 新增静态 import 影响产物契约 | 会被内联进 `app.js`，不新增产物文件；改完跑 `npm run build && npm run check:renderer-assets` |
| 未开放导航项混入 | 动作表**不生成** `ready: false` 的项；用例有一条专门断言「搜不到它」 |
| 大列表卡顿 | 用 `limit` 截断渲染条数；`rankEntries` 是 O(n) 打分 + O(n log n) 排序，会话量级（千级）无压力 |

## 10. 测试设计

### 单元：`tests/unit/command-palette-core.test.mjs`

- `matchRank`：等级 0/1/2/3 各自的边界（含「恰好等于」「恰好前缀」「子序列跨词」）；
  大小写不敏感；中文子串；不匹配返回 `null`；**关键词命中落在等级 4**
- `rankEntries`：
  - 空 query → 原序 + `total` 正确
  - **三级排序键**：matchRank 优先于 kind 权重；kind 权重优先于原索引
  - **稳定性**：构造两条同分同 kind 的条目，断言保持原数组顺序
  - `limit` 截断：`items.length === limit` 且 `total` 是**截断前**的总数
  - 全部不匹配 → `items` 为空、`total` 为 0
- **反向验证记录**（写进文件头注释）：把三级排序键砍成两级，哪些用例变红

### GUI：`tests/e2e/command-palette.mjs`（真实启动 Electron）

| # | 断言 |
| --- | --- |
| ① | `⌘K` 唤起：`.command-palette` 出现，`role="dialog"`，输入框拿到焦点 |
| ② | 空查询有引导内容（不是空白），且**不含**未开放项 |
| ③ | 输入中文能命中（如「设置」）；`↑`/`↓` 改变 `aria-activedescendant`（**用真实键盘**，不用合成事件——合成 `KeyboardEvent` 在 eslint 的 Node 视角是 `no-undef`，本项目踩过） |
| ④ | `Enter` 执行：设置面板出现、面板消失、焦点归还到唤起前元素 |
| ⑤ | `Esc` 关闭 |
| ⑥ | **未开放项不出现在结果里**（搜「资料库」→ 不出现该条目） |
| ⑦ | 无结果时出现 `role="status"` 空态，且**不是**加载态 |
| ⑧ | 选中项在**不看颜色**时也可辨（断言字重变化，不只断言 class） |
| ⑨ | 侧栏入口点击能唤起（鼠标路径，既有入口回归） |
| ⑩ | 浅色 + 深色两套主题截图 + **像素断言**（面板区域与背板可区分） |
| ⑪ | 输入法组合期间 `Enter` 不提交 |
| ⑫ | 既有 GUI 用例不受影响（`test:gui` 全链在 PR 前跑一遍） |

截图目录 `artifacts/command-palette/`；用例挂进 `package.json` 的
`test:gui:palette`，并同时进 `test:gui` 与 `test:e2e` 两条链。

## 11. 明确的后续项（**不进这一版**，各自写清理由）

| 项 | 为什么现在不做 |
| --- | --- |
| **frecency（频率×近因的自学习排序）** | 需要新增一条持久化通道。本项目的持久化有「单一真源」纪律（`preferences.json` 是真源、localStorage 只做首帧镜像），而 frecency 的正确落点是 `preferences.json` —— 那要动 daemon 与 IPC，属于独立任务。首版用「常用动作 + 最近会话」拿到同样的**首屏可用性**，代价为零 |
| **收藏 / 置顶** | 同上，需要持久化；且它要先把「动作」变成有稳定 id 的可持久对象 —— 首版的声明式动作表已经给了 id，是它的前置条件，下一版可直接接 |
| **类型前缀**（`>` 命令 / `i` issue 式） | 体量小但会改变输入语义，需要先有真实使用反馈才知道该不该做 |
| **第二层上下文动作面板**（选中项再展开动作） | 首版动作都是「选中即执行」的单动作，没有第二个动作可给 |
| **集中式快捷键管理页** | 调研 §二「缺口 2」已认定它是独立缺口（注册表 + 冲突检测 + 可改键）。面板的 `hint` 字段是它的**前置**：先把「有哪些键」显式化，再谈「改键」 |
| **跨内容全局搜索**（会话正文 / 产物内容） | 调研 §二「缺口 1」：索引与检索该落 daemon，是独立任务。面板的实体层是它的 UI 前置 |

> 这些项**不是被否掉的**，是排期问题。写在这里是为了让下一轮不必重新论证。