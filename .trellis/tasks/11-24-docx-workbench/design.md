# 设计：docx 工作台（#482）

## 1. IPC 路由

`session-files.js` 的 `applyDocEdit`：

```js
const proposal = readProposal(id);
if (proposal.kind === "docx") {
  const engineDir = join(getResourcesDir(), "docx-engine");
  const env = await ensurePythonRuntime(defaultPythonRuntimeOptions({ engineDir, homeDir: homedir() }), defaultSpawn);
  if (env.status !== "ready") throw 可读错误（引导到内置运行时；文件未修改）;
  return applyDocxProposal(id, { python: env.python, engineDir });
}
return applyProposal(id, hunkIds);
```

- `hunkIds` 对 docx 忽略（可以是 `[]`），但类型校验保留。
- ensure 失败也要给「文件未修改」的明确文案。

## 2. UI（DocEditDetail）

- 读回后 `const isDocx = detail.kind === "docx"`。
- docx 分支：
  - 头部同款；meta 的 `+N −M` 换成「1 处替换」；
  - 主体两块（复用 diff 底色，不新增颜色档）：
    - 「替换前」：`diff-del` 底 + `−` 符号 + sr-only「替换前：」；
    - 「替换后」：`diff-add` 底 + `+` 符号 + sr-only「替换后：」；
  - 一条说明：「v1 只替换正文里这一处文字；不保留 Word 原生修订痕迹。接受前会先把当前文件存成版本。」
  - 无逐段勾选、无全选/全不选、无「未勾选丢弃」提示。
  - 接受按钮文案「接受替换（1 处）」；`canAccept = !stale`；调用 `applyDocEdit(id, [])`。
  - 过期条与文本建议一致。
- 文本分支逻辑不动。

## 3. 纯逻辑 `doc-edit-core.js`

- `isDocxProposal(proposal)`。
- `formatProposalStats(entry)`：`kind==="docx"` → `1 处替换`；否则保持 `+N −M`。
- `acceptDocxSuccessText(name)`：`已替换「file」正文中的 1 处文字`。
- 单测覆盖上述三项与文本分支不变。

## 4. 测试

- 单测：core 新函数；现有文本工作台 e2e 回归。
- 最小 e2e（gui-doc-edit-base 扩展或新 section）：用 `buildDocxProposal` + `saveProposal`
  种一条 docx 建议（基于夹具 a-styles 的副本），打开工作台 → 看到替换前/后 →
  接受（真实 python 引擎）→ 目标文字变化、建议消失、文件历史有旧版本。
  若真实引擎在 CI 的 e2e 环境不稳定，可在 #483 统一处理并在此显式 skip 说明。

## 5. 取舍

- **接受时才 ensure 运行时**：生成建议不需要 Python（#481 已如此）；只在真正写回时启动。
- **不显示 part 选择**：v1 只支持正文；显示 `word/document.xml` 只作说明。
- **一次替换 vs 逐段**：docx v1 是「一处文字替换」，不做虚假的逐段 UI。
