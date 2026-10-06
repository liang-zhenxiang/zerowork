# 执行清单：资料库

> 需求 `prd.md`，技术设计 `design.md`，调研 `research/feasibility.md`。
> 分支 `feat/library`，一个任务一个 PR（对应 Issue #115）。

> **完成记录（2026-10-06 归档）**：本任务已随 **PR #116** 于 2026-10-03 squash 合并
> （merge commit `b451604`），Issue #115 同时关闭。下面的清单按合并时的事实回填：
> 验收证据取自 PR #116 正文的验证表（`npm run lint:all` 16 通过 / `npm test` 225 通过 /
> `test:gui` 22 个脚本全过 / `build && check:renderer-assets` 通过），
> 反向验证三条也已独立复现。**唯一未做的是「截图」那一条**，据实保持未勾。

## 步骤

### 0. 开工前
- [x] `git switch main && git pull` → `git switch -c feat/library`
- [x] 把 `.trellis/tasks/archive/2026-10/10-03-readme-storefront` 的归档移动带进本分支
- [x] 基线：`npm run lint:all && npm test`，记下 `npm run test:gui` 的通过数

### 1. daemon 侧聚合（先写纯逻辑，便于单测）
- [x] 在 `session-files.js` 加聚合函数：扫会话文件 → 抽 `artifacts_presented` →
      **按 path 全局去重** → 每个 path 一次 `statSync` 得 `exists` → 按 `deliveredAt` 降序
      截断到 `LIBRARY_MAX_ITEMS` 并置 `truncated`
- [x] 元数据形状见 `design.md` §1.2；`size`/`kind`/`html` 是**交付时刻快照**，
      `exists` 是**实时** —— 注释里写清这个区别
- [x] `sessions` 数组：**最近在前**、**去重**（同一会话交付两次只出现一次）
- [x] 健壮性：坏行跳过、坏文件跳过、整体不抛（`design.md` §1.6）

### 2. IPC 三处接线
- [x] `src/shared/ipc.js` 加 channel 常量
- [x] `src/preload/index.js` 暴露 API
- [x] `session-files.js` 的 INVOKE 表加 handler
- [x] `npm run lint:all`（里面有 IPC 一致性检查，改完必须跑）

### 3. 渲染层
- [x] `LibraryView`：骨架抄 `SkillsView` / `AutomationsView`（load + busy + error + 列表 + 空态）
- [x] 列表行抄 `OverviewView` 的行形态，**不新造视觉**（`docs/DESIGN.md` §6）
- [x] 三态互斥且可辨；**空态要教人怎么产生产物**（`design.md` §3.3）
- [x] 失效条目：**不只靠颜色**的标记（§7.6），并给出原因
- [x] 动作：预览（**走来源会话的 cwd**）、在文件夹中显示（落在该 cwd 外时的降级）、
      定位到来源会话（复用 `resumeTask`）
- [x] `NAV_ITEMS$1` 的「资料库」改 `ready: true`，并在 label 分派处加分支
- [x] `app.css` 只在确有需要时加，优先复用既有类

### 4. 测试
- [x] `tests/unit/library-aggregate.test.mjs`：覆盖 `design.md` §4「单元」全部条目
      （每个用例一个临时目录，照 `mailbox-session-index.test.mjs` 的模式）
- [x] `tests/e2e/library.mjs`：覆盖 §4「GUI」七条；挂进 `package.json` 的
      `test:gui` 链（新脚本 `test:gui:library`）
- [x] **反向验证两条**（写进文件头注释）：去重去掉 → ⑦ 红；空态与加载态合并 → ② 红
- [x] 两条都**真跑并还原**

### 5. 文档
- [x] `CHANGELOG.md` 的 `[Unreleased]` → 「新增」
- [x] `docs/USAGE.md` 的「资料库」一节**改写成与实现一致**：只列**产物**、
      失效条目怎么表达、跨工作区为什么不能直接预览
- [x] Roadmap（Issue #21）更新

### 6. 验收与提交
```bash
npm run lint:all
npm test
npm run build && npm run check:renderer-assets
npm run test:gui          # 既有用例一条不少
```
- [x] 逐条对照 `prd.md` 的 Acceptance Criteria
- [x] 中文 U+FFFD 扫描
- [ ] 截一张「资料库有产物」的图给维护者看（浅 + 深）—— **未做**：PR #116 正文与评论都没有附图
- [x] 小批量提交；约定式提交、**不出现反引号**（用 `-F`）
- [x] PR 正文用 `--body-file`，含 `Closes #115`；创建后复核该关键字确实在
- [x] 等 `CI 总览` 绿 → squash 合并；判断成败**不接管道 `tail`/`head`**
- [x] 合并后复核远端状态与 Issue 是否关闭

## 回滚点
| 点 | 回滚 |
| --- | --- |
| 步骤 1-2 后 | daemon 侧是新增函数 + 新 channel，`git checkout` 相关文件即回基线 |
| 步骤 3 后 | `LibraryView` 是新增视图 + 导航一处改动，可单独 revert |

## 明确不做（v1）
见 `prd.md` 的「后续项」：run 会话的产物、缓存、工作空间文件浏览、从资料库删除条目。

## 特别注意
- **不放宽安全边界**：预览只用既有 `previewBaseUrl` + 来源会话 cwd；
  **不要**为了「让所有产物都能预览」去加一条渲染层可指定任意路径的读取通道
- **不做推送**：资料库只做拉式 invoke，不挂到 run 边界（否则每次 run 都扫盘）