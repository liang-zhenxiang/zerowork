# PRD · 第二十三轮十连——「数据与备份」

任务目录：`.trellis/tasks/11-14-ui-round23/`　分支：`feat/ui-round23`　issue：#390　日期：2026-11-14

## 背景

会话数据是本地优先产品的核心资产。第二十三轮把「数据安全四条链路」补全：
备份→恢复→导入→体检，外加存储位置透明化与统一确认摘要。

## 十项清单（先逐项查重）

| # | 功能 | 说明 | 落点 |
| --- | --- | --- | --- |
| 1 | 全量备份 | 备份 sessions/*.jsonl 为单个 tar 归档（Node 无内置 tar——零依赖方案：自制「文本拼接清单」格式 .zwbackups：JSON Lines，每行 {name, content}；恢复侧解析） | daemon handler |
| 2 | 备份恢复 | 从 .zwbackups 恢复：预览条数+确认；同名跳过（不覆盖磁盘现状） | daemon handler |
| 3 | 会话导入 | 数据管理「导入 jsonl」：文件选择+header 校验+入库 | daemon handler |
| 4 | 导出全部 Markdown | 数据管理一键全量导出 md 到 exports/ | daemon handler（复用 sessionExportMarkdown） |
| 5 | 数据体检 | 体检报告：损坏 jsonl/空会话/超大会话(>5MB)/未命名统计 | daemon handler |
| 6 | 存储位置透明 | 数据管理显示 sessions/ 绝对路径 + 「在 Finder 打开」（复用既有 openPath 通道查重） | DataManagementSection |
| 7 | 备份提醒 | 上次备份>7 天且会话>20 条 → 数据管理提示条（读备份目录 mtime） | DataManagementSection |
| 8 | 导出格式选择 | 查重：md/txt/html 菜单已分项（#316/#354）→ **换题**：会话行菜单「复制会话路径」（开发者向，clipboard） | Sidebar 行菜单 |
| 9 | 片段导出 | 片段库 JSON 导出（#363 已做短语导出；片段同通道） | 数据管理或个性化页 |
| 10 | 统一确认摘要 | 危险操作确认卡组件（标题/数量/去向/取消）——查重：已有逐项 confirm，抽公共组件 DataConfirmCard 供清理空会话/清空归档/备份恢复共用 | renderer |

## 验收标准

- 每项 build 过 + 真实 Electron 截图/DOM 断言 ≥1（tests/e2e/ui-round23-shots.mjs）
- lint:all / npm test / 既有 GUI 用例全绿
- CHANGELOG [Unreleased]；PR Closes #390；CI 绿合并；guard release；交付截图

## 硬约束（沿用二十二轮教训）

- 零新依赖；app.css 只追加 §47（合并后 grep 段号查重）；jsx(Comp, {}) 带第二参
- **unset ELECTRON_RUN_AS_NODE**；TDZ 声明序；e2e 种子首条消息文本=期望标题
- INVOKE/preload 两份手工副本必须同步（契约测会拦）；MAIN_HANDLED 白名单核对
- 新 daemon handler 引用的函数必须在本模块导入/声明（daemon-graph 契约测）
- prefers-reduced-motion 用 0s 形式；merge commit 标题用 chore:
- python 替换逐段写入+即时校验；check:unicode 必过
