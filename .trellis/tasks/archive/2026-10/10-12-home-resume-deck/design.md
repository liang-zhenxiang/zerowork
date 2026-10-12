# 技术设计:首页「继续推进」工作台

对应 prd.md 的技术方案。分层、契约、数据流、权衡与回滚。

## 1. 模块边界

```
src/main/daemon/session-digest.js   新增·纯模块(Electron 外可 import,library.js 同模式)
  └ summarizeLastActivity(records)  纯函数:原始 JSONL 条目 → 摘要对象
src/main/daemon/session-files.js    IO 编排:sessionDigest(paths) 处理器
src/shared/ipc.js                   INVOKE.sessionDigest = "session:digest"
src/preload/index.js                kami.sessionDigest(paths)
src/renderer/src/app.js             HomeResumeDeck 组件(替换 HomeRecentSessions 调用点)
src/renderer/src/app.css            卡片样式(视觉方案见 research/ux-proposal.md)
tests/unit/session-digest.test.mjs  纯模块单测
tests/e2e/home-resume-deck.mjs      端到端(真实启动 + 截图)
```

## 2. 契约

### 2.1 IPC

```js
// INVOKE.sessionDigest = "session:digest"
// 入参:{ paths: string[] }   // 渲染层保证 ≤ 4 条;daemon 侧仍设硬上限 8 防御
// 出参:{ digests: Record<path, Digest | { kind: "error", message: string }> }
```

```ts
type Digest =
  | { kind: "delivered"; names: string[]; extra: number; at: number }
  | { kind: "text";     text: string; at: number }
  | { kind: "fallback" };  // 无可 summarizing 内容(或文件超限/读失败非 error 场景退化)
```

- 单个 path 失败不整体失败(首页要能渲染其余卡),失败项记 `{kind:"error"}`,渲染层按 fallback 处理但不吞——控制台可见
- **不进 listSessions**:那是每次 run 边界都推的热路径(ipc.js 653 行注释),
  读文件的开销不能挂上去;digest 由渲染层按需拉

### 2.2 摘要算法(纯逻辑,单测钉死)

输入:该会话 JSONL 的**原始条目数组**(尾部窗口,见 §3)。从尾向头扫:

1. **交付优先**:窗口内最后一条 `customType: "artifacts_presented"` 且其后没有
   新的 assistant 文本 → `delivered`(names 最多 2 个文件名 + extra 计数)
2. 否则**最后一条有文本的 assistant message** → `text`,截断 60 字,
   清洗 markdown 噪声(代码围栏/链接 URL/首尾 #*` 与空白;粗清洗,不追求完美)
3. 都没有(纯工具流/坏数据/空)→ `fallback`

`at` 取该条目的 `timestamp`(ISO 解析为 ms;缺失时 0,渲染层退用会话 modifiedAt)。

**措辞分工**:digest 只报事实;「进行中…」前缀、相对时间、单位换算全在渲染层
(它已有 running 字段与 formatMessageTime)。

## 3. 成本控制(IO 编排,session-files.js)

```
sessionDigest(paths):
  for path (并发上限 4):
    statSync(size)
    ├─ size > DIGEST_LARGE_FILE_BYTES(2MB) → fallback(不读)
    ├─ SessionManager.open(path).getEntries() → 尾部窗口(最后 200 条)→ 纯函数
    └─ ENOENT → { kind: "error" }   // 与 listSessions 的可见性口径不追赶:列表有、文件没了就如实报
```

- **统一读文件,不走内存桶**:桶的 conversation.entries 是投影格式(带 fold 结构),
  与文件原始格式不同,两边归一的成本与 bug 面都大于直接读文件;
  pi 的 SessionManager 本身就是追加落盘,运行中会话的文件是新鲜的
- 未落盘的新会话(listSessions 的 pending 项)文件不存在 → error 项,
  渲染层以 messageCount 兜底文案,不特殊处理
- 尾部窗口 200 条:交付与末条回复必然在尾部;窗口内没有 → fallback

## 4. 渲染层数据流(app.js)

```
taskList(既有:拉式 + sessionListPush 推送刷新)
  └ recentForHome = sort(taskList).slice(0, 3)(既有 useMemo,改为 4 由设计定稿)
      └ useEffect[recentForHome]:kami.sessionDigest(paths) → digestMap state
          └ HomeResumeDeck({ sessions: recentForHome, digests: digestMap, running…, onResume })
```

- digest 拉取失败整体降级:卡片只显示标题+元信息(即现状水平),不空转
- **链路验证点(PRD 验收 2)**:run 结束 → sessionListPush → reloadSessions →
  recentForHome 引用变化 → digest 重拉 → 「进行中」消失、摘要更新。
  e2e 要覆盖这条(等 run 完成后回首页断言终态摘要)
- 卡片点击 → 既有 `resumeTask(path)`(返回 promise 的版本,资料库预览已在用)

## 5. 视觉(要点,细则以 research/ux-proposal.md 合流稿为准)

- 替换 `HomeRecentSessions` 渲染点(`composer-zone` 内清单正下方,槽位不动):
  **三态纪律照旧**——无会话返回 null;加载中不出独立骨架(摘要未到时卡内摘要位
  留白,标题/时间先渲染,避免二次跳动)
- 遵守 DESIGN.md:Token 档位内取值;主列不新增带边框内容卡层级;
  running 信号 = 形态(脉冲点)+ 文字(「进行中」),不只靠颜色
- `check:theme-tokens` 会守暗色;新色若需登记例外,理由写进 ux-proposal

## 6. 兼容与回滚

- 纯增量:不改会话文件格式、不改 daemon 存储;digest 是只读投影
- 老用户(有历史会话)升级后首页即见摘要,无迁移
- 回滚 = revert 单个 PR;`HomeRecentSessions` 删除后旧文案「最近会话」不保留
  (新组件承担同语义;侧栏不受影响)

## 7. 测试设计

### 单元(tests/unit/session-digest.test.mjs,照 library-aggregate 模式)

- 三 kind 判定:交付在尾/文本在尾/纯工具流 fallback
- 交付后又说话 → 按 text(不是 delivered)
- 截断:60 字 + 省略号;markdown 清洗(围栏/URL/首尾符号)
- names 最多 2 + extra 计数;timestamp 缺失 → at=0
- 坏行容忍(JSON 解析失败的条目跳过);空数组 → fallback
- 反向验证:改坏优先级(交付永远赢)→ 「交付后又说话」一条变红

### e2e(tests/e2e/home-resume-deck.mjs,复用 harness + mock 模型)

1. 跑完一轮带交付的会话(照 artifact-present 的 mock 形态)
2. 返回首页 → 断言:卡片区出现、摘要含交付文件名、元信息含相对时间
3. running 态:发第二条消息,回合进行中回首页,断言「进行中」信号;
   等 run 结束断言信号消失、摘要为终态
4. 点击卡片 → 断言回到该会话(消息流可见)
5. 截图:浅色终态 + 暗色一张;无会话新装首屏不出现该区(onboarding 回归已有覆盖)

### 回归

- `onboarding.mjs`(清单三态)与 `gui-smoke.mjs` 必须不受影响:
  改动点在清单**正下方**的兄弟节点,不动清单自身状态类
- `npm run lint:all` / `npm run test` / `npm run test:gui` 全绿后合并

## 8. 权衡记录(为什么这么做)

| 决策 | 备选 | 取舍 |
| --- | --- | --- |
| digest 按需拉式 | 挂进 listSessions 热路径 | 热路径每次 run 边界推,读文件会放大;首页只需 3-4 张 |
| 统一读文件 | 桶/文件双来源归一 | 桶是投影格式,归一成本与 bug 面 > 直接读;文件本就新鲜 |
| 2MB 超限退化 fallback | 尾部字节截断解析 | JSONL 条目跨行,截字节会碎;真实会话多在百 KB 级,退化极少触发 |
| 摘要粗清洗 markdown | 完整 markdown→纯文本 | 摘要 60 字,粗清洗够用;完整转换引入依赖不值得 |
