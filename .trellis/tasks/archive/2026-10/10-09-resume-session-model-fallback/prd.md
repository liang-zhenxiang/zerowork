# resume 回落会话自身模型：没选过模型也能回到这条会话 (#162)

## Goal

`resumeSession` 在 `activeModelKey` 为空时，回落到**会话文件里记录的模型**（#162 方案 A）。
修好两处同一堵墙：对比屏「留为会话 → 去这条会话」与资料库「定位到来源会话」——
全新用户（没配过全局模型）点进去不再收到「还没有选择模型」。

Issue: https://github.com/liang-zhenxiang/zerowork/issues/162

## Background（已核实的前提）

- `createHost`（`src/main/daemon/session-files.js:2529` 一带）在 `activeModelKey === void 0` 时直接抛
  「还没有选择模型」；`resumeSessionOnce`（`:3524`）→ `mountSessionFile` → `remountHostInBucket` → `createHost`。
- 会话文件里的模型信息**可得**：pi 的 `SessionManager` 有 `model_change` 条目（`provider` + `modelId`），
  且 `SessionContext.model` / `SessionProjection.model` 直接给出 `{provider, modelId}`（已读
  `node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts:32-34,148-162`）。
- 全局模型 key 的格式是 `providerId/modelId`（`session-files.js:4791` 的拼法），与会话条目的
  `{provider, modelId}` 一一对应。
- 自动化任务执行器（`session-files.js:985`）有同款检查，但那是**新建**宿主、无会话文件可回落，
  不在本任务范围（保持现状）。

## Requirements

1. `createHost` 在 `activeModelKey === void 0` 时：
   - 若 bucket 挂着会话文件（resume 场景），从中取**当时的模型**（优先 `SessionContext.model`，
     即最近一次 `model_change` 的投影；没有则扫条目找最后一个 `model_change`）
   - 拼成 `providerId/modelId` 后查 `catalog.isUsable(...)`：可用 → 用它建宿主（**不写回**
     `activeModelKey`，全局选择不受影响）；不可用 → 报错文案升级为针对性提示
     （「这条会话用的是 {模型}，先在设置里接上它就能打开」），不再是一句泛泛的「还没有选择模型」
   - 取不到模型信息（老会话文件无 `model_change`）→ 同样给针对性文案（指路设置页）
2. `activeModelKey` 已有值时**行为不变**：resume 仍按全局选择走（现状语义）。
3. 资料库「定位到来源会话」自动受益（同一代码路径），不需要单独改动。

## 约束

- **不新建**任何持久化：回落模型是 resume 时的**临时决定**，落盘反而会制造「全局选择被悄悄改了」的意外。
- 会话文件**只读**：回落不写 `model_change` 条目（那是 pi 在真实切换时写的；Host 用什么模型
  由 `SessionHost.create({ modelKey })` 决定，恢复投影时 pi 会从条目重建状态）。
- 错误文案遵循「错误要可诊断」：说清缺什么、去哪补。

## Acceptance Criteria

- [ ] 单测（vitest）：回落解析的纯逻辑——有 `model_change` 的会话取到正确的 key；
      没有的返回 undefined；`isUsable` 拒绝时错误文案包含模型名与「设置」指引
- [ ] 单测：`activeModelKey` 有值时 createHost 的模型来源不经过回落分支（回归保护）
- [ ] e2e/GUI（真实启动）：**不预配模型**的全新环境，把一条含 `model_change` 的会话文件放进
      sessions 目录 → resume 能进入会话（界面出现该会话的消息），而不是弹「还没有选择模型」
- [ ] e2e/GUI：全局已配模型的既有用例全部不回归（全量 `npm run test:gui`）
- [ ] 反向验证：回落模型在 catalog 里**不可用**时（如 provider 已删），错误文案点名模型并指路设置页
- [ ] CHANGELOG `[Unreleased]` 记入 修复 类（写清此前错在哪、后果是什么）

## Notes

- 入手位置：`src/main/daemon/session-files.js` 的 `createHost`（约 `:2529`）；模型来源
  `SessionManager` 实例在 `mountSessionFile(options.manager)` 与 `remountHostInBucket` 链路上可得。
- 相关既有测试参考：`tests/e2e/compare-keep.mjs`（不预配模型的隔离环境做法可借鉴）。
