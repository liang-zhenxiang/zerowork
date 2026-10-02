# 暗色主题设计评审（v0.2.x 现状）

> 截图:`artifacts/tour/`(2026-10-03 抓取)。不改源码。对比度按 WCAG 相对亮度公式手算,
> 半透明文字先 α 混合到实际底色再取值。

## 一、诊断

### D1 【P0】输入卡外槽在深色下是一圈亮边 —— 硬编码渐变逃出了 token 体系
- 现象:`04-home-dark.png` 输入卡四周有一圈浅灰光晕、底缘最宽;浅色下正常。
- 用户感受:全页最重的盒子自带发光边,像没接完线的半成品。§3.9 要的是「唯一视觉重点
  是输入卡」,实际读成「唯一会发光的框」。
- 成因:`src/renderer/src/app.css:2142`
  `.composer-slot { background: linear-gradient(180deg, #f0f0f0 0%, #f5f5f5 100%) }` ——
  **两个写死的亮色字面量**。`[data-theme="dark"]`(app.css:700 起)**没有**覆写,
  也没有对应 token(全文件仅 3 处 `composer-slot`,无一处含颜色)。
  `scripts/check-theme-tokens.mjs` 只校验**同名 token 对**,认不出「没走 token 的字面量」
  ——这是它的结构性盲区,本条正踩在盲区上。

### D2 【P0】案例卡封面在深色下是四块亮色图片
- 现象:深色首页底部四张案例卡,封面仍是米白/浅色实拍图。
- 成因(三层):
  1. **远程 CDN 图**:`resources/welcome/cases.json` 的 `cover` 指向
     `https://static.workbuddy.cn/workbuddy/playbook/cases/*.png`(12 张)。
     `EXTERNAL_REQUESTS.md` §6 标为「⚠️ 不可控」,备选关法是 vendored 12 张本地图
     或清空字段,当前**保持原样**。
  2. **深色下无任何压暗**:app.css 的 `.case-cover img` 只有 `object-fit: cover`
     与 `border-radius: inherit`。
  3. **兜底反而是对的**:`.case-cover` 底用 `var(--bg-raised)`(dark `#26262a`)、
     图标色 `var(--text-secondary)`。即**图挂了是暗色正确的,图加载成功才是亮的** ——
     两个分支的观感是反的。
- 三方面含义:
  - **暗色观感**:四个亮矩形是全页最亮的区域,权重与「这是推荐案例」不匹配;
    视线先被图片吸走再回到输入卡,与 §3.9 的盒子预算反向。
  - **本地优先**:`EXTERNAL_REQUESTS.md` 写明「只是图片地址,服务端不获得会话数据」——
    **数据面没问题,体验面破功**:首屏的视觉锚点需要联网。
  - **断网可用性**:兜底路径存在且主题正确,不会白块 —— 这条**不是缺陷**。
    真正的缺口是实图与兜底之间硬切(`--bg-raised` 暗底与亮图色差极大,加载完成闪一下)。

### D3 【不是问题】侧栏「规划中」分组的文字色
- token:`app.css:9960-9967` `.nav-item-pending, .nav-item:disabled { color: var(--text-secondary);
  font-size: var(--text-meta) }` —— 12px 正文级,判据取 AA 4.5:1。
- 计算(相对亮度 L,对比度 `(L1+0.05)/(L2+0.05)`):

  | | 底色 | 文字(α 混合后) | L(底) / L(字) | 对比度 |
  | --- | --- | --- | --- | --- |
  | 浅色 | `--bg-sidebar` `#f2f2f2` | `rgba(0,0,0,.5)`→`#797979` | 0.8879 / 0.1911 | **3.89:1** |
  | 深色 | `--bg-sidebar` `#141416` | `rgba(255,255,255,.55)`→`#959596` | 0.00705 / 0.3019 | **6.17:1** |

- 结论:**深色 6.17:1 达标,且优于浅色**。浅色 3.89:1 低于 4.5,但
  (a) WCAG 1.4.3 对 disabled 控件**明确豁免**;(b) §2.1 已把「降一档」定义为 50% 这一档。
  **深色这条不是问题,本轮不动颜色。**

### D4 【守约】首页主列垂直节奏
- CSS 实测四项:`home-title` mb `--space-4`(app.css:1681)、`mode-tabs` mb `--space-4`
  (app.css:1805,注释写明由 64 收到 12)、`capability-row` mb `--space-6`(app.css:1866)、
  `home-guide` mb `--space-5`(app.css:2068)。即 **12 : 12 : 24 : 16,与 §3.8 逐项一致**。
- 目测 `01-home-light.png`(窗口≈1280 CSS px、截图 2x):标题底→胶囊 ≈13、胶囊底→chip ≈10、
  chip 底→清单 ≈27、清单底→输入卡 ≈22。同序同量级,最大一档确实落在 chip→清单 ——**守约,不必改**。
- 提示:`04-home-dark.png` 标题只有「ZeroWork,」是**打字机动画途中抓的帧**
  (与 02 设置页淡入同因)。与主题无关,不记为缺陷。

### D5 设置页深色
- `03-settings-dark.png` 未见硬编码亮色,分区分隔线与禁用行都由 token 承担,覆写到位。
- 唯一同源风险是与 D1 同类的「字面量逃逸」,按 D1 的解法一并登记即可。

## 二、提案

### P0-1 把输入卡外槽的渐变收进 token
- **感受改变**:深色下发光边框消失,输入卡回到「唯一的盒子」,与浅色语义对齐。
- **落点**:`app.css` `:root` 增 `--composer-slot-bg: linear-gradient(180deg, #f0f0f0 0%, #f5f5f5 100%)`;
  `[data-theme="dark"]` 增同名覆盖 `linear-gradient(180deg, #26262a 0%, #1f1f22 100%)`;
  `.composer-slot` 改引 `var(--composer-slot-bg)`。深浅都是「比 `--bg` 深一档的凹槽」,
  语义一致、数值同构(满足 §2.0)。
- **成本**:极小。三行 CSS。开 token 后 `check-theme-tokens.mjs` **自动接管**这个盲区
  (颜色类在反名单之外,漏配暗色会静态红)——这是本条的主要价值,不只是修一处色。
- **测试义务**:`check-theme-tokens` 现有断言即覆盖,无需新增;
  若要眼见的锁,由 D4 的几何 e2e 顺带断言 `.composer-slot` 的 computed `background-image`
  在两个主题下不相同。

### P0-2 深色下压暗案例封面
- **感受改变**:四个亮矩形收进暗环境,注意力回落到输入卡;联网与断网两种首屏观感不再割裂。
- **落点**:`app.css` 增 `[data-theme="dark"] .case-cover img { filter: brightness(.86) saturate(.94) }`。
  **不动 `cases.json`、不动 CDN、不动授权面**。
- **成本**:一行 CSS,零资源改动。
- **测试义务**:几何/契约层面无需断言(图片非文字,无对比度义务);
  若要锁,加一条构建期扫描「`[data-theme="dark"]` 块内覆盖了 `.case-cover img`」的存在性断言即可 ——
  与 P0-1 同属「防回退」而非「防错」。

### P1-1 把 §3.8 的节奏从文档搬进断言
- **感受改变**:无直接观感变化;防的是 §3.8 记的那类事故重演
  (「64 没有被重新分配 → 最大空白落在两个本该挨着的控件之间」)。目前 12:12:24:16
  只是文档约定 + 注释,没有东西拦得住下一次插行。
- **落点**:`tests/e2e/gui-smoke.mjs` 读 `.home-title` / `.mode-tabs` / `.capability-row` /
  `.home-guide` 的 computed `margin-bottom`,断言为 12 / 12 / 24 / 16。
- **成本**:小,一段 evaluate。
- **测试义务**:这条**本身就是**测试义务,由 `npm run test:gui` 承担。

### P1-2 封面实图淡入,消除硬切
- **感受改变**:首屏加载完成时不再「啪」地闪出亮图,尤其深色下(暗底→亮图)落差最大。
- **落点**:`.case-cover img` 的 `opacity` 过渡,走既有 `--dur-fast` / `--ease-standard`(§3.2)。
- **成本**:一行 transition。
- **测试义务**:不新增;`opacity` 属 §5.1 允许的视觉属性,不触发布局。

## 三、不做

| 想法 | 理由 |
| --- | --- |
| vendored 12 张封面本地图 / 清空 `cover` 字段 | `EXTERNAL_REQUESTS.md` §6 已列为可控方案,但需准备 12 张图 + 授权确认(红线 9 / `THIRD_PARTY_NOTICES.md`)。P0-2 的压暗解决观感,不必先付这份成本。 |
| 改「规划中」的文字色让浅色也达 AA | 深色 6.17:1 本已达标;浅色是 §2.1「降一档=50%」的既定结果,且 disabled 有 WCAG 豁免。改它等于推翻上一轮刚沉淀的教训。 |
| 给案例卡加专用暗色底板 / 描边来「框住」图片 | 违反 §3.9 盒子预算(再加一层盒子);且案例槽几何与 §3.8 的 `padding-bottom` 耦合,牵一发动全身。压暗是零几何改动的解。 |
| 调整 `home-main` 的 `padding-bottom: 252px` | 它是与案例区实测高联动的几何值(§3.8 明文),本轮案例区高度未变,没有调整依据。 |
| 为 5 处档外阴影补暗色版 | `docs/DESIGN.md` §10.3.2 已登记:3 处落在自带亮底元素上、2 处由底色差承担。实测设置页与首页未见分层不足,无新证据,不动。 |
