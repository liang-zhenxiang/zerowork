# PRD · 第三十轮十连——「工作区与任务看板」

任务目录：`.trellis/tasks/11-24-ui-round30/`　分支：`feat/ui-round30`　issue：#484　日期：2026-11-24

## 背景

把「任务」从侧栏列表升级为轻量看板视角：状态分列、跨列拖动改状态、
完成流一目了然。

## 十项清单

| # | 功能 | 落点 |
| --- | --- | --- |
| 1 | 看板视图入口 | 侧栏任务区头「列表 / 看板」切换（localStorage 记忆） |
| 2 | 三列状态看板 | 进行中 / 已完成 / 已归档 |
| 3 | 列内拖拽改状态 | HTML5 drag：拖到另一列 = archive/pin 切换 |
| 4 | 列计数徽标 | 列头数量 |
| 5 | 卡片摘要 | 最后一条消息摘要（sessionDigests 复用） |
| 6 | 视图记忆 | zw:task-view 持久化 |
| 7 | 空列引导 | 空列文案 |
| 8 | 列内滚动 | 每列 max-height + overflow |
| 9 | 窄视口降级 | <1200px 回退列表 |
| 10 | 键盘导航 | 卡片可聚焦、Enter 打开 |

## 硬约束

- 零新依赖；app.css 只追加 §58；**首页/侧栏新增 DOM 必须查 gui-ui-audit /
  gui-health-bento / focus-mode 预算契约（三连教训）**；看板仅在侧栏内、
  不动首页布局
- fixed 浮层会被 transform 祖先吞；clipboard toast 同步派发
- e2e 种子首条消息文本=期望标题；assistant 带 model
- python 替换逐段写入+立即 build；check:unicode 必过；小步提交
