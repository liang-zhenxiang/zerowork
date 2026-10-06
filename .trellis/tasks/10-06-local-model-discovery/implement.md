# 执行清单：本机模型服务探测与一键接入

> 每个阶段**闭环就提交**（`AGENTS.md`：小批量提交，一个功能闭环就提交）。
> 阶段末尾的「验证」是**门禁**，不过不进下一段。
> 主会话（调度者）负责派发与验收；实现由子 agent 完成（`.trellis/spec/workflow/index.md`）。

---

## 阶段 0：准备（主会话）

- [ ] `git checkout -b feat/local-model-discovery`（从最新 `main`）
- [ ] `python3 ./.trellis/scripts/task.py start` 激活任务
- [ ] 填 `implement.jsonl` / `check.jsonl`（给子 agent 的 spec 清单）

**验证**：`git status` 干净在分支上；`task.py current` 指向本任务。

---

## 阶段 1：daemon 纯逻辑（`local-endpoints.js`）—— 先写测试

- [ ] **先写单测** `tests/unit/local-endpoints.test.mjs`（TDD：先红后绿）
  - 候选表：每项 `id` 合法（`^[a-z][a-z0-9-]*$`）、`port` 是 1..65535 整数、**无重复**、**表里没有任何 host/url 字段**
  - `loopbackBaseUrl`：主机名恒为 `127.0.0.1`，产物形如 `http://127.0.0.1:<port>/v1`
  - `parseModelList`：正常 / 空数组 / 缺 `data` / `data` 不是数组 / `data` 项缺 `id` / 非 JSON
  - `classifyListResponse`：`ready` / `empty` / `auth-required`(401、403) / `unreachable`(其它 4xx/5xx、畸形)
  - `resolveCandidates(env)`：默认表；`ZEROWORK_LOCAL_ENDPOINTS` 覆盖端口；未知 id / 非数字 / 越界 → 回落默认且不抛错
  - `buildProviderInput`：id 合法、`baseUrl` 正确、`api: "openai-completions"`、模型字段齐全、**带占位 `apiKey`**
- [ ] 实现 `src/main/daemon/local-endpoints.js`
- [ ] **反向验证**：把 `loopbackBaseUrl` 的主机名改成 `0.0.0.0` → 有且仅有「只探回环」那条用例变红；
      回滚后全绿

**验证**：`npx vitest run tests/unit/local-endpoints.test.mjs` 全绿；反向验证已执行并记录结果。

---

## 阶段 2：模型配置写路径的 round-trip（`models.js`）

- [ ] **先写单测**：`upsertCustomProvider` 的 `apiKey` 行为
  - 传入非空 `apiKey` → 落盘条目里有它
  - 传入 `apiKey: undefined` 而**旧条目有** → **继承**（不被抹掉）
  - 传入空串 → 视为「不改」，仍然继承（与 `thinkingLevelMap` 的既有口径一致）
  - `readCustomProvider` 的返回**不含** `apiKey`
  - 完整的 round-trip：`save(带 key) → read → save(原样)`，`apiKey` 仍在，且 `isUsable` 为真
- [ ] 改 `src/main/daemon/models.js`
- [ ] **反向验证**：把「继承」那一支去掉 → round-trip 用例变红，`readCustomProvider` 相关的用例不受影响

**验证**：`npx vitest run tests/unit/` 全绿（既有 336 条一条不少）。

---

## 阶段 3：IPC 与 preload

- [ ] `src/shared/ipc.js` 加 `probeLocalEndpoints` / `connectLocalEndpoint` 两条 + 契约注释
- [ ] `src/preload/index.js` 暴露 `probeLocalEndpoints()` / `connectLocalEndpoint(candidateId, modelId)`
- [ ] `src/main/daemon/session-files.js` 两个 handler（**返回值表达失败，不 throw 预期错误**）
- [ ] `tests/unit/ipc.test.mjs` 的既有断言应自动覆盖新通道（命名规范 / 不重复 / 不与 PUSH 重叠）

**验证**：`npm test`、`npm run check:daemon-graph`、`node scripts/lint.mjs`。

---

## 阶段 4：mock 能力（给 e2e 用）

- [ ] 扩展 `tests/e2e/mock-model-server.mjs`：`GET /models` 返回 `{object:"list", data:[…]}`
- [ ] 支持两个开关：返回**空列表**、返回 **401**
- [ ] 不破坏既有 20 多个用例对它的用法（默认行为不变）

**验证**：`npm run test:gui:model`、`npm run test:gui:loop` 仍绿。

---

## 阶段 5：界面（视觉规范见 `research/design-spec.md`）

- [ ] `ModelsSection` 新增「本机模型服务」区（三态可辨 + 隐私边界一句话 + 已接入态）
- [ ] `OnboardingChecklist` 第 2 步：命中时换文案与动作；**接入成功后自己重拉一次**（§Z-3）
- [ ] 纠正 `app.js:63655` 的「本地服务可留空」（现状是错的）
- [ ] `app.css` 只加必要样式：**只用既有 token**，尽量复用既有类
- [ ] 不重排、不格式化（红线 6）；`git diff --stat` 复核改动规模

**验证**：`npm run lint:all`、`npm run build && npm run check:renderer-assets`、`npm run check:theme-tokens`。

---

## 阶段 6：e2e（真实启动 + 截图）

新增 `tests/e2e/local-model-discovery.mjs`，挂进 `package.json` 的 `test:gui` 链条：

- [ ] 起 mock 服务 → `createHarness({ name: "local-model", env: { ZEROWORK_LOCAL_ENDPOINTS: "ollama=<mockPort>" } })`
- [ ] 首页第 2 步出现「接上本机 Ollama（N 个模型）」→ 点击 → 这一步变成已完成
- [ ] **接入后真的发一条消息并收到回复**（照 `onboarding.mjs` 的 mock 用法；
      **不许只看「没报错」** —— 测试规范第 5 条）
- [ ] 设置 → 模型：命中态截图 + 像素断言
- [ ] 未起服务（或指向一个没人听的端口）时：首页文案保持现状、**页面上不出现任何错误/失败字样**（断言）
- [ ] 「探到但零模型」与「探到但要鉴权」两个状态下界面可辨（截图 + 文案断言）
- [ ] 浅色 / 深色各一张截图
- [ ] 反向验证：把 `connectLocalEndpoint` 的成功分支改成直接返回 `ok:true`（不真写配置）→
      必须有用例变红

**验证**：`npm run test:gui:local-model` 通过；`npm run test:gui` 全链条通过；
确认用例**真的在 `ci.yml` 的调用链里**（测试规范第 10 条）。

---

## 阶段 7：文档与登记

- [ ] `EXTERNAL_REQUESTS.md` 新增一节（loopback 主动请求）
- [ ] `docs/USAGE.md`：模型接入补路径；**修掉「留空即可」**
- [ ] `docs/ARCHITECTURE.md`：「设计决策与已否决方案」表补一行（占位凭据 + 被否掉的两种做法）
- [ ] `CHANGELOG.md` `[Unreleased]`：**新增**（本机模型服务）+ **修复**（占位符与文档里「留空即可」此前是错的）
- [ ] 全仓 U+FFFD 扫描（`AGENTS.md` 的命令）

---

## 阶段 8：PR

- [ ] `npm run lint:all && npm test && npm run test:gui`
- [ ] PR 正文用 `--body-file` 写；含 `Closes #<issue>`
- [ ] 创建后复核：`gh pr view <N> --json body --jq '.body | test("Closes #[0-9]+")'` → `true`
- [ ] 等 `CI 总览` 绿；`gh pr merge <N> --squash --delete-branch`
- [ ] 合并后复核 Issue 真的关了、远端真实状态

---

## 回滚点

| 点 | 回滚动作 |
| --- | --- |
| 阶段 2 之后 | `models.js` 的改动是**独立可回滚的**（只影响 `apiKey` 的透传），回滚后阶段 1 的产物仍成立 |
| 阶段 5 之后 | 界面改动集中在两处，可用 `git revert` 单提交回滚，不影响 daemon 侧能力 |
| 任何阶段 | 分支未合并前一律 `git reset --hard` 到阶段起点；**已合并的走新 PR 修复，不 force push `main`** |