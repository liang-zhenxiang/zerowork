# 「关于」页补第三方组件注明（#19 的可执行部分）

## 背景（已核实）

1. **「关于」页已经存在**，但只有三行：版本、诊断入口、配置目录 —— 没有任何第三方注明。
2. **应用确实随包分发第三方代码**：KaTeX（含字体子集）、SheetJS（`vendor-xlsx.js`，
   2026-10-05 刚从 0.18.5 升到 0.20.3）、lodash、JSZip、PDF.js（`pdf.worker.js`）。
   MIT 与 Apache-2.0 都要求在**分发副本**里保留版权与许可声明，而用户手上是安装包、
   不是仓库（`electron-builder.yml` 的 `files` 只带 `out/**`、`package.json`、`resources/`，
   仓库根的 `LICENSE` / `THIRD_PARTY_NOTICES.md` **不进包**）。
3. **#19 里那条 MiSans 义务其实不成立**：文档说「MiSans 留在 `--font-body` 最末位兜底」，
   而实现里 `--font-body` 现为 `"PingFang SC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
   （无 MiSans），`@font-face` 已于 2026-09-20 移除，renderer 构建根下没有 `fonts/` 目录
   （woff2 从未入库）。**不使用就没有注明义务** —— 那不是「欠着」，是「不必做」。

## 交付

- `src/renderer/src/attributions.js`（纯数据）：应用许可 + 5 个随包组件（名字/许可/权利人/用途）
  + 完整清单的落点。刻意**不列 MiSans**（列了等于声称用了它）。
- 「关于」页新增「第三方组件」一段 + 一行指向 `THIRD_PARTY_NOTICES.md` 的说明
  （完整清单与许可原文以仓库那份为单一真源，应用内不复制副本以免漂移）。
- 新增 `.settings-subhead` 一节标题样式（档位照既有：`--text-body` + 次文色 + 500 字重，
  不新造字号）。
- 文档纠正：`THIRD_PARTY_NOTICES.md`（MiSans 条目与两条待办改为「不适用」/「已履行」）
  与 `resources/fonts/README.md`（状态改为「已完全移除」）；`docs/USAGE.md` 补关于页说明；
  `CHANGELOG.md` 新增一条。

## Acceptance Criteria

- [x] 单元 7 条：字段齐全 / 名字不重复 / 应用许可与 `package.json` 一致 / licenseIds 去重 /
      落点是仓库文件；**两个方向**——SECURITY.md 里每个随包 vendored 依赖都在清单里、
      **已不随包的 MiSans 不许出现**（并断言 `--font-body` 里确实没有它）
- [x] GUI：打开「关于」，断言「第三方组件」小节与 5 行**真的渲染出来**（`getClientRects` 非空，
      不是「在 DOM 里」）、许可标识露出来、链接文字是文件名；浅色 + **深色**两张截图
- [x] 反向验证两条：往清单塞 MiSans → 单测 2 条红；删掉关于页的注明块 → GUI 红（复原后 41/41）
- [x] `lint:all` / `vitest`（336 条）/ `test:gui` 全绿

## 非目标

- **不把许可原文复制进安装包**：那会与仓库那份各自漂移；本轮以「应用内注明 + 指向仓库」
  履行归属义务。若将来要求离线自包含，应做**打包时复制**（`scripts/before-pack.cjs`）
  而不是在仓库里再存一份副本。
- 不动 #19 里另外两项（Anthropic 专有许可、付费技能）—— 那要权利人裁决，不是技术手段能代替。
