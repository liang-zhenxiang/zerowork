# PRD · 第十八轮十连——「个性化与表达」

任务目录：`.trellis/tasks/11-09-ui-round18/`　分支：`feat/ui-round18`　issue：#350　日期：2026-11-09

## 背景

十七轮后功能面宽而深（可靠性闭环完成）。第十八轮聚焦**个性化与表达**：
界面与输出「像自己的」——颜色、称呼、命名、密度、数字格式都可按人调整。

## 十项清单（先逐项查重）

| # | 功能 | 说明 | 主要落点 |
| --- | --- | --- | --- |
| 1 | 自定义强调色 | 个性化页八色选择（含当前 Aurora 青），`zw:accent-override` 存 localStorage，`:root` 级覆盖 `--accent`（含 hover/soft 衍生色，用 color-mix 派生） | PersonalizationSection + app.css |
| 2 | 助手称呼自定义 | 查重：assistantName 已有（preferences）。补「问候语与回复署名使用该称呼」——查实际渲染点后决定增补面 | HomeGreeting / AssistantEntry |
| 3 | 会话标题风格 | 自动命名三档：简洁/描述性/带日期。存 `zw:title-style`；命名建议逻辑（round13 F8）按档生成 | titleSuggestions |
| 4 | 回复长度偏好 | 三档（简洁/平衡/详细）→ 存 preferences？daemon 有 customInstructions——查重后决定走 localStorage + 注入点是否已有；若无注入点则降级为「提示条记忆」（发送时 append 到首条） | PersonalizationSection |
| 5 | 导出主题 | 导出 HTML/海报亮/暗/跟随当前主题。查 drawSessionPoster / exportToHtml 的配色来源 | session-files.js / drawSessionPoster |
| 6 | 快捷短语分组 | quick-chips 已有编辑器；补 `分组:` 前缀语法 chips（`组:词` 渲染时分组显示）——降级方案：仅视觉分组头 | QuickChipsEditor |
| 7 | 全局 UI 字号档 | 小/标准/大 三档（`html[data-ui-scale-font]`，与 chatFontSize 独立）。查重：preferences.uiScale 是 zoom 级，不同维度 | PersonalizationSection + app.css |
| 8 | 侧栏密度 | 舒适/紧凑（`html[data-sidebar-density]`，行高/间距两档 token） | app.css |
| 9 | 数字格式 | 千分位/中文单位切换（统计页与会话统计行共用格式化函数 numFormat()） | StatsView / chat-session-stats |
| 10 | 会话封面色条 | 任务行左侧 3px 色条：取空间色（zw:space-colors 已有）> 标签色 > 无 | renderTaskRow |

## 验收标准

- 每项：build 过 + 真实 Electron 截图 ≥1 张（tests/e2e/ui-round18-shots.mjs）
- 新逻辑补单测/e2e；lint:all / npm test / 既有 GUI 用例全绿
- CHANGELOG [Unreleased]；PR 正文 Closes #350；CI 全绿 squash 合并；guard release；截图内嵌交付

## 硬约束（沿用十七轮教训）

- 零新依赖；app.css 只追加 §37；手写 createElement；jsx(Comp, {}) 永远带第二参
- `ELECTRON_RUN_AS_NODE=1` 是 DSH 注入的环境变量——跑 build/e2e 前必须 unset（#345 开发期发现的硬坑）
- aria-label 唯一（#339 教训）；懒渲染 prop 先 grep 核对（#329 教训）
- e2e 种子 cwd=join(WORKSPACE_DIR,"临时任务",auto)；组选择按组名找 index
- python 替换逐段写入+即时校验；check:unicode 必过；不推 main；不 force push
- Composer 作用域没有 showToast——走 zw:toast CustomEvent（三次踩过）
