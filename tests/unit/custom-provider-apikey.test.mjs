/**
 * 自定义服务商条目里 `apiKey` 的读写口径（models.js 的 upsertCustomProvider）。
 *
 * 守的一件事：**upsertCustomProvider 是白名单重建，`apiKey` 必须能穿过它。**
 *
 * 为什么值得单开一个文件：
 *   - 一键接入本机模型服务时，daemon 会往条目里写一个**占位凭据**
 *     （不带任何凭据的服务商，pi 把它的模型判为不可用、`setModel` 直接抛；
 *     见 tasks/10-06-local-model-discovery/research/model-access.md §Z-1）；
 *   - 而 `apiKey` 不在表单模型（CustomModelInput）里，`readCustomProvider` 也
 *     刻意不回填它 —— 所以「用户编辑一次这个服务商」之后，能保住它的**只有**
 *     upsert 的继承分支。那一支要是没了，表现是「接入成功后去设置页点一下编辑、
 *     保存，模型又变成选不中」，且全程没有任何提示。
 *   - 同一条继承也顺带修掉一个既有缺陷：按 pi 文档手写 `apiKey` 的用户，
 *     条目被本应用认领过一次之后，编辑一次就会丢配置。
 *
 * 文件隔离与 tests/unit/theme-preferences.test.mjs 同一模式：每个用例一个全新的
 * ZEROWORK_CONFIG_DIR 临时目录（getModelsPath 现读环境变量，不缓存），用完即删。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getModelsPath } from "../../src/main/daemon/config-paths.js";
import {
	OWNER_KEY,
	readCustomProvider,
	readModelsJson,
	upsertCustomProvider,
	writeModelsJson,
} from "../../src/main/daemon/models.js";

let configDir;
let previousConfigDir;

const PLACEHOLDER = "local-no-auth";

/** 一键接入产出的那种条目（形状与 buildProviderInput 一致；这里不 import 它，本文件只测落盘口径）。 */
const providerInput = (overrides = {}) => ({
	id: "local-ollama",
	name: "本机 Ollama",
	baseUrl: "http://127.0.0.1:11434/v1",
	api: "openai-completions",
	apiKey: PLACEHOLDER,
	models: [
		{
			id: "llama3.2",
			name: "llama3.2",
			contextWindow: 128000,
			maxTokens: 8192,
			reasoning: false,
			vision: false,
		},
	],
	...overrides,
});

/** 去掉 apiKey 的输入 —— 对应渲染层那条路（表单里根本没有这个字段）。 */
const withoutKey = (overrides = {}) => {
	const { apiKey: _dropped, ...rest } = providerInput(overrides);
	return rest;
};

/** 直接读落盘条目 —— 断言「磁盘上真的有」，而不是只信内存里的返回值。 */
const diskEntry = (providerId = "local-ollama") =>
	readModelsJson(getModelsPath()).providers[providerId];

beforeEach(() => {
	previousConfigDir = process.env["ZEROWORK_CONFIG_DIR"];
	configDir = mkdtempSync(join(tmpdir(), "zerowork-provider-key-"));
	process.env["ZEROWORK_CONFIG_DIR"] = configDir;
});

afterEach(() => {
	if (previousConfigDir === undefined) delete process.env["ZEROWORK_CONFIG_DIR"];
	else process.env["ZEROWORK_CONFIG_DIR"] = previousConfigDir;
	rmSync(configDir, { recursive: true, force: true });
});

describe("upsertCustomProvider —— apiKey 的写入", () => {
	it("输入里给了非空 apiKey 就写进条目", () => {
		upsertCustomProvider(getModelsPath(), providerInput());
		expect(diskEntry().apiKey).toBe(PLACEHOLDER);
	});

	it("两端的空白被去掉（写进配置的值与用于判空的规则是同一个）", () => {
		upsertCustomProvider(getModelsPath(), providerInput({ apiKey: `  ${PLACEHOLDER}  ` }));
		expect(diskEntry().apiKey).toBe(PLACEHOLDER);
	});

	it("输入里的 apiKey 覆盖旧值（用户真的换了一把 key）", () => {
		const path = getModelsPath();
		upsertCustomProvider(path, providerInput());
		upsertCustomProvider(path, providerInput({ apiKey: "sk-new" }));
		expect(diskEntry().apiKey).toBe("sk-new");
	});

	it("输入与旧条目都没有 apiKey 时，条目里不出现这个字段", () => {
		upsertCustomProvider(getModelsPath(), withoutKey());
		expect("apiKey" in diskEntry()).toBe(false);
		expect(diskEntry().apiKey).toBeUndefined();
	});
});

describe("upsertCustomProvider —— apiKey 的继承（白名单重建不能抹掉它）", () => {
	it("输入是 undefined 时继承旧条目的值", () => {
		const path = getModelsPath();
		upsertCustomProvider(path, providerInput());
		upsertCustomProvider(path, withoutKey({ name: "改过的名字" }));
		expect(diskEntry().apiKey).toBe(PLACEHOLDER);
		// 顺带确认这次 upsert 真的生效了（不是「什么都没写」造成的假通过）
		expect(diskEntry().name).toBe("改过的名字");
	});

	it("输入是空串时视为「不改」—— 仍然继承（留空 = 复用已存凭据的既有口径）", () => {
		const path = getModelsPath();
		upsertCustomProvider(path, providerInput());
		upsertCustomProvider(path, providerInput({ apiKey: "" }));
		expect(diskEntry().apiKey).toBe(PLACEHOLDER);
	});

	it("输入只有空白时同样视为「不改」", () => {
		const path = getModelsPath();
		upsertCustomProvider(path, providerInput());
		upsertCustomProvider(path, providerInput({ apiKey: "   " }));
		expect(diskEntry().apiKey).toBe(PLACEHOLDER);
	});

	it("输入是非字符串（渲染层塞了数字 / null）时不写、继承旧值", () => {
		const path = getModelsPath();
		upsertCustomProvider(path, providerInput());
		upsertCustomProvider(path, providerInput({ apiKey: 42 }));
		upsertCustomProvider(path, providerInput({ apiKey: null }));
		expect(diskEntry().apiKey).toBe(PLACEHOLDER);
	});

	it("旧条目里的 apiKey 是空串时不继承 —— 不写一个 pi schema 不允许的值", () => {
		// pi 的 model-config schema：apiKey 是 minLength 1 的字符串。
		const path = getModelsPath();
		writeModelsJson(path, {
			providers: {
				"local-ollama": {
					[OWNER_KEY]: true,
					name: "本机 Ollama",
					baseUrl: "http://127.0.0.1:11434/v1",
					api: "openai-completions",
					apiKey: "",
					models: [],
				},
			},
		});
		upsertCustomProvider(path, withoutKey());
		expect("apiKey" in diskEntry()).toBe(false);
	});
});

describe("readCustomProvider —— 不把凭据暴露给渲染进程", () => {
	it("返回里没有 apiKey 字段", () => {
		upsertCustomProvider(getModelsPath(), providerInput());
		const back = readCustomProvider(getModelsPath(), "local-ollama");
		expect("apiKey" in back).toBe(false);
		expect(back.apiKey).toBeUndefined();
	});

	it("整个返回对象序列化后也找不到那个占位值（不是靠「藏字段」蒙混）", () => {
		upsertCustomProvider(getModelsPath(), providerInput());
		const back = readCustomProvider(getModelsPath(), "local-ollama");
		expect(JSON.stringify(back)).not.toContain(PLACEHOLDER);
	});
});

describe("round-trip：编辑一次不能把占位凭据弄丢", () => {
	it("upsert(带 key) → readCustomProvider → 用读回的值再 upsert → apiKey 仍在", () => {
		const path = getModelsPath();
		upsertCustomProvider(path, providerInput());

		// 设置页「编辑」路径：把读回的东西改一处再存一次（表单里没有 key 字段）
		const back = readCustomProvider(path, "local-ollama");
		expect(back).toBeDefined();
		upsertCustomProvider(path, { ...back, name: "本机 Ollama（改名）" });

		expect(diskEntry().apiKey).toBe(PLACEHOLDER);
		expect(diskEntry().name).toBe("本机 Ollama（改名）");
		// 模型也在（白名单重建不能顺手丢掉模型）
		expect(diskEntry().models.map((m) => m.id)).toEqual(["llama3.2"]);
	});

	it("再加一个模型后保存也保住凭据", () => {
		const path = getModelsPath();
		upsertCustomProvider(path, providerInput());
		const back = readCustomProvider(path, "local-ollama");
		upsertCustomProvider(path, {
			...back,
			models: [
				...back.models,
				{
					id: "qwen2.5:7b",
					name: "qwen2.5:7b",
					contextWindow: 128000,
					maxTokens: 8192,
					reasoning: false,
					vision: false,
				},
			],
		});
		expect(diskEntry().apiKey).toBe(PLACEHOLDER);
		expect(diskEntry().models.map((m) => m.id)).toEqual(["llama3.2", "qwen2.5:7b"]);
	});
});

describe("既有行为不变（动 apiKey 这一处不能顺手改坏别的）", () => {
	it("仍然打 x-zerowork 归属标记", () => {
		upsertCustomProvider(getModelsPath(), providerInput());
		expect(diskEntry()[OWNER_KEY]).toBe(true);
	});

	it("仍然拒绝对手工配置的条目覆写（没有归属标记的）", () => {
		const path = getModelsPath();
		writeModelsJson(path, {
			providers: {
				"local-ollama": {
					name: "手工配的",
					baseUrl: "http://127.0.0.1:11434/v1",
					api: "openai-completions",
					models: [],
				},
			},
		});
		expect(() => upsertCustomProvider(path, providerInput())).toThrow(/手工配置/);
		// 拒绝之后磁盘上一个字都没改
		expect(diskEntry().name).toBe("手工配的");
		expect("apiKey" in diskEntry()).toBe(false);
	});

	it("anthropic + authHeader 的门槛不变（openai 兼容时不写这个字段）", () => {
		const path = getModelsPath();
		upsertCustomProvider(path, providerInput({ authHeader: true }));
		expect("authHeader" in diskEntry()).toBe(false);
		upsertCustomProvider(
			path,
			providerInput({ id: "local-anthropic", api: "anthropic-messages", authHeader: true })
		);
		expect(diskEntry("local-anthropic").authHeader).toBe(true);
	});

	it("compat 白名单不变（只搬两个已知键，未知键不落盘）", () => {
		upsertCustomProvider(
			getModelsPath(),
			providerInput({ compat: { supportsDeveloperRole: true, somethingElse: true } })
		);
		expect(diskEntry().compat).toEqual({ supportsDeveloperRole: true });
	});

	it("模型的 thinkingLevelMap 仍然按模型 id 从旧条目继承", () => {
		const path = getModelsPath();
		writeModelsJson(path, {
			providers: {
				"local-ollama": {
					[OWNER_KEY]: true,
					name: "本机 Ollama",
					baseUrl: "http://127.0.0.1:11434/v1",
					api: "openai-completions",
					apiKey: PLACEHOLDER,
					models: [
						{
							id: "llama3.2",
							name: "llama3.2",
							reasoning: true,
							input: ["text"],
							contextWindow: 128000,
							maxTokens: 8192,
							thinkingLevelMap: { low: "low" },
						},
					],
				},
			},
		});
		upsertCustomProvider(path, withoutKey());
		expect(diskEntry().models[0].thinkingLevelMap).toEqual({ low: "low" });
		// 两条继承同时成立：apiKey 来自旧条目、thinkingLevelMap 来自旧模型
		expect(diskEntry().apiKey).toBe(PLACEHOLDER);
	});
});