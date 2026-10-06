/**
 * 本机回环地址上的模型服务探测。
 *
 * 干什么：按一张**写死的候选表**，并发请求 `http://127.0.0.1:<端口>/v1/models`，
 * 把响应归类成 ready / empty / auth-required / unreachable 四态，供界面一键接入。
 *
 * 三条边界（单测逐条钉住）：
 *
 *   1. **只探回环。** 主机名只在 loopbackBaseUrl 里出现一次、写成 IP 字面量；
 *      候选表每项只有 `{ id, label, port }` —— 没有 host 字段，就没有「被填个域名进去」
 *      的入口。listEndpointModels 里**再拒一道**非回环地址（不在唯一入口上赌运气）。
 *      主机名不用任何可被 hosts 文件改写的别名：别名解析到哪儿不由我们决定。
 *   2. **不做端口扫描。** 只探 resolveCandidates() 返回的那几项，不遍历端口区间。
 *   3. **只读。** 不下载、不写配置、不碰凭据 —— 写路径留给调用方（saveCustomProvider）。
 *
 * 为什么不复用 probeModel（session-state.js）：那是「发一次真实推理」——
 * POST /chat/completions、`max_tokens: 1`、10 秒超时。这里是「探端口 + 列模型」，
 * 要求 ≤1 秒量级并发，它满足不了。
 *
 * 为什么统一走 `GET /v1/models`：Ollama / LM Studio / vLLM / LocalAI / Jan 都提供
 * OpenAI 兼容的这一层，响应同形状（`{object:"list", data:[{id}]}`）。于是探测逻辑
 * 只有一条，不必「每个服务一套解析」——收益不抵那个成本。
 *
 * 可测性：端口可由环境变量覆盖（见 resolveCandidates），但**只能改端口** ——
 * 不能新增/删除候选，也不能改主机名，所以「只探回环、只探固定几项」不因为可测而失效。
 */

/**
 * 占位凭据。
 *
 * **不是可选的**：不带凭据的服务商，pi 的 getProviderAuthStatus() 判定为
 * `{configured: false}`，其模型 `available` 为 false，而 setModel 的第一道门就是
 * isUsable() —— 一键接入会建好服务商却**选不中模型**，功能等于没做（三轮实测，
 * 见 tasks/10-06-local-model-discovery/research/model-access.md §Z-1）。
 *
 * 写进 `models.json` 的条目里（pi 对 Ollama 的官方文档写法），**不写 auth.json**：
 * 生命周期跟着服务商条目走（删服务商即删占位），也不会在凭据库里留下一条「不是密钥的东西」。
 *
 * 取值刻意写成一眼可辨的常量：本机服务不需要鉴权，它只是让 isUsable 成立的门票。
 */
const LOCAL_PLACEHOLDER_API_KEY = "local-no-auth";

/**
 * 候选表：只含回环端口与展示名。`{ id, label, port }` 三个字段，**不许有 host / baseUrl**。
 *
 * 端口出处（逐个核实，不靠记忆）：
 *   - ollama   11434 —— Ollama 默认监听端口（`OLLAMA_HOST` 缺省即 127.0.0.1:11434）
 *   - lmstudio 1234  —— LM Studio「Local Server」的默认端口
 *   - vllm     8000  —— `vllm serve` 的 `--port` 默认值
 *   - localai  8080  —— LocalAI 默认监听端口
 *   - jan      1337  —— Jan 的本地 API 服务器默认端口
 */
const LOCAL_ENDPOINT_CANDIDATES = [
  { id: "ollama", label: "Ollama", port: 11434 },
  { id: "lmstudio", label: "LM Studio", port: 1234 },
  { id: "vllm", label: "vLLM", port: 8000 },
  { id: "localai", label: "LocalAI", port: 8080 },
  { id: "jan", label: "Jan", port: 1337 }
];

/** 服务商 id 的前缀：靠前缀**结构性**地避开与内置服务商（以及用户手编的条目）重名。 */
const PROVIDER_ID_PREFIX = "local-";

/** 覆盖端口的环境变量名。与仓库既有的 ZEROWORK_* 注入先例同族。 */
const LOCAL_ENDPOINTS_ENV_KEY = "ZEROWORK_LOCAL_ENDPOINTS";

/** 单个端点的探测超时。刻意短：探测是「顺手一问」，不该让界面等。 */
const DEFAULT_ENDPOINT_TIMEOUT_MS = 800;

/** 整轮探测的总上限。并发跑时所有项应在一个单项上限内收口，这个数是余量。 */
const DEFAULT_TOTAL_TIMEOUT_MS = 1600;

/** 自建/本机服务无从得知真实窗口与输出上限，沿用设置页表单的默认值。 */
const DEFAULT_CONTEXT_WINDOW = 128e3;
const DEFAULT_MAX_TOKENS = 8192;

/**
 * 构造回环地址 —— **本模块里唯一拼地址的地方**。
 *
 * 主机名是写死的 IP 字面量，不从任何输入拼进来；端口也在这里过一遍范围校验，
 * 免得一个坏端口被拼进 URL 之后由 fetch 去报一个看不懂的错。
 */
function loopbackBaseUrl(port) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`非法端口「${String(port)}」：端口应为 1..65535 的整数`);
  }
  return `http://127.0.0.1:${port}/v1`;
}

/**
 * 判断一个地址是不是本机回环上的 http 地址。
 *
 * 只认 IP 字面量那一个主机名：任何别名都可能被 hosts 文件指到别处，
 * https 也不在候选表覆盖的范围内（这些服务默认都是明文 http）。
 */
function isLoopbackUrl(value) {
  if (typeof value !== "string") return false;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" && parsed.hostname === "127.0.0.1";
}

/**
 * 解析 OpenAI 兼容的模型清单。
 *
 * 返回 `{ ok: true, models: [{ id, name }] }`；形状不对时返回
 * `{ ok: false, reason }`，`reason` 是**可区分的机器码**（调用方据此决定展现）：
 *
 *   - `not-an-object`   顶层不是对象（含 null / 数组 / 字符串 / undefined）
 *   - `missing-data`    没有 `data` 字段
 *   - `data-not-array`  `data` 不是数组
 *   - `item-missing-id` 某个条目缺 `id`（或 `id` 不是非空字符串）
 *
 * 「空数组」是**合法**的：那是「服务在跑但一个模型都没有」，与「形状不对」是两件事。
 */
function parseModelList(payload) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: "not-an-object" };
  }
  const data = payload.data;
  if (data === void 0) return { ok: false, reason: "missing-data" };
  if (!Array.isArray(data)) return { ok: false, reason: "data-not-array" };
  const models = [];
  for (const item of data) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { ok: false, reason: "item-missing-id" };
    }
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (id === "") return { ok: false, reason: "item-missing-id" };
    const name = typeof item.name === "string" && item.name.trim() !== "" ? item.name.trim() : id;
    models.push({ id, name });
  }
  return { ok: true, models };
}

/**
 * 把一次 HTTP 响应归类成四态之一。四态**互斥且可辨**（docs/DESIGN.md §4 同族纪律：
 * 「加载中 / 真空 / 错误」不许混为一谈，这里同理：「没探到」与「探到了但没模型」不是一回事）：
 *
 *   - `ready`         2xx 且至少一个模型 → 可一键接入
 *   - `empty`         2xx 但零模型 → 服务在跑，只是还没有模型（给指引，**不是错误**）
 *   - `auth-required` 401 / 403 → 服务在跑但要鉴权（本功能不碰密钥，指向手工添加）
 *   - `unreachable`   连不上 / 超时 / 非 2xx 其它 / 响应不是 JSON / 形状不对
 *
 * `unreachable` 是**预期内的常态**：绝大多数用户没装本机服务。它不得在界面上
 * 呈现为错误、不得出现红叉、不得计入任何「失败」计数。
 */
function classifyListResponse(status, payload) {
  if (status === 401 || status === 403) return "auth-required";
  if (status < 200 || status >= 300) return "unreachable";
  const parsed = parseModelList(payload);
  if (!parsed.ok) return "unreachable";
  return parsed.models.length === 0 ? "empty" : "ready";
}

/** 服务商 id：前缀 + 候选 id。候选 id 的合法性由候选表单测钉住。 */
function providerIdFor(candidate) {
  return `${PROVIDER_ID_PREFIX}${candidate.id}`;
}

/**
 * 把探测结果转成 saveCustomProvider 的入参（**不新建写路径**）。
 *
 * 零模型（或一个合法模型都挑不出来）时返回 `undefined` —— 调用方据此给出
 * 「该服务没有可用模型」之类的可诊断提示，而不是交出一份注定被 validation 拒掉的配置。
 * 沿用既有手法：`buildRequest` 对不支持的协议同样是返回 `void 0`。
 *
 * 两个刻意的取值：
 *   - `apiKey` 是占位凭据，理由见 LOCAL_PLACEHOLDER_API_KEY 的注释（**不是可选项**）
 *   - 模型重复报同一个 id 时按先来后到去重 —— validation 明确禁止重复的模型 id
 */
function buildProviderInput(candidate, models) {
  const seen = new Set();
  const unique = [];
  const list = Array.isArray(models) ? models : [];
  for (const model of list) {
    if (typeof model !== "object" || model === null) continue;
    const id = typeof model.id === "string" ? model.id.trim() : "";
    if (id === "" || seen.has(id)) continue;
    seen.add(id);
    const name = typeof model.name === "string" && model.name.trim() !== "" ? model.name.trim() : id;
    unique.push({ id, name });
  }
  if (unique.length === 0) return void 0;
  const label = typeof candidate.label === "string" && candidate.label !== "" ? candidate.label : candidate.id;
  return {
    id: providerIdFor(candidate),
    name: `本机 ${label}`,
    baseUrl: loopbackBaseUrl(candidate.port),
    api: "openai-completions",
    apiKey: LOCAL_PLACEHOLDER_API_KEY,
    models: unique.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: DEFAULT_CONTEXT_WINDOW,
      maxTokens: DEFAULT_MAX_TOKENS,
      reasoning: false,
      vision: false
    }))
  };
}

/** 把 fetch 的异常翻成一句人话 —— 超时与「端口没服务在听」要能分辨。 */
function describeFetchError(error, timeoutMs) {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  if (
    name === "TimeoutError" ||
    name === "AbortError" ||
    message.includes("abort") ||
    message.includes("timeout") ||
    message.includes("Timeout")
  ) {
    return `连接超时（${timeoutMs} 毫秒无响应）`;
  }
  return "无法连接（端口没有服务在听）";
}

/** 端点的返回形状：`{ state, models, detail? }`。candidate 的 id/label 由调用方补上。 */
function endpointResult(state, models, detail) {
  return detail === void 0 ? { state, models } : { state, models, detail };
}

/**
 * 发一次 `GET {baseUrl}/models` —— **本模块唯一发请求的地方**。
 *
 * **永不抛异常**：网络层面的每一种失败都归类成 `unreachable` 并用 `detail` 说明。
 * 这是照 probeModel 的成文约定（可预期的失败用返回值表达；throw 会被 IPC 层裹成
 * 通用文案，丢掉归类后的单行原因）。
 */
async function listEndpointModels({
  baseUrl,
  timeoutMs = DEFAULT_ENDPOINT_TIMEOUT_MS,
  fetchImpl = fetch
} = {}) {
  if (!isLoopbackUrl(baseUrl)) {
    // 第二道门：即便调用方绕过候选表塞了个外部地址进来，也**不发这个请求**。
    return endpointResult("unreachable", [], "不是本机回环地址，已拒绝探测");
  }
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_ENDPOINT_TIMEOUT_MS;
  const url = `${baseUrl.replace(/\/+$/, "")}/models`;
  let response;
  try {
    response = await fetchImpl(url, { method: "GET", signal: AbortSignal.timeout(ms) });
  } catch (error) {
    return endpointResult("unreachable", [], describeFetchError(error, ms));
  }
  if (response.status === 401 || response.status === 403) {
    return endpointResult("auth-required", [], `该服务要求鉴权（${response.status}），请用「＋ 添加模型」手工配置`);
  }
  if (response.status < 200 || response.status >= 300) {
    return endpointResult("unreachable", [], `服务返回 ${response.status}`);
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    return endpointResult("unreachable", [], "响应不是 JSON");
  }
  // 判据只有 classifyListResponse 一处 —— 不在这里另写一套 if，否则两边会漂移。
  // 代价是模型清单从同一份 payload 再取一次（几条到几十条的小数组，值得）。
  const state = classifyListResponse(response.status, payload);
  if (state === "ready") return endpointResult("ready", parseModelList(payload).models);
  if (state === "empty") return endpointResult("empty", [], "服务在运行，但它还没有任何模型");
  return endpointResult("unreachable", [], "响应不是 OpenAI 兼容的模型列表");
}

/**
 * 解析候选表的端口覆盖。
 *
 * 形态：`ZEROWORK_LOCAL_ENDPOINTS=ollama=51234,lmstudio=52000`（逗号分隔，两侧空白容忍）。
 * 规则：
 *   - 只覆盖**端口**；未知 id / 非数字 / 越界(1..65535) / 片段没有等号 → 忽略该项、
 *     回落默认端口，并记进 `ignored`（可诊断的降级，不是静默）
 *   - 同一个 id 写两次时后写的生效
 *   - 空字符串、只有空白、尾部逗号都是常态，不算错误
 *   - 值必须是纯十进制整数：任何夹带主机名、冒号、小数点或符号的写法都会被挡在
 *     `not-a-number` 上 —— 注入没有改主机名的入口
 */
function parseEndpointOverrides(env) {
  const ports = new Map();
  const ignored = [];
  const raw = env === null || env === void 0 ? void 0 : env[LOCAL_ENDPOINTS_ENV_KEY];
  if (typeof raw !== "string") return { ports, ignored };
  for (const fragment of raw.split(",")) {
    const piece = fragment.trim();
    if (piece === "") continue;
    const at = piece.indexOf("=");
    if (at <= 0) {
      ignored.push({ id: piece, value: "", reason: "malformed" });
      continue;
    }
    const id = piece.slice(0, at).trim();
    const value = piece.slice(at + 1).trim();
    const known = LOCAL_ENDPOINT_CANDIDATES.some((candidate) => candidate.id === id);
    if (!known) {
      ignored.push({ id, value, reason: "unknown-id" });
      continue;
    }
    if (!/^\d+$/.test(value)) {
      ignored.push({ id, value, reason: "not-a-number" });
      continue;
    }
    const port = Number(value);
    if (port < 1 || port > 65535) {
      ignored.push({ id, value, reason: "out-of-range" });
      continue;
    }
    ports.set(id, port);
  }
  return { ports, ignored };
}

/**
 * 解析出这一轮要探的候选。
 *
 * 返回 `{ candidates, overridden, ignored }` —— 调用方据此能分辨「哪些项被覆盖了」
 * 还是「都是默认」，也能把 `ignored` 如实报给界面（IPC 契约里的 `probeErrors`）。
 * `candidates` 永远是**副本**：调用方改它不会污染候选表常量。
 */
function resolveCandidates(env) {
  const { ports, ignored } = parseEndpointOverrides(env);
  const candidates = LOCAL_ENDPOINT_CANDIDATES.map((candidate) => {
    const port = ports.get(candidate.id);
    return port === void 0 ? { ...candidate } : { ...candidate, port };
  });
  const overridden = [...ports.entries()].map(([id, port]) => ({ id, port }));
  return { candidates, overridden, ignored };
}

/** 结果里带一个地址，但坏端口不值得让整轮探测炸掉 —— 拿不到就置空。 */
function tryLoopbackBaseUrl(port) {
  try {
    return loopbackBaseUrl(port);
  } catch {
    return "";
  }
}

/**
 * 并发探测一批候选，逐项返回 `{ id, label, baseUrl, state, models, detail? }`。
 *
 * 两条约束：
 *   - **并发**：串行探五项会让界面白等五倍
 *   - **总耗时设上限**：某项卡住时整轮在上限内收口，未完成项标成 `unreachable`
 *     （它同样是「没探到」，不是错误）。上限默认取「单项上限 + 200 毫秒余量」与
 *     1600 毫秒的较大者；并发执行下正常情况下所有项都在一个单项上限内收口。
 *
 * 候选表被手工塞进非法端口时，只有那一项变成 `unreachable` 并**省略 baseUrl**
 * （正常路径由 resolveCandidates 产出，不会有这种项）—— 整体绝不抛。
 */
async function probeLocalEndpoints({
  candidates = LOCAL_ENDPOINT_CANDIDATES,
  timeoutMs = DEFAULT_ENDPOINT_TIMEOUT_MS,
  totalTimeoutMs,
  fetchImpl = fetch
} = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  if (list.length === 0) return [];
  const ms = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_ENDPOINT_TIMEOUT_MS;
  const budgetMs =
    Number.isFinite(totalTimeoutMs) && totalTimeoutMs > 0
      ? totalTimeoutMs
      : Math.max(DEFAULT_TOTAL_TIMEOUT_MS, ms + 200);
  const settled = new Map();
  const baseUrls = new Map();
  const work = list.map(async (candidate) => {
    let baseUrl;
    try {
      baseUrl = loopbackBaseUrl(candidate.port);
    } catch {
      settled.set(candidate.id, endpointResult("unreachable", [], `候选表里的端口不合法（${candidate.id}）`));
      return;
    }
    baseUrls.set(candidate.id, baseUrl);
    let result;
    try {
      result = await listEndpointModels({ baseUrl, timeoutMs: ms, fetchImpl });
    } catch (error) {
      // listEndpointModels 自己不会抛；兜一层只为「整轮绝不抛」这条性质。
      result = endpointResult("unreachable", [], describeFetchError(error, ms));
    }
    settled.set(candidate.id, result);
  });
  let timer;
  const budget = new Promise((resolve) => {
    timer = setTimeout(() => resolve("budget"), budgetMs);
    timer.unref?.();
  });
  await Promise.race([Promise.all(work).then(() => "done"), budget]);
  clearTimeout(timer);
  return list.map((candidate) => {
    const result =
      settled.get(candidate.id) ??
      endpointResult("unreachable", [], `探测总耗时超过 ${budgetMs} 毫秒上限，该项未完成`);
    const baseUrl = baseUrls.get(candidate.id);
    return baseUrl === void 0
      ? { id: candidate.id, label: candidate.label, ...result }
      : { id: candidate.id, label: candidate.label, baseUrl, ...result };
  });
}

export {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_ENDPOINT_TIMEOUT_MS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TOTAL_TIMEOUT_MS,
  LOCAL_ENDPOINTS_ENV_KEY,
  LOCAL_ENDPOINT_CANDIDATES,
  LOCAL_PLACEHOLDER_API_KEY,
  PROVIDER_ID_PREFIX,
  buildProviderInput,
  classifyListResponse,
  isLoopbackUrl,
  listEndpointModels,
  loopbackBaseUrl,
  parseModelList,
  probeLocalEndpoints,
  providerIdFor,
  resolveCandidates,
};