#!/usr/bin/env python3
"""make_fixtures.py —— 生成 #460 的两个 docx 夹具（只用 python3 标准库）。

为什么用脚本生成、而不是把 .docx 提交进仓库：

1. 二进制在 review 里看不见，改了什么没人能审；
2. 仓库已有约定：`resources/docx-engine/docx_to_html/tests` 的夹具也是现造的
   （见该目录 conftest.py），不留二进制；
3. 生成是**确定性的** —— 条目顺序、时间戳、XML 内容都固定，任何机器重跑都得到
   同样的字节，所以实验结论可复现。

两个夹具刻意覆盖两条不同的保真线：

- `a-styles.docx`：标题样式、正文字体字号、加粗 run、项目符号编号、外部超链接。
- `b-table-header-footer.docx`：表格（首行表头 + 边框）、页眉、带 PAGE 域的页脚、
  分节属性（页面尺寸与页边距）。

用法：

    python3 tests/fixtures/docx-revision/make_fixtures.py --out /tmp/docx-revision

输出目录不存在会自动创建，内含以上两个文件。
"""
from __future__ import annotations

import argparse
import zipfile
from pathlib import Path

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"

# 固定时间戳：让 zip 条目在每台机器上都一样。1980-01-01 是 zip 能表示的最早时间。
ZIP_DATE = (1980, 1, 1, 0, 0, 0)

XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

CORE_PROPS = (
    XML_DECL
    + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"'
    ' xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/"'
    ' xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    "<dc:title>{title}</dc:title><dc:creator>ZeroWork fixture</dc:creator>"
    "<cp:lastModifiedBy>ZeroWork fixture</cp:lastModifiedBy>"
    '<dcterms:created xsi:type="dcterms:W3CDTF">2026-11-23T00:00:00Z</dcterms:created>'
    '<dcterms:modified xsi:type="dcterms:W3CDTF">2026-11-23T00:00:00Z</dcterms:modified>'
    "</cp:coreProperties>"
)

APP_PROPS = (
    XML_DECL
    + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"'
    ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
    "<Application>ZeroWork fixture</Application></Properties>"
)

ROOT_RELS = (
    XML_DECL
    + f'<Relationships xmlns="{PKG_REL_NS}">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
    "</Relationships>"
)

STYLES = (
    XML_DECL
    + f'<w:styles xmlns:w="{W_NS}">'
    "<w:docDefaults><w:rPrDefault><w:rPr>"
    '<w:rFonts w:ascii="Calibri" w:eastAsia="宋体" w:hAnsi="Calibri"/>'
    '<w:sz w:val="21"/><w:szCs w:val="21"/>'
    "</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>"
    '<w:spacing w:after="120" w:line="276" w:lineRule="auto"/>'
    "</w:pPr></w:pPrDefault></w:docDefaults>"
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>'
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>'
    '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>'
    '<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr>'
    '<w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>'
    '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/>'
    '<w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720"/></w:pPr></w:style>'
    '<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/>'
    '<w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>'
    '<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/>'
    "<w:tblPr><w:tblBorders>"
    '<w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
    '<w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
    '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
    '<w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
    '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
    '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
    "</w:tblBorders></w:tblPr></w:style>"
    "</w:styles>"
)

NUMBERING = (
    XML_DECL
    + f'<w:numbering xmlns:w="{W_NS}">'
    '<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/>'
    '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/>'
    '<w:lvlText w:val="%1."/><w:lvlJc w:val="left"/>'
    '<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>'
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
    "</w:numbering>"
)

SECT_PR = (
    "<w:sectPr>"
    '<w:pgSz w:w="11906" w:h="16838"/>'
    '<w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800"'
    ' w:header="851" w:footer="992" w:gutter="0"/>'
    "</w:sectPr>"
)


def _doc(body: str, extra_ns: str = "") -> str:
    return (
        XML_DECL
        + f'<w:document xmlns:w="{W_NS}" xmlns:r="{R_NS}"{extra_ns}><w:body>{body}</w:body></w:document>'
    )


def _p(text: str, *, style: str | None = None, num_id: int | None = None, bold: bool = False) -> str:
    ppr = ""
    if style or num_id is not None:
        inner = f'<w:pStyle w:val="{style}"/>' if style else ""
        if num_id is not None:
            inner += f'<w:numPr><w:ilvl w:val="0"/><w:numId w:val="{num_id}"/></w:numPr>'
        ppr = f"<w:pPr>{inner}</w:pPr>"
    rpr = "<w:rPr><w:b/></w:rPr>" if bold else ""
    return f'<w:p>{ppr}<w:r>{rpr}<w:t xml:space="preserve">{text}</w:t></w:r></w:p>'


def fixture_a() -> dict[str, str]:
    """样式 + 编号 + 超链接。"""
    body = (
        _p("季度报告", style="Heading1")
        + '<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr>'
        '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">本季度营收</w:t></w:r>'
        '<w:r><w:t xml:space="preserve"> 增长 12%，详见 </w:t></w:r>'
        '<w:hyperlink r:id="rIdLink1"><w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr>'
        '<w:t>公开报告</w:t></w:r></w:hyperlink>'
        '<w:r><w:t>。</w:t></w:r></w:p>'
        + _p("第一条要点", style="ListParagraph", num_id=1)
        + _p("第二条要点", style="ListParagraph", num_id=1)
        # 真实文档里一段话常被拆成多个 run（拼写检查、格式变化都会拆），
        # 这条刻意拆开，用来证明「按整段文字查找」会失败。
        + '<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr>'
        '<w:r><w:t xml:space="preserve">跨 run </w:t></w:r>'
        '<w:r><w:rPr><w:i/></w:rPr><w:t>的文本</w:t></w:r></w:p>'
        + _p("以上数据未经审计。", style="Normal")
        + SECT_PR
    )
    overrides = (
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
        '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>'
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
    )
    document_rels = (
        XML_DECL
        + f'<Relationships xmlns="{PKG_REL_NS}">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>'
        '<Relationship Id="rIdLink1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"'
        ' Target="https://example.com/report" TargetMode="External"/>'
        "</Relationships>"
    )
    return {
        "[Content_Types].xml": content_types(overrides),
        "_rels/.rels": ROOT_RELS,
        "docProps/app.xml": APP_PROPS,
        "docProps/core.xml": CORE_PROPS.format(title="样式与编号夹具"),
        "word/document.xml": _doc(body),
        "word/styles.xml": STYLES,
        "word/numbering.xml": NUMBERING,
        "word/_rels/document.xml.rels": document_rels,
    }


def _cell(text: str, *, bold: bool = False, fill: str | None = None) -> str:
    tcpr = f'<w:tcPr><w:shd w:val="clear" w:color="auto" w:fill="{fill}"/></w:tcPr>' if fill else ""
    rpr = "<w:rPr><w:b/></w:rPr>" if bold else ""
    return f'<w:tc>{tcpr}<w:p><w:r>{rpr}<w:t>{text}</w:t></w:r></w:p></w:tc>'


def _row(cells: list[str], *, header: bool = False) -> str:
    trpr = "<w:trPr><w:tblHeader/></w:trPr>" if header else ""
    return f"<w:tr>{trpr}{''.join(cells)}</w:tr>"


def fixture_b() -> dict[str, str]:
    """表格 + 页眉 + 带 PAGE 域的页脚。"""
    borders = (
        "<w:tblBorders>"
        '<w:top w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
        '<w:left w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
        '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
        '<w:right w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
        '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
        '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/>'
        "</w:tblBorders>"
    )
    table = (
        "<w:tbl><w:tblPr>"
        '<w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/>'
        f"{borders}</w:tblPr>"
        '<w:tblGrid><w:gridCol w:w="4675"/><w:gridCol w:w="4675"/></w:tblGrid>'
        + _row([_cell("项目", bold=True, fill="D9E2F3"), _cell("金额（万元）", bold=True, fill="D9E2F3")], header=True)
        + _row([_cell("营业收入"), _cell("1,280")])
        + _row([_cell("营业成本"), _cell("760")])
        + "</w:tbl>"
    )
    sect_pr = (
        "<w:sectPr>"
        '<w:headerReference w:type="default" r:id="rIdHeader"/>'
        '<w:footerReference w:type="default" r:id="rIdFooter"/>'
        '<w:pgSz w:w="11906" w:h="16838"/>'
        '<w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800"'
        ' w:header="851" w:footer="992" w:gutter="0"/>'
        "</w:sectPr>"
    )
    body = _p("数据汇总", style="Heading1") + _p("下表为初步核算结果。", style="Normal") + table + sect_pr

    header = (
        XML_DECL
        + f'<w:hdr xmlns:w="{W_NS}" xmlns:r="{R_NS}"><w:p>'
        '<w:r><w:rPr><w:b/></w:rPr><w:t>内部资料 · 仅供评审</w:t></w:r></w:p></w:hdr>'
    )
    footer = (
        XML_DECL
        + f'<w:ftr xmlns:w="{W_NS}" xmlns:r="{R_NS}"><w:p>'
        '<w:r><w:t xml:space="preserve">第 </w:t></w:r>'
        '<w:fldSimple w:instr=" PAGE "><w:r><w:t>1</w:t></w:r></w:fldSimple>'
        '<w:r><w:t xml:space="preserve"> 页</w:t></w:r></w:p></w:ftr>'
    )
    overrides = (
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
        '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>'
        '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>'
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
    )
    document_rels = (
        XML_DECL
        + f'<Relationships xmlns="{PKG_REL_NS}">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        '<Relationship Id="rIdHeader" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>'
        '<Relationship Id="rIdFooter" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>'
        "</Relationships>"
    )
    return {
        "[Content_Types].xml": content_types(overrides),
        "_rels/.rels": ROOT_RELS,
        "docProps/app.xml": APP_PROPS,
        "docProps/core.xml": CORE_PROPS.format(title="表格与页眉页脚夹具"),
        "word/document.xml": _doc(body),
        "word/styles.xml": STYLES,
        "word/header1.xml": header,
        "word/footer1.xml": footer,
        "word/_rels/document.xml.rels": document_rels,
    }


def content_types(overrides: str) -> str:
    return (
        XML_DECL
        + f'<Types xmlns="{CT_NS}">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        f"{overrides}</Types>"
    )


def write_docx(path: Path, parts: dict[str, str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name, text in parts.items():
            info = zipfile.ZipInfo(name, date_time=ZIP_DATE)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o600 << 16
            archive.writestr(info, text.encode("utf-8"))


def build(out_dir: Path) -> dict[str, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    produced = {
        "a-styles.docx": out_dir / "a-styles.docx",
        "b-table-header-footer.docx": out_dir / "b-table-header-footer.docx",
    }
    write_docx(produced["a-styles.docx"], fixture_a())
    write_docx(produced["b-table-header-footer.docx"], fixture_b())
    return produced


def main() -> int:
    parser = argparse.ArgumentParser(description="生成 #460 docx 保真实验夹具")
    parser.add_argument("--out", required=True, type=Path, help="输出目录（会创建）")
    args = parser.parse_args()
    for name, path in build(args.out).items():
        print(f"{name}\t{path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
