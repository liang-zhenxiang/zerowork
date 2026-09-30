# 贡献指南

感谢你愿意花时间。这份文档说明**这个项目怎么接受改动** —— 读完之后你应该知道：
从哪里入手、本地怎么验、提交信息怎么写、PR 会被怎么审。

## 目录

- [动手之前](#动手之前)
- [行为准则](#行为准则)
- [我能贡献什么](#我能贡献什么)
- [报告问题](#报告问题)
- [修改规则](#修改规则)
- [开发环境准备](#开发环境准备)
- [本地检查](#本地检查)
- [提交信息规范](#提交信息规范)
- [分支与合并策略](#分支与合并策略)
- [测试](#测试)
- [Review 流程](#review-流程)
- [发布流程](#发布流程)

---

## 动手之前

先读这三份：

| 文档 | 为什么 |
| --- | --- |
| [README.md](README.md) | 这个项目是什么、怎么跑起来 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 进程模型、目录职责、**以及「为什么这样设计」** |
| [docs/DESIGN.md](docs/DESIGN.md) | 改界面之前必读：设计 Token 的档位纪律与禁止清单 |
| [AGENTS.md](AGENTS.md) | **用 AI 助手改这个项目**：开发流程与规则的速查版（AI 工具会自动加载它） |

如果你要改的是界面，**第三份不能跳** —— 它规定了哪些做法被禁止，
以及档位不够用时应该先改文档而不是在组件里加档。

---

## 行为准则

参与本项目即表示你同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。
简而言之：对人友善，对事严格。

---

## 我能贡献什么

| 类型 | 适合谁 | 怎么做 |
| --- | --- | --- |
| **报 Bug** | 任何人 | 用 [Bug 模板](https://github.com/liang-zhenxiang/zerowork/issues/new/choose) 提 Issue，附报错原文 |
| **改文档** | 任何人 | 文档与代码同等重要。发现文档与实现不一致，指明具体文件与行号即可 |
| **补测试** | 熟悉项目的人 | 见[测试](#测试)一节：**每一层都写过「为什么这一层不可替代」**，还没被覆盖的地方是明确的 |
| **修 `good first issue`** | 首次贡献者 | 这类 Issue 的正文里写明了「从哪个文件入手」 |
| **加功能** | —— | 先在 Issue 里说一声，避免两个人做同一件事 |

**不建议一上来就大改。** 这个项目有两块体量很大的代码（`src/main/daemon/` 约 40 个模块、
`src/renderer/src/` 下单个 chunk 6.8 万行），它们的现状是**有意的**，
理由写在 `docs/ARCHITECTURE.md` 的「设计决策与已否决方案」一节。
动手前先读那一节，能省下大量来回报。

---

## 报告问题

- **功能缺陷 / 崩溃**：使用 [Bug 模板](https://github.com/liang-zhenxiang/zerowork/issues/new/choose)
- **使用疑问**：到 [Discussions](https://github.com/liang-zhenxiang/zerowork/discussions)，不必开 Issue
- **安全漏洞**：**不要**开公开 Issue，见 [SECURITY.md](SECURITY.md)
- **文档与实现不一致**：请指出具体文件与行号

拿不准该走哪条？看 [SUPPORT.md](SUPPORT.md) 的分流。

---

## 修改规则

这一节是这个项目**真实的知识**，不是客套话。它划出三档。

### ✅ 可以改的

- `tools/`、`tests/`、`docs/`、`scripts/`、构建配置、治理文件 —— 这些是原创内容
- `src/main/index.js`、`src/preload/index.js`、`src/shared/ipc.js` ——
  已人工整理过，模块边界清晰
- `resources/` 下的**自研内容**（场景、模式、专家、技能、提示词、样式）

### ⚠️ 谨慎改的

- `src/main/daemon/` —— 约 40 个模块、2 万多行，改动前先确认影响面。
  模块之间的相对 import 由 `npm run check:daemon-graph` 守着，
  但**语义耦合**（谁在什么时候初始化)没有自动检查
- `src/renderer/src/` —— 大块 chunk（`app.js` 单个 6.8 万行），
  且与构建产物的命名约定耦合。**改产物命名前必读
  `electron.vite.config.mjs` 的 renderer 段注释**：源码里的 `m.f||(m.f=[...])`
  依赖表是**字面量字符串**，构建工具不会改写它们 —— 产物名一旦带上内容哈希，
  懒加载就会 reject 到错误边界（真实事故，见 `CHANGELOG.md` 的 `0.1.4-zerowork.23`）。
  这条有自动守卫：`npm run check:renderer-assets`
- `resources/` 下的**第三方内容** —— 本项目对它们是**原样分发**。
  它们的授权状态见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)

### 🚫 不要做的

- **不要为了让 lint 通过而大规模重排** `src/renderer/src/` 与 `src/main/daemon/`
  的代码格式。格式化会产生巨大的 diff，淹没真实改动。
  （这也是 `npm run format:check` 的范围**刻意只覆盖工具链与工作流**的原因，
  见 `.prettierignore` 里逐条写明的排除理由）
- **不要删除 `$1` `$2` 这类变量名后缀**。它们是构建工具消解命名冲突的结果，
  手工「整理」会引入难以发现的引用错误
- **不要在 `resources/**` 上跑本项目的 lint / formatter / 测试**。
  它有自己的风格与运行环境，用本工程的规则去要求它只会产生数千条无意义报错 ——
  `eslint.config.mjs`、`vitest.config.mjs`、`.prettierignore` 三处都做了整目录排除，
  请不要「顺手」把排除去掉

---

## 开发环境准备

```bash
node --version    # 需要 >= 22.19.0（见 package.json 的 engines）
npm ci            # 用 ci 而不是 install：它严格按锁文件装，可复现
npm run dev       # 开发模式（渲染层热更新）
```

### 开发模式需要显式指定资源与配置目录

主进程按 `process.env` 定位资源与配置目录，未打包运行时需要显式指定：

```bash
ZEROWORK_CONFIG_DIR=/tmp/zerowork-dev \
ZEROWORK_RESOURCES_DIR=$PWD/resources \
npm start
```

`ZEROWORK_CONFIG_DIR` 建议指向临时目录 —— 否则会污染你真实的 `~/.zerowork`。

> 如果装依赖很慢：本机可以配一个镜像源（`npm config set registry https://registry.npmmirror.com`，
> 并设 `replace-registry-host=always`）。**请配到用户级的 `~/.npmrc`，不要提交进仓库** ——
> 仓库里的 `package-lock.json` 刻意指向官方 registry，这样 CI（跑在境外）与本地都能走最快的路。

---

## 本地检查

### 一键自查（推荐）

```bash
npm run lint:all
```

它跑完 CI 里**本地能跑**的那些静态检查：eslint、prettier、tsc、daemon 模块图、
文档有效性、随包内容完整性、行尾一致性、渲染层产物契约，以及
actionlint / yamllint / zizmor（没装的工具会**跳过并提示安装方式**，
跳过项在结尾单独列出，**不会被算作通过**）。

**它不覆盖两件事，交接时请留意：**

- **提交信息规范**。CI 校的是 PR 标题，而标题在 PR 建立之前根本不存在 ——
  本地没有任何入口能验它，本地全绿不等于 `commit-messages` 会绿。
  单条提交可以自查：`npm run check:commit-msg -- --message "feat(daemon): xxx"`
- **端到端 GUI 测试**与**安装包构建**，它们需要图形环境，在 CI 上跑

### 只想跑单项

```bash
npm run lint                 # eslint
npm run format:check         # prettier（范围见 .prettierignore）
npm run typecheck            # tsc --noEmit（当前为宽松模式，见 tsconfig.json 注释）
npm run check:daemon-graph   # daemon 模块图闭合
npm run check:docs           # 文档链接有效 + 环境变量有出处
npm run check:resources      # 随包关键文件存在且被 git 跟踪
npm run check:line-endings   # 行尾一致性
npm run build && npm run check:renderer-assets   # 渲染层产物契约（需先构建）
```

### 端到端测试

```bash
npm run test        # 单元测试（Vitest）
npm run test:gui    # 端到端 GUI 测试（真实启动 Electron）
npm run test:e2e    # 全部端到端（含需要真实模型端点的那几层）
npm run test:all    # lint:all + 单元 + 端到端
```

---

## 提交信息规范

使用[约定式提交](https://www.conventionalcommits.org/zh-hans/)：

```
<类型>(<范围>): <描述>

类型：feat | fix | docs | ci | chore | refactor | perf | test | style | revert | build
范围：main | daemon | renderer | preload | shared | sandbox | tools | docs | ci
```

例：

```
fix(daemon): 修正 daemon ready 推送与渲染层监听的竞态
docs(tools): 补充模块图检查的用法说明
```

上面那份类型清单**同时写在两个地方**，改一处必须改另一处：

- 本文档这一节（给人看的）
- `scripts/check-commit-msg.mjs` 的 `ALLOWED_TYPES`（给机器看的）

CI 会校验 PR 标题与 PR 区间内的每条提交（squash 合并后 PR 标题就是提交信息）。
本地可以自查一条：

```bash
npm run check:commit-msg -- --message "feat(daemon): 支持批量同步"
```

**正文写「为什么」，不只是「改了什么」。** diff 已经说明了改了什么；
review 时最有价值的是动机、被否掉的方案、以及你踩过的坑。

---

## 分支与合并策略

| 分支 | 用途 |
| --- | --- |
| `main` | 唯一长期分支，**只能通过 PR 合入** |
| `feat/*` | 新功能 |
| `fix/*` | 缺陷修复 |
| `docs/*` | 文档 |
| `chore/*` | 基建、依赖、工具链 |

流程：

```bash
git switch -c feat/short-description main
# ... 改动 ...
npm run lint:all
git commit -m "feat(daemon): ..."
git push -u origin feat/short-description
gh pr create --fill        # 或按模板写正文
```

**合并用 squash**，保持 `main` 历史线性。一个 PR 只做一件事 ——
夹带无关改动会让 review 成本陡增，也会让回滚变得不可能。

---

## 测试

改了代码就要考虑测试。这个项目的测试不是「覆盖率指标」，每一层都回答一个具体问题：

```bash
npm run test        # ① 单元测试：纯逻辑对不对
npm run test:gui    # ②–⑬ 端到端：不依赖真实模型
npm run test:e2e    # ②–㉒ 全部端到端（⑯–㉒ 需要本机有可用模型端点，不可用时整轮跳过）
```

各层的分工写在 `docs/MAINTAINER_GUIDE.md` 的「测试分层」一节，
每一层都注明了**它为什么不可替代**。

三条硬要求：

1. **改 GUI 相关代码务必跑 `npm run test:gui`**。Electron 应用最常见的故障形态是
   「界面看着正常，但 IPC 全挂」—— 只做「能启动」的冒烟测试抓不到。
   测试会真实启动应用、驱动 DOM、断言 daemon 存活与 IPC 应答
2. **新增界面功能请同步补端到端断言**。测试截图输出在 `artifacts/`，可直接肉眼复核
3. **改完 daemon 请跑 `npm run check:daemon-graph`**。`src/main/daemon/` 的模块用相对
   import 相连，漏一个 export、写错一个路径，构建期抓不到，只会在运行时某个冷门分支抛
   `ReferenceError`。CI 的「静态检查」job 里跑同一条命令

### 写断言时的两个陷阱（都是踩过的）

- **断言不要匹配状态词本身**。「汇总：成功 3 ｜ 失败 0」这类输出里，
  几个状态词永远都在里面 —— `grep -q '失败'` 等于断言恒真。
  要匹配带上下文的正文行，或断言具体数值
- **「调用了不报错」证明不了任何事**。通道名拼对但 handler 是空函数，照样不报错。
  设置类断言一律「读当前值 → 写新值 → 读回来断言变了 → 还原 → 断言变回去」

---

## Review 流程

### 提交 PR 之后

CI 会自动跑起来（约几分钟）。如果红了不用慌，点进失败的检查项就能看到具体原因。
`CI 总览` 是唯一的门禁 check，它绿了才算全绿。

### 作为作者，你可以期待

- 我们会在合理时间内给出第一次反馈；如果一周没有回应，欢迎在 PR 里 @ 维护者 ——
  那是我们的问题，不是你的
- 反馈会**区分「必须改」和「建议」**，前者会说明原因
- 指出问题时会给方向，而不只是「这里不好」

### 作为 reviewer，我们按这个顺序看

1. **CI 是否通过** —— 没通过先看为什么，别急着看代码
2. **改动是否符合项目定位**（见 [docs/MAINTAINER_GUIDE.md](docs/MAINTAINER_GUIDE.md) 的「项目定位与边界」）
3. **描述里的「为什么」** —— 只说「改了什么」的 PR 要追问动机
4. **有没有触碰[红线](docs/MAINTAINER_GUIDE.md#项目红线)**
5. **有没有同步更新文档** —— 改了行为却改了文档的，要打回
6. **有没有更新 CHANGELOG** —— 用户可见的行为变化必须有记录

### 什么样的 PR 会被拒绝

- 一个 PR 里夹带多个不相关的改动
- 为了让 lint 通过而大规模重排 `src/renderer/src/` 或 `src/main/daemon/`
- 放宽权限默认值 / 沙箱约束，而没有说明理由与影响面
- 在 `resources/**` 上跑本项目的 lint / formatter
- **给工作流加自动触发器**，或把 `${{ }}` 直接写进 `run:`（见红线）

---

## 发布流程

维护者执行，大致如下（细节见 [docs/MAINTAINER_GUIDE.md](docs/MAINTAINER_GUIDE.md)）：

```bash
# 1. 把 CHANGELOG.md 的 [Unreleased] 归入新版本号，并保留一个空的 [Unreleased]
# 2. 提交并合并
git switch -c chore/release-v0.2.0 main
# ... 改 CHANGELOG 与 package.json 的 version ...
git commit -m "chore(release): 发布 v0.2.0"

# 3. 推送 tag（这一步触发自动发布）
git tag -a v0.2.0 -m "v0.2.0" && git push origin v0.2.0
```

推 tag 之前可以用 `npm run check:release-version -- v0.2.0` 自查
tag / CHANGELOG / `package.json` 三个版本号是否一致 —— 不一致时发布说明会静默地
只剩 PR 清单，而要撤掉一个已推送的 tag 很麻烦。

`release.yml` 会自动生成三段式发布说明（CHANGELOG 手写段 + GitHub 原生 PR 清单
+ 可选 AI 摘要），并在构建产物就绪后附上安装包。
