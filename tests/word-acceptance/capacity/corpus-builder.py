#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""WCF-D52 容量基线的**独立**压力语料构建器（**只依赖 Python 标准库**）。

用途：造**有界**的压力语料，交给 potbot 的真实链路（`importDocx` → `exportDocx`），
再用**独立**读回器（`scripts/demo/verify-docx.py`）复核产物。四条基线的语料都由本脚本造：

    段落数 ≥ 500   /   汉字数 ≥ 5 万   /   图片数 ≥ 100   /   容器 ≥ 10 MiB

## 纪律（不要违反）

1. **图片必须是有效 PNG**，不是截断的假图。本脚本用 `zlib` + `struct` 手写 PNG
   （IHDR/IDAT/IEND 三段，长度与 CRC 自算），并用**随机噪声**填充像素——
   随机数据 DEFLATE 压不动，容器大小因此可控且可预测（这正是"≥10 MiB 容器"要的）。
   2026-10-02 本轮已实测：坏图会让 Word 拒绝整包，所以不能拿假字节充数。
2. **声明数字是"本脚本实际写进去的量"**，不是"想要的量"。构建完就地复算真实段落/汉字/图片数，
   写进 stdout 的 JSON。调用方（`support.ts`）拿它与独立读回器比对——**声明与读回不符即失败**，
   这是抓"导入/导出静默截断"的那根线。
3. **绝不静默降级**：参数非法退出 2；构建后自检不过退出 3。不"差不多"、不截断。
4. 产物**逐字节可复现**：固定 ZIP 时间戳 + 固定随机种子。

## 段落种类（指导文档要求"必须包含空段、连续空格、tab、软换行和混合格式"）

| kind | 构造 |
|---|---|
| `plain` | 普通正文段（承载大部分汉字） |
| `empty` | `<w:p/>` 真空段 |
| `spaces` | 仅连续空格的段落（`xml:space="preserve"`） |
| `tab` | 段内含 `<w:tab/>` |
| `softbreak` | 段内含 `<w:br/>`（**不是**段落边界） |
| `mixed` | 段内 3 个 run，分别粗体 / 斜体+字号 / 颜色 |

运行：`python tests/word-acceptance/capacity/corpus-builder.py --out x.docx --paragraphs 500`
"""

from __future__ import annotations

import argparse
import json
import os
import random
import struct
import sys
import zipfile
import zlib

XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
PIC_NS = "http://schemas.openxmlformats.org/drawingml/2006/picture"
CT_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"

MAIN_PART = "word/document.xml"
DOC_RELS = "word/_rels/document.xml.rels"
PACKAGE_RELS = "_rels/.rels"
CONTENT_TYPES = "[Content_Types].xml"

DOC_CT = ("application/vnd.openxmlformats-officedocument."
          "wordprocessingml.document.main+xml")
IMAGE_REL = R_NS + "/image"

# 中文字符区间（判"汉字数"的口径——与读回器独立复算的口径一致）
CJK_RANGES = ((0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF))

# 非承载段落的固定文本：**刻意全为 ASCII**，使"汉字总数"完全由承载段落决定、可精确控制。
TEXT_EMPTY = ""
TEXT_SPACES = "      "                      # 连续空格（xml:space="preserve"）
TEXT_TAB = "col-a\tcol-b\tcol-c"
TEXT_SOFT_PLAIN = "soft break sample"
TEXT_MIXED_ASCII_A = "bold ascii "
TEXT_MIXED_ASCII_B = " italic small "
TEXT_MIXED_ASCII_C = " color "

KINDS = ("plain", "empty", "spaces", "tab", "softbreak", "mixed")


ASCII_POOL = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,;:-_"


def varied_ascii(length: int, seed: int) -> str:
    """**变字**的 ASCII 串（抵制过度压缩，同 `hanzi_run` 的理由）。"""
    if length <= 0:
        return ""
    noise = random.Random(seed).randbytes(length)
    pool = ASCII_POOL
    size = len(pool)
    return "".join(pool[byte % size] for byte in noise)


def is_cjk(ch: str) -> bool:
    code = ord(ch)
    return any(low <= code <= high for low, high in CJK_RANGES)


def count_hanzi(text: str) -> int:
    return sum(1 for ch in text if is_cjk(ch))


def esc(text: str) -> str:
    return (text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


# ---------------------------------------------------------------------------
# PNG：程序生成的**有效**图片（随机噪声，抗压缩）
# ---------------------------------------------------------------------------


def _png_chunk(tag: bytes, data: bytes) -> bytes:
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def make_png(pixels: int, seed: int) -> bytes:
    """生成一张 `pixels × pixels` 的 8 位真彩 **有效 PNG**（像素为随机噪声）。

    用噪声而非纯色，是因为纯色会被 DEFLATE 压到几百字节——那样"容器 ≥10 MiB"就得靠
    堆几万张图，既慢又不像真实照片。噪声让每张图的可压缩率≈1，容器大小≈像素数×3。
    """
    if pixels < 1:
        raise ValueError("pixels 必须 ≥1")
    rnd = random.Random(seed)
    width = height = pixels
    payload = rnd.randbytes(width * height * 3)
    raw = bytearray()
    stride = width * 3
    for row in range(height):
        raw.append(0)  # filter type 0（None）
        raw += payload[row * stride:(row + 1) * stride]
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # 8bit / truecolor
    return (b"\x89PNG\r\n\x1a\n"
            + _png_chunk(b"IHDR", ihdr)
            + _png_chunk(b"IDAT", zlib.compress(bytes(raw), 6))
            + _png_chunk(b"IEND", b""))


# ---------------------------------------------------------------------------
# OOXML 片段
# ---------------------------------------------------------------------------


def drawing_xml(rel_id: str, doc_pr_id: int, name: str, emu: int) -> str:
    """一个 inline 图片 run（真实 Word 认的 `wp:inline` → `a:graphic` → `pic:pic`）。"""
    return (
        '<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">'
        '<wp:extent cx="%d" cy="%d"/><wp:docPr id="%d" name="%s"/>'
        '<a:graphic><a:graphicData uri="%s">'
        '<pic:pic><pic:nvPicPr><pic:cNvPr id="%d" name="%s"/><pic:cNvPicPr/></pic:nvPicPr>'
        '<pic:blipFill><a:blip r:embed="%s"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>'
        '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="%d" cy="%d"/></a:xfrm>'
        '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
        '</pic:pic></a:graphicData></a:graphic>'
        '</wp:inline></w:drawing></w:r>'
        % (emu, emu, doc_pr_id, esc(name), PIC_NS, doc_pr_id, esc(name), rel_id, emu, emu)
    )


def paragraph_xml(kind: str, text: str, image: "str | None" = None) -> str:
    """按 kind 生成一个 `<w:p>`。`image` 给定时在该段尾部追加一个图片 run。"""
    image_xml = image or ""
    if kind == "plain":
        preserve = ' xml:space="preserve"' if text != text.strip() else ""
        return ('<w:p><w:r><w:t%s>%s</w:t></w:r>%s</w:p>'
                % (preserve, esc(text), image_xml))
    if kind == "empty":
        return "<w:p>%s</w:p>" % image_xml
    if kind == "spaces":
        return ('<w:p><w:r><w:t xml:space="preserve">%s</w:t></w:r>%s</w:p>'
                % (esc(TEXT_SPACES), image_xml))
    if kind == "tab":
        return ('<w:p><w:r><w:t>x</w:t><w:tab/><w:t>%s</w:t></w:r>%s</w:p>'
                % (esc(TEXT_TAB), image_xml))
    if kind == "softbreak":
        return ('<w:p><w:r><w:t>%s</w:t><w:br/><w:t>second line</w:t></w:r>%s</w:p>'
                % (esc(TEXT_SOFT_PLAIN), image_xml))
    if kind == "mixed":
        return (
            '<w:p>'
            '<w:r><w:rPr><w:b/></w:rPr><w:t>%s</w:t></w:r>'
            '<w:r><w:rPr><w:i/><w:sz w:val="28"/></w:rPr><w:t>%s</w:t></w:r>'
            '<w:r><w:rPr><w:color w:val="FF0000"/></w:rPr><w:t>%s</w:t></w:r>'
            '<w:r><w:t xml:space="preserve">%s</w:t></w:r>'
            '%s</w:p>'
            % (esc(TEXT_MIXED_ASCII_A), esc(TEXT_MIXED_ASCII_B),
               esc(TEXT_MIXED_ASCII_C), esc(text), image_xml)
        )
    raise ValueError("未知段落种类：%s" % kind)


def document_xml(paragraphs: "list[str]") -> str:
    return (
        XML_DECL
        + '<w:document xmlns:w="%s" xmlns:r="%s" xmlns:wp="%s" xmlns:a="%s" xmlns:pic="%s">'
          '<w:body>%s'
          '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
          '<w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:gutter="0"/>'
          '</w:sectPr></w:body></w:document>'
        % (W_NS, R_NS, WP_NS, A_NS, PIC_NS, "".join(paragraphs))
    )


def content_types_xml(image_count: int) -> str:
    defaults = ['<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
                '<Default Extension="xml" ContentType="application/xml"/>']
    if image_count > 0:
        defaults.append('<Default Extension="png" ContentType="image/png"/>')
    overrides = ['<Override PartName="/%s" ContentType="%s"/>' % (MAIN_PART, DOC_CT)]
    return (XML_DECL + '<Types xmlns="%s">%s%s</Types>'
            % (CT_NS, "".join(defaults), "".join(overrides)))


def package_rels_xml() -> str:
    return (XML_DECL + '<Relationships xmlns="%s">'
            '<Relationship Id="rId1" Type="%s/officeDocument" Target="%s"/>'
            '</Relationships>' % (PKG_REL_NS, R_NS, MAIN_PART))


def document_rels_xml(image_count: int) -> str:
    rels = "".join(
        '<Relationship Id="rIdImg%d" Type="%s" Target="media/image%d.png"/>' % (i, IMAGE_REL, i)
        for i in range(1, image_count + 1)
    )
    return XML_DECL + '<Relationships xmlns="%s">%s</Relationships>' % (PKG_REL_NS, rels)


def write_zip(path: str, parts: "list[tuple[str, bytes]]") -> None:
    """确定性打包（**DEFLATE**——真实 Word 产物就是这个压缩方法，同时压到读侧 inflate 路径）。"""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in parts:
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o600 & 0xFFFF) << 16
            zf.writestr(info, data)


def build(args, write: bool = True) -> dict:
    if args.paragraphs < 1:
        raise SystemExit("段落数必须 ≥1")
    if args.images > args.paragraphs:
        raise SystemExit("图片数(%d)不得超过段落数(%d)：本构建器每段至多内联 1 张图"
                         % (args.images, args.paragraphs))

    kinds = [KINDS[i % len(KINDS)] for i in range(args.paragraphs)]
    # 承载汉字的段落：plain 与 mixed（后者第 4 个 run 承载）
    carriers = [i for i, k in enumerate(kinds) if k in ("plain", "mixed")]
    if args.hanzi > 0 and not carriers:
        raise SystemExit("没有可承载汉字的段落（需要至少一个 plain/mixed 段）")

    per = args.hanzi // len(carriers) if carriers else 0
    remainder = args.hanzi - per * len(carriers) if carriers else 0
    cjk_pool = [chr(0x4E00 + i) for i in range(0x1000)]

    def hanzi_run(start: int, length: int) -> str:
        """**变字**的汉字串（不是同一个字重复）。

        为什么必须变字：同一个字重复几万遍会被 DEFLATE 压到 ~1/300，撞上读侧
        `maxCompressionRatio: 200` 的**炸弹守卫**——那测出来的就不是"容量"，而是
        "语料造得像炸弹"。真实中文文本的压缩比只有个位数。此处用确定性的错位取字，
        既保持可复现，又把压缩比拉回真实区间。

        `--repetitive` 反过来用：**故意**造高重复文本，用来测"读侧压缩比守卫的确切边界"。
        """
        if args.repetitive:
            return cjk_pool[0] * length
        return "".join(cjk_pool[(start + step * 37) % len(cjk_pool)] for step in range(length))

    texts: "list[str]" = []
    carrier_index = 0
    cursor = 0
    for index, kind in enumerate(kinds):
        if kind in ("plain", "mixed"):
            take = per + (1 if carrier_index < remainder else 0)
            carrier_index += 1
            texts.append(hanzi_run(cursor, take) if take > 0 else "")
            cursor += take
        else:
            texts.append("")

    # 图片：均匀落在段上（优先非空段），每段至多 1 张
    image_of: "dict[int, tuple[str, int, str]]" = {}
    for n in range(1, args.images + 1):
        slot = ((n - 1) * max(len(kinds) // max(args.images, 1), 1)) % len(kinds)
        while slot in image_of:
            slot = (slot + 1) % len(kinds)
        image_of[slot] = ("rIdImg%d" % n, n, "image%d.png" % n)

    emu = 914400  # 1 英寸
    paragraphs = []
    for index, kind in enumerate(kinds):
        image = None
        if index in image_of:
            rel_id, doc_pr_id, name = image_of[index]
            image = drawing_xml(rel_id, doc_pr_id, name, emu)
        paragraphs.append(paragraph_xml(kind, texts[index], image))

    image_parts: "list[tuple[str, bytes]]" = [
        ("word/media/image%d.png" % n, make_png(args.image_pixels, args.seed + n))
        for n in range(1, args.images + 1)
    ]

    def assemble(body: "list[str]") -> "list[tuple[str, bytes]]":
        parts: "list[tuple[str, bytes]]" = [
            (CONTENT_TYPES, content_types_xml(args.images).encode("utf-8")),
            (PACKAGE_RELS, package_rels_xml().encode("utf-8")),
            (MAIN_PART, document_xml(body).encode("utf-8")),
            (DOC_RELS, document_rels_xml(args.images).encode("utf-8")),
        ]
        parts.extend(image_parts)
        return parts

    # `--min-bytes` 盯的是**容器**（整份 DOCX）大小，不是 `document.xml` 部件——
    # 图片已经压不动，所以容器大小主要由"图片像素数 × 张数"决定；不够时用**合法正文段落**补足
    # （不截断、不塞垃圾字节）。先按估算一次补齐，再复算兜底。
    filler_chunk = 8192
    filler_cost = filler_chunk + 64  # <w:p><w:r><w:t>…</w:t></w:r></w:p> 的固定开销
    extra = 0
    container_bytes = 0
    for _ in range(6):
        parts = assemble(paragraphs)
        if not write:
            container_bytes = sum(len(data) for _, data in parts)
            break
        write_zip(args.out, parts)
        container_bytes = os.path.getsize(args.out)
        if args.min_bytes == 0 or container_bytes >= args.min_bytes:
            break
        need = args.min_bytes - container_bytes
        add = max(1, -(-need // filler_cost))
        paragraphs.extend(
            paragraph_xml("plain", varied_ascii(filler_chunk, args.seed + 1000 + extra + i))
            for i in range(add)
        )
        extra += add
    if write and args.min_bytes > 0 and container_bytes < args.min_bytes:
        sys.stderr.write("补足失败：容器 %d 字节 < 要求 %d\n" % (container_bytes, args.min_bytes))
        raise SystemExit(3)

    document_part_bytes = len(document_xml(paragraphs).encode("utf-8"))

    # 就地复算**实际写入**的规模（不是"想要的量"）
    actual_hanzi = 0
    kind_counts = {kind: 0 for kind in KINDS}
    for index, kind in enumerate(kinds):
        kind_counts[kind] += 1
        # plain/mixed 的承载文本都存放在 texts[] 里，按 texts 统计即完整（不重复计）。
        actual_hanzi += count_hanzi(texts[index])
    meta = {
        "out": os.path.abspath(args.out) if write else None,
        "paragraphs": len(paragraphs),
        "hanzi": actual_hanzi,
        "images": args.images,
        "image_pixels": args.image_pixels,
        "body_bytes": container_bytes,
        "document_part_bytes": document_part_bytes,
        "declared_min_bytes": args.min_bytes,
        "padding_paragraphs_added": extra,
        "paragraph_kinds": kind_counts,
        "seed": args.seed,
        "repetitive": bool(args.repetitive),
        "compression": "deflate",
    }
    return meta


def main(argv: "list[str]") -> int:
    parser = argparse.ArgumentParser(description="WCF-D52 容量基线压力语料构建器")
    parser.add_argument("--out", required=True, help="产物 DOCX 路径")
    parser.add_argument("--paragraphs", type=int, default=10)
    parser.add_argument("--hanzi", type=int, default=0)
    parser.add_argument("--images", type=int, default=0)
    parser.add_argument("--image-pixels", type=int, default=32)
    parser.add_argument("--min-bytes", type=int, default=0)
    parser.add_argument("--seed", type=int, default=20261003)
    parser.add_argument("--repetitive", action="store_true",
                        help="承载汉字用同一个字重复（故意造高压缩比，用于测读侧压缩比守卫）")
    parser.add_argument("--meta-only", action="store_true",
                        help="只打印将要写入的规模，不落盘")
    args = parser.parse_args(argv[1:])

    if args.paragraphs < 1 or args.hanzi < 0 or args.images < 0 or args.image_pixels < 1:
        sys.stderr.write("参数非法：paragraphs≥1, hanzi≥0, images≥0, image-pixels≥1\n")
        return 2

    if args.meta_only:
        meta = build(args, write=False)
    else:
        os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
        meta = build(args, write=True)

    # 构建后自检：声明的规模必须真的落进产物里（用 zipfile 独立复算）
    if not args.meta_only:
        with zipfile.ZipFile(meta["out"]) as zf:
            names = zf.namelist()
            if len(names) != len(set(names)):
                sys.stderr.write("构建自检失败：ZIP 条目路径重复\n")
                return 3
            expected_png = sum(1 for name in names if name.startswith("word/media/"))
            if expected_png != args.images:
                sys.stderr.write("构建自检失败：媒体部件 %d 声明 %d\n"
                                 % (expected_png, args.images))
                return 3
            document = zf.read(MAIN_PART).decode("utf-8")
            written_paragraphs = document.count("<w:p>") + document.count("<w:p/>")
            if written_paragraphs != meta["paragraphs"]:
                sys.stderr.write("构建自检失败：实际段落 %d 声明 %d\n"
                                 % (written_paragraphs, meta["paragraphs"]))
                return 3
            if meta["body_bytes"] < args.min_bytes:
                sys.stderr.write("构建自检失败：容器 %d 字节 < 要求 %d\n"
                                 % (meta["body_bytes"], args.min_bytes))
                return 3

    sys.stdout.write(json.dumps(meta, ensure_ascii=True, sort_keys=True) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
