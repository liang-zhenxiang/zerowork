/**
 * 确定性 hooks 的设置页闭环：列表 / 新增 / 试运行 / 工作区信任开关。
 *
 * 这条链跨了四层（renderer → preload → daemon → preferences.json），任何一层接错
 * 都表现为「看起来没坏」：
 *   · 只存在内存里 → 当前页能看见，重开没了；
 *   · 写进去但读侧不认 → 设置里列着、执行时不生效；
 *   · 试运行不带载荷 → 用户以为脚本没问题，实际线上 stdin 是空的；
 *   · 工作区 hooks 未信任却执行 → 「克隆即执行代码」。
 * 所以这里钉的是「写下 → 落盘 → 试运行看到真实输出 → 信任开关改变状态」。
 *
 * 等待一律等**具体内容元素**（两段式渲染：h2 同步、内容等 IPC 回包）。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const HOOK_STDOUT = "GUI_HOOK_OK";
const HOOK_STDERR_PREFIX = "GUI_HOOK_SEEN";

const h = createHarness({ name: "gui-hooks" });
mkdirSync(h.WORKSPACE_DIR, { recursive: true });

/*
 * 工作区 hooks：启动前就放到 `.zerowork/hooks.json` —— 默认**不执行**，
 * 设置页要能只读展示它、并让用户显式打开信任。
 */
mkdirSync(join(h.WORKSPACE_DIR, ".zerowork"), { recursive: true });
writeFileSync(
	join(h.WORKSPACE_DIR, ".zerowork", "hooks.json"),
	JSON.stringify(
		{
			version: 1,
			hooks: [{ id: "ws-1", event: "PreToolUse", matcher: "write", command: "node check-write.mjs", timeoutMs: 5000 }],
		},
		null,
		2,
	),
	"utf8",
);

/** 用户级 hook 的试运行脚本：读 stdin、回显事件、退出码 0。 */
const fixture = join(h.WORKSPACE_DIR, "gui-hook.mjs");
writeFileSync(
	fixture,
	`let input = "";\nprocess.stdin.setEncoding("utf8");\nprocess.stdin.on("data", (c) => (input += c));\nprocess.stdin.on("end", () => {\n  const payload = JSON.parse(input);\n  console.log("${HOOK_STDOUT}");\n  console.error("${HOOK_STDERR_PREFIX}:" + payload.event);\n});\n`,
	"utf8",
);
const hookCommand = `"${process.execPath}" "${fixture}"`;

/**
 * 拒绝脚本：退出码 2。生命周期事件用它验证**文案**——
 * 「拒绝」在工具事件里等于拦下调用，在这里只说明这个脚本不同意（未阻断）。
 * 用 exit 0 的脚本测不出这句话，因为「通过」的事件无关分支。
 */
const denyFixture = join(h.WORKSPACE_DIR, "gui-hook-deny.mjs");
writeFileSync(
	denyFixture,
	`let input = "";\nprocess.stdin.setEncoding("utf8");\nprocess.stdin.on("data", (c) => (input += c));\nprocess.stdin.on("end", () => {\n  console.error("DENY:" + input.length);\n  process.exit(2);\n});\n`,
	"utf8",
);
const denyCommand = `"${process.execPath}" "${denyFixture}"`;

/*
 * 导出 / 导入（#387）：导出的内容由第一条新用例捕获并写到这个路径，
 * 后面的用例用它驱动真实的 file input（setInputFiles），走完整读取路径。
 */
const exportedPath = join(h.WORKSPACE_DIR, "exported-hooks.json");
const invalidPath = join(h.WORKSPACE_DIR, "invalid-hooks.json");
/** 导出形状的现场证据，供回读用例比对「导入后与导出前逐字段一致」。 */
let exportedHooks;

await h.launch();
const win = h.window();

/** 在设置页里按 h2 文案找分组。 */
const sectionReady = (heading, selector) =>
	win.evaluate(
		({ title, sel }) => {
			const section = [...document.querySelectorAll(".settings-section")].find(
				(node) => node.querySelector("h2")?.textContent.trim() === title,
			);
			return section === undefined ? false : section.querySelector(sel) !== null;
		},
		{ title: heading, sel: selector },
	);

const sectionText = (heading) =>
	win.evaluate((title) => {
		const section = [...document.querySelectorAll(".settings-section")].find(
			(node) => node.querySelector("h2")?.textContent.trim() === title,
		);
		return section === undefined ? null : section.textContent;
	}, heading);

async function openSettings() {
	await win.evaluate(() => document.querySelector('[aria-label="设置"]').click());
	await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") !== null), {
		timeout: 30_000,
		desc: "设置对话框打开",
	});
	await win.evaluate(() => {
		const item = [...document.querySelectorAll(".settings-nav-item")].find((node) => node.textContent.trim() === "通用");
		item?.click();
	});
	// 等具体内容元素（`.starter-add` 在数据回包后才渲染），不要只等 h2。
	await waitUntil(() => sectionReady("Hooks", ".starter-add"), {
		timeout: 20_000,
		interval: 300,
		desc: "「Hooks」分组内容渲染（getHooks 回包后）",
	});
}

async function clickInSection(heading, selector) {
	await win.evaluate(
		({ title, sel }) => {
			const section = [...document.querySelectorAll(".settings-section")].find(
				(node) => node.querySelector("h2")?.textContent.trim() === title,
			);
			if (section === undefined) throw new Error(`找不到「${title}」分组`);
			const node = section.querySelector(sel);
			if (node === null) throw new Error(`「${title}」分组里找不到 ${sel}；片段：${section.outerHTML.slice(0, 1500)}`);
			node.click();
		},
		{ title: heading, sel: selector },
	);
}

async function setInput(ariaLabel, value) {
	await win.evaluate(
		({ label, next }) => {
			const node = document.querySelector(`[aria-label="${label}"]`);
			if (node === null) throw new Error(`找不到输入框：${label}`);
			const proto = node instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
			Object.getOwnPropertyDescriptor(proto, "value").set.call(node, next);
			node.dispatchEvent(new window.Event("input", { bubbles: true }));
		},
		{ label: ariaLabel, next: value },
	);
}

/** 把 Hooks 分组滚进视口中央：截图要拍到这一块，而不是通用页顶端。 */
async function scrollToHooks() {
	await win.evaluate(() => {
		const section = [...document.querySelectorAll(".settings-section")].find(
			(node) => node.querySelector("h2")?.textContent.trim() === "Hooks",
		);
		section?.scrollIntoView({ block: "center" });
	});
	await h.waitForSettled();
}

async function settleAnimations(selector) {
	await win.evaluate(async (sel) => {
		const node = document.querySelector(sel);
		if (node === null) return;
		await Promise.all([...node.getAnimations({ subtree: true })].map((animation) => animation.finished));
	}, selector);
}

/** 在 hook 编辑区的「事件」下拉里按文案选中一个事件。 */
async function pickHookEvent(text) {
	await win.evaluate(() => {
		const trigger = document.querySelector('[aria-label="Hook 事件"]');
		if (trigger === null) throw new Error("编辑区里没有事件下拉");
		trigger.click();
	});
	await waitUntil(() => win.evaluate(() => document.querySelector('[role="listbox"]') !== null), {
		timeout: 10_000,
		desc: "hook 事件下拉展开",
	});
	await win.evaluate((needle) => {
		const listbox = document.querySelector('[role="listbox"]');
		const hit = [...listbox.querySelectorAll('[role="option"]')].find((node) => (node.textContent ?? "").includes(needle));
		if (hit === undefined) throw new Error(`事件下拉里没有「${needle}」`);
		hit.click();
	}, text);
}

/** matcher 输入框的当前状态（未渲染时返回 null）。 */
const matcherState = () =>
	win.evaluate(() => {
		const node = document.querySelector('[aria-label="Hook 工具匹配"]');
		return node === null ? null : { disabled: node.disabled, value: node.value };
	});

/** 等 matcher 被禁用（事件切换是异步渲染，别点完立刻断言）。 */
async function waitMatcherDisabled() {
	return waitUntil(
		async () => {
			const state = await matcherState();
			return state !== null && state.disabled ? state : null;
		},
		{ timeout: 10_000, interval: 200, desc: "命中生命周期事件后 matcher 输入框被禁用" },
	);
}

/** 用户级列表里标题含 titleText 的那一行，点它的 actionText 按钮。 */
async function clickHookAction(titleText, actionText) {
	await win.evaluate(
		({ title, action }) => {
			const section = [...document.querySelectorAll(".settings-section")].find(
				(node) => node.querySelector("h2")?.textContent.trim() === "Hooks",
			);
			if (section === undefined) throw new Error("找不到 Hooks 分组");
			const row = [...section.querySelectorAll(".starter-item")].find((node) =>
				(node.querySelector(".starter-row-title")?.textContent ?? "").includes(title),
			);
			if (row === undefined) throw new Error(`没有标题含「${title}」的 hook 行`);
			const button = [...row.querySelectorAll(".starter-action")].find(
				(node) => !node.disabled && (node.textContent ?? "").includes(action),
			);
			if (button === undefined) throw new Error(`「${title}」行没有可点的「${action}」按钮`);
			button.click();
		},
		{ title: titleText, action: actionText },
	);
}

/** Hooks 分组里「导出 / 导入」按钮的状态（找不到返回 null）。 */
const hooksIoButton = (label) =>
	win.evaluate((text) => {
		const section = [...document.querySelectorAll(".settings-section")].find(
			(node) => node.querySelector("h2")?.textContent.trim() === "Hooks",
		);
		const button = [...(section?.querySelectorAll(".hooks-io .starter-action") ?? [])].find(
			(node) => (node.textContent ?? "").trim() === text,
		);
		return button === undefined ? null : { disabled: button.disabled };
	}, label);

/** 用真实的 file input 注入文件（常驻隐藏节点，setInputFiles 不要求可见）。 */
async function pickImportFile(path) {
	await win.locator('input[aria-label="选择 hooks 导入文件"]').setInputFiles(path);
}

/** 等导入预览弹窗出现且包含指定文案，返回弹窗全文（不等就是超时）。 */
const waitImportPreview = (needle) =>
	waitUntil(
		() =>
			win.evaluate((text) => {
				const card = document.querySelector(".hooks-import-card");
				if (card === null) return false;
				const content = card.textContent ?? "";
				return content.includes(text) ? content : null;
			}, needle),
		{ timeout: 15_000, interval: 200, desc: `导入预览弹窗出现且包含「${needle}」` },
	);

/** 预览弹窗里「导入 N 条」按钮的禁用状态（弹窗不在时返回 null）。 */
const importButtonDisabled = () =>
	win.evaluate(() => {
		const card = document.querySelector(".hooks-import-card");
		if (card === null) return null;
		const button = [...card.querySelectorAll("button")].find((node) =>
			(node.textContent ?? "").trim().startsWith("导入"),
		);
		return button === undefined ? null : button.disabled;
	});

async function closeImportPreview() {
	await win.evaluate(() => {
		const card = document.querySelector(".hooks-import-card");
		const button = [...(card?.querySelectorAll("button") ?? [])].find((node) => node.textContent.trim() === "取消");
		button?.click();
	});
	await waitUntil(() => win.evaluate(() => document.querySelector(".hooks-import-card") === null), {
		timeout: 10_000,
		desc: "导入预览弹窗关闭",
	});
}

/** 把「最近运行」滚进视口中央：截图要拍到这一块（分组很长，滚到顶端只会拍到列表）。 */
async function scrollToRecentRuns() {
	await win.evaluate(() => {
		const section = [...document.querySelectorAll(".settings-section")].find(
			(node) => node.querySelector("h2")?.textContent.trim() === "Hooks",
		);
		const heading = [...(section?.querySelectorAll("h3") ?? [])].find((node) => node.textContent.trim() === "最近运行");
		heading?.scrollIntoView({ block: "center" });
	});
	await h.waitForSettled();
}

await h.check("设置 → 通用 → Hooks：空列表有可读空态，工作区文件默认未信任", async () => {
	await openSettings();
	assert.equal(await sectionReady("Hooks", ".hooks-empty"), true, "用户级空列表要有空态文案");
	const text = await sectionText("Hooks");
	assert.ok(text.includes("未信任"), `工作区卡片应显示「未信任」：${text}`);
	assert.ok(text.includes("不会执行"), `未信任时要说明它不会执行：${text}`);
	assert.ok(text.includes("check-write.mjs"), "工作区 hooks 应以只读方式展示命令");
	await scrollToHooks();
	await h.shoot("settings-hooks-empty-light");
});

await h.check("新增一条用户级 PreToolUse hook → 列表出现一行", async () => {
	await clickInSection("Hooks", ".starter-add");
	await waitUntil(() => sectionReady("Hooks", ".starter-editor"), { timeout: 10_000, desc: "hook 编辑区展开" });
	await setInput("Hook 工具匹配", "write");
	await setInput("Hook 命令", hookCommand);
	await win.evaluate(() => {
		const button = [...document.querySelectorAll(".starter-editor-actions button")].find((node) => node.textContent.trim() === "保存 hook");
		if (button === undefined) throw new Error("编辑区里没有「保存 hook」按钮");
		button.click();
	});
	await waitUntil(
		() =>
			win.evaluate(() => {
				const section = [...document.querySelectorAll(".settings-section")].find(
					(node) => node.querySelector("h2")?.textContent.trim() === "Hooks",
				);
				if (section === undefined) return false;
				/*
				 * 只看**用户级**那张表（第一个 `ul.starter-list`）。工作区 hooks 的
				 * 只读列表排在它后面，而行标题可以是**同一串**
				 * （「工具调用前 · write · 超时 5000ms」）—— 拿整段文本去等，会被
				 * 工作区那一行**在点击保存之前**就满足，于是这条「保存成功」的等待
				 * 形同虚设（全量跑时真实踩到：后面的 check 读到的仍是保存前的空列表）。
				 *
				 * 同时要求 `.starter-add` 回来且可用：编辑器在里时它不渲染，
				 * 「回来且可用」= 保存那次刷新已经落地（否则可能读到旧列表）。
				 */
				const userList = section.querySelector("ul.starter-list");
				const addButton = section.querySelector(".starter-add");
				if (userList === null || addButton === null || addButton.disabled) return false;
				return [...userList.querySelectorAll(".starter-row-title")].some((title) =>
					title.textContent.includes("工具调用前 · write"),
				);
			}),
		{ timeout: 15_000, interval: 200, desc: "用户级 hook 行出现（且保存后的列表刷新已落地）" },
	);
});

await h.check("用户级 hook 真的落盘到 preferences.json", () => {
	const file = join(h.CONFIG_DIR, "preferences.json");
	assert.equal(existsSync(file), true, "偏好文件应已创建");
	const parsed = JSON.parse(readFileSync(file, "utf8"));
	assert.equal(Array.isArray(parsed.hooks), true, "preferences.json 里应有 hooks 数组");
	assert.equal(parsed.hooks.length, 1);
	assert.equal(parsed.hooks[0].event, "PreToolUse");
	assert.equal(parsed.hooks[0].matcher, "write");
	assert.equal(parsed.hooks[0].command, hookCommand);
	assert.equal(parsed.hooks[0].timeoutMs, 5000);
});

await h.check("试运行弹窗展示载荷、退出码与 stdout/stderr", async () => {
	/*
	 * 等「可点」而不只是「存在」：保存后的刷新若还没落地，按钮仍是 disabled，
	 * 这时点空会连锁失败（全量跑时真实发生过）。
	 * 按文字找「试运行」而不是取第一个 .starter-action —— 顺序依赖不值得赌。
	 */
	await waitUntil(
		() =>
			win.evaluate(() => {
				const section = [...document.querySelectorAll(".settings-section")].find(
					(node) => node.querySelector("h2")?.textContent.trim() === "Hooks",
				);
				if (section === undefined) return false;
				return [...section.querySelectorAll(".starter-action")].some(
					(node) => !node.disabled && (node.textContent ?? "").includes("试运行"),
				);
			}),
		{ timeout: 15_000, interval: 200, desc: "用户级 hook 行可操作（保存后的列表刷新完成）" },
	);
	await win.evaluate(() => {
		const section = [...document.querySelectorAll(".settings-section")].find(
			(node) => node.querySelector("h2")?.textContent.trim() === "Hooks",
		);
		const button = [...(section?.querySelectorAll(".starter-action") ?? [])].find(
			(node) => !node.disabled && (node.textContent ?? "").includes("试运行"),
		);
		if (button === undefined) throw new Error("找不到可点的「试运行」按钮");
		button.click();
	});
	await waitUntil(() => win.evaluate(() => document.querySelector(".hooks-test-card") !== null), {
		timeout: 10_000,
		desc: "试运行弹窗打开",
	});
	try {
		await waitUntil(
			() => win.evaluate(() => (document.querySelector(".hooks-test-card")?.textContent ?? "").includes("通过（退出码 0）")),
			{ timeout: 15_000, interval: 200, desc: "试运行返回结果（不是一直加载）" },
		);
	} catch (error) {
		const modal = await win.evaluate(() => document.querySelector(".hooks-test-card")?.textContent ?? "(no modal)");
		throw new Error(`${error.message}\n弹窗文本：${modal}`, { cause: error });
	}
	const text = await win.evaluate(() => document.querySelector(".hooks-test-card")?.textContent ?? "");
	assert.ok(text.includes("PreToolUse"), `载荷里应显示事件名：${text}`);
	assert.ok(text.includes(HOOK_STDOUT), `弹窗里应展示 stdout：${text}`);
	assert.ok(text.includes(`${HOOK_STDERR_PREFIX}:PreToolUse`), `弹窗里应展示 stderr：${text}`);
	await settleAnimations(".hooks-test-card");
	await h.shoot("settings-hooks-test-light");
	await win.evaluate(() => {
		const button = [...document.querySelectorAll(".hooks-test-card button")].find((node) => node.textContent.trim() === "关闭");
		button?.click();
	});
	await waitUntil(() => win.evaluate(() => document.querySelector(".hooks-test-card") === null), {
		timeout: 10_000,
		desc: "试运行弹窗关闭",
	});
});

await h.check("试运行留下 hook 审计（这条通道不该无痕）", async () => {
	const auditDir = join(h.CONFIG_DIR, "logs", "audit");
	const readAll = () => {
		if (!existsSync(auditDir)) return [];
		return readdirSync(auditDir)
			.filter((name) => name.endsWith(".jsonl"))
			.flatMap((name) => readFileSync(join(auditDir, name), "utf8").split("\n"))
			.filter((line) => line.trim() !== "")
			.map((line) => JSON.parse(line));
	};
	await waitUntil(
		() => {
			const hits = readAll().filter((record) => record.category === "hook" && record.detail.includes("试运行"));
			return hits.length > 0 ? hits : null;
		},
		{ timeout: 20_000, interval: 300, desc: "审计 JSONL 出现「试运行」记录" },
	);
	// detail 不写命令原文（可能含路径与参数），只写 hook id 与判定。
	const records = readAll().filter((record) => record.category === "hook" && record.detail.includes("试运行"));
	assert.ok(records.some((record) => record.outcome === "allowed"), `试运行应记 allowed：${JSON.stringify(records)}`);
	assert.ok(
		records.every((record) => !record.detail.includes(fixture)),
		`审计 detail 里出现了命令原文（应只写 hook id 与判定）：${JSON.stringify(records)}`,
	);
});

await h.check("事件下拉出现三个生命周期事件；选中后 matcher 被禁用并给出说明", async () => {
	await clickInSection("Hooks", ".starter-add");
	await waitUntil(() => sectionReady("Hooks", ".starter-editor"), { timeout: 10_000, desc: "hook 编辑区展开" });
	await win.evaluate(() => {
		const trigger = document.querySelector('[aria-label="Hook 事件"]');
		if (trigger === null) throw new Error("编辑区里没有事件下拉");
		trigger.click();
	});
	await waitUntil(() => win.evaluate(() => document.querySelector('[role="listbox"]') !== null), {
		timeout: 10_000,
		desc: "hook 事件下拉展开",
	});
	const labels = await win.evaluate(() =>
		[...document.querySelectorAll('[role="listbox"] [role="option"]')].map((node) => node.textContent ?? ""),
	);
	for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
		assert.ok(
			labels.some((text) => text.includes(event)),
			`事件下拉里应有 ${event}：${labels.join(" / ")}`,
		);
	}
	await win.evaluate(() => {
		const hit = [...document.querySelectorAll('[role="listbox"] [role="option"]')].find((node) =>
			(node.textContent ?? "").includes("SessionStart"),
		);
		if (hit === undefined) throw new Error("事件下拉里没有 SessionStart");
		hit.click();
	});
	const state = await waitMatcherDisabled();
	assert.equal(state.value, "", "生命周期事件下 matcher 不应显示工具名");
	const hints = await win.evaluate(() =>
		[...document.querySelectorAll(".hooks-lifecycle-hint")].map((node) => node.textContent ?? ""),
	);
	assert.ok(
		hints.some((text) => text.includes("该事件没有工具名")),
		`应提示「该事件没有工具名」：${hints.join(" / ")}`,
	);
	await win.evaluate(() => {
		const button = [...document.querySelectorAll(".starter-editor-actions button")].find((node) => node.textContent.trim() === "取消");
		if (button === undefined) throw new Error("编辑区里没有「取消」按钮");
		button.click();
	});
	await waitUntil(() => win.evaluate(() => document.querySelector(".starter-editor") === null), {
		timeout: 10_000,
		desc: "编辑区关闭",
	});
});

await h.check("新增一条 SessionStart hook → 列表显示「会话开始」，落盘不带 matcher", async () => {
	await clickInSection("Hooks", ".starter-add");
	await waitUntil(() => sectionReady("Hooks", ".starter-editor"), { timeout: 10_000, desc: "hook 编辑区展开" });
	await pickHookEvent("SessionStart");
	await waitMatcherDisabled();
	await setInput("Hook 命令", denyCommand);
	await win.evaluate(() => {
		const button = [...document.querySelectorAll(".starter-editor-actions button")].find((node) => node.textContent.trim() === "保存 hook");
		if (button === undefined) throw new Error("编辑区里没有「保存 hook」按钮");
		button.click();
	});
	await waitUntil(
		() =>
			win.evaluate(() => {
				const section = [...document.querySelectorAll(".settings-section")].find(
					(node) => node.querySelector("h2")?.textContent.trim() === "Hooks",
				);
				if (section === undefined) return false;
				// 与上一条 hook 的等待同一条口径：只认用户级列表，且「新增」按钮回来且可用
				// = 保存后的刷新已落地（否则读到的仍是保存前的列表）。
				const userList = section.querySelector("ul.starter-list");
				const addButton = section.querySelector(".starter-add");
				if (userList === null || addButton === null || addButton.disabled) return false;
				return [...userList.querySelectorAll(".starter-row-title")].some((title) =>
					title.textContent.includes("会话开始"),
				);
			}),
		{ timeout: 15_000, interval: 200, desc: "用户级列表出现「会话开始」行（保存后的刷新已落地）" },
	);
	const parsed = JSON.parse(readFileSync(join(h.CONFIG_DIR, "preferences.json"), "utf8"));
	const entry = parsed.hooks.find((item) => item.event === "SessionStart");
	assert.ok(entry !== undefined, `preferences.json 里应有 SessionStart hook：${JSON.stringify(parsed.hooks)}`);
	assert.equal(entry.command, denyCommand);
	assert.equal(entry.timeoutMs, 5000);
	// 生命周期事件没有工具名：写侧**不写 matcher 字段**（不是写 "*"）。
	assert.equal("matcher" in entry, false, `生命周期事件不应落盘 matcher：${JSON.stringify(entry)}`);
});

await h.check("生命周期事件试运行 → 文案是「未阻断」，且最近运行立刻出现这条记录", async () => {
	await clickHookAction("会话开始", "试运行");
	await waitUntil(() => win.evaluate(() => document.querySelector(".hooks-test-card") !== null), {
		timeout: 10_000,
		desc: "试运行弹窗打开",
	});
	try {
		await waitUntil(
			() =>
				win.evaluate(() => {
					const text = document.querySelector(".hooks-test-card")?.textContent ?? "";
					return text.includes("未阻断") ? text : false;
				}),
			{ timeout: 15_000, interval: 200, desc: "弹窗显示结果（而不是一直加载）" },
		);
	} catch (error) {
		const modal = await win.evaluate(() => document.querySelector(".hooks-test-card")?.textContent ?? "(no modal)");
		throw new Error(`${error.message}\n弹窗文本：${modal}`, { cause: error });
	}
	const modalText = await win.evaluate(() => document.querySelector(".hooks-test-card")?.textContent ?? "");
	assert.ok(
		modalText.includes("拒绝（退出码 2，未阻断）"),
		`生命周期事件的退出码 2 必须标成「未阻断」：${modalText}`,
	);
	assert.ok(
		!modalText.includes("按 fail-closed 阻止"),
		`非阻断事件不得出现 fail-closed 文案：${modalText}`,
	);
	assert.ok(modalText.includes("会话开始"), `弹窗头部应标明事件：${modalText}`);
	assert.ok(modalText.includes("SessionStart"), "载荷里应显示事件名");
	await settleAnimations(".hooks-test-card");
	await h.shoot("settings-hooks-test-lifecycle-light");
	await win.evaluate(() => {
		const button = [...document.querySelectorAll(".hooks-test-card button")].find((node) => node.textContent.trim() === "关闭");
		button?.click();
	});
	await waitUntil(() => win.evaluate(() => document.querySelector(".hooks-test-card") === null), {
		timeout: 10_000,
		desc: "试运行弹窗关闭",
	});
	/*
	 * 最近运行的单一事实源是审计：试运行写完审计后才返回结果，`runTest` 收到结果时
	 * refresh() 一次。所以这里等的是「界面上真的出现了这条记录」—— 它同时钉住
	 * 「refresh 没被漏掉」（漏掉时列表停在保存那一刻，见反向验证）。
	 */
	const rows = await waitUntil(
		() =>
			win.evaluate(() => {
				const section = [...document.querySelectorAll(".settings-section")].find(
					(node) => node.querySelector("h2")?.textContent.trim() === "Hooks",
				);
				if (section === undefined) return false;
				const items = [...section.querySelectorAll(".hooks-run")].map((node) => node.textContent ?? "");
				return items.some((text) => text.includes("试运行 拒绝")) ? items : null;
			}),
		{ timeout: 15_000, interval: 200, desc: "「最近运行」出现本次试运行的记录（runTest 后的 refresh 生效）" },
	);
	// 早前那次 PreToolUse 试运行也应留在列表里（最近运行是「最近 5 条」而不是「最后一条」）。
	assert.ok(
		rows.some((text) => text.includes("试运行 放行")),
		`最近运行应保留之前那次放行记录：${rows.join(" | ")}`,
	);
	assert.ok(
		rows.some((text) => text.includes("失败")),
		`拒绝的试运行结论应是「失败」（非阻断事件只有 allowed / failed）：${rows.join(" | ")}`,
	);
	await scrollToRecentRuns();
	await h.shoot("settings-hooks-recent-runs-light");
});

await h.check("信任工作区 hooks → 状态变为已信任并落盘", async () => {
	await win.evaluate(() => {
		const input = document.querySelector('[aria-label="信任此工作区的 hooks"]');
		if (input === null) throw new Error("工作区卡片上没有信任开关");
		input.click();
	});
	await waitUntil(
		() => win.evaluate(() => {
			const section = [...document.querySelectorAll(".settings-section")].find(
				(node) => node.querySelector("h2")?.textContent.trim() === "Hooks",
			);
			return (section?.textContent ?? "").includes("已信任");
		}),
		{ timeout: 15_000, desc: "工作区状态变为「已信任」" },
	);
	const parsed = JSON.parse(readFileSync(join(h.CONFIG_DIR, "preferences.json"), "utf8"));
	assert.equal(Array.isArray(parsed.trustedWorkspaceHooks), true, "偏好文件里应有 trustedWorkspaceHooks");
	/*
	 * 记的是**真实路径**（hooks.js 的 normalizeWorkspacePath 会展开符号链接）：
	 * macOS 上 `tmpdir()` 在 `/var/folders/...`，而 `/var` 本身是 `/private/var`
	 * 的链接。不按 realpath 比，这条断言会红在「看起来完全一样」的两条路径上。
	 */
	const realWorkspace = realpathSync(h.WORKSPACE_DIR);
	assert.ok(
		parsed.trustedWorkspaceHooks.some((entry) => entry.toLowerCase() === realWorkspace.toLowerCase()),
		`信任名单里应有工作区真实路径 ${realWorkspace}：${JSON.stringify(parsed.trustedWorkspaceHooks)}`,
	);
	await scrollToHooks();
	await h.shoot("settings-hooks-trusted-light");
});

await h.check("导出 hooks：形状与配置文件同构，且不含工作区信任列表", async () => {
	/*
	 * 覆写 createObjectURL 捕获 Blob；同时拦掉 anchor.click —— Electron 在没有
	 * will-download 处理器时会弹系统保存对话框，测试会卡在那一步。捕获到 Blob
	 * 与 download 名，就足以断言「导出了什么」。
	 */
	await win.evaluate(() => {
		window.__zwExport = {};
		const originalCreate = URL.createObjectURL.bind(URL);
		URL.createObjectURL = (blob) => {
			window.__zwExport.blob = blob;
			return originalCreate(blob);
		};
		const originalClick = window.HTMLAnchorElement.prototype.click;
		window.__zwRestoreAnchorClick = () => {
			window.HTMLAnchorElement.prototype.click = originalClick;
		};
		window.HTMLAnchorElement.prototype.click = function () {
			window.__zwExport.download = this.download;
			window.__zwExport.href = this.href;
		};
	});
	try {
		const button = await hooksIoButton("导出");
		assert.notEqual(button, null, "Hooks 分组里应有「导出」按钮");
		assert.equal(button.disabled, false, "「导出」按钮应可用");
		await clickInSection("Hooks", ".hooks-io .starter-action");
		await waitUntil(() => win.evaluate(() => window.__zwExport.blob !== void 0), {
			timeout: 10_000,
			desc: "点「导出」后捕获到 Blob",
		});
	} finally {
		// 无论断言是否失败都还原原型：锚点在别处也用。
		await win.evaluate(() => window.__zwRestoreAnchorClick?.());
	}
	const exported = await win.evaluate(async () => ({
		download: window.__zwExport.download,
		text: await window.__zwExport.blob.text(),
	}));
	assert.equal(exported.download, "zerowork-hooks.json", "导出文件名");
	const parsed = JSON.parse(exported.text);
	assert.equal(parsed.version, 1, `导出文件应带 version：${exported.text}`);
	assert.equal(Array.isArray(parsed.hooks), true, "导出文件里应是 hooks 数组");
	assert.equal(parsed.hooks.length, 2, `导出应含当前 2 条用户级 hook：${exported.text}`);
	// 信任列表是本机绝对路径：带出去既不安全也无意义。
	assert.equal("trustedWorkspaceHooks" in parsed, false, `导出不得包含本机信任列表：${exported.text}`);
	for (const hook of parsed.hooks) {
		assert.equal(typeof hook.id, "string", `每条 hook 应带 id：${JSON.stringify(hook)}`);
		assert.equal(typeof hook.event, "string", `每条 hook 应带 event：${JSON.stringify(hook)}`);
		assert.equal(typeof hook.command, "string", `每条 hook 应带 command：${JSON.stringify(hook)}`);
		assert.equal(typeof hook.timeoutMs, "number", `每条 hook 应带 timeoutMs：${JSON.stringify(hook)}`);
	}
	exportedHooks = parsed.hooks;
	writeFileSync(exportedPath, exported.text, "utf8");
});

await h.check("清空用户级列表后导入导出文件 → 预览 → 确认 → 条目恢复", async () => {
	// 清空走 daemon 通道（等价于逐条删完，但不依赖删除按钮的顺序）。
	await win.evaluate(() => window.kami.setHooksUser([]));
	// HooksSection 只在挂载时读一次配置：关掉再打开，拿到的才是清空后的真实状态。
	await win.evaluate(() => document.querySelector('[aria-label="关闭设置"]')?.click());
	await waitUntil(() => win.evaluate(() => document.querySelector('[aria-label="关闭设置"]') === null), {
		timeout: 10_000,
		desc: "设置对话框关闭",
	});
	await openSettings();
	assert.equal(await sectionReady("Hooks", ".hooks-empty"), true, "清空后应显示空态");

	await pickImportFile(exportedPath);
	const text = await waitImportPreview(`导入预览 · ${exportedHooks.length} 条`);
	assert.ok(text.includes("工具调用前"), `预览应逐条显示事件：${text}`);
	assert.ok(text.includes("会话开始"), `预览应逐条显示事件：${text}`);
	assert.ok(text.includes(exportedHooks[0].id), `预览应显示 hook id：${text}`);
	assert.equal(await importButtonDisabled(), false, "合法文件下「导入」按钮应可用");
	await settleAnimations(".hooks-import-card");
	await h.shoot("settings-hooks-import-preview-light");

	await win.evaluate(() => {
		const card = document.querySelector(".hooks-import-card");
		const button = [...(card?.querySelectorAll("button") ?? [])].find((node) =>
			(node.textContent ?? "").trim().startsWith("导入"),
		);
		if (button === undefined) throw new Error("预览弹窗里没有「导入」按钮");
		button.click();
	});
	await waitUntil(() => win.evaluate(() => document.querySelector(".hooks-import-card") === null), {
		timeout: 15_000,
		desc: "导入完成后预览弹窗关闭",
	});
	await waitUntil(
		() =>
			win.evaluate(() => {
				const section = [...document.querySelectorAll(".settings-section")].find(
					(node) => node.querySelector("h2")?.textContent.trim() === "Hooks",
				);
				const userList = section?.querySelector("ul.starter-list");
				if (userList === null || userList === undefined) return false;
				return userList.querySelectorAll(".starter-item").length === 2;
			}),
		{ timeout: 15_000, interval: 200, desc: "导入后用户级列表恢复 2 条（refresh 生效）" },
	);
	const saved = JSON.parse(readFileSync(join(h.CONFIG_DIR, "preferences.json"), "utf8"));
	assert.deepEqual(saved.hooks, exportedHooks, "导入后落盘的 hooks 应与导出前逐字段一致");
});

await h.check("非法条目在预览里标出第几条与原因，并禁用导入", async () => {
	writeFileSync(
		invalidPath,
		JSON.stringify(
			{
				version: 1,
				hooks: [
					{ id: "bad-1", event: "Nope", command: "echo 1" },
					{ id: "ok-1", event: "PreToolUse", command: "echo 2" },
				],
			},
			null,
			2,
		),
		"utf8",
	);
	await pickImportFile(invalidPath);
	const text = await waitImportPreview("第 1 条：");
	assert.ok(text.includes("导入预览 · 1 条"), `预览只应计入合法条目：${text}`);
	assert.ok(text.includes("有 1 条非法条目"), `应说明非法条目数：${text}`);
	assert.equal(await importButtonDisabled(), true, "有非法条目时「导入」按钮必须禁用");
	try {
		await h.shoot("settings-hooks-import-error-light");
	} finally {
		await closeImportPreview();
	}
	// 取消不写盘：列表与文件都保持导入前的两条。
	const saved = JSON.parse(readFileSync(join(h.CONFIG_DIR, "preferences.json"), "utf8"));
	assert.equal(saved.hooks.length, 2, `取消导入不应写盘：${JSON.stringify(saved.hooks)}`);
});

await h.check("暗色下 hooks 分组与试运行卡片可读", async () => {
	const pickDark = async () => {
		await win.evaluate(() => document.querySelector('[aria-label="外观"]').click());
		await waitUntil(() => win.evaluate(() => document.querySelector('[role="listbox"]') !== null), {
			timeout: 10_000,
			desc: "外观下拉展开",
		});
		await win.evaluate(() => {
			const listbox = document.querySelector('[role="listbox"]');
			const hit = [...listbox.querySelectorAll('[role="option"]')].find((node) => (node.textContent ?? "").includes("深色"));
			if (hit === undefined) throw new Error("外观下拉里没有「深色」");
			hit.click();
		});
		await waitUntil(() => win.evaluate(() => document.documentElement.getAttribute("data-theme") === "dark"), {
			timeout: 15_000,
			desc: "切到暗色",
		});
	};
	await pickDark();
	await scrollToHooks();
	await h.shoot("settings-hooks-dark");
	// 「最近运行」在分组底部：滚到那里再拍一张，确认它不靠浅色背景才可读。
	await scrollToRecentRuns();
	await h.shoot("settings-hooks-recent-runs-dark");
});

await h.check("暗色下导入预览可读", async () => {
	await pickImportFile(exportedPath);
	await waitImportPreview(`导入预览 · ${exportedHooks.length} 条`);
	await settleAnimations(".hooks-import-card");
	await h.shoot("settings-hooks-import-preview-dark");
	await closeImportPreview();
});

await h.finish();
