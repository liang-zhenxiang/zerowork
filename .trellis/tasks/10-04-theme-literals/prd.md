# 把「没走 token 的硬编码颜色」变成改错就红（#105）

## Goal

`check-theme-tokens` 防的是「亮色 token 块加了新名字、暗色块忘了配」——它按**名字**
比对两个块，因此有一条结构性盲区：**认不出「压根没走 token 的硬编码颜色」**。

2026-10-03 踩到的实例是首页输入卡外槽的渐变（`.composer-slot` 里裸写 `#f0f0f0` /
`#f5f5f5`）：暗色块没有任何覆盖，深色下在输入卡外圈炸出一圈浅灰发光边
（全页最亮的区域变成这圈边，与 §3.9「唯一的视觉重点是输入卡」正相反），
而检查**全程是绿的** —— 那个块里一个 token 名字都没有，无从比对。

本任务把这个盲区补上：token 块**之外**的声明里出现颜色字面量 → 报错，
除非在**带理由与出处**的白名单里。

## 新增的第 ④ 项断言

- 逐字符状态机扫**全部**声明（不限顶层 —— 踩坑的那条完全可能写在 `@media` 里），
  记下选择器路径、属性、值与行号。
- 判定「token 块」= 顶层 `:root` 主块与 `[data-theme="dark"]` 块。
- token 块之外出现 hex / `rgb()` / `hsl()` / `hwb` / `lab` / `lch` / `oklab` / `oklch` /
  **命名色**（完整 148 个）→ 报错。
- 三种**不算**颜色：`transparent` 与 `currentColor`（表达「透明/跟随前景」，与主题无关）；
  `mask-image` 类属性里的颜色（掩膜只取 alpha，`#000` 与 `#fff` 完全等价）；
  `url(...)` 里的内容（文件名带 `white` 不是颜色）。
- 白名单按「选择器 + 属性 + 值形态」精确匹配，每条必须写理由与出处；
  **过期条目同样报错**（写了却没人用 = 白名单在悄悄变宽）。
- 新增 `--list` 模式：只打印清单，供下次盘点用。

## 首次盘点（32 处，逐处定性质）

```
主题 token 契约
  ✓ 暗色块覆盖全部随主题变化的 token（亮色 59 项，其中 28 项为档位类不随主题变）
  ✓ app.css 存在顶层 [data-theme="dark"] 规则（1 处）（app.css 无媒体查询一路是当前现状，见本文件头部说明）
  ✓ widget 双路暗色规则齐全（显式 data-theme + prefers-color-scheme 媒体查询）

 token 块之外的声明 4673 条，含颜色字面量 27 处：
.annotationLayer .choiceWidgetAnnotation select:required,

白名单 27 处：
app.css:84  .textLayer .highlight { --highlight-bg-color: rgb(180 0 170 / 0.25) }  → rgb((…)
app.css:85  .textLayer .highlight { --highlight-selected-bg-color: rgb(0 100 0 / 0.25) }  → rgb((…)
app.css:125  .textLayer ::selection { background: rgba(0 0 255 / 0.25) }  → rgba((…)
app.css:258  .annotationLayer :is(.linkAnnotation, .buttonWidgetAnnotation.pushButton) > a:hover { background: rgba(255, 255, 0, 1) }  → rgba((…)
app.css:259  .annotationLayer :is(.linkAnnotation, .buttonWidgetAnnotation.pushButton) > a:hover { box-shadow: 0 2px 10px rgba(255, 255, 0, 1) }  → rgba((…)
app.css:287  .annotationLayer .textWidgetAnnotation :is(input, textarea):required,
app.css:417  .annotationLayer .popup { background-color: rgba(255, 255, 153, 1) }  → rgba((…)
app.css:418  .annotationLayer .popup { box-shadow: 0 calc(2px * var(--total-scale-factor)) calc(5px * var(--total-scale-factor))
app.css:444  .annotationLayer .popupContent { border-top: 1px solid rgba(51, 51, 51, 1) }  → rgba((…)
app.css:2970  .attachment-remove { background: rgba(0, 0, 0, 0.55) }  → rgba((…)
app.css:2977  .attachment-remove:hover { background: rgba(0, 0, 0, 0.78) }  → rgba((…)
app.css:3014  .doc-file-icon.doc-file-pdf { color: #c94f4f }  → #c94f4f
app.css:3018  .doc-file-icon.doc-file-word { color: #4a7bc8 }  → #4a7bc8
app.css:3022  .doc-file-icon.doc-file-excel { color: #4b9e6b }  → #4b9e6b
app.css:3026  .doc-file-icon.doc-file-ppt { color: #d98a3d }  → #d98a3d
app.css:3033  .file-icon-markdown { color: #4b9e6b }  → #4b9e6b
app.css:3037  .file-icon-code { color: #4a7bc8 }  → #4a7bc8
app.css:3041  .file-icon-config { color: #b7903d }  → #b7903d
app.css:3045  .file-icon-image { color: #8b6bc8 }  → #8b6bc8
app.css:3049  .file-icon-media { color: #c85a8f }  → #c85a8f
app.css:4304  .image-preview-overlay { background: rgb(0 0 0 / 72%) }  → rgb((…)
app.css:5768  .preview-panel.fullscreen { box-shadow: -8px 0 24px rgb(0 0 0 / 6%) }  → rgb((…)
app.css:5846  .preview-menu { box-shadow: 0 8px 24px rgb(0 0 0 / 18%) }  → rgb((…)
app.css:6328  .preview-video { background: #000 }  → #000
app.css:6498  .preview-pdf-body .react-pdf__Page { box-shadow: 0 1px 4px rgb(0 0 0 / 15%) }  → rgb((…)
app.css:6558  .office-docx .docx-wrapper>section.docx { box-shadow: 0 1px 4px rgb(0 0 0 / 15%) }  → rgb((…)
app.css:9815  .mcp-switch-thumb,
```

### 判定为「真漏网」并修掉的一处

`.markdown code.clickable-path`（markdown 正文里的路径徽章）底色写死 `#e9eef2` /
hover `#dde6ee`，**没有任何暗色覆盖**。规则上方的注释写着「保留原值并登记为 token
例外」，但那份登记**在 docs/DESIGN.md 里查不到** —— 文档与实现不一致，
而后果是真实的：深色正文里会冒出一块**近白亮片**（与 `.composer-slot` 完全同一种形态）。

修法：`color-mix(in srgb, var(--accent) 12%, var(--bg))`（hover 20%）。
浅色下与原来几乎等值，深色下自动变成深底 + accent 字 —— 不新造 token、不留例外。

## 顺带补上的一处文档欠账

`--overlay` 的注释说「控件 scrim 与全屏看图遮罩保留原值并在入口样式表里的注释
（见 docs/DESIGN.md）」，但 DESIGN §10.3.2 的登记表里**没有这两条**。本轮补上
（否则白名单的「出处」就是空的）。

## Acceptance Criteria

- [x] 清单逐处列出并定性（白名单 / 漏网）
- [x] 新检查并入 `check-theme-tokens.mjs` 第 ④ 项，随 `lint:all` 生效
- [x] 修掉唯一的漏网（`.clickable-path`），并配一条**能证伪**的 GUI 断言
      （深色下徽章底色亮度必须 < 90：它是亮片就红）
- [x] 反向验证三条（硬编码 hex/命名色、白名单条目改名、恢复 `.clickable-path` 字面量），
      全部真跑并写进脚本头部
- [x] `docs/DESIGN.md` §2.0 与 §10.3.2 同步
- [x] 既有用例一条不少；`npm run lint:all` / `vitest` / `test:gui` 全绿

## 约束

- 不做成「禁止一切颜色字面量」：既有例外是刻意决定，白名单 + 理由即可
- 解析用逐字符状态机（注释/字符串/括号深度），不用正则切片
- 不为让检查通过而重排 `app.css`（红线 6）
- 只扫 `app.css`：`json-mode.css` 是原样分发的 VS Code 主题、`katex.css` /
  `code-preview.css` 是 vendor 产物，都不在设计 token 体系内，也没有 `[data-theme]` 块

## 难度

中。难点不在解析，而在**白名单的松紧**：太松等于没有（下次照样漏），太紧会天天红，
很快被无视。做法是只认「选择器 + 属性 + 值形态」三重精确，并要求过期条目报错。
