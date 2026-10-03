# -*- coding: utf-8 -*-
"""用本机真实 Microsoft Word（COM）产出一份 DOCX 语料（v3）。

v1：Word **拒绝打开**我们手工拼的 DOCX ⇒ 手工仿真的 OOXML ≠ Word 认的 OOXML。
v2：`Paragraph.ParagraphFormat` 在晚绑定下抛 AttributeError，段落级格式**没生效**
    （我一开始误以为"Word 没写"，靠 dump 原始 XML 才定位到是脚本的问题）。
v3：改用 `Range.ParagraphFormat`（带回退链），并在**保存前从 Word 侧读回**段落格式，
    证明 Word 确实接受了这些设置；正文留一个空尾段，避免插入表格时吃掉正文段。

产物与进程都在仓外。失败如实记录。
"""
import hashlib
import json
import os
import sys
import traceback

WD_ALIGN_CENTER = 1
WD_ALIGN_RIGHT = 2
WD_LINE_SPACE_SINGLE = 0
WD_LINE_SPACE_1PT5 = 1
WD_FORMAT_DOCUMENT_DEFAULT = 16


def digest(p):
    with open(p, "rb") as h:
        return hashlib.sha256(h.read()).hexdigest()


def main(argv):
    product, report_path = argv[1], argv[2]
    report = {"ok": False, "product": os.path.abspath(product), "word": {},
              "authored": [], "readback_from_word": {}, "path_used": None,
              "error": None, "traceback": None}

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
        report["word"]["version"] = str(app.Version)
        report["word"]["build"] = str(app.Build)
        report["word"]["name"] = str(app.Name)

        doc = app.Documents.Add()
        report["path_used"] = "Documents.Add（Word 自建，产物字节 100% 出自 Word）"

        # 末尾多留一个空段，供插入表格（否则插表格会吃掉最后一段正文）
        doc.Content.Text = "年度报告\r第一段正文，首行缩进两个字符。\r（右对齐斜体补充）\r"

        def para_format(index):
            """取某段的 ParagraphFormat；优先 Range.ParagraphFormat，回退 Paragraph.Format。"""
            para = doc.Paragraphs(index)
            for getter in (lambda: para.Range.ParagraphFormat, lambda: para.Format):
                try:
                    return getter()
                except Exception:
                    continue
            raise RuntimeError("无法取到第 %d 段的 ParagraphFormat" % index)

        def author(what, fn):
            try:
                fn()
                report["authored"].append({"change": what, "ok": True})
            except Exception as exc:
                report["authored"].append({"change": what, "ok": False,
                                           "error": "%s: %s" % (type(exc).__name__, exc)})

        def p1():
            rng = doc.Paragraphs(1).Range
            rng.Font.Size = 16
            rng.Font.Bold = True
            rng.Font.NameFarEast = "黑体"
            para_format(1).Alignment = WD_ALIGN_CENTER
        author("P1 16pt+粗体+黑体+居中", p1)

        def p2():
            rng = doc.Paragraphs(2).Range
            rng.Font.Size = 12
            rng.Font.Bold = False
            rng.Font.Italic = False
            rng.Font.NameFarEast = "宋体"
            fmt = para_format(2)
            fmt.LineSpacingRule = WD_LINE_SPACE_1PT5
            fmt.Alignment = 0
            try:
                fmt.CharacterUnitFirstLineIndent = 2
            except Exception:
                fmt.FirstLineIndent = 24.0  # 12pt × 2 字 = 24pt
                raise
        author("P2 12pt+宋体+1.5倍行距+首行缩进2字符+左对齐", p2)

        def p3():
            rng = doc.Paragraphs(3).Range
            rng.Font.Size = 12
            rng.Font.Italic = True
            fmt = para_format(3)
            fmt.LineSpacingRule = WD_LINE_SPACE_SINGLE
            fmt.Alignment = WD_ALIGN_RIGHT
        author("P3 12pt+斜体+单倍行距+右对齐", p3)

        def table():
            rng = doc.Paragraphs(doc.Paragraphs.Count).Range
            tbl = doc.Tables.Add(rng, 2, 2)
            tbl.Borders.Enable = True
            tbl.Cell(1, 1).Range.Text = "指标"
            tbl.Cell(1, 2).Range.Text = "数值"
            tbl.Cell(2, 1).Range.Text = "人数"
            tbl.Cell(2, 2).Range.Text = "8"
        author("表格 2x2 + 边框 + 单元格文本", table)

        def page():
            s = doc.PageSetup
            s.TopMargin = 72.0
            s.BottomMargin = 72.0
            s.LeftMargin = 90.0
            s.RightMargin = 90.0
        author("页面 上下72pt 左右90pt", page)

        # —— 保存前：从 Word 侧读回，证明设置被接受（不是"我以为设上了"）——
        try:
            def view(i):
                fmt = para_format(i)
                return {"alignment": int(fmt.Alignment),
                        "lineSpacingRule": int(fmt.LineSpacingRule),
                        "lineSpacing": float(fmt.LineSpacing),
                        "characterUnitFirstLineIndent": _safe(
                            lambda: float(fmt.CharacterUnitFirstLineIndent)),
                        "firstLineIndent": float(fmt.FirstLineIndent)}
            report["readback_from_word"] = {"p1": view(1), "p2": view(2), "p3": view(3)}
        except Exception as exc:
            report["readback_from_word"] = {"error": "%s: %s" % (type(exc).__name__, exc)}

        doc.SaveAs2(os.path.abspath(product), FileFormat=WD_FORMAT_DOCUMENT_DEFAULT)
        report["word"]["saved_as"] = os.path.abspath(product)
        report["word"]["paragraph_count_after"] = int(doc.Paragraphs.Count)
        report["word"]["table_count"] = int(doc.Tables.Count)
        doc.Close(0)
        doc = None
        report["ok"] = True
    except Exception as exc:
        report["error"] = "%s: %s" % (type(exc).__name__, exc)
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

    if os.path.isfile(product):
        report["product_sha256"] = digest(product)
        report["product_bytes"] = os.path.getsize(product)
    return _finish(report, report_path, 0 if report["ok"] else 1)


def _safe(fn):
    try:
        return fn()
    except Exception:
        return None


def _finish(report, report_path, code):
    with open(report_path, "w", encoding="utf-8") as h:
        json.dump(report, h, ensure_ascii=False, indent=2, sort_keys=True)
    keys = ("ok", "error", "path_used", "word", "readback_from_word",
            "product_sha256", "product_bytes")
    sys.stdout.write(json.dumps({k: report[k] for k in keys if k in report},
                                ensure_ascii=False) + "\n")
    return code


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
