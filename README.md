<div align="center">

# ZeroWork

**本地优先的办公 AI Agent 桌面端** —— 把模型能力接到你的真实文件与工作流上。

[![CI](https://github.com/liang-zhenxiang/zerowork/actions/workflows/ci.yml/badge.svg)](https://github.com/liang-zhenxiang/zerowork/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/liang-zhenxiang/zerowork)](https://github.com/liang-zhenxiang/zerowork/releases)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/badge?org=liang-zhenxiang&repo=zerowork)](https://github.com/ossf/scorecard)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[快速开始](#快速开始) · [使用指南](docs/USAGE.md) · [排错](docs/TROUBLESHOOTING.md) · [架构](docs/ARCHITECTURE.md) · [贡献](CONTRIBUTING.md)

**中文** | [English](README.en.md)

</div>

---

## 这是什么

一个桌面应用，让 AI Agent 在你自己的机器上替你处理办公与开发里的事情：
读写文件、解析文档、跑命令、按计划执行任务。

- **Electron + React 19**，Agent 内核基于 [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
- **不绑定模型供应商**：任何 OpenAI 兼容的端点都能接，包括本地模型与自建网关
- **本地优先**：出站请求逐条可查（见 [EXTERNAL_REQUESTS.md](EXTERNAL_REQUESTS.md)）
- **安全默认收紧**：受限权限档下宁可拒绝执行，也不静默地无约束执行

> ⚠️ 项目处于 **0.x** 阶段，且**只有 Windows 是完整支持的平台** ——
> 命令沙箱依赖 Windows 专有的系统调用。macOS 上除命令执行外均可用，Linux 未做适配。
> 详见[平台支持](#平台支持)。

## 特性

| 能力 | 说明 |
| --- | --- |
| **多场景** | 代码开发 / 日常办公 / 文档处理 / 数据分析 / 深度研究 / 幻灯片，按场景切换工作方式 |
| **专家与技能** | 十余个打包好的专家（数据分析、研报、产品设计、前端、文档…）+ 可按需加载的技能 |
| **MCP 连接器** | 接入外部工具。stdio 与 HTTP 两种传输，工具调用**每次询问权限** |
| **文档解析** | PDF / Office / DOCX 的读取与再生成 |
| **自动化任务** | 定时触发：到点起一个会话跑你写的提示词 |
| **会话管理** | 归档、从任意历史消息**分叉**出新会话、用量统计 |
| **审计** | 命令执行、沙箱、运行时、审计四类事件留痕；**擦除日志本身也留痕** |
| **权限与沙箱** | 三档权限 + 独立于模型的权限判定 + 沙箱执行 |

## 快速开始

### 用安装包

从 [Releases](https://github.com/liang-zhenxiang/zerowork/releases) 下载。

> ⚠️ **安装包没有代码签名。** macOS 首次打开需**右键 → 打开**（直接双击会被拦下），
> Windows 会有 SmartScreen 提示，点「更多信息 → 仍要运行」。
> 这是没有代码签名证书时的必然结果，不是打包出错 —— 详见
> [排错手册](docs/TROUBLESHOOTING.md#安装包被系统拦下)。

### 从源码

```bash
npm ci
npm run dev     # 开发模式（渲染层热更新）
```

未打包运行时需要显式指定资源与配置目录：

```bash
ZEROWORK_CONFIG_DIR=/tmp/zerowork-dev \
ZEROWORK_RESOURCES_DIR=$PWD/resources \
npm run dev
```

装好之后第一次要做的事是**接上模型**（设置 → 模型），见
[使用指南 · 第二步](docs/USAGE.md#第二步接上模型)。

## 平台支持

| 能力 | Windows | macOS | Linux |
| --- | :---: | :---: | :---: |
| 应用本体 / 界面 / IPC | ✅ | ✅ | ✅ |
| 模型对话 / Agent 循环 | ✅ | ✅ | ✅ |
| 文档解析（PDF / Office / docx） | ✅ | ✅ | ✅ |
| **命令执行** | ✅ 沙箱内 | ⚠️ 受限档被拒 | ⚠️ 受限档被拒 |
| 托管运行时 | ✅ Node / Bash / Python | 🔶 Node / Python | 🔶 Python |

### 关于命令沙箱

命令沙箱靠 `koffi` 调 Windows 的 `kernel32` / `advapi32`，是 **Windows 专有**的。
所以在 macOS / Linux 上，**默认权限档下命令会被直接拒绝执行**：

| 权限档 | macOS / Linux 上的行为 |
| --- | --- |
| `read-only` / `workspace-write`（**含默认档**） | ⚠️ 命令被**直接拒绝** |
| `danger-full-access` | ✅ 可以执行（不经沙箱、直接 spawn） |

**这是有意的安全设计**：宁可不执行，也不静默地无约束执行 ——
否则「受限档」就成了摆设。命令被拒时界面会给出理由与逃生指引，
细节见[排错手册](docs/TROUBLESHOOTING.md#macos--linux命令被拒绝执行)。

**也因此没有 Linux 安装包**：发一个「界面能开、命令执行被拒」的包，
等于对外承诺一个不成立的平台支持。

## 文档索引

| 文档 | 给谁看 |
| --- | --- |
| [docs/USAGE.md](docs/USAGE.md) | **使用者** —— 安装、配置模型、各功能区怎么用、权限与平台差异 |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | **遇到问题的人** —— 按报错原文搜，含「什么情况下不该用这个方案」 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | **想改代码的人** —— 进程模型、模块划分、**以及为什么这样设计** |
| [docs/DESIGN.md](docs/DESIGN.md) | **改界面的人** —— 设计 Token 的档位纪律与禁止清单 |
| [docs/MAINTAINER_GUIDE.md](docs/MAINTAINER_GUIDE.md) | **维护者** —— 仓库配置、测试分层、发布流程、项目红线 |
| [AGENTS.md](AGENTS.md) | **用 AI 助手改这个项目的人** —— 开发流程与规则的速查版（AI 工具会自动加载它） |
| [CONTRIBUTING.md](CONTRIBUTING.md) | **贡献者** —— 本地检查、提交规范、分支策略 |
| [SUPPORT.md](SUPPORT.md) | **不知道去哪问的人** —— 分流到文档 / Discussions / Bug / 安全报告 |
| [SECURITY.md](SECURITY.md) | **报告安全问题的人** —— 含威胁模型与已知的开放风险 |
| [EXTERNAL_REQUESTS.md](EXTERNAL_REQUESTS.md) | **关心隐私的人** —— 运行时向外部发起的每一个请求 |
| [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) | **关心许可的人** —— 随包第三方内容的授权状态 |

## 技术形态（想改代码再看）

两处结构性事实值得先知道，细节在 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)：

1. **源码以 JavaScript + JSDoc 提供**，类型检查走 `tsc`（`checkJs` 当前关闭，
   原因与渐进补类型的路径写在架构文档里）
2. **渲染层是 chunk 粒度，不是组件粒度** —— `src/renderer/src/app.js` 单个文件 6.8 万行。
   这是**有意的**：自动拆分产不出可读可靠的划分，理由与四条人工切分线索同在架构文档里

```bash
npm run test:all    # 本地全量：静态检查 + 单元测试 + 端到端 GUI 测试
```

## 路线图

路线图的单一事实来源是 **[Roadmap Issue #21](https://github.com/liang-zhenxiang/zerowork/issues/21)**，
README 不重复维护一份。当前方向：把项目打造成规范的开源项目（v0.2.0），
随后处理随包第三方内容的授权与依赖安全等已知问题。

## 贡献

欢迎任何形式的参与 —— 报 Bug、改文档、补测试都算。
先读 [CONTRIBUTING.md](CONTRIBUTING.md)，里面有本地检查入口与提交规范。

第一次贡献？找带 [`good first issue`](https://github.com/liang-zhenxiang/zerowork/labels/good%20first%20issue) 标签的 Issue，
它们的正文里写明了从哪个文件入手。

参与即表示同意遵守 [行为准则](CODE_OF_CONDUCT.md)。

### 维护者

| 维护者 | GitHub | 邮箱 |
| --- | --- | --- |
| liang-zhenxiang | [@liang-zhenxiang](https://github.com/liang-zhenxiang) | 116311683@qq.com |
| nicholyx | [@nicholyx](https://github.com/nicholyx) | nicholyx@163.com |

两人都是全权维护者。有问题也可以在 Issue / PR 里直接 @ 我们 ——
**如果是安全问题，请走 [SECURITY.md](SECURITY.md) 的私有渠道，不要开公开 Issue。**

## 外部请求与发布前核对

- **[EXTERNAL_REQUESTS.md](EXTERNAL_REQUESTS.md)** —— 运行时向外部发起的请求：到哪个地址、
  做什么用、由什么触发、能不能关掉
- **[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)** —— **发布前必须由权利人确认**的事项：
  随包第三方内容的许可证与再分发授权状态

> ⚠️ 在 `THIRD_PARTY_NOTICES.md` 里被标为待确认的条目**确认之前**，
> 请不要假设任何使用授权。

## 许可

**Apache License 2.0**，见 [LICENSE](LICENSE)。

本项目依赖 `@earendil-works/pi-coding-agent` 等第三方包，它们的条款会对再分发构成额外约束；
随包内容还包含若干带独立许可证的第三方资源，逐项列在
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
