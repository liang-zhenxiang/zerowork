/**
 * 能力库画廊纯逻辑（src/renderer/src/expert-gallery-core.js）的单元测试。
 *
 * 守的是「界面上只表现为顺序 / 数字 / 一条 toast 不对劲」的那几块：
 *   1. 来源 × 标签 × 关键词是**与**关系（三者可叠加，不是互相顶掉）；
 *   2. 计数与列表同源；
 *   3. 排序三档：中文按拼音、`recent` 只认真实安装时间、不改入参数组；
 *   4. 封面色槽位稳定落在 1..6（同一专家两次渲染必须同色）；
 *   5. 拖放路径解析：mac / Windows / 编码 / 重复 / 非 file URI / 空行。
 *
 * 路径解析那组是这轮的重点：渲染层不允许「猜路径」，所以它只接受
 * `file:` URI 与 preload 给的绝对路径，其余一律丢弃 —— 这条边界必须有用例。
 */

import assert from "node:assert/strict";
import { describe, it } from "vitest";
import {
	SORT_MODES,
	SOURCE_FILTERS,
	filterExperts,
	isPackDropPath,
	pathsFromDropText,
	sortExperts,
	sourceCounts,
} from "../../src/renderer/src/expert-gallery-core.js";

function expert(overrides) {
	return {
		name: "fixture",
		displayName: "示例专家",
		profession: "示例",
		description: "示例描述",
		displayDescription: "示例展示描述",
		tags: ["示例", "测试", "占位"],
		source: "builtin",
		expertType: "expert",
		...overrides,
	};
}

const BUILTIN_ANALYST = expert({
	name: "data-analyst",
	displayName: "数据分析师",
	profession: "数据分析",
	description: "把表格变成结论",
	displayDescription: "做数据清洗、指标拆解与可视化",
	tags: ["数据", "分析", "报告"],
});

const BUILTIN_DESIGNER = expert({
	name: "product-designer",
	displayName: "产品设计师",
	profession: "产品设计",
	description: "从需求到原型",
	displayDescription: "梳理信息架构并产出可评审的原型",
	tags: ["产品", "设计", "原型"],
});

const USER_WRITER = expert({
	name: "my-writer",
	displayName: "我的写作助手",
	profession: "写作",
	description: "中文长文润色",
	displayDescription: "把草稿改到可以发布",
	tags: ["写作", "文案", "校对"],
	source: "user",
});

const PACK_MINUTES = expert({
	name: "pack-minutes",
	displayName: "会议纪要专家",
	profession: "会议纪要",
	description: "把会议记录整理成可执行纪要",
	displayDescription: "结论 / 待办 / 风险三段",
	tags: ["会议", "纪要", "待办"],
	source: "pack",
	packId: "pack-minutes",
	packVersion: "1.0.0",
	packInstalledAt: 1000,
});

const PACK_MAIL = expert({
	name: "pack-mail",
	displayName: "邮件助手",
	profession: "邮件",
	description: "写更短的邮件",
	displayDescription: "把长说明压成三句话",
	tags: ["邮件", "沟通", "写作"],
	source: "pack",
	packId: "pack-mail",
	packVersion: "0.2.0",
	packInstalledAt: 3000,
});

/** 旧包：`_pack.json` 缺 installedAt（本次改动前装的包就是这样）。 */
const PACK_LEGACY = expert({
	name: "pack-legacy",
	displayName: "旧包",
	profession: "兼容",
	description: "装得早，没有安装时间",
	displayDescription: "旧版本写下的元数据",
	tags: ["兼容", "旧版", "迁移"],
	source: "pack",
	packId: "pack-legacy",
	packVersion: "0.0.1",
});

const ALL = [BUILTIN_ANALYST, BUILTIN_DESIGNER, USER_WRITER, PACK_MINUTES, PACK_MAIL, PACK_LEGACY];

describe("SOURCE_FILTERS / SORT_MODES", () => {
	it("来源四档与排序三档的 id 固定（界面与测试共用同一份）", () => {
		assert.deepEqual(
			SOURCE_FILTERS.map((filter) => filter.id),
			["all", "builtin", "user", "pack"],
		);
		assert.deepEqual(
			SORT_MODES.map((mode) => mode.id),
			["default", "name", "recent"],
		);
	});
});

describe("filterExperts —— 来源 × 标签 × 关键词是「与」关系", () => {
	it("默认全部返回（保持传入顺序）", () => {
		assert.deepEqual(filterExperts(ALL, {}), ALL);
		assert.deepEqual(filterExperts(ALL), ALL);
	});

	it("按来源筛选", () => {
		assert.deepEqual(
			filterExperts(ALL, { source: "builtin" }).map((item) => item.name),
			["data-analyst", "product-designer"],
		);
		assert.deepEqual(
			filterExperts(ALL, { source: "user" }).map((item) => item.name),
			["my-writer"],
		);
		assert.deepEqual(
			filterExperts(ALL, { source: "pack" }).map((item) => item.name),
			["pack-minutes", "pack-mail", "pack-legacy"],
		);
	});

	it("未知来源值按「全部」处理（坏数据不让列表变空）", () => {
		assert.deepEqual(filterExperts(ALL, { source: "mystery" }), ALL);
	});

	it("按标签筛选", () => {
		assert.deepEqual(
			filterExperts(ALL, { tag: "会议" }).map((item) => item.name),
			["pack-minutes"],
		);
	});

	it("关键词匹配名称 / 展示名 / 职称 / 描述，且大小写不敏感", () => {
		assert.deepEqual(
			filterExperts(ALL, { keyword: "纪要" }).map((item) => item.name),
			["pack-minutes"],
		);
		assert.deepEqual(
			filterExperts(ALL, { keyword: "ANALYST" }).map((item) => item.name),
			["data-analyst"],
		);
		// 描述（daemon 的 description）也算命中。
		assert.deepEqual(
			filterExperts(ALL, { keyword: "指标拆解" }).map((item) => item.name),
			["data-analyst"],
		);
	});

	it("来源 + 标签 + 关键词三者叠加（不是互相顶掉）", () => {
		assert.deepEqual(
			filterExperts(ALL, { source: "pack", tag: "写作", keyword: "邮件" }).map((item) => item.name),
			["pack-mail"],
		);
		// 同一个标签下换来源就没有结果 —— 这条是「与」关系的反证。
		assert.deepEqual(filterExperts(ALL, { source: "builtin", tag: "写作", keyword: "邮件" }), []);
	});

	it("关键词首尾空白被忽略；空关键词等于不过滤", () => {
		assert.deepEqual(filterExperts(ALL, { keyword: "   " }), ALL);
		assert.deepEqual(
			filterExperts(ALL, { keyword: "  纪要  " }).map((item) => item.name),
			["pack-minutes"],
		);
	});

	it("坏数据（null / 缺字段）不会抛错", () => {
		const dirty = [null, {}, { name: "ok", source: "pack", tags: [] }];
		assert.deepEqual(filterExperts(dirty, { source: "pack" }).map((item) => item?.name), ["ok"]);
		assert.equal(filterExperts(undefined, {}).length, 0);
	});
});

describe("sourceCounts —— 计数与列表同源", () => {
	it("四档计数（未知来源只进「全部」）", () => {
		const counts = sourceCounts([...ALL, { name: "ghost", source: "mystery" }]);
		assert.deepEqual(counts, { all: 7, builtin: 2, user: 1, pack: 3 });
	});

	it("空列表全为 0", () => {
		assert.deepEqual(sourceCounts([]), { all: 0, builtin: 0, user: 0, pack: 0 });
	});
});

describe("sortExperts —— 三档排序", () => {
	it("default 保持 daemon 给的顺序，返回新数组", () => {
		const sorted = sortExperts(ALL, "default");
		assert.deepEqual(
			sorted.map((item) => item.name),
			ALL.map((item) => item.name),
		);
		assert.notEqual(sorted, ALL);
	});

	it("name 按中文拼音排序（不是码点序）", () => {
		assert.deepEqual(
			sortExperts(ALL, "name").map((item) => item.displayName),
			["产品设计师", "会议纪要专家", "旧包", "数据分析师", "我的写作助手", "邮件助手"],
		);
	});

	it("name 同展示名时按 name 兜底（结果确定）", () => {
		const same = [
			expert({ name: "b-expert", displayName: "同名" }),
			expert({ name: "a-expert", displayName: "同名" }),
		];
		assert.deepEqual(
			sortExperts(same, "name").map((item) => item.name),
			["a-expert", "b-expert"],
		);
	});

	it("recent 只对有能力包安装时间的条目降序，其余按名称排在后面", () => {
		assert.deepEqual(
			sortExperts(ALL, "recent").map((item) => item.name),
			[
				"pack-mail", // 3000
				"pack-minutes", // 1000
				// 没有安装时间的（内置 / 我的 / 旧包）按名称排在后面：
				"product-designer", // 产品设计师
				"pack-legacy", // 旧包
				"data-analyst", // 数据分析师
				"my-writer", // 我的写作助手
			],
		);
	});

	it("recent 不给非包条目伪造安装时间", () => {
		const legacy = sortExperts([PACK_LEGACY, BUILTIN_ANALYST], "recent");
		assert.equal(legacy.length, 2);
		for (const item of legacy) {
			// 输出里不该凭空出现这个字段（只认输入里真有的）。
			assert.equal(Object.hasOwn(item, "packInstalledAt"), false);
		}
	});

	it("不修改传入数组（React 状态可能被别处共享）", () => {
		const input = [...ALL];
		const before = input.map((item) => item.name);
		sortExperts(input, "recent");
		sortExperts(input, "name");
		assert.deepEqual(
			input.map((item) => item.name),
			before,
		);
	});
});

describe("pathsFromDropText —— 拖放载荷 → 本地路径", () => {
	it("macOS 路径 + 百分号编码", () => {
		assert.deepEqual(pathsFromDropText("file:///Users/me/My%20Pack.zwpack"), ["/Users/me/My Pack.zwpack"]);
	});

	it("Windows 盘符去掉前缀斜杠", () => {
		assert.deepEqual(pathsFromDropText("file:///C:/Users/me/pack.zwpack"), ["C:/Users/me/pack.zwpack"]);
		assert.deepEqual(pathsFromDropText("file:///C:/Program%20Files/a.zwpack"), [
			"C:/Program Files/a.zwpack",
		]);
	});

	it("中文目录名按 UTF-8 解码", () => {
		assert.deepEqual(
			pathsFromDropText("file:///Users/me/%E4%BC%9A%E8%AE%AE%E7%BA%AA%E8%A6%81"),
			["/Users/me/会议纪要"],
		);
	});

	it("URI 列表：一行一个，空行与注释忽略，重复去重保序", () => {
		const text = [
			"# 这是 uri-list 的注释",
			"",
			"file:///tmp/a.zwpack",
			"file:///tmp/b.zwpack",
			"file:///tmp/a.zwpack",
			"   ",
		].join("\r\n");
		assert.deepEqual(pathsFromDropText(text), ["/tmp/a.zwpack", "/tmp/b.zwpack"]);
	});

	it("非 file: 协议与解析失败的行丢弃", () => {
		assert.deepEqual(pathsFromDropText("https://example.com/x.zwpack"), []);
		assert.deepEqual(pathsFromDropText("not a url"), []);
		assert.deepEqual(pathsFromDropText("file:///tmp/%ZZ.zwpack"), []);
		assert.deepEqual(pathsFromDropText(""), []);
		assert.deepEqual(pathsFromDropText(undefined), []);
	});

	it("localhost 主机按本地路径处理；远程主机保留 UNC 前缀", () => {
		assert.deepEqual(pathsFromDropText("file://localhost/Users/me/x.zwpack"), ["/Users/me/x.zwpack"]);
		assert.deepEqual(pathsFromDropText("file://server/share/x.zwpack"), ["//server/share/x.zwpack"]);
	});

	it("混合载荷：只留 file: 行", () => {
		const text = "https://example.com\nfile:///tmp/one.zwpack\n# 注释\nfile:///tmp/two.zwpack";
		assert.deepEqual(pathsFromDropText(text), ["/tmp/one.zwpack", "/tmp/two.zwpack"]);
	});
});

describe("isPackDropPath —— 初筛交给 daemon 前的判断", () => {
	it("接受 .zwpack / .zip（大小写不敏感）", () => {
		assert.equal(isPackDropPath("/tmp/a.zwpack"), true);
		assert.equal(isPackDropPath("C:\\Users\\me\\a.ZIP"), true);
	});

	it("没有扩展名的路径按目录处理（daemon 支持目录来源）", () => {
		assert.equal(isPackDropPath("/tmp/pack-fixture"), true);
		assert.equal(isPackDropPath("/tmp/pack-fixture/"), true);
		assert.equal(isPackDropPath("C:\\Users\\me\\pack-fixture"), true);
	});

	it("有其它扩展名的文件不是能力包", () => {
		assert.equal(isPackDropPath("/tmp/readme.txt"), false);
		assert.equal(isPackDropPath("/tmp/a.tar.gz"), false);
		assert.equal(isPackDropPath(""), false);
		assert.equal(isPackDropPath(undefined), false);
	});
});
