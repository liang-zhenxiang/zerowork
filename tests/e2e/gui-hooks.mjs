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
});

await h.finish();
