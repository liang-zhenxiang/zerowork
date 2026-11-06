# 集成 Trellis 工作流框架

## Goal

把 [Trellis](https://github.com/mindfold-ai/Trellis) 接入本仓库，让**任务、分层规范、
跨会话记忆**有结构化的载体；并与既有的 `AGENTS.md`、两个项目级 skill **融合**，
消除规则分叉 —— 目标状态是「新开一个会话，不必调用任何 skill 就知道这个项目怎么开发」。

## 背景（为什么做）

当前规则只存在于 `AGENTS.md` 与两个 skill 里，解决了「规则自动加载」，
但没解决三件事：

1. **任务上下文散落**：一轮迭代的 PRD、调研、决策散在 Issue 与对话里，
   对话被压缩后就丢了，下次接手要从头问一遍
2. **规范无法分层**：`AGENTS.md` 是一份大文件，改 `daemon/` 与改 `renderer/`
   需要的约束不同，却只能读同一份
3. **没有跨会话记忆**：每轮做过什么、学到什么，没有沉淀载体

## Requirements

- R1 执行 `trellis init --claude` 并把 `.trellis/` 提交进仓库
- R2 **`AGENTS.md` 的既有内容一字不改** —— Trellis 用托管块追加，块外内容原样保留
- R3 `.trellis/spec/` **必须是本项目的真实分层**，不是模板默认的 `frontend/` / `backend/`
- R4 明确 `AGENTS.md`（仓库怎么操作）与 Trellis（任务怎么做完）的**分工**，写进两处
- R5 本机开发身份取自 **git 用户名**，且该文件不进库
- R6 两个既有 skill 说明与 Trellis 的关系，避免规则分叉

## Acceptance Criteria

- [ ] `.trellis/` 已提交，`.trellis/.developer` 与 `.runtime/` **未**提交
- [ ] `git diff` 显示 `AGENTS.md` 的既有内容**只有追加、没有修改**
- [ ] `.trellis/spec/` 下是按 `main` / `daemon` / `renderer` / `shared` / `resources` 分的真实层
- [ ] 手工运行 SessionStart 钩子，输出里能看到**全部 spec 索引**
- [ ] `npm run check:docs` 通过（spec 索引已纳入链接校验）
- [ ] 两个 skill 与 `AGENTS.md` 都写明了两套规则的分工
- [ ] 全仓扫描无 U+FFFD

## 约束

- **不改变任何应用行为** —— 这是工程基建改动，不碰 `src/`
- 不引入需要联网才能工作的构建步骤
- `trellis update` 可能重新生成托管文件；本项目**手写的** spec 与 workflow 叠加节
  要保留，这一点写进文档

## 非目标

- 不为其他 AI 平台（Cursor / Codex / Gemini…）生成配置。本次只做 Claude Code；
  将来要加时用 `trellis update --<platform>` 即可

## Notes

- Trellis 版本：0.6.17（`@mindfoldhq/trellis`）
- 授权：AGPL-3.0。**它是开发工具，不是本项目分发的依赖** ——
  不进入 `package.json` 的 dependencies，也不随安装包分发
