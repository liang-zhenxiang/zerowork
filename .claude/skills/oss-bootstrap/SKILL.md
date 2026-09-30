---
name: oss-bootstrap
description: 把一个新项目（或只有代码的裸仓库）落实为符合主流规范的开源项目——CI、治理文件、Issue/PR 模板、仓库自动化、文档体系、看板与发布流程。当用户说「新建开源项目」「给项目加上 CI / 规范」「按热门开源项目的标准搭基建」时使用。基建就位后的日常迭代请改用 maintain-loop skill。
---

# 开源项目 Bootstrap（oss-bootstrap）

把一个裸仓库变成结构完整的开源项目。**参考实现就在本仓库** —— ZeroWork 从只有代码的仓库起步，
已经完整走过一遍这条路，本仓库的每个文件都是可直接借鉴的成品。下面以它为参照
（路径均相对本仓库根），把流程沉淀为六个阶段。

## 与 maintain-loop 的关系

- **本 skill**：从 0 到 1 搭基建（只做一次，或大改时回来对照）
- **`maintain-loop` skill**：基建就位后，日常迭代的闭环（规划 → 实现 → 发布）

搭完基建后，一切开发工作都应切换到 maintain-loop 的流程。

## 第零步：先判断，再动手

1. **项目类型与工具链**：语言、构建工具、测试框架 —— 决定 CI 里静态检查与测试的内容。
   常见映射：
   - **JS/TS** → eslint + prettier + `tsc --noEmit` + vitest/jest（**本项目就是这一类**）
   - **Electron / 桌面应用** → 上面的基础上加 Playwright 驱动的端到端 GUI 测试
   - Go → golangci-lint + `go test`；Python → ruff + pytest；bash → shellcheck + `bash -n`
   - YAML（工作流）→ actionlint + yamllint；工作流安全 → zizmor
2. **仓库现状**：`gh repo view`、已有文件清单、**是否 fork**（fork 需要先在网页端脱离
   fork network 才能开部分功能，API 做不了）、已有 Secrets 与变量
3. **权限**：`gh auth status` 确认 scopes（`repo` / `workflow`）；操作 Projects 看板需要
   `project, read:project`，缺失时请用户执行 `gh auth refresh -s project,read:project`

**不要一次性问用户一堆问题。** 语言与现状自己判断；只有 **LICENSE 选型** 与
**是否已有用户 / 破坏性变更** 这类真正属于用户的决定才需要确认。

**先查一遍仓库里有没有「看起来对但其实是坏的」文件。** 本项目的 `LICENSE` 曾是一份
**被逐段截断**的 Apache-2.0（130 行 vs 官方 202 行），GitHub 因此把它识别为
NOASSERTION —— 对外等于「许可证不明」，比没有许可证更糟。核对方法：
`diff <(curl -sSL <官方文本>) LICENSE`。

**实施节奏**：按阶段推进，每个组件独立分支 + 独立 PR（小批量提交，CI 全绿再合并），
遵循 maintain-loop 的分支与合并规范。

---

## 阶段一：地基 —— CI 与提交规范

这是其他一切的前提：先让「每次改动都被自动检查」跑起来。

1. **CI 工作流**（参考 `.github/workflows/ci.yml`），骨架固定为这几层：
   - **静态检查**：按语言选工具，版本固定（可复现）。**收敛在单个平台上跑** ——
     与操作系统无关的检查放三份只是把同一件事做三遍
   - **测试**：保留**平台矩阵**，但只保留有真实价值的 leg。
     本项目的取舍：单元测试跑 ubuntu + **Windows**（路径分隔符、大小写敏感、
     保留设备名这些差异只在 Windows 暴露，历史上真抓到过问题），macOS leg 去掉
     （纯逻辑单测在 darwin 上没有增量）
   - **构建**：至少在最主要的平台上构建得出来
   - **端到端**：桌面应用必须真启动应用并驱动 DOM，不能只做「能启动不报错」的冒烟
   - **提交信息校验**：Conventional Commits，脚本方式实现（参考 `scripts/check-commit-msg.mjs`），
     同时校验区间内的提交与 **PR 标题**（squash 后标题就是提交信息）
   - **工作流自身的检查**：actionlint + yamllint + **zizmor**（安全扫描）
   - **`ci-summary` 汇总 job**：`needs: [全部]` + `if: always() && !cancelled()`，
     name 取 `CI 总览` —— 分支保护只盯这一个 check，增删检查项不用改保护规则
2. **本地统一入口**（参考 `scripts/lint.mjs`）：一条命令跑完 CI 里**本地能跑**的那些。
   三条要求：
   - 缺失的工具**跳过并列出**，跳过不等于通过
   - 文件头如实写明**它不覆盖什么**（本项目：提交信息规范与端到端 GUI 测试）
   - 用 Node 而不是 bash —— 使用者在 Windows / macOS / Linux 上都会跑它
3. **最小权限**：CI 声明 `permissions: contents: read`；需要写权限的在工作流或
   **job** 层单独声明（放在工作流层会被 zizmor 的 `excessive-permissions` 拦下）。
   所有 `run:` 块开头 `set -euo pipefail` + `#!/usr/bin/env bash`

### CI 里最容易做错的三件事

- **`${{ }}` 直接写进 `run:`** —— PR 标题、Issue 正文都是攻击者可控字符串，
  直接拼进 Shell 就是表达式注入。一律经 `env:` 中转
- **门禁 job 忘了 `exit 1`** —— 把各 job 的结果打印出来然后 `exit 0`，
  会让门禁永远绿灯，分支保护形同虚设。也要对每个 job 写**显式期望值**，
  不能用 `contains(needs.*.result, 'failure')` 模糊匹配（被跳过的 job 是 `skipped`）
- **矩阵没设 `fail-fast: false`** —— 一个 leg 挂了会取消其他 leg，
  你既丢失「哪些平台真的失败」，也让汇总更难判

---

## 阶段二：治理文件与模板

| 文件 | 参考 | 要点 |
| --- | --- | --- |
| `LICENSE` | 根目录 | 用户选型；**用官方全文**，附录只填版权署名，不加别的段落 |
| `CONTRIBUTING.md` | 根目录 | 流程、提交规范（**与校验脚本的类型清单必须一致**）、本地检查入口、分支策略 |
| `CODE_OF_CONDUCT.md` | 根目录 | Contributor Covenant 2.1；联系方式要**真实可用**（不要编造邮箱） |
| `SECURITY.md` | 根目录 | 漏洞报告渠道 + **威胁模型**（资产 / 信任边界 / 对手假设）+ 已知的开放风险 |
| `SUPPORT.md` | 根目录 | 分流路径：文档 → Discussions → Bug → 安全报告 |
| `.github/CODEOWNERS` | `.github/` | 兜底规则 + **安全敏感路径单独指定**（权限判定、沙箱、工作流、许可证） |
| Issue 模板 | `.github/ISSUE_TEMPLATE/` | **YAML 表单**而非 markdown；至少分 bug / feature / docs；`config.yml` 指向 Discussions 与 `security/advisories/new`，关闭空白 Issue |
| PR 模板 | `.github/PULL_REQUEST_TEMPLATE.md` | 为什么 → 做了什么 → 关键取舍 → 怎么验证 → 提交前清单 |
| 多语言 README | `README.md` / `README.en.md` | 顶部互相链接做语言切换 |

**Issue 模板里的字段要能直接缩小排查范围。** 本项目的 bug 模板里有「操作系统」一项，
因为命令沙箱是 Windows 专有的 —— 同一个操作在不同平台上的行为本来就不同。

---

## 阶段三：仓库自动化

参考 `.github/workflows/` 与 `.github/dependabot.yml`：

- **labeler.yml**：按改动路径自动给 PR 打标签。用 `pull_request_target`
  （fork 来的 PR 在 `pull_request` 下拿不到写权限的 token），
  **且绝不 checkout PR 代码** —— 任何 checkout PR 代码的场景禁止用 `pull_request_target`
- **welcome.yml**：首次贡献者致意（同样不 checkout 代码）
- **stale.yml**：N 天无响应标 stale，再 M 天自动关闭；给 `pinned` / `security` /
  `good first issue` 加 exempt
- **release.yml**：`v*.*.*` tag 触发。发布说明三段式组装 —— CHANGELOG 手写部分（awk 提取）
  + GitHub 原生 `releases/generate-notes`（PR 清单与对比链接）+ 可选 AI 摘要
  （配了 key 才启用，**任何失败都退出 0**，摘要不该成为发布的单点故障）。
  预发布版本（tag 含 `-`）不标 latest；**tag 过滤器末尾要加 `*`**，
  否则预发布 tag 根本不触发工作流，预发布逻辑成死代码
- **dependency-review.yml**：PR 引入有漏洞的依赖时拦截
- **ai-review.yml**（可选）：AI 代码审查。**不 checkout PR 代码**（用 `gh pr diff` 读文本）；
  opt-in；失败不阻断。必须在文件里写明「PR 文本可能包含提示注入，AI 意见不作为合并依据」
- **dependabot.yml**：**显式限定目录**。不限定的话，它会对着 `resources/**`
  这类随包分发的第三方模板自带的 lockfile 开 PR（本项目实测连开 6 个），
  而那些内容本项目约定**原样分发**、不代其升级

### 供应链加固（对标 OSSF Scorecard）

| 加固项 | 做法 |
| --- | --- |
| Actions pin 到 commit SHA | `uses: actions/checkout@<40 位 SHA> # v7.0.1` —— tag 可移动而 SHA 不可；注释保留版本号，Dependabot 的 PR 照常更新 SHA |
| checkout 不留凭证 | 每个 checkout 加 `persist-credentials: false` |
| 工作流安全扫描 | CI 加 **zizmor** job（容器按版本 pin，挂载 `:ro`），基线 0 findings；豁免集中在 `.github/zizmor.yml`，**每条豁免必须写明可验证的安全依据** |
| OSSF Scorecard | `ossf/scorecard-action`，`publish_results: true` 需要 `id-token: write`，README 加徽章 |
| 最小权限 | 每个工作流显式声明 `permissions`，且**写在 job 层而不是工作流层** |

**pin 到 SHA 而不开 Dependabot = 用供应链安全换永久不升级。** 这两件事必须一起做。

注意：给 step **插入** `with:` 块这类结构调整，逐个手工做（批量脚本会算错缩进层级）。

---

## 阶段四：文档体系

- **README**：面向使用者。结构：这是什么 / 特性 / 徽章 / 快速开始 / 平台支持 /
  文档索引 / 路线图 / 贡献 / 许可证。
  完成后核对两件事：提到的每个参数真实存在、本地链接全部有效
  （本项目有 `npm run check:docs` 自动做这件事，**包括校验文档里提到的环境变量
  在代码里真的有出处**）
- **docs 四件套**：
  - `USAGE.md`：从零跑起来的全部步骤 + 每个功能区详解 + 常见场景
  - `ARCHITECTURE.md`：面向想改代码的人，**写「为什么这样设计」并记录被否掉的方案**
  - `TROUBLESHOOTING.md`：现象（**保留报错原文**）/ 原因 / 解决；
    写明「什么情况下不该用这个方案」
  - `MAINTAINER_GUIDE.md`：维护者手册 + 项目红线
- **CHANGELOG.md**：Keep a Changelog 格式，`[Unreleased]` 段 + 固定六分类
  （新增/变更/弃用/移除/修复/安全），不自创分类

### 一条硬要求：不写无法复现的数字

本项目的 README 曾写「387 项断言」，其中单元测试的「111 项」对不上
（实际是 104 项）。**文档里任何统计数字都要能被一条命令复算出来**，
否则宁可写「以测试运行器的输出为准」。

### 从测试里取真实的界面名称

写使用文档时不要凭印象编造按钮与分组名。本项目的功能区与设置分组名是从
端到端测试的断言里取的（`tests/e2e/gui-sections.mjs` / `gui-settings.mjs`），
那是**被测试守着的**名字，不会漂。

---

## 阶段五：仓库设置（gh api / gh 命令）

这些不在代码里，要用 API 落实，并且**记录进 MAINTAINER_GUIDE 的「仓库配置清单」**：

```bash
# 仓库功能开关（一次 PATCH 全搞定）
gh api -X PATCH repos/{owner}/{repo} \
  -F has_issues=true -F has_discussions=true -F has_wiki=false \
  -F allow_auto_merge=true -F delete_branch_on_merge=true \
  -F description="..." 

# 安全功能
gh api -X PUT repos/{owner}/{repo}/private-vulnerability-reporting
gh api -X PUT repos/{owner}/{repo}/vulnerability-alerts
gh api -X PUT repos/{owner}/{repo}/automated-security-fixes
gh api -X PATCH repos/{owner}/{repo} --input - <<'JSON'
{"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}
JSON
```

> ⚠️ **`private-vulnerability-reporting` 不开，`SECURITY.md` 与 Issue 模板里指向
> `security/advisories/new` 的那个入口就是死的。** 这类「文档指向一个不存在的功能」
> 是搭基建时最容易漏的。

分支保护（**必须在 CI 至少跑过一次之后做**，否则 GitHub 找不到那个 check）：

```bash
gh api repos/{owner}/{repo}/branches/main/protection -X PUT --input - <<'JSON'
{ "required_status_checks": {"strict": true, "contexts": ["CI 总览"]},
  "required_pull_request_reviews": {"dismiss_stale_reviews": true, "required_approving_review_count": 0},
  "enforce_admins": false, "restrictions": null,
  "allow_force_pushes": false, "allow_deletions": false,
  "required_conversation_resolution": true }
JSON
```

注意 `contexts` 用的是**检查的显示名**（`ci-summary` job 的 `name:`），不是 job id；
单人维护的仓库 `required_approving_review_count: 0` —— 不要求别人审批，但 CI 仍是硬门禁。

其余：仓库 topics、标签体系（`gh label create`）、Projects 看板、Roadmap Issue、第一个里程碑。
需要用户手动配置的（Secrets、网页端开关）列一张清单告知，不要默默跳过。

---

## 阶段六：验证与首个发布

1. **全流程演练**：开一个真实的小 PR（哪怕是文档），完整走一遍
   分支 → PR → CI → review → squash merge → Issue 自动关闭。
   **基建只有在第一次真实使用时才算真正搭好。**
   ⚠️ 这一步大概率会暴露问题 —— 本项目的 CI 第一次真跑就抓到一条依赖宿主环境的断言
   （拿仓库根目录去验「能列出 git 分支」，而 CI 上是 detached HEAD + 浅克隆）。
   **这是好事，不要因为「本地是绿的」就跳过这一步**
2. **首个 Release**：CHANGELOG 归档 → 发布 PR → tag 推送 → 验证 `release.yml`
   产出的三段式发布说明
3. 交接：向用户汇报搭建清单（建了什么、在哪、还差什么需要手动配置）

---

## 搭建阶段的踩坑记录（与 maintain-loop 互补）

- **`run-name` 里的 `#`**：`run-name: 为 PR #${{ ... }}` 中 `#` 前有空格会被 YAML 当注释，
  表达式被吞掉。含 `#` 的行要加引号。yamllint 能发现。
- **一次 PATCH 全部仓库开关**：`has_issues` / `has_discussions` / `has_wiki` /
  `allow_auto_merge` / `delete_branch_on_merge` / `description` 可以一次改完，
  比逐个试快得多。
- **shellcheck 会检查 `run:` 里的内联脚本**：`ls | wc -l` 报 SC2012。用 `find`。
- **提交信息里的反引号**：用 `git commit -m "...\`xxx\`..."` 时反引号会被 shell
  当命令替换执行，**提交信息会静默缺一段**。一律写进文件用 `-F`。
- **`git mv` 会暂存重命名**，之后**任何一次 `git commit` 都会把它带上** ——
  哪怕你只想提交另一个文件。本项目真实踩过：改文件名后只 `git add` 了另一个文件提交，
  结果重命名被一起带进了那个 PR，而**引用更新还没提交** →
  在大小写敏感的 CI（Linux）上链接全断，本地（macOS 大小写不敏感）看不出来。
  两条应对：① 提交前用 `git status` 确认暂存区，或 `git show --stat HEAD` 复核；
  ② **怀疑「本地绿 CI 红」时先 `git stash push -u` 再跑本地检查** ——
  能立刻分清是「提交内容有问题」还是「未提交改动掩盖了问题」。
- **在大小写不敏感的文件系统上只改文件名的大小写**（`architecture.md` →
  `ARCHITECTURE.md`）同样危险：git 可能把它记成「修改」而不是「重命名」。
  稳妥做法是显式 `git mv <旧名> <新名>`，并用 `git show --stat` 复核结果是 `R` 而不是 `D` + `??`。
- **`git stash push -u` 是复现 CI 状态的好办法**：怀疑「本地绿 CI 红」时，
  先 stash 掉未提交改动再跑本地检查 —— 能立刻分清是「提交内容有问题」
  还是「未提交改动掩盖了问题」。
- **pin 到 SHA 时要核对 SHA 对应的版本**：本项目的 `download-artifact` 一度被
  误写成 `upload-artifact` 的 SHA（注释还写着 v7.0.1）。用
  `gh api repos/<owner>/<repo>/commits/<sha> --jq .commit.message` 复核。
- **`toJSON(needs)` + `node --input-type=module` heredoc** 是写汇总门禁的可行组合：
  表达式进入 `env:`（不经 shell），再用 heredoc 交给 node。

## 完成标准

- [ ] CI 覆盖静态检查、测试、构建、端到端、提交规范、工作流扫描，且有一个汇总 check
- [ ] 分支保护启用，且**只依赖汇总 check**
- [ ] 治理文件齐全，LICENSE 能被 GitHub 识别（`gh api repos/... --jq .license.spdx_id`）
- [ ] labeler / welcome / stale / release / dependabot / dependency-review 就位
- [ ] 供应链基线达标：所有 `uses:` pin 到 SHA、checkout 全部 `persist-credentials: false`、
      zizmor 0 findings（豁免有据）、Scorecard 就位
- [ ] docs 四件套 + CHANGELOG 就位，README 的参数与链接经过校验
- [ ] 看板、Roadmap Issue、第一个里程碑就位
- [ ] **一个真实 PR 从头到尾走通过**，首个 Release 已发布
- [ ] 移交清单已告知用户（需手动配置的 Secrets、网页端开关）

之后的一切迭代，切换到 `maintain-loop` skill。
