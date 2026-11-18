# 实施清单：能力包 v1（#420）

## 0. 准备

- 分支：`feat/capability-pack`（从最新 main）。
- 读：`.trellis/spec/daemon/index.md`、`.trellis/spec/testing/index.md`、`docs/DESIGN.md` 的 Token 纪律。
- 不修改 `resources/**`；不新增依赖（`jszip` 已在依赖里）。

## 1. daemon：`src/main/daemon/packs.js`

1. 常量：`PACK_FORMAT`、`PACK_FORMAT_VERSION`、上限（200 / 1 MiB / 5 MiB）、扩展名白名单。
2. `readManifest(dir)`：解析 + 逐字段校验；错误 `{code, message, file}`。
3. `walkPackDir(dir)`：`lstat` 遍历 → 拒绝符号链接/隐藏项/非法扩展名/路径穿越/超限；返回文件清单（相对路径 + 大小）。
4. `extractZip(source, staging)`：JSZip 逐条校验路径、大小、链接属性；拒绝 `prompts/` 并提示 v1 不支持；解压后走 `walkPackDir` 再校验一次。
5. `inspectPack(source)`：目录/zip 统一进 staging → `readManifest` → `walkPackDir` → 调 `loadExpertDir(staging, id, "pack")` 验证专家合法性 → 返回
   `{ok:true, preview:{manifest, expert:{id,name,displayName,profession,description}, skills:[{name,description}], agents:n, files:n, bytes, connectors, conflicts:{existing, existingIsPack, overridesBuiltin}}}`；失败返回 `{ok:false, errors:[...]}` 并清理 staging。
6. `installPack(source)`：inspect → 冲突判定 → staging 加 `_pack.json` → 原子 rename 到 `packs/<id>`（旧版本先备份，失败回滚）。
7. `uninstallPack(id)`：校验 id 与 `_pack.json`；删除；返回结果。
8. `listPacks()`：扫 `packs/*/_pack.json`，返回 `{id, version, name, installedAt, source}`。
9. `exportPack({name, destPath})`：只接受 `configDir/experts/<name>` 或 `packs/<name>`；不收 `resources/experts`；生成 manifest（id/name/version/description/author）+ `files` sha256 清单 → JSZip 写 zip（失败删半成品）。

## 2. 加载入口

- `experts.js` 的 `loadExperts(resourcesDir, userDirs, ...)` 改为接受**用户目录数组**（保持向后兼容：字符串也接受）；
  `loadExpertsDir(configDir/packs, "pack")` 作为中间来源，`configDir/experts` 最后覆盖。
- `loadExpertDir` 的 `source` 增加 `"pack"`；从 `_pack.json` 读 `packId`/`packVersion` 附到返回值。
- `session-files.js` 的 `loadExpertsNow()` 传数组；`listExperts` 投影补 `packId` / `packVersion`（缺省不带字段）。

## 3. IPC 与主进程

- `src/shared/ipc.js`：新增 5 个 daemon 通道 + 2 个 dialog 通道。
- `src/main/daemon/session-files.js`：注册 5 个 handler（结果对象，不 throw）。
- `src/main/index.js`：`pickPackFile`（openFile，`filters: [{name:"能力包", extensions:["zwpack"]}]`）、
  `pickPackSave`（saveFile，默认 `packs/<id>-<version>.zwpack`）。
- `src/preload/index.js`：暴露 7 个方法。

## 4. 渲染层最小入口

- `ExpertsView`：头部加「导入能力包…」→ `pickPackFile()` → `inspectPack()` → 预览弹窗。
- `PackPreviewModal`：按 design §5 布局；错误态逐条列；安装调用 `installPack()`；成功后
  `onToast` + 重新 `reloadExperts()`；Esc 关闭、`useModalFocus`。
- `ExpertDetailModal`：
  - `source === "pack"`：显示「来源：能力包 <packId>@<packVersion>」+「移除能力包」（确认句包含专家名）；
  - `source === "user"`：显示「导出能力包…」→ `pickPackSave()` → `exportPack()` → toast；
  - `source === "builtin"`：不显示导出（tooltip：内置专家可能含第三方内容，暂不支持导出）。
- CSS：复用 `.hooks-import-*` 与 `.ex-modal-*` 的语汇，新增 `.pack-preview-*`；只用 Token，
  亮暗两主题；不新增字号档；动效用 `var(--ease-standard)`。

## 5. 测试

1. `tests/unit/capability-pack.test.mjs`
   - 每个用例独立 `ZEROWORK_CONFIG_DIR`（参照 `theme-preferences.test.mjs`）。
   - 用例：合法目录导入 / zip 导入 / manifest 缺字段 / id 不一致 / 路径穿越 / 绝对路径 /
     符号链接 / 隐藏文件 / 脚本扩展名 / 超体积 / 覆盖旧版本 / 同名非能力包拒绝 /
     导出后再导入 / hash 篡改拒绝 / 卸载。
   - 断言用 `loadExpertsNow` 或直接 `listExperts` 同源函数（`experts.js` 可导入 `loadExperts`）。
2. `tests/e2e/gui-pack.mjs`
   - harness `name: "pack"`；stub `dialog.showOpenDialog`（参照 `dialog-native.mjs`）；
   - 步骤：打开专家页 → 截图初始 → 点导入 → 预览弹窗截图（亮/暗）→ 安装 → toast →
     专家出现 → 详情 → 移除 → 专家消失；
   - 断言等待全部用 `waitUntil`；每步有可失败谓词。
3. 反向验证（必须实际执行并还原）：
   - 从 `loadExpertsNow` 的目录数组里去掉 packs 目录 → e2e「安装后专家出现」必红；
   - 关掉 `walkPackDir` 的符号链接检查 → 对应单测必红。

## 6. 文档与门禁

- `CHANGELOG.md` `[Unreleased]` → **新增**：能力包（一句话说清「纯文件、预览、不执行代码」）。
- `docs/USAGE.md`：新增「能力包」小节：格式、怎么导入/导出、连接器为什么只声明、
  内置专家为什么不支持导出、v1 不支持提示词模板。
- `.trellis/spec/`：若发现可复用规则（zip 校验、包不执行代码），回写到 daemon 或 testing 规范。

## 7. 验证命令（按顺序）

```bash
npm run check:unicode
npx vitest run tests/unit/capability-pack.test.mjs
npm test
npm run build
node tests/e2e/gui-pack.mjs
node tests/e2e/gui-smoke.mjs
npm run lint:all
```

## 8. 提交与 PR

- 提交拆分：① daemon + IPC + 加载入口；② 渲染层入口与预览弹窗；③ 测试 + 文档。
- PR 正文写：为什么（竞品对照）、格式与安全边界、偏离 design 之处、反向验证结果。
- 合并前 `CI 总览` 全绿；合并后归档任务并更新 Roadmap（#420 → 已完成）。
