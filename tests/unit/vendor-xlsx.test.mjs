/**
 * 随包的 vendored SheetJS（`src/renderer/src/vendor-xlsx.js`）的回归测试。
 *
 * 为什么值得单独测这一个文件：它是**随安装包分发**的预打包产物，不在 npm 依赖图里
 * （Dependabot 与 `npm audit` 都看不见它），而升级它的动作是「手工替换一个 866 KB 的文件」——
 * 换错了、换成了别的构建、或者换成一个导出面不一样的版本，**不会有任何工具告诉你**，
 * 症状是「点开 csv/xls 预览就白屏或报错」，而那条路径要靠真开文件才走得到。
 *
 * 这里测的是**应用真正用到的那条路**（`office-xlsx.js` 的 `XlsxPreview`）：
 *
 *   XLSX.read(csv 文本 | xls 字节)  →  XLSX.write({ type: "array", bookType: "xlsx" })  →  再读回来
 *
 * 断言分三层：
 *   ① **版本不低于两个 high 公告的修复版本**（0.19.3 原型污染 / 0.20.2 ReDoS）——
 *      低于它就是把带漏洞的代码发给了用户。这条不写死具体版本，因此升级不必改测试，
 *      **降级必红**。
 *   ② **导出面**：应用只用 `read` / `write` / `utils`（模块命名空间），缺一个就是白屏。
 *   ③ **数值真的过得去**：转换出来的字节是 xlsx（zip 魔数），且再读回来能拿到原值。
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SECURITY = readFileSync(new URL("../../SECURITY.md", import.meta.url), "utf8");
const XLSX = await import("../../src/renderer/src/vendor-xlsx.js");

/** 形如 1.2.3 的比较（同 scripts/check-vendored-advisories.mjs）。 */
function compareVersions(a, b) {
	const pa = String(a).split(".").map((n) => Number.parseInt(n, 10) || 0);
	const pb = String(b).split(".").map((n) => Number.parseInt(n, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
		const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
		if (diff !== 0) return diff > 0 ? 1 : -1;
	}
	return 0;
}

describe("vendored SheetJS：版本与导出面", () => {
	it("版本不低于两个 high 公告的修复版本（0.19.3 / 0.20.2）", () => {
		expect(XLSX.version, "拿不到版本号说明换成了别的构建").toMatch(/^\d+\.\d+\.\d+$/);
		expect(
			compareVersions(XLSX.version, "0.20.2"),
			`手上是 ${XLSX.version}，低于 0.20.2 —— 那是两个 high 公告（原型污染 / ReDoS）的修复版本，等于把带漏洞的代码发给用户`,
		).toBeGreaterThanOrEqual(0);
	});

	it("版本与 SECURITY.md 清单里登记的一致（两处说法不许打架）", () => {
		// 只认**清单表格行**（以 `|` 开头、且第一格是 vendor-xlsx.js 的路径）——
		// 正文里也会提到这个文件名和别的版本号（讲的正是历史），拿正文当判据会解析错。
		const row = SECURITY.split("\n").find(
			(line) => line.trimStart().startsWith("|") && /`[^`]*vendor-xlsx\.js`/.test(line),
		);
		expect(row, "SECURITY.md 的清单里没有 vendor-xlsx.js 那一行").toBeDefined();
		const cells = row.split("|").slice(1, -1).map((c) => c.trim());
		const listed = [...(cells[2] ?? "").matchAll(/\b(\d+\.\d+\.\d+)\b/g)].map((m) => m[1]);
		expect(listed, `清单那一行的版本格里没解析到版本号：${row.slice(0, 140)}`).toContain(XLSX.version);
	});

	it("应用用到的三个导出都在（缺一个就是点开就白屏）", () => {
		expect(typeof XLSX.read).toBe("function");
		expect(typeof XLSX.write).toBe("function");
		expect(typeof XLSX.utils).toBe("object");
	});
});

describe("vendored SheetJS：应用的确切转换路径（csv / xls → xlsx）", () => {
	const CSV = "项目,金额\n标记行,ZEROWORK_VENDOR_9900\n合计,42\n";

	it("csv 文本 → xlsx 字节 → 读回来，值一模一样", () => {
		const book = XLSX.read(CSV, { type: "string" });
		expect(book.SheetNames.length).toBeGreaterThan(0);

		const bytes = new Uint8Array(XLSX.write(book, { type: "array", bookType: "xlsx" }));
		// xlsx 就是 zip：前两字节是 PK。不是的话说明 write 出来的根本不是工作簿。
		expect(String.fromCharCode(bytes[0], bytes[1])).toBe("PK");

		const again = XLSX.read(bytes, { type: "array" });
		const sheet = again.Sheets[again.SheetNames[0]];
		expect(sheet.A2?.v).toBe("标记行");
		expect(sheet.B2?.v).toBe("ZEROWORK_VENDOR_9900");
		expect(sheet.B3?.v).toBe(42);
	});

	it("xls（BIFF8）字节也走得通 —— 应用对 .xls 走的是同一条路", () => {
		const book = XLSX.read(CSV, { type: "string" });
		const biff = new Uint8Array(XLSX.write(book, { type: "array", bookType: "biff8" }));
		// BIFF8 的魔数：OLE2 复合文档的签名
		expect(String.fromCharCode(biff[0], biff[1])).toBe("\u00d0\u00cf");

		const converted = XLSX.read(biff, { type: "array" });
		const bytes = new Uint8Array(XLSX.write(converted, { type: "array", bookType: "xlsx" }));
		const again = XLSX.read(bytes, { type: "array" });
		expect(again.Sheets[again.SheetNames[0]].B2?.v).toBe("ZEROWORK_VENDOR_9900");
	});
});
