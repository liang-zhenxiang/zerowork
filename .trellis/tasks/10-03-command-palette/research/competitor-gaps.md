# Research: 同类产品能力缺口（命令面板专项）

- **Query**：同类产品里有、而 ZeroWork 没有的高价值能力是什么？（命令面板为首要考察对象）
- **Scope**：external（同类产品调研）+ internal（ZeroWork 现状核实）
- **Date**：2026-10-03
- **任务**：`.trellis/tasks/10-03-command-palette`

---

## 方法与边界（这份文件不重复什么）

**怎么查的**：只用公开可抓取的一手材料 —— 官方手册、官方文档、官方帮助页、开源仓库原文。
过程是 `curl` 抓原文 → 本地转纯文本 → 引用其中原话。**不依赖记忆里的产品印象，也不引用二手评测**。
抓不到的明确写「查不到」。

**【重要】与已有调研的分工**：首次运行体验的同类调研已经在
`docs/ONBOARDING-RESEARCH.md`（426 行）做过一轮，覆盖 AnythingLLM / Msty / LM Studio / Jan /
Cherry Studio / Cursor，并明确列了「不做」清单（内置模型、一键下载推理引擎、账号墙、遥测、
feature tour 视频）。**本文件不重复它的结论，也不重新推荐它已否掉的方案**，
只覆盖它没碰的部分：**交互层的键盘效率（命令面板 / 快捷键 / 搜索 / 收藏）**。

**先核实、再调研**：所有对 ZeroWork 现状的判断都先在
`src/renderer/src/app.js`（打包态单文件）与 `src/main/daemon/`、`src/main/` 里 grep 过，
结论都带命中数。**已核实、不要当缺口的既有能力**（避免下一轮重复讨论）：

| 已存在 | 位置 / 证据 |
| --- | --- |
| 全局唤起热键（老板键） | `src/main/index.js:349`（`GlobalToggleShortcutController`），默认 `Shift+Alt+W`；状态在诊断页显示（`app.js:66234` `GlobalShortcutRow`） |
| 拖拽文件进输入框 | `app.js` 有 `onDrop`（10 处）/ `dragOver`（6 处） |
| 提示词模板 | `src/main/daemon/prompt-templates.js`；UI 里「提示词」出现 16 次 |
| 自动化 / 专家 / 技能 / 连接器 / 统计与诊断 | `automation.js` / `experts.js` / `skills.js` / `mcp.js` / `observability.js`；导航项 `NAV_ITEMS$1`（`app.js:13229`） |
| 首页「最近会话」续聊 | 见 Roadmap 的 #68 |

**局限**：没有逐个安装实测，结论来自官方文档；产品版本变动快，细节可能有出入。
其中 Raycast 手册自带 `.md` 变体，抓的是其**出版版本**，可信度最高。

---

## 一、命令面板（Command Palette）专项

### 考察对象与来源

| 产品 | 材料来源（实际抓取，200） | 覆盖情况 |
| --- | --- | --- |
| Raycast | `manual.raycast.com/search-bar.md`、`action-panel.md`、`keyboard-shortcuts.md` | 充分（含排序优先级原文） |
| VS Code | `code.visualstudio.com/docs/getstarted/userinterface`、`tips-and-tricks` | 充分 |
| Obsidian | `github.com/obsidianmd/obsidian-help` 的 Command palette 页 | 充分 |
| Notion | `notion.com/help/keyboard-shortcuts` | 中等（快捷键口径） |
| Cherry Studio | `docs.cherryai.com.cn` 的 `key-shortcut.md`、`global-search.md`、`launchpad.md` | 充分（中文一手） |
| Linear | `linear.app/docs/search` | 中等（搜索 + 命令菜单行为） |
| macOS Spotlight | `support.apple.com/guide/mac-help/use-spotlight-mchlp1008/mac` | 中等 |
| Arc | `arc.net/features` 抓取失败（404 / Wayback 超时） | **查不到** |
| Chatbox | `chatboxai.app` 官网与 Guide 页只有功能营销文案，**无命令面板 / 快捷键文档** | 材料不足 |
| LobeChat / LobeHub | `lobehub.com/llms.txt` 与 `/docs/usage/...` 无 command-menu 页（404） | **查不到** |

---

### 1. Raycast —— 「一切皆一个搜索框」的标杆

- **面板里放了什么**：一个输入框（Search Bar）+ 一个结果列表（Root Search）。
  可搜对象覆盖应用、命令（内置 + 扩展）、索引到的文件与目录、日历事件、联系人、
  计算器结果、Quicklinks、AI 命令、脚本命令、系统设置面板、Web URL、颜色值。
  空搜索时列表显示**常用/最近项**（最近文件、今日日程）。
- **排序怎么做**（原文，**这是最值得抄的一条**）：Root Search 有明确的优先级链 ——
  1. 别名精确匹配 → 2. 别名前缀匹配 → 3. 标题模糊匹配分 → 4. 副标题与关键词匹配 →
  5. **frecency（频率 + 近因的混合分）**。且它「学你」：同一查询你反复选某项，
  它下次会升到更短查询就能命中；给每个命令提供 **Reset Ranking** 清掉学习数据。
- **键盘交互**：`↑/↓` 上下移动；`⌘↑/⌘↓` 跨分组跳；`⌥↑/⌥↓` 翻页；
  `Enter` 主动作；`⌘Enter` 次动作；`⌘K` 打开 **Action Panel**；
  `Esc` 清空文本 / 再按关闭；空搜索时 `↑/↓` **翻搜索历史**。
- **Action Panel（选中项之后还能干什么）**：这是 Raycast 的第二层。
  选中任一结果按 `⌘K` 展开**上下文动作**，按 **分节**组织（Primary / Favorites / Configure / Deeplink / Manage）；
  面板顶部还有一个 **「Search for actions…」** 输入框，可用模糊匹配在动作里再搜一层
  （搜索时所有匹配项**打平成一列**、忽略原分组）。动作可带**子菜单**、可在内联**键盘录制器**里绑热键。
- **值得学的细节**：
  - 排序链里**别名 > 模糊分 > frecency**，且 frecency 只做末位修正 —— 不喧宾夺主。
  - **可学习的排序 + 可重置**（Reset Ranking），把「它老猜错」变成用户能修的。
  - **参数化命令**：命令可带最多 3 个参数，选中后在搜索栏区域就地弹出参数输入框，
    `←/→` 在参数间移动，输入完 `Enter` 执行。
  - **搜索灵敏度可调**（Low / Medium / High 三档），把「模糊到什么程度」交给用户。
  - **Compact Mode**：空搜索时窗口只显示搜索栏，开始输入或打开 Action Panel 才展开。
  - **别名（Alias）**：给命令绑短关键词（如 `gc` = Google Chrome）；有参数的命令，
    输入别名后加空格**自动聚焦第一个参数框**。
- **不适合我们的**：App / 文件 / 日历 / 联系人这类**操作系统级索引**——那是 launcher 的活，
  不是办公 Agent 的核心；我们没有也不该有全盘文件索引。

来源：<https://manual.raycast.com/search-bar.md>、<https://manual.raycast.com/action-panel.md>、<https://manual.raycast.com/keyboard-shortcuts.md>

### 2. VS Code —— 「一个窗口，五种打开方式」

- **面板里放了什么**：同一个 Quick Input 窗口承担多种模式，靠**前缀**切换：
  - `⌘P` = Quick Open，按文件名导航；
  - `⇧⌘P` = Command Palette，**执行命令**（原文：从任意上下文访问全部功能）；
  - `⇧⌘O` = 跳到文件内某个符号；`⌃G` = 跳到某一行；
  - 在命令模式输入框里 **`?`** 会列出**当前可用命令**。
- **排序/展示**：每个命令右侧**显示它绑定的默认快捷键**（原文：
  「You can see the default keyboard shortcut alongside the command」）——
  面板本身成了**快捷键的学习入口**。`⌃Tab` 在最近打开的文件间循环（MRU）。
- **键盘交互**：`⌘P` / `⇧⌘P` 直接进入对应模式；上下键 + `Enter`；命令模式可拖拽边缘移动面板位置。
- **值得学的细节**：
  - **一个输入框，前缀分模式**（文件 / 命令 / 符号 / 行号）——比堆多个入口更省。
  - **快捷键提示贴在命令右侧**，是「教会用户」的最低成本方式。
  - `?` **就地列出可用命令**（当用户不知道有什么可做时，面板自己回答）。
  - 命令是**按上下文过滤**的（原文「based on your current context」）。
- **不适合我们的**：符号导航、行号跳转属于代码编辑器语义；我们至多借「文件内跳转」。

来源：<https://code.visualstudio.com/docs/getstarted/userinterface>（Command Palette 一节）、<https://code.visualstudio.com/docs/getstarted/tips-and-tricks>

### 3. Obsidian —— 「运行任意命令 + 可置顶 + 最近使用」

- **面板里放了什么**：一个「运行任意命令」的入口，同时可**浏览所有命令及其快捷键**。
- **排序/展示**：支持**模糊匹配**（原文举例：输入 `scf` 能找到 **S**ave **c**urrent **f**ile）。
  从 **1.8.3** 起，**最近使用的命令置顶**；但**一旦开始筛选，短命令会优先于最近使用的命令**
  （即：最近使用只在未筛选时生效，筛选后让位给匹配质量）。
- **键盘交互**：`Ctrl+P` / `⌘P` 打开（也可点 Ribbon 图标）；方向键选择；`Enter` 执行。
- **值得学的细节**：
  - **置顶命令（Pinned commands）**：把高频命令钉在面板顶部，不输入即可见。
  - **「最近使用」只在未输入时置顶** —— 这是很干净的取舍，避免了「我打字了它还拿历史压我」。
  - 命令面板同时是**快捷键的发现处**（能查到每个命令绑了什么键）。
- **不适合我们的**：Ribbon / 文件管理那是笔记应用的组织方式；我们借的是面板交互本身。

来源：<https://raw.githubusercontent.com/obsidianmd/obsidian-help/master/en/Plugins/Command%20palette.md>

### 4. Notion —— 「搜索 = 跳转，另有斜杠命令」

- **面板里放了什么**：两种入口并存。
  - `⌘/Ctrl + P` **或** `⌘/Ctrl + K` = 打开**搜索 / 跳转到最近查看的页面**；
  - 页内另有一层**行内触发**：`/` 唤出**内容块菜单**（Slash commands），
    `@` 提及人、`[[` 链接页面、`+` 新建子页面 —— 都是在编辑器里就地弹出的「命令菜单」。
- **排序**：`⌘P/⌘K` 面板会给「最近查看的页面」（原文：jump to a recently viewed page）。
- **值得学的细节**：
  - **全局跳转（⌘K）与行内命令（`/`）分成两层**：一个管「去哪」，一个管「做什么」。
    两者都在键盘上，且都不打断输入（`/` 是输入流的一部分）。
  - `⌘K` **同时兼任「搜索」与「跳到最近」**——一个键干两件相关的事。
- **不适合我们的**：Notion 的 `[[` / `@` 是块编辑器语义；我们可借「在输入框里用 `/` 触发命令」
  这一交互形态（我们输入框已有「加号菜单」收着模式/专家/连接器，见 ONBOARDING-RESEARCH）。

来源：<https://www.notion.com/help/keyboard-shortcuts>

### 5. Cherry Studio —— 中文形态最贴近：**快捷键设置 + 全局搜索 + 启动台**

- **集中式快捷键设置**（我们完全没有的形态）：`设置 → 快捷键` 是一个**完整的管理页**：
  - 顶部三个按钮：**全部启用 / 全部禁用 / 重置**（并注明「只作用于当前可见项」，即受筛选影响）；
  - **搜索框**（占位「搜索快捷键...」，可按**功能名或按键组合**过滤）；
  - **分组筛选**：全部 / 全局与窗口 / 消息交互 / 会话与对话 / AI 助手工具，每组带数量；
  - 列表每行三段：功能名 · **按键组合（点击进入「按下快捷键」录制态）** · 启用开关；
  - **单项重置**（改过的项左侧出现 ↺）、**冲突提示**（「已被「xxx」使用」/「该快捷键已被系统或其他应用占用」）、
    系统级快捷键**置灰不可改**、未绑键时开关不可切并提示「请先绑定快捷键」。
- **全局搜索**：一个入口搜**消息、对话、任务、助手、Agent、知识库**，
  支持**按类型筛选 + 按更新时间缩小范围**；文档明确它搜的是「Cherry Studio 里已保存的内容」，
  **不搜磁盘文件**（要搜磁盘文件得先经 Agent 工作目录 / 知识库流程）。
- **启动台（Launchpad）**：把 9 个内置应用（对话/工作/绘画/翻译/小程序/知识库/文件/编码搭档/笔记）
  平铺成入口；可**拖拽排序**、可**右键「添加到侧边栏」**固定。
- **值得学的细节**：
  - **快捷键做成一等公民的管理页**（分组 + 搜索 + 冲突检测 + 单项/整体重置 + 启用禁用）。
  - **⌘K 在 Cherry 里是「清除上下文」**（重要反例：`⌘K` 被占用了，所以
    **ZeroWork 若要用 `⌘K`，必须先确认它没被别处占用**；Cherry 自己把 `⌘K` 给了「忘记上文」）。
  - 它的文档站**自己用 `Ctrl K` 唤出「询问」**（抓取时页面顶栏即是）——命令面板已是文档站标配。
- **不适合我们的**：小程序 / 绘画 / 翻译面板是「全能工作台」的产物，不是办公 Agent 的核心。

来源：<https://docs.cherryai.com.cn/pre-basic/settings/key-shortcut.md>、<https://docs.cherryai.com.cn/advanced-basic/workbench/global-search.md>、<https://docs.cherryai.com.cn/cherry-studio/preview/launchpad.md>

### 6. Linear —— 「一个键进搜索 + 前缀限定范围」

- **面板里放了什么**：`/`（或点侧栏搜索按钮）打开**命令菜单 / 搜索**，
  检索 issues、projects、documents。
- **前缀限定**（原文）：输入 `i` 再空格 → 聚焦 issue 结果；`p` → projects，`u` → users，
  `t` → team，`l` → labels，`f` → favorites，`d` → documents。
  **这是「一个输入框 + 单字母前缀切换实体类型」的另一种实现**（与 VS Code 前缀同思路）。
- **排序/空状态**：打开搜索时显示**最近搜索**与**最近 issues**；结果按「最相关」排序
  （未开始/进行中在前，backlog/完成/取消/归档在后），可改为按更新时间/创建时间；
  **最多返回 500 条**。
- **值得学的细节**：
  - **空状态给「最近搜索 + 最近项」**——打开就用得上，不用现打。
  - **单字母前缀限定实体类型**（比 VS Code 的符号前缀更贴近「办公实体」语境）。
  - 另有 `O then I` 的**双键序列**（`O` 后 `I`）打开最近 issues —— 说明「按键序列」也是一种可选交互。
- **不适合我们的**：issue 追踪的排序权重（状态优先）是它业务语义，不可照搬。

来源：<https://linear.app/docs/search>

### 7. macOS Spotlight（系统级参照）

- **面板里放了什么**：`⌘Space` 唤出一个输入框，**同一个框**里做文件/邮件/消息搜索、
  计算、单位换算、查词典、剪贴板历史、执行 **Quick Actions**、以及（Siri AI 开启后）对话。
- **排序**：结果即时出现，**最佳匹配置顶**。
- **键盘交互**：`⌘Space` 打开；`↑/↓` 在列表移动；`Return` 打开；**`↑` 可召回上一次搜索**；
  选中后按住 `⌘` 定位文件、按 `Space` 走 Quick Look 预览。
- **值得学的细节**：
  - **一个框兼做「搜索 / 计算 / 换算 / 动作」**——命令面板与「万能输入框」合一。
  - **`↑` 召回上次搜索**（对办公场景很实用）。
  - 选中项上按键即出**上下文动作**（`⌘` 定位、`Space` 预览），与 Raycast Action Panel 同源。
- **不适合我们的**：全盘索引、剪贴板历史、系统设置面板——系统 launcher 的能力，不搬。

来源：<https://support.apple.com/guide/mac-help/use-spotlight-mchlp1008/mac>

### 横向对比表

| 维度 | Raycast | VS Code | Obsidian | Notion | Cherry Studio | Linear | Spotlight | **ZeroWork（现状）** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 有无命令面板 | 有（一切） | 有（命令） | 有 | 有（搜索+跳转） | 有（搜索/启动台） | 有（搜索） | 有 | **无**（`command-palette`/`⌘K`/`cmdk` 命中 0） |
| 唤出键 | `⌘Space` | `⇧⌘P` | `⌘P` | `⌘P`/`⌘K` | 全局搜索（可改键） | `/` | `⌘Space` | — |
| 模糊匹配 | ✅ | ✅ | ✅ | ✅ | ✅（搜索项） | ✅ | ✅ | 无（`fuzzy`/`模糊` 命中 0/1，无实现） |
| 最近/常用置顶 | ✅ frecency | ✅ MRU | ✅（未筛选时） | ✅ 最近页面 | ✅ 最近 | ✅ 最近搜索/项 | ✅ 最佳匹配 | 首页「最近 3 条会话」 |
| 可置顶/收藏 | ✅ Favorites | 未查到 | ✅ Pinned | 收藏 | ✅ 固定到侧栏 | `f` 前缀（favorites） | — | **无**（`收藏` 命中 0） |
| 选中项二次动作 | ✅ Action Panel (`⌘K`) | 命令即上下文 | 命令菜单 | 行内 `/` | 命令菜单 | 命令菜单 | ✅ Quick Actions | 无 |
| 快捷键提示贴在项旁 | ✅ | ✅ | ✅ | — | ✅ | — | — | 无 |
| 集中式快捷键管理页 | 部分（Action Panel 内绑） | ✅ Keyboard Shortcuts | ✅ Hotkeys | — | ✅ **完整管理页** | — | 系统设置 | **无**（散落 `window.addEventListener("keydown")`） |
| 前缀限定实体类型 | 别名 | `>` `?` 前缀 | — | `/` `@` `[[` | 类型筛选 | `i` `p` `u`… | — | 无 |

**表里读出来的三件事**：

1. **命令面板是这批产品的共识形态**，且**都建立在「模糊匹配 + 最近使用」之上**——
   ZeroWork 在这两项上都是 0。
2. **成熟的命令面板都有「第二层」**（Raycast Action Panel / VS Code 上下文命令 / Notion `/`）：
   面板不只「去哪儿」，还「对选中的东西做什么」。
3. **Cherry Studio 是唯一把「快捷键管理」做成独立可配置页的**，而这恰好覆盖 ZeroWork
   最薄弱的一环（我们只有零散 4 处 handler，且全局热键写死 `Shift+Alt+W`）。

---

### 给 ZeroWork 的融合结论

#### A. 面板里应该有哪些「动作 / 实体」类型

**动作（做某件事）**——都是既有代码里已存在的入口，面板只是把它们收进一个框：

| 分组 | 动作（示例，均对应现有能力） |
| --- | --- |
| 导航 | 去首页 / 打开设置（`NAV_ITEMS` 9 个分页）/ 打开诊断 · 审计 |
| 会话 | 新建任务 / 打开最近会话（已有「最近 3 条」）/ 归档 |
| 创作 | 用某个**专家**起一个任务 / 应用某个**提示词模板** / 换一个**场景** |
| 配置 | 切换主题（浅/深/跟随）/ 切换工作空间 / 切换模型 |
| 工具 | 打开专家·技能·连接器 / 打开自动化 |

**实体（跳到某个东西）**——需要一层「可搜对象」：

- 工作空间、会话/任务、专家、技能、连接器（MCP）、提示词模板、场景、设置分页。

> 关键点：**动作与实体都用同一套「一个输入框 + 结果列表」**，靠类型前缀或分组区分，
> 而不是各做一个入口（VS Code / Linear / Cherry 的共同做法）。

#### B. 排序策略（照抄 Raycast 的优先级链，落到我们的规模）

1. **分组**：动作 / 实体 / 最近使用（前缀或分组头区分）。
2. **匹配优先**：精确命中（名称或别名）> 名称前缀 > 名称模糊分 > 关键词/副标题。
3. **末位修正**：**frecency（频率×近因）** 只作末位打破平局，**不压过匹配质量**。
4. **未输入时**：只显示**收藏 + 最近使用**（照 Obsidian 1.8.3 的取舍：一输入就让位给匹配）。
5. **空结果**：给一句可诊断的提示（对齐 `docs/DESIGN.md` §4 的三态纪律），而不是空白。

#### C. 首版（MVP）边界 —— 做到什么程度

**要做的（首版最小闭环）**：

1. **一个 `⌘K` / `Ctrl+K` 唤起的浮层**，输入框 + 结果列表 + 键盘上下选择 + `Enter` 执行 + `Esc` 关闭。
2. **可搜对象先接「现成数据」**：会话/任务、专家、技能、连接器、提示词模板、场景、
   设置分页、以及一批**动作**（新建任务、切主题、打开某设置页等）。
   —— 这些数据都已经在渲染层，**不需要新 daemon 模块**。
3. **模糊匹配**：**自写**（项目对「自写小工具」有先例，如自写 PNG 解码器 / KaTeX vendoring），
   不引入 `cmdk` 之类新依赖（与「控制随包体积」的既有取向一致）。
4. **排序 = 匹配分 + frecency（末位）**；frecency 初版可只用 localStorage，
   不必进 daemon（`preferences` 已有持久化，但 MVP 可先本地）。
5. **键位冲突先核实**：`⌘K` 在 Cherry 里被「清除上下文」占用 —— **ZeroWork 实现前必须先 grep
   确认 `⌘K` / `Ctrl+K` 未被现有功能占用**（当前 `key === "." / "o" / "t"` 三处 + Esc/Enter，
   `⌘K` 看起来空闲，但要按此把关）。给设置页留一个「面板快捷键」的可改项。
6. **遵循 `docs/DESIGN.md`**：不新造视觉参数；浮层复用既有 token / 缓动 / 三态组件。

**首版不做**（留待后续，见第三节）：

- 第二层 **Action Panel**（选中后 `⌘K` 再出上下文动作 + 面板内再搜动作）—— 留到 v2，
  首版先用「选中即执行」的单一动作。
- **集中式快捷键管理页**（Cherry 那种全量分组/冲突检测/重置）——独立缺口，见第二节。
- **参数化命令 / 别名自定义 / 灵敏度三档 / Compact Mode**——都是打磨项，不进 MVP。
- **全盘文件索引 / 系统级对象**（Raycast 那类）——不做。

---

## 二、其它缺口（第二优先）

以下每一项都**先在 ZeroWork 里核实过「确实没有」**（给出 grep 命中数），再去同类产品里确认它是标配。

### 缺口 1：跨内容的全局搜索（会话 / 任务 / 产物 / 专家 / 技能）

- **是什么 / 谁是标配**：一个入口搜「应用内已保存的一切」。Cherry Studio 明确做成了
  「搜消息、对话、任务、助手、Agent、知识库」（含类型筛选 + 时间筛选）；
  Linear（`/` 搜 issues/projects/documents）、Notion（`⌘K` 搜页面）、Obsidian、VS Code 全部有。
- **为什么对「办公 Agent」有价值**：办公场景的典型痛点是**「记得内容，不记得放在哪」**
  （Cherry 原文即此句）。Agent 每天产出会话、产物、专家任务，没有搜索就只能靠肉眼翻历史。
  它也是命令面板「实体」层的天然数据源——**两者可以共用一套索引**。
- **兼容性**：✅ 完全兼容。纯本地、不需要服务端、不绑供应商；数据都在 `session-files.js` /
  `archive.js` / 各 daemon 模块里。
- **成本 / 落点**：**中**。索引与检索落在 **daemon**（新增一个类似 `search.js` 的模块，
  或扩展 `archive.js`），UI 落在**渲染层**。

### 缺口 2：集中式、可自定义的快捷键体系

- **是什么 / 谁是标配**：Cherry Studio 有**完整的快捷键管理页**（分组、搜索、冲突检测、
  单项/整体重置、启用禁用、系统键置灰）；Obsidian 有 Hotkeys 设置；VS Code 有
  Keyboard Shortcuts 编辑器；Raycast 可在 Action Panel 内即时绑键。
- **为什么对「办公 Agent」有价值**：当前 ZeroWork 的快捷键是**散落的 4 处**
  （`⌘.` 切侧栏 `app.js` 专注模式 handler、`Ctrl+O` 回指挥位、`Ctrl+T` 切任务面板、
  全局 `Shift+Alt+W` 写死），**没有集中处、没有提示、没有冲突检测、不可自定义**。
  用户「想改一个键」无处可改，「想学有哪些键」无处可查。**这是命令面板的前置**：
  面板要贴快捷键提示，就得先有一个「快捷键注册表」。
- **兼容性**：✅ 兼容。纯本地；全局热键走 `globalShortcut`（`src/main/index.js` 已有基建），
  应用内键走渲染层。
- **成本 / 落点**：**中**。注册表 + 管理页在**渲染层**；全局热键的读写与冲突在**主进程**
  （`GlobalToggleShortcutController` 已封装，改成可配置即可）。

### 缺口 3：收藏 / 置顶 + 「最近使用」个性化

- **是什么 / 谁是标配**：Raycast 的 Favorites + frecency + Reset Ranking；Obsidian 的
  Pinned commands + 最近使用置顶；Cherry 的「固定到侧边栏」；Notion 的收藏。
- **为什么对「办公 Agent」有价值**：办公用户有**固定的高频动作**（开某个专家、跑某个流程）。
  收藏让「常做的」不用每次搜；frecency 让「常搜的」自动上浮。这是把一次性面板
  变成**越用越顺手**的关键，直接对应「更想用」。
- **兼容性**：✅ 兼容。偏好数据可进 `preferences.js`（已有持久化基建）。
- **成本 / 落点**：**小**（收藏）/ **小-中**（frecency）。渲染层为主，持久化走 `preferences`。
- **注**：ZeroWork 现在的 `置顶` 只用于「当前工作空间置顶」（issue #73），**不是**用户自选的收藏。

### 缺口 4：划词 / 选中文本助手

- **是什么 / 谁是标配**：Cherry Studio 的**划词助手**（选中文本即唤起处理，默认关闭、需启用）；
  Raycast 的选中文本 + Quick AI；macOS 的 Services。
- **为什么对「办公 Agent」有价值**：办公最高频的动作是**「这段文字，帮我……」（改写/总结/翻译/解释）**。
  现在是「复制 → 切到 ZeroWork → 粘贴 → 选专家/写提示词」，划词助手能压成**一次选中**。
- **兼容性**：⚠️ **需判断**。划词要读**其他应用里的选中文本**，在 Electron 里通常靠
  `globalShortcut` + 剪贴板读取（或平台 API），默认开启会有**隐私/出站**观感问题。
  建议：**默认关闭 + 明确说明「只在你主动按键时才读一次剪贴板」**，与 Cherry 的默认关闭一致。
- **成本 / 落点**：**中**。全局热键 + 剪贴板读取在**主进程**；浮层 UI 在**渲染层**。

### 缺口 5：语音输入（听写）

- **是什么 / 谁是标配**：Raycast 的 **Dictation**（含 `⌃M` 快捷键与 Esc 取消）；macOS 系统听写。
- **为什么对「办公 Agent」有价值**：口述一封邮件/一段需求，比打字快——对办公 Agent 是「更想用」的强项。
- **兼容性**：⚠️ **有张力**。「本地优先 / 不绑供应商」下，云端 ASR 是出站行为；
  纯本地 ASR 要随包大模型（与「不内置模型」的既有取舍冲突）。
  **可行路径**：把听写做成**可选 BYOK 出站能力**，默认关闭、写进 `EXTERNAL_REQUESTS.md`，
  或接操作系统自带的听写（零出站、零体积）。
- **成本 / 落点**：**大**（若自建）/ **小**（若只做「调用系统听写」的接线）。落点主要在**渲染层 + 主进程**。

> 说明：这 5 项里，**缺口 1 与缺口 2 是命令面板的直接前置**（搜索是实体来源、快捷键注册表是面板提示来源）；
> **缺口 3 是面板的「个性化」层**；缺口 4/5 与面板相对独立，可并列推进。

---

## 三、明确不做（看着好但不适合本项目）

逐条写理由，避免下一轮重新讨论。

1. **操作系统级的全盘索引 / 系统对象搜索**（Raycast 的应用、文件、联系人、日历；
   Spotlight 的剪贴板历史、系统设置面板）。
   理由：那是 launcher 的核心，不是办公 Agent 的核心；全盘索引带来 IO 与隐私成本，
   与「本地优先、出站克制」的取向不一致。**半吸收的边界**：只搜**应用内**已保存内容。
2. **云端 ASR 作为默认开启的听写**。理由：默认出站违反 `EXTERNAL_REQUESTS.md` 的克制；
   见缺口 5 的「只做可选 / 走系统听写」。
3. **把划词助手做成默认开启**。理由：默认读取其他应用的选中文本有隐私观感问题；
   只做**默认关闭 + 主动触发**。
4. **引入 `cmdk` / 现成命令面板组件库**。理由：与项目既有的「自写小工具、控制随包体积」
   取向一致（对照：自写 PNG 解码器、vendored KaTeX）；模糊匹配逻辑本身很小，可自写并单测覆盖。
5. **照抄别人的视觉参数**（Raycast 的窗口尺寸、Compact Mode 的像素行为、Cherry 的卡片参数）。
   理由：视觉纪律在 `docs/DESIGN.md`；面板应复用既有 token 与缓动，不新造一套。
6. **为「看起来功能全」而把未开放导航项（助理/项目/资料库）写进面板**。
   理由：与 `docs/ONBOARDING-RESEARCH.md` 的建议 1 同一条纪律 —— 名字摆出来却按不动，
   比收起来更伤。
7. **命令别名（用户自定义短词）** 进 MVP。理由：它是打磨项，依赖先有「快捷键/注册表」基建；
   放后续，不进首版。
8. **参数化命令（一条命令带多个输入框）** 进 MVP。理由：ZeroWork 的动作大多无参，
   首版「选中即执行」足够，避免过量设计。

---

## 来源清单（均实际抓取）

**同类产品**

- Raycast 手册：<https://manual.raycast.com/search-bar.md> ｜ <https://manual.raycast.com/action-panel.md> ｜ <https://manual.raycast.com/keyboard-shortcuts.md>
- VS Code：<https://code.visualstudio.com/docs/getstarted/userinterface> ｜ <https://code.visualstudio.com/docs/getstarted/tips-and-tricks>
- Obsidian：<https://raw.githubusercontent.com/obsidianmd/obsidian-help/master/en/Plugins/Command%20palette.md>
- Notion：<https://www.notion.com/help/keyboard-shortcuts>
- Cherry Studio：<https://docs.cherryai.com.cn/pre-basic/settings/key-shortcut.md> ｜ <https://docs.cherryai.com.cn/advanced-basic/workbench/global-search.md> ｜ <https://docs.cherryai.com.cn/cherry-studio/preview/launchpad.md>
- Linear：<https://linear.app/docs/search>
- macOS Spotlight：<https://support.apple.com/guide/mac-help/use-spotlight-mchlp1008/mac>

**ZeroWork 现状（核实点）**

- `src/renderer/src/app.js`：`NAV_ITEMS$1`（L13229）、`NAV_ITEMS`（设置分页，L64819）、
  专注模式 handler（`event.key === "."` + `metaKey||ctrlKey`）、`Ctrl+O`/`Ctrl+T` handler（`event.key.toLowerCase()`）、
  `GlobalShortcutRow`（L66234，`DEFAULT_GLOBAL_SHORTCUT = "Shift+Alt+W"`）。
- `src/main/index.js`：`GlobalToggleShortcutController`（L349）、`globalShortcut` 注册与状态（L360-371）。
- `src/preload/index.js`：`globalShortcutStatus` 通道（L410 / L631）。
- `src/main/daemon/`：`prompt-templates.js` / `experts.js` / `skills.js` / `automation.js` /
  `mcp.js` / `observability.js` / `archive.js` / `session-files.js` / `preferences.js`
  （**无 search 类模块**，`ls | grep search` 为空）。
- 命中数为 0（证明缺口）：`command-palette`/`commandPalette`/`cmdk`/`⌘K`/`Ctrl+K`、
  `全局搜索`、`收藏`、`划词`、`fuzzy`、`语音`/`听写`/`dictation`。

**查不到的（不补全）**

- **Arc 命令栏**：`arc.net/features` 抓取 404，Wayback 取回超时 → 未取得一手材料。
- **Chatbox**：官网与 Guide 页只有功能营销文案，**无命令面板 / 快捷键文档**。
- **LobeChat / LobeHub**：`llms.txt` 与 `/docs/usage/...` 无 command-menu 页（404），
  仅见官方 CLI 命令 `lh`。
- **Raycast「Command Aliases & Hotkeys」专页** `.md` 抓取 404；别名相关内容已由
  `search-bar.md` / `action-panel.md` 覆盖。
