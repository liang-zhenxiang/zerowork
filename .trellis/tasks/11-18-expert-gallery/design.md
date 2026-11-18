# 设计：能力库画廊（#421）

## 1. 数据面（只增不改）

`loadExperts` 目前把 `loaded.skills` 丢掉了（只有 def + source）。改为把技能引用带回：

```js
{ ...loaded.def, source, skills: [{ name, file }], ...packMeta }
```

`session-files.js` 的 `listExperts` 投影新增（缺省不带字段）：

- `skills: [{ name, description }]` —— 按 file 读 frontmatter 的 `description`；读不到就 `""`
  （UI 留白，不伪造）。
- `agents: number` —— `expert.agents.length`（团队型）。
- `packInstalledAt: number` —— 从 `_pack.json` 读（`readPackMeta` 补该字段）。

现有字段（name / displayName / profession / description / displayDescription /
quickPrompts / tags / source / expertType / packId / packVersion）一个不改。

## 2. 渲染层纯函数：`src/renderer/src/expert-gallery-core.js`

新模块（可被 vitest 直接 import，同 `command-palette-core.js` 模式）：

```
SOURCE_FILTERS = [{id:"all",label:"全部"},{id:"builtin",label:"内置"},
                  {id:"user",label:"我的"},{id:"pack",label:"能力包"}]

filterExperts(experts, {source, tag, keyword}) -> expert[]
sortExperts(experts, mode)                     // "default" | "name" | "recent"
sourceCounts(experts) -> {all,builtin,user,pack}
expertCategory(expert) -> 1..6                 // 封面色条：按 name 稳定哈希
pathsFromDropText(text) -> string[]            // file:// URI → 本地路径（去重、保序）
isPackDropPath(path) -> boolean                // .zwpack / .zip / 目录一律交给 daemon 校验
```

排序规则：
- `default`：保持 daemon 顺序（内置 → 能力包 → 我的）。
- `name`：`displayName` 用 `localeCompare(..., "zh-Hans-CN")`，同分按 `name`。
- `recent`：`packInstalledAt` 降序；非包按 `displayName` 排在后面（不伪造安装时间）。

拖拽路径解析（`pathsFromDropText`）：
- 输入 `text/uri-list` 或 `text/plain`，按行取 `file://` URL；
- `new URL()` + `decodeURIComponent`；`file:///C:/x` → `C:/x`，`file:///Users/x` → `/Users/x`；
- 非 `file:` 或解析失败的行丢弃；结果去重保序。
- 真实 OS 拖拽优先走 preload 已有的 `getFilePath(file)`（`webUtils.getPathForFile`），
  `uri-list` 是后备（也让 e2e 能构造）。

## 3. 界面结构

```
skills-body > ExpertsView
├─ ex-topbar           搜索 + 导入能力包… + 我的专家
├─ ex-source-row       来源四档（chip，带计数）         ← 新
├─ ex-tools-row        排序 select（默认/名称/最近安装） ← 新
├─ ex-cats             现有标签筛选（保留）
└─ ex-grid / 空态 / 错误态
   └─ ExpertCard       + 封面色条 + 来源/版本/技能数元信息
```

- 来源与标签是**与**关系；搜索与两者也是**与**。无结果时给「清除筛选」。
- 排序控件用原生 `<select>` + 现有边框语汇（与设置页一致），不用自定义下拉。
- 卡片：
  - 顶部 3px 色条：`data-cat="1..6"`，颜色 `--cat-N`；纯装饰、`aria-hidden`。
  - 头部右下角来源徽标：内置（不显示徽标，避免噪声）/ 我的 / 能力包（带 `v1.0.0`）。
  - 描述下 meta 行：`N 个技能`；能力包追加 `· M 月 D 日安装`（本地时区）。
- 详情（`ExpertDetailModal`）：
  - 在「专家帮你做」之后加「包含技能（N）」分区：名称 + 描述（缺描述只显示名称）。
  - 团队型显示「成员 N」。
  - 来源行扩展：内置 / 我的专家 / 能力包 `<id>@<version>`（+ 安装时间）。
  - 内置专家附一句「内置专家可能包含第三方内容，暂不支持导出」——与按钮 disabled 一致。

## 4. 拖拽导入

- `ExpertsView` 增加 `onDragOver/onDragLeave/onDrop`（挂在 `.ex` 容器）。
- `dragenter` 且 `dataTransfer.types` 含 Files 时显示覆盖层「松开以导入能力包」；
  `dragleave`（relatedTarget 在容器内不闪）+ `drop` 隐藏。
- `drop`：先 `files` → `window.kami.getFilePath(file)`；为空则读 `text/uri-list` →
  `pathsFromDropText`。取第一个路径：
  - 扩展名不是 `.zwpack` / `.zip` 且不是目录时，toast 说明「请拖入 .zwpack 能力包」；
  - 否则走与按钮相同的 `inspectPack` → 预览流程。
- 目录拖拽也允许（daemon 支持），但 UI 文案以 `.zwpack` 为主。

## 5. 测试

- **单测** `tests/unit/expert-gallery-core.test.mjs`：
  - 筛选矩阵（source × tag × keyword）、计数、排序稳定性和中文排序、
    `recent` 对非包不伪造时间、`expertCategory` 稳定且 1..6、
    `pathsFromDropText` 覆盖 mac/Windows/编码/重复/非 file URI/空行。
- **e2e** `tests/e2e/gui-expert-gallery.mjs`：
  - 来源筛选：点「能力包」后只剩 pack 卡（预置一个能力包夹具，复用 #420 的安装路径）；
  - 排序：切「名称」后卡片顺序变化且与 `localeCompare` 一致（读 DOM 的 name 列表）；
  - 详情：装一个带技能的包，打开详情，断言技能名与描述、来源版本、安装时间；
  - 拖放：合成 `DragEvent` + `DataTransfer` 带 `text/uri-list`（指向夹具目录）→ 断言预览弹窗与拖放覆盖层；截图亮/暗。
  - 截图先于断言之后的视觉证据；全部用 `waitUntil`。
- **回归**：`gui-pack` 10/10、`gui-smoke`、`ipc-functional`、`bridge-rest`。
- **反向验证**：把 `filterExperts` 的 source 分支短路 → 新 e2e 必红；还原。

## 6. 取舍

- **不把标签改成领域树**：现有标签就是领域切片；再加一层树会让 10 个专家的页面变重。
  来源筛选是这次真正缺的维度。
- **不在卡片上放封图**：项目没有专家封面素材，自动生成大图会抢卡片内容；
  3px 色条提供「成组可辨」的视觉节奏，详情仍以文字为主。
- **停用不做**：见 #426；本轮不引入半生效的状态。
- **拖放不作为唯一入口**：文件选择器保留；拖放是加速。
