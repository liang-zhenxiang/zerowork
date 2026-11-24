#!/usr/bin/env python3
"""patch_docx.py —— docx 包内 run 级文本替换引擎（只用 Python 标准库）。

## 它做什么

把一份 `.docx` 里**某个 `w:t` 内的一段文字**替换成新文字，其余 zip 条目原样
（逐字节）写出。定位规则（与 ADR-0001 的 v1 边界一致）：

- 原文必须**完整落在同一个 `w:t` 内**，不做跨 run 拼接、不做模糊匹配；
- 该原文在目标部件里必须**唯一命中**；找不到 / 多处命中 / 跨 run 一律**拒绝**；
- 只改目标 `w:t` 的文本字节，标签、属性（含 `xml:space`）与 run 边界都不动 ——
  因此不会出现「为了改一句话，整份文档被重新排版」。

## 调用契约（单行 JSON + 退出码 0/1）

```bash
python3 patch_docx.py --in a.docx --out b.docx \
  [--part word/document.xml] --find "本季度营收" --replace "本季度营业收入"
```

成功：stdout 一行 JSON，退出码 0：

```json
{"ok":true,"part":"word/document.xml","entries":8,"changed":1,
 "bytes_before":15,"bytes_after":21,"other_entries_unchanged":true}
```

失败：stderr 一行 JSON，退出码 1，且**不创建、不覆盖输出文件**：

```json
{"ok":false,"code":"cross-run","error":"……"}
```

错误码：`bad-input`、`not-docx`、`missing-part`、`not-found`、`multiple-matches`、
`cross-run`、`bad-xml`、`io-error`、`self-check-failed`。

## 安全与保真

- zip 条目顺序、时间戳、压缩方式、权限位（`external_attr`）与 `create_system`
  全部沿用原条目；`[Content_Types].xml`、图片、样式等**完全不经过解析**。
- 先写同目录临时文件 → 在临时文件上做**写后自检**（重新打开、XML 合法、
  目标文本已替换、其余条目 sha256 逐字节一致）→ 最后一步 `os.replace` 原子替换。
  自检失败只删临时文件，原文件与输出文件都不受影响。
- 目标部件用**文本级定向拼接**，不用 ElementTree 重新序列化整个 XML：
  真实 Word 文档根元素常带 `mc:Ignorable` 与大量命名空间声明，朴素重序列化
  可能丢前缀声明。ElementTree 只用于**只读校验**（确认 w:t 结构可安全定位）。

## 关于本目录

`resources/docx-engine/` 是随安装包分发的引擎内容，**不参与本项目的 eslint /
prettier / vitest**（见仓库 `AGENTS.md` 红线 5）。本脚本只依赖标准库，
系统 `python3` 即可运行，不需要托管 venv。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
import zipfile
import zlib
from pathlib import Path
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape

WORD_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
CONTENT_TYPES_ENTRY = "[Content_Types].xml"
DEFAULT_PART = "word/document.xml"
EXIT_OK = 0
EXIT_FAILED = 1


class PatchError(Exception):
    """可诊断的拒绝/失败：调用方据此以非零码退出，且保证不产出半成品。"""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class _ArgumentParser(argparse.ArgumentParser):
    """把 argparse 的「参数错误」也纳入 JSON 契约（默认会直接打印用法并退 2）。"""

    def error(self, message: str) -> None:  # noqa: D401 - argparse 的协议方法
        raise PatchError("bad-input", f"参数错误：{message}")


# ---------------------------------------------------------------------------
# XML 文本级定位
# ---------------------------------------------------------------------------

_NAMESPACE_DECL_RE = (
    r'xmlns(?::([A-Za-z_][\w.-]*))?\s*=\s*["\']' + re.escape(WORD_NS) + r'["\']'
)

# 只解析 XML 里合法的五类实体与数字引用；未知名实体 ET 早已拒绝。
_XML_ENTITY_RE = re.compile(r"&(#[xX][0-9A-Fa-f]+|#[0-9]+|amp|lt|gt|quot|apos);")

# 属性段允许引号内出现 `>`，避免 `[^>]*` 在合法 XML 上提前收尾。
_ATTRS = r"""(?:\s+(?:"[^"]*"|'[^']*'|[^>"'])*)?"""


def _xml_unescape(value: str) -> str:
    """把 XML 文本里的实体还原成纯文本（与 ElementTree 的解析结果对齐）。"""

    def replace(match: re.Match[str]) -> str:
        entity = match.group(1)
        if entity == "amp":
            return "&"
        if entity == "lt":
            return "<"
        if entity == "gt":
            return ">"
        if entity == "quot":
            return '"'
        if entity == "apos":
            return "'"
        if entity[:2] in ("#x", "#X"):
            return chr(int(entity[2:], 16))
        return chr(int(entity[1:]))

    return _XML_ENTITY_RE.sub(replace, value)


def _w_prefixes(xml_text: str) -> list[str]:
    """列出绑定到 WordprocessingML 主命名空间的全部前缀（`""` 表示默认命名空间）。"""
    prefixes: list[str] = []
    for match in re.finditer(_NAMESPACE_DECL_RE, xml_text):
        prefix = match.group(1) or ""
        if prefix not in prefixes:
            prefixes.append(prefix)
    return prefixes


def _w_t_pattern(prefixes: list[str]) -> re.Pattern[str]:
    tag = "(?:" + "|".join(re.escape(f"{prefix}:t" if prefix else "t") for prefix in prefixes) + ")"
    return re.compile(r"<(" + tag + r")" + _ATTRS + r"(?:/>|>(.*?)</\1>)", re.S)


def _element_texts(root: ET.Element) -> list[str]:
    return [element.text or "" for element in root.iter(f"{{{WORD_NS}}}t")]


def _paragraph_texts(root: ET.Element) -> list[str]:
    """按「最近的 w:p 祖先」把 w:t 文本归组，供跨 run 判定使用。"""
    parent = {child: node for node in root.iter() for child in node}
    grouped: dict[ET.Element, list[str]] = {}
    order: list[ET.Element] = []
    for element in root.iter(f"{{{WORD_NS}}}t"):
        node: ET.Element | None = element
        while node is not None and node.tag != f"{{{WORD_NS}}}p":
            node = parent.get(node)
        if node is None:
            continue
        if node not in grouped:
            grouped[node] = []
            order.append(node)
        grouped[node].append(element.text or "")
    return ["".join(grouped[node]) for node in order]


def _parse_xml(xml_bytes: bytes, part: str) -> ET.Element:
    try:
        return ET.fromstring(xml_bytes)
    except ET.ParseError as exc:
        raise PatchError("bad-xml", f"部件 {part} 不是合法的 XML：{exc}") from None


def patch_part(
    part_bytes: bytes, find: str, replace: str, part: str
) -> tuple[bytes, dict[str, int], list[str]]:
    """在目标部件内定位并替换唯一命中的一段文字。

    返回 `(改后的字节, 统计, 替换后的完整 w:t 文本清单)` —— 第三项供写后自检使用，
    避免调用方再按同样的规则推一遍预期值。
    """
    if find == "":
        raise PatchError("bad-input", "要查找的原文不能为空")
    if find == replace:
        raise PatchError("bad-input", "替换前后的文字相同，未做任何改动")

    try:
        xml_text = part_bytes.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise PatchError(
            "bad-xml",
            f"部件 {part} 不是 UTF-8 编码的 XML（偏移 {exc.start}），暂不支持该文档",
        ) from None

    root = _parse_xml(part_bytes, part)
    element_texts = _element_texts(root)

    prefixes = _w_prefixes(xml_text)
    if not prefixes:
        raise PatchError(
            "bad-xml",
            f"部件 {part} 没有声明 WordprocessingML 命名空间（{WORD_NS}），无法定位 w:t",
        )

    matches = list(_w_t_pattern(prefixes).finditer(xml_text))
    if len(matches) != len(element_texts):
        raise PatchError(
            "bad-xml",
            f"部件 {part} 的 w:t 结构无法安全定位"
            f"（XML 解析到 {len(element_texts)} 个，文本扫描到 {len(matches)} 个）",
        )

    for index, match in enumerate(matches):
        scanned = _xml_unescape(match.group(2) or "")
        if scanned != element_texts[index]:
            raise PatchError(
                "bad-xml",
                f"部件 {part} 的第 {index + 1} 个 w:t 含无法安全定位的内容"
                "（可能嵌入了子元素、注释或 CDATA）",
            )

    hits = [(index, text) for index, text in enumerate(element_texts) if find in text]
    total = sum(text.count(find) for _, text in hits)

    if total == 0:
        if any(find in text for text in _paragraph_texts(root)):
            raise PatchError(
                "cross-run",
                f"目标文字在 {part} 中被 Word 拆成了多个 run（跨 w:t）："
                "v1 只支持完整落在一个 run 内的文字，请在 Word 中手动修改这一处后重试。",
            )
        raise PatchError(
            "not-found",
            f"在 {part} 中找不到目标文字：{find!r}（未做任何改动）",
        )
    if total > 1:
        raise PatchError(
            "multiple-matches",
            f"目标文字在 {part} 中出现 {total} 次，无法确定改哪一处；"
            "请给出更长的、能唯一定位的原文（未做任何改动）。",
        )

    target_index, old_text = hits[0]
    offset = old_text.find(find)
    assert offset >= 0  # hits 的构造保证至少出现一次
    new_text = old_text[:offset] + replace + old_text[offset + len(find):]

    match = matches[target_index]
    start, end = match.span(2)
    raw_inner = match.group(2) or ""
    if raw_inner == escape(old_text):
        # 原文本是规范转义：只动命中的那一段，其余字节保持不变。
        new_inner = (
            escape(old_text[:offset])
            + escape(replace)
            + escape(old_text[offset + len(find):])
        )
    else:
        # 原文本用了数字字符引用等非规范转义：整段 w:t 文本重新转义，
        # 文本语义不变，且仍然只改目标部件这一个条目的这几个字节。
        new_inner = escape(new_text)

    if _xml_unescape(new_inner) != new_text:
        raise PatchError(
            "self-check-failed",
            f"内部校验失败：{part} 第 {target_index + 1} 个 w:t 的替换结果与预期不一致",
        )

    patched = (xml_text[:start] + new_inner + xml_text[end:]).encode("utf-8")

    expected_texts = list(element_texts)
    expected_texts[target_index] = new_text
    patched_texts = _element_texts(_parse_xml(patched, part))
    if patched_texts != expected_texts:
        raise PatchError(
            "self-check-failed",
            f"内部校验失败：替换后 {part} 的文本与预期不一致（未写入任何文件）",
        )

    return patched, {
        "bytes_before": len(find.encode("utf-8")),
        "bytes_after": len(replace.encode("utf-8")),
    }, expected_texts


# ---------------------------------------------------------------------------
# zip 保真读写与写后自检
# ---------------------------------------------------------------------------

def _entry_metadata(info: zipfile.ZipInfo) -> tuple[object, ...]:
    return (
        info.filename,
        info.date_time,
        info.compress_type,
        info.external_attr,
        info.create_system,
        info.comment,
    )


def _cleanup(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:
        pass


def _read_source_part(source: Path, part: str) -> bytes:
    if not source.is_file():
        raise PatchError("io-error", f"输入文件不存在或不是普通文件：{source}")
    try:
        with zipfile.ZipFile(source, "r") as archive:
            names = archive.namelist()
            if CONTENT_TYPES_ENTRY not in names:
                raise PatchError(
                    "not-docx",
                    f"{source} 缺少 {CONTENT_TYPES_ENTRY}，不是有效的 .docx 包"
                    "（老格式 .doc 请先另存为 .docx；加密文档请先解除加密）。",
                )
            if part not in names:
                raise PatchError(
                    "missing-part",
                    f"{source} 里没有部件 {part}；请确认目标文字所在的部件（正文是 "
                    f"{DEFAULT_PART}，页眉页脚是 word/header*.xml / word/footer*.xml）。",
                )
            return archive.read(part)
    except zipfile.BadZipFile as exc:
        raise PatchError(
            "not-docx",
            f"{source} 不是有效的 zip / .docx 包：{exc}"
            "（老格式 .doc 请先另存为 .docx；加密文档请先解除加密）。",
        ) from None
    except RuntimeError as exc:
        # zipfile 在条目被加密时抛 RuntimeError("File ... is encrypted")。
        raise PatchError(
            "not-docx",
            f"{source} 的条目无法读取：{exc}（加密文档请先解除加密）。",
        ) from None
    except NotImplementedError as exc:
        raise PatchError("not-docx", f"{source} 使用了不支持的压缩方式：{exc}") from None
    except zlib.error as exc:
        raise PatchError("not-docx", f"{source} 的条目数据已损坏：{exc}") from None


def _verify_temp(
    path: Path,
    part: str,
    patched_part: bytes,
    expected_texts: list[str],
    metadata: list[tuple[object, ...]],
    original_sha: dict[str, str],
    source_comment: bytes,
) -> None:
    """在临时文件上做写后自检；任何一项不成立都抛 self-check-failed。"""
    try:
        with zipfile.ZipFile(path, "r") as archive:
            infos = archive.infolist()
            if [item.filename for item in infos] != [item[0] for item in metadata]:
                raise PatchError("self-check-failed", "写后自检失败：zip 条目顺序与原文件不一致")
            if [_entry_metadata(item) for item in infos] != metadata:
                raise PatchError(
                    "self-check-failed",
                    "写后自检失败：条目元数据（时间戳 / 压缩方式 / 权限位）未保留",
                )
            if archive.comment != source_comment:
                raise PatchError("self-check-failed", "写后自检失败：zip 注释未保留")

            for info in infos:
                data = archive.read(info)
                if info.filename == part:
                    if data != patched_part:
                        raise PatchError(
                            "self-check-failed",
                            f"写后自检失败：{part} 的实际写入内容与预期不一致",
                        )
                    try:
                        actual_texts = _element_texts(ET.fromstring(data))
                    except ET.ParseError as exc:
                        raise PatchError(
                            "self-check-failed",
                            f"写后自检失败：{part} 写入后不是合法 XML：{exc}",
                        ) from None
                    if actual_texts != expected_texts:
                        raise PatchError(
                            "self-check-failed",
                            f"写后自检失败：{part} 的文本内容与预期不一致",
                        )
                else:
                    digest = hashlib.sha256(data).hexdigest()
                    if original_sha.get(info.filename) != digest:
                        raise PatchError(
                            "self-check-failed",
                            f"写后自检失败：条目 {info.filename} 与原文件不是逐字节一致",
                        )
    except zipfile.BadZipFile as exc:
        raise PatchError(
            "self-check-failed",
            f"写后自检失败：输出的包无法重新打开：{exc}",
        ) from None


def write_patched(
    source: Path,
    target: Path,
    part: str,
    patched_part: bytes,
    expected_texts: list[str],
) -> int:
    """按原条目顺序重打包；自检通过后才原子替换，返回条目数。"""
    try:
        target.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise PatchError("io-error", f"无法创建输出目录 {target.parent}：{exc}") from None

    handle, temp_name = tempfile.mkstemp(
        prefix=f".{target.name}.", suffix=".tmp", dir=str(target.parent)
    )
    os.close(handle)
    temp_path = Path(temp_name)

    try:
        # 目标文件的权限位沿用源文件（mkstemp 默认 0600；共享文档不该因为一次
        # 修订就变成仅属主可写）。Windows 上 chmod 只影响只读位，失败无害。
        try:
            os.chmod(temp_path, source.stat().st_mode & 0o777)
        except OSError:
            pass
        with zipfile.ZipFile(source, "r") as archive:
            infos = archive.infolist()
            metadata = [_entry_metadata(info) for info in infos]
            source_comment = archive.comment
            original_sha: dict[str, str] = {}
            with zipfile.ZipFile(temp_path, "w") as output:
                output.comment = source_comment
                for info in infos:
                    data = patched_part if info.filename == part else archive.read(info)
                    if info.filename != part:
                        original_sha[info.filename] = hashlib.sha256(data).hexdigest()
                    output.writestr(info, data)

        _verify_temp(
            temp_path,
            part,
            patched_part,
            expected_texts,
            metadata,
            original_sha,
            source_comment,
        )
        os.replace(temp_path, target)
    except PatchError:
        _cleanup(temp_path)
        raise
    except zipfile.BadZipFile as exc:
        _cleanup(temp_path)
        raise PatchError(
            "io-error",
            f"重新打包时无法读取 {source}：{exc}（原文件未改动）",
        ) from None
    except (RuntimeError, NotImplementedError, zlib.error) as exc:
        _cleanup(temp_path)
        raise PatchError(
            "io-error",
            f"重新打包失败：{exc}（原文件未改动）",
        ) from None
    except OSError as exc:
        _cleanup(temp_path)
        hint = (
            "；文件可能正被其它程序打开，关闭 Word / WPS 后重试"
            if isinstance(exc, PermissionError)
            else ""
        )
        raise PatchError("io-error", f"写入 {target} 失败：{exc}{hint}（原文件未改动）") from None

    return len(infos)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _write_json_line(stream: object, payload: dict[str, object]) -> None:
    line = json.dumps(payload, ensure_ascii=False) + "\n"
    buffer = getattr(stream, "buffer", None)
    if buffer is None:
        stream.write(line)  # type: ignore[attr-defined]
        stream.flush()  # type: ignore[attr-defined]
        return
    buffer.write(line.encode("utf-8"))
    buffer.flush()


def _fail(exc: PatchError) -> int:
    _write_json_line(sys.stderr, {"ok": False, "code": exc.code, "error": exc.message})
    return EXIT_FAILED


def build_parser() -> argparse.ArgumentParser:
    parser = _ArgumentParser(
        description="docx 包内 run 级文本替换（只改目标 w:t，其余条目逐字节保留）",
        add_help=True,
    )
    parser.add_argument("--in", dest="source", required=True, help="输入 .docx 路径")
    parser.add_argument("--out", dest="target", required=True, help="输出 .docx 路径（可覆盖）")
    parser.add_argument(
        "--part",
        default=DEFAULT_PART,
        help=f"要修补的部件（默认 {DEFAULT_PART}；页眉页脚用 word/header1.xml 等）",
    )
    parser.add_argument("--find", required=True, help="要替换的原文（必须唯一命中且落在单个 w:t 内）")
    parser.add_argument("--replace", required=True, help="替换后的文字（允许为空字符串）")
    return parser


def main(argv: list[str] | None = None) -> int:
    try:
        args = build_parser().parse_args(argv)
        part = args.part
        if not isinstance(part, str) or part.strip() == "":
            raise PatchError("bad-input", "部件名不能为空")

        source = Path(args.source)
        target = Path(args.target)
        part_bytes = _read_source_part(source, part)
        patched, stats, expected_texts = patch_part(
            part_bytes, args.find, args.replace, part
        )
        entries = write_patched(source, target, part, patched, expected_texts)
    except PatchError as exc:
        return _fail(exc)
    except OSError as exc:
        return _fail(PatchError("io-error", f"读写失败：{exc}"))
    except Exception as exc:  # noqa: BLE001 - 契约要求任何失败都是可解析的 JSON
        return _fail(
            PatchError(
                "io-error",
                f"未预期的内部错误（请反馈）：{type(exc).__name__}: {exc}",
            )
        )

    _write_json_line(
        sys.stdout,
        {
            "ok": True,
            "part": part,
            "entries": entries,
            "changed": 1,
            "bytes_before": stats["bytes_before"],
            "bytes_after": stats["bytes_after"],
            "other_entries_unchanged": True,
        },
    )
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
