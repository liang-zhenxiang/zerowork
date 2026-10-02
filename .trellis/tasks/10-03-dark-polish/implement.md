# 执行清单：暗色与首屏视觉收口

> 需求 `prd.md`，做法 `design.md`，诊断依据 `research/design-review.md`。
> 分支 `fix/dark-polish`，一个任务一个 PR。

## 步骤

### 0. 开工前
- [ ] `git switch main && git pull` → `git switch -c fix/dark-polish`
- [ ] 基线：`npm run lint:all && npm test`，记下 `npm run test:gui` 的通过数
- [ ] 把 `.trellis/tasks/10-03-modal-backdrop` 的归档移动带进本分支

### 1. R1 输入卡外槽收进 token
- [ ] `:root` 增 `--composer-slot-bg`（原值原样搬进去，浅色渲染不变）
- [ ] `[data-theme="dark"]` 增同名覆盖（`var(--bg-raised)` → `var(--bg)`，理由见 design §1）
- [ ] `.composer-slot` 改引 token；**把原处那段「仍不入 token 档」的注释一并订正**
      （那个决定做于暗色主题存在之前）
- [ ] `npm run check:theme-tokens` 必须通过

### 2. R2 案例封面
- [ ] `.case-cover img` 加淡入过渡（`--dur-fast` / `--ease-standard`）
- [ ] `[data-theme="dark"] .case-cover img` 加 `filter: brightness(.86) saturate(.94)`
- [ ] `prefers-reduced-motion` 下关停淡入 —— **注意确认关停清单里关的是不是 animation，
      transition 要单独处理**
- [ ] 若新增了登记项，同步 `docs/DESIGN.md` §10.3 / §10.3.1

### 3. R3 §3.8 节奏断言
- [ ] 在 `tests/e2e/gui-smoke.mjs` 加一段：读 `.home-title` / `.mode-tabs` /
      `.capability-row` / `.home-guide` 的 computed `margin-bottom`，断言 12/12/24/16
- [ ] **写死数值，不读 token**（读 token 是自证）

### 4. 截图与像素证据
- [ ] 浅/深两套主题的首页截图
- [ ] 断言**深色下输入卡外槽区域的平均亮度不高于主背景一个可辨阈值**
      （防「token 加了但没生效」）
- [ ] 深色封面的**修复前后对比**（修复前的一张可以先拍下来存进 PR，不必进库）

### 5. 反向验证（写进测试文件头注释）
- [ ] 把 `--composer-slot-bg` 从暗色块删掉 → 相关断言必须**变红**
- [ ] 把 §3.8 的某一个 `margin-bottom` 改坏 → 节奏断言必须**变红**
- [ ] 两条都真跑、都还原

### 6. 验收与提交
```bash
npm run lint:all
npm test
npm run build && npm run check:renderer-assets
npm run test:gui          # 既有用例一条不少
```
- [ ] 逐条对照 `prd.md` 的 Acceptance Criteria
- [ ] 中文 U+FFFD 扫描
- [ ] `CHANGELOG.md` 的 `[Unreleased]` → 「修复」（写清此前错在哪、有什么后果）
- [ ] 小批量提交；提交信息走约定式提交、**不出现反引号**（用 `-F`）
- [ ] PR 正文用 `--body-file`，含 `Closes #106`；创建后复核该关键字确实在
- [ ] 等 `CI 总览` 绿 → `gh pr merge --squash --delete-branch`；判断成败**不接管道 `tail`/`head`**
- [ ] 合并后复核远端状态与 Issue 是否关闭

## 回滚点
| 点 | 回滚 |
| --- | --- |
| 步骤 1-2 后 | 只改 `app.css` 若干行，`git checkout -- src/renderer/src/app.css` 即回基线 |
| 步骤 3 后 | 断言在既有用例内，可单独 revert |

## 明确不做
- 不动 `cases.json` / CDN / 授权面（**#104**）
- 不尝试让 `check-theme-tokens` 查字面量逃逸（**#105**）
- 不给案例卡加遮罩盒子（违反 §3.9）、不改 `home-main` 的 `padding-bottom`