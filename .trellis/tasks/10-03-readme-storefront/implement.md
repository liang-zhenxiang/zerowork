# 执行清单：README 门面

> 需求 `prd.md`，做法 `design.md`。分支 `feat/readme-storefront`，一个任务一个 PR。

## 步骤

### 0. 开工前
- [ ] `git switch main && git pull` → `git switch -c feat/readme-storefront`
- [ ] 把 `.trellis/tasks/10-03-dark-polish` 的归档移动带进本分支
- [ ] 基线：`npm run lint:all`、`npm run check:docs`、`npm run check:release-notes`

### 1. 截图流水线 `tools/shoot-storefront.mjs`
- [ ] 复用 `tests/e2e/lib/harness.mjs` 启动（**隔离目录**，不碰真实用户数据）
- [ ] 用 `win.screenshot({ path, scale: "css" })` 按 CSS 像素拍（不是设备像素）
- [ ] 把窗口设成笔记本常见宽度（约 1440×900），并**确认应用不会把尺寸写回复用**
- [ ] 会话内容用 `tests/e2e/mock-model-server.mjs` 造，**不联网**
- [ ] 产出四张：`docs/images/home-light.png` / `home-dark.png` / `conversation.png` /
      `command-palette.png`
- [ ] **产物契约**：四张都存在、尺寸正确、**不是纯色**（复用 `lib/png.mjs` 的 `imageStats`）；
      任一条不成立就**非零退出**
- [ ] 脚本头部写清：什么时候该重跑、跑完要提交什么、断网时会拍到什么

### 2. 拍图并人工过目
- [ ] 跑脚本产出四张图
- [ ] **逐张看过**：有没有真实路径 / 姓名 / Key / 内网地址（红线 8）；
      版本号是不是构建期真值
- [ ] 单张宽度 ≤ 1600px、四张合计 ≤ 1.5 MB

### 3. README（中英同步）
- [ ] `README.md`：徽章之下插入首屏截图 + 「它能做什么」（2-3 条，每条一句用户的话 + 图）
- [ ] `README.en.md`：同样内容，**按英文表达习惯重写，不逐字对译**
- [ ] 图片用**相对路径**（`docs/images/…`），不要 `raw.githubusercontent.com` 绝对地址
- [ ] 「快速上手」写清：下载 → **首次运行怎么打开（未签名应用）** → 配模型 → 第一条
- [ ] **既有段落全部保留**，只增不改；不新增章节体系；不重复 Roadmap（指向 Issue #21）
- [ ] `npm run check:release-notes` 必须仍通过（首次运行指引三处 6/6）

### 4. 让图不会烂掉
- [ ] 核实 `scripts/check-docs.mjs` 是否覆盖 `![alt](路径)` 形态
      （已初步确认它的正则 `!?\[[^\]]*\]\(…\)` 覆盖图片；**用反向验证证实**）
- [ ] **反向验证**：临时把 README 里一个图片路径改坏 → `npm run check:docs` 必须**变红**；
      改回。记录结论
- [ ] 记录进 PR 正文

### 5. 验收与提交
```bash
npm run lint:all
npm run check:docs
npm run check:release-notes
npm test
npm run test:gui       # 确认没碰坏既有能力（本任务不该影响产品代码）
```
- [ ] 逐条对照 `prd.md` 的 Acceptance Criteria
- [ ] 中文 U+FFFD 扫描
- [ ] `CHANGELOG.md` 的 `[Unreleased]` → 「变更」
- [ ] 小批量提交；约定式提交、**不出现反引号**（用 `-F`）
- [ ] PR 正文用 `--body-file`，含 `Closes #107`；创建后复核该关键字确实在
- [ ] 等 `CI 总览` 绿 → squash 合并；判断成败**不接管道 `tail`/`head`**
- [ ] 合并后复核远端状态与 Issue 是否关闭

## 回滚点
| 点 | 回滚 |
| --- | --- |
| 步骤 1 后 | `tools/shoot-storefront.mjs` 是新增文件，删掉即回基线 |
| 步骤 2 后 | `docs/images/` 是新增目录，连同 README 改动单独一个提交，可单独 revert |

## 明确不做
- 不改任何 `src/**` 产品代码；**发现产品缺陷另开 Issue，不顺手改**
- 不做演示 GIF / 录屏；不把门面图纳入 CI 像素比对（理由见 design §4）
- 不动 `resources/**`