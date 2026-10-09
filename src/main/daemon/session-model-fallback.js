/**
 * resume 场景的模型回落（#162 方案 A）：没选过全局模型时，回到这条会话
 * 用它**当时记录的模型**，而不是被「还没有选择模型」挡在门外。
 *
 * ## 为什么是独立模块而不是就地写进 session-files.js
 *
 * `session-files.js` 在模块顶层就 `requireParentPort()`（见 library.js 头注释的
 * 同款理由），在 Electron utilityProcess 之外 import 不了，逻辑放那里等于不可单测。
 * 决策本身是纯函数：输入「全局选择 / 会话记录 / catalog 可用性」，输出一个决策，
 * 不碰文件系统、不碰进程、catalog 以两个方法的形式注入。
 *
 * ## 语义边界（刻意如此）
 *
 * - **只影响 resume**：新建会话没有会话文件可回落，仍然要求全局已选模型（现状不变）。
 * - **不写回全局**：回落是这一次建宿主的临时决定，`activeModelKey` 不被悄悄改 ——
 *   用户在设置里选什么还是什么；写回反而制造「全局选择被 resume 改了」的意外。
 * - **不写会话文件**：`model_change` 条目由 pi 在真实切换时写；回落不伪造历史。
 * - 会话记录的模型接不上（provider 已删 / 没配 Key）时，**宁可拒绝**并点名那个模型，
 *   不静默换成别的 —— 「回到这条会话」如果换了脑子，用户不会察觉但会困惑。
 */

/**
 * 判定建宿主该用哪个模型。
 *
 * @param {object} input
 * @param {string | undefined} input.activeModelKey 全局已选模型（`providerId/modelId`），没有为 undefined
 * @param {{ provider: string, modelId: string } | null | undefined} input.contextModel
 *   会话文件记录的模型（`SessionManager.buildSessionContext().model`）；新建会话没有它
 * @param {object} input.catalog 模型目录，只用两个方法：`isUsable(key)`、`resolveModel(key)`
 * @returns {{ kind: "global", key: string }}
 *   | { kind: "session", key: string }               —— 回落成立：用会话记录的模型
 *   | { kind: "unavailable", key: string, displayName: string }
 *                                                    —— 会话记录了模型但 catalog 接不上
 *   | { kind: "missing" }                            —— 既没有全局选择，会话也没记录（或非 resume）
 */
export function resolveResumeModelKey(input) {
  const { activeModelKey, contextModel, catalog } = input;
  if (activeModelKey !== void 0) return { kind: "global", key: activeModelKey };
  /*
   * 投影的 model 优先来自**最后一条 assistant 消息自带的 provider/model 字段**
   * （pi 的 getSessionContextSettings：它是「最后一轮谁在答」），model_change 条目
   * 反而被它覆盖。缺字段的坏数据（如手改过的老文件）会得到
   * `{provider: undefined, modelId: undefined}` —— 那不是「记录过模型」，
   * 按 missing 走，否则报错会说出「undefined/undefined」这种鬼话。
   */
  if (contextModel != null && typeof contextModel.provider === "string" && contextModel.provider !== "" && typeof contextModel.modelId === "string" && contextModel.modelId !== "") {
    const key = `${contextModel.provider}/${contextModel.modelId}`;
    if (!catalog.isUsable(key)) {
      // provider 整个没了时 resolveModel 也拿不到，回落到 key 本身——总得说出是哪个模型。
      return { kind: "unavailable", key, displayName: catalog.resolveModel(key)?.name ?? key };
    }
    return { kind: "session", key };
  }
  return { kind: "missing" };
}

/**
 * 把决策翻成用户可读的错误（可诊断：缺什么、去哪补）。
 * `kind` 为 `global` / `session` 时返回 undefined —— 那两态不是错误，不该走到这里报错。
 */
export function resumeModelError(decision) {
  if (decision.kind === "unavailable") {
    return new Error(
      `这条会话用的是「${decision.displayName}」，但它当前接不上（对应服务商未配置或已删除）。到设置里接上它，或任选一个已配置的模型，就能打开这条会话。`
    );
  }
  if (decision.kind === "missing") {
    return new Error("还没有选择模型。请点左下角设置，为任一服务商填写 API Key 并选择模型。");
  }
  return void 0;
}
