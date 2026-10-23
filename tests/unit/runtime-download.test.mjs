/**
 * 运行时下载的单元测试。
 *
 * 为什么要有这个文件：下载实现从 node:https 改成了 undici.request
 * （spec: proxy-settings —— 只有走 undici 的全局 dispatcher，代理设置才
 * 对它生效）。两者的返回形状不同，改动很容易在「body 是 response 还是
 * response.body」这种地方静默出错，而错误只在真正下载运行时的时候才暴露。
 *
 * 覆盖：
 *   · 200 正常下载 → 文件落盘、内容一致
 *   · 第二次调用复用已下载文件（不重复请求）
 *   · SHA256 不符 → 抛错且不留下半成品
 *   · 404 → 带状态码的可诊断错误
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { downloadArtifact } from "../../src/main/daemon/runtimes.js";

const payload = "runtime-payload-for-download-test";
const sha256 = createHash("sha256").update(payload).digest("hex");

let server;
let baseUrl;
let workDir;

beforeEach(async () => {
	workDir = mkdtempSync(join(tmpdir(), "zerowork-runtime-dl-"));
	server = createServer((req, res) => {
		if (req.url === "/missing") {
			res.writeHead(404);
			res.end("not found");
			return;
		}
		res.writeHead(200, { "content-type": "application/octet-stream", "content-length": payload.length });
		res.end(payload);
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
	await new Promise((resolve) => server.close(resolve));
	rmSync(workDir, { recursive: true, force: true });
});

describe("downloadArtifact —— undici 版下载器", () => {
	it("下载成功并落盘", async () => {
		const target = join(workDir, "runtime.bin");
		const result = await downloadArtifact({
			url: `${baseUrl}/artifact.bin`,
			sha256,
			targetFile: target,
			minBytes: 1,
		});
		expect(readFileSync(target, "utf8")).toBe(payload);
		expect(result.bytes).toBe(payload.length);
		expect(result.sha256).toBe(sha256);
		expect(result.reusedBytes).toBe(0);
	});

	it("第二次调用复用已有文件，不再发请求", async () => {
		const target = join(workDir, "runtime.bin");
		await downloadArtifact({ url: `${baseUrl}/artifact.bin`, sha256, targetFile: target, minBytes: 1 });
		const second = await downloadArtifact({
			url: `${baseUrl}/artifact.bin`,
			sha256,
			targetFile: target,
			minBytes: 1,
		});
		expect(second.reusedBytes).toBe(payload.length);
	});

	it("SHA256 不符时抛错且不留产物", async () => {
		const target = join(workDir, "runtime.bin");
		await expect(
			downloadArtifact({
				url: `${baseUrl}/artifact.bin`,
				sha256: "0".repeat(64),
				targetFile: target,
				minBytes: 1,
			}),
		).rejects.toThrow(/SHA256/);
		expect(existsSync(target)).toBe(false);
	});

	it("404 的错误带状态码", async () => {
		const target = join(workDir, "runtime.bin");
		await expect(
			downloadArtifact({ url: `${baseUrl}/missing`, sha256, targetFile: target, minBytes: 1 }),
		).rejects.toThrow(/404/);
	});
});
