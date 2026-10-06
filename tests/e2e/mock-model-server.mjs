/**
 * 最小 OpenAI 兼容模型服务，用于端到端测试。
 *
 * 为什么需要它：
 *   「输入 → 模型回复」是这类应用的主链路，但常规做法要求真实 API Key。
 *   应用支持自定义 provider（可配 baseUrl），所以可以在本地起一个假服务，
 *   把整条链路真正跑通：渲染层 → IPC → daemon → pi SDK → HTTP → 模型 → 流式回传。
 *
 * 覆盖范围：
 *   ✅ 请求真的发出去了、发到了哪、body 里有什么
 *   ✅ 流式响应被正确解析并落到会话状态
 *   ✅ 工具调用（tool_calls）的处理路径
 *   ✅ `GET …/models` 的模型清单（本机模型服务探测的靶子）
 *   ❌ 不验证任何真实模型的能力 —— 它只会回预设的文本
 *
 * 请求账本**两本，分开记**（这是刻意的，不是疏漏）：
 *   - `requests`      —— 除 `/models` 之外的全部请求（chat completions 等）。
 *                        语义与本次改动前**完全一致**，既有用例不受影响
 *   - `probeRequests` —— 只有 `GET …/models` 的探测请求
 *   为什么要分开：本文件被二十多个用例共用，其中若干条按**下标**取 `requests[1]`、
 *   或按**长度增量**等待「下一条请求」。把探测请求混进 `requests`，会让那些等待
 *   被一次探测提前满足，得到「看着在等、其实没等」的假信号（测试规范 §三.1）。
 *   分开记之后，两边的断言都精确：等对话就等 `requests`，等探测就等 `probeRequests`。
 *
 * 用 node:http 手写，不引第三方依赖：测试基建引入的依赖越多，
 * 它自己出问题的概率越高。
 */
import { createServer } from "node:http";

/**
 * 启动 mock 服务。
 * @param {object} opts
 * @param {string} opts.reply    模型要回复的文本
 * @param {boolean} opts.toolCall 是否返回一个工具调用而不是纯文本
 * @param {number} opts.port     监听端口，0 表示随机
 * @param {(string | { id?: string })[]} opts.models `GET …/models` 列出的模型。
 *        默认 `["mock-model"]` —— 与既有用例里 `models[].id` 的取值同族，
 *        既有用例不读这个端点，默认值只影响新用例。元素给字符串即当作 id。
 * @param {boolean} opts.modelsEmpty `/models` 返回 200 + `{ object:"list", data:[] }`，
 *        对应「探到了服务，但它一个模型都没有」（**不是**「没探到」）
 * @param {boolean} opts.modelsAuthRequired `/models` 返回 401，
 *        对应「探到了服务，但它要鉴权」。与 `modelsEmpty` 同时打开时以 401 为准
 */
export function startMockModelServer({
	reply = "这是 mock 模型的回复。",
	toolCall = false,
	port = 0,
	models = ["mock-model"],
	modelsEmpty = false,
	modelsAuthRequired = false,
} = {}) {
	/** 收到的所有「非 /models」请求，供测试断言。语义与本次改动前一致 */
	const requests = [];
	/** 只收 `GET …/models` 的探测请求。为什么单开一本：见文件头「请求账本两本」 */
	const probeRequests = [];

	/** 规范化后的模型 id 清单（元素可能是字符串，也可能是 `{ id }` 形状的对象） */
	const modelIds = models
		.map((m) => (typeof m === "string" ? m : String(m?.id ?? "")))
		.filter((id) => id !== "");

	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			let parsed;
			try {
				parsed = JSON.parse(body);
			} catch {
				parsed = undefined;
			}
			const entry = { url: req.url, method: req.method, headers: req.headers, body: parsed };

			// ── 模型清单（本机模型服务探测） ──
			// 与 /chat/completions 挤在同一个 mock 里是有意的：这样「探测到的端点」与
			// 「能真的对话的端点」必然是同一个。另写一个 mock 会让这两件事分家，
			// 于是出现「探测通了、发消息却不通」这种假绿。
			if (req.method === "GET" && pathEndsWith(req.url, "/models")) {
				probeRequests.push(entry);
				respondModelList(res, { modelIds, modelsEmpty, modelsAuthRequired });
				return;
			}

			requests.push(entry);

			if (!req.url?.includes("/chat/completions")) {
				res.writeHead(404, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: "not found" } }));
				return;
			}

			// SSE 流式响应：OpenAI 的 chat completions 流格式
			res.writeHead(200, {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				connection: "keep-alive",
			});

			const id = `chatcmpl-mock-${Date.now()}`;
			const created = Math.floor(Date.now() / 1000);
			const base = { id, object: "chat.completion.chunk", created, model: "mock-model" };

			const send = (delta, finish = null) => {
				res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
			};

			send({ role: "assistant", content: "" });

			if (toolCall) {
				// 工具调用路径：模型要求执行一个工具
				send({
					tool_calls: [
						{
							index: 0,
							id: "call_mock_1",
							type: "function",
							function: { name: "ls", arguments: '{"path":"."}' },
						},
					],
				});
				send({}, "tool_calls");
			} else {
				// 分片吐出文本，模拟真实流式行为。
				// 【\s 不能少】`.` 不匹配换行——多行回复的 \n 会在分片时全部丢失，
				// 表现为「段落被并进同一段」：依赖段落结构的断言（块级公式、列表）
				// 会莫名走样且极难排查（2026-10-02 公式用例首次踩到）。
				for (const chunk of reply.match(/[\s\S]{1,8}/gu) ?? []) {
					send({ content: chunk });
				}
				send({}, "stop");
			}

			res.write("data: [DONE]\n\n");
			res.end();
		});
	});

	return new Promise((resolve) => {
		server.listen(port, "127.0.0.1", () => {
			resolve({
				port: server.address().port,
				baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
				requests,
				probeRequests,
				/** 这个 mock 在 `/models` 上宣称的模型 id，供断言与自检核对 */
				modelIds,
				close: () => new Promise((r) => server.close(r)),
			});
		});
	});
}

/** `url` 的路径部分（丢掉查询串与尾部斜杠）是否以 `suffix` 结尾。解析不了就当不匹配。 */
function pathEndsWith(url, suffix) {
	try {
		return new URL(url ?? "/", "http://127.0.0.1").pathname.replace(/\/+$/, "").endsWith(suffix);
	} catch {
		return false;
	}
}

/**
 * `GET …/models` 的响应。
 * 401 优先于空清单（两个开关同时打开时以 401 为准）—— 「要鉴权」比「没有模型」
 * 更靠前，因为鉴权不过时我们根本看不到它有没有模型。
 */
function respondModelList(res, { modelIds, modelsEmpty, modelsAuthRequired }) {
	if (modelsAuthRequired) {
		res.writeHead(401, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: "unauthorized", type: "invalid_request_error" } }));
		return;
	}
	res.writeHead(200, { "content-type": "application/json" });
	res.end(
		JSON.stringify({
			object: "list",
			data: modelsEmpty ? [] : modelIds.map((id) => ({ id, object: "model", created: 0, owned_by: "mock" })),
		}),
	);
}
