# Journal - liangzhenxiang (Part 1)

> AI development session journal
> Started: 2026-10-03

---



## Session 1: 会话置顶（10-03-session-pin）
<!-- trellis-session: v=2 fp=e1d432de10b1da43 -->

**Date**: 2026-10-03
**Task**: 会话置顶（10-03-session-pin）
**Branch**: `feat/session-pin`

### Summary

侧栏会话可置顶：独立索引 pins.json + session:pin 通道 + 行内钉标记与菜单入口；顺带修好行内操作钮的键盘可达性

### Main Changes

- 新增 daemon/pin.js（SessionPinStore，照 archive.json 的形态：不动会话文件、原子落盘、损坏即当空索引）
- listSessions 下发 pinned 字段；新通道 session:pin + taskListChanged 推送
- 新增渲染层纯模块 session-pin.js（置顶优先排序 + 折叠窗口），groupSessions 与任务区窗口改用它们
- 会话行 ⋯ 菜单新增「置顶 / 取消置顶」，置顶行带 12px 图钉标记
- 修既有缺陷：.task-item-ops / .space-group-actions 由 visibility:hidden 改 opacity+pointer-events —— 前者的隐藏态会把按钮移出 Tab 序列，行内全部动作对键盘用户关闭（DESIGN §7.9 已登记）

### Git Commits

(No commits - planning session)

### Testing

- [OK] 单元 19 条（新增）：置顶排序 / 折叠窗口 / 索引落盘与幂等与损坏；vitest 全绿 244 条
- [OK] GUI 9 条（tests/e2e/session-pin.mjs）+ ipc-functional 追加置顶往返；本机沙箱起不了 Electron，未能实跑（既有用例同样跑不了）
- [OK] 反向验证真跑：去掉置顶比较键 → 2 条红；去掉 persist() → 6 条红
- [OK] npm run build / check:renderer-assets / check-daemon-graph / lint:all(12 通过，2 项与本改动无关) / U+FFFD 扫描 全过

### Status

[OK] **Completed**

### Next Steps

- 在有图形环境的机器上跑 npm run test:gui（含新增 test:gui:pin）并补截图
- 建 Issue 并把 pr-body.md 的 Closes #N 换成真实编号；更新 Roadmap #21
- README 的 docs/images/home-light.png 已过期（侧栏里「资料库」还画在「规划中」组）—— 需要在能跑 GUI 的机器上重新生成


## Session 2: 会话置顶 · 独立评审与修正（10-03-session-pin）
<!-- trellis-session: v=2 fp=a91ef3bb13e79201 -->

**Date**: 2026-10-03
**Task**: 会话置顶 · 独立评审与修正（10-03-session-pin）
**Branch**: `feat/session-pin`

### Summary

请独立上下文的审查者只读审查本轮的置顶实现，按其发现逐条处置；并记录需要真机确认的剩余项

### Main Changes

- 评审发现 1：session-files.js 的 pending 分支注释写「恒 false」是错的 —— pending 的判据正是「有路径、文件不在磁盘上」，那时置顶确实可能为真（已改注释，并写明它是刻意保留置顶的情形）
- 评审发现 2：app.css 两处注释仍写 visibility、CHANGELOG 把「修复」写进了「新增」段 —— 已改
- 评审发现 3：IconPin 原为「竖线 + 两横」，12px 下会读成加号/准星 —— 已改成带喇叭口的钉头（并用 24×24 网格采样把剪影打出来核过：是钉形，与 IconPlus 明显不同）
- 评审发现 4：菜单项可能落在 .sidebar-scroll 可视区之外，而页面内 btn.click() 照样绿 —— clickMenuItem 现在先断言目标项真的在可视区里
- 评审发现 5：prd 与 USAGE 承诺的「归档/删除/重命名不牵连置顶」没有用例 —— 已补 GUI ⑩⑪⑫（真实 IPC + DOM 断言）

### Git Commits

(No commits - planning session)

### Testing

- [OK] 复核：npm run build / check:renderer-assets / check-daemon-graph / vitest 244 条 / lint:all(12 通过，2 项无关) / U+FFFD 全过

### Status

[OK] **Completed**

### Next Steps

- 真机确认（已登记在任务 design.md §八）：靠下行的菜单是否被裁（需要时给 .space-menu 加上翻）、12px 钉图标的辨识度与深色对比度、当前会话+置顶的组合、置顶数 > 5 时窗口变长的布局


## Session 3: 导出为 Markdown（10-03-export-markdown）
<!-- trellis-session: v=2 fp=5ca700e28c258122 -->

**Date**: 2026-10-03
**Task**: 导出为 Markdown（10-03-export-markdown）
**Branch**: `feat/export-markdown`

### Summary

会话行 ⋯ 菜单把「导出」拆成 HTML / Markdown 两项；Markdown 版把当前分支渲染成可移植文档，顺带修掉会话行菜单在靠窗口底部时被裁的既有缺陷

### Main Changes

- 新增 daemon/session-markdown.js 纯渲染器：逐类对齐 pi 的 HTML 导出（用户/助手/思考/工具调用与结果/命令/压缩/分支摘要/模型切换/产物）
- 条目取自活宿主的 getBranch()（leaf 在内存里才是真值；自己 open 文件会把「最后一条条目」当叶子）
- 三条口径：超长内容（含工具入参）按界面同一口径截断、图片不内嵌 base64、代码围栏长度按内容算
- 行为：buildExportPath 支持扩展名；空会话判据与渲染同源（renderSessionBlocks）
- 顺带修：会话行 ⋯ 菜单空间不足时向上展开（.space-menu-up + useLayoutEffect 量测）—— 两轮加项把这个既有缺陷推到会真发生

### Git Commits

(No commits - planning session)

### Testing

- [OK] 单元 17 条（含真实 SessionManager 读预置会话文件的集成用例，锁住「只导出当前分支」）+ GUI 4 条 + ipc-functional 第 16 项从 Node 侧读回文件
- [OK] 反向验证真跑：clamp 不截断 → 2 条红；围栏写死 → 1 条红
- [OK] vitest 261 条 / build / check:renderer-assets / check-daemon-graph / lint:all（12 通过，2 项与本改动无关）/ U+FFFD 全过

### Status

[OK] **Completed**

### Next Steps

- 有图形环境时跑 npm run test:gui:export-markdown 与全套 test:gui；并真机看一眼菜单翻转后的观感


## Session 4: 文件时光机一轮（10-15-file-time-machine）
<!-- trellis-session: v=2 fp=63b94e51162687ea -->

**Date**: 2026-10-15
**Task**: 文件时光机一轮（10-15-file-time-machine）
**Branch**: `feat/file-time-machine`

### Summary

Agent 改过的文件留一版、可看可退；两处 P0 由独立设计师评审抓出并改掉

### Main Changes

- 新增 daemon 侧 version-store + 三个 IPC 通道；渲染层新增「文件历史」页（版本时间轴 + 只读预览 + 就地确认还原）

### Git Commits

| Hash | Message |
|------|---------|
| `9f3ca58` | feat(file-history): 文件时光机——Agent 改过的文件留一版，可看可退 (#206) |

### Testing

- [OK] npm test 810 全过；test:gui:file-history 10/10（断言 84 条）；六处反向验证各自只打中相关那一条

### Status

[OK] **Completed**

### Next Steps

- 发版时把 [Unreleased] 归入 v0.9.0；Roadmap 已更新


## Session 5: 值守一轮：接手另一会话已完成的实现（10-16-watch-policy）
<!-- trellis-session: v=2 fp=2055d6692bb2a62f -->

**Date**: 2026-10-17
**Task**: 值守一轮：接手另一会话已完成的实现（10-16-watch-policy）
**Branch**: `feat/watch-policy`

### Summary

值守合入 main：任务级边界只收紧、越界留证人、交差报告；本轮最值得记的是「开始前先确认有没有人在做同一件事」

### Main Changes

- 接手另一会话的实现：rebase 到最新 main（解 CHANGELOG 冲突，把他们的条目逐字移进 [Unreleased]）、独立复核、判 CodeQL 告警、squash 合并

### Git Commits

| Hash | Message |
|------|---------|
| `0463e7c` | feat(automation): 值守——给无人值守的任务一套可声明的边界与交差报告 (#209) |

### Testing

- [OK] build ✓；单测 40 文件 / 898 条；sections 25/25；local-state 33/33；check:daemon-graph 两条性质；CI 总览全绿（GUI 链 8m23s）

### Status

[OK] **Completed**

### Next Steps

- squash 合并后：[Unreleased] 已积压（文件时光机已发 v0.9.0，值守待 v0.10.0）；#213 待做


## Session 6: 交差报告 e2e 改用 mock 端点（10-18-watch-e2e-mock）
<!-- trellis-session: v=2 fp=ec61171eb384c677 -->

**Date**: 2026-10-18
**Task**: 交差报告 e2e 改用 mock 端点（10-18-watch-e2e-mock）
**Branch**: `test/watch-e2e-mock`

### Summary

交差报告的真实 DOM 渲染进 CI；顺带修好提示条与报告的矛盾（被叫停 vs 运行失败）

### Main Changes

- watch-policy.mjs 556→657 行改为 mock+真实 Electron；daemon 的 runFinished 带 outcome；渲染层按 outcome 措辞与选色

### Git Commits

| Hash | Message |
|------|---------|
| `51f399a` | test(e2e): 交差报告改用 mock 端点并进 CI，顺带修好提示条与报告的矛盾 (#219) |

### Testing

- [OK] test:gui:watch 9/9（隔离 HOME 下同样 9/9）；单测 906；CI GUI 链 6m32s，CI 日志确认 watch-policy 真跑 9/9 未跳过

### Status

[OK] **Completed**

### Next Steps

- 3 条 js/file-access-to-http 告警已自动 fixed；[Unreleased] 有两条修复待发

---

## 2026-10-20 — #225 daemon-graph 反向验证不再改写真实源码

### Summary

`tests/unit/daemon-graph.test.mjs` 那条「复现真实漏 import」的用例此前直接改写
`src/main/daemon/session-files.js` 再还原。vitest 默认并行跑测试文件，至少 8 个单测
读这个文件 —— 落在改写窗口里就会在**与自己无关的用例上**报错。改为把模块图复制到
临时目录再动手，真实源码全程只读。PR #227 已合并，Issue #225 已关闭。

### Key Decisions

- 复用已有的 `ZW_DAEMON_DIR` 入口，不给检查脚本加第二个参数
- 副本必须保持相对布局（`../sandbox/`、`../../shared/`），否则得到「模块不存在」假报错
- 用例前置断言「未改动的副本应当通过」，把红归因到那两行 import 而不是副本缺文件
- 用运行前后 sha256 把「真实源码只读」变成可执行断言

### Pitfalls

- 反向验证（把副本路径改回真实路径）暴露了原写法的**第二种坏形态**：用例中途失败时
  还原语句执行不到，仓库会停在被改坏的状态 —— `afterEach` 未必能救
- 全量连跑 20 次时撞到另一条计时抖动（`mock-model-server` 的 243ms < 250ms），
  已单独开 #226，没有混进本次 PR
- 本地 `lint:all` 的 zizmor 需要 Docker 守护进程；CI 上通过，与改动无关
- 归档提交一度落在本地 `main` 上，未推送即改到分支走 PR #228 —— 事后确认 tree 一致后
  用 `git reset --keep` 对齐

### Git Commits

| Hash | Message |
|------|---------|
| `8e81342` | test(unit): daemon-graph 的反向验证改用临时副本，不再改写真实源码 (#227) |
| `d40bb1a` | chore(trellis): 归档 daemon-graph 测试竞态任务的规划产物 (#228) |

### Testing

- daemon-graph 单文件连跑 20 次：0 失败
- 全量连跑 28 次：daemon-graph 从未失败（1 次是 #226 的计时抖动）
- 单测 906/906；CI 16/16；main CI 绿

### Status

[OK] **Completed**

### Next Steps

- #226：`mock-model-server` 的 delayMs 用例按墙钟差断言，并行全量偶发假红
- #182 触发条件已成立：`electron-vite@6.0.0` peer 已放开 vite 8
- `[Unreleased]` 积压：稳定版 v0.11.0 尚未发布

---

## 2026-10-21 — #226 mock 的 delayMs 断言改读服务端发送时刻

### Summary

`mock-model-server` 的 `delayMs` 用例断言「慢的那台至少比快的那台多用 250ms」，量的是
`fetch` 两端 `Date.now()` 差。全量并行时被调度／GC／抢 CPU 吃穿到 243ms，两个独立会话
各撞到一次。改为读 mock 服务端自己记录的发送时刻。PR #230 已合并，#226 已关闭。

### Key Decisions

- **先做实验再选方案**：32 并发下量了三种墙钟形态，余量分别 26 / 36 / 59ms —— 全是猜的
- 让服务端记 `performance.now()`：`setTimeout` 只会晚不会早，所以间隔断言单调安全
- 四条断言覆盖四侧：间隔下限、默认不等待、首片不等待、网络层真的分片
- 先断言正文样本数 ≥ 2 —— `every()` 对空数组恒真，不先断言就会变成永远绿的假断言

### Pitfalls

- 提交信息里打出过一个 U+FFFD（「另加」的「另」），**commit-msg 检查不扫正文**；
  靠人工扫出来后才 amend。未推送前修正，没有留下脏历史
- 全量连跑 30 次与 32 并发 × 30 轮都是 0 失败，改前 20 次内就会撞一次 —— 这个对比才是
  「抖动消失」的证据，单次全绿证明不了什么

### Git Commits

| Hash | Message |
|------|---------|
| `c0efc6f` | test(unit): mock 的 delayMs 断言改读服务端发送时刻，不再按墙钟差 (#230) |

### Testing

- 目标文件 16/16；全量 906/906；全量连跑 30 次 0 失败；32 并发 × 30 轮 0 失败
- 反向验证 3 条全部精确命中且无残留
- CI 16/16

### Status

[OK] **Completed**

### Next Steps

- #182 触发条件已成立：`electron-vite@6.0.0` 的 peer 已放开 vite 8
- 稳定版 v0.11.0 仍未发布，`[Unreleased]` 已积压 3 条修复
