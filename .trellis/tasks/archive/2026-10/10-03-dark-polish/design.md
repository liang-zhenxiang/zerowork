# 技术设计：暗色与首屏视觉收口

> 需求与验收标准见 `prd.md`；诊断的完整依据见 `research/design-review.md`（设计师评审）。
> 本文件只补「怎么改」与「为什么是这个值」。

---

## 1. R1：`.composer-slot` 的渐变收进 token

### 现状

```css
/* app.css:2141（浅色，唯一一处）*/
.composer-slot {
	background: linear-gradient(180deg, #f0f0f0 0%, #f5f5f5 100%);
}
```

`[data-theme="dark"]` 块里**没有同名覆盖**，也没有对应 token。

### 改法

```css
/* :root —— 原值原样搬进 token，浅色渲染不变 */
--composer-slot-bg: linear-gradient(180deg, #f0f0f0 0%, #f5f5f5 100%);

/* [data-theme="dark"] —— 同名覆盖 */
--composer-slot-bg: linear-gradient(180deg, var(--bg-raised) 0%, var(--bg) 100%);

/* 引用点 */
.composer-slot { background: var(--composer-slot-bg); }
```

### 为什么暗色取这两个值

- **浅色的语义**是「比主背景凹一档的槽」：`--bg` 是纯白，槽是它上面的一层浅灰。
- **暗色沿用同一条语义关系**：`--bg-raised`（`#26262a`）在暗色块里就是「抬升面」，
  `--bg`（`#1c1c1e`）是底。用**既有 token 而不是新造字面量** —— 数值与语义都现成，
  再抄一遍 `#26262a` 才违反「数值相同、语义相同时应引用既有名」的纪律。
- 上下两端都来自 token，所以暗色下**槽与卡片的差是可控的一档**，
  不像现在这样取一个亮色字面量、在暗底上炸出一圈发光边。

### 这条改动的真正价值（不只是修一处颜色）

`scripts/check-theme-tokens.mjs` 校验的是**同名 token 对**。`.composer-slot` 的渐变
此前是「没走 token 的字面量」，检查**看不见它** —— 所以它能在暗色主题落地后
悄无声息地活下来（盲区已另立 **#105**）。

**把这两行收进 token 之后，这个盲区里的这一处被拉回检查覆盖面**：以后谁把
`--composer-slot-bg` 从暗色块删掉，`check:theme-tokens` 会直接报红。

> 也就是说：R1 的验收标准里「`check:theme-tokens` 通过」不是形式 ——
> 它是这条修复**唯一的自动化守卫**。截图是给人看的，这条是给机器看的。

## 2. R2：深色下压暗案例封面 + 淡入

```css
/* 淡入：消除「兜底暗底 → 实图亮色」的硬切。opacity 是 §5.1 允许的视觉属性 */
.case-cover img { transition: opacity var(--dur-fast) var(--ease-standard); }

/* 深色下压暗：只动 filter，不动 cases.json、不动 CDN、不碰授权面 */
[data-theme="dark"] .case-cover img { filter: brightness(0.86) saturate(0.94); }
```

- 用 `filter` 而不是给卡片加一层遮罩盒子：加盒子违反 §3.9 的盒子预算，
  且案例槽的几何与 §3.8 的 `padding-bottom` 耦合，牵一发动全身。
- `prefers-reduced-motion` 下关停淡入（transition 也要进 §10.3.1 的关停清单 ——
  注意那里现在关的是 animation，**transition 要单独确认**）。

## 3. R3：把 §3.8 的节奏搬进断言

在 GUI 用例里读四个元素的 computed `margin-bottom`，断言 `12 / 12 / 24 / 16`：

| 元素 | 期望 |
| --- | --- |
| `.home-title` | `var(--space-4)` = 12px |
| `.mode-tabs` | `var(--space-4)` = 12px |
| `.capability-row` | `var(--space-6)` = 24px |
| `.home-guide` | `var(--space-5)` = 16px |

**写死 12/12/24/16 而不是读 token**：读 token 就与实现同义反复，
改坏文档与代码其中一处都测不出来。这条守的是「分组变了而间距没跟着分」那类事故。

放在 `tests/e2e/gui-smoke.mjs` 还是新用例：**放 `gui-smoke.mjs`**
（它已经在量首页的几何），不新增脚本、不新增 `package.json` 条目。

## 4. 测试设计

| 层 | 内容 |
| --- | --- |
| **截图 + 像素**（新用例或并入既有） | 浅/深两套主题的首页截图；**断言深色下「输入卡外槽区域」的平均亮度不高于主背景一个可辨阈值** —— 这是防「token 加了但没生效」的物理证据 |
| **契约**（静态） | `npm run check:theme-tokens` 必须通过；`--composer-slot-bg` 在两个块都有定义 |
| **回归**（静态） | `check-theme-tokens` 之外，确认 `check:design-exceptions` 未被触发（本任务**不应**新增受控例外） |
| **像素前后对比** | 深色封面的亮度：修复前后各截一张，`diffGrids` 或区域均值证明**变了**；浅色下**没变** |

**反向验证（必做）**：把 `--composer-slot-bg` 从暗色块删掉 → 断言必须变红；
把 §3.8 的某一个 `margin-bottom` 改坏 → 节奏断言必须变红。两条都真跑。

## 5. 明确的后续项

| 项 | 为什么不做 |
| --- | --- |
| 首屏封面改随包本地图 | 需 12 张图 + **再分发授权确认**（红线 9）—— 已立 **#104** |
| 让 `check-theme-tokens` 能查出「字面量逃逸」 | 已立 **#105** |
| 「规划中」浅色对比度、档外阴影补暗色版 | 已判定不是问题（见 `prd.md` 事实 4 与 `docs/DESIGN.md` §10.3.2） |