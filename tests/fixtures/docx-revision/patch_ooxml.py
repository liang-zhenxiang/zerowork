#!/usr/bin/env python3
"""patch_ooxml.py —— 实验 A：OOXML 包内 run 级文本修补（只用 python3 标准库）。

做法：只替换 `word/document.xml` 里**一个** `w:t` 的文本内容，其余 zip 条目
原样写出（保留条目顺序、时间戳与压缩方式），然后自证三件事：

1. 除 `word/document.xml` 外，所有条目**逐字节一致**；
2. 改后的 `word/document.xml` 仍是合法 XML，且结构特征（样式、编号、超链接、
   表格、页眉页脚）与改前一致 —— 用 inspect_docx 的清单做 diff；
3. 失败路径**不产出半成品**：找不到目标文本 / 目标文本不唯一时以非零码退出，
   输出文件不会被创建或覆盖（先写临时文件，最后一步原子替换）。

用法：

    python3 tests/fixtures/docx-revision/patch_ooxml.py \
      --in a-styles.docx --out a-patched.docx --find 本季度营收 --replace 本季度营业收入

    页眉里的文字在另一个部件里，用 --part 指明：

    python3 .../patch_ooxml.py --in b.docx --out b-patched.docx \
      --part word/header1.xml --find "内部资料 · 仅供评审" --replace "内部资料（已修订）"

    # 失败路径演示：目标不存在
    python3 tests/fixtures/docx-revision/patch_ooxml.py \
      --in a-styles.docx --out never.docx --find 不存在的文本 --replace x
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path
from xml.sax.saxutils import escape

sys.path.insert(0, str(Path(__file__).resolve().parent))

from inspect_docx import diff, inventory  # noqa: E402

DOCUMENT_ENTRY = "word/document.xml"


class PatchError(Exception):
    """可诊断的失败：调用方据此以非零码退出，且不产出文件。"""


def _pattern(text: str) -> re.Pattern[str]:
    """匹配 `<w:t ...>text</w:t>`，只捕获开闭标签，便于只替换文本。"""
    return re.compile(
        r"(<w:t(?:\s[^>]*)?>)" + re.escape(escape(text)) + r"(</w:t>)"
    )


def patch_document_xml(
    xml_bytes: bytes, find: str, replace: str, part: str = DOCUMENT_ENTRY
) -> tuple[bytes, dict[str, object]]:
    xml_text = xml_bytes.decode("utf-8")
    pattern = _pattern(find)
    matches = list(pattern.finditer(xml_text))
    if not matches:
        raise PatchError(f"{part} 里找不到文本：{find!r}（未做任何改动）")
    if len(matches) > 1:
        raise PatchError(
            f"文本 {find!r} 在 {part} 中出现 {len(matches)} 次，无法确定改哪一处；"
            "本实验只允许唯一命中"
        )

    match = matches[0]
    patched_text = pattern.sub(lambda m: m.group(1) + escape(replace) + m.group(2), xml_text, count=1)
    patched = patched_text.encode("utf-8")

    # 自证「只有这段字节变了」：算出目标文本在文件里的字节区间，
    # 断言改后文件恰好等于「区间前 + 新文本 + 区间后」，且原区间正是旧文本。
    old_segment = escape(find).encode("utf-8")
    new_segment = escape(replace).encode("utf-8")
    start = len(xml_text[: match.end(1)].encode("utf-8"))
    end = len(xml_text[: match.start(2)].encode("utf-8"))
    if xml_bytes[start:end] != old_segment:
        raise PatchError(
            "内部校验失败：匹配到的区间与原文本不一致"
            f"（{xml_bytes[start:end]!r} != {old_segment!r}）"
        )
    expected = xml_bytes[:start] + new_segment + xml_bytes[end:]
    if patched != expected:
        raise PatchError("内部校验失败：除目标文本外还有其它字节被改动")

    ET.fromstring(patched)  # 改后必须仍是合法 XML
    return patched, {
        "offset": start,
        "bytes_removed": len(old_segment),
        "bytes_inserted": len(new_segment),
        "document_xml_size_before": len(xml_bytes),
        "document_xml_size_after": len(patched),
    }


def write_patched(source: Path, target: Path, patched_xml: bytes, part: str) -> dict[str, object]:
    """按原条目顺序重新打包；先写临时文件再原子替换。"""
    with zipfile.ZipFile(source) as archive:
        infos = archive.infolist()
        originals = {info.filename: archive.read(info.filename) for info in infos}

    target.parent.mkdir(parents=True, exist_ok=True)
    handle, temp_name = tempfile.mkstemp(prefix=target.name + ".", suffix=".tmp", dir=target.parent)
    os.close(handle)
    temp_path = Path(temp_name)
    try:
        with zipfile.ZipFile(temp_path, "w") as out:
            for info in infos:
                data = patched_xml if info.filename == part else originals[info.filename]
                out.writestr(info, data)
        os.replace(temp_path, target)
    except BaseException:
        temp_path.unlink(missing_ok=True)
        raise

    with zipfile.ZipFile(target) as archive:
        written = archive.infolist()
        written_order = [info.filename for info in written]
        source_order = [info.filename for info in infos]
        changed = [
            info.filename
            for info in written
            if archive.read(info.filename) != originals[info.filename]
        ]
        metadata_same = all(
            (info.date_time, info.compress_type, info.external_attr)
            == (source_info.date_time, source_info.compress_type, source_info.external_attr)
            for info, source_info in zip(written, infos)
        )

    return {
        "entries": len(written_order),
        "entry_order_preserved": written_order == source_order,
        "changed_entries": changed,
        "unchanged_entries": len(written_order) - len(changed),
        "entry_metadata_preserved": metadata_same,
        "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
    }


def verify_with_python_docx(path: Path) -> dict[str, object]:
    """可选：用 python-docx 真正打开一次（本机没有该依赖时如实记录，不算失败）。"""
    try:
        from docx import Document  # type: ignore[import-not-found]
    except ImportError:
        return {"available": False, "reason": "当前解释器没有 python-docx（stdlib 实验不受影响）"}
    try:
        document = Document(str(path))
    except Exception as exc:  # noqa: BLE001 - 打开失败本身就是结论
        return {"available": True, "opened": False, "error": str(exc)}
    return {
        "available": True,
        "opened": True,
        "paragraphs": [paragraph.text for paragraph in document.paragraphs],
        "tables": len(document.tables),
        "headers": len(document.sections[0].header.paragraphs) if document.sections else 0,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="docx 包内 run 级文本修补实验")
    parser.add_argument("--in", dest="source", required=True, type=Path)
    parser.add_argument("--out", dest="target", required=True, type=Path)
    parser.add_argument("--find", required=True, help="要替换的完整 run 文本")
    parser.add_argument("--replace", required=True, help="替换后的文本")
    parser.add_argument(
        "--part",
        default=DOCUMENT_ENTRY,
        help="要修补的部件（默认 word/document.xml；页眉页脚用 word/header1.xml 等）",
    )
    parser.add_argument("--json", action="store_true", help="以 JSON 输出报告")
    args = parser.parse_args()

    try:
        with zipfile.ZipFile(args.source) as archive:
            if args.part not in archive.namelist():
                raise PatchError(f"{args.source} 缺少 {args.part}（不是有效的 docx 部件）")
            original_xml = archive.read(args.part)
        patched_xml, change = patch_document_xml(original_xml, args.find, args.replace, args.part)
        before = inventory(args.source)
        package = write_patched(args.source, args.target, patched_xml, args.part)
        after = inventory(args.target)
    except PatchError as exc:
        sys.stderr.write(f"拒绝执行：{exc}\n")
        return 1
    except (OSError, zipfile.BadZipFile, ET.ParseError) as exc:
        sys.stderr.write(f"失败：{type(exc).__name__}: {exc}\n")
        return 1

    report = {
        "source": str(args.source),
        "target": str(args.target),
        "change": {"find": args.find, "replace": args.replace, **change},
        "package": package,
        "inventory_diff": diff(before, after),
        "python_docx": verify_with_python_docx(args.target),
    }
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"修补成功：{args.source} → {args.target}")
        print(
            f"  {args.part} 偏移 {change['offset']}，"
            f"删除 {change['bytes_removed']} 字节、写入 {change['bytes_inserted']} 字节"
        )
        print(f"  条目 {package['entries']} 个，改动条目：{package['changed_entries']}")
        print(
            f"  其余 {package['unchanged_entries']} 个条目逐字节一致："
            f"{package['unchanged_entries'] == package['entries'] - len(package['changed_entries'])}"
        )
        differing = [
            label
            for label, result in report["inventory_diff"].items()  # type: ignore[union-attr]
            if not result["same"]
        ]
        print(f"  清单差异项：{differing or '无'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
