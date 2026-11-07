/**
 * 诊断健康评分的单测（health-score.js，零依赖直测）。
 *
 * 这一屏最容易错的不是画环，而是「哪一项该扣多少、建议指向谁」——
 * 所以断言全部打在 computeHealth / healthBand 的输出上，只有一条看 UI 才验得出来
 * （在 tests/e2e/gui-health-bento.mjs）。
 *
 * 反向验证（已真跑并还原）：
 *   - 把 buildAdvice 的「严格小于才替换」改成 `<=`（并列取最后一个）→
 *     「并列最低分按固定顺序取建议」变红；
 *   - 把 scoreTasks 的 `status !== "running"` 改成不过滤 → 「进行中的任务不参与
 *     成功率」变红（running 会把分母顶大，分数偏低）。
 */
import { describe, expect, it } from "vitest";
import {
	HEALTH_MAX_PER_ITEM,
	computeHealth,
	healthBand,
} from "../../src/renderer/src/health-score.js";

/** 四项都满分的输入，作为各用例的基线（只改被测的那一项）。 */
const healthy = () => ({
	model: { kind: "ready" },
	runtimes: { master: true, items: [{ enabled: true, status: { kind: "ready" } }] },
	runs: [{ status: "ok" }],
	shortcut: { kind: "registered" },
});

/** 取某一项的分数（断言用的便捷读法）。 */
const itemOf = (health, key) => health.items.find((item) => item.key === key);

describe("computeHealth：满分与总分", () => {
	it("四项全满 → 100，档位「状态良好」，建议说明无需处理", () => {
		const health = computeHealth(healthy());
		expect(health.total).toBe(100);
		expect(health.items.map((item) => item.score)).toEqual([25, 25, 25, 25]);
		expect(health.items.every((item) => item.status === "ok")).toBe(true);
		expect(health.advice).toBe("四项都正常，没有需要处理的项。");
		expect(health.adviceTarget).toBeUndefined();
		expect(health.adviceUnknown).toBe(false);
		expect(healthBand(health.total)).toEqual({ key: "ok", label: "状态良好" });
	});

	it("每项满分是 25（总分 100 的口径）", () => {
		expect(HEALTH_MAX_PER_ITEM).toBe(25);
	});

	it("空输入不抛错：四项都按「无法判断」计 0", () => {
		const health = computeHealth(undefined);
		expect(health.total).toBe(0);
		expect(health.items.map((item) => item.status)).toEqual(["unknown", "unknown", "unknown", "unknown"]);
		expect(health.adviceUnknown).toBe(true);
	});
});

describe("computeHealth：模型可用", () => {
	it("一个可用模型都没有 → 0 分且建议指向「填 API Key」", () => {
		const health = computeHealth({ ...healthy(), model: { kind: "no-model-at-all" } });
		expect(itemOf(health, "model").score).toBe(0);
		expect(itemOf(health, "model").status).toBe("deduct");
		expect(health.adviceTarget).toBe("model");
		expect(health.advice).toContain("模型");
		expect(health.advice).toContain("API Key");
	});

	it("有可用模型但没选中 → 10 分（不是 0，也不是满分）", () => {
		const health = computeHealth({ ...healthy(), model: { kind: "model-not-usable" } });
		expect(itemOf(health, "model").score).toBe(10);
		expect(itemOf(health, "model").status).toBe("deduct");
		expect(health.advice).toContain("模型");
	});

	it("读取失败 → 0 分、状态「无法判断」，建议是「无法读取…刷新」", () => {
		const health = computeHealth({ ...healthy(), model: null });
		const model = itemOf(health, "model");
		expect(model.score).toBe(0);
		expect(model.status).toBe("unknown");
		expect(model.stateText).toBe("无法判断");
		expect(health.adviceTarget).toBe("model");
		expect(health.advice).toContain("无法读取");
		expect(health.advice).toContain("刷新");
	});

	it("认不出的 kind 也按「无法判断」处理，不猜成满分或扣分", () => {
		const health = computeHealth({ ...healthy(), model: { kind: "some-future-kind" } });
		expect(itemOf(health, "model").status).toBe("unknown");
	});
});

describe("computeHealth：内置运行时", () => {
	it("总开关关闭 → 10 分，建议说明这是用户的选择（不说成故障）", () => {
		const health = computeHealth({ ...healthy(), runtimes: { master: false, items: [] } });
		const runtimes = itemOf(health, "runtimes");
		expect(runtimes.score).toBe(10);
		expect(runtimes.status).toBe("deduct");
		expect(health.advice).toContain("你的选择");
	});

	it("按启用项的就绪比例折算：1/4 → 6 分（round(6.25)）", () => {
		const health = computeHealth({
			...healthy(),
			runtimes: {
				master: true,
				items: [
					{ enabled: true, status: { kind: "ready" } },
					{ enabled: true, status: { kind: "missing" } },
					{ enabled: true, status: { kind: "failed" } },
					{ enabled: true, status: { kind: "disabled" } },
				],
			},
		});
		expect(itemOf(health, "runtimes").score).toBe(6);
	});

	it("禁用的运行时不计入分母：1 就绪 / 1 启用（另 1 条被禁用）→ 25", () => {
		const health = computeHealth({
			...healthy(),
			runtimes: {
				master: true,
				items: [
					{ enabled: true, status: { kind: "ready" } },
					{ enabled: false, status: { kind: "missing" } },
				],
			},
		});
		expect(itemOf(health, "runtimes").score).toBe(25);
		expect(itemOf(health, "runtimes").status).toBe("ok");
	});

	it("没有任何启用的运行时 → 25（没有可坏的东西）", () => {
		const health = computeHealth({
			...healthy(),
			runtimes: { master: true, items: [{ enabled: false, status: { kind: "missing" } }] },
		});
		expect(itemOf(health, "runtimes").score).toBe(25);
	});

	it("读取失败 → 0 分 + 「无法判断」", () => {
		const health = computeHealth({ ...healthy(), runtimes: null });
		expect(itemOf(health, "runtimes").score).toBe(0);
		expect(itemOf(health, "runtimes").status).toBe("unknown");
	});
});

describe("computeHealth：最近任务成功率", () => {
	it("没有已结束记录 → 25（没有失败可扣）", () => {
		const health = computeHealth({ ...healthy(), runs: [] });
		expect(itemOf(health, "tasks").score).toBe(25);
	});

	it("只有进行中的任务 → 仍按「还没有任务记录」给 25", () => {
		const health = computeHealth({ ...healthy(), runs: [{ status: "running" }] });
		expect(itemOf(health, "tasks").score).toBe(25);
	});

	it("10 成功 10 失败 → 13（round(12.5)）", () => {
		const runs = [
			...Array.from({ length: 10 }, () => ({ status: "ok" })),
			...Array.from({ length: 10 }, () => ({ status: "error" })),
		];
		const health = computeHealth({ ...healthy(), runs });
		expect(itemOf(health, "tasks").score).toBe(13);
		expect(health.adviceTarget).toBe("tasks");
		expect(health.advice).toContain("任务");
	});

	it("进行中的任务不参与分母（只看已结束的）", () => {
		const runs = [{ status: "ok" }, { status: "running" }, { status: "running" }];
		const health = computeHealth({ ...healthy(), runs });
		expect(itemOf(health, "tasks").score).toBe(25);
	});

	it("只看最近 20 条已结束任务：第 21 条起的历史失败不影响分数", () => {
		const runs = [
			...Array.from({ length: 20 }, () => ({ status: "ok" })),
			{ status: "error" },
		];
		const health = computeHealth({ ...healthy(), runs });
		expect(itemOf(health, "tasks").score).toBe(25);
	});

	it("读取失败 → 0 分 + 「无法判断」", () => {
		const health = computeHealth({ ...healthy(), runs: null });
		expect(itemOf(health, "tasks").score).toBe(0);
		expect(itemOf(health, "tasks").status).toBe("unknown");
	});
});

describe("computeHealth：全局快捷键", () => {
	it("注册失败 → 0 分，建议给出可行动的方向", () => {
		const health = computeHealth({ ...healthy(), shortcut: { kind: "failed" } });
		expect(itemOf(health, "shortcut").score).toBe(0);
		expect(itemOf(health, "shortcut").status).toBe("deduct");
		expect(health.adviceTarget).toBe("shortcut");
		expect(health.advice).toContain("快捷键");
	});

	it("查询失败（null）→ 0 分 + 「无法判断」，与「注册失败」区分开", () => {
		const health = computeHealth({ ...healthy(), shortcut: null });
		expect(itemOf(health, "shortcut").score).toBe(0);
		expect(itemOf(health, "shortcut").status).toBe("unknown");
		expect(health.advice).toContain("无法读取");
	});
});

describe("computeHealth：建议取扣分最多的一项", () => {
	it("多项扣分时指向最低分那一项", () => {
		const health = computeHealth({
			...healthy(),
			model: { kind: "model-not-usable" }, // 10
			shortcut: { kind: "failed" }, // 0 ← 最低
		});
		expect(health.adviceTarget).toBe("shortcut");
	});

	it("并列最低分时按 模型 → 运行时 → 任务 → 快捷键 的固定顺序", () => {
		// 模型与快捷键都是 0：固定顺序里模型在前。
		const health = computeHealth({ ...healthy(), model: { kind: "no-model-at-all" }, shortcut: { kind: "failed" } });
		expect(itemOf(health, "model").score).toBe(0);
		expect(itemOf(health, "shortcut").score).toBe(0);
		expect(health.adviceTarget).toBe("model");

		// 运行时与快捷键并列 0 的情况不存在（运行时最低是 10，除非读取失败）；
		// 用「运行时读取失败」与「快捷键失败」并列验证顺序。
		const tied = computeHealth({ ...healthy(), runtimes: null, shortcut: { kind: "failed" } });
		expect(itemOf(tied, "runtimes").score).toBe(0);
		expect(itemOf(tied, "shortcut").score).toBe(0);
		expect(tied.adviceTarget).toBe("runtimes");
		expect(tied.advice).toContain("无法读取");
	});

	it("「无法判断」的项目是最低分时，建议改为刷新提示而不是「去修它」", () => {
		const health = computeHealth({ ...healthy(), runs: null });
		expect(health.adviceTarget).toBe("tasks");
		expect(health.adviceUnknown).toBe(true);
		expect(health.advice).toContain("无法读取最近任务成功率");
	});
});

describe("healthBand：四档边界", () => {
	it.each([
		[100, "ok", "状态良好"],
		[90, "ok", "状态良好"],
		[89, "accent", "基本可用"],
		[70, "accent", "基本可用"],
		[69, "warning", "需要处理"],
		[50, "warning", "需要处理"],
		[49, "danger", "存在问题"],
		[0, "danger", "存在问题"],
	])("%i 分 → %s（%s）", (score, key, label) => {
		expect(healthBand(score)).toEqual({ key, label });
	});

	it("越界值被夹到 0–100（NaN 按 0 处理），不会产出第五档", () => {
		expect(healthBand(160).key).toBe("ok");
		expect(healthBand(-20).key).toBe("danger");
		expect(healthBand(Number.NaN).key).toBe("danger");
	});
});
