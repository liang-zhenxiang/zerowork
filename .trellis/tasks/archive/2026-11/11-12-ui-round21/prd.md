# PRD · 第二十一轮十连——「可访问性与包容」

任务目录：`.trellis/tasks/11-12-ui-round21/`　分支：`feat/ui-round21`　issue：#370　日期：2026-11-12

## 背景

二十轮后视觉与功能完备。第二十一轮聚焦**可访问性**：读屏器、键盘、低视力、
减少动效——让界面对所有人可用。

## 十项清单（先逐项查重）

| # | 功能 | 说明 | 查重/落点 |
| --- | --- | --- | --- |
| 1 | 读屏地标 | main/nav/aside 地标角色补齐 | index.html + app.js 结构 |
| 2 | 跳转主内容 | Tab 首个到达「跳到主内容」链接（视觉隐藏，聚焦显现） | index.html |
| 3 | 图片/图标 alt | icon-only button aria-label 审计补漏 | 全站扫描 |
| 4 | 色对比体检 | 文本对比 <4.5:1 组合修复（token 层改） | app.css token |
| 5 | 动效偏好深审计 | 所有 animation 补 reduced-motion 关停 | app.css 扫描 |
| 6 | 表单关联 | input 关联 label；错误 aria-describedby | 表单处逐个补 |
| 7 | 快捷键避让 | 不劫持读屏常用键（已有 Meta 系，审计确认） | keydown 处审计 |
| 8 | 200% 缩放 | 浏览器字号 200% 布局不碎 | CSS 相对单位抽查 |
| 9 | 焦点可见 | :focus-visible 加粗一致（§22 已有，统一） | app.css |
| 10 | 语言标注 | html lang、局部语言切换标注 | index.html |

## 验收标准

- 每项 build 过 + DOM 断言/截图 ≥1（tests/e2e/ui-round21-shots.mjs）
- lint:all / npm test / 既有 GUI 用例全绿
- CHANGELOG [Unreleased]；PR Closes #370；CI 绿合并；guard release；交付截图

## 硬约束（沿用二十轮教训）

- 零新依赖（手写可访问性断言，不引 axe）；app.css 只追加 §45
- **unset ELECTRON_RUN_AS_NODE**；aria-label 唯一；TDZ 声明序
- CSS 段号会撞：合并后 grep 段头注释查重名顺延（#364 教训）
- merge commit 标题用 chore:（merge: 过不了 check-commit-msg）
- python 替换逐段写入+即时校验；check:unicode 必过
