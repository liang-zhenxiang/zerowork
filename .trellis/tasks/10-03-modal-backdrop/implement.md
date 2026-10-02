# 执行清单：修掉模态背板

> 需求见 `prd.md`，做法与影响面见 `design.md`。
> 分支：`fix/modal-backdrop`，一个任务一个 PR。

## 步骤

### 0. 开工前

- [ ] `git switch main && git pull` → `git switch -c fix/modal-backdrop`
- [ ] 基线：`npm run lint:all && npm test`，并记下 `npm run test:gui` 的脚本数与通过数
- [ ] 把 `.trellis/tasks/10-03-command-palette` 的归档移动（`git status` 里那批 `D`/`??`）
      一并带进本分支的提交

### 1. 影响面实测（`design.md` 的表是初稿，逐处核实）

- [ ] 对 9 处 `modal-backdrop` 逐个打开并 **实测**计算样式（不是一个一个推断）
- [ ] 确认 `.ex-modal-mask` 与 `.image-preview-overlay` 的结论
- [ ] 把实测结果（每一处：受影响 / 不受影响 + 数值）**更新进 `design.md`**
- [ ] 截图存档：至少「设置面板 + 专家详情」同框对照一张（一暗一亮的对照最直观）

### 2. 改 `app.css`

- [ ] `.app > :not(…)` 的排除清单补 `.modal-backdrop`
- [ ] **改掉那段已被证伪的注释**（「漏排除的后果是多一张卡，肉眼可见、不会静默」），
      换成事实描述 + 指向守卫用例的位置
- [ ] 不改 `.image-preview-overlay` 的 72%；不动视图页的既有行为

### 3. 新增守卫用例 `tests/e2e/modal-backdrop.mjs`

- [ ] 按 `design.md` §5 的 7 条实现
- [ ] 断言写成**遍历 DOM 里的遮罩类元素**，不是只查 `.modal-backdrop`
      （将来新增的直挂 `.app` 的浮层也要被它抓到）
- [ ] 打不开的模态（权限审批）**显式 `h.skip` 并写明原因**，不允许静默跳过
- [ ] `package.json` 加 `test:gui:modal-backdrop`，挂进 `test:gui` 链
- [ ] **反向验证**：去掉排除清单 → ②③④ 必须变红；改坏视图页 `margin` → ① 必须变红。
      两条都真跑一遍，结果写进文件头注释

### 4. 文档

- [ ] `CHANGELOG.md` 的 `[Unreleased]` → 「修复」，写清**此前错在哪、有什么后果**
      （背板是不透明的 `--bg` 面板，模态与页面失去分层；`--overlay` 成为死代码）
- [ ] 若 `docs/DESIGN.md` 有描述模态背板/`--overlay` 的段落，同步核对

### 5. 验收

```bash
npm run lint:all
npm test
npm run build && npm run check:renderer-assets
node tests/e2e/modal-backdrop.mjs
npm run test:gui        # 既有用例一条不少
```

- [ ] 逐条对照 `prd.md` 的 Acceptance Criteria
- [ ] 中文内容 U+FFFD 扫描
- [ ] 模态截图人工看一遍（浅 + 深）

### 6. 提交与 PR

- [ ] 小批量提交；提交信息走约定式提交、正文写为什么；**不出现反引号**（用 `-F`）
- [ ] PR 正文用 `--body-file`，含 `Closes #108`；创建后复核该关键字确实在
- [ ] `gh pr checks <N>` 等 `CI 总览` 绿；`gh pr merge <N> --squash --delete-branch`
- [ ] 判断成败**不用管道接 `tail`/`head`**；合并后复核远端状态与 Issue 是否关闭

## 回滚点

| 点 | 回滚 |
| --- | --- |
| 步骤 2 后 | 只改了一处选择器与一段注释，`git checkout -- src/renderer/src/app.css` 即回到基线 |
| 步骤 3 后 | 用例与 `package.json` 的挂链单独一个提交，可单独 revert |

## 明确不做

- 不换成正向清单（做法 B）—— 理由在 `design.md` §2
- 不修深色下的输入卡发光边（那是 **#106**）
- 不调 `--overlay` 的登记值（40% 是登记过的），模态卡片看不清是另一件事