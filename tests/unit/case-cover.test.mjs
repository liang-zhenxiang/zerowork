/**
 * 案例封面几何内核（case-cover.js）的单元测试。
 *
 * 这一层守的是两件在界面上都「不报错、只是难看」的事：
 *   1. **可复现**：同一份案例数据每次渲染都该长一样。用随机数的话封面会抖，
 *      而这种抖不会抛错、截图断言也未必抓得住（它可能刚好每次都在同一帧）。
 *   2. **同类目不雷同**：一个类目下三条案例若共用一套几何，网格里就是三张复制的
 *      瓷砖 —— 这正是「封面改成生成式」最容易掉进去的坑。
 *
 * 反向验证（2026-10-04）：把 `coverSeed` 改成 `return Math.floor(Math.random() * 2 ** 32)`，
 * 下方「同一 id 永远同一结果」与「同类目三条互不相同」两条变红（前者随机，
 * 后者时红时绿 —— 正因为如此才不能只靠它）。复原后全绿。
 */
import { describe, expect, it } from "vitest";
import {
	coverAccent,
	coverBarWidth,
	coverBars,
	coverLines,
	coverSeed,
	coverSignature,
	coverVariant,
} from "../../src/renderer/src/case-cover.js";

/** cases.json 里真实存在的四个类目（与 chips.json 的胶囊一一对应）。 */
const CHIP_IDS = ["doc-processing", "data-viz", "slides", "deep-research"];

/** cases.json 里真实的 12 个案例 id（同类目三条）。 */
const CASE_IDS = [
	"doc-book-summary-notes",
	"doc-api-reference",
	"doc-meeting-minutes",
	"viz-sales-dashboard",
	"viz-finance-report",
	"viz-survey-analysis",
	"slide-product-launch",
	"slide-quarterly-review",
	"slide-training-deck",
	"research-industry-report",
	"research-competitor-analysis",
	"research-tech-trends",
];

describe("coverVariant —— 交付物形态", () => {
	it("四个真实类目各有自己的画法", () => {
		expect(coverVariant("doc-processing")).toBe("doc");
		expect(coverVariant("data-viz")).toBe("chart");
		expect(coverVariant("slides")).toBe("slide");
		expect(coverVariant("deep-research")).toBe("note");
	});

	it("未知类目回确定的缺省（doc），不是 undefined", () => {
		for (const bad of ["nope", "", undefined, null, 7, {}]) {
			expect(coverVariant(bad)).toBe("doc");
		}
	});
});

describe("coverAccent —— 复用分类色板，不新造颜色", () => {
	it("四个类目分别落在 --cat-1 / 4 / 5 / 2", () => {
		expect(coverAccent("doc-processing")).toBe("var(--cat-1)");
		expect(coverAccent("data-viz")).toBe("var(--cat-4)");
		expect(coverAccent("slides")).toBe("var(--cat-5)");
		expect(coverAccent("deep-research")).toBe("var(--cat-2)");
	});

	it("返回值一律是既有 token 的 var() 引用 —— 不出现十六进制字面量", () => {
		for (const chipId of [...CHIP_IDS, "unknown"]) {
			const accent = coverAccent(chipId);
			expect(accent).toMatch(/^var\(--cat-[1-6]\)$/);
		}
	});

	it("未知类目回第一槽", () => {
		expect(coverAccent(undefined)).toBe("var(--cat-1)");
	});
});

describe("coverSeed —— 确定性", () => {
	it("同一个 id 永远同一个种子", () => {
		expect(coverSeed("doc-api-reference")).toBe(coverSeed("doc-api-reference"));
	});

	it("非字符串输入不抛错（回 0 号种子）", () => {
		for (const bad of [undefined, null, 7, {}, []]) {
			expect(coverSeed(bad)).toBe(coverSeed(""));
		}
	});

	it("12 个真实 id 大多落到不同的种子（碰撞是可能的，但不能大面积撞）", () => {
		const seeds = new Set(CASE_IDS.map(coverSeed));
		expect(seeds.size).toBeGreaterThanOrEqual(11);
	});
});

describe("coverLines —— 三条内容行的宽度", () => {
	it("同一 id 每次结果相同（渲染不抖）", () => {
		expect(coverLines("doc-meeting-minutes")).toEqual(coverLines("doc-meeting-minutes"));
	});

	it("三条，取值都在 38–96 之间（都在纸面内，不会溢出也不会消失）", () => {
		for (const id of CASE_IDS) {
			const lines = coverLines(id);
			expect(lines).toHaveLength(3);
			for (const width of lines) {
				expect(Number.isInteger(width)).toBe(true);
				expect(width).toBeGreaterThanOrEqual(38);
				expect(width).toBeLessThanOrEqual(96);
			}
		}
	});

	it("同类目下的三条案例**互不相同**（否则是复制粘贴的三张瓷砖）", () => {
		for (const prefix of ["doc-", "viz-", "slide-", "research-"]) {
			const group = CASE_IDS.filter((id) => id.startsWith(prefix));
			const shapes = new Set(group.map((id) => coverLines(id).join(",")));
			expect(shapes.size, `类目 ${prefix} 下有三条一模一样的封面：${[...shapes][0]}`).toBe(group.length);
		}
	});
});

describe("coverBars —— 图表的三根柱子", () => {
	it("同一 id 每次结果相同", () => {
		expect(coverBars("viz-sales-dashboard")).toEqual(coverBars("viz-sales-dashboard"));
	});

	it("三根，取值都在 34–96 之间（不出现 0 高的空柱子）", () => {
		for (const id of CASE_IDS) {
			const bars = coverBars(id);
			expect(bars).toHaveLength(3);
			for (const height of bars) {
				expect(height).toBeGreaterThanOrEqual(34);
				expect(height).toBeLessThanOrEqual(96);
			}
		}
	});

	it("同类目下三条案例的柱形互不相同", () => {
		const group = CASE_IDS.filter((id) => id.startsWith("viz-"));
		const shapes = new Set(group.map((id) => coverBars(id).join(",")));
		expect(shapes.size).toBe(group.length);
	});
});

describe("coverBarWidth —— 纸面顶部的类目色短条", () => {
	it("同一 id 每次结果相同，取值在 26–58 之间（都在纸面内）", () => {
		for (const id of CASE_IDS) {
			expect(coverBarWidth(id)).toBe(coverBarWidth(id));
			expect(coverBarWidth(id)).toBeGreaterThanOrEqual(26);
			expect(coverBarWidth(id)).toBeLessThanOrEqual(58);
		}
	});

	it("同类目下三条案例的色条**不是三根一样长**（允许偶尔撞，但不该整齐划一）", () => {
		for (const prefix of ["doc-", "viz-", "slide-", "research-"]) {
			const group = CASE_IDS.filter((id) => id.startsWith(prefix));
			const widths = new Set(group.map(coverBarWidth));
			expect(widths.size).toBeGreaterThanOrEqual(2);
		}
	});
});

describe("coverSignature —— 两张封面是不是同一张图", () => {
	it("同一 id 永远同一签名", () => {
		expect(coverSignature("doc-api-reference")).toBe(coverSignature("doc-api-reference"));
	});

	it("12 个真实案例两两不同（这是「封面不是复制粘贴」的真正判据）", () => {
		const signatures = CASE_IDS.map(coverSignature);
		expect(new Set(signatures).size).toBe(CASE_IDS.length);
	});

	it("同类目下三条也两两不同", () => {
		for (const prefix of ["doc-", "viz-", "slide-", "research-"]) {
			const group = CASE_IDS.filter((id) => id.startsWith(prefix));
			const signatures = new Set(group.map(coverSignature));
			expect(signatures.size, `类目 ${prefix} 有两条签名相同的封面`).toBe(group.length);
		}
	});

	it("签名里带上了题头与三条内容的几何（不是空串对空串）", () => {
		const signature = coverSignature("doc-api-reference");
		expect(signature.split("/")).toHaveLength(4);
		expect(signature).toMatch(/^\d+\/\d+\/\d+\/\d+$/);
	});
});
