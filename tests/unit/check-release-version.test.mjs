/**
 * `scripts/check-release-version.mjs` 的单元测试。
 *
 * 重点钉住 2026-11-13 新增的 **package-lock 根版本**校验：
 * 锁文件漂移时没有任何其它检查会报错（发布说明照常生成、CI 也全绿），
 * 只有这一处会拦下来。用临时夹具目录跑真实脚本（`CHECK_RELEASE_ROOT`），
 * 断言的是退出码与可诊断的文案 —— 用户据此能直接照做。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../scripts/check-release-version.mjs", import.meta.url));
const roots = [];

afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** 一份最小的发布夹具：CHANGELOG + package.json + package-lock.json。 */
function fixture({ version = "1.2.3", lockVersion = version, lockRootVersion = version } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "zw-release-"));
	roots.push(dir);
	writeFileSync(join(dir, "CHANGELOG.md"), `## [${version}] - 2026-01-01\n`, "utf8");
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture", version }), "utf8");
	writeFileSync(
		join(dir, "package-lock.json"),
		JSON.stringify({ version: lockVersion, packages: { "": { version: lockRootVersion } } }),
		"utf8",
	);
	return dir;
}

function run(dir, tag = "v1.2.3") {
	return spawnSync(process.execPath, [SCRIPT], {
		env: { ...process.env, CHECK_RELEASE_ROOT: dir, TAG: tag, NO_COLOR: "1" },
		encoding: "utf8",
	});
}

describe("check-release-version —— package-lock 根版本", () => {
	it("四处一致时退出 0", () => {
		const result = run(fixture());
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("package-lock.json: 1.2.3");
		expect(result.stdout).toContain("四者一致");
	});

	it("顶层 version 漂移时退出 1，并给出改法", () => {
		const result = run(fixture({ lockVersion: "1.2.2" }));
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("package-lock.json 的根版本与 package.json 对不上");
		expect(result.stdout).toContain("npm install --package-lock-only");
	});

	it("packages[\"\"] 漂移同样退出 1（只改一处会留下假象）", () => {
		const result = run(fixture({ lockRootVersion: "1.2.2" }));
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("package-lock.json 的根版本与 package.json 对不上");
	});

	it("锁文件缺失或损坏时退出 1，而不是静默跳过", () => {
		const dir = fixture();
		rmSync(join(dir, "package-lock.json"));
		const result = run(dir);
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("package-lock.json 读不到");
	});
});
