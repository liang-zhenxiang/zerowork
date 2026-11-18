# 执行清单

## 1. 对比度

- [x] `app.css` 亮/暗 `--text-faint` 改为 0.59 / 0.52（抬升面 4.63:1）；暗色选中态由深青改亮青（7.6:1）
- [x] `tests/unit/theme-contrast.test.mjs`（解析 token + WCAG 计算，找不到 token 即失败）
- [x] `docs/DESIGN.md` §2.1 数值与说明更新

## 2. 选中态

- [x] `.mini-btn.active` / `.ex-cat.active` 改 `--primary-active` + 字重
- [x] 审计类别与专家分类补 `aria-pressed`

## 3. 侧栏当前页

- [x] `Sidebar` 接收 `activeView`，8 个 nav 项映射 view id
- [x] `aria-current="page"` + `.nav-item-current` + CSS

## 4. 资料库空态

- [x] CSS 限定居中规则、给有统计块的场景加下方居中

## 5. 新功能状态

- [x] 注入卡 chevron + 查看内容/收起 + summary 焦点环
- [x] 回复长度 `.is-selected` + 可见组标签；历史重复标记全量清理（旧解析正则匹配不上自己写出的行，用户每点一次就多一行）

## 6. 测试与文档

- [x] `tests/e2e/gui-ui-audit.mjs` + 挂进 `test:gui` + 浅/暗截图
- [x] `CHANGELOG.md`、`.trellis/spec/renderer/index.md`
- [x] `lint:all`、`npm test`、`build`、相关 GUI 套件
- [x] PR → CI 绿 → squash 合并（#402，提交 58c34cf）

## 回滚

单文件 CSS/渲染改动，逐项可独立回滚；token 只调 alpha，不改变布局。
