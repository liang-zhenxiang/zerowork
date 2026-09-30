#!/usr/bin/env node
/**
 * build-icons.mjs —— 从 `build/icon.svg` 生成三平台应用图标
 *
 * 产出的三个文件都被 `.gitignore` 之外的路径收录，直接入库：
 *
 *   build/icon.icns  macOS（收进 .app 的 Resources）
 *   build/icon.ico   Windows（NSIS 安装器与可执行文件）
 *   build/icon.png   1024×1024 备用（Linux、文档、商店素材）
 *
 * 为什么需要这个脚本：electron-builder 对图标有硬性尺寸要求
 * （macOS 最小 512、Windows 最小 256），而 `.icns` / `.ico` 不是能手工拼的东西。
 * 更关键的是 `.icns` **只有 macOS 能生成**（`sips` + `iconutil`），所以这必须是一个
 * 本地跑一次、产物入库的步骤 —— 不能让 CI 每次构建时现生成。
 *
 * 依赖：
 *   - macOS（`qlmanage` 光栅化、`iconutil` 打包 icns）
 *   - 无任何 npm 依赖：PNG 的读/写与缩放都在本文件里实现
 *
 * 用法：
 *   npm run build:icons
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_DIR = join(ROOT, "build");
const SOURCE = join(BUILD_DIR, "icon.svg");
const MASTER = 1024;

if (process.platform !== "darwin") {
	process.stderr.write(
		`这个脚本只能在 macOS 上运行（需要 qlmanage 与 iconutil）。\n` +
			`当前平台是 ${process.platform}。\n` +
			`图标产物（build/icon.icns、build/icon.ico、build/icon.png）已经入库，\n` +
			`只有「改设计后重新生成」这一步需要 macOS。\n`,
	);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// PNG 解码
//
// 只支持光栅化器实际会产出的形态：8 位、颜色类型 6（RGBA）或 2（RGB）、
// 无隔行。遇到别的形态直接报错，而不是猜 —— 猜错会静默产出颜色错误的图标。
// ---------------------------------------------------------------------------
function decodePng(file) {
	const buf = readFileSync(file);
	let offset = 8;
	let width;
	let height;
	let colorType;
	const chunks = [];

	while (offset < buf.length) {
		const length = buf.readUInt32BE(offset);
		const type = buf.toString("ascii", offset + 4, offset + 8);
		const data = buf.subarray(offset + 8, offset + 8 + length);

		if (type === "IHDR") {
			width = data.readUInt32BE(0);
			height = data.readUInt32BE(4);
			const bitDepth = data[8];
			colorType = data[9];
			const interlace = data[12];
			if (bitDepth !== 8 || interlace !== 0 || (colorType !== 6 && colorType !== 2)) {
				throw new Error(`不支持的 PNG 形态：位深 ${bitDepth}、颜色类型 ${colorType}、隔行 ${interlace}`);
			}
		}
		if (type === "IDAT") chunks.push(data);
		offset += 12 + length;
	}

	const raw = inflateSync(Buffer.concat(chunks));
	const channels = colorType === 6 ? 4 : 3;
	const stride = width * channels;
	const pixels = Buffer.alloc(height * stride);

	let cursor = 0;
	for (let y = 0; y < height; y += 1) {
		const filter = raw[cursor];
		cursor += 1;
		const line = raw.subarray(cursor, cursor + stride);
		cursor += stride;

		const current = pixels.subarray(y * stride, (y + 1) * stride);
		const previous = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);

		for (let x = 0; x < stride; x += 1) {
			const a = line[x];
			const b = x >= channels ? current[x - channels] : 0;
			const c = previous[x];
			const d = x >= channels ? previous[x - channels] : 0;
			let value;
			switch (filter) {
				case 0:
					value = a;
					break;
				case 1:
					value = a + b;
					break;
				case 2:
					value = a + c;
					break;
				case 3:
					value = a + ((b + c) >> 1);
					break;
				case 4: {
					// Paeth：p = a + b - c，取距离 p 最近的那个邻居
					// （a=左、b=上、c=左上，这里分别对应 b、c、d）
					const p = b + c - d;
					const pa = Math.abs(p - b);
					const pb = Math.abs(p - c);
					const pc = Math.abs(p - d);
					const predictor = pa <= pb && pa <= pc ? b : pb <= pc ? c : d;
					value = a + predictor;
					break;
				}
				default:
					throw new Error(`未知的 PNG 行过滤器：${filter}`);
			}
			current[x] = value & 0xff;
		}
	}

	return { width, height, channels, pixels };
}

// ---------------------------------------------------------------------------
// PNG 编码（RGBA8）
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
	const table = new Int32Array(256);
	for (let n = 0; n < 256; n += 1) {
		let c = n;
		for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c;
	}
	return table;
})();

function crc32(buf) {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const out = Buffer.alloc(8 + data.length + 4);
	out.writeUInt32BE(data.length, 0);
	out.write(type, 4, "ascii");
	data.copy(out, 8);
	out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
	return out;
}

function encodePng(width, height, rgba) {
	const stride = width * 4;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y += 1) {
		raw[y * (stride + 1)] = 0; // 过滤器 0：None
		rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
	}

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // 位深
	ihdr[9] = 6; // 颜色类型：RGBA
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;

	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw, { level: 9 })),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

// ---------------------------------------------------------------------------
// 缩放：面积平均
//
// 用面积平均而不是最近邻：图标要在 16px 下看，最近邻会让细线整段消失或整段变粗。
// ---------------------------------------------------------------------------
function resize(source, size) {
	const { width, height, channels, pixels } = source;
	const out = Buffer.alloc(size * size * 4);
	const scale = width / size;

	for (let dy = 0; dy < size; dy += 1) {
		const y0 = dy * scale;
		const y1 = (dy + 1) * scale;
		for (let dx = 0; dx < size; dx += 1) {
			const x0 = dx * scale;
			const x1 = (dx + 1) * scale;
			let r = 0;
			let g = 0;
			let b = 0;
			let a = 0;
			let n = 0;

			for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy += 1) {
				if (sy < 0 || sy >= height) continue;
				for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx += 1) {
					if (sx < 0 || sx >= width) continue;
					const i = (sy * width + sx) * channels;
					r += pixels[i];
					g += pixels[i + 1];
					b += pixels[i + 2];
					a += channels === 4 ? pixels[i + 3] : 255;
					n += 1;
				}
			}

			const o = (dy * size + dx) * 4;
			out[o] = Math.round(r / n);
			out[o + 1] = Math.round(g / n);
			out[o + 2] = Math.round(b / n);
			out[o + 3] = Math.round(a / n);
		}
	}

	return out;
}

// ---------------------------------------------------------------------------
// ICO 容器
//
// Vista 起 ICO 允许直接内嵌 PNG，不必再存 BMP + AND 掩码。
// 256 那一档**必须**是 PNG（BMP 表示不下），所以整份统一用 PNG 最省心。
// ---------------------------------------------------------------------------
function buildIco(entries) {
	const header = Buffer.alloc(6);
	header.writeUInt16LE(0, 0); // 保留位
	header.writeUInt16LE(1, 2); // 类型：1 = 图标
	header.writeUInt16LE(entries.length, 4);

	const directory = Buffer.alloc(16 * entries.length);
	let offset = header.length + directory.length;

	entries.forEach((entry, index) => {
		const at = index * 16;
		directory[at] = entry.size >= 256 ? 0 : entry.size; // 0 表示 256
		directory[at + 1] = entry.size >= 256 ? 0 : entry.size;
		directory[at + 2] = 0; // 调色板数
		directory[at + 3] = 0; // 保留位
		directory.writeUInt16LE(1, at + 4); // 色彩平面
		directory.writeUInt16LE(32, at + 6); // 位深
		directory.writeUInt32LE(entry.data.length, at + 8);
		directory.writeUInt32LE(offset, at + 12);
		offset += entry.data.length;
	});

	return Buffer.concat([header, directory, ...entries.map((e) => e.data)]);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
function rasterize(svgPath, size, outDir) {
	execFileSync("qlmanage", ["-t", "-s", String(size), "-o", outDir, svgPath], {
		stdio: ["ignore", "ignore", "pipe"],
	});
	return join(outDir, `${svgPath.split("/").pop()}.png`);
}

function main() {
	if (!readFileSync(SOURCE, "utf8").includes("<svg")) {
		throw new Error(`${SOURCE} 看起来不是 SVG`);
	}

	const scratch = mkdtempSync(join(tmpdir(), "zerowork-icons-"));
	const iconset = join(BUILD_DIR, "icon.iconset");

	try {
		process.stdout.write(`光栅化 build/icon.svg → ${MASTER}×${MASTER}\n`);
		const masterPng = rasterize(SOURCE, MASTER, scratch);
		const master = decodePng(masterPng);

		if (master.width !== MASTER || master.height !== MASTER) {
			throw new Error(`光栅化结果尺寸不对：${master.width}×${master.height}`);
		}

		const cache = new Map([[MASTER, resize(master, MASTER)]]);
		const at = (size) => {
			if (!cache.has(size)) cache.set(size, resize(master, size));
			return cache.get(size);
		};

		writeFileSync(join(BUILD_DIR, "icon.png"), encodePng(MASTER, MASTER, at(MASTER)));
		process.stdout.write("  build/icon.png\n");

		rmSync(iconset, { recursive: true, force: true });
		mkdirSync(iconset, { recursive: true });
		const scale1x = [16, 32, 128, 256, 512];
		for (const size of scale1x) {
			writeFileSync(join(iconset, `icon_${size}x${size}.png`), encodePng(size, size, at(size)));
			writeFileSync(join(iconset, `icon_${size}x${size}@2x.png`), encodePng(size * 2, size * 2, at(size * 2)));
		}

		execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(BUILD_DIR, "icon.icns")], {
			stdio: ["ignore", "ignore", "inherit"],
		});
		rmSync(iconset, { recursive: true, force: true });
		process.stdout.write("  build/icon.icns\n");

		const icoSizes = [16, 24, 32, 48, 64, 128, 256];
		writeFileSync(
			join(BUILD_DIR, "icon.ico"),
			buildIco(icoSizes.map((size) => ({ size, data: encodePng(size, size, at(size)) }))),
		);
		process.stdout.write("  build/icon.ico\n");

		process.stdout.write("\n完成。electron-builder 会从 buildResources 目录自动拾取：\n");
		process.stdout.write("  macOS   → build/icon.icns\n");
		process.stdout.write("  Windows → build/icon.ico\n");
	} finally {
		rmSync(scratch, { recursive: true, force: true });
		rmSync(iconset, { recursive: true, force: true });
	}
}

main();
