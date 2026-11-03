# 执行清单（已完成）

## 1. 纯逻辑

- [x] `src/renderer/src/case-cover.js`（变体 / 色板 / 种子 / 几何 / 签名）
- [x] `tests/unit/case-cover.test.mjs`（20 条）

## 2. 渲染与样式

- [x] `app.js` 的 `CaseCover` 改成画示意图（sheet + 题头 + 内容），删掉 img/onLoad/onError
- [x] `app.css`：`.case-cover*` 重写（color-mix + 既有分类色板）；删掉 `img` 压暗与淡入
- [x] reduced-motion 第 ④ 组里那条 `.case-cover img` 移除

## 3. 数据面

- [x] `resources/welcome/cases.json` 去 `cover`
- [x] `src/main/daemon/resources.js` 不再要求 `cover`
- [x] `resources/welcome/README.md` 字段表 + 「封面是远程图」缺口

## 4. 文档

- [x] `EXTERNAL_REQUESTS.md` §6 改为「已改为不出网」；汇总表划掉第五项、计数改四项
- [x] `THIRD_PARTY_NOTICES.md` 第 1 节（顺带消掉了再分发授权问题）
- [x] `CHANGELOG.md` 的 `[Unreleased] → 修复`
- [x] `docs/images/*.png` 门面图重拍（README 上还是旧的 CDN 封面）

## 5. 测试

- [x] `tests/e2e/offline-covers.mjs`（6 条）+ 注册进 `npm run test:gui`
- [x] `tests/e2e/dark-polish.mjs`：删掉盯着 img 的 ④⑤，reduced-motion 那条**改探**
      `.turn-nav-mark::before`（真有过 transition 的元素），不是简单删掉

## 6. 反向验证（真跑 + 记录在用例文件头）

- [x] 换回 `<img src=CDN>` → GUI ①②③ 红
- [x] 线宽写成常量 → 单测 3 条 + GUI ③ 红
- [x] 复原 → 单测 20 / GUI 6 全绿
