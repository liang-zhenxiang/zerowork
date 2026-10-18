# PRD:交差报告的 e2e 改用 mock 端点,并进 CI

## 背景(为什么做)

「值守」合入后(PR #209),**交差报告在真实界面里的渲染**只在
`tests/e2e/watch-policy.mjs` 里被断言(越界徽标、「越界叫停」而不是「失败」、
证人行、老记录兜底)。而那条 e2e **依赖本机真实模型端点**
(`~/.claude/settings.json` → `ANTHROPIC_BASE_URL`),因此按仓库惯例
(`.trellis/spec/testing/index.md` §七)不进 `test:gui` 链、**CI 上没有信号**。

进 CI 的只有它的相邻层:

| 覆盖对象 | 在哪 |
| --- | --- |
| 规矩求值、收敛、证人上限等纯逻辑 | `tests/unit/watch-policy.test.mjs` |
| 报告的六态判定与文案 | `tests/unit/watch-report-core.test.mjs` |
| 表单四组控件 + 与全局档位的关系 | `tests/e2e/gui-sections.mjs` |
| 规矩的存取往返、非法输入被拒 | `tests/e2e/local-state.mjs` |

于是「**纯逻辑对了、渲染层没接上**」这一类 CI 拦不住 —— 而这正是本项目
反复记录过的形态(widget-render、IPC 功能层、资料库「模型返回对了但界面没接上」)。

**同时它造成一个安全告警的长期来源**:读本机凭据再发往该端点,触发 3 条
`js/file-access-to-http`(CodeQL)。`main` 上同类告警已有 6 条(另两个脚本),
每次碰到 `required_conversation_resolution` 都要判断一次。

## 期望(做什么)

把 `tests/e2e/watch-policy.mjs` **改成 mock 端点 + 真实 Electron**:

- [ ] 用 `tests/e2e/file-history.mjs` 同款的本地 mock 模型服务(OpenAI 兼容),
      按轮次返回 `tool_calls`,**不需要任何本机凭据**
- [ ] 保留现有的整链路断言:建带规矩的任务 → 手动触发 → 范围外/只读的写被拒
      → 运行记录带 `boundary` → **界面上的报告真的渲染出来**(徽标 / 结论句 / 证人行)
- [ ] 删掉 `readEndpoint` / `probeEndpoint` / `SETTINGS` / 全部 `h.skip` 分支 ——
      端点不再是前置条件
- [ ] 脚本改名/改号后挂进 `test:gui` 链(`test:e2e` 里那条保留,或随之调整)
- [ ] 跑完后 `js/file-access-to-http` 的 3 条告警应当消失(不再读凭据发请求)

## 验收标准

- [ ] `npm run test:gui:watch` 在**没有任何本机凭据**的环境下全绿
      (用一个空的 `HOME` 或临时 `ZEROWORK_CONFIG_DIR` 证明不读 `~/.claude/settings.json`)
- [ ] 该脚本已进 `test:gui` 链,`npm run test:gui:sections` 与它一并通过
- [ ] 断言**不弱于现状**:现有 4 个语义断言(只读被拒 / 证人 / 界面徽标 / 范围)一条不少,
      另加「无需凭据」这条新的可证伪断言
- [ ] 反向验证:注掉「界面渲染报告」那一段 → 恰好相关断言变红 → 还原复绿
- [ ] `npm run lint:all`、`npm run test`、`npm run test:gui` 全绿
- [ ] 更新 `.trellis/spec/testing/index.md` §七「已知限制」:脚本数 7 → 6,
      并注明交差报告已进 CI

## 非目标

- 不改 `watch-policy.js` / `watch-report-core.js` 的任何判定逻辑(这是测试基建)
- 不改渲染层的界面(同)
- 不顺手迁移其他 6 个依赖本机端点的脚本(那是另一件事,单独排期)

## 入手位置

- `tests/e2e/watch-policy.mjs` —— 主体重写(照 `tests/e2e/file-history.mjs`)
- `package.json` —— `test:gui:watch` 进 `test:gui` 链
- `.trellis/spec/testing/index.md` §七 —— 更新已知限制

## 难度

中偏低。mock 服务与真实 Electron 的骨架在 `file-history.mjs` 里已经现成,
主要工作是**把现有断言的语义平移过去**,以及把「等运行记录落盘」换成
「等 mock 收到第 N 轮请求」这类**信号等待**(不是固定 sleep)。
