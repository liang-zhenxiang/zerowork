# 把 vendored 依赖的审计盲区写进 SECURITY.md

## 问题（Issue #61）

`src/renderer/src/vendor-xlsx.js` 是 **SheetJS 0.18.5 的打包产物**（866 KB），
由 `office-xlsx.js` 懒加载 —— **它随包分发给用户，且带两个高危漏洞**
（原型污染 GHSA-4r6h-8v6p-xvw6、ReDoS GHSA-5pgg-2g8v-p4x9）。

**而 npm audit 与 Dependabot 都报不出来**：

1. 它不是 npm 依赖，是 vendored 到源码树里的 bundle
2. `xlsx` 这个包在 #49 之后移到了 `devDependencies` ——
   告警指向的包**已经不在生产依赖里**，看起来像「已修好」，
   而真正出问题的代码在源码树里，**没有任何工具盯着**

## 本次范围：**只做「让它可见」，不做升级决定**

升级要换到 SheetJS 自家的 registry（`cdn.sheetjs.com`）或换库 ——
那是**引入一个新的、非 npm 的依赖源**，属于供应链决策，需要单独讨论。

**本任务不做那个决定**，只做一件事：**把这个风险写进 `SECURITY.md` 的开放风险**，
不让它停留在「审计工具看不见 = 没人知道」。

## Requirements

- R1 在 `SECURITY.md` 里**如实写明**：
  - 存在一个随包的 vendored 依赖带已知高危漏洞
  - **为什么审计工具看不到它**（不是 npm 依赖 + 原包已移出生产依赖）
  - 影响面与**触发条件**（解析恶意 .xlsx —— 这正是本产品的核心功能）
  - 当前的处置状态（待评估升级路径，见 Issue #61）
- R2 **顺带说明这类盲区的普遍性**：本项目还有哪些 `vendor-*.js`
  （`vendor-jszip.js`、`vendor-lodash.js` 等），它们各自是什么库、什么版本 ——
  **即使它们当前没有已知漏洞也要列出**，因为「没人盯着」才是问题本身
- R3 语气要**准确不夸大**：这是「已识别的开放风险」，不是「正在被利用的漏洞」
- R4 对外文字中文

## Acceptance Criteria

- [ ] `SECURITY.md` 的开放风险里能查到这一条
- [ ] 列出了**全部** `vendor-*.js` 及其库名与版本（不是你随手挑几个）
- [ ] `npm run check:docs` 与 `lint:all` 全过
- [ ] 不夸大、不淡化 —— 说清「已知 + 未修 + 有跟踪 Issue」

## 约束

- **只改 `SECURITY.md`**（可能加一个小的检查/清单文件，但不要改代码）
- **不做依赖升级**、不改 `vendor-*.js`
- 不改 `resources/**`

## 难度

小。**主要是把事实说清楚**。
