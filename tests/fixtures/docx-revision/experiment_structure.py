#!/usr/bin/env python3
"""experiment_structure.py —— 实验 A2：结构编辑（插入 / 删除段落）的代价（stdlib）。

只改文字（实验 A）与改结构是两件事。本脚本用 ElementTree 直接改
`word/document.xml`，验证：

1. **包级完整性**：除目标部件外，其余条目仍逐字节一致；
2. **结构确实变了**：段落数 / 正文文本按预期增减；
3. **代价值得说清**：ElementTree 会把**整个 document.xml 重新序列化**，
   与实验 A 的「15 字节替换」不是一个量级的改动面。真实 Word 文档的根元素
   往往带 `mc:Ignorable="w14 wp14"` 与十几个命名空间前缀，朴素重序列化可能
   丢掉未使用的前缀声明（本夹具只带 w/r，不会暴露这一点，所以这条限制是
   **代码审查结论**，并在 ADR 里明确标出）。

用法：

    python3 tests/fixtures/docx-revision/experiment_structure.py \
      --in a-styles.docx --out-dir /tmp/docx-revision
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from inspect_docx import diff, inventory  # noqa: E402

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
DOCUMENT_ENTRY = "word/document.xml"

ET.register_namespace("w", W_NS)
ET.register_namespace("r", R_NS)


def _w(tag: str) -> str:
    return f"{{{W_NS}}}{tag}"


class StructureError(Exception):
    """可诊断的失败：不产出文件。"""


def _body(root: ET.Element) -> ET.Element:
    body = next((child for child in root if child.tag == _w("body")), None)
    if body is None:
        raise StructureError("document.xml 没有 w:body")
    return body


def _paragraph_text(paragraph: ET.Element) -> str:
    return "".join(
        child.text or "" for child in paragraph.iter() if child.tag == _w("t")
    )


def _make_paragraph(text: str, style: str = "Normal") -> ET.Element:
    paragraph = ET.Element(_w("p"))
    properties = ET.SubElement(paragraph, _w("pPr"))
    pstyle = ET.SubElement(properties, _w("pStyle"))
    pstyle.set(_w("val"), style)
    run = ET.SubElement(paragraph, _w("r"))
    text_node = ET.SubElement(run, _w("t"))
    text_node.text = text
    text_node.set("{http://www.w3.org/XML/1998/namespace}space", "preserve")
    return paragraph


def insert_paragraph(root: ET.Element, text: str) -> None:
    body = _body(root)
    paragraph = _make_paragraph(text)
    sect_pr_index = next(
        (index for index, child in enumerate(body) if child.tag == _w("sectPr")), None
    )
    if sect_pr_index is None:
        body.append(paragraph)
    else:
        body.insert(sect_pr_index, paragraph)


def delete_paragraph(root: ET.Element, text: str) -> None:
    body = _body(root)
    matches = [
        child
        for child in body
        if child.tag == _w("p") and _paragraph_text(child) == text
    ]
    if not matches:
        raise StructureError(f"找不到正文为 {text!r} 的段落（未做任何改动）")
    if len(matches) > 1:
        raise StructureError(f"正文为 {text!r} 的段落有 {len(matches)} 个，无法确定删哪一个")
    body.remove(matches[0])


def rewrite_part(source: Path, target: Path, transform) -> dict[str, object]:
    with zipfile.ZipFile(source) as archive:
        infos = archive.infolist()
        originals = {info.filename: archive.read(info.filename) for info in infos}
    if DOCUMENT_ENTRY not in originals:
        raise StructureError(f"{source} 缺少 {DOCUMENT_ENTRY}")

    original_xml = originals[DOCUMENT_ENTRY]
    root = ET.fromstring(original_xml)
    transform(root)
    serialized = ET.tostring(root, encoding="utf-8", xml_declaration=True)
    ET.fromstring(serialized)

    target.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(prefix=target.name + ".", suffix=".tmp", dir=target.parent)
    os.close(handle)
    temp_path = Path(temp_name)
    try:
        with zipfile.ZipFile(temp_path, "w") as out:
            for info in infos:
                data = serialized if info.filename == DOCUMENT_ENTRY else originals[info.filename]
                out.writestr(info, data)
        os.replace(temp_path, target)
    except BaseException:
        temp_path.unlink(missing_ok=True)
        raise

    with zipfile.ZipFile(target) as archive:
        written = archive.infolist()
        changed = [
            info.filename
            for info in written
            if archive.read(info.filename) != originals[info.filename]
        ]
        order_same = [info.filename for info in written] == [info.filename for info in infos]

    return {
        "changed_entries": changed,
        "entry_order_preserved": order_same,
        "document_xml_bytes_before": len(original_xml),
        "document_xml_bytes_after": len(serialized),
        "document_xml_rewritten_entirely": len(changed) == 1 and changed[0] == DOCUMENT_ENTRY,
    }


def verify(path: Path) -> dict[str, object]:
    try:
        from docx import Document  # type: ignore[import-not-found]
    except ImportError:
        return {"available": False, "reason": "当前解释器没有 python-docx"}
    try:
        document = Document(str(path))
    except Exception as exc:  # noqa: BLE001 - 打不开本身就是结论
        return {"available": True, "opened": False, "error": str(exc)}
    return {
        "available": True,
        "opened": True,
        "paragraphs": [paragraph.text for paragraph in document.paragraphs],
    }


def run(source: Path, out_dir: Path, json_output: bool) -> dict[str, object]:
    out_dir.mkdir(parents=True, exist_ok=True)
    inserted = out_dir / f"{source.stem}.inserted.docx"
    deleted = out_dir / f"{source.stem}.deleted.docx"
    before = inventory(source)

    insert_report = rewrite_part(
        source, inserted, lambda root: insert_paragraph(root, "补充：数据以审计后版本为准。")
    )
    delete_report = rewrite_part(
        source, deleted, lambda root: delete_paragraph(root, "以上数据未经审计。")
    )

    report = {
        "source": str(source),
        "insert": {
            "path": str(inserted),
            "package": insert_report,
            "inventory_diff": diff(before, inventory(inserted)),
            "python_docx": verify(inserted),
        },
        "delete": {
            "path": str(deleted),
            "package": delete_report,
            "inventory_diff": diff(before, inventory(deleted)),
            "python_docx": verify(deleted),
        },
    }
    if json_output:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        for mode in ("insert", "delete"):
            section = report[mode]
            print(f"[{mode}] {source.name} → {Path(section['path']).name}")
            print(f"  改动条目：{section['package']['changed_entries']}")
            print(
                f"  document.xml 字节：{section['package']['document_xml_bytes_before']}"
                f" → {section['package']['document_xml_bytes_after']}"
            )
            differing = [
                label
                for label, result in section["inventory_diff"].items()  # type: ignore[union-attr]
                if not result["same"]
            ]
            print(f"  清单差异项：{differing or '无'}")
            opened = section["python_docx"]
            print(f"  python-docx 打开：{opened.get('opened')}")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="docx 结构编辑实验：插入 / 删除段落")
    parser.add_argument("--in", dest="source", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        run(args.source, args.out_dir, args.json)
    except StructureError as exc:
        sys.stderr.write(f"拒绝执行：{exc}\n")
        return 1
    except (OSError, zipfile.BadZipFile, ET.ParseError) as exc:
        sys.stderr.write(f"失败：{type(exc).__name__}: {exc}\n")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
