# daemon-graph 反向验证用例不再改写真实源码

对应 Issue：[#225](https://github.com/liang-zhenxiang/zerowork/issues/225)

## 背景

`tests/unit/daemon-graph.test.mjs` 里「复现那次真实缺陷：删掉 onExceedAction /
parseWatchPolicy 的 import 必须被抓住」这条用例，做法是：

```js
backup = readFileSync(SESSION_FILES, "utf8");
writeFileSync(SESSION_FILES, after);   // 改写 src/main/daemon/session-files.js
runCheck();
writeFileSync(SESSION_FILES, backup);  // 再写回
```

这条用例本身有价值（它是「真实漏 import」事故的自动化反向验证），但它**与其它测试
共享同一个仓库文件**。至少 8 个单测文件会读 `session-files.js`：
`compare-keep` / `library-aggregate` / `session-digest` / `theme-preferences` /
`projects-store` / `session-model-fallback` / `watch-policy` / `daemon-graph` 自己。

vitest 默认并行跑测试文件。只要别的文件落在「已改写、尚未还原」的窗口里读源码，
就会拿到一份**缺少两行 import 的源码**。2026-10-20 升级内核时实测撞到过一次：
单独跑 6/6 通过，之后两次全量也全绿 —— 典型的并行竞态。

危险之处在于它是**间歇性**的，且失败信息（若出现在别的测试上）指向一个不存在的
问题 —— 与本项目记过的「假等待」同一形态：症状指向被断言的副作用，而真因在别处。

## 需求

1. 那条反向验证用例**不再改写仓库里的 `src/main/daemon/session-files.js`**，
   在临时副本上删 import、对副本跑检查脚本。
2. 保留它原本的证明力：删掉 import 后 `runCheck` 必须报错，且**只报这两个名字**
   （不误报 `command-exec.js` / `config-paths.js`）。
3. 同时钉住「原仓库文件全程只读」这条性质 —— 用运行前后的 sha256 断言证明，
   而不是靠「我们没写它」的口头约定。
4. 不改动全仓测试并行度（不接受 `--no-file-parallelism`）。

## 约束

- `tools/check-daemon-graph.mjs` 已有 `ZW_DAEMON_DIR` 环境变量入口（测试在用），
  优先复用它，不新增脚本参数 —— 已有机制够用就不要造第二个入口。
- 检查脚本会跟随相对 import 走出 daemon 目录（`../../shared/ipc.js`、
  `../sandbox/index.js`），副本必须保持同样的相对布局，否则会产生
  「模块不存在」的**假报错**，让反向验证失去意义。
- 副本只在测试进程内存在，`afterEach` 清理，失败时也不留在临时目录里。

## 验收标准

- [ ] `src/main/daemon/session-files.js` 在测试运行期间不变动（用例内用 sha256 断言）
- [ ] 反向验证仍在：在副本上删 import → `runCheck` 报错，报 `onExceedAction` 与
      `parseWatchPolicy`，且不误报其它模块
- [ ] 副本上的「未改动状态」先跑一次必须是绿的（证明红是这两行 import 造成的，
      而不是副本本身缺文件）
- [ ] 连跑 `npx vitest run` 20 次不再出现该用例间歇红
- [ ] `npm run lint:all` 与 `npm run test` 通过

## 难度

低。改动集中在一个测试文件；风险点是副本的相对布局要覆盖检查脚本会走到的所有目录。
