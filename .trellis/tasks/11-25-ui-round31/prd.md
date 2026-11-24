# PRD · 第三十一轮十连——「Composer 输入体验」

任务目录：`.trellis/tasks/11-25-ui-round31/`　分支：`feat/ui-round31`　issue：#493　日期：2026-11-25

## 十项清单（查重结论）

| # | 功能 | 查重 | 本轮落点 |
| --- | --- | --- | --- |
| 1 | 多行粘贴保形 | textarea 天然支持 | 查重达标 |
| 2 | ⌘Enter 插入换行 | ⇧Enter 换行已有 | 查重达标 |
| 3 | 草稿自动保存指示 | draftKey 已有；**补**：防抖保存后微提示（「已自动保存」小字淡出） | Composer |
| 4 | 引用回复 | **查后定**（先查消息操作是否已有引用） | 消息操作 |
| 5 | 斜杠菜单键盘导航 | 24 轮已有面板；**补**：↑↓ 选择 + Enter 执行 | slash menu |
| 6 | 输入历史 ↑ | enableHistory 已有 | 查重达标 |
| 7 | 图片粘贴反馈 | img.attach 已有；**补**：粘贴成功 toast（名称+大小） | Composer paste |
| 8 | 长文本发送确认 | **新做**：>2000 字确认（可关，存 localStorage） | Composer |
| 9 | 草稿清空撤销 | 17 轮已有 | 查重达标 |
| 10 | 输入框高度记忆 | rows 固定；**降级**（拖拽调高复杂度高） | — |

## 硬约束

- 零新依赖；app.css 只追加 §59；composer 新增 DOM 查 focus-mode 预算契约
- clipboard toast 同步派发；e2e 用 window.Event/KeyboardEvent（no-undef）
- python 替换逐段+立即 build；check:unicode；小步提交；合并 main 后 grep 检查覆盖
