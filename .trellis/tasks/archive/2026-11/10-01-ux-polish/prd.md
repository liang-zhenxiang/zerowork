# UI/UX 精修与设计一致性

## Goal

界面是本项目给人的**第一印象**。对办公类 Agent 产品，用户会长时间盯着它，
视觉噪音的代价会持续累积。

**但要做的是修真实缺陷与消除不一致，不是加装饰。**

## 背景：先纠正一个误判（重要）

本任务的初版 PRD 基于一份界面勘察报告，其中把「31 处 4px/5px 微圆角与
`--radius-sm`(6px) 并存」判为「圆角不齐、最容易被看出不精致」。

**这个判断是错的。** `app.css` 第 629 行附近**明确记录着一次全文审计**：

```
保留不归档（逐字不同且有语义）：1/2/3px（favicon/小标记）、
4/5px（低于 sm 的微圆角：badge/小按钮/进度 thumb）、22/24px、50%/999px（圆形/胶囊）。
```

同处还记着「全文审计 158 处 border-radius 的归档依据，在此留存一处以免后续重复判断」。

也就是说：**这是有据可依的刻意决定**，不是遗漏。差点改掉它。

> 教训已写进 `.trellis/spec/workflow/`：判定「这是问题」之前，
> 先在代码里搜有没有关于它的决策记录。本项目习惯把刻意偏离写进注释 ——
> 看到「保留」「例外」「登记」「不归档」这类字样要停下来读。

## 现状：这套 CSS 的纪律水准高于一般项目

硬编码字号只有 1 处（还是注释）、过渡时长硬编码只有 2 处（也都在注释）、
原生 `<select>` 零使用、`:hover` 157 处 / `:active` 99 处 /
`:disabled` 92 处 / `:focus` 44 处。

**所以「该从哪下手」不是「补基础」。**

## 已核实的问题清单

每一条都标注了「是否查过决策记录」。

| # | 问题 | 证据 | 查过决策记录？ | 优先级 |
| --- | --- | --- | --- | --- |
| 1 | **界面显示的版本号是 `0.1.4`**，而 `package.json` 是 `0.2.1` | `app.js:13638`、`app.js:64392`（全仓只有这 2 处硬编码版本号） | 不适用（客观 bug） | **高** |
| 2 | **`prefers-reduced-motion` 只覆盖 15 个 `@keyframes` 中的 1 个**，且只盖 `.turn-nav` | `app.css:3367`；未覆盖 `.spinner`(1192)、首页打字机(1698/1711)、shimmer(2991)、tool-pulse(4274) | 查过，**无**决策记录 | **高** |
| 3 | **37 处裸 `ease`**，而 §3 规定「变色类用 `--ease-standard`」 | 全仓分布见下 | 查过，**无**决策记录 | 中 |
| 4 | 8 个文件类型色 + 专家头像 8 色不走 `--cat-*` 六槽 | `app.css:2615+`、`app.js:14677` | **有**注释「按族分色（族来自 doc-formats 的 docBadgeOf）」 | 低 |
| 5 | 6 处裸写阴影在 `--shadow-*` 三档之外 | `app.css:1845/5244/5322/5975/6034/9291` | 查过，无决策记录；但 token 块声明「3 档 + 1 个场景例外」，这 6 处是**未登记**的例外 | 低 |

### 关于 #3：不是「两种曲线」而是**三种**

| 曲线 | 定义 | 用了多少处 |
| --- | --- | --- |
| `--ease-out` | `cubic-bezier(0.33, 1, 0.68, 1)`，注释「默认：入场/常规」 | 56 |
| `--ease-standard` | `ease-out`（CSS 关键字），注释「变色/透明度等纯视觉反馈」 | 13 |
| 裸 `ease` | `cubic-bezier(0.25, 0.1, 0.25, 1)` | **37** |

裸 `ease` 用在这些属性上：`background`、`background-color`、`color`、
`transform`、`box-shadow`、`scrollbar-color`、`stroke-dashoffset` ——
**全部属于 §3 说的「变色类」**，应当走 `--ease-standard`。

## Requirements

- R1 **修 #1**：版本号改由构建期注入，消灭两处硬编码；并加自动守卫防回归
- R2 **修 #2**：补全 `prefers-reduced-motion`
- R3 **修 #3**：37 处裸 `ease` → `var(--ease-standard)`；如某处确需 `ease`，
  在 `docs/DESIGN.md` 登记并说明理由
- R4 **#4 / #5 只做记录**：在 `docs/DESIGN.md` 补登记（#4 已有注释，
  补进文档的例外表；#5 要么收编、要么登记为例外并补暗色版）。
  **不为了「统一」而动它们**
- R5 **每个改动都要有视觉证据**：改前/改后截图对比

## Acceptance Criteria

- [ ] 界面显示的版本号与 `package.json` 一致，且接的是**同一个来源**；
      有一条自动检查能在版本不一致时失败
- [ ] 系统开启「减弱动态效果」后，转圈与首页打字机**不再动画**，
      且**文字仍然可见**（见下「最容易犯的错」）
- [ ] `rg 'transition:[^;]*\bease\b' src/renderer/src/app.css | grep -v 'var(--ease'`
      的命中数降到 0
- [ ] `docs/DESIGN.md` 同步更新（改了 token 用法就必须改它）
- [ ] 有改前/改后的截图对比
- [ ] `npm run test:gui:smoke` 与 `npm run test:gui:sections` 仍全绿
      （界面改动的回归防线）

### 最容易犯的错（务必避开）

`.home-title-char` 的基础样式是 **`opacity: 0`**，靠动画淡入：

```css
.home-title-char {
	opacity: 0;
	animation: home-title-char-in var(--dur-fast) var(--ease-out) both;
}
```

**如果只加 `animation: none`，标题会永久不可见** —— 无障碍改动反而制造了
更严重的问题。正确写法是**同时把终态显式写出来**：

```css
.home-title-char {
	opacity: 1;      /* ← 必须显式给出，否则动画一关文字就没了 */
	animation: none;
}
```

同理 `.home-title-caret`（光标）在动画关闭后应当**隐藏**（它的终态是隐），
而不是停在基础态变成一个恒亮的光标。

## 约束（不得破坏）

- **不加装饰性动效**。动效只用于状态切换，走既有三档时长（§2.8）
- **不新增 token 档位**。档位不够时先改 `docs/DESIGN.md` 写明理由
- **冲突时以 `docs/DESIGN.md` 为准**，它是设计的事实来源
- **不为了改样式而大规模重排 `src/renderer/src/`**（`AGENTS.md` 红线 6）——
  那是 68,000 行的 chunk 文件
- **不改动任何功能行为**
- `.app > :not(...)` 那条排除法选择器不能加 `div:` 前缀（`app.css:873-876` 记录过翻车）
- **`app.css` 前 502 行是 vendored 的 PDF.js 样式**，不属于本工程，不要动

## 非目标

- **不接暗色主题开关**。暗色变量已存在但**未实测**（`app.css:686-689` 自己承认
  「本块目前没有实测依据」）。接线的前提是色彩项**先 token 化** —— 那是独立事项
- **不做 i18n**（`.trellis/spec/testing/` 与 `resources/` 的相关约定同理）

## Notes

- 改 `app.css` 时新类名要能对上既有命名族（`.chat-*` / `.composer-*` / `.sidebar-*`）
- 视觉验证用 `npm run test:gui:smoke` / `test:gui:sections`（已带像素断言）
