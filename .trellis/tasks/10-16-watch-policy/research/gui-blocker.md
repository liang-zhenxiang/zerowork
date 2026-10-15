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

## 为什么无法自行修复

重装需要网络，而本机**到 npm registry 不通**：

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

在有网络的环境执行 `npm rebuild electron` 或删掉 `node_modules/electron` 后重装。
恢复后**必须**补跑：`npm run test:gui:sections`，然后按 PRD 跑完整
`npm run test:gui` 并留截图。
