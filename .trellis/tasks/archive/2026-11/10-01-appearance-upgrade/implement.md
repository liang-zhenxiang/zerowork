# 执行清单：暗色主题落地

> 顺序即依赖序。每步末尾的命令通过才进下一步。
> B 部分（界面精品化）条目待研究员报告定案后追加。

## 0. 分支与基线

- [ ] `git checkout -b feat/dark-theme`（自最新 main）
- [ ] 基线复核：`npm run lint:all && npm run test`（应全绿）

## 1. 静态契约先行（保护后续改动）

- [ ] 新建 `scripts/check-theme-tokens.mjs`（design §4 三项断言）
- [ ] 挂进 `scripts/lint.mjs` 的检查清单 + `package.json` scripts
- [ ] 验证：`node scripts/check-theme-tokens.mjs` 当前即通过（token 已齐）；
      故意删一个暗色 token → 必须红（证伪）

## 2. 共享契约 + daemon（后端先行）

- [ ] `src/shared/ipc.js`：`getThemePreference/setThemePreference` 通道常量
- [ ] `src/main/daemon/preferences.js`：`isThemePreference()` 纯函数
- [ ] `src/main/daemon/session-files.js`：成对 handler（校验 + 落盘）
- [ ] 单测 `tests/unit/theme-preferences.test.mjs`：合法值/非法值/往返/缺省
- [ ] 验证：`npm run test` 全绿；`npm run check:daemon-graph` 通过

## 3. preload + 主进程

- [ ] `src/preload/index.js`：`getThemePreference()/setThemePreference(theme)` 暴露
- [ ] `src/main/index.js`：
  - 启动早期（建窗口前）读偏好 → `nativeTheme.themeSource`
  - `setThemePreference` 通道从批量转发表拆出，落盘（daemon）+ 生效（themeSource）一次完成
  - `nativeTheme.on('updated')` → `setTitleBarOverlay` symbolColor + 向窗口
    `webContents.send('theme:changed', effective)`
- [ ] 验证：`npm run lint:all`；手动 `npm run dev` 冒烟（改偏好文件 theme 字段重启生效）

## 4. 渲染层接线与设置 UI

- [ ] `app.js` 入口 effect：读偏好 → 设/删 `data-theme` 属性；监听 `theme:changed`
- [ ] `GeneralSection` 新增 `AppearanceSection`（三档 segmented，乐观更新+失败回滚）
- [ ] widget 宿主侧：创建时与 `theme:changed` 时向活动 widget iframe 推 `theme` 消息
- [ ] 验证：`npm run build && npm run check:renderer-assets`

## 5. 散点 rgba 清理

- [ ] 逐处核对（design §3 原则），改动清单写进 PR 描述
- [ ] `rg 'transition:[^;]*\bease\b' src/renderer/src/app.css | grep -v 'var(--ease'` 仍为 0
- [ ] U+FFFD 扫描（AGENTS.md 脚本）

## 6. GUI 测试（真实启动 + 截图）

- [ ] 新建 `tests/e2e/gui-theme.mjs`（design §5 五个用例，骨架来自 harness）
- [ ] 截图断言含「与浅色可区分」（直方图距离），防切换无效的假通过
- [ ] `npm run test:gui:theme` 单跑通过
- [ ] **反向验证**：注释接线 effect → 用例 ①③ 变红 → 恢复
- [ ] `npm run test:gui:settings`（设置页回归，分组多了一节）→ 需同步
      `gui-settings.mjs` 的 EXPECTED 清单（如「通用」分组结构变化）

## 7. 全量回归

- [ ] `npm run test:all`（lint + 单元 + e2e 全套）
- [ ] 检查 `artifacts/theme/` 截图：浅色/深色各视图齐全

## 8. 文档与收尾

- [ ] `docs/DESIGN.md`：主题机制「预留」→「生效」，三档语义与接线点
- [ ] `docs/USAGE.md`：设置里新增「外观」的说明
- [ ] `CHANGELOG.md` `[Unreleased]`：新增（深色主题）+ 变更（缺省 light 的取舍写明）
- [ ] `README.md` 截图/特性若提及主题则同步
- [ ] 提交（约定式，正文写为什么）→ 推分支 → PR（body-file + `Closes` 无 issue 可省，
      引用任务）→ `gh pr checks` 绿 → squash 合并
