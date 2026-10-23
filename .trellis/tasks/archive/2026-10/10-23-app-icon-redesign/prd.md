# 应用图标重设计

## 背景

用户反馈（2026-10-23）安装后的 Dock 图标「太丑」：当前图标是近白底 `#F6F8FA`
加 30/1024 宽度的纯黑线条（外环 + 文档折角），在深色壁纸与彩色图标群里辨识度很低。

现状文件与生成链路：

- 设计源：`build/icon.svg`（唯一真源）
- 生成脚本：`tools/build-icons.mjs`（`npm run build:icons`，仅 macOS：qlmanage + iconutil）
- 产物：`build/icon.icns`（macOS）、`build/icon.ico`（Windows）、`build/icon.png`（1024 备用）
- 打包：electron-builder 从 `build/`（buildResources）自动拾取

## 期望

产出一枚在 16px 与 1024px 下都成立、且与「极光墨」视觉语言一致的新图标。

### 视觉方向（2026-10-23 已与用户确认：方案 A + 圆角）

- **底色**：深墨 `#0D1418`，与应用的深色玻璃质感一致。
- **圆角**：图标本体画成圆角矩形（内容区 824×824，`rx=185`，四周留 100px 透明边距）。
  **这是一次对旧约定的修正**：旧 SVG 注释写「不要自己画圆角、macOS 会套遮罩」，
  但 macOS 的 `.icns` **不会**自动套圆角 —— 用户截图里 ZeroWork 就是一个白色直角方块。
  `qlmanage` 实测能保留 SVG 的透明通道，圆角方案可行。
- **标记**：保留「圆环 = 0 + 折页文档」的品牌读法。圆环加粗到 52/1024，
  用 teal `#2DD4BF` → 紫 `#6366F1` 的对角渐变；文档纯白 `#F6F8FA`，折角 teal。
- **小尺寸可读**：16px / 24px 下外环与折角仍可辨认。

### 硬性约束

- 画布 1024×1024，**内容区为圆角矩形并留透明边距**（见上）；不要铺满整张画布
- `build/` 目录中除四个图标文件外不得出现其他图片（electron-builder 会全部当作候选）
- SVG 必须能被 `qlmanage` 正常光栅化（避免滤镜、外链字体、CSS 变量等）
- 修改后必须运行 `npm run build:icons` 并提交三个产物文件

## 验收标准

- [ ] 新的 `build/icon.svg` 与 `icon.icns` / `icon.ico` / `icon.png` 三份产物一并更新
- [ ] 1024px 与 64px / 32px / 16px 预览均清晰可辨（附预览截图到任务目录）
- [ ] `npm run build:icons` 在本机可重复执行、产物与提交一致
- [ ] 不引入任何新的构建依赖；不修改 macOS 圆角与阴影策略
- [ ] `CHANGELOG.md [Unreleased]` 的「变更」记录图标重设计

## 入手位置

- `build/icon.svg`
- `tools/build-icons.mjs`（仅在需要调整生成参数时）
- 预览：可临时把 SVG 转 PNG 查看，产物不入库
