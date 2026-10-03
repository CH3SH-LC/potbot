#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""构建 WCF-D10 的独立语料 fixture（**只依赖 Python 标准库**）。

运行：`python tests/word-acceptance/fixtures/build-corpus.py`

产出（写入本目录，随后**随仓冻结**）：

* `corpus-a-independent-deflate.docx` —— 中文报告风，DEFLATE 压缩，手工拼 OOXML；
* `corpus-b-independent-deflate.docx` —— 中文公文风，DEFLATE 压缩，手工拼 OOXML；
* `legacy-golden-potbot-store.docx` —— **FREEZE-6 时期 potbot 生成器自产**的旧 golden 样本
  的**逐字节副本**（ZIP_STORED），用于兼容回归；
* `expectations/*.json` —— 三份预期文件（`--expect` 的输入）。

## 纪律（不要违反）

1. **不得重跑本脚本去"刷新" fixture 来让红测试变绿。** 期望文件里的 `sha256` 是冻结基线；
   一旦回归，应当修实现或改判据，而不是重新生成样本。本脚本只在**有意变更判据**时重跑，
   且必须在 PROVENANCE.md 里记下变更原因与新摘要。
2. **预期值不是从生成文件反推的**：`corpus-a` / `corpus-b` 的语义期望（12pt、2 字缩进、
   1.5 倍行距……）是**按 OOXML 规范手写声明**的常量；读回器再按规范独立复算成原始属性。
   唯一"派生"的值是文件 `sha256`（按定义就该等于文件本身的摘要）。
   `legacy-golden` 的期望是**冻结回归基线**——它逐字记录旧产物的当前读回结果，
   这是 golden 的本意，且其来源摘要被钉死在 FREEZE-6 的原始部件上（见 PROVENANCE.md）。
3. `corpus-a` 的内容与 `scripts/demo/verify-docx.py --self-test` 内部合成样本同源
   （`corpus_parts()`），保证"工具自检"与"真实 fixture 读回"不会各说各话。
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
VERIFIER = os.path.join(REPO_ROOT, "scripts", "demo", "verify-docx.py")

LEGACY_SOURCE = os.path.join(
    REPO_ROOT,
    "docs", "other", "evidence", "FREEZE-6", "products", "j1-j3-real-files-h8",
    "T1", "r1", "document", "art-9efb77a7dad8cf05d289865447f96e75.docx",
)

XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
REL_BASE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"


def _load_verifier():
    spec = importlib.util.spec_from_file_location("verify_docx_tool", VERIFIER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# corpus B：中文公文风（与 corpus A 内容不同，用于避免"只测一份"）
# ---------------------------------------------------------------------------

CORPUS_B_DOCUMENT = (
    XML_DECL
    + '<w:document xmlns:w="%s"><w:body>' % W_NS
    + '<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="center"/>'
      '<w:outlineLvl w:val="0"/></w:pPr>'
      '<w:r><w:rPr><w:b/>'
      '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="黑体" '
      'w:cs="Times New Roman"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>'
      '<w:t>关于规范文档格式的通知</w:t></w:r></w:p>'
    + '<w:p><w:pPr><w:pStyle w:val="Normal"/>'
      '<w:spacing w:line="360" w:lineRule="atLeast" w:before="0" w:after="240"/>'
      '<w:ind w:firstLineChars="200" w:firstLine="480"/></w:pPr>'
      '<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" '
      'w:eastAsia="仿宋" w:cs="Times New Roman"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>'
      '<w:t>各科室：为进一步规范格式，现将有关事项通知如下。</w:t></w:r></w:p>'
    + '<w:p><w:pPr><w:jc w:val="right"/><w:spacing w:line="240" w:lineRule="auto"/>'
      '<w:ind w:hangingChars="200" w:hanging="480" w:leftChars="100" w:left="240"/></w:pPr>'
      '<w:r><w:rPr><w:i/><w:u w:val="double"/><w:sz w:val="21"/></w:rPr>'
      '<w:t>（此件公开发布）</w:t></w:r></w:p>'
    + '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>'
      '<w:jc w:val="center"/><w:tblLayout w:type="fixed"/></w:tblPr>'
      '<w:tblGrid><w:gridCol w:w="1200"/><w:gridCol w:w="2400"/><w:gridCol w:w="1200"/></w:tblGrid>'
      '<w:tr><w:tc><w:p><w:r><w:t>序号</w:t></w:r></w:p></w:tc>'
      '<w:tc><w:p><w:r><w:t>事项</w:t></w:r></w:p></w:tc>'
      '<w:tc><w:p><w:r><w:t>负责</w:t></w:r></w:p></w:tc></w:tr>'
      '<w:tr><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc>'
      '<w:tc><w:p><w:r><w:t>字体字号</w:t></w:r></w:p></w:tc>'
      '<w:tc><w:p><w:r><w:t>办公室</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    + '<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>'
      '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1701" w:gutter="0"/>'
      '<w:cols w:num="1"/></w:sectPr>'
    + '</w:body></w:document>'
)

CORPUS_B_STYLES = (
    XML_DECL
    + '<w:styles xmlns:w="%s">' % W_NS
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/>'
      '<w:rPr><w:rFonts w:eastAsia="仿宋"/><w:sz w:val="28"/></w:rPr></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>'
      '<w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>'
    + '</w:styles>'
)

CORPUS_B_DOC_RELS = (
    XML_DECL
    + '<Relationships xmlns="%s">' % REL_NS
    + '<Relationship Id="rId10" Type="%s/styles" Target="styles.xml"/>' % REL_BASE
    + '<Relationship Id="rId11" Type="%s/image" Target="media/image1.png"/>' % REL_BASE
    + '</Relationships>'
)

CORPUS_B_CONTENT_TYPES = (
    XML_DECL
    + '<Types xmlns="%s">' % CT_NS
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Default Extension="png" ContentType="image/png"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-'
      'officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-'
      'officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/docProps/custom.xml" ContentType="application/vnd.openxmlformats-'
      'officedocument.custom-properties+xml"/>'
    + '</Types>'
)

CORPUS_B_PACKAGE_RELS = (
    XML_DECL
    + '<Relationships xmlns="%s">' % REL_NS
    + '<Relationship Id="rId1" Type="%s/officeDocument" Target="word/document.xml"/>' % REL_BASE
    + '<Relationship Id="rId2" Type="%s/custom-properties" Target="docProps/custom.xml"/>' % REL_BASE
    + '</Relationships>'
)

# 注意：**不含** PotbotDocumentPresentation 属性——它是一份"未知部件"，不是呈现版本标记。
CORPUS_B_CUSTOM = (
    XML_DECL
    + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" '
      'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
      '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="DepartmentCode">'
      '<vt:lpwstr>OFFICE-2026</vt:lpwstr></property></Properties>'
)

CORPUS_PNG = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x02\x00\x00\x00\x02\x08\x06"


def corpus_b_parts():
    return [
        ("[Content_Types].xml", CORPUS_B_CONTENT_TYPES.encode("utf-8")),
        ("_rels/.rels", CORPUS_B_PACKAGE_RELS.encode("utf-8")),
        ("word/document.xml", CORPUS_B_DOCUMENT.encode("utf-8")),
        ("word/_rels/document.xml.rels", CORPUS_B_DOC_RELS.encode("utf-8")),
        ("word/styles.xml", CORPUS_B_STYLES.encode("utf-8")),
        ("word/media/image1.png", CORPUS_PNG),
        ("docProps/custom.xml", CORPUS_B_CUSTOM.encode("utf-8")),
    ]


def corpus_b_expectation():
    """**手写**语义期望（按 OOXML 规范声明语义量，原始属性交给读回器独立复算）。"""
    return {
        "label": "corpus-b-gongwen",
        "required_parts": sorted(name for name, _ in corpus_b_parts()),
        "deflate_parts": ["word/document.xml"],
        "content_types": {
            "/word/document.xml": "application/vnd.openxmlformats-officedocument."
                                  "wordprocessingml.document.main+xml",
            "/word/styles.xml": "application/vnd.openxmlformats-officedocument."
                                "wordprocessingml.styles+xml",
            "/docProps/custom.xml": "application/vnd.openxmlformats-officedocument."
                                    "custom-properties+xml",
            "word/media/image1.png": "image/png",
        },
        "relationships": [
            {"owner_part_path": None, "id": "rId1", "type": REL_BASE + "/officeDocument",
             "target": "word/document.xml", "target_mode": "Internal"},
            {"owner_part_path": None, "id": "rId2", "type": REL_BASE + "/custom-properties",
             "target": "docProps/custom.xml", "target_mode": "Internal"},
            {"owner_part_path": "word/document.xml", "id": "rId10", "type": REL_BASE + "/styles",
             "target": "styles.xml", "target_mode": "Internal"},
            {"owner_part_path": "word/document.xml", "id": "rId11", "type": REL_BASE + "/image",
             "target": "media/image1.png", "target_mode": "Internal"},
        ],
        # 3 个正文段落 + 表格 2 行 × 3 格 = 6 个单元格段落
        "paragraph_count": 9,
        "sections": [{
            "page_size": {"w": 16838, "h": 11906, "orient": "landscape"},
            "margins": {"top": 1134, "right": 1134, "bottom": 1134, "left": 1701, "gutter": 0},
            "columns": 1,
        }],
        "paragraphs": [
            {
                "index": 0,
                "text": "关于规范文档格式的通知",
                "style": "Heading1",
                "align": "center",
                "outline_level": 0,
                "runs": [{
                    "text": "关于规范文档格式的通知",
                    "bold": True,
                    "italic": None,
                    "underline": None,
                    "size_pt": 16,
                    "fonts": {"ascii": "Times New Roman", "eastAsia": "黑体",
                              "cs": "Times New Roman"},
                    "highlight": None,
                    "shading": None,
                }],
            },
            {
                "index": 1,
                "text": "各科室：为进一步规范格式，现将有关事项通知如下。",
                "style": "Normal",
                # 最小 18pt → 按规范复算 w:line=360 w:lineRule="atLeast"
                "line_spacing": {"at_least_pt": 18},
                "after_pt": 12,
                "indent": {"first_line_chars": 2},
                "runs": [{
                    "text": "各科室：为进一步规范格式，现将有关事项通知如下。",
                    "size_pt": 14,
                    "fonts": {"ascii": "Times New Roman", "eastAsia": "仿宋"},
                }],
            },
            {
                "index": 2,
                "text": "（此件公开发布）",
                "align": "right",
                "line_spacing": {"multiple": 1.0},
                "indent": {"hanging_chars": 2, "left_chars": 1},
                "runs": [{
                    "text": "（此件公开发布）",
                    "italic": True,
                    "underline": "double",
                    "size_pt": 10.5,
                }],
            },
        ],
        "tables": [{
            "grid": [1200, 2400, 1200],
            "cell_texts": [["序号", "事项", "负责"], ["1", "字体字号", "办公室"]],
        }],
    }


# ---------------------------------------------------------------------------
# corpus C：**由本机真实 Microsoft Word 保存出来**的 DOCX（WCF-D06 发现本机装有 Word）
# ---------------------------------------------------------------------------

#: 冻结产物（**不由本脚本重新生成**——它需要 Word，而 Word 不是可依赖的构建前提）。
WORD_CORPUS_FILENAME = "corpus-c-word16-created.docx"
#: 该产物的冻结摘要；本脚本只**校验**它没被改动，绝不重写。
WORD_CORPUS_SHA256 = "6b2c2e142faa7a563a8ec142f1389107445bed8162567713f1903bfaa4481026"

#: 产出它的 Word 身份与授权状态（合同 R156：**Word 通过只记 Word 通过**）。
WORD_IDENTITY = {
    "product": "Microsoft Word",
    "version": "16.0",
    "build": "16.0.20430",
    "exe": "C:/Program Files/Microsoft Office/root/Office16/WINWORD.EXE",
    "how_saved": "COM 自动化：Documents.Add() 建文档 → Range.Font / Range.ParagraphFormat "
                 "授权格式 → SaveAs2(FileFormat=wdFormatDocumentDefault=16)",
    "authoring_script": "tests/word-acceptance/fixtures/word-author-corpus-c.py",
    "licensing": "本机处于**未授权**状态但功能可用；授权持续性不可依赖。"
                 "Word 在本任务中只是**取证工具**，不是产品依赖。",
    "scope_of_claim": "只声明「Microsoft Word 16.0.20430 通过」。**未**在 WPS、"
                      "**未**在手机端、**未**在 Word 其他版本上验证（R156）。",
}

WORD_CORPUS_PARTS = [
    "[Content_Types].xml",
    "_rels/.rels",
    "docProps/app.xml",
    "docProps/core.xml",
    "word/_rels/document.xml.rels",
    "word/document.xml",
    "word/fontTable.xml",
    "word/settings.xml",
    "word/styles.xml",
    "word/theme/theme1.xml",
    "word/webSettings.xml",
]


def corpus_c_expectation():
    """corpus-c 的期望：格式值**按我让 Word 做的语义手写**（R128 换算），不是从产物反推。

    若 Word 写出来的东西与我声明的语义不符，判据就该红——那是发现，不是把期望改过去。
    """
    return {
        "label": "corpus-c-word16-created (real Microsoft Word)",
        "word": WORD_IDENTITY,
        "required_parts": sorted(WORD_CORPUS_PARTS),
        "deflate_parts": sorted(WORD_CORPUS_PARTS),
        # Word 自己的包里每个部件的有效内容类型（按 OOXML 规范声明，由判据去核）
        "content_types": {
            "/word/document.xml": "application/vnd.openxmlformats-officedocument."
                                  "wordprocessingml.document.main+xml",
            "/word/styles.xml": "application/vnd.openxmlformats-officedocument."
                                "wordprocessingml.styles+xml",
            "/word/settings.xml": "application/vnd.openxmlformats-officedocument."
                                  "wordprocessingml.settings+xml",
            "/word/webSettings.xml": "application/vnd.openxmlformats-officedocument."
                                     "wordprocessingml.webSettings+xml",
            "/word/fontTable.xml": "application/vnd.openxmlformats-officedocument."
                                   "wordprocessingml.fontTable+xml",
            "/word/theme/theme1.xml": "application/vnd.openxmlformats-officedocument.theme+xml",
            "/docProps/core.xml": "application/vnd.openxmlformats-package.core-properties+xml",
            "/docProps/app.xml": "application/vnd.openxmlformats-officedocument."
                                 "extended-properties+xml",
        },
        "relationships": [
            # 包级
            {"owner_part_path": None, "id": "rId1", "type": REL_BASE + "/officeDocument",
             "target": "word/document.xml", "target_mode": "Internal"},
            {"owner_part_path": None, "id": "rId2",
             "type": "http://schemas.openxmlformats.org/package/2006/relationships/"
                     "metadata/core-properties",
             "target": "docProps/core.xml", "target_mode": "Internal"},
            {"owner_part_path": None, "id": "rId3", "type": REL_BASE + "/extended-properties",
             "target": "docProps/app.xml", "target_mode": "Internal"},
            # word/document.xml 的关系（Word 的 rId 分配，不许无映射重排——R106）
            {"owner_part_path": "word/document.xml", "id": "rId1", "type": REL_BASE + "/styles",
             "target": "styles.xml", "target_mode": "Internal"},
            {"owner_part_path": "word/document.xml", "id": "rId2", "type": REL_BASE + "/settings",
             "target": "settings.xml", "target_mode": "Internal"},
            {"owner_part_path": "word/document.xml", "id": "rId3",
             "type": REL_BASE + "/webSettings", "target": "webSettings.xml",
             "target_mode": "Internal"},
            {"owner_part_path": "word/document.xml", "id": "rId4", "type": REL_BASE + "/fontTable",
             "target": "fontTable.xml", "target_mode": "Internal"},
            {"owner_part_path": "word/document.xml", "id": "rId5", "type": REL_BASE + "/theme",
             "target": "theme/theme1.xml", "target_mode": "Internal"},
        ],
        # 3 个正文段 + 表格 2×2 的 4 个单元格段 + 1 个尾部空段
        "paragraph_count": 8,
        "sections": [{
            "page_size": {"w": 11906, "h": 16838},
            "margins": {"top": 1440, "right": 1800, "bottom": 1440, "left": 1800, "gutter": 0},
        }],
        "paragraphs": [
            {
                "index": 0,
                "text": "年度报告",
                "align": "center",              # Word: <w:jc w:val="center"/>
                "runs": [{
                    "text": "年度报告",
                    "bold": True,               # Word: <w:b/>
                    "italic": None,             # Word 没写 <w:i/> ⇒ 未指定，不是显式关闭
                    "size_pt": 16,              # R128：16pt → w:sz=32（半点值）
                    "fonts": {"eastAsia": "黑体"},
                }],
            },
            {
                "index": 1,
                "text": "第一段正文，首行缩进两个字符。",
                "line_spacing": {"multiple": 1.5},   # R128：1.5 倍 → line=360 lineRule=auto
                "indent": {"first_line_chars": 2,    # R130：字符量走 w:firstLineChars=200
                           "first_line_twips": 480}, # 同元素上另有一个**长度量** w:firstLine
                "runs": [{
                    "text": "第一段正文，首行缩进两个字符。",
                    "bold": None,               # Word 没写 <w:b/>
                    "size_pt": 12,              # R128：12pt → w:sz=24
                    "fonts": {"eastAsia": "宋体"},
                }],
            },
            {
                "index": 2,
                "text": "（右对齐斜体补充）",
                "align": "right",
                "line_spacing": {"multiple": 1.0},   # 单倍 → line=240 lineRule=auto
                "runs": [{
                    "text": "（右对齐斜体补充）",
                    "italic": True,             # Word: <w:i/>
                    "size_pt": 12,
                }],
            },
        ],
        "tables": [{
            "grid": [4153, 4153],
            "cell_texts": [["指标", "数值"], ["人数", "8"]],
        }],
    }


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------

def _write_json(path, payload):
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")


def _digest(path):
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def main(argv):
    tool = _load_verifier()
    fixtures_dir = HERE
    expectations_dir = os.path.join(HERE, "expectations")
    os.makedirs(expectations_dir, exist_ok=True)

    manifest = {"generated": [], "notes": []}

    # --- corpus A：与工具自检样本同源 -------------------------------------
    corpus_a = os.path.join(fixtures_dir, "corpus-a-independent-deflate.docx")
    tool.write_parts(corpus_a, tool.corpus_parts())
    expectation_a = tool.corpus_expectation()
    expectation_a["sha256"] = _digest(corpus_a)
    _write_json(os.path.join(expectations_dir, "corpus-a.json"), expectation_a)
    manifest["generated"].append({"fixture": os.path.basename(corpus_a),
                                  "sha256": expectation_a["sha256"],
                                  "builder": "verify-docx.corpus_parts (WCF-D10 自有)"})

    # --- corpus B：独立内容 ------------------------------------------------
    corpus_b = os.path.join(fixtures_dir, "corpus-b-independent-deflate.docx")
    tool.write_parts(corpus_b, corpus_b_parts())
    expectation_b = corpus_b_expectation()
    expectation_b["sha256"] = _digest(corpus_b)
    _write_json(os.path.join(expectations_dir, "corpus-b.json"), expectation_b)
    manifest["generated"].append({"fixture": os.path.basename(corpus_b),
                                  "sha256": expectation_b["sha256"],
                                  "builder": "build-corpus.py corpus_b_parts (WCF-D10 自有)"})

    # --- corpus C：真实 Word 产物（**只校验摘要，绝不重生成**） -------------
    corpus_c = os.path.join(fixtures_dir, WORD_CORPUS_FILENAME)
    if not os.path.isfile(corpus_c):
        sys.stderr.write(
            "缺少真实 Word 语料 %s。它必须由装有 Word 的机器跑 "
            "fixtures/word-author-corpus-c.py 产出后复制进来（本脚本不会替你生成）。\n"
            % corpus_c)
        return 1
    corpus_c_digest = _digest(corpus_c)
    if corpus_c_digest != WORD_CORPUS_SHA256:
        sys.stderr.write(
            "真实 Word 语料摘要不符：登记 %s，实际 %s。\n"
            "**不要**把登记值改成实际值来让测试变绿——先查语料是不是被改动或需重新取证。\n"
            % (WORD_CORPUS_SHA256, corpus_c_digest))
        return 1
    expectation_c = corpus_c_expectation()
    expectation_c["sha256"] = corpus_c_digest
    _write_json(os.path.join(expectations_dir, "corpus-c.json"), expectation_c)
    manifest["generated"].append({
        "fixture": WORD_CORPUS_FILENAME,
        "sha256": corpus_c_digest,
        "builder": "本机 Microsoft Word %s (build %s) 经 COM 保存"
                   % (WORD_IDENTITY["version"], WORD_IDENTITY["build"]),
        "regenerated_by_this_script": False,
    })

    # --- legacy golden：FREEZE-6 自产旧样本逐字节副本 ----------------------
    if not os.path.isfile(LEGACY_SOURCE):
        sys.stderr.write("找不到 FREEZE-6 旧 golden 样本：%s\n" % LEGACY_SOURCE)
        return 1
    legacy = os.path.join(fixtures_dir, "legacy-golden-potbot-store.docx")
    shutil.copyfile(LEGACY_SOURCE, legacy)
    source_digest = _digest(LEGACY_SOURCE)
    copy_digest = _digest(legacy)
    if source_digest != copy_digest:
        sys.stderr.write("旧 golden 副本与原件不一致\n")
        return 1

    # 冻结回归基线：记录**当前**读回结果。注意——这是 golden 的本意（记录既有行为），
    # 因此与 corpus A/B 的"手写语义期望"性质不同，见本文件顶部纪律第 2 条。
    legacy_readback = tool.verify(legacy)
    if not legacy_readback["ok"]:
        sys.stderr.write("旧 golden 样本未通过基础读回，不应作为基线：%s\n"
                         % legacy_readback["error"])
        return 1
    expectation_legacy = {
        "label": "legacy-golden-potbot-store (frozen regression baseline)",
        "sha256": copy_digest,
        "source": {
            "path": os.path.relpath(LEGACY_SOURCE, REPO_ROOT).replace("\\", "/"),
            "sha256": source_digest,
        },
        "required_parts": legacy_readback["parts"],
        "deflate_parts": [],
        # 旧产物也有包级关系（rId1 → word/document.xml）；这一条让兼容回归同样覆盖"关系可解析"。
        "relationships": [
            {"owner_part_path": None, "id": "rId1", "type": REL_BASE + "/officeDocument",
             "target": "word/document.xml", "target_mode": "Internal"},
        ],
        "paragraph_count": len(legacy_readback["format"]["paragraphs"]),
        "paragraphs": [
            {"index": item["index"], "text": item["text"]}
            for item in legacy_readback["format"]["paragraphs"]
        ],
        "sections": [{"page_size": {"w": 11906, "h": 16838}}],
        "tables": [],
    }
    _write_json(os.path.join(expectations_dir, "legacy-golden.json"), expectation_legacy)
    manifest["generated"].append({
        "fixture": os.path.basename(legacy),
        "sha256": copy_digest,
        "origin": expectation_legacy["source"]["path"],
        "origin_sha256": source_digest,
        "compression": "store (ZIP_STORED)",
    })
    manifest["notes"].append(
        "legacy-golden 的期望是**冻结回归基线**（记录旧产物既有读回结果），不是手写规范期望。")

    # 自检：四份 fixture 都必须通过各自的期望判据
    for name, fixture, expectation in (
        ("corpus-a", corpus_a, expectation_a),
        ("corpus-b", corpus_b, expectation_b),
        ("corpus-c-word16", corpus_c, expectation_c),
        ("legacy-golden", legacy, expectation_legacy),
    ):
        outcome = tool.verify(fixture, expectation=expectation)
        manifest["generated"].append({"verifier_selfcheck": name, "ok": outcome["ok"],
                                      "error": outcome["error"]})
        if not outcome["ok"]:
            sys.stderr.write("fixture %s 未通过期望判据：%s\n" % (name, outcome["error"]))
            return 1

    sys.stdout.write(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
