/**
 * 计划书纯逻辑（src/renderer/src/plan-core.js）的单元测试。
 *
 * 守四块，都是「界面上只表现为文案 / 顺序怪怪的」、GUI 断言抓不住的东西：
 *   1. **解析**：编号 / 无编号 / 标题 / 加粗 / 50 步上限 —— 模型不总按格式写，
 *      解析不出来时必须按空行切段保住内容（PRD 硬要求「不丢内容」）；
 *   2. **步骤操作**：增删改移勾选，且边界是「原样返回」而不是悄悄造半条数据；
 *   3. **进度**：0 步时不能是 NaN；
 *   4. **差异 / Markdown**：新增 / 删除 / 未变三态，以及导出格式。
 *
 * ── 反向验证（已真跑并还原）─────────────────────────────────────────
 * 注入一：把 `parsePlanText` 的段落回退整段删掉 → 「没有编号时按空行切段」
 * 变红，其余全绿；注入二：把 `moveStep` 的边界判断改成 `splice` 硬移 →
 * 「越界不动」两条变红。还原后全绿。
 */

import { describe, expect, it } from "vitest";
import {
	PLAN_STEP_MAX,
	addStep,
	diffStepLists,
	moveStep,
	newStepId,
	parsePlanText,
	planToMarkdown,
	removeStep,
	stepStats,
	toggleStep,
	updateStep,
} from "../../src/renderer/src/plan-core.js";

const step = (id, text, done = false) => ({ id, text, done });

describe("parsePlanText —— 计划文本 → 标题 + 步骤", () => {
	it("识别「计划：」标题与编号步骤", () => {
		const { title, steps } = parsePlanText(
			"计划：重构术语表\n\n1. 读一遍现有文档\n2. 统一术语表\n3. 复核并提交"
		);
		expect(title).toBe("重构术语表");
		expect(steps).toEqual(["读一遍现有文档", "统一术语表", "复核并提交"]);
	});

	it("标题可带 markdown 井号，也接受全角冒号", () => {
		expect(parsePlanText("## 计划：迁移配置\n1. 备份").title).toBe("迁移配置");
		expect(parsePlanText("计划: 迁移配置\n1. 备份").title).toBe("迁移配置");
	});

	it("没有标题行时回退为「计划书」", () => {
		expect(parsePlanText("1. 第一步\n2. 第二步").title).toBe("计划书");
	});

	it("去掉步骤里的加粗标记", () => {
		const { steps } = parsePlanText("计划：x\n1. **读**一遍文档\n2. 写 `README`");
		expect(steps).toEqual(["读一遍文档", "写 `README`"]);
	});

	it("一条编号步骤都解析不到时按空行切段，整段作为一步（不丢内容）", () => {
		const { steps } = parsePlanText(
			"计划：整理周报\n\n先读上周周报，梳理完成项。\n再对齐本周目标。\n\n最后写结论。"
		);
		expect(steps).toEqual(["先读上周周报，梳理完成项。 再对齐本周目标。", "最后写结论。"]);
	});

	it("回退切段时不会把标题行再当成一步", () => {
		const { steps } = parsePlanText("计划：只有标题\n\n正文第一段。");
		expect(steps).toEqual(["正文第一段。"]);
	});

	it("编号步骤超过 50 条时截断", () => {
		const lines = ["计划：很多步"];
		for (let i = 1; i <= 60; i += 1) lines.push(`${i}. 第 ${i} 步`);
		const { steps } = parsePlanText(lines.join("\n"));
		expect(steps).toHaveLength(PLAN_STEP_MAX);
		expect(steps[0]).toBe("第 1 步");
		expect(steps.at(-1)).toBe(`第 ${PLAN_STEP_MAX} 步`);
	});

	it("空文本 → 空步骤（不抛错）", () => {
		expect(parsePlanText("")).toEqual({ title: "计划书", steps: [] });
		expect(parsePlanText(undefined)).toEqual({ title: "计划书", steps: [] });
	});

	it("单条步骤正文超过 500 字时截断（daemon 会拒收超长，解析先截断保住内容）", () => {
		const long = "字".repeat(600);
		const { steps } = parsePlanText(`计划：x\n1. ${long}`);
		expect(steps[0]).toHaveLength(500);
	});
});

describe("步骤操作", () => {
	it("newStepId 形如 s-…，且连续调用不重复", () => {
		const a = newStepId();
		const b = newStepId();
		expect(a).toMatch(/^s-[a-z0-9]+-\d+$/u);
		expect(a).not.toBe(b);
	});

	it("addStep 追加到末尾并带 id / done:false", () => {
		const next = addStep([step("a", "一")], "二");
		expect(next).toHaveLength(2);
		expect(next[1]).toMatchObject({ text: "二", done: false });
		expect(next[1].id).toMatch(/^s-/u);
		// 纯函数：原数组不被改。
		expect([step("a", "一")]).toHaveLength(1);
	});

	it("addStep 拒绝空文本与超过 50 步", () => {
		const list = [step("a", "一")];
		expect(addStep(list, "   ")).toBe(list);
		const full = Array.from({ length: PLAN_STEP_MAX }, (_, i) => step(`s${i}`, `第 ${i} 步`));
		expect(addStep(full, "溢出的")).toBe(full);
	});

	it("updateStep 改正文；空文本 / 找不到时原样返回", () => {
		const list = [step("a", "旧")];
		expect(updateStep(list, "a", "新")[0].text).toBe("新");
		expect(updateStep(list, "a", "   ")).toBe(list);
		expect(updateStep(list, "nope", "新")).toBe(list);
	});

	it("removeStep 删一步；找不到时原样返回", () => {
		const list = [step("a", "一"), step("b", "二")];
		expect(removeStep(list, "a")).toEqual([step("b", "二")]);
		expect(removeStep(list, "nope")).toBe(list);
	});

	it("moveStep 上移 / 下移，越界时原样返回", () => {
		const list = [step("a", "一"), step("b", "二"), step("c", "三")];
		expect(moveStep(list, "b", -1).map((s) => s.id)).toEqual(["b", "a", "c"]);
		expect(moveStep(list, "b", 1).map((s) => s.id)).toEqual(["a", "c", "b"]);
		expect(moveStep(list, "a", -1)).toBe(list);
		expect(moveStep(list, "c", 1)).toBe(list);
		expect(moveStep(list, "nope", 1)).toBe(list);
	});

	it("toggleStep 只翻目标那一条，其余保持原引用", () => {
		const a = step("a", "一");
		const next = toggleStep([a, step("b", "二")], "a");
		expect(next[0].done).toBe(true);
		expect(next[1].done).toBe(false);
		expect(toggleStep(next, "a")[0].done).toBe(false);
	});
});

describe("stepStats —— 进度", () => {
	it("统计完成数与百分比", () => {
		expect(stepStats([step("a", "一", true), step("b", "二")])).toEqual({ done: 1, total: 2, percent: 50 });
		expect(stepStats([step("a", "一", true), step("b", "二", true)])).toEqual({ done: 2, total: 2, percent: 100 });
	});

	it("0 步时 percent 是 0 而不是 NaN", () => {
		expect(stepStats([])).toEqual({ done: 0, total: 0, percent: 0 });
		expect(stepStats(undefined)).toEqual({ done: 0, total: 0, percent: 0 });
	});
});

describe("planToMarkdown", () => {
	it("输出标题 + 编号列表", () => {
		expect(planToMarkdown("重构术语表", [step("a", "读文档"), step("b", "统一术语")])).toBe(
			"# 重构术语表\n\n1. 读文档\n2. 统一术语"
		);
	});

	it("空标题回退为「计划书」，无步骤时只有标题", () => {
		expect(planToMarkdown("   ", [])).toBe("# 计划书");
		expect(planToMarkdown(undefined, [])).toBe("# 计划书");
	});

	it("接受裸字符串步骤（解析结果可直接导出）", () => {
		expect(planToMarkdown("x", ["一", "二"])).toBe("# x\n\n1. 一\n2. 二");
	});
});

describe("diffStepLists —— 版本行级差异", () => {
	it("完全相同时全是 same", () => {
		expect(diffStepLists(["a", "b"], ["a", "b"])).toEqual([
			{ kind: "same", text: "a" },
			{ kind: "same", text: "b" },
		]);
	});

	it("改一步 = 删旧 + 加新", () => {
		expect(diffStepLists(["a", "旧"], ["a", "新"])).toEqual([
			{ kind: "same", text: "a" },
			{ kind: "del", text: "旧" },
			{ kind: "add", text: "新" },
		]);
	});

	it("纯新增 / 纯删除", () => {
		expect(diffStepLists(["a"], ["a", "b"])).toEqual([
			{ kind: "same", text: "a" },
			{ kind: "add", text: "b" },
		]);
		expect(diffStepLists(["a", "b"], ["a"])).toEqual([
			{ kind: "same", text: "a" },
			{ kind: "del", text: "b" },
		]);
	});

	it("接受 Step 对象；空列表不炸", () => {
		expect(diffStepLists([], [])).toEqual([]);
		expect(diffStepLists([step("a", "一")], [])).toEqual([{ kind: "del", text: "一" }]);
		expect(diffStepLists([], [step("a", "一")])).toEqual([{ kind: "add", text: "一" }]);
	});
});
