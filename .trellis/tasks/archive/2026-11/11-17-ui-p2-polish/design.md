# 技术设计：UI P2 六项

1. `app.css` `.ss-field:focus-within`：`outline: 2px solid var(--ring)`（其余不变）。
2. `app.css`：`.settings-foot a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 2px; }`
   —— 只作用于设置页脚注链接，避免全局 `<a>` 影响 Markdown 渲染。
3. `app.js` SettingsView：`useModalFocus({ initialFocus: () => document.querySelector(".settings-nav-item[aria-current='page']") })`。
4. `health-score.js` `STATE_TEXT.deduct`: "扣分" → "待改善"；同步 app.js 注释里的措辞。
5. `app.js` SkillsView `<header>` 内加 `<h1 className="sr-only">专家·技能·连接器</h1>`。
6. 4 处 `transition: … ease` → `var(--ease-standard)`（16326/16384 是 height/width 过渡，
   只换缓动，不改属性；是否登记为布局例外不在本轮）。
   新增 `tests/unit/css-motion.test.mjs`：剥离注释后扫描 `transition` / `animation`
   声明里裸 `ease`（`--ease` 除外），命中即失败；并反向用一条已知裸 ease 字符串自测。

GUI：扩展 `gui-ui-audit` —— 检索焦点色、关于链接色、设置初始焦点、健康文案、
专家 sr-only h1；浅/暗不额外截图（已有）。
