/**
 * PNG 解码器与图像统计的单测。
 *
 * 为什么这个文件重要：`tests/e2e/lib/png.mjs` 是所有**截图断言的地基** ——
 * 每个 GUI 用例「画面不是一片空白」的判断都建在它上面。
 * 地基错了，上面所有断言都是假的（而且会**安静地**是假的：
 * 一张白屏被解码成「内容丰富」不会有任何征兆）。
 *
 * 所以这里不只测「能解码」，还测**每种滤波类型都还原正确** ——
 * PNG 的五种滤波是逐行可选的，一张真实截图里五行可能用五种不同的滤波，
 * 只测 filter 0 等于只测了最不会出问题的那种。
 */
import { describe, it, expect } from "vitest";
import { deflateSync } from "node:zlib";
import { decodePng, imageStats, downsample, diffGrids, renderGrid } from "../e2e/lib/png.mjs";

// ── 一个够用的 PNG 编码器，用于造夹具 ────────────────────────
//
// 放在测试里而不是复用被测代码：**不能让编码器与被解码器共享实现**，
// 否则同一处理解错误会在两边同时出现，测试就永远发现不了它。

function crc32(buf) {
	let crc = 0xffffffff;
	for (let n = 0; n < buf.length; n++) {
		let c = (crc ^ buf[n]) & 0xff;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		crc = c ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(typed));
	return Buffer.concat([len, typed, crc]);
}

function paeth(a, b, c) {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	return pb <= pc ? b : c;
}

/**
 * 编码一张 8 位 RGB 的 PNG。
 *
 * ⚠️ 滤波的参考像素一律取**原图**像素，不是已滤波的字节 ——
 * 这是 PNG 规范的定义（解码端逐行还原后再作为下一行的参考）。
 * 写这个编码器时第一版就是在 `raw` 里取左侧参考，结果 filter 1–4 全部对不上，
 * 而这恰恰证明了 round-trip 测试的价值：**编码器错了，测试立刻发现**。
 *
 * @param {number} filter 0–4，逐行统一使用这一种滤波（正是为了测解码器）
 */
function encodePng(width, height, pixelAt, filter = 0) {
	const bpp = 3;
	const stride = width * bpp;
	const raw = Buffer.alloc(height * (1 + stride));

	// 先算出整张原图，滤波时作为参考
	const src = Buffer.alloc(height * stride);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const [r, g, b] = pixelAt(x, y);
			const o = y * stride + x * bpp;
			src[o] = r;
			src[o + 1] = g;
			src[o + 2] = b;
		}
	}

	for (let y = 0; y < height; y++) {
		const rowStart = y * (1 + stride);
		raw[rowStart] = filter;
		for (let x = 0; x < width; x++) {
			const o = x * bpp;
			const base = y * stride + o;
			const left = x > 0 ? [src[base - bpp], src[base - bpp + 1], src[base - bpp + 2]] : [0, 0, 0];
			const up = y > 0 ? [src[base - stride], src[base - stride + 1], src[base - stride + 2]] : [0, 0, 0];
			const upLeft = y > 0 && x > 0 ? [src[base - stride - bpp], src[base - stride - bpp + 1], src[base - stride - bpp + 2]] : [0, 0, 0];
					const cur = [src[base], src[base + 1], src[base + 2]];
			for (let k = 0; k < 3; k++) {
				let v;
				if (filter === 0) v = cur[k];
				else if (filter === 1) v = cur[k] - left[k];
				else if (filter === 2) v = cur[k] - up[k];
				else if (filter === 3) v = cur[k] - ((left[k] + up[k]) >> 1);
				else v = cur[k] - paeth(left[k], up[k], upLeft[k]);
				raw[rowStart + 1 + o + k] = v & 0xff;
			}
		}
	}

	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bitDepth
	ihdr[9] = 2; // colorType = truecolor RGB
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", ihdr),
		chunk("IDAT", deflateSync(raw)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/** 取某个像素的 RGB。 */
function pixelAt(img, x, y) {
	const o = (y * img.width + x) * img.channels;
	return [img.data[o], img.data[o + 1], img.data[o + 2]];
}

/** 一张有实际结构的图：四段横带，颜色与亮度都不同。 */
const bands = (x, y) => {
	if (y < 6) return [20, 20, 20];
	if (y < 12) return [90, 90, 90];
	if (y < 18) return [12, 191, 91];
	return [20, 112, 180];
};

describe("PNG 解码", () => {
	// 五种滤波各自还原同一张图 —— 这条是核心：只测 filter 0 等于漏掉 4/5 的情况
	for (const filter of [0, 1, 2, 3, 4]) {
		it(`滤波类型 ${filter} 能还原出原始像素`, () => {
			const img = decodePng(encodePng(32, 24, bands, filter));
			expect(img.width).toBe(32);
			expect(img.height).toBe(24);
			expect(img.channels).toBe(3);
			// 抽查四段的代表像素，覆盖每一带的边界
			expect(pixelAt(img, 5, 2)).toEqual([20, 20, 20]);
			expect(pixelAt(img, 5, 8)).toEqual([90, 90, 90]);
			expect(pixelAt(img, 5, 14)).toEqual([12, 191, 91]);
			expect(pixelAt(img, 5, 22)).toEqual([20, 112, 180]);
		});
	}

	it("五种滤波解出的是同一张图", () => {
		const reference = decodePng(encodePng(16, 12, bands, 0));
		for (const filter of [1, 2, 3, 4]) {
			const other = decodePng(encodePng(16, 12, bands, filter));
			expect(other.data.equals(reference.data), `filter ${filter} 与 filter 0 不一致`).toBe(true);
		}
	});

	it("拒绝非 PNG 输入", () => {
		expect(() => decodePng(Buffer.from("这不是 PNG"))).toThrow(/不是 PNG/);
	});

	it("遇到不支持的位深明确报错，而不是返回看似正常的结果", () => {
		const png = encodePng(4, 4, () => [0, 0, 0]);
		// IHDR 的 bitDepth 在签名(8) + 长度(4) + 类型(4) 之后，即偏移 24
		png[24] = 16;
		expect(() => decodePng(png)).toThrow(/位深/);
	});

	it("遇到交错 PNG 明确报错", () => {
		const png = encodePng(4, 4, () => [0, 0, 0]);
		png[28] = 1; // IHDR 的 interlace 字段
		expect(() => decodePng(png)).toThrow(/交错/);
	});

	it("遇到索引色明确报错（需要调色板，本解码器不处理）", () => {
		const png = encodePng(4, 4, () => [0, 0, 0]);
		png[25] = 3; // colorType = 索引色
		expect(() => decodePng(png)).toThrow(/colorType/);
	});
});

describe("图像统计", () => {
	it("纯白图的亮度标准差为 0、颜色数为 1 —— 这正是「白屏」的判据", () => {
		const stats = imageStats(decodePng(encodePng(32, 32, () => [255, 255, 255])));
		expect(stats.stdDev).toBeCloseTo(0, 5);
		expect(stats.distinctColors).toBe(1);
		expect(stats.mean).toBeCloseTo(255, 5);
	});

	it("纯深色图同样被判为「一片纯色」", () => {
		const stats = imageStats(decodePng(encodePng(32, 32, () => [28, 28, 30])));
		expect(stats.stdDev).toBeLessThan(1);
		expect(stats.distinctColors).toBe(1);
	});

	it("有结构的图标准差明显更高", () => {
		const blank = imageStats(decodePng(encodePng(32, 32, () => [255, 255, 255])));
		const content = imageStats(decodePng(encodePng(32, 32, bands)));
		expect(content.stdDev).toBeGreaterThan(blank.stdDev + 30);
		expect(content.distinctColors).toBeGreaterThan(blank.distinctColors);
	});

	it("颜色多样性按 5 位量化 —— 抗锯齿的细微差别不该算成「很多颜色」", () => {
		// 造一张只有 1 个色阶差异的图：量化后应当仍算作 **1** 种颜色。
		// 不量化的话它会被数成 2 种（甚至更多），阈值就失去意义了。
		const almostFlat = imageStats(decodePng(encodePng(32, 32, (x) => (x % 2 ? [255, 255, 255] : [252, 255, 255]))));
		expect(almostFlat.distinctColors).toBe(1);
	});
});

describe("降采样与网格比对", () => {
	it("尺寸不同不影响降采样结果的网格大小", () => {
		const small = downsample(decodePng(encodePng(16, 16, bands)), 8, 8);
		const large = downsample(decodePng(encodePng(160, 160, bands)), 8, 8);
		expect(small.cells.length).toBe(64);
		expect(large.cells.length).toBe(64);
	});

	it("同一张图与自己的差异为 0", () => {
		const grid = downsample(decodePng(encodePng(64, 48, bands)));
		expect(diffGrids(grid, grid)).toBe(0);
	});

	it("明显不同的两张图差异显著", () => {
		const a = downsample(decodePng(encodePng(64, 48, bands)));
		const b = downsample(decodePng(encodePng(64, 48, () => [255, 255, 255])));
		expect(diffGrids(a, b)).toBeGreaterThan(50);
	});

	it("网格尺寸不同时明确报错，而不是给出一个凑合的数字", () => {
		const a = downsample(decodePng(encodePng(64, 48, bands)), 8, 8);
		const b = downsample(decodePng(encodePng(64, 48, bands)), 4, 4);
		expect(() => diffGrids(a, b)).toThrow(/尺寸不同/);
	});

	it("字符画的行数与列数符合网格", () => {
		const lines = renderGrid(downsample(decodePng(encodePng(64, 48, bands)), 10, 5)).split("\n");
		expect(lines.length).toBe(5);
		expect(lines[0].length).toBe(10);
	});
});
