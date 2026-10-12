/**
 * 首页「继续推进」的交接摘要：把一个会话的原始 JSONL 条目折成一句「干到哪了」。
 *
 * 为什么单独一个纯模块（与 library.js 同模式）：`session-files.js` 在模块顶层就
 * `requireParentPort()` 并 `loadResources()`，在 Electron utilityProcess 之外根本
 * import 不了 —— 把摘要判定放那里等于放弃单测，而「交付优先 / 末条回复 / 退化」
 * 的优先级正是要靠单测钉死的逻辑（改错优先级不会崩，只会显示错的摘要）。
 *
 * 输入格式：会话 `.jsonl` 逐行 `JSON.parse` 出来的条目对象（`type: "message"` /
 * `type: "custom"` + `customType`，`message.content` 是字符串或 `{type:"text"}` 块
 * 数组）。它与 pi 的 `SessionManager.getEntries()` 返回值同构（IO 层喂的就是它），
 * 所以这里不碰文件系统、也不感知 Electron。文本提取复用 session-view.js 导出的
 * `textOf`（与 library.js 同源），不另写一份等价实现。
 *
 * 措辞分工（design.md §2.2）：digest 只报事实（交付了哪些文件 / 最后一句说了什么）；
 * 「进行中…」前缀、相对时间、单位换算全在渲染层 —— 它已有 running 字段与
 * formatMessageTime，重复一份只会漂移。
 */

import { basename } from "node:path";
import { textOf } from "./session-view.js";

/** 文本摘要的截断上限（字）。 */
const DIGEST_TEXT_MAX = 60;

/**
 * 尾部窗口条数：交付与末条回复必然在会话尾部，只扫最后这么多条条目，
 * 防大会话全量解析（入口在 IO 层，见 session-files.js 的 sessionDigest）。
 */
const DIGEST_TAIL_WINDOW = 200;

/**
 * 会话文件的超限阈值：超过就不读、直接退化 fallback。JSONL 条目跨行，
 * 尾部按字节截断会碎出半行坏 JSON；真实会话多在百 KB 级，这条退化极少触发。
 */
const DIGEST_LARGE_FILE_BYTES = 2 * 1024 * 1024;

/** delivered 摘要里最多列出的文件名个数，其余记进 extra 计数。 */
const DIGEST_NAMES_MAX = 2;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** ISO 时间戳 → ms；缺失 / 坏值 → 0（渲染层退用会话 modifiedAt）。 */
function timeOf(value) {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * 粗清洗 markdown 噪声（design.md §2.2：粗清洗，不追求完美）。
 *
 * 摘要只有 60 字，完整 markdown → 纯文本的转换要引入依赖不值得；这里只去掉
 * 对「干到哪了」没有信息量的东西：代码围栏整段（含流式中断留下的未闭合残段）、
 * 链接 URL（留链接文字）、裸 URL、行首的标题 / 引用 / 列表标记、行内代码反引号，
 * 以及首尾的强调符与空白。中间的 `*` `_` `~` 可能是正当用法，不动。
 */
function cleanSummaryText(raw) {
  let text = typeof raw === "string" ? raw : "";
  if (text === "") return "";
  // 代码围栏整段去掉：围栏里的代码对「干到哪了」没有信息量。先去闭合段，
  // 再去未闭合的残段（流式中断时文件尾部可能只有开栏没有收栏）。
  text = text.replace(/(```|~~~)[\s\S]*?\1/g, " ").replace(/(```|~~~)[\s\S]*$/g, " ");
  // 链接留文字去 URL；剩下的裸 URL 整个去掉。
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/https?:\/\/\S+/g, " ");
  // 行首标记（标题井号 / 引用 / 列表符 / 有序序号）按行去。
  text = text.replace(/^\s{0,3}(?:[#>]+|[-*+]\s+|\d+[.)]\s+)/gm, " ");
  // 反引号几乎只会是行内代码标记，全局去掉（摘要里裸反引号没有正当用法）；
  // 成对的 ** 同理是加粗标记，也全局去掉。单个 * _ ~ 可能是正当用法，只清首尾。
  text = text.replace(/`/g, "").replace(/\*\*/g, "");
  // 首尾的强调符与空白；随后折叠中间的空白（换行折成空格，摘要是一句话）。
  text = text.replace(/^[\s#*_~>-]+/, "").replace(/[\s#*_~>-]+$/, "");
  return text.replace(/\s+/g, " ").trim();
}

/**
 * 折出一句「干到哪了」（**纯函数，不碰文件系统**）。
 *
 * 从尾部窗口的**尾向头**找两类锚点，优先级（design.md §2.2）：
 *  1. 最后一次交付（`customType: "artifacts_presented"`）且其后没有新的
 *     assistant 文本 → `{kind:"delivered", names, extra, at}`；
 *  2. 否则最后一条有文本的 assistant message → `{kind:"text", text, at}`
 *     （清洗 + 截断 DIGEST_TEXT_MAX）；
 *  3. 都没有（纯工具流 / 坏数据 / 空）→ `{kind:"fallback"}`。
 *
 * 「其后」只看 assistant 文本：交付后用户又发了消息但模型还没回，摘要仍是
 * delivered —— 那是此刻真实的状态，不是要掩盖的竞态。
 *
 * 坏条目（非对象 / 无 type）跳过不炸；`records` 不是数组时按空处理。
 */
function summarizeLastActivity(records, options = {}) {
  const tailWindow = typeof options.tailWindow === "number" ? options.tailWindow : DIGEST_TAIL_WINDOW;
  const maxChars = typeof options.maxChars === "number" ? options.maxChars : DIGEST_TEXT_MAX;
  const namesMax = typeof options.namesMax === "number" ? options.namesMax : DIGEST_NAMES_MAX;
  const windowed = Array.isArray(records) ? records.slice(-tailWindow) : [];
  // 从尾向头扫，各自记**第一次**命中（即文件序里的最后一条）与下标。
  let deliveredIdx = -1;
  let deliveredNames;
  let deliveredAt = 0;
  let textIdx = -1;
  let textContent = "";
  let textAt = 0;
  for (let i = windowed.length - 1; i >= 0; i--) {
    const record = windowed[i];
    if (!isPlainObject(record)) continue;
    if (textIdx === -1 && record.type === "message") {
      const message = record.message;
      if (isPlainObject(message) && message.role === "assistant") {
        const cleaned = cleanSummaryText(textOf(message.content));
        if (cleaned !== "") {
          textIdx = i;
          textContent = cleaned;
          textAt = timeOf(record.timestamp);
        }
      }
      continue;
    }
    if (
      deliveredIdx === -1 &&
      record.type === "custom" &&
      record.customType === "artifacts_presented"
    ) {
      const files = isPlainObject(record.data) && Array.isArray(record.data.files) ? record.data.files : [];
      const names = [];
      for (const file of files) {
        if (!isPlainObject(file) || typeof file.path !== "string" || file.path === "") continue;
        const name = basename(file.path);
        if (name !== "") names.push(name);
      }
      // 没有有效文件的交付条目不算交付（没东西可展示），继续向前找。
      if (names.length > 0) {
        deliveredIdx = i;
        deliveredNames = names;
        deliveredAt = timeOf(record.timestamp);
      }
    }
    if (deliveredIdx !== -1 && textIdx !== -1) break;
  }
  if (deliveredIdx > textIdx) {
    return {
      kind: "delivered",
      names: deliveredNames.slice(0, namesMax),
      extra: Math.max(0, deliveredNames.length - namesMax),
      at: deliveredAt,
    };
  }
  if (textIdx !== -1) {
    const text = textContent.length > maxChars ? `${textContent.slice(0, maxChars)}…` : textContent;
    return { kind: "text", text, at: textAt };
  }
  return { kind: "fallback" };
}

export {
  DIGEST_LARGE_FILE_BYTES,
  DIGEST_NAMES_MAX,
  DIGEST_TAIL_WINDOW,
  DIGEST_TEXT_MAX,
  summarizeLastActivity,
};
