/**
 * 把一次会话渲染成 Markdown（「导出为 Markdown」的纯逻辑内核）。
 *
 * ## 为什么要有这个东西
 *
 * 会话本来只能导出成单文件 HTML（pi 的 `exportToHtml`）。HTML 自包含、能直接看，
 * 但**带不走**：贴进 Notion / Obsidian / 文档 / PR 描述都需要 Markdown，
 * 而从 HTML 页面上复制出来的是带样式的 DOM。办公场景里「把这次对话沉淀成文档」
 * 是真实且高频的一步，所以补一条并列的导出格式。
 *
 * ## 为什么是「照着 HTML 导出的口径写」，不是重新发明
 *
 * pi 的 HTML 导出（`dist/core/export-html/template.js`）已经决定了**哪些条目算内容**：
 * user（含技能块与图片）、assistant（text / thinking / toolCall、stopReason）、
 * bashExecution、toolResult、model_change、compaction、branch_summary、
 * custom_message(display)。本模块逐类对齐它 —— 两边对同一份会话的认识必须一致，
 * 否则同一件事在 HTML 里看得见、在 Markdown 里凭空消失（那是「导出少了半截」的 bug）。
 *
 * ## 三条渲染口径（都是有意的）
 *
 * 1. **超长内容按与界面同一口径截断**（`DETAIL_LIMIT` / `TRUNCATED_MARK`，从
 *    session-view.js 借用）。界面看到的与导出的应当是同一件事；不然「导出」就变成了
 *    「把一个十万字符的工具日志塞进你正准备发给同事的文档里」。
 * 2. **图片不内嵌 base64**，只留一行占位（类型 + 大致体积）。一张截图内联进 Markdown
 *    会让文件从几十 KB 变成几 MB，且绝大多数 Markdown 阅读器在文档里显示不出它 ——
 *    想拿原图可以直接看会话，或先导出 HTML。
 * 3. **代码围栏的长度是算出来的**（内容里出现多长的反引号，围栏就比它长一格）。
 *    写死三个反引号的话，工具输出里只要出现 ``` 就会把整篇文档截断 —— 这是导出功能
 *    最典型的「看起来成功、打开是烂的」事故。
 * 4. **技能调用只留一行「调用了技能 X」**，不搬技能注入进消息里的大段指令。
 *    那段指令（`<skill name="…">…</skill>` 的标签体）是应用的管道，不是用户写的话：
 *    HTML 导出把它折起来藏在可展开块里，Markdown 里没有「折起来」这回事，
 *    原样搬进去只会把用户真正说的那句话淹掉。
 *
 * 纯函数：不碰 IO、不 import Electron、不需要会话宿主，单测直接 import。
 */
import { DETAIL_LIMIT, TRUNCATED_MARK, splitSkillBlocks } from "./session-view.js";

/** 元信息里显示的助手名字。与界面的消息流保持一致（不要在这里另起一个称呼）。 */
const ASSISTANT_LABEL = "ZeroWork";

/** 每种条目的时间戳都可能有，也可能没有（手写 / 旧格式）。统一格式化。 */
function formatStamp(value) {
  if (typeof value !== "string" || value === "") return "";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/** 统一换行、去掉行尾空白：导出的文档不该带着编辑器留下的 CRLF 与尾随空格。 */
function normalize(text) {
  return String(text).replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "");
}

/**
 * 选一段足够长的围栏。
 *
 * Markdown 的围栏规则：内容里出现连续 N 个反引号时，围栏至少要 N+1 个。
 * 这里取「内容里最长连续反引号 + 1，且不少于 3」。
 */
function fenceFor(content) {
  let longest = 0;
  for (const run of normalize(content).match(/`+/g) ?? []) {
    if (run.length > longest) longest = run.length;
  }
  return "`".repeat(Math.max(3, longest + 1));
}

/** 一段代码 / 输出块。语言缺省 text（不写语言有些渲染器不认围栏）。 */
function codeBlock(content, language = "text") {
  const body = normalize(content).replace(/\n+$/, "");
  if (body === "") return "";
  const fence = fenceFor(body);
  return `${fence}${language}\n${body}\n${fence}`;
}

/**
 * 截断结果 → 正文文本。截断时把「原多少字符」**另起一行**写上
 * （`clamp` 已经在正文尾巴留了「（已截断）」，两段说明粘在一起会变成
 * `（已截断）（原 N 字符）` 这种连着的括号，读起来像排版事故）。
 */
function truncationNote({ text, truncated, originalLength }) {
  return truncated ? `${text}\n（原 ${originalLength} 字符）` : text;
}

/**
 * 按界面口径截断后放进围栏。
 *
 * **工具结果与工具入参都必须走这里**：`write` / `edit` 的 `arguments` 里装的是
 * 整个文件正文（pi 的 schema：`write{file_path,content}`、`edit{file_path,old_string,new_string}`），
 * 一条这样的调用就能把导出撑到几 MB —— 只截结果、不截入参，等于口径只兑现了一半。
 * 截断后按纯文本渲染（内容已经不是合法 JSON 了，标 json 会让读者以为能解析）。
 */
function clampedBlock(raw, language) {
  const { text, truncated, originalLength } = clamp(raw);
  if (text.trim() === "") return "";
  return truncated
    ? codeBlock(truncationNote({ text, truncated, originalLength }), "text")
    : codeBlock(text, language);
}

/**
 * 按界面的口径截断长文本。
 * 返回 `{ text, truncated, originalLength }` —— 调用方负责把「截断了多少」写给读者看。
 */
function clamp(text) {
  const body = normalize(text);
  if (body.length <= DETAIL_LIMIT) return { text: body, truncated: false, originalLength: body.length };
  return {
    text: `${body.slice(0, DETAIL_LIMIT)}\n${TRUNCATED_MARK}`,
    truncated: true,
    originalLength: body.length,
  };
}

/** 引用块（思考、摘要这类「不是发给你的正文」的内容）。 */
function quote(text) {
  const body = normalize(text).trim();
  if (body === "") return "";
  return body
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

/** 用户消息：技能调用一段、图片占位一行、正文一段。 */
function renderUser(message) {
  const content = message.content;
  const rawText = typeof content === "string" ? content : textOf(content);
  const { skillNames, text } = splitSkillBlocks(rawText);
  const images = Array.isArray(content) ? content.filter((block) => block?.type === "image") : [];
  const parts = [];
  for (const name of skillNames) parts.push(`> 调用了技能：${name}`);
  for (const image of images) {
    const size = typeof image?.data === "string" ? Math.round((image.data.length * 3) / 4 / 1024) : 0;
    parts.push(`> （图片：${image?.mimeType ?? "image"}${size > 0 ? `，约 ${size} KB` : ""} —— 未内嵌，原图见会话）`);
  }
  const body = text.trim();
  if (body !== "") parts.push(body);
  return parts.join("\n\n");
}

/** 从内容块数组里取纯文本（string 内容直接返回）。 */
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/** 助手消息：正文 → 思考 → 工具调用（每个调用后面跟它的结果，如果有）。 */
function renderAssistant(message, resultsByCallId) {
  const blocks = Array.isArray(message.content) ? message.content : [];
  const parts = [];

  /*
   * 正文与思考**按 content 的原序**渲染（pi 常见的顺序是 [thinking, text]，
   * 把思考一律挪到后面会让「解释这句话的思考」出现在它所解释的句子之后）。
   * 工具调用统一挪到最后 —— 与 pi 的 HTML 导出同一套两遍结构（template.js 的
   * 「先 text/thinking、再 toolCall」），这样工具块不会插断一段连贯的回复。
   */
  for (const block of blocks) {
    if (block?.type === "text") {
      const body = typeof block.text === "string" ? block.text.trim() : "";
      if (body !== "") parts.push(body);
      continue;
    }
    if (block?.type === "thinking") {
      const thinking = typeof block.thinking === "string" ? block.thinking.trim() : "";
      if (thinking === "") continue;
      parts.push(["> 思考", quote(truncationNote(clamp(thinking)))].join("\n"));
    }
  }

  for (const block of blocks) {
    if (block?.type !== "toolCall") continue;
    parts.push(renderToolCall(block, resultsByCallId.get(block.id)));
  }

  if (message.stopReason === "aborted") parts.push("> （这一轮被中止）");
  else if (message.stopReason === "error") {
    parts.push(`> （这一轮出错：${typeof message.errorMessage === "string" && message.errorMessage !== "" ? message.errorMessage : "未知错误"}）`);
  }

  return parts.filter((part) => part !== "").join("\n\n");
}

/** 一次工具调用：名字 + 入参（JSON）+ 结果（若已有）。 */
function renderToolCall(call, result) {
  const name = typeof call.name === "string" && call.name !== "" ? call.name : "（未命名工具）";
  const args = call.arguments === undefined ? {} : call.arguments;
  let argsText = "";
  try {
    argsText = JSON.stringify(args, null, 2) ?? "";
  } catch {
    argsText = "（入参无法序列化）";
  }

  const parts = [`**工具调用：${name}**`];
  if (argsText !== "" && argsText !== "{}") parts.push(clampedBlock(argsText, "json"));

  const outcome = renderToolResult(result);
  if (outcome !== "") parts.push(outcome);
  return parts.join("\n\n");
}

/** 工具结果：正文 + 错误标记；超长按界面口径截断。 */
function renderToolResult(result) {
  if (result === undefined || result === null) return "";
  const body = textOf(result.content ?? "");
  const images = Array.isArray(result.content) ? result.content.filter((block) => block?.type === "image") : [];
  const parts = [];
  if (body.trim() !== "") {
    parts.push(clampedBlock(body, "text"));
  }
  if (images.length > 0) parts.push(`> （工具返回了 ${images.length} 张图片，未内嵌）`);
  if (result.isError === true) parts.push("> 结果：**失败**");
  return parts.join("\n\n");
}

/** 命令执行（bashExecution）。 */
function renderBashExecution(message) {
  const command = typeof message.command === "string" ? message.command : "";
  if (command === "") return "";
  const parts = [codeBlock(`$ ${command}`, "bash")];
  const output = typeof message.output === "string" ? message.output : "";
  if (output.trim() !== "") {
    parts.push(clampedBlock(output, "text"));
  }
  if (message.cancelled === true) parts.push("> （已取消）");
  else if (typeof message.exitCode === "number" && message.exitCode !== 0) {
    parts.push(`> （退出码 ${message.exitCode}）`);
  }
  return parts.join("\n\n");
}

/** 产物交付（本应用的 `custom:artifacts_presented`）。 */
function renderArtifacts(entry) {
  const files = entry?.data?.files;
  if (!Array.isArray(files) || files.length === 0) return "";
  const lines = ["**交付的产物**"];
  for (const file of files) {
    const path = typeof file?.path === "string" ? file.path : "";
    if (path === "") continue;
    const size = typeof file?.size === "number" ? `（${file.size} 字节）` : "";
    lines.push(`- \`${path}\`${size}`);
  }
  return lines.length > 1 ? lines.join("\n") : "";
}

/** 单条条目 → Markdown 片段（不认得的条目返回空串：宁可不写，也不写错）。 */
function renderEntry(entry, resultsByCallId) {
  if (entry === null || typeof entry !== "object") return "";
  if (entry.type === "message") {
    const message = entry.message;
    if (message === null || typeof message !== "object") return "";
    if (message.role === "user") return renderUser(message);
    if (message.role === "assistant") return renderAssistant(message, resultsByCallId);
    if (message.role === "bashExecution") return renderBashExecution(message);
    // toolResult 由它对应的那次工具调用负责渲染（否则会重复一遍）。
    return "";
  }
  if (entry.type === "compaction") {
    const before = typeof entry.tokensBefore === "number" ? entry.tokensBefore.toLocaleString("zh-CN") : "?";
    return [`> **（上下文已压缩：${before} tokens）**`, quote(entry.summary ?? "")].filter(Boolean).join("\n");
  }
  if (entry.type === "branch_summary") {
    return ["> **（分支摘要）**", quote(entry.summary ?? "")].filter(Boolean).join("\n");
  }
  if (entry.type === "model_change") {
    return `> 切换模型：${entry.provider ?? "?"}/${entry.modelId ?? "?"}`;
  }
  if (entry.type === "custom_message" && entry.display === true) {
    const body = typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content ?? "");
    return [`> **（${entry.customType ?? "扩展消息"}）**`, quote(body)].join("\n");
  }
  if (entry.type === "custom" && entry.customType === "artifacts_presented") return renderArtifacts(entry);
  return "";
}

/** 消息与工具调用的计数（元信息行用）。 */
function countEntries(entries) {
  let userMessages = 0;
  let assistantMessages = 0;
  let toolCalls = 0;
  let toolResults = 0;
  for (const entry of entries) {
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role === "user") userMessages += 1;
    else if (message?.role === "assistant") {
      assistantMessages += 1;
      if (Array.isArray(message.content)) {
        toolCalls += message.content.filter((block) => block?.type === "toolCall").length;
      }
    } else if (message?.role === "toolResult") toolResults += 1;
  }
  return { userMessages, assistantMessages, toolCalls, toolResults };
}

/** 最后一次模型切换（元信息行用；没有就空着，不猜）。 */
function lastModel(entries) {
  let model = "";
  for (const entry of entries) {
    if (entry?.type === "model_change") model = `${entry.provider ?? "?"}/${entry.modelId ?? "?"}`;
  }
  return model;
}

/**
 * 正文段落（导出文档里标题与元信息之后的那些块）。
 *
 * 抽出来是为了让「有没有内容可导出」的判据**与渲染本身同源**：早先版本手写了一个
 * 「有 message 或 custom_message 就算有内容」的判断，结果两头都错 ——
 * 只有 compaction / branch_summary / 产物的会话明明渲染得出来却被判成空，
 * 而 `display:false` 的扩展消息判成有内容、写出来却是一篇光有标题的文档。
 * 现在只有一个判据：**渲染出来的正文段落是不是空的**。
 */
function renderSessionBlocks(entries) {
  const list = Array.isArray(entries) ? entries : [];
  // 工具结果先建索引：assistant 的 toolCall 要能就地找到自己的结果（同 pi 的 HTML 导出）。
  const resultsByCallId = new Map();
  for (const entry of list) {
    if (entry?.type !== "message") continue;
    const message = entry.message;
    if (message?.role === "toolResult" && typeof message.toolCallId === "string") {
      resultsByCallId.set(message.toolCallId, message);
    }
  }

  const blocks = [];
  for (const entry of list) {
    const part = renderEntry(entry, resultsByCallId);
    if (part.trim() === "") continue;
    const stamp = formatStamp(entry.timestamp);
    const isUser = entry.type === "message" && entry.message?.role === "user";
    // 每段带一个小标题，文档里才看得出「谁在说」。
    const label = isUser
      ? "## 你"
      : entry.type === "message" && entry.message?.role === "assistant"
        ? `## ${ASSISTANT_LABEL}`
        : undefined;
    // 时间用纯文本跟在标题后（不用 <sub> 这类内联 HTML）：导出的文档要能直接贴进
    // 任何 Markdown 环境，而内联 HTML 在不同渲染器里的支持并不一致。
    const head = label === undefined ? [] : [label + (stamp === "" ? "" : ` · ${stamp}`)];
    blocks.push([...head, part].join("\n\n"));
  }
  return blocks;
}

/** 该会话是否有可导出的内容（判据＝渲染出来的正文段落非空，见 renderSessionBlocks）。 */
function hasExportableContent(entries) {
  return renderSessionBlocks(entries).length > 0;
}

/**
 * 渲染整篇文档。
 *
 * @param {object} input
 * @param {string} input.title       会话标题（来自列表的展示标题）
 * @param {object|undefined} input.header  会话 header（cwd / id / 创建时间）
 * @param {object[]} input.entries   当前分支的原始条目（`SessionManager.getBranch()`）
 * @param {Date} [input.now]         导出时刻（测试注入，缺省取当前时间）
 * @returns {string} Markdown 全文（结尾带一个换行）
 */
function renderSessionMarkdown({ title, header, entries, now = new Date() }) {
  const list = Array.isArray(entries) ? entries : [];
  const counts = countEntries(list);
  const model = lastModel(list);
  const heading = typeof title === "string" && title.trim() !== "" ? title.trim() : "会话记录";

  const meta = [`- 导出时间：${formatStamp(now.toISOString())}`];
  if (typeof header?.cwd === "string" && header.cwd !== "") meta.push(`- 工作空间：\`${header.cwd}\``);
  if (model !== "") meta.push(`- 模型：${model}`);
  meta.push(
    `- 消息：你 ${counts.userMessages} 条 / ${ASSISTANT_LABEL} ${counts.assistantMessages} 条 / 工具调用 ${counts.toolCalls} 次`,
  );
  meta.push("- 由 ZeroWork 导出");

  const blocks = renderSessionBlocks(list);
  return [`# ${heading}`, meta.join("\n"), ...blocks].join("\n\n") + "\n";
}

export {
	ASSISTANT_LABEL,
	clamp,
	clampedBlock,
	codeBlock,
	fenceFor,
	formatStamp,
	hasExportableContent,
	renderSessionBlocks,
	renderSessionMarkdown,
};
