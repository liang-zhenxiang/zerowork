/**
 * src/shared/ipc.js 的单元测试。
 *
 * 这个模块是主进程与 preload 共用的 IPC 契约，改错了不会编译报错，
 * 只会在运行时表现为「某个功能静默失效」——最需要测试兜住的那类代码。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
	INVOKE,
	PUSH,
	PDF_EXTENSION,
	OFFICE_EXTENSIONS,
	LEGACY_DOC_EXTENSIONS,
	docKindOf,
	DEFAULT_GLOBAL_SHORTCUT,
} from "../../src/shared/ipc.js";

describe("IPC 通道常量", () => {
	it("INVOKE 通道名带命名空间前缀（保证同前缀通道聚合在一起）", () => {
		for (const [key, channel] of Object.entries(INVOKE)) {
			expect(channel, `INVOKE.${key} 缺少 "域:" 前缀`).toMatch(/^[a-z-]+:[a-z-]+$/);
		}
	});

	it("PUSH 与 INVOKE 不重叠（同一通道不能既是请求又是推送）", () => {
		const invokeChannels = new Set(Object.values(INVOKE));
		const overlap = Object.values(PUSH).filter((c) => invokeChannels.has(c));
		expect(overlap, `重叠通道：${overlap.join(", ")}`).toEqual([]);
	});

	it("通道名全局唯一（重复会导致后注册的覆盖先注册的）", () => {
		const all = [...Object.values(INVOKE), ...Object.values(PUSH)];
		const seen = new Map();
		const dupes = [];
		for (const c of all) {
			if (seen.has(c)) dupes.push(c);
			seen.set(c, true);
		}
		expect(dupes, `重复通道：${dupes.join(", ")}`).toEqual([]);
	});

	it("daemonStatus 通道存在（消除 daemon ready 推送的启动竞态）", () => {
		expect(INVOKE.daemonStatus).toBe("daemon:status");
	});

	it("本机模型服务的两条通道已登记（探测 / 一键接入）", () => {
		expect(INVOKE.probeLocalEndpoints).toBe("settings:probe-local-endpoints");
		expect(INVOKE.connectLocalEndpoint).toBe("settings:connect-local-endpoint");
	});

	/**
	 * preload 不 import 本模块（既有架构），INVOKE 是**两份手工同步的副本**
	 * ——文件里明写了「改通道名两处都要改」。人记不住这件事，让这条断言记：
	 * 只改一处时，新通道会静默失效（渲染层调到一个 daemon 不认的通道名）。
	 */
	it("shared 与 preload 的 INVOKE 表逐条一致（两份手工副本不许漂移）", () => {
		const tableOf = (relativePath) => {
			const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
			const start = source.indexOf("const INVOKE = {");
			expect(start, `${relativePath} 里找不到 INVOKE 表`).toBeGreaterThan(-1);
			const end = source.indexOf("\n};", start);
			expect(end, `${relativePath} 的 INVOKE 表没有收尾`).toBeGreaterThan(start);
			const table = new Map();
			for (const line of source.slice(start, end).matchAll(/^\s*([A-Za-z]\w*):\s*"([^"]+)",$/gm)) {
				table.set(line[1], line[2]);
			}
			return table;
		};
		const shared = tableOf("../../src/shared/ipc.js");
		const preload = tableOf("../../src/preload/index.js");
		expect(shared.size).toBeGreaterThan(50);
		expect([...shared.keys()].filter((k) => !preload.has(k)), "preload 缺少这些通道").toEqual([]);
		expect([...preload.keys()].filter((k) => !shared.has(k)), "preload 多出这些通道").toEqual([]);
		const mismatched = [...shared].filter(([k, v]) => preload.get(k) !== v);
		expect(mismatched, `通道值不一致：${mismatched.map(([k]) => k).join(", ")}`).toEqual([]);
	});

	it("默认全局快捷键为 Shift+Alt+W", () => {
		expect(DEFAULT_GLOBAL_SHORTCUT).toBe("Shift+Alt+W");
	});
});

describe("docKindOf —— 按扩展名判定文档类型", () => {
	it("识别 PDF", () => {
		expect(docKindOf("report.pdf")).toBe("pdf");
		expect(docKindOf("/a/b/REPORT.PDF")).toBe("pdf");
	});

	it("识别 Office 文档", () => {
		for (const ext of OFFICE_EXTENSIONS) {
			expect(docKindOf(`file${ext}`), `${ext} 应识别为 office`).toBe("office");
		}
	});

	it("识别旧版 Office 格式", () => {
		for (const ext of LEGACY_DOC_EXTENSIONS) {
			expect(docKindOf(`legacy${ext}`), `${ext} 应识别为 legacy`).toBe("legacy");
		}
	});

	it("未知扩展名归为 unsupported", () => {
		// 注意是 "unsupported" 而不是空串 —— 调用方按这个值决定是否提示
		// 「不支持的文件类型」，返回空串会让提示逻辑失效。
		expect(docKindOf("photo.xyz")).toBe("unsupported");
		expect(docKindOf("noext")).toBe("unsupported");
	});

	it("大小写不敏感", () => {
		expect(docKindOf("A.Pdf")).toBe(docKindOf("a.pdf"));
		expect(docKindOf("REPORT.DOCX")).toBe("office");
	});

	it("三类扩展名互不重叠", () => {
		const office = [...OFFICE_EXTENSIONS];
		const legacy = [...LEGACY_DOC_EXTENSIONS];
		expect(office).not.toContain(PDF_EXTENSION);
		expect(legacy).not.toContain(PDF_EXTENSION);
		const overlap = office.filter((e) => legacy.includes(e));
		expect(overlap, `office 与 legacy 重叠：${overlap.join(", ")}`).toEqual([]);
	});

	it("扩展名集合非空（防常量被误删）", () => {
		expect(OFFICE_EXTENSIONS.size).toBeGreaterThan(0);
		expect(LEGACY_DOC_EXTENSIONS.size).toBeGreaterThan(0);
	});
});
