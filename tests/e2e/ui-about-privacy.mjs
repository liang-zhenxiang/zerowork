/**
 * 「关于」里的 GitHub 入口 + 首页「继续推进」可清除。
 *
 * 两件事各锁一条闭环：
 *
 *  ① 关于：设置页的链接必须指向仓库地址，并且**真的可点**；菜单里那条走主进程
 *     shell.openExternal，渲染层测不到，所以退一步读源码做静态断言 —— 它锁的是
 *     「菜单项与设置页共用同一个常量」，不是「点了一定会打开浏览器」（那由
 *     will-navigate / setWindowOpenHandler 统一保证，见 gui-theme 里那条外链断言）。
 *
 *  ② 隐私：首页把最近三个会话的标题与交接摘要摊在首屏，投屏 / 录屏 / 换人用同一台
 *     机器时是暴露面。清除后必须**当场消失**、**重开还在**、**有新任务时回来**——
 *     三件事缺一件这个功能就是假的：只消失不持久是刷新就复原，永久关闭则是把人
 *     以后再也找不到续摊入口。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

const REPO_URL = "https://github.com/liang-zhenxiang/zerowork";
const REPO_LABEL = "打开 GitHub 仓库";

function startMockModel() {
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			let firstText;
			try {
				const parsed = JSON.parse(body);
				const firstUser = (parsed?.messages ?? []).find((m) => m.role === "user")?.content ?? "";
				firstText = typeof firstUser === "string"
					? firstUser
					: Array.isArray(firstUser)
						? firstUser.map((p) => (typeof p?.text === "string" ? p.text : "")).join("")
						: "";
			} catch {
				firstText = "";
			}
			const reply = `收到：${firstText.slice(0, 24)}`;
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\n`);
			res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	return new Promise((done) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			done({ baseUrl: `http://127.0.0.1:${port}/v1`, close: () => server.close() });
		});
	});
}

const root = resolve(import.meta.dirname, "../..");
const WORKSPACE_DIR = resolve(process.env.ZEROWORK_E2E_DIR ?? "/tmp", "e2e-ui-about-privacy");
mkdirSync(WORKSPACE_DIR, { recursive: true });
writeFileSync(resolve(WORKSPACE_DIR, "README.md"), "# ui about / privacy\n", "utf8");

const h = createHarness({ name: "ui-about-privacy", shots: true });
const mock = await startMockModel();
await h.launch();
const win = h.window();

await h.check("菜单「关于」里有打开 GitHub 仓库的条目，且与设置页共用同一地址", async () => {
	const main = readFileSync(resolve(root, "src/main/index.js"), "utf8");
	assert.ok(main.includes(`const REPO_URL = "${REPO_URL}"`), "主进程应把仓库地址收敛成一个常量");
	assert.ok(main.includes("REPO_LABEL"), "关于子菜单的条目应复用常量而非另写一遍字面量");
	assert.ok(
		/if \(id === "about"\)[\s\S]{0,400}REPO_LABEL/.test(main),
		"「关于」子菜单里应挂上这条菜单项"
	);
	assert.ok(/setAboutPanelOptions\(\{[\s\S]{0,200}website: REPO_URL/.test(main), "系统关于面板也应带上同一个地址");
});

await h.check("设置 → 关于 里有可点的 GitHub 链接", async () => {
	await win.evaluate(() => document.querySelector('[aria-label="设置"]').click());
	await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") !== null), { timeout: 30_000, desc: "设置对话框打开" });
	await win.evaluate(() => {
		const item = [...document.querySelectorAll(".settings-nav-item")].find((node) => node.textContent.trim() === "关于");
		item.click();
	});
	const link = await waitUntil(
		() => win.evaluate((label) => {
			const node = [...document.querySelectorAll(".settings-card a")].find((a) => a.textContent.trim() === label);
			if (node === null) return null;
			return { href: node.getAttribute("href"), target: node.getAttribute("target"), text: node.textContent.trim() };
		}, REPO_LABEL),
		{ timeout: 20_000, desc: "关于分组里的 GitHub 链接" }
	);
	assert.equal(link.href, REPO_URL, "链接必须指向仓库地址");
	assert.equal(link.target, "_blank", "必须走新窗口通道，否则会被 will-navigate 拦下后弹在自己的窗口里");
	await h.shoot("settings-about-github");
});

await h.check("点它不会把应用自己导航走", async () => {
	const before = await win.evaluate(() => window.location.href + document.body.childElementCount);
	await win.evaluate((label) => {
		const node = [...document.querySelectorAll(".settings-card a")].find((a) => a.textContent.trim() === label);
		node.click();
	}, REPO_LABEL);
	await new Promise((r) => setTimeout(r, 600));
	const after = await win.evaluate(() => window.location.href + document.body.childElementCount);
	assert.equal(after, before, "点外链不得把应用页面替换掉");
});

await h.check("关掉设置，回到首页准备一个会话", async () => {
	await win.evaluate(() => document.querySelector('[aria-label="关闭设置"]').click());
	await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") === null), { timeout: 15_000, desc: "设置对话框关闭" });
	await win.evaluate(() => globalThis.kami.newTask());
	await win.evaluate(async ({ baseUrl, ws }) => {
		const k = globalThis.kami;
		await k.saveCustomProvider(
			{
				id: "mock-privacy",
				name: "Mock Privacy",
				baseUrl,
				api: "openai-completions",
				authHeader: true,
				models: [{ id: "privacy-model", name: "privacy-model", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 8192 }]
			},
			"mock-key"
		);
		await k.setModel("mock-privacy/privacy-model");
		await k.setWorkspace(ws);
	}, { baseUrl: mock.baseUrl, ws: WORKSPACE_DIR });
	const box = win.locator('[aria-label="消息输入框"]');
	await box.waitFor({ state: "visible", timeout: 30_000 });
	await box.fill("这是一条会出现在继续推进卡上的测试消息");
	await box.press("Enter");
	await waitUntil(
		() => win.evaluate(() => document.querySelector('[aria-label="返回首页"]') !== null),
		{ timeout: 40_000, desc: "进入会话视图" }
	);
	await win.evaluate(() => document.querySelector('[aria-label="返回首页"]').click());
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".home-resume-card") !== null),
		{ timeout: 30_000, desc: "首页出现续摊卡" }
	);
	await h.shoot("home-resume-before-clear");
});

await h.check("点「清除」后续摊区当场消失", async () => {
	const hasClear = await win.evaluate(() => document.querySelector(".home-resume-clear") !== null);
	assert.ok(hasClear, "区头应有清除按钮");
	await win.evaluate(() => document.querySelector(".home-resume-clear").click());
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".home-resume") === null),
		{ timeout: 10_000, desc: "续摊区消失" }
	);
	const stored = await win.evaluate(() => window.localStorage.getItem("zerowork.homeResumeClearedAt"));
	assert.ok(Number(stored) > 0, "清除时刻必须落盘，否则刷新就复原");
});

await h.check("重开页面后仍然不出现（不是「只消失一下」）", async () => {
	await win.reload();
	await waitUntil(() => win.evaluate(() => document.querySelector(".home") !== null), { timeout: 30_000, desc: "首页重新挂上" });
	await new Promise((r) => setTimeout(r, 1500));
	const present = await win.evaluate(() => document.querySelector(".home-resume") !== null);
	assert.equal(present, false, "清除状态应在重载后依然生效");
});

await h.check("新开一个会话后重新出现在首页（不是永久关闭）", async () => {
	await win.evaluate(() => globalThis.kami.newTask());
	const box = win.locator('[aria-label="消息输入框"]');
	await box.waitFor({ state: "visible", timeout: 30_000 });
	await box.fill("清除之后的新任务");
	await box.press("Enter");
	await waitUntil(
		() => win.evaluate(() => document.querySelector('[aria-label="返回首页"]') !== null),
		{ timeout: 40_000, desc: "进入会话视图" }
	);
	await win.evaluate(() => document.querySelector('[aria-label="返回首页"]').click());
	await waitUntil(
		() => win.evaluate(() => document.querySelector(".home-resume-card") !== null),
		{ timeout: 30_000, desc: "新会话让续摊卡回来" }
	);
	await h.shoot("home-resume-after-new-task");
});

mock.close();
await h.finish();
