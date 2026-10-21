# 设计：变更审阅台

## 一、数据模型：什么是「一条变更」

版本存储（`version-store.js`）的语义是：**在覆盖之前**把旧内容存一版。所以
`versions[]` 的每一项是「被替换掉的那份内容」，`at / tool / sessionId / added / removed`
描述的是**替换它的那次改动**。

因此「一条变更」= 某个文件的**最后一个版本条目**：

| 字段 | 来源 |
| --- | --- |
| `key` / `path` / `name` / `dir` | `listVersionFiles` |
| `versionId` / `at` / `tool` / `sessionId` / `added` / `removed` | 最后一条 version（**现清单只给 `lastAt`，需补这四项**） |
| `exists` | 目标文件当前是否还在 |
| `reviewed` | `review-state.json[key] === versionId` |

**已阅判定用版本 id 而不是时间戳**：文件再被改一次，`versionId` 变了，自动回到待审阅。
没有时间比较、没有时钟偏差，也不需要清理历史。

## 二、IPC 契约（三条，全部 pull 式）

### `review:list`（无入参）

```js
{
  entries: [{
    key, path, name, dir,
    versionId, at, tool?, sessionId?,
    added?, removed?,
    exists, reviewed
  }],
  pending, reviewed,
  truncated,        // 文件数超过 VERSION_LIST_MAX_FILES
  skippedTotal      // 版本存储里被跳过的次数（二进制/超大）
}
```

按 `at` 降序。**只读 meta，不读任何文件正文** —— 页面打开要快，角标也要便宜。

### `review:read`（`{ key, versionId }`）

```js
{ ok: true, hunks, before, after, truncated, beforeTooLarge?, afterTooLarge? }
| { ok: false, reason: "unknown" | "no-such-version" | "missing" | "binary" | "too-large" | "no-after" }
```

- `before` = `readVersionContent(key, versionId)`（改前）
- `after` = 读**当前磁盘文件**；上限 `REVIEW_MAX_BYTES`（256 KiB），超限 → `too-large`
- 二进制（`\0` 出现在前 8 KiB）→ `binary`
- 文件已不存在 → `no-after`（界面如实说「文件已被删除或移走」，不伪造 diff）
- `hunks` 用既有 `computeLineDiff(before, after)` 的 `.diff`；`DIFF_CELL_BUDGET`
  触顶时 `.diff` 为 `undefined`，此时给 `{ ok:true, hunks: "", added, removed }`
  并在界面说「改动过大，只给增删行数」

### `review:mark`（`{ key, versionId }`）

```js
{ ok: true, pending }
```

写 `review-state.json`。**幂等**；`versionId` 必须与清单里的一致，否则拒绝
（防止「审阅了旧版本却把新版本标成已阅」）。返回新的待审阅计数供角标更新。

## 三、状态文件

`<config>/review-state.json`：

```json
{ "files": { "<key>": { "versionId": "0000000012", "at": 1760000000000 } } }
```

- 坏 JSON / 结构不对 → **当空**（与 `pin.js` / `projects.js` 同口径），最坏后果是丢标记
- 写入原子化（临时文件 + rename），与 `projects-store` 同款
- 只写不读磁盘正文，成本与文件数线性

## 四、读取当前文件的安全边界（红线 4 的延伸）

`review:read` 是**唯一**新增的「读任意路径」入口，因此必须自限：

| 限制 | 值 | 理由 |
| --- | --- | --- |
| 大小 | 256 KiB | 与 `VERSION_MAX_BYTES` 同量级；超过就不给 diff，只给增删行数 |
| 二进制 | 前 8 KiB 含 `\0` | 与 `versions` 的 `looksBinary` 同判据 |
| 符号链接 | 不跟随（`lstat` 判定） | 不让审阅页成为「读 /etc/shadow」的跳板 |
| 不存在 | 返回 `no-after`，不抛 | 文件被删除是正常状态 |

**不做**路径白名单：版本存储本身只记录 Agent 实际写过的路径，天然受工作区约束；
再加白名单会误伤「工作区外但用户明确让 Agent 改」的合法场景。

## 五、渲染层结构

```
「变更审阅」页
├─ 头部：标题 + 「待审阅 N · 已审阅 M」+ 筛选（全部 / 待审阅）
├─ 左列（320px）：变更卡列表（无边框索引列，DESIGN §3.9）
│    每卡：文件名 / 目录 / 相对时间 / +N −M / 状态点（待审阅用 accent，已阅用次文）
└─ 右区：选中项的审阅卡
     ├─ 元信息行：时间 · 工具 · 来源会话（可点「回到会话」）
     ├─ 并排对照：左「改前」右「现在」，统一 diff 着色（+/- 行）
     └─ 动作：标记已阅 / 还原到改前（二次确认）/ 回到会话
```

- **全页只有一个内容卡**：右区是唯一卡片，左列退成索引列（DESIGN §3.9）
- diff 行着色复用 `.code-block` 现有 token，不新增颜色
- 状态不只靠颜色：待审阅有文字标签（DESIGN §7.6）
- 空态 / 加载 / 错误三态齐全
- 角标：侧栏 nav-item 右侧一个小圆点数字，`pending === 0` 时不渲染

## 六、复用与不重复

| 需要 | 复用 |
| --- | --- |
| 版本清单 | `listVersionFiles`（补最后一条版本的四项字段） |
| 改前正文 | `readVersionContent` |
| diff | `computeLineDiff`（`session-view.js`，已导出） |
| 还原 | `versions:restore`（不新造） |
| 二进制判定 | `looksBinary`（`version-store.js`，若未导出则提出为共享纯函数） |
| 原子落盘 | `projects-store` 的临时文件 + rename 形态 |

## 七、风险

1. **补字段会碰既有清单**：`listVersionFiles` 是 `versions:list` 的数据源，文件历史页在用它。
   只**增**字段、不删不改既有字段；既有单测必须全绿。
2. **diff 预算**：超大文件 `computeLineDiff` 返回无 `diff`；界面必须降级为增删行数，
   不能显示空白 diff 装作「没有改动」。
3. **审阅页是新的读盘入口**：大小/二进制/符号链接三条边界必须有单测。
