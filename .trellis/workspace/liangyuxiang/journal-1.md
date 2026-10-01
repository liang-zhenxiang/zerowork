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
