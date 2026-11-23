#!/usr/bin/env python3
"""inspect_docx.py —— 给 docx 做一份「保真清单」（只用 python3 标准库）。

实验要回答的是「这条路径保住了什么、丢了什么」，所以先得有一份可比较的清单。
本脚本不解包到磁盘、不依赖 python-docx，直接读 OPC zip：

- **包结构**：条目顺序、每个条目的 sha256（判断除目标文件外是否逐字节不变）
- **结构特征**：样式 / 编号 / 页眉页脚 / 批注 / 脚注等部件是否存在
- **正文特征**：标题样式使用、段落与 run、加粗/斜体/下划线、超链接及目标、
  编号段落、表格与单元格、body 块顺序
- **页面特征**：页眉/页脚文字、PAGE 域、分节数、页面尺寸与页边距
- **语义文本**：按 body 顺序拼出的纯文本（判断「文字有没有丢」）

输出一份 JSON，便于把两次结果做 diff。用法：

    python3 tests/fixtures/docx-revision/inspect_docx.py FILE [FILE ...] [--json]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import zipfile
import xml.etree.ElementTree as ET
from collections import Counter
from pathlib import Path

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"


def _local(tag: object) -> str:
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def _attr(element: ET.Element, name: str) -> str | None:
    for key, value in element.attrib.items():
        if _local(key) == name:
            return value
    return None


def _texts(element: ET.Element) -> list[str]:
    return [child.text for child in element.iter() if _local(child.tag) == "t" and child.text]


def _paragraph_text(paragraph: ET.Element) -> str:
    return "".join(_texts(paragraph))


def _body_blocks(body: ET.Element) -> list[ET.Element]:
    return [child for child in body if _local(child.tag) in {"p", "tbl", "sectPr"}]


def _relationships(archive: zipfile.ZipFile, entry: str) -> dict[str, dict[str, str]]:
    if entry not in archive.namelist():
        return {}
    root = ET.fromstring(archive.read(entry))
    result: dict[str, dict[str, str]] = {}
    for relationship in root:
        rel_id = relationship.get("Id")
        if rel_id:
            result[rel_id] = {
                "type": (relationship.get("Type") or "").rsplit("/", 1)[-1],
                "target": relationship.get("Target") or "",
                "external": relationship.get("TargetMode") == "External",
            }
    return result


def _header_footer_inventory(archive: zipfile.ZipFile) -> dict[str, object]:
    headers: list[dict[str, str]] = []
    footers: list[dict[str, str]] = []
    for name in archive.namelist():
        is_header = name.startswith("word/header") and name.endswith(".xml")
        is_footer = name.startswith("word/footer") and name.endswith(".xml")
        if not (is_header or is_footer):
            continue
        root = ET.fromstring(archive.read(name))
        instructions = []
        for element in root.iter():
            kind = _local(element.tag)
            if kind == "fldSimple":
                instructions.append(_attr(element, "instr") or "")
            elif kind == "instrText" and element.text:
                instructions.append(element.text)
        item = {
            "part": name,
            "text": "".join(_texts(root)),
            "page_field": any(
                token.upper() == "PAGE"
                for instruction in instructions
                for token in instruction.split()
            ),
        }
        (headers if is_header else footers).append(item)
    return {"headers": headers, "footers": footers}


def inventory(path: str | Path) -> dict[str, object]:
    path = Path(path)
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        entries = []
        for info in archive.infolist():
            if info.filename.endswith("/"):
                continue
            data = archive.read(info.filename)
            entries.append(
                {
                    "name": info.filename,
                    "size": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                }
            )

        document = ET.fromstring(archive.read("word/document.xml"))
        body = next(child for child in document if _local(child.tag) == "body")
        rels = _relationships(archive, "word/_rels/document.xml.rels")

        paragraphs = [element for element in body.iter() if _local(element.tag) == "p"]
        runs = [element for element in body.iter() if _local(element.tag) == "r"]
        hyperlinks = [element for element in body.iter() if _local(element.tag) == "hyperlink"]
        numbered = [
            element
            for element in paragraphs
            if any(_local(child.tag) == "numPr" for child in element.iter())
        ]
        def has_run_property(element: ET.Element, name: str) -> bool:
            for child in element.iter():
                if _local(child.tag) != "rPr":
                    continue
                for grand in child:
                    if _local(grand.tag) != name:
                        continue
                    value = _attr(grand, "val")
                    if value is None or value.lower() not in {"0", "false", "off", "none"}:
                        return True
            return False

        bold_runs = [element for element in runs if has_run_property(element, "b")]
        italic_runs = [element for element in runs if has_run_property(element, "i")]
        underlined_runs = [element for element in runs if has_run_property(element, "u")]
        styles = Counter()
        for paragraph in paragraphs:
            style = next(
                (
                    _attr(element, "val")
                    for element in paragraph.iter()
                    if _local(element.tag) == "pStyle"
                ),
                None,
            )
            styles[style or "(default)"] += 1

        tables = [element for element in body.iter() if _local(element.tag) == "tbl"]
        rows = [element for element in body.iter() if _local(element.tag) == "tr"]
        cells = [element for element in body.iter() if _local(element.tag) == "tc"]
        table_text = []
        for table in tables:
            for row in (child for child in table if _local(child.tag) == "tr"):
                table_text.append(
                    [
                        "".join(
                            _paragraph_text(paragraph)
                            for paragraph in cell.iter()
                            if _local(paragraph.tag) == "p"
                        )
                        for cell in row
                        if _local(cell.tag) == "tc"
                    ]
                )

        sect_prs = [element for element in document.iter() if _local(element.tag) == "sectPr"]
        page = {"count": len(sect_prs), "size": None, "margins": None}
        if sect_prs:
            sect = sect_prs[-1]
            size = next((child for child in sect if _local(child.tag) == "pgSz"), None)
            margin = next((child for child in sect if _local(child.tag) == "pgMar"), None)
            if size is not None:
                page["size"] = {"width": _attr(size, "w"), "height": _attr(size, "h")}
            if margin is not None:
                page["margins"] = {
                    key: _attr(margin, key)
                    for key in ("top", "right", "bottom", "left", "header", "footer")
                }

        hyperlink_targets = []
        for hyperlink in hyperlinks:
            rel_id = _attr(hyperlink, "id")
            relationship = rels.get(rel_id or "", {})
            hyperlink_targets.append(
                {"text": "".join(_texts(hyperlink)), "target": relationship.get("target", "")}
            )

        body_text = []
        for block in _body_blocks(body):
            name = _local(block.tag)
            if name == "p":
                body_text.append(_paragraph_text(block))
            elif name == "tbl":
                inline = " / ".join(
                    " | ".join(
                        "".join(
                            _paragraph_text(paragraph)
                            for paragraph in cell.iter()
                            if _local(paragraph.tag) == "p"
                        )
                        for cell in row
                        if _local(cell.tag) == "tc"
                    )
                    for row in (child for child in block if _local(child.tag) == "tr")
                )
                body_text.append(f"[表格] {inline}")

        header_footer = _header_footer_inventory(archive)
        parts = {
            name: name in names
            for name in (
                "word/styles.xml",
                "word/numbering.xml",
                "word/comments.xml",
                "word/footnotes.xml",
                "word/settings.xml",
                "word/theme/theme1.xml",
            )
        }

        return {
            "file": str(path),
            "size": path.stat().st_size,
            "entry_order": [entry["name"] for entry in entries],
            "entries": entries,
            "parts": parts,
            "document": {
                "body_blocks": [_local(block.tag) for block in _body_blocks(body)],
                "paragraphs": len(paragraphs),
                "runs": len(runs),
                "bold_runs": len(bold_runs),
                "italic_runs": len(italic_runs),
                "underlined_runs": len(underlined_runs),
                "numbered_paragraphs": len(numbered),
                "paragraph_styles": dict(styles),
                "hyperlinks": hyperlink_targets,
                "tables": len(tables),
                "table_rows": len(rows),
                "table_cells": len(cells),
                "table_text": table_text,
                "text": body_text,
            },
            "header_footer": header_footer,
            "page": page,
        }


def diff(before: dict[str, object], after: dict[str, object]) -> dict[str, object]:
    """只比较「保真清单」里与内容/结构有关的项，供实验输出用。"""
    fields = [
        ("parts", ("parts",)),
        ("paragraphs", ("document", "paragraphs")),
        ("runs", ("document", "runs")),
        ("bold_runs", ("document", "bold_runs")),
        ("numbered_paragraphs", ("document", "numbered_paragraphs")),
        ("paragraph_styles", ("document", "paragraph_styles")),
        ("hyperlinks", ("document", "hyperlinks")),
        ("tables", ("document", "tables")),
        ("table_cells", ("document", "table_cells")),
        ("table_text", ("document", "table_text")),
        ("text", ("document", "text")),
        ("headers", ("header_footer", "headers")),
        ("footers", ("header_footer", "footers")),
        ("page", ("page",)),
    ]
    result = {}
    for label, keys in fields:
        before_value: object = before
        after_value: object = after
        for key in keys:
            before_value = before_value[key]  # type: ignore[index]
            after_value = after_value[key]  # type: ignore[index]
        result[label] = {"same": before_value == after_value, "before": before_value, "after": after_value}
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description="docx 保真清单")
    parser.add_argument("files", nargs="*", type=Path)
    parser.add_argument("--diff", nargs=2, metavar=("BEFORE", "AFTER"), type=Path, help="比较两份文档")
    args = parser.parse_args()

    if args.diff:
        print(json.dumps(diff(inventory(args.diff[0]), inventory(args.diff[1])), ensure_ascii=False, indent=2))
        return 0
    if not args.files:
        parser.error("至少给一个文件；或用 --diff BEFORE AFTER 比较两份文档")

    results = [inventory(path) for path in args.files]
    print(json.dumps(results if len(results) > 1 else results[0], ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
