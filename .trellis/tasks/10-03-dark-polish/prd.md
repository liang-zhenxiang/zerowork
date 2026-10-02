# 暗色与首屏视觉收口：把第一眼做到精品

> 诊断与提案的完整依据见 `research/design-review.md`（设计师视角，2026-10-03）。
> 本文件只保留**结论、范围与验收标准**。

## Goal

暗色主题落地（PR #66）之后，深色下暴露出一处**真实缺陷**与几处观感落差。
本任务把它们逐项收口，并把「首页主列垂直节奏」这条只写在文档里的约定**变成断言**。

## 背景：已核实的事实

### 事实 1（缺陷）：输入卡外槽的渐变是硬编码亮色，深色下没有任何覆盖

- `src/renderer/src/app.css:2142`：`.composer-slot { background: linear-gradient(180deg, #f0f0f0 0%, #f5f5f5 100%) }`
  —— **两个写死的亮色字面量**
- `[data-theme="dark"]` 块里**没有**任何 `.composer-slot` 覆盖，也没有对应 token
- 后果：**深色首页的最重盒子自带一圈浅灰发光边**（深色截图里肉眼可见，
  底缘最宽——那正是 `.composer-slot` 的 `padding: 2px 2px var(--space-1)`）。
  全页最亮的区域是这圈边，与 `docs/DESIGN.md` §3.9「唯一的视觉重点是输入卡」相反
- **为什么静态检查没抓到**：`scripts/check-theme-tokens.mjs` 校验的是
  「亮色 token 块里随主题变化的名字必须有暗色覆盖」——它**只认 token 对**，
  认不出「压根没走 token 的字面量」。这是一处结构性盲区
- 那条 `app.css` 注释写着「仍不入 token 档（场景原值，§2.7 已登记同类例外）」——
  **这句写于暗色主题存在之前**；单主题时代「不入档」是合理的，双主题时代它是漏配

### 事实 2（观感）：案例卡封面在深色下是四块亮色实拍图

- 封面来自远程 CDN：`resources/welcome/cases.json` 的 `cover` 指向
  `https://static.workbuddy.cn/...`（`EXTERNAL_REQUESTS.md` §6 已登记为「⚠️ 不可控」）
- `.case-cover img` 只有 `object-fit` 与 `border-radius`，**深色下无任何压暗**
- 于是首屏**最亮的四块矩形是别人的实拍图**，视线先被它们吸走再回到输入卡
- **兜底反而是对的**：`.case-cover` 的底色用 `var(--bg-raised)`、图标用 `var(--text-secondary)`
  —— 即「图挂了是暗色正确的，图加载成功才是亮的」，两个分支观感相反
- 另有一处硬切：兜底暗底 → 实图亮色，加载完成时闪一下

> **本任务只解决观感**（深色下压暗 + 淡入）。「首屏依赖第三方 CDN」这件事
> 涉及再分发授权（`AGENTS.md` 红线 9），**另开 Issue 记录，不在本任务里动**。

### 事实 3（守约）：首页垂直节奏与 §3.8 逐项一致 —— **不需要改**

设计师实测了 `home-title` / `mode-tabs` / `capability-row` / `home-guide` 的
`margin-bottom`，是 **12 : 12 : 24 : 16**，与规范完全一致。**已核实的「不是问题」。**

### 事实 4（不是问题）：侧栏「规划中」在深色下的对比度

实测 **深色 6.17:1，优于浅色 3.89:1**。浅色低于 AA 4.5:1，但
(a) WCAG 1.4.3 对 disabled 控件明确豁免，(b) `docs/DESIGN.md` §2.1 已把「降一档」
定义为 50% 这一档。**本轮不动颜色。**（这条是设计师主动推翻的假设，记录下来防止下一轮重提。）

## Requirements

### R1 修掉输入卡外槽的深色缺陷

- 把该渐变现成一个 token（亮色块定义、暗色块同名覆盖），`.composer-slot` 改引 token
- 两个主题下都读作「比主背景深一档的凹槽」，语义一致（§2.0 双块同构）
- 改完后 `npm run check:theme-tokens` 必须通过 —— 这条覆盖是它**自动接管**的，
  不只是修一处颜色，是把盲区里的一条拉回检查范围

### R2 深色下把案例封面收进暗环境

- 深色下压暗封面（`filter`），**不改 `cases.json`、不动 CDN、不碰授权面**
- 封面加载完成时**淡入**，消除「暗底 ↔ 亮图」的硬切；过渡走既有 `--dur-*` 与缓动
- 浅色下的观感**不得改变**

### R3 把 §3.8 的节奏从文档搬进断言

- 在 GUI 用例里读四个元素的 computed `margin-bottom`，断言 `12 / 12 / 24 / 16`
- 这条守的是 §3.8 记载的那类事故：**分组变了而间距没跟着分**，
  结果「主列最大的一段空白落在两个本该挨着的控件之间」

## Acceptance Criteria

- [ ] 深色首页的输入卡外槽不再是亮色：截图可见，且**有像素证据**
      （外槽区域的平均亮度在深色下不高于主背景一个可辨阈值）
- [ ] `--composer-slot-bg` 在亮色与暗色两块都有定义；`npm run check:theme-tokens` 通过
- [ ] 深色下案例封面的亮度显著低于修复前（**有前后像素对比**），浅色下像素无变化
- [ ] 封面淡入用的是既有 `--dur-*` / 缓动 token，且 `prefers-reduced-motion` 下关停
- [ ] GUI 用例断言 12 : 12 : 24 : 16；**把其中一个值改坏，该用例必须变红**（反向验证）
- [ ] 浅色与深色两套主题的首页截图各留一张，人工看过
- [ ] `npm run lint:all`、`npm test`、`npm run test:gui` 全绿，既有用例一条不少
- [ ] `CHANGELOG.md` 的 `[Unreleased]` 记入「修复」（写清此前错在哪、有什么后果）
- [ ] 若 §3.8 的节奏断言与文档不一致，**以文档为准并修代码**，同时在此写明

## 约束

- **不引入依赖**、不改 `resources/**`、不碰 `cases.json` 的 `cover` 字段
- **不新增视觉档位**；不动既有的 `--radius-lg` 例外与 `home-main` 的 `padding-bottom`
  （那两处都有明文依据，见 `research/design-review.md` 的「不做」）
- 不为 lint 通过而大规模重排 `app.css`

## 执行顺序（本任务按**轻量任务**处理：PRD 即全部规划产物）

三条需求都落在「改一处、验一处」的尺度上，不另写 `design.md` / `implement.md`：

1. **R1**：`app.css` 的 `:root` 增 `--composer-slot-bg`、`[data-theme="dark"]` 增同名覆盖、
   `.composer-slot` 改引 token → `npm run check:theme-tokens`
2. **R2**：`.case-cover img` 加淡入过渡；`[data-theme="dark"] .case-cover img` 加压暗
3. **R3**：`tests/e2e/gui-smoke.mjs`（或新用例）断言四个元素的 `margin-bottom` 为 12/12/24/16
   → 反向验证：把其中一个值改坏，确认该断言变红
4. 截图（浅/深各一张）+ 像素对比，人工看一眼
5. CHANGELOG + 若动了登记表则同步 `docs/DESIGN.md`

## 明确的后续项（本任务不做）

| 项 | 为什么不在本任务做 |
| --- | --- |
| 首屏案例封面改为随包本地图 | 需要 12 张图 + **再分发授权确认**（红线 9 / `THIRD_PARTY_NOTICES.md`）。另开 Issue 记录 |
| 给 `check-theme-tokens` 加「字面量逃逸」检测 | 独立缺口：它现在只认 token 对。本任务把 `.composer-slot` 拉回 token 覆盖面，但**检测能力本身**没变 —— 另开 Issue |
| 「规划中」浅色对比度 | 已判定不是问题（见事实 4） |
| 档外阴影补暗色版 | `docs/DESIGN.md` §10.3.2 已登记理由，无新证据 |