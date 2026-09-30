# 技术设计

## 一、版本号注入（R1）

### 现状

```js
// src/renderer/src/app.js:13633-13640（侧栏）
jsx("span", { className: "brand-version", children: ["V", "0.1.4"] })

// src/renderer/src/app.js:64388-64392（设置-关于）
jsx("span", { className: "provider-meta", children: ["版本 ", "0.1.4"] })
```

全仓只有这 2 处硬编码版本号。`package.json` 是 `0.2.1`。
界面在向用户展示一个**不存在的版本**（`0.1.4` 是开源前的内部编号）。

### 候选方案与被否掉的理由

| 方案 | 结论 | 理由 |
| --- | --- | --- |
| 从 `package.json` import | ✗ | 渲染层是 sandbox 的 chunk，拿不到 package.json |
| 主进程 `app.getVersion()` 经 IPC 传 | ✗ | 主进程**已经有** `app.getVersion()`，但用在 `setAboutPanelOptions`（原生面板），**没有通向渲染层的通道**。新开一条 IPC 意味着渲染层要异步取值 —— 而侧栏是**同步渲染**的，会多出一个 loading 态 |
| **Vite `define` 构建期注入** | ✓ **采用** | 同步、零运行时开销、与既有构建配置一致 |

### 实现

`electron.vite.config.mjs` 的 `renderer` 段加 `define`：

```js
import { readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

renderer: {
	define: { __APP_VERSION__: JSON.stringify(pkg.version) },
	...
}
```

`app.js` 的两处字面量换成 `__APP_VERSION__`。

**dev 与 prod 都生效**：Vite 的 `define` 在两种模式下都会替换，不是只在 build 时。
所以 `npm run dev` 里显示的也是真实版本。

### 防回归守卫

`scripts/check-renderer-assets.mjs` 已经是一个「构建后校验渲染层产物」的检查
（它守的是产物命名契约那次真实事故）。**把版本检查加进去**，理由是同一个：
两者都是「只有构建之后才能验证的渲染层契约」。

检查内容：**构建产物的 `app.js` 里应当含有 `package.json` 的当前版本号**。
- 若源码里又写死了旧版本 → 产物里出现旧版本、找不到新版本 → 检查失败
- 没构建时该脚本本来就返回「已跳过」，行为一致

> 为什么不做成「扫描源码里有没有 semver 字面量」：那会误报（第三方库
> 自带版本号字符串）。**校验产物**才是既准确又不误伤的判据。

---

## 二、`prefers-reduced-motion`（R2）

### 现状

全文 15 个 `@keyframes`，只有 `app.css:3367` 一个 media 块，且只覆盖
`.turn-nav-mark::before` / `.turn-nav-preview` 两个选择器。

### 要覆盖的（按「必须」到「应当」排序）

| 选择器 | 动画 | 为什么必须 |
| --- | --- | --- |
| `.home-title-char` | 逐字淡入（打字机） | **全应用最显眼的一段动效**，对前庭敏感用户最该关 |
| `.home-title-caret::after` | 光标无限闪烁 | 无限循环 |
| `.spinner` | 无限旋转 | 无限循环 |
| `text-shimmer-sweep` 的宿主 | 无限扫光 | 无限循环 |
| `tool-pulse` 的宿主 | 无限脉冲 | 无限循环 |
| 各入场动画（`page-in` / `pop-layer-in` / `fold-in` / `toast-in` / …） | 一次性 | 体感最轻，可一并关掉 |

### 关键陷阱：**关掉动画不等于回到「正常样子」**

`.home-title-char` 的基础样式是 `opacity: 0`，靠动画淡入（`both` 填充）。
**只写 `animation: none` 会让标题永久不可见。**

所以 media 块里必须**同时给出终态**：

```css
@media (prefers-reduced-motion: reduce) {
	.home-title-char {
		opacity: 1;      /* ← 少了这一行，标题就没了 */
		animation: none;
	}
	.home-title-caret,
	.home-title-caret::after {
		opacity: 0;      /* 光标本就是装饰，直接隐藏 */
		animation: none;
	}
	.spinner { animation: none; }   /* 语义由相邻文字承担，见 DESIGN.md §7.6 */
	...
}
```

**每关一个动画都要问一句：关掉之后元素停在基础态，那个状态对吗？**
不能想当然。这条要写进 `docs/DESIGN.md`。

---

## 三、缓动统一（R3）

37 处裸 `ease` → `var(--ease-standard)`。

**逐处确认，不做全局替换**：`ease` 与 `ease-out` 是两条不同曲线
（`cubic-bezier(0.25,0.1,0.25,1)` vs `cubic-bezier(0,0,0.58,1)`），
若某处**刻意**要 `ease`，应在 `docs/DESIGN.md` 登记而不是改掉。

`app.css` 前 502 行是 vendored 的 PDF.js 样式，**不在改动范围**。

---

## 四、交付顺序

1. 版本号（有自动守卫，回归成本最低）
2. reduced-motion（含终态陷阱）
3. 缓动统一（面最广，放最后，改完跑一次界面测试确认无视觉意外）
4. `docs/DESIGN.md` 同步（**改了 token 用法就必须改它**）
