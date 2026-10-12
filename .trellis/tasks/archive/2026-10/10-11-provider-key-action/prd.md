# 「更换 Key」挂在一个没有东西可换的动作上（#147）

## 背景（动手前核实过的事实）

「设置 → 模型 → 服务商」里，每行右侧的动作是 `🔑 更换 Key`（未配置时是 `填写 Key`）。
判据在 `ProviderRow`：`provider.source === "subscription"` 走 `.provider-hint`，
其余一律给 Key 按钮 —— 而**一键接入本机模型服务**（#146）建出来的那一条，
凭据是 `models.json` 里的占位值 `local-no-auth`（本机服务根本不校验它），
于是那一行对用户说「更换 Key」，却没有东西可换。

顺带核实出一条**同源的隐患**：`canRemoveKey(provider)` 只认 `source === "stored" | "runtime"`，
占位凭据来源正是 stored，所以那一行还挂着「清除」—— 点下去会把占位删掉，
`isUsable` 随即不成立、那条服务商的模型全部变成选不中。**「清除」在这里同样是陷阱**，
它和「更换 Key」是同一个错的两半，一起修。

## 决定：这个事实由 daemon 说，渲染层只决定措辞

Issue 给了两条路（按 baseUrl 是否回环推断 / 只在凭据缺失时才给按钮），并倾向「由 daemon 说」。
核实后选第三条、更贴近事实的判据：

> **这条服务商的凭据，是不是我们自己的占位值。**

为什么不用「baseUrl 是不是回环」：用户按 `docs/USAGE.md` 手工添加的本机服务会**自己填一个
占位 Key**（文档就是这么教的），那一条的「更换 Key」是**该给**的 —— 那是他填的，他能改。
回环地址分不出「我们造的占位」与「用户填的占位」。

为什么不用「凭据缺失时才给」：本机这条**不是缺凭据**（缺了 pi 会判模型不可用、
一键接入根本选不中模型，见 `docs/ARCHITECTURE.md` 的决策表），它缺的是「一个值得换的东西」。

于是 daemon 侧多一个**布尔事实** `placeholderCredential`：

- 凭据本身**不出 daemon**（`readCustomProvider` 刻意不回填 `apiKey`，既有约定），
  所以这件事必须在 daemon 里翻译成布尔值，而不是让渲染层拿到 Key 自己比
- 判据是**存档里的值**等于 `LOCAL_PLACEHOLDER_API_KEY`。用户一旦用「编辑」填了自己的 Key，
  这一位自动变回 false、按钮回来 —— 自愈，不需要额外状态
- 不加进 `source` 枚举：`source` 是 pi 的词汇（凭据来源），我们的占位是这条链自己造的事实，
  塞进去将来可能和 pi 新增的来源名撞车

渲染层据此改三处（都在 `ProviderRow` 关心范围内）：

| 位置 | 现在 | 改后 |
| --- | --- | --- |
| 行内 meta 标签 | 「已保存 API Key」（不准确：用户没保存过任何 Key） | 「已接入本机服务」 |
| 动作位 | `🔑 更换 Key` | `.provider-hint`「无需 Key」（与订阅那行同一手法） |
| `canRemoveKey` | 有「清除」 | **不给**（点了会把占位删掉，那条服务商的模型随即全部不可用） |

## 期望

- [ ] 一键接入出来的本机服务商那行**不再出现**「更换 Key」，也不出现「清除」
- [ ] 云端 / 用户自己填过 Key 的服务商那行**照旧**给「更换 Key」（不能一刀切）
- [ ] GUI 用例分别断言这两种行（接本机 mock + 一个已配凭据的服务商）
- [ ] 单测钉住 daemon 侧的判据（占位 → true；用户填的 Key → false；编辑后仍是占位 → 仍 true）
- [ ] 反向验证：把判据写反，恰好相关用例变红

## 入手位置

- `src/main/daemon/models.js`（新增 `hasPlaceholderCredential`，凭据不出这个模块）
- `src/main/daemon/model-catalog.js` 的 `toProviderInfo`
- `src/renderer/src/app.js` 的 `sourceLabel$1` / `canRemoveKey` / `ProviderRow`
- `tests/e2e/local-model-discovery.mjs`（复用它的一键接入 + mock，不另起一套）
- `tests/unit/custom-provider-apikey.test.mjs`（同一个主题的文件）

## 难度

小。判断的是「这个事实由谁说、按什么判」，代码量很小。
