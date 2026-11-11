# 执行清单

## 1. 纯逻辑与 runner

- [ ] 新建 `src/main/daemon/hooks.js`：解析/校验、合并、matcher、决策、runner（注入 spawn）
- [ ] 新建 `tests/unit/hooks.test.mjs`（按 design §八）
- [ ] 跑 `npm test -- tests/unit/hooks.test.mjs`

## 2. 配置与 IPC

- [ ] `preferences.js`：读侧白名单加 `hooks` 与 `trustedWorkspaceHooks`；写侧校验
- [ ] `src/shared/ipc.js`：`hooks:get` / `set-user` / `set-trusted` / `test`
- [ ] `src/preload/index.js`：对应 bridge + JSDoc
- [ ] `session-files.js`：四个 handler；工作区 `.zerowork/hooks.json` 读取与信任判断
- [ ] 单元：配置损坏 fail-closed、未信任跳过

## 3. 接入与审计

- [ ] `session-files.js` 主会话 extensions 最前面插 hooks 扩展（权限门之前）
- [ ] 定时任务两处、子代理/团队成员一处同样插入
- [ ] `audit.js` 加类别 `hook`；renderer 审计中心类别筛选同步
- [ ] 集成测试 `tests/e2e/hooks-block.mjs`：write 被 exit 2 拦住、文件未写、审计 blocked；
      exit 1 也拦住（fail-closed）；无 hook 时正常

## 4. 设置页

- [ ] `HooksSection` 放在 `PermissionSection` 之后：用户级列表/编辑/删除/试运行
- [ ] 工作区卡片：路径、是否存在、信任开关、只读列表、未信任说明
- [ ] `app.css` 追加 §45；token；窄窗；暗色；reduced-motion
- [ ] GUI 测试 `tests/e2e/gui-hooks.mjs` + 浅/暗截图

## 5. 收尾

- [ ] `SECURITY.md` 增加 Hooks 威胁模型
- [ ] `CHANGELOG.md` `[Unreleased]` →「安全」或「新增」
- [ ] `npm run lint:all`、`npm test`、`npm run build`、`npm run test:gui`（全量）、`check:unicode`
- [ ] 分支 `feat/deterministic-hooks` → PR（Closes #368），CI 绿后 squash 合并

## 回滚

- 默认空配置 = 零行为变化；删掉配置即可关闭
- 工作区 hooks 默认不执行，回滚不需要清理用户仓库
