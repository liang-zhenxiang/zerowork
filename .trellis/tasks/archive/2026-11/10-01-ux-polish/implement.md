# 执行清单

> 分支 `feat/ux-polish`，一个任务一个 PR。**实现由子 agent 完成，
> 主会话负责派发与验收**（见 `.trellis/spec/workflow/`）。

---

## 阶段一：版本号（先做，有自动守卫）

- [ ] 1.1 `electron.vite.config.mjs` 的 renderer 段加 `define: { __APP_VERSION__ }`，
      版本从 `package.json` 读（读法见 `design.md`）
- [ ] 1.2 `src/renderer/src/app.js` 两处 `"0.1.4"` → `__APP_VERSION__`
      （`13638`、`64392`，**只改这两个字符串，不要重排文件**）
- [ ] 1.3 `scripts/check-renderer-assets.mjs` 加「产物里应含当前版本号」检查
- [ ] 1.4 **验证**：`npm run build` 后跑该检查应通过；
      再把 `app.js` 里临时改回 `"0.9.9"`，检查**必须失败**（反向验证）
- [ ] 1.5 跑 `npm run test:gui:smoke`（它断言界面渲染正常，能抓到 define 没生效）

**验收**：产物 `out/renderer/assets/app.js` 里能找到 `0.2.1` 且找不到 `0.1.4`。

---

## 阶段二：`prefers-reduced-motion`

- [ ] 2.1 扩写 `app.css:3367` 的 media 块，覆盖 `design.md` 表格里列的全部动画
- [ ] 2.2 **每一个都要显式写出终态**（`.home-title-char` → `opacity: 1`；
      caret → `opacity: 0`），不要只写 `animation: none`
- [ ] 2.3 **验证不能只看 CSS**：用 Playwright 以 `reducedMotion: "reduce"` 启动，
      断言首页标题**可见**（`opacity` 为 1 且文字非空）、`.spinner` 的
      `animation-name` 为 `none`
- [ ] 2.4 反向验证：去掉 `.home-title-char` 的 `opacity: 1`，
      上面的断言**必须变红** —— 这条证明陷阱是真的存在过

**验收**：reduced-motion 下打字机与转圈不动，且标题文字照常显示。

---

## 阶段三：缓动统一

- [ ] 3.1 列出全部 37 处裸 `ease`（`rg -n 'transition:[^;]*\bease\b' src/renderer/src/app.css`）
- [ ] 3.2 **逐处判断**：属 `background` / `color` / `box-shadow` / `transform` 等
      变色与纯视觉反馈的 → 换 `var(--ease-standard)`；
      确有理由保留 `ease` 的 → 在 `docs/DESIGN.md` 登记
- [ ] 3.3 跳过 `app.css` 前 502 行（vendored PDF.js）
- [ ] 3.4 改完跑 `npm run test:gui:sections` 与 `preview-renderers`（界面回归）

**验收**：`rg 'transition:[^;]*\bease\b' src/renderer/src/app.css | grep -v 'var(--ease'`
的命中数为 0（或全部已登记）。

---

## 阶段四：文档与登记

- [ ] 4.1 `docs/DESIGN.md`：
      - 登记 reduced-motion 的覆盖范围与「关动画要写终态」这条规则
      - 把文件类型色（8 色，来自 `docBadgeOf`）补进例外表
      - 6 处裸阴影：收编或登记（`app.css:1845/5244/5322/5975/6034/9291`）
- [ ] 4.2 `CHANGELOG.md` 的 `[Unreleased]` 记入（修复类写清「此前错在哪」）
- [ ] 4.3 全仓 U+FFFD 扫描（改了几处中文注释）

---

## 阶段五：验收（主会话做）

- [ ] 5.1 自己跑 `npm run lint:all`、`test:gui:smoke`、`test:gui:sections`
- [ ] 5.2 逐条核对 `prd.md` 的 Acceptance Criteria
- [ ] 5.3 反向验证至少一项（版本守卫 **且** reduced-motion 的终态陷阱）
- [ ] 5.4 截图对比：改前/改后各一张
- [ ] 5.5 开 PR（`Closes #31`），等 `CI 总览` 绿后 squash 合并

---

## 回滚点

| 阶段 | 出问题怎么办 |
| --- | --- |
| 一 | 单独回退 `define` 与两处字面量即可，互不依赖 |
| 二 | 整个 media 块可整块删掉；**不要**只删其中几行（终态与禁用是配套的） |
| 三 | 逐处可独立回退 |
