#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""造一份**带真实页脚域**的多页 DOCX 夹具，供 WF-089 的真实引擎导出用例使用。

为什么需要它：本机现有语料（`tests/word-acceptance/fixtures/corpus-*.docx`）**没有页脚**，
而 WF-089 的通过判据里有一条是「读回的**页脚文本与文档一致**」。要证明这一点，
源文档必须真的带 `PAGE` / `NUMPAGES` 域。

**纪律**：

* 只写**域指令**（`fldChar begin → instrText → fldChar end`），**不伪造缓存值**（合同 R158）。
  页码真值由**真实排版引擎**（Word）在导出时算出——这正是要验证的事。
* 用 `python-docx`（独立工具）造夹具，**不 import** potbot 的 DOCX 写出器。

用法：`python make-footer-fixture.py <out.docx> [--sections <n>]`
退出码：0 = 写入成功；2 = 用法错误。
"""

from __future__ import annotations

import argparse
import os
import sys

from docx import Document
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Pt


def add_field(paragraph, instruction: str) -> None:
    """在段落里追加一个**只有域指令、没有缓存**的域（R158 的"directive_only"态）。"""
    run = paragraph.add_run()
    begin = OxmlElement("w:fldChar")
    begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = instruction
    end = OxmlElement("w:fldChar")
    end.set(qn("w:fldCharType"), "end")
    run._r.append(begin)
    run._r.append(instr)
    run._r.append(end)


def build(out_path: str, sections: int) -> None:
    document = Document()

    # 页脚：静态词 + PAGE 域 + 静态词 + NUMPAGES 域 —— 读回时可用一个正则同时核对
    # 「页码递增」与「总页数 == 读回页数」。
    footer = document.sections[0].footer
    footer_paragraph = footer.paragraphs[0]
    footer_paragraph.text = ""
    footer_paragraph.add_run("potbot-footer Page ")
    add_field(footer_paragraph, " PAGE ")
    footer_paragraph.add_run(" of ")
    add_field(footer_paragraph, " NUMPAGES ")

    for index in range(1, sections + 1):
        heading = document.add_heading("D53 章节 %d 标题" % index, level=1)
        for _ in range(1, level_fill(index)):
            document.add_paragraph("D53 正文段落，用于把文档撑到多页，验证分页与页脚一致。")
        for run in heading.runs:
            run.font.size = Pt(16)

    if os.path.dirname(os.path.abspath(out_path)):
        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    document.save(out_path)


def level_fill(index: int) -> int:
    """每节正文段落数（交替，避免每节页数完全一样，让分页更有判别力）。"""
    return 14 if index % 2 == 1 else 20


def main(argv) -> int:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument("out")
    parser.add_argument("--sections", type=int, default=12)
    args = parser.parse_args(argv[1:])
    build(args.out, args.sections)
    sys.stdout.write("WROTE %s\n" % os.path.abspath(args.out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
