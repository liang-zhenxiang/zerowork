/**
 * resume 模型回落（#162 方案 A）的单测。
 *
 * 被测对象 `src/main/daemon/session-model-fallback.js` 是刻意抽出的纯函数模块
 * （session-files.js 顶层 requireParentPort，import 不了——同 library.js 的理由）。
 * catalog 以两个方法注入：`isUsable(key)` 与 `resolveModel(key)`。
 *
 * ── 反向验证（已真跑并还原）──────────────────────────────────────────
 * 1) 把 `resolveResumeModelKey` 里 contextModel 分支删掉（回落不存在），
 *    则「回落到会话记录的模型」与「记录不可用 → unavailable」两条变红。
 * 2) 把「不写回全局」破坏掉（比如决策后顺手改 activeModelKey）：本模块是纯函数
 *    无从改起——这正是它抽出来的意义；e2e 层另有不预配模型的真实链路用例兜住。
 */
import { describe, expect, it } from "vitest";
import {
	resolveResumeModelKey,
	resumeModelError,
} from "../../src/main/daemon/session-model-fallback.js";

/** 可按 key 控制可用性的假 catalog；resolveModel 可选地返回带显示名的模型。 */
function fakeCatalog({ usable = [], models = {} } = {}) {
	return {
		isUsable: (key) => usable.includes(key),
		resolveModel: (key) => models[key],
	};
}

const RECORDED = { provider: "acme", modelId: "large" };
const RECORDED_KEY = "acme/large";

describe("resolveResumeModelKey", () => {
	it("全局已选模型 → 原样直通，不经过回落（现状语义的回归保护）", () => {
		const catalog = fakeCatalog();
		const decision = resolveResumeModelKey({
			activeModelKey: "other/model",
			contextModel: RECORDED,
			catalog,
		});
		// 即便 catalog 一个模型都不认识，全局选择也直通——
		// 可用性检查是 createHost 下一步的事，不在这层重复。
		expect(decision).toEqual({ kind: "global", key: "other/model" });
	});

	it("没选过全局模型 + 会话记录的模型可用 → 回落到会话记录的模型", () => {
		const catalog = fakeCatalog({ usable: [RECORDED_KEY] });
		const decision = resolveResumeModelKey({
			activeModelKey: void 0,
			contextModel: RECORDED,
			catalog,
		});
		expect(decision).toEqual({ kind: "session", key: RECORDED_KEY });
	});

	it("会话记录的模型接不上 → unavailable，displayName 取 catalog 里的名字", () => {
		const catalog = fakeCatalog({
			usable: [],
			models: { [RECORDED_KEY]: { name: "ACME Large" } },
		});
		const decision = resolveResumeModelKey({
			activeModelKey: void 0,
			contextModel: RECORDED,
			catalog,
		});
		expect(decision.kind).toBe("unavailable");
		expect(decision.displayName).toBe("ACME Large");
	});

	it("provider 整个没了（resolveModel 也拿不到）→ displayName 回落到 key 本身", () => {
		const catalog = fakeCatalog();
		const decision = resolveResumeModelKey({
			activeModelKey: void 0,
			contextModel: RECORDED,
			catalog,
		});
		expect(decision).toEqual({ kind: "unavailable", key: RECORDED_KEY, displayName: RECORDED_KEY });
	});

	it("没选过全局模型 + 会话没有记录（老会话 / 新建）→ missing", () => {
		const catalog = fakeCatalog();
		expect(
			resolveResumeModelKey({ activeModelKey: void 0, contextModel: void 0, catalog })
		).toEqual({ kind: "missing" });
	});

	it("SessionContext.model 为 null（pi 的空态形态）→ 同 missing", () => {
		const catalog = fakeCatalog();
		expect(
			resolveResumeModelKey({ activeModelKey: void 0, contextModel: null, catalog })
		).toEqual({ kind: "missing" });
	});
});

describe("resumeModelError", () => {
	it("unavailable → 点名模型并指路设置页", () => {
		const error = resumeModelError({
			kind: "unavailable",
			key: RECORDED_KEY,
			displayName: "ACME Large",
		});
		expect(error).toBeInstanceOf(Error);
		expect(error.message).toContain("ACME Large");
		expect(error.message).toContain("设置");
	});

	it("missing → 与现状同义的指路文案（新建会话也走它，语义不变）", () => {
		const error = resumeModelError({ kind: "missing" });
		expect(error.message).toContain("还没有选择模型");
		expect(error.message).toContain("设置");
	});

	it("global / session 不是错误 → undefined", () => {
		expect(resumeModelError({ kind: "global", key: "a/b" })).toBeUndefined();
		expect(resumeModelError({ kind: "session", key: "a/b" })).toBeUndefined();
	});
});
