/**
 * 能力包（zerowork-pack v1）的单元测试。
 *
 * 这一层守的是**安全边界**：路径越界、符号链接、隐藏条目、脚本扩展名、
 * 体积 / 数量上限、manifest 校验、哈希篡改，以及安装 / 卸载 / 导出的往返。
 *
 * 夹具全部在临时目录现场生成（不提交二进制 zip）；每个用例独立的
 * `ZEROWORK_CONFIG_DIR`，与 hooks / theme 偏好那组单测同一模式。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import {
	PACK_META_FILE,
	exportPack,
	inspectPack,
	installPack,
	listPacks,
	uninstallPack,
} from "../../src/main/daemon/packs.js";
import { loadExperts, loadGlobalSkills } from "../../src/main/daemon/experts.js";
import { getBuiltinSkillDirs, getConfigDir, getResourcesDir } from "../../src/main/daemon/config-paths.js";

const PACK_ID = "pack-e2e-minutes";
const SKILL_DIR = "minutes-format";
/**
 * 单测直接 import `src/main/daemon/**`，而 `config-paths.js` 的缺省值按
 * **构建产物**（out/main）的相对位置算 —— 在源码目录下会指向 `src/resources`。
 * 与 e2e harness 一样显式指到仓库根，否则「内置专家拒绝导出」这类用例
 * 根本看不到内置专家。
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

let previousResourcesDir;
let previousAppDir;

function expertMarkdown(id = PACK_ID) {
	return `---
name: ${id}
description: 把会议记录整理成可执行纪要
displayName: 会议纪要专家
profession: 会议纪要整理
displayDescription: 把录音转写与零散笔记整理成可执行的纪要
quickPrompts:
  - 把这段会议记录整理成纪要
  - 提取待办事项与负责人
  - 生成一封会后邮件
tags:
  - 会议
  - 纪要
  - 待办
expertType: expert
---
你是会议纪要专家。只做纪要，不编造事实。
`;
}

const SKILL_MARKDOWN = `---
name: pack-e2e-minutes-format
description: 会议纪要的标准结构
---
按「结论 / 待办 / 风险」三段整理。
`;

let configDir;
let previousConfigDir;
let tempDirs;

function makeTemp(prefix) {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

beforeEach(() => {
	previousConfigDir = process.env["ZEROWORK_CONFIG_DIR"];
	previousResourcesDir = process.env["ZEROWORK_RESOURCES_DIR"];
	previousAppDir = process.env["ZEROWORK_APP_DIR"];
	configDir = mkdtempSync(join(tmpdir(), "zerowork-pack-"));
	tempDirs = [configDir];
	process.env["ZEROWORK_CONFIG_DIR"] = configDir;
	process.env["ZEROWORK_RESOURCES_DIR"] = join(ROOT, "resources");
	process.env["ZEROWORK_APP_DIR"] = ROOT;
});

afterEach(() => {
	if (previousConfigDir === undefined) delete process.env["ZEROWORK_CONFIG_DIR"];
	else process.env["ZEROWORK_CONFIG_DIR"] = previousConfigDir;
	if (previousResourcesDir === undefined) delete process.env["ZEROWORK_RESOURCES_DIR"];
	else process.env["ZEROWORK_RESOURCES_DIR"] = previousResourcesDir;
	if (previousAppDir === undefined) delete process.env["ZEROWORK_APP_DIR"];
	else process.env["ZEROWORK_APP_DIR"] = previousAppDir;
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** 造一个合法包目录；overrides 可以改 manifest 的任意字段。 */
function writePack(root, options = {}) {
	const id = options.id ?? PACK_ID;
	mkdirSync(join(root, "skills", SKILL_DIR), { recursive: true });
	writeFileSync(join(root, "expert.md"), expertMarkdown(id));
	writeFileSync(join(root, "skills", SKILL_DIR, "SKILL.md"), SKILL_MARKDOWN);
	writeFileSync(join(root, "README.md"), "# 会议纪要专家\n");
	if (options.withManifest !== false) {
		const manifest = {
			format: "zerowork-pack",
			formatVersion: 1,
			id,
			version: "1.0.0",
			name: "会议纪要专家",
			description: "把录音转写整理成可执行的纪要",
			author: "e2e",
			domain: "日常办公",
			connectors: [{ id: "github", type: "http", description: "读取仓库 issue" }],
			...(options.manifest ?? {}),
		};
		writeFileSync(join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	}
	return root;
}

function newPackDir(options = {}) {
	const dir = makeTemp("zerowork-pack-src-");
	return writePack(dir, options);
}

/** 把一个目录打成 zip 字节。`mutate` 可在生成前改 zip 里的条目。 */
async function zipBytesOf(root, mutate) {
	const zip = new JSZip();
	const walk = (dir, prefix) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const absolute = join(dir, entry.name);
			const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory()) walk(absolute, rel);
			else zip.file(rel, readFileSync(absolute));
		}
	};
	walk(root, "");
	if (mutate !== undefined) mutate(zip);
	return zip.generateAsync({ type: "nodebuffer" });
}

async function writeZip(sourceDir, destPath, mutate) {
	writeFileSync(destPath, await zipBytesOf(sourceDir, mutate));
	return destPath;
}

function newZipSource(options = {}) {
	const root = newPackDir(options);
	const dest = join(makeTemp("zerowork-pack-zip-"), "package.zwpack");
	return writeZip(root, dest);
}

function packInConfig() {
	return join(getConfigDir(), "packs", PACK_ID);
}

describe("预览：合法包", () => {
	it("目录来源：返回专家摘要、技能、连接器与文件统计", async () => {
		const source = newPackDir();
		const result = await inspectPack(source);
		expect(result.ok).toBe(true);
		const preview = result.preview;
		expect(preview.expert.id).toBe(PACK_ID);
		expect(preview.expert.displayName).toBe("会议纪要专家");
		expect(preview.manifest.version).toBe("1.0.0");
		expect(preview.skills).toEqual([
			{ name: "pack-e2e-minutes-format", description: "会议纪要的标准结构" },
		]);
		expect(preview.agents).toBe(0);
		expect(preview.files).toBeGreaterThanOrEqual(4);
		expect(preview.bytes).toBeGreaterThan(0);
		expect(preview.connectors).toEqual([
			{ id: "github", type: "http", description: "读取仓库 issue" },
		]);
		expect(preview.conflicts).toEqual({
			existing: false,
			existingIsPack: false,
			overridesBuiltin: false,
		});
	});

	it("zip 来源：与目录来源给出同一份预览", async () => {
		const zip = await newZipSource();
		const result = await inspectPack(zip);
		expect(result.ok).toBe(true);
		expect(result.preview.expert.id).toBe(PACK_ID);
		expect(result.preview.manifest.description).toBe("把录音转写整理成可执行的纪要");
	});
});

describe("预览：manifest 校验", () => {
	it("缺少 manifest.json 时明确报 PACK_MANIFEST_MISSING", async () => {
		const source = newPackDir({ withManifest: false });
		const result = await inspectPack(source);
		expect(result.ok).toBe(false);
		expect(result.errors[0].code).toBe("PACK_MANIFEST_MISSING");
		expect(result.errors[0].file).toBe("manifest.json");
	});

	it.each([
		["format", "other-pack", "PACK_FORMAT_INVALID"],
		["formatVersion", 2, "PACK_FORMAT_INVALID"],
		["id", "", "PACK_ID_INVALID"],
		["version", "1.0", "PACK_VERSION_INVALID"],
		["name", "", "PACK_MANIFEST_INVALID"],
	])("字段 %s 非法时拒绝（%s → %s）", async (field, value, code) => {
		const source = newPackDir({ manifest: { [field]: value } });
		const result = await inspectPack(source);
		expect(result.ok).toBe(false);
		expect(result.errors[0].code).toBe(code);
	});

	it("manifest.id 与 expert.md 的 name 不一致时拒绝", async () => {
		const source = newPackDir({ manifest: { id: "another-id" } });
		const result = await inspectPack(source);
		expect(result.ok).toBe(false);
		expect(result.errors[0].code).toBe("PACK_ID_MISMATCH");
	});

	it("minAppVersion 高于当前版本时拒绝并给出两边版本号", async () => {
		const source = newPackDir({ manifest: { minAppVersion: "99.0.0" } });
		const result = await inspectPack(source);
		expect(result.ok).toBe(false);
		expect(result.errors[0].code).toBe("PACK_APP_VERSION_TOO_LOW");
		expect(result.errors[0].message).toContain("99.0.0");
	});

	it("files 声明的哈希不匹配时拒绝", async () => {
		const source = newPackDir({
			manifest: {
				files: [
					{ path: "expert.md", sha256: "0".repeat(64), size: 1 },
				],
			},
		});
		const result = await inspectPack(source);
		expect(result.ok).toBe(false);
		expect(result.errors[0].code).toBe("PACK_HASH_MISMATCH");
		expect(result.errors[0].file).toBe("expert.md");
	});
});

describe("预览：路径与内容安全边界", () => {
	it("zip 里被 JSZip 净化过的 ../ 仍按原样名拒绝", async () => {
		/*
		 * JSZip 在 loadAsync 时会把 `skills/../agents/evil.md` 清洗成
		 * `agents/evil.md`（看着完全合法）。这里刻意去掉自动生成的目录条目，
		 * 让「净化后合法、原名穿越」成为唯一被检出的形状 —— 否则目录条目里的
		 * `/` 会先触发另一条错误，测试就测不到 unsafeOriginalName 这条判据。
		 */
		const zip = new JSZip();
		zip.file("skills/../agents/evil.md", "x");
		for (const key of Object.keys(zip.files)) {
			if (zip.files[key].dir) delete zip.files[key];
		}
		const dest = join(makeTemp("zw-trav-"), "evil.zwpack");
		writeFileSync(dest, await zip.generateAsync({ type: "nodebuffer" }));
		const result = await inspectPack(dest);
		expect(result.ok).toBe(false);
		expect(result.errors[0].code).toBe("PACK_PATH_INVALID");
		expect(result.errors[0].file).toBe("skills/../agents/evil.md");
	});

	it("zip 里的普通 ../ 穿越同样被拒绝", async () => {
		const zip = await writeZip(newPackDir(), join(makeTemp("zw-trav2-"), "evil.zwpack"), (z) =>
			z.file("skills/../../evil.md", "x"),
		);
		const result = await inspectPack(zip);
		expect(result.ok).toBe(false);
		expect(result.errors[0].code).toBe("PACK_PATH_INVALID");
	});

	it("zip 里的绝对路径被拒绝", async () => {
		const zip = await writeZip(newPackDir(), join(makeTemp("zw-abs-"), "abs.zwpack"), (z) =>
			z.file("/abs.md", "x"),
		);
		const result = await inspectPack(zip);
		expect(result.ok).toBe(false);
		expect(result.errors[0].code).toBe("PACK_PATH_INVALID");
	});

	it("zip 里的反斜杠分隔被拒绝", async () => {
		const zip = await writeZip(newPackDir(), join(makeTemp("zw-slash-"), "slash.zwpack"), (z) =>
			z.file("skills\\evil.md", "x"),
		);
		const result = await inspectPack(zip);
		expect(result.ok).toBe(false);
		expect(result.errors[0].code).toBe("PACK_PATH_INVALID");
	});

	it("zip 里的符号链接条目被拒绝", async () => {
		const zip = join(makeTemp("zw-link-"), "link.zwpack");
		const z = new JSZip();
		z.file("manifest.json", JSON.stringify({ format: "zerowork-pack", formatVersion: 1, id: PACK_ID, version: "1.0.0", name: "x" }));
		z.file("expert.md", expertMarkdown());
		z.file("skills/link.md", "x", { unixPermissions: 0o120777 });
		writeFileSync(zip, await z.generateAsync({ type: "nodebuffer", platform: "UNIX" }));
		const result = await inspectPack(zip);
		expect(result.ok).toBe(false);
		expect(result.errors[0].code).toBe("PACK_SYMLINK");
	});

	it("目录里的符号链接被拒绝", async (ctx) => {
		if (process.platform === "win32") {
			ctx.skip();
			return;
		}
		const source = newPackDir();
		symlinkSync(join(source, "expert.md"), join(source, "skills", "linked.md"));
		const result = await inspectPack(source);
		expect(result.ok).toBe(false);
		expect(result.errors[0].code).toBe("PACK_SYMLINK");
	});

	it("隐藏文件被拒绝", async () => {
		const source = newPackDir();
		writeFileSync(join(source, "skills", ".hidden.md"), "x");
		const result = await inspectPack(source);
		expect(result.ok).toBe(false);
		expect(result.errors[0].code).toBe("PACK_HIDDEN_ENTRY");
	});

	it("脚本 / 可执行扩展名被拒绝", async () => {
		for (const name of ["run.sh", "run.ps1", "payload.exe", "index.js"]) {
			const source = newPackDir();
			writeFileSync(join(source, "skills", name), "x");
			const result = await inspectPack(source);
			expect(result.ok, `${name} 应被拒绝`).toBe(false);
			expect(result.errors[0].code).toBe("PACK_EXTENSION_NOT_ALLOWED");
		}
	});

	it("prompts/ 明确提示 v1 不支持", async () => {
		const source = newPackDir();
		mkdirSync(join(source, "prompts"), { recursive: true });
		writeFileSync(join(source, "prompts", "daily.md"), "x");
		const result = await inspectPack(source);
		expect(result.ok).toBe(false);
		expect(result.errors[0].code).toBe("PACK_PROMPTS_UNSUPPORTED");
	});

	it("顶层多出未知目录时拒绝", async () => {
		const source = newPackDir();
		mkdirSync(join(source, "secrets"), { recursive: true });
		writeFileSync(join(source, "secrets", "a.md"), "x");
		const result = await inspectPack(source);
		expect(result.ok).toBe(false);
		expect(result.errors[0].code).toBe("PACK_TOP_LEVEL_NOT_ALLOWED");
	});

	it("单文件超过 1 MiB 时拒绝", async () => {
		const source = newPackDir();
		writeFileSync(join(source, "skills", "big.md"), "x".repeat(1024 * 1024 + 1));
		const result = await inspectPack(source);
		expect(result.ok).toBe(false);
		expect(result.errors[0].code).toBe("PACK_FILE_TOO_LARGE");
	});

	it("文件数超过 200 时拒绝", async () => {
		const source = newPackDir();
		for (let i = 0; i < 200; i += 1) {
			writeFileSync(join(source, "skills", `file-${i}.md`), "x");
		}
		const result = await inspectPack(source);
		expect(result.ok).toBe(false);
		expect(result.errors[0].code).toBe("PACK_TOO_MANY_FILES");
	});
});

describe("安装 / 列表 / 卸载", () => {
	it("安装后进入专家列表（source=pack，带 packId/packVersion）", async () => {
		const result = await installPack(newPackDir());
		expect(result.ok).toBe(true);
		expect(result.id).toBe(PACK_ID);

		const experts = loadExperts(
			join(getResourcesDir(), "experts"),
			[{ dir: join(getConfigDir(), "packs"), source: "pack" }],
			[],
			[],
		);
		const installed = experts.find((expert) => expert.name === PACK_ID);
		expect(installed).toBeDefined();
		expect(installed.source).toBe("pack");
		expect(installed.packId).toBe(PACK_ID);
		expect(installed.packVersion).toBe("1.0.0");
		expect(installed.skillsDir).toBe(join(packInConfig(), "skills"));
	});

	it("zip 来源同样可以安装", async () => {
		const result = await installPack(await newZipSource());
		expect(result.ok).toBe(true);
		expect(readdirSync(packInConfig()).sort()).toEqual(
			// `_pack.json` 是安装时写入的本地元数据，不属于包内容。
			["README.md", PACK_META_FILE, "expert.md", "manifest.json", "skills"].sort(),
		);
	});

	it("同名旧版本原子替换，文件内容随之更新", async () => {
		await installPack(newPackDir());
		const next = newPackDir({
			manifest: { version: "1.1.0", description: "第二版" },
		});
		writeFileSync(join(next, "README.md"), "# 第二版\n");
		const result = await installPack(next);
		expect(result.ok).toBe(true);
		expect(listPacks().packs.map((pack) => pack.version)).toEqual(["1.1.0"]);
		expect(readFileSync(join(packInConfig(), "README.md"), "utf8")).toBe("# 第二版\n");
		expect(readFileSync(join(packInConfig(), "manifest.json"), "utf8")).toContain("第二版");
	});

	it("再次预览时冲突信息带已安装版本与路径（让「升级」可执行）", async () => {
		await installPack(newPackDir());
		const next = newPackDir({ manifest: { version: "1.1.0" } });
		const result = await inspectPack(next);
		expect(result.ok).toBe(true);
		expect(result.preview.conflicts).toMatchObject({
			existing: true,
			existingIsPack: true,
			existingVersion: "1.0.0",
			existingPath: packInConfig(),
		});
	});

	it("同名目录不是能力包时拒绝，且不改动它", async () => {
		mkdirSync(packInConfig(), { recursive: true });
		writeFileSync(join(packInConfig(), "keep.txt"), "keep");
		const result = await installPack(newPackDir());
		expect(result.ok).toBe(false);
		expect(result.errors[0].code).toBe("PACK_CONFLICT_NOT_PACK");
		expect(readFileSync(join(packInConfig(), "keep.txt"), "utf8")).toBe("keep");
	});

	it("卸载后从列表消失；重复卸载报 not-installed", async () => {
		await installPack(newPackDir());
		expect(listPacks().packs).toHaveLength(1);
		const removed = uninstallPack(PACK_ID);
		expect(removed).toEqual({ ok: true, id: PACK_ID });
		expect(listPacks().packs).toEqual([]);
		const again = uninstallPack(PACK_ID);
		expect(again.ok).toBe(false);
		expect(again.reason).toBe("not-installed");
	});

	it("技能名与全局技能重名时拒绝安装并回滚", async () => {
		const globalSkills = loadGlobalSkills(getBuiltinSkillDirs());
		expect(globalSkills.length).toBeGreaterThan(0);
		const clash = globalSkills[0].name;
		const source = newPackDir();
		writeFileSync(
			join(source, "skills", SKILL_DIR, "SKILL.md"),
			`---\nname: ${clash}\ndescription: 与全局技能重名\n---\n正文\n`,
		);
		const result = await installPack(source);
		expect(result.ok).toBe(false);
		expect(result.errors[0].code).toBe("PACK_CONFLICT_GLOBAL");
		// 回滚：安装目录不能留下半个专家。
		expect(existsSync(packInConfig())).toBe(false);
		expect(listPacks().packs).toEqual([]);
	});

	it("不存在的 id 不会被当作路径", async () => {
		const result = uninstallPack("../evil");
		expect(result.ok).toBe(false);
		expect(result.errors[0].code).toBe("PACK_ID_INVALID");
	});

	it("安装元数据写入了 manifest、来源与文件哈希", async () => {
		const source = newPackDir();
		await installPack(source);
		const meta = JSON.parse(readFileSync(join(packInConfig(), PACK_META_FILE), "utf8"));
		expect(meta.manifest.id).toBe(PACK_ID);
		expect(meta.source).toBe(source);
		expect(meta.files.length).toBeGreaterThanOrEqual(4);
		expect(meta.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
		expect(meta.installedAt).toBeTypeOf("number");
	});
});

describe("导出 / 再导入 roundtrip", () => {
	/** 在 config/experts 下造一个用户专家（不带 manifest，模拟手工专家）。 */
	function writeUserExpert(overrides = {}) {
		const root = join(getConfigDir(), "experts", PACK_ID);
		writePack(root, { withManifest: false, ...overrides });
		return root;
	}

	it("用户专家可导出，导出物含 manifest 与 SHA-256 清单，再导入通过校验", async () => {
		writeUserExpert();
		const dest = join(makeTemp("zw-export-"), `${PACK_ID}.zwpack`);
		const exported = await exportPack({ name: PACK_ID, destPath: dest });
		expect(exported.ok).toBe(true);
		// expert.md + README.md + skills/minutes-format/SKILL.md
		expect(exported.files).toBe(3);

		const zip = await JSZip.loadAsync(readFileSync(dest));
		const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
		expect(manifest.format).toBe("zerowork-pack");
		expect(manifest.id).toBe(PACK_ID);
		expect(manifest.version).toBe("1.0.0");
		expect(manifest.files.length).toBe(exported.files);
		expect(manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);

		const inspected = await inspectPack(dest);
		expect(inspected.ok).toBe(true);

		const installed = await installPack(dest);
		expect(installed.ok).toBe(true);
	});

	it("导出后篡改文件内容，再导入因哈希不符被拒绝", async () => {
		writeUserExpert();
		const dest = join(makeTemp("zw-tamper-"), `${PACK_ID}.zwpack`);
		expect((await exportPack({ name: PACK_ID, destPath: dest })).ok).toBe(true);

		const zip = await JSZip.loadAsync(readFileSync(dest));
		zip.file("expert.md", `${expertMarkdown()}\n（被篡改）\n`);
		const tampered = join(makeTemp("zw-tamper-out-"), "tampered.zwpack");
		writeFileSync(tampered, await zip.generateAsync({ type: "nodebuffer" }));

		const result = await installPack(tampered);
		expect(result.ok).toBe(false);
		expect(result.errors[0].code).toBe("PACK_HASH_MISMATCH");
		expect(result.errors[0].file).toBe("expert.md");
	});

	it("已安装的能力包也可以再次导出", async () => {
		await installPack(newPackDir());
		const dest = join(makeTemp("zw-export-pack-"), "again.zwpack");
		const exported = await exportPack({ name: PACK_ID, destPath: dest });
		expect(exported.ok).toBe(true);
		const zip = await JSZip.loadAsync(readFileSync(dest));
		const manifest = JSON.parse(await zip.file("manifest.json").async("string"));
		expect(manifest.connectors).toEqual([
			{ id: "github", type: "http", description: "读取仓库 issue" },
		]);
	});

	it("内置专家拒绝导出（再分发授权未确认）", async () => {
		const builtin = readdirSync(join(getResourcesDir(), "experts"), { withFileTypes: true })
			.find((entry) => entry.isDirectory());
		expect(builtin).toBeDefined();
		const dest = join(makeTemp("zw-export-builtin-"), "builtin.zwpack");
		const result = await exportPack({ name: builtin.name, destPath: dest });
		expect(result.ok).toBe(false);
		expect(result.errors[0].code).toBe("PACK_EXPORT_BUILTIN");
	});

	it("找不到专家时给出 PACK_EXPORT_NOT_FOUND", async () => {
		const dest = join(makeTemp("zw-export-missing-"), "missing.zwpack");
		const result = await exportPack({ name: "no-such-expert", destPath: dest });
		expect(result.ok).toBe(false);
		expect(result.errors[0].code).toBe("PACK_EXPORT_NOT_FOUND");
	});
});
