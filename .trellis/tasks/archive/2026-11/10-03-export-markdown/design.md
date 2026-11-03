# 导出为 Markdown —— 技术设计与决策记录

> 需求与验收标准在 `prd.md`。本文件只回答「怎么定、为什么这么定」。

## 一、渲染口径：**逐类对齐 pi 的 HTML 导出**，不重新发明

HTML 导出的实现是权威（`dist/core/export-html/template.js`），它认得的条目就是「一次会话
有哪些内容」。Markdown 逐类对齐它：

| 条目 | HTML 导出 | 本模块（Markdown） |
| --- | --- | --- |
| `message` / user | 正文 + 技能块（可展开）+ 图片 | `## 你 · 时间` + `> 调用了技能：X` + 正文；图片留一行占位 |
| `message` / assistant · text | markdown 段落 | 原样段落 |
| `message` / assistant · thinking | 折叠的 thinking 块 | `> 思考` 引用块（超长同样截断） |
| `message` / assistant · toolCall | 工具卡（带结果） | `**工具调用：X**` + 入参 JSON 围栏 + 结果围栏 |
| `message` / assistant · stopReason | aborted / error 提示 | `> （这一轮被中止 / 出错：…）` |
| `message` / toolResult | 挂在上面的工具卡里 | **同样挂在对应调用下**（靠 `toolCallId` 索引；不单独成段，否则同一件事写两遍） |
| `message` / bashExecution | 命令 + 输出 + 退出码 | bash 围栏 + 输出围栏 + `> （退出码 N）` |
| `compaction` | 可展开的压缩块 | `> **（上下文已压缩：N tokens）**` + 摘要引用 |
| `branch_summary` | 分支摘要块 | `> **（分支摘要）**` + 摘要引用 |
| `model_change` | 一行「Switched to model」 | `> 切换模型：provider/model` |
| `custom_message`（`display: true`） | 扩展消息块 | `> **（customType）**` + 内容引用 |
| `custom: artifacts_presented` | （HTML 归在产物面板） | `**交付的产物**` + 路径清单 —— 导出的是「这次交付了什么」，与资料库同一件事 |
| 其余（`session_info` / `label` / `usage` / `custom` 其它类型 / `context_edit`） | 不渲染 | 不渲染（宁可不写，也不写错） |

## 二、三条渲染口径（每条都有代价，写清楚免得下一轮翻案）

1. **超长内容按与界面同一口径截断**：复用 `session-view.js` 的 `DETAIL_LIMIT`(4000) 与
   `TRUNCATED_MARK`，并**额外标明原长度**（`（原 N 字符）`）。
   理由：界面看到什么、导出就该是什么；一份十万字符的工具日志灌进用户正要发给同事的文档里，
   比「少了几百行日志」糟糕得多。要全文可以直接导出 HTML。
2. **图片不内嵌 base64**：只留 `> （图片：image/png，约 N KB —— 未内嵌，原图见会话）`。
   一张截图就能把文档从几十 KB 变成几 MB，而多数 Markdown 阅读器并不会在文档里显示它。
3. **代码围栏长度按内容算**（内容里最长连续反引号 + 1，且不少于 3）。
   写死三个反引号的话，工具输出里只要出现 ``` 就会把整篇文档从那里截断 ——
   导出功能最典型的「命令成功、打开是烂的」事故。

另外两条**范围**上的取舍：

- **技能调用只留一行**，不搬 `<skill name="…">…</skill>` 标签体里的注入指令：
  那是应用的管道，不是用户写的话；HTML 里它被折起来藏着，Markdown 没有「折起来」，
  原样搬只会把用户真正说的那句话淹掉。
- **不导出被隐藏的注入上下文**（system prompt / 工具清单 / pi context）：
  同理，且 HTML 导出把它们放在诊断面板里，搬进 Markdown 就得连那套语义一起搬（非目标）。

## 三、条目从哪拿：活的宿主的 `getBranch()`

`SessionHost.branchEntries()` → `this.session.sessionManager.getBranch()`。

**为什么不自己 open 一遍会话文件**：`getBranch()` 从宿主内存里的 **leaf 指针**往上走，
而「打开文件」时 pi 把**最后一条条目**当成 leaf（`session-manager.js` 的 `_buildIndex`）。
用户刚回退 / 分叉过，两者就是**两条不同的分支** —— 症状是「导出来的不是我正在看的那条线」，
而这在界面上几乎无从察觉。（这条是写测试时实测出来的，集成用例里专门放了一条
「不在当前分支上的条目」做守卫。）

**为什么 HTML 导出不受影响**：`exportToHtml` 用的也是同一个 live `sessionManager` + live state，
两边口径一致。

## 四、落盘：复用既有的一切

| 项 | 做法 | 理由 |
| --- | --- | --- |
| 目录 | `getEffectiveWorkspaceRoot()/exports` | 与 HTML 导出同一个目录：用户不必记两套位置 |
| 文件名 | `buildExportPath(dir, title, now, ".md")` | 同一个函数 + 同一个 `sanitizeExportTitle`（标题里的 `/` `\` 会被清成 `-`），只是扩展名不同 |
| 空会话 | `hasExportableContent()` 先判，抛「该会话还没有内容可导出」 | 与 HTML 导出（pi 抛 Nothing to export → daemon 翻中文）**同一句话**；写一篇只有标题的空文档比报错更让人困惑 |
| 非当前会话 | 沿用既有行为：先 `resumeSession` 再导出 | 与 HTML 导出逐句同形；tooltip 已如实写明 |
| 同一秒导出两次 | 会覆盖同名文件 | 与 HTML 导出同口径（它也是这样）。要改成加序号，就得**两种格式一起改**，属另一件事 |

## 五、界面

- ⋯ 菜单：「导出」→ **「导出为 HTML」**（改名，选择发生在点之前）+ 新增
  **「导出为 Markdown」**。两项 tooltip 分别写清用途，并说明非当前会话会先被恢复。
- 导出后的反馈与 HTML 导出**逐句同形**（toast 路径 + 打开文件 + 非当前会话时同步快照并切视图）：
  两条路径的差异只该在通道与格式上。
- 菜单因此从 5 项变 6 项（置顶那轮已经把它推到 6 项）——`session-pin.mjs` 里那条
  「菜单项必须落在侧栏可视区内」的断言是按几何算的，见 implement.md 的「已知风险」。

## 六、测试与反向验证

| 层 | 文件 | 覆盖 |
| --- | --- | --- |
| 单元 | `tests/unit/session-markdown.test.mjs` | 骨架与元信息 / 用户（技能、图片）/ 助手（正文、思考、工具、错误与中止）/ 命令 / 压缩 / 分支摘要 / 模型切换 / 扩展消息 / 产物 / 空会话 / 截断 / 围栏 / 脏数据 |
| 集成（**本机真跑**） | 同上最后一条 | 写一个真实 `.jsonl` → pi 的 `SessionManager.open().getBranch()` → 渲染 → 断言内容与「只认当前分支」 |
| GUI | `tests/e2e/export-markdown.mjs` | 菜单两项并列 / 导出真的落盘且内容正确 / 界面给的是成功反馈 / 截图 |
| GUI | `tests/e2e/ipc-functional.mjs` 第 16 项 | 从 Node 侧读回导出文件（不只看返回值），断言 `.md` 与非空 |

**反向验证（真跑并还原，实测输出）**

1. 让 `clamp()` 不再截断：
   ```
   × 超长工具输出被截断，并标明原长度（与界面同一口径）
   × clamp 只在超过上限时截断
   Tests  2 failed | 13 passed (15)
   ```
2. 让 `fenceFor()` 写死三个反引号：
   ```
   × 内容里的反引号会把围栏撑长（导出文档不会被内容截断）
   Tests  1 failed | 14 passed (15)
   ```

## 七、评审发现与处置（2026-10-03，独立审查子 agent）

| 发现 | 处置 |
| --- | --- |
| **工具入参没截断**：`write` / `edit` 的 `arguments` 里装的是整个文件正文，一条调用就能把导出撑到几 MB —— 只截结果不截入参，等于口径只兑现一半 | 已抽 `clampedBlock(raw, language)`，**结果与入参走同一个函数**；截断后按 text 渲染（内容已不是合法 JSON）；补了一条 200 KB `write` 入参的断言 |
| `ipc-functional` 第 16 项的「跳过」写成裸 `return` → harness 记成 **PASS**，且它依赖的前提（前面发过消息）不成立 | 已改成**自给自足**：自己预置一条有内容的会话文件再导出，并断言文件里的用户/助手文本（不靠别项的副作用） |
| `hasExportableContent` 与渲染器**两处都不一致**（compaction / branch_summary / 产物-only 会被误判成空；`display:false` 的反被判成有内容） | 判据改成**与渲染同源**：抽出 `renderSessionBlocks()`，空不空看渲染出来的段落 |
| 助手消息的块顺序与 HTML 导出不同（思考被一律挪到正文之后，而 pi 常见顺序是 `[thinking, text]`） | 已改成**按 content 原序**渲染 text/thinking、toolCall 收尾（与 HTML 的两遍结构一致），并补了断言 |
| e2e 的 `clickMenuItem` 没断言「菜单项在可视区内」；PRD / CHANGELOG 里的「产物面板」措辞不准（实际是 `shell.openPath` 交给系统默认程序） | 已补可见区断言；三处文档措辞改成「交给系统默认程序打开」 |
| 单元测试里 `md.length < long.length` 是弱断言 | 已换成断言文档总长有上界 + 含截断标记 |
| **菜单越界**这条被本轮推到会真发生（详见下一节） | 已修 + 补 GUI 断言 |

## 八、顺带发现的既有缺陷：菜单越界（**归 #118，不在本 PR**）

写这个功能的 GUI 用例时，发现会话行的 ⋯ 菜单在靠窗口底部时会落到 `.sidebar-scroll`
的可视区之外（最后几项点不到，最靠下的那一项正是**删除**）。这条**不是本 PR 修的** ——
它随「会话置顶」（#118）一起修掉：那边的置顶项把菜单推到更容易越界的位置，
而且那边新增了「点菜单项之前先断言它在可视区内」的守卫，第一次真跑就把这条抓了出来。

这里留一条记录，是为了下一轮读这份文档的人知道「菜单为什么会翻到上面」：
实现与调试经过（含 React #185 那一次反馈环、以及 CSS 源序把 `top` 覆盖回去）写在
`.trellis/tasks/10-03-session-pin/design.md`。

本 PR 与 #118 的边界（避免下一个人翻两遍）：本 PR 只动导出（渲染器 + IPC + 菜单项文案），
菜单的定位与翻转属于 #118。
