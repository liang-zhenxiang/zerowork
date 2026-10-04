# 维护者手册

这份文档写给项目的维护者。

它回答两个问题：**这个项目平时需要做什么**，以及**出事了怎么办**。

> 📌 **规则的速查版在仓库根目录的 [`AGENTS.md`](../AGENTS.md)** ——
> 那份文件由 AI 工具在每个会话自动加载。**改维护流程时两处都要改**：
> 本文档是细节的事实来源，`AGENTS.md` 是执行入口的速查版。

## 目录

- [维护者](#维护者)
- [项目定位与边界](#项目定位与边界)
- [仓库配置清单](#仓库配置清单)
- [自动化设施一览](#自动化设施一览)
- [测试分层](#测试分层)
- [随包依赖的取舍](#随包依赖的取舍)
- [安装包签名：为什么没有，以及为什么先不申请](#安装包签名为什么没有以及为什么先不申请)
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

清单上的仓库级设置**已全部就位**：

| 项 | 状态 |
| --- | --- |
| Issues / Discussions | 已开启；Wiki 已关 |
| Projects（[ZeroWork 路线图](https://github.com/users/liang-zhenxiang/projects/1)） | 已建并链接到本仓库 |
| 允许自动合并 / 合并后自动删分支 | 已开启 |
| Private vulnerability reporting | 已开启 |
| Secret scanning + Push protection | 已开启 |
| Dependabot 告警 + 安全更新 | 已开启 |
| topics / 标签体系 | 已配好，标签与 `.github/labeler.yml` 一致 |
| **分支保护 `main`** | **已配置**，内容与上一节一致：只要求 `CI 总览`、要求解决所有对话、禁止强推与删除、approvals 为 0 |

仓库许可证已被 GitHub 识别为 **Apache-2.0**。

> ⚠️ **核对分支保护时的一个坑**：这个接口要求 **admin** 权限，而**非管理员**访问
> `GET /repos/{owner}/{repo}/branches/main/protection` 会拿到 **404** ——
> 配好的分支保护**同样返回 404**。所以「404 = 未配置」这个推断不成立，
> 用协作者账号核对时会得到相反的错误结论。
>
> 换用这些不依赖 admin 的手段：尝试直接推 `main`（会被 protected branch 拒绝）、
> 合并一个 PR 后看远端分支是否自动消失（即 `delete_branch_on_merge`）、
> 或看 PR 的 `mergeStateStatus` 是否因必需的 check 未完成而变成 `BLOCKED`。

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

## 随包依赖的取舍

### 出过什么事

v0.3.0 发布后用户反馈「安装要很久、打开要很久、电脑很卡」。实测（mac-arm64，
`npm run dist:dir`）：

| | v0.3.0 | 现在 |
| --- | --- | --- |
| `ZeroWork.app` | **948 MB** | 583 MB |
| `Resources/app/node_modules` | **554 MB** | 189 MB |
| 随包文件数 | **22016** | 15098 |

根因是一行**看起来最正常**的配置：

```js
main: { plugins: [externalizeDepsPlugin()] }   // 无参数
```

无参数的 `externalizeDepsPlugin()` 把 `package.json` 的**全部** `dependencies` 外置。
这些包于是不进 `out/`，而由 electron-builder **原样装进安装包**。问题在于其中大半是
**渲染层专用**的（`monaco-editor`、`react-pdf`、`echarts`…）—— 渲染层早已被 Vite
打包进 `out/renderer`，而 sandbox 渲染进程**根本 `require` 不到 node_modules**。
这些随包纯属重复。

### 认哪条线

> **`dependencies` = 主进程运行时真的会 `import` 的包。渲染层专用的进 `devDependencies`。**

渲染层不需要 node_modules，原因值得记牢：`src/renderer/src/*.js` 是**预打包的
vendored bundle**（`vendor-xlsx.js`、`office-pptx.js`、`code-preview.js`…），
里面**没有任何裸 import**，Vite 只是把它们原样搬运成同名产物。所以渲染层依赖放在
哪个分区**对构建没有影响** —— 放进 `devDependencies` 只是让 electron-builder 不装它。

> ⚠️ **核实「谁用到了某个包」时，不要 grep `src/renderer/src/` 的 import。**
> 那些是打包产物，import 早被内联掉了，grep 不到任何东西 ——
> 「grep 渲染层发现没人用它，于是删掉」正是这类事故的成因。
> 要以 `src/main`、`src/preload`、`src/shared` 为准（**含 `await import()`**，
> 主进程有好几个包是懒加载的，只 grep 静态 import 会漏）。

主进程当前需要这 11 个（硬编码在 `scripts/check-package-size.mjs`）：

```
@earendil-works/pi-coding-agent  @modelcontextprotocol/sdk  @mozilla/readability
jsonc-parser  jszip  koffi  linkedom  officeparser  pdfjs-dist  turndown  typebox
```

### 有意不带的东西

`electron-builder.yml` 的 `files` 段里有五条排除规则（四类）。
**每一条都对应一个判断，不是「看着大就删」** —— 改之前请先读那一节的注释：

| 排除 | 省 | 判断 |
| --- | --- | --- |
| `tesseract.js` / `tesseract.js-core` | ~50 MB | 只在 OCR 时加载；**本项目不做 OCR**（Roadmap 的「不做」清单），`doc-extract.js` 对无文本层的 PDF 直接抛 `scanned`。officeparser 侧是懒加载，且 `defaults.js` 的 `ocr: false` 是默认值，我们调用时也没传选项 |
| `@napi-rs/canvas` | ~27 MB | `pdfjs-dist` 的**可选**依赖，Node 端 canvas 渲染用；我们只调 `getTextContent()`。pdfjs 自己对它的加载就是 try/catch + warn |
| `officeparser` 的浏览器构建 | ~30 MB | 挂在 `exports` 的 `browser` 条件下；Node 入口只 `require` 同目录的五个 `.js`，全包内无一处引用那些文件名 |
| `pdfjs-dist/build/`（非 legacy） | ~7 MB | 我们只 import `legacy/build/pdf.mjs` 与 `pdf.worker.mjs`；legacy 产物内部无相对 import |

**代价要写清楚**：万一将来有人开启 OCR，报错会是 `Cannot find module 'tesseract.js'`
—— 这是**响亮的失败**，不是静默降级（符合本项目「宁可拒绝也不降级」的原则）。
真要恢复 OCR，请连同 Roadmap 的「不做」条目一起改。

### 为什么没做到 Issue 里写的 400 MB

那个目标**不成立**。实测的地板是：

```
Contents/Frameworks           288 MB   Electron 本体，不可压缩
Contents/Resources/resources   79 MB   随包内容资源（红线：不动 resources/）
Contents/Resources/app/out     27 MB   渲染层产物
                              394 MB   ← 不含任何 node_modules 的地板
```

再叠加主进程**必须**随包的 `@earendil-works/pi-coding-agent`
（含其 provider SDK 依赖树，合计约 100 MB）与 `koffi`，583 MB 已接近可达的底部。
要继续降只能砍掉应用声明要用的运行时依赖（模型 SDK、esbuild…），
那是**砍功能**，不是优化 —— 不在这条路线上。

同样的理由，文件数「降到 5000 以内」也做不到：光 `@earendil-works` 一棵树就 4920 个文件，
加 `openai` / `@anthropic-ai` / `zod` / `@smithy` / `@aws-sdk` 已远超 5000。
**这两个数字都是 Issue 里估的，不是量出来的** —— 以上是量出来的。

### 评估过、但**没有做**的：把主进程纯 JS 依赖打进 `out/main`

`externalizeDepsPlugin({ exclude: [...] })` 可以让 Vite 把这些包**打进** `out/main`，
而不是原样随包。实测（2026-10-01，把 `officeparser`、`typebox`、`linkedom`、`jszip`、
`turndown`、`jsonc-parser`、`@mozilla/readability`、`@modelcontextprotocol/sdk`
八个加进 exclude）：

| | 现状（`du -sh` 口径） | 改后（实测） |
| --- | --- | --- |
| `out/main` | 916 KB | **4.5 MB**（+3.6 MB） |
| 被移出随包的八个包 | 34.6 MB（35380 KB 逐包求和） | 0 |
| 随包文件数 | 15098 | −2405（八个包分别 474/1408/180/260/48/9/15/11） |

净收益 **约 31 MB / 2405 个文件**（整包 583 → 约 552 MB，**−5%**）。
功能上是通的：改完 `test:gui:smoke` 22/22、`test:gui:doc` 5/5
（真实模型跑通 PDF 与 DOCX 提取）。

**结论：不实施。** 三个理由：

1. **收益量级不对**。−5% 不会改变用户抱怨的「安装久、打开久」——
   同一个 Issue 里的 400 MB 目标本身就不可达（见上一节），
   再挤 5% 是把复杂度花在看不见的地方
2. **代价正是本项目刻意买过的**。`minify: false` 的初衷就是
   「保留原始标识符便于线上定位」。打包后这些包在堆栈里只剩
   `index-BbXimslP.mjs` 这种名字 —— 换走的是维护者定位问题的时间，
   换回来的是 5% 的体积
3. **它带一条脆弱的特例**。officeparser 内部有 `await import("tesseract.js")`，
   而 `tesseract.js` **不在** `dependencies` 里（它是传递依赖），
   `externalizeDepsPlugin` 的默认外置集合**不含它** —— 一旦 officeparser 被打包，
   rollup 就会顺着这条懒 import 去打包 50 MB 的 tesseract。
   必须额外写一行 `external: ['tesseract.js']` 才拦得住。
   这类「改别处会静默踩到」的耦合，在这个仓库里的历史都不太好

> ⚠️ **`pdfjs-dist` 无论怎么打包都省不掉** —— 这一条纠正了 Issue 里的估算：
> `doc-extract.js` 用 `createRequire(import.meta.url).resolve("pdfjs-dist/package.json")`
> 定位 `cmaps` / `standard_fonts`，**这要求该包在运行时的 node_modules 里真实存在**。
> 打进 bundle 会让 `getPdfAssetUrls()` 直接抛错、PDF 读取整体失效。
> 同理 `@earendil-works/pi-coding-agent` 与 `koffi` 带原生 `.node`，必须随包。
> 所以 R4 实际能省的上界是 **约 35 MB，不是 Issue 里估的 76 MB**。

### 守卫

`scripts/check-package-size.mjs`（`npm run check:package-size`）断言四件事：

1. 渲染层专用依赖**不得**出现在随包 node_modules 里（按名单，**含传递依赖** ——
   `echarts`/`zrender` 随 `pptx-preview` 走、`codepage` 随 `xlsx` 走，只查直接依赖会漏）
2. 有意排除的包不得出现
3. 主进程需要的 11 个包**必须都在**（硬编码，不从 package.json 推导 ——
   推导的话「把 koffi 挪进 devDependencies」会让名单跟着缩水，检查就自己把自己放过去了）
4. 体积与文件数不超上限

它接在两个地方：

- `npm run lint:all` —— 本地；没有 `release/` 时**明确跳过**并写明「本次没有验证任何东西」
- `.github/workflows/build-installers.yml` 的两个 job —— **这里才是关键**：
  CI 的 `lint:all` 没有 `release/`，会被跳过，而这件事只有打包之后才验得了

> **上调 `LIMITS` 要在 PR 里写明理由。** 这条检查的全部价值就在于它不会自己放宽 ——
> 真要让某个包随包，应当改 `MAIN_PROCESS_REQUIRED`，而不是改上限。

---

## 安装包签名：为什么没有，以及为什么先不申请

安装包**既不签名也不公证**（`electron-builder.yml` 的 `mac.identity: null`、
CI 里的 `CSC_IDENTITY_AUTO_DISCOVERY: "false"`）。代价是用户第一次打开会被系统拦下，
所以**三处必须写明怎么打开** —— 这不是可选的礼貌，是打包决策的一部分。

### 三处指引的落点

| 位置 | 为什么是这里 |
| --- | --- |
| `release.yml` 组装发布说明的**最前面** | **最重要的一处**。用户是从 Release 页下载的，装完打不开时回到的也是这个页面；他要的答案只有一个 ——「为什么打不开、我该怎么办」 |
| `README.md` / `README.en.md` 的「用安装包」 | 从仓库首页进来的人 |
| `docs/USAGE.md` 的开头 | 从文档进来的人 |

**顺序是契约，不是排版偏好**：指引必须在 PR 清单**之前**。
v0.3.0 及以前它被放在发布说明**最末尾**，结果用户没翻到，直接来问
「有一个装完打不开，是正常的吗？」。

守卫是 `scripts/check-release-notes.mjs`（`npm run lint:all` 与 CI 的静态检查都跑）。
它**按能力断言，不按措辞断言**：改文案不会让它变红，删掉任一能力（未签名说明 /
「这是正常的」/ macOS 的打开方式 / Windows 的打开方式）才会。

### `codesign` 报 `Identifier=Electron`？那不影响任何事

`Info.plist` 里的 `CFBundleIdentifier` 是 `io.github.liang-zhenxiang.zerowork`，
但 `codesign -dv` 报 `Identifier=Electron`。**本条实测过，结论是「不修」**：

- **来源**：它来自上游 Electron 预编译二进制自带的 linker-signed adhoc 签名。
  实测 `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron` 与打包后的
  `ZeroWork`，两者的 CodeDirectory 逐字节相同（`size=392 flags=0x20002(adhoc,linker-signed)`）。
  `identity: null` 意味着 electron-builder **全程不做签名**，于是改名（`Electron` → `ZeroWork`）
  与重写 `Info.plist` 都不会碰到它，所以还多了个 `Info.plist=not bound`。
  上游 Electron 自己也是 `CFBundleIdentifier=com.github.Electron` 配 `Identifier=Electron`，
  即这个错位不是本仓库引入的。
- **能不能修**：能。实测 `codesign --force --sign - --identifier io.github.liang-zhenxiang.zerowork`
  之后 `Identifier` 就对了（并且补上了 `Info.plist entries=32`、
  `Sealed Resources version=2 rules=13 files=16812`）。
- **为什么仍然不修**：**Gatekeeper 的判据是「有没有 Developer ID 证书链 + 有没有公证票据」，
  `Identifier` 字符串不参与。** 实测改完后 `spctl --assess` 依然拒绝，
  用户看到的现象一模一样。而 ad-hoc 签名**无论标识对不对都没有稳定的
  Designated Requirement**（DR 就是 cdhash，每次构建都变），
  所以 TCC 授权也不会因此跨版本保留。
  换言之：成本是给构建加一个 `afterPack` 重签步骤（而 `identity: null` 本来就是为了跳过它），
  换来用户可见的变化是零 —— 为「看起来整洁」引入一个发布路径上的新失败点，不值得。
- 另外实测确认：`codesign --verify` 在**上游原封不动的 Electron.app** 上同样报
  `code has no resources but signature indicates they must be present`
  （源自 `Electron Framework.framework` 那个 linker-signed 签名）。
  这是 Electron 未签名构建的基线，不是本项目的打包缺陷。

### 评估过、但**没有做**的：申请证书 + 公证

**收益**：macOS 上双击即可打开（没有 Gatekeeper 弹窗）；Windows 上 SmartScreen
的声誉仍要下载量积累，不是签了就好。

**成本**（这是决定不做的主因，按量级从大到小）：

1. **要 Apple Developer Program 会员资格**（个人 99 美元/年；组织还需要 D-U-N-S 编号）。
   这是**持续支出**，不是一次性的
2. **CI 要多管三组密钥**：证书 p12 及其密码、Apple ID + App 专用密码（或 App Store Connect
   API Key）、Team ID。多一组长期凭据就多一条泄露面，也要求 `SECURITY.md` 的威胁模型同步更新
3. **必须开 hardened runtime**，而它对本项目不是「打开开关」这么简单：
   daemon 走 `utilityProcess.fork`、沙箱用 `koffi` 加载原生模块、`asar: false`
   让代码以真实文件落盘 —— 这些都要靠 entitlements
   （`allow-jit` / `allow-unsigned-executable-memory` / `disable-library-validation` …）
   逐项放行，每一项都要在**真实的 Windows/macOS 用户路径**上验证。放行错了的表现是
   「签了名反而跑不起来」，而那时距离发布只差一步
4. **公证是发布路径上的新单点**：`notarytool` 要联网、要排队（分钟级），
   失败会阻断发布。而当前的发布设计是「文案出问题不该阻断发布」，
   引入一个会阻断的环节要重新想清楚降级策略

**结论：现在不做。** 依据是投入产出比 —— 项目处于 0.x、**只有 Windows 是完整支持的平台**、
macOS 上命令执行本来就受限，因此「macOS 首次打开多一步」是当前阶段可以接受的代价；
而上面四项成本是持续的、且第 3 项有真实的回退风险。

**但代价必须如实说出来**：所以「安装包没有代码签名」写在了**下载页（发布说明最前面）**、
README 与使用指南三处，而不是留一句「介意的话请从源码构建」。
信任缺口的另一半由**构建溯源证明**补上（`build-installers.yml` 用 OIDC 签发，
`gh attestation verify` 可验证）—— 它替代不了签名，但把「无法验证来源」变成了「可验证」。

> 🚫 **不做自签名脚本，也不教用户绕过 Gatekeeper。** 那是在教用户绕过系统安全机制，
> 而且会让「未签名」这件事显得可以糊弄过去。给用户的路径只有两条：
> **按系统提示正常放行**（右键打开 / 仍要运行），或者**从源码构建**。
> 这条边界写在这里，是为了让「用户嫌麻烦」时的下一次讨论不用从零开始。

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

> **本章现在描述的是「稳定渠道」的发布。** 项目还有一条 **Beta 渠道**
> （main 合并即自动构建、无需人工操作），完整机制见下一节「双渠道更新」；
> 两者的关系一句话：**beta 是自动的，稳定版是你手工触发的**。

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

推送 tag 后 `release.yml` 会自动生成发布说明并附上安装包。
**四段的顺序是契约**（`scripts/check-release-notes.mjs` 守着，见[安装包签名](#安装包签名为什么没有以及为什么先不申请)）：

1. **首次运行指引** —— 未签名说明 + 两个平台各自怎么打开。**必须最靠前**
2. **发布摘要**（配了 `ANTHROPIC_API_KEY` 才有；没有则跳过，不影响发布）
3. **本版本的变更内容**（从 `CHANGELOG.md` 对应段落提取）
4. **变更清单**（自己拼的中文 PR 列表 + 对比链接）

> 「变更清单」**不再用** GitHub 原生的 `releases/generate-notes` ——
> 它返回的是英文骨架，而本项目的对外文字一律中文（见 `.trellis/spec/workflow/`）。

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

## 双渠道更新：机制与操作

### 机制总览

```
main 合并功能 PR（AI/维护者的日常开发）          你试用某个 beta 觉得 OK
        │                                              │
        ▼                                              ▼
  Beta 发布流水线（自动）                      稳定发布流程（手工，见上一章）
  版本 0.X.0-beta.N                            CHANGELOG 归档 + version + tag vX.Y.Z
  pre-release + beta.yml                                │
        │                                              ▼
        └──────────► GitHub Releases ◄──── 稳定 Release + latest.yml
                           │
                           ▼
        应用内更新器按用户设置拉对应渠道的 yml：
        稳定版用户 ← latest.yml     Beta 用户 ← beta.yml
```

两条铁律（由流水线保证，不需要你记）：

1. **beta 永远是 pre-release 且只带 beta.yml** —— 稳定渠道用户永远不会被 beta 触碰
   （发布前有守卫步骤校验，channel 文件不对会红）
2. **beta 版本号永远领先稳定版一个 minor**（稳定 0.3.0 → beta 落在 0.4.0 线）——
   你发稳定版 0.4.0 时天然「覆盖」这条 beta 线，不需要「beta 转正」动作

### 你要做的事

**发 beta：什么都不用做。** 功能 PR 合并进 main 后，若 `CHANGELOG.md` 的
`[Unreleased]` 段有内容，Beta 流水线（`.github/workflows/beta.yml`）自动构建并发布
`v0.X.0-beta.N`（N 自动递增）。想主动补发（比如改了打包配置想验证），到
Actions → **Beta 发布** → Run workflow 手动触发一次。

**发稳定版：走上一章的既有流程。** 一句话版（细节都在上一章）：

1. 觉得当前 beta（或 main 上的积累）够稳了
2. 从最新 main 切 `chore/release-vX.Y.Z`，把 `[Unreleased]` 归档成 `[X.Y.Z] - 日期`、
   `package.json` 的 version 改成同版本
3. PR 合并后打 tag 推上去：`git tag -a vX.Y.Z -m "..." && git push origin vX.Y.Z`
4. Release 流水线自动出稳定版（latest.yml 随安装包附上），稳定渠道用户
   在下一次检查更新时收到通知

**发布说明写错了怎么办：手工重算（2026-10-04 起，issue #129）**

Release 页上的文字就是本项目的对外门面，而它由流水线自动拼。**它错过一次**：
v0.4.0 的 PR 清单取错了对比基准（稳定版取到了最后一个 beta tag），清单里只剩发布 PR
自己 —— 1 条 vs 实际的 51 条（根因与修法见 PR #128）。

那一刻的困境是：**说明已经发出去了，却没有可复用的修正路径**。重跑那次 run 用的是
**tag 那个提交里的 release.yml**（旧版本，改不动），只能维护者现场手工 `gh release edit`。

现在有了那条路子：

```bash
gh workflow run release.yml -f tag=v0.4.0
```

它与正常发布**共用同一段生成逻辑**（同三个 job），差别只有两处：

- **检出的 ref 是那个 tag**（不是 main）—— 发布说明的依据必须是**发布当时**的
  CHANGELOG 与 package.json，而不是此刻 main 上的；
- **不构建、不重传安装包**（资产已经在 Release 上，重传只会覆盖或报错），
  publish job 走它本来就有的「Release 已存在 → 改用 edit 更新说明」那条分支。

输入必须是**已经存在的 tag**。两条失败路径实测如下（2026-10-04，三次 dispatch）：

| 输入 | 失败在哪 | 为什么 |
| --- | --- | --- |
| `-f tag=v9.9.9`（不存在） | **检出代码** | GitHub 解析不到这个 ref，走不到后面 |
| `-f tag=main`（存在但不是 tag） | **「校验 tag 存在」** | 检出能过（main 在），只有显式校验拦得住 —— 这一步的用武之地正是这种误用 |

两条都是**明确失败**，不会出现「悄悄拿着 main 的 CHANGELOG 去生成说明」这种最坏形态。
也就是说：给错参数一定会红，而且失败原因读得出来。

> ⚠️ 改本文件之后，验证的**首选**仍然是「真的跑一次」：正式发布前可以拿一个临时 tag 试，
> 已经发布的版本则用上面这条 dispatch（它跑的就是同一段逻辑）。
> 只做静态检查是不够的 —— `startup_failure` 这类错**连日志都没有**（见上一节）。

**给 beta 用户的提示**：beta 用户切回稳定渠道后，要**等到下一个稳定版本发布**
才会收到更新（beta 版本号领先稳定版，这是语义化版本的比较规则使然，不是 bug）——
设置页的更新区文案里写了这一点。

### 验证与排错

- Beta 流水线的 run 在 Actions 里看；`[Unreleased]` 为空时会正常退出（绿色，不发布）
- channel 守卫失败（产物里没有 beta.yml 或混入了 latest.yml）会让 run 变红——
  这条红线**不要跳过**，它保护的是稳定渠道
- 应用内更新器：设置 → 通用 → 更新；macOS 未签名不支持自动安装（只检查 + 通知 +
  跳转下载页，Windows 才有「重启并安装」）——这是平台限制，如实呈现

---

## 应急处理

### GitHub 访问时断时续（EOF / TLS 超时）

先诊断再开关代理——**哪条路稳因人因时段而异，不要把「开」或「关」当固定结论**；
诊断命令、环境注意（e2e 的 mock 服务怕被代理劫持）与重试兜底模式见
`.trellis/spec/workflow/index.md` 的「四·补」。


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
