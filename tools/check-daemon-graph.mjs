#!/usr/bin/env node
/**
 * 校验 `src/main/daemon/*.js` 的模块图是否闭合。
 *
 * 守三条性质：
 *   ① 每个相对 import 都指向真实存在的文件；
 *   ② 每个具名 import 都能在目标模块的导出里找到；
 *   ③ **每个被引用的自由标识符都有出处**（import / 声明 / 已知全局）。
 *
 * 为什么需要它：daemon 由数十个 ES 模块组成，彼此用相对 import 相连。
 * 这层错误**构建期抓不到** —— 漏一个 export、写错一个路径，只会在运行时
 * 某个冷门分支抛 `ReferenceError`。单元测试只跑 `tests/unit`，不碰模块边界。
 *
 * ③ 是**补上一条真实事故**后加的：给 `session-files.js` 加值守边界时，
 * `onExceedAction` 与 `parseWatchPolicy` 被调用、却忘了写进 import —— 而
 * `src/main/daemon/**` 在 ESLint 配置里是**整目录排除**的（见 eslint.config.mjs
 * 的 ignores：这些是大块生成式模块，不能按手写源码的风格要求），
 * 于是 `no-undef` 从来不检查这里。①② 也抓不到它们 —— 那两条只看 import 语句
 * 本身，不看「某个标识符用没用上」。这条性质守的正是那个缺口：
 * 这类错误只在真正跑到那段分支时才炸，而那段分支是无人值守的定时任务。
 *
 * 手动遍历 AST 而不是引入作用域分析器：这个工具已经在用 espree，为一条
 * 检查再引一份依赖不划算。遍历里对每种**会引入绑定**的节点单独处理，
 * 漏掉的形状只会导致多报（在该名字确实没绑定时），不会漏报真问题。
 *
 * 用法：
 *   node tools/check-daemon-graph.mjs
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "espree";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 允许测试把扫描目标指向临时目录（tests/unit/daemon-graph.test.mjs 用它
// 在最小输入上驱动这个脚本）；不设时就是真实的 daemon 目录。
const DAEMON_DIR =
	process.env["ZW_DAEMON_DIR"] !== undefined && process.env["ZW_DAEMON_DIR"] !== ""
		? resolve(process.env["ZW_DAEMON_DIR"])
		: join(ROOT, "src", "main", "daemon");

/**
 * 运行时与语言内建的全局名。**只放真正不会在本仓被声明的那些**；
 * 宁可少放（多报 = 有人去看一眼）也不要多放（把真问题藏起来）。
 */
const BUILTIN_GLOBALS = new Set([
	"Array",
	"ArrayBuffer",
	"BigInt",
	"BigInt64Array",
	"BigUint64Array",
	"Boolean",
	"DataView",
	"Date",
	"Error",
	"EvalError",
	"FinalizationRegistry",
	"Float32Array",
	"Float64Array",
	"Function",
	"Infinity",
	"Int16Array",
	"Int32Array",
	"Int8Array",
	"Intl",
	"JSON",
	"Map",
	"Math",
	"NaN",
	"Number",
	"Object",
	"Promise",
	"Proxy",
	"RangeError",
	"ReferenceError",
	"Reflect",
	"RegExp",
	"Set",
	"SharedArrayBuffer",
	"String",
	"Symbol",
	"SyntaxError",
	"TypeError",
	"URIError",
	"Uint16Array",
	"Uint32Array",
	"Uint8Array",
	"Uint8ClampedArray",
	"WeakMap",
	"WeakRef",
	"WeakSet",
	"AbortController",
	"AbortSignal",
	"Blob",
	"Buffer",
	"File",
	"FormData",
	"Headers",
	"Request",
	"Response",
	"TextDecoder",
	"TextEncoder",
	"URL",
	"URLSearchParams",
	"atob",
	"btoa",
	"clearImmediate",
	"clearInterval",
	"clearTimeout",
	"console",
	"crypto",
	"fetch",
	"globalThis",
	"performance",
	"process",
	"queueMicrotask",
	"setImmediate",
	"setInterval",
	"setTimeout",
	"structuredClone",
	"undefined",
	"decodeURI",
	"decodeURIComponent",
	"encodeURI",
	"encodeURIComponent",
	"escape",
	"unescape",
	"isFinite",
	"isNaN",
	"parseFloat",
	"parseInt",
	"DOMException",
	"Event",
	"EventTarget",
	"MessageChannel",
	"MessagePort",
	"BroadcastChannel",
	"WebSocket",
	"Worker",
	"crypto",
	"navigator",
	"self",
	"window",
	"document",
	"localStorage",
	"sessionStorage",
	"alert",
	"confirm",
]);

/** 解析一个模块，取出它的导入与导出「结构」（不含注释、格式、位置）。 */
function readStructure(file) {
	const src = readFileSync(file, "utf8");
	const ast = parse(src, { ecmaVersion: "latest", sourceType: "module" });

	const imports = new Map(); // 来源 -> 具名导入（排序后的数组）
	const exports = new Set();

	for (const node of ast.body) {
		if (node.type === "ImportDeclaration") {
			const names = imports.get(node.source.value) ?? [];
			for (const spec of node.specifiers) {
				// 只关心具名导入：默认/命名空间导入在这个工程里没有用
				if (spec.type === "ImportSpecifier") names.push(spec.local.name);
			}
			imports.set(node.source.value, names.sort());
			continue;
		}
		if (node.type === "ExportNamedDeclaration") {
			for (const spec of node.specifiers) exports.add(spec.exported.name);
			const decl = node.declaration;
			if (decl !== null && decl !== undefined) {
				if (decl.type === "VariableDeclaration") {
					for (const d of decl.declarations) {
						if (d.id.type === "Identifier") exports.add(d.id.name);
					}
				} else if (decl.id !== undefined && decl.id !== null) {
					exports.add(decl.id.name);
				}
			}
			continue;
		}
		if (node.type === "ExportAllDeclaration") exports.add(`* from ${node.source.value}`);
	}

	return { imports, exports, ast };
}

/**
 * 收集一个模块里**所有**被绑定的名字（任意作用域）与所有被引用的标识符。
 *
 * 只看「模块里到底绑没绑这个名字」，不做真正的作用域链分析 —— 对
 * 「import 少写一个」这类问题足够，而且不会因为 TDZ / 遮蔽等细节误报。
 */
function collectFreeVariables(ast) {
	const bound = new Set();
	const referenced = new Set();

	/** 把各种「声明形态」里的名字收进 bound。 */
	const declarePattern = (node) => {
		if (node === null || node === undefined) return;
		switch (node.type) {
			case "Identifier":
				bound.add(node.name);
				break;
			case "ObjectPattern":
				for (const prop of node.properties) {
					if (prop.type === "RestElement") declarePattern(prop.argument);
					else declarePattern(prop.value);
				}
				break;
			case "ArrayPattern":
				for (const el of node.elements) declarePattern(el);
				break;
			case "RestElement":
				declarePattern(node.argument);
				break;
			case "AssignmentPattern":
				declarePattern(node.left);
				break;
			default:
				break;
		}
	};

	const walk = (node) => {
		if (node === null || node === undefined || typeof node.type !== "string") return;
		switch (node.type) {
			case "ImportDeclaration":
				for (const spec of node.specifiers) bound.add(spec.local.name);
				return;
			case "VariableDeclarator":
				declarePattern(node.id);
				walk(node.init);
				return;
			case "FunctionDeclaration":
			case "FunctionExpression":
			case "ArrowFunctionExpression":
				if (node.id !== null && node.id !== undefined) bound.add(node.id.name);
				for (const p of node.params) declarePattern(p);
				walk(node.body);
				return;
			case "ClassDeclaration":
			case "ClassExpression":
				if (node.id !== null && node.id !== undefined) bound.add(node.id.name);
				walk(node.superClass);
				walk(node.body);
				return;
			case "CatchClause":
				declarePattern(node.param);
				walk(node.body);
				return;
			case "MemberExpression":
				// `a.b` 里的 `b` 是属性名，不是标识符引用；`a` 才是。
				walk(node.object);
				if (node.computed) walk(node.property);
				return;
			case "Property":
				// 对象字面量的键不是引用（`{ foo: 1 }`）；计算键与值才是。
				if (node.computed) walk(node.key);
				walk(node.value);
				return;
			case "MetaProperty":
				// `import.meta` / `new.target`：两个名字都是语法关键字，不是引用。
				return;
			case "MethodDefinition":
			case "PropertyDefinition":
				if (node.computed) walk(node.key);
				walk(node.value);
				return;
			case "LabeledStatement":
			case "BreakStatement":
			case "ContinueStatement":
				// 标签是语句的一部分，不是标识符引用。
				walk(node.body);
				return;
			case "Identifier":
				referenced.add(node.name);
				return;
			default:
				break;
		}
		for (const key of Object.keys(node)) {
			if (key === "type" || key === "loc" || key === "range" || key === "start" || key === "end") {
				continue;
			}
			const value = node[key];
			if (Array.isArray(value)) {
				for (const child of value) walk(child);
			} else if (value !== null && typeof value === "object" && typeof value.type === "string") {
				walk(value);
			}
		}
	};

	walk(ast);
	return { bound, referenced };
}

const files = readdirSync(DAEMON_DIR).filter((f) => f.endsWith(".js"));
// 结构缓存按**绝对路径**建：跨目录的相对导入（../sandbox/、../../shared/）
// 也要能查到 —— 只按 daemon 目录内建索引会把它们误报成「模块不存在」。
const cache = new Map();
const structOf = (abs) => {
	if (!cache.has(abs)) cache.set(abs, existsSync(abs) ? readStructure(abs) : undefined);
	return cache.get(abs);
};

const problems = [];
let externalEdges = 0;

for (const file of files) {
	const abs = join(DAEMON_DIR, file);
	const st = structOf(abs);
	for (const [source, names] of st.imports) {
		if (!source.startsWith(".")) continue; // 外部依赖（pi SDK、node: 等）不在校验范围
		const target = resolve(dirname(abs), source);
		const tst = structOf(target);
		if (tst === undefined) {
			problems.push(`${file} 导入了不存在的模块 ${source}`);
			continue;
		}
		if (!target.startsWith(DAEMON_DIR)) externalEdges += 1;
		const wildcard = [...tst.exports].some((e) => e.startsWith("* from "));
		for (const name of names) {
			if (!tst.exports.has(name) && !wildcard) {
				problems.push(`${file} 从 ${source} 导入了 ${name}，但对方没有导出它`);
			}
		}
	}

	// ③ 自由变量：引用了却哪都没绑定 → 跑到那一行必抛 ReferenceError。
	const { bound, referenced } = collectFreeVariables(st.ast);
	for (const name of referenced) {
		if (bound.has(name) || BUILTIN_GLOBALS.has(name)) continue;
		problems.push(`${file} 引用了 ${name}，但模块里既没导入也没声明它`);
	}
}

console.log(`daemon 模块：${files.length} 个（其中 ${externalEdges} 条 import 指向 daemon 目录之外）`);

if (problems.length > 0) {
	for (const p of problems) console.error(`  ✗ ${p}`);
	console.error(`\n模块图不闭合：${problems.length} 处问题`);
	process.exit(1);
}
console.log("  ✓ 模块图闭合：相对 import 全部指到真文件，具名导入全部能对上导出");
console.log("  ✓ 无自由变量：每个被引用的标识符都有 import / 声明 / 内建出处");
