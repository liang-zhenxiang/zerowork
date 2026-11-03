# 关于页与菜单指向 GitHub + 首页「继续推进」可清除

## 背景

1. 应用没有一处能点回仓库。用户装了 beta、遇到问题想看源码 / 提交 issue / 看更新日志，
   只能自己去 GitHub 搜仓库名。「关于」是最自然的落点，而它此前只有版本号与第三方许可。
2. 首页首屏会把最近三个会话的**标题 + 交接摘要**摊开。换人用同一台机器、投屏、录屏时
   这是一处实打实的隐私暴露面，而用户没有任何手段收掉它（只能删掉会话，代价过大）。

## 期望

- [x] 菜单「关于」子菜单里有「打开 GitHub 仓库」，点它用系统浏览器打开
- [x] 设置 → 关于 里有同一条链路，可点、可右键复制，排布与「诊断」行对齐
- [x] 两处共用同一个地址常量（主进程持有，渲染层复用同一字面量并由 GUI 测试锁住）
- [x] 首页「继续推进」区头有「清除」，点后当场消失
- [x] 清除状态落盘，重开应用仍不出现
- [x] 有新会话（或老会话又跑了一轮）时重新出现 —— 不是永久关闭
- [x] GUI 测试覆盖以上全部路径

## 语义裁决

「清除」= **清到此刻为止**（记时间戳，modifiedAt 不晚于它的会话不显示），不是永久关闭。
永久关闭会把续摊入口一次性地废掉，用户以后再也找不到「回来续摊」。

## 入手位置

- `src/main/index.js`：`REPO_URL` / `REPO_LABEL`、`appMenuTemplate` 的 about 子菜单、
  `app.setAboutPanelOptions`
- `src/renderer/src/app.js`：`AboutSection` 一行、`HomeResumeDeck` 区头与 `onClear`、
  App 里的 `resumeClearedAt` 状态与 `recentForHome` 过滤
- `src/renderer/src/app.css`：`.home-resume-head` 改 flex、`.home-resume-clear`、`.provider-link`
- `tests/e2e/ui-about-privacy.mjs`（新增，进 `test:gui` 链）

## 难度

低。真正的坑是**「只消失一下」**和**「永久关闭」**两种错解，测试里把三条路径都锁住了。
