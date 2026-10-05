# vendored SheetJS 升到 0.20.3，并给这类代码配上周期巡检（#61）

## 背景（已核实的事实）

`src/renderer/src/vendor-xlsx.js` 是**随安装包分发**的预打包产物，此前是 SheetJS 0.18.5：

| 公告 | 严重度 | 上游修在 |
| --- | --- | --- |
| Prototype Pollution（CVE-2023-30533 / GHSA-4r6h-8v6p-xvw6） | high | 0.19.3 |
| ReDoS（CVE-2024-22363 / GHSA-5pgg-2g8v-p4x9） | high | 0.20.2 |

触发条件正是**解析用户提供的表格文件**（预览 `.csv` / `.xls` 时 `XLSX.read`）——
本产品的核心功能。而**没有任何审计工具看得见它**：它不是 npm 依赖、原包已被瘦身
（#49）移出生产依赖、Dependabot 里还显式 ignore 了 `xlsx`、升级 `package.json`
也不改变随包的字节（四层原因写在 SECURITY.md 的「审计盲区」一节）。

## 决策：走官方自有渠道，原样复制

两个公告的修复版本**只发在 SheetJS 自有分发**（`cdn.sheetjs.com`），npm 上 0.18.5 就是
最后一版 —— 而 OSV / GitHub Advisory 对 npm 包 `xlsx` 记的是 `{"introduced": "0"}` 且
**没有 `fixed` 事件**，所以**任何按 npm 包名查的自动化都会一直报它，哪怕我们修好了**。
这是本任务里最容易误导后来者的一点，必须写进文档与机制。

- 取 `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`（0.20.3 是当前最高版本，
  0.20.4 及以后实测 404）。
- 入库的是包内 `package/xlsx.mjs`，**原样复制**（不重排版）：
  - 导出面与旧版一致且多一个 `default`（应用只用 `read` / `write` / `utils`）；
  - 顺带修掉一个**许可缺陷**：此前那份复制品连上游版权头
    `/*! xlsx.js (C) 2013-present SheetJS */` 一起被删掉了，而 Apache-2.0 第 4 条
    要求保留归属声明。
- 记录两份 sha256（压缩包 + 入库文件），写进 SECURITY.md 供复核。

## 机制：「谁来盯」的答案是两半

| 一半 | 谁 | 守什么 |
| --- | --- | --- |
| 静态 | `scripts/check-vendored-deps.mjs`（进 `lint:all`） | **清单准不准**：新出现的 `vendor-*.js` 必须登记、清单版本必须与 bundle 里的版本标记逐字一致 |
| 动态 | `scripts/check-vendored-advisories.mjs` + `.github/workflows/vendored-advisories.yml`（每周一 + 手动） | **清单还新不新**：拿「库 + 版本」查 OSV.dev，有未豁免的公告就开/更新 Issue |

两个刻意的设计：

1. **版本不重复维护**：新脚本从 `check-vendored-deps.mjs` 的 `VERSION_MARKER` 取
   库名/生态/版本（版本还是从 bundle 正文现读的）。两处各写一份版本迟早会有一处落后。
2. **豁免不是「永远闭嘴」**：豁免条目必须写「上游修在哪个版本」，
   而脚本会**反过来校验**「手上的版本 ≥ 上游修复版本」，低于它照样失败。
   现在唯一两条豁免就是 SheetJS 那两个公告（因为 OSV 对 npm 侧没有 `fixed` 事件）。

## Acceptance Criteria

- [x] `vendor-xlsx.js` 升到 0.20.3（原样复制，含版权头），来源与两份 sha256 记进 SECURITY.md
- [x] `check-vendored-deps.mjs` 的 `VERSION_MARKER` 跟上新形态（单引号），并写明**为什么改正则**
- [x] 新增 `check-vendored-advisories.mjs`（0 无公告 / 1 有未豁免 / 2 没查成）与每周巡检工作流
- [x] 豁免表带理由 + 反查修复版本
- [x] SECURITY.md：清单版本、风险状态（已修）、「工具仍会报」的说明、复查落点
- [x] THIRD_PARTY_NOTICES.md 补登记 vendored JS bundle 的许可（xlsx Apache-2.0 / lodash MIT / JSZip MIT）
- [x] 单测 5 条（版本不低于修复版本 / 与 SECURITY.md 一致 / 导出面 / csv→xlsx 往返 / xls→xlsx）
- [x] GUI 1 条（真开 `.csv`，断言转换后的工作簿被渲染出来）
- [x] 反向验证：换回 0.18.5 → 三处守卫同时变红；复原后全绿
- [x] `lint:all` / `vitest` / `test:gui` 全绿

## 约束与非目标

- **不换解析库**（#61 的另一条候选路径）：换库要重写 10 万行的渲染层预览链路，
  收益不确定；本次先修掉随包的高危并把机制补上。
- 不放宽任何安全约束；`resources/**` 不动。
- 巡检工作流**刻意不进 `ci.yml`**：查漏洞数据库是不可靠的外部依赖，
  放进去会让 PR 因上游抽风而红。

## 难度

中。技术上只是换一个文件；难在**取证与机制**——来源可复核、豁免可证伪、
以及把「工具仍会报它」这件反直觉的事讲清楚。
