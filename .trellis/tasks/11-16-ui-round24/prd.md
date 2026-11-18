# PRD · 第二十四轮十连——「上下文与效率」

任务目录：`.trellis/tasks/11-16-ui-round24/`　分支：`feat/ui-round24`　issue：#397　日期：2026-11-16

## 背景

二十三轮后数据链路闭环。第二十四轮聚焦**上下文与效率**：长对话的信息密度——
上下文用量可视化、token 感知、提示词资产管理。

## 十项清单（先逐项查重）

| # | 功能 | 说明 | 落点 |
| --- | --- | --- | --- |
| 1 | 上下文占比条 | Composer 的 token-estimate 升级为「context 占用条」（估算 tokens / contextWindow） | Composer |
| 2 | 压缩提示 | 占用 >80% 时提示「旧轮次可能已被压缩」 | Composer 提示 |
| 3 | 提示词预览按轮切换 | 已有提示词预览页查重；补按轮视图（查重后定范围） | PromptPreviewSection |
| 4 | 变量说明 | customInstructions 已有（#313）查重 → **换题**：模型选择器显示 contextWindow 大小 | 模型选择器 |
| 5 | token 计数改进 | 中文按 1 字≈1 token、英文按 4 字符≈1 token 的启发式（零依赖） | tokenEstimate |
| 6 | 会话成本行内显示 | 会话统计行加本会话 cost（stats 已有 cost 数据则直接接） | chat-session-stats |
| 7 | 截断预估 | 占用超窗口时显示「最早 N 轮将被截断」预估 | Composer |
| 8 | 空发送防护 | 查重：发送按钮空文本已禁用 → **换题**：⌘K 快捷键帮助补充发送相关快捷键说明 | 帮助浮层 |
| 9 | 斜杠命令面板 | 输入 / 触发本地命令面板（/help /stats /export 等映射到既有动作） | Composer |
| 10 | 帮助浮层补全 | HelpSheet 补斜杠命令说明（依赖 #9） | HelpSheet |

## 验收标准

- 每项 build 过 + 真实 Electron 截图/DOM 断言 ≥1（tests/e2e/ui-round24-shots.mjs）
- lint:all / npm test / 既有 GUI 用例全绿
- CHANGELOG [Unreleased]；PR Closes #397；CI 绿合并；guard release；交付截图

## 硬约束（沿用二十二/三轮教训）

- 零新依赖；app.css 只追加 §48（合并后 grep 段号查重）；jsx(Comp, {}) 带第二参
- **unset ELECTRON_RUN_AS_NODE**；TDZ 声明序；e2e 种子首条消息文本=期望标题；assistant 带 model+usage
- 侧栏自动翻页只能 wheel/touchstart 手势触发（#380 教训）
- turnViews 是轮计数（N 消息=N/2 轮）；listAll 标题读 session_info 条目
- prefers-reduced-motion 用 0s 形式；merge commit 标题用 chore:
- python 替换逐段写入+立即 build 校验；check:unicode 必过
