/*
 * network.js —— daemon 的出站网络配置（spec: proxy-settings）
 *
 * 为什么需要这个文件：pi 内核自己的 HTTP dispatcher（pi-coding-agent 的
 * core/http-dispatcher.js）只在它的 CLI 入口与 rpc-entry 里被安装，
 * 而本项目的 daemon 是通过包的根入口动态 import 内核的 —— 那条路径不会
 * 安装 dispatcher。结果就是「设了代理，模型请求还是直连」。
 *
 * 这里照抄它同一套做法：EnvHttpProxyAgent 读 HTTP_PROXY / HTTPS_PROXY /
 * NO_PROXY（由主进程在 fork 时注入，见 src/main/index.js 的 daemonEnv），
 * 再用 undici.install() 把全局 fetch 换成 undici 的实现 —— 两者必须来自
 * **同一个 undici 实例**，否则 setGlobalDispatcher 设的是 A、模型 SDK 用的是 B，
 * 表现为设置生效了但请求没走代理。
 *
 * 依赖纪律：package.json 把 undici 锁在与 pi 相同的 8.10.2，npm 才会去重成
 * 同一份。升级 pi 时要连带核对这里（npm ls undici 应当只看到 pi 那份）。
 */
import * as undici from "undici";

/**
 * 安装全局 dispatcher。必须在任何 `await import("@earendil-works/pi-coding-agent")`
 * 之前调用（daemon/index.js 的第一行）。
 *
 * 没有代理环境变量时 EnvHttpProxyAgent 等价于直连，所以「直连 / 跟随系统 /
 * 手动」三档走的是同一条代码路径，不需要在这里分支。
 */
export function installProxyDispatcher() {
	const dispatcher = new undici.EnvHttpProxyAgent({
		// 与 pi 的 http-dispatcher 保持一致：HTTP/2 在部分代理后面会出问题，
		// 且强制 HTTP 目标走 CONNECT 隧道（Undici 8.7 之前的默认行为）。
		allowH2: false,
		proxyTunnel: true,
		connect: {
			// Node 默认 250ms 在高延迟线路上会误杀连接尝试（pi 同款注释）。
			autoSelectFamilyAttemptTimeout: 2_000,
		},
	});
	undici.setGlobalDispatcher(dispatcher);
	// 把 fetch 与 dispatcher 对齐到同一个 undici 实例。
	// install 在当前 undici 版本是实验性 API，不存在时保持 Node 内置 fetch
	// （此时 Node 26+ 仍会通过内置 dispatcher 走代理；更老的 Node 只是拿不到
	// 代理，不会崩）。
	undici.install?.();
}
