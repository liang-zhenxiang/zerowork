/**
 * 本机模型服务探测的单元测试。
 *
 * 这一层是**安全边界**所在：候选表决定应用会主动向哪些地址发请求。
 * 所以除了功能覆盖，另有两类断言是刻意加的：
 *
 *   1. **候选表里不许有 host / baseUrl 字段** —— 没有字段就没有「被填个域名进去」
 *      的入口，地址只能由 `loopbackBaseUrl` 用写死的回环 IP 字面量构造。
 *      另有一条**静态断言**直接扫模块源码，确保没有别的主机名字面量混进去。
 *   2. **注入（`ZEROWORK_LOCAL_ENDPOINTS`）只能改端口** —— 不能新增候选、不能改
 *      主机名、更不能借一个带冒号的值把主机名夹带进来。于是「只探回环、只探固定
 *      几项」这条性质不因为「要可测」而失效。
 *
 * 网络只有 `listEndpointModels` 一处，`fetchImpl` 可注入 —— **全部用例都不真的联网**。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import {
	LOCAL_ENDPOINT_CANDIDATES,
	LOCAL_PLACEHOLDER_API_KEY,
	buildProviderInput,
	classifyListResponse,
	listEndpointModels,
	loopbackBaseUrl,
	parseModelList,
	probeLocalEndpoints,
	providerIdFor,
	resolveCandidates,
} from "../../src/main/daemon/local-endpoints.js";
import { validateCustomProvider } from "../../src/main/daemon/validation.js";

/** 造一个够用的 Response 替身：实现只用 `status` 与 `json()`（不看 `ok`）。 */
const jsonResponse = (status, body) => ({
	status,
	json: async () => body,
});

/** `json()` 会抛的替身 —— 对应「2xx 但响应体不是 JSON」。 */
const brokenJsonResponse = (status) => ({
	status,
	json: async () => {
		throw new SyntaxError("Unexpected token < in JSON at position 0");
	},
});

/** 超时错误：Node 的 fetch 在信号超时时抛的就是这个形状（name 为 TimeoutError）。 */
const timeoutError = () =>
	Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

/** 从模块源码里取文本，供静态断言用。 */
const MODULE_SOURCE = readFileSync(
	new URL("../../src/main/daemon/local-endpoints.js", import.meta.url),
	"utf8",
);

/** 除回环 IP 字面量外，模块源码里一个都不许出现的写法。 */
const FORBIDDEN_HOST_LITERALS = ["0.0.0.0", "localhost", "192.168.", "::1"];

// ── 候选表 ────────────────────────────────────────────────

describe("LOCAL_ENDPOINT_CANDIDATES", () => {
	it("非空，且每项 id 合法（小写字母开头、只含小写字母数字连字符）", () => {
		expect(LOCAL_ENDPOINT_CANDIDATES.length).toBeGreaterThan(0);
		for (const candidate of LOCAL_ENDPOINT_CANDIDATES) {
			expect(candidate.id, `${candidate.id} 不满足 ^[a-z][a-z0-9-]*$`).toMatch(/^[a-z][a-z0-9-]*$/);
		}
	});

	it("每项有非空的展示名", () => {
		for (const candidate of LOCAL_ENDPOINT_CANDIDATES) {
			expect(typeof candidate.label, `${candidate.id} 缺 label`).toBe("string");
			expect(candidate.label.trim().length, `${candidate.id} 的 label 是空的`).toBeGreaterThan(0);
		}
	});

	it("每项端口是 1..65535 的整数", () => {
		for (const candidate of LOCAL_ENDPOINT_CANDIDATES) {
			expect(Number.isInteger(candidate.port), `${candidate.id} 的端口不是整数`).toBe(true);
			expect(candidate.port, `${candidate.id} 的端口越界`).toBeGreaterThanOrEqual(1);
			expect(candidate.port, `${candidate.id} 的端口越界`).toBeLessThanOrEqual(65535);
		}
	});

	it("id 与端口都没有重复", () => {
		const ids = LOCAL_ENDPOINT_CANDIDATES.map((c) => c.id);
		expect(new Set(ids).size, `候选表里 id 有重复：${ids.join(",")}`).toBe(ids.length);
		const ports = LOCAL_ENDPOINT_CANDIDATES.map((c) => c.port);
		expect(new Set(ports).size, `候选表里端口有重复：${ports.join(",")}`).toBe(ports.length);
	});

	it("每项只有 id / label / port 三个字段 —— 没有 host / baseUrl 这类可填地址的字段", () => {
		for (const candidate of LOCAL_ENDPOINT_CANDIDATES) {
			expect(Object.keys(candidate).sort(), `${candidate.id} 多出了字段`).toEqual([
				"id",
				"label",
				"port",
			]);
		}
	});

	it("覆盖调研结论里写明的五项服务", () => {
		const ids = LOCAL_ENDPOINT_CANDIDATES.map((c) => c.id);
		for (const id of ["ollama", "lmstudio", "vllm", "localai", "jan"]) {
			expect(ids, `候选表里没有 ${id}`).toContain(id);
		}
	});
});

describe("模块源码的静态断言", () => {
	it("除回环 IP 字面量外，源码里不出现任何主机名字面量", () => {
		for (const literal of FORBIDDEN_HOST_LITERALS) {
			expect(
				MODULE_SOURCE.includes(literal),
				`模块源码里出现了主机名字面量 ${literal} —— 本模块只允许回环 IP`,
			).toBe(false);
		}
	});

	it("也不出现「只探一个固定端口区间」式的遍历写法提示（port 由候选表给出）", () => {
		// 仅作形状守卫：候选表里的端口必须是字面量常量，不从运行时算出来。
		expect(MODULE_SOURCE.includes("LOCAL_ENDPOINT_CANDIDATES = [")).toBe(true);
	});
});

// ── loopbackBaseUrl ──────────────────────────────────────

describe("loopbackBaseUrl", () => {
	it("主机名恒为回环 IP，路径落在 /v1 这一层", () => {
		expect(loopbackBaseUrl(11434)).toBe("http://127.0.0.1:11434/v1");
		expect(loopbackBaseUrl(1234)).toBe("http://127.0.0.1:1234/v1");
		expect(loopbackBaseUrl(1)).toBe("http://127.0.0.1:1/v1");
		expect(loopbackBaseUrl(65535)).toBe("http://127.0.0.1:65535/v1");
	});

	it("每一对（端口 → 地址）解析出来的主机名都是回环", () => {
		for (const candidate of LOCAL_ENDPOINT_CANDIDATES) {
			const url = new URL(loopbackBaseUrl(candidate.port));
			expect(url.hostname, `${candidate.id} 的地址不是回环`).toBe("127.0.0.1");
			expect(url.protocol).toBe("http:");
			expect(url.pathname).toBe("/v1");
		}
	});

	it.each([
		["0", 0],
		["负数", -1],
		["越界上界", 65536],
		["小数", 1.5],
		["NaN", Number.NaN],
		["字符串", "11434"],
		["undefined", undefined],
		["null", null],
	])("非法端口（%s）直接拒绝，不构造出一个坏地址", (_label, port) => {
		expect(() => loopbackBaseUrl(port)).toThrow();
	});
});

// ── parseModelList ───────────────────────────────────────

describe("parseModelList", () => {
	it("正常形状：取出 id 与 name", () => {
		const parsed = parseModelList({
			object: "list",
			data: [
				{ id: "qwen2.5:7b", object: "model" },
				{ id: "llama3.2", name: "Llama 3.2" },
			],
		});
		expect(parsed.ok).toBe(true);
		expect(parsed.models).toEqual([
			{ id: "qwen2.5:7b", name: "qwen2.5:7b" },
			{ id: "llama3.2", name: "Llama 3.2" },
		]);
	});

	it("name 缺失或只有空白时回落到 id", () => {
		const parsed = parseModelList({ data: [{ id: "a" }, { id: "b", name: "   " }] });
		expect(parsed.ok).toBe(true);
		expect(parsed.models.map((m) => m.name)).toEqual(["a", "b"]);
	});

	it("id 两端的空白被去掉（并且 name 的回落用的是去掉空白后的 id）", () => {
		const parsed = parseModelList({ data: [{ id: "  org/model  " }] });
		expect(parsed.ok).toBe(true);
		expect(parsed.models).toEqual([{ id: "org/model", name: "org/model" }]);
	});

	it("空数组是合法的 —— 那是「服务在跑但没模型」，不是错误", () => {
		const parsed = parseModelList({ object: "list", data: [] });
		expect(parsed.ok).toBe(true);
		expect(parsed.models).toEqual([]);
	});

	it.each([
		["缺 data", { object: "list" }, "missing-data"],
		["data 不是数组", { data: {} }, "data-not-array"],
		["data 是字符串", { data: "qwen" }, "data-not-array"],
		["data 是 null", { data: null }, "data-not-array"],
		["某项缺 id", { data: [{ name: "x" }] }, "item-missing-id"],
		["某项 id 为空串", { data: [{ id: "   " }] }, "item-missing-id"],
		["某项 id 不是字符串", { data: [{ id: 7 }] }, "item-missing-id"],
		["某项不是对象", { data: ["qwen"] }, "item-missing-id"],
	])("形状不对时返回可区分的原因：%s", (_label, payload, reason) => {
		const parsed = parseModelList(payload);
		expect(parsed.ok).toBe(false);
		expect(parsed.reason).toBe(reason);
	});

	it.each([
		["null", null],
		["数组", []],
		["字符串", "<html>"],
		["undefined", undefined],
		["数字", 42],
	])("顶层不是对象（%s）时返回 not-an-object", (_label, payload) => {
		const parsed = parseModelList(payload);
		expect(parsed.ok).toBe(false);
		expect(parsed.reason).toBe("not-an-object");
	});
});

// ── classifyListResponse ─────────────────────────────────

describe("classifyListResponse", () => {
	it("2xx 且至少一个模型 → ready", () => {
		expect(classifyListResponse(200, { data: [{ id: "a" }] })).toBe("ready");
		expect(classifyListResponse(201, { data: [{ id: "a" }] })).toBe("ready");
	});

	it("2xx 但零模型 → empty（与「没探到」是两件事）", () => {
		expect(classifyListResponse(200, { object: "list", data: [] })).toBe("empty");
	});

	it("2xx 但形状不对 → unreachable", () => {
		expect(classifyListResponse(200, { object: "list" })).toBe("unreachable");
		expect(classifyListResponse(200, { data: {} })).toBe("unreachable");
		expect(classifyListResponse(200, { data: [{ name: "x" }] })).toBe("unreachable");
	});

	it("2xx 但响应体不是 JSON（payload 为 undefined）→ unreachable", () => {
		expect(classifyListResponse(200, undefined)).toBe("unreachable");
	});

	it.each([401, 403])("%i 是「探到了但要鉴权」，不是「没探到」", (status) => {
		expect(classifyListResponse(status, undefined)).toBe("auth-required");
		expect(classifyListResponse(status, { error: "unauthorized" })).toBe("auth-required");
	});

	it.each([404, 429, 500, 502, 302, 0])("非 2xx 且不是鉴权（%i）→ unreachable", (status) => {
		expect(classifyListResponse(status, undefined)).toBe("unreachable");
	});

	it("四态互斥：同一个响应只落一个状态", () => {
		const states = [
			classifyListResponse(200, { data: [{ id: "a" }] }),
			classifyListResponse(200, { data: [] }),
			classifyListResponse(401, undefined),
			classifyListResponse(500, undefined),
		];
		expect(new Set(states).size).toBe(4);
	});
});

// ── resolveCandidates ────────────────────────────────────

describe("resolveCandidates", () => {
	it("不传 env 时就是候选表的默认端口", () => {
		const { candidates, overridden, ignored } = resolveCandidates();
		expect(candidates).toEqual(LOCAL_ENDPOINT_CANDIDATES);
		expect(overridden).toEqual([]);
		expect(ignored).toEqual([]);
	});

	it("返回的是副本 —— 改它不会污染候选表常量", () => {
		const { candidates } = resolveCandidates();
		candidates[0].port = 1;
		expect(LOCAL_ENDPOINT_CANDIDATES[0].port).not.toBe(1);
	});

	it("按 id 覆盖端口（只覆盖写到的那些）", () => {
		const { candidates, overridden } = resolveCandidates({
			ZEROWORK_LOCAL_ENDPOINTS: "ollama=51234",
		});
		const byId = Object.fromEntries(candidates.map((c) => [c.id, c]));
		expect(byId["ollama"].port).toBe(51234);
		expect(byId["lmstudio"].port).toBe(1234);
		expect(candidates.length).toBe(LOCAL_ENDPOINT_CANDIDATES.length);
		expect(overridden).toEqual([{ id: "ollama", port: 51234 }]);
	});

	it("支持多个条目、多余空格与尾部逗号", () => {
		const { candidates, overridden, ignored } = resolveCandidates({
			ZEROWORK_LOCAL_ENDPOINTS: " ollama = 51234 , lmstudio=52000 , ",
		});
		const byId = Object.fromEntries(candidates.map((c) => [c.id, c]));
		expect(byId["ollama"].port).toBe(51234);
		expect(byId["lmstudio"].port).toBe(52000);
		expect(overridden).toEqual([
			{ id: "ollama", port: 51234 },
			{ id: "lmstudio", port: 52000 },
		]);
		expect(ignored).toEqual([]);
	});

	it("同一个 id 写两次时后者生效", () => {
		const { candidates } = resolveCandidates({ ZEROWORK_LOCAL_ENDPOINTS: "ollama=1,ollama=51234" });
		expect(candidates.find((c) => c.id === "ollama").port).toBe(51234);
	});

	it.each([
		["空 env", ""],
		["只有空白", "   "],
		["未定义", undefined],
		["空对象成员", {}],
	])("%s 时回落默认、不抛错", (_label, value) => {
		const env = typeof value === "string" ? { ZEROWORK_LOCAL_ENDPOINTS: value } : {};
		const { candidates, overridden, ignored } = resolveCandidates(env);
		expect(candidates).toEqual(LOCAL_ENDPOINT_CANDIDATES);
		expect(overridden).toEqual([]);
		expect(ignored).toEqual([]);
	});

	it.each([
		["未知 id", "evil=1234", "unknown-id"],
		["非数字", "ollama=abc", "not-a-number"],
		["小数", "ollama=114.5", "not-a-number"],
		["负数", "ollama=-1", "not-a-number"],
		["空值", "ollama=", "not-a-number"],
		["十六进制", "ollama=0x10", "not-a-number"],
		["越界下界（0）", "ollama=0", "out-of-range"],
		["越界上界（65536）", "ollama=65536", "out-of-range"],
		["片段里没有等号", "ollama", "malformed"],
	])("%s 时忽略该项、回落默认端口，并记下原因", (_label, raw, reason) => {
		const { candidates, overridden, ignored } = resolveCandidates({
			ZEROWORK_LOCAL_ENDPOINTS: raw,
		});
		expect(candidates, "候选数量不该因为坏片段而变化").toEqual(LOCAL_ENDPOINT_CANDIDATES);
		expect(overridden).toEqual([]);
		expect(ignored.length).toBe(1);
		expect(ignored[0].reason).toBe(reason);
	});

	it("注入不能新增候选 —— 选项永远只有候选表里那几项", () => {
		const { candidates } = resolveCandidates({
			ZEROWORK_LOCAL_ENDPOINTS: "evil=1234,ollama=51234",
		});
		expect(candidates.map((c) => c.id)).toEqual(LOCAL_ENDPOINT_CANDIDATES.map((c) => c.id));
	});

	it("注入不能借「主机名:端口」的形状把主机名夹带进来", () => {
		const { candidates, ignored } = resolveCandidates({
			ZEROWORK_LOCAL_ENDPOINTS: "ollama=192.168.1.9:11434",
		});
		expect(candidates.find((c) => c.id === "ollama").port).toBe(11434);
		expect(ignored.length).toBe(1);
		expect(ignored[0].reason).toBe("not-a-number");
	});

	it("注入不能改展示名", () => {
		const { candidates } = resolveCandidates({ ZEROWORK_LOCAL_ENDPOINTS: "ollama=51234" });
		expect(candidates.find((c) => c.id === "ollama").label).toBe(
			LOCAL_ENDPOINT_CANDIDATES.find((c) => c.id === "ollama").label,
		);
	});

	it("只认 ZEROWORK_LOCAL_ENDPOINTS 这一个环境变量名", () => {
		const { candidates } = resolveCandidates({ ZEROWORK_LOCAL_ENDPOINT: "ollama=51234" });
		expect(candidates).toEqual(LOCAL_ENDPOINT_CANDIDATES);
	});
});

// ── providerIdFor ────────────────────────────────────────

describe("providerIdFor", () => {
	it("每一项都满足服务商 id 的合法正则", () => {
		for (const candidate of LOCAL_ENDPOINT_CANDIDATES) {
			expect(providerIdFor(candidate), `${candidate.id} 的 id 不合法`).toMatch(/^[a-z][a-z0-9-]*$/);
		}
	});

	it("五项互不相同", () => {
		const ids = LOCAL_ENDPOINT_CANDIDATES.map(providerIdFor);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("统一带前缀 —— 靠前缀结构性地避开与内置服务商重名，而不是靠运气", () => {
		for (const candidate of LOCAL_ENDPOINT_CANDIDATES) {
			expect(providerIdFor(candidate).startsWith("local-"), `${candidate.id} 没带前缀`).toBe(true);
		}
	});

	it("不与常见的内置服务商 id 撞名", () => {
		const builtinIds = [
			"anthropic",
			"openai",
			"google",
			"xai",
			"openrouter",
			"deepseek",
			"mistral",
			"groq",
			"ollama",
			"lmstudio",
			"vllm",
			"localai",
			"jan",
		];
		for (const candidate of LOCAL_ENDPOINT_CANDIDATES) {
			expect(builtinIds, `${candidate.id} 与内置 id 撞名`).not.toContain(providerIdFor(candidate));
		}
	});

	it("同一个候选每次算出来都一样（稳定）", () => {
		const candidate = LOCAL_ENDPOINT_CANDIDATES[0];
		expect(providerIdFor(candidate)).toBe(providerIdFor(candidate));
	});
});

// ── buildProviderInput ───────────────────────────────────

describe("buildProviderInput", () => {
	const ollama = LOCAL_ENDPOINT_CANDIDATES.find((c) => c.id === "ollama");
	const models = [{ id: "qwen2.5:7b", name: "qwen2.5:7b" }];

	it("产出的入参能通过既有的服务商校验（直接拿 validation.js 验，不复述规则）", () => {
		const input = buildProviderInput(ollama, models);
		const validation = validateCustomProvider(input);
		expect(validation.errors).toEqual({});
		expect(validation.ok).toBe(true);
	});

	it("字段与既有形状一致：openai 兼容 + 回环地址 + 展示名带服务名", () => {
		const input = buildProviderInput(ollama, models);
		expect(input.id).toBe(providerIdFor(ollama));
		expect(input.api).toBe("openai-completions");
		expect(input.baseUrl).toBe(loopbackBaseUrl(ollama.port));
		expect(input.name).toContain(ollama.label);
	});

	it("带占位凭据 —— 不带凭据的模型 isUsable 为 false，一键接入等于没做", () => {
		const input = buildProviderInput(ollama, models);
		expect(typeof input.apiKey).toBe("string");
		expect(input.apiKey).toBe(LOCAL_PLACEHOLDER_API_KEY);
		expect(input.apiKey.trim().length).toBeGreaterThan(0);
	});

	it("模型项字段齐全且取值为正的上下文/输出上限", () => {
		const input = buildProviderInput(ollama, models);
		expect(input.models.length).toBe(1);
		for (const model of input.models) {
			expect(typeof model.id).toBe("string");
			expect(model.id.trim().length).toBeGreaterThan(0);
			expect(typeof model.name).toBe("string");
			expect(model.contextWindow, "上下文窗口需大于 0").toBeGreaterThan(0);
			expect(model.maxTokens, "单次最大输出需大于 0").toBeGreaterThan(0);
			expect(model.reasoning).toBe(false);
			expect(model.vision).toBe(false);
		}
	});

	it("模型 id 去重（服务重复报同一个 id 时不产生非法配置）", () => {
		const input = buildProviderInput(ollama, [
			{ id: "a", name: "A" },
			{ id: "a", name: "A 又一次" },
			{ id: "b", name: "B" },
		]);
		expect(input.models.map((m) => m.id)).toEqual(["a", "b"]);
		expect(validateCustomProvider(input).ok).toBe(true);
	});

	it("丢掉空的/非法的模型项后仍能通过校验", () => {
		const input = buildProviderInput(ollama, [
			{ id: "  " },
			null,
			"qwen",
			{ id: "ok", name: "" },
		]);
		expect(input.models.map((m) => m.id)).toEqual(["ok"]);
		expect(validateCustomProvider(input).ok).toBe(true);
	});

	it("零模型时返回 undefined（调用方据此给出「该服务没有可用模型」）", () => {
		expect(buildProviderInput(ollama, [])).toBeUndefined();
		expect(buildProviderInput(ollama, undefined)).toBeUndefined();
	});

	it("不改动传进来的 models 数组", () => {
		const source = [{ id: "a", name: "A" }];
		buildProviderInput(ollama, source);
		expect(source).toEqual([{ id: "a", name: "A" }]);
	});
});

// ── listEndpointModels ───────────────────────────────────

describe("listEndpointModels", () => {
	const baseUrl = loopbackBaseUrl(11434);

	it("先拒一道非回环地址 —— 不发这个请求", async () => {
		let called = 0;
		const fetchImpl = async () => {
			called += 1;
			return jsonResponse(200, { data: [{ id: "a" }] });
		};
		for (const bad of [
			"http://0.0.0.0:11434/v1",
			"http://192.168.1.9:11434/v1",
			"http://example.com/v1",
			"http://127.0.0.1.evil.com:11434/v1",
			"https://127.0.0.1:11434/v1",
			"not a url",
			undefined,
		]) {
			const result = await listEndpointModels({ baseUrl: bad, fetchImpl });
			expect(result.state, `${String(bad)} 不该被探测`).toBe("unreachable");
			expect(result.models).toEqual([]);
		}
		expect(called, "非回环地址一个请求都不该发出去").toBe(0);
	});

	it("GET {baseUrl}/models，不重复斜杠", async () => {
		const seen = [];
		const fetchImpl = async (url, init) => {
			seen.push([url, init]);
			return jsonResponse(200, { data: [{ id: "a" }] });
		};
		await listEndpointModels({ baseUrl, fetchImpl });
		await listEndpointModels({ baseUrl: `${baseUrl}/`, fetchImpl });
		expect(seen.map(([url]) => url)).toEqual([
			"http://127.0.0.1:11434/v1/models",
			"http://127.0.0.1:11434/v1/models",
		]);
		expect(seen[0][1].method).toBe("GET");
	});

	it("2xx + 有模型 → ready，并带回模型清单", async () => {
		const result = await listEndpointModels({
			baseUrl,
			fetchImpl: async () => jsonResponse(200, { object: "list", data: [{ id: "qwen2.5:7b" }] }),
		});
		expect(result.state).toBe("ready");
		expect(result.models).toEqual([{ id: "qwen2.5:7b", name: "qwen2.5:7b" }]);
	});

	it("2xx + 零模型 → empty，并给出「去拉一个模型」的指引（不是错误）", async () => {
		const result = await listEndpointModels({
			baseUrl,
			fetchImpl: async () => jsonResponse(200, { object: "list", data: [] }),
		});
		expect(result.state).toBe("empty");
		expect(result.models).toEqual([]);
		expect(result.detail).toContain("还没有任何模型");
	});

	it.each([401, 403])("%i → auth-required，并指向手工添加模型的路径", async (status) => {
		const result = await listEndpointModels({
			baseUrl,
			fetchImpl: async () => jsonResponse(status, { error: "unauthorized" }),
		});
		expect(result.state).toBe("auth-required");
		expect(result.models).toEqual([]);
		expect(result.detail).toContain("鉴权");
	});

	it.each([404, 500, 503])("%i → unreachable，且 detail 带上状态码", async (status) => {
		const result = await listEndpointModels({
			baseUrl,
			fetchImpl: async () => jsonResponse(status, {}),
		});
		expect(result.state).toBe("unreachable");
		expect(result.detail).toContain(String(status));
	});

	it("2xx 但响应体不是 JSON → unreachable，不抛", async () => {
		const result = await listEndpointModels({
			baseUrl,
			fetchImpl: async () => brokenJsonResponse(200),
		});
		expect(result.state).toBe("unreachable");
		expect(result.models).toEqual([]);
	});

	it("2xx 但形状不是 OpenAI 兼容的清单 → unreachable", async () => {
		const result = await listEndpointModels({
			baseUrl,
			fetchImpl: async () => jsonResponse(200, { models: [{ name: "x" }] }),
		});
		expect(result.state).toBe("unreachable");
	});

	it("连接被拒（fetch 抛错）→ unreachable，不抛", async () => {
		const result = await listEndpointModels({
			baseUrl,
			fetchImpl: async () => {
				throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
			},
		});
		expect(result.state).toBe("unreachable");
		expect(result.detail).toContain("无法连接");
	});

	it("超时 → unreachable，且 detail 说明是超时（与「连接被拒」可辨）", async () => {
		const result = await listEndpointModels({
			baseUrl,
			timeoutMs: 500,
			fetchImpl: async () => {
				throw timeoutError();
			},
		});
		expect(result.state).toBe("unreachable");
		expect(result.detail).toContain("超时");
		expect(result.detail).toContain("500");
	});

	it("超时靠 AbortSignal 施加在真实 fetch 上（注入的 fetchImpl 能拿到信号）", async () => {
		let signal;
		await listEndpointModels({
			baseUrl,
			timeoutMs: 1234,
			fetchImpl: async (_url, init) => {
				signal = init.signal;
				return jsonResponse(200, { data: [{ id: "a" }] });
			},
		});
		expect(signal).toBeInstanceOf(globalThis.AbortSignal);
	});

	it("非法 timeoutMs 回落到默认值，不自造一个 0 毫秒超时", async () => {
		let captured;
		await listEndpointModels({
			baseUrl,
			timeoutMs: 0,
			fetchImpl: async (_url, init) => {
				captured = init;
				return jsonResponse(200, { data: [{ id: "a" }] });
			},
		});
		expect(captured.signal).toBeInstanceOf(globalThis.AbortSignal);
		expect(captured.signal.aborted).toBe(false);
	});

	it("四种状态的返回值形状一致（都有 state 与 models）", async () => {
		const cases = [
			jsonResponse(200, { data: [{ id: "a" }] }),
			jsonResponse(200, { data: [] }),
			jsonResponse(401, {}),
			jsonResponse(500, {}),
		];
		for (const response of cases) {
			const result = await listEndpointModels({ baseUrl, fetchImpl: async () => response });
			expect(typeof result.state).toBe("string");
			expect(Array.isArray(result.models)).toBe(true);
		}
	});
});

// ── probeLocalEndpoints ──────────────────────────────────

describe("probeLocalEndpoints", () => {
	const okFetch = async () => jsonResponse(200, { object: "list", data: [{ id: "qwen2.5:7b" }] });

	it("候选为空数组时返回空数组（不抛）", async () => {
		expect(await probeLocalEndpoints({ candidates: [], fetchImpl: okFetch })).toEqual([]);
		expect(await probeLocalEndpoints({ candidates: undefined, fetchImpl: okFetch }).then((r) => r.length)).toBe(
			LOCAL_ENDPOINT_CANDIDATES.length,
		);
	});

	it("逐项返回 { id, label, baseUrl, state, models }，顺序与候选表一致", async () => {
		const results = await probeLocalEndpoints({ fetchImpl: okFetch });
		expect(results.map((r) => r.id)).toEqual(LOCAL_ENDPOINT_CANDIDATES.map((c) => c.id));
		for (const [index, result] of results.entries()) {
			const candidate = LOCAL_ENDPOINT_CANDIDATES[index];
			expect(result.label).toBe(candidate.label);
			expect(result.baseUrl).toBe(loopbackBaseUrl(candidate.port));
			expect(new URL(result.baseUrl).hostname).toBe("127.0.0.1");
			expect(result.state).toBe("ready");
			expect(result.models.length).toBe(1);
		}
	});

	it("是并发的 —— 否则「同时探五项」会变成串行的五倍等待", async () => {
		let inFlight = 0;
		let peak = 0;
		const fetchImpl = async () => {
			inFlight += 1;
			peak = Math.max(peak, inFlight);
			await delay(20);
			inFlight -= 1;
			return jsonResponse(200, { data: [{ id: "m" }] });
		};
		await probeLocalEndpoints({ fetchImpl, timeoutMs: 5000 });
		expect(peak, "没有观察到并发（同时在飞的请求数 ≤ 1）").toBeGreaterThan(1);
	});

	it("某一项抛错不影响其它项", async () => {
		const fetchImpl = async (url) => {
			if (url.includes(":1234/")) throw new TypeError("fetch failed");
			return jsonResponse(200, { data: [{ id: "m" }] });
		};
		const results = await probeLocalEndpoints({ fetchImpl });
		const byId = Object.fromEntries(results.map((r) => [r.id, r]));
		expect(byId["lmstudio"].state).toBe("unreachable");
		expect(byId["ollama"].state).toBe("ready");
		expect(byId["vllm"].state).toBe("ready");
	});

	it("候选表里有非法端口时也只让该项 unreachable，整体不抛", async () => {
		const results = await probeLocalEndpoints({
			candidates: [
				{ id: "broken", label: "坏项", port: 0 },
				{ id: "ollama", label: "Ollama", port: 11434 },
			],
			fetchImpl: okFetch,
		});
		const byId = Object.fromEntries(results.map((r) => [r.id, r]));
		expect(byId["broken"].state).toBe("unreachable");
		expect(byId["ollama"].state).toBe("ready");
	});

	it("总耗时上限生效：单项一直不响应时，整体在上限内收口并把未完成项标成 unreachable", async () => {
		// 「端口开着但永不响应」的替身：只在信号中止时才失败，自己不会先返回。
		const hangingFetch = (_url, init) =>
			new Promise((_resolve, reject) => {
				init?.signal?.addEventListener?.("abort", () => reject(timeoutError()));
			});
		const startedAt = Date.now();
		const results = await probeLocalEndpoints({
			fetchImpl: hangingFetch,
			timeoutMs: 800,
			totalTimeoutMs: 60,
		});
		const elapsed = Date.now() - startedAt;
		expect(elapsed, `等了 ${elapsed} 毫秒，总上限没生效`).toBeLessThan(1000);
		expect(results.length).toBe(LOCAL_ENDPOINT_CANDIDATES.length);
		for (const result of results) {
			expect(result.state).toBe("unreachable");
			expect(result.detail).toContain("上限");
		}
	});

	it("每项都拿到结果时不会因为总上限而误标（正常路径不受上限影响）", async () => {
		const results = await probeLocalEndpoints({ fetchImpl: okFetch, totalTimeoutMs: 3000 });
		expect(results.every((r) => r.state === "ready")).toBe(true);
	});

	it("省略 candidates / timeoutMs 时用默认候选表与默认超时", async () => {
		// 仍然注入 fetchImpl：这条用例不许真的联网（默认候选表是真实端口）。
		const results = await probeLocalEndpoints({ candidates: undefined, fetchImpl: okFetch });
		expect(results.length).toBe(LOCAL_ENDPOINT_CANDIDATES.length);
	});
});