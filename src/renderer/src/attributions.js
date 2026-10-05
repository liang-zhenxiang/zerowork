/**
 * 「关于」页要展示的第三方组件与许可 —— 纯数据，不含渲染。
 *
 * ## 为什么这份清单必须在应用内可见，而不只是躺在仓库里
 *
 * 本应用**随包分发**了若干第三方库（预打包进 `out/renderer`，或被 `resources/` 带走），
 * 而 MIT 与 Apache-2.0 都要求分发副本里保留**版权声明与许可**：
 * Apache-2.0 第 4 条（保留 NOTICE/归属）、MIT 的「在软件的副本中包含版权声明与许可声明」。
 * 光在仓库里有一份 `THIRD_PARTY_NOTICES.md` 不够 —— 用户手上拿到的是安装包，不是仓库。
 *
 * ## 这份清单的边界（写清楚，免得被当成「全部第三方内容」）
 *
 * 只列**随应用一起分发、且要求保留归属**的代码型依赖。`resources/` 下的专家 / 技能 /
 * 提示词等内容归 `THIRD_PARTY_NOTICES.md` 管，那个文件才是这些事项的**唯一权威清单**；
 * 这里是与它对得上、且**只在应用内呈现**的那一小块（完整清单与许可原文仍以仓库为准）。
 *
 * ## 一声明：MiSans 曾经在列，现在不在
 *
 * 小米 MiSans 字体曾随包，其许可要求「在软件中特别注明使用了 MiSans 字体」——
 * 那是本清单当初要解决的义务。**2026-09-20 起 MiSans 已从界面字体栈与随包内容中移除**
 * （理由与实测记录见 `resources/fonts/README.md` 与 `app.css` 里 `--font-body` 的注释），
 * 因此那条义务随之不再适用，本清单**刻意不列它** —— 列了等于声称用了它，反而不实。
 * 若将来重新随包 MiSans，必须同时把那条注明加回这里（这条约束由单测守着）。
 */

/** 应用自身的许可。真源是仓库根的 `LICENSE`。 */
export const APP_LICENSE = {
	id: "Apache-2.0",
	holder: "ZeroWork 贡献者",
};

/**
 * 随包分发的第三方组件。字段：
 *   name    —— 展示名（含常见的包名，方便对上仓库里的依赖）
 *   license —— 许可标识
 *   holder  —— 权利人（MIT/Apache-2.0 的归属声明要求）
 *   use     —— 一句话说明它在应用里做什么（用户看得懂的那半）
 */
export const BUNDLED_COMPONENTS = [
	{
		// 显示名只写 KaTeX：同伴（remark-math / rehype-katex）与字体子集放进用途说明 ——
		// 名字太长会把整行挤成省略号（实测），而那一行正是**要让人看见**的归属声明。
		name: "KaTeX",
		license: "MIT",
		holder: "KaTeX Contributors 及各依赖权利人",
		use: "数学公式排版（含字体子集）",
	},
	{
		name: "SheetJS Community Edition（xlsx）",
		license: "Apache-2.0",
		holder: "SheetJS LLC",
		use: "预览 csv / xls 时把表格转成工作簿",
	},
	{
		name: "lodash",
		license: "MIT",
		holder: "John-David Dalton 及 lodash 贡献者",
		use: "工具函数",
	},
	{
		name: "JSZip",
		license: "MIT",
		holder: "Stuart Knightley 及 JSZip 贡献者",
		use: "解析 docx / xlsx / pptx 的包结构",
	},
	{
		name: "PDF.js（pdfjs-dist）",
		license: "Apache-2.0",
		holder: "Mozilla Foundation",
		use: "PDF 预览与文本层",
	},
];

/** 完整清单与许可原文在哪（应用内指向仓库，安装包不重复携带一份会漂移的副本）。 */
export const FULL_NOTICES_LOCATION = {
	file: "THIRD_PARTY_NOTICES.md",
	url: "https://github.com/liang-zhenxiang/zerowork/blob/main/THIRD_PARTY_NOTICES.md",
};

/** 清单里出现过的全部许可标识（去重、保持出现顺序）—— 给「概览一句话」与单测用。 */
export function licenseIds() {
	const ids = [];
	for (const component of BUNDLED_COMPONENTS) {
		if (!ids.includes(component.license)) ids.push(component.license);
	}
	return ids;
}
