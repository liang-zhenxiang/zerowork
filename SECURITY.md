# 安全策略

## 支持的版本

本项目处于 0.x 阶段，只对**最新发布版本**提供安全修复。发现漏洞时请在报告中写明受影响的版本。

| 版本 | 是否接受安全修复 |
| --- | :---: |
| 最新 Release | ✅ |
| 更早的版本 | ❌ （请先升级） |
| `main` 分支 | ✅ |

## 报告安全漏洞

**请不要通过公开 Issue 报告安全漏洞。**

请使用 GitHub 的
[Private vulnerability reporting](https://docs.github.com/zh/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
提交（仓库的 **Security** 标签页 → **Report a vulnerability**）。

这是**首选渠道**：它会把报告只发给维护者，且全程留痕。如果因为某些原因用不了它，
也可以直接给任一维护者发邮件：

| 维护者 | GitHub | 邮箱 |
| --- | --- | --- |
| liang-zhenxiang | [@liang-zhenxiang](https://github.com/liang-zhenxiang) | 116311683@qq.com |
| nicholyx | [@nicholyx](https://github.com/nicholyx) | nicholyx@163.com |

> 邮件渠道没有加密保证。**如果漏洞涉及凭证或用户数据，请优先用 Private vulnerability reporting；
> 实在要用邮件，也请只描述问题、不要附真实的凭证或用户数据。**

请在报告中包含：

- 受影响的版本
- 漏洞类型与影响面（能读到什么、能写到什么、能执行什么）
- 复现步骤（最小可复现即可）
- 如可能，附上修复建议

### 我们会怎么做

| 阶段 | 时限 |
| --- | --- |
| 确认收到 | 7 天内 |
| 初步评估（是否成立、严重度） | 14 天内 |
| 修复或缓解方案 | 视严重度而定，会在评估后告知预计时间 |

修复发布后我们会在 Release 说明与
[Security Advisories](https://github.com/liang-zhenxiang/zerowork/security/advisories) 中致谢
（除非你希望匿名）。

### 严重度分级

按可利用性与后果分四档，决定修复的优先级：

| 级别 | 判据 | 例子 |
| --- | --- | --- |
| **严重** | 无需用户交互即可读写任意文件，或绕过权限闸门执行任意命令 | 沙箱逃逸、权限判定被绕过 |
| **高** | 需要用户交互（打开一个文件 / 点一个链接），后果是任意文件读写或凭据泄露 | 解压不可信归档时写到目标目录之外 |
| **中** | 需要用户交互，且后果限于信息泄露或拒绝服务 | 解析畸形文档导致崩溃 |
| **低** | 影响有限，或需要本地已具备的能力 | 日志里出现非敏感的路径 |

### 不在范围内

- 需要在用户机器上**已经具备代码执行能力**才能触发的「漏洞」
- 第三方依赖自身的漏洞 —— 请直接报告给上游。但**如果它在本项目里可被触发**，
  那属于我们的问题，请照常报告
- 随包分发的第三方内容（`resources/` 下的插件与技能）自身的实现缺陷 ——
  见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；但**它们的授权与再分发问题**
  是我们的问题，欢迎提出

## 威胁模型

这个应用的攻击面与普通桌面应用不同，写清楚「什么是威胁」比列一串检查项有用。

### 资产

按重要程度排序：

1. **用户机器上的文件** —— 应用能读写工作区，命令执行能触达整个文件系统
2. **模型供应商凭据** —— 存在用户配置目录里
3. **MCP 连接器配置里的环境变量** —— `expandEnvVars` 展开的内容可能含密钥
4. **会话历史与审计日志** —— 含用户的工作内容、命令原文、路径

### 信任边界

```
┌─ 可信 ────────────────────────────────────────────────┐
│  本仓库的源码（含 resources/ 里的自研内容）             │
└───────────────────────────────────────────────────────┘
┌─ 不可信（一律按「敌意输入」对待）────────────────────────┐
│  · 用户打开的文档（PDF / Office / docx）                │
│  · 模型返回的内容（可能被提示注入污染）                  │
│  · MCP server 的响应                                   │
│  · 用户配置的 MCP server 本身（等同于任意命令执行）       │
│  · 网络响应（Web 搜索、URL 抓取）                       │
└───────────────────────────────────────────────────────┘
```

**「模型返回的内容不可信」是理解本项目多数安全设计的钥匙。** 模型会调用工具，
而工具的参数可能来自被污染的上下文 —— 所以权限判定不能相信模型的自述，
必须在工具真正执行前独立复核。

### 对手假设

- 能让用户**打开一个恶意文件**的攻击者
- 能让用户**访问一个恶意网页**、从而让 Web 搜索 / 抓取工具取回被污染内容的攻击者
- 能**提交 PR** 的人（因此工作流的触发方式与表达式注入是红线）
- **不假设**攻击者已经能在用户机器上执行代码

### 攻面与对应的设计

| 攻面 | 现有设计 |
| --- | --- |
| 渲染层被注入脚本 | 沙箱化渲染进程 + CSP 由主进程按 dev/prod 下发（见下） |
| 模型诱导执行危险命令 | 独立于模型的权限判定（`permission-rules.js`）+ 沙箱层 |
| 沙箱不可用时静默放行 | **宁可不执行，也不静默地无约束执行** —— 受限档下直接拒绝并给出逃生指引 |
| MCP 配置解析被注入 | `expandEnvVars` 处理不受信任输入，相关改动需特别审查（见下） |
| 恶意文档解析 | daemon 侧的解析库在独立进程内，与界面隔离（`officeparser` 读 pdf / docx / xlsx / pptx）；渲染侧的预览解析（vendored SheetJS）跑在**沙箱渲染进程**内。两条路径上「**解析库自身的漏洞**」都是开放问题，见下文 |
| 工作流拿到不该有的权限 | 所有工作流显式最小 `permissions`；`uses:` pin 到 commit SHA；zizmor 扫描基线 0 findings |
| 审计记录被悄悄清空 | 「擦除审计日志」这个动作本身也会留一条记录 |

### 已知的开放风险

写在这里而不是藏起来 —— 一个诚实的威胁模型比一个看起来完整的更有用。

- **随包的 vendored 依赖带已知高危漏洞，而审计工具看不到它。**
  `src/renderer/src/vendor-xlsx.js` 是 SheetJS 0.18.5 的预打包产物，**随安装包分发**，
  带原型污染（[GHSA-4r6h-8v6p-xvw6](https://github.com/advisories/GHSA-4r6h-8v6p-xvw6)）与
  ReDoS（[GHSA-5pgg-2g8v-p4x9](https://github.com/advisories/GHSA-5pgg-2g8v-p4x9)）
  两个 high 公告，二者**都没有 npm 上的修复版本**（`xlsx` 停在 0.18.5）。
  触发条件正是**解析用户提供的表格文件** —— 本产品的核心功能。
  当前状态：**已知、未修、有跟踪**（[Issue #61](https://github.com/liang-zhenxiang/zerowork/issues/61)）。
  **这一条的要点不是「有一个漏洞」，而是「有一类代码没有任何工具在盯」** ——
  为什么审计工具看不见、以及全部 `vendor-*.js` 的清单，见下文
  「随包的 vendored 依赖：审计盲区」。
- **仓库根的生产依赖有 1 条 high 未修**（`brace-expansion`，由
  `@earendil-works/pi-coding-agent` 传递引入，`npm audit fix` 可修）。
  作为对照：`officeparser` 早年依赖的 `decompress` 曾有一条 Zip Slip 类 critical，
  已随 officeparser 迁移到 8.x（改用 `fflate`）自行消失 —— 那一类**会随升级消失**，
  上面那条 vendored 盲区**不会**。跟踪在
  [依赖安全 Issue](https://github.com/liang-zhenxiang/zerowork/issues/17)。
- **随包第三方内容的授权状态尚未完全确认。** 见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
  这不是技术漏洞，但它决定了「分发这个软件」这件事本身是否成立。
- **命令沙箱是 Windows 专有的**（靠 `koffi` 调 `kernel32` / `advapi32`）。
  在 macOS / Linux 上受限档直接拒绝执行命令，这是有意的降级，不是缺陷。

## 本项目的安全相关设计细节

### 渲染层隔离

渲染进程运行在沙箱化的 web 环境中，无法直接访问任意文件路径。
需要文件系统能力的操作（文件对话框、读取图片字节）由主进程通过 IPC 应答完成。

### CSP

Content-Security-Policy **不写在 `index.html` 里**，而是由主进程按
dev / prod 分别下发（见 `src/main/index.js` 的 `installCsp`）。
原因：dev 模式下 `@vitejs/plugin-react` 会注入内联的 react-refresh preamble，
静态 meta CSP 收紧 `script-src` 会把它拦掉。

⚠️ 修改 CSP 时请同时验证 dev 与 prod 两种模式。

### 沙箱与权限

Agent 执行命令经过沙箱层（`src/main/sandbox/`），权限预设定义在
daemon 的 `PERMISSION_PRESETS` / `APPROVAL_POLICIES` 中。

**放宽权限默认值属于安全敏感变更，请在 PR 中明确说明理由。**

权限判定规则本身（`src/main/daemon/permission-rules.js`）有单元测试覆盖
（凭据目录清单、路径包含判定含目录穿越、命令意图分类、不透明命令识别），
改动它时测试必须同步扩充。

### MCP 连接器

MCP server 通过 stdio 或 HTTP 传输启动外部进程，**等同于执行用户配置的任意命令**。
配置解析在 daemon 的 `readMcpConfig` / `parseServer` 一带，
涉及 JSONC 解析与环境变量展开（`expandEnvVars`）。

**涉及 `expandEnvVars` 的改动需要特别审查** —— 它处理的是不受信任的配置输入。

MCP 工具的权限判定是 `ask`（而不是 `allow`）。端到端测试里有一条安全断言：
调用 MCP 工具时**权限请求数必须非零**，为 0 就说明审批链路被绕过了。

### 审计日志

daemon 记录命令执行、沙箱、运行时、审计四类事件（`AUDIT_CATEGORIES`）。
审计日志本身可能包含敏感信息（命令内容、路径），导出与展示时请注意。

## 依赖安全

```bash
# 本机 registry 若配了镜像，必须显式指定官方源，否则审计接口拿不到数据
npm audit --registry=https://registry.npmjs.org/
```

本项目依赖 `@earendil-works/pi-coding-agent` 等第三方包，
其安全更新节奏不由本项目控制。

Dependabot 告警与安全更新已启用；版本更新只覆盖**仓库根**的依赖 ——
`resources/` 下随包分发的第三方模板不代其升级（理由见 `.github/dependabot.yml` 的注释）。

**但上面这套机制有一处结构性覆盖不到的地方**，见下一节。

### 随包的 vendored 依赖：审计盲区

`src/renderer/src/*.js` 是**预打包的 vendored bundle**：依赖在入库前就已被内联完毕，
文件里没有任何裸 import，Vite 只把它们原样搬运成同名产物
（详见 `docs/MAINTAINER_GUIDE.md` 的「渲染层现状」）。`vendor-*.js` 是其中
**按来源命名**的那一批。它们**随安装包分发给用户**，却落在所有审计工具的视野之外。

**盲区由四层原因叠加而成：**

1. **它们不是 npm 依赖。** Dependabot 与 `npm audit` 只读 `package.json` /
   `package-lock.json`，不会去读源码树里的 `.js` 文件。
2. **原包已移出生产依赖。** 瘦身（#49）把 `xlsx` 这类渲染层专用包移进了
   `devDependencies`，于是 `npm audit --omit=dev`（也就是「随包究竟发了什么」那一档）
   不再报它 —— 现状看起来像「已经修好了」。
3. **Dependabot 里还显式 `ignore` 了 `xlsx`。** 那条 ignore 本身有据可依
   （npm 上 0.18.5 之后没有新版本，让它一直弹「无法修复」的告警只会造成告警疲劳，
   见 `.github/dependabot.yml`）—— 但副作用是**唯一可能提到它的通道也静默了**。
4. **升级 `package.json` 不改变随包的字节。** bundle 是冻结在 git 里的产物，
   仓库里**没有重新生成它们的脚本**，只有有人手工重打包时才会更新。
   这一条最要紧：它意味着第 2、3 条不是「还没修」，而是**修了也不会生效**。

**当前清单（全部 `vendor-*.js`）**

| 文件 | 库 | 版本 | 如何被加载 |
| --- | --- | --- | --- |
| `src/renderer/src/vendor-xlsx.js` | SheetJS Community Edition（npm 包名 `xlsx`） | 0.18.5 | `office-xlsx.js` 的 `XlsxPreview` 在预览 `.csv` / `.xls` 时**动态 import 懒加载** |
| `src/renderer/src/vendor-lodash.js` | lodash | 4.18.1 | 被 `workspace.js` / `office-xlsx.js` / `office-pptx.js` **静态 import** |
| `src/renderer/src/vendor-jszip.js` | JSZip | 3.10.2 | 被 `workspace.js` / `office-docx.js` / `office-pptx.js` **静态 import** |
| `src/renderer/src/vendor-jszip-2.js` | JSZip —— 打包器拆出的**再导出薄壳**（244 字节，自身无版本号） | 3.10.2（同 `vendor-jszip.js`） | 被 `office-docx.js` / `office-pptx.js` 静态 import 取默认导出 |

> **版本号取自 bundle 内的版本标记，不是猜的**：`vendor-xlsx.js` 的
> `XLSX.version = "0.18.5"`、`vendor-lodash.js` 的 `var VERSION = "4.18.1"`、
> `vendor-jszip.js` 的 `n.version = "3.10.2"`。
> `scripts/check-vendored-deps.mjs` 会逐字核对**这张表与 bundle 里的版本标记**，
> 并保证新出现的 `vendor-*.js` 必须先登记在册。
>
> **这四个里目前只有 SheetJS 带已知公告。** 列出其余三个不是为了凑数 ——
> 「当前没问题」与「有人在盯」是两件事，而这里缺的正是后者。

**已识别的风险：SheetJS 0.18.5**

| 公告 | 严重度 | 修在 |
| --- | --- | --- |
| [Prototype Pollution in sheetJS](https://github.com/advisories/GHSA-4r6h-8v6p-xvw6)（CVE-2023-30533） | high | 0.19.3 |
| [SheetJS Regular Expression Denial of Service](https://github.com/advisories/GHSA-5pgg-2g8v-p4x9)（CVE-2024-22363） | high | 0.20.2 |

- **触发条件**：预览 **`.csv` / `.xls`** 文件时，`XlsxPreview` 动态加载
  `vendor-xlsx.js`，并用 `XLSX.read()` 解析该文件的字节（`office-xlsx.js:104969-104974`）——
  即**用户提供的不受信内容**。精确的边界是：SheetJS 在这条路径上只承担
  「把 csv / xls 转成 xlsx」，随后的渲染交给 fortune-sheet；
  **`.xlsx` 的预览不走 SheetJS**，daemon 侧读表格走的是 `officeparser` 8.x + `fflate`。
  缩小触发面不等于风险可忽略 —— 它仍在「打开用户文件」这条核心路径上。
- **影响面**：两条公告都发生在**沙箱化的渲染进程**内（CSP 亦由主进程收紧），
  不会直接触达文件系统、命令执行或主进程。这是对**后果范围**的说明，
  不是对风险等级的否定：原型污染与拒绝服务都会破坏本应用对「不可信输入」的处置假设。
  （公告原文对原型污染那条另有一句限定：*workflows that do not read arbitrary files
  are unaffected*，即「不读任意文件的工作流不受影响」—— 本项目**恰好就是**
  读任意文件的那一类。）
- **修复版本不在 npm 上**：`npm view xlsx version` → `0.18.5`。SheetJS 已迁到
  `cdn.sheetjs.com` 自有分发，升级意味着**引入一个新的、非 npm 的依赖源** ——
  这是供应链决策，需单独讨论。故当前状态为：**已知、未修、有跟踪**
  （[Issue #61](https://github.com/liang-zhenxiang/zerowork/issues/61)）。

**同类盲区的范围不止 `vendor-*.js`**

`office-pptx.js`、`office-xlsx.js`、`code-preview.js`、`pdf.worker.js` 等同样是
预打包 bundle，分别来自 `pptx-preview`、fortune-sheet（`@fortune-sheet/react` /
`@corbe30/fortune-excel`）、`monaco-editor`、`pdfjs-dist` —— 但它们内部**没有
`XLSX.version` 那样可直接读取的版本号**，仓库里也没有记录它们各自由哪个版本打出。
其中至少一个当前带开放公告：`office-pptx.js` 所来自的 `pptx-preview`（在
`devDependencies` 里）传递依赖了 `echarts`（XSS）与 `uuid`（缓冲区边界检查），
在 `npm audit` 里是 moderate。

**这份清单以「已确认」为准，不声称穷尽** —— 而这正是本节的结论。

**复查落点**

`scripts/check-vendored-deps.mjs` 把上面那张表变成机器可查的：新出现的
`vendor-*.js` 不登记会失败，表里的版本与 bundle 里的版本标记不一致也会失败。
它**故意不联网** —— 查漏洞数据库会让一个静态门禁变成网络依赖
（理由同 `scripts/check-docs.mjs` 的「不做的事」），所以
「版本与公告状态的比对」仍是**定期的人工事项**，跟踪在 Issue #61。
