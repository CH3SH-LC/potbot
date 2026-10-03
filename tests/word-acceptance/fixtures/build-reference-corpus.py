#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""构建 WCF-D71 的**引用/审阅读回**语料 fixture（只依赖 Python 标准库）。

运行：`python tests/word-acceptance/fixtures/build-reference-corpus.py`

产出（写入本目录，随后**随仓冻结**）：

* `corpus-d-reference-elements.docx` —— 手工拼 OOXML（书签 / 超链接内外部 / 简单域 + 复杂域 /
  脚注尾注 / 批注 / 修订 / OMML 公式 / 图表部件），DEFLATE；
  内容与 `scripts/demo/verify-docx.py` 的 `reference_corpus_parts()` **同源**，
  保证"工具自检"与"真实 fixture 读回"不会各说各话（沿用 corpus-a 的纪律）。
* `corpus-e-annotation-export.docx` —— **potbot 生成器自产**（WCF-D60）的真实产物**逐字节副本**，
  用来证明"独立读回器能按新判据读回**真的由生产实现写出来的**引用/审阅元素"。
* `expectations/corpus-d.json` / `expectations/corpus-e.json` —— 预期文件。

## 纪律（与 build-corpus.py 同源，不要违反）

1. **不得重跑本脚本去"刷新" fixture 来让红测试变绿。** 期望里的 `sha256` 是冻结基线；
   回归了应当修实现或改判据，不是重新生成样本。
2. **预期值不是从生成文件反推的**（`corpus-d`）。语义期望按 OOXML 规范**手写声明**
   （`reference_corpus_expectation()`），读回器独立解析后比对。
   `corpus-e` 的期望是**手写读文**（人工读 XML 得到），`sha256` 按定义等于文件摘要。
3. **`corpus-e` 是生产产物副本，不是生产实现的预期值**：期望里**只**出现人工从 XML 读出的
   事实（id、名称、作者、目标），**没有**任何 `src/**` 的调用。
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

# WCF-D60 的真实产物（引用/审阅导出侧收口）。**只读副本**，来源与摘要记进 PROVENANCE。
ANNOTATION_SOURCE = os.path.join(
    REPO_ROOT, ".task-manifest", "outputs", "WCF-D60", "artifacts", "annotations.docx",
)

REL_BASE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def _load_verifier():
    spec = importlib.util.spec_from_file_location("verify_docx_tool", VERIFIER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _digest(path: str) -> str:
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


def _write_json(path: str, payload: dict) -> None:
    with open(path, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
        handle.write("\n")


def corpus_e_expectation(digest: str) -> dict:
    """**人工读 XML** 得到的期望（D60 的 `annotations.docx`，见 PROVENANCE.md）。

    逐项来源：`word/document.xml` 的正文元素、`word/footnotes.xml` / `word/endnotes.xml` /
    `word/comments.xml` 的 id、`word/_rels/document.xml.rels` 的关系。**没有**调用 `src/**`。
    """
    return {
        "label": "corpus-e（potbot WCF-D60 真实产物副本：书签/超链接/域/注记/批注/修订/目录）",
        "sha256": digest,
        "required_parts": [
            "[Content_Types].xml",
            "_rels/.rels",
            "customXml/item1.xml",
            "docProps/core.xml",
            "word/_rels/document.xml.rels",
            "word/comments.xml",
            "word/document.xml",
            "word/endnotes.xml",
            "word/footnotes.xml",
            "word/media/image1.png",
            "word/styles.xml",
        ],
        # 不声明压缩方式：这是**生产产物的现状**，本批不主张它必须是 DEFLATE。
        "bookmarks": {
            "starts": [{"id": 1, "name": "总则"}],
            "names": ["总则"],
            "paired": True,
            "unpaired_start_ids": [],
            "unpaired_end_ids": [],
            "duplicate_start_ids": [],
        },
        "hyperlinks": [
            {"kind": "external", "relationship_id": "rId13", "anchor": None,
             "target": "https://example.com/wcf-d60", "target_mode": "External",
             "tooltip": "外部链接（只记录，不抓取）"},
            {"kind": "internal", "relationship_id": None, "anchor": "总则",
             "anchor_resolves": True, "tooltip": None},
        ],
        "external_targets": [{"relationship_id": "rId13", "target": "https://example.com/wcf-d60"}],
        "dangling_anchors": [],
        "unbound_hyperlinks": [],
        "fields": [
            # 交叉引用：**有指令、没有缓存**（从未解析）——三态必须分开报（R158）。
            {"kind": "simple", "instruction": " REF 总则 \\h ", "has_instruction": True,
             "has_cache": False, "cached_text": None, "dirty": True, "refreshed": False,
             "state": "instruction_no_cache"},
            # 目录：复杂域，条目文字在 separate 之后、end 之前 = 缓存；begin 带 dirty。
            {"kind": "complex", "instruction": 'TOC \\o "1-3" \\h \\z \\u', "has_instruction": True,
             "has_cache": True, "cached_text": "第一章 总则", "dirty": True, "refreshed": False,
             "state": "cached_not_refreshed"},
        ],
        "field_pairing": {"begin": 1, "separate": 1, "end": 1, "balanced": True, "unclosed": False},
        "notes": {
            "footnotes": {"present": True, "relationship": True, "has_separators": True,
                          "reference_ids": [1], "dangling_reference_ids": [],
                          "unreferenced_note_ids": []},
            "endnotes": {"present": True, "relationship": True, "has_separators": True,
                         "reference_ids": [1], "dangling_reference_ids": [],
                         "unreferenced_note_ids": []},
        },
        "comments": {
            "part_present": True, "relationship": True,
            "range_start_ids": [1], "range_end_ids": [1], "reference_ids": [1],
            "paired_range_ids": [1], "unpaired_range_start_ids": [], "unpaired_range_end_ids": [],
            "dangling_reference_ids": [], "unreferenced_comment_ids": [],
        },
        "revisions": {"ins": 1, "del": 1, "del_text": 2, "del_without_del_text": 0,
                      "authors": ["审阅人"]},
        "math": {"count": 0, "structures": []},
        "charts": [],
        "unparsed_elements": {},
        "relationships": [
            {"owner_part_path": "word/document.xml", "id": "rId13",
             "type": REL_BASE + "/hyperlink", "target": "https://example.com/wcf-d60",
             "target_mode": "External"},
            {"owner_part_path": "word/document.xml", "id": "rId14",
             "type": REL_BASE + "/footnotes", "target": "footnotes.xml", "target_mode": "Internal"},
            {"owner_part_path": "word/document.xml", "id": "rId15",
             "type": REL_BASE + "/endnotes", "target": "endnotes.xml", "target_mode": "Internal"},
            {"owner_part_path": "word/document.xml", "id": "rId16",
             "type": REL_BASE + "/comments", "target": "comments.xml", "target_mode": "Internal"},
        ],
    }


def main(argv) -> int:
    tool = _load_verifier()
    fixtures_dir = HERE
    expectations_dir = os.path.join(fixtures_dir, "expectations")
    os.makedirs(expectations_dir, exist_ok=True)

    manifest: dict = {"kind": "wcf-d71-reference-corpus-build", "generated": [], "notes": []}

    # --- corpus D：手工拼 OOXML（与读回器自检样本同源）-----------------------
    corpus_d = os.path.join(fixtures_dir, "corpus-d-reference-elements.docx")
    tool.write_parts(corpus_d, tool.reference_corpus_parts())
    digest_d = _digest(corpus_d)
    expectation_d = tool.reference_corpus_expectation()
    expectation_d["sha256"] = digest_d
    expectation_d["label"] = "corpus-d（手工拼 OOXML，引用/审阅元素齐全，DEFLATE）"
    # 声明"这份样本里**没有**未解析元素"——一旦有新元素冒出来，这条判据会变红。
    expectation_d["unparsed_elements"] = {}
    expectation_d["content_types"] = {
        "/word/document.xml": "application/vnd.openxmlformats-officedocument."
                              "wordprocessingml.document.main+xml",
        "/word/footnotes.xml": "application/vnd.openxmlformats-officedocument."
                               "wordprocessingml.footnotes+xml",
        "/word/endnotes.xml": "application/vnd.openxmlformats-officedocument."
                              "wordprocessingml.endnotes+xml",
        "/word/comments.xml": "application/vnd.openxmlformats-officedocument."
                              "wordprocessingml.comments+xml",
        "/word/charts/chart1.xml": "application/vnd.openxmlformats-officedocument."
                                   "drawingml.chart+xml",
    }
    _write_json(os.path.join(expectations_dir, "corpus-d.json"), expectation_d)
    manifest["generated"].append({
        "fixture": os.path.basename(corpus_d), "sha256": digest_d,
        "origin": "scripts/demo/verify-docx.py::reference_corpus_parts()",
        "compression": "deflate",
    })

    # --- corpus E：potbot 真实产物副本 ---------------------------------------
    if not os.path.isfile(ANNOTATION_SOURCE):
        sys.stderr.write("找不到 WCF-D60 产物：%s\n" % ANNOTATION_SOURCE)
        return 1
    corpus_e = os.path.join(fixtures_dir, "corpus-e-annotation-export.docx")
    shutil.copyfile(ANNOTATION_SOURCE, corpus_e)
    digest_e = _digest(corpus_e)
    source_digest = _digest(ANNOTATION_SOURCE)
    if digest_e != source_digest:
        sys.stderr.write("corpus-e 副本与 WCF-D60 产物不一致\n")
        return 1
    expectation_e = corpus_e_expectation(digest_e)
    expectation_e["source"] = {
        "path": os.path.relpath(ANNOTATION_SOURCE, REPO_ROOT).replace("\\", "/"),
        "sha256": source_digest,
        "producer": "potbot WCF-D60 引用/审阅导出（design-05-P7 导出侧收口）",
    }
    _write_json(os.path.join(expectations_dir, "corpus-e.json"), expectation_e)
    manifest["generated"].append({
        "fixture": os.path.basename(corpus_e), "sha256": digest_e,
        "origin": expectation_e["source"]["path"], "origin_sha256": source_digest,
        "compression": "deflate",
    })

    # --- 自检：两份 fixture 都必须通过各自的期望判据 --------------------------
    for name, fixture, expectation in (
        ("corpus-d", corpus_d, expectation_d),
        ("corpus-e", corpus_e, expectation_e),
    ):
        outcome = tool.verify(fixture, expectation=expectation)
        manifest["generated"].append({"verifier_selfcheck": name, "ok": outcome["ok"],
                                      "error": outcome["error"],
                                      "unparsed": outcome["coverage"]})
        if not outcome["ok"]:
            sys.stderr.write("fixture %s 未通过期望判据：%s\n"
                             % (name, json.dumps(outcome["error"], ensure_ascii=False)))
            for check in outcome["checks"]:
                if not check["passed"]:
                    sys.stderr.write("  FAIL %s :: %s\n" % (check["name"], check["detail"]))
            return 1

    manifest["notes"].append(
        "corpus-d 的期望是**手写规范声明**；corpus-e 的期望是**人工读 XML**，"
        "两者都不 import src/** 当预期值（R167）。")
    sys.stdout.write(json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
