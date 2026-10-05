#!/usr/bin/env node
/**
 * check-vendored-advisories.mjs —— 拿随包 vendored 依赖的「库 + 版本」去查公告
 *
 * 补的是 `check-vendored-deps.mjs` 的另一半：
 *   · 那个脚本**静态**地保证「清单与 bundle 一致」（进 `lint:all`，不联网）；
 *   · 这个脚本**联网**地保证「清单与公告状态一致」（定时跑，见
 *     `.github/workflows/vendored-advisories.yml`）。
 *
 * 为什么必须联网、又为什么不放进 `lint:all`：查漏洞数据库是不可靠的外部依赖，
 * 把静态门禁变成网络依赖会让它随机变红（同 `check-docs.mjs` 的「不做的事」）。
 * 所以它单独成一个**每周一次**的工作流 —— 发现新公告就开/更新一个 Issue，
 * 而不是让某个 PR 因为上游数据库抽风而红。
 *
 * ## 两个刻意的设计
 *
 * 1. **版本不在这里维护**：库名、版本、生态都从 `check-vendored-deps.mjs` 的
 *    `VERSION_MARKER` 来（版本还是从 bundle 正文现读的）。两处各写一份版本，
 *    迟早会有一处落后 —— 而落后的那份会让「这个版本有没有公告」的判断失去意义。
 * 2. **豁免必须带理由，且会被反过来校验**：OSV 对某些包记不出 `fixed` 事件
 *    （最典型是 SheetJS：npm 上从来没有修复版），于是**修好的版本也会被报「受影响」**。
 *    这种假阳性在豁免表里写明「上游修在哪个版本」，**并且要求我们手上的版本 ≥ 那个版本** ——
 *    低于它照样失败。豁免不是「永远闭嘴」，是「这一条我解释过」。
 *
 * 退出码：
 *   0 —— 没有未豁免的公告
 *   1 —— 有未豁免的公告（会打印出来，供工作流开 Issue）
 *   2 —— **没查成**（网络/接口失败）：与「查了没问题」必须区分开，否则一次网络抖动
 *        会被读成「一切正常」。这一档不当作发现漏洞处理。
 *
 * 用法：
 *   node scripts/check-vendored-advisories.mjs
 *   node scripts/check-vendored-advisories.mjs --json   # 机器可读（工作流用）
 */

import { versionFromBundle, VERSION_MARKER } from "./check-vendored-deps.mjs";

const OSV_ENDPOINT = "https://api.osv.dev/v1/query";
const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (USE_COLOR ? `\u001b[${code}m${text}\u001b[0m` : text);
const green = (t) => paint("32", t);
const red = (t) => paint("31", t);
const yellow = (t) => paint("33", t);
const dim = (t) => paint("2", t);

/** 形如 1.2.3 的比较（够用了：这几个库都是纯 x.y.z）。返回 -1 / 0 / 1。 */
export function compareVersions(a, b) {
	const pa = String(a).split(".").map((n) => Number.parseInt(n, 10) || 0);
	const pb = String(b).split(".").map((n) => Number.parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff > 0 ? 1 : -1;
	}
	return 0;
}

/** 查一个包版本的全部公告。失败时抛错（由调用方转成退出码 2）。 */
async function queryOsv({ ecosystem, name }, version) {
	// 走 globalThis 前缀：`fetch` 是 Node 22 的全局，但 eslint 按 Node 视角静态检查时
	// 不认裸 `fetch`（本项目在合成事件上踩过同一个坑）—— 属性访问能过，且语义不变。
	const response = await globalThis.fetch(OSV_ENDPOINT, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ package: { ecosystem, name }, version }),
	});
	if (!response.ok) throw new Error(`OSV 返回 ${response.status}`);
	const body = await response.json();
	return Array.isArray(body.vulns) ? body.vulns : [];
}

async function main() {
	const asJson = process.argv.includes("--json");
	const findings = [];
	const exempted = [];
	const failures = [];

	// 只查登记了 osv 坐标、且不是「再导出薄壳」的那些（薄壳沿用来源版本的公告面）
	const targets = Object.entries(VERSION_MARKER).filter(
		([, registry]) => registry.osv !== undefined && registry.from === undefined,
	);

	if (!asJson) process.stdout.write("\nvendored 依赖公告检查（OSV.dev）\n");

	for (const [file, registry] of targets) {
		const { version, error } = versionFromBundle(file, registry);
		if (error !== undefined) {
			failures.push(`${file}：${error}`);
			continue;
		}
		let vulns;
		try {
			vulns = await queryOsv(registry.osv, version);
		} catch (error) {
			failures.push(`${file}（${registry.osv.name}@${version}）：查询失败 —— ${error.message}`);
			continue;
		}

		const exemptions = new Map((registry.advisoryExemptions ?? []).map((item) => [item.id, item]));
		const hitIds = new Set(vulns.map((v) => v.id));
		for (const vuln of vulns) {
			const exemption = exemptions.get(vuln.id);
			if (exemption === undefined) {
				findings.push({ file, lib: registry.lib, version, id: vuln.id, summary: vuln.summary ?? "" });
				continue;
			}
			// 豁免的前提是**我们确实已经过了上游的修复版本** —— 否则豁免无效
			if (compareVersions(version, exemption.fixedIn) < 0) {
				findings.push({
					file,
					lib: registry.lib,
					version,
					id: vuln.id,
					summary: `（豁免无效：手上 ${version} < 上游修复版本 ${exemption.fixedIn}）`,
				});
				continue;
			}
			exempted.push({ file, version, id: vuln.id, fixedIn: exemption.fixedIn });
		}
		// 豁免表里列了、但这次没报出来的：说明上游把公告元数据补全了（或公告被撤），
		// 该删豁免 —— 只提示不失败（网络侧的元数据随时会变）
		for (const [id, exemption] of exemptions) {
			if (!hitIds.has(id)) {
				exempted.push({ file, version, id, stale: true, fixedIn: exemption.fixedIn });
			}
		}
		if (!asJson) {
			process.stdout.write(
				`  ${vulns.length === 0 ? green("✓") : dim("·")} ${file}  ${registry.osv.name}@${version}  ` +
					dim(`公告 ${vulns.length} 条\n`),
			);
		}
	}

	for (const item of exempted) {
		if (asJson) continue;
		process.stdout.write(
			`  ${yellow(item.stale ? "·" : "✓")} 已豁免 ${item.id}（上游修在 ${item.fixedIn}，手上 ${item.version}）` +
				dim(item.stale ? " —— 这次没报出来，可以考虑删掉这条豁免\n" : "\n"),
		);
	}

	if (asJson) {
		process.stdout.write(`${JSON.stringify({ findings, exempted, failures }, null, 2)}\n`);
	} else if (findings.length === 0 && failures.length === 0) {
		process.stdout.write(`  ${green("✓")} 没有未豁免的公告\n`);
	}

	if (failures.length > 0) {
		if (!asJson) {
			process.stdout.write(`\n${red("未能完成检查（不是「没问题」）：")}\n`);
			for (const line of failures) process.stdout.write(`  ✗ ${line}\n`);
		}
		return 2;
	}
	if (findings.length > 0) {
		if (!asJson) {
			process.stdout.write(`\n${red("发现未豁免的公告：")}\n`);
			for (const item of findings) {
				process.stdout.write(
					`  ✗ ${item.lib} ${item.version}（${item.file}）：${item.id} ${item.summary}\n` +
						`      https://osv.dev/vulnerability/${item.id}\n` +
						`      处置：升级该 bundle（并同步 VERSION_MARKER / SECURITY.md 清单），` +
						`或在 VERSION_MARKER 的 advisoryExemptions 里写明理由与上游修复版本。\n`,
				);
			}
		}
		return 1;
	}
	return 0;
}

process.exit(await main());
