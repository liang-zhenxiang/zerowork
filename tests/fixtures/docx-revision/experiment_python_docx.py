#!/usr/bin/env python3
"""experiment_python_docx.py —— 实验 B：python-docx 环回保存与全量重建。

两种做法，对应两个不同的问题：

- `resave`：`Document(path)` 打开后原样 `save()`。回答「python-docx 会不会
  顺手改坏别的东西」——它重写**所有** XML 部件，所以条目逐字节一致是不可能的，
  要看的是**语义清单**有没有变。
- `rebuild`：把内容读出来，用一个全新的 `Document()` 重建。这是「python-docx
  全量重建」路径的真实成本：能重建多少，取决于你愿意为每种特性重写多少代码。
  本脚本实现的是**尽力而为**的版本（保留段落样式名、run 级粗斜下划线、表格
  单元格文字、页眉页脚文字、页面尺寸与页边距），**刻意不**重建编号定义、
  超链接关系、表格底纹与列宽、页脚的 PAGE 域 —— 这些正是全量重建的缺口。

依赖：python-docx（本项目托管 venv 里已有：`~/.venv-html-to-docx/bin/python`）。
没有该依赖时脚本以 2 退出并说明如何跑，不假装成功。

用法：

    ~/.venv-html-to-docx/bin/python tests/fixtures/docx-revision/experiment_python_docx.py \
      --in a-styles.docx --out-dir /tmp/docx-revision
"""
from __future__ import annotations

import argparse
import json
import sys
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from inspect_docx import diff, inventory  # noqa: E402


def _require_python_docx():
    try:
        import docx  # noqa: F401
        from docx import Document
    except ImportError:
        sys.stderr.write(
            "本实验需要 python-docx。本项目的托管 venv 已带该依赖，可这样跑：\n"
            "  ~/.venv-html-to-docx/bin/python tests/fixtures/docx-revision/experiment_python_docx.py ...\n"
            "若该 venv 不存在，请先在应用「设置 → 内置运行时」安装 docx 引擎后再跑。\n"
        )
        raise SystemExit(2)
    return Document


def resave(source: Path, target: Path, Document) -> None:  # noqa: N803 - 与库名一致
    Document(str(source)).save(str(target))


def rebuild(source: Path, target: Path, Document) -> dict[str, object]:
    """尽力而为的全量重建；返回过程中如实记下的降级点。"""
    source_document = Document(str(source))
    output = Document()
    notes: list[str] = []
    missing_styles: set[str] = set()

    from docx.table import Table
    from docx.text.hyperlink import Hyperlink
    from docx.text.run import Run

    body = source_document.element.body
    for child in body.iterchildren():
        name = child.tag.rsplit("}", 1)[-1]
        if name == "p":
            from docx.text.paragraph import Paragraph

            paragraph = Paragraph(child, source_document)
            style_name = paragraph.style.name if paragraph.style is not None else None
            try:
                target_paragraph = output.add_paragraph(style=style_name)
            except (KeyError, ValueError):
                missing_styles.add(style_name or "(none)")
                target_paragraph = output.add_paragraph()
            for item in paragraph.iter_inner_content():
                if isinstance(item, Run):
                    run = target_paragraph.add_run(item.text)
                    run.bold = item.bold
                    run.italic = item.italic
                    run.underline = item.underline
                elif isinstance(item, Hyperlink):
                    # 超链接退化：只留文字，不重建关系与样式。
                    target_paragraph.add_run(item.text)
                    notes.append("超链接退化为纯文本")
        elif name == "tbl":
            table = Table(child, source_document)
            target_table = output.add_table(rows=len(table.rows), cols=len(table.columns))
            try:
                target_table.style = "Table Grid"
            except (KeyError, ValueError):
                notes.append("表格样式 Table Grid 不可用")
            for row_index, row in enumerate(table.rows):
                for column_index, cell in enumerate(row.cells):
                    target_table.cell(row_index, column_index).text = cell.text
            notes.append("表格只保留文字与网格：列宽、底纹、表头重复标记未重建")

    source_sections = source_document.sections
    if source_sections:
        source_section = source_sections[0]
        target_section = output.sections[0]
        target_section.page_width = source_section.page_width
        target_section.page_height = source_section.page_height
        target_section.top_margin = source_section.top_margin
        target_section.bottom_margin = source_section.bottom_margin
        target_section.left_margin = source_section.left_margin
        target_section.right_margin = source_section.right_margin
        for source_paragraph in source_section.header.paragraphs:
            if source_paragraph.text:
                target_section.header.paragraphs[0].text = source_paragraph.text
                notes.append("页眉文字已复制，样式未重建")
                break
        footer_text = "".join(paragraph.text for paragraph in source_section.footer.paragraphs)
        if footer_text:
            target_section.footer.paragraphs[0].text = footer_text
            notes.append("页脚退化为纯文字：PAGE 域未重建（python-docx 无域 API）")

    if missing_styles:
        notes.append(f"新模板里没有这些样式，已降级为默认样式：{sorted(missing_styles)}")

    output.save(str(target))
    return {"notes": sorted(set(notes))}


def changed_entries(source: Path, target: Path) -> dict[str, object]:
    with zipfile.ZipFile(source) as before, zipfile.ZipFile(target) as after:
        before_names = before.namelist()
        after_names = after.namelist()
        changed = [
            name
            for name in after_names
            if name not in before_names or before.read(name) != after.read(name)
        ]
        return {
            "source_entries": len(before_names),
            "target_entries": len(after_names),
            "entries_identical": len(after_names) - len(changed),
            "entries_changed": changed,
            "missing_parts": [name for name in before_names if name not in after_names],
            "added_parts": [name for name in after_names if name not in before_names],
        }


def run(source: Path, out_dir: Path, Document, json_output: bool) -> dict[str, object]:
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = source.stem
    resaved = out_dir / f"{stem}.resaved.docx"
    rebuilt = out_dir / f"{stem}.rebuilt.docx"
    resave(source, resaved, Document)
    notes = rebuild(source, rebuilt, Document)

    before = inventory(source)
    report = {
        "source": str(source),
        "resave": {
            "path": str(resaved),
            "package": changed_entries(source, resaved),
            "inventory_diff": diff(before, inventory(resaved)),
        },
        "rebuild": {
            "path": str(rebuilt),
            "package": changed_entries(source, rebuilt),
            "inventory_diff": diff(before, inventory(rebuilt)),
            "result": notes,
        },
    }
    if json_output:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        for mode in ("resave", "rebuild"):
            section = report[mode]
            print(f"[{mode}] {source.name} → {Path(section['path']).name}")
            differing = [
                label
                for label, result in section["inventory_diff"].items()  # type: ignore[union-attr]
                if not result["same"]
            ]
            print(f"  清单差异项：{differing or '无'}")
            print(
                f"  条目：源 {section['package']['source_entries']}，"
                f"输出 {section['package']['target_entries']}，"
                f"逐字节一致 {section['package']['entries_identical']}"
            )
            for note in section["result"]["notes"] if mode == "rebuild" else []:
                print(f"  · {note}")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="python-docx 环回保存与全量重建实验")
    parser.add_argument("--in", dest="source", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    Document = _require_python_docx()
    run(args.source, args.out_dir, Document, args.json)
    return 0


if __name__ == "__main__":
    sys.exit(main())
