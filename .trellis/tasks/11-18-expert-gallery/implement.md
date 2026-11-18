# 实施清单：能力库画廊（#421）

## 0. 准备

- 分支 `feat/expert-gallery`，基线 main（#420 已合并）。
- 读 `.trellis/spec/renderer/index.md` 的 Token/焦点/状态双通道纪律与 `.trellis/spec/testing/index.md`。

## 1. 数据面

1. `src/main/daemon/experts.js`：`loadExperts` 返回对象带上 `skills: loaded.skills`（`{name,file}`）。
2. `src/main/daemon/packs.js` / `experts.js` 的 `_pack.json` 读取：补 `installedAt`（数字，缺省不带）。
3. `src/main/daemon/session-files.js` 的 `listExperts` 投影：
   - `skills: e.skills.map(({name,file}) => ({name, description: readDescription(file)}))`，
     读失败 description 为 `""`；
   - `agents: e.agents.length`（缺省 0 也带，UI 可判断）；
   - `packInstalledAt`（仅 pack 来源）。
   保持既有字段与顺序不变。

## 2. 纯函数模块

新建 `src/renderer/src/expert-gallery-core.js`，按 design §2 导出
`SOURCE_FILTERS`、`filterExperts`、`sortExperts`、`sourceCounts`、`expertCategory`、
`pathsFromDropText`。无 DOM 依赖，ESM 导出，供 app.js（打包时被内联）与 vitest 共用。

## 3. 界面

1. `ExpertsView`：
   - 状态 `source`（"all"）、`sort`（"default"）与现有 keyword/tag 组合；
   - 来源 chip 行（`.ex-source-row`）带计数；排序 `<select>`（`.ex-sort`）；
   - 无结果空态给「清除筛选」；
   - 拖放容器：`onDragOver/onDragLeave/onDrop` + `.ex-drop-overlay`；
   - 拖放/按钮都走同一个 `openPackFromPath(path)`（inspect → 预览）。
2. `ExpertCard`：
   - `data-cat={expertCategory(expert)}` + `.ex-cover` 3px 色条；
   - 来源徽标：`user` → 「我的」，`pack` → 「能力包 · vX.Y.Z」；内置不显示；
   - meta 行：`N 个技能`，pack 追加安装日期。
3. `ExpertDetailModal`：
   - 「包含技能（N）」分区（名称 + 描述；描述为空只显示名称）；
   - 团队型显示「成员 N」；
   - 来源行补安装时间；内置专家补一句不可导出说明。
4. CSS：`.ex-source-row`、`.ex-source-chip`、`.ex-sort`、`.ex-cover`、`.ex-card-meta`、
   `.ex-card-badge`、`.ex-drop-overlay`、`.ex-skill-*`。只用 Token；
   封面色用 `--cat-1..6`（按 `[data-cat]` 选择器）；亮暗都检查。

## 4. 测试

1. `tests/unit/expert-gallery-core.test.mjs`（design §5 全矩阵）。
2. `tests/e2e/gui-expert-gallery.mjs`：
   - 夹具：在 WORKSPACE 造一个带 2 个技能的能力包（复用 gui-pack 的写法），
     通过 `globalThis.kami.installPack(dir)` 安装；
   - 断言来源四档计数与筛选结果；排序「名称」；详情技能与版本/安装时间；
   - 合成拖放：`new DataTransfer(); dt.setData("text/uri-list", "file://" + dir)；`
     dispatch `dragover`/`drop` 到 `.ex`；断言覆盖层与预览弹窗；截图亮/暗；
   - 截图先于断言、全部 `waitUntil`。
3. 回归：`gui-pack`、`gui-smoke`、`ipc-functional`、`bridge-rest`。
4. 反向验证：`filterExperts` 的 source 分支短路 → e2e 红；还原后绿。
   拖拽解析的 Windows 路径用例 → 改坏解析必红。

## 5. 文档

- `CHANGELOG.md` `[Unreleased] 新增`：能力库画廊（来源筛选、排序、技能详情、拖拽导入）。
- `docs/USAGE.md` 的「专家」/「能力包」小节：补来源筛选与拖拽导入。
- Roadmap 在合并后更新，不在此提交里改。

## 6. 验证命令

```bash
npx vitest run tests/unit/expert-gallery-core.test.mjs
npm test
npm run build
node tests/e2e/gui-expert-gallery.mjs
node tests/e2e/gui-pack.mjs
node tests/e2e/gui-smoke.mjs
node tests/e2e/ipc-functional.mjs
node tests/e2e/bridge-rest.mjs
npm run check:unicode
npm run lint:all
```

## 7. 提交拆分

1. `feat(daemon): listExperts 暴露技能与安装信息`
2. `feat(renderer): 能力库的来源筛选、排序、卡片与详情`
3. `test(docs): 能力库单测、e2e 与文档`

合并后归档任务、更新 Roadmap、核对 beta。
