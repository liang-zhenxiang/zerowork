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
