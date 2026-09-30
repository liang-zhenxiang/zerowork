# 获取帮助

遇到问题不知道去哪问？按下面的顺序来，越往上越快。

## 1. 先查文档（大多数问题在这里就有答案）

| 场景 | 文档 |
| --- | --- |
| 安装、配置模型供应商、场景 / 技能 / MCP / 自动化怎么用 | [docs/USAGE.md](docs/USAGE.md) |
| 某个功能报错了 | [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) —— **先按报错原文搜一遍** |
| 想理解进程模型、模块划分、以及「为什么这样设计」 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 界面样式与设计 Token 的规矩 | [docs/DESIGN.md](docs/DESIGN.md) |
| 从零跑起来的步骤 | [README 的快速开始](README.md#快速开始) |

## 2. 使用问题（怎么配、为什么没生效）

到 [GitHub Discussions](https://github.com/liang-zhenxiang/zerowork/discussions) 提问。

提问时请附上：

1. 你的操作系统与版本
2. 应用版本（「关于」页或安装包文件名）
3. **完整的报错文本**（不是截图）—— 报错原文是可搜索的，改写过的不是
4. 配置目录的位置（默认 `~/.zerowork`；如果你改过 `ZEROWORK_CONFIG_DIR`，请说明）
5. 相关的界面截图（如果是渲染类问题）

> ⚠️ 贴日志前先看一眼有没有模型 API Key。**不要贴任何凭据。**

## 3. 确认是 Bug

请[提 Issue](https://github.com/liang-zhenxiang/zerowork/issues/new/choose)（选 Bug 模板），
附上与上面相同的要素。

一个能被快速定位的 Bug 报告长这样：

- 现象一句话说清（「点开 xlsx 预览，整个面板变成『界面渲染出错』」）
- 有确定性的复现步骤（不是「有时候会」）
- 附上报错原文与控制台输出
- 说明版本与平台 —— 这个应用在 macOS / Linux 上**命令沙箱不可用**，
  同一个操作在不同平台上的行为本来就不同（见 [docs/USAGE.md 的平台差异](docs/USAGE.md)）

## 4. 安全漏洞

**不要**用公开 Issue 报告安全问题。按 [SECURITY.md](SECURITY.md) 的说明私下报告。

## 5. 想贡献代码

见 [CONTRIBUTING.md](CONTRIBUTING.md)。里面写了本地检查入口、提交信息规范与分支策略。

---

> 💡 提问前先在现有 Issue 与 Discussions 里搜一遍关键词 —— 你的问题很可能已经有人问过并解决了。
