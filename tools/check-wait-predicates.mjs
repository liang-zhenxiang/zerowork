#!/usr/bin/env node
/**
 * check-wait-predicates.mjs —— 抓「假等待」：谓词的**每一条**返回路径都是常量真值。
 *
 * 为什么值得一条门禁：harness 的 `waitUntil` 判据是 `if (value) return value`
 * （`tests/e2e/lib/harness.mjs`），所以**谓词返回对象字面量 = 恒真** —— 那个「等待」
 * 只轮询一次就返回，`timeout` 一毫秒都不参与，而写法读起来完全像一个正常的信号等待。
 * 这个形态在这个仓库里出现过至少三次（`gui-updates` #114、`gui-formula` #149、
 * `gui-space-pin` #150），每次都是「修一处、等下一次」——把它变成静态检查，循环才停。
 *
 * ## 判定：保守，只报「一条可能为假的路径都没有」的调用点
 *
 * 对每个 `waitUntil(...)` 取它的**谓词函数**，收集**所有**返回路径，然后问：
 * 有没有任何一条路径**可能**交出假值？
 *
 *   · 对象 / 数组字面量、`true`、非空字符串、非零数字 —— 常量真值，算「不可能为假」
 *   · 比较、`!x`、成员访问、变量、函数调用 —— **算作可能为假**（宁可不报，不误报）
 *   · `cond ? a : b` 与 `a && b` / `a || b` —— 两侧任一可能为假就算可能为假
 *   · `win.evaluate(cb)` —— 钻进 `cb` 再看一遍它的返回路径（这是最常见的写法）
 *
 * 于是**已知的好写法一律不在射程内**：
 *   `return last.found ? last : null`、`() => el !== null`、
 *   `const s = await win.evaluate(...); return s.ok ? s : null`
 *
 * 判不出来的一律**不报**，只在输出里列成「需人工确认」（谓词是标识符、没有任何 return 等）。
 *
 * 用法：node tools/check-wait-predicates.mjs
 * 退出码：0 没有假等待，1 命中（附文件:行号与逐条返回路径）
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "espree";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (USE_COLOR ? `\u001b[${code}m${text}\u001b[0m` : text);
const green = (t) => paint("32", t);
const red = (t) => paint("31", t);
const yellow = (t) => paint("33", t);
const dim = (t) => paint("2", t);

/** 谓词是这几个形态时无法静态判定 —— 列出来让人看，不算失败。 */
const UNKNOWN = "unknown";

/** 深度优先遍历（不依赖 eslint 的 visitor keys：测试里只出现标准语法）。 */
function walk(node, visit) {
	if (node === null || typeof node !== "object") return;
	if (Array.isArray(node)) {
		for (const item of node) walk(item, visit);
		return;
	}
	if (typeof node.type === "string") visit(node);
	for (const key of Object.keys(node)) {
		if (key === "parent") continue;
		walk(node[key], visit);
	}
}

/** `x.evaluate(cb)` / `win.evaluate(cb)` —— 判据钻进回调才看得见真正的返回值。 */
function isEvaluateCall(node) {
	return (
		node.type === "CallExpression" &&
		node.callee.type === "MemberExpression" &&
		node.callee.property.type === "Identifier" &&
		node.callee.property.name === "evaluate" &&
		node.arguments.length > 0
	);
}

/** 收集**这个函数自己**的 return（不进嵌套函数）。 */
function ownReturns(fn) {
	const returns = [];
	const body = fn.body;
	if (body.type !== "BlockStatement") return [{ node: body, line: body.loc?.start.line ?? 0 }];

	const visitBlock = (statements) => {
		for (const stmt of statements ?? []) visitStatement(stmt);
	};
	const visitStatement = (stmt) => {
		if (stmt === null || typeof stmt !== "object") return;
		switch (stmt.type) {
			case "ReturnStatement":
				returns.push({ node: stmt.argument, line: stmt.loc?.start.line ?? 0 });
				return;
			case "BlockStatement":
				return visitBlock(stmt.body);
			case "IfStatement":
				visitStatement(stmt.consequent);
				visitStatement(stmt.alternate);
				return;
			case "ForStatement":
			case "ForOfStatement":
			case "ForInStatement":
			case "WhileStatement":
			case "DoWhileStatement":
				return visitStatement(stmt.body);
			case "SwitchStatement":
				for (const c of stmt.cases) visitBlock(c.consequent);
				return;
			case "TryStatement":
				visitStatement(stmt.block);
				visitStatement(stmt.handler?.body);
				visitStatement(stmt.finalizer);
				return;
			case "LabeledStatement":
				return visitStatement(stmt.body);
			default:
				// 其它语句里可能嵌着函数表达式 —— **不进**（那不是谓词的返回路径）
				return;
		}
	};
	visitBlock(body.body);
	return returns;
}

/**
 * 这条返回路径**有没有可能**交出假值。
 *
 * 返回 `true` = 可能为假（安全，门禁不报）；`false` = 常量真值（可疑）。
 * 判不出来的一律返回 `true` —— 这条门禁只抓「铁证」，宁可漏报不误报。
 */
function canBeFalsy(node, scope) {
	if (node === null || node === undefined) return true; // `return;` = undefined
	switch (node.type) {
		case "ObjectExpression":
		case "ArrayExpression":
		case "FunctionExpression":
		case "ArrowFunctionExpression":
		case "ClassExpression":
		case "NewExpression":
			return false;
		case "Literal":
			if (node.value === null || node.value === false) return true;
			if (typeof node.value === "number") return node.value === 0;
			if (typeof node.value === "string") return node.value === "";
			if (typeof node.value === "bigint") return node.value === 0n;
			return false; // true / 正则 / 其它字面量
		case "TemplateLiteral": {
			// 含插值就可能为空串 → 可能为假
			if (node.expressions.length > 0) return true;
			return node.quasis.map((q) => q.value.cooked ?? "").join("") === "";
		}
		case "Identifier": {
			if (node.name === "undefined" || node.name === "NaN") return true;
			// 同一个函数体里 `const x = <初始化式>` 的简单情形：顺着初始化式看
			const init = scope?.get(node.name);
			if (init !== undefined) return canBeFalsy(init, null);
			return true;
		}
		case "AwaitExpression":
		case "ChainExpression":
			return canBeFalsy(node.argument ?? node.expression, scope);
		case "UnaryExpression":
			// `!x` 是布尔（可能为假）；`void x`、`typeof x` 也可能是假值
			return true;
		case "ConditionalExpression":
			return canBeFalsy(node.consequent, scope) || canBeFalsy(node.alternate, scope);
		case "LogicalExpression":
			return canBeFalsy(node.left, scope) || canBeFalsy(node.right, scope);
		case "SequenceExpression":
			return canBeFalsy(node.expressions[node.expressions.length - 1], scope);
		case "AssignmentExpression":
			return canBeFalsy(node.right, scope);
		case "CallExpression":
			// 直接返回 `win.evaluate(cb)` 的结果 —— 钻进回调看它的返回路径
			if (isEvaluateCall(node)) return evaluateCanBeFalsy(node.arguments[0]);
			return true;
		default:
			return true;
	}
}

/** 谓词里 `const x = <init>` 的初始化式（只收本函数体第一层，够用且不会误判）。 */
function localConsts(fn) {
	const map = new Map();
	if (fn.body.type !== "BlockStatement") return map;
	for (const stmt of fn.body.body) {
		if (stmt.type !== "VariableDeclaration") continue;
		for (const decl of stmt.declarations) {
			if (decl.id.type === "Identifier" && decl.init !== null) map.set(decl.id.name, decl.init);
		}
	}
	return map;
}

/** evaluate 回调的返回路径里，有没有可能交出假值。 */
function evaluateCanBeFalsy(callback) {
	if (callback === undefined) return true;
	if (callback.type !== "ArrowFunctionExpression" && callback.type !== "FunctionExpression") {
		return true; // 传的是标识符之类，判不了
	}
	const returns = ownReturns(callback);
	if (returns.length === 0) return true; // 没有 return → undefined
	const scope = localConsts(callback);
	return returns.some((r) => canBeFalsy(r.node, scope));
}

/**
 * 文件顶层的函数声明与「const 名 = 函数」——用来解析 `waitUntil(paletteOpen, ...)`
 * 这种把谓词写成**具名引用**的调用点（不解析的话只能报「判不了」）。
 *
 * 只收顶层：测试文件里这些 helper 都在顶层，而按名字全文件乱找会在变量遮蔽时给出错误结论。
 */
function topLevelFunctions(ast) {
	const map = new Map();
	for (const stmt of ast.body) {
		if (stmt.type === "FunctionDeclaration" && stmt.id !== null) {
			map.set(stmt.id.name, stmt);
			continue;
		}
		if (stmt.type !== "VariableDeclaration") continue;
		for (const decl of stmt.declarations) {
			if (decl.id.type !== "Identifier" || decl.init === null) continue;
			if (decl.init.type === "ArrowFunctionExpression" || decl.init.type === "FunctionExpression") {
				map.set(decl.id.name, decl.init);
			}
		}
	}
	return map;
}

/** 判定一个 `waitUntil(...)` 调用点。 */
function judgeCall(call, topFns) {
	let predicate = call.arguments[0];
	if (predicate === undefined) return { kind: UNKNOWN, reason: "没有谓词参数" };
	if (predicate.type === "Identifier") {
		const resolved = topFns.get(predicate.name);
		if (resolved === undefined) {
			return { kind: UNKNOWN, reason: `谓词是标识符 ${predicate.name}，文件顶层找不到它的定义` };
		}
		predicate = resolved;
	}
	if (predicate.type !== "ArrowFunctionExpression" && predicate.type !== "FunctionExpression") {
		return { kind: UNKNOWN, reason: "谓词是标识符/表达式，判不了它的返回路径" };
	}
	const returns = ownReturns(predicate);
	if (returns.length === 0) {
		return { kind: UNKNOWN, reason: "谓词没有任何 return（只靠抛错？）" };
	}
	const scope = localConsts(predicate);
	const falsyAble = returns.filter((r) => canBeFalsy(r.node, scope));
	if (falsyAble.length > 0) return { kind: "ok", returns: returns.length };

	// 全部返回路径都是常量真值 —— 这个等待永远等不到
	const lines = returns.map((r) => r.line).filter((n) => n > 0);
	return { kind: "fake", lines, returns: returns.length };
}

function targetFiles() {
	const out = execFileSync("git", ["ls-files", "-z", "tests/e2e", "tools"], {
		cwd: ROOT,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return out
		.split("\0")
		.filter((file) => file.endsWith(".mjs"))
		.map((file) => path.join(ROOT, file));
}

/**
 * 判定一段源码里的全部 `waitUntil` 调用点。
 *
 * 导出成纯函数（只吃字符串、不碰文件系统）是为了能单测：**门禁自己也要有门禁** ——
 * 一个「永远说没问题」的检查比没有检查更坏（它会让下一个假等待合法地溜过去）。
 */
export function analyze(source) {
	const ast = parse(source, {
		ecmaVersion: "latest",
		sourceType: "module",
		loc: true,
		comment: false,
	});
	const topFns = topLevelFunctions(ast);
	const fake = [];
	const unknown = [];
	let sites = 0;

	walk(ast, (node) => {
		if (node.type !== "CallExpression") return;
		if (node.callee.type !== "Identifier" || node.callee.name !== "waitUntil") return;
		sites += 1;
		const verdict = judgeCall(node, topFns);
		if (verdict.kind === "fake") fake.push({ line: node.loc.start.line, ...verdict });
		else if (verdict.kind === UNKNOWN) {
			unknown.push({ line: node.loc.start.line, reason: verdict.reason });
		}
	});
	return { sites, fake, unknown };
}

function main() {
	process.stdout.write("\n等待谓词检查（假等待）\n");

	let files;
	try {
		files = targetFiles();
	} catch (error) {
		if (error.status === 128) {
			process.stdout.write(dim("  跳过：当前目录不是 git 仓库\n"));
			return 0;
		}
		throw error;
	}

	const fake = [];
	const unknown = [];
	let sites = 0;

	for (const file of files) {
		const source = readFileSync(file, "utf8");
		if (!source.includes("waitUntil")) continue;
		const result = analyze(source);
		const rel = path.relative(ROOT, file);
		sites += result.sites;
		for (const item of result.fake) fake.push({ file: rel, ...item });
		for (const item of result.unknown) unknown.push({ file: rel, ...item });
	}

	if (unknown.length > 0) {
		process.stdout.write(`  ${yellow("需人工确认")}：${unknown.length} 处静态判不出来（不是失败，列出来备查）\n`);
		for (const item of unknown) {
			process.stdout.write(dim(`    ${item.file}:${item.line} —— ${item.reason}\n`));
		}
	}

	if (fake.length === 0) {
		process.stdout.write(`  ${green("✓")} ${sites} 个 waitUntil 调用点：没有「每一条返回路径都是常量真值」的谓词\n`);
		return 0;
	}

	process.stdout.write(
		`\n${red(`发现 ${fake.length} 处假等待（共扫了 ${sites} 个调用点；谓词恒真，timeout 形同虚设）：`)}\n`,
	);
	for (const item of fake) {
		process.stdout.write(`  ✗ ${item.file}:${item.line}（${item.returns} 条返回路径全是常量真值）\n`);
		if (item.lines.length > 0) {
			process.stdout.write(dim(`      可疑的 return 在第 ${item.lines.join(" / ")} 行\n`));
		}
	}
	process.stdout.write(
		dim(
			"\n  改法：让「未就绪」时返回假值，就绪时才交出对象。\n" +
				"    异步：const s = await win.evaluate(...); return s.ok ? s : null;\n" +
				"    同步：return cond ? value : null;\n" +
				"  不要靠放宽 timeout —— 谓词恒真时，40 秒和 1 毫秒一样没用（#114 踩过）。\n",
		),
	);
	return 1;
}

// 直接执行时跑 main；被 import 时不跑（单测路径）。与 next-beta-version.mjs 同形。
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exit(main());
}
