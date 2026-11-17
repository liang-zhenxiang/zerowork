# PRD：UI P2 打磨六项

- 来源：2026-11-16 UI/UX 评审剩余的 P2 中，与 #397 不冲突、单点收益明确的六项
- 分支：`fix/ui-p2-polish`
- 日期：2026-11-17

## 背景与需求

1. **会话检索的焦点环是近黑色**：`.ss-field:focus-within` 用 `--text-secondary` 画
   2px outline，而全局焦点环已统一到 `--ring`；同页出现两种焦点语言。
2. **「关于」页的链接是浏览器默认蓝**：`<a>` 没有任何颜色规则，与全站的
   `--accent` 可点标识不一致。
3. **设置弹窗初始焦点落在关闭键上**：`useModalFocus()` 取第一个可聚焦元素，即 X；
   用户一打开设置最醒目的是关闭按钮，键盘用户也被送离内容。初始焦点应落在当前
   分组导航项。
4. **健康评分「扣分 10 / 25」有歧义**：状态词「扣分」紧挨得分「10/25」，容易被读成
   「扣了 10 分」。把状态词改为「待改善」。
5. **专家页没有 h1**：其余二级页是「返回 + h1 + 右动作」，专家页只有切换胶囊；
   读屏用户不知道当前页面标题。补一个 `sr-only` h1。
6. **4 处裸 `ease`**：`app.css` 中 4 条 transition 用 `ease` 而非
   `var(--ease-standard)`，违反 `docs/DESIGN.md` §3.2。

## 验收

- [ ] 检索输入框聚焦时 outline 色 = `--ring`（GUI computed style）
- [ ] 关于页链接颜色 = `--accent`（GUI）
- [ ] 打开设置后 `document.activeElement` 是当前 `.settings-nav-item`，不是关闭键（GUI）
- [ ] 健康评分行出现「待改善」而非「扣分」（GUI 或单测）
- [ ] 专家页存在 `h1.sr-only` 且文案为「专家·技能·连接器」（GUI）
- [ ] 静态门禁：`app.css` 中 transition/animation 不得出现裸 `ease`（新增单测）
- [ ] `lint:all`、`npm test`、相关 GUI 套件、`check:unicode`
- [ ] `CHANGELOG.md` 记「修复」

## 不做

- 导航词与页标题统一、弹窗两套关闭动作、路径等宽/可复制 —— 留到后续批次
- 两条未登记的布局过渡（属 §5 例外登记问题，需要单独讨论）
