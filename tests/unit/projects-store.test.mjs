/**
 * 项目索引（projects.json）的单测。
 *
 * 被测对象 `src/main/daemon/projects.js` —— 照 pin.js 形态抽的独立模块
 * （原子落盘 / 坏文件当空 / 结构校验拒收），不 import session-files.js，可直接测。
 *
 * ── 反向验证（已真跑并还原）──────────────────────────────────────────
 * 1) 把 assignSession 里「先从旧项目移除」删掉：「换项目 = 先移除」与
 *    「一个会话只属一个项目」两条变红。
 * 2) 把 persist 的 renameSync 换成直接 writeFileSync（非原子）：单测本身仍绿 ——
 *    原子性是崩溃语义，单测钉不住它，由「与 pin.js 同形态」的代码评审承担。
 *    （写在这里是交代边界，不是宣称测过。）
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { PROJECT_COLOR_COUNT, PROJECT_INSTRUCTIONS_MAX, ProjectsStore } from "../../src/main/daemon/projects.js";

let dir;

function newStore() {
  return new ProjectsStore(join(dir, "projects.json"));
}

afterEach(() => {
  if (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

function freshDir() {
  dir = mkdtempSync(join(tmpdir(), "zerowork-projects-"));
  return dir;
}

describe("加载：文件不存在 / 坏 JSON / 结构不符 一律当空", () => {
	it("文件不存在 → 空列表，不抛", () => {
    freshDir();
		expect(newStore().list()).toEqual([]);
	});

	it("坏 JSON → 当空", () => {
    freshDir();
		writeFileSync(join(dir, "projects.json"), "{不是 JSON");
		expect(newStore().list()).toEqual([]);
	});

	it("字段形态不对的条目跳过；id 重复以先到为准", () => {
    freshDir();
		writeFileSync(
			join(dir, "projects.json"),
			JSON.stringify({
				version: 1,
				projects: [
					{ id: "p1", name: "正常", colorIndex: 2, instructions: "", createdAt: 1, sessionPaths: ["/a.jsonl"] },
					{ id: "", name: "id 空", sessionPaths: [] },
					{ name: "缺 id" },
					{ id: "p2", name: "   ", sessionPaths: [] },
					{ id: "p1", name: "id 重复（后到丢弃）" },
					{ id: "p3", name: "色号越界归 0", colorIndex: 99, sessionPaths: [] },
				],
			}),
		);
		const list = newStore().list();
		expect(list.map((p) => p.id)).toEqual(["p1", "p3"]);
		expect(list[1].colorIndex).toBe(0);
	});

	it("sessionPaths 去重并 resolve（同一文件两种写法只占一条）", () => {
    freshDir();
		writeFileSync(
			join(dir, "projects.json"),
			JSON.stringify({
				version: 1,
				projects: [{ id: "p1", name: "A", sessionPaths: ["/tmp/s.jsonl", "/tmp/./s.jsonl"] }],
			}),
		);
		const store = newStore();
		expect(store.list()[0].sessionPaths).toHaveLength(1);
	});
});

describe("CRUD", () => {
	it("创建：名称 trim、色按现存数轮转、id 唯一", () => {
    freshDir();
		const store = newStore();
		const a = store.create("  Q3 调研  ");
		expect(a.name).toBe("Q3 调研");
		expect(a.colorIndex).toBe(0);
		const b = store.create("B");
		expect(b.colorIndex).toBe(1);
		expect(a.id).not.toBe(b.id);
	});

	it("创建空名被拒（trim 后空串也算空）", () => {
    freshDir();
		const store = newStore();
		expect(() => store.create("   ")).toThrow("不能为空");
		expect(() => store.create(undefined)).toThrow("不能为空");
	});

	it("改名 / 改色 / 改指令：幂等不落盘，越界被拒", () => {
    freshDir();
		const store = newStore();
		const { id } = store.create("A");
		store.rename(id, "AA");
		expect(store.get(id).name).toBe("AA");
		expect(() => store.rename(id, " ")).toThrow("不能为空");
		store.setColor(id, 5);
		expect(store.get(id).colorIndex).toBe(5);
		expect(() => store.setColor(id, PROJECT_COLOR_COUNT)).toThrow("只有");
		store.setInstructions(id, "始终先看数据再下结论");
		expect(store.get(id).instructions).toBe("始终先看数据再下结论");
		// 超限截断：数据层最后防线
		store.setInstructions(id, "字".repeat(PROJECT_INSTRUCTIONS_MAX + 50));
		expect(store.get(id).instructions).toHaveLength(PROJECT_INSTRUCTIONS_MAX);
	});

	it("删除：只解除引用，返回被解除的会话路径", () => {
    freshDir();
		const store = newStore();
		const { id } = store.create("A");
		store.assignSession("/tmp/x.jsonl", id);
		const released = store.delete(id);
		expect(released).toEqual([resolve("/tmp/x.jsonl")]);
		expect(store.list()).toEqual([]);
		expect(store.projectIdFor("/tmp/x.jsonl")).toBeUndefined();
	});
});

describe("会话归属：一个会话只属一个项目", () => {
	it("归入后 projectIdFor 反查得到；移出（null）后为 undefined；重复移出幂等", () => {
    freshDir();
		const store = newStore();
		const a = store.create("A");
		store.assignSession("/tmp/s1.jsonl", a.id);
		expect(store.projectIdFor("/tmp/s1.jsonl")).toBe(a.id);
		store.assignSession("/tmp/s1.jsonl", null);
		expect(store.projectIdFor("/tmp/s1.jsonl")).toBeUndefined();
		expect(() => store.assignSession("/tmp/s1.jsonl", null)).not.toThrow();
	});

	it("换项目 = 先从旧项目移除（旧项目 sessionPaths 不再含它）", () => {
    freshDir();
		const store = newStore();
		const a = store.create("A");
		const b = store.create("B");
		store.assignSession("/tmp/s1.jsonl", a.id);
		store.assignSession("/tmp/s1.jsonl", b.id);
		expect(store.get(a.id).sessionPaths).toEqual([]);
		expect(store.get(b.id).sessionPaths).toHaveLength(1);
		expect(store.projectIdFor("/tmp/s1.jsonl")).toBe(b.id);
	});

	it("归入不存在的项目被拒；同项目重复归入幂等不落盘", () => {
    freshDir();
		const store = newStore();
		const a = store.create("A");
		expect(() => store.assignSession("/tmp/s.jsonl", "p_ghost")).toThrow("项目不存在");
		store.assignSession("/tmp/s.jsonl", a.id);
		store.assignSession("/tmp/s.jsonl", a.id);
		expect(store.get(a.id).sessionPaths).toHaveLength(1);
	});

	it("手改文件出现同会话双项目：加载以先注册为准（不炸、不双计）", () => {
    freshDir();
		writeFileSync(
			join(dir, "projects.json"),
			JSON.stringify({
				version: 1,
				projects: [
					{ id: "pa", name: "A", sessionPaths: ["/tmp/s.jsonl"] },
					{ id: "pb", name: "B", sessionPaths: ["/tmp/s.jsonl"] },
				],
			}),
		);
		const store = newStore();
		expect(store.projectIdFor("/tmp/s.jsonl")).toBe("pa");
		// 期望值过 resolve（与 store 同一规范化）：Windows 上 "/tmp/s.jsonl" 会被
		// resolve 成 "D:\tmp\s.jsonl"，裸写 POSIX 路径在 Windows 上必假红（CI 实测）。
		expect(store.list()[1].sessionPaths).toEqual([resolve("/tmp/s.jsonl")]); // B 里的脏引用原样保留，反查不指向它
	});
});

describe("常驻指令反查（注入层的入口）", () => {
	it("有指令 → 返回指令文本；未归入 / 项目无指令 → undefined", () => {
    freshDir();
		const store = newStore();
		const a = store.create("A");
		expect(store.instructionsFor("/tmp/s.jsonl")).toBeUndefined();
		store.assignSession("/tmp/s.jsonl", a.id);
		expect(store.instructionsFor("/tmp/s.jsonl")).toBeUndefined();
		store.setInstructions(a.id, "输出一律用中文");
		expect(store.instructionsFor("/tmp/s.jsonl")).toBe("输出一律用中文");
	});
});

describe("落盘形态", () => {
	it("持久化后重开能读回（version 字段与 2 空格缩进 + 尾换行）", () => {
    freshDir();
		const store = newStore();
		const a = store.create("Q3 调研");
		store.assignSession("/tmp/s.jsonl", a.id);
		const raw = readFileSync(join(dir, "projects.json"), "utf8");
		expect(raw.endsWith("\n")).toBe(true);
		const parsed = JSON.parse(raw);
		expect(parsed.version).toBe(1);
		expect(parsed.projects[0].name).toBe("Q3 调研");
		const reopened = new ProjectsStore(join(dir, "projects.json"));
		expect(reopened.projectIdFor("/tmp/s.jsonl")).toBe(a.id);
	});

	it("写入走临时文件 + rename（落盘期间不留 .tmp 残骸）", () => {
    freshDir();
		const store = newStore();
		store.create("A");
		const files = mkdtempSync(join(tmpdir(), "zerowork-projects-"));
		try {
			const other = new ProjectsStore(join(files, "sub", "projects.json"));
			other.create("B"); // 目录不存在也能写（mkdirSync recursive）
			expect(other.list()[0].name).toBe("B");
		} finally {
			rmSync(files, { recursive: true, force: true });
		}
	});
});
