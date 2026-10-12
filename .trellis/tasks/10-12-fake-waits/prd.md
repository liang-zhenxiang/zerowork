# 全仓排查 waitUntil 的「假等待」（#150）

## 背景

`waitUntil` 的判据是 `if (value) return value`（`tests/e2e/lib/harness.mjs`），于是
**谓词返回对象字面量 = 恒真** —— 那个「等待」只轮询一次就返回，`timeout` 一毫秒都不参与，
而写法读起来完全像一个正常的信号等待。

这个形态在仓库里出现过至少三次：`gui-updates`（#114）、`gui-formula`（#149）、
`gui-space-pin`（#150）。每次红灯指向的都是**被断言的副作用**（「公式缺 MathML」「组数不足」），
不是等待本身 —— 它会让人去查一个不存在的问题。Issue 的诉求是「修一处、等下一次」这个循环停下来。

## 决定：把「那句判断」机械化，而不是再人工扫一遍

Issue 的判断方法是人眼版的：「把谓词单独拿出来问一句『它什么时候返回假？』」。
247 个调用点靠肉眼扫，正是过去三次漏掉它的原因，所以本轮把它做成静态检查
（`tools/check-wait-predicates.mjs`）：

> 取谓词**所有**返回路径，问「有没有任何一条**可能**交出假值」？一条都没有 → 报假等待。

判定刻意保守：比较、`!x`、成员访问、变量、函数调用、条件/逻辑表达式的一侧可能为假 → 一律放过；
`win.evaluate(cb)` 钻进回调再算一遍；**判不出来的一律不报**（列成「需人工确认」）。
于是已知的好写法（Issue 里那两个「✓」）不在射程内 —— 误报会逼出「抑制注释」，
那条路一旦开了，门禁就开始腐烂。

## 期望

- [x] 每一个 `waitUntil` 调用点都被**逐个**过了一遍，并给出「未就绪时返回什么」的结论
- [x] 确认为假等待的改掉（本轮 1 处，正是 Issue 点名的 `gui-space-pin`）
- [x] 一处都没借机削弱断言；超时路径的现场**补**进错误信息
- [x] 每条改动做反向验证（三份证据见 `research/wait-audit.md`）
- [x] `waitUntil` 交出的对象里，「闸门字段」与「断言载荷」分开命名（`ready` vs 数据字段）
- [x] 方法与结论沉淀进 `.trellis/spec/testing/index.md` §三.1，**含门禁的盲区**

## 审计记录

见 `research/wait-audit.md`：247 个调用点、5 处「判不了」逐个核实（都是布尔比较，不动）、
1 处真阳性（已修）、反向验证三份证据、判定器的盲区、以及**不处理**的另一类
（真等待但预算不够：`compare-keep` ⑨/⑩ —— 本轮不顺手放宽任何 timeout）。

## 入手位置

- `tools/check-wait-predicates.mjs`（新增判定器）
- `tests/e2e/gui-space-pin.mjs`（唯一改动的调用点）
- `tests/unit/wait-predicates.test.mjs`（门禁自己的单测）
- `.trellis/spec/testing/index.md` §三.1、`scripts/lint.mjs`、`.github/workflows/ci.yml`

## 难度

中。工具与判据都是现成的，成本在「逐个读、并且不把好写法改坏」的耐心上。
