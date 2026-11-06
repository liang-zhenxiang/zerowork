# 让 h.check 内部的 h.skip 真正跳过

## 问题（Issue #64）

在 `h.check(...)` 的**回调内部**调用 `h.skip(...)` 再 `return` 时，
那一条 check **仍然会被记成 PASS** —— 报告里同时出现 `[PASS]` 与 `[SKIP]`，
而实际上**一条断言都没跑**。

`command-exec.mjs` 的 check A 在 Windows 上就是这个形态。

## 为什么必须修

#60 刚给 harness 加了「**一条都没通过 → 退出码 2（无信号）**」，目的就是让
「跑了但什么都没验」在门禁上读得出来。但这一条会**记成 PASS**，
**恰好把那个信号抵消掉** —— 它绕过了刚建立的那道防线。

## 根因（是**缺一个语义**，不是谁写错了）

`h.check(name, fn)` 的语义是「fn 不抛异常就算过」。`h.skip()` 只往 results 里
追加一条 SKIP，**并不改变外层 check 的结论**。所以「在 check 里跳过」这件事
在当前的 API 下**表达不出来**。

## Requirements

- R1 给 harness 补一个语义，让「这条 check 被跳过」能**替代**它的 PASS，而不是并列。
  可能的形式（选一个并说明理由）：
  - `h.skip()` 抛出一个**哨兵**，由 `h.check` 捕获并把它改记为 SKIP
  - 或提供 `h.maybeSkip(条件, 原因)` 之类的入口
- R2 判定「无信号」时，被跳过的 check **不计入 passed**
- R3 **用测试钉住** —— 这是 #60 那条防线的延伸，必须有回归测试
- R4 顺带排查：还有哪些用例在 `h.check` 内部 `h.skip` + `return`，一并改过来

## Acceptance Criteria

- [ ] 「在 check 里跳过」时，那一条**只记 SKIP、不记 PASS**
- [ ] 一个「所有 check 都被跳过」的文件 → **退出码 2**（而不是 0）
- [ ] 现有行为不回退：正常 check 仍记 PASS，`h.skip` 在 check **外面**调用时行为不变
- [ ] 反向验证真做（破坏新语义 → 必须变红）
- [ ] `npm run lint:all` 全过

## 约束

- 主要改 `tests/e2e/lib/harness.mjs`，以及排查出的调用点
- **不改产品代码**、不动 `resources/**`
- 现有 e2e 用例的**断言不得削弱**（这是「补语义」，不是「改判定」）

## 难度

小。改一个语义 + 加回归测试。
