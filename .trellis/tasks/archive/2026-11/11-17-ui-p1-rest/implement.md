# 执行清单

## 1. 首页矮视口

- [x] `--home-case-reserve` 变量（保持 268）+ 两档紧凑规则（≤840 收眉标、≤800 收能力宫格）；预留不能降，否则案例区压住输入卡
- [x] GUI：800 与 679 两档按实际尺寸断言 `composer.bottom <= home.bottom`，且案例区不压输入卡

## 2. 统计头部

- [x] 空态隐藏 分享卡 / 本周摘要 / 导出 CSV
- [x] 「重试首页」去掉 refresh 图标，与「刷新」区分
- [x] GUI：空态头部只有刷新 + 重试首页（无 svg）

## 3. 记忆空态

- [x] `profile-view` 非编辑态挂 role=button/tabIndex/Enter/Space/点击
- [x] 焦点环与 cursor
- [x] GUI：点击空态进入编辑

## 4. 侧栏空间组名

- [x] 组头两行结构 + CSS
- [x] GUI：名称与计数不同行、名称可见宽度达标；操作区位置不变

## 收尾

- [x] `npm test`、`lint:all`、`build`、`ui-audit`、`gui-settings`、`route-crawl`、`check:unicode`
- [x] 反向验证两条（reserve / 空态可点）
- [x] `CHANGELOG.md` 记「修复」
- [x] PR → CI 绿 → squash 合并（#413，提交 57e0fb1）

## 回滚

逐项独立，CSS/渲染层小改。
