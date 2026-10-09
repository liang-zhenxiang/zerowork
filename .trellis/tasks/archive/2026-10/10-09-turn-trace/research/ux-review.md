# 工作轨迹条 UI/UX 评审

基于 trace-light.png / trace-dark.png 实拍 + app.css 4756–4870 逐行核对。

## 总评（3 行内）

token 纪律与状态语义无可挑剔：中性感分类、danger 只表 bad、⚠ 形态 + aria 双通道，深浅两套完全同源。
缺陷集中在两处「感知下限」——点击手型缺失与浅色连接符过淡，都是一行 CSS 的距离；
「点击定位工具行」这个核心交互的价值目前被可发现性折价。

## 问题清单

| 优先级 | 现象 | 为什么是问题 | 改法（token 约束内，精确到 CSS） |
| --- | --- | --- | --- |
| 高 | 段是 `<button>` 但悬停光标始终是默认箭头，只有底色微变 | 轨迹条唯一的交互入口就是点段跳转；箭头 + 静态 chip 外观（--bg-chip 与技能胶囊同源）= 看起来不可点。全仓其余可点元素均显式 `cursor: pointer`（app.css:265 等），此处漏了 | `.trace-seg`（app.css:4772）加 `cursor: pointer;` |
| 中 | 浅色下连接符近乎不可见：`.trace-conn` 用 `--border`（#e6e6e6），对白底约 1.2:1 | 连接符承载「地铁线」顺序语义与换行后「轨道延续」的读法；不可见时退化为三个孤立 chip，顺序感消失。CSS 注释自认 2px 是「还能看见」的下限——浅色下这个下限本身就不达标 | `.trace-conn`（app.css:4846）改 `background: var(--text-secondary);` —— 0.5 黑 / 0.55 白双主题自动适配，纯既有 token，10×2px 尺寸不变不会喧宾夺主 |
| 低 | bad 段 hover 反馈趋近于零：底色仅 8%→14% danger 掺混，Δ 肉眼难辨 | 用户最想点的恰是失败段（跳到出错工具行），但它反而是 hover 反馈最弱的一段 | `.trace-seg.bad:hover`（app.css:4821）补 `border-color: color-mix(in srgb, var(--danger) 60%, transparent);`（与既有 35% 掺混同一手法，只动既有 token） |

## 亮点（2 条内）

- bad 段「不看颜色也读得出」做满了：⚠ 字形（12px）+ danger 文字与描边 + `aria-label`「有失败或被拦截」，且状态色零渗漏到读/写/命令分类（§2.4 严守）。
- 键盘与可访问性完整：`focus-visible` 2px `--accent` 焦点环、`title` 提示、`<button type="button">` 可聚焦；深浅两套全部由同一组 token 派生，实拍一致性确认无漂移。

## 第二轮（2026-10-10 补记）

第一轮评审 agent 因回传挂起被停，其结论在合并后才送达——含一条**真实缺陷**，
已在 `fix/turn-trace-hover-feedback` 分支全部处置：

| 优先级 | 发现 | 处置 |
| --- | --- | --- |
| P0 | `.trace-seg:hover` 用 `--bg-hover` 比静态底 `--bg-chip` 更浅，两主题下 hover 都**变浅**，与全站 hover 加深语言相反，点击暗示趋零 | ✅ 改 `color-mix(var(--text) 12%)` + `border-color: var(--border)`，两主题统一加深一档 |
| P1 | bad 段浅色 `--danger` 对白 3.67:1 低于 AA 小字标准，形态线索单靠 ⚠ | ✅ 补 `font-weight: 600`（形态双保险） |
| P2 | `trace-seg.running` 类无对应 CSS 规则，进行中段与普通段只差呼吸点 | ✅ 补 `border-color: var(--border)` |
| 勘误 | count 注释「降一档已由字号承担」与实现（同字号同色）不符 | ✅ 改为「区分由 mono 字形承担」 |
| 间距节奏 / 折叠态结构 / count 样式 | 判断为成立不改 | — |

（连接符可见度一条第一轮与第二轮意见一致，已在 #175 落地。）
