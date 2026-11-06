# 技术设计

> 调研结论见 `docs/ONBOARDING-RESEARCH.md`（8 个同类产品的横向对比 + 6 条按性价比排序的建议）。
> 本文件只讲**怎么做**。

---

## 一、首页三步清单（核心）

### 现状

`ModelGuide`（`app.js:14949`）是全应用**唯一**的「下一步」指引，
它只覆盖三个必要条件里的**一个**（有可用模型）：

```js
function ModelGuide({ modelId, onOpenSettings }) {
	if (error !== undefined || snapshot === undefined) return null;
	const readiness = judgeModelReadiness(modelId ?? snapshot.activeModelId, snapshot.models);
	if (readiness.kind === "ready") return null;     // 有模型就整块不显示
	return jsx("div", { className: "home-guide", role: "status", ... });
}
```

**问题不只是"少了两项"，而是它制造了一个死胡同**：缺模型时它把用户推向设置页；
用户照做配好模型回来，清单消失了，首页那些案例卡看起来可以点了 ——
但其实用户**还没有工作空间**，点了也发不出去。

### 方案：泛化为 `OnboardingChecklist`

**复用 `.home-guide` 这套类名与视觉**（`app.css:1918`），不新造样式族 ——
符合 `DESIGN.md` §6「不新造类名」与 §3.3「内容容器走卡片级别」。

三项条件与**推导方式**（不持久化）：

| 项 | 判据 | 数据来源 |
| --- | --- | --- |
| 有工作空间 | 工作区列表非空 | 现有的工作区状态 |
| 有可用模型 | `judgeModelReadiness(...).kind === "ready"` | 复用 `ModelGuide` 已有逻辑 |
| 发出第一条消息 | 存在至少一个会话 | 现有的会话列表 |

**不持久化是有意的**：状态是**推导**出来的，天然与真实情况一致，
不会出现「标记为已完成但其实没配好」。也正因如此，第 3 项（回头路）几乎零成本。

**三项全完成 → 返回 `null`**（与 `ModelGuide` 现在的行为一致，不打扰老用户）。

### 每一行要有**可点的去处**

只显示「你还没做 X」是没用的 —— 每行都要能一键跳到该去的地方：

- 有工作空间 → 新建工作空间
- 有可用模型 → 设置 · 模型
- 第一条消息 → 聚焦输入框 / 挑一个案例

---

## 二、案例卡带上它绑定的专家

### 现状（已核实）

`app.js:15888` 的案例卡点击：

```js
onClick: () => composerRef.current?.setText(c.prompt)
```

**只填提示词，从不选专家。** 而 `resources/welcome/cases.json` 里
**12 个案例、12 个都定义了 `expert` 字段**（`technical-documentation-engineer`、
`data-analytics-reporter` 等）—— 也就是说 12/12 的案例设计意图被丢掉了。

`onSelectExpert` 就在 `HomeView` 的作用域里（`app.js:15698` 传入、`:15852` 转发给 Composer），
**只是一直没接**。`resources/welcome/README.md` 自己也写着这是待办。

### 方案

```js
onClick: () => {
	composerRef.current?.setText(c.prompt);
	if (c.expert !== undefined) onSelectExpert(c.expert);
}
```

改动是一行。**注意**：要确认 `onSelectExpert` 的语义是「设为当前专家」而不是
「切换」—— 若是切换，连点两张卡会互相取消。

---

## 三、侧栏 4 个「敬请期待」

### 先核实，再改

调研报告称它们「长得像正常按钮」。**但这条说法存疑**：

```css
.nav-item-pending { color: var(--text-faint); }   /* app.css:9702 */
```

`--text-faint`（30% 黑）**已经是**「仅禁用态用」的色（`DESIGN.md` §2.1）。
所以它们**看起来就是灰的**，不是"像正常按钮"。

**所以这一条要先看实际截图再决定动不动。** 若确实已经足够明显，就**不改** ——
「改一个本来就对的东西」是负收益。

若需要改，方向是**让不可用这件事无需试错就知道**（`cursor` / 去掉"点了才弹提示"），
而**不是**把它们藏起来（`DESIGN.md` §6 禁止隐藏核心功能）。

---

## 四、本地优先的一句话

首次运行要说清「数据不出本机」，而不是让人去翻文档。
落点：首页空状态或清单区的一句说明文案。

**不新增组件、不新增样式**，用既有排版档位。

---

## 五、回头路

因为清单状态是**推导**的，不需要「重置」按钮 —— 只要在它该出现时出现即可。

但用户可能想**主动再看一遍**：给一个轻量入口（例如首页某处的「上手清单」），
点击后临时展开。**不做持久化的「已读」标记。**

---

## 六、不做

调研文档 §「明确不做」列了 8 条（内置免费额度、一键下载本地模型、强制账号、
独立 feature tour、引导首步做语言+主题、模型目录与量化档位、照抄视觉参数、
为「看起来全」而打开没做好的导航项）。**照该清单执行，不在此重复理由。**

---

## 交付顺序

1. **三**（先核实，可能零改动）
2. **二**（一行改动，缺陷最明确）
3. **一**（主体）
4. **四 / 五**（依附于一）
