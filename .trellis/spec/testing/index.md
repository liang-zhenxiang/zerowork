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
| `h.skip(label, reason)` | 跳过但**在报告里留痕**（静默跳过会让「全绿」失去意义） |
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

### 9. 跳过要让**门禁**读得出来，不只是人读得出来

`h.skip()` 让文本报告里出现「跳过 N」，这是第一步。但如果 CI 门禁读不出
「跳过 N」，那**全跳过的运行仍然会以退出码 0 通过** —— 门禁看到的还是绿的。

这是一个**尚未解决的问题**（见 Issue #30）：要么让门禁识别跳过数，
要么让 harness 在「一条都没跑」时非零退出。**在解决之前，不要以为
「报告里写了跳过」就等于「CI 能发现」。**

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
- **7 个脚本依赖本机 `~/.claude/settings.json` 的模型端点**，探不到就整轮
  `exit(0)`。**这意味着它们在 CI 上是零信号** —— 这是已知缺口，不是设计
- **`resources/**` 不参与本项目的测试工具链**（见 `.trellis/spec/resources/`）
- **渲染层是 chunk 粒度、没有组件源码**，所以不存在「组件单测」这种可能；
  界面只能通过 e2e 的 DOM 断言 + 像素断言覆盖

---

## 相关

- `AGENTS.md` —— 命令速查与仓库操作规则
- `.trellis/spec/renderer/index.md` —— 改界面时的规范
- `tests/e2e/lib/harness.mjs` —— 骨架的实现与逐条注释
