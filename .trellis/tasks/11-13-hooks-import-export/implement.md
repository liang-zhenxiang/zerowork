# 执行清单

## 1. 纯逻辑与 IPC

- [x] `hooks.js`：`HOOK_IMPORT_MAX_BYTES`、`parseHookImportText`、`mergeHookConfigs`、
      `previewHookImport`，并导出
- [x] `src/shared/ipc.js`：`importHooks: "hooks:import"`
- [x] `src/preload/index.js`：`previewHooksImport(text)` / `importHooks(text)`
- [x] `session-files.js`：处理函数（预览不写盘；apply 先校验再写；基准取当前已保存列表）
- [x] 单测：合并 / 文本解析 / 预览错误定位 / 重复 id

## 2. 设置页

- [x] HooksSection：导出按钮（Blob）与导入按钮（常驻隐藏 file input）
- [x] 导入预览弹窗：条数、逐条摘要、`第 N 条：原因`、按钮禁用逻辑
- [x] 成功后 refresh + toast；导出 toast 提示文件含本机命令
- [x] `app.css` §48：只追加，复用 token；窄窗 / 暗色

## 3. 测试与文档

- [x] `tests/e2e/gui-hooks.mjs`：导出形状 → 清空 → 导入回读；非法文件预览；截图
- [x] `SECURITY.md`、`CHANGELOG.md`
- [x] `npm run lint:all`、`npm test`、`npm run build && npm run check:renderer-assets`、
      相关 GUI 套件
- [ ] PR（Closes #387）→ `CI 总览` 绿 → squash 合并

## 回滚

删掉按钮、通道与纯函数即可；既有 hooks 读写路径不受影响。
