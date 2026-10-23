/*
 * updates.js —— 应用内更新器（双渠道：stable / beta，spec: update-channels）
 *
 * 渠道模型（完整图见任务 design.md §0）：
 *   stable → GitHub Releases 的 latest.yml    （稳定版发布流水线产出）
 *   beta   → GitHub Releases 的 beta.yml      （beta 流水线产出，pre-release）
 * 两个 channel 文件物理隔离，beta 发布不可能污染稳定渠道。
 *
 * 平台差异（如实降级，不假装）：
 *   · Windows（NSIS）：检查 → 下载 → quitAndInstall 全自动。
 *   · macOS：未签名应用不支持自动安装（Squirrel 要求签名身份）——
 *     只做「检查 + 通知 + 引导去 Release 页下载」。UI 文案如实说明。
 *
 * 环境守卫：只在打包态启用（app.isPackaged）；e2e 例外是显式喂了
 * ZEROWORK_UPDATE_FEED 的环境（本地 http 的 mock feed，见
 * tests/e2e/gui-updates.mjs）——「显式喂了 feed」本身就是测试意图。
 * dev（npm run dev）两者都不满足，更新器完全静默。
 */
import { app, ipcMain, net, shell } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
// 显式 import 而不是用全局（main 目录的 eslint globals 白名单不含 timers；
// 显式源也和本文件其余 import 的风格一致）。
import process from "node:process";
import { setTimeout as scheduleCheck, setInterval as schedulePeriodicCheck, clearInterval as cancelPeriodicCheck } from "node:timers";
import { join } from "node:path";
import { homedir } from "node:os";
import { URL } from "node:url";
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;

/**
 * macOS 手动下载安装包的状态。
 *
 * 为什么不复用 autoUpdater.downloadUpdate()：macOS 上它下载的是 Squirrel
 * 自动更新用的 `.zip`，不能直接打开安装。要「应用内下载并打开」，只能从
 * update-available 的 info.files 里挑 `.dmg` 自己下。
 *
 * 字段在 update-available 时填充（候选产物），下载成功后 path/version 有值。
 */
const installer = {
  /** 最近一次 update-available 的 files 数组（electron-updater 的 UpdateInfo.files）。 */
  files: undefined,
  /** 已下载完成的 dmg 路径与对应版本。 */
  path: undefined,
  version: undefined,
};

/** 内部可变状态（渲染层经 getUpdateState 读取的投影）。 */
const state = {
  /** idle | checking | available | not-available | downloading | downloaded | error */
  phase: "idle",
  /** 最近的可用版本号（available 之后填）。 */
  availableVersion: undefined,
  /** 下载进度（0-100，downloading 时有意义）。 */
  percent: 0,
  /** 最近一次错误（中文，可展示）。 */
  error: undefined,
  /** 当前生效渠道（configure 时填）。 */
  channel: "stable",
  /** 上次检查时间（epoch ms）。 */
  lastCheckAt: undefined,
};

let windowRef = undefined;
let feedOverride = undefined;
let timerRef = undefined;

function emit(event) {
  if (windowRef !== undefined && !windowRef.isDestroyed()) {
    windowRef.webContents.send("updates:event", event);
  }
}

function setPhase(patch) {
  Object.assign(state, patch);
  emit({ type: "state", ...state });
}

/** 主进程读偏好（只读不写——写永远走 daemon，与 applyInitialTheme 同纪律）。 */
function readChannelPreference() {
  const override = process.env["ZEROWORK_CONFIG_DIR"];
  const configDir = override !== undefined && override !== "" ? override : join(homedir(), ".zerowork");
  try {
    const record = JSON.parse(readFileSync(join(configDir, "preferences.json"), "utf8"));
    return record.updateChannel === "beta" ? "beta" : "stable";
  } catch {
    // 文件不存在/损坏是正常态（首启）；缺省 stable。
    return "stable";
  }
}

function configure(channel) {
  state.channel = channel;
  autoUpdater.channel = channel;
  // 渠道切换时 prerelease 标志跟着走（理由见 initUpdates 里的注释）。
  autoUpdater.allowPrerelease = channel === "beta";
  // ZEROWORK_UPDATE_FEED（e2e 的本地 mock feed）优先于 GitHub provider——
  // 测试不碰真实仓库；generic provider 直接从该 url 拉 <channel>.yml。
  if (feedOverride !== undefined) {
    autoUpdater.setFeedURL({ provider: "generic", url: feedOverride });
  } else {
    autoUpdater.setFeedURL({
      provider: "github",
      owner: "liang-zhenxiang",
      repo: "zerowork",
      channel,
    });
  }
}

function check() {
  state.lastCheckAt = Date.now();
  setPhase({ phase: "checking", error: undefined });
  // checkForUpdates 的 promise 只反映「请求发出」，结果全走事件回调；
  // 这里吞掉 reject（错误已由 error 事件统一上报），避免 unhandled rejection。
  autoUpdater.checkForUpdates().catch(() => {});
}

/** 从 UpdateInfo.files 里挑出 macOS 的 .dmg（zip 是 Squirrel 用的，打不开安装）。 */
function pickDmgFile(files) {
	if (!Array.isArray(files)) return undefined;
	return files.find((entry) => typeof entry?.url === "string" && /\.dmg$/i.test(entry.url));
}

/**
 * 把 update info 里的 url 解析成可下载的绝对地址。
 *
 * generic provider（e2e 的 mock feed）给的是相对文件名，要拼回 feed 根；
 * github provider 给的是完整 URL，原样使用。解析不出时返回 undefined，
 * 由调用方如实报错，不要猜一个地址出来。
 */
function resolveDownloadUrl(url) {
	if (/^https?:\/\//iu.test(url)) return url;
	if (feedOverride !== undefined && feedOverride !== "") {
		try {
			return new URL(url, feedOverride).toString();
		} catch {
			return undefined;
		}
	}
	return undefined;
}

/**
 * macOS：应用内下载 .dmg 并校验 SHA512。
 *
 * 这里**不**调用 autoUpdater.downloadUpdate()：它下载的是 Squirrel 用的
 * zip，无法直接打开安装（见文件头的平台差异说明）。
 *
 * 校验是必要的：这类下载绕开了 electron-updater 自己的产物校验流程，
 * 而 macOS 安装包本身未签名 —— 不再比对发布清单里的 sha512 的话，
 * 中间人替换的 dmg 会被直接交给用户。
 */
async function downloadInstaller() {
	if (process.platform !== "darwin") {
		return { ok: false, reason: "Windows 由更新器自动下载；此操作仅用于 macOS" };
	}
	if (state.phase !== "available" && state.phase !== "downloaded") {
		return { ok: false, reason: "当前没有可下载的新版本，请先检查更新" };
	}
	const version = state.availableVersion;
	if (version === undefined) return { ok: false, reason: "更新信息缺少版本号" };
	if (installer.version === version && installer.path !== undefined && existsSync(installer.path)) {
		return { ok: true, path: installer.path, reused: true };
	}
	const entry = pickDmgFile(installer.files);
	if (entry === undefined) return { ok: false, reason: "这次发布没有提供 .dmg 安装包" };
	const url = resolveDownloadUrl(entry.url);
	if (url === undefined) return { ok: false, reason: "无法解析安装包的下载地址" };

	const dir = join(app.getPath("temp"), "zerowork-updates");
	mkdirSync(dir, { recursive: true });
	const target = join(dir, `ZeroWork-${version}.dmg`);
	const part = `${target}.part`;
	// 同一版本重复点按不会重复下载；换版本时旧的半成品没有价值。
	rmSync(part, { force: true });

	setPhase({ phase: "downloading", percent: 0, error: undefined });
	try {
		const response = await net.fetch(url);
		if (!response.ok) throw new Error(`下载安装包失败：HTTP ${response.status}`);
		if (response.body === null) throw new Error("下载安装包失败：响应没有内容");
		const header = response.headers.get("content-length");
		const totalBytes = header === null ? 0 : Number(header);
		const hash = createHash("sha512");
		const stream = createWriteStream(part);
		let received = 0;
		for await (const chunk of response.body) {
			hash.update(chunk);
			await new Promise((resolve, reject) => {
				stream.write(chunk, (error) => (error === null ? resolve() : reject(error)));
			});
			received += chunk.length;
			if (totalBytes > 0) {
				setPhase({ phase: "downloading", percent: Math.min(99, Math.round((received / totalBytes) * 100)) });
			}
		}
		await new Promise((resolve, reject) => {
			stream.end(() => resolve());
			stream.once("error", reject);
		});
		if (typeof entry.sha512 === "string" && entry.sha512 !== "") {
			const actual = hash.digest("base64");
			if (actual !== entry.sha512) {
				throw new Error("安装包校验失败（SHA512 不符），文件已丢弃。请重试或到发布页下载");
			}
		}
		renameSync(part, target);
		installer.path = target;
		installer.version = version;
		setPhase({ phase: "downloaded", percent: 100 });
		return { ok: true, path: target };
	} catch (error) {
		rmSync(part, { force: true });
		const reason = error instanceof Error ? error.message : String(error);
		setPhase({ phase: "error", error: reason });
		return { ok: false, reason };
	}
}

/** 打开已下载的 dmg；打不开时退回「在文件管理器中定位」，不让用户空手。 */
async function openInstaller() {
	const path = installer.path;
	if (path === undefined || !existsSync(path)) {
		return { ok: false, reason: "安装包不存在或已被清理，请重新下载" };
	}
	const failure = await shell.openPath(path);
	if (failure !== "") {
		shell.showItemInFolder(path);
		return { ok: false, reason: `无法自动打开安装包（${failure}），已在文件管理器中定位` };
	}
	return { ok: true };
}

/**
 * 注册 IPC 与事件转发。在 app.whenReady、窗口创建之后调用一次。
 * @param {import("electron").BrowserWindow} win
 */
export function initUpdates(win) {
  windowRef = win;
  feedOverride = process.env["ZEROWORK_UPDATE_FEED"];
  const enabled = app.isPackaged || feedOverride !== undefined;
  if (!enabled) {
    // dev：三条 IPC 仍注册（渲染层设置页要能打开），但都如实回答「不可用」。
    ipcMain.handle("updates:get-state", () => ({ version: app.getVersion(), channel: "stable", phase: "unavailable" }));
    ipcMain.handle("updates:check", () => ({ ok: false, reason: "dev 环境不启用更新器" }));
    ipcMain.handle("updates:install", () => ({ ok: false, reason: "dev 环境不启用更新器" }));
    ipcMain.handle("updates:download", () => ({ ok: false, reason: "dev 环境不启用更新器" }));
    ipcMain.handle("updates:open-installer", () => ({ ok: false, reason: "dev 环境不启用更新器" }));
    return;
  }

  // e2e（未打包 + ZEROWORK_UPDATE_FEED）：electron-updater 在未打包态默认
  // inactive（找不到 app-update.yml 就静默不工作——表现是永远卡在 checking
  // 且没有任何网络请求，2026-10-02 调试实录）。forceDevUpdateConfig 让它
  // 改读项目根的 dev-app-update.yml（e2e 在启动前写好，测完删）。
  if (feedOverride !== undefined && !app.isPackaged) {
    autoUpdater.forceDevUpdateConfig = true;
  }
  // 未签名应用：electron-updater 的下载校验依赖 latest.yml 的 sha512（仍在），
  // 但 macOS 的自动安装需要签名身份——直接关掉自动下载，只做「检查 + 通知」。
  autoUpdater.autoDownload = process.platform === "win32";
  autoUpdater.autoInstallOnAppQuit = false;
  // allowPrerelease 跟随渠道：github provider 在 beta 渠道下**必须**为 true——
  // 它默认只在「latest release」（稳定）里找 channel 清单，beta-mac.yml 在
  // pre-release 里，不开就去 v0.3.0 找 beta-mac.yml 而 404（2026-10-02 真机
  // 实测的错误原文即此）。stable 渠道保持 false：绝不把 pre-release 当稳定推送。
  autoUpdater.allowPrerelease = readChannelPreference() === "beta";

  autoUpdater.on("checking-for-update", () => setPhase({ phase: "checking" }));
  autoUpdater.on("update-available", (info) => {
    // 留存候选产物：macOS 的「应用内下载」要从这里挑 .dmg（见 downloadInstaller）。
    installer.files = Array.isArray(info?.files) ? info.files : undefined;
    installer.path = undefined;
    installer.version = undefined;
    setPhase({ phase: "available", availableVersion: info?.version });
    // mac（autoDownload=false）到这一步就停：等用户点「下载更新」。
  });
  autoUpdater.on("update-not-available", () => setPhase({ phase: "not-available", availableVersion: undefined }));
  autoUpdater.on("download-progress", (progress) => {
    setPhase({ phase: "downloading", percent: Math.round(progress?.percent ?? 0) });
  });
  autoUpdater.on("update-downloaded", (info) => {
    setPhase({ phase: "downloaded", availableVersion: info?.version });
  });
  autoUpdater.on("error", (error) => {
    setPhase({ phase: "error", error: error instanceof Error ? error.message : String(error) });
  });

  configure(readChannelPreference());

  ipcMain.handle("updates:get-state", () => ({ version: app.getVersion(), ...state }));
  ipcMain.handle("updates:check", () => {
    check();
    return { ok: true };
  });
  ipcMain.handle("updates:install", () => {
    if (process.platform !== "win32") {
      // 渲染层本就不该在 mac 上显示安装按钮；这里是防线的第二层。
      return { ok: false, reason: "macOS 未签名应用不支持自动安装，请到 Release 页下载" };
    }
    if (state.phase !== "downloaded") {
      return { ok: false, reason: "更新还没下载完成" };
    }
    // 退出并安装由更新器接管进程生命周期，这里不需要返回值。
    autoUpdater.quitAndInstall();
    return { ok: true };
  });
  // macOS 的替代路径：应用内下载 dmg 并打开（不能自动安装，但省掉去发布页找版本）。
  ipcMain.handle("updates:download", () => downloadInstaller());
  ipcMain.handle("updates:open-installer", () => openInstaller());

  // 启动静默检查（延迟 10s：让 daemon/界面先起来，更新检查不抢启动带宽），
  // 之后每 24h 一次。Channel 切换时的立即检查由 main 的 setUpdateChannel
  // 包装层触发（configUpdatesIPC，见 index.js 接线）。
  scheduleCheck(() => check(), 10_000);
  timerRef = schedulePeriodicCheck(() => check(), 24 * 60 * 60 * 1000);
}

/** 渠道被设置后的重配 + 立即检查（setUpdateChannel handler 的包装层调用）。 */
export function switchUpdateChannel(channel) {
  if (channel !== "stable" && channel !== "beta") return;
  configure(channel);
  check();
}

/** 测试与退出清理。 */
export function disposeUpdates() {
  if (timerRef !== undefined) cancelPeriodicCheck(timerRef);
  timerRef = undefined;
}
