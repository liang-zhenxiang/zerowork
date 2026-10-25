/**
 * 提示词模板的纯逻辑：校验、归一、id 生成。
 *
 * 为什么单独一个 shared 模块：写侧（daemon 的 `setPromptTemplates`）与读侧
 * （daemon 的 `readPreferences`）必须共用**同一份判据** —— 否则会出现
 * 「写进去能过、重启后读回来被丢掉」的半截状态；而渲染层还要用同一套上限
 * 做输入框的 `maxLength`。三处任何一处漂移都是静默的数据丢失，所以收在
 * `src/shared/` 里，daemon 与 renderer 都从这里 import。
 *
 * 这里刻意不碰任何 Electron / DOM / 文件系统：纯函数才好钉死边界条件。
 */

/** 标题上限：首页卡片一行放得下（中文字符按 1 计）。 */
export const STARTER_TITLE_MAX = 40;

/** 提示词上限：够写一段完整的开局指令，又不至于把 preferences.json 撑坏。 */
export const STARTER_PROMPT_MAX = 2000;

/** 自定义模板数量上限：再多首页那四格就轮不过来了，「换一批」也会变成折磨。 */
export const STARTER_COUNT_MAX = 12;

/** 模板 id 的形状。带前缀是为了和 resources/ 里的内置案例 id 区分（它们没有前缀）。 */
export const STARTER_ID_PATTERN = /^tpl-[a-z0-9]{4,32}$/;

/**
 * 生成一个模板 id。
 *
 * 不用 `crypto.randomUUID()`：它带连字符，还要额外正则宽容；也不用纯时间戳：
 * 同一毫秒内连点两次「新增」会撞 id（撞了就被去重丢掉，界面上表现为「点了没反应」）。
 * 时间戳 + 随机尾数，长度稳定在 4~32 的窗口里。
 */
export function createStarterId(now = Date.now(), random = Math.random) {
  const stamp = now.toString(36).slice(-8);
  const tail = Math.floor(random() * 36 ** 3)
    .toString(36)
    .padStart(3, "0");
  return `tpl-${stamp}${tail}`;
}

function cleanText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 归一单条模板。
 *
 * 返回 `{ ok: true, value }` 或 `{ ok: false, reason }` —— 调用方需要知道
 * **为什么**被拒（设置里要把原因显示出来），所以不是静默 undefined。
 */
export function normalizeStarter(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "模板必须是一个对象" };
  }
  const id = cleanText(raw.id);
  const title = cleanText(raw.title);
  const prompt = cleanText(raw.prompt);
  if (!STARTER_ID_PATTERN.test(id)) {
    return { ok: false, reason: `模板 id「${id}」不合法（须匹配 ${STARTER_ID_PATTERN.source}）` };
  }
  if (title === "") return { ok: false, reason: "标题不能为空" };
  if (title.length > STARTER_TITLE_MAX) {
    return { ok: false, reason: `标题最多 ${STARTER_TITLE_MAX} 个字符（现在 ${title.length}）` };
  }
  if (prompt === "") return { ok: false, reason: "提示词不能为空" };
  if (prompt.length > STARTER_PROMPT_MAX) {
    return { ok: false, reason: `提示词最多 ${STARTER_PROMPT_MAX} 个字符（现在 ${prompt.length}）` };
  }
  return { ok: true, value: { id, title, prompt } };
}

/**
 * 归一整份模板列表：逐条校验、按 id 去重、按数量上限截断。
 *
 * 读侧对脏数据**宽容**（丢掉坏的那条，留下好的），写侧对脏数据**严格**
 * （`assertStarters` 直接抛错）。这个不对称是有意的：偏好文件可能被手改、
 * 被旧版本写坏，读不回来就整份丢会让用户以为「我的模板全没了」；
 * 而写入是我们自己发起的，拒绝非法值才能保证「写进去的一定能原样读回来」。
 */
export function normalizeStarters(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const result = normalizeStarter(item);
    if (!result.ok) continue;
    if (seen.has(result.value.id)) continue;
    seen.add(result.value.id);
    out.push(result.value);
    if (out.length >= STARTER_COUNT_MAX) break;
  }
  return out;
}

/**
 * 写侧校验：不合法就抛。错误信息要能直接显示给用户（设置里的行内错误）。
 */
export function assertStarters(raw) {
  if (!Array.isArray(raw)) throw new Error("模板列表必须是数组");
  if (raw.length > STARTER_COUNT_MAX) {
    throw new Error(`最多保存 ${STARTER_COUNT_MAX} 个模板（现在 ${raw.length}）`);
  }
  const normalized = [];
  const seen = new Set();
  for (const item of raw) {
    const result = normalizeStarter(item);
    if (!result.ok) throw new Error(result.reason);
    if (seen.has(result.value.id)) throw new Error(`模板 id 重复：「${result.value.id}」`);
    seen.add(result.value.id);
    normalized.push(result.value);
  }
  return normalized;
}
