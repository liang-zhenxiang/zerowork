/**
 * 极简 PNG 解码 + 图像统计。
 *
 * 为什么自己写而不用现成的库：
 *
 *   · 这是**测试基建**，加一个运行时依赖只为了让测试能读自己刚截的图，不划算
 *   · 需要的只是「解出像素做几个统计量」，不需要编码、不需要动画、
 *     不需要调色板与交错 —— 那些正是通用库体积的来源
 *   · Chromium 的截图固定是 8 位、非交错、RGB 或 RGBA，覆盖面很小
 *
 * 只支持 8 位非交错的灰度 / RGB / RGBA / 灰度+alpha。遇到不支持的格式**明确报错**，
 * 而不是返回一个看起来正常的结果 —— 一个静默返回错的统计量比报错危险得多。
 */

import { inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 每个像素的字节数，按 colorType 查。0=灰度 2=RGB 3=索引 4=灰度+A 6=RGBA */
const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * 解码 PNG。返回 `{ width, height, channels, data }`，`data` 是逐行的原始字节。
 * @param {Buffer} buf
 */
export function decodePng(buf) {
	if (!buf.subarray(0, 8).equals(SIGNATURE)) {
		throw new Error('不是 PNG（签名不符）');
	}

	let offset = 8;
	let ihdr = null;
	const idat = [];

	while (offset < buf.length) {
		const length = buf.readUInt32BE(offset);
		const type = buf.toString('ascii', offset + 4, offset + 8);
		const data = buf.subarray(offset + 8, offset + 8 + length);

		if (type === 'IHDR') {
			ihdr = {
				width: data.readUInt32BE(0),
				height: data.readUInt32BE(4),
				bitDepth: data[8],
				colorType: data[9],
				interlace: data[12],
			};
		} else if (type === 'IDAT') {
			idat.push(data);
		} else if (type === 'IEND') {
			break;
		}
		offset += 12 + length; // length(4) + type(4) + data + crc(4)
	}

	if (!ihdr) throw new Error('PNG 缺少 IHDR');
	if (ihdr.bitDepth !== 8) {
		throw new Error(`不支持位深 ${ihdr.bitDepth}（本解码器只处理 8 位）`);
	}
	if (ihdr.interlace !== 0) {
		throw new Error('不支持交错（interlaced）PNG');
	}
	const channels = CHANNELS[ihdr.colorType];
	if (!channels || ihdr.colorType === 3) {
		throw new Error(`不支持的 colorType ${ihdr.colorType}（索引色需调色板，本解码器不处理）`);
	}

	const raw = inflateSync(Buffer.concat(idat));
	const stride = ihdr.width * channels;
	const out = Buffer.alloc(ihdr.height * stride);

	// 逐行反滤波。每行开头一个 filter 字节，其后是 stride 个字节。
	let pos = 0;
	for (let y = 0; y < ihdr.height; y++) {
		const filter = raw[pos++];
		const line = raw.subarray(pos, pos + stride);
		pos += stride;

		const cur = out.subarray(y * stride, (y + 1) * stride);
		const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
		unfilter(filter, line, cur, prev, channels);
	}

	return { width: ihdr.width, height: ihdr.height, channels, data: out };
}

/** 按 PNG 规范还原一行。`bpp` 是「每像素字节数」，用于取左侧参考像素。 */
function unfilter(filter, line, cur, prev, bpp) {
	switch (filter) {
		case 0: // None
			line.copy(cur);
			break;
		case 1: // Sub：减左侧
			for (let i = 0; i < line.length; i++) {
				const left = i >= bpp ? cur[i - bpp] : 0;
				cur[i] = (line[i] + left) & 0xff;
			}
			break;
		case 2: // Up：减上方
			for (let i = 0; i < line.length; i++) {
				const up = prev ? prev[i] : 0;
				cur[i] = (line[i] + up) & 0xff;
			}
			break;
		case 3: // Average：减左与上的均值
			for (let i = 0; i < line.length; i++) {
				const left = i >= bpp ? cur[i - bpp] : 0;
				const up = prev ? prev[i] : 0;
				cur[i] = (line[i] + ((left + up) >> 1)) & 0xff;
			}
			break;
		case 4: // Paeth
			for (let i = 0; i < line.length; i++) {
				const left = i >= bpp ? cur[i - bpp] : 0;
				const up = prev ? prev[i] : 0;
				const upLeft = prev && i >= bpp ? prev[i - bpp] : 0;
				cur[i] = (line[i] + paeth(left, up, upLeft)) & 0xff;
			}
			break;
		default:
			throw new Error(`未知的 PNG 滤波类型 ${filter}`);
	}
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
 * 把图像降采样成固定尺寸的灰度网格。返回 `{ cols, rows, cells }`，
 * 每个 cell 是 0–255 的亮度均值。
 *
 * 降采样而不是逐像素是因为：**这张图是拿来判断「整体长什么样」的**，
 * 逐像素比对对渲染的亚像素差异太敏感，会变成一条不稳定的门禁。
 * 降采样之后，抗锯齿的微小差别被平均掉，而「区域整体变白/变黑/错位」依然看得见。
 */
export function downsample(img, cols = 32, rows = 18) {
	const { width, height, channels, data } = img;
	const cells = new Float64Array(cols * rows);
	const counts = new Uint32Array(cols * rows);

	for (let y = 0; y < height; y++) {
		const ry = Math.min(rows - 1, Math.floor((y / height) * rows));
		for (let x = 0; x < width; x++) {
			const rx = Math.min(cols - 1, Math.floor((x / width) * cols));
			const i = (y * width + x) * channels;
			const r = data[i];
			const g = channels >= 3 ? data[i + 1] : r;
			const b = channels >= 3 ? data[i + 2] : r;
			// Rec. 709 亮度
			const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
			const idx = ry * cols + rx;
			cells[idx] += lum;
			counts[idx]++;
		}
	}

	for (let i = 0; i < cells.length; i++) {
		cells[i] = counts[i] > 0 ? cells[i] / counts[i] : 0;
	}
	return { cols, rows, cells };
}

/** 一组统计量，用于写「不是空白」这类断言。 */
export function imageStats(img) {
	const { width, height, channels, data } = img;
	const total = width * height;
	const hist = new Uint32Array(256); // 亮度直方图，用来数「有多少种不同的灰」

	let sum = 0;
	let min = 255;
	let max = 0;
	const colors = new Set();

	for (let i = 0; i < total; i++) {
		const o = i * channels;
		const r = data[o];
		const g = channels >= 3 ? data[o + 1] : r;
		const b = channels >= 3 ? data[o + 2] : r;
		const lum = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
		hist[lum]++;
		sum += lum;
		if (lum < min) min = lum;
		if (lum > max) max = lum;
		// 颜色多样性用「量化到 5 位」来数：抗锯齿会产生大量只差 1 的颜色，
		// 逐位精确会得到「一张纯色图也有几千种颜色」的错误结论
		colors.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
	}

	const mean = sum / total;
	let variance = 0;
	for (let i = 0; i < total; i++) {
		const o = i * channels;
		const r = data[o];
		const g = channels >= 3 ? data[o + 1] : r;
		const b = channels >= 3 ? data[o + 2] : r;
		const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
		variance += (lum - mean) ** 2;
	}

	// 出现超过 0.5% 像素的亮度值有几个 —— 「这张图有没有层次」
	let dominantBuckets = 0;
	for (let i = 0; i < 256; i++) {
		if (hist[i] > total * 0.005) dominantBuckets++;
	}

	return {
		width,
		height,
		mean,
		stdDev: Math.sqrt(variance / total),
		min,
		max,
		distinctColors: colors.size,
		dominantBuckets,
	};
}

/**
 * 两张同尺寸图的降采样差异（0–255 的平均绝对差）。
 * 用于「改前改后」的粗略回归比对。
 */
export function diffGrids(a, b) {
	if (a.cols !== b.cols || a.rows !== b.rows) {
		throw new Error('两张图的降采样网格尺寸不同，无法比对');
	}
	let sum = 0;
	for (let i = 0; i < a.cells.length; i++) {
		sum += Math.abs(a.cells[i] - b.cells[i]);
	}
	return sum / a.cells.length;
}

/** 把降采样网格渲染成便于在终端里看的字符画 —— 失败时贴进日志，比数值直观。 */
export function renderGrid(grid) {
	const ramp = ' .:-=+*#%@';
	const lines = [];
	for (let r = 0; r < grid.rows; r++) {
		let line = '';
		for (let c = 0; c < grid.cols; c++) {
			const v = grid.cells[r * grid.cols + c];
			const idx = Math.min(ramp.length - 1, Math.floor((v / 255) * ramp.length));
			line += ramp[idx];
		}
		lines.push(line);
	}
	return lines.join('\n');
}
