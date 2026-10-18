# 技术设计:交差报告的 e2e 改用 mock 端点

## 1. 为什么可行(前提核实)

交差报告需要的是**一条带 `boundary` 的运行记录**,而 `boundary` 由
`createAutomationRunExecutor` 在 run 结束时写入 —— 它的来源是:

- **越界证人**:权限门的 `tool_call` 钩子(与模型无关,任何模型都能触发)
- **`timedOut` / `timeoutMinutes`**:executor 自己的定时器
- **`readOnlyEnforced` / `scoped` / `stopOnExceed`**:任务声明的规矩(与模型无关)
- **`changedFiles`**:版本存储按 run 的 `sessionId` 反查(与模型无关)

模型在这里只做一件事:**发起一次会被规矩拦下的工具调用**。mock 服务完全可以
按轮次返回 `tool_calls`,与 `file-history.mjs` 用 mock 触发三次 `write` 是同一形态。

> 实测依据:PR #209 修掉的三个缺陷里,「范围判定跑在路径折算之前」与
> 「清空规矩清不掉」都是**纯逻辑层**的;而「越界证人」这条链路是
> `tool_call` 钩子 → `onExceeded` → `boundary` —— 全程不经过模型输出内容。

## 2. mock 剧本

照 `file-history.mjs` 的「数 `role:"tool"` 条数」写法(数请求数会把「工具结果没回传」
误判成下一轮):

```
第 1 轮(tool 条数 = 0): 返回 tool_call write { path: "src/app.js", content: "..." }
第 2 轮(tool 条数 ≥ 1): 返回最终文本「完成」
```

- `tool_calls.id` **跨轮唯一**(live 视图按 id 整卡替换,复用会顶掉前一张卡)
- 只读任务:同一条剧本 —— 写入被规矩拦下,模型收到拒绝后回最终文本
- 范围任务:两条 tool_call(范围内 `reports/inside.txt` 放行、范围外 `outside.txt` 被拒)

## 3. 等待策略(不用固定 sleep)

| 要等的东西 | 判据 |
| --- | --- |
| mock 收到第 N 轮 | `mock.requests.length >= N` |
| 运行记录落盘 | `listAutomations()` 里该任务的 `runs.length > 0` |
| 界面报告展开 | 先等 `.auto-row-expand[aria-expanded=true]`,再等 `.auto-run-fold[aria-expanded=true]`(**分两次 evaluate** —— React 批处理,同一事件里点两下读到的是上一帧。这条是原文件里踩过的坑,保留注释) |
| 报告内容出现 | `.run-report-line` 的文本非空、`.auto-run-badge` 存在 |

## 4. 断言平移(不弱化)

现有 4 条语义断言,一条不少:

1. **只读任务里的写入被拒,且运行记录留下越界证人**
   - `run.boundary.exceeded.length > 0`、`tool` 非空、`detail` 含「只读」
   - **副作用**:`existsSync(join(WORKSPACE_DIR, "watch-probe.txt")) === false`
2. **界面报告徽标是「越界叫停」而不是「失败」**
   - 徽标非空且 ≠「失败」、报告文本非空
3. **范围限定:范围外被拒、范围内放行**
   - `reports/inside.txt` 存在、`outside.txt` 不存在
4. **任务清理干净**

**新增一条**(可证伪):**不读本机凭据** ——
脚本不再出现 `~/.claude/settings.json`;并用一个**指向不存在路径的 `HOME`**
跑一遍,证明它根本不依赖那个文件(静态断言 + 运行时断言各一条)。

## 5. 进 CI

`package.json` 的 `test:gui` 链里插入 `npm run test:gui:watch`。
插入位置:紧跟在 `test:gui:auto`(自动化)之后 —— 它们测的是同一个功能区。

> 为什么不放 `test:e2e`:`test:e2e` **没有任何 workflow 调用**(查过全部
> `.github/workflows/*.yml`,只有 `test`、`test:gui`、`test:gui:model`、
> `test:gui:loop`)。挂在那里等于没有 CI 信号 —— 这正是本 issue 要修的病。

## 6. 告警

脚本不再读 `~/.claude/settings.json`、不再把文件内容发往外部请求,
`js/file-access-to-http` 的三条告警应随之消失。**不手工点掉告警** ——
让它因为「问题真的不存在了」而自动关闭(CodeQL 下一次分析会标记为 fixed)。

## 7. 风险

| 风险 | 对策 |
| --- | --- |
| mock 剧本与真实模型行为差异,导致「真实场景下不成立」 | 这里验的是**规矩与报告链路**,不是模型能力;`file-history.mjs` 用同一手法且已进 CI 稳定运行 |
| 自动化任务跑起来比固定等待慢 | 全部用信号等待,不用 sleep |
| 进 CI 后 GUI 链变长 | 该用例本身的耗时与 `file-history` 同量级(约 20-40s);可接受 |
