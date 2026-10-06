# 依赖告警的分级处置（#17）

## 背景（2026-10-06 复核的真实数字）

Issue 里记的是 94 条（三轮评论后 87/88），**当前实际是 89 条**：

| manifest | 条数 |
| --- | --- |
| `resources/plugins/teams_marketplace/modern-webapp/…/template/package-lock.json` | 33 |
| `resources/plugins/teams_marketplace/ppt-implement/…/templates/frontend/yarn.lock` | 21 |
| `resources/docx-engine/pyproject.toml` | 18 |
| `resources/plugins/teams_marketplace/ppt-implement/…/scripts/export/package-lock.json` | 4 |
| `package-lock.json`（仓库根） | 13 |

`npm audit`（全量）28 条；`npm audit --omit=dev`（随包的那一半）**1 条**。

## 交付

1. **四类分解**写进 `SECURITY.md`（归属 + 影响面 + 每类的动作）：
   随包第三方模板 76 / 开发依赖 25 / 无 npm 修复版的 xlsx 1 / 审计盲区 vendor-*.js（已处置）。
2. **`THIRD_PARTY_NOTICES.md` 新增第 1.5 节**：四个 manifest 的路径、条数、来源与
   「为什么不升级」；并写明**要移除某项资产就移除整个目录**（别只改依赖）。
3. **76 条 `resources/**` 告警按「不适用」逐条带理由关闭**（reason=not_used，
   comment 指向上面两处）—— 让告警列表反映「已判定」，而不是每周重新判断一次。
4. **一轮非破坏性的 `npm audit fix`**（28 → 26，锁文件随之更新，336 条单测与构建仍绿）。
5. **唯一一条随包高危**（`brace-expansion@5.0.9`，经 `pi-coding-agent → minimatch@10`）
   如实记录 + 开上游 [Issue #140](https://github.com/liang-zhenxiang/zerowork/issues/140)：
   修复版 5.x **只发 ESM**，而 eslint 链上的 CJS 使用者要 1.x/2.x —— 全局 override 会打断构建；
   嵌套 override 实测**根本不生效**（npm 报 overridden、装的还是 5.0.9）。
   **刻意不加假 override**：加了只会掩盖问题。

## 结果

开放告警 **89 → 13**（全部在仓库根，且都已分类）。

## 不做

- 不逐个升级 `resources/**`（理由见上）。
- 不在本轮做跨主版本升级（vitest 5 / electron-builder 26.5 / monaco 0.57）——
  那是 Dependabot 的例行工作，塞进这个 PR 只会把风险混在一起。

## 难度

低-中。难的是**判断**（哪条该修、哪条该关、哪条修不了），不是操作。
