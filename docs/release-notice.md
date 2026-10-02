### ⚠️ 首次打开会被系统拦下 —— 这是正常的

安装包**没有代码签名**（项目没有代码签名证书），所以 macOS 与 Windows
都会在你第一次打开时拦一下。**文件本身是完好的** —— 不是下坏了，也不是打包出错。

| 平台 | 会看到什么 | 怎么打开 |
| --- | --- | --- |
| **macOS** | 「无法验证开发者，无法打开」 | **右键点图标 → 打开**，在弹窗里再点「打开」。若仍被拦下：打开**系统设置 → 隐私与安全性**，在「安全性」一栏点**仍要打开** |
| **macOS** | 「**已损坏**，无法打开。你应该将它移到废纸篓」 | 这是 **0.4.0-beta.2 及更早版本**的已知缺陷（签名损坏，**0.4.0-beta.3 起已修复**）。带 `-arm64` 的包会这样，Intel 包不受影响但很慢。应急办法是在「终端」里执行 `xattr -dr com.apple.quarantine /Applications/ZeroWork.app`，或直接下载 beta.3 及以后的包 |
| **Windows** | SmartScreen 提示「Windows 已保护你的电脑」 | 点**更多信息** → **仍要运行** |

**下载哪个包**：Apple 芯片（M1 及以后）用带 `-arm64` 的那个；Intel 机器用不带的那个。
**装错了会很慢** —— Intel 包在 Apple 芯片上由 Rosetta 翻译执行。

dmg 的 **arm64 与 x64 两个包要各自放行一次** —— 放行过其中一个，不代表另一个不再被拦。

介意未签名的话，可以从源码构建 —— 见
[CONTRIBUTING.md](https://github.com/liang-zhenxiang/zerowork/blob/main/CONTRIBUTING.md)。

**平台支持**：只有 Windows 是完整支持的平台 —— 命令沙箱依赖 Windows 专有的系统调用，
macOS / Linux 上默认权限档下命令会被拒绝执行。详见
[README 的平台支持说明](https://github.com/liang-zhenxiang/zerowork/blob/main/README.md#平台支持)。
