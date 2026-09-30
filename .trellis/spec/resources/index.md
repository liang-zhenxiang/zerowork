# resources（随包分发的第三方内容）编码规范

> `resources/` **不是本工程的源码**，而是随安装包分发的**运行时内容资源**。
> 本页的核心结论只有一句：**不要对本目录应用本项目的工具链。**

---

## 一、这一层是什么

daemon 启动时加载的内容资源，决定产品的可配置性：

| 目录 | 内容 |
| --- | --- |
| `scenes/` | 场景（代码开发 / 日常办公 …） |
| `modes/` | 交互模式（问答 / 创作 / 规划），含 `tools` 白名单 |
| `experts/` | 专家角色，每个含技能与 agent 定义 |
| `skills/` | 技能（docx、前端设计、会议纪要…） |
| `agents/` | Agent 定义（planner / reviewer / scout / worker） |
| `styles/` | 回答风格 |
| `prompts/` | 提示词片段与语言、记忆系统提示 |
| `visualizer/` | 可视化规范（图表、配色、图表类型） |
| `welcome/` | 首屏案例与快捷入口 |
| `runtimes/` | 运行时（gitbash 等） |
| `plugins/` | 插件市场内容 |
| `bin/` | 随包分发的工具二进制（rg、fd、uv） |
| `docx-engine/` | 文档转换引擎（Python） |

路径可通过 `ZEROWORK_RESOURCES_DIR` 环境变量覆盖 ——
这使得把资源目录指向仓库外成为可能（开发模式依赖此项）。

---

## 二、硬约束：不参与本项目的工具链

**eslint / prettier / vitest 三处都做了整目录排除。**（`AGENTS.md` 红线 5）

原因：它有自己的风格与运行环境 —— 里面的 JS 是 vendored 第三方库、
Python 是独立引擎、Markdown 是给模型看的提示词。用本项目的规则去要求它，
只会产出大量无意义的报错，并诱使人去「修」不该修的东西。

**不要移除这些排除项，也不要对 `resources/**` 跑 `--fix`。**

---

## 三、许可：发布前的红线

`THIRD_PARTY_NOTICES.md` 记录着随包内容的授权状况，其中**有尚未确认的条目**：

- 某些技能带**专有许可**（All rights reserved）
- 某些技能是**付费第三方内容**
- 字体有**「应用内注明」**义务

> ⚠️ **这些条目确认之前，不得对外声称本包「可自由使用」。**（`AGENTS.md` 红线 9）
>
> 处置（移除 / 替换 / 取得授权）属于**权利人的决定**，不是代码问题 ——
> 不要因为「看起来该删」就删掉文件。跟踪在 Issue #19。

---

## 四、改动本目录时

- **凭证 / 内网地址不进本目录**。第三方内容也要扫（`AGENTS.md` 红线 8）——
  `npm run check:resources` 就是干这个的
- 改**内容**（提示词、技能定义）属于产品行为改动，要记入 `CHANGELOG.md`
- 改**结构**（新增目录）要同步更新本页的表格与 `docs/ARCHITECTURE.md` 的「资源系统」

---

## 相关

- `THIRD_PARTY_NOTICES.md` —— 随包内容的授权清单
- `docs/ARCHITECTURE.md` —— 「资源系统」一节
- `.trellis/spec/daemon/index.md` —— 资源是如何被加载的
