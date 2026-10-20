# 执行清单

## 1. mock 侧（`tests/e2e/mock-model-server.mjs`）

- [ ] `send()` 记录 `{ at: performance.now(), kind, text }` 到 `sendTimes`
- [ ] `kind` 区分 `role` / `content` / `terminal`，让测试能只取正文片
- [ ] 把 `sendTimes` 挂到 `startMockModelServer` 的返回值上
- [ ] 文件头注释补一句：账本里多了发送时刻，供断言避免墙钟抖动
- [ ] 单独导出一条 `close()` 之外的读取方式？不需要，数组是活的

## 2. 用例侧（`tests/unit/mock-model-server.test.mjs`）

- [ ] 重写 `delayMs` 那条用例：
  - `delayMs: 300` 那台：取正文章，断言相邻间隔 `>= 270`（300×0.9）
  - 默认那台：断言相邻间隔 `< 100`（300/3）
  - 首片：`delayMs` 那台首个正文片相对请求开始 `< 150`
  - `delayMs: 300` 那台正文章数 `>= 2`（空样本显式失败）
  - 网络层仍收到 ≥2 个非空 content
- [ ] 保留原用例的意图注释，改写成「为什么不再测墙钟」

## 3. 验证

- [ ] `npx vitest run tests/unit/mock-model-server.test.mjs`
- [ ] 32 并发压测脚本跑 30 轮（用 /tmp 下的脚本模拟，不进仓库）
- [ ] 全量 `npx vitest run` 连跑 30 次
- [ ] `npm run lint:all`（zizmor 需 Docker）
- [ ] 反向验证 3 条（见 design.md）

## 4. 文档

- [ ] `.trellis/spec/testing/index.md` 第五节补第 7 条：不要用墙钟差断言服务端行为
- [ ] `docs/MAINTAINER_GUIDE.md` 四条硬要求 → 五条
- [ ] `CONTRIBUTING.md` 三个陷阱 → 四个
- [ ] `CHANGELOG.md` `[Unreleased]` 记一条
