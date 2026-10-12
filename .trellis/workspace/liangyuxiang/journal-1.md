# Journal - liangyuxiang (Part 1)

> AI development session journal
> Started: 2026-10-01

---


## 2026-10-02 外观与体验升级（10-01-appearance-upgrade）

- **PR #66 暗色主题**：预留 token 接线成完整功能（三档外观/防闪变启动/widget+窗口控件联动）。
  关键决策：路线 A（属性单路驱动，app.css 无媒体查询暗色块，避免 token 双源）；缺省浅色。
  踩坑：preload 的 INVOKE 是手工同步副本表（只改 shared/ipc.js → conversion failure 报错
  易误判），已修 spec（guides/index.md）。
- **PR #68 首页最近会话**：一键续聊（两跳变一跳）+ 隐私悬停说明。设计评审落盘
  research/design-review.md（9 条诊断 + P0/P1 提案 + Cherry Studio/Chatbox/Claude Desktop 融合结论）。
- 教训：pane 研究 agent 两次死等无回应（50+ 分钟），TaskStop 后主会话接手更快；
  中文文档改动后必须立即跑 U+FFFD 扫描（本次 USAGE.md 险些带伤合入，扫描抓回）。
- 测试资产：check-theme-tokens（静态契约）、gui-theme（8 例含亮度差断言+反向验证 0/8）、
  gui-recent（5 例）。taskList 尚 in_progress：B 部分剩 P1-2 专注模式、P1-3 widget 成品感。

## 2026-10-02 续：issue 驱动的体验批次（PR #75-#78）

- 调研结论转成 5 个 issue（#70-74）并挂进 Roadmap 计划中——后续开发跟着 issue 走。
- #76 专注模式：折叠能力（按钮/过渡/a11y）早已存在，缺的只是键盘路径——改动极小。
  CI 抓到本地看漏的 eslint（合成 KeyboardEvent 的 no-undef），改走 Playwright 真实键盘。
- #77 widget 徽标：rebase 时 #76 已 squash 合入，旧提交用 rebase --skip 跳过。
- #74 核验完成：公式渲染缺位确认，接入评估（体积/离线字体/双主题）落 issue 评论，
  按「先核验再定范围」不冒然背上三件套依赖。
- 剩余：#73 会话分组（中）、#74 接入（中）。

## 2026-10-02 再续：#73 空间置顶（PR #80）

- 前提修正的实践：issue 原判断「分组视图较弱」，核实后分组/折叠/重命名全已在，
  缺口收窄为置顶+标识——按仓库规则在 issue 留言修正再动手，避免实现错误目标。
- 测试踩坑（已沉淀进用例注释）：setWorkspace 只改 daemon 默认值，当前会话 cwd
  不动；「在指定空间建会话」必须走 newTask（侧栏同一 IPC）——首页直发会续建到
  旧空间，两条会话挤同组就是这来的。
- issue 队列只剩 #74（公式接入，评估已落评论，独立排期）。

## 2026-10-02 三续：#74 公式渲染（PR #82）——issue 队列清空

- 两版方案的教训：自写 remark 切分对 TeX 保真先天不足（markdown text 已解码转义，
  \, 变 ,）——**语法捕获必须在 micromark 字符层**，最终走 esbuild 整链 vendor
  （remark-math/rehype-katex/katex，296KB，可再生脚本）。
- 单行 $$ 提升块级的后处理插件与消息流终态重建相互踩踏（整条消息渲染异常）——
  撤回，围栏式即块级；插件方式的完整调试记录在测试注释里。
- 顺带修两个既有缺陷：mock 分片正则 . 不匹配 \n（多行回复段落被压扁）；
  theme 测试在 CI 慢机的 5/8 flake（SelectField 未渲染就点击）——慢环境才暴露的
  时序洞，等元素出现是信号等待的应有形态。
- vendored 治理：SECURITY.md 清单 + VERSION_MARKER + THIRD_PARTY_NOTICES + 静态
  并入型 vendor 的目录约定（chunk 契约扫描之外）。

## 2026-10-02 四续：#84 双渠道自动更新（PR #85/#86）

- 架构：beta 走独立流水线绕开 release.yml 的版本一致性校验（那套校验保护稳定语义，
  beta 版本是运行态）；channel 隔离靠「prerelease 版本→beta.yml」+ 发布前守卫步骤。
- 三个实测坑（都已沉淀注释）：① chord 的 esbuild 生产依赖把全平台 27 个二进制
  （262MB）打进包——afterPack 按 Arch 枚举（数字！ia32=1/x64=2/arm64=3）裁剪；
  ② electron-updater 非打包态 inactive（卡 checking 无网络请求）——
  forceDevUpdateConfig + dev-app-update.yml；③ mac 的 channel 文件带平台后缀
  （stable-mac.yml）——mock feed 按名字渠道段分发。
- CodeQL 又立功：gui-updates 的固定 /tmp 路径 4 条高危（同款第二次）——mkdtempSync。
- 操作手册在 MAINTAINER_GUIDE「双渠道更新」章（beta 零操作；稳定版=既有 tag 流程）。

## 2026-10-02 五续：beta 流水线的真实用户端到端（PR #88-97）

十轮构建才全绿，每轮红灯都是真实缺陷（守卫体系全程没放行过坏包）：
PowerShell 解析 / download-artifact 无 | 语法 / channel 不随版本推导 / publish:null
不产 yml → never 非法 → 真 provider+CLI / artifact 不收 yml / tag 无 identity /
**真机闭环再抓两个**：github provider 的 beta 渠道必须 allowPrerelease（默认只找
latest release）、版本计算的字段名 tagName（写错则序号恒 1、beta.2 覆盖 beta.1）。
最终闭环：装好的 beta.1 应用（Beta 渠道）检查到 beta.2 的新版本提示+toast，截图存证。
教训两条：① dispatch 前**先核实 merge 真的落了 main**（网络重试静默失败会让后续
全跑在旧代码上）；② 字段名类 bug 单测测不出（本地字符串数组 ≠ gh 对象形态）——
映射层要有形态用例。

## 2026-10-12：首页「继续推进」工作台（#199 / PR #200）

选题视角：盘点发现「显然的功能」基本都有（轮次轨/工作轨迹/附件/对比/命令面板），
空白在**回来续摊**——首页最近会话是裸文字行，点进去才知道干到哪。竞品核对
（Claude/ChatGPT Desktop 均为标题+时间）确认交接摘要是空白，本地优先做它零隐私顾虑。

- **daemon**：session-digest.js 纯模块（library.js 模式）+ session:digest 按需通道；
  刻意不进 session:list 热路径（run 边界每次推）；>2MB 不读直接退化；
  错误态给退化文案不给骨架——不伪装成加载态。
- **设计评审两轮**（subagent 设计师）：R1「N 轮」量纲失真（messageCount 是
  user+assistant 之和）→ 改「N 条消息」；R2 清单共存证据 + composer-zone 子序
  结构断言；R3 零消息注脚省略。全部销项。
- **e2e 三个真踩的坑**：① mock 按 content 路由只按字符串取——UI 实发分段数组，
  剧本静默落兜底（症状=断言等的东西永远不出现，不是报错），已沉淀 testing spec；
  ② 回首页再发消息=继续 current 会话（与续摊区同一心智），多会话剧本要先
  kami.newTask()；③ Skeleton 无类名，骨架态探测用「摘要位无文本」。
- **反向验证**：改坏「交付后又说话按文本」优先级→单测+e2e 双红，失败信息
  准确指向挂起会话摘要停在交付态；还原复绿。
- **流程教训**：归档提交直接 push main 被分支保护拦下（按预期工作）——归档也
  要走 PR（#186/#198 皆然，这次差点忘）；U+FFFD 又出现一处（e2e 注释），
  门禁链路正常。
