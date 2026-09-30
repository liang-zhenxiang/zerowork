# 维护者手册

这份文档写给项目的维护者。

它回答两个问题：**这个项目平时需要做什么**，以及**出事了怎么办**。

## 目录

- [维护者](#维护者)
- [项目定位与边界](#项目定位与边界)
- [仓库配置清单](#仓库配置清单)
- [自动化设施一览](#自动化设施一览)
- [测试分层](#测试分层)
- [日常维护](#日常维护)
- [处理 Issue](#处理-issue)
- [审查 PR](#审查-pr)
- [发布新版本](#发布新版本)
- [应急处理](#应急处理)
- [项目红线](#项目红线)
- [附：常用命令速查](#附常用命令速查)

---

## 维护者

| 维护者 | GitHub | 邮箱 | 关注面 |
| --- | --- | --- | --- |
| liang-zhenxiang | [@liang-zhenxiang](https://github.com/liang-zhenxiang) | 116311683@qq.com | 仓库整体、发布 |
| nicholyx | [@nicholyx](https://github.com/nicholyx) | nicholyx@163.com | 仓库整体、发布 |

**两人都是全权维护者**，权限与职责相同：都可以合并 PR、发布版本、处理安全问题。
代码所有者（`.github/CODEOWNERS`）指定的也是这两位。

分工上的两条约定：

- **敏感改动互相过目**：`src/main/daemon/permission-rules.js`、`src/main/sandbox/`、
  `.github/workflows/` 这些安全敏感路径的改动，尽量由**另一位**看一眼再合并
  （分支保护不强制审批 —— 单人维护时那会把自己锁在门外；这条靠约定，不靠机器）
- **一个人休假或失联时，另一个人有全部权限接手**，不存在「只有某人能发布」的环节。
  这也是为什么 Secrets 与仓库设置不绑定个人账号

**联系方式用于**：安全报告（首选 [Private vulnerability reporting](https://github.com/liang-zhenxiang/zerowork/security/advisories/new)，
见 `SECURITY.md`）、行为准则的执行（见 `CODE_OF_CONDUCT.md`）。
这两处的联系人也都是以上两位。

> 版权署名（`LICENSE` 附录与安装包的 `copyright` 字段）与此处的维护者名单是**两回事** ——
> 前者是权利归属声明，后者是「找谁」。当前署名是 `Copyright 2026 ZeroWork`。


## 项目定位与边界

明确项目**做什么**和**不做什么**，是拒绝无关需求时最有力的依据。

### 做

- 办公场景的本地 AI Agent 桌面端：多场景对话、专家与技能体系、MCP 连接器、
  自动化任务、会话归档与审计
- 把「模型能力」接到「用户的真实文件与工作流」上
- **本地优先**：本地能做的事不放到云端，出站请求逐条可查（见 `EXTERNAL_REQUESTS.md`）
- 安全默认收紧：受限档宁可拒绝执行，也不静默地无约束执行

### 不做

| 不做的事 | 原因 |
| --- | --- |
| 做模型本身 / 训练模型 | 本项目是 Agent 的**宿主**，模型通过可配置的 provider 接入 |
| 只绑定某一家模型供应商 | 支持自定义 `baseUrl` 的 OpenAI 兼容端点，是不被单一供应商锁死的前提 |
| 做成需要部署的服务端 | 会彻底改变项目的使用门槛；本地优先是这个项目的立足点 |
| OCR / 扫描件识别 | 与「文档解析」是两件事，引入的依赖体量与准确率预期都完全不同 |
| 为一个平台「差不多能用」就发布 | Linux 安装包就是因此不发的：命令沙箱拿不到，发出去等于承诺一个不成立的支持 |
| 放宽权限默认值以换取「顺手」 | 见[项目红线](#项目红线) |

**落到「不做」里的需求，礼貌地引用这一段并说明理由后关闭** —— 让它悬着比明确拒绝更消耗人。

---

## 仓库配置清单

以下配置**不在代码里**，只在 GitHub 仓库设置中，换机器或重建仓库时需要重新配置。

### 必须开启的仓库功能

| 功能 | 为什么必须 |
| --- | --- |
| **Issues** | 反馈主入口，配合 `.github/ISSUE_TEMPLATE/` 的表单使用 |
| **Discussions** | 承接使用提问，避免 Issue 列表被问答淹没（`SUPPORT.md` 与 Issue 模板都指向它） |
| **Private vulnerability reporting** | `SECURITY.md` 与 `ISSUE_TEMPLATE/config.yml` 都指向 `security/advisories/new`。**不开的话那个入口是不存在的**，文档里的安全报告渠道就是死的 |
| **Secret scanning** + **Push protection** | 推送含凭证的内容时直接拦截 |
| **Dependabot 告警** + **安全更新** | 依赖存在已知漏洞时告警并自动提 PR |
| **合并后自动删分支**（`delete_branch_on_merge`） | 否则每次都得手动带 `--delete-branch`，忘了就留下垃圾分支 |
| **允许自动合并**（`allow_auto_merge`） | 否则 `gh pr merge --auto` 会报 `Auto merge is not allowed` |

### 应当关闭的

| 功能 | 为什么关 |
| --- | --- |
| **Wiki** | 文档正文在 `docs/`，随 PR 一起被 review；留着空 Wiki 只会让访客点进一个空页面 |

### 分支保护

`Settings` → `Branches` → `Add branch protection rule`，分支名 `main`：

- ✅ Require a pull request before merging
- ✅ Require status checks to pass → 只选 **`CI 总览`**
- ✅ Require conversation resolution before merging
- ⬜ Require approvals —— **单人维护时不要开**，否则维护者没法合并自己的 PR
- ✅ Do not allow force pushes / deletions

> `contexts` 用的是检查的**显示名**（`ci-summary` job 的 `name:` = `CI 总览`），
> 不是 job id。而且这一步必须在 CI 至少跑过一次之后做，否则 GitHub 找不到那个 check。
>
> 只需要盯这一个 check 是刻意的：**增删检查项时不用回来改分支保护规则**。

### Secrets 与 Variables

当前**没有任何必需的 Secrets**。两个可选项：

| 名称 | 用途 | 不配的后果 |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | ① `release.yml` 生成发布摘要；② `ai-review.yml` 做 PR 审查 | 两个功能都**静默跳过**，发布与 CI 不受影响 |

> 这两个功能都是 **opt-in** 且**任何失败都退出 0** —— 它们不该成为发布或合并的单点故障。

### Labels

默认标签之外，项目标签由 `.github/labeler.yml` 自动应用，需要先用
`gh label create` 建出来（见本仓库的提交历史或重新执行一次建标签脚本）：

`ci` / `dependencies` / `automation` / `governance` / `stale` / `pinned` /
`security` / `desktop` / `agent-core` / `ui` / `sandbox` / `resources` / `tests` / `release`

### 配置现状（2026-09-30 核对）

上面那份清单里已经配好的：Issues / Discussions / Wiki（已关）/ Projects /
允许自动合并 / 合并后自动删分支 / Private vulnerability reporting / topics / 标签体系。
仓库许可证已被 GitHub 识别为 **Apache-2.0**。

**还没配的是分支保护** —— 它需要 admin 权限。在配上之前，
**`main` 上没有硬门禁**：CI 照常运行，但不会阻止直接合并。
这是当前最该补的一项，配置内容见上一节。

> Secret scanning / Push protection / Dependabot 安全更新这几项**需要 admin 权限才能读取状态**，
> 维护者请在 `Settings → Code security` 里自行确认一遍。

### 开发在本仓库内进行，不要走 fork

**从 `main` 切分支 → 推分支 → 开 PR → 等 `CI 总览` 绿 → squash 合并。**
全部在 `liang-zhenxiang/zerowork` 这一个仓库里完成。

不要为了「隔离」而改走 fork：那会带来三件实打实的代价 ——
fork 来的 PR 其工作流需要维护者**逐次人工 approve** 才会跑；
仓库设置与 Secrets 要**配两套**；Release 与代码会**分家**（tag 打在哪一边都不对）。
这些代价对「外部贡献者」是合理的，对主要维护者是纯粹的负担。

**即使有 push 权限，也不要直接往 `main` 提交。** 三个理由：

1. `CI 总览` 是**分支保护的门禁**，直接推就绕过了它 —— 那道门禁会变成摆设
2. 提交信息规范与 CHANGELOG 需要一个**执行点**。squash 合并时 PR 标题会被 CI 校验，
   直接提交没有这个环节
3. 单人维护时「自己 review 自己」仍然有效：它强制你在合并前把 diff 完整看一遍，
   而这是唯一能发现「顺手改坏了别处」的时刻

> 外部贡献者仍然走 fork + PR（这是 GitHub 的标准协作方式）。
> 上面说的只是**维护者自己**不要绕这一圈。

---

## 自动化设施一览

| 工作流 | 触发条件 | 它做什么 |
| --- | --- | --- |
| `.github/workflows/ci.yml` | push 到 main、PR、手动 | 静态检查 / 三平台测试 / 构建 / GUI / 提交规范 / 工作流扫描，结果汇总为 **`CI 总览`** |
| `.github/workflows/labeler.yml` | PR 打开或更新 | 按改动路径自动打标签 |
| `.github/workflows/welcome.yml` | 首次开 Issue / PR | 自动发表欢迎语与上手提示 |
| `.github/workflows/stale.yml` | 每天定时 + 手动 | 60 天无响应标 `stale`，再 14 天自动关闭 |
| `.github/workflows/release.yml` | 推送 `v*.*.*` tag | 生成三段式发布说明，附上构建产物 |
| `.github/workflows/build-installers.yml` | 手动 + tag | Windows / macOS 安装包构建（**不进门禁**） |
| `.github/workflows/scorecard.yml` | 每周 + main 推送 | OSSF Scorecard 供应链评分，结果进 code scanning |
| `.github/workflows/dependency-review.yml` | PR | 引入有漏洞的依赖时拦截 |
| `.github/workflows/ai-review.yml` | PR | **opt-in** 的 AI 代码审查（配了 `ANTHROPIC_API_KEY` 才跑） |
| `.github/dependabot.yml` | 每周一 | 为 Actions 与根目录的 npm 依赖提更新 PR |

### 如果自动化行为不符合预期

| 现象 | 改哪里 |
| --- | --- |
| 打标签不对 | `.github/labeler.yml` 的路径规则 |
| stale 误伤 | `.github/workflows/stale.yml`，把标签加进 `exempt-issue-labels` |
| CI 卡住不让合并 | 先确认是不是真有问题；确认无误时可以临时在分支保护里放宽，**但请尽快改回来** |
| Dependabot 噪音太大 | `.github/dependabot.yml` 的 `open-pull-requests-limit` 或分组规则 |
| Dependabot 对着 `resources/**` 开 PR | **这是已知的边界**，见下 |

#### Dependabot 与 `resources/**`

`resources/` 下是随包分发的第三方插件模板，它们自带 `package.json` / `package-lock.json` /
`yarn.lock`。本项目对它们的约定是**原样分发**，不代其升级依赖。

`.github/dependabot.yml` 已把范围显式限定在仓库根，但**「自动安全修复」功能走的是
依赖图而不是这份配置**，实测曾对着那些模板连开 6 个 PR（#9–#14），只能关闭。
若再次出现，处置方式是**关闭并引用本段说明**，而不是逐个合并 ——
合并会让本项目的副本与上游不一致，且没有任何测试能覆盖那些模板。

那些模板的依赖告警，正确的去向是登记在 `THIRD_PARTY_NOTICES.md`。

### 维护流程已沉淀为 Skill

维护知识沉淀为两个项目级 skill（`.claude/skills/`），**随仓库分发，克隆即生效**：

| Skill | 适用场景 | 内容 |
| --- | --- | --- |
| `oss-bootstrap` | **新项目**从零落实开源规范 | 六阶段：CI 与提交规范 → 治理文件 → 仓库自动化 → 文档体系 → 仓库设置 → 首个发布 |
| `maintain-loop` | **本项目**的日常迭代闭环 | 盘点 → 规划 → 实现 → CI 与合并 → 发布 → 继续规划，附运行期的硬规则 |

两者的关系：前者「从 0 到 1 搭基建」，后者「基建就位后按流程跑」。
本仓库自身就是 `oss-bootstrap` 的参考实现。

在装了 Claude Code 的环境里，说「新建开源项目 / 给项目补 CI 与规范」会走 `oss-bootstrap`；
说「继续迭代 / 按维护流程走 / 发布新版本」会走 `maintain-loop`。
人工维护者也可以把它们当**流程速查表**读 —— 本手册讲「每件事的细节」，skill 讲「整件事的顺序」。

> **修改维护流程时两边都要改**：先改本手册（细节的事实来源），再同步对应 skill（流程的执行入口）。

---

## 测试分层

这个项目的测试不是「覆盖率指标」，每一层回答一个具体问题。
改代码前先知道哪一层守着你要动的东西。

```bash
npm run test      # ① 单元测试
npm run test:gui  # ②–⑬ 端到端（不依赖真实模型）
npm run test:e2e  # ②–㉒ 全部端到端（⑯ 起需要本机有可用模型端点）
```

### ②–⑬ 与 ⑯–㉒：端到端各层

| 层 | 命令 | 回答的问题 |
| --- | --- | --- |
| ② 启动健康度 | `test:gui:smoke` | 应用能不能起来、daemon 活没活、**样式加载没有** |
| ③ 分区域 | `test:gui:sections` | 顶层七个功能区能不能渲染出来 |
| ④ 设置页分组 | `test:gui:settings` | 设置对话框里**九个分组逐个点开，面板有没有内容** |
| ⑤ IPC 功能性 | `test:gui:ipc` | 每个具体功能能不能用 |
| ⑥ 桥接面补测 | `test:gui:bridge` | 那些没人调过的通道，调一下答什么 |
| ⑦ 本地状态读写 | `test:gui:state` | 设置项写进去读得回来吗、任务 CRUD 真的落盘了吗 |
| ⑧ 对话框/降级 | `test:gui:dialog` | 用户取消对话框会怎样、缺原生模块会不会崩 |
| ⑨ 可视化渲染 | `test:gui:widget` | 卡片到底画出来没有 |
| ⑩ 产物交付 | `test:gui:artifact` | 成果文件交付后，界面上有没有那张卡 |
| ⑪ 子代理委派 | `test:gui:subagent` | 委派是真的起了隔离子会话、并且把结果并回来了吗 |
| ⑫ Agent 团队 | `test:gui:team` | 建团 → 成员独立会话 → 产出回收，是真的吗 |
| ⑬ 文件预览 | `test:gui:preview` | xlsx / pptx / js / json 渲染 + 样式生效 |
| ⑭ 主链路 | `test:gui:model` | **在界面上打字发送**，模型真的回话了吗、回复真的画出来了吗 |
| ⑮ Agent 循环 | `test:gui:loop` | 模型要求执行工具时，Agent 真的执行并回传了没有 |
| ⑯ 真实端点 | `test:gui:real` | 协议对接对不对（鉴权头、流式事件类型、token 计数） |
| ⑰ 文档解析 | `test:gui:doc` | PDF / DOCX 提取链路通了没有 |
| ⑱ docx/运行时 | `test:gui:docx` | 格式转换往返对不对、运行时跨平台装得上装不上 |
| ⑲ 技能/MCP | `test:gui:skill` | 技能正文注没注入、MCP 工具调不调得动、有没有被静默放行 |
| ⑳ 命令执行 | `test:gui:cmd` | 命令真的跑起来了吗、缺沙箱时会不会静默无约束执行 |
| ㉑ 定时任务 | `test:gui:auto` | 到点真的把任务跑起来了吗、运行记录落盘没有 |
| ㉒ 会话分支 | `test:gui:branch` | 真能从历史中间分叉出新会话吗、母会话会不会被改坏 |

单元测试（`npm run test`）当前 **104 项**，覆盖 IPC 契约、权限判定规则、
定时任务的时间计算、自有 agent 工具与 daemon 模块依赖图。

> **断言总数以测试运行器的实际输出为准**（`npm run test` 会打印）。
> 不要在文档里写一个没人能复算的数字 —— 这个仓库曾经有过一个对不上的统计口径。

### 几层为什么不可替代

- **⑤ IPC 功能性最难被替代**：通道名拼错、daemon 侧 handler 未注册、返回结构变了，
  **界面可能照常渲染**（数据区空白或停在加载态），只有真正调用才会暴露
- **⑭ 主链路**补上了此前唯一的空白 —— 常规做法下它需要真实 API Key。
  应用支持自定义 provider（`baseUrl` 可配），所以在本地起一个 OpenAI 兼容的 mock
  服务即可把整条链路串起来
- **⑯ 真实端点**：mock 只能证明管道不漏，证明不了**协议对接正确**。
  它的断言里会埋一个唯一标记要求模型原样回复，并校验回复携带**真实 token 用量** ——
  后者是「确实调用了真实模型」的硬证据

### 写测试时的三条硬要求

1. **断言不要匹配状态词本身**。「汇总：成功 3 ｜ 失败 0」这类输出里，状态词永远都在里面 ——
   `grep -q '失败'` 等于断言恒真。要匹配带上下文的正文行，或断言具体数值
2. **「调用了不报错」证明不了任何事**。通道名拼对但 handler 是空函数，照样不报错。
   设置类断言一律「读当前值 → 写新值 → 读回来断言变了 → 还原 → 断言变回去」
3. **测试必须隔离环境**。所有端到端测试显式设置 `ZEROWORK_CONFIG_DIR` 与
   `ZEROWORK_WORKSPACE_DIR`，避免污染用户的真实环境。
   ⚠️ **只设 `CONFIG_DIR` 是不够的** —— 工作区根目录会落在真实家目录下

### 测试里记录的产品语义（与直觉相反，但都是刻意的）

| 行为 | 直觉 | 实际 |
| --- | --- | --- |
| 清空审计日志 | 清空后 0 条 | 剩 **1 条** `audit/cleared` —— 「擦除审计日志」本身必须留痕 |
| 移除工作区 | 删掉磁盘目录 | **不删**目录（那是用户真实文件），只把该空间的会话移进回收站 |
| 查询不存在的路径 | 抛错 | 返回 `{ kind: "missing" }` —— 调用方要靠它决定「先读还是先建」 |

---

## 日常维护

### 每周（约 10 分钟）

- [ ] 扫一眼 Issues，给新 Issue 加标签、回复，或标记 `good first issue`
- [ ] 扫一眼 Pull Requests，看 `CI 总览` 是否绿
- [ ] 处理 Dependabot 的更新 PR（通常点一下合并即可；生产依赖的主版本更新要跑测试）
- [ ] 看一眼 **Scorecard 评分**有没有掉（掉了通常意味着供应链基线被改回去了）

### 每月（约 30 分钟）

- [ ] 检查 Actions 用量，避免账单意外
- [ ] 翻一下 Actions 的历史运行，看有没有反复失败的工作流
- [ ] 跑一次 `npm audit --registry=https://registry.npmjs.org/`，看运行时依赖有没有新增告警
- [ ] 看 `CHANGELOG.md` 的 `[Unreleased]` 是否积压了不少内容，考虑发一个版本
      （**积压即说明「发布」这一步欠着，优先补上**）

### 每季度

- [ ] 复审 `SECURITY.md` 的威胁模型是否还成立（尤其是新的出站请求与新的解析库）
- [ ] 检查工作流里 pin 的 Actions 版本，考虑升大版本
- [ ] 回顾一下「不做」清单，确认项目没有偏离定位
- [ ] 复核 `THIRD_PARTY_NOTICES.md` 里随包第三方内容的授权状态

---

## 处理 Issue

### 收到新 Issue

1. **先判断类型**：Bug / 功能请求 / 文档问题 / 使用提问
2. **使用提问** → 引导到 Discussions，并礼貌关闭（附上讨论链接，不要粗暴关）
3. **Bug** → 确认能否复现，加 `bug`；能定位的补一句「从哪个文件入手」
4. **功能请求** → 对照[项目边界](#项目定位与边界)，能做的加 `enhancement`，
   明确不做的**说明理由后关闭**
5. **适合新手** → 加 `good first issue`，并在正文补充入手位置

### 回复的几个原则

- **先说结论**：能修 / 不能修 / 需要更多信息
- **给替代方案**：不能按他说的做，就告诉他可以怎么做
- **不要秒回后消失**：要说「我看看」，就说清楚大概什么时候看
- **明确拒绝**：做不到就直说，含糊其辞比拒绝更消耗人

---

## 审查 PR

### 审查清单

按这个顺序看：

1. **CI 是否通过** —— 没通过先看为什么，别急着看代码
2. **改动是否符合项目定位**
3. **描述里的「为什么」** —— 只说「改了什么」的要追问动机
4. **有没有触碰[红线](#项目红线)**
5. **有没有同步更新文档** —— 改行为不改文档，要打回
6. **有没有更新 CHANGELOG** —— 用户可见的行为变化必须有记录
7. **有没有在 `resources/**` 上跑本项目的 lint / formatter** —— 那是第三方内容

### 合并

使用 **squash merge**，保持 `main` 历史线性：

```bash
gh pr merge <N> --squash --delete-branch
```

合并前确认 squash 后的标题仍符合约定式提交（默认取 PR 标题，而标题已被 CI 校验过）。

**合并后核对 Issue 是否真的关闭了。** 症状是「PR 合并了、Issue 还开着」，
根因通常是 PR 正文里的 `Closes #N` 没写进去（创建 PR 时用 `--body-file <文件>`，
不要用嵌套 heredoc —— `-` 拿到的 stdin 会是空的，**正文会静默丢失**）。

---

## 发布新版本

### 什么时候发

- 有新的用户可见功能
- 有重要的 Bug 修复
- 积累了一批小改动

不需要为每个提交发版。

### 版本号规则

遵循[语义化版本](https://semver.org/lang/zh-CN/)：

| 改动类型 | 版本变化 | 例子 |
| --- | --- | --- |
| 破坏性变更 | major | 移除某个设置项、权限档语义变化 |
| 新增功能 | minor | 支持新的文档格式 |
| Bug 修复 | patch | 修复预览导致界面崩溃 |

对使用者而言，本项目的「破坏性变更」主要指：**配置目录结构变化、权限档语义变化、
随包资源路径变化**。

> `CHANGELOG.md` 里 `0.1.4-restore.N` / `0.1.4-zerowork.N` 是**开源前的内部迭代记录**，
> 编号体系与之后的语义化版本不同。公开发布自 `0.2.0` 起。

### 怎么发

```bash
# 1. 从最新 main 切发布分支
git switch main && git pull
git switch -c chore/release-v0.2.0

# 2. 编辑 CHANGELOG.md：把 [Unreleased] 的内容归入新版本段，并保留一个空的 [Unreleased]
#    同时把 package.json 的 version 改成同一个版本号

# 3. 发布前自查（tag / CHANGELOG / package.json 三者必须一致）
npm run check:release-version -- v0.2.0

# 4. 提交、推分支、建 PR、走完整 CI、squash 合并
git commit -m "chore(release): 发布 v0.2.0"

# 5. 确认远端还没有这个 tag（见下方「发布幂等」），再打标签推送
git ls-remote --tags origin v0.2.0
git tag -a v0.2.0 -m "v0.2.0"
git push origin v0.2.0
```

推送 tag 后 `release.yml` 会自动生成三段式发布说明并附上安装包：

1. **发布摘要**（配了 `ANTHROPIC_API_KEY` 才有；没有则跳过，不影响发布）
2. **本版本的变更内容**（从 `CHANGELOG.md` 对应段落提取）
3. **变更清单**（GitHub 原生 `releases/generate-notes`：PR 列表、贡献者、对比链接）

### 发布幂等

网络抖动时 `git push` 可能「显示失败、远端已成功」，重试就是第二次推同一个 tag →
触发两次发布工作流。工作流已做「先查后建」（已存在时改走 `gh release edit`），
但**推送 tag 前先用 `git ls-remote --tags origin v0.2.0` 确认它不存在**，
避免制造无意义的失败运行。

### 判断成败禁止管道接 `tail` / `head`

```bash
# ❌ 判断的是 tail 的退出码 —— 命令没成功也报成功
if gh pr merge N --squash | tail -1; then ...

# ✅ 先取输出，判断放在后面
if out="$(gh pr merge N --squash 2>&1)"; then ...
```

这条是真实事故：一次合并没发生却报成功，tag 于是打在错误的提交上、
release 用了错误的内容生成；重推时又把一次真实的 SSL 失败误读为成功，
release 空窗近一小时才发现。

**merge / push 之后必须复核远端真实状态**：`gh pr view N --json state`、
`git ls-remote --tags origin vX.Y.Z`。

### tag 打错了怎么修

顺序不能乱：

```bash
git push origin :refs/tags/vX.Y.Z      # 1. 删远端 tag
gh release delete vX.Y.Z               # 2. 删错误的 release
git switch main && git log --oneline -3 # 3. 确认 main 含归档提交
git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z   # 4. 重推
gh release view vX.Y.Z                 # 5. 验证正文开头是本轮主题句
```

---

## 应急处理

### 怀疑凭据泄露

**这是本项目的最高优先级事件**（应用会存模型 API Key 与 MCP 配置里的环境变量）。

1. **立即轮换密钥** —— 到对应供应商控制台吊销并重新签发
2. **排查影响范围**
   - 检查 Actions 运行历史，看有没有非你触发的运行
   - 检查是否有可疑的 PR 改动了 `.github/workflows/`
   - 检查是否有异常的 Issue / Discussion 内容包含配置片段
3. **排查泄露途径**
   - 是否在日志、截图、Issue 里贴出过密钥
   - **`resources/**` 的第三方内容里是否混入了真实密钥**（那些文件来自外部，
     值得单独扫一遍）
4. **记录**事故经过，避免重蹈覆辙

### CI 突然全红

1. 先看是不是 `CI 总览` 汇总失败但各子任务通过 —— 那是汇总逻辑的问题
2. 看具体哪个 job 红，以及在哪个平台红
3. **本地是绿的而 CI 是红的**时，按分歧源逐项排查，不要先猜版本：
   - **工具版本**。actionlint 与 yamllint 的版本固定在 `ci.yml` 的 `env` 里；
     本地可能更新。`node scripts/lint.mjs` 在版本不一致时会**单独提示**
   - **平台差异**。只有三平台矩阵能发现 —— 历史上一处路径拼接问题只在 Windows 上暴露
   - **依赖安装**。CI 用 `npm ci`（严格按锁文件）；本地若是 `npm install`，
     可能会顺带升级某些包
4. 如果所有 PR 都红，可能是 GitHub 改了运行器镜像，检查运行日志里的环境信息

### 工作流执行失败但本地怎么都复现不了

先看 `zizmor` 有没有报新的 findings —— 它抓的是**工作流本身**的问题
（权限过宽、表达式注入、`uses:` 没 pin），这些在本地跑业务代码是复现不出来的。

### 发布流水线起不来（`startup_failure`）

**症状**：推了 tag，但 `gh run list --workflow=release.yml` 显示
`completed/startup_failure`，而且 `gh run view <id>` **一个 job 都没有**。

**这类错误的日志根本不存在** —— `gh run view --log` 会说「log not found」。
错误在 **workflow run 的页面上以注解形式**显示，用 API 拿不到
（`startup_failure` 不产生 check run）。所以只能打开那个 run 的网页看。

本项目真实踩过一次，注解原文：

```
Invalid workflow file: .github/workflows/release.yml#L307
The workflow is not valid.
The job is requesting 'attestations: write, id-token: write',
but is only allowed 'attestations: none, id-token: none'
```

**根因**：`release.yml` 里 `installers` 这个 job 用 `uses:` 调用
`build-installers.yml`，而它只声明了 `permissions: contents: read`。
**调用方的 `permissions` 是「被调工作流的上限」** —— 不是「只声明我自己要用的」。
被调的 workflow 里有 job 要 `id-token: write` + `attestations: write`
（生成构建溯源证明），上限不够就整个工作流校验失败。

修法是给调用方补上那两项：

```yaml
  installers:
    uses: ./.github/workflows/build-installers.yml
    permissions:
      contents: read
      id-token: write
      attestations: write
```

**为什么它藏了这么久**：这个缺陷是「加溯源证明」那次改动引入的，
而它**只在 tag 触发、且走到那条 `uses:` 调用路径时**才暴露 —— 那之后没有发布过，
所以直到下一次发版才第一次跑到。**每次动 release.yml 之后，最可靠的验证仍然是
真的打一个 tag 走一遍**（或至少用一个临时 tag 试）。

**排查时我误判过两次**，教训值得记下来：

1. 先怀疑是 `uses:` 用了 `$/`（自仓库引用语法），改成 `./` —— 问题依旧。
   我当时是靠「同一 commit 上其他工作流都跑得通」做排除法的，
   但**那个推理有漏洞**：其他工作流都不调用可复用工作流，
   所以「差别只在那一行」这个结论并不成立。排除法要能覆盖所有差异，否则只是猜
2. 两轮之后才想到**去看 run 页面上的注解** —— 而答案一直写在那里

**结论：症状里已经给了线索（0 个 job = 启动阶段就被拒 = 工作流校验失败），
就该直接去找校验错误，而不是从「最近改了什么」开始猜。**

### 发布出问题

| 症状 | 处理 |
| --- | --- |
| Release 正文只有 PR 清单、没有 CHANGELOG 段 | tag 对应的版本段在 `CHANGELOG.md` 里不存在。用 `npm run check:release-version -- <tag>` 确认，补上段落或重发 |
| 安装包没附上 | 看 `build-installers.yml` 的运行结果；单个平台失败不影响其余平台 |
| 想撤掉一个已发布的 Release | 先 `gh release delete <tag>`，再决定要不要删 tag。**已推送的 tag 删起来会留下痕迹**，非必要不删 |

### HTTPS 对 github.com 不通

先试 SSH，再考虑重试。曾有整晚 443 端口间歇性超时，而 SSH 一直通。
用临时 remote 兜底，**不要动使用者已有的 `origin` 配置**：

```bash
git remote add ssh-origin git@github.com:<owner>/<repo>.git
# ...用完删掉
git remote remove ssh-origin
```

### 网络抖动是常态

`gh` / `git push` 失败就重试：

```bash
for i in 1 2 3 4 5; do
  if out="$(<命令> 2>&1)"; then echo "$out" | tail -1; break; fi
  echo "第 ${i} 次失败，重试..."; sleep 5
done
```

**注意非幂等操作的重复执行风险** —— 推 tag 就是典型（见「发布幂等」）。

### `gh` 只认 `origin`

分支推在别的 remote 上时，`gh pr create` 会报
`you must first push the current branch to a remote` —— **这不是网络问题，重试多少次都不会好**。
加 `--head <owner>:<branch>` 一次就过。

---

## 项目红线

以下几条**任何时候不得违反**，除非完全清楚后果并在 PR 里写明理由。

### 1. 不要把 `${{ }}` 表达式直接写进 `run:`

```yaml
# ❌ 危险：PR 标题是攻击者可控字符串，直接拼进 Shell
run: node scripts/check-commit-msg.mjs --message "${{ github.event.pull_request.title }}"

# ✅ 正确：先落到 env，再用带引号的变量引用
env:
  PR_TITLE: ${{ github.event.pull_request.title }}
run: node scripts/check-commit-msg.mjs --message "$PR_TITLE"
```

PR 标题、Issue 正文、分支名都是**任何人都能构造的字符串**。
直接插进 `run:` 就是标准的表达式注入（pwn request）。

### 2. 不要降低 `pull_request_target` 的安全性

`labeler.yml` 与 `welcome.yml` 用了 `pull_request_target`，因为它需要在 fork 来的 PR 上写标签 / 发评论。

**它们当前安全的前提是：不 checkout PR 代码、不执行 PR 内容。**

如果有人往这两个工作流里加 `actions/checkout` 并把 `ref` 指向 PR 分支，
就等于把仓库写权限交给任何提 PR 的人。**这种改动必须拒绝。**
豁免理由写在 `.github/zizmor.yml`，改动那两个工作流时要同步复核豁免是否还成立。

### 3. 不要在日志里输出 Secret

GitHub 会对已知的 Secret 做脱敏，但**不要依赖这个机制** ——
经过编码、截断、拼接后的值不会被识别。

### 4. 不要放宽权限默认值或沙箱约束

`workspace-write` 是默认档有它的理由；`danger-full-access` 意味着命令**不经任何约束**
直接跑在用户机器上。要让受限档「看起来能用」而放松约束，是**用安全性换演示效果**。

放宽默认值属于安全敏感变更，PR 里必须说明**理由与影响面**，
并在 `SECURITY.md` 的威胁模型里同步更新。

### 5. 不要把凭证、内网地址写进代码

仓库是公开的。任何硬编码的地址都会被索引，任何硬编码的凭证都会立刻泄露。
**`resources/**` 的第三方内容也要扫** —— 那不是我们写的，但发布的是我们。

### 6. 不要在 `resources/**` 上应用本项目的工具链

它有自己的风格与运行环境（`eslint.config.mjs` / `vitest.config.mjs` / `.prettierignore`
三处都做了整目录排除）。为了「统一风格」把排除去掉，会产生数千条无意义报错，
并让真实改动淹没在噪音里。

### 7. 发布前必须确认第三方再分发授权

随包第三方内容的授权状态见 `THIRD_PARTY_NOTICES.md`。
其中被标为「不改就不能发布」的条目**确认之前不得对外声称可自由使用**。
这不是技术判断，是权利人的决定。

---

## 附：常用命令速查

```bash
# 本地全量检查（提交前必做）
npm run lint:all

# 校验一条提交信息
npm run check:commit-msg -- --message "feat(daemon): xxx"

# 校验发布版本号一致性
npm run check:release-version -- v0.2.0

# 渲染层产物契约（需先构建）
npm run build && npm run check:renderer-assets

# 依赖安全（本机 registry 是镜像时必须显式指定官方源）
npm audit --registry=https://registry.npmjs.org/

# 查看最近的 Actions 运行
gh run list -L 10

# 查看某次运行的日志（输出混着源码行时，过滤 ANSI 回显再看）
gh run view <run-id> --log

# 重新运行失败的 job
gh run rerun <run-id> --failed

# PR 门禁状态
gh pr checks <N>

# 合并（squash）
gh pr merge <N> --squash --delete-branch

# 确认远端还没有某个 tag（推 tag 之前必做）
git ls-remote --tags origin v0.2.0
```
