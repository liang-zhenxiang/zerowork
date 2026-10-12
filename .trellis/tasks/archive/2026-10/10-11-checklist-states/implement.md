# 执行清单

## 1. 代码

- [ ] `OnboardingChecklist` 把 `return null` 拆成三态：
  - [ ] `error !== undefined` → `.home-guide` 里的错误行（图标 + 原因 + 重试），`role="alert"`
  - [ ] 数据未到位 → `.home-guide` 里的骨架行（3 行 + 说明行），`role="status"` + `aria-label`
  - [ ] `allDone && !expanded` → 现有小按钮，不动
- [ ] 骨架与真行**同尺寸**：文字位用 `minHeight: 1lh` 的 flex 容器（照侧栏 `TASK_SKELETON_TITLE_STYLE`）
- [ ] `app.css`：只加错误态要用的两个声明（危险色图标 / 危险色文字），不新增盒子、不新增颜色字面量

## 2. 测试（新增 `tests/e2e/home-checklist-states.mjs`）

- [ ] harness 名 `home-checklist-states`（独立隔离目录与截图目录）
- [ ] 触发手段：**切视图再回首页**（清单只在挂载与 cwd 变化时拉数据）——
      去「专家·技能·连接器」再点「新建任务」回来
- [ ] ① 读失败：把 `kami.settingsSnapshot` 打桩成 reject → 触发 → 断言
      `.home-guide[role=alert]` 存在、文案含注入原因、有「重试」按钮 → 截图
- [ ] ② 加载中：把打桩换成一个**由测试持有的 promise** → 点「重试」→ 断言骨架
      （`[role=status]` + 骨架条 + 没有真实行文案）→ 截图
- [ ] ③ 恢复：resolve 那个 promise → 断言真实行回来了（同一块区域被填上）→ 截图
- [ ] 反向验证：把错误分支改回 `return null` → **只有 ① 变红**，改回后全绿
- [ ] 接进 `package.json` 的 `test:gui` 链

## 3. 收尾

- [ ] 更新 `onboarding.mjs` 里那句「不能拿 .home-guide 不见了当完成证据」的注释
      （三态分开后歧义消失，注释要跟上）
- [ ] CHANGELOG `[Unreleased] → 修复` 记一条（写清「此前错在哪、有什么后果」）
- [ ] 真跑一次 GUI 用例 + 看截图（深浅两套）
