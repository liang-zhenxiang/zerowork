/**
 * 更新器（双渠道）的 GUI 测试（spec: update-channels）。
 *
 * 不碰真实 GitHub：本地起一个 generic feed 服务，经 ZEROWORK_UPDATE_FEED
 * 注入主进程。两份 yml 用**不同的假版本号**（stable=99.0.0 / beta=98.0.0），
 * 「当前生效的是哪个渠道」就能从 UI 显示的版本号反推——不需要读内部状态。
 *
 * ⚠️ 这个 mock **只认真实的清单文件名**（stable → latest*.yml，
 * beta → beta*.yml），其它名字一律 404。2026-10-26 之前它对任意 *.yml 都
 * 返回同一份内容，于是 #282（稳定渠道去拉 stable.yml、线上只有 latest.yml）
 * 全程绿灯漏了过去。严格命名是这条用例的核心价值，不要改回宽容匹配。
 *
 * 断言：
 *   ① 设置 → 通用 → 更新区渲染（版本徽章 / 渠道选择器 / 立即检查）；
 *   ② 立即检查 → 请求 latest*.yml 且状态走到「有新版本」
 *      （mac 在此停步：未签名不自动下载，恰好把「检查+通知」这条链验完）；
 *   ③ 切到 Beta 渠道 → 请求 beta*.yml，UI 版本号变成 beta 那份；
 *   ④ 渠道持久化：重开设置、再写一次无关偏好后仍是 Beta（issue #283）；
 *   ⑤ 切回稳定 → 再次请求 latest*.yml（渠道切换真的换了 feed 文件）。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createHarness, waitUntil } from "./lib/harness.mjs";

// ── mock feed：两份 channel yml + 占位产物（available 阶段不下载产物本体） ──
const fakeBody = "placeholder-installer";
const sha512 = createHash("sha512").update(fakeBody).digest("base64");
const ymlFor = (version) =>
	[
		`version: ${version}`,
		"files:",
		`  - url: ZeroWork-${version}.dmg`,
		`    sha512: ${sha512}`,
		"    size: 21",
		`path: ZeroWork-${version}.dmg`,
		`sha512: ${sha512}`,
		"releaseDate: '2026-10-02T00:00:00.000Z'",
		"",
	].join("\n");
const STABLE_VERSION = "99.0.0";
const BETA_VERSION = "98.0.0";

// electron-updater 的清单文件名：channel 名 + 平台后缀。
// stable 渠道在 UI 上叫 stable，但 electron-updater 必须用 latest
// （electron-builder 的默认产物名）；beta 才是真的 beta.yml。
const PLATFORM_SUFFIX =
	process.platform === "darwin"
		? "-mac"
		: process.platform === "linux"
			? process.arch === "x64"
				? "-linux"
				: `-linux-${process.arch}`
			: "";
const STABLE_CHANNEL_FILE = `/latest${PLATFORM_SUFFIX}.yml`;
const BETA_CHANNEL_FILE = `/beta${PLATFORM_SUFFIX}.yml`;

const feedHits = [];
const feedServer = await new Promise((resolve) => {
	const server = createServer((req, res) => {
		const path = req.url.split("?")[0];
		feedHits.push(path);
		let body;
		if (path === STABLE_CHANNEL_FILE) body = ymlFor(STABLE_VERSION);
		else if (path === BETA_CHANNEL_FILE) body = ymlFor(BETA_VERSION);
		else if (path === `/ZeroWork-${STABLE_VERSION}.dmg` || path === `/ZeroWork-${BETA_VERSION}.dmg`) body = fakeBody;
		if (body === undefined) {
			res.writeHead(404);
			res.end();
			return;
		}
		res.writeHead(200, { "content-type": path.endsWith(".yml") ? "text/yaml" : "application/octet-stream" });
		res.end(body);
	});
	server.listen(0, "127.0.0.1", () => resolve(server));
});
const feedUrl = `http://127.0.0.1:${feedServer.address().port}/`;
console.log(`✓ mock 更新 feed 已就绪：${feedUrl}`);
// dev 态的 electron-updater 读项目根的 dev-app-update.yml（见 updates.js 注释）；
// e2e 的 cwd 是项目根。测完在 finish 后删除。
const DEV_FEED_CONFIG = join(process.cwd(), "dev-app-update.yml");
writeFileSync(DEV_FEED_CONFIG, `provider: generic\nurl: ${feedUrl}\n`);

const h = createHarness({ name: "updates", env: { ZEROWORK_UPDATE_FEED: feedUrl } });
mkdirSync(h.WORKSPACE_DIR, { recursive: true });

await h.launch();
const win = h.window();

/** 打开设置 → 通用（更新区在通用分组里）。 */
async function openSettingsGeneral() {
	await win.evaluate(() => {
		const btn = document.querySelector('[aria-label="设置"]');
		if (btn === null) throw new Error('找不到设置按钮 [aria-label="设置"]');
		btn.click();
	});
	await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") !== null), {
		timeout: 15_000,
		desc: "设置对话框挂载",
	});
}

/** 更新区的当前状态行文字。 */
const phaseText = () =>
	win.evaluate(() => document.querySelector(".update-phase")?.textContent ?? null);
const phaseKind = () =>
	win.evaluate(() => document.querySelector(".update-phase")?.dataset.phase ?? null);

// ── ① 更新区渲染 ─────────────────────────────────────────────
await h.check("设置 → 通用有更新区（徽章/渠道/按钮）", async () => {
	await openSettingsGeneral();
	// SelectField 的出现依赖 getUpdateChannel 的 IPC 回包 + 渲染，CI 慢机上要等。
	//
	// 【2026-10-03 修】此前这里写的是「15s 不够 → 放宽到 40s」，但**超时值从来
	// 没参与过判定**：谓词返回的是一个**对象字面量**，而 waitUntil 的判定是
	// `if (value) return value`（harness.mjs）—— 对象恒真，于是它在第一次求值就
	// 返回，40s 一格没用上，紧随其后的断言跑在尚未渲染完的 DOM 上。
	// 症状是间歇性红（PR #112 的 CI：feed 就绪到 FAIL 相隔 4.5 秒），
	// 而「加超时」治不了它 —— 那是给一个没生效的参数加倍。
	//
	// 正解是让**谓词真的能返回假值**：就绪才交出对象，否则返回 null。
	// 谓词必须能返回假值，否则超时形同虚设 —— 这条已沉淀进 .trellis/spec/testing/。
	const found = await waitUntil(
		async () => {
			const state = await win.evaluate(() => ({
				badge: document.querySelector(".settings-section-badge")?.textContent ?? null,
				channel: document.querySelector('[aria-label="更新渠道"]') !== null,
				checkBtn: [...document.querySelectorAll("button")].some((b) => b.textContent === "立即检查"),
			}));
			// 三项都到齐才算「更新区渲染完成」：徽章与选择器来自同一次 IPC 回包，
			// 按钮是同一段 JSX 里的静态子节点 —— 以**最晚到达的那个**为准，
			// 才不会出现「选择器到了、按钮还没到」这种半成品状态被当成就绪。
			return state.channel && state.checkBtn ? state : null;
		},
		{ timeout: 40_000, interval: 400, desc: "更新区渲染" },
	);
	assert.match(String(found.badge), /^V\d+\.\d+\.\d+/, `版本徽章形态不对：${found.badge}`);
	assert.ok(found.channel, "渠道选择器不在");
	assert.ok(found.checkBtn, "「立即检查」按钮不在");
});
await h.snap("updates-section");

await h.check("版本号走运行时真值：桥暴露 appVersion，且侧栏品牌行与之一致", async () => {
	// 为什么测这个：构建期注入的 __APP_VERSION__ 在 **beta 包**里恒为仓库版本号
	// （extraMetadata 的版本覆盖发生在打包层、注入发生在更早的 vite build），
	// 于是侧栏会显示错误版本——用户 2026-10-02 正是被这个坑到。修法是运行时取值。
	//
	// 诚实说明测试的边界：e2e 跑的是未打包的 out/，此时 getVersion() 与
	// __APP_VERSION__ 恰好都是仓库版本号，**两者无法在这一层区分**。所以这里
	// 锁的是「桥存在 + 侧栏用桥的值」这条接线；「值本身对不对」由真机（打包态）
	// 验证覆盖，见 PR 描述里的截图。
	const r = await win.evaluate(() => ({
		bridge: globalThis.kami.appVersion ?? null,
		brand: document.querySelector(".brand-version")?.textContent ?? null,
	}));
	assert.match(String(r.bridge), /^\d+\.\d+\.\d+/, `桥暴露的 appVersion 形态不对：${r.bridge}`);
	assert.equal(r.brand, `V${r.bridge}`, `侧栏品牌行 ${r.brand} 与运行时版本 ${r.bridge} 不一致——它又回落到构建期注入了？`);
});

// ── ② 立即检查 → 有新版本（稳定渠道）────────────────────────
await h.check("立即检查发现新版本（stable yml 的 99.0.0）", async () => {
	await win.evaluate(() => {
		const btn = [...document.querySelectorAll("button")].find((b) => b.textContent === "立即检查");
		if (btn === undefined) throw new Error("找不到「立即检查」");
		btn.click();
	});
	await waitUntil(async () => (await phaseKind()) === "available", {
		timeout: 30_000,
		interval: 500,
		desc: "状态走到 available",
	});
	const text = await phaseText();
	assert.ok(String(text).includes("99.0.0") || String(text).includes("新版本"), `状态行没体现新版本：${text}`);
	assert.ok(
		feedHits.includes(STABLE_CHANNEL_FILE),
		`feed 没收到稳定渠道请求 ${STABLE_CHANNEL_FILE}（命中：${feedHits.join(",")}）`,
	);
});

// ── ③ 切 Beta 渠道 ───────────────────────────────────────────
await h.check("切到 Beta 后改吃 beta.yml（98.0.0）", async () => {
	await win.evaluate(() => {
		const trigger = document.querySelector('[aria-label="更新渠道"]');
		if (trigger === null) throw new Error("找不到渠道选择器");
		trigger.click();
	});
	await waitUntil(() => win.evaluate(() => document.querySelector('[role="listbox"]') !== null), {
		timeout: 10_000,
		desc: "渠道下拉展开",
	});
	await win.evaluate(() => {
		const listbox = document.querySelector('[role="listbox"]');
		const hit = [...listbox.querySelectorAll('[role="option"]')].find((el) => (el.textContent ?? "").includes("Beta"));
		if (hit === undefined) throw new Error("下拉里没有 Beta 项");
		hit.click();
	});
	// 切渠道会立即触发一次检查 → beta.yml 被拉 → available 且版本是 beta 那份
	await waitUntil(() => feedHits.includes(BETA_CHANNEL_FILE), {
		timeout: 30_000,
		interval: 500,
		desc: `feed 收到 beta 渠道请求 ${BETA_CHANNEL_FILE}`,
	});
	await waitUntil(async () => (await phaseKind()) === "available", {
		timeout: 30_000,
		interval: 500,
		desc: "beta 渠道回到 available",
	});
	await h.snap("updates-beta");
});

// ── ④ 渠道持久化（issue #283）────────────────────────────────
await h.check("重开设置、再写一次无关偏好后仍是 Beta", async () => {
	// 关闭设置再重新打开：选择器的值来自 getUpdateChannel（daemon 读
	// preferences.json）。旧实现的白名单漏了 updateChannel，这里会显示回稳定版。
	await win.evaluate(() => {
		const close = document.querySelector('[aria-label="关闭设置"]');
		if (close === null) throw new Error("找不到关闭设置按钮");
		close.click();
	});
	await waitUntil(() => win.evaluate(() => document.querySelector(".settings-card") === null), {
		timeout: 10_000,
		desc: "设置对话框关闭",
	});
	await openSettingsGeneral();
	const channelText = await waitUntil(
		() => win.evaluate(() => document.querySelector('[aria-label="更新渠道"]')?.textContent ?? null),
		{ timeout: 20_000, interval: 300, desc: "更新渠道选择器渲染" },
	);
	assert.ok(String(channelText).includes("Beta"), `重开设置后渠道回退成了：${channelText}`);

	// 再写一次无关偏好（主题）：writePreferences 是整份覆写，旧实现会把
	// updateChannel 顺手抹掉。写完后直接走 daemon 读一次，必须仍是 beta。
	await win.evaluate(() => window.kami.setThemePreference("dark"));
	const after = await win.evaluate(() => window.kami.getUpdateChannel());
	assert.equal(after.channel, "beta", "写主题把更新渠道抹掉了");
	await win.evaluate(() => window.kami.setThemePreference("system"));
});

// ── ⑤ 切回稳定 ───────────────────────────────────────────────
await h.check("切回稳定版回到 latest.yml", async () => {
	const stableHitsBefore = feedHits.filter((u) => u === STABLE_CHANNEL_FILE).length;
	await win.evaluate(() => {
		const trigger = document.querySelector('[aria-label="更新渠道"]');
		trigger.click();
	});
	await waitUntil(() => win.evaluate(() => document.querySelector('[role="listbox"]') !== null), {
		timeout: 10_000,
		desc: "下拉展开",
	});
	await win.evaluate(() => {
		const listbox = document.querySelector('[role="listbox"]');
		const hit = [...listbox.querySelectorAll('[role="option"]')].find((el) => (el.textContent ?? "").includes("稳定"));
		hit.click();
	});
	await waitUntil(
		() => feedHits.filter((u) => u === STABLE_CHANNEL_FILE).length > stableHitsBefore,
		{ timeout: 30_000, interval: 500, desc: `${STABLE_CHANNEL_FILE} 被再次请求` },
	);
});

// ── ⑥ macOS：应用内下载安装包 ────────────────────────────────
// 只在本机 macOS 跑：Windows 的路径是「自动下载 + 重启并安装」，由
// autoUpdater 自己处理，不需要这个用例；CI 的单元测试作业是 ubuntu，
// GUI 测试在 macOS 上手工跑。
if (process.platform === "darwin") {
	await h.check("macOS：下载更新 → 安装包落到临时目录并出现「打开安装包」", async () => {
		// 上一步切回稳定只等到「feed 收到请求」，状态可能还在 checking；
		// 必须等按钮真的渲染出来再点，而不是查一次就断言不存在。
		await waitUntil(
			() =>
				win.evaluate(() =>
					[...document.querySelectorAll("button")].some((b) => b.textContent === "下载更新"),
				),
			{ timeout: 30_000, interval: 300, desc: "「下载更新」按钮出现" },
		);
		await win.evaluate(() => {
			const btn = [...document.querySelectorAll("button")].find((b) => b.textContent === "下载更新");
			if (btn === undefined) throw new Error("找不到「下载更新」按钮");
			btn.click();
		});
		await waitUntil(async () => (await phaseKind()) === "downloaded", {
			timeout: 30_000,
			interval: 300,
			desc: "下载完成（downloaded）",
		});
		const target = join(tmpdir(), "zerowork-updates", `ZeroWork-${STABLE_VERSION}.dmg`);
		assert.ok(existsSync(target), `安装包没落到 ${target}`);
		assert.equal(readFileSync(target, "utf8"), fakeBody, "安装包内容与 feed 不一致");
		// 只断言按钮出现，**不点击**：点击会真的调用 shell.openPath，
		// 在开发机上弹出 Finder / 挂载窗口。打开动作由真机手工验证。
		const hasOpen = await win.evaluate(() =>
			[...document.querySelectorAll("button")].some((b) => b.textContent === "打开安装包"),
		);
		assert.ok(hasOpen, "下载完成后没有「打开安装包」按钮");
		const text = await phaseText();
		assert.ok(String(text).includes("已下载"), `状态行没体现已下载：${text}`);
	});
	await h.snap("updates-mac-downloaded");
}

await h.finish();
feedServer.close();
rmSync(DEV_FEED_CONFIG, { force: true });
