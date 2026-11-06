# PRD：v0.4 外观与体验升级 —— 暗色主题落地 + 界面精品化

## 背景

**用户目标（2026-10-01 /goal）**：把 ZeroWork 打造成吸引更多人的产品——界面美观度第一、其次好用想用；对标同类产品融合改造（不一味复制）；所有功能补齐单元 / e2e / GUI 测试（真实启动 app + 截图验证），且新功能不得破坏老功能。

**现状核实（全部一手验证，非转述）**：

1. `app.css` 的 token 化已彻底：`var(--*)` 引用 2336 处，token 定义外**硬编码 hex 颜色为 0**，
   rgba 散点仅约 30 处（多数与 pdf/第三方样式相关）。
2. `[data-theme="dark"]` 的暗色 token 块**已经完整预留**（`app.css:696`）：文字三级 / 表面色 /
   主色 / 状态色 / 分类板 / 阴影（含输入卡两档的暗色版）全部就位；注释明言
   「应用侧尚无暗色开关与持久化，变量先定义、不接线，避免半成品主题流出去」。
3. widget（消息流 HTML 预览）已实现双路暗色触发（`data-theme` 属性 + `prefers-color-scheme`），
   等主应用设置 `data-theme` 后即自动跟随。
4. 主进程 `titleBarOverlay` 全透明不画底色（`src/main/index.js:258`），主题切换只需考虑
   symbolColor 联动。
5. 同类产品（Claude Desktop / Cherry Studio / Chatbox 等）暗色模式是**标配**；
   ZeroWork 目前 `color-scheme: light` 是明显短板。**界面截图见 `artifacts/smoke/home.png`**：
   干净但偏素，黑白灰为主、品牌绿只在状态点出现。
6. 测试基线全绿：`lint:all` 15 项、单元 155 条、`gui:smoke` 22/22。
   e2e harness（`tests/e2e/lib/harness.mjs`）提供 `h.shoot()`（截图 + 像素断言）。

## 期望

### A. 暗色主题完整落地（旗舰，本轮必须交付）

- [ ] **设置项**：设置 → 通用新增「外观」section，三档：跟随系统 / 浅色 / 深色
      （沿用 `window.kami.*` IPC 模式与既有 settings-section 组件形态）
- [ ] **接线**：应用启动时读持久化值 → `document.documentElement.setAttribute('data-theme', …)`；
      「跟随系统」档用 `prefers-color-scheme` + 变化监听；未持久化时默认跟随系统
      （与 CSS 里已有的 `:root:not([data-theme="light"])` 双路规则一致）
- [ ] **持久化**：主进程侧落盘（与既有设置同一存储），重启后保持
- [ ] **窗口联动**：`titleBarOverlay.symbolColor` 随主题切换（深色主题下窗口控件符号要用浅色）
- [ ] **散点清理**：token 外 rgba 硬编码逐处核对，凡受主题影响的改走 token；
      与主题无关的（如 pdf 选区高亮）保留并注释理由
- [ ] **widget 联动**：切换主题时向 widget iframe 推送 `theme` 消息（基建已存在，核对是否已接）
- [ ] **设计纪律**：不新增档位、不新造颜色语义；暗色值已有就不再调（除非对比度不足，
      需给出 WCAG 对比度数据）

### B. 界面精品化（研究员报告回来后定案，首批候选）

- [ ] 待融合 ux-researcher 报告的 Top 改造点（候选：命令面板 / 消息流视觉层次 /
      首页品牌感 / 微交互动效），原则：**融合改造，不一味复制**，遵守 DESIGN.md 档位纪律

### C. 测试（每一项都要可证伪）

- [ ] **单元**：主题持久化逻辑（合法值 / 非法值回落 / 默认值）、theme 解析纯函数
- [ ] **静态契约**：新增检查脚本——暗色 token 块覆盖了亮色 token 块中所有**随主题变化的**
      token 名（防「加了新 token 忘配暗色」这个未来会反复发生的错）
- [ ] **GUI（真实启动 + 截图）**：设置里切深色 → 首页 / 会话 / 设置三视图截图 +
      像素断言（非纯色、且与浅色截图**确实不同**）；重启后仍是深色（持久化）；
      跟随系统档在模拟 `prefers-color-scheme` 下生效
- [ ] **回归**：全套 `test:gui:*` 不倒退（老功能不受影响）

## 验收标准

1. `npm run test:all` 全绿（含新增用例）；反向验证：注释掉接线代码，GUI 测试必须变红
2. 浅色 / 深色两套主题下关键界面截图齐全且像素断言通过，截图入 `artifacts/`
3. `docs/DESIGN.md` 同步：主题机制从「预留」改为「生效」，写明三档语义与接线点
4. `CHANGELOG.md` `[Unreleased]` 记入「新增：深色主题」
5. U+FFFD 扫描通过（中文内容编辑后必扫）

## 约束

- 渲染层是 **chunk 粒度源码**（`app.js` 68k 行 bundle 形态）：改动必须外科手术式，
  不大规模重排（红线 6）
- 不放宽安全约束、不动 `resources/**`、不引入新第三方依赖
- 一个任务一个分支一个 PR：`feat/dark-theme`

## 入手位置

- `src/renderer/src/app.css:696`（暗色 token 块）、`:root`（亮色基准）
- `src/renderer/src/app.js:62318`（GeneralSection，加「外观」section）
- `src/main/index.js:258`（titleBarOverlay）
- `src/preload/index.js`（IPC 通道表，`settings:*` 模式）
- `tests/e2e/gui-settings.mjs`（设置页测试模式参考）
- `tests/e2e/lib/harness.mjs`（h.shoot / waitForSettled）
