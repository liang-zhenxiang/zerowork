# 首页上手清单的三态：加载 / 读失败 / 三步完成（#148）

## 背景

`OnboardingChecklist`（`src/renderer/src/app.js`）此前是一句：

```js
if (error !== void 0 || snapshot === void 0 || workspaces === void 0 || sessions === void 0) return null;
```

三种本该互斥且可辨的情形（`docs/DESIGN.md` §4）在界面上长得一模一样 —— 什么都不显示。
而「三步都完成、且未展开」才是唯一该什么都不显示的形态。**读失败的用户会读成
「这个应用没有引导」**，§4 要求的「错误就地呈现并给出重试动作」完全没有落点。

视觉方案见 `research/ux-proposal.md`（先出方案再动手，是 Issue 的明确要求）。

## 期望

- [ ] 读失败 → 就地错误态（原因 + 重试），**不吞错误**
- [ ] 加载中 → 与真行同尺寸同位置的骨架（§4 的骨架纪律）
- [ ] 三步完成 → 保持现在的「上手清单」小按钮
- [ ] 三态共用 `.home-guide` 这个槽，`--space-5`(16px) 底距不变（§3.8 与 §3.9 都不破）
- [ ] GUI 用例覆盖三种情形 + 各种一张截图；反向验证：把错误分支改回 `return null` 恰好那条变红

## 关键设计决策（详见 research/ux-proposal.md）

1. **不新增盒子**：错误态与加载态都复用清单那块「填色无边」的次级面，不复用带边框的
   `.state-error`（那会变成主列里的第二个盒子，违反 §3.9）
2. **加载给骨架、不给留白**：留白会造成输入卡位移；骨架与真行同高同位置，是「原地填上」
3. **不加显示延迟**：侧栏「历史任务」骨架就是立刻显示的既成先例，两处行为要一致
4. **错误靠图标 + 危险色文字 + 重试按钮表达**，不靠边框

## 入手位置

- `src/renderer/src/app.js` 的 `OnboardingChecklist`
- `src/renderer/src/app.css` 的 `.home-guide*`
- 新增 `tests/e2e/home-checklist-states.mjs`（自己的 harness 名，独立隔离目录）

## 难度

小到中。逻辑就是一次三态展开；成本在视觉判断与「怎么在 GUI 里稳定注入读失败」。
