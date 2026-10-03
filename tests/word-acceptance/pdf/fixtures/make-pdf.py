#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""D53 测试夹具：造**真 PDF** / **假 PDF（改扩展名）**，以及确认工具可用。

存在的理由：D53 的编排器测试需要"一个真实排版引擎产出的真 PDF"，但**日常测试不许依赖 Word**。
用 `reportlab`（另一个**真实** PDF 生成器）产真字节即可——被测的是**读回与判据**，
不是"谁排的版"。

用法：

    python make-pdf.py <out.pdf> --mode pdf --pages 3 [--footer-prefix potbot-footer]
    python make-pdf.py <out.pdf> --mode notpdf        # 写一段文本，扩展名却是 .pdf
    python make-pdf.py --check-tools                  # 校验 reportlab + pypdf 是否可用

退出码：0 成功；1 工具缺失或写失败（**显式失败，不 skip**）；2 用法错误。
"""

from __future__ import annotations

import argparse
import json
import os
import sys

FAKE_PNG = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000a49444154789c6360000002000100ffff03000006000557bfabd4000000"
    "0049454e44ae426082"
)


def check_tools() -> int:
    result = {"ok": True, "tools": {}}
    for module in ("reportlab", "pypdf"):
        try:
            imported = __import__(module)
            result["tools"][module] = getattr(imported, "__version__", "?")
        except Exception as exc:
            result["ok"] = False
            result["tools"][module] = "MISSING: %s" % exc
    sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
    return 0 if result["ok"] else 1


def make_pdf(out_path: str, pages: int, footer_prefix: str) -> int:
    try:
        from reportlab.lib.pagesizes import A4  # noqa: PLC0415
        from reportlab.pdfgen import canvas  # noqa: PLC0415
    except Exception as exc:
        sys.stderr.write("reportlab 不可用：%s\n" % exc)
        return 1

    ensure_parent(out_path)
    pdf = canvas.Canvas(out_path, pagesize=A4)
    width, height = A4
    for index in range(1, pages + 1):
        pdf.setFont("Helvetica", 12)
        pdf.drawString(72, height - 72, "D53 fixture body page %d" % index)
        pdf.drawString(72, 40, "%s Page %d of %d" % (footer_prefix, index, pages))
        pdf.showPage()
    pdf.save()
    if not os.path.isfile(out_path) or os.path.getsize(out_path) == 0:
        sys.stderr.write("reportlab 未产出文件\n")
        return 1
    sys.stdout.write("WROTE_PDF %s %d\n" % (os.path.abspath(out_path), os.path.getsize(out_path)))
    return 0


def make_notpdf(out_path: str) -> int:
    """写一段**不是 PDF** 的字节，却用 `.pdf` 扩展名——模拟"改扩展名伪造"。"""
    ensure_parent(out_path)
    with open(out_path, "wb") as handle:
        handle.write(FAKE_PNG)
        handle.write(b"\nTHIS IS NOT A PDF, ONLY RENAMED.\n")
    sys.stdout.write("WROTE_NOTPDF %s %d\n" % (os.path.abspath(out_path), os.path.getsize(out_path)))
    return 0


def ensure_parent(path: str) -> None:
    parent = os.path.dirname(os.path.abspath(path))
    if parent:
        os.makedirs(parent, exist_ok=True)


def main(argv) -> int:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("out", nargs="?")
    parser.add_argument("--mode", choices=("pdf", "notpdf"), default="pdf")
    parser.add_argument("--pages", type=int, default=3)
    parser.add_argument("--footer-prefix", default="potbot-footer")
    parser.add_argument("--check-tools", action="store_true")
    args = parser.parse_args(argv[1:])

    if args.check_tools:
        return check_tools()
    if not args.out:
        sys.stderr.write("用法：make-pdf.py <out.pdf> [--mode pdf|notpdf] [--pages N]\n")
        return 2
    if args.mode == "notpdf":
        return make_notpdf(args.out)
    return make_pdf(args.out, args.pages, args.footer_prefix)


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
