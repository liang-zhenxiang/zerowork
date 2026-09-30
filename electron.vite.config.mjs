/**
 * electron-vite 构建配置。
 *
 * 产物结构：
 *   out/main/index.mjs        主进程
 *   out/preload/index.mjs     预加载脚本
 *   out/renderer/             渲染层（React SPA）
 *
 * minify 显式关闭：保留原始标识符与注释，便于线上问题定位与堆栈对照。
 */
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const NO_MINIFY = false;

/**
 * 应用版本号的**单一真源**：package.json 的 `version`。
 *
 * 渲染层需要把版本显示给用户（侧栏品牌行、设置-关于），但它跑在 sandbox 渲染进程里，
 * 读不到 package.json；主进程虽有 `app.getVersion()`，却只用在 `setAboutPanelOptions`
 * （原生面板）上，没有通向渲染层的通道 —— 新开一条 IPC 意味着渲染层要**异步**取值，
 * 而侧栏是同步渲染的，会多出一个 loading 态。
 *
 * 所以走 Vite 的构建期替换：`__APP_VERSION__` 在 dev 与 build 两种模式下都会被
 * 替换成下面这行读到的字面量（不是只在 build 时），运行时零开销、保持同步。
 * 守卫在 `scripts/check-renderer-assets.mjs`：产物里必须含这个版本号。
 */
const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

export default defineConfig({
	main: {
		plugins: [externalizeDepsPlugin()],
		build: {
			minify: NO_MINIFY,
			rollupOptions: {
				input: {
					index: resolve("src/main/index.js"),
					daemon: resolve("src/main/daemon/index.js"),
					"sandbox-prepare-worker": resolve("src/main/sandbox/prepare-worker.js"),
				},
				output: {
					entryFileNames: "[name].mjs",
					chunkFileNames: "chunks/[name]-[hash].mjs",
				},
			},
		},
	},
	preload: {
		plugins: [externalizeDepsPlugin()],
		build: {
			minify: NO_MINIFY,
			rollupOptions: {
				input: { index: resolve("src/preload/index.js") },
				output: {
					entryFileNames: "[name].mjs",
					format: "es",
				},
			},
		},
	},
	renderer: {
		root: resolve("src/renderer"),
		plugins: [react()],
		// 构建期注入版本号（见文件上方 pkg 的说明）。渲染层源码里写的是
		// `__APP_VERSION__`，替换发生在**构建期**，所以运行时它就是一个普通字符串。
		define: { __APP_VERSION__: JSON.stringify(pkg.version) },
		build: {
			minify: NO_MINIFY,
			rollupOptions: {
				// 入口 chunk 显式命名 `app`，让产物是 app.js / app.css。
				// 不能沿用默认（html 文件名 `index`）：渲染层源码里有一批**运行时**字符串
				// 引用入口样式表（`./app.css`，见下面的说明），名字对不上就会 404。
				input: { app: resolve("src/renderer/index.html") },
				output: {
					// 产物文件名**必须语义化、不带内容哈希** —— 这不是风格偏好，是硬约束。
					//
					// 源码里每个懒加载块的依赖表以**字面量字符串**形式内联（`viteMapDeps([...])`，
					// 形如 ["./office-xlsx.js", "./vendor-lodash.js", "./office-xlsx.css"]）。
					// 这些字符串在运行时被拼成 URL 去预加载，**Vite 不会再改写它们**：
					// 构建只认 import 说明符，不认这种字符串。
					//
					// 所以写进依赖表的文件名必须与构建产出的文件名一致。默认的哈希命名会让
					// 这批字符串全部指向不存在的文件 —— 其中 CSS 那几条是**致命**的
					// （预加载助手对 CSS 失败会 reject 懒加载 promise，渲染层直接进错误边界，
					// 表现为「点开 xlsx / 代码预览即界面渲染出错」）。JS 那几条只是白预载。
					entryFileNames: "assets/[name].js",
					chunkFileNames: "assets/[name].js",
					assetFileNames: "assets/[name][extname]",
				},
			},
		},
	},
});
