#!/usr/bin/env python3
"""experiment_roundtrip.py —— 实验 C：docx → 中间标记 → docx（现有转换链实测）。

PRD 把这条路径写作「docx → Markdown → docx」。应用里真实存在的链路是
**docx → HTML → docx**（`docx_to_html` 提取、`html_to_docx` 生成，即
`docx_extract` / `docx_convert` 两个工具背后的引擎）。两者是同一类路径
（先降维成语义标记、再重新生成），HTML 这一支的表达力**强于** Markdown：
HTML 都保不住的东西，Markdown 只会丢得更多。所以这里实测 HTML 链，
并把结论按「上界」使用。

依赖：引擎的 Python 依赖（python-docx / lxml / beautifulsoup4 / html-for-docx）。
本项目托管 venv 里已具备，直接用它跑：

    ~/.venv-html-to-docx/bin/python tests/fixtures/docx-revision/experiment_roundtrip.py \
      --in a-styles.docx --out-dir /tmp/docx-revision

若引擎依赖缺失，脚本以 2 退出并说明原因 —— 不伪造「理论上会丢」的结论。

用法与自证：
1. 调 `python -m docx_to_html extract`，读它的 `not_restorable` 与 warnings；
2. 调 `python -m html_to_docx convert`，读 warnings；
3. 用 inspect_docx 对原文件与再生成文件做清单 diff，输出「保住 / 丢失」。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from inspect_docx import diff, inventory  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[3]
ENGINE_DIR = REPO_ROOT / "resources" / "docx-engine"


class EngineError(Exception):
    """引擎调用失败：带 stderr，便于定位是依赖缺失还是转换失败。"""


def _run(command: list[str], cwd: Path) -> dict[str, object]:
    environment = os.environ.copy()
    environment["PYTHONPATH"] = os.pathsep.join(
        filter(None, [str(ENGINE_DIR), environment.get("PYTHONPATH", "")])
    )
    process = subprocess.run(
        command,
        cwd=cwd,
        env=environment,
        capture_output=True,
        text=True,
        check=False,
    )
    stdout = process.stdout.strip()
    if process.returncode != 0:
        raise EngineError(
            f"命令失败（退出码 {process.returncode}）：{' '.join(command)}\n"
            f"stderr：{process.stderr.strip() or '（空）'}\n"
            f"stdout：{stdout or '（空）'}"
        )
    lines = [line for line in stdout.splitlines() if line.strip()]
    if not lines:
        raise EngineError(f"命令没有输出 JSON：{' '.join(command)}")
    try:
        return json.loads(lines[-1])
    except json.JSONDecodeError as exc:
        raise EngineError(f"引擎输出不是 JSON：{lines[-1]}\n{exc}") from exc


def html_features(path: Path) -> dict[str, int]:
    text = path.read_text(encoding="utf-8")
    return {
        "h1": len(re.findall(r"<h1\b", text)),
        "h2": len(re.findall(r"<h2\b", text)),
        "paragraph": len(re.findall(r"<p\b", text)),
        "table": len(re.findall(r"<table\b", text)),
        "thead": len(re.findall(r"<thead\b", text)),
        "th": len(re.findall(r"<th\b", text)),
        "li": len(re.findall(r"<li\b", text)),
        "ol": len(re.findall(r"<ol\b", text)),
        "ul": len(re.findall(r"<ul\b", text)),
        "anchor": len(re.findall(r"<a\b", text)),
        "bold": len(re.findall(r"font-weight\s*:\s*(?:bold|[7-9]00)", text)),
    }


def fixed_page_field(path: Path) -> int:
    """数 PAGEREF / PAGE 之类域在输出里留下的痕迹（本实验只关心 PAGE）。"""
    import zipfile
    import xml.etree.ElementTree as ET

    with zipfile.ZipFile(path) as archive:
        count = 0
        for name in archive.namelist():
            if not (name.startswith("word/header") or name.startswith("word/footer")):
                continue
            if not name.endswith(".xml"):
                continue
            root = ET.fromstring(archive.read(name))
            for element in root.iter():
                if element.tag.rsplit("}", 1)[-1] == "fldSimple":
                    for key, value in element.attrib.items():
                        if key.rsplit("}", 1)[-1] == "instr" and value.strip().upper().startswith("PAGE"):
                            count += 1
    return count


def run(source: Path, out_dir: Path, executable: str, json_output: bool) -> dict[str, object]:
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = source.stem
    html_path = out_dir / f"{stem}.roundtrip.html"
    assets_dir = out_dir / f"{stem}.roundtrip_assets"
    regenerated = out_dir / f"{stem}.roundtrip.docx"

    extraction = _run(
        [
            executable,
            "-m",
            "docx_to_html",
            "extract",
            str(source),
            "-o",
            str(html_path),
            "--assets-dir",
            str(assets_dir),
        ],
        out_dir,
    )
    conversion = _run(
        [executable, "-m", "html_to_docx", "convert", str(html_path), "-o", str(regenerated)],
        out_dir,
    )

    before = inventory(source)
    after = inventory(regenerated)
    report = {
        "source": str(source),
        "html": str(html_path),
        "regenerated": str(regenerated),
        "extract": extraction,
        "html_features": html_features(html_path),
        "convert": conversion,
        "inventory_diff": diff(before, after),
        "page_field_in_output": fixed_page_field(regenerated),
    }
    if json_output:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"[roundtrip] {source.name} → {html_path.name} → {regenerated.name}")
        print(f"  提取 not_restorable：{extraction.get('not_restorable') or '（空）'}")
        print(f"  HTML 特征：{report['html_features']}")
        print(f"  生成 warnings：{conversion.get('warnings') or '（空）'}")
        differing = [
            label
            for label, result in report["inventory_diff"].items()  # type: ignore[union-attr]
            if not result["same"]
        ]
        print(f"  清单差异项：{differing or '无'}")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description="docx → HTML → docx 环回实测")
    parser.add_argument("--in", dest="source", required=True, type=Path)
    parser.add_argument("--out-dir", required=True, type=Path)
    parser.add_argument("--python", default=sys.executable, help="跑引擎的解释器（默认当前解释器）")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    if not (ENGINE_DIR / "docx_to_html").is_dir():
        sys.stderr.write(f"找不到引擎目录：{ENGINE_DIR}\n")
        return 2
    try:
        run(args.source, args.out_dir, args.python, args.json)
    except EngineError as exc:
        sys.stderr.write(f"实验 C 未能执行：\n{exc}\n")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
