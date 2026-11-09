/**
 * 计划书存储（src/main/daemon/plans-store.js）的单元测试。
 *
 * 为什么值得单独测：计划书是**跨重启**的承诺，且写进去的东西必须能原样读回来。
 * 这条链路上没有编译期检查 —— 路径穿越、版本上限、批准态、损坏文件，任何一条写错
 * 都只在「用户重启后计划没了 / 读不出来」时才暴露。这类静默失效正是单测该钉住的东西。
 *
 * 覆盖：保存 / 跨实例读回 / 校验拒绝（路径穿越、超长、空步骤、非法来源）/
 * 版本上限 20 / 损坏 JSON → null / 删除幂等 / 批准（当前与指定版本）/
 * 内容不变时保留批准态、内容改动后清除 / capturedEntryId 跨保存保留。
 *
 * ── 反向验证（已真跑并还原）─────────────────────────────────────────
 * 注入一：把 `save` 里 `versions` 的 `.slice(-PLAN_MAX_VERSIONS)` 去掉 →
 * 「版本上限 20」变红，其余全绿。**只断言 `get()` 的读回值时会漏**（读侧
 * 也会截到 20），所以那条用例额外直接核对磁盘上的原始 JSON（2026-11-10
 * 检查时实测到并补上的盲区）；注入二：把 `get` 的 JSON.parse catch 改成
 * rethrow → 「损坏 JSON → null」变红。还原后全绿。
 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	PLAN_MAX_STEPS,
	PLAN_MAX_VERSIONS,
	PlanStore,
} from "../../src/main/daemon/plans-store.js";

let dirs = [];

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), "zerowork-plans-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs = [];
});

const SESSION = "session-abc_123";

function step(id, text, done = false) {
	return { id, text, done };
}

function saveOne(store, text = "第一步") {
	return store.save(SESSION, {
		title: "计划：某件事",
		steps: [step("s-1", text)],
		capturedEntryId: "entry-1",
		source: "agent",
	});
}

describe("PlanStore —— 保存与读回", () => {
	it("保存后落盘，另一个实例（= 重启后的 daemon）能原样读回", () => {
		const dir = tempDir();
		const saved = saveOne(new PlanStore(dir));

		expect(existsSync(join(dir, `${SESSION}.json`))).toBe(true);
		expect(saved).toMatchObject({ sessionId: SESSION, title: "计划：某件事" });
		expect(saved.steps).toEqual([step("s-1", "第一步")]);
		expect(saved.versions).toHaveLength(1);
		expect(saved.versions[0]).toMatchObject({ source: "agent", title: "计划：某件事" });

		const afterRestart = new PlanStore(dir);
		const read = afterRestart.get(SESSION);
		expect(read).not.toBeNull();
		expect(read.steps).toEqual([step("s-1", "第一步")]);
		expect(read.capturedEntryId).toBe("entry-1");
	});

	it("目录不存在时自动建目录", () => {
		const dir = join(tempDir(), "nested", "deeper");
		const store = new PlanStore(dir);
		store.save(SESSION, { steps: [step("s-1", "一")], source: "manual" });
		expect(new PlanStore(dir).get(SESSION)).not.toBeNull();
	});

	it("缺少 id 时 daemon 自动补，done 缺省 false", () => {
		const store = new PlanStore(tempDir());
		const saved = store.save(SESSION, { steps: [{ text: "一" }], source: "manual" });
		expect(saved.steps[0].id).toMatch(/^s-\d+-1$/u);
		expect(saved.steps[0].done).toBe(false);
	});

	it("读不存在的计划 → null（不是错误）", () => {
		expect(new PlanStore(tempDir()).get("nope")).toBeNull();
	});

	it("非法 sessionId 读 → null（读路径不抛错）", () => {
		const store = new PlanStore(tempDir());
		expect(store.get("../etc/passwd")).toBeNull();
		expect(store.get("a/b")).toBeNull();
		expect(store.get("")).toBeNull();
		expect(store.get(undefined)).toBeNull();
	});

	it("JSON 损坏 → null，且之后仍能正常写", () => {
		const dir = tempDir();
		writeFileSync(join(dir, `${SESSION}.json`), "{ 这不是 JSON");
		const store = new PlanStore(dir);
		expect(store.get(SESSION)).toBeNull();
		saveOne(store);
		expect(store.get(SESSION)).not.toBeNull();
	});

	it("形状不符（步骤为空）→ null", () => {
		const dir = tempDir();
		writeFileSync(
			join(dir, `${SESSION}.json`),
			JSON.stringify({ title: "x", steps: [], updatedAt: 1, versions: [] })
		);
		expect(new PlanStore(dir).get(SESSION)).toBeNull();
	});

	it("写盘不留临时文件", () => {
		const dir = tempDir();
		saveOne(new PlanStore(dir));
		expect(existsSync(join(dir, `${SESSION}.json.tmp`))).toBe(false);
	});
});

describe("PlanStore —— 写侧校验（写进去的必须能原样读回来）", () => {
	it("拒绝带路径分隔符 / 空 / 非字符串的 sessionId", () => {
		const store = new PlanStore(tempDir());
		for (const bad of ["../x", "a/b", "a\\b", "", undefined, 42]) {
			expect(() => store.save(bad, { steps: [step("s-1", "一")], source: "manual" }), String(bad)).toThrow();
		}
	});

	it("拒绝空步骤 / 超 50 步 / 空正文 / 超 500 字", () => {
		const store = new PlanStore(tempDir());
		expect(() => store.save(SESSION, { steps: [], source: "manual" })).toThrow(/至少要有一步/u);
		const many = Array.from({ length: PLAN_MAX_STEPS + 1 }, (_, i) => step(`s-${i}`, `第 ${i} 步`));
		expect(() => store.save(SESSION, { steps: many, source: "manual" })).toThrow(/步骤过多/u);
		expect(() => store.save(SESSION, { steps: [step("s-1", "   ")], source: "manual" })).toThrow(/正文为空/u);
		expect(() => store.save(SESSION, { steps: [step("s-1", "字".repeat(501))], source: "manual" })).toThrow(/正文过长/u);
	});

	it("拒绝超 80 字标题 / 非法来源 / 非法步骤 id", () => {
		const store = new PlanStore(tempDir());
		expect(() => store.save(SESSION, { title: "字".repeat(81), steps: [step("s-1", "一")], source: "manual" })).toThrow(/标题过长/u);
		expect(() => store.save(SESSION, { steps: [step("s-1", "一")], source: "robot" })).toThrow(/未知的计划书来源/u);
		expect(() => store.save(SESSION, { steps: [step("../x", "一")], source: "manual" })).toThrow(/id 非法/u);
	});

	it("非法输入不会留下任何文件", () => {
		const dir = tempDir();
		const store = new PlanStore(dir);
		expect(() => store.save(SESSION, { steps: [], source: "manual" })).toThrow();
		expect(existsSync(join(dir, `${SESSION}.json`))).toBe(false);
	});
});

describe("PlanStore —— 版本", () => {
	it("每次保存追加一版；最多保留 20 个（丢最旧）", () => {
		const dir = tempDir();
		const store = new PlanStore(dir);
		for (let i = 1; i <= 25; i += 1) {
			store.save(SESSION, { steps: [step("s-1", `第 ${i} 版`)], source: "manual" });
		}
		const plan = store.get(SESSION);
		expect(plan.versions).toHaveLength(PLAN_MAX_VERSIONS);
		// 最新一版是第 25 版；最旧保留下来的是第 6 版。
		expect(plan.versions.at(-1).steps[0].text).toBe("第 25 版");
		expect(plan.versions[0].steps[0].text).toBe("第 6 版");
		/* **落盘侧**也要截断，不能只靠 `get()` 读回时截 —— 读侧截断会把
		   「save 漏了 `.slice(-20)`」掩盖成全绿（文件体积已经失控）。
		   2026-11-10 反向验证实测过：删掉 save 里的 `.slice()` 时，
		   只断言 `plan.versions` 的那一版**不会变红**，所以这里直接看磁盘。 */
		const raw = JSON.parse(readFileSync(join(dir, `${SESSION}.json`), "utf8"));
		expect(raw.versions).toHaveLength(PLAN_MAX_VERSIONS);
		expect(raw.versions[0].steps[0].text).toBe("第 6 版");
	});

	it("版本记录保存后的快照（标题 / 来源 / 步骤都一致）", () => {
		const store = new PlanStore(tempDir());
		const saved = store.save(SESSION, {
			title: "计划：A",
			steps: [step("s-1", "一", true)],
			source: "manual",
		});
		expect(saved.versions.at(-1)).toMatchObject({
			source: "manual",
			title: "计划：A",
			steps: [step("s-1", "一", true)],
		});
	});

	it("只勾选完成：版本数不变，但步骤状态已落盘", () => {
		const dir = tempDir();
		const store = new PlanStore(dir);
		const first = saveOne(store);
		const toggled = store.save(SESSION, {
			title: first.title,
			steps: [step("s-1", "第一步", true)],
			source: "manual",
		});
		expect(toggled.versions).toHaveLength(1);
		expect(toggled.steps[0].done).toBe(true);
		expect(toggled.updatedAt).toBeGreaterThanOrEqual(first.updatedAt);
		// 落盘了：新实例（= 重启后的 daemon）读回的勾选状态是改过的。
		expect(new PlanStore(dir).get(SESSION).steps[0].done).toBe(true);
	});

	it("改步骤文本：版本 +1", () => {
		const store = new PlanStore(tempDir());
		saveOne(store);
		const changed = store.save(SESSION, {
			title: "计划：某件事",
			steps: [step("s-1", "改过的第一步")],
			source: "manual",
		});
		expect(changed.versions).toHaveLength(2);
		expect(changed.versions.at(-1).steps[0].text).toBe("改过的第一步");
	});

	it("只改标题：版本 +1", () => {
		const store = new PlanStore(tempDir());
		saveOne(store);
		const changed = store.save(SESSION, {
			title: "计划：换个标题",
			steps: [step("s-1", "第一步")],
			source: "manual",
		});
		expect(changed.versions).toHaveLength(2);
		expect(changed.versions.at(-1).title).toBe("计划：换个标题");
	});

	it("恢复旧版本（把旧文本再保存一次）：版本 +1，而不是覆盖历史", () => {
		const store = new PlanStore(tempDir());
		saveOne(store);
		store.save(SESSION, { title: "计划：某件事", steps: [step("s-1", "第二步")], source: "manual" });
		const restored = store.save(SESSION, { title: "计划：某件事", steps: [step("s-1", "第一步")], source: "manual" });
		expect(restored.versions).toHaveLength(3);
		expect(restored.versions.at(-1).steps[0].text).toBe("第一步");
	});
});

describe("PlanStore —— 批准", () => {
	it("批准当前版本：写入 approvedAt / approvedVersionId", () => {
		const store = new PlanStore(tempDir());
		const saved = saveOne(store);
		const approved = store.approve(SESSION);
		expect(typeof approved.approvedAt).toBe("number");
		expect(approved.approvedVersionId).toBe(saved.versions.at(-1).id);
		expect(new PlanStore(store.dir).get(SESSION).approvedVersionId).toBe(approved.approvedVersionId);
	});

	it("批准指定旧版本", () => {
		const store = new PlanStore(tempDir());
		const first = saveOne(store);
		saveOne(store, "第二步");
		const plan = store.get(SESSION);
		const approved = store.approve(SESSION, first.versions[0].id);
		expect(approved.approvedVersionId).toBe(first.versions[0].id);
		expect(plan.versions).toHaveLength(2);
	});

	it("计划书不存在 / 版本不存在 → 抛错", () => {
		const store = new PlanStore(tempDir());
		expect(() => store.approve(SESSION)).toThrow(/不存在/u);
		saveOne(store);
		expect(() => store.approve(SESSION, "v-nope")).toThrow(/找不到要批准的版本/u);
	});

	it("内容不变时保留批准态；内容改动后清除", () => {
		const store = new PlanStore(tempDir());
		const saved = saveOne(store);
		store.approve(SESSION);

		// 同标题、同步骤文本（只是勾选完成）→ 仍算同一份计划，批准态保留。
		const unchanged = store.save(SESSION, {
			title: saved.title,
			steps: [step("s-1", "第一步", true)],
			source: "manual",
		});
		expect(unchanged.approvedAt).toBeTypeOf("number");

		const changed = store.save(SESSION, {
			title: saved.title,
			steps: [step("s-1", "改过了")],
			source: "manual",
		});
		expect(changed.approvedAt).toBeUndefined();
		expect(changed.approvedVersionId).toBeUndefined();
	});

	it("capturedEntryId 在手动保存时保留（避免下次渲染把编辑覆盖回去）", () => {
		const store = new PlanStore(tempDir());
		saveOne(store);
		const manual = store.save(SESSION, {
			title: "计划：某件事",
			steps: [step("s-1", "手动改过")],
			source: "manual",
		});
		expect(manual.capturedEntryId).toBe("entry-1");
	});
});

describe("PlanStore —— 删除", () => {
	it("删除后读回 null；重复删除不报错", () => {
		const dir = tempDir();
		const store = new PlanStore(dir);
		saveOne(store);
		expect(store.remove(SESSION)).toEqual({ ok: true });
		expect(store.get(SESSION)).toBeNull();
		expect(store.remove(SESSION)).toEqual({ ok: true });
	});

	it("删除时校验 sessionId", () => {
		expect(() => new PlanStore(tempDir()).remove("../x")).toThrow();
	});

	it("磁盘上的文件确实是可读 JSON（便于用户手查）", () => {
		const dir = tempDir();
		saveOne(new PlanStore(dir));
		const raw = JSON.parse(readFileSync(join(dir, `${SESSION}.json`), "utf8"));
		expect(raw.title).toBe("计划：某件事");
	});
});
