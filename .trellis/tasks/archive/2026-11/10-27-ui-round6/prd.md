# PRD · 第六轮十连——会话体验与信息密度

issue #290 · 分支 feat/ui-round6 · 2026-10-27

## 十项

1. 消息锚点链接（hover # 复制深链 sessionPath#entryId）
2. 引用回复（>> 前缀弹选择器）
3. 会话内目录 outline（右侧迷你地图）
4. 输入框 token 实时计数
5. 会话健康度圆点（呼吸/红/绿）
6. 代码块折叠（>20 行默认折叠）
7. 快速回复模板 chips
8. 消息时间线标尺
9. 单条消息导出卡片 PNG
10. 段落渐入（替代逐字打字机）

## 硬约束

- 零新依赖；app.css 只在末尾追加 §23；手写 createElement（无 JSX）
- hooks 必须在组件体顶层（第五轮 §20 坑）
- e2e 种子会话用嵌套 message 格式 + assistant 带 model（第五轮 §20 坑）
- 每项至少 1 张真实 Electron 截图；CHANGELOG + DESIGN.md §21
