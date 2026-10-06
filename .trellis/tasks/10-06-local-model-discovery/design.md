# 技术设计：本机模型服务探测与一键接入

> 事实依据全部来自 `research/model-access.md`（逐条带 `file:line`）与
> 本文件的「设计决策」一节（每条都写了**被否掉的方案**，照 `docs/ARCHITECTURE.md` 的规矩）。
> 视觉规范见 `research/design-spec.md`。

---

## 一、边界

### 做什么

1. **探测**：按一张**写死的候选表**，并发请求本机回环地址上的 `{baseUrl}/models`，
   把结果归类成可展示的形状
2. **接入**：把探测结果转成一个合法的自定义服务商 + 选中一个模型，**复用既有写路径**
3. **接线**：首页上手清单第 2 步、设置 → 模型 页各加一处入口
4. **修两处既有缺陷**（探测过程中实测发现的，与本功能直接相邻）

### 不做什么

- 不下载任何东西、不装 Ollama、不做端口范围扫描、不探非回环地址
- 不新建写模型配置的路径（`saveCustomProvider` 之外不另开一条）
- 不改权限判定、不改沙箱

---

## 二、关键机制与已核实的事实

### 2.1 探测：一个统一形状覆盖全部候选

所有候选服务都提供 **OpenAI 兼容的 `GET {base}/models`**：

```json
{ "object": "list", "data": [ { "id": "qwen2.5:7b" }, ... ] }
```

- Ollama：`http://127.0.0.1:11434/v1/models`（OpenAI 兼容层；另有原生 `/api/tags`，**不用它** —— 两套形状意味着两套解析，收益不抵成本）
- LM Studio `1234`、vLLM `8000`、LocalAI `8080`、Jan `1337` 同形状

**因此候选表的每一项只需要 `{ id, label, port }`**，探测逻辑只有一条：
`GET http://127.0.0.1:{port}/v1/models`。这消掉了「每个服务一套解析」的复杂度。

### 2.2 归类：四态，且必须可辨

`GET /v1/models` 的返回按下列**互斥**规则归类（`docs/DESIGN.md` §4 的同族纪律：
「加载中 / 真空 / 错误」不许混为一谈）：

| 状态 | 判据 | 界面含义 |
| --- | --- | --- |
| `ready` | 2xx 且 `data` 是**非空**数组 | 探到了，可一键接入 |
| `empty` | 2xx 且 `data` 是**空**数组 | 探到了服务，但它一个模型都没有 → 给「去它的界面里拉一个模型」的指引，**不是错误** |
| `auth-required` | 401 / 403 | 探到了服务，但它要鉴权 → 走手工添加模型的路径（本功能不碰密钥） |
| `unreachable` | 连接被拒 / 超时 / 非 2xx 其它 / 响应不是 JSON / 形状不对 | **安静地不显示**（设置页里收在一句话之后） |

> `unreachable` 是**预期内的常态**：绝大多数用户没装本机服务。
> 它在界面上**不得**呈现为错误、不得出现红叉、不得计入任何「失败」计数。

### 2.3 【硬阻塞，已实测】不带凭据的服务商，其模型**不可用**

三轮实测（`research/model-access.md` §Z-1，本文件作者独立复现过一次）：

| `models.json` 条目 | `getProviderAuthStatus()` | 模型的 `available` | `isUsable()` |
| --- | --- | --- | --- |
| `baseUrl`/`api`/`models` 齐全，**无凭据** | `{configured:false}` | `false` | **false** |
| 同上 + `auth.json` 里有键 | `{configured:true,"stored"}` | `true` | true |
| 同上 + 条目里写 **`apiKey` 字段** | `{configured:true,"models_json_key"}` | `true` | true |

而 `INVOKE.setModel` 的第一道门就是 `isUsable`（`src/main/daemon/session-files.js:4355` 附近），
不带凭据会直接抛「该模型不可用：请先为其服务商配置 API Key」。

**结论：一键接入必须写入一个占位凭据，否则功能等于没做。**

> 这同时暴露了两句**现在就是错的**文案（与本任务无关也该修）：
> `src/renderer/src/app.js:63655` 的自定义表单占位符「本地服务可留空」、
> `docs/USAGE.md:109` 的「本地端点通常不需要 Key，留空即可」。
> 照着做的人会得到一个**选不中**的模型。

### 2.4 占位凭据写哪儿：**写进 `models.json` 条目**，不写 `auth.json`

| 方案 | 结论 | 理由 |
| --- | --- | --- |
| **①（采用）** `models.json` 条目加 `apiKey` 字段（pi 对 Ollama 的**官方文档写法**：`node_modules/@earendil-works/pi-coding-agent/docs/models.md:52-58`） | ✅ | 生命周期跟着服务商条目走（删服务商即删占位）；占用的是**配置**文件而不是凭据库；不会在 `auth.json` 里留一条「不是密钥的东西」 |
| ② 写进 `auth.json`（`saveCustomProvider(input, "<占位>")` 的第二参数） | ❌ 否掉 | 会把一个假凭据放进**凭据库**；且 `deleteCustomProvider` 只调 `runtime.removeRuntimeApiKey`、**没有**调文件级 `removeApiKey`（`src/main/daemon/model-catalog.js:146-150` 对比 `:99-104`），删服务商后占位会变成孤儿残留在 `auth.json` |
| ③ 放宽 `isUsable`（本机服务免凭据） | ❌ 否掉 | 直接违反「宁可拒绝，也不静默降级」：`isUsable` 是「换了会报错的模型」的唯一守卫，放宽它会让用户能选到真跑不通的服务商 |

### 2.5 【连带】`upsertCustomProvider` 的白名单会**丢掉 `apiKey`** —— 必须一起修

`src/main/daemon/models.js:93-114` 是**白名单重建**：只搬
`x-zerowork` / `name` / `baseUrl` / `api` / `models` / `authHeader` / `compat`。
`apiKey` 不在其中，`readCustomProvider`（`models.js:520-556`）**也不回填它**。

后果（如果我们按 2.4 走而不修这里）：一键接入写好占位 → 用户之后在设置页**编辑**这个服务商、
或**再加一个模型**后保存 → 占位被静默抹掉 → **模型又变成选不中**，而且没有任何提示。

修法（最小改动、不改变既有语义）：

- `upsertCustomProvider`：`input.apiKey` 是**非空字符串**时写入 `entry.apiKey`；
  **否则原样继承** `existing?.apiKey`（键不在输入里 = 「不改」，与 `thinkingLevelMap` 的既有口径一致，`models.js:57-65`）
- `readCustomProvider`：**不新增 `apiKey` 字段**。渲染层拿不到它，`app.js` 的表单也就不可能把它带回来 ——
  「继承」全在 daemon 侧完成，**不把凭据暴露给渲染进程**
- `app.js` 的自定义表单**不感知**这件事，无需改动

> 这同时修掉一个既有缺陷：一个按上游文档手写 `apiKey` 的用户，只要该条目被本应用认领过，
> 编辑一次就丢配置。

### 2.6 首页清单不会自己刷新（`research/model-access.md` §Z-3）

`OnboardingChecklist` 只在**挂载**与 **cwd 变化**时拉数据（`app.js:15207-15221`），
没有任何「模型配置变了」的推送通道。**一键接入之后必须由组件自己重拉一次**，
否则「点完这一步变成已完成」不会发生。

---

## 三、模块与契约

### 3.1 新模块 `src/main/daemon/local-endpoints.js`

**纯函数为主**，网络只有一处、且可注入 `fetchImpl`（照 `probeModel` 的既有范式）。

```js
// 候选表：只含回环 + 端口 + 展示名。每项必须在注释里写明出处。
const LOCAL_ENDPOINT_CANDIDATES = [
  { id: "ollama",   label: "Ollama",   port: 11434, note: "Ollama 的 OpenAI 兼容层" },
  { id: "lmstudio", label: "LM Studio", port: 1234 },
  { id: "vllm",     label: "vLLM",     port: 8000 },
  { id: "localai",  label: "LocalAI",  port: 8080 },
  { id: "jan",      label: "Jan",      port: 1337 },
];

resolveCandidates(env)        // 支持 ZEROWORK_LOCAL_ENDPOINTS 覆盖（形态见 §3.4），并做校验
loopbackBaseUrl(port)         // `http://127.0.0.1:${port}/v1` —— 主机名写死，不从外部拼
parseModelList(payload)       // → { ok:true, models:[{id,name}] } | { ok:false, reason }
classifyListResponse(status, payload)  // → "ready" | "empty" | "auth-required" | "unreachable"
buildProviderInput(candidate, models)  // → saveCustomProvider 的入参（含占位 apiKey 与 providerId）
providerIdFor(candidate)      // → 稳定、合法（^[a-z][a-z0-9-]*$）、不与内置冲突的 id
listEndpointModels({ baseUrl, timeoutMs, fetchImpl })  // 唯一发请求的地方
probeLocalEndpoints({ candidates, timeoutMs, fetchImpl })  // 并发 + 总超时上限
```

**硬约束（由单测钉住）**：

- 只允许 `127.0.0.1`：`loopbackBaseUrl` 是**唯一**构造地址的地方，主机名字面量写死；
  候选表里**不允许**出现 host 字段（没有字段就没有「填个域名进去」的可能）
- 端口必须是 1..65535 的整数
- **不遍历端口区间**：只探 `resolveCandidates()` 返回的那几项

### 3.2 IPC 契约

在 `src/shared/ipc.js` 登记两条（命名照既有 `/^[a-z-]+:[a-z-]+$/`）：

| 常量 | 值 | 入参 | 返回 |
| --- | --- | --- | --- |
| `probeLocalEndpoints` | `settings:probe-local-endpoints` | 无 | `{ candidates: Array<{id,label,baseUrl,state,models,detail?}>, probeErrors? }` |
| `connectLocalEndpoint` | `settings:connect-local-endpoint` | `[candidateId, modelId]` | `{ ok:true, providerId, modelKey } \| { ok:false, error }` |

**恪守既有约定：可预期的失败用返回值表达，不用 throw**
（`session-files.js:4433-4439` 的成文说明：throw 会被 IPC 层裹成通用文案，丢掉归类后的原因）。

`connectLocalEndpoint` 的步骤：
1. 从候选表解析 `candidateId` 与 `modelId`（**只接受候选表里的 id**，防止渲染层塞任意 baseUrl 进来）
2. `getCatalog().saveCustomProvider(buildProviderInput(...))`（**复用既有写路径**）
3. `catalog.isUsable(modelKey)` 复核 —— 不成立就如实报错（**不静默成功**）
4. 走既有的 `setModel` 语义把 `activeModelKey` 落盘并同步当前会话
5. 任一步失败 → `{ ok:false, error }`，错误里带上是**哪一步**失败的

### 3.3 渲染层

| 位置 | 改动 |
| --- | --- |
| `OnboardingChecklist`（`app.js:15195`） | 第 2 步未完成时，**异步探一次本机服务**；命中则文案与按钮变成「接上本机 X（N 个模型）」，点击 = `connectLocalEndpoint` → 成功后 `load()` 重拉；未命中/探测中 = 现状文案 |
| `ModelsSection`（`app.js:64213`） | 「服务商」区之下新增一区（照 `settings-section` 骨架），列出探测结果；未命中的候选折叠在一句话之后；已接入的显示已接入态；区块末行写隐私边界 |
| 探针结果缓存 | **不缓存**：两处各自在需要时探一次（探测很便宜，缓存会引入「界面显示的是旧状态」这类问题） |

**判据函数不动**：`judgeModelReadiness`（`app.js:15159`）与 `guideText`（`app.js:15165`）保持原样 ——
接入成功后 `activeModelKey` 变了、`available` 为真，判据自然转成 `ready`。**不新造状态。**

### 3.4 可测性：候选表必须可注入

e2e 无法监听固定端口 11434（可能被真 Ollama 占用，也不能假定 CI 机器上没有）。

**`ZEROWORK_LOCAL_ENDPOINTS`** —— 逗号分隔的 `id=port` 列表，覆盖候选表的**端口**（不新增/删除候选，也不允许改主机名）：

```
ZEROWORK_LOCAL_ENDPOINTS=ollama=51234
```

- 只覆盖端口 → 「只探回环、只探固定几项」这条性质**不因为注入而失效**
- 未知 id、非数字、越界端口 → **忽略该项并回落到默认端口**，不抛错（可诊断的降级，不是静默）
- 仓库已有 `ZEROWORK_*` 注入先例（`ZEROWORK_UPDATE_FEED`，`tests/e2e/gui-updates.mjs:76`），
  且 `createHarness({ name, env })` 就是干这个的（`tests/e2e/lib/harness.mjs:404-417`）
- ⚠️ `npm run check:docs` 反向只查「文档写了、代码没读」——这条会进文档，代码里也必须真读它

### 3.5 需要改的 mock

`tests/e2e/mock-model-server.mjs` 目前只响应 `/chat/completions`，其余 404。
要给它加 `GET /models`（返回 `{object:"list", data:[…]}`），并支持「返回空列表」「返回 401」
两个开关 —— 正好对应 §2.2 的三态。**扩展而不是另写一个**：同一个 mock 才能保证
「探测到的端点」与「能真的对话的端点」是同一个。

---

## 四、要改的文件清单

| 文件 | 改动 | 风险 |
| --- | --- | --- |
| `src/main/daemon/local-endpoints.js` | **新增**（纯函数 + 一处可注入的 fetch） | 低 |
| `src/main/daemon/models.js` | `upsertCustomProvider` 带 `apiKey`（写入 / 继承） | **中** —— 动的是模型配置的写路径，必须有 round-trip 单测 |
| `src/main/daemon/session-files.js` | 两条 IPC handler | 低（照既有 handler 写） |
| `src/shared/ipc.js` | 两条通道常量 + 契约注释 | 低 |
| `src/preload/index.js` | 暴露两个方法 | 低 |
| `src/renderer/src/app.js` | `OnboardingChecklist` 第 2 步 + `ModelsSection` 新区分 + 一处占位符文案纠正 | **中**（大 chunk 文件，只许**定点改**，不许重排） |
| `src/renderer/src/app.css` | 新区的样式（**只用既有 token 与既有类，尽量不新造类名**） | 中 |
| `tests/e2e/mock-model-server.mjs` | 加 `GET /models` 与两个开关 | 低 |
| `EXTERNAL_REQUESTS.md` | 新增一条 loopback 主动请求 | 低 |
| `docs/USAGE.md` | 模型接入补「本机模型服务」；**修掉「留空即可」那句** | 低 |
| `CHANGELOG.md` | `[Unreleased]` → 新增 / 修复 | 低 |
| `package.json` | 新 e2e 脚本挂进 `test:gui` 链条 | 低 |

---

## 五、风险与对策

| 风险 | 对策 |
| --- | --- |
| 探测在用户机器上「扫端口」观感不佳 | 只探 5 个写死的回环端口；UI 明写边界；不做区间扫描（单测钉死） |
| 用户机器上真的跑着 Ollama，e2e 却要可复现 | `ZEROWORK_LOCAL_ENDPOINTS` 注入端口 |
| 写模型配置的既有路径被改动 | round-trip 单测：`save(带 apiKey) → read → save → apiKey 仍在` |
| 大 chunk 文件的定点改 | 只改必要的行；`git diff --stat` 复核改动行数；禁止格式化重排 |
| 探测拖慢首屏 | 不阻塞渲染；总超时设上限；探测中显示现状文案 |
| 接入后「看着成功其实不可用」 | `connectLocalEndpoint` 内**复核 `isUsable`**，不成立就报错；e2e 要真发一条消息验证 |

---

## 六、被否掉的方案（照 `docs/ARCHITECTURE.md` 的规矩记下来）

| 被否掉的方案 | 理由 |
| --- | --- |
| 用 `probeModel` 做探测 | 它是「发一次真实推理」（10s 超时、`max_tokens:1` 的 POST，`session-state.js:826-849`），不是「探端口/列模型」。PRD 要求 ≤1s 量级并发探测，它满足不了 |
| 用 Ollama 原生 `/api/tags` 而不是 `/v1/models` | 会让 Ollama 需要一套独立解析。统一形状的收益更大 |
| 探测时自动把已装的模型全接进来 | 「静默地替用户改配置」与项目取向相反；接入必须是一次显式点击 |
| 在应用启动时探测一次并缓存 | 启动时做网络动作（哪怕是回环）与「启动不出网」的既有气质冲突；且会引入「界面显示的是旧状态」 |
| 用 `roles: ["local"]` 之类的内置服务商 | pi 没有内置 ollama 服务商（上游文档明确让人写 `models.json`），没有这条捷径 |
| 把探测结果做成推送通道（`PUSH`） | 只服务两处界面、且都是「用户主动打开」的场景，拉式足够；新增推送通道是长期维护负担 |

---

## 七、与其他文档的同步

- `EXTERNAL_REQUESTS.md`：新增一节（形态：`http://127.0.0.1:<固定端口>/v1/models`，**主动请求**、可控、只探回环）
- `docs/USAGE.md`：模型接入一节 + 纠正「留空即可」
- `docs/ARCHITECTURE.md`：若把「占位凭据」写成一条设计决策，补一行到「设计决策与已否决方案」表
- `docs/DESIGN.md`：仅当视觉规范确实引入了新档位或新例外才动；否则**不动**