# PRD · 第二十二轮十连——「性能与体感」

任务目录：`.trellis/tasks/11-13-ui-round22/`　分支：`feat/ui-round22`　issue：#379　日期：2026-11-13

## 背景

二十一轮后可访问性闭环。第二十二轮聚焦**性能与体感**：启动更快、长会话不卡、动画更顺。

## 十项清单（先逐项查重）

| # | 功能 | 说明 | 落点 |
| --- | --- | --- | --- |
| 1 | 启动剖析 | performance.mark 标首帧/可交互；诊断页显示 | app.js 启动尾 + 诊断 |
| 2 | 长会话虚拟化 | 消息列表 >100 条窗口化（±30 条缓冲） | ChatView stream 渲染 |
| 3 | 图片懒加载 | loading=lazy + decode 后淡入 | markdown img 组件 |
| 4 | 侧栏滚动翻页 | task-list 滚到尾部自动 virtualPages+1 | Sidebar task-list onScroll |
| 5 | 输入防抖审计 | 过滤框/搜索已即时（受控），确认无重复渲染热点 | 审计为主 |
| 6 | 大 markdown 分段 | >100KB 回复先渲 50KB +「显示全部」 | markdown 组件 |
| 7 | 动画 GPU 化 | 呼吸/脉冲改 transform/opacity | app.css §46 |
| 8 | 事件节流 | resize/scroll rAF 合并 | App/ChatView handlers |
| 9 | 会话缓存 LRU | viewCacheRef 上限 20 条（Map 保持插入序即可近似 LRU） | viewCacheRef |
| 10 | 启动预热 | 首帧后 requestIdleCallback 预取 listSessions | App 启动尾 |

## 验收标准

- 每项 build 过 + 断言/截图 ≥1（tests/e2e/ui-round22-shots.mjs）
- lint:all / npm test / 既有 GUI 用例全绿
- CHANGELOG [Unreleased]；PR Closes #379；CI 绿合并；guard release；交付截图

## 硬约束（沿用二十一轮教训）

- 零新依赖；app.css 只追加 §46（合并后 grep 段号查重）；jsx(Comp, {}) 带第二参
- **unset ELECTRON_RUN_AS_NODE**；TDZ 声明序；e2e 种子 assistant 带 model+usage
- prefers-reduced-motion 兜底用 0s 形式（不用 0.01ms——Chrome 序列化成 1e-05s 假红）
- merge commit 标题用 chore:；--force-with-lease 仅限本轮临时分支
- python 替换逐段写入+即时校验；check:unicode 必过
