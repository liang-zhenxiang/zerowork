# 执行清单：双渠道自动更新

## 0. 分支与基线
- [ ] `feat/update-channels`（自最新 main）；`npm run lint:all && npm run test` 全绿

## 1. 版本计算（脚本 + 单测）
- [ ] `scripts/next-beta-version.mjs`：读 package.json + gh release 列表 →
      输出下一 beta 版本（供 workflow 用；`--check-unreleased` 模式判 [Unreleased] 非空）
- [ ] `tests/unit/update-version.test.mjs`（纯函数部分抽 `computeNextBeta` 导出）

## 2. beta workflow
- [ ] `.github/workflows/beta.yml`（design §2；红线：env 中转、prerelease、concurrency）
- [ ] `actionlint`/`yamllint` 本地过（lint:all 覆盖）

## 3. 依赖与偏好
- [ ] `npm i electron-updater`（dependencies；audit 核对）
- [ ] daemon：`updateChannel` 偏好（get/set handler，缺省 stable，同 theme 模式）
- [ ] shared/ipc.js + preload 双表：`settings:get/set-update-channel`、
      `updates:get-state/check-now/install`、事件 `updates:event`

## 4. 主进程更新器
- [ ] `src/main/updates.js`：init/configure/check/install + 事件转发 +
      `ZEROWORK_UPDATE_FEED` 覆盖（design §3/§5 守卫）
- [ ] `main/index.js` 接线（启动 init + handler 注册）

## 5. 渲染层
- [ ] `UpdatesSection`（AppearanceSection 同构；版本徽章/渠道/检查按钮/状态行/
      win 安装按钮/mac 手动下载指引）
- [ ] GeneralSection 注册；更新 toast + 就地状态切换
- [ ] preload `onUpdateEvent` 桥

## 6. e2e
- [ ] `tests/e2e/gui-updates.mjs`（mock feed；design §5 四断言）+ package.json 注册

## 7. 全量回归 + 文档
- [ ] `npm run test:all`
- [ ] MAINTAINER_GUIDE 新章「发 beta / 发稳定版」操作手册；USAGE 设置章节补更新区；
      CHANGELOG；README「平台支持」附近提双渠道
- [ ] U+FFFD 扫描；PR（Closes 新建 issue）
