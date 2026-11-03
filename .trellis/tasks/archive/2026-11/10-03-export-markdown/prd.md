# 导出为 Markdown：把会话带走

## Goal

会话行 ⋯ 菜单里的「导出」**只出一种东西：单文件 HTML**（pi 的 `exportToHtml`）。
HTML 自包含、能直接看，但**带不走**：贴进 Notion / Obsidian / 飞书文档 / PR 描述 /
周报都需要 Markdown，而从 HTML 页面上复制出来的是一坨带样式的 DOM。

这是办公场景里最常发生的一件事：**把这次对话沉淀成一份能继续编辑的文档**。

所以把菜单项拆成两条：**「导出为 HTML」/「导出为 Markdown」**，各自落到同一个
`exports/` 目录，导出后同样 toast 出路径并用系统默认程序打开（HTML 走浏览器、
.md 走系统关联的编辑器）。

## 背景：已核实的事实（一手读代码 / 读依赖）

| 项 | 结论 | 出处 |
| --- | --- | --- |
| 现有导出链路 | `INVOKE.sessionExport` → 会话宿主 `exportHtml` → `<工作空间>/exports/<标题>-<时间戳>.html`，返回 `{outputPath}` | `session-files.js` 的 `[INVOKE.sessionExport]`、`session-host.js` 的 `exportHtml` |
| 界面侧 | 导出后 toast 出路径，再调 `shell.openPath` 交给**系统默认程序**（不是应用内的预览面板 —— 应用内预览那是 `openPreview2` 那条路）；**非当前会话会先被恢复**（tooltip 里写着「恢复此会话并导出…」） | `app.js` 的 `exportTask`、`src/main/index.js` 的 `openArtifact` |
| pi 有没有现成的 Markdown 导出 | **没有**。`core/session-export.js` 只有 `serializeSessionBranch` / `exportSessionToJsonl`，`core/export-html/` 是 HTML 专用 | `node_modules/@earendil-works/pi-coding-agent/dist/core/` |
| 渲染口径的权威来源 | HTML 导出覆盖的条目类型：user（含技能块 / 图片）、assistant（text / thinking / toolCall、stopReason）、bashExecution、toolResult、model_change、compaction、branch_summary、custom_message(display) | `core/export-html/template.js` |
| 条目从哪拿 | 活的宿主里 `sessionManager.getBranch()` → 当前分支的原始条目数组（`SessionEntry[]`） | `core/agent-session.d.ts`、`core/session-manager.d.ts` |
| 可复用的现成件 | `splitSkillBlocks`（技能块 / 正文分离）、`DETAIL_LIMIT`(4000) 与 `TRUNCATED_MARK`（界面的截断口径）、`buildExportPath` + `sanitizeExportTitle` | `session-view.js`、`skills.js` |

## Requirements

### R1 渲染（纯函数）

- 新模块 `src/main/daemon/session-markdown.js`：输入 `{ title, header, entries, now }`，
  输出一段 Markdown 字符串。**不碰 IO、不 import Electron**，可以单测直接 import。
- 文档结构：一级标题（会话标题）→ 元信息（导出时间 / 工作空间 / 模型 / 消息与工具计数）→ 正文。
- 正文按分支顺序，覆盖 HTML 导出认得的每一类：
  用户文本、助手文本、思考、工具调用与结果、命令执行、压缩摘要、分支摘要、
  模型切换、技能调用、产物交付（`custom:artifacts_presented`）。
- **超长内容按与界面同一口径截断**（`DETAIL_LIMIT` / `TRUNCATED_MARK`），并在截断处
  标明原长度 —— 导出的是「你看到的东西」，不是一份 10 万字符的原始日志。
- **图片不内嵌 base64**：以一行文字占位（mimeType + 大致体积）。理由写在 design.md。
- 生成的 Markdown 必须**自洽**：代码围栏不会被内容里的反引号截断（动态选围栏长度）。

### R2 落盘与接口

- 新通道 `session:export-markdown`（`shared/ipc.js` 与 `preload/index.js` **两处都登记**），
  入参 `path`，返回 `{ outputPath }`，与 HTML 导出同形。
- 文件落到**同一个** `exports/` 目录、同样按标题 + 时间戳命名，扩展名 `.md`。
- 空会话给中文提示（与 HTML 导出同一句「该会话还没有内容可导出」），不写空文件。
- 非当前会话**沿用既有行为**：先恢复再导出（tooltip 文案同步说明）。

### R3 界面

- 会话行 ⋯ 菜单：「导出」拆成「导出为 HTML」「导出为 Markdown」，
  tooltip 分别写清（含非当前会话时的「恢复此会话并导出」）。
- 导出成功后的反馈与现有 HTML 导出**完全一致**（toast 路径 + 交给系统默认程序打开）。

## Acceptance Criteria

- [ ] `npm run lint:all` / `npm test` 全绿，既有用例一条不少
- [ ] 单元：覆盖每一类条目（用户 / 助手 / 思考 / 工具调用 + 结果 / 命令 / 压缩 / 分支摘要 /
      模型切换 / 技能 / 产物交付）、空会话、超长截断、围栏自洽、缺字段不崩
- [ ] **集成**（能在 Node 里跑，不需要 Electron）：预置一个真实 `.jsonl` 会话文件 →
      `SessionManager.open(...).getBranch()` → 渲染 → 断言关键内容都在
- [ ] GUI：预置会话 → ⋯ 菜单点「导出为 Markdown」→ `exports/*.md` 真的存在、
      内容含标题与对话正文、toast 里带的是成功提示与真实路径
- [ ] **反向验证**：注释掉截断 → 对应用例变红；把围栏长度写死成 3 → 含三反引号的用例变红
      （两条都真跑并记录）
- [ ] `CHANGELOG.md` 的 `[Unreleased] → 新增`、`docs/USAGE.md` 的会话一节同步
- [ ] 中文内容 U+FFFD 扫描通过

## 约束

- 不改 HTML 导出的任何行为（它由 pi 负责，我们只是并列加一条）
- 不放宽安全约束：新通道只读会话、只往**工作空间的 exports/** 写，不新增任意路径写入口
- 不动 `resources/**`，不新增第三方依赖
- 渲染层改动外科手术式（红线 6：`app.js` 是 6.8 万行 chunk 文件）

## 非目标

- **不导出 PDF / Word**：那是文档生成（`docx-engine`）的事，不是会话导出的形态
- **不导出被隐藏的注入上下文**（system prompt / pi context / 工具清单）：
  那是应用的管道，不是用户的内容；HTML 导出把它们放在「诊断面板」里，
  本轮 Markdown 不搬这套（要搬就得连诊断面板的语义一起搬）
- **不做「导出选中消息」**：先有整会话导出这一条完整路径

## 入手位置

- 新建 `src/main/daemon/session-markdown.js`（纯渲染）
- `src/main/daemon/session-host.js`（加一个只读窄出口：当前分支的原始条目）
- `src/main/daemon/session-view.js`（`buildExportPath` 支持扩展名参数）
- `src/main/daemon/session-files.js`（`[INVOKE.sessionExportMarkdown]`，照 HTML 那条分支写）
- `src/shared/ipc.js` + `src/preload/index.js`
- `src/renderer/src/app.js`（菜单两项 + `exportMarkdownTask`）
- `tests/unit/session-markdown.test.mjs`、`tests/e2e/export-markdown.mjs`、`tests/e2e/ipc-functional.mjs`

## 难度

中。难点不在写文件，而在**忠实**：条目类型多，错一类就是「导出来的东西少了半截」，
所以渲染逻辑全部放纯函数里，用预置会话文件 + 真实 `SessionManager` 做集成验证。
