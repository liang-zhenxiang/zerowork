# 首屏案例封面改成本地生成：把「本地优先」的第一屏还给用户

## Goal

首页「最佳实践案例」的 12 张封面**直接引第三方 CDN**（`static.workbuddy.cn`，
`EXTERNAL_REQUESTS.md` §6 登记为「⚠️ 不可控」）。

数据面没问题（只是图片地址，服务端不因此拿到任何会话数据），但**体验面破功**：
一个把「本地优先」当卖点的产品，第一次打开就向第三方域名发请求。用户装它正是因为
不想让数据出去 —— 而第一屏就在出网。暗色主题落地后这件事更显眼：深色首页里最亮的
四块矩形是别人的实拍图，视线先被它们吸走再回到输入卡，与 `docs/DESIGN.md` §3.9
「唯一的视觉重点是输入卡」相反。

## 背景：已核实的事实

| 项 | 结论 | 出处 |
| --- | --- | --- |
| 封面从哪来 | `resources/welcome/cases.json` 的 `cover` 字段（12 条，全部指向 `static.workbuddy.cn`） | 直接读文件 |
| 谁在渲染 | `CaseCover`（`app.js`）：`<img onLoad/onError>` + 图标兜底；加载失败只显示一个居中图标 | `app.js` 的 `CaseCover` |
| 加载器**强制要求** cover | `resources.js` 的 `requireStringField(raw, "cover", at)` —— 直接从 JSON 删掉这个字段会让**整份案例数据加载失败** | `src/main/daemon/resources.js` |
| 分类色板 | `--cat-1..6` 六槽，**已同时定义在亮色与暗色两个 token 块**（`check-theme-tokens` 覆盖它） | `app.css` 的 token 块 |
| 之前的观感补丁 | 深色下给 `img` 加 `brightness(.86) saturate(.94)` 并淡入（2026-10-03，#114 同轮）—— 它治的是症状，且有一条 GUI 断言盯着 | `dark-polish.mjs` ④⑤ |
| 授权面 | 第三方图**随包分发属于再分发**，须先确认（红线 9；与 #19 同类）—— 未确认 | `AGENTS.md` 红线 9、`THIRD_PARTY_NOTICES.md` |
| 同类做法 | 封面这类「首屏视觉锚点」在同价位产品里几乎都是**第一方生成**（几何 + 分类色），不引外链 | 命令面板那轮调研的同类观察（`research/competitor-gaps.md`） |

## 三条候选中为什么选 B

| 路径 | 判断 |
| --- | --- |
| A. 12 张图降采样后随包 | **信息量最全，但先要过授权**（红线 9）。授权没确认之前不能做 —— 而这件事已经挂了两轮 |
| **B. 第一方生成封面**（本任务） | **无授权风险**，且顺带解决暗色下的观感问题。代价是丢掉「这是实拍成品预览」的信息量 —— 用一个**按交付物类型画的示意图**把这一半补回来（文档 / 图表 / 幻灯片 / 研究笔记四种形态） |
| C. 磁盘缓存 + 降采样 | 仍要联网一次，**体验面与可信度问题没解决**；单独用不足以关闭本 Issue |

## Requirements

- **R1 第一方生成封面**：新模块 `src/renderer/src/case-cover.js`（纯逻辑，可单测）：
  - `coverVariant(chipId)` → `doc` / `chart` / `slide` / `note`（未知 chipId 有确定缺省）
  - `coverAccent(chipId)` → 既有分类色板里的一个（`--cat-*`，**不新造颜色**）
  - `coverSeed(caseId)` / `coverLines(caseId)` / `coverBars(caseId)` → 由 id 派生的
    确定性几何（同一 id 永远同一结果；同类目下三条互不相同，避免三张一样的瓷砖）
- **R2 渲染**：`CaseCover` 改成画示意图（sheet + 顶部色条 + 内容线 / 竖条 / 幻灯片块），
  **不再使用 `<img>`、不再有任何远程 URL**；装饰对屏读隐藏（`aria-hidden`）。
- **R3 数据面**：`cases.json` 去掉 `cover` 字段；`resources.js` 的加载器**不再要求**它
  （并说明为什么）；`resources/welcome/README.md` 的字段表同步。
- **R4 主题**：亮暗两套下都清晰（背景走 `color-mix` 混既有 token，不新增 token）；
  **删掉**深色下给 `img` 用的 `filter` 与淡入规则（连同 reduced-motion 里那一条）。
- **R5 文档**：`EXTERNAL_REQUESTS.md` §6 从「不可控」改为「不出网」并更新计数与结论；
  `THIRD_PARTY_NOTICES.md` 如列了这批图则同步；`CHANGELOG.md` 记一条。

## Acceptance Criteria

- [x] 首页封面**不再产生任何远程请求**（GUI 用例断言：卡片里没有 `<img>`、
      产物/repo 里搜不到 `static.workbuddy.cn`）
- [x] **断网仍照常渲染**（GUI：`context.setOffline(true)` 后整页 reload，封面还在、不是白块）
- [x] 12 张封面彼此可辨（同类目三条不雷同），浅/深两套主题截图 + 像素断言
- [x] 单测覆盖 `case-cover.js`：变体映射、色板映射、几何确定性、取值域、同类目三条不雷同
- [x] 既有用例一条不少；`dark-polish` 里那两条盯着 `img` 的断言**随规则一起删掉**
      （规则没了还留断言 = 假通过）
- [x] `npm run lint:all` / `npx vitest run` / `npm run test:gui` 全绿
- [x] 中文内容 U+FFFD 扫描通过

## 约束

- **不放宽任何安全约束**（本任务只减外联，不增）
- 不动 `resources/**` 里除了 `cases.json` 字段与 `README.md` 说明之外的内容
- 不新增第三方依赖；不新造颜色 token（复用 `--cat-*` 与既有底色）
- 渲染层改动外科手术式（红线 6）

## 非目标

- 不恢复路径 A（若将来授权确认，那份图可以另开任务，与本地生成并存没有意义 ——
  真要恢复就是换回来，本任务的价值是「不必等授权也能体面」）
- 不做每个案例一张手绘插图（12 张手绘是另一个量级的成本，且与「可维护」相反）
- 不改案例卡的标题/分页/点击行为

## 入手位置

- 新建 `src/renderer/src/case-cover.js` + `tests/unit/case-cover.test.mjs`
- `src/renderer/src/app.js` 的 `CaseCover`（约 16018 行）
- `src/renderer/src/app.css` 的 `.case-cover*`（约 3301 行）与 reduced-motion 块
- `resources/welcome/cases.json`、`resources/welcome/README.md`
- `src/main/daemon/resources.js`（`requireStringField(raw, "cover", …)`）
- `EXTERNAL_REQUESTS.md`、`tests/e2e/dark-polish.mjs`
- 新建 `tests/e2e/offline-covers.mjs`

## 难度

中。技术实现不难（几何 + 色板），真正的成本在**跨文件一致性**：
数据、加载器、渲染、样式、两处文档、两条旧断言，六处必须同时改对 ——
少改一处就是「装了包但封面是白的」或「断言盯着一个不存在的规则」。
