@AGENTS.md

## Claude Code 专属说明

**本仓库的规则全部在 [`AGENTS.md`](AGENTS.md)**，上面那一行把它导入了。
本文件刻意保持这么短 —— 规则只有一份，改动才不会漂移。

### 为什么是「导入」而不是软链

Claude Code 官方给过两种共享写法（`@AGENTS.md` 导入，或 `ln -s AGENTS.md CLAUDE.md`），
**本项目用导入**，因为软链在这里有一条硬伤：

> **Windows 上创建软链需要管理员权限或开启开发者模式**；而且除非开启 `core.symlinks`，
> git 会把提交的软链检出成一个**普通文本文件**（内容只有一行路径），
> 克隆下来的人只会得到一个坏的 `CLAUDE.md`。

本项目的完整支持平台就是 Windows（见 README 的「平台支持」），所以这条不能赌。

### 三条机制上的注意（写给后来者）

1. **不要在本仓库添加 `CLAUDE.local.md`。** Claude Code 的规则是：工作目录**或其任意祖先目录**
   存在 `CLAUDE.md` / `.claude/CLAUDE.md` / `CLAUDE.local.md` 时，它会**转而忽略 `AGENTS.md`** ——
   除非那个 `CLAUDE.md` 像本文件这样用 `@AGENTS.md` 显式导入。
   个人偏好请放到 `~/.claude/` 下的用户级文件里（那层不占位）。
2. **「自动加载」不是无条件的。** 本文件的存在使 `AGENTS.md` **必然**被加载（通过导入）；
   而如果哪天有人删掉本文件，`AGENTS.md` 依然会被原生加载 —— 两者只要有一个在，
   规则就在上下文里。**不要**把规则挪进别处再用一句「请去读 AGENTS.md」的文字引用 ——
   那样 Claude 只有在自己决定打开那个文件时才会看到它。
3. **规则改了改两处**：`AGENTS.md`（速查版）与 `docs/MAINTAINER_GUIDE.md`（细节来源）。

### 怎么确认它生效了

- 会话里跑 `/context`，在 **Memory files** 一栏里应当能看到 `CLAUDE.md` 与 `AGENTS.md`
- `/memory` 会列出所有记忆文件的位置
- 交互式启动时若只加载了 `AGENTS.md`，会打印一行
  `no CLAUDE.md found; AGENTS.md loaded: …` —— 那是正常的，不代表本文件没用
