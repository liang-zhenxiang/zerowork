---
name: maintain-loop
description: ZeroWork 项目的维护闭环流程——规划、实现、发布、继续规划的完整循环，以及踩坑沉淀的硬规则。当需要在项目中继续迭代（新功能、修缺陷、补文档）、发布新版本、盘点未完成事项，或有人说「继续」「走维护流程」「按开源流程开发」时使用。
---

# 维护闭环（maintain-loop）

本项目（ZeroWork，仓库 `liang-zhenxiang/zerowork`，开发在 fork `nicholyx/zerowork` 上进行）
按真实开源项目的方式维护：小批量提交、PR 驱动、CI 门禁、Issue 追踪、里程碑与版本发布。

**核心闭环**：`规划 → 实现 → 发布 → 继续规划`。每一轮迭代围绕一个主题，走完一轮再开下一轮。

> 本 skill 假设项目基建（CI、治理文件、自动化、看板）已就位。
> 如果是**新项目**要从零落实开源规范，先使用 `oss-bootstrap` skill 搭建，再回到这里。

开始前，若对本项目的设计不熟，先读 `docs/ARCHITECTURE.md` 与 `docs/MAINTAINER_GUIDE.md`。

---

## 一、盘点现状（每轮开始与用户询问「还剩什么没做」时）

```bash
gh issue list --state open --json number,title
gh api repos/liang-zhenxiang/zerowork/milestones --jq '.[] | "\(.title): 完成 \(.closed_issues) / 待办 \(.open_issues)"'
gh release list
gh run list --branch main --workflow=ci.yml --limit 3
git status --short && git log --oneline -3
```

检查点：本地与远端是否一致、main 的 `CI 总览` 是否绿、`CHANGELOG.md` 的 `[Unreleased]`
是否积压了未发布的改动（**积压即说明「发布」这一步欠着，优先补上**）。

---

## 二、规划

1. **建里程碑**：`gh api repos/liang-zhenxiang/zerowork/milestones -f title="vX.Y.Z" -f state=open -f description="主题"`
2. **建 Issue**，每项一个，结构固定为：
   - **背景**：为什么（引用真实痛点或真实产物，不写空话）
   - **期望**：做成什么样（带验收标准 checkbox）
   - **入手位置**：涉及哪些文件/函数
   - **难度**：简单 / 中等 / 中偏难，标注「适合首次贡献」
   - `--milestone "vX.Y.Z"`，打上 `enhancement` / `bug` / `documentation` 标签
3. **更新 Roadmap（Issue #8）**：它是项目路线的**单一事实来源**。规划后把新条目写进
   「计划中」，完成后移入「已完成」，已完成条目带上 Issue 链接。README 的路线图段落
   **不重复维护一份**，只指向它。

---

## 三、实现

- **一个 Issue 对应一个分支、一个 PR**。分支名 `feat/*`、`fix/*`、`docs/*`、`chore/*`。
- **动手前先核实 Issue 的前提**。前提不成立时，在 Issue 里留言说明并改写范围，
  而不是硬着头皮实现一个错误的目标。
- 实现中偏离 Issue 计划（如发现了更严重的相关缺陷），**先起一个独立 Issue 记录**，再决定顺序。

### 设计原则（这个项目已确立的判断，新功能必须延续）

- **宁可拒绝，也不静默降级**。沙箱不可用时受限档**直接拒绝执行命令**，
  而不是「无约束地跑一下」。任何「为了让功能看起来能用而放宽安全约束」的改动都要拒绝。
- **反直觉但刻意的行为要写进文档与测试**：清空审计日志会留一条 `audit/cleared`、
  移除工作区**不删磁盘目录**、查询不存在的路径返回 `{kind:"missing"}` 而不是抛错。
  这些不是缺陷，改之前先读 `docs/MAINTAINER_GUIDE.md` 的「产品语义」表。
- **错误要可诊断**：报错里给出原因与逃生指引（例如命令被拒时说明「为什么拒」
  以及「怎么才能执行」），而不是一句「操作失败」。
- **文档与代码同等重要**：改了行为不改文档，等于没有改。

### 中文内容质量（本项目高频踩坑）

**每次编辑中文内容（代码注释、文档、Issue/PR 正文）后，全仓扫描 U+FFFD。**

```bash
python3 -c "
import pathlib
SKIP={'.git','node_modules','out','artifacts','coverage'}
# 这三个文件里的 U+FFFD 是**合法**的：vendored 解码器与 XML 字符集里的替换字符字面量
LEGIT={'src/renderer/src/code-preview.js','src/renderer/src/workspace.js','src/renderer/src/app.js'}
bad=[]
for p in pathlib.Path('.').rglob('*'):
    if not p.is_file() or any(s in p.parts for s in SKIP) or str(p) in LEGIT: continue
    try: t=p.read_text(encoding='utf-8')
    except Exception: continue
    if chr(0xfffd) in t:
        for i,l in enumerate(t.splitlines(),1):
            if chr(0xfffd) in l: bad.append(f'{p}:{i}')
print('\n'.join(bad) if bad else 'OK')
"
```

**这条必须执行，不要省。** 多轮迭代中反复出现「写入时混入替换字符」。

- **修的时候按行号整行重写，不要用 `str.replace(单个替换字符)`** ——
  一行里可能有**连续多个** U+FFFD，`replace` 会把它整段换成完整的替换文本，
  产出「用用于最佳努力的清理用于最佳努力的清理」这种重复串（真实踩过）。
  正确做法：读出该行、构造正确内容、按行号赋值回去。
- **批量改中文文档用「按行索引」，别用长中文串做匹配锚点**。长句里混入一个替换字符
  就会静默匹配失败或匹配错位。先用 `### 标题` 这类含 ASCII 的锚点定位，再按行号切片替换。
- 排错文档保留**报错原文**（使用者拿报错搜索），并写明「什么情况下不该用这个方案」。

### 提交与 PR

- 提交信息遵循 Conventional Commits（校验脚本 `scripts/check-commit-msg.mjs`，CI 会查）。
  **类型清单同时写在 `CONTRIBUTING.md` 与脚本的 `ALLOWED_TYPES` 里，改一处必须改另一处。**
  正文写**为什么**，不只是改了什么。
- 提交前本地跑 `npm run lint:all`。它**不验提交信息规范** ——
  CI 校的是 PR 标题，标题在 PR 建立前不存在，本地无从验证。
- 单条提交可以自查：`npm run check:commit-msg -- --message "feat(daemon): xxx"`
- PR 正文结构：为什么 → 做了什么 → **关键取舍（含被否掉的方案）** → 测试策略。
- **CHANGELOG**：每个用户可感知的改动都要记入 `[Unreleased]`，分类固定为
  新增/变更/弃用/移除/修复/安全，不自创分类。修复类条目写清「此前错在哪、有什么后果」。
- **往 `[Unreleased]` 插条目，锚点必须校验在正确段落里**。`lines.index('### 新增')`
  找的是全文件第一个 —— 版本刚发布后 `[Unreleased]` 是空壳，第一个「### 新增」在
  **上一个已发布版本**的段下，新条目会错插进已发布段。
  插入前断言「锚点行号 > `[Unreleased]` 行号 且 < 下一个 `## [` 行号」。
- **创建 PR / Issue 的正文写进临时文件，用 `--body-file /tmp/xxx.md`，不要用嵌套 heredoc**。
  把 `gh pr create --body-file - <<'EOF'` 放进 `$(...)`、外层又给循环加 heredoc 时，
  `-` 拿到的 stdin 会是空的 —— **正文静默丢失**，`Closes #N` 一起消失，
  症状是「PR 合并了、issue 还开着」。创建后用
   `gh pr view <N> --json body --jq '.body | length'` 复核正文真的落地了。
- **不要把提交信息直接当 PR 正文**（`--body-file` 指向提交信息那个文件）。提交信息里
  通常没有 `Closes #N`，而 **GitHub 只在 PR 正文里识别关闭关键字** —— 提交信息不算。
  本项目**连续两个 PR** 因此没有自动关闭 Issue，每次都要事后手工补。
  稳妥做法：正文文件单独写，**开头或结尾带 `Closes #N`**，创建后立刻复核：
  ```bash
  gh pr view <N> --json body --jq '.body | test("Closes #[0-9]+")'   # 应为 true
  ```
  合并后再核一次 Issue 状态（`gh issue view <N> --json state`）——
  这两步都很便宜，而漏掉的代价是一个「看起来还开着」的 Issue。
- **提交信息里不要出现反引号**：`git commit -m "...\`xxx\`..."` 的反引号会被 shell
  当命令替换执行，消息**静默缺一段**。一律写文件用 `-F`。

---

## 四、CI 与合并

- CI 全绿才合并：`gh pr checks <N>`。**唯一门禁是 `CI 总览`**。
- 合并：`gh pr merge <N> --squash --delete-branch`
- squash 后 PR 标题会成为提交信息，所以标题也要符合规范（CI 会校验）。
- **合并后核对 Issue 是否真的关闭了**（见上一条：正文丢失是常见原因）。

### CI 故障排查（真实踩过）

- **本地全绿、CI 却红** → 先 `git stash push -u`，在**已提交状态**下重跑
  `node scripts/lint.mjs`。这一步能立刻分清是「提交内容有问题」还是
  「未提交改动掩盖了问题」（真实踩过：`git mv` 的重命名被顺带提交进了另一个 PR，
  而引用更新还没提交 → 大小写敏感的 Linux 上链接全断，macOS 本地完全看不出）。
- **只有某个平台红** → 平台差异。历史上 Windows leg 抓到过路径拼接问题，
  macOS runner 抓到过「断言依赖宿主 checkout 形态」（拿仓库根目录去验「能列出 git 分支」，
  而 CI 上是 detached HEAD + 浅克隆，一个本地分支都没有）。
  **这类断言的正确改法是自建一个已知形状的夹具，而不是放宽断言。**
- **工具版本与 CI 不一致** → `node scripts/lint.mjs` 在版本不一致时会单独提示
  （actionlint / yamllint 的版本固定在 `ci.yml` 的 `env` 里）。
- **zizmor 报了新的 findings** → 它抓的是**工作流本身**的问题（权限过宽、
  表达式注入、`uses:` 没 pin），本地跑业务代码复现不出来。
  修法优先是改正，**不是**往 `.github/zizmor.yml` 加豁免；加豁免必须写明可验证的安全依据。
- **网络抖动是常态**：`gh` / `git push` 失败就重试：

  ```bash
  for i in 1 2 3 4 5; do
    if out="$(<命令> 2>&1)"; then echo "$out" | tail -1; break; fi
    echo "第 ${i} 次失败，重试..."; sleep 5
  done
  ```

  注意非幂等操作的重复执行风险（见发布幂等）。
- **`gh run view --job <id> --log` 在运行未结束时拿不到日志**，但
  `gh api repos/{owner}/{repo}/actions/jobs/<id>/logs` 可以 —— 等待整个运行结束
  不值得，用后者。
- **`gh` 只认 `origin`**：分支推在别的 remote 上时 `gh pr create` 会报
  `you must first push the current branch to a remote` —— 这不是网络问题，
  重试多少次都不会好，加 `--head <owner>:<branch>` 一次就过。

---

## 五、发布

1. 从最新 main 切 `chore/release-vX.Y.Z` 分支。
2. 把 `CHANGELOG.md` 的 `[Unreleased]` 归入 `[X.Y.Z] - 日期`，段首加一句话概述本轮主题；
   `[Unreleased]` 恢复为空壳。同时把 `package.json` 的 `version` 改成同一个版本号。
3. **发布前自查**：`npm run check:release-version -- vX.Y.Z` —— 校验
   tag / CHANGELOG / package.json 三者一致。不一致时发布说明会**静默地**只剩 PR 清单，
   而要撤掉一个已推送的 tag 很麻烦。
4. 提交信息 `chore(release): 发布 vX.Y.Z`，建发布 PR 并走完整 CI。
5. **推 tag 前先确认远端没有它**：`git ls-remote --tags origin vX.Y.Z`
6. `git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z`
7. `release.yml` 自动生成三段式发布说明（AI 摘要 + CHANGELOG 手写段 + PR 清单与对比链接）
   并附上安装包。
8. 验证：`gh release view vX.Y.Z` 确认内容齐全、`gh run list --workflow=release.yml` 成功。

### 发布幂等

网络抖动时 `git push` 可能「显示失败、远端已成功」，重试会重复推送 tag →
触发两次发布工作流。工作流已做「先查后建」（已存在改走 `gh release edit`），
但**推送 tag 前先用 `git ls-remote --tags origin vX.Y.Z` 确认不存在**，
避免制造无意义的失败运行。

### 判断成败禁止管道接 tail/head

```bash
# ❌ 判断的是 tail 的退出码 —— 命令没成功也报成功
if gh pr merge N --squash | tail -1; then ...

# ✅ 先取输出，判断放在后面
if out="$(gh pr merge N --squash 2>&1)"; then ...
```

这条是**真实事故**（发生在参考项目上）：一次合并没发生却报成功，tag 于是打在错误的
提交上、release 用了错误的内容生成；重推时又把一次真实的 SSL 失败误读为成功，
release 空窗近一小时才发现。

**merge / push 之后必须复核远端真实状态**：`gh pr view N --json state`、
`git ls-remote --tags origin vX.Y.Z`。

---

## 六、发布后：继续规划

- 更新 Roadmap（Issue #8）：本轮条目移入「已完成」。
- 建下一版本里程碑与 Issue（回到第二步）。
- 看板同步（新 Issue 加入、项目状态与里程碑一致）。

---

## 红线（来自 docs/MAINTAINER_GUIDE.md，任何时候不得违反）

- **`${{ }}` 表达式不直接写进 `run:`**，一律经 `env:` 中转（表达式注入）
- **不降低 `pull_request_target` 的安全性**。`labeler.yml` 与 `welcome.yml` 用它，
  安全前提是「不 checkout PR 代码、不执行 PR 内容」。往里面加 `actions/checkout`
  并指向 PR 分支 = 把仓库写权限交给任何提 PR 的人，必须拒绝
- **不在日志中输出 Secret**；不要依赖 GitHub 的脱敏机制（编码/截断后的值不会被识别）
- **不放宽权限默认值或沙箱约束**。放宽是安全敏感变更，PR 里必须说明理由与影响面，
  并同步更新 `SECURITY.md` 的威胁模型
- **不在 `resources/**` 上应用本项目的工具链**（eslint / prettier / vitest 三处整目录排除）。
  它是随包分发的第三方内容，有自己的风格与运行环境
- **不为了让 lint 通过而大规模重排** `src/renderer/src/` 与 `src/main/daemon/`
- **不删除 `$1` `$2` 这类变量名后缀**（构建工具消解命名冲突的结果）
- **不管凭证、内网地址**，进代码、进 Issue、进日志都不行。`resources/**` 的第三方内容也要扫
- **发布前必须确认第三方再分发授权**（见 `THIRD_PARTY_NOTICES.md`）。
  标为待确认的条目确认之前，不得对外声称可自由使用

## 快速命令参考

| 操作 | 命令 |
| --- | --- |
| 本地全量检查 | `npm run lint:all` |
| 校验一条提交信息 | `npm run check:commit-msg -- --message "feat(daemon): xxx"` |
| 校验发布版本号 | `npm run check:release-version -- vX.Y.Z` |
| 渲染层产物契约 | `npm run build && npm run check:renderer-assets` |
| 依赖安全 | `npm audit --registry=https://registry.npmjs.org/` |
| 建里程碑 | `gh api repos/liang-zhenxiang/zerowork/milestones -f title=... -f state=open` |
| 合并 PR | `gh pr merge <N> --squash --delete-branch` |
| 发布 | 推 `vX.Y.Z` tag 即触发 `release.yml` |
| 取某个 job 的日志 | `gh api repos/{owner}/{repo}/actions/jobs/<job-id>/logs` |
| 乱码扫描 | 见「中文内容质量」一节的 python 命令 |
