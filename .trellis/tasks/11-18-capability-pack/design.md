# 设计：能力包 v1（#420）

## 1. 包格式

目录布局（`.zwpack` 是同一布局的 zip）：

```
manifest.json
expert.md
README.md            # 可选，仅展示
skills/<name>/SKILL.md ...   # 可选，专家的私有技能
agents/<name>.md             # 可选，团队型专家的成员人格
```

`manifest.json`：

```json
{
  "format": "zerowork-pack",
  "formatVersion": 1,
  "id": "meeting-minutes",
  "version": "1.0.0",
  "name": "会议纪要专家",
  "description": "把录音转写整理成可执行的纪要",
  "author": "someone",
  "domain": "日常办公",
  "minAppVersion": "0.24.0",
  "connectors": [
    { "id": "github", "type": "http", "description": "读取仓库 issue" }
  ],
  "files": [
    { "path": "expert.md", "sha256": "…", "size": 1234 }
  ]
}
```

- `id` 必须等于专家目录名，也等于 `expert.md` frontmatter 的 `name`（复用现有专家校验）。
- `files` 由导出生成，导入时**若存在则逐条校验**（缺文件/哈希不符即拒绝）；手工包可省略。
- `connectors` **只是声明**：预览里展示，绝不写 `mcp.json`，不携带任何凭据。
- `minAppVersion` 可选；存在且高于当前版本时拒绝并给出两边版本号。

## 2. 安全校验（拒绝一律带 code + message + file）

| 检查 | 规则 |
| --- | --- |
| 条目数 | ≤ 200 |
| 单文件 | ≤ 1 MiB（解压后） |
| 总体积 | ≤ 5 MiB（解压后） |
| 路径 | 禁止绝对路径、`..` 段、盘符、NUL；统一 `/` 后校验 |
| 链接 | 目录来源用 `lstat` 拒绝符号链接；zip 来源拒绝 external-attr 指向链接的条目 |
| 隐藏条目 | `.` 开头的文件/目录一律拒绝 |
| 扩展名白名单 | `.md .txt .json .yaml .yml .csv .png .jpg .jpeg .webp .gif .pdf` |
| 大小写 | 归一化后判重，避免 Windows 上覆盖 |
| 结构 | 顶层只允许 `manifest.json`、`expert.md`、`README.md`、`skills/`、`agents/`；出现 `prompts/` 明确提示「v1 不支持」 |
| 专家合法性 | 安装前对 staging 目录调用现有 `loadExpertDir()`，复用全部专家规则（frontmatter、quickPrompts=3、tags=3、技能非空等） |

zip 解压到 `getConfigDir()/.pack-staging/<id>-<pid>-<ts>/`，校验在 staging 上做；
失败删除 staging，不碰安装目录。

## 3. 安装 / 卸载 / 列表

- 安装位置：`getConfigDir()/packs/<id>/`（目录本身就是专家目录，`expert.md` 在根）。
- 安装元数据：`<id>/_pack.json` = `{ manifest, installedAt, source, files }`（source 为来源路径，
  仅本机可见；不写入专家正文）。
- 冲突：
  - 目标存在且有 `_pack.json` → 原子替换（先 rename 到备份，装好再删备份；失败回滚）。
  - 目标存在但没有 `_pack.json` → 拒绝（"同名目录不是能力包，先手动处理"）。
  - 与内置专家同名 → 允许（用户覆盖内置），预览里标 `overridesBuiltin: true`。
- 加载：`loadExperts()` 增加一个用户来源目录 `configDir/packs`，合并顺序
  `builtin → packs → configDir/experts`（后者覆盖前者；与现有「用户覆盖内置」一致）。
  每个专家的 `source` 增加 `"pack"`，并从 `_pack.json` 带出 `packId`/`packVersion`。
- 卸载：只接受有 `_pack.json` 的目录；`rm -rf` 后返回 `{ok:true, id}`；不存在返回 `{ok:false, reason:"not-installed"}`。
- 导出：只允许 `configDir/experts/<name>`（用户专家）或已安装能力包；内置专家拒绝
  （再分发授权未确认）。写 zip 到调用方给的目标路径，manifest 里生成 `files` 哈希清单。

## 4. 模块与 IPC

新模块 `src/main/daemon/packs.js`（避免继续膨胀 `session-files.js`）：

```
inspectPack(sourcePath) -> { ok, preview? , errors? }
installPack(sourcePath) -> { ok, expert?, errors? }
uninstallPack(id) -> { ok, id?, reason? }
listPacks() -> { packs: [...] }
exportPack({ name, destPath }) -> { ok, path? , errors? }
```

- `packs.js` 只依赖 `experts.js`（`loadExpertDir`）、`config-paths.js`、`jszip`；
  `session-files.js` 注册 IPC 并调用；无顶层跨模块副作用（daemon 规范）。
- `src/shared/ipc.js` 新增：`packInspect`、`packInstall`、`packUninstall`、`packList`、`packExport`。
- 文件选择在**主进程**（与 `pickSkillDirectory` 同层）：
  `pickPackFile`（openFile，过滤 `.zwpack`）、`pickPackSave`（saveFile，默认名 `<id>-<version>.zwpack`）。
- preload 暴露：`inspectPack`、`installPack`、`uninstallPack`、`listPacks`、`exportPack`、
  `pickPackFile`、`pickPackSave`。

## 5. 渲染层（最小入口）

- 专家 tab 头部：`导入能力包…` 按钮（`mini-btn`，IconPlus）→ 选文件 → 预览弹窗。
- 预览弹窗（新 `PackPreviewModal`）：
  - 专家头像 + 显示名 + 职业 + 简介；作者 / 版本 / 领域；
  - 技能清单（名称 + 描述）、成员数（团队型）、文件数与总体积；
  - 连接器声明列表 + 一句「仅声明，不会自动安装；请到设置 → 连接器手动配置」；
  - 冲突提示（同名非能力包 / 覆盖内置 / 将替换旧版本）；
  - 错误态：逐条列出 code + 文件 + 说明；
  - 按钮：取消 / 安装；安装中禁用；成功 toast「已安装能力包 <name>」。
- 专家详情（`ExpertDetailModal`）：
  - `source === "pack"` 时显示「来源：能力包 <id>@<version>」与「移除能力包」（二次确认）。
  - 用户专家显示「导出能力包…」；内置专家不显示（附 tooltip 说明再分发授权）。
- 视觉：复用 `.ex-*` / `.hooks-import-*` 的卡片与预览语言；亮暗一致；键盘可达（Esc 关闭、
  初始焦点在标题、焦点陷阱用 `useModalFocus`）。

## 6. 测试策略

- 单测 `tests/unit/capability-pack.test.mjs`：
  - 每个用例独立 `ZEROWORK_CONFIG_DIR` 临时目录；
  - manifest 校验矩阵、路径/链接/扩展名/体积拒绝、安装→listExperts→卸载、导出→再导入 roundtrip、hash 篡改拒绝；
  - 夹具在临时目录现场生成（不提交二进制 zip）。
- e2e `tests/e2e/gui-pack.mjs`：
  - stub `dialog.showOpenDialog` 返回夹具目录；
  - 点「导入能力包…」→ 等预览弹窗 → 截图（亮/暗）→ 安装 → toast → 专家页出现 → 详情移除 → 消失；
  - 反向验证：把 `packs` 来源从 `loadExperts` 拿掉，e2e 必红；还原后全绿。
- 单测覆盖 zip 路径穿越（用 JSZip 现场构造）。

## 7. 取舍与偏离

- **安装到 `packs/<id>/` 而不是 `experts/<id>/`**：与 Issue 一致，且让「用户手工专家」
  与「能力包」来源可区分；卸载只碰 `packs/`，不会误删用户目录。
- **v1 不装提示词模板**：模板是全局 `prompts/` 命名空间，需要额外的归属与卸载追踪；
  本轮明确拒绝并提示，避免「静默忽略」。
- **连接器只声明不安装**：自动写 `mcp.json` 等于替用户授权外部工具，违背权限模型。
- **导出拒绝内置专家**：`resources/experts/**` 含第三方内容，再分发授权未确认前不能打包分享。
- **不新增沙箱/权限通道**：导入只写配置目录，不需要放宽任何约束。
