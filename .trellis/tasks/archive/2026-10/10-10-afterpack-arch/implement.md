# 执行清单

## 1. 修正映射

- [ ] `ARCH_NAMES` 改为与 builder-util 一致：`0 ia32 / 1 x64 / 2 armv7l / 3 arm64 / 4 universal`
- [ ] 注释写清来源（`node_modules/builder-util/out/arch.js`）与「上游若改，单测会红」
- [ ] `riscv64` 的语义从 `undefined` 改为 `null`（显式的「明确全删」）

## 2. 抽纯函数（可测）

- [ ] `esbuildDirFor(platformName, arch)`：数字或字符串 arch → esbuild 目录名；
      返回 `undefined` = 表里没有（保守全留），`null` = 明确全删
- [ ] `trimEsbuildDir(dir, keep)`：在给定目录里执行裁剪，返回删掉几个
- [ ] `trimEsbuild(context)` 只是把两者与「找 .app」串起来
- [ ] 保留 `module.exports = afterPack`（electron-builder 的契约），命名导出挂在其上

## 3. 测试

- [ ] `tests/unit/after-pack-trim.test.mjs`
  - [ ] 映射矩阵：darwin / win32 / linux × ia32 / x64 / armv7l / arm64 / universal
  - [ ] **对着装着的 builder-util 反查**：本地映射与 `Arch` 枚举逐项一致
  - [ ] `linux/riscv64` → `null`（明确全删），未知组合 → `undefined`（保守全留）
  - [ ] **夹具反向验证**：临时目录里放 5 个平台目录 → 裁剪后只剩目标那一个；
        `keep=null` 时全删；目录不存在时不抛

## 4. 真验证

- [ ] 本机重跑 `npm run dist:dir`，确认那条 `未知的平台组合 darwin/ia32` **不再出现**，
      且日志变成「保留 darwin-x64，删除 0 个平台目录」
- [ ] `npm run check:package-size` 仍然通过

## 5. 收尾

- [ ] CHANGELOG `[Unreleased] → 修复` 记一条（写清「此前错在哪、有什么后果」）
- [ ] 归档任务目录、Roadmap #21 把 #183 移入已完成
