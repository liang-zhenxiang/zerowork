# GUI 测试环境阻塞（2026-10-16）

## 现象

`npm run test:gui`（以及它的每一条子命令）全部失败：

```
Error: Process failed to launch!
    at Electron.launch (playwright-core/lib/coreBundle.js:44316:36)
```

直接运行 Electron 二进制，**连 `--version` 都跑不了**：

```
$ ./node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --version
Abort trap: 6        # 退出码 134，耗时 48ms
```

## 已排除的可能

| 假设 | 验证方式 | 结论 |
| --- | --- | --- |
| 本仓库代码改坏了 | 失败发生在 `--version`，**连 main 都进不去**，与任何应用代码无关 | 排除 |
| 安装包被截断 | 主二进制 51920 字节 = `__LINKEDIT` 的 `fileoff 32768 + filesize 19152`（**完全吻合**）；框架 201 MB、整包 307 MB | 排除 |
| 架构不匹配 | 本机 `arm64` / Apple M4；二进制是 `Mach-O 64-bit executable arm64` | 排除 |
| 签名失效 | `codesign --verify --deep --strict` 通过（exit 0）；`--validated` 逐项通过 | 排除 |
| quarantine 属性 | 复制到 `/tmp` 并 `xattr -cr` + `codesign --force --deep --sign -` 重签，**仍是 134** | 排除 |
| 本机不能跑 Electron | 百度网盘的 Electron 26 进程**正在运行**（`ps` 可见） | 排除 |
| 安全软件拦截 | 无 CrowdStrike / Sentinel / Defender 之类进程 | 排除 |
| 本项目 node_modules 特有 | 复制整包到 `/tmp/el3` 后仍失败 | 排除 |

## 直接证据

LaunchServices 给出的错误是决定性的：

```
$ open -a ".../dist/Electron.app" --args --version
error=Error Domain=NSOSStatusErrorDomain Code=-10827
      "kLSNoExecutableErr: The executable is missing"

$ lsregister -f ".../dist/Electron.app"
failed to scan ...: -10822
```

`-10822` = `kLSDataUnavailableErr`。

`find node_modules/electron -newermt "2026-10-16 03:00" -not -newermt "2026-10-16 04:00"`
列出 **45 个文件**，全部是 Electron 安装产物（`path.txt`、各级 `_CodeSignature/CodeResources`、
5 个 Helper 二进制、Electron Framework、Mantle/ReactiveObjC/Squirrel）。时间戳集中在
**03:29–03:32**，正与 GUI 测试开始失败的时刻重合 —— 此前（02:34）`test:gui:state`
成功过并产出过截图。`node_modules/electron/dist` 目录本身的时间戳仍是 `Sep 30 15:24`，
而被改写的都是包内文件。

**推断**：03:29 前后有一次对 `node_modules/electron` 的不完整重装/覆盖，
留下了结构完整、签名自洽、但内核拒绝加载的包。

## 推翻上面的推断（同日补测，结论反转）

上面的推断**是错的**。补做的四个实验：

| 实验 | 结果 |
| --- | --- |
| 从本机 Electron 官方缓存 `~/Library/Caches/electron/…/electron-v44.4.4-darwin-arm64.zip`（`unzip -t` 校验无损）解压到 `/tmp` 的全新副本 | **仍 134** |
| 同法解压 44.4.3、44.3.0 | **均 134** |
| 直接运行**正在运行中**的百度网盘（Electron 26）的二进制 | **134** |
| `open /System/Applications/Calculator.app`（macOS 自带） | **`kLSNoExecutableErr`，同一个错** |

**所以不是文件损坏、不是 Electron 版本、不是本仓库。** 03:29 那批时间戳是
`npm` 一次重装留下的正常痕迹 —— 恰好与失败同时发生，是**巧合**；
我先前把巧合当成了因果。**同时发生不等于因果**，这正是那次推断错的地方。

真实原因：**本会话的 shell 无法启动任何 GUI 程序**（含 macOS 自带的 Calculator）。
`open` 对任何 `.app` 都返回 `-10827`，直接 exec 一律 `SIGABRT(134)`。
这是本执行环境的限制，与本项目无关，也**无法通过改代码或重装依赖绕过**。

（`node_modules/electron/dist` 已用缓存里的 44.4.4 覆盖还原，比 03:29 那份更可信；
还原后行为不变，仍 134 —— 再次印证与文件无关。）

## 为什么无法自行修复

重装需要网络，而本机**到 npm registry 与 github.com 都不通**（DNS 无法解析）：

```
$ npm install electron@44.4.4 --registry=https://registry.npmjs.org/
npm error network In most cases you are behind a proxy or have bad network settings.
```

## 影响

`npm run test:gui` 全部 34 条子命令、以及 `npm run test:e2e` 都无法执行。
本轮新增的 `tests/e2e/gui-sections.mjs` 断言**已写但未被执行过** ——
它的断言依据是实施代码里逐条核对过的类名与文案（`.watch-group-label`、
`.preset-tag`、`30 分钟`、`不生效`），不是推测，但**没有真实渲染验证**。

## 恢复方式

**换一个能启动 GUI 程序的执行环境**（不是重装依赖 —— 依赖是好的）。
在那种环境里跑：

```
npm run test:gui:sections     # 先验证本轮新增的断言
npm run test:gui              # 再按 PRD 跑完整回归并留截图
```

按 PRD 还欠一条独立用例 `tests/e2e/watch-policy.mjs`（真实启动 → 建带规矩的
定时任务 → 手动触发 → 断言运行报告与越界证人 → 各态截图），
它也必须在能跑 GUI 的环境里补。
