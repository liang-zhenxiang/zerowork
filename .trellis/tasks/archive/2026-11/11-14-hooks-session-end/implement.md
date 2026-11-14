# 执行清单

## 1. 核心（`hooks.js`）

- [x] `HOOK_EVENTS` / `LIFECYCLE_EVENTS` 加入 `SessionEnd`；`BLOCKING_EVENTS` 不变
- [x] `HOOK_SHUTDOWN_BUDGET_MS = 2000` 与 `runHooksWithinBudget`
- [x] `payloadForSessionEnd`（reason 归一 + 默认 quit）
- [x] 扩展工厂注册 `session_shutdown`，SessionEnd 走预算路径
- [x] 单测：事件表 / 载荷 / 预算耗尽不 spawn / 30s 配置被压到 ≤2s

## 2. 宿主与装配

- [x] `SessionHost.shutdown(reason)`：emit `session_shutdown` → dispose；异常吞掉
- [x] `session-files.js` 七处调用点（含重启 `resume`）按 design 的 reason 映射改用 `shutdown`
- [x] `session-files.js` 新增 `daemon:shutdown` handler（并行 shutdown 所有 host）
- [x] `src/shared/ipc.js` 增加 `daemonShutdown`；preload 只登记常量、不暴露方法
- [x] `main/index.js` `before-quit` 改为可等待 + 2.5s 兜底 + 重入守卫

## 3. UI 与试运行

- [x] `hookEvent` 下拉 / 标签加入 `SessionEnd`；脚注写「退出最多等 2 秒」
- [x] `testHook` 按事件给 `reason: "quit"` 的示例载荷

## 4. 测试与文档

- [x] `tests/e2e/hooks-session-end.mjs`：删除会话 / 重启 / 应用退出三条路径 + 退出不被拖住
- [x] `tests/e2e/gui-hooks.mjs`：新选项 + matcher 禁用
- [x] `SECURITY.md`、`.trellis/spec/daemon/index.md` §七、`CHANGELOG.md`
- [x] `lint:all`、`npm test`、`npm run build && check:renderer-assets`、三个 hooks e2e
- [x] PR（Closes #386）→ CI 绿 → squash 合并（#392，提交 4163f0b）

## 回滚

删掉 SessionEnd 配置即可；`before-quit` 的兜底计时器保证即使 daemon 卡住也能退出。
