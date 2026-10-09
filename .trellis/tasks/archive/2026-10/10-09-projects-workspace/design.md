# 技术设计：项目工作区 Projects

> 落点全部经 projects-research 报告核实（文件:行号为 2026-10-09 main）。
> 视觉细节以 ux-designer 方案为准收敛进 app.css，本文管**结构与契约**。

## 1. 模块边界（红线 6 的规避：不重排大文件）

| 新文件 | 职责 | 依赖 |
| --- | --- | --- |
| `src/main/daemon/projects.js` | projects.json 的 store（读写、CRUD、会话映射）+ 会话→项目反查 | config-paths.js；**不 import session-files.js**（可单测） |
| `src/renderer/src/projects-core.js` | 纯逻辑：卡片墙排序/过滤、详情聚合（会话×产物×项目）的视图模型、色轮转 | 零依赖（session-pin.js 同模式） |
| `src/renderer/src/projects-view.js` | ProjectView 组件 + 两级视图 JSX | projects-core.js；由 app.js import |
| 修改 `app.js` | 仅追加：NAV ready + onOpenProjects + view 装配 + ⋯ 菜单项（各一小块，不重排） | — |
| 修改 `app.css` | 仅追加 projects 区段样式（走既有 token） | — |
| 修改 `session-files.js` | IPC handler 登记（一处）+ compose 回调注入（一处） | projects.js |

## 2. 数据与契约

### 2.1 projects.json（照 pin.js 形态：原子写、坏当空、结构校验）

```jsonc
{
  "version": 1,
  "projects": [
    {
      "id": "p_…",            // crypto.randomUUID()
      "name": "Q3 竞品调研",
      "colorIndex": 2,         // 0..5 → --cat-1..6；创建时按现存项目数轮转，可改
      "instructions": "",      // 常驻指令，≤2000 字，空串=无
      "createdAt": 1730000000000,
      "sessionPaths": ["/abs/…jsonl"]   // resolve 后绝对路径（与 pin/archive 同键口径）
    }
  ]
}
```

- **会话引用不做主动清理**：会话文件可能暂时不可达（外置盘/同步中），与 pin.js 的
  「不清理指向已消失会话的条目」同理由；详情视图对读不到的会话显示「不在磁盘上」
  而不是把它删掉（静默丢东西是明确禁区）
- store 接口：`listProjects() / createProject(name) / renameProject(id,name) /
  deleteProject(id) / setColor(id,colorIndex) / setInstructions(id,text) /
  assignSession(path,projectId|null)`；assignSession **跨项目去重**：
  先从旧项目移除再加入新项目（一个会话只属一个项目，MVP 约束）

### 2.2 IPC（四处登记，照 pin 全链路）

`src/shared/ipc.js` INVOKE 表新增：

- `projectsList` / `projectsCreate {name}` / `projectsRename {id,name}` /
  `projectsDelete {id}` / `projectsSetColor {id,colorIndex}` /
  `projectsSetInstructions {id,text}` / `projectsAssignSession {sessionPath,projectId|null}`
- PUSH 复用既有 `taskListChanged`（assignSession 影响侧栏标记）；
  项目列表本身**纯拉式**（打开视图时读，与资料库同口径——不占后台）
- handler 落 `session-files.js` 的 handlers 表（`:4369` pin 样例同款，参数逐个校验，
  非法参数 throw 带原因的 Error）；`src/main/index.js:382` 自动转发，无需改

### 2.3 会话行→项目标记（listSessions 增量字段）

`listSessions` 每项**增** `projectId?: string`（无项目则缺省字段——不是 false，
避免三态歧义）。daemon 读 projects store 反查注入。渲染层侧栏行画项目色点
+ `title="项目：{名}"`（§7.6 冗余）。

## 3. 常驻指令注入（方案 A，research 已核实可行）

`prompt-compose.js` 的 `composePromptWithMeta` 增可选入参 `projectInstructionsBody`：
与 `memorySystemBody` 同型的**追加段**（`all.push`），段名 `project-instructions`，
segments 自动带来源标注（诊断面板可见、`promptPreview` IPC 同源一致）。

链路（四处小改）：

1. `prompt-compose.js`：入参 + push 段
2. `command-exec.js:1611` createPromptSwitch 的 getCurrent 增 `projectInstructions` 字段
3. `session-files.js:2886` 用户会话装配的 compose 回调：`projectsStore.instructionsFor(bucket.sessionFilePath)`
   （store 内存索引，O(1)，无项目命中返回 undefined → 不进注入路径，零开销）
4. `resources.js` 透传（`274/292` 一带）

**边界**：指令为空串 = 无段（与无项目完全一致）；改指令下一轮即生效（before_agent_start
每轮现组装）；子代理/团队/对比列会话**不注入**（只有用户主会话的 compose 回调接了）——
对比列没有工作空间上下文，注入项目指令反而是噪音。

## 4. 视图结构（overlay，照 LibraryView 模式）

```
view === "projects" && <ProjectView
    onClose={→ setView(returnView)}      // openProjects 记 returnView（chat 优先）
    onResumeTask={resumeTask}            // 点会话即 resume（#162 已回落模型）
    sessions={taskList}                  // 复用既有推送数据，不另拉
    library={readLibraryArtifacts 的缓存}// 产物区按来源会话过滤（projects-core 纯函数）
  />
```

- 三态一行表达式照 LibraryView（`:67654`）；空项目墙的 EmptyState 给「新建第一个项目」
  主按钮（§4：空态给第一步）
- L1→L2 用视图内部 state（selectedId），不新增路由概念；Esc/返回键回 L1
- 指令编辑：受控 textarea + 2000 字计数（超限禁存并提示），保存按钮 + 已存标记；
  失焦不自动存（编辑中切走要留现场？——MVP：离开详情即丢未保存草稿，保存按钮旁
  明示「未保存」。避免半套草稿持久化）

## 5. ⋯ 菜单「归入项目」

照置顶样例（`app.js:13576`）加子菜单形态：点「归入项目」→ 就地展开项目列表
（最多 6 项 + 「新建项目…」）。已归入的会话显示「移出项目」与「换到…」。
菜单项点击 → `kami.projectsAssignSession(path, projectId|null)` → PUSH taskListChanged
→ 侧栏标记即时更新。

## 6. 安全与红线自检

- 不放宽任何权限；projects.json 是本地偏好数据，不涉凭证
- 「删除项目不删会话/文件」在确认弹窗里写明（宁可明确说清，不静默）
- app.js / session-files.js 只做追加式小块，不动既有行（红线 6）
- 新 CSS 全走 token（check-theme-tokens 双查：token 对 + 字面量逃逸）
- 不在 `resources/**` 应用工具链（本功能不碰 resources）

## 7. 测试设计

| 层 | 什么 | 怎么 |
| --- | --- | --- |
| 单元 | projects store CRUD/坏文件/原子写/assignSession 跨项目去重/会话引用不清理 | 临时目录真文件，vitest |
| 单元 | projects-core 视图模型（排序、产物过滤、色轮转） | 纯函数直测 |
| 单元 | compose 注入：有指令含段（带标注）/无指令与现状逐字节一致 | 快照对比 |
| e2e/GUI | 全链路：建项目→归入→详情→resume→指令注入（mock 收到的 systemPrompt 含段）→删除项目会话还在 | harness + mock 模型；浅/深截图各 ≥2 |
| 回归 | 全量 test:gui（31 套件）+ lint:all | CI 门禁 |

## 8. 回滚

单 PR 独立分支；projects.json 是新增文件（老版本无此文件即无项目功能，天然向后兼容）；
IPC 通道为新增不覆写；回滚 = revert 该 PR，无数据迁移负担。
