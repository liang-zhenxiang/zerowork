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
import { app, ipcMain } from "electron";
import { readFileSync } from "node:fs";
// 显式 import 而不是用全局（main 目录的 eslint globals 白名单不含 timers；
// 显式源也和本文件其余 import 的风格一致）。
import process from "node:process";
import { setTimeout as scheduleCheck, setInterval as schedulePeriodicCheck, clearInterval as cancelPeriodicCheck } from "node:timers";
import { join } from "node:path";
import { homedir } from "node:os";
import electronUpdater from "electron-updater";

const { autoUpdater } = electronUpdater;

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
    setPhase({ phase: "available", availableVersion: info?.version });
    // mac（autoDownload=false）到这一步就停：通知用户去 Release 页。
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
