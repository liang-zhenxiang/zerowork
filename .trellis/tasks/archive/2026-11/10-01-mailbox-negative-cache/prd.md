# 修掉 mailbox 的会话索引负缓存

## Goal

`src/main/daemon/mailbox.js` 的 `memberSessionPath()` 有一个**负缓存**：
索引未命中时不重建，导致**成员产出写进会话文件后的约 1 秒内读不到它**。

跟踪在 Issue #38。

## 背景（已核实的根因）

```js
function memberSessionPath(sessionId) {
	if (sessionId === "") return void 0;
	const dir = getSessionsDir();
	const direct = join(dir, `${sessionId}.jsonl`);
	if (existsSync(direct)) return direct;          // 文件名带前缀时走不到
	const now = Date.now();
	let index = sessionFileIndex;
	if (index === void 0 || index.dir !== dir || now - index.builtAt > SESSION_FILE_INDEX_TTL_MS) {
		index = { dir, builtAt: now, byId: buildSessionFileIndex(dir) };
		sessionFileIndex = index;                    // ← 只在 TTL 过期时重建
	}
	return index.byId.get(sessionId);                // ← 未命中直接 undefined，不重建
}
```

`SESSION_FILE_INDEX_TTL_MS = 1000`。

**负缓存的含义**：索引可能是在「成员会话文件还不存在」的时刻建的，
那个**空的**结论会活满 1 秒 —— 期间所有读取都解析不到该文件。

## 为什么这是产品缺陷而不是测试问题

`readMemberOutput` 附近的注释写着：

> 产出写进成员会话的那一刻就算交付，没有「投递」这个可能失败的环节

**而这个负缓存就是那个「可能失败的环节」。** 注释描述的设计意图与代码行为不一致。

影响面：`<team_output>` 自动投递、`team_read` 取回成员产出，
以及任何在成员产出后 1 秒内读取它的路径。**不是偶发 —— 落在窗口内必然失败。**

## Requirements

- R1 **先写一条会红的单测**（TDD）：文件落盘后**立刻**读必须能读到，
  且**不能靠 sleep 跨过 TTL**。这条测试在修复前必须是红的
- R2 修掉负缓存 —— 未命中时重建一次，而不是让空结论活满 TTL
- R3 **不得**用「把 TTL 调小」或「加 sleep」这类做法绕过。那只是把窗口变窄，不是消除
- R4 确认 `<team_output>` 的自动投递走的是同一判据、一并受益

## Acceptance Criteria

- [ ] 新增的单测在**修复前是红的**（把修复回退，测试必须失败）——
      这是本任务的验收核心，没有它等于没修
- [ ] 单测在**没有任何 sleep** 的情况下通过
- [ ] 修完 `tests/e2e/team-create.mjs` 的迁移版本（已保留）转绿
- [ ] `npm run lint:all` 与 `npm test` 全过
- [ ] 不改变对外语义 —— 只是去掉一个错误的缓存结论

## 约束

- 只改 `src/main/daemon/mailbox.js` 与新增的单测。**不顺手动别处**
- 不动 `resources/**`
- `src/main/daemon/` 是大文件目录，**不得重排**（`AGENTS.md` 红线 6）

## 为什么现在才发现

一直被测试里的 `waitForTimeout(3000)` 盖着 —— 3 秒恰好跨过 1 秒 TTL。
把固定等待换成信号等待之后，**第一次跑就暴露了**。

## Notes

- 单测放 `tests/unit/`（它是纯逻辑 + fs，不需要起应用）
- 一并把 `team-create.mjs` 的迁移版本收进来 —— 它是本修复的**端到端证据**
