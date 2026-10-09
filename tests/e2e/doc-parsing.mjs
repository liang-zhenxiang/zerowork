/**
 * 文档解析工具链端到端测试：真实模型 → read_document 工具 → 提取正文。
 *
 * 补的是此前唯一没验证的功能链路。`read_document` 不是 IPC 通道，
 * 而是**暴露给模型的工具** —— 没有模型就没人调用它，所以一直测不了。
 * 现在用真实模型触发工具调用即可覆盖。
 *
 * 覆盖：
 *   PDF 提取（pdfjs 路径）
 *   DOCX 提取（officeparser / docx-engine 路径）
 *   提取结果真的回传给模型（第二轮请求里带得出标记）
 *
 * 标记法：文档正文里埋唯一标记，模型按提示原样回报。
 * 只有"提取成功 + 回传成功"两个条件同时满足，标记才会出现在回复里。
 *
 * ⚠️ 凭据运行时从 ~/.claude/settings.json 读取，不进仓库、不打印。
 *
 * ── 迁移说明（共享 harness）────────────────────────────────
 *
 * 骨架（隔离目录、启动并等到就绪、check 收集器、末尾报告与退出码）全部来自
 * `./lib/harness.mjs`：不再手写固定路径 /tmp/zerowork-docparse*、不再 `rmSync`、
 * 不再固定等 9 秒、不再自建报告循环。两处等待都走信号（回合结束、快照里出现标记）。
 *
 * ⚠️ 端点探不到时**逐条 h.skip**，不再是整轮 `exit(0)` ——
 *   后者在报告里表现为「全绿」，实际一条断言都没跑，在 CI 上就是零信号。
 *   改后报告会多出「跳过 N」。
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { createHarness, waitUntil } from "./lib/harness.mjs";

// ⚠️ 标记要挑**弱模型也抄得准**的形状。
// 原先用的是 `ZWPDF42` / `ZWDOCX42` —— 一串辅音字母 + 数字。实测弱模型会把
// `ZWDOCX42` 抄成 `ZWDOC42`（掉一个字母），用例就报「模型未回报标记」，
// 看起来像提取链路坏了，其实链路是通的、只是转录出错。
// 改成「可发音的词 + 数字」后转录稳定，而断言强度不变（仍是逐字精确匹配）。
const PDF_MARK = "PLUTO7421";
const DOCX_MARK = "LOTUS8532";

const h = createHarness({ name: "doc-parsing" });

// ── 读取本机模型端点（凭据不落盘、不打印）────────────────────
const SETTINGS = resolve(homedir(), ".claude", "settings.json");

function readEndpoint() {
	if (!existsSync(SETTINGS)) return undefined;
	try {
		const env = JSON.parse(readFileSync(SETTINGS, "utf8"))?.env ?? {};
		const baseUrl = env.ANTHROPIC_BASE_URL;
		const token = env.ANTHROPIC_AUTH_TOKEN;
		const model = String(env.ANTHROPIC_MODEL ?? "").replace(/\[[^\]]*\]$/, "");
		return baseUrl && token && model ? { baseUrl, token, model } : undefined;
	} catch {
		return undefined;
	}
}

/** 解析出可用端点；不可用时给出**能照着修**的原因。 */
async function resolveEndpoint() {
	if (!existsSync(SETTINGS)) {
		return { reason: `未找到 ${SETTINGS}（需要其中的 env.ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL）` };
	}
	const endpoint = readEndpoint();
	if (endpoint === undefined) {
		return { reason: `${SETTINGS} 的 env 里缺少 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL 中的某一项` };
	}
	const probe = await fetch(`${endpoint.baseUrl}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-api-key": endpoint.token, "anthropic-version": "2023-06-01" },
		body: JSON.stringify({ model: endpoint.model, max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
	}).catch(() => undefined);
	if (!probe || !probe.ok) {
		return { reason: `模型端点不可用（HTTP ${probe?.status ?? "无响应"}）：${endpoint.baseUrl}` };
	}
	return { endpoint };
}

/** 端点不可用时要**逐条**上报的跳过项 —— 与下面的 h.check 一一对应。 */
const CHECKS = [
	"启动后界面已渲染",
	"配置真实模型并切换工作区",
	"PDF 提取：模型读出文档标记",
	"DOCX 提取：模型读出文档标记",
	"无渲染层未捕获异常",
];

const { endpoint, reason } = await resolveEndpoint();

if (endpoint === undefined) {
	console.log(`⚠ ${reason}`);
	console.log("  文档解析测试整轮跳过 —— 逐条记入报告，而不是伪装成全绿。");
	for (const label of CHECKS) h.skip(label, reason);
	await h.finish(); // finish 会 exit；下面只有端点可用时才会执行到
}

// ── 准备测试文档（自带生成，不依赖外部预置）─────────────────
// 工作区由 harness 按用例名隔离，不需要自建 / 清空目录。

/** 生成最小可用 PDF。PDF 是文本格式，可直接手写对象结构。 */
function writeMinimalPdf(path, marker) {
	const text = `BT /F1 18 Tf 72 700 Td (ZeroWork PDF Test Marker ${marker}) Tj ET`;
	const stream = `${text}\n`;
	const pdf = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length ${stream.length}>>stream
${stream}endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R/Size 6>>
%%EOF
`;
	writeFileSync(path, pdf, "utf8");
}

/** 生成最小可用 DOCX（zip + OOXML）。 */
function writeMinimalDocx(path, marker) {
	// 用 jszip（项目依赖）在 Node 侧打包，避免重复造 zip
	return import("jszip").then(({ default: JSZip }) => {
		const zip = new JSZip();
		zip.file(
			"[Content_Types].xml",
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
		);
		zip.file(
			"_rels/.rels",
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
		);
		zip.file(
			"word/document.xml",
			`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body><w:p><w:r><w:t>ZeroWork DOCX Test Marker ${marker}</w:t></w:r></w:p></w:body>
</w:document>`,
		);
		return zip.generateAsync({ type: "nodebuffer" }).then((buf) => writeFileSync(path, buf));
	});
}

writeMinimalPdf(resolve(h.WORKSPACE_DIR, "probe.pdf"), PDF_MARK);
await writeMinimalDocx(resolve(h.WORKSPACE_DIR, "probe.docx"), DOCX_MARK);

console.log(`✓ 模型端点可用，测试文档已自动生成：probe.pdf / probe.docx`);

await h.launch();
const win = h.window();

await h.check("启动后界面已渲染", async () => {
	// 先截图后断言：这一屏是后面所有断言的起点，界面不对时图里能直接看出来
	await h.shoot("welcome");
});

await h.check("配置真实模型并切换工作区", async () => {
	const r = await win.evaluate(
		async ({ baseUrl, token, model, ws }) => {
			const k = globalThis.kami;
			try {
				await k.saveCustomProvider(
					{
						id: "local-proxy",
						name: "Local Proxy",
						baseUrl,
						api: "anthropic-messages",
						authHeader: true,
						models: [{ id: model, name: model, reasoning: false, vision: false, contextWindow: 128000, maxTokens: 4096 }],
					},
					token,
				);
				await k.setModel(`local-proxy/${model}`);
				await k.setWorkspace(ws);
				return { ok: true };
			} catch (e) {
				return { ok: false, err: String(e?.message ?? e).slice(0, 200) };
			}
		},
		{ ...endpoint, ws: h.WORKSPACE_DIR },
	);
	assert.ok(r.ok, `配置失败: ${r.err}`);
});

/**
 * 让模型读文档并回报标记。
 *
 * 两段等待都是**信号**，没有一处固定 sleep：
 *   ① 先等整个回合结束（`k.prompt` 落地）—— 工具调用发生在回合内部，
 *      回合没结束时回复还可能继续追加
 *   ② 再等快照的 assistant 文本里真的出现该标记
 *
 * ⚠️ 回合进行中不能用 `h.waitForSettled()`：渲染层有 500ms 级的计时器在改 DOM
 * （时长刷新、等待提示轮播），「连续 800ms 无变动」永远达不到。
 */
async function readDocAndReport(filename, mark) {
	const turn = await win.evaluate(
		async ({ file }) => {
			try {
				await Promise.race([
					globalThis.kami.prompt({
						// 提示词用**自然的提问**，不写「只回复 X、不要加其它内容」——
						// 那会与系统提示词的交付纪律（产出后要做过程叙述）冲突，弱模型会卡在
						// 矛盾里反复权衡、把输出预算烧光。这个坑在 docx-runtime 里踩过。
						text: `请用 read_document 工具读取工作区里的 ${file}，然后告诉我文档正文里那串标记（形如一个单词加四位数字）具体是什么。`,
					}),
					new Promise((_, rej) => setTimeout(() => rej(new Error("TIMEOUT_150S")), 150_000)),
				]);
				return { timedOut: false };
			} catch (e) {
				const msg = String(e?.message ?? e);
				// 超时之外的错误（提供方报错、工具拒绝……）也要留下来 —— 否则现象
				// 只是「模型没回报标记」，真正的原因被吞掉了
				return { timedOut: msg.includes("TIMEOUT_150S"), err: msg.slice(0, 200) };
			}
		},
		{ file: filename },
	);
	if (turn.timedOut) return { timedOut: true, found: false, text: "(回合 150 秒未结束)", err: turn.err };

	// 原来是页面里 `for × 45 + sleep 2s` 的手写轮询，换成 waitUntil：
	// 同样的 90 秒预算，超时时带上最后一次快照状态。
	let state = null;
	let why;
	try {
		await waitUntil(
			async () => {
				state = await win.evaluate(async () => {
					const s = await globalThis.kami.snapshot();
					const assistant = (s?.entries ?? []).filter((x) => x?.role === "assistant" && String(x?.text ?? "").length > 0);
					return { text: assistant.map((x) => x.text).join("\n") };
				});
				return state.text.includes(mark);
			},
			{ timeout: 90_000, interval: 2000, desc: `模型的回复里出现标记 ${mark}（提取成功 + 回传成功才会出现）` },
		);
		return { found: true, text: state.text };
	} catch (error) {
		why = error.message;
	}

	// 失败时的现场取法与改写前一致：全部 assistant 条目的尾部片段
	const tail = await win.evaluate(async () => {
		const s = await globalThis.kami.snapshot();
		const assistant = (s?.entries ?? []).filter((x) => x?.role === "assistant");
		return JSON.stringify(assistant).slice(-300);
	});
	return { found: false, text: tail || state?.text || "(没读到任何 assistant 条目)", why };
}

await h.check("PDF 提取：模型读出文档标记", async () => {
	const r = await readDocAndReport("probe.pdf", PDF_MARK);
	// 先截图、后断言 —— 断言失败时图里才有出问题的那一屏。
	// 名字如实描述画面：本文件不驱动导航，回合结束后界面仍停在欢迎页
	// （会话在后台跑），所以这张图抓的是「PDF 那一轮结束时的界面」。
	await h.shoot("after-pdf-reply");
	assert.ok(!r.timedOut, `读取 PDF 时挂起${r.err ? `（${r.err}）` : ""}`);
	assert.ok(r.found, `模型未能回报 PDF 标记 ${PDF_MARK}。回复尾部: ${r.text}${r.why ? `（${r.why}）` : ""}`);
});

await h.check("DOCX 提取：模型读出文档标记", async () => {
	const r = await readDocAndReport("probe.docx", DOCX_MARK);
	await h.shoot("after-docx-reply");
	assert.ok(!r.timedOut, `读取 DOCX 时挂起${r.err ? `（${r.err}）` : ""}`);
	assert.ok(r.found, `模型未能回报 DOCX 标记 ${DOCX_MARK}。回复尾部: ${r.text}${r.why ? `（${r.why}）` : ""}`);
});

await h.check("无渲染层未捕获异常", () => assert.equal(h.pageErrors.length, 0, h.pageErrors.join("; ")));

await h.finish();
