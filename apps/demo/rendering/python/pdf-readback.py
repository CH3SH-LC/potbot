#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""**独立** PDF 读回器（pypdf）—— 不 import 生产实现，不复用生成器自报数据。

对应 design-05 **WF-089** 的验收面：导出产物必须被**读回**（存在、非空、是 PDF 魔数、页数、
页脚文本），凭据来自**独立工具**而非导出器自己。

用法：

    python pdf-readback.py <file.pdf> [--report <report.json>] [--max-pages <n>]

输出**永远是单行 JSON**（`ensure_ascii=False` 以便中文可读；调用方按 UTF-8 解码）：
`{ok, path, bytes, sha256, magic, magic_ok, pdf_version, page_count, encrypted, pages:[{page,text}],
  text_truncated, tool, error:{code,message}|null}`

退出码：
* **0** = 读回成功（`magic_ok` 为假也算"读回成功但**不是** PDF"，由调用方判定）；
* **1** = 读回失败（`error.code` 机器可判：`file_missing` / `read_error`）；
* **2** = 用法错误；
* **3** = **工具缺失**（没装 pypdf）——**显式失败，绝不 skip 计通过**（合同纪律）。

（`not_a_pdf` 不作为退出码：那不是"读回失败"，而是"读回成功、结论是不像 PDF"，
调用方据此判失败——两者不能混为一谈。）
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys

PAGE_TEXT_LIMIT = 2000


def digest(path: str) -> str:
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def build_report(path: str, max_pages: int) -> tuple[int, dict]:
    report = {
        "ok": False,
        "path": os.path.abspath(path),
        "bytes": None,
        "sha256": None,
        "magic": None,
        "magic_ok": False,
        "pdf_version": None,
        "page_count": None,
        "encrypted": None,
        "pages": [],
        "text_truncated": False,
        "tool": "pypdf",
        "error": None,
    }

    if not os.path.isfile(path):
        report["error"] = {"code": "file_missing", "message": "文件不存在：%s" % path}
        return 1, report

    report["bytes"] = os.path.getsize(path)
    report["sha256"] = digest(path)
    with open(path, "rb") as handle:
        head = handle.read(8)
    report["magic"] = head.decode("latin-1")
    report["magic_ok"] = head.startswith(b"%PDF-")
    if report["magic_ok"] and len(head) >= 8:
        report["pdf_version"] = head[5:8].decode("latin-1", "replace")

    try:
        import pypdf  # noqa: PLC0415
    except Exception as exc:
        report["error"] = {"code": "tool_missing",
                           "message": "pypdf 不可用，无法独立读回 PDF：%s" % exc}
        return 3, report

    report["tool"] = "pypdf %s" % getattr(pypdf, "__version__", "?")

    try:
        reader = pypdf.PdfReader(path)
        report["encrypted"] = bool(reader.is_encrypted)
        report["page_count"] = len(reader.pages)
        limit = report["page_count"] if max_pages <= 0 else min(max_pages, report["page_count"])
        for index in range(limit):
            text = reader.pages[index].extract_text() or ""
            if len(text) > PAGE_TEXT_LIMIT:
                text = text[:PAGE_TEXT_LIMIT]
                report["text_truncated"] = True
            report["pages"].append({"page": index + 1, "text": text})
    except Exception as exc:
        report["error"] = {"code": "read_error",
                           "message": "%s: %s" % (type(exc).__name__, exc)}
        return 1, report

    report["ok"] = True
    return 0, report


def main(argv) -> int:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("path")
    parser.add_argument("--report", default=None)
    parser.add_argument("--max-pages", type=int, default=0)
    args = parser.parse_args(argv[1:])

    code, report = build_report(args.path, args.max_pages)
    if args.report:
        with open(args.report, "w", encoding="utf-8") as handle:
            json.dump(report, handle, ensure_ascii=False, indent=2, sort_keys=True)
    sys.stdout.write(json.dumps(report, ensure_ascii=False) + "\n")
    return code


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
