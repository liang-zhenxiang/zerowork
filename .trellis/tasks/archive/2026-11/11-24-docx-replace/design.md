# 设计：docx_replace（#481）

## 1. 工具

`src/main/daemon/docx-replace.js`：

```js
createDocxReplaceTool({
  cwd, engineDir, homeDir,
  getDocEditMode: () => boolean,
  getSessionId: () => string,
  docsDir?,               // 测试注入
  ensure?, patch?,        // 运行时与引擎注入
  onAudit?, onBlocked?    // 给宿主/审计
})
```

`execute` 顺序：

1. 校验参数（`path/find/replace` 非空字符串；`find !== replace`）。
2. `resolveInsideWorkspace(cwd, path)`（复用 doc-edits）；扩展名 `.docx`；`stat` 存在、普通文件、≤ 50 MiB。
3. 读字节、`sha256`。
4. **修订模式开**：`buildDocxProposal({...})` + `saveProposal`，返回工具成功回执
   `{ type:"docx_replace_suggestion", id, path, find, replace, message }`；不 ensure Python。
5. **关闭**：`ensurePythonRuntime` → `recordBinaryVersion({ path, bytes, sessionId, tool:"docx_replace" })`
   （失败即中止）→ `patchDocx({ python, engineDir, inputPath=path, outputPath=path, find, replace })`
   → 审计 `file/allowed`（只记文件名/字节变化，不记正文）→ 返回成功回执。
   引擎错误按 `DocxPatchError.code` 原样带给模型；审计 `file/failed`。

工具描述必须写清 v1 边界（正文单 run、唯一命中；不支持 Word 修订痕迹），并提示
「修改前先读文件确认原文逐字一致」。

## 2. Proposal 模型（doc-edits.js）

- 新增 `buildDocxProposal`（id、kind:"docx"、path、baseSha256(文件字节)、part、
  find、replace、sessionId、createdAt、toolName）。
- `parseProposal` 按 `kind` 分支：docx 校验上述字段（不再要求 before/after/ops/hunks）；
  `summarize` 对 docx 返回 `{ kind:"docx", hunkCount:1, added:1, removed:1, ... }`
  （列表只用来显示「1 处替换」）。
- `checkFreshness` 支持 docx：按文件字节 hash 与 base 比较；文件不存在→missing。
- `delete/reject` 复用；`applyProposal` 文本路径不变。

## 3. 应用 docx 建议

`applyDocxProposal(id, options)`（同模块，供 #482 的 IPC 调用）：

1. 读建议；读当前字节；hash 必须等于 baseSha256，否则审计 failed + 抛「原文已变化」。
2. `recordBinaryVersion` 当前字节（失败中止）。
3. `patchDocx(in=out=path)`。
4. 审计 allowed；删除建议；返回 `{ path, replaced:1 }`。

## 4. 接线

- `session-files.js`：在 `createHost` 与无人值守的工具装配处注册（与 docx_convert 同档）；
  `getDocEditMode` 读桶状态；`getSessionId` 用 adoptedSessionId。
- `src/main/daemon/command-exec.js` 的 `MUTATING` 加入 `docx_replace`（按 `path` 判定）。
- `resources/modes/craft.md` 的 tools 白名单加入 `docx_replace`。
- IPC：`readDocEdit`/`listDocEdits` 已存在；#482 增加 apply 路由。本 Issue 不改 UI。

## 5. 测试

`tests/unit/docx-replace.test.mjs`：参数/路径/扩展名/大小；修订模式开（文件不变、建议字段、
不调用 ensure）；关闭（注入 fake patch/ensure/version/audit，验证顺序与失败中止）；
权限 MUTATING 断言（纯集合）；proposal parse/summarize/freshness（二进制 hash）。

## 6. 取舍

- **修订模式开不启动 Python**：生成建议不需要引擎；环境坏时仍能记录建议。
- **直接写回也在工具内完成**：与 `docx_convert` 一样是受控 spawn；权限门按 path 判定。
- **v1 只动正文部件**：页眉页脚/表格不在本轮；错误里给出「请在 Word 手动修改」。
