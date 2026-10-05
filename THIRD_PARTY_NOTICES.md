# 第三方依赖与发布前核对

本文件记录**发布前必须由权利人确认的事项**：许可证选择、依赖条款、随包资源与外部请求。

> ⚠️ 本文件不是走形式的清单。下面每一项都需要**权利人（或法务）拍板**，
> 未确认前不要把本仓库当作已完成许可合规的产物分发。

---

## 1. 随包资源的外部请求

`resources/` 下的部分内置能力会向外部服务发起请求（金融数据、知识库上传、
公众号检索等），其中若干项**没有开关**。

完整清单（地址 + 用途 + 能否关闭）见 **[EXTERNAL_REQUESTS.md](./EXTERNAL_REQUESTS.md)**。

其中优先级最高的一项：

| 位置 | 情况 |
| --- | --- |
| 股票数据技能（`stock` / `stock-data` / `stock-tool`） | 随包脚本经混淆并含 WASM，**内含监控 SDK 的上报地址常量**；无开关，本轮未改动。若不需该能力，**整体移除这三个技能目录**是最干净的处置 |

> 2026-10-04（#104）：**首屏案例封面图不再是外部请求**。它此前指向第三方静态站
> （12 张 PNG），现已改为渲染层第一方生成 —— 顺带也把这批图**随包再分发**的授权问题
> 一并消掉了（那本来要走 `THIRD_PARTY_NOTICES` 的确认流程，见 `AGENTS.md` 红线 9）。

## 2. 随包内容里**带许可声明的**第三方资产 —— 最高优先级

`resources/` 下有一批资产**自带来源方的许可文件**。这些是**法律声明**，
不是可以顺手清理的品牌字样 —— 删掉它们等于移除许可信息（MIT 明确要求保留
版权与许可声明；专有声明更是原始权利人的主张）。因此**一律原样保留**，
并在此逐项登记，供权利人核对。

| 位置 | 许可 | 权利人 |
| --- | --- | --- |
| `resources/plugins/teams_marketplace/document-skills/1.0.0/skills/pdf/LICENSE.txt` | ⚠️ **专有** —— `© 2025 Anthropic, PBC. All rights reserved.`，正文写明使用受你与 Anthropic 的协议约束 | Anthropic, PBC |
| `resources/skills/frontend-design/LICENSE.txt` | MIT | Anthropic, PBC |
| `resources/skills/web-interface-guidelines/LICENSE.txt` | MIT | Vercel, Inc. |
| `resources/experts/mvp-dev-expert-team/LICENSE` | MIT | weiyou |
| `resources/experts/technical-documentation-engineer/skills/minimax-docx/LICENSE` | MIT | MiniMaxAI |
| `resources/experts/visual-storytelling-expert/skills/minimax-docx/LICENSE` | MIT | MiniMaxAI |
| `resources/experts/mvp-dev-expert-team/references/01-standards/*.md`（10 篇，文件头 HTML 注释） | MIT 归属声明：`Adapted from UmaDev knowledge base (MIT License)` | UmaDev |
| `resources/experts/visual-storytelling-expert/skills/content-factory/README.md` | **付费第三方技能**（标价 $9、作者署名 Carson Jarvis） | 个人作者 |
| `resources/experts/market-researcher/skills/stock/scripts/{data,tool}-vendor.js`（内嵌注释） | 打包进来的开源库各自声明：axios、URI.js、OpenJS Foundation、Express 系等 | 各自作者 |
| `resources/bin/UV-NOTICE.md` | `uv` 二进制来源与 sha256 校验记录 | astral-sh |
| `src/renderer/src/app.css`（内嵌 pdf.js viewer 的文本层 / 注释层样式，文件头两处带 Apache-2.0 声明） | Apache-2.0 | Mozilla Foundation |
| `src/renderer/src/vendor-katex.js` + `katex.css` + `katex-fonts/`（由 `scripts/vendor-katex.mjs` 从 npm 生成） | MIT（KaTeX、remark-math、rehype-katex 及其依赖树均为 MIT） | KaTeX Contributors 及各依赖的权利人；上游许可随 npm 包分发 |
| `src/renderer/src/vendor-xlsx.js`（SheetJS Community Edition 的 ESM 构建，**原样复制上游 `package/xlsx.mjs`，含其版权头**） | Apache-2.0 | SheetJS LLC（`/*! xlsx.js (C) 2013-present SheetJS -- http://sheetjs.com */` 随文件保留） |
| `src/renderer/src/vendor-lodash.js` | MIT | John-David Dalton 及 lodash 贡献者 |
| `src/renderer/src/vendor-jszip.js` + `vendor-jszip-2.js` | MIT（或 GPLv3，双许可） | Stuart Knightley 及 JSZip 贡献者 |
| `resources/fonts/README.md`（MiSans 字体来源与许可条款；**字体二进制未入库**） | 小米《MiSans 字体知识产权许可协议》—— 全球免费商用，但**嵌入式使用须「在软件中特别注明使用了 MiSans 字体」** | 小米科技有限责任公司 |

**发布前需要权利人逐项处置**（三选一）：

- [ ] **`pdf` 技能（Anthropic 专有）** —— 这是全部清单里最需要先处理的一项：
      标注是 *All rights reserved*，与 Apache-2.0 分发不相容。取得授权、替换为
      自研实现，或移除该技能目录
- [ ] `content-factory`（付费第三方技能）—— 同上
- [ ] 各 MIT 资产 —— **可以随包分发**，但必须保留其 LICENSE 与归属声明
      （已保留，勿删）
- [ ] 其余（UmaDev 归属注释、vendored 库声明、uv 来源）—— 保留即可
- [ ] **MiSans 的「应用内注明」义务 —— 目前未履行**。许可条款要求「在软件中
      特别注明使用了 MiSans 字体」，而应用内注明位置取决于「关于」页，**当前没有关于页**，
      所以这条义务处于未完成状态。`resources/fonts/README.md` 是仓库内的注明，
      **不等于软件内的注明**。发布前须补上「关于」页或改用其他方式随应用呈现该声明

### 关于其余 `resources/` 内容

除上表所列，`resources/` 下还有专家包、预装插件、回复风格、提示词片段、
docx 技能与引擎、首屏数据等。它们随本仓库一并以 Apache-2.0 分发。

- [ ] 权利人确认对这部分内容**拥有著作权或已取得可再分发的授权**，
      且该授权覆盖**公开开源分发**（不只是内部使用）
- [ ] 若不覆盖，则对照 `resources/` 各目录逐项完成**替换或移除**

> 这两条都无法由技术手段代为实现 —— 它取决于权利人的事实状态与手上的授权文件。
>
> 本仓库的 git 历史保留了本次发布前对随包文档的整理过程，需要追溯时可查提交记录。

## 3. 第三方依赖的许可条款

`package.json` 中的依赖各有其许可条款。其中
`@earendil-works/pi-coding-agent` 是 Agent 内核的基础，其条款对再分发构成额外约束。

```bash
npx license-checker --summary
```

- [ ] 已核对全部依赖条款，并确认与所选许可证兼容

## 4. 许可证与版权主体

- 当前 `LICENSE` 为 **Apache-2.0**（选型理由见 [README.md 的「许可」一节](README.md#许可)；
  `LICENSE` 本身是 license 原文，不含任何注释块）
- `LICENSE` 末尾版权署名为 `Copyright 2026 ZeroWork`

- [ ] 确认 Apache-2.0 符合预期（如需更换，替换 `LICENSE` 与
      `package.json` 的 `license` 字段即可）
- [ ] 确认版权署名与真实的权利主体一致

## 5. 运行时依赖的外部服务（供参考）

应用本体自身的出站请求**全部可控**（需用户显式配置或点击才会发生）：
模型 API（用户配置 `baseUrl`）、联网搜索（用户配置服务商与 Key）、
`web_fetch`（模型指定 URL，受权限门约束）、托管运行时下载（用户点「安装」时）、
本地预览服务（仅回环地址）。

详见 [EXTERNAL_REQUESTS.md](./EXTERNAL_REQUESTS.md) 第一节。

---

## 核对清单汇总

按优先级排序 —— **第一条是唯一一条「不改就不能发布」的**：

- [ ] **第 2 节带许可声明的资产**：`pdf`（Anthropic 专有）与 `content-factory`
      （付费第三方技能）已取得授权 / 替换 / 移除；MIT 资产的许可声明已保留
- [ ] **MiSans 的应用内注明义务已履行**（补「关于」页或等效呈现）——
      这是唯一一条「资产已合规、但义务尚未执行」的条目
- [ ] 第 2 节其余内容：随包内容的授权状态已由权利人确认
- [ ] 第 1 节：`EXTERNAL_REQUESTS.md` 已过目，无开关的请求已决定保留 / 替换 / 移除
- [ ] 第 3 节：依赖条款已核对并与所选许可证兼容
- [ ] 第 4 节：许可证选型与版权主体已确认

> 未全部勾选前，请勿假设任何使用授权。
>
> ⚠️ **注意**：`resources/` 下各 LICENSE / NOTICE 文件是**法律声明**，
> 不是可以随品牌清理一并删掉的字样。若要移除某项资产，请连同其声明一起移除
> 整个目录，而不是只删声明文件。
