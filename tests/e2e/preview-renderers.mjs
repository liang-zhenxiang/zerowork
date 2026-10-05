/**
 * 文件预览渲染器端到端测试：工作区里的 `.xlsx` / `.csv` / `.pptx` / `.js` / `.json`
 * → 在「工作空间文件」里点开 → **真的渲染出内容、且各自的样式表已生效**。
 *
 * 补的是一处零覆盖：产物面板里「工作空间文件」这一视图、以及**全部懒加载预览渲染器**
 * （`office-xlsx` / `office-pptx` / `code-preview` / `json-mode`）此前**没有任何测试碰过**。
 * 这几个都是懒加载的重包（office-xlsx 10 万行、office-pptx 7 万行、code-preview 5.6MB），
 * 「打开就白屏 / 打开就报错」正是这类懒加载最典型的故障形态 —— 而且不会有人告诉你：
 * 冒烟测试与 IPC 断言全都照过，只有真去点开那个文件才看得见。
 *
 * 用**真实文件**（不是桩）：xlsx 用仓库里的 `xlsx`（SheetJS）现造，
 * pptx 用 `jszip` 按 OOXML 拼最小部件。渲染链路只有在真文件上才走得通。
 *
 * 断言分三层，缺一层就抓不到对应的故障：
 *   ① 容器与渲染产物（`.preview-office`、canvas、工作表标签/幻灯片文本）；
 *   ② **解析证据**：工作表标签名「探针表」、幻灯片里的标记文本 —— 这些来自文件本身，
 *      只有真解析了工作簿/演示文稿才会出现（表格是 canvas 画的，单元格文本不在 DOM 里，
 *      所以不能拿单元格内容当判据）；
 *   ③ **样式表生效**：断言工作表标签的 padding-left 等于 office-xlsx.css 里的值。
 *      这一条是回归守卫 —— 该 chunk 自己的样式表曾经压根不进产物（见下），
 *      容器和 canvas 都照样在，只有这条会红。
 *
 * 顺带记录一处**真实缺陷**（本测试逼出来的，已在 EXTERNAL_REQUESTS.md 登记）：
 * 懒加载块的样式表在构建产物里不存在时，预加载助手会 reject 懒加载 promise，
 * 未拦截的 `vite:preloadError` 直接把整个渲染层打进错误边界 ——
 * 表现为「点开 xlsx / 代码预览就界面渲染出错」，而不是「样式缺失」。
 *
 * ── 迁移说明（共享 harness）────────────────────────────────
 *
 * 骨架（隔离目录、启动并等到就绪、check 收集器、末尾报告与退出码）全部来自
 * `./lib/harness.mjs`，本文件只剩「驱动界面 + 断言」。启动不再固定等 9 秒，
 * 发送不再固定等 4 秒（改为等 **mock 真的收到请求**）。
 *
 * ⚠️ 这里**刻意不用** `h.waitForSettled()`：断言发生在模型回合进行中/之后，
 * 而回合期间渲染层有 500ms 级计时器在改 DOM，达不到「800ms 静默」。
 *
 * ── 竞态修复：为什么轮询条件是「全部条件」而不是「第一个条件」──
 *
 * 下面四处页面内轮询原来都是「等到条件 A 成立 → 立刻断言副作用 B」，
 * 而**懒加载的样式表是异步挂进文档的**：内容可以先渲染出来、样式表晚一拍到位。
 * 于是同一条用例「本地快 → 恰好过、CI 慢 → 偶发红」。
 *
 * 真实故障（CI 日志）：json 用例报「文档里没有 json-mode.css」，
 * 而当时 `document.styleSheets` 里 `app.css` / `office-xlsx.css` / `code-preview.css`
 * （更早的预览挂上的）都在，**独缺刚挂上的那一份** —— 正是「晚一拍」的样子。
 *
 * 修法：把该断言涉及的条件**全部**放进同一个轮询的退出条件里，
 * 全满足才返回，慢机器只是多等几轮。**不是**「先等内容、再 sleep 一段时间、再查 CSS」
 * —— 那是把竞态换成一个猜的时长，慢机器上照样红。
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createHarness, waitUntil, ROOT } from "./lib/harness.mjs";

const XLSX_NAME = "预算探针.xlsx";
const XLSX_MARK = "ZEROWORK_XLSX_7788";
// 工作表名会渲染在底部标签上（表格是 canvas 画的，单元格文本不在 DOM 里）——
// 「只有真解析了工作簿才会出现」的那个锚点就是它。
const XLSX_SHEET = "探针表";
// csv / xls 走的是**另一条路**：进预览前先由随包的 SheetJS 把文本/旧格式转成 xlsx
// （vendor-xlsx.js）。这条路的锚点是「转换后工作簿的表名」—— SheetJS 给 csv 的默认名
// 就是 `Sheet1`，只有转换真的跑过才会出现这个名字（见下面那条用例）。
const CSV_NAME = "表格探针.csv";
const CSV_SHEET = "Sheet1";
const PPTX_NAME = "演示探针.pptx";
const PPTX_MARK = "ZEROWORK_PPTX_5566";
// 代码 / 配置预览走的是**同一类懒加载块**（monaco 的 code-preview，以及它按需加载的
// json-mode），两者各自带着自己的样式表 —— 也正是同一个缺陷的受害者，所以一并覆盖。
const JS_NAME = "预览探针.js";
const JS_MARK = "ZEROWORK_JS_3344";
const JSON_NAME = "预览探针.json";
const JSON_MARK = "ZEROWORK_JSON_2211";

const require_ = createRequire(import.meta.url);

// ── 夹具：真实 xlsx（SheetJS 现造）────────────────────────
function writeXlsx(target) {
	const XLSX = require_("xlsx");
	const wb = XLSX.utils.book_new();
	const ws = XLSX.utils.aoa_to_sheet([
		["项目", "金额"],
		["标记行", XLSX_MARK],
		["合计", 42],
	]);
	XLSX.utils.book_append_sheet(wb, ws, XLSX_SHEET);
	XLSX.writeFile(wb, target);
}

// ── 夹具：最小合法 pptx（OOXML 部件用 jszip 拼）──────────
// 不引第三方生成器（仓库里没有 pptxgenjs）：一张幻灯片 + 必需的母版/版式/主题，
// 是 OOXML 规定的最小可解析集合。
async function writePptx(target) {
	const JSZip = require_("jszip");
	const zip = new JSZip();

	zip.file(
		"[Content_Types].xml",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
</Types>`,
	);

	zip.file(
		"_rels/.rels",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`,
	);

	zip.file(
		"ppt/presentation.xml",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>
<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>
<p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>
<p:defaultTextStyle><a:defPPr><a:defRPr lang="zh-CN"/></a:defPPr><a:lvl1pPr algn="l"><a:defRPr sz="1800"/></a:lvl1pPr></p:defaultTextStyle>
</p:presentation>`,
	);

	zip.file(
		"ppt/_rels/presentation.xml.rels",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
</Relationships>`,
	);

	zip.file(
		"ppt/slides/slide1.xml",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
<p:sp>
<p:nvSpPr><p:cNvPr id="2" name="TextBox 1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
<p:spPr><a:xfrm><a:off x="838200" y="838200"/><a:ext cx="7315200" cy="1143000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>
<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" dirty="0"/><a:t>${PPTX_MARK}</a:t></a:r></a:p></p:txBody>
</p:sp>
</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`,
	);

	zip.file(
		"ppt/slides/_rels/slide1.xml.rels",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`,
	);

	zip.file(
		"ppt/slideLayouts/slideLayout1.xml",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank">
<p:cSld name="空白"><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sldLayout>`,
	);

	zip.file(
		"ppt/slideLayouts/_rels/slideLayout1.xml.rels",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>
</Relationships>`,
	);

	zip.file(
		"ppt/slideMasters/slideMaster1.xml",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
<p:cSld><p:spTree>
<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
</p:spTree></p:cSld>
<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>
<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`,
	);

	zip.file(
		"ppt/slideMasters/_rels/slideMaster1.xml.rels",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`,
	);

	// 主题部件内容不重要，但必须存在（部件的 rels 指向它）。
	zip.file(
		"ppt/theme/theme1.xml",
		`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="探针主题">
<a:themeElements>
<a:clrScheme name="探针"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>
<a:fontScheme name="探针"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme>
<a:fmtScheme name="探针"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
</a:themeElements></a:theme>`,
	);

	const buf = await zip.generateAsync({ type: "nodebuffer" });
	const { writeFileSync } = require_("node:fs");
	writeFileSync(target, buf);
}

// ── mock 模型（只要让会话建起来，内容不重要）────────────
function startMockModel() {
	// 记下收到的请求 —— 「发送有没有走通」用这个当判据，比固定等 4 秒可靠
	const requests = [];
	const server = createServer((req, res) => {
		req.on("data", () => {});
		req.on("end", () => {
			requests.push({ url: req.url });
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-office",
					object: "chat.completion.chunk",
					choices: [{ index: 0, delta: { role: "assistant", content: "OFFICE_PREVIEW_READY" } }],
				})}\n\n`,
			);
			res.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-office",
					object: "chat.completion.chunk",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				})}\n\n`,
			);
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	return new Promise((ok) => {
		server.listen(0, "127.0.0.1", () =>
			ok({ baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests, close: () => new Promise((r) => server.close(r)) }),
		);
	});
}

// ── 夹具落盘（工作区由 harness 按用例名隔离）──────────────
const h = createHarness({ name: "preview" });
const WORKSPACE_DIR = h.WORKSPACE_DIR;

writeXlsx(join(WORKSPACE_DIR, XLSX_NAME));
await writePptx(join(WORKSPACE_DIR, PPTX_NAME));
writeFileSync(
	join(WORKSPACE_DIR, CSV_NAME),
	`项目,金额\n标记行,ZEROWORK_CSV_9900\n合计,42\n`,
	"utf8",
);
writeFileSync(join(WORKSPACE_DIR, JS_NAME), `// ${JS_MARK}\nexport const previewProbe = () => 42;\n`, "utf8");
writeFileSync(join(WORKSPACE_DIR, JSON_NAME), `{\n  "mark": "${JSON_MARK}",\n  "n": 1\n}\n`, "utf8");
console.log(`✓ 夹具已生成：${XLSX_NAME} / ${CSV_NAME} / ${PPTX_NAME} / ${JS_NAME} / ${JSON_NAME}`);

const mock = await startMockModel();

await h.launch();
const win = h.window();
await h.snap("home");

/** 等 mock 收到第 n 轮请求 —— 「消息真的发出去了」是比固定等待可靠的信号。 */
async function waitForRequests(n, why) {
	try {
		await waitUntil(() => mock.requests.length >= n, {
			timeout: 40_000,
			interval: 500,
			desc: `mock 收到第 ${n} 轮请求`,
		});
	} catch (error) {
		throw new Error(`mock 只收到 ${mock.requests.length} 轮请求（期望 ≥${n}）—— ${why}（${error.message}）`);
	}
}

/**
 * 在页面里轮询探针，直到它报告「该断言的**全部**条件都就位」。
 *
 * 探针每轮返回一个**完整的状态快照**（`complete` 为真才算完成），
 * 而不是分两步「先等 A，再读 B」—— 懒加载的样式表是异步挂进文档的，
 * 分两步就会踩到「内容先出、样式表后到」的竞态（见文件头）。
 *
 * 超时时把**最后一次探针状态**带进错误里：失败信息要能直接看出卡在哪一步
 * （容器没出现？样式表没进文档？还是计算样式不对？）。
 */
async function waitForComplete(desc, probe, { arg, timeout = 60_000, interval = 800 } = {}) {
	let last = null;
	try {
		return await waitUntil(
			async () => {
				last = await win.evaluate(probe, arg);
				return last?.complete ? last : null;
			},
			{ timeout, interval, desc },
		);
	} catch (error) {
		throw new Error(`${error.message}\n  最后一次探针状态：${JSON.stringify(last ?? "(未取到)").slice(0, 400)}`);
	}
}

/** 点开「工作空间文件」视图，等文件树出现。 */
async function openWorkspaceTree() {
	await win.evaluate(() => {
		const btn = document.querySelector('[aria-label="展开产物面板"]');
		btn?.click();
	});
	// ViewSwitcher：按钮文本是当前视图名（默认「概览」）；点开菜单选「工作空间文件」
	await waitUntil(() => win.evaluate(() => document.querySelector(".view-switcher button") !== null), {
		timeout: 30_000,
		interval: 500,
		desc: "出现视图切换按钮（.view-switcher）",
	});
	const ok = await win.evaluate(() => {
		const btn = [...document.querySelectorAll(".view-switcher button")][0];
		if (btn === undefined) return false;
		btn.click();
		return true;
	});
	assert.ok(ok, "找不到视图切换按钮（.view-switcher）—— 产物面板没打开？");

	await waitUntil(
		() =>
			win.evaluate(
				() => [...document.querySelectorAll(".view-switcher-menu .preview-item")].some((n) => (n.textContent || "").includes("工作空间文件")),
			),
		{ timeout: 30_000, interval: 500, desc: "视图菜单里出现「工作空间文件」项" },
	);
	const picked = await win.evaluate(() => {
		const item = [...document.querySelectorAll(".view-switcher-menu .preview-item")].find((n) =>
			(n.textContent || "").includes("工作空间文件"),
		);
		if (item === undefined) return false;
		item.click();
		return true;
	});
	assert.ok(picked, "视图菜单里没有「工作空间文件」项");
}

/** 点开某个文件行，返回它的标题（便于诊断）。 */
async function clickFileRow(name) {
	// 文件树可能还在扫描，用轮询等它出现 —— 固定等待在慢机器上不够、快机器上白等。
	let listing = "";
	try {
		await waitUntil(
			async () => {
				const r = await win.evaluate((label) => {
					const rows = [...document.querySelectorAll(".file-tree-row.file-tree-file")];
					if (rows.length === 0) return { state: "no-rows" };
					const row = rows.find(
						(n) => (n.textContent || "").includes(label) || (n.getAttribute("title") || "").includes(label),
					);
					if (row === undefined) return { state: "not-found", listing: rows.map((n) => n.textContent.trim()).join("|") };
					row.click();
					return { state: "ok" };
				}, name);
				if (r.listing !== undefined) listing = r.listing;
				return r.state === "ok";
			},
			{ timeout: 40_000, interval: 1000, desc: `文件树里出现「${name}」并点开` },
		);
	} catch (error) {
		if (listing !== "") throw new Error(`文件树里找不到「${name}」。现有条目：${listing}`);
		throw new Error(`等了 40 秒文件树也没出现（.file-tree-row.file-tree-file 为空）—— ${error.message}`);
	}
}

/** 关掉当前预览标签、回到文件列表（面板在预览态下不显示文件树）。 */
async function closePreviewTab() {
	const closed = await win.evaluate(() => {
		const btn = document.querySelector(".preview-tab-close");
		if (btn === null) return false;
		btn.click();
		return true;
	});
	assert.ok(closed, "找不到预览标签的关闭按钮，无法回到文件列表");
	// 等文件树真的回来，而不是固定等 2 秒 —— 回来的快慢由界面说了算
	await waitUntil(() => win.evaluate(() => document.querySelector(".file-tree-row.file-tree-file") !== null), {
		timeout: 30_000,
		interval: 500,
		desc: "关闭预览标签后文件树重新出现",
	});
}

await h.check("建会话并打开产物面板 → 工作空间文件", async () => {
	const r = await win.evaluate(async ({ baseUrl, ws }) => {
		const k = globalThis.kami;
		try {
			await k.saveCustomProvider(
				{
					id: "mock-office",
					name: "Mock Office",
					baseUrl,
					api: "openai-completions",
					authHeader: true,
					models: [{ id: "office-model", name: "office-model", reasoning: false, vision: false, contextWindow: 128000, maxTokens: 4096 }],
				},
				"mock-key",
			);
			await k.setModel("mock-office/office-model");
			await k.setWorkspace(ws);
			return { ok: true };
		} catch (e) {
			return { ok: false, err: String(e?.message ?? e).slice(0, 200) };
		}
	}, { baseUrl: mock.baseUrl, ws: WORKSPACE_DIR });
	assert.ok(r.ok, `配置失败：${r.err}`);

	const box = win.locator('[aria-label="消息输入框"]');
	await box.waitFor({ state: "visible", timeout: 30_000 });
	await box.fill("看一眼工作区里的表格");
	await box.press("Enter");
	// 原来是固定等 4 秒。改成等 mock 真收到请求 —— 消息有没有发出去，这是直接证据。
	await waitForRequests(1, "消息没有发出去");

	await openWorkspaceTree();
	// 先截图、后断言：这一屏是后面所有断言的起点，画面不对时图里能直接看出来。
	await h.shoot("workspace-tree");
});

await h.check("XLSX：预览容器出现且**真的解析了工作簿**", async () => {
	await clickFileRow(XLSX_NAME);
	const r = await waitForComplete(
		`xlsx 预览渲染出工作表标签「${XLSX_SHEET}」且 office-xlsx.css 生效`,
		(sheetName) => {
			const office = document.querySelector(".preview-office");
			if (office === null) {
				return { complete: false, found: false, stage: "no-container", sample: (document.body.innerText || "").slice(-300) };
			}
			// 表格是 **canvas** 绘制的，单元格文本不在 innerText 里 ——
			// 所以断言不能看单元格内容，要看**只有真解析了工作簿才会出现**的
			// 东西：底部的工作表标签（名字来自文件本身）。
			const tab = office.querySelector(".luckysheet-sheets-item-name");
			const tabName = tab === null ? null : (tab.textContent || "").trim();
			// 这条样式只写在 office-xlsx.css 里（app.css 里 0 处）：
			// 拿它证明**该 chunk 自己的样式表真的加载了** ——
			// 曾经它压根不进产物，CSS 预加载失败还会把界面打进错误边界。
			const paddingLeft = tab === null ? null : getComputedStyle(tab).paddingLeft;
			const hrefs = [...document.styleSheets].map((s) => (s.href || "").split("/").pop());
			const canvas = office.querySelectorAll("canvas").length;
			return {
				// **全部条件**就位才算完成：标签名（来自文件）+ canvas + 样式表已进文档
				// 且计算值已生效。此前只等标签名，样式表晚一拍挂上时读到的就是旧值。
				complete: tabName === sheetName && canvas > 0 && hrefs.includes("office-xlsx.css") && paddingLeft === "3px",
				found: true,
				stage: "container",
				tabName,
				canvas,
				hrefs,
				paddingLeft,
				tabWidth: tab === null ? 0 : Math.round(tab.getBoundingClientRect().width),
				note: `容器在但没等到工作表标签；面板头：${(office.querySelector(".preview-office-name")?.textContent ?? "?").trim()}`,
			};
		},
		{ arg: XLSX_SHEET },
	);
	// 先截图、后断言 —— 断言失败时图里才有出问题的那一屏
	await h.shoot("xlsx-preview");
	assert.ok(r.found, `没有出现 .preview-office —— xlsx 预览没打开。界面尾部：${r.sample}`);
	assert.equal(r.tabName, XLSX_SHEET, `工作表标签不对（夹具里的表名就叫「${XLSX_SHEET}」）：${JSON.stringify(r.tabName)}。${r.note ?? ""}`);
	assert.ok(r.canvas > 0, `没有 canvas —— 表格网格没画出来`);
	// 这条是**回归守卫**：样式表没进产物时这里会是 "0px"
	// （轮询已把它纳入完成条件，这里再断言一次是为了把「期望值」写在断言里）
	assert.equal(
		r.paddingLeft,
		"3px",
		`工作表标签的 padding-left 是 ${r.paddingLeft}，不是 office-xlsx.css 里的 3px —— 该 chunk 的样式表没加载。当前样式表：${JSON.stringify(r.hrefs)}`,
	);
	assert.ok(r.tabWidth > 0, "工作表标签宽度为 0 —— 有样式表但布局没生效");
	console.log(`      xlsx 预览：${r.canvas} 个 canvas，工作表标签「${r.tabName}」（宽 ${r.tabWidth}px，样式表已生效）`);
});

await h.check("CSV：走 SheetJS 转换成工作簿后渲染（vendor-xlsx 那条路）", async () => {
	// 上一条（xlsx）结束时预览标签还开着，先关掉回到文件列表。
	await closePreviewTab();
	await clickFileRow(CSV_NAME);
	// 锚点是**转换后工作簿的表名**：`.csv` 进预览前会被 vendor-xlsx.js 读成工作簿
	// 再写成 xlsx 字节，SheetJS 给 csv 的默认表名是 `Sheet1`。
	// 转换没跑（换了 bundle / 导出面不对 / 懒加载失败）时，这个名字不会出现。
	const r = await waitForComplete(
		`csv 预览渲染出表「${CSV_SHEET}」且 office-xlsx.css 生效`,
		(sheetName) => {
			const office = document.querySelector(".preview-office");
			if (office === null) {
				return { complete: false, found: false, sample: (document.body.innerText || "").slice(-300) };
			}
			const tab = office.querySelector(".luckysheet-sheets-item-name");
			const tabName = tab === null ? null : (tab.textContent || "").trim();
			const hrefs = [...document.styleSheets].map((s) => (s.href || "").split("/").pop());
			const canvas = office.querySelectorAll("canvas").length;
			return {
				complete: tabName === sheetName && canvas > 0 && hrefs.includes("office-xlsx.css"),
				found: true,
				tabName,
				canvas,
				hrefs,
			};
		},
		{ arg: CSV_SHEET },
	);
	await h.shoot("csv-preview");
	assert.ok(r.found, `没有出现 .preview-office —— csv 预览没打开`);
	assert.equal(
		r.tabName,
		CSV_SHEET,
		`表名不是「${CSV_SHEET}」：说明 .csv 没有被 SheetJS 转成工作簿（这条路的表名来自转换结果）`,
	);
	assert.ok(r.canvas > 0, "没有 canvas —— 表格网格没画出来");
	console.log(`      csv 预览：${r.canvas} 个 canvas，转换后的表名「${r.tabName}」`);
});

await h.check("PPTX：预览容器出现且渲染出幻灯片文本", async () => {
	// 先关掉 xlsx 的预览标签回到文件列表 —— 面板在预览态下不显示文件树。
	await closePreviewTab();
	await clickFileRow(PPTX_NAME);
	const r = await waitForComplete(
		`pptx 预览渲染出幻灯片文本 ${PPTX_MARK}`,
		(mark) => {
			const office = document.querySelector(".preview-office");
			if (office === null) {
				return { complete: false, found: false, stage: "no-container", sample: "(无容器)" };
			}
			const text = office.innerText || "";
			return {
				// 这里的「条件」与「断言」是同一件事（都看这段文本）—— 本来就没有
				// 「条件 A 成立就断言副作用 B」的竞态，仍统一走同一个轮询，
				// 好让失败时的状态快照格式一致。
				complete: text.includes(mark),
				found: true,
				stage: "container",
				hasMark: text.includes(mark),
				textLen: text.length,
				text: text.slice(0, 200),
				html: office.innerHTML.slice(0, 300),
			};
		},
		{ arg: PPTX_MARK, timeout: 45_000 },
	);
	await h.shoot("pptx-preview");
	assert.ok(r.found, `没有出现 .preview-office —— pptx 预览没打开`);
	assert.ok(
		r.hasMark,
		`幻灯片里没有夹具文本 ${PPTX_MARK}（容器在、内容空 = 白屏）。文本：${JSON.stringify(r.text)}，HTML：${r.html}`,
	);
	console.log(`      pptx 预览渲染出 ${r.textLen} 字符，含夹具文本 ${PPTX_MARK}`);
});

await h.check("CODE (.js)：monaco 渲染出源码，且 code-preview.css 生效", async () => {
	await closePreviewTab();
	await clickFileRow(JS_NAME);
	const r = await waitForComplete(
		`代码预览渲染出 ${JS_MARK} 且 code-preview.css 生效`,
		(mark) => {
			const ed = document.querySelector(".monaco-editor");
			if (ed === null) {
				return { complete: false, found: false, sample: (document.body.innerText || "").slice(-200) };
			}
			const lines = [...document.querySelectorAll(".view-line")].map((n) => n.textContent || "").join("\n");
			const hasMark = lines.includes(mark);
			// 这条 position 只写在 code-preview.css 里（app.css 里 monaco-editor 出现 0 次）
			const position = getComputedStyle(ed).position;
			return {
				// 此前只要 `.monaco-editor` 一出现就返回，随后立刻断言 view-line 里有
				// mark、position 是 relative —— 两件都可能在首帧之后才成立。
				// 源码内容**与**该 chunk 自己的样式表都就位才算完成。
				complete: hasMark && position === "relative",
				found: true,
				hasMark,
				lines: lines.slice(0, 200),
				position,
			};
		},
		{ arg: JS_MARK },
	);
	await h.shoot("code-preview");
	assert.ok(r.found, `没出现 .monaco-editor —— 代码预览没渲染。界面尾部：${r.sample}`);
	assert.ok(r.hasMark, `编辑器里没有夹具代码里的 ${JS_MARK}。首行：${JSON.stringify(r.lines)}`);
	assert.equal(
		r.position,
		"relative",
		`.monaco-editor 的 position 是 ${r.position}，不是 code-preview.css 里的 relative —— 该 chunk 的样式表没加载`,
	);
	console.log(`      .js 预览：monaco 渲染出源码，样式表已生效`);
});

await h.check("CONFIG (.json)：json-mode 按需加载，且 json-mode.css 进了文档", async () => {
	await closePreviewTab();
	await clickFileRow(JSON_NAME);
	const r = await waitForComplete(
		`json 预览渲染出 ${JSON_MARK} 且 json-mode.css 进了文档`,
		(mark) => {
			const ed = document.querySelector(".monaco-editor");
			if (ed === null) {
				return { complete: false, found: false, sample: (document.body.innerText || "").slice(-200) };
			}
			const lines = [...document.querySelectorAll(".view-line")].map((n) => n.textContent || "").join("\n");
			const hasMark = lines.includes(mark);
			// 加载失败的样式表**不会**出现在 document.styleSheets 里，
			// 所以「在不在这个列表里」就是「加载成没成功」的判据。
			const hrefs = [...document.styleSheets].map((s) => (s.href || "").split("/").pop());
			const hasJsonCss = hrefs.includes("json-mode.css");
			return {
				// ⚠️ 这一条就是 CI 上偶发红的那处：原来只等内容出现，然后**立刻**读样式表。
				// 内容与样式表都就位才算完成 —— CI 上遇到的正是「文本先出、CSS 后到」。
				complete: hasMark && hasJsonCss,
				found: true,
				hasMark,
				hasJsonCss,
				hrefs,
				lines: lines.slice(0, 200),
			};
		},
		{ arg: JSON_MARK },
	);
	await h.shoot("json-preview");
	assert.ok(r.found, `没出现 .monaco-editor —— json 预览没渲染。界面尾部：${r.sample}`);
	assert.ok(r.hasMark, `编辑器里没出现 ${JSON_MARK}。首行：${JSON.stringify(r.lines)}`);
	assert.ok(
		r.hasJsonCss,
		`文档里没有 json-mode.css（按需加载的样式表没进来）。当前样式表：${JSON.stringify(r.hrefs)}`,
	);
	console.log(`      .json 预览：json-mode.css 已随按需加载进入文档`);
});

await h.check("构建产物里三份 chunk 样式表都在（这是上游前提）", () => {
	// 界面侧断言只能证明「样式表加载成功了」，证明不了「它被构建出来了」。
	// 这一条守住构建侧：产物里必须有这三份 —— 它们正是曾经完全缺失的那三份。
	const assetsDir = resolve(ROOT, "out", "renderer", "assets");
	for (const name of ["office-xlsx.css", "code-preview.css", "json-mode.css"]) {
		const p = join(assetsDir, name);
		assert.ok(existsSync(p), `产物里没有 ${name} —— 懒加载块的样式表没被构建出来`);
		assert.ok(statSync(p).size > 1000, `${name} 只有 ${statSync(p).size} 字节，可疑`);
	}
	// 反向：入口 CSS 也在（不能为了这三份把入口弄丢）
	assert.ok(existsSync(join(assetsDir, "app.css")), "产物里没有 app.css（入口样式表）");
	console.log(`      产物样式表：app.css + office-xlsx.css / code-preview.css / json-mode.css`);
});

await h.check("无渲染层未捕获异常", () => assert.equal(h.pageErrors.length, 0, h.pageErrors.join("; ")));

// 先关应用再关 mock：应用一关，daemon 与 mock 之间的长连接才会断开，
// server.close() 才不会一直等在那儿。
await h.app().close();
await mock.close();
await h.finish();
