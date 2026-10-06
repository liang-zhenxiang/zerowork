# Research: 模型接入现状（写路径 / 探测能力 / 两处界面 / 约束 / 可测性）

- **Query**: 为「本机回环地址上的模型服务探测 + 一键接入」查明既有代码事实（17 项）
- **Scope**: internal（只读代码与测试，未改任何 `src/` 文件）
- **Date**: 2026-10-06
- **工作目录**: `/Users/liangyuxiang/Documents/work/yu-project/zerowork`

> 阅读约定：所有行号取自本轮 `HEAD`（`59ddabd`）的工作区状态。
> **末尾「§Z 关键结论」是必须优先看的五条**，其中第 1 条是本次调研发现的**硬阻塞**。

---

## A. 「一键接入」要复用哪条写路径

### A1. `INVOKE.saveCustomProvider` 的通道常量与 daemon handler

**通道常量**（两份手工同步的副本，改一处必须改两处）：

- `src/shared/ipc.js:255` — `saveCustomProvider: "settings:save-custom-provider",`
- `src/preload/index.js:231` — 同名同值

`src/preload/index.js:292-294` 明确写着这条约定：

```js
   * 注意：本表与 src/shared/ipc.js 是两份手工同步的副本（preload 不 import
   * shared 模块的既有架构），改通道名两处都要改。
```

**daemon 侧 handler** —— `src/main/daemon/session-files.js:3791`：

```js
  [INVOKE.saveCustomProvider]: async ([input, apiKey]) => {
    await (await getCatalog()).saveCustomProvider(
      input,
      apiKey
    );
  },
```

注意入参是从 **数组** 里解构的（`[input, apiKey]`）。原因见 `src/main/index.js:380-383`：

```js
  for (const channel of Object.values(INVOKE)) {
    if (MAIN_HANDLED.includes(channel)) continue;
    ipcMain.handle(channel, (_event, ...args) => callDaemon(channel, args));
  }
```

即：**任何新增的 `INVOKE` 常量都会自动被 main 转发给 daemon**（除非加进 `MAIN_HANDLED`，`src/main/index.js:125-148`）。main 是哑转发器，不需要为新通道改 main。

**入参形状与校验规则**（`src/main/daemon/model-catalog.js:110-126`）：

```js
  async saveCustomProvider(input, apiKey) {
    const validation = validateCustomProvider(input);
    if (!validation.ok) {
      throw new Error(`配置有误：${Object.values(validation.errors).join("；")}`);
    }
    const builtinIds = new Set(this.runtime.getProviders().map((p) => p.id));
    const owned = new Set(listOwnedProviderIds(this.modelsPath));
    if (builtinIds.has(input.id) && !owned.has(input.id)) {
      throw new Error(`「${input.id}」与内置服务商同名，请换一个 id。`);
    }
    upsertCustomProvider(this.modelsPath, input);
    await this.runtime.refresh({ allowNetwork: false });
    if (apiKey !== void 0 && apiKey.trim() !== "") {
      writeApiKey(getAuthPath(), input.id, apiKey.trim());
      await this.runtime.setRuntimeApiKey(input.id, apiKey.trim());
    }
  }
```

**校验规则**（`src/main/daemon/validation.js:10-38`，逐条）：

| 字段 | 规则 | 错误文案 |
| --- | --- | --- |
| `id` | `/^[a-z][a-z0-9-]*$/` | 只能用小写字母、数字和连字符，且以字母开头 |
| `name` | `trim() !== ""` | 请填写显示名称 |
| `baseUrl` | `new URL()` 可解析且协议为 `http:` / `https:` | 请填写完整地址 / 只支持 http 或 https |
| `models` | 数组非空、每项 `id.trim() !== ""`、`id` 不重复 | 至少填一个模型 / 模型 ID 不能为空 / 模型 ID 不能重复 |

⚠️ `validateCustomProvider` 只校验上表四项；`models` 里的 `contextWindow` / `maxTokens` / `reasoning` / `vision` **不校验**（那是 `validateCustomModel` 的事，`validation.js:40-46`，只在 `addProviderModel` 路径用）。

**完整 `CustomModelInput` 字段**（决定了探测结果要转成什么形状）：

- 界面空表单模板 `src/renderer/src/app.js:63517-63523`：
  ```js
  const EMPTY_CUSTOM = {
    id: "", name: "", baseUrl: "",
    api: "openai-completions",
    models: [{ id: "", name: "", contextWindow: 128e3, maxTokens: 32768, reasoning: false, vision: false }]
  };
  ```
- 提交时的归一化（`app.js:63566-63571`）：`name` 空则取 `id`；每个 model 的 `id` 做 `trim()`、`name` 空则取 `id.trim()`；`apiKey` 空串转 `undefined`
- 编辑回填形状（`model-catalog.js:154-183` `readCustomProvider`）：非 anthropic 不出现 `authHeader` 字段；`api` 收窄到 `anthropic-messages` / `google-generative-ai` / `openai-completions` 三种，未知一律当 OpenAI 兼容；model 缺省值 `contextWindow: 128e3`、`maxTokens: 8192`、`reasoning: false`

### A2. `upsertCustomProvider` 写什么 / 落盘路径 / JSON 结构

**落盘路径**：`src/main/daemon/config-paths.js:23-25`

```js
function getModelsPath() {
  return join(getConfigDir(), "models.json");
}
```

`getConfigDir()`（`config-paths.js:14-17`）优先读 `process.env["ZEROWORK_CONFIG_DIR"]`，否则回落 `~/.zerowork`。

**写实现**（`src/main/daemon/models.js:87-121`）：白名单重建，不是合并：

```js
function upsertCustomProvider(path, input) {
  const config = readModelsJson(path);
  const existing = config.providers[input.id];
  if (existing !== void 0 && !isOwned(existing)) {
    throw new Error(`models.json 里已有手工配置的服务商「${input.id}」，请换一个 id 以免覆盖它。`);
  }
  const entry = {
    [OWNER_KEY]: true,          // "x-zerowork": true
    name: input.name,
    baseUrl: input.baseUrl,
    api: input.api,
    models: input.models.map((model) => toModelsJsonModel(model, existing?.models?.find((m) => m.id === model.id)))
  };
  if (input.api === "anthropic-messages" && input.authHeader === true) entry.authHeader = true;
  if (input.api === "openai-completions" && input.compat !== void 0) { /* 只搬 supportsDeveloperRole / supportsReasoningEffort */ }
  writeModelsJson(path, { ...config, providers: { ...config.providers, [input.id]: entry } });
  return next;
}
```

- 归属标记常量：`models.js:31` — `const OWNER_KEY = "x-zerowork";`
- 单模型形状：`models.js:65-85` `toModelsJsonModel`，`input` 由 `vision` 推出（`["text","image"]` 或 `["text"]`），`cost` **恒写 `{input:0,output:0,cacheRead:0,cacheWrite:0}`**（注释：自建服务商无从得知真实价格，写 0 避免 `/cost` 显示 NaN）
- 写文件：`models.js:185-189`，`mkdirSync` + `JSON.stringify(config, null, 2)` + 末尾换行
- 空 `models` 数组是**合法**的（`models.js:217-219` 注释说明那是 `ensureBuiltinProviders` 的用法）

**真实样例结构**（本轮用 `ZEROWORK_CONFIG_DIR=<临时目录>` 直接跑 `ModelCatalog.create()` + `saveCustomProvider(...)` 实跑落盘得到，非推测）：

```json
{
  "providers": {
    "ollama": {
      "x-zerowork": true,
      "name": "本机 Ollama",
      "baseUrl": "http://127.0.0.1:11434/v1",
      "api": "openai-completions",
      "models": [
        {
          "id": "llama3.2",
          "name": "llama3.2",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 4096,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
        }
      ]
    }
  }
}
```

读侧宽容规则（`models.js:37-63` `readModelsJson`）：文件不存在 → `{providers:{}}`；空文件 → 同；**非法 JSON 抛「已停止操作以免覆盖你的配置」并带原始错误**；`providers` 非对象抛错。

### A3. `api` 取值域与 `authHeader` 的作用

**界面支持的取值域**（`src/renderer/src/app.js:63536-63547`）：

```js
const API_OPTIONS = [
  { value: "openai-completions", label: "OpenAI 兼容",
    hint: "多数国产网关、Ollama、vLLM；基址填到 /v1 那一层" },
  { value: "anthropic-messages", label: "Anthropic Messages",
    hint: "Claude 官方或代理；基址填到端点根（SDK 自动拼 /v1/messages）" }
];
```

代码层面还认 `google-generative-ai`（`model-catalog.js:167`、`session-state.js:880`），但**不在表单下拉里**，只在编辑既有条目时被保留。

**`authHeader` 的作用**（只对 anthropic 有效）——两处消费：

1. 落盘：`models.js:102-104`，**仅当 `api === "anthropic-messages"` 且 `authHeader === true`** 才写 `entry.authHeader = true`
2. 发请求时决定用哪个头（`src/main/daemon/session-state.js:861-862`）：
   ```js
   if (target.api === "anthropic-messages") {
     const auth = key === void 0 ? {} : target.authHeader === true ? { authorization: `Bearer ${key}` } : { "x-api-key": key };
   ```
   即 `authHeader: true` = 用 `Authorization: Bearer`，缺省 = 用 `x-api-key`。对 `openai-completions` 恒用 `Bearer`（`session-state.js:835`）。

### A4. 保存后「选中某个模型」

**通道**：`INVOKE.setModel` — `src/shared/ipc.js:91` / `src/preload/index.js:70`，值都是 `"session:set-model"`。

**handler**（`src/main/daemon/session-files.js:4345-4363`）：

```js
  /**
   * 切换模型。不依赖会话 —— 设置界面在会话建立前就要能用。
   * 全局设置（spec A）：写入 activeModelKey 后，**之后新建的宿主**都用它；
   * 当前会话同步切过去；后台保活的宿主保留各自模型 —— 进行中的 run 不换引擎。
   */
  [INVOKE.setModel]: async ([modelKey]) => {
    const key = modelKey;
    const catalog = await getCatalog();
    if (!catalog.isUsable(key)) {
      throw new Error("该模型不可用：请先为其服务商配置 API Key");
    }
    activeModelKey = key;
    writePreferences({ ...readPreferences(), activeModelKey: key });
    if (currentBucket.hostPromise !== void 0)
      await (await currentBucket.hostPromise).setModel(key);
    else updateStateLocally(currentBucket, { modelId: key });
  },
```

**`modelKey` 格式**=`${providerId}/${modelId}`：

- 生成：`src/main/daemon/auth.js:96-98` `toModelKey(providerId, modelId) => \`${providerId}/${modelId}\``
- 解析：`auth.js:100-104`
  ```js
  function parseModelKey(key) {
    const at = key.indexOf("/");
    if (at <= 0 || at === key.length - 1) return void 0;
    return { providerId: key.slice(0, at), modelId: key.slice(at + 1) };
  }
  ```
  注意：**只按第一个 `/` 切**，所以 `modelId` 本身可以含 `/`（例如 `org/model`）。界面侧就是这么拼的（`app.js:63907`、`63913`：`const key = \`${model.providerId}/${model.id}\``）。

**`isUsable` 判定**（`src/main/daemon/model-catalog.js:166-171`）：

```js
  isUsable(modelKey) {
    const parsed = parseModelKey(modelKey);
    if (parsed === void 0) return false;
    if (this.runtime.getModel(parsed.providerId, parsed.modelId) === void 0) return false;
    return this.runtime.getProviderAuthStatus(parsed.providerId).configured;
  }
```

> 第三条判据是本次调研最大的发现，见 **§Z-1**。

### A5. 保存后渲染层如何刷新

**没有任何针对「模型配置变了」的推送通道。** `src/shared/ipc.js:542-579` 的 `PUSH` 全表只有：
`sessionEvent` / `taskListChanged` / `uiRequest` / `permissionRequest` / `questionnaireRequest` / `daemonReady` / `daemonDown` / `automationEvent` / `runtimeInstallProgress`（preload 侧多一条 `updatesEvent`，`src/preload/index.js:500`）。

刷新一律是**拉式**，且三处各自为政：

| 位置 | 何时重拉 | 代码 |
| --- | --- | --- |
| 设置页 | 每次 `run(action)` 成功后 `await load()` 重拉 `settingsSnapshot` | `app.js:65105-65119` |
| 输入框模型菜单 | 菜单**打开时** `reload()` | `app.js:15002-15013` |
| 首页上手清单 | **仅挂载时与 `cwd` 变化时** | `app.js:15207-15221` |

```js
  const load = reactExports.useCallback(() => {
    setError(void 0);
    Promise.all([
      window.kami.settingsSnapshot(),
      window.kami.workspaceSnapshot(),
      window.kami.listSessions()
    ]).then(([settings, workspace, list2]) => { ... })
  }, []);
  reactExports.useEffect(() => { load(); }, [load, cwd2]);
```

⚠️ 含义：**首页一键接入之后，清单不会自己重画**（没有 cwd 变化、没有推送）。要么组件自己 `load()` 一次，要么新增推送。这是实现时必须处理的一处接线，不是「应该没问题」的地方。

---

## B. 已有的探测能力

### B6. `probeModel` 的定义、签名与返回值

**定义**：`src/main/daemon/session-state.js:901-924`（`diff` 里由 `session-files.js:285` 导入）：

```js
async function probeModel(target, fetchImpl = fetch) {
  const request = buildRequest(target);
  if (request === void 0) {
    return { ok: false, error: `该协议（${target.api}）暂不支持连通测试` };
  }
  const startedAt = Date.now();
  let response;
  try {
    response = await fetchImpl(request.url, { ...request.init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("abort") || message.includes("timeout") || message.includes("Timeout")) {
      return { ok: false, error: `连接超时（${TIMEOUT_MS / 1e3} 秒无响应）` };
    }
    return { ok: false, error: "网络连接失败，请检查网络与接口地址" };
  }
  const latencyMs = Date.now() - startedAt;
  if (response.ok) return { ok: true, latencyMs };
  if (response.status === 429) return { ok: true, latencyMs, error: "连通正常，但正在限流" };
  return { ok: false, error: statusError(response.status) };
}
```

- `TIMEOUT_MS = 1e4`（`session-state.js:826`）—— **10 秒**，对「探端口」这个场景偏长
- `target` 形状（由调用点 `session-files.js:4459-4467` 与 `4495-4501` 反推）：
  `{ api, baseUrl, modelId, apiKey?, extraHeaders?, authHeader? }`
- `statusError`（`session-state.js:893-899`）：
  ```js
  if (status === 401 || status === 403) return "API Key 无效或权限不足";
  if (status === 404) return "模型不存在或接口路径不对";
  if (status === 429) return "触发服务商限流，稍后再试";
  if (status >= 500) return "服务商接口异常，稍后再试";
  return `请求被拒绝（${status}）`;
  ```

**它怎么区分三种失败**（这是问题 6 的核心）：

| 情形 | 判定位置 | 返回 |
| --- | --- | --- |
| 网络不通 | `catch`（`session-state.js:913-919`） | `{ok:false, error:"网络连接失败，请检查网络与接口地址"}` |
| 超时 | `catch` 内 message 匹配 `abort`/`timeout`/`Timeout` | `{ok:false, error:"连接超时（10 秒无响应）"}` |
| Key 不对 | `statusError(401/403)` | `{ok:false, error:"API Key 无效或权限不足"}` |
| 模型不存在 | `statusError(404)` | `{ok:false, error:"模型不存在或接口路径不对"}` |
| 协议不支持 | `buildRequest` 返回 `undefined` | `{ok:false, error:"该协议（…）暂不支持连通测试"}` |

⚠️ **关键：401/403 与 404 都只能从 HTTP 状态码区分，而「Key 不对」与「路径不对」在很多服务上返回的是同一个码。** 另外 `probeModel` 是**发一次真实推理请求**（`max_tokens: 1`）——不是只列模型列表。

### B7. `withHardTimeout` 的签名与语义

`src/main/daemon/session-files.js:1929-1936`：

```js
function withHardTimeout(promise, ms, message = "请求超时") {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error(message)), ms).unref?.();
    })
  ]);
}
```

语义：`Promise.race` 的**外层兜底**，与 `probeModel` 内部的 `AbortSignal.timeout` 是两道独立的钟（后者管 socket，前者管「无论如何别把 UI 卡住」）。调用方一律用 **15 秒**（`session-files.js:4418`、`4468`、`4502`）。

### B8. `INVOKE.refreshCatalog` 怎么拉模型列表 —— **没有可复用的「只拉列表」函数**

通道：`src/shared/ipc.js:267` / `src/preload/index.js:243`，值 `"settings:refresh-catalog"`。
handler：`src/main/daemon/session-files.js:3804-3806` → `ModelCatalog.refreshCatalog`

`src/main/daemon/model-catalog.js:157-164`：

```js
  /** 联网刷新模型目录。用户主动点击时才调——启动时不联网。 */
  async refreshCatalog() {
    const result = await this.runtime.refresh({ allowNetwork: true });
    if (result.errors.size > 0) {
      const detail = [...result.errors.entries()].map(([id, error]) => `${id}: ${error instanceof Error ? error.message : String(error)}`).join("；");
      throw new Error(`部分服务商刷新失败 —— ${detail}`);
    }
  }
```

**结论：没有。** 逐条核实：

1. 它整包委托给 pi 的 `ModelRuntime.refresh({allowNetwork: true})`（`node_modules/@earendil-works/pi-coding-agent/dist/core/model-runtime.js:506-535`），返回的是「每个 provider 的错误表」，不是模型列表。
2. pi 的 `ModelsStore`（`dist/core/models-store.js:25`）自述是 *Locked JSON-backed storage for dynamically refreshed provider catalogs* —— 它只是 `models-store.json` 的读写层，**不含 HTTP**。
3. 在 pi 的 `dist/` 里搜 `/v1/models` 只命中 Anthropic SDK 自己的 `Models.list`（`dist/bundle/chunks/chunk-DTD7JQ7Y.js`），**没有**面向「任意 OpenAI 兼容 baseUrl 列模型」的实现。
4. **反证更强**：应用自己要求 `saveCustomProvider` 的入参里**必须显式带 `models` 数组**（`validation.js:29-31`「至少填一个模型」）。如果 pi 能从 baseUrl 自动列模型，这个校验就没有存在的必要。

→ **本任务必须自己实现「按 baseUrl 拉模型列表」**（OpenAI 兼容是 `GET {base}/models`；Ollama 另有 `GET {base}/api/tags`）。这段代码目前**在仓库里不存在**，需要新写。

---

## C. 两个要改的界面

### C9. 首页上手清单（三步清单）

| 项 | 值 |
| --- | --- |
| 组件名 | `OnboardingChecklist` |
| 定义位置 | `src/renderer/src/app.js:15195-15318` |
| 挂载位置 | `src/renderer/src/app.js:16200-16210`（在 `composer-zone` 内、`Composer` 之上） |
| props | `{ modelId, cwd, onOpenSettings, onOpenWorkspace, onFocusComposer }`（`app.js:15195-15201`） |
| 挂载处传参 | `app.js:16202-16209`；`onOpenSettings` 来自 `HomeView`（`app.js:16081`）→ `App` 的 `openSettings`（`app.js:69372`） |
| 渲染结构 | `div.home-guide[role=status]` + 每步 `div.home-guide-row`（未完成时加 `.home-guide-row-action`） |

**三步的判据**（`app.js:15223-15227`）：

```js
  const readiness = judgeModelReadiness(modelId ?? snapshot.activeModelId, snapshot.models);
  const modelReady = readiness.kind === "ready";
  const workspaceReady = workspaces.length > 0;
  const messageReady = sessions.length > 0;
  const allDone = modelReady && workspaceReady && messageReady;
```

**第 2 步（本任务要改的那一步）的判据函数** `judgeModelReadiness`（`app.js:15159-15164`）：

```js
function judgeModelReadiness(modelId, models) {
  const available = models.filter((model) => model.available);
  if (available.length === 0) return { kind: "no-model-at-all" };
  const usable = available.some((model) => `${model.providerId}/${model.id}` === modelId);
  return usable ? { kind: "ready" } : { kind: "model-not-usable" };
}
```

**文案来源** `guideText`（`app.js:15165-15170`）：

```js
function guideText(readiness) {
  if (readiness.kind === "no-model-at-all") {
    return { title: "还没有可用模型，现在还不能开始对话", action: "去设置里填 API Key" };
  }
  return { title: "还没有选定要用哪个模型", action: "去选一个模型" };
}
```

**三步 rows 数组与按钮回调**（`app.js:15240-15265`）：

```js
  const rows = [
    { key: "workspace", done: workspaceReady, icon: IconWorkspace,
      label: workspaceReady ? "已有工作空间" : "选一个工作空间，Agent 才有放文件的地方",
      action: "选择工作空间", go: onOpenWorkspace },
    { key: "model", done: modelReady, icon: IconKey,
      label: modelReady ? "已选定可用模型" : text2.title,
      action: text2.action, go: () => onOpenSettings("models") },   // ← 本任务第 3 步要动的就这一行
    { key: "message", done: messageReady, icon: IconSend,
      label: messageReady ? "已发出第一条消息，或从下面的案例开始" : "发出第一条消息，或从下面的案例开始",
      action: "去写第一条", go: onFocusComposer }
  ];
```

**按钮文案与渲染**（`app.js:15296-15307`）：未完成行渲染 `button.mini-btn`，children = `[row.action, " →"]`；整行也可点（`role="button"` + `tabIndex=0` + `onKeyDown` 处理 Enter/Space，`app.js:15283-15292`）。

**数据来源**：三个 IPC 并发拉（`app.js:15209-15217`）—— `settingsSnapshot()` / `workspaceSnapshot()` / `listSessions()`；任一未回 → `return null`（`app.js:15222`）。
**收起态**：三步全完成且未展开时，只渲染一个 `mini-btn`「上手清单」（`app.js:15228-15238`）。

### C10. 设置 → 模型的页面

| 项 | 值 |
| --- | --- |
| 页面容器 | `SettingsView`，`src/renderer/src/app.js:65089-65172`；`page2 === "models"` 时渲染 `ModelsSection`（`app.js:65161`） |
| 模型页组件 | `ModelsSection`，`app.js:64213-64274` |
| 「当前模型」区 | `ModelPicker`，`app.js:63883-63921`（`h2` = 「当前模型」，含「显示全部(N)」与「刷新模型目录」两个 `mini-btn`） |
| 「服务商」区 | `app.js:64238-64269`（`h2` = 「服务商」，右上角 `mini-btn`「＋ 添加模型」） |
| 分区类名 | 一律 `section.settings-section` + `header.settings-section-head` + `h2` |

**`ModelsSection` 的状态机**（`app.js:64213-64223`）：

```js
function ModelsSection({ snapshot, busy, run }) {
  const [form, setForm] = reactExports.useState({ kind: "closed" });
  const [addOpen, setAddOpen] = reactExports.useState(false);
  const openEdit = (providerId) => {
    void run(async () => {
      const input = await window.kami.readCustomProvider(providerId);
      if (input === void 0) throw new Error("读不到该服务商的配置");
      setForm({ kind: "edit", input });
    });
  };
  const managed = snapshot.providers.filter((p) => p.configured || p.custom);
```

⚠️ `managed` 过滤器很重要：**「服务商」列表只显示 `configured || custom`** —— 一个刚接入但 `configured === false` 的本机服务商会**落在列表外**（与 §Z-1 直接相关）。

**`CustomForm` 如何被打开 / 保存后如何回列表**：

- 打开（编辑既有自定义服务商）：`openEdit` → `setForm({kind:"edit", input})` → `app.js:64246-64257` 渲染 `<CustomForm initial={form.input} … />`
- 打开（新建）：走的是**另一个组件** `AddModelDialog`（`app.js:64018-64212`），入口是「＋ 添加模型」`button` → `setAddOpen(true)`（`app.js:64241`）。它内部用 `ProviderSelect`（`app.js:63923-64009`）选「预置」或「自定义」；选「自定义」时在弹层里渲染 `CustomForm`（`app.js:64060-64071` `submitCustom` → `window.kami.saveCustomProvider(input, key)`）
- **保存后回到列表**：`onSaved()`（`AddModelDialog` 路径，`app.js:64065`）或 `onSave` 回调里 `setForm({kind:"closed"})`（编辑路径，`app.js:64252-64255`），两者都包在 `run(...)` 里，`run` 结束会 `await load()` 重拉 `settingsSnapshot`
- `CustomForm` 自身定义：`app.js:63548-63822`；它的「测试」按钮走 `window.kami.testDraftModel({providerId, api, baseUrl, authHeader?}, modelId, apiKey)`（`app.js:63573-63593`），失败用**返回值**表达，只有 IPC 断了才进 `catch`
- 表单里 API Key 输入框的 placeholder（`app.js:63655`）：`isEdit ? "留空表示不修改已保存的 Key" : "本地服务可留空"`

### C11. 既有类名与 `app.css` 行号

**首页清单族（`src/renderer/src/app.css`）**

| 类名 | 行号 | 备注 |
| --- | --- | --- |
| `.home-guide` | `2124` | 注释块 `2025-2048` 说明它是「次级辅助面 `--bg-raised`、无边框」，与输入卡的间距 `--space-5(16)` |
| `.home-guide-row` | `2137` | |
| `.home-guide-icon` | `2143` | |
| `.home-guide-row-action` | `2155` | 整行可点（issue #72） |
| `.home-guide-row-action:hover` | `2160` | |
| `.home-guide-row-action .home-guide-icon` | `2164` | |
| `.home-guide-text` | `2172` | |
| `.home-guide-note` | `2185` | 清单末行「本地优先…」用的那档 |
| `.context-row` | 见 `app.js:15229` 用法 | 收起态的 `mini-btn` 容器 |

**设置页族**

| 类名 | 行号 |
| --- | --- |
| `.settings-section` | `7069` |
| `.settings-section-head` | `7073` |
| `.settings-section-head h2` | `7080` |
| `.settings-section-badge` | `2049` |
| `.model-grid` | `7219` |
| `.model-card` / `.active` / `.unavailable` | `7225` / `7246` / `7252` |
| `.model-card-head` / `-name` / `-meta` / `-test` / `-probe` | `7257` / `7263` / `7272` / `7278` / `7283` |
| `.model-card-probe.ok` / `.err` | `7291` / `7295` |
| `.provider-list` | `7301` |
| `.custom-form` | `7659` |
| `.form-actions` | `7681` |
| `.form-actions .model-card-probe` | `7754` |

**通用按钮 / 布局**

| 类名 | 行号 |
| --- | --- |
| `.mini-btn`（含 `:hover` / `:disabled` / `.saved:disabled` / `.danger` / `.active`） | `7158` / `7172` / `7176` / `7184` / `7189` / `9697` |
| `.primary-btn`（含 `:hover` / `:disabled`） | `7198` / `7207` / `7211` |
| `.bar-spacer` | `2886` |

**三态组件**（本任务「探到但零模型」vs「没探到」要用得上）：
`EmptyState` `app.js:13232`、`LoadingState` `app.js:13245`、`ErrorState` `app.js:13251`；
判据纪律在 `docs/DESIGN.md:179-189`（§4 加载/空/错误三态）：

> **三态必须互斥且各自可辨**：加载中=数据为 `undefined`；真空=数据为 `[]`；错误=就地呈现并给出重试动作。
> 数据到达前不得显示「无数据」类文案；错误态与「数据还没回来」在视觉上必须可区分。

---

## D. 约束与既有约定

### D12. 新增 IPC 通道的写法与 preload 暴露

**写法约定**（`src/shared/ipc.js`）：每个 `INVOKE` 条目**必须**带一段 `/** … */`，写清「干什么、边界在哪、为什么这么设计」。它同时是**类型契约的落点**（没有 TS，注释就是契约）。范例 —— `src/shared/ipc.js:281-289`：

```js
  /**
   * 测试**表单里还没保存**的服务商配置（自定义服务商表单右下角的「测试」按钮）。
   *
   * 与 testModel 的区别：那条从**已保存的目录**里解析模型，表单里刚填的
   * baseUrl / 模型 id 在保存前不在目录里 —— 用 testModel 一律报
   * 「目录里找不到该模型」。这条直接拿表单的当前值构造探测，所以用户能
   * 「填完就试」，不必先存一遍再回来改。
   */
  testDraftModel: "settings:test-draft-model",
```

**通道名硬约束**（`tests/unit/ipc.test.mjs:20-25` 会红）：

```js
	it("INVOKE 通道名带命名空间前缀（保证同前缀通道聚合在一起）", () => {
		for (const [key, channel] of Object.entries(INVOKE)) {
			expect(channel, `INVOKE.${key} 缺少 "域:" 前缀`).toMatch(/^[a-z-]+:[a-z-]+$/);
		}
	});
```
→ 新通道如 `"settings:probe-local-endpoints"` 合法；另外两条测试分别禁「PUSH 与 INVOKE 重叠」与「通道名重复」。

**preload 三段都要加**（`src/preload/index.js`）：
1. `INVOKE` 副本表（`index.js:218-…`，与 `shared/ipc.js` 手工同步）
2. `bridge` 上的方法（`index.js:591-600` 附近是同族写法）：
   ```js
   settingsSnapshot: () => ipcRenderer.invoke(INVOKE.settingsSnapshot),
   ...
   testDraftModel: (draft, modelId, apiKey) => ipcRenderer.invoke(INVOKE.testDraftModel, draft, modelId, apiKey),
   ```
   注意 `ipcRenderer.invoke(channel, ...args)` 的多参数会被打包成数组 → daemon 侧 handler 用 `([a, b]) =>` 解构（见 A1）
3. 若需要推送：`PUSH` 表 + `onXxx: (listener) => subscribe(PUSH.xxx, listener)`（`index.js:654-664`）；`subscribe` 的实现可参照既有条目
4. 最后 `contextBridge.exposeInMainWorld("kami", bridge)`（`index.js:684`）

> preload **不 import `src/shared/`**（既有架构），所以是手工两份 —— 注释明写在同一文件 `index.js:292-294`。

### D13. daemon 侧 handler 所在文件与注册方式

- **所有 handler 集中在 `src/main/daemon/session-files.js`** 的 `const handlers = { … }`（起点 `session-files.js:3714`）
- 分发：`session-files.js:4945-4976` `dispatch(request)` → `handlers[request.channel]`；未登记通道回 `未知通道：${channel}`；异常经 `eventLog.append({kind:"ipc_error"})` 记录后回错误文案（**错误文案会原样到渲染层**，所以 `throw new Error("…")` 的措辞就是用户看到的话）
- daemon 入口 `src/main/daemon/index.js:26-33` 收帧调 `dispatch`
- 设置相关的 handler 聚在 `session-files.js:3727`（`settingsSnapshot`）到 `3806`（`refreshCatalog`）这一段；旁边 `3785-3802` 就是 `setApiKey` / `removeApiKey` / `saveCustomProvider` / `deleteCustomProvider` / `readCustomProvider` / `addProviderModel` —— **新通道加在这附近最自然**

**`check-daemon-graph` 的 import 规则**（`tools/check-daemon-graph.mjs`，`npm run check:daemon-graph`）—— 守两条性质（文件头 `:5-15`）：

```js
 * 守两条性质：
 *   ① 每个相对 import 都指向真实存在的文件；
 *   ② 每个具名 import 都能在目标模块的导出里找到。
```

实现要点（`check-daemon-graph.mjs:77-92`）：只查**以 `.` 开头**的相对导入；对方模块若没有该具名导出且没有 `export *`，就报 `导入了 X，但对方没有导出它`。跨目录（`../sandbox/`、`../../shared/`）也在校验范围（`:63-69` 的注释）。

→ 若新增 `src/main/daemon/local-endpoints.js`，**必须确保 `session-files.js` 里 import 的每个具名符号都在该文件 `export { … }` 列表里**。另外 `.trellis/spec/daemon/index.md:31-44` 提醒：**顶层只做声明，跨模块使用放进函数体**，否则可能 TDZ（`ReferenceError: Cannot access 'x' before initialization`，只在真实启动时出现）。

### D14. `EXTERNAL_REQUESTS.md` 里现有「本地预览服务」那条的写法

`EXTERNAL_REQUESTS.md:66-73`（第一节「应用本体」第 5 条）：

```markdown
### 5. 本地预览服务

| 项 | 内容 |
| --- | --- |
| 地址 | `http://127.0.0.1:<随机端口>` |
| 用途 | 为工作区里的 HTML 产物提供本机预览 |
| 可控 | ✅ 只监听本机回环地址，不出网 |
```

第 1 条（模型 API，`EXTERNAL_REQUESTS.md:20-27`）用的是更完整的五字段表（地址/用途/触发/可控），可作为「主动发起」那类的模板，因为它有「触发」行。

阅读约定在文件头 `EXTERNAL_REQUESTS.md:10-14`：

> - **可控** = 应用提供开关 / 需要用户显式配置，或可以整体关闭
> - **不可控** = 随包内容自带、当前没有开关

⚠️ 注意该文件里**没有**第 5 条之外的回环条目；新增要编号为「6.」并插在第一、二节之间会打乱后面编号（当前「二、随包资源」从第 6 条起）。**建议新增在第一节的 5 之后、并把第二节的编号整体顺延**，或明确说明编号策略 —— 这处需要主 agent 决定。

相关：`docs/USAGE.md:472-476` 与 `docs/MAINTAINER_GUIDE.md:65` 都引用这份清单。

### D15. 仓库里已有的「探测本机服务」类代码 —— 逐条核实

搜过的关键词：`127.0.0.1`、`localhost`、`11434`、`1234`、`8080`、`1337`、`node:net`、`isIP`、`createConnection`、`AbortSignal.timeout`。

| 结论 | 证据 |
| --- | --- |
| **没有任何「探测本机模型服务」的代码** | 全仓搜 `11434` 只命中 4 处**文档/文案**：`src/renderer/src/app.js:63540`（`API_OPTIONS` 的 hint 提到 Ollama）、`docs/TROUBLESHOOTING.md:179`、`docs/USAGE.md:109`、`docs/ONBOARDING-RESEARCH.md` 多处 |
| **没有端口扫描 / TCP 连通探测** | 全仓 `src/` 里 `node:net` 只出现 1 次：`src/main/daemon/session-view.js:6` `import { isIP } from "node:net";`（用途是判断 host 是不是 IP 字面量，不是连接） |
| **有「只监听回环」的既有实现（对照组，不是可复用件）** | `src/main/daemon/preview-server.js:89` `this.server?.listen(0, "127.0.0.1", …)`；`preview-server.js:71` 返回 `http://127.0.0.1:${this.port}` |
| **有「禁止访问内网/回环」的地址判定（可复用的**反向**逻辑，注意语义相反）** | `src/main/daemon/session-view.js:380` `isPrivateIpLiteral(hostname)`；`session-view.js:428` 在 `verifyTarget` 里用它**拒绝**抓取 `localhost` / `127.0.0.1` / 私有网段 |
| **有 `fetch` 超时封装的两个先例** | `session-state.js:911`（probeModel 内，`AbortSignal.timeout(TIMEOUT_MS)`，10s）；`session-view.js:442`（`fetchPage`，`AbortSignal.timeout(timeoutMs)`）；`command-exec.js:1853` 用信号数组 |
| **有 `fetch` 可注入的先例（对测试友好）** | `probeModel(target, fetchImpl = fetch)`（`session-state.js:901`）与 `fetchPage(rawUrl, options)`（`session-view.js:435` 附近，`options.fetchImpl ?? fetch`） |

`preview-renderers.mjs:228` 也用 `createServer` 起本机服务（见 E16）。

→ **可复用的只是「模式」（fetch + AbortSignal.timeout + 函数式注入 fetchImpl），没有可复用的探测实现。** 「按候选表探一圈」这一段要从零写。

⚠️ 一处**语义冲突**要在实现时注意：`session-view.js:428` 的 `verifyTarget` 明确把 `127.0.0.1` 当作**该拒绝的目标**。新模块不要误用它，也不要改它（它有 `web_fetch` 的安全语义）。

---

## E. 可测性

### E16. e2e 怎么起一个本机 HTTP 服务 / 端口分配

**现成件**：`tests/e2e/mock-model-server.mjs`（**注意：不在 `tests/e2e/lib/` 下**，与本任务里若去找的路径不同）：

- 导出 `startMockModelServer({ reply = "这是 mock 模型的回复。", toolCall = false, port = 0 } = {})`（`mock-model-server.mjs:27`）
- 端口分配：`port` 默认 **0 = 随机端口**，`server.listen(port, "127.0.0.1", …)`（`:96`），resolve 出：
  ```js
  resolve({
    port: server.address().port,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,   // 已带 /v1
    requests,                                                   // 收到的所有请求，供断言
    close: () => new Promise((r) => server.close(r)),
  });
  ```
- 只响应 `req.url` 含 `/chat/completions` 的 POST（`:43-47`），其余 404 —— **本任务若要「列模型」需要另写/扩展一个 mock（`/models`）**
- 用 `node:http` 手写、不引第三方依赖（文件头 `:15-17` 说明理由）

**用法范例**（`tests/e2e/onboarding.mjs:27-30, 253-272`）：

```js
const mock = await startMockModelServer({ reply: "ONBOARDING_OK" });
const h = createHarness({ name: "onboarding" });
await h.launch();
...
await globalThis.kami.saveCustomProvider({ id:"onboarding-mock", name:"Onboarding Mock",
  baseUrl, api:"openai-completions", models:[{ id:"mock-model", …, contextWindow:128000, maxTokens:4096 }] }, "sk-e2e-dummy");
await globalThis.kami.setModel("onboarding-mock/mock-model");
```

⚠️ **注意这里传了 `"sk-e2e-dummy"` 这个假 Key** —— 又一次印证 §Z-1。

其他自建 server 的先例（都是 `createServer` + `listen(0, "127.0.0.1")`）：
`tests/e2e/artifact-present.mjs:40,82`、`gui-updates.mjs:51,67`、`preview-renderers.mjs:228,252`、`subagent-task.mjs:43,98`、`widget-render.mjs:47,101`、`tool-loop.mjs:41,92`、`team-create.mjs:77,168`。

**收尾顺序**（`onboarding.mjs:377-381`，testing spec §5.3）：
```js
// 先关应用，再关 mock（反过来 server.close 会等 daemon 与 mock 之间还活着的长连接）。
await h.app().close();
await mock.close();
await h.finish();
```

### E17. 通过环境变量注入配置的先例（`ZEROWORK_*`）

**先例充足**，且有一条**静态门禁**要遵守。

| 变量 | 读取处 |
| --- | --- |
| `ZEROWORK_CONFIG_DIR` | `src/main/daemon/config-paths.js:15`（`const override = process.env["ZEROWORK_CONFIG_DIR"];`）、`src/main/index.js:311,335`、`src/main/updates.js:64` |
| `ZEROWORK_RESOURCES_DIR` | `config-paths.js:52`、`runtimes.js:742` |
| `ZEROWORK_APP_DIR` | `config-paths.js:62`；由 main 注入：`src/main/index.js:159` |
| `ZEROWORK_WORKSPACE_DIR` | `config-paths.js:67`、`preferences.js:261` |
| `ZEROWORK_RUNTIMES_DIR` | `runtimes.js:648` |
| `ZEROWORK_NODE_HOME` / `ZEROWORK_GITBASH_HOME` | `runtimes.js:664,677` |
| `ZEROWORK_GITBASH_URL` / `ZEROWORK_NODE_URL` | `runtimes.js:823,982` |
| `ZEROWORK_UPDATE_FEED` | `src/main/updates.js:108` —— **e2e 注入的典范**：`tests/e2e/gui-updates.mjs:76` `createHarness({ name: "updates", env: { ZEROWORK_UPDATE_FEED: feedUrl } })` |

**e2e 注入方式**（`tests/e2e/lib/harness.mjs:404-417`）—— `createHarness({ name, env })`：

```js
			async _launch() {
				app = await electron.launch({
					args: [ROOT, `--user-data-dir=${USER_DATA_DIR}`],
					env: {
						...process.env,
						ZEROWORK_CONFIG_DIR: CONFIG_DIR,
						ZEROWORK_RESOURCES_DIR: resolve(ROOT, 'resources'),
						ZEROWORK_WORKSPACE_DIR: WORKSPACE_DIR,
						...(opts.env ?? {}),      // ← 用例自己注入的变量在这里生效
					},
					timeout: bootTimeout,
				});
```

⚠️ **一条必须知道的静态门禁**：`npm run check:docs` 的第 ② 条（`scripts/check-docs.mjs:9-13`）：

```js
 *   ② **文档里提到的环境变量真实存在**。README 与 docs 里写了 `ZEROWORK_XXX`，
 *      代码里就必须真的有地方读它。这条防的是「文档描述了一个不存在的开关」——
 *      使用者照着配，配了没反应，比报错更难排查。
```

反向不查（代码里有、文档没写不报错），所以**新环境变量只写进代码 + 测试是安全的，要写进 docs 就得确保代码真的读它**。
`.trellis/spec/` 下的 md 也在被查清单里（`check-docs.mjs:44-60` 的 `DOC_FILES`），但 `.trellis/workflow.md` 与 `.claude/skills/trellis-*` 不查。

**单元测试里注入 env 的先例**（`tests/unit/theme-preferences.test.mjs:34-41`）：

```js
	previousConfigDir = process.env["ZEROWORK_CONFIG_DIR"];
	process.env["ZEROWORK_CONFIG_DIR"] = configDir;
	// afterEach 里还原
```

**`test:gui` 链条**：新 e2e 用例必须挂进 `package.json` 的 `test:gui`（`package.json:56`）—— 那是 26 条 `test:gui:xxx` 的串联；`ci.yml` 的调用链见 `.trellis/spec/testing/index.md` 第 10 条（「不在 CI 里跑的测试等于没有测试」）。

---

## §Z 关键结论（实现前必须处理）

### Z-1.【硬阻塞 / 实测】不写任何凭据 → `setModel` 一定失败，模型在 UI 里也标为不可用

PRD R2 写「**不写任何凭据**：本机服务不需要 Key，`authHeader` 保持缺省」。**这条照字面实现会直接跑不通。** 三轮实测证据：

**证据 1 — 直接用应用自己的 `ModelCatalog` 实跑（`ZEROWORK_CONFIG_DIR=<临时目录>`，本轮执行）：**

```
provider: [{"id":"ollama","name":"本机 Ollama","configured":false,"custom":true,"modelCount":1}]
model:    [{"id":"llama3.2","providerId":"ollama","name":"llama3.2","contextWindow":128000,
            "maxTokens":4096,"reasoning":false,"vision":false,"available":false}]
isUsable keyless: false
isUsable with dummy key: true
```

即：`saveCustomProvider(input, undefined)` 之后 ——
`configured === false`、model 的 `available === false`、`isUsable()` **false**。
而 `INVOKE.setModel` 的第一道门就是 `isUsable`（`session-files.js:4355`），会抛
**「该模型不可用：请先为其服务商配置 API Key」**。

**证据 2 — 直接问 pi 的 `ModelRuntime`（三种写法对照）：**

| `models.json` 里的条目 | `getProviderAuthStatus(id)` |
| --- | --- |
| `baseUrl`/`api`/`models` 齐全，**无凭据** | `{"configured":false}` |
| 同上 + **`auth.json` 里有键** | `{"configured":true,"source":"stored"}` |
| 同上 + `models.json` 里写 **`apiKey` 字段** | `{"configured":true,"source":"models_json_key"}` |
| 同上 + `apiKey: "$SOME_ENV"` 而该 env 未设 | `{"configured":false}` |

判定链在 pi 的 `provider-composer.js:405-422`（`configuredApiKey` = `extension?.apiKey ?? config?.apiKey`；`undefined` → `configuredRequestAuthStatus` 返回 `undefined` → 回落到环境变量检测 → 最终 `{configured:false}`），消费方 `dist/core/model-runtime.js:411-419`。

**证据 3 — 既有 e2e 全部传假 Key**：`onboarding.mjs:271` `"sk-e2e-dummy"`、`model-roundtrip.mjs:104`、`tool-loop.mjs:154`、`team-create.mjs:270`…… 二十多个用例，**无一例外**。

**同时被这条打到的还有三处既有文案/代码**（都指向「本机服务不用 Key」）：

| 位置 | 原文 / 行为 |
| --- | --- |
| `src/renderer/src/app.js:63655` | 自定义表单 API Key 占位符：`"本地服务可留空"` |
| `docs/USAGE.md:109` | 「本地端点通常不需要 Key，留空即可」 |
| `src/main/daemon/model-catalog.js:203-209` | `INVOKE.testModel` 的注释：「fallback（无凭据，本地服务）直接发无鉴权探测」 |

**另有一条连带影响**：`ModelsSection` 的 `managed` 过滤器是 `configured || custom`（`app.js:64223`）。新接入的条目有 `custom:true`（因为有 `x-zerowork` 标记），所以**它会出现在「服务商」列表里**，但它的模型会在 `ModelPicker` 里被 `available` 过滤掉（`app.js:63886` `models.filter(m => m.available)`），默认视图下**看不到**。

**已核实的两个机械出路**（仅陈述事实，选择权在主 agent）：
1. 写一个非空占位串进 `auth.json`（走 `saveCustomProvider(input, "…")` 第二个参数或 `INVOKE.setApiKey`）→ `configured:true, source:"stored"`。代价：auth.json 里多一条假凭据，与 PRD「不写任何凭据」冲突，也与 `EXTERNAL_REQUESTS.md`「不写凭据」的克制气质冲突。
2. 让 `models.json` 条目带 `apiKey` 字段 → `configured:true, source:"models_json_key"`。**但 `upsertCustomProvider` 目前不写该字段**（`models.js:93-114` 是白名单重建，只搬 `x-zerowork`/`name`/`baseUrl`/`api`/`models`/`authHeader`/`compat`）—— 走这条路就要动 `models.js` 的白名单，属于「改既有写路径」。
3. 放宽 `isUsable`（**不推荐且与「宁可拒绝」原则冲突**，此处仅列出以说明它确实是第三个选项）。

⚠️ 无论选哪条，`app.js:63655` 与 `docs/USAGE.md:109` 那两句「留空即可」都**已经是错的**（无论本任务做不做）。这是本轮实测发现的既有缺陷，建议单独记一条。

### Z-2. 没有「只拉模型列表」的现成函数 —— 这段要新写

见 B8 的四条核实。`refreshCatalog` 是「让 pi 重刷目录」，不是「从 baseUrl 列模型」。新模块要自己发：
- OpenAI 兼容：`GET {base}/models`
- Ollama 额外：`GET {base}/api/tags`（若按 PRD 的候选表实现，Ollama 这条通常更可靠）

可借用的**模式**：`probeModel(target, fetchImpl = fetch)`（`session-state.js:901`）与 `fetchPage`（`session-view.js:435`）的「`fetchImpl` 注入 + `AbortSignal.timeout`」写法 —— 这是让 e2e 与单测都能真跑的既有范式。

### Z-3. 首页清单不会自动刷新

`OnboardingChecklist` 只在挂载与 `cwd` 变化时拉数据（`app.js:15219-15221`）。没有推送通道（`PUSH` 全表见 A5）。**一键接入后清单必须自己触发一次重拉**，否则「点完变成已完成」这一步不会发生。

### Z-4. `probeModel` 是「发一次推理」而不是「探端口」

10 秒超时（`session-state.js:826`）、`max_tokens: 1` 的真实 POST（`session-state.js:836-849`）。PRD 要求「单端点 ≤ 1s 量级、并发探测、总耗时设上限」—— 用 `probeModel` 满足不了，需要另写一个短超时的探测/列模型函数。`probeModel` 仍可用于**接入后的连通性验证**（复用 `testModel` 那条链）。

### Z-5. 新增模块的三处必过静态门禁

| 命令 | 要求 |
| --- | --- |
| `npm run check:daemon-graph` | 新模块的每个具名 export 都要在 `export { … }` 里列全；只查相对 import |
| `tests/unit/ipc.test.mjs` | 新 `INVOKE` 通道名须匹配 `/^[a-z-]+:[a-z-]+$/`、不重复、不与 `PUSH` 重叠 |
| `npm run check:docs` | 若把新 `ZEROWORK_*` 变量写进任何被查文档（含 `.trellis/spec/*/index.md`），代码里必须真的读它 |

另：`npm run check:theme-tokens` 与 `check-design-exceptions` 也在 CI 里，界面改动应沿用既有 token 与既有类名（C11 全表）。

---

## 参考（同主题既有文档）

- `docs/ONBOARDING-RESEARCH.md:324-343`「4. 缺模型时，别只把用户推去设置页」——
  **本项目自己已经写下的做法与边界**：预填 `http://127.0.0.1:11434/v1`、探测 `127.0.0.1:11434` 有没有在听、
  「明确不做：一键帮用户下载模型」（`:340-341`、`:383-385`）
- `docs/ONBOARDING-RESEARCH.md:228-234` 横向对比表（「模型配置门槛」那一行是 PRD 事实 1 的来源）
- `EXTERNAL_REQUESTS.md:20-27`（模型 API 条目，五字段表的模板）与 `:66-73`（本地预览服务）
- `.trellis/spec/daemon/index.md`（本层必读：初始化顺序 / IPC 登记 / 落盘先于推送 / 错误可诊断）
- `docs/DESIGN.md:179-189`（§4 三态互斥）
- `.trellis/spec/testing/index.md`（分层、harness 用法、第 10 条「不在 CI 里跑的测试等于没有测试」）

## 明确「没找到」的项

| 问题 | 结论 | 搜过的关键词 |
| --- | --- | --- |
| 可复用的「只拉模型列表」函数 | **没找到** | `allowNetwork`、`/v1/models`、`ModelsStore`、`listModels`、`fetchModels`（pi dist 全量 + `src/`） |
| 可复用的「端口探测 / 扫描」代码 | **没找到** | `127.0.0.1`、`localhost`、`11434`、`1234`、`8080`、`1337`、`node:net`、`isIP`、`createConnection` |
| 模型配置变更的推送通道 | **没有** | `PUSH` 全表（`shared/ipc.js:542-579` + `preload/index.js:497-530`） |
| `scripts/probe-custom-provider.ts` | **文件不存在**（`model-catalog.js:205` 的注释引用了它，但它已被删除/从未入库） | `find . -name "probe-custom-provider*"` |
| 真实 `models.json` 样例（仓库内） | **没有随仓样例**；本文件的样例是本轮用临时 `ZEROWORK_CONFIG_DIR` 实跑落盘得到的 | `x-zerowork`、`models.json`（`docs/`、`.trellis/`、`tests/`、`scripts/`） |
| `tests/e2e/lib/mock-model-server.mjs` | **不在此路径** —— 实际在 `tests/e2e/mock-model-server.mjs` | `ls tests/e2e/lib/`（只有 `harness.mjs` 与 `png.mjs`） |