# mock-model-server 的 delayMs 用例不再按墙钟差断言

对应 Issue：[#226](https://github.com/liang-zhenxiang/zerowork/issues/226)

## 背景

`tests/unit/mock-model-server.test.mjs` 的 `delayMs` 用例断言「慢的那台至少比快的那台
多用 250ms」：

```js
expect(slowMs - fastMs).toBeGreaterThanOrEqual(250);
```

2026-10-20 并行全量 `npx vitest run` 连跑时，**两个独立会话各撞到一次**
`expected 243 to be greater than or equal to 250`。单独跑该文件 15 次全绿 ——
是负载相关的计时抖动。

它与刚修完的 #225 是同一家族：间歇性、且失败信息指向被断言的对象
（「delayMs 没生效」），而真因是 worker 争抢 CPU。区别在于这条是**真等待但预算不够**
（`check-wait-predicates` 按设计覆盖不到），不能靠那条门禁拦住。

## 测量结论（决定方案前的实验，32 并发压测）

| 断言形态 | 负载下实测 | 相对阈值的余量 |
| --- | --- | --- |
| 现状：两次墙钟相减 ≥ 250 | slow − fast 下限 **276ms** | 26ms，会缩水到失败 |
| 响应内首片→末片 span | 282–286ms | 36ms |
| 慢的那台绝对耗时 | 359–366ms | 59ms（但仍依赖墙钟） |

三种都在**用墙钟近似一个服务端行为**。只要测量点落在测试进程里，就迟早会被负载撞穿。

## 需求

断言的对象从「测试进程量到的时间差」换成「**mock 服务端自己记录的发送时刻**」：

1. mock 在每片 `res.write` 时记录时刻（`sendTimes`），与既有 `requests` /
   `probeRequests` 账本同一风格，默认不影响任何既有行为。
2. 断言改为：
   - `delayMs` 生效时，服务端**相邻正文片**的间隔 `>= delayMs * 0.9`
     —— 单调安全：机器慢只会让间隔**更大**
   - 未开 `delayMs` 时，相邻正文片间隔**显著小于**开了的那台（相对比较，不依赖绝对值）
   - 第一片不等待：`delayMs` 那台的首个正文片与请求开始时刻的间隔远小于 `delayMs`
3. 保留「流式真的分片了」的端到端证据：网络层确实收到了多个 `delta.content`。

## 约束

- 不改动 e2e / 既有用例的行为。`sendTimes` 是纯增量字段。
- **不接受**删掉断言，也**不接受**把阈值放宽到「必然成立」——那等于让它在
  `delayMs` 真的失效时也绿。
- 不再用 `Date.now()` 相减作为**主**判据。

## 验收标准

- [ ] `delayMs` 真的失效（比如把 `if (index > 0 && delayMs > 0)` 的 sleep 删掉）时，
      用例必须变红 —— 反向验证
- [ ] 32 并发负载下连跑 30 次全量，该用例不再出现间歇红
- [ ] `npx vitest run tests/unit/mock-model-server.test.mjs` 全绿
- [ ] `npm run lint:all` 通过（zizmor 需 Docker，已知例外）

## 难度

低–中。改动集中在 mock 与一条用例，难点在**验证**：要造出足够的并发才说明抖动消失。
