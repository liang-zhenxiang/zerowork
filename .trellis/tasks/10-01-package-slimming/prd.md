# 安装包瘦身：移除随包的渲染层依赖

## Goal

用户下载 v0.3.0 后反馈：**安装要很久、打开要很久、电脑很卡**。
实测原因很清楚 —— **885 MB 的应用里有 500 MB 是 `node_modules`，22016 个文件**。

## 背景（实测数据）

```
ZeroWork.app                        885 MB
├── Contents/Frameworks             288 MB   ← Electron 本体，不可压缩
└── Contents/Resources              597 MB
    ├── app                         524 MB
    │   ├── node_modules            500 MB   22016 个文件  ← 问题
    │   └── out                      24 MB   38 个文件
    └── resources                    73 MB   ← 随包内容资源
```

根因：`externalizeDepsPlugin()` **无参数**，把 `package.json` 的 22 个
`dependencies` 全部外置 → electron-builder 整个装进包。

**但大半是渲染层专用的，而渲染层已被 Vite 打包进 `out/`**
（sandbox 渲染进程根本无法 `require` node_modules）—— 这些随包纯属重复。

### 逐包构成

| 类别 | 体积 | 处置 |
| --- | --- | --- |
| 渲染层专用 | **约 200 MB** | `monaco-editor` 97M、`react-pdf` 43M、`echarts` 23M、`@fortune-sheet` 15M、`react-dom` 8M、`xlsx` 6M、`pptx-preview` 3M、`react`/`react-markdown`/`remark-gfm`/`docx-preview`/`@corbe30` 各 1M | **移除** |
| OCR 链 | **约 50 MB** | `tesseract.js-core` 43M ← `officeparser → tesseract.js` | **移除**（见下） |
| Node 端 canvas | 27 MB | `@napi-rs/canvas` ← `pdfjs-dist` 的**可选**依赖 | 评估 |
| 主进程纯 JS | 约 76 MB | `officeparser` 46M、`pdfjs-dist` 17M、`typebox` 6M、`linkedom`/`jszip`/`turndown`/`jsonc-parser`/`@modelcontextprotocol` 各 1–2M | 评估打进 out/ |
| 主进程原生 | 约 39 MB | `@earendil-works/*` 37M（6 个 `.node`）、`koffi` 2M | **必须随包** |

**OCR 那条值得单独说**：Roadmap 的「不做」清单里明确写着不做 OCR / 扫描件识别。
**我们在随包发一个声明不支持的能力，还占了 50 MB。**

## Requirements

- R1 **把渲染层专用依赖移出随包**（约 200 MB）。
  首选做法是把它们从 `dependencies` 移到 `devDependencies` ——
  渲染层由 Vite 打包，与依赖分区无关，移动后照常构建
- R2 **处理 OCR 链**（约 50 MB）。与 Roadmap 的「不做 OCR」一致
- R3 **评估 `@napi-rs/canvas`**：确认主进程是否真的用到 Node 端 canvas 渲染；
  不用就排除
- R4 **评估把主进程纯 JS 依赖打进 `out/main`**（`externalizeDepsPlugin({ exclude })`），
  再省约 76 MB。**这是有代价的**：`minify: false` 的初衷是「保留原始标识符便于线上定位」，
  打包会让产物变大、可读性下降 —— **把取舍写进文档**，并说明为什么值得
- R5 **用测试钉死**，防止后续加功能又把体积涨回去：
  - 打包产物体积上限
  - **随包的 `node_modules` 中不得出现渲染层专用依赖**（按名单断言）
  - 断言「主进程真正需要的包都在」

## Acceptance Criteria

- [ ] `npm run dist:dir` 后，`ZeroWork.app` **从 885 MB 降到 400 MB 以内**
      （Electron 本体 288 MB 是下限，Resources 目标 ≤ 110 MB）
- [ ] 随包 `node_modules` **文件数从 22016 降到 5000 以内**
- [ ] **应用仍能正常启动与工作**：`npm run test:gui:smoke` 与
      `test:gui:sections` 全绿（这是「没移错」的证据）
- [ ] 新增的检查脚本能在体积超标时**失败**（反向验证：故意移回一个渲染层依赖，检查必须红）
- [ ] 取舍写进 `docs/MAINTAINER_GUIDE.md` 或 `electron-builder.yml` 的注释

## 约束

- **不要把 `asar` 改成 `true`** —— daemon 用 `utilityProcess.fork`，需要真实文件路径。
  这条写在 `electron-builder.yml` 里，是有代价换来的
- 不放宽 `minify: false` 的默认（除非 R4 的评估结论支持，且要写明理由）
- 不动 `resources/`（它是内容资源，不是依赖）
- 每移一个依赖都要**真的启动应用验证**，不能只看构建通过

## 难度

中。改的是构建配置，但**移错一个主进程依赖就是运行时才炸** ——
所以每一步都要有「应用仍能跑」的证据。

## Notes

- 验证命令：
  ```bash
  npm run dist:dir
  du -sh release/mac-arm64/ZeroWork.app
  find release/mac-arm64/ZeroWork.app/Contents/Resources/app/node_modules -type f | wc -l
  ```
- 本机是 Apple M4 / arm64，`dist:dir` 出的是 mac-arm64
