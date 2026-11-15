# 执行清单

## 1. 注入核心（`hooks.js`）

- [x] `HOOK_INJECT_PER_HOOK_BYTES` / `HOOK_INJECT_TOTAL_BYTES`、`clipUtf8`、`buildHookInjection`
- [x] 扩展：SessionStart 暂存；before_agent_start 合并投递并清空；只取 allow 输出
- [x] handler 返回 `{message}`（customType `hook_context`、display true、details.hooks）
- [x] 审计 detail 追加「注入 N 字节」/「已截断」，不含正文
- [x] 单测：截断边界 / 拼接 / 暂存一次 / 失败输出不注入

## 2. 可见性

- [x] `session-view.js` 投影落盘形态 `type:"custom_message"`（display true + hook_context）；`session-state.js` 的 daemon 侧 reducer 同步
- [x] `session-host.js` live：message_start 的运行时 `role:"custom"` → `hook_context` 事件
- [x] `app.js` reducer + `HookContextCard`（折叠、来源胶囊、说明行）+ `classify`
- [x] `app.css` §49（只用 token，窄窗 / 暗色）

## 3. 测试与文档

- [x] `tests/e2e/hooks-inject.mjs`：mock 请求体断言 + 失败输出不在上下文 + 卡片截图 + 重开仍在
- [x] `SECURITY.md`、spec §七、`CHANGELOG.md`
- [x] `lint:all`、`npm test`、`npm run build && check:renderer-assets`、hooks 相关全部 e2e
- [ ] PR（Closes #385）→ CI 绿 → squash 合并

## 回滚

删配置即无注入；视图未识别 `hook_context` 时该消息只是不显示（模型仍收到），
因此回滚要同时回滚注入逻辑与投影，避免「不可见但生效」的中间态。
