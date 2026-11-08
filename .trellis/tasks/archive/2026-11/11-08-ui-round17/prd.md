# PRD · 第十七轮十连——「可靠性与恢复」

任务目录：`.trellis/tasks/11-08-ui-round17/`　分支：`feat/ui-round17`　issue：#342　日期：2026-11-08

## 背景

十六轮迭代后功能面已宽（v0.18.0 稳定 + v0.19 beta 线）。第十七轮聚焦**可靠性**：
出错时能不能自助、误操作能不能撤销、数据能不能找回。这是工具类产品信任感的根基。

## 十项清单（先逐项查重）

| # | 功能 | 说明 | 状态 |
| --- | --- | --- | --- |
| 1 | 撤销归档 | 归档 toast 带「撤销」按钮（重放 toggleArchived），10 分钟窗口 | 新做 |
| 2 | 撤销清空草稿 | 清空动作把旧文本存 `zw:draft-undo:<key>`，toast「撤销」一键还原 | 新做 |
| 3 | 会话快照对比 | 「与上一版比较」——查 compare_run 链路可复用性 | 先查重 |
| 4 | 失败队列重放 | 批量提问队列失败项标记红点 + 「重放」 | 新做（round13 队列之上） |
| 5 | 慢 IPC 提示 | >3s 的 await 包「仍在处理…」toast（一次性，不刷屏） | 新做 |
| 6 | 崩溃恢复横幅 | main 侧记录上次退出是否干净（will-quit vs crash），渲染层首启横幅 | 新做 |
| 7 | 导出前校验 | 导出前 statSync 目标目录可写、剩余空间 >1MB，失败 toast | 新做 |
| 8 | 存储余量指示 | 设置→数据：CONFIG_DIR 所在盘剩余空间（statfsSync） | 新做 |
| 9 | 日志查看器入口 | 「打开日志目录」——查重（诊断页可能已有） | 先查重 |
| 10 | 错误码检索 | ErrorCard 加「搜索此错误」→ shell.openExternal(GitHub Issues 搜索预填) | 新做 |

## 验收标准

- 每项：build 过 + 真实 Electron 截图 ≥1 张（tests/e2e/ui-round17-shots.mjs）
- 新逻辑补单测/e2e；lint:all / npm test / 既有 GUI 用例全绿
- CHANGELOG [Unreleased]；PR 正文 Closes #342；CI 全绿 squash 合并；guard release；截图内嵌交付

## 硬约束（沿用十六轮教训）

- 零新依赖；app.css 只追加 §34；手写 createElement；jsx(Comp, {}) 永远带第二参
- aria-label 唯一（搜索按钮/输入框同名会让 locator strict 冲突——#339 教训）
- e2e 种子 cwd=join(WORKSPACE_DIR,"临时任务",auto)；resumeSession 需已选模型
- 组选择按组名找 index（空间组按最近活跃排序，[0] 不一定是 alpha）
- 矮视口铁律 CDP 1024×679；python 替换逐段写入+即时校验；grep 具体标识符
- check:unicode 必过；不推 main；不 force push；daemon 不 import("electron")
