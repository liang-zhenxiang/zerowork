# MiSans 随包字体说明

## 当前状态（2026-09-20 起：**已完全移除**）

**MiSans 不在界面字体栈里，也不随包**。`--font-body` 现为
`"PingFang SC", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`，
`@font-face` 声明已于 2026-09-20 移除，renderer 构建根下也没有 `fonts/` 目录
（两个 woff2 从未入库）。

> ⚠️ **本文件此前写着「MiSans 留在 --font-body 最末位兜底」——那是过期说法**，
> 2026-10-05 核实后纠正（同一处错误也出现在 `THIRD_PARTY_NOTICES.md` 里，
> 那份还据此认为「MiSans 的应用内注明义务未履行」；既然不使用，义务就不适用）。

移除的理由：用户实测小字号发虚，且 3876 字子集与雅黑**混排**时字形粗细不匀
（同一段落里一级汉字用 MiSans、生僻字落雅黑）。代价是 `font-weight: 600` 由雅黑
**合成加粗**，实测权衡后选择系统字体的清晰度优先。

## 当初为什么随包（保留记录）

界面大量 `font-weight:600` 在微软雅黑上只能合成加粗（雅黑无真 600 字重），笔画发虚，
12-14px 小字号尤其明显。MiSans 有真 Semibold 字重且针对小字号屏显优化，故随包其
子集作为 Windows 中文 UI 字体；macOS 仍用系统苹方，雅黑降级为兜底。

## 字体文件位置与接入

实际 woff2 放在 **renderer 构建根下的 `fonts/`**（本仓库未收录该二进制；renderer 是 vite 构建根，CSS `url()` 相对引用
才会被打包进产物；`resources/` 是主进程运行时读取的目录，不进 renderer bundle）：

- `MiSans-Regular.woff2`（@font-face `font-weight: 400`）
- `MiSans-Semibold.woff2`（@font-face `font-weight: 600`）

`src/renderer/src/app.css`（index.html 引用的就是它）里留有 @font-face 的声明与移除记录
（`font-display: swap`；2026-09-20 已清掉，见该文件 746-751 行的注释），body 字体栈中
`"MiSans"` 位于**最末位**（`--font-body` 的兜底位，见「当前状态」一节）。

## 来源

- 上游字体：小米 MiSans（小米科技有限责任公司，联合汉仪/蒙纳制作），
  官方发布页 https://hyperos.mi.com/font/download
- 实际下载点：开源镜像仓库 dsrkafuu/misans 的全量 TTF
  - https://raw.githubusercontent.com/dsrkafuu/misans/main/raw/Normal/ttf/MiSans-Regular.ttf
  - https://raw.githubusercontent.com/dsrkafuu/misans/main/raw/Normal/ttf/MiSans-Semibold.ttf
  - 下载日期 2026-09-12，字节数与 GitHub API 列出的一致（8073152 / 7984932）

## 许可证（《MiSans 字体知识产权许可协议》）

关键条款（摘自小米官方协议文本，经 misans-webfont npm README 转录核对）：

- 「MiSans Global 所有的字体都是供全球免费商用，您可以在任何平台、任何商业项目中
  使用所有字体。」
- 嵌入式使用：「可以。但您应在软件中特别注明使用了 MiSans 字体。」
  —— 本 README 即仓库内的注明；应用内注明位置待「关于」页落地时补（当前无关于页）。
- 义务三条：
  1. 在软件中特别注明使用了 MiSans 字体；
  2. 不得对字体字形外观改编或二次开发（子集化只删字形不改外观，
     与各家 webfont 分包实践一致）；
  3. 不得单独分发/售卖字体本身（随应用整体分发、用于渲染界面不受此限；
     用字体创作的作品可自由分发）。

## 子集口径（复现方法）

字符集 3876 字 = ASCII 可打印（0x20-0x7E）+ GB2312 一级汉字 3755 字
（区位 16-55；末区 0xD7 只到 0xF9）+ 常用中文标点
（，。、；：？！""''（）《》—…·！～【】「」￥）+ 常用符号（→←↑↓✓✗）。
未覆盖的字（二级汉字/生僻字）本就会由系统雅黑渲染 —— 这也是 2026-09-15 改回雅黑优先的
起因之一：与其让一级汉字走 MiSans、生僻字走雅黑造成整段混排，不如整体交给系统字体。

```sh
pip install fonttools brotli
pyftsubset MiSans-Regular.ttf --text-file=charset.txt --flavor=woff2 \
  --output-file=MiSans-Regular.woff2 --layout-features='*'
# Semibold 同理
```

产物大小：Regular 483904 B（≈473 KB）、Semibold 489152 B（≈478 KB），远低于 2MB 上限。
`--layout-features='*'` 保留全部 OpenType 特性（tnum 等，`font-variant-numeric` 依赖）。
