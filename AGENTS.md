# AGENTS.md —— 本仓库的开发规则与流程

> **这份文件是给 AI 助手看的，并且会被自动加载** —— 目的是让一个新会话
> **不必先调用 skill** 就知道这个项目该怎么开发。
>
> 加载机制（两件事都成立，规则只有一份）：AI 工具直接读本文件（Claude Code 从 v2.1.277 起原生支持）；
> 本仓库另有 [`CLAUDE.md`](CLAUDE.md) 用 `@AGENTS.md` 导入它 —— 那一行是**必需的**，
> 因为工作目录存在 `CLAUDE.md` 时 Claude Code 会转而忽略 `AGENTS.md`。
> 细节与「不要用软链」的理由见 `CLAUDE.md`。
>
> 人类读者请从 [README](README.md) → [CONTRIBUTING.md](CONTRIBUTING.md) →
> [docs/MAINTAINER_GUIDE.md](docs/MAINTAINER_GUIDE.md) 入手；
> 本文件是那三份的**规则速查版**。

---

## 项目是什么

**ZeroWork** —— 本地优先的办公 AI Agent 桌面端（Electron + React 19，
Agent 内核基于 `@earendil-works/pi-coding-agent`）。仓库 `liang-zhenxiang/zerowork`。

两条决定了很多取舍的前提：

- **只有 Windows 是完整支持的平台**：命令沙箱靠 `koffi` 调 Windows 专有的
  `kernel32` / `advapi32`，macOS / Linux 上受限档**直接拒绝执行命令**（有意的设计）。
  这也是**不发 Linux 安装包**的原因 —— 发了等于承诺一个不成立的支持
- **`resources/` 是随包分发的第三方内容**，不是本工程的源码：
  它有自己的风格与运行环境，**不参与本项目的 lint / 格式化 / 测试**
  （eslint / prettier / vitest 三处都做了整目录排除）
- **版权署名（`LICENSE` 与安装包的 `copyright`）是权利归属声明**，
  与「维护者是谁」是两件事；改动它属于权利人的决定

## 开发方式（先记住这条）

**所有开发都在本仓库内进行**：从 `main` 切分支 → 推分支 → 开 PR → 等 `CI 总览` 绿 → squash 合并。

- **不要经由 fork** —— 那会让 CI 逐次需要人工 approve、仓库设置与 Secrets 要配两套、
  Release 与代码分家。那些代价对**外部贡献者**是合理的，对维护者是纯粹的负担
- **即使有 push 权限，也不要直接推 `main`**：`CI 总览` 是分支保护的门禁，
  直接推就绕过了它；而且「自己 review 自己」是唯一能发现「顺手改坏了别处」的时刻

---

## 一轮迭代的完整流程

### 一、盘点现状（每轮开始，或用户问「还剩什么没做」）

```bash
gh issue list --state open --json number,title
gh api repos/liang-zhenxiang/zerowork/milestones --jq '.[] | "\(.title): 完成 \(.closed_issues) / 待办 \(.open_issues)"'
gh release list
gh run list --branch main --workflow=ci.yml --limit 3
git status --short && git log --oneline -3
```

检查点：本地与远端是否一致、`main` 的 CI 是否绿、`CHANGELOG.md` 的 `[Unreleased]`
**是否积压**（积压即说明「发布」这一步欠着，优先补上）。

### 二、规划

1. **里程碑**：`gh api repos/liang-zhenxiang/zerowork/milestones -f title="vX.Y.Z" -f state=open -f description="主题"`
2. **建 Issue**，每项一个，结构固定为：**背景**（为什么，引用真实痛点）/ **期望**（带验收标准 checkbox）/
   **入手位置**（涉及哪些文件）/ **难度**。打上 `enhancement` / `bug` / `documentation` 标签
3. **更新 Roadmap（Issue #21）** —— 它是路线的**单一事实来源**：
   新条目进「计划中」，完成的移入「已完成」并带上链接。README 不重复维护一份

### 三、实现

- **一个 Issue 对应一个分支、一个 PR**。分支名 `feat/*` `fix/*` `docs/*` `chore/*`
- **动手前先核实 Issue 的前提**。前提不成立时在 Issue 里留言说明并改写范围，
  而不是硬着头皮实现一个错误的目标
- 实现中发现更严重的相关缺陷 → **先起一个独立 Issue 记录**，再决定顺序

#### 这个项目已确立的设计原则（新功能必须延续）

- **宁可拒绝，也不静默降级**：沙箱不可用时受限档直接拒绝执行命令，
  而不是「无约束地跑一下」。任何「为了让功能看起来能用而放宽安全约束」的改动都要拒绝
- **反直觉但刻意的行为要写进文档与测试**：清空审计日志会留一条 `audit/cleared`、
  移除工作区**不删磁盘目录**、查询不存在的路径返回 `{kind:"missing"}` 而不是抛错
- **错误要可诊断**：给出原因与逃生指引，而不是一句「操作失败」
- **文档与代码同等重要**：改了行为不改文档，等于没有改

#### 中文内容质量（本项目高频踩坑，每次编辑中文后都要做）

```bash
python3 -c "
import pathlib
SKIP={'.git','node_modules','out','release','artifacts','coverage'}
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

> 那三个 `LEGIT` 文件里的替换字符是 **vendored 解码器与 XML 字符集里的合法字面量**，不要动。
>
> **修的时候按行号整行重写，不要 `replace(单个替换字符)`** —— 一行里可能有**连续多个**
> U+FFFD，`replace` 会把它整段换成完整文本，产出「用用于最佳努力的清理用于最佳努力的清理」
> 这种重复串（真实踩过）。批量改中文文档用「按行索引」，不要拿长中文串做匹配锚点。

#### 提交与 PR

- **提交信息遵循约定式提交**（`scripts/check-commit-msg.mjs`，CI 会查）。
  **类型清单同时写在 `CONTRIBUTING.md` 与脚本的 `ALLOWED_TYPES` 里，改一处必须改另一处。**
  正文写**为什么**，不只是改了什么
- **提交前跑 `npm run lint:all`**。它**不覆盖提交信息规范**（CI 校的是 PR 标题，
  标题在 PR 建立前不存在）与端到端 GUI 测试
- **提交信息里不要出现反引号**：`git commit -m "...\`xxx\`..."` 的反引号会被 shell
  当命令替换执行，消息**静默缺一段**。一律写进文件用 `git commit -F`
- **PR 正文写进临时文件用 `--body-file`，不要用嵌套 heredoc**（`-` 拿到的 stdin 会是空的，
  **正文静默丢失**）。创建后复核：
  ```bash
  gh pr view <N> --json body --jq '.body | test("Closes #[0-9]+")'   # 应为 true
  ```
- **不要把提交信息直接当 PR 正文** —— 提交信息通常没有 `Closes #N`，
  而 **GitHub 只在 PR 正文里识别关闭关键字**。本项目连续两个 PR 因此没有自动关闭 Issue
- **CHANGELOG**：每个用户可感知的改动都记入 `[Unreleased]`，分类固定为
  新增/变更/弃用/移除/修复/安全，**不自创分类**；修复类写清「此前错在哪、有什么后果」

### 四、CI 与合并

- **CI 全绿才合并**（`gh pr checks <N>`）。唯一门禁是 **`CI 总览`**
- `gh pr merge <N> --squash --delete-branch`（squash 后 PR 标题会成为提交信息，
  所以标题也要符合约定式提交）
- **合并后核对 Issue 是否真的关闭了** —— 没关就是 PR 正文里的 `Closes #N` 丢了
- **判断成败禁止管道接 `tail`/`head`**：`if gh pr merge N | tail -1; then` 判断的是
  **tail 的退出码**，命令没成功也报成功（这是参考项目上的真实事故：tag 因此打在错误提交上）。
  一律 `if out="$(cmd 2>&1)"`，输出打印放在判断**之后**；merge / push 之后
  **必须复核远端真实状态**（`gh pr view N --json state`、`git ls-remote --tags`）
- **本地全绿、CI 却红**时：先 `git stash push -u`，在**已提交状态**下重跑
  `node scripts/lint.mjs` —— 能立刻分清是「提交内容有问题」还是「未提交改动掩盖了问题」
- **`gh run view --job <id> --log` 在运行未结束时拿不到日志**，
  但 `gh api repos/{owner}/{repo}/actions/jobs/<id>/logs` 可以

### 五、发布

1. 从最新 `main` 切 `chore/release-vX.Y.Z`
2. `CHANGELOG.md` 的 `[Unreleased]` 归入 `[X.Y.Z] - 日期`，段首加一句话概述本轮主题；
   `[Unreleased]` 恢复空壳。同时把 `package.json` 的 `version` 改成同一个版本号
3. **发布前自查**：`npm run check:release-version -- vX.Y.Z` —— 校验
   tag / CHANGELOG / package.json 三者一致。不一致时发布说明会**静默地**只剩 PR 清单
4. 发布 PR 走完整 CI → squash 合并
5. **推 tag 前先确认远端没有它**：`git ls-remote --tags origin vX.Y.Z`
6. `git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z`
7. `release.yml` 自动生成三段式发布说明（AI 摘要 + CHANGELOG 段 + PR 清单）
   并构建 Windows / macOS 安装包附上，同时为安装包生成**构建溯源证明**
8. 验证：`gh release view vX.Y.Z` 内容齐全、`gh run list --workflow=release.yml` 成功

> ⚠️ **动过 `release.yml` 之后，一定要真的打一个 tag 验证。**
> 它的失败形态是 `startup_failure` + **0 个 job** —— 而**这类错误的日志根本不存在**，
> 必须去 workflow run **页面上看注解**。曾为此误判两轮，经过见
> `docs/MAINTAINER_GUIDE.md` 的「发布流水线起不来」。

### 六、发布后：继续规划

更新 Roadmap（Issue #21）→ 建下一版本里程碑与 Issue → 回到第一步。

---

## 红线（任何时候不得违反，改动需在 PR 里写明理由）

1. **`${{ }}` 表达式不直接写进 `run:`**，一律经 `env:` 中转（PR 标题、Issue 正文
   都是攻击者可控字符串，直接拼进 shell 就是表达式注入）
2. **不降低 `pull_request_target` 的安全性**。`labeler.yml` 与 `welcome.yml` 用它，
   安全前提是「**不 checkout PR 代码、不执行 PR 内容**」。
   往里面加 `actions/checkout` 并指向 PR 分支 = 把仓库写权限交给任何提 PR 的人，**必须拒绝**
3. **不在日志中输出 Secret**；不要依赖 GitHub 的脱敏机制（编码 / 截断后的值不会被识别）
4. **不放宽权限默认值或沙箱约束**。放宽是安全敏感变更，PR 里必须说明理由与影响面，
   并同步更新 `SECURITY.md` 的威胁模型
5. **不在 `resources/**` 上应用本项目的工具链**（eslint / prettier / vitest 三处整目录排除）
6. **不为了让 lint 通过而大规模重排** `src/renderer/src/` 与 `src/main/daemon/`
   （那是两块大文件，重排会产生淹没真实改动的巨型 diff）
7. **不删除 `$1` `$2` 这类变量名后缀**（构建工具消解命名冲突的结果）
8. **凭证 / 内网地址不进代码、不进 Issue、不进日志**。`resources/**` 的第三方内容也要扫
9. **发布前必须确认第三方再分发授权**（见 `THIRD_PARTY_NOTICES.md`）。
   标为待确认的条目确认之前，**不得对外声称可自由使用**
10. **不直接推 `main`**，也不为了「隔离」而改走 fork

---

## 常用命令

```bash
npm run lint:all        # 本地全量检查（= CI 里本地能跑的那些，11 项）
npm run test            # 单元测试
npm run test:gui        # 端到端 GUI 测试（真实启动 Electron）
npm run test:all        # lint:all + 单元 + 端到端

npm run check:app-id    # 安装器 appId 与运行时 APP_ID 是否一致
npm run check:commit-msg -- --message "feat(daemon): xxx"
npm run check:release-version -- vX.Y.Z
npm run build && npm run check:renderer-assets   # 渲染层产物契约

npm audit --registry=https://registry.npmjs.org/  # 本机配了镜像时必须显式指定官方源

gh pr checks <N>                          # 门禁状态（只认「CI 总览」）
gh pr merge <N> --squash --delete-branch
gh api repos/{owner}/{repo}/actions/jobs/<job-id>/logs   # 运行未结束时取 job 日志
```

---

## 其他文档与 skill 的分工

| 去哪 | 看什么 |
| --- | --- |
| **[docs/MAINTAINER_GUIDE.md](docs/MAINTAINER_GUIDE.md)** | **维护流程的事实来源**：项目定位与边界、仓库配置清单、测试分层、应急处理、项目红线 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献者视角：本地检查、提交规范、分支策略、Review 流程 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 改代码前必读：进程模型、模块划分、**以及为什么这样设计** |
| [docs/DESIGN.md](docs/DESIGN.md) | 改界面之前必读：设计 Token 的档位纪律与禁止清单 |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | 排错：现象 / 原因 / 解决，含「什么情况下不该用这个方案」 |
| [Roadmap Issue #21](https://github.com/liang-zhenxiang/zerowork/issues/21) | 路线的单一事实来源 |

**项目级 skill**（`.claude/skills/`，随仓库分发）：

| Skill | 什么时候用 |
| --- | --- |
| `maintain-loop` | 本项目的日常迭代：**逐步操作视角 + 长尾踩坑记录**（本文件是它的规则速查版） |
| `oss-bootstrap` | **给另一个新项目**从零搭开源基建时用。对本项目的日常开发没有约束力 |

> **改维护流程时，`AGENTS.md` 与 `docs/MAINTAINER_GUIDE.md` 都要改** ——
> 前者是会话自动加载的速查版，后者是事实来源。skill 是操作视角，同步更新即可。
