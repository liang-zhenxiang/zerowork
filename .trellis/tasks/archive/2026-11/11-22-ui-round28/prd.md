# PRD · 第二十八轮十连——「会话检索增强」

任务目录：`.trellis/tasks/11-22-ui-round28/`　分支：`feat/ui-round28`　issue：#452　日期：2026-11-22

## 背景

#286 会话检索已有基础（全文命中 + 跳转定位 + entry-flash）。本轮把「找得到」升级为
「找得快、筛得准、用得顺」。

## 十项清单（先逐项查重）

| # | 功能 | 落点 |
| --- | --- | --- |
| 1 | 角色筛选 chip | ss-hit 列表按「我发的 / 它答的」筛选 |
| 2 | 时间范围筛选 | 全部 / 7 天 / 30 天 |
| 3 | 拼音首字母匹配 | 零依赖启发式（常用词表 + 单字映射） |
| 4 | 命中数统计行 | 「共 N 条命中 · M 个会话」 |
| 5 | 高亮计数 | 每条命中显示出现次数 |
| 6 | 最近搜索记录 | 最近 5 条（localStorage zw:ss-recent） |
| 7 | 全半角/大小写容错 | 查重（既有搜索可能已 toLowerCase） |
| 8 | 空查询引导文案 | 未输入时的引导 |
| 9 | 结果导出 | 命中列表复制为 Markdown |
| 10 | 归档排除开关 | 归档会话默认排除 + 开关（查重） |

## 硬约束（沿用各轮教训）

- 零新依赖；app.css 只追加 §56（合并后 grep 段号查重）；jsx(Comp, {}) 带第二参
- **unset ELECTRON_RUN_AS_NODE**；e2e 种子首条消息文本=期望标题；assistant 带 model
- 首页/composer 新增 DOM 必须查 gui-ui-audit/gui-health-bento/focus-mode 预算契约
- fixed 浮层会被 transform 祖先吞（#447 教训）；clipboard 反馈同步派发
- 新增 desktop.json 键必须同步 desktop-behavior.test.mjs fixture（#440 教训）
- 合并 main 后 grep 检查改动是否被覆盖；改动后小步提交
- python 替换逐段写入+立即 build 校验；check:unicode 必过；merge commit 标题用 chore:
