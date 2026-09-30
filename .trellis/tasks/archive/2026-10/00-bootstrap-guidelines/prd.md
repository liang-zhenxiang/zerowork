# Bootstrap Guidelines（已由 10-01-trellis-integration 完成）

这是 `trellis init` 自动生成的引导任务，原意是让 AI 带着开发者**把 `.trellis/spec/`
填成本项目的真实规范**。

## 结果：已完成，但方式与模板设想的不同

模板假设的是一个 frontend/backend 分层的 Web 项目，生成的占位规范是
`hook-guidelines.md`、`state-management.md`、`database-guidelines.md` 之类。
**本项目不是这种结构** —— 它是 Electron 桌面应用，真实分层是
主进程 / daemon / 渲染层 / 共享契约 / 随包资源。

所以处置是：

1. 删除模板生成的 `spec/frontend/` 占位目录
2. 按**真实分层**重建规格，内容取自 `docs/ARCHITECTURE.md`、`docs/DESIGN.md`
   与 `AGENTS.md` 里已确立的约束（不是通用最佳实践）
3. 校验方式：手工运行 SessionStart 钩子，确认输出里列出全部 spec 索引

详见 `.trellis/spec/*/index.md` 与任务 `10-01-trellis-integration` 的 prd.md。

## 验收

- [x] 分层规范换成项目真实结构（main / daemon / renderer / shared / resources）
- [x] 每层内容有代码与行号层面的依据
- [x] 钩子能注入全部 spec 索引
- [x] `npm run check:docs` 通过
