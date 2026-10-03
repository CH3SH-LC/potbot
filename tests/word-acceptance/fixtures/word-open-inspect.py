#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""用真实 Microsoft Word（COM）打开一份 DOCX，读回格式，再 `SaveAs2` 另存。

用途：验证 **potbot 自产的 DOCX 能不能被真实 Word 打开**，以及 Word 往返之后格式还在不在。
（合同 R155 的四件事——「能打开」「格式正确」「独立读回通过」「目标软件验证通过」——本工具
只负责产出前两件事的原始读数，后两件由调用方分别判定，不得混为一谈。）

运行：`python tests/word-acceptance/fixtures/word-open-inspect.py <in.docx> <roundtrip.docx> <report.json>`

纪律：

* **只打开 `%TEMP%` 下的副本**——仓内文件一个字节都不让 Word 碰，也不留锁文件；
* 打开失败**如实记录错误码与原文**（Word 拒绝打开时给的是 24601 一类的 `com_error`）；
* 不做"应该没问题"的推断：读不出来的字段就报 `runs_error`，不猜。

方法与踩过的坑（别重复踩）：

* `Paragraph.ParagraphFormat` 与 `Range.Runs` 在**晚绑定**下都会抛
  `AttributeError: <unknown>.<name>`。所以段落格式走 `Range.ParagraphFormat` / `Paragraph.Format`，
  run 级格式走 **`Range.Characters` 逐字符读 `Font`，再把格式相同的连续字符合并成 run**。
* Word 的 `app.Quit()` 不可靠（实测三次里两次 `WINWORD.EXE` 仍在）。调用方负责 `taskkill /F` 兜底。
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
import traceback

WD_FORMAT_DOCUMENT_DEFAULT = 16
ALIGN_NAMES = {0: "left", 1: "center", 2: "right", 3: "justify", 4: "distribute"}
LINE_RULE_NAMES = {0: "single", 1: "oneAndHalf", 2: "double", 3: "atLeast",
                   4: "exactly", 5: "multiple"}
WD_UNDEFINED = 9999999
SKIP_CHARS = ("\r", "\x07", "")


def digest(path: str) -> str:
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def num(value):
    """COM 数值 → JSON 友好值；`wdUndefined` 明确标出，不静默变成 0。

    **保留小数**：`Font.Size` 可以是 10.5pt，`LineSpacing` 可以是 13.9pt。早先版本先 `int()`
    再返回，把 10.5 读成 10 —— 那会伪造出"字号不符"的假差异。别再用 `int()` 截。
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return bool(value)
    try:
        fvalue = float(value)
    except Exception:
        return str(value)
    if int(fvalue) == WD_UNDEFINED:
        return "wdUndefined(9999999)"
    return round(fvalue, 4)


def flag(value):
    """COM 布尔 → True/False/None；`wdUndefined`（选区混合）原样标出。

    COM 的 True 是 **-1**、False 是 0，不是 Python 的 `True`/`False`，
    所以不能拿 `value is True` 去比。
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return bool(value)
    try:
        ivalue = int(value)
    except Exception:
        return str(value)
    if ivalue == WD_UNDEFINED:
        return "wdUndefined(9999999)"
    return bool(ivalue)


def _safe(fn):
    try:
        return fn()
    except Exception:
        return None


def read_runs(paragraph) -> list:
    """把段落拆成「连续同格式」的 run；依据是每个字符的 `Font`（晚绑定安全）。"""
    chars = paragraph.Range.Characters
    groups: list = []
    for index in range(1, int(chars.Count) + 1):
        char = chars(index)
        text = str(char.Text)
        if text in SKIP_CHARS:
            continue
        font = char.Font
        key = (flag(font.Bold), flag(font.Italic), num(font.Size),
               str(font.NameFarEast), str(font.NameAscii))
        if groups and groups[-1][0] == key:
            groups[-1][1] += text
        else:
            groups.append([key, text])
    return [{"text": text, "bold": key[0], "italic": key[1], "size_pt": key[2],
             "name_far_east": key[3], "name_ascii": key[4],
             "method": "Range.Characters + Font（连续同格式合并）"}
            for key, text in groups]


def inspect(source: str, roundtrip: str, report_path: str) -> int:
    report = {"ok": False, "opened": False, "source": os.path.abspath(source),
              "source_sha256": digest(source), "source_bytes": os.path.getsize(source),
              "word": {}, "error": None, "error_code": None, "traceback": None,
              "document": {}, "roundtrip": {}}

    try:
        import win32com.client as wc
    except Exception as exc:
        report["error"] = "pywin32 不可用：%s" % exc
        return _finish(report, report_path, 1)

    app = None
    doc = None
    try:
        app = wc.DispatchEx("Word.Application")
        app.Visible = False
        app.DisplayAlerts = 0
        report["word"] = {"name": str(app.Name), "version": str(app.Version),
                          "build": str(app.Build)}

        doc = app.Documents.Open(os.path.abspath(source), ReadOnly=False,
                                 AddToRecentFiles=False, ConfirmConversions=False,
                                 Revert=True)
        report["opened"] = True

        report["document"]["paragraph_count"] = int(doc.Paragraphs.Count)
        report["document"]["table_count"] = int(doc.Tables.Count)
        report["document"]["section_count"] = int(doc.Sections.Count)

        paragraphs = []
        for index in range(1, int(doc.Paragraphs.Count) + 1):
            paragraph = doc.Paragraphs(index)
            try:
                fmt = paragraph.Range.ParagraphFormat
            except Exception:
                fmt = paragraph.Format
            entry = {
                "index": index - 1,
                "text": str(paragraph.Range.Text).replace("\r", "").replace("\x07", ""),
                "alignment": num(fmt.Alignment),
                "alignment_name": ALIGN_NAMES.get(int(fmt.Alignment), "?"),
                "line_spacing_rule": num(fmt.LineSpacingRule),
                "line_spacing_rule_name": LINE_RULE_NAMES.get(int(fmt.LineSpacingRule), "?"),
                "line_spacing": num(fmt.LineSpacing),
                "character_unit_first_line_indent": num(
                    _safe(lambda: fmt.CharacterUnitFirstLineIndent)),
                "first_line_indent": num(fmt.FirstLineIndent),
                "left_indent": num(fmt.LeftIndent),
                "space_before": num(fmt.SpaceBefore),
                "space_after": num(fmt.SpaceAfter),
                "runs": [],
            }
            try:
                entry["runs"] = read_runs(paragraph)
            except Exception as exc:
                entry["runs_error"] = "%s: %s" % (type(exc).__name__, exc)
            paragraphs.append(entry)
        report["document"]["paragraphs"] = paragraphs

        tables = []
        for tindex in range(1, int(doc.Tables.Count) + 1):
            table = doc.Tables(tindex)
            cells = []
            for row_index in range(1, int(table.Rows.Count) + 1):
                row = []
                for col_index in range(1, int(table.Columns.Count) + 1):
                    try:
                        row.append(str(table.Cell(row_index, col_index).Range.Text)
                                   .replace("\r", "").replace("\x07", ""))
                    except Exception:
                        row.append(None)
                cells.append(row)
            tables.append({"rows": int(table.Rows.Count),
                           "columns": int(table.Columns.Count),
                           "cell_texts": cells})
        report["document"]["tables"] = tables

        doc.SaveAs2(os.path.abspath(roundtrip), FileFormat=WD_FORMAT_DOCUMENT_DEFAULT)
        report["roundtrip"]["path"] = os.path.abspath(roundtrip)
        doc.Close(0)
        doc = None
        report["ok"] = True
    except Exception as exc:
        report["error"] = "%s: %s" % (type(exc).__name__, exc)
        try:
            report["error_code"] = str(exc.args[0])
            report["error_args"] = repr(exc.args)
        except Exception:
            pass
        report["traceback"] = traceback.format_exc()
    finally:
        if doc is not None:
            try:
                doc.Close(0)
            except Exception:
                pass
        if app is not None:
            try:
                app.Quit(0)
            except Exception:
                pass

    if os.path.isfile(roundtrip):
        report["roundtrip"]["sha256"] = digest(roundtrip)
        report["roundtrip"]["bytes"] = os.path.getsize(roundtrip)
    return _finish(report, report_path, 0 if report["ok"] else 1)


def _finish(report: dict, report_path: str, code: int) -> int:
    with open(report_path, "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2, sort_keys=True)
    keys = ("ok", "opened", "error", "word", "roundtrip")
    sys.stdout.write(json.dumps({key: report.get(key) for key in keys},
                                ensure_ascii=False) + "\n")
    return code


def main(argv) -> int:
    if len(argv) != 4:
        sys.stderr.write("用法：word-open-inspect.py <in.docx> <roundtrip.docx> <report.json>\n")
        return 2
    return inspect(argv[1], argv[2], argv[3])


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
