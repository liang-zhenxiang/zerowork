/**
 * 文件时光机视图纯逻辑的单测（file-history-core.js，零依赖直测）。
 *
 * 这一页的界面只有 e2e 能覆盖（渲染层是 chunk 粒度、没有组件源码），但「清单顺序」
 * 「每个节点说什么」「边界情形的措辞」全是纯字符串与纯排序——放进单测之后，
 * e2e 只需要验「IPC 通了、DOM 挂上了、还原真的落盘了」。
 *
 * ── 反向验证（已真跑并还原）──────────────────────────────────────────
 * 见每条 describe 的说明；本文件的两处注入验证记录在主会话的任务报告里。
 */
import { describe, expect, it } from "vitest";
import {
	FILE_HISTORY_DIRECTION_NOTE,
	FILE_HISTORY_EMPTY_DESC,
	FILE_HISTORY_EMPTY_TITLE,
	FILE_HISTORY_LIST_MAX,
	countBroken,
	defaultVersionIndex,
	fileRowNote,
	formatDirLabel,
	formatRelativeTime,
	formatToolName,
	formatTruncatedNote,
	formatVersionTime,
	restoreConfirmText,
	restoreFailureRetryable,
	restoreFailureText,
	restoreSuccessText,
	sortFileEntries,
	timelineNotes,
	versionChangeText,
	versionCountLabel,
	versionSourceText
} from "../../src/renderer/src/file-history-core.js";

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0).getTime();

describe("formatVersionTime", () => {
	it("固定为 MM-DD HH:mm:ss（节点身份行 / 预览头 / 确认句 / toast 同格式）", () => {
		expect(formatVersionTime(at(2026, 10, 15, 14, 32))).toBe("10-15 14:32:00");
		expect(formatVersionTime(at(2026, 1, 5, 9, 7))).toBe("01-05 09:07:00");
		expect(formatVersionTime(at(2026, 12, 31, 0, 0))).toBe("12-31 00:00:00");
	});

	it("带秒：同一分钟内的两版必须能分辨（评审 P1-3 —— 确认句要能定位到具体一版）", () => {
		const a = new Date(2026, 9, 15, 16, 22, 4, 0).getTime();
		const b = new Date(2026, 9, 15, 16, 22, 37, 0).getTime();
		expect(formatVersionTime(a)).toBe("10-15 16:22:04");
		expect(formatVersionTime(b)).toBe("10-15 16:22:37");
		expect(formatVersionTime(a)).not.toBe(formatVersionTime(b));
	});
});

describe("formatRelativeTime", () => {
	const now = at(2026, 10, 15, 14, 0);

	it("按档给：刚刚 / 分钟 / 小时 / 昨天 / 天", () => {
		expect(formatRelativeTime(now - 20 * 1000, now)).toBe("刚刚");
		expect(formatRelativeTime(now - 5 * 60 * 1000, now)).toBe("5 分钟前");
		expect(formatRelativeTime(now - 3 * 60 * 60 * 1000, now)).toBe("3 小时前");
		expect(formatRelativeTime(now - 30 * 60 * 60 * 1000, now)).toBe("昨天");
		expect(formatRelativeTime(now - 4 * 24 * 60 * 60 * 1000, now)).toBe("4 天前");
	});

	it("超过 30 天落到绝对日期（N 天前那个数字已经失去意义）", () => {
		expect(formatRelativeTime(at(2026, 1, 5, 9, 0), now)).toBe("01-05");
	});

	it("时钟偏斜（at 在未来）不产生负数，落到「刚刚」", () => {
		expect(formatRelativeTime(now + 60 * 1000, now)).toBe("刚刚");
	});

	it("边界：59 分 59 秒仍是分钟档，满 60 分钟进小时档", () => {
		expect(formatRelativeTime(now - (60 * 60 * 1000 - 1000), now)).toBe("59 分钟前");
		expect(formatRelativeTime(now - 60 * 60 * 1000, now)).toBe("1 小时前");
	});
});

describe("sortFileEntries", () => {
	const rows = [
		{ key: "c", name: "c.md", lastAt: 100 },
		{ key: "a", name: "a.md", lastAt: 300 },
		{ key: "b", name: "b.md", lastAt: 300 },
		{ key: "d", name: "d.md", lastAt: 0 }
	];

	it("最后改动时间倒序；并列时按名字升序（同刻顺序仍然确定）", () => {
		expect(sortFileEntries(rows).map((r) => r.key)).toEqual(["a", "b", "c", "d"]);
	});

	it("不改动入参（视图按引用比较时不会被它悄悄重排）", () => {
		const before = rows.map((r) => r.key);
		sortFileEntries(rows);
		expect(rows.map((r) => r.key)).toEqual(before);
	});

	it("空 / 未定义输入返回空数组", () => {
		expect(sortFileEntries(undefined)).toEqual([]);
		expect(sortFileEntries([])).toEqual([]);
	});
});

describe("默认选中与计数", () => {
	it("默认选中最新一版（数组末位）；空数组是 -1", () => {
		expect(defaultVersionIndex([{ id: "1" }, { id: "2" }, { id: "3" }])).toBe(2);
		expect(defaultVersionIndex([])).toBe(-1);
		expect(defaultVersionIndex(undefined)).toBe(-1);
	});

	it("countBroken 只数 broken:true 的版本", () => {
		expect(countBroken([{ id: "1" }, { id: "2", broken: true }, { id: "3", broken: false }])).toBe(1);
		expect(countBroken([])).toBe(0);
		expect(countBroken(undefined)).toBe(0);
	});

	it("版本数标签是「N 版」", () => {
		expect(versionCountLabel(3)).toBe("3 版");
		expect(versionCountLabel(0)).toBe("0 版");
	});
});

describe("versionChangeText：节点第二行", () => {
	it("该版之后还有改动 → 被一次 +X −Y 的改动替换（符号承担语义）", () => {
		expect(versionChangeText({ added: 12, removed: 3 })).toBe("被一次 +12 −3 的改动替换");
		expect(versionChangeText({ added: 0, removed: 1 })).toBe("被一次 +0 −1 的改动替换");
	});

	it("最新一版不编造数字，给一句说明", () => {
		expect(versionChangeText({ added: 12, removed: 3 }, { isLatest: true })).toBe("这是最近一次改动之前的样子");
		expect(versionChangeText({}, { isLatest: true })).toBe("这是最近一次改动之前的样子");
	});

	it("契约里 added/removed 可缺省（如还原留下的那一版）→ 不写 +0 −0", () => {
		expect(versionChangeText({ tool: "restore" })).toBe("被一次改动替换");
		expect(versionChangeText({ added: 3 })).toBe("被一次改动替换");
	});

	it("broken 的版本第二行直接说明它不能还原（不静默）", () => {
		expect(versionChangeText({ broken: true, added: 1, removed: 1 })).toBe("内容已不在，这一版不能还原");
		expect(versionChangeText({ broken: true }, { isLatest: true })).toBe("内容已不在，这一版不能还原");
	});
});

describe("versionSourceText：节点右端的来源", () => {
	it("工具名翻成用户话术，不露 write / edit / restore", () => {
		expect(versionSourceText({ tool: "write" }, "市场部周报")).toBe("写入 · 市场部周报");
		expect(versionSourceText({ tool: "edit" }, "财务整理")).toBe("编辑 · 财务整理");
		expect(versionSourceText({ tool: "restore" }, "")).toBe("还原 · 来源会话已不在");
		expect(formatToolName("custom")).toBe("custom");
	});

	it("只有其一就不摆分隔符", () => {
		expect(versionSourceText({}, "周报")).toBe("周报");
		expect(versionSourceText({ tool: "edit" }, "")).toBe("编辑 · 来源会话已不在");
	});

	it("会话解析不到时不显示裸 sessionId，如实说", () => {
		expect(versionSourceText({}, "")).toBe("来源会话已不在");
		expect(versionSourceText({}, undefined)).toBe("来源会话已不在");
	});
});

describe("fileRowNote：清单第三行", () => {
	const now = at(2026, 10, 15, 14, 0);

	it("时间 · 来源会话", () => {
		expect(fileRowNote({ lastAt: now - 2 * 60 * 60 * 1000 }, { now, sessionTitle: "市场部周报" })).toBe(
			"2 小时前 · 市场部周报"
		);
	});

	it("来源解析不到 → 来源会话已不在（不显示裸 id）", () => {
		expect(fileRowNote({ lastAt: now - 1000 }, { now })).toBe("刚刚 · 来源会话已不在");
	});

	it("exists:false 与 skipped>0 都如实追加，措辞与项目页一致", () => {
		expect(
			fileRowNote({ lastAt: now - 1000, exists: false, skipped: 2 }, { now, sessionTitle: "数据组" })
		).toBe("刚刚 · 数据组 · 文件已不在 · 2 次未记录");
	});

	it("lastAt 为 0（meta 里没有版本）时不摆 1970 的日期", () => {
		expect(fileRowNote({ lastAt: 0 }, { now, sessionTitle: "空文件" })).toBe("空文件");
	});
});

describe("formatDirLabel：所在目录的显示口径", () => {
	it("长路径只留末两段（绝对路径铺在界面上读不出「这是哪儿」）", () => {
		expect(formatDirLabel("/var/folders/mf/xx/T/zerowork-ws-file-history-3Ofy0A")).toBe(
			"T/zerowork-ws-file-history-3Ofy0A"
		);
		expect(formatDirLabel("/Users/me/Documents/市场部/2026Q4")).toBe("市场部/2026Q4");
	});

	it("本来就短（一到两段）就逐字保留，包括盘符根与末尾斜杠", () => {
		expect(formatDirLabel("/Users")).toBe("/Users");
		expect(formatDirLabel("市场部/2026Q4")).toBe("市场部/2026Q4");
		expect(formatDirLabel("C:\\Users\\me\\docs\\")).toBe("me/docs");
	});

	it("空值不抛错", () => {
		expect(formatDirLabel("")).toBe("");
		expect(formatDirLabel(undefined)).toBe("");
	});
});

describe("truncated / skipped 的说明行", () => {
	it("截断说明逐字照资料库的句式，数字来自同一上限常量", () => {
		expect(FILE_HISTORY_LIST_MAX).toBe(200);
		expect(formatTruncatedNote()).toBe("文件较多，这里只显示最近改动的 200 个。");
	});

	it("没有缺口时一行都不出（不摆空行）", () => {
		expect(timelineNotes()).toEqual([]);
		expect(timelineNotes({ skipped: 0, brokenCount: 0 })).toEqual([]);
	});

	it("skipped>0 说清原因", () => {
		expect(timelineNotes({ skipped: 2 })).toEqual(["另有 2 次改动没有留下版本：文件超过 1 MiB，或不是文本文件。"]);
	});

	it("skipped>0 且有 broken：两行，第二行带「其中」", () => {
		expect(timelineNotes({ skipped: 2, brokenCount: 1 })).toEqual([
			"另有 2 次改动没有留下版本：文件超过 1 MiB，或不是文本文件。",
			"其中 1 版的内容已不在，不能还原，但时间点仍在。"
		]);
	});

	it("只有 broken（skipped 为 0）也必须说出来——不静默", () => {
		expect(timelineNotes({ brokenCount: 3 })).toEqual(["3 版的内容已不在，不能还原，但时间点仍在。"]);
	});
});

describe("还原确认句", () => {
	it("三个事实按顺序：文件名 / 时间点 / 先存成一条新版本", () => {
		expect(restoreConfirmText({ name: "周报.md", at: at(2026, 10, 15, 14, 32) })).toBe(
			"把「周报.md」还原到 10-15 14:32:00 的样子？现在的内容会先存成一条新版本，之后还能再退回来。"
		);
	});

	it("exists:false 时补一句「会重新创建它」（design.md §5 的既定行为）", () => {
		const text = restoreConfirmText({ name: "预算.xlsx", at: at(2026, 10, 15, 9, 5), exists: false });
		expect(text).toContain("把「预算.xlsx」还原到 10-15 09:05:00 的样子？");
		expect(text).toContain("现在的内容会先存成一条新版本，之后还能再退回来。");
		expect(text.endsWith("文件已不在，还原会重新创建它。")).toBe(true);
	});
});

describe("还原成功 / 失败的文案", () => {
	it("成功 toast 报出还原到的时间点", () => {
		expect(restoreSuccessText(at(2026, 10, 15, 14, 32))).toBe("已还原到 10-15 14:32:00");
	});

	it("每种 reason 都有自己的话术，且不回落到「操作失败」", () => {
		expect(restoreFailureText("running")).toBe("这个文件所属的会话正在运行，等它跑完再还原。");
		expect(restoreFailureText("missing")).toContain("这一版的内容已不在");
		expect(restoreFailureText("missing")).toContain("其余版本仍然可用");
		expect(restoreFailureText("no-such-version")).toBe("这一版已经不在了，时间轴已刷新。");
		expect(restoreFailureText("write-failed", "EACCES")).toBe("写入失败：EACCES。文件未被改动。");
		expect(restoreFailureText("unknown", "boom")).toBe("还原失败：boom。");
	});

	it("reason 缺省时用 daemon 的信息兜底，没有信息才给一句通用话", () => {
		expect(restoreFailureText(undefined, "存储损坏")).toBe("存储损坏");
		expect(restoreFailureText(undefined)).toBe("还原失败。");
	});

	it("可重试的失败是 running / write-failed / unknown；missing 不给重试", () => {
		expect(restoreFailureRetryable("running")).toBe(true);
		expect(restoreFailureRetryable("write-failed")).toBe(true);
		expect(restoreFailureRetryable("unknown")).toBe(true);
		expect(restoreFailureRetryable("missing")).toBe(false);
		expect(restoreFailureRetryable("no-such-version")).toBe(false);
	});
});

describe("钉住的两段固定文案（ux-proposal §5.2 与 §3.1）", () => {
	it("空态标题与说明逐字", () => {
		expect(FILE_HISTORY_EMPTY_TITLE).toBe("还没有文件历史");
		expect(FILE_HISTORY_EMPTY_DESC).toBe(
			"Agent 用写入 / 编辑工具改过文件之后，这里会留下每次改动前的版本，随时能退回去。"
		);
	});

	it("方向说明逐字（「为什么 3 个版本不是改了 3 次」的答案）", () => {
		expect(FILE_HISTORY_DIRECTION_NOTE).toBe(
			"这里每一版都是某次改动之前的内容；当前磁盘上的内容不在其中，还原之后它会作为一条新版本出现在末尾。"
		);
	});
});
