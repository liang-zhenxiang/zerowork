# 执行清单

## 0. 准备

- [x] 核实 Issue 前提（`agent_end` 无 `willRetry` → 用 `agent_settled`；不做上下文注入），已留言
- [x] 分支 `feat/hooks-lifecycle-events`；规划产物落盘

## 1. 核心（`src/main/daemon/hooks.js`）

- [x] `HOOK_EVENTS` 追加三个；新增 `TOOL_EVENTS` / `LIFECYCLE_EVENTS`
- [x] `normalizeHook`：生命周期事件只接受缺省 / `""` / `"*"` matcher，其余抛错
- [x] 三个 payload builder
- [x] `auditDetail` 的 `toolName` 改可选；非阻断文案带「未阻断」
- [x] `createLifecycleHookExtension`：三个监听器 + 共用 `run`（fatal 不刷审计、无命中不 spawn、
      全部跑完、异常自吞）
- [x] 新导出

## 2. 装配（三处）

- [x] `session-files.js` 主会话 extensions：紧邻 Pre 扩展
- [x] `session-files.js` `buildRunExtensions`：同一 `hookSet`
- [x] `command-exec.js` `buildSubagentExtensions`：并入 `hookExtensions`
- [x] `session-files.js` `testHook`：按事件生成示例载荷

## 3. IPC 与设置页

- [x] `hooks:get` 返回 `recentRuns`（审计最近 hook 记录 ≤5）
- [x] `app.js`：事件下拉三项 + matcher 禁用与提示 + 最近运行列表 + 试运行文案按事件区分
- [x] `app.css` 追加 §47（§46 已属第二十一轮），只用既有 token；窄窗 / 暗色 / reduced-motion

## 4. 测试

- [x] `tests/unit/hooks.test.mjs`：事件表、matcher 校验、载荷、扩展工厂（假 pi + 假 spawn）
- [x] `tests/e2e/hooks-lifecycle.mjs`：真实子进程三条 hook + 非阻断 + 未信任工作区
- [x] `tests/e2e/gui-hooks.mjs` 扩展：下拉、禁用 matcher、最近运行、截图
- [x] 反向验证：至少「删事件映射」「去掉非阻断兜底」「去掉 matcher 校验」各红一次

## 5. 文档与收尾

- [x] `SECURITY.md`、`.trellis/spec/daemon/index.md` §七、`CHANGELOG.md`
- [x] `npm run lint:all`、`npm test`、`npm run build && npm run check:renderer-assets`；
      相关 GUI 套件本地跑通，全量 `test:gui` 由 CI 把关
- [x] PR（Closes #373）→ `CI 总览` 绿 → squash 合并（#377，提交 c649a58）

## 回滚

- 删除三个事件配置即可关闭；代码层面只新增工厂与装配点，不改 Pre/Post 语义
