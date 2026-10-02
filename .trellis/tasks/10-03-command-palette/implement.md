# 执行清单：命令面板（⌘K）

> 设计见 `design.md`，需求见 `prd.md`。**按顺序做，每步都有可验证的产出。**
> 分支：`feat/command-palette`，一个任务一个 PR。

## 步骤

### 0. 开工前

- [ ] `git switch main && git pull` → `git switch -c feat/command-palette`
- [ ] 确认基线绿：`npm run lint:all && npm test`
- [ ] 记下基线：`npm run test:gui` 的用例数与通过数（后面要「一条不少」）

### 1. 纯逻辑模块 + 单元测试（先写测试）

- [ ] 新建 `src/renderer/src/command-palette-core.js`
      —— 导出 `KIND_WEIGHT` / `matchRank` / `rankEntries`，**不含 React、不碰 DOM**
- [ ] 新建 `tests/unit/command-palette-core.test.mjs`，覆盖 `design.md` §10 单元部分
- [ ] **反向验证**：把 `rankEntries` 的三级排序键砍成两级，跑测试确认**有**用例变红；
      把结论（哪几条变红）写进测试文件头部注释，然后改回来
- [ ] `npx vitest run tests/unit/command-palette-core.test.mjs` 全绿

> 先写测试的理由：排序的优先级链是这个功能的**全部技术含量**，
> 而它在界面上表现为「顺序有点怪」——只有单测能锁住。

### 2. 组件与接线（`app.js`）

- [ ] `import { rankEntries, KIND_WEIGHT } from "./command-palette-core.js";`
      （放文件顶部；与 `app.js:29537` 引入 katex 同款静态 import）
- [ ] 声明式**动作表**常量：`{ id, kind, title, subtitle?, keywords, hint?, run }`
      —— 动作全部调用既有 `window.kami.*` 或既有 setState，**不新增 IPC**
- [ ] `CommandPalette` 组件（结构见 `design.md` §4），`open=false` 时 `return null`
- [ ] `App()` 里：`⌘K` 全局监听（照 `⌘.` 的写法）+ `paletteOpen` state
- [ ] 侧栏加常驻入口（在「新建任务」下方，带 `⌘K` 提示）
- [ ] 实体条目映射：`taskList` / `groupMetas` / `experts` + 首次打开时拉
      `skillsSnapshot` / `mcpConfigGet` / `listAutomations`（缓存进 ref）
- [ ] **未开放导航项（`ready: false`）不生成条目**
- [ ] `app.css` 加 `.command-palette` / `.command-palette-input` / `.command-palette-foot`
      三处样式，**只用既有 token**（`design.md` §6 的取值表）
- [ ] `prefers-reduced-motion` 关停 + `docs/DESIGN.md` §10.3 / §10.3.1 登记

### 3. GUI 端到端测试

- [ ] 新建 `tests/e2e/command-palette.mjs`，覆盖 `design.md` §10 的 ①②③④⑤⑥⑦⑧⑨⑩⑪
- [ ] `package.json` 加 `test:gui:palette`，并挂进 `test:gui` 与 `test:e2e` 两条链
- [ ] **反向验证**（至少一条）：把「未开放项过滤」去掉，确认 ⑥ 变红；
      把面板 `open=false → null` 改成常驻，确认相关用例仍合理。记录结论

### 4. 文档

- [ ] `CHANGELOG.md` 的 `[Unreleased]` → 「新增」，写清它替用户省掉了什么
- [ ] `docs/USAGE.md` 写快捷键（⌘K / Esc / ↑↓ / Enter）与「Esc 直接关闭不做两级」的口径
- [ ] `docs/DESIGN.md` 登记面板动效（§10.3）与 reduced-motion 关停（§10.3.1）
- [ ] 若新增了受控例外，按 §5 登记编号 —— **本设计不需要任何布局属性过渡，预期为零**

### 5. 验收（全绿才算完成）

```bash
npm run lint:all
npm test
npm run build && npm run check:renderer-assets
npm run test:gui:palette
npm run test:gui              # 既有用例一条不少
npm run check:docs            # 改过 docs/ 必跑
```

- [ ] 逐条对照 `prd.md` 的 Acceptance Criteria 打勾
- [ ] **中文内容 U+FFFD 扫描**（`AGENTS.md`「中文内容质量」的脚本），本次改了多处中文文档
- [ ] 截图人工看一眼：`artifacts/command-palette/` 的浅色与深色两张

### 6. 提交与 PR

- [ ] 小批量提交（先 core+单测，再组件+GUI，再文档），**不要攒成一个大提交**
- [ ] 提交信息走约定式提交，正文写**为什么**；**信息里不出现反引号**（用 `git commit -F`）
- [ ] PR 标题符合约定式提交（squash 后它就是提交信息）
- [ ] PR 正文写进临时文件用 `--body-file`，**含 `Closes #103`**
- [ ] 创建后复核：`gh pr view <N> --json body --jq '.body | test("Closes #[0-9]+")'` → `true`
- [ ] `gh pr checks <N>` 等 `CI 总览` 绿
- [ ] `gh pr merge <N> --squash --delete-branch`，**判断成败不用管道接 tail/head**
- [ ] 合并后复核 Issue #103 真的关闭了；更新 Roadmap（Issue #21）

## 回滚点

| 点 | 回滚动作 |
| --- | --- |
| 步骤 1 后 | `command-palette-core.js` + 单测是自包含的，删掉即回到基线 |
| 步骤 2 后 | `app.js` / `app.css` 的改动集中在一个组件 + 三处样式，`git checkout -- src/renderer` 即回到基线 |
| 步骤 3 后 | GUI 用例与 `package.json` 的挂链单独一个提交，可单独 revert |

## 明确不做（防止实现时范围膨胀）

详见 `design.md` §11：frecency、收藏置顶、类型前缀、第二层动作面板、
快捷键管理页、跨内容全局搜索 —— **一个都不进这一版**。