/**
 * `tests/e2e/mock-model-server.mjs` 的模型清单（`GET …/models`）自检。
 *
 * ## 为什么这个 mock 需要一份自己的测试
 *
 * 它是**二十多个 e2e 用例共用的靶子**，而「本机模型服务探测」这条链路又要靠它当靶子：
 * 探测到的是它、接入后真正发消息打到的也是它。也就是说，这个文件里的一处疏忽会同时
 * 表现为「探测用例假红」和「所有依赖 mock 的对话用例连带失败」—— 而后者会淹没前者。
 *
 * 所以这里把三件事钉死：
 *
 * 1. **三种形态各自的样子**：有模型（`ready`）/ 空清单（`empty`）/ 401（`auth-required`）。
 *    后两种是「探到了服务」的两种不同结局，与前一种**互斥且可辨** —— 这正是新功能
 *    要区分的状态，靶子自己必须先是对的。
 * 2. **请求账本两本分开**：`requests` 只收非 `/models` 的请求，`probeRequests` 只收探测。
 *    混在一本里会让既有用例里按长度增量等待的断言被一次探测提前满足
 *    （「看着在等、其实没等」），所以这条要有回归防线。
 * 3. **默认行为一个字节都没变**：既有的 `chat/completions` 流式路径照旧，
 *    且它落在 `requests` 里、不落进 `probeRequests`。
 *
 * 这里直接发**真实 HTTP 请求**（不走注入的 fetchImpl）：要验的正是「这个 mock 在网络上
 * 长什么样」，注入一个假的 fetch 就把被测对象换掉了。
 */
import { afterEach, describe, expect, it } from "vitest";
import { startMockModelServer } from "../e2e/mock-model-server.mjs";

/** 每个用例起的 mock，统一在 afterEach 关掉 —— 漏一个就会让 vitest 拖着不退出 */
const running = [];
async function start(opts) {
	const mock = await startMockModelServer(opts);
	running.push(mock);
	return mock;
}

afterEach(async () => {
	while (running.length > 0) await running.pop().close();
});

/** 打一次 `GET …/models`，返回状态码与已解析的 body。默认打探测真正会打的路径 */
async function getModels(mock, path = "/v1/models") {
	const res = await fetch(`http://127.0.0.1:${mock.port}${path}`);
	return { status: res.status, body: await res.json() };
}

/** 把 SSE 流里的所有 `delta.content` 拼起来 —— 「回复真的被分片吐完」的判据 */
function concatStreamContent(raw) {
	return raw
		.split("\n")
		.filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
		.map((line) => JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? "")
		.join("");
}

describe("mock 模型服务：GET …/models", () => {
	it("有模型（ready）：返回 OpenAI 兼容形状，并只记进 probeRequests", async () => {
		const mock = await start();

		const { status, body } = await getModels(mock);

		expect(status).toBe(200);
		expect(body.object).toBe("list");
		expect(body.data.map((m) => m.id)).toEqual(["mock-model"]);
		expect(body.data[0].object).toBe("model");

		// 账本：探测请求不许混进 requests（既有用例按 requests 的长度增量等待）
		expect(mock.probeRequests).toHaveLength(1);
		expect(mock.requests).toHaveLength(0);
		expect(mock.probeRequests[0].method).toBe("GET");
		expect(mock.probeRequests[0].url).toBe("/v1/models");
	});

	it("默认清单与既有用例的模型 id 同族（不是空清单）", async () => {
		const mock = await start();
		expect(mock.modelIds).toEqual(["mock-model"]);
		const { body } = await getModels(mock);
		expect(body.data.length).toBeGreaterThan(0);
	});

	it("空清单（empty）：200 + data 为空数组 —— 与「没探到」是两件事", async () => {
		const mock = await start({ modelsEmpty: true });

		const { status, body } = await getModels(mock);

		// 状态码仍是 2xx：服务**在**，只是没有模型。若这里返回非 2xx，
		// 「探到但零模型」就会被归类成「没探到」，两个状态再也分不开。
		expect(status).toBe(200);
		expect(body.object).toBe("list");
		expect(body.data).toEqual([]);
	});

	it("要鉴权（auth-required）：401，且错误体是 OpenAI 兼容形状", async () => {
		const mock = await start({ modelsAuthRequired: true });

		const { status, body } = await getModels(mock);

		expect(status).toBe(401);
		expect(body.error.message).toBeTruthy();
	});

	it("两个开关同时打开时以 401 为准（鉴权不过就看不到有没有模型）", async () => {
		const mock = await start({ modelsEmpty: true, modelsAuthRequired: true });
		expect((await getModels(mock)).status).toBe(401);
	});

	it("模型清单可配：顺序与内容照给的那一份", async () => {
		const mock = await start({ models: ["llama3.2", "qwen2.5:7b", "mistral"] });

		const { body } = await getModels(mock);

		expect(body.data.map((m) => m.id)).toEqual(["llama3.2", "qwen2.5:7b", "mistral"]);
	});

	it("元素也可以给 { id } 形状的对象（只取 id）", async () => {
		const mock = await start({ models: [{ id: "obj-model" }, "plain-model"] });

		const { body } = await getModels(mock);

		expect(body.data.map((m) => m.id)).toEqual(["obj-model", "plain-model"]);
	});

	it("路径变体：任意以 /models 结尾的路径都命中，含查询串与尾部斜杠", async () => {
		const mock = await start();

		expect((await getModels(mock, "/v1/models/")).status).toBe(200);
		expect((await getModels(mock, "/models")).status).toBe(200);
		expect((await getModels(mock, "/v1/models?x=1")).status).toBe(200);

		expect(mock.probeRequests).toHaveLength(3);
		expect(mock.requests).toHaveLength(0);
	});

	it("非 GET 的 /models 不算探测：走既有的 404 路径，落进 requests", async () => {
		const mock = await start();

		const res = await fetch(`http://127.0.0.1:${mock.port}/v1/models`, { method: "POST" });

		expect(res.status).toBe(404);
		expect(mock.probeRequests).toHaveLength(0);
		expect(mock.requests).toHaveLength(1);
	});

	it("未知 GET 路径仍是 404，且落进 requests（既有语义未变）", async () => {
		const mock = await start();

		const res = await fetch(`http://127.0.0.1:${mock.port}/v1/something-else`);

		expect(res.status).toBe(404);
		expect(mock.requests).toHaveLength(1);
		expect(mock.probeRequests).toHaveLength(0);
	});

	it("回归：chat/completions 仍走 SSE 流式，且只落进 requests", async () => {
		const mock = await start();

		const res = await fetch(`${mock.baseUrl}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "mock-model", messages: [{ role: "user", content: "嗨" }], stream: true }),
		});
		const raw = await res.text();

		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/event-stream");
		// 「回复真的吐完了」要读到副作用，不是只看没报错
		expect(concatStreamContent(raw)).toBe("这是 mock 模型的回复。");
		expect(raw).toContain("data: [DONE]");

		expect(mock.requests).toHaveLength(1);
		expect(mock.probeRequests).toHaveLength(0);
		expect(mock.requests[0].body.model).toBe("mock-model");
	});

	it("同一个 mock 既是「探测到的端点」也是「能对话的端点」—— 两本账互不串台", async () => {
		const mock = await start({ models: ["dual-model"] });

		expect((await getModels(mock)).body.data.map((m) => m.id)).toEqual(["dual-model"]);
		const res = await fetch(`${mock.baseUrl}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "dual-model", messages: [], stream: true }),
		});
		await res.text();

		expect(mock.probeRequests).toHaveLength(1);
		expect(mock.requests).toHaveLength(1);
	});
});