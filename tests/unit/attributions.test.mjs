/**
 * 「关于」页的第三方组件注明（attributions.js）的单元测试。
 *
 * 这一层守的是**准确性**，而准确性在这里有法律含义：
 *   · 少列一个随包的库 = 该库的归属声明没给到用户（MIT 与 Apache-2.0 都要求随分发保留）；
 *   · 多列一个**已经不在随包内容里**的东西（如 2026-09-20 起移除的 MiSans）= 声称用了它，
 *     同样不实。
 * 所以下面两条是**成对**的：随包的 vendored 依赖必须在清单里，MiSans 必须不在。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	APP_LICENSE,
	BUNDLED_COMPONENTS,
	FULL_NOTICES_LOCATION,
	licenseIds,
} from "../../src/renderer/src/attributions.js";

const SECURITY = readFileSync(new URL("../../SECURITY.md", import.meta.url), "utf8");

/** SECURITY.md「随包的 vendored 依赖」清单里的库名（第 2 格）。 */
function vendoredLibNames() {
	const row = (line) => line.trimStart().startsWith("|") && /`[^`]*vendor-[^`]*\.js`/.test(line);
	return SECURITY.split("\n")
		.filter(row)
		.map((line) => line.split("|").slice(1, -1)[1]?.trim() ?? "")
		.filter((name) => name !== "");
}

/** 库名 → 在应用内清单里的关键字（够用即可：这几家名字都很独特）。 */
const KEYWORD = {
	"SheetJS Community Edition": "SheetJS",
	lodash: "lodash",
	JSZip: "JSZip",
	"KaTeX（含 remark-math / rehype-katex 整链）": "KaTeX",
};

describe("第三方组件清单：形状", () => {
	it("每条都有名字、许可、权利人与用途（缺一个就等于没做归属）", () => {
		expect(BUNDLED_COMPONENTS.length).toBeGreaterThanOrEqual(4);
		for (const component of BUNDLED_COMPONENTS) {
			for (const field of ["name", "license", "holder", "use"]) {
				expect(typeof component[field], `${component.name} 缺 ${field}`).toBe("string");
				expect(component[field].trim().length).toBeGreaterThan(0);
			}
			// 许可一律是 SPDX 形态的短标识（写一段话没法核对）
			expect(component.license, `${component.name} 的许可标识不像 SPDX`).toMatch(/^[A-Za-z0-9.-]+$/);
		}
	});

	it("名字不重复", () => {
		const names = BUNDLED_COMPONENTS.map((c) => c.name);
		expect(new Set(names).size).toBe(names.length);
	});

	it("应用自身的许可与 package.json 一致（两处说法不许打架）", () => {
		const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
		expect(APP_LICENSE.id).toBe(pkg.license);
	});

	it("licenseIds 去重且与清单一致", () => {
		const ids = licenseIds();
		expect(ids).toContain("MIT");
		expect(ids).toContain("Apache-2.0");
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("完整清单的落点是仓库文件（应用内只留归属，不复制一份会漂移的副本）", () => {
		expect(FULL_NOTICES_LOCATION.file).toBe("THIRD_PARTY_NOTICES.md");
		expect(FULL_NOTICES_LOCATION.url).toMatch(/^https:\/\/github\.com\/liang-zhenxiang\/zerowork\//);
	});
});

describe("第三方组件清单：与随包内容对得上（成对的两个方向）", () => {
	it("SECURITY.md 里每一个随包的 vendored 依赖，都能在应用内清单里找到", () => {
		const names = vendoredLibNames();
		expect(names.length, "SECURITY.md 的 vendored 清单没解析到任何一行").toBeGreaterThanOrEqual(3);
		const listed = BUNDLED_COMPONENTS.map((c) => `${c.name} ${c.use}`).join(" ");
		for (const lib of names) {
			// 兜底取「第一个词」：清单里有的行带很长的说明
			//（如「JSZip —— 打包器拆出的再导出薄壳」），拿整串去比当然找不到。
			const keyword = KEYWORD[lib] ?? lib.split(/[\s（—]/)[0].trim();
			expect(
				listed.includes(keyword),
				`随包的「${lib}」没有出现在「关于」页的第三方组件里 —— 它的归属声明就没给到用户`,
			).toBe(true);
		}
	});

	it("**不列**已经不随包的东西：MiSans 自 2026-09-20 起已从字体栈与随包内容移除", () => {
		const listed = JSON.stringify(BUNDLED_COMPONENTS);
		expect(
			listed.includes("MiSans"),
			"清单里出现了 MiSans —— 它已不随包（见 resources/fonts/README.md 与 app.css 的 --font-body 注释）",
		).toBe(false);
		// 反向证据：界面字体栈里确实没有它（清单说「没用」要有依据）
		const css = readFileSync(new URL("../../src/renderer/src/app.css", import.meta.url), "utf8");
		const fontBody = css.match(/--font-body:[^;]+;/)?.[0] ?? "";
		expect(fontBody).not.toContain("MiSans");
	});
});
