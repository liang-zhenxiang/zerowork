# PRD · 第十四轮十连——「启动与首感的最后一公里」

任务目录：`.trellis/tasks/11-05-ui-round14/`　分支：`feat/ui-round14`　issue：#331　日期：2026-11-05

## 背景

十三轮迭代后功能完备（v0.17.0 已发布 + 12/13 两轮）。第十四轮聚焦**启动与首感**：
新用户头 60 秒（首启、空数据、首次配置模型）与老用户每日回归（打开即续）。
这是 onboarding 的最后一公里。

## 十项清单

| # | 功能 | 说明 | 主要落点 |
| --- | --- | --- | --- |
| 1 | 首启欢迎屏 | 首次启动（无会话+无 provider 配置记录）显示 3 步引导卡（配置模型→发第一条→看统计），localStorage `zw:onboarded` 记完成后不再出现 | HomeView |
| 2 | 模型配置向导 | 未配置 provider 时输入卡上方「配置模型 →」直达按钮 + 步骤指示 | HomeView composer 上方 |
| 3 | 每日回归摘要 | 二次启动侧栏顶部「昨日完成 N 任务」胶囊（usageStats 有昨日数据才显） | Sidebar |
| 4 | 快速开始清单 | 首页上手清单改为可勾选 checklist（localStorage `zw:checklist`），完成划线持久化 | HomeView 上手清单 |
| 5 | 启动品牌帧 | 冷启动白屏期居中 logo 呼吸帧（index.html 静态层，app 挂载后移除；nativeTheme 同步底色） | index.html + main |
| 6 | 最近会话置顶行 | 首页标题下「继续上次：会话名」胶囊（存在非 current 会话才显，点击 resume） | HomeView |
| 7 | 工作区引导 | 未设置工作区时 toast「先选择工作区」+ 设置直达链接（首次提问时） | submit 入口 |
| 8 | 空态示例填草稿 | quick-chips 点击改为填入草稿不直接发送（round7 F7 链路已 fillText——查重后确认或微调） | Composer chips |
| 9 | 帮助入口聚合 | 侧栏底部「?」按钮 → 浮层聚合快捷键表（⌘/）/文档链接/诊断页三入口 | Sidebar footer |
| 10 | 首屏骨架屏 | 会话列表/统计首次 IPC 加载时显示 skeleton 条（已有 Skeleton 组件，接入 Sidebar/统计） | Sidebar + StatsView |

## 验收标准

- 每项：build 过 + 真实 Electron 截图 ≥1 张（tests/e2e/ui-round14-shots.mjs）
- 新逻辑补单测/e2e；lint:all / npm test / 既有 GUI 用例全绿
- CHANGELOG [Unreleased]；PR 正文 Closes #331；CI 全绿 squash 合并；guard release；截图内嵌交付

## 硬约束（沿用十三轮教训）

- 零新依赖；app.css 只追加 §31；手写 createElement；jsx(Comp, {}) 永远带第二参
- 懒渲染组件引用的 prop 名必须先 grep 核对（#329 白屏教训：build 期不报错）
- 矮视口铁律：CDP 1024×679 过 focus-mode（composerBottom≤home）
- python 替换逐段写入+即时校验；grep 具体标识符；check:unicode 必过；不推 main；不 force push
- daemon 环境变量注入（不用 import("electron")）；折叠/隐藏类用 CSS 方案
