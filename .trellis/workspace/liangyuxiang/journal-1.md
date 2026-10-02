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
