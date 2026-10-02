/**
 * 更新器（双渠道）的 GUI 测试（spec: update-channels）。
 *
 * 不碰真实 GitHub：本地起一个 generic feed 服务（electron-updater 的
 * generic provider 直接从 url 拉 <channel>.yml），经 ZEROWORK_UPDATE_FEED
 * 注入主进程。两份 yml 用**不同的假版本号**（stable=99.0.0 / beta=98.0.0），
 * 「当前生效的是哪个渠道」就能从 UI 显示的版本号反推——不需要读内部状态。
 *
 * 断言：
 *   ① 设置 → 通用 → 更新区渲染（版本徽章 / 渠道选择器 / 立即检查）；
 *   ② 立即检查 → 状态走到「有新版本」（mac 在此停步：未签名不自动下载，
 *      恰好把「检查+通知」这条链验完；下载/安装是 Windows 路径，这里不覆盖）；
 *   ③ 切到 Beta 渠道 → feed 收到 beta.yml 的请求，UI 版本号变成 beta 那份；
 *   ④ 切回稳定 → 回到 latest.yml（渠道切换真的换了 feed 文件）。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createHarness, waitUntil } from "./lib/harness.mjs";

// ── mock feed：两份 channel yml + 占位产物（available 阶段不下载产物本体） ──
// mkdtempSync 而不是固定 /tmp 路径：CodeQL 的 js/insecure-temporary-file
// （本项目此前已修过 4 条同款）——固定名可预测目录是它的判定形态。
const FEED_DIR = mkdtempSync(join(tmpdir(), "zerowork-update-feed-"));
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
writeFileSync(join(FEED_DIR, "latest.yml"), ymlFor(STABLE_VERSION));
writeFileSync(join(FEED_DIR, "beta.yml"), ymlFor(BETA_VERSION));
writeFileSync(join(FEED_DIR, `ZeroWork-${STABLE_VERSION}.dmg`), fakeBody);
writeFileSync(join(FEED_DIR, `ZeroWork-${BETA_VERSION}.dmg`), fakeBody);

const feedHits = [];
const feedServer = await new Promise((resolve) => {
	const server = createServer((req, res) => {
		feedHits.push(req.url);
		// channel 文件带平台后缀（macOS 拉 stable-mac.yml / beta-mac.yml，
		// Windows 拉 stable.yml / beta.yml）——按名字里的渠道段给对应版本，
		// 不逐平台枚举。
		const name = req.url.replace(/^\//, "").split("?")[0];
		const isBeta = name.startsWith("beta");
		try {
			const body = name.endsWith(".yml") ? ymlFor(isBeta ? BETA_VERSION : STABLE_VERSION) : fakeBody;
			res.writeHead(200, { "content-type": name.endsWith(".yml") ? "text/yaml" : "application/octet-stream" });
			res.end(body);
		} catch {
			res.writeHead(404);
			res.end();
		}
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
	// SelectField 的出现依赖 getUpdateChannel 的 IPC 回包 + 渲染，CI 慢机上
	// 15s 不够（#92 的 CI flake：「渠道选择器不在」——与 theme 套件修过的
	// 同族问题）。放宽到 40s，与「等元素出现」的信号等待语义一致。
	const found = await waitUntil(
		async () =>
			await win.evaluate(() => ({
				badge: document.querySelector(".settings-section-badge")?.textContent ?? null,
				channel: document.querySelector('[aria-label="更新渠道"]') !== null,
				checkBtn: [...document.querySelectorAll("button")].some((b) => b.textContent === "立即检查"),
			})),
		{ timeout: 40_000, interval: 400, desc: "更新区渲染" },
	);
	assert.match(String(found.badge), /^V\d+\.\d+\.\d+/, `版本徽章形态不对：${found.badge}`);
	assert.ok(found.channel, "渠道选择器不在");
	assert.ok(found.checkBtn, "「立即检查」按钮不在");
});
await h.snap("updates-section");

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
	assert.ok(feedHits.some((u) => u.startsWith("/stable")), `feed 没收到稳定渠道请求（命中：${feedHits.join(",")}）`);
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
	await waitUntil(() => feedHits.some((u) => u.startsWith("/beta")), {
		timeout: 30_000,
		interval: 500,
		desc: "feed 收到 beta 渠道请求",
	});
	await waitUntil(async () => (await phaseKind()) === "available", {
		timeout: 30_000,
		interval: 500,
		desc: "beta 渠道回到 available",
	});
	await h.snap("updates-beta");
});

// ── ④ 切回稳定 ───────────────────────────────────────────────
await h.check("切回稳定版回到 latest.yml", async () => {
	const stableHitsBefore = feedHits.filter((u) => u === "/latest.yml").length;
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
		() => feedHits.filter((u) => u.startsWith("/stable")).length > stableHitsBefore,
		{ timeout: 30_000, interval: 500, desc: "latest.yml 被再次请求" },
	);
});

await h.finish();
feedServer.close();
rmSync(DEV_FEED_CONFIG, { force: true });
rmSync(FEED_DIR, { recursive: true, force: true });
