# 反向验证记录（2026-10-16）

「反向验证」= 把一条**真实的不变量**故意注掉/写反，确认**恰好**相关用例变红、
恢复后复绿。它守的是「这些断言不是恒真的」—— 恒真的断言比没有断言更糟。

命令一律 `npx vitest run tests/unit/watch-policy.test.mjs`，
注入前先把文件备份到 `/tmp/watch-policy.bak*.js`，验证完**从备份整份还原**
（不用反向 patch —— 反向 patch 少改一个字就静默还原不干净）。

---

## 注入 1：收敛取反（`stricterTier` 取更宽的那个）

改动：`rankOf(a) <= rankOf(b) ? a : b` → `rankOf(a) >= rankOf(b) ? a : b`

这把「**只能更严，不能更宽**」这条本功能的核心不变量直接写反了。

结果：**7 条变红 / 29 条仍绿**

```
× 规矩声明「可写」而全局是「只读」时，收严成只读并给出告警
× 规矩声明「可写」而全局是全权时，收严成可写（规矩本身生效）
× 规矩声明「只读」而全局是全权时，只读生效（收严是允许的方向）
× 没有任何一条路径能把档位调得比全局更宽
× ② 只读档位下写操作被拒，rule = tier
× 意图缺失或畸形时放行（本模块只做额外拒绝，不接管既有判定）
× boundaryFor 把只读执行与告警带进运行记录
```

结论：**恰好**是「档位收敛」那一族的用例，解析类与运行记账类的用例不受影响 ——
说明断言确实钉在了这条不变量上，而不是顺带被别的东西带着红。

## 注入 2：老记录编造事实（`summarizeRun` 的缺 boundary 分支）

改动：`{ known: false, state: "unknown" }` → `{ known: true, state: "ok" }`

这把「**老运行记录没有边界信息时如实说不知道**」写成了「编一个空的出来」。
用户会以为那条老记录「有边界、只是没用上」，是典型的静默失效。

结果：**1 条变红 / 35 条仍绿**

```
× 老记录没有 boundary 时如实说不知道，不编一个空的出来
```

结论：**只有**这一条变红 —— 与它无关的 35 条全绿，说明这条断言的判据是精确的。

## 还原

两次注入后都从 `/tmp/watch-policy.bak*.js` 整份还原，`36 passed (36)` 复绿。

---

## 注入 3：`check-daemon-graph` 的③自由变量检查（本轮新增的那条性质）

这条检查是**补一次真实事故**加的：给 `session-files.js` 加值守边界时，
`boundaryFor` 与 `evaluateWatchBoundary` 两个被调用的函数忘了写进 `import`。
它能漏过三道关口不是偶然 —— 单元测试不 import daemon 模块、ESM 具名绑定在构建期不检查、
而 `src/main/daemon/**` 在 ESLint 配置里是**整目录排除**的（`no-undef` 从不检查它）。

改动：删掉 `src/main/daemon/session-files.js` 里的 `boundaryFor,` 这一行 import
（它在该文件里被真实引用）。

结果：**精确报出那一条**，退出码 1

```
daemon 模块：50 个（其中 3 条 import 指向 daemon 目录之外）
  ✗ session-files.js 引用了 boundaryFor，但模块里既没导入也没声明它

模块图不闭合：1 处问题
```

还原：从 `/tmp/sf.bak` 整份还原，两条性质**双双复绿**（exit 0），
`git diff --stat src/main/daemon/session-files.js` 无输出（确认没有残留）。

结论：这条检查**不是恒真的** —— 它确实能抓住当初漏掉的那一类错误。
