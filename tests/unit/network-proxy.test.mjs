/**
 * daemon 出站网络代理的单元测试（spec: proxy-settings）。
 *
 * 守的核心事实：installProxyDispatcher 之后，**全局 fetch / undici.request
 * 真的会用 HTTP_PROXY**。这是整条模型请求链路走代理的前提 —— 如果
 * undici.install() 没有把 fetch 与 dispatcher 对齐，或者版本没去重，
 * 就会出现「设置生效了，但请求还是直连」这种最难查的形态。
 *
 * 做法：起一个只记录请求、不真正转发的本地代理，把 HTTP_PROXY 指向它，
 * 然后请求一个外部地址。请求必然失败（代理不回正常响应），但我们只断言
 * **代理收到了请求** —— 那正是要证明的事。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import * as undici from "undici";
import { installProxyDispatcher } from "../../src/main/daemon/network.js";

const hits = [];
/** 精确匹配代理收到的目标主机（不用 substring —— CodeQL 会把它当成 URL 校验缺陷）。 */
function hitHost(host) {
	for (const entry of hits) {
		const [receivedHost] = String(entry.url).split(":");
		if (receivedHost === host) return entry;
	}
	return undefined;
}
let server;
let proxyUrl;
const savedEnv = {};
const originalFetch = globalThis.fetch;

beforeAll(async () => {
	for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy"]) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	server = createServer((req, res) => {
		hits.push({ method: req.method, url: req.url });
		res.writeHead(502, { "content-type": "text/plain" });
		res.end("proxy-hit");
	});
	server.on("connect", (req, socket) => {
		hits.push({ method: "CONNECT", url: req.url });
		socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	proxyUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(() => {
	hits.length = 0;
});

afterAll(async () => {
	await new Promise((resolve) => server.close(resolve));
	// 恢复全局 dispatcher 与 fetch，避免影响同进程里的其它用例。
	undici.setGlobalDispatcher(new undici.Agent());
	globalThis.fetch = originalFetch;
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("installProxyDispatcher —— daemon 出站请求走代理", () => {
	it("设置 HTTP_PROXY 后，undici.request 会先连代理", async () => {
		process.env["HTTP_PROXY"] = proxyUrl;
		process.env["HTTPS_PROXY"] = proxyUrl;
		process.env["NO_PROXY"] = "127.0.0.1";
		installProxyDispatcher();

		await expect(undici.request("http://example.com/proxy-check")).rejects.toThrow();

		// proxyTunnel: true 时 HTTP 目标也会走 CONNECT。
		const hit = hitHost("example.com");
		expect(hit, `代理没收到请求，实际命中：${JSON.stringify(hits)}`).toBeDefined();
	});

	it("全局 fetch 与 dispatcher 对齐（undici.install 生效）", async () => {
		process.env["HTTP_PROXY"] = proxyUrl;
		process.env["HTTPS_PROXY"] = proxyUrl;
		process.env["NO_PROXY"] = "127.0.0.1";
		installProxyDispatcher();

		await expect(fetch("http://example.com/fetch-check")).rejects.toThrow();

		const hit = hitHost("example.com");
		expect(hit, `全局 fetch 没走代理，实际命中：${JSON.stringify(hits)}`).toBeDefined();
	});
});
