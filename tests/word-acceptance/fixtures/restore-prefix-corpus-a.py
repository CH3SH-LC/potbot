#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""还原 `corpus-a` 的**修复前字节**，供 E3b 实验当对照（**不改仓库里的 fixture**）。

背景：2026-10-02 归因更正轮里，`corpus-a` 的 `[Content_Types].xml` 补上了一行
`/docProps/core.xml` 的 Override（摘要 `b770029d…b3d7` → `10a84344…6fcd7`）。
要判断"Word 打不开 G1 产物"到底是不是这一行造成的，就得把**修复前的字节**拿回来当对照。

本脚本**只往实验目录写**，不碰 `tests/word-acceptance/fixtures/corpus-a-independent-deflate.docx`。

**自校验**：还原出来的字节的 SHA-256 必须逐字节等于登记值 `b770029d…b3d7`；
不等于就**非零退出**——宁可失败，也不给实验一个"差不多的对照"。

用法：`python restore-prefix-corpus-a.py <out.docx>`
"""

from __future__ import annotations

import hashlib
import importlib.util
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
VERIFIER = os.path.join(REPO_ROOT, "scripts", "demo", "verify-docx.py")
CORPUS_A = os.path.join(HERE, "corpus-a-independent-deflate.docx")

#: 修复前登记摘要（见 PROVENANCE.md 的变更记录）。
PREFIX_SHA256 = "b770029d83b9ce4f16ef6ef56e1898a334df9c17080f95fef26f192593efb3d7"

#: 2026-10-02 补上去的那一行，去掉它就回到修复前。
ADDED_OVERRIDE = (
    '<Override PartName="/docProps/core.xml" '
    'ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
).encode("utf-8")


def main(argv) -> int:
    if len(argv) != 2:
        sys.stderr.write("用法：restore-prefix-corpus-a.py <out.docx>\n")
        return 2
    destination = argv[1]

    spec = importlib.util.spec_from_file_location("verify_docx_tool", VERIFIER)
    tool = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(tool)

    parts = tool.read_parts(CORPUS_A)
    restored = []
    stripped = 0
    for name, data in parts:
        if name == tool.CONTENT_TYPES_PART:
            if ADDED_OVERRIDE not in data:
                sys.stderr.write(
                    "当前 corpus-a 的 [Content_Types].xml 里找不到那一行 Override —— "
                    "语料状态与登记不符，无法可靠还原修复前字节。\n")
                return 1
            data = data.replace(ADDED_OVERRIDE, b"", 1)
            stripped += 1
        restored.append((name, data))
    if stripped != 1:
        sys.stderr.write("没有找到 [Content_Types].xml，还原失败。\n")
        return 1

    # 用与构建脚本同一套写出逻辑（固定时间戳 + DEFLATE），保证逐字节可复现。
    tool.write_parts(destination, restored)
    with open(destination, "rb") as handle:
        digest = hashlib.sha256(handle.read()).hexdigest()

    ok = digest == PREFIX_SHA256
    sys.stdout.write(
        '{"restored": "%s", "sha256": "%s", "expected": "%s", "matches_registered": %s}\n'
        % (os.path.abspath(destination), digest, PREFIX_SHA256, "true" if ok else "false"))
    if not ok:
        sys.stderr.write(
            "还原出来的字节与登记摘要不符：%s != %s —— 拒绝把它当对照（宁可失败也不要"
            "一个'差不多的对照'）。\n" % (digest, PREFIX_SHA256))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
