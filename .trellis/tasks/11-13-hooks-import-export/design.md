# 技术设计：hooks 导出 / 导入

## 一、纯逻辑（`src/main/daemon/hooks.js`）

```js
HOOK_IMPORT_MAX_BYTES = 128 * 1024

parseHookImportText(text)                 // 文本 → JSON 值；非法文本/超限抛可诊断错误
mergeHookConfigs(existing, incoming)      // 按 id 合并：同 id 覆盖原位置，新 id 追加；不修改入参
previewHookImport(raw, existing)          // {
                                          //   fatal?: string,
                                          //   incoming: Hook[],
                                          //   merged: Hook[],
                                          //   errors: { index, message }[]
                                          // }
```

- `parseHookImportText` 用 `Buffer.byteLength(text,'utf8')` 判上限；JSON 解析失败时把原因带上
- `previewHookImport` 复用 `parseHookConfig(raw, "导入文件")`：
  - `fatal`（不是数组 / 没有 hooks 数组 / 超过 32 条）→ 整份拒绝
  - 逐条错误保留原始 index（`第 N 条`）
  - **重复 id** 额外报一条（`导入文件里有重复 id：xxx`）——读侧不查重、写侧查重，
    预览必须提前说清，免得用户点「导入」才看到错误
- 合并只接受已规范化的 hook（daemon 内部调用），是纯函数，便于单测

## 二、IPC（`src/shared/ipc.js` / preload / `session-files.js`）

新增一个通道：

```js
INVOKE.importHooks = "hooks:import"   // (text: string, apply: boolean) => result
```

- `apply !== true`：只返回预览 `{ fatal?, incoming, merged, errors }`，不写盘
- `apply === true`：若 `fatal` 或 `errors.length > 0` → 抛错（不落盘）；
  否则 `assertHookConfig(merged)` → `writePreferences({ ...readPreferences(), hooks })` →
  返回 `{ hooks, imported: incoming.length }`
- 合并的基准是**当前已保存的用户级 hooks**（`readHooksConfig().config.hooks`），
  不是渲染层传来的旧列表 —— 避免设置页开着时别处改动被覆盖
- preload 暴露 `previewHooksImport(text)` / `importHooks(text)`

## 三、导出

纯渲染层：`{ version: 1, hooks: data.user }` → Blob 下载，文件名 `zerowork-hooks.json`。
不经过 daemon —— 数据来自 `hooks:get`，没有第二份真相；形状由单测（daemon 侧
`parseHookConfig` 能原样读回）与 GUI 往返共同保证。

## 四、UI（`src/renderer/src/app.js` + `app.css` §48）

- Hooks 分组用户级区域底部：`导出` / `导入` 两个按钮（复用 `.starter-action` / `.chip-edit-add` 风格）
- 导入用**常驻隐藏 `<input type="file">`**（aria-label「选择 hooks 导入文件」），
  点击按钮触发；文件读文本后调预览 —— 相比临时创建 input，这条可被 GUI 测试用
  `setInputFiles` 驱动，且对读屏器更友好
- 预览弹窗：
  - 头部：`导入预览 · N 条`，文件里若有 1 条以上非法，标题旁标红
  - 列表：每条显示事件 / id / 命令首行；非法条目显示「第 N 条：原因」
  - 底部：`取消` / `导入 N 条`；有错误或 fatal 时导入按钮禁用并说明原因
- 成功后 `refresh()` + toast「已导入 N 条（合并后共 M 条）」
- 导出成功 toast「已导出 N 条 hooks（文件含本机命令，分享前请确认）」
- 样式只追加 §48，复用既有 token；窄窗折行、暗色、无动画

## 五、安全

- 导入文件是不可信输入：整份校验通过才落盘；**不执行**
- `hooks:import` 的 `apply` 由渲染层传，但 daemon 侧无论 `apply` 与否都先校验；
  `apply` 不改变校验强度
- 导出只含用户级 hooks；信任列表是本机路径，不导出
- `SECURITY.md` hooks 段补两句：导出文件含本机命令；导入按不可信输入处理

## 六、测试

### 单测（`tests/unit/hooks.test.mjs` 追加）

- `mergeHookConfigs`：同 id 覆盖且位置不变；新 id 追加；不修改入参
- `parseHookImportText`：合法对象 / 裸数组；非法 JSON 的报错含原因；超过 128KB 报错
- `previewHookImport`：逐条 index 正确；重复 id 被指出；fatal 结构（hooks 不是数组）

### GUI（`tests/e2e/gui-hooks.mjs` 扩展）

1. 导出：覆写 `URL.createObjectURL` 捕获 Blob → 点「导出」→ 断言 JSON 形状与不含
   `trustedWorkspaceHooks`
2. 清空用户级 hooks（走 daemon `setHooksUser([])`）→ 用 `setInputFiles` 导入刚导出的文件 →
   预览弹窗出现 → 确认 → 列表恢复原条目
3. 导入含非法 matcher 的文件 → 预览标出「第 1 条」与原因，导入按钮禁用
4. 截图：预览弹窗（浅/暗）

## 七、文档

- `SECURITY.md`：导出文件含命令、导入按不可信输入处理
- `CHANGELOG.md` `[Unreleased]` → 新增
- 设置页文案说明「导出只含用户级 hooks，不含工作区信任列表」

## 八、回滚

纯新增入口，不改变既有配置读取 / 执行路径；删掉按钮与通道即可回退。
