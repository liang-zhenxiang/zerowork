/**
 * 项目常驻指令注入段的单测（prompt-compose 的 projectInstructionsBody）。
 *
 * 被测对象 `composePromptWithMeta` —— 纯函数，直测组装形态。
 * 两条硬口径（design.md §3）：
 *   1. **有指令** → 文本出现「## 项目要求」段，segments 带 project-instructions 来源
 *      （诊断面板 / promptPreview 由此看见它）；
 *   2. **无指令（undefined / 空串 / 纯空白）** → 组装结果与「根本没有项目功能」
 *      **逐字节一致**——回归保护：未归入项目的会话一个字节都不能变。
 *
 * ── 反向验证（已真跑并还原）──────────────────────────────────────────
 * 把 prompt-compose.js 里 projectInstructionsBody 的 push 段删掉，
 * 「有指令」两条变红；「无指令字节级一致」仍绿（它本来就不该变）。
 */
import { describe, expect, it } from "vitest";
import { composePromptWithMeta } from "../../src/main/daemon/prompt-compose.js";

/** 最小可组装 input：骨架无槽位无 include，模式正文一段。 */
function baseInput(extra = {}) {
	return {
		sceneBody: "# 场景\n你是办公助手。",
		modeBody: "# 模式\n按步骤推进。",
		modeId: "work",
		resolveFragment: () => void 0,
		...extra,
	};
}

describe("projectInstructionsBody 注入段", () => {
	it("有指令 → 文本含「## 项目要求」与指令内容", () => {
		const out = composePromptWithMeta(baseInput({ projectInstructionsBody: "输出一律用中文，引用需给出处。" }));
		expect(out.text).toContain("## 项目要求");
		expect(out.text).toContain("输出一律用中文，引用需给出处。");
	});

	it("有指令 → segments 带 project-instructions 来源（诊断面板可见）", () => {
		const out = composePromptWithMeta(baseInput({ projectInstructionsBody: "先看数据。" }));
		const seg = out.segments.find((s) => s.source === "project-instructions");
		expect(seg).not.toBeUndefined();
		expect(seg.text).toContain("先看数据。");
	});

	it("指令段位于记忆段之后（同为追加段，顺序稳定）", () => {
		const out = composePromptWithMeta(baseInput({ projectInstructionsBody: "项目要求正文", memorySystemBody: "记忆正文" }));
		const sources = out.segments.map((s) => s.source);
		expect(sources.indexOf("memory-system")).toBeLessThan(sources.indexOf("project-instructions"));
	});

	it("无指令（undefined / 空串 / 纯空白）→ 与不传该字段逐字节一致", () => {
		const reference = composePromptWithMeta(baseInput()).text;
		for (const empty of [void 0, "", "   \n\t "]) {
			const out = composePromptWithMeta(baseInput(empty === void 0 ? {} : { projectInstructionsBody: empty }));
			expect(out.text).toBe(reference);
			expect(out.segments.some((s) => s.source === "project-instructions")).toBe(false);
		}
	});

	it("指令 trim 后注入（前后空白不进提示词）", () => {
		const out = composePromptWithMeta(baseInput({ projectInstructionsBody: "  保持简洁。 \n" }));
		const seg = out.segments.find((s) => s.source === "project-instructions");
		expect(seg.text).toContain("保持简洁。");
		expect(seg.text).not.toContain("  保持简洁。");
	});
});
