# 测试规范（写测试之前必读）

> 本页是**测试的权威约定**：分层、写法、验收标准、以及踩过的坑。
> 目标是让**任何同事克隆下来就能按同一套标准写测试与验证**，而不是各写各的。
>
> 命令速查在 `AGENTS.md`；这里是「怎么写、为什么这样写」。

---

## 一、三层测试，各管什么

| 层 | 位置 | 跑什么 | 什么时候用 |
| --- | --- | --- | --- |
| **单元** | `tests/unit/**/*.test.mjs` | vitest，直接 import `src/` 源码 | 纯逻辑、纯函数。**不用启动任何东西，秒级** |
| **端到端（GUI）** | `tests/e2e/*.mjs` | Playwright `_electron`，**真实启动应用** | 需要真实 Electron / IPC / daemon / 渲染层的路径 |
| **静态契约** | `scripts/check-*.mjs` | 不跑代码，查契约 | 产物命名、模块图、文档链接、工作流安全 |

**选择顺序**：能写成单测就不要写 e2e。e2e 一个用例几分钟，单测毫秒级。
只有「只有真实跑起来才暴露的问题」才值得放进 e2e ——
典型是「界面看着在、但 IPC 全挂」（daemon 没起来、通道名对不上）。

---

## 二、写 e2e：骨架一律来自 `tests/e2e/lib/harness.mjs`

**用例文件里不该出现**：`electron.launch`、`rmSync(CONFIG_DIR)`、自建的 `check()`、
末尾的报告循环、`app.close()` + `process.exit()`。这些全部由 harness 提供。

### 最小骨架

```js
import assert from "node:assert/strict";
import { createHarness } from "./lib/harness.mjs";

const h = createHarness({ name: "myfeature" });   // name 唯一，决定隔离目录与截图目录
await h.launch();                                  // 启动并等到界面真的就绪
const win = h.window();

await h.check("标题正确", async () => assert.equal(await win.title(), "ZeroWork"));
await h.shoot("home");                             // 截图 + 像素断言

await h.finish();                                  // 汇总 + 收尾 + 设退出码
```

### `name` 的规则

**必须唯一且稳定**。它同时决定三件事，撞名会互相清空数据：

- 配置目录 `/tmp/zerowork-e2e-<name>`
- 工作区目录 `/tmp/zerowork-ws-<name>`
- Electron 的 userData `/tmp/zerowork-ud-<name>`
- 截图目录 `artifacts/<name>/`

### 常用 API

| 方法 | 用途 |
| --- | --- |
| `h.check(label, fn)` | 记一条断言，**不因失败中断整轮** |
| `h.skip(label, reason)` | 跳过但**在报告里留痕**。在 `h.check` 回调**里**调用 → 这条 check **只记 SKIP**（不记 PASS），`label` 必须与外层 check 一致；在回调**外**调用 → 独立一条 SKIP。全都没通过时退出码是 `2`（见三·9） |
| `h.shoot(label)` | 截图 + **像素断言**（不是一片纯色），失败时打字符画 |
| `h.snap(label)` | 只截图不断言（用于中间过渡态） |
| `h.waitForSettled()` | 等界面**停止变化**（DOM 变动静默 800ms） |
| `h.waitForDaemon()` | 等 daemon 报启动 |
| `waitUntil(fn, {timeout, desc})` | 轮询等待任意条件，超时抛出**带描述**的错误 |

---

## 三、硬性规范（不是风格偏好）

### 1. 用信号等待，不用固定 sleep

```js
// ✗ 错的：慢机器不够、快机器白等，两头都错
await win.waitForTimeout(9000);

// ✓ 对的：等一个可观察的条件
await h.waitForSettled();
await waitUntil(() => mock.requests.length >= 2, { timeout: 30_000, desc: "mock 收到第 2 轮请求" });
```

实拍证据：`gui-settings` 原来光固定等待就有 9s + 9×0.6s + 0.8s ≈ 15s，
换信号等待后**整个文件（含启动与 9 轮导航）12.1s** —— 那个 9 秒基本是白等。

> ⚠️ **`waitForSettled()` 不能在「模型回合进行中」用。**
> 渲染层在回合进行时有 500ms 级的计时器在改 DOM（时长刷新、等待提示轮播、重试倒计时），
> **连续 800ms 无变动这个条件永远达不到**，用它只会等到超时。
> 回合中的等待要用更直接的信号：等 mock 真的收到请求、等目标元素真的出现。
> 导航后、启动后这类**空闲态**才适合 `waitForSettled()`。

#### 谓词**必须能返回假值** —— 否则超时形同虚设

`waitUntil` 的判定是 `if (value) return value`（`harness.mjs`）。
**返回对象、数组、函数都是恒真**，于是它在第一次求值就返回 ——
`timeout` 一格都用不上，而写法**读起来完全像一个正常的信号等待**。

```js
// ✗ 错的：谓词返回对象字面量 → 恒真 → 立刻返回，timeout 从不参与判定
const state = await waitUntil(
	async () => await win.evaluate(() => ({ badge: …, channel: …, checkBtn: … })),
	{ timeout: 40_000, desc: "更新区渲染" },
);

// ✓ 对的：就绪才交出对象，否则返回假值
const state = await waitUntil(async () => {
	const s = await win.evaluate(() => ({ badge: …, channel: …, checkBtn: … }));
	return s.channel && s.checkBtn ? s : null;
}, { timeout: 40_000, desc: "更新区渲染" });
```

**这不是假想的风险**（2026-10-03，`gui-updates`）：那条等待从写下起就没生效过，
CI 上间歇性红。日志时间戳显示「feed 就绪 → FAIL」只隔 **4.5 秒**，而代码写着 40 秒超时 ——
红灯不是等超时，是根本没等。

更值得记的是**它被「修」错过一次**：上一轮把 15s 放宽到 40s 并写下
「放宽到 40s 就好了」——那是**给一个没生效的参数加倍**，治不了任何东西，
还留下了一条错误的因果，让人下次继续用加超时的办法去治同类问题。

> 判断方法：**把谓词单独拿出来问一句「它什么时候返回假？」** 答不上来，就是在裸奔。
> 与「用 `waitForTimeout` 盖住竞态」同族 —— 都属于「看起来在等，其实没等」。

### 2. 先截图、后断言

截图要放在可能失败的断言**之前**，失败时才有现场。这一点**真实踩过**：
`gui-smoke` 早先的截图在断言之后，断言一失败，反而什么都没留下。

harness 有兜底：`finish()` 在有 FAIL 时会自动补拍 `_failure.png`。

### 3. 断言只许加强，不许削弱

迁移或重构测试时，**原来断言什么，之后还要断言什么**。允许的等价替换：

```js
// 原：轮询 N 次后断言
for (let i = 0; i < 20; i++) { if (found()) break; await win.waitForTimeout(500); }
assert.ok(found(), "界面上没出现 .widget-card");

// 换：waitUntil，且把原诊断信息搬进 desc
await waitUntil(found, { timeout: 30_000, desc: "界面上出现 .widget-card（工具返回对了却没渲染？）" });
```

替换后**失败信息不能弱于原来**。把原来的上下文（页面尾部样本、轮数、原始提示语）
搬进 `desc`。

### 4. 等到条件 A 之后，**不要立刻**断言副作用 B

这是本项目在 CI 上**真实红过**的一条。

```js
// ✗ 错的：等的是「内容出现」，断言的是「样式表挂上」——
//    这是两件事，没有先后约束
for (let i = 0; i < 40; i++) {
	const lines = [...document.querySelectorAll(".view-line")].map(...).join("\n");
	if (lines.includes(mark)) {
		const hrefs = [...document.styleSheets].map(...);
		return { found: true, hasJsonCss: hrefs.includes("json-mode.css") };  // ← 可能还没挂上
	}
	await new Promise((r) => setTimeout(r, 1000));
}

// ✓ 对的：把两件事都放进**同一个完成条件**，都满足才返回
const probe = (mark) => {
	const lines = [...document.querySelectorAll(".view-line")].map(...).join("\n");
	const hasMark = lines.includes(mark);
	const hrefs = [...document.styleSheets].map(...);
	return { complete: hasMark && hrefs.includes("json-mode.css"), ... };
};
```

**为什么它像随机 flake**：本地快，两件事几乎同一拍，恰好过；
CI 慢，条件 A 先满足、B 晚一拍 → 失败。而失败信息指向的是 B，
让人以为是 B 坏了，实际是**等待写错了**。

> 真实经过：`preview-renderers` 的 json 用例在 CI 上红了一条
> 「文档里没有 json-mode.css」，本地 7/7 全过。
> 用**定向延迟注入**（把该样式表的 `appendChild` 延迟 3 秒）复现，
> 得到与 CI 逐字一致的失败信息，才确认是竞态而不是产品缺陷。
> 同一次排查还揪出**第二处**同类写法（等编辑器容器出现就断言内容文本，
> 本地两者相差 16ms，靠 1 秒轮询间隔侥幸跳过）。

### 5. 「发送成功了没有」要验证到**副作用**，不要只看没报错

`await win.waitForTimeout(4000)` 然后当作「消息发出去了」，是**无法证伪**的断言 ——
发失败了也照样过。

**等对端的可观察结果**：mock server 真的收到了请求（`mock.requests.length >= n`）、
文件真的落了盘、状态真的变了。

### 6. 截图的像素断言有实测依据

`h.shoot()` 默认断言「亮度标准差 ≥ 3 且颜色数 ≥ 12」。这两个数是**量出来的**：

| | 标准差 | 颜色数 |
| --- | --- | --- |
| 纯白图（白屏） | 0.00 | 1 |
| 真实界面的**最小值**（最简的一屏空状态） | **12.23** | **85** |

取 3 与 12 是留了 4~7 倍余量。**它只用来抓「基本没渲染」，不承担「画面变了没」**——
后者交给基线 diff（`h.saveBaseline` / `h.diffBaseline`），且不做自动门禁。

已知误报场景：一屏**没有文字、且用平涂色块**的界面颜色数会很低。
真实界面因为文字抗锯齿会产生大量颜色，碰不到这条。

---

### 7. 看门狗的超时要按**最坏合法耗时**设，不要用默认值

harness 默认 `fileTimeout` 12 分钟。若某个用例的最坏耗时超过它（例如要下载运行时
再跑两个模型回合再等产物落盘），**必须显式调大**并写明理由。

不设的后果不是「更安全」，而是**在慢机器上引入一个假红** ——
而被假红误导一次，就会让人开始不信任测试。

### 8. 同步调用会让看门狗失效

`execFileSync(..., { timeout: 180_000 })` **同步阻塞事件循环** ——
连同进程里的 harness 看门狗一起卡住，那 180 秒内看门狗**是瞎的**。

改用 async 版本（`promisify(execFile)`），语义不变，看门狗重新有效。

**判断标准**：这段代码执行期间，「整个进程」还能不能响应？

### 9. 跳过要让**门禁**读得出来，不只是人读得出来 —— **已解决**

`h.skip()` 让文本报告里出现「跳过 N」，但那只是给人看的，**门禁读的是退出码**。
退出码不管跳过时，一个**一条断言都没跑**的测试文件在 CI 上仍然是绿的。
本仓库有 7 个脚本依赖本机 `~/.claude/settings.json` 的模型端点，探不到就整轮跳过
—— 它们曾经正是以「全绿」的形态存在的（见 Issue #30）。

**做法：退出码分三档，而不是一个布尔值。** 判定集中在 `tests/e2e/lib/harness.mjs`
的 `classifyRun()`（纯函数，单测在 `tests/unit/harness-exit-code.test.mjs`）：

| 退出码 | 含义 | 条件 |
| --- | --- | --- |
| `0` | 通过 | 至少一条 PASS，且没有 FAIL / 渲染层未捕获异常 |
| `1` | 失败 | 有 FAIL，或有渲染层未捕获异常 |
| `2` | **无信号** | 一条都没通过（整轮跳过，或压根没记过断言） |

判定只看「**有没有通过**」，不看「跳过了几条」：`passed > 0 && skipped > 0`
（例如 5 通过 / 1 跳过）仍然是 `0`。有跳过本身不是问题 ——
**跳过掩盖了「什么都没验」才是**。拿「有条目被跳过」当失败条件会误伤
（平台不适用、上游没产出都是合理跳过）。

**为什么不用另一条路（让 `ci-summary` 去解析输出里的「跳过 N」）**：

- 退出码是 CI **已经在读**的信号。`npm run test:gui` 是 `&&` 链，非零即让
  `gui-tests` 失败、`CI 总览` 随之变红 —— **不需要把每个文件的日志搬进汇总 job**。
  解析输出那条路要把文本跨 job 传出来，链条更长、更脆
- 退出码在**本地与 CI 同源**：本地跑一次就能看到同一个判定。解析输出只在 CI 生效，
  本地仍会「全跳过 → 退出码 0」

**关键判断：一个永远跳过的测试，和一个不存在的测试，在门禁上没有区别。**
两者都没让任何断言真的跑过，提供的信号都是零。既然第 10 条认定
「不在 CI 里跑的测试等于没有测试」，那「跑了但一条都没通过」同样不能算绿。

⚠️ **所以退出码 `2` 是刻意的，不是 bug。** 那些依赖本机端点的脚本在 CI 上
永远拿 `2` —— 这正是事实：**它们在 CI 上没有信号**。正确处置是别把它们
当成 CI 的覆盖（或补上不依赖端点的断言），**不是把判定调松**。

#### 补丁：`h.check` **内部**的 `h.skip` 会把这条 check 记成 PASS（Issue #64，已修）

上面那道防线有个缺口：它的判据是 `passed === 0`，而 `h.check(name, fn)` 的语义是
「fn 不抛异常就算过」—— 在回调里写 `h.skip(...)` 再 `return`，只会**多追加**一条
SKIP，外层那条 check 照样记成 PASS。于是报告里同时出现 `[PASS]` 与 `[SKIP]`，
**一段一条断言都没跑的代码把 `passed` 顶成 1**，退出码回到 `0`，正好绕开防线。
`command-exec.mjs` 的 A / C 两条在 Windows 上就是这个形态（`h.skip` 后 `return`）。

**做法：让「跳过」成为一条能中止 check 的控制流。** `h.skip()` 在 `h.check` 的
回调里抛出哨兵 `SkipSignal`，`h.check` 捕获后把这一条**改记为 SKIP**：

- 一条 `h.check` 恒等于报告里的一行 —— 不会再出现「PASS 与 SKIP 并列」；
- 跳过的 check **不计入 passed**，所以「所有 check 都被跳过」时退出码是 `2`；
- 在回调里 `h.skip` 会中止**整条** check（没有「只跳过其中一条断言」的粒度，
  需要那种粒度就把那条断言拆成单独一条 `h.check`）；
- 回调里的 `label` 必须**就是外层 check 的 label**（对不上直接抛错）。同一条 check
  在「平台不适用」与「端点不可用」两条路径下，报告里的名字才是同一个；
- 在 check **外面**调用 `h.skip` 行为完全不变（整轮跳过那 7 个脚本走的就是这条路）。

回归防线在 `tests/unit/harness-exit-code.test.mjs`（同一个文件里的第二组用例）。

### 10. 不在 CI 里跑的测试，等于没有测试

某次迁移发现三个 e2e 文件（`real-model` / `doc-parsing` / `docx-runtime`）
**根本不在 CI 的调用链里** —— `ci.yml` 的 gui-tests 只跑 `npm run test:gui`
与 `test:gui:model && test:gui:loop`。

比「静默变绿」更隐蔽：它连跑都没跑，而仓库里没有任何地方会告诉你。

**新增测试后，去 `ci.yml` 确认它真的进了某条调用链。**

### 11. 安全扫描的告警要**判断**，不要为了过门禁就点掉

CodeQL 在测试脚本上报的 `js/file-access-to-http` 是**误报**：
测试读开发者自己的 `~/.claude/settings.json`，再 POST 到同一个配置里写的地址探活 ——
源与目的地同源，没有不可信输入。（CodeQL 自己也把这些实例标为 `classifications: ["test"]`。）

但**「是误报」这个结论要先做出来再处置**。正确做法是带理由 `dismiss` 到
Security 页面（可追溯、日后不重复报），**不是**把 PR 上的对话点掉了事 ——
那样告警还开着，下次改动同一段代码又会被拦。

## 四、验收标准：反向验证

> **没有反向验证的测试防线是假的。**

每加一条关键断言，都要问自己：**把被测功能删掉，这条会红吗？**
会红才是真测试；不会红的是同义反复。

具体做法（**必须真的执行一次**，不是想一想）：

```bash
# 1. 记下当前状态
cp <被测文件> /tmp/backup

# 2. 注入缺陷（改掉一个关键分支、去掉一个参考值、注释掉一条路径）

# 3. 跑测试，确认**恰好**相关的用例变红、其余不受影响
npx vitest run tests/unit/<x>.test.mjs

# 4. 恢复，确认重新全绿
cp /tmp/backup <被测文件>
```

**本项目已做过的两次真实反向验证**（可作为范例）：

- 把 PNG 解码器 Paeth 还原里的 upLeft 参考去掉 →
  **恰好**「滤波类型 4」那一条变红，其余 18 条不受影响
- 去掉 e2e 的 userData 隔离 → 并行跑时 `dialog-native` 退出码 1，
  加回去两个用例双双通过

### 4.1 e2e 的反向验证：注入之后**必须重新构建**

`tests/e2e/*` 跑的是 `out/` 里的**构建产物**，不是 `src/`。所以对 e2e 做反向验证时，
改完 `src/renderer/src/app.js`（或任何会被打包进渲染层的文件）**必须**先

```bash
npm run build          # 不重建 = 什么都没注入，你会白跑一轮并得出错误结论
```

然后才跑用例。**这是真实浪费过一轮的**（2026-10-06 的一次反向验证）。
判据很简单：**注入后测试仍然全绿，先怀疑「产物没重建」，再怀疑「这条断言是假的」。**

### 4.2 反向验证的注入与还原，都要能被复核

注入 → 跑 → 报告「哪些变红了」→ 还原 → 再跑一次确认全绿。**四步都要留下实际输出**。
只报「做了反向验证」不算证据：本项目要求的是「哪一条变红、变红的文案是什么」。
还原的判据是 `git diff --stat src/` 为空 —— 注入**绝不能**跟着提交进主干。

---

## 四·补、断言不要依赖「本机恰好配了什么」

**同一条断言在本机与 CI 上走的是不同分支 —— 这类红灯看起来像产品缺陷，其实是环境差异。**

2026-10-06 的真实一例：一条断言写死了首页「还没有选定要用哪个模型」，
而文案由 `judgeModelReadiness()` 决定 —— 它在**一个可用模型都没有**时给的是
另一句（「还没有可用模型，现在还不能开始对话」）：

| 环境 | 已配置的服务商 | 走哪个分支 |
| --- | --- | --- |
| 开发机 | `ANTHROPIC_AUTH_TOKEN` 让 Anthropic 可用 | `model-not-usable` |
| CI runner | 一个都没有 | `no-model-at-all` |

**写法**：把「现状」写成一份**允许集合**并断言整对匹配（文案与动作要成对，不许混搭），
而不是写死一条。**更要有办法在本机复现 CI 那一侧** —— 把那个环境变量摘掉再跑：

```bash
env -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_API_KEY npm run test:gui:<name>
```

CI 上能跑红的用例，**本机必须也能跑红**，否则你无法在推之前知道结果（§七 那条
「一切以 CI 为准」的代价太大：一次迭代一个多小时）。

> 同族的还有：依赖本机装有某个运行时、依赖某个端口空闲、依赖界面语言 / 时区。
> 共同点都是**把「这台机器碰巧是什么样」写进了断言**。写之前问一句：
> **这条断言在另一台干净的机器上还成立吗？**

---

## 五、踩过的坑（都真实发生过）

### 1. Electron 的 userData 不隔离 → e2e 会互相踢掉

主进程调 `app.requestSingleInstanceLock()`，而这个锁落在 **userData 目录**里，
**与 `ZEROWORK_CONFIG_DIR` 无关**。两个实例碰在一起，后起的立刻 `app.quit()`。

症状**极像随机 flake**：跑得慢的先起来，后面每个都立刻退出；单独跑又全过。

解法：harness 给每个用例指定 `--user-data-dir=/tmp/zerowork-ud-<name>`。
这不只是为了并行 —— 一个用例写进 Local Storage 的东西本来也不该漏给下一个。

### 2. 「React 挂载完成」≠「界面就绪」

只等 `#root` 有子节点时，首页的场景标签与案例卡**还没到**（它们要等 daemon
起来后经 IPC 异步取回）。截出来是一张半空的页面。

这正是固定等 9 秒曾经在掩盖的东西 —— 换个机器快慢就不一样了。
现在的就绪判据是三个条件：`#root` 挂载、daemon 报启动、DOM 变动静默。

### 3. `finish()` 会 exit，但 mock server 必须先关

顺序必须是 `app.close()` → `mock.close()` → `h.finish()`。
若先关 mock 再 finish，`server.close()` 会等 daemon 与 mock 之间还活着的长连接断开，
严重时被看门狗判超时。

### 4. 测试夹具自己写错也会被 round-trip 抓住

写 PNG 测试夹具时，滤波的参考像素应当取**原图**，第一版取的是已滤波的字节，
filter 1–4 全部对不上。round-trip 测试当场抓了出来 —— 这正说明它不是走形式。

### 5. 别让用例之间共享临时目录名

早期多个用例共用 `/tmp/zerowork-workspaces`，互相清空。现在一律由 `name` 派生。

---

## 六、新增一个用例的完整步骤

1. 想清楚**这一层对不对**：能单测就单测
2. `tests/e2e/<name>.mjs`，`createHarness({ name: "<唯一名>" })`
3. 在 `package.json` 加脚本 `test:gui:<x>`，并加进 `test:gui` 的链条
4. 写断言 → **加截图**（`h.shoot`）→ 确认断言没被削弱
5. **反向验证**：注入缺陷确认会红
6. 跑 `npx eslint tests/e2e/` 与 `node scripts/lint.mjs`
7. 全仓 U+FFFD 扫描（命令见 `AGENTS.md`）

---

## 七、已知限制（不要假装不存在）

- **CI 只跑 macOS 的 GUI 测试**。脚本硬编码 POSIX `/tmp` 路径；
  Linux 还需 xvfb + `--no-sandbox`；Windows 会因路径整体失败
- **7 个脚本依赖本机 `~/.claude/settings.json` 的模型端点**（`real-model` /
  `doc-parsing` / `docx-runtime` / `skill-mcp` / `command-exec` / `automation-run` /
  `session-branch`）。端点探不到时按情形逐条 `h.skip`：其中 5 个会**整轮跳过**，
  于是以退出码 `2`（无信号）结束 —— 见第 9 条。**它们在 CI 上没有信号，这是事实**：
  这几个文件也不在 `gui-tests` 的调用链里（第 10 条），指望它们守住 CI 是错的
- **`resources/**` 不参与本项目的测试工具链**（见 `.trellis/spec/resources/`）
- **渲染层是 chunk 粒度、没有组件源码**，所以不存在「组件单测」这种可能；
  界面只能通过 e2e 的 DOM 断言 + 像素断言覆盖

---

## 相关

- `AGENTS.md` —— 命令速查与仓库操作规则
- `.trellis/spec/renderer/index.md` —— 改界面时的规范
- `tests/e2e/lib/harness.mjs` —— 骨架的实现与逐条注释
