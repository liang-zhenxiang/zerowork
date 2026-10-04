# 执行清单

顺序按「先能测、再接线」排：纯逻辑 → 单测 → 持久化 → 接线 → GUI。

## 1. 纯逻辑（可单测）

- [x] `src/renderer/src/palette-memory.js`
  - `EMPTY_MEMORY`、`normalizeMemory`、`recordUse`、`toggleFavorite`、`evict`、
    `orderIdle`、`scoreOf`
  - 常数：`HALF_LIFE_MS`(7 天) / `FAVORITES_MAX`(20) / `USAGE_MAX`(200)
- [x] `src/renderer/src/command-palette-core.js`：`rankEntries` 加可选 `scoreOf`
- [x] `tests/unit/palette-memory.test.mjs`（新）
- [x] `tests/unit/command-palette-core.test.mjs`（补：scoreOf 的插入位置 + 不传时行为不变）

## 2. 持久化

- [x] `src/main/daemon/preferences.js`：`readPaletteMemory`
- [x] `src/main/daemon/session-files.js`：`settings:get-palette-memory` / `settings:set-palette-memory`
- [x] `src/shared/ipc.js` + `src/preload/index.js`
- [x] `tests/e2e/bridge-rest.mjs`：驱动两枚新通道（形状断言）

## 3. 渲染层

- [x] `app.js` 的 `CommandPalette`：星标、⌘D、收藏伪分组、底部提示
- [x] `app.js` 的 `App()`：读一次 + 写回
- [x] `app.css`：`.palette-star` 等（复用 token，暗色自动继承）

## 4. GUI

- [x] `tests/e2e/palette-memory.mjs`（新）+ 注册到 `package.json` 的 `test:gui` 链

## 5. 反向验证（真跑 + 记录）

- [x] 摘掉排序里的 `scoreOf` 接线 → e2e 的⑦变红（且只有它）
- [x] 去掉写入时的衰减 → 单测 2 条变红
- [x] 去掉点击分派的 `favorited &&` → e2e 的⑥变红（误加收藏 + 面板没关）
- [x] 复原 → 单测 304 / GUI 全套 26 个脚本全绿

## 6. 收尾

- [x] `CHANGELOG.md` 的 `[Unreleased] → 新增`
- [x] `docs/USAGE.md` 的命令面板一节
- [x] U+FFFD 扫描、`npm run lint:all`、`npx vitest run`、`npm run test:gui`
