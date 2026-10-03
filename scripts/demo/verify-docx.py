#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""独立 DOCX 读回器（S6 / WCF-D10 验收工具，**独立于生成器**）。

用法：

    python scripts/demo/verify-docx.py <path-to.docx> [--pretty]
    python scripts/demo/verify-docx.py <path-to.docx> --expect <expect.json> [--pretty]
    python scripts/demo/verify-docx.py --self-test [--pretty]
    python scripts/demo/verify-docx.py --mutate <kind> <in.docx> <out.docx>
    python scripts/demo/verify-docx.py --list-mutations

设计纪律（读这一节再改本文件）：

* 本工具**只依赖 Python 标准库**（`zipfile` + `xml.etree.ElementTree`），
  与 potbot 自己的 TS ZIP/XML 写入器**没有任何共享代码**。这正是它的价值：
  用它读回只能证明"容器与 XML 在世界标准下可解析"，证明不了"Word 能打开"。
* **不 import 生产实现**，**不复用生产单位换算**（合同 R167/R128）。本文件里的
  `half_points()` / `line_twips_multiple()` / `line_twips_exact()` / `line_twips_at_least()` /
  `first_line_chars()` / `spacing_twips()` 是**按 ECMA-376 规范自己复算**的第二实现——
  两套实现同时错成一样才算"生产换算正确"是**不被承认的**，所以这里的换算独立写、独立测，
  并在 `expect_units_recompute` 判据里与原文件的原始属性逐项对齐。
* 输出**永远是单行/多行 JSON**（默认 `ensure_ascii=True`，中文转成 `\\uXXXX`，
  避免 Windows 控制台代码页把中文转坏）；结构化、可机判。
* 退出码：**0 = 该文件通过了本层的全部判据**；**1 = 未通过**（`ok=false`，
  `error.code` 给出机器可判的原因）；**2 = 工具自身用法错误**（参数不对）；
  **3 = 变异不可应用**（`--mutate` 在目标文件里找不到可变的构造——**绝不静默变成空操作**）。
* 本工具**不修改**被读文件（`--mutate` 只写 `<out.docx>`，不碰 `<in.docx>`）。

## 基础判据（全部通过才 `ok=true`）

1. 路径存在且是普通文件；
2. 是一个合法 ZIP（`zipfile.ZipFile` 能打开，中央目录完整）；
3. **逐条目 CRC 自校验**（`testzip()` 返回 None —— 任一字节被改动即报错）；
4. 含主部件 `word/document.xml` 与包级部件 `[Content_Types].xml`；
5. 全部 `.xml` / `.rels` 部件都能被独立 XML 解析器解析（无解析异常）；
6. `word/document.xml` 的 `w:p` 段落能抽出**至少一个非空文本**（标题）。
7. 若有文档呈现版本标记，其自定义属性部件必须有正确的根命名空间、
   内容类型及指向该部件的包级内部关系；无标记的旧文档仍按原判据读回。

`ok=false` 时 `error` 里给出**首个**失败项，便于定位；`checks` 数组给出逐项结论。

## 格式读回（`format` 字段，WCF-D10 新增）

7 个基础判据**只看容器与文本**，看不出"这一段是不是居中"或"这一段字号被改过"。
本工具因此另外解析 OOXML 的**有效原始属性**：

* `w:rPr`：`w:b` / `w:i` / `w:strike`（**元素有无**与 `w:val` **分开**报告——合同 R118：
  「没有 `<w:b/>`」与「`<w:b w:val="false"/>`」是两种不同的字节）、
  `w:u`（类型）、`w:sz` / `w:szCs`（**半点值**，原样报告，不做 pt 折算）、
  `w:rFonts` 四槽 ascii/hAnsi/eastAsia/cs、`w:color`、`w:highlight`、`w:shd`、`w:vertAlign`；
* `w:pPr`：`w:jc`、`w:spacing` 的 `line`/`lineRule`/`before`/`after`/`beforeLines`/`afterLines`、
  `w:ind` 的 `firstLine` **与** `firstLineChars` **分别**报告（合同 R130：字符与长度是两种量，
  不得互相冒充）、`w:outlineLvl`、`w:pStyle`；
* 表格：`w:tblGrid/w:gridCol` 列宽、逐行逐格文本、`w:gridSpan`；
* 节：`w:sectPr` 的 `w:pgSz` / `w:pgMar` / `w:cols`（body 级与段落级都收）。

**报告原始属性**而不是解析成模型，是为了让上层（TS 验收用例）自己决定判据，
也避免本工具把"生产模型的语义"当成本工具的前提。

## 期望文件与判别力（`--expect`，合同 R168 / 场景 T16）

只报属性还不够——要能判"这份文件是否**符合预先声明的预期**"。`--expect` 指向一个
JSON 预期文件，判据全部**只在给了 `--expect` 时**才参与 `ok`（这样老调用方的结论不变）。
每条判据是一个具名 check，变异对应关系见下表（`--list-mutations` 可打印）：

| 变异 kind | 语义 | 必须抓它的判据 |
|---|---|---|
| `drop-rpr` | 删掉首个 `w:rPr` | `expect_run_properties` |
| `resize-font` | 改字号（`w:sz` 半点值 ±4） | `expect_run_properties` |
| `indent-unit-swap` | `w:firstLineChars` → `w:firstLine`（**换单位**） | `expect_paragraph_indent` |
| `break-relationship` | 把某内部关系指向不存在的部件 | `expect_relationships` |
| `drop-unknown-part` | 丢掉一个非基础部件 | `expect_required_parts` |
| `tamper-hash` | 正文插入语义中性的注释（sha256 变、其余全不变） | `expect_sha256` |

`tamper-hash` 刻意做成**语义中性**（只插一条 XML 注释、重新打包），因此
`expect_run_properties` / `expect_paragraph_indent` / `expect_required_parts` /
`expect_relationships` **必须仍然通过**——这证明 sha256 判据不是靠"文件一动就红"蒙对的。

`--self-test` 用本文件内部手工拼出的**合成样本**跑一遍「对照必须绿 + 6 个变异必须各自被
对应判据抓住」；TS 侧的 `tests/word-acceptance/**` 用**真实语料 fixture** 跑同样一套。

## 引用与审阅读回（WCF-D71 新增，合同 R158 / R161 / R166–R168）

上面的格式读回**看不到** design-05 批次新增的引用与审阅元素（书签、超链接、域、脚注尾注、
批注、修订、公式、图表）——WCF-D60 把"独立读回只覆盖包与关系完整性、不覆盖元素语义"
明确登记为缺口。本工具补上这一层，**不 import 任何生产 TS 实现**，按 ECMA-376 自己解析：

* **书签**：`w:bookmarkStart` / `w:bookmarkEnd` 的 `w:id` / `w:name`，并给出**配对性**
  （有 start 必须有同 id 的 end；重复 id 单独报）；
* **超链接**：`w:hyperlink` 的 `r:id` / `w:anchor` / `w:tooltip`，**内部 vs 外部**分清；
  外部目标只按关系里的 `TargetMode="External"` **如实标出**，`Target` 原样记录——
  **绝不去抓取**（R161：本工具只读包内字节，没有任何网络调用）；
  内部锚点**必须能对上已存在的书签名**，对不上即"悬空锚点"，如实报出；
* **域**：`w:fldSimple@w:instr` 与复杂域（`w:fldChar begin/separate/end` + `w:instrText`），
  并把 **「有指令」/「有缓存」/「已刷新」三态分开报**（R158：写域指令 ≠ 已算页码；
  未刷新必须在报告里可见）——三态合成 `state`：`no_instruction` / `instruction_no_cache` /
  `cached_not_refreshed` / `refreshed`；
* **脚注尾注**：`w:footnoteReference` / `w:endnoteReference@w:id`；`word/footnotes.xml` /
  `word/endnotes.xml` 部件与其**关系**是否存在；引用 id 与部件内 `w:footnote@w:id` 的对账
  （悬空引用 / 未被引用的注）；
* **批注**：`w:commentRangeStart` / `w:commentRangeEnd` / `w:commentReference@w:id` 的**配对**；
  `word/comments.xml` 与关系的存在性；引用 id 与 `w:comment@w:id` 的对账；
* **修订**：`w:ins` / `w:del` / `w:delText` 的计数、作者、日期，并单独报"`w:del` 里误用 `w:t`
  而非 `w:delText`"的条数；
* **公式**（OMML，若导出侧已接）：`m:oMath` 数量与结构可读性——从 `m:f`（`m:num`/`m:den`）
  读出分子分母、从 `m:rad`（`m:deg`/`m:e`）读出次数与被开方数；
* **图表**：`word/charts/*.xml` 的**存在性与关系**，以及系列数 / 数据点数量。

**未解析元素显式列出**：`coverage.unparsed_elements` 逐部件列出"出现过、但本工具没有语义解析"
的元素 local name。**不是"没报错所以没问题"**——报告里能直接看到读回的边界。
`--expect` 里给了 `unparsed_elements` 时，这条清单会被当作判据比对（新元素一旦出现就变红）。

## 引用/审阅类变异（判据 R168）

**故意与上面 6 个基础变异分成两组**：`--list-mutations` 的 `mutations` 仍然是原来那 6 个
（老调用方逐条比对 kind→判据，多一个都会红），引用/审阅类出现在同一份输出的
`reference_mutations` 键里。两组共用 `--mutate <kind>` 与同一套 `apply_mutation`。

| 变异 kind | 语义 | 必须抓它的判据 |
|---|---|---|
| `drop-bookmark-end` | 删掉一个 `w:bookmarkEnd` | `expect_bookmarks` |
| `dangling-anchor` | 把 `w:anchor` 改成不存在的书签名 | `expect_hyperlinks` |
| `drop-footnotes-part` | 丢掉 `word/footnotes.xml` | `expect_note_parts` |
| `drop-comments-part` | 丢掉 `word/comments.xml` | `expect_comments` |
| `unpair-comment-range` | 把 `w:commentRangeEnd@w:id` 改成别的 id | `expect_comments` |
| `strip-field-cache` | 删掉域里的缓存文字（指令还在） | `expect_fields` |
| `mark-field-refreshed` | 摘掉 `w:dirty="true"`（缓存没变，却声称已刷新） | `expect_fields` |
| `flatten-math` | 把 `m:f` 换成纯文本 `1/2` | `expect_math_structure` |
| `drop-chart-part` | 丢掉 `word/charts/chart1.xml` | `expect_chart_parts` |
| `tamper-revision-author` | 改 `w:ins`/`w:del` 的作者 | `expect_revisions` |
| `drop-field-separate` | 删掉复杂域的 `w:fldChar w:fldCharType="separate"`（FA-V） | `expect_fields` |
| `del-text-as-t` | 把 `w:del` 里的 `w:delText` 换成 `w:t`（FA-V） | `expect_revisions` |
| `break-external-relationship` | 删掉一条 `TargetMode="External"` 关系（FA-V，**不抓取**） | `expect_hyperlinks` |
"""

from __future__ import annotations

import hashlib
import json
import os
import posixpath
import re
import sys
import zipfile

try:
    import xml.etree.ElementTree as ET
except Exception:  # pragma: no cover - 标准库缺失属环境损坏
    ET = None  # type: ignore[assignment]


W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W = "{%s}" % W_NS
MAIN_PART = "word/document.xml"
CONTENT_TYPES_PART = "[Content_Types].xml"
CONTENT_TYPES_NS = "http://schemas.openxmlformats.org/package/2006/content-types"
PACKAGE_RELS_PART = "_rels/.rels"
PACKAGE_RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
CUSTOM_PART = "docProps/custom.xml"
CUSTOM_NS = "http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"
CUSTOM_MIME = "application/vnd.openxmlformats-officedocument.custom-properties+xml"
CORE_PROPS_MIME = "application/vnd.openxmlformats-package.core-properties+xml"
CUSTOM_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/custom-properties"
VALUE_NS = "http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"
PRESENTATION_PROPERTY = "PotbotDocumentPresentation"

DOC_RELS_PART = "word/_rels/document.xml.rels"

R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
R = "{%s}" % R_NS
M_NS = "http://schemas.openxmlformats.org/officeDocument/2006/math"
C_NS = "http://schemas.openxmlformats.org/drawingml/2006/chart"
REL_BASE = R_NS

FOOTNOTES_PART = "word/footnotes.xml"
ENDNOTES_PART = "word/endnotes.xml"
COMMENTS_PART = "word/comments.xml"
CHARTS_DIR = "word/charts/"
CHARTS_PREFIX = "word/charts/"

# 变异登记表：kind -> 对应判据（判据名必须出现在 checks 里）
#
# **基础组**。顺序与内容**不得**改动：`tests/word-acceptance/support.ts` 的 `MUTATIONS`
# 与 `--list-mutations` 的 `mutations` 键逐条比对，多一个少一个都会让老用例变红。
MUTATIONS: "dict[str, str]" = {
    "drop-rpr": "expect_run_properties",
    "resize-font": "expect_run_properties",
    "indent-unit-swap": "expect_paragraph_indent",
    "break-relationship": "expect_relationships",
    "drop-unknown-part": "expect_required_parts",
    "tamper-hash": "expect_sha256",
}

# 引用/审阅组（WCF-D71）。**单独一组**：老用例只读 `mutations` 键，这组出现在
# `reference_mutations` 键里，所以扩展变异矩阵不会误伤既有断言。
REFERENCE_MUTATIONS: "dict[str, str]" = {
    "drop-bookmark-end": "expect_bookmarks",
    "dangling-anchor": "expect_hyperlinks",
    "drop-footnotes-part": "expect_note_parts",
    "drop-comments-part": "expect_comments",
    "unpair-comment-range": "expect_comments",
    "strip-field-cache": "expect_fields",
    "mark-field-refreshed": "expect_fields",
    "flatten-math": "expect_math_structure",
    "drop-chart-part": "expect_chart_parts",
    "tamper-revision-author": "expect_revisions",
    # FA-V 补的 3 个（任务书点名、WCF-D71 未覆盖）：复杂域配对 / w:del 文本元素 / 外部关系断裂。
    "drop-field-separate": "expect_fields",
    "del-text-as-t": "expect_revisions",
    "break-external-relationship": "expect_hyperlinks",
}

ALL_MUTATIONS: "dict[str, str]" = {**MUTATIONS, **REFERENCE_MUTATIONS}

_COMPRESSION_NAMES = {0: "store", 8: "deflate"}
_FALSEY = ("0", "false", "off")


# ---------------------------------------------------------------------------
# 独立单位换算（**不复用生产实现**，按 ECMA-376 自己复算）
# ---------------------------------------------------------------------------

def half_points(pt: float) -> int:
    """pt → `w:sz` 半点值（ECMA-376 §17.3.2.39：`w:sz` 单位是 half-point）。12pt → 24。"""
    return int(round(pt * 2))


def line_twips_exact(pt: float) -> int:
    """固定行距 pt → `w:line`（`w:lineRule="exact"`，单位 twips，1pt = 20 twips）。20pt → 400。"""
    return int(round(pt * 20))


def line_twips_at_least(pt: float) -> int:
    """最小行距 pt → `w:line`（`w:lineRule="atLeast"`）。18pt → 360。"""
    return int(round(pt * 20))


def line_twips_multiple(multiple: float) -> int:
    """倍数行距 → `w:line`（`w:lineRule="auto"`，单位 1/240 行）。1.5 倍 → 360。"""
    return int(round(multiple * 240))


def first_line_chars(chars: float) -> int:
    """字符缩进 → `w:firstLineChars`（单位 1/100 字）。2 字 → 200。"""
    return int(round(chars * 100))


def spacing_twips(pt: float) -> int:
    """段前/段后 pt → `w:before` / `w:after`（twips）。12pt → 240。"""
    return int(round(pt * 20))


# ---------------------------------------------------------------------------
# 低层工具
# ---------------------------------------------------------------------------

def _tag_local(tag: str) -> str:
    """返回 `{ns}local` 形式标签的 local 名（无命名空间时原样返回）。"""
    if tag.startswith("{"):
        return tag.split("}", 1)[1]
    return tag


def _int(value: "str | None") -> "int | None":
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _err(code: str, message: str) -> dict:
    return {"code": code, "message": message}


def _truthy(value: "str | None") -> bool:
    """OOXML on/off 属性：**缺 `w:val` 即 on**；否则按 1/true/on 判真（合同 R118）。"""
    if value is None:
        return True
    return str(value).strip().lower() not in _FALSEY


def _rels_part_for(owner_part: "str | None") -> str:
    """部件路径 → 其关系部件路径。`word/document.xml` → `word/_rels/document.xml.rels`；
    `None` / `""`（包级）→ `_rels/.rels`。"""
    if owner_part in (None, ""):
        return PACKAGE_RELS_PART
    return posixpath.join(posixpath.dirname(owner_part), "_rels",
                          posixpath.basename(owner_part) + ".rels")


def _resolve_target(owner_part: str, target: str) -> str:
    """把关系 Target 解析成包内部件名（处理 `/` 绝对与 `..` 相对）。"""
    if target.startswith("/"):
        return posixpath.normpath(target.lstrip("/"))
    base = posixpath.dirname(owner_part)
    if base == "":
        return posixpath.normpath(target)
    return posixpath.normpath(posixpath.join(base, target))


# ---------------------------------------------------------------------------
# 格式读回（WCF-D10）
# ---------------------------------------------------------------------------

def _parse_toggle(node) -> dict:
    """开关型属性：**元素有无**与 `w:val` 原样分开报告（合同 R118）。"""
    if node is None:
        return {"present": False, "val": None, "effective": None}
    val = node.get(W + "val")
    return {"present": True, "val": val, "effective": _truthy(val)}


def _parse_rpr(rpr) -> dict:
    """解析 `w:rPr`。**没有 `w:rPr` 时仍返回同一套键**（全为 absent/null）。

    统一形状是有意的：调用方拿到 `props["b"]` 永远是一个 `{present, val, effective}` 对象，
    不必区分"没有 rPr"与"rPr 里没有 w:b"两种空——两者读回结果本就应当一致（合同 R118：
    没写就是"未指定"）。
    """
    def child(tag: str):
        return None if rpr is None else rpr.find(W + tag)

    fonts = child("rFonts")
    color = child("color")
    highlight = child("highlight")
    shd = child("shd")
    underline = child("u")
    vert = child("vertAlign")
    size = child("sz")
    size_cs = child("szCs")
    return {
        "b": _parse_toggle(child("b")),
        "i": _parse_toggle(child("i")),
        "strike": _parse_toggle(child("strike")),
        "u": {
            "present": underline is not None,
            "val": underline.get(W + "val", "single") if underline is not None else None,
        },
        "vertAlign": vert.get(W + "val") if vert is not None else None,
        "sz": _int(size.get(W + "val")) if size is not None else None,
        "szCs": _int(size_cs.get(W + "val")) if size_cs is not None else None,
        "rFonts": None if fonts is None else {
            slot: fonts.get(W + slot) for slot in ("ascii", "hAnsi", "eastAsia", "cs")
        },
        "color": None if color is None else {"val": color.get(W + "val")},
        "highlight": None if highlight is None else {"val": highlight.get(W + "val")},
        "shd": None if shd is None else {
            "val": shd.get(W + "val"), "color": shd.get(W + "color"), "fill": shd.get(W + "fill")
        },
    }


def _parse_ppr(ppr) -> dict:
    """解析 `w:pPr`。**没有 `w:pPr` 时仍返回同一套键**（全为 null），形状统一。"""
    def child(tag: str):
        return None if ppr is None else ppr.find(W + tag)

    style = child("pStyle")
    jc = child("jc")
    spacing = child("spacing")
    indent = child("ind")
    outline = child("outlineLvl")
    return {
        "pStyle": style.get(W + "val") if style is not None else None,
        "jc": jc.get(W + "val", "left") if jc is not None else None,
        "spacing": None if spacing is None else {
            "line": _int(spacing.get(W + "line")),
            "lineRule": spacing.get(W + "lineRule"),
            "before": _int(spacing.get(W + "before")),
            "after": _int(spacing.get(W + "after")),
            "beforeLines": _int(spacing.get(W + "beforeLines")),
            "afterLines": _int(spacing.get(W + "afterLines")),
        },
        "indent": None if indent is None else {
            key: _int(indent.get(W + key))
            for key in ("firstLine", "firstLineChars", "hanging", "hangingChars",
                        "left", "leftChars", "right", "rightChars")
        },
        "outlineLvl": _int(outline.get(W + "val")) if outline is not None else None,
    }


def _parse_run(run) -> dict:
    text = "".join(node.text or "" for node in run.iter() if _tag_local(node.tag) == "t")
    return {"text": text, "properties": _parse_rpr(run.find(W + "rPr"))}


def _parse_sectpr(sectpr) -> dict:
    page = sectpr.find(W + "pgSz")
    margins = sectpr.find(W + "pgMar")
    cols = sectpr.find(W + "cols")
    return {
        "page_size": None if page is None else {
            "w": _int(page.get(W + "w")), "h": _int(page.get(W + "h")), "orient": page.get(W + "orient")
        },
        "margins": None if margins is None else {
            key: _int(margins.get(W + key))
            for key in ("top", "right", "bottom", "left", "gutter", "header", "footer")
        },
        "columns": _int(cols.get(W + "num")) if cols is not None else None,
    }


def _parse_tables(root) -> list:
    tables = []
    for table in root.iter():
        if _tag_local(table.tag) != "tbl":
            continue
        grid = []
        grid_node = table.find(W + "tblGrid")
        if grid_node is not None:
            grid = [_int(col.get(W + "w")) for col in grid_node.findall(W + "gridCol")]
        rows = []
        for row in table.findall(W + "tr"):
            cells = []
            for cell in row.findall(W + "tc"):
                text = "".join(node.text or "" for node in cell.iter() if _tag_local(node.tag) == "t")
                span = cell.find(W + "tcPr/" + W + "gridSpan")
                cells.append({
                    "text": text,
                    "grid_span": _int(span.get(W + "val")) if span is not None else None,
                })
            rows.append(cells)
        tables.append({"grid": grid, "rows": rows})
    return tables


def _parse_format(root) -> dict:
    paragraphs = []
    for index, para in enumerate(node for node in root.iter() if _tag_local(node.tag) == "p"):
        text = "".join(node.text or "" for node in para.iter() if _tag_local(node.tag) == "t")
        ppr = para.find(W + "pPr")
        paragraphs.append({
            "index": index,
            "text": text,
            "properties": _parse_ppr(ppr),
            "runs": [_parse_run(run) for run in para.iter() if _tag_local(run.tag) == "r"],
        })
    body = root.find(W + "body")
    sections = []
    if body is not None:
        sectpr = body.find(W + "sectPr")
        if sectpr is not None:
            sections.append(_parse_sectpr(sectpr))
    for para in root.iter():
        if _tag_local(para.tag) != "p":
            continue
        ppr = para.find(W + "pPr")
        if ppr is None:
            continue
        sectpr = ppr.find(W + "sectPr")
        if sectpr is not None:
            sections.append(_parse_sectpr(sectpr))
    return {"paragraphs": paragraphs, "tables": _parse_tables(root), "sections": sections}


# ---------------------------------------------------------------------------
# 引用与审阅读回（WCF-D71，只读包内字节；**不抓取任何外部关系**，R161）
# ---------------------------------------------------------------------------

def _id_value(value: "str | None"):
    """id 属性 → int（可解析时），否则原样字符串。配对比较用得上，也保留非数字的原貌。"""
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return value


def _parse_rels(parts: dict, owner_part: "str | None") -> dict:
    """某部件的关系表：`{Id: {type,target,mode}}`。**只读字节**，不解析目标内容。"""
    raw = parts.get(_rels_part_for(owner_part))
    if raw is None:
        return {}
    try:
        root = ET.fromstring(raw)
    except Exception:  # noqa: BLE001 - 关系表坏了由别处判据报告，这里只求"读不到就空"
        return {}
    out = {}
    for rel in root:
        if _tag_local(rel.tag) != "Relationship":
            continue
        out[rel.get("Id")] = {
            "type": rel.get("Type"),
            "target": rel.get("Target"),
            "mode": rel.get("TargetMode", "Internal"),
        }
    return out


def _descendant_text(node, namespace: "str | None" = None) -> str:
    """子树里 `t` local 名的文本拼接。给了 namespace 只收该命名空间的 `t`。"""
    chunks = []
    for child in node.iter():
        if _tag_local(child.tag) != "t":
            continue
        if namespace is not None and not child.tag.startswith("{%s}" % namespace):
            continue
        if child.text:
            chunks.append(child.text)
    return "".join(chunks)


def _has_descendant(node, local: str) -> bool:
    return any(_tag_local(child.tag) == local for child in node.iter())


def _iter_field_nodes(root):
    """按文档顺序产出域相关节点 `(kind, node)`；**跳过 `w:fldSimple` 子树**
    （简单域单独处理，免得它的缓存文字被算进正在扫描的复杂域）。"""
    def walk(node):
        for child in list(node):
            local = _tag_local(child.tag)
            if local == "fldSimple":
                continue
            if local in ("fldChar", "instrText"):
                yield local, child
            elif local == "t":
                yield "t", child
            yield from walk(child)

    return walk(root)


def _classify_field(kind: str, instruction: str, cached: str, dirty: bool) -> dict:
    """把「有指令 / 有缓存 / 已刷新」**三态分开**，再合成一个可判的状态串（R158）。"""
    has_instruction = bool(instruction and instruction.strip())
    has_cache = cached is not None and cached != ""
    # `w:dirty` 缺席 = 声称"已刷新"；`w:dirty="true"` = **显式未刷新**（R158 的显式标记）。
    refreshed = (not dirty) and has_cache
    if not has_instruction:
        state = "no_instruction"
    elif not has_cache:
        state = "instruction_no_cache"
    elif dirty:
        state = "cached_not_refreshed"
    else:
        state = "refreshed"
    return {
        "kind": kind,
        "instruction": instruction if instruction else None,
        "has_instruction": has_instruction,
        "cached_text": cached if has_cache else None,
        "has_cache": has_cache,
        "dirty": bool(dirty),
        "refreshed": bool(refreshed),
        "state": state,
    }


def _parse_references(parts: dict, root) -> dict:
    """解析书签 / 超链接 / 域 / 脚注尾注 / 批注 / 修订 / 公式 / 图表。"""
    doc_rels = _parse_rels(parts, MAIN_PART)

    starts = []
    ends = []
    for node in root.iter():
        local = _tag_local(node.tag)
        if local == "bookmarkStart":
            starts.append({"id": _id_value(node.get(W + "id")), "name": node.get(W + "name")})
        elif local == "bookmarkEnd":
            ends.append({"id": _id_value(node.get(W + "id"))})
    start_ids = [item["id"] for item in starts if item["id"] is not None]
    end_ids = [item["id"] for item in ends if item["id"] is not None]
    bookmark_names = {item["name"] for item in starts if item["name"]}
    bookmarks = {
        "starts": starts,
        "ends": end_ids,
        "names": sorted(bookmark_names),
        "paired": bool(start_ids) and not [i for i in start_ids if i not in end_ids]
                  and not [i for i in end_ids if i not in start_ids],
        "unpaired_start_ids": sorted({i for i in start_ids if i not in end_ids}, key=str),
        "unpaired_end_ids": sorted({i for i in end_ids if i not in start_ids}, key=str),
        "duplicate_start_ids": sorted({i for i in start_ids if start_ids.count(i) > 1}, key=str),
    }

    # --- 超链接 ---------------------------------------------------------------
    hyperlinks = []
    external_targets = []
    dangling_anchors = []
    unbound_hyperlinks = []
    for node in root.iter():
        if _tag_local(node.tag) != "hyperlink":
            continue
        index = len(hyperlinks)
        rel_id = node.get(R + "id")
        anchor = node.get(W + "anchor")
        tooltip = node.get(W + "tooltip")
        rel = doc_rels.get(rel_id) if rel_id is not None else None
        target = rel.get("target") if rel else None
        mode = rel.get("mode") if rel else None
        if rel_id is not None and rel is None:
            kind = "dangling_relationship"
        elif rel_id is not None and mode == "External":
            kind = "external"
            # **如实标出，绝不抓取**（R161）。这里只记录 Target 字符串。
            external_targets.append({"relationship_id": rel_id, "target": target})
        elif rel_id is not None:
            kind = "relationship"
        elif anchor is not None:
            kind = "internal"
        else:
            kind = "unbound"
            unbound_hyperlinks.append(index)
        resolves = None
        if anchor is not None:
            resolves = anchor in bookmark_names
            if not resolves:
                dangling_anchors.append(anchor)
        hyperlinks.append({
            "index": index,
            "kind": kind,
            "relationship_id": rel_id,
            "anchor": anchor,
            "anchor_resolves": resolves,
            "tooltip": tooltip,
            "target": target,
            "target_mode": mode,
        })
    # 包里**所有**外部关系（不只被超链接引用的）——R161 的透明账。
    external_rels = [
        {"id": rid, "type": rel["type"], "target": rel["target"]}
        for rid, rel in sorted(doc_rels.items()) if rel["mode"] == "External"
    ]

    # --- 域 -------------------------------------------------------------------
    fields = []
    for node in root.iter():
        if _tag_local(node.tag) != "fldSimple":
            continue
        instruction = node.get(W + "instr") or ""
        cached = _descendant_text(node)
        dirty = _truthy(node.get(W + "dirty")) if node.get(W + "dirty") is not None else False
        fields.append(_classify_field("simple", instruction, cached, dirty))
    open_field = None
    counts = {"begin": 0, "separate": 0, "end": 0}
    for kind, node in _iter_field_nodes(root):
        if kind == "fldChar":
            ftype = node.get(W + "fldCharType")
            if ftype in counts:
                counts[ftype] += 1
            if ftype == "begin":
                dirty = node.get(W + "dirty") is not None and _truthy(node.get(W + "dirty"))
                open_field = {"instruction": "", "cached": "", "dirty": dirty, "separate": False}
            elif ftype == "separate" and open_field is not None:
                open_field["separate"] = True
            elif ftype == "end" and open_field is not None:
                fields.append(_classify_field(
                    "complex", open_field["instruction"], open_field["cached"],
                    open_field["dirty"]))
                open_field = None
        elif kind == "instrText" and open_field is not None and not open_field["separate"]:
            open_field["instruction"] += node.text or ""
        elif kind == "t" and open_field is not None and open_field["separate"]:
            open_field["cached"] += node.text or ""
    field_pairing = {
        "begin": counts["begin"],
        "separate": counts["separate"],
        "end": counts["end"],
        "balanced": counts["begin"] == counts["end"] and counts["separate"] <= counts["begin"],
        "unclosed": open_field is not None,
    }

    # --- 脚注 / 尾注 -----------------------------------------------------------
    def note_group(kind: str) -> dict:
        ref_tag = "footnoteReference" if kind == "footnote" else "endnoteReference"
        part_path = FOOTNOTES_PART if kind == "footnote" else ENDNOTES_PART
        item_tag = "footnote" if kind == "footnote" else "endnote"
        rel_type = REL_BASE + "/" + ("footnotes" if kind == "footnote" else "endnotes")
        reference_ids = []
        for node in root.iter():
            if _tag_local(node.tag) == ref_tag:
                reference_ids.append(_id_value(node.get(W + "id")))
        present = part_path in parts
        ids_in_part = []
        has_separators = False
        if present:
            try:
                part_root = ET.fromstring(parts[part_path])
                for child in part_root:
                    if _tag_local(child.tag) != item_tag:
                        continue
                    ids_in_part.append(_id_value(child.get(W + "id")))
                    if child.get(W + "type") in ("separator", "continuationSeparator"):
                        has_separators = True
            except Exception:  # noqa: BLE001
                present = "unparsable"
        rel = next((rid for rid, item in doc_rels.items() if item["type"] == rel_type), None)
        relationship = (
            rel is not None
            and _resolve_target(MAIN_PART, doc_rels[rel]["target"] or "") == part_path
        )
        real_ids = [i for i in ids_in_part if isinstance(i, int) and i > 0]
        return {
            "part": part_path,
            "present": present is True,
            "relationship": relationship,
            "reference_ids": reference_ids,
            "note_ids": ids_in_part,
            "has_separators": has_separators,
            "dangling_reference_ids": [i for i in reference_ids if i not in ids_in_part],
            "unreferenced_note_ids": [i for i in real_ids if i not in reference_ids],
        }

    footnotes = note_group("footnote")
    endnotes = note_group("endnote")
    notes = {
        "footnote_references": footnotes["reference_ids"],
        "endnote_references": endnotes["reference_ids"],
        "footnotes": footnotes,
        "endnotes": endnotes,
    }

    # --- 批注 -----------------------------------------------------------------
    range_start_ids = []
    range_end_ids = []
    reference_ids = []
    for node in root.iter():
        local = _tag_local(node.tag)
        if local == "commentRangeStart":
            range_start_ids.append(_id_value(node.get(W + "id")))
        elif local == "commentRangeEnd":
            range_end_ids.append(_id_value(node.get(W + "id")))
        elif local == "commentReference":
            reference_ids.append(_id_value(node.get(W + "id")))
    comments_present = COMMENTS_PART in parts
    comment_ids = []
    if comments_present:
        try:
            comments_root = ET.fromstring(parts[COMMENTS_PART])
            for child in comments_root:
                if _tag_local(child.tag) == "comment":
                    comment_ids.append(_id_value(child.get(W + "id")))
        except Exception:  # noqa: BLE001
            comments_present = "unparsable"
    comments_rel = next(
        (rid for rid, item in doc_rels.items() if item["type"] == REL_BASE + "/comments"), None)
    comments = {
        "part": COMMENTS_PART,
        "part_present": comments_present is True,
        "relationship": comments_rel is not None and _resolve_target(
            MAIN_PART, doc_rels[comments_rel]["target"] or "") == COMMENTS_PART,
        "range_start_ids": range_start_ids,
        "range_end_ids": range_end_ids,
        "reference_ids": reference_ids,
        "paired_range_ids": sorted({i for i in range_start_ids if i in range_end_ids}, key=str),
        "unpaired_range_start_ids": [i for i in range_start_ids if i not in range_end_ids],
        "unpaired_range_end_ids": [i for i in range_end_ids if i not in range_start_ids],
        "comment_ids": comment_ids,
        "dangling_reference_ids": [i for i in reference_ids if i not in comment_ids],
        "unreferenced_comment_ids": [i for i in comment_ids if i not in reference_ids],
    }

    # --- 修订 -----------------------------------------------------------------
    revision_entries = []
    del_with_t = 0
    del_text_count = 0
    for node in root.iter():
        local = _tag_local(node.tag)
        if local in ("ins", "del"):
            text = _descendant_text(node)
            revision_entries.append({
                "kind": local,
                "id": _id_value(node.get(W + "id")),
                "author": node.get(W + "author"),
                "date": node.get(W + "date"),
                "text": text,
                "uses_del_text": _has_descendant(node, "delText"),
            })
        elif local == "delText":
            del_text_count += 1
    for entry in revision_entries:
        if entry["kind"] == "del" and not entry["uses_del_text"]:
            del_with_t += 1
    revisions = {
        "ins": sum(1 for item in revision_entries if item["kind"] == "ins"),
        "del": sum(1 for item in revision_entries if item["kind"] == "del"),
        "del_text": del_text_count,
        "del_without_del_text": del_with_t,
        "authors": sorted({item["author"] for item in revision_entries if item["author"]}),
        "entries": revision_entries,
    }

    # --- 公式（OMML）----------------------------------------------------------
    structures = []
    math_count = 0
    for node in root.iter():
        if _tag_local(node.tag) == "oMath":
            math_count += 1
    for node in root.iter():
        local = _tag_local(node.tag)
        if not node.tag.startswith("{%s}" % M_NS):
            continue
        if local == "f":
            num = node.find("{%s}num" % M_NS)
            den = node.find("{%s}den" % M_NS)
            structures.append({
                "kind": "fraction",
                "numerator": _descendant_text(num, M_NS) if num is not None else None,
                "denominator": _descendant_text(den, M_NS) if den is not None else None,
            })
        elif local == "rad":
            deg = node.find("{%s}deg" % M_NS)
            body = node.find("{%s}e" % M_NS)
            structures.append({
                "kind": "radical",
                "degree": _descendant_text(deg, M_NS) if deg is not None else None,
                "radicand": _descendant_text(body, M_NS) if body is not None else None,
            })
    math = {"count": math_count, "structures": structures}

    # --- 图表 -----------------------------------------------------------------
    charts = []
    chart_rel_ids = {rid: item for rid, item in doc_rels.items()
                     if item["type"] == REL_BASE + "/chart"}
    for name in sorted(parts):
        if not (name.startswith(CHARTS_PREFIX) and name.endswith(".xml")):
            continue
        series = 0
        points = 0
        try:
            chart_root = ET.fromstring(parts[name])
            for node in chart_root.iter():
                if _tag_local(node.tag) == "ser":
                    series += 1
                elif _tag_local(node.tag) == "pt":
                    points += 1
        except Exception:  # noqa: BLE001
            series = points = None
        rel_id = next((rid for rid, item in chart_rel_ids.items()
                       if _resolve_target(MAIN_PART, item["target"] or "") == name), None)
        charts.append({
            "part": name,
            "relationship_id": rel_id,
            "relationship": rel_id is not None,
            "series": series,
            "points": points,
        })

    return {
        "bookmarks": bookmarks,
        "hyperlinks": hyperlinks,
        "external_rels": external_rels,
        "external_targets": external_targets,
        "dangling_anchors": dangling_anchors,
        "unbound_hyperlinks": unbound_hyperlinks,
        "fields": fields,
        "field_pairing": field_pairing,
        "notes": notes,
        "comments": comments,
        "revisions": revisions,
        "math": math,
        "charts": charts,
    }


# 本工具**有语义解析**的元素 local name（document.xml）。不在这张表里的元素会进
# `coverage.unparsed_elements`——**显式列出**，不是静默放过。
_PARSED_ELEMENT_LOCALS = frozenset({
    "document", "body",
    "p", "pPr", "rPr", "r", "t", "br", "tab",
    "tbl", "tblPr", "tblW", "tblGrid", "gridCol", "tr", "tc", "tcPr", "gridSpan", "trPr", "tcW",
    "sectPr", "pgSz", "pgMar", "cols", "type",
    "pStyle", "jc", "spacing", "ind", "outlineLvl",
    "rFonts", "color", "highlight", "shd", "u", "vertAlign", "sz", "szCs", "b", "i", "strike",
    "bookmarkStart", "bookmarkEnd",
    "hyperlink", "tooltip",
    "fldSimple", "instrText", "fldChar",
    "footnoteReference", "endnoteReference",
    "commentRangeStart", "commentRangeEnd", "commentReference",
    "ins", "del", "delText",
})

# 注记/批注部件里有语义解析的元素（脚注尾注 id、批注 id、注文正文与分隔符）。
_ANNOTATION_ELEMENT_LOCALS = _PARSED_ELEMENT_LOCALS | frozenset({
    "footnotes", "endnotes", "comments", "footnote", "endnote", "comment",
    "footnoteRef", "endnoteRef", "separator", "continuationSeparator", "delText",
})

# 已知的读回范围边界——**写出来**，不让它变成"没报错所以没问题"。
_COVERAGE_NOTES = (
    "document.xml / footnotes.xml / endnotes.xml / comments.xml：逐元素 local name 核对，"
    "不在已解析集合里的一律列进 unparsed_elements。",
    "图表部件（word/charts/*.xml）：只读系列数（c:ser）与数据点数（c:pt），"
    "图表 XML 的其余元素**不解析**；图表部件内部的元素清单不进 unparsed_elements"
    "（图表靠部件 + 关系表判定，不看正文里的 drawing 节点）。",
    "正文里的 drawing / graphic 树（图片、图形节点）**不解析**——它们会出现在 "
    "unparsed_elements 里，不静默放过。",
    "批注部件内的回复列表 / 已解决状态（w15 扩展）**不解析**（WCF-D60 缺口 5）。",
    "本工具**不抓取任何外部关系**（R161）：TargetMode=\"External\" 只记录 Target 字符串，"
    "没有任何网络或磁盘访问。",
)

_MATH_ELEMENT_LOCALS = frozenset({
    "oMath", "oMathPara", "f", "num", "den", "rad", "deg", "e", "r", "t", "sSup", "sSub",
    "sSubSup", "sPre", "nary", "sub", "sup", "d", "func", "fName", "limLow", "limUpp", "acc",
    "bar", "box", "groupChr", "mPr", "ctrlPr", "argPr", "rPr",
})


def _collect_unparsed(parts: dict) -> dict:
    """逐部件列出"出现过、但没有语义解析"的元素 local name。**不含注释/文本节点**。"""
    report = {}
    for name in (MAIN_PART, FOOTNOTES_PART, ENDNOTES_PART, COMMENTS_PART):
        raw = parts.get(name)
        if raw is None:
            continue
        try:
            root = ET.fromstring(raw)
        except Exception:  # noqa: BLE001
            continue
        recognized = (_PARSED_ELEMENT_LOCALS if name == MAIN_PART
                      else _ANNOTATION_ELEMENT_LOCALS)
        unparsed = set()
        for node in root.iter():
            local = _tag_local(node.tag)
            if node.tag.startswith("{%s}" % M_NS):
                if local not in _MATH_ELEMENT_LOCALS and local != "document":
                    unparsed.add(local)
                continue
            if local not in recognized:
                unparsed.add(local)
        if unparsed:
            report[name] = sorted(unparsed)
    return report


# ---------------------------------------------------------------------------
# 期望判据（--expect）
# ---------------------------------------------------------------------------

def _expect_sha256(data: bytes, expectation: dict) -> tuple:
    want = expectation.get("sha256")
    if not want:
        return None
    got = hashlib.sha256(data).hexdigest()
    return got == want, "expected=%s actual=%s" % (want, got)


def _expect_required_parts(names: list, expectation: dict) -> tuple:
    want = expectation.get("required_parts")
    if want is None:
        return None
    missing = sorted(set(want) - set(names))
    extra = sorted(set(names) - set(want))
    return (not missing and not extra), "missing=%s unexpected=%s" % (missing, extra)


def _expect_deflate(entry_details: dict, expectation: dict) -> tuple:
    want = expectation.get("deflate_parts")
    if not want:
        return None
    bad = {name: entry_details.get(name, "MISSING") for name in want
           if entry_details.get(name) != "deflate"}
    return (not bad), "not_deflate=%s" % bad


def _expect_relationships(parts: dict, expectation: dict) -> tuple:
    want = expectation.get("relationships")
    if want is None:
        return None
    problems = []
    for item in want:
        owner = item.get("owner_part_path")
        rels_part = _rels_part_for(owner)
        raw = parts.get(rels_part)
        if raw is None:
            problems.append("%s: rels part %s missing" % (item.get("id"), rels_part))
            continue
        try:
            rels_root = ET.fromstring(raw)
        except Exception as exc:  # noqa: BLE001
            problems.append("%s: rels unparsable (%s)" % (item.get("id"), exc))
            continue
        matches = [rel for rel in rels_root
                   if rel.get("Id") == item.get("id")]
        if len(matches) != 1:
            problems.append("%s: rel id found %d times" % (item.get("id"), len(matches)))
            continue
        rel = matches[0]
        if item.get("type") and rel.get("Type") != item["type"]:
            problems.append("%s: type %s != %s" % (item.get("id"), rel.get("Type"), item["type"]))
        mode = rel.get("TargetMode", "Internal")
        if item.get("target_mode") and mode != item["target_mode"]:
            problems.append("%s: target_mode %s != %s" % (item.get("id"), mode, item["target_mode"]))
        if item.get("target") and rel.get("Target") != item["target"]:
            problems.append("%s: target %s != %s" % (item.get("id"), rel.get("Target"), item["target"]))
        # 内部关系的目标部件必须真的存在（合同 R160：无悬空 rId）
        if mode == "Internal":
            resolved = _resolve_target(owner or "", rel.get("Target") or "")
            if resolved not in parts:
                problems.append("%s: internal target %s missing from package"
                                % (item.get("id"), resolved))
    return (not problems), "; ".join(problems) if problems else "ok"


def _expect_sections(format_data: dict, expectation: dict) -> tuple:
    want = expectation.get("sections")
    if want is None:
        return None
    problems = []
    got = format_data["sections"]
    if len(got) != len(want):
        problems.append("section count expected=%d actual=%d" % (len(want), len(got)))
    for index, expected in enumerate(want):
        actual = got[index] if index < len(got) else None
        if actual is None:
            continue
        for group in ("page_size", "margins"):
            if expected.get(group) is None:
                continue
            if actual.get(group) is None:
                problems.append("section[%d].%s missing" % (index, group))
                continue
            for key, value in expected[group].items():
                if actual[group].get(key) != value:
                    problems.append("section[%d].%s.%s expected=%r actual=%r"
                                    % (index, group, key, value, actual[group].get(key)))
        if expected.get("columns") is not None and actual.get("columns") != expected["columns"]:
            problems.append("section[%d].columns expected=%r actual=%r"
                            % (index, expected["columns"], actual.get("columns")))
    return (not problems), "; ".join(problems) if problems else "ok"


def _semantic_line_spacing(spec: dict) -> tuple:
    """把期望里的行距语义翻译成（合法）的 (line, lineRule) —— **本工具自己按规范复算**。"""
    if spec.get("multiple") is not None:
        return line_twips_multiple(spec["multiple"]), "auto"
    if spec.get("exact_pt") is not None:
        return line_twips_exact(spec["exact_pt"]), "exact"
    if spec.get("at_least_pt") is not None:
        return line_twips_at_least(spec["at_least_pt"]), "atLeast"
    if spec.get("raw"):
        return spec["raw"].get("line"), spec["raw"].get("lineRule")
    return None, None


def _expect_paragraph_text(format_data: dict, expectation: dict) -> tuple:
    want = expectation.get("paragraphs")
    if want is None:
        return None
    problems = []
    got = format_data["paragraphs"]
    count = expectation.get("paragraph_count")
    if count is not None and len(got) != count:
        problems.append("paragraph count expected=%d actual=%d" % (count, len(got)))
    for expected in want:
        index = expected.get("index")
        if index is None or index >= len(got):
            problems.append("paragraph[%r] out of range (actual=%d)" % (index, len(got)))
            continue
        actual = got[index]
        if expected.get("text") is not None and actual["text"] != expected["text"]:
            problems.append("paragraph[%d].text expected=%r actual=%r"
                            % (index, expected["text"], actual["text"]))
        if "style" in expected and actual["properties"].get("pStyle") != expected["style"]:
            problems.append("paragraph[%d].pStyle expected=%r actual=%r"
                            % (index, expected["style"], actual["properties"].get("pStyle")))
        if "align" in expected and actual["properties"].get("jc") != expected["align"]:
            problems.append("paragraph[%d].jc expected=%r actual=%r"
                            % (index, expected["align"], actual["properties"].get("jc")))
        if "outline_level" in expected:
            if actual["properties"].get("outlineLvl") != expected["outline_level"]:
                problems.append("paragraph[%d].outlineLvl expected=%r actual=%r"
                                % (index, expected["outline_level"],
                                   actual["properties"].get("outlineLvl")))
    return (not problems), "; ".join(problems) if problems else "ok"


def _expect_paragraph_spacing(format_data: dict, expectation: dict) -> tuple:
    want = expectation.get("paragraphs")
    if want is None:
        return None
    problems = []
    got = format_data["paragraphs"]
    for expected in want:
        index = expected.get("index")
        if index is None or index >= len(got):
            continue
        actual = got[index]["properties"].get("spacing")
        spec = expected.get("line_spacing")
        if spec is not None:
            if actual is None:
                problems.append("paragraph[%d].spacing missing" % index)
            else:
                line, rule = _semantic_line_spacing(spec)
                if line is not None and actual.get("line") != line:
                    problems.append("paragraph[%d].line expected=%r actual=%r"
                                    % (index, line, actual.get("line")))
                if rule is not None and actual.get("lineRule") != rule:
                    problems.append("paragraph[%d].lineRule expected=%r actual=%r"
                                    % (index, rule, actual.get("lineRule")))
        for key, field in (("before_pt", "before"), ("after_pt", "after")):
            if expected.get(key) is not None:
                if actual is None:
                    problems.append("paragraph[%d].spacing missing" % index)
                elif actual.get(field) != spacing_twips(expected[key]):
                    problems.append("paragraph[%d].%s expected=%r actual=%r"
                                    % (index, field, spacing_twips(expected[key]), actual.get(field)))
    return (not problems), "; ".join(problems) if problems else "ok"


def _expect_paragraph_indent(format_data: dict, expectation: dict) -> tuple:
    """缩进判据：**字符与长度分开**（合同 R130）——`first_line_chars` 只认 `w:firstLineChars`。"""
    want = expectation.get("paragraphs")
    if want is None:
        return None
    problems = []
    got = format_data["paragraphs"]
    for expected in want:
        index = expected.get("index")
        spec = expected.get("indent")
        if index is None or index >= len(got) or spec is None:
            continue
        actual = got[index]["properties"].get("indent")
        if actual is None:
            problems.append("paragraph[%d].indent missing (expected=%r)" % (index, spec))
            continue
        if spec.get("first_line_chars") is not None:
            want_chars = first_line_chars(spec["first_line_chars"])
            if actual.get("firstLineChars") != want_chars:
                problems.append(
                    "paragraph[%d].firstLineChars expected=%r actual=%r "
                    "(w:firstLine=%r is a twips length, NOT a char count)"
                    % (index, want_chars, actual.get("firstLineChars"), actual.get("firstLine")))
        if spec.get("first_line_twips") is not None:
            if actual.get("firstLine") != spec["first_line_twips"]:
                problems.append("paragraph[%d].firstLine expected=%r actual=%r"
                                % (index, spec["first_line_twips"], actual.get("firstLine")))
        if spec.get("left_chars") is not None:
            if actual.get("leftChars") != first_line_chars(spec["left_chars"]):
                problems.append("paragraph[%d].leftChars expected=%r actual=%r"
                                % (index, first_line_chars(spec["left_chars"]),
                                   actual.get("leftChars")))
        if spec.get("hanging_chars") is not None:
            if actual.get("hangingChars") != first_line_chars(spec["hanging_chars"]):
                problems.append("paragraph[%d].hangingChars expected=%r actual=%r"
                                % (index, first_line_chars(spec["hanging_chars"]),
                                   actual.get("hangingChars")))
    return (not problems), "; ".join(problems) if problems else "ok"


def _compare_text(expected, actual, label) -> list:
    problems = []
    if expected.get("text") is not None and actual.get("text") != expected["text"]:
        problems.append("%s.text expected=%r actual=%r" % (label, expected["text"], actual["text"]))
    return problems


def _expect_run_properties(format_data: dict, expectation: dict) -> tuple:
    want = expectation.get("paragraphs")
    if want is None:
        return None
    problems = []
    got = format_data["paragraphs"]
    for expected in want:
        index = expected.get("index")
        if index is None or index >= len(got):
            continue
        actual_runs = got[index]["runs"]
        for run_index, run_spec in enumerate(expected.get("runs", [])):
            label = "paragraph[%d].run[%d]" % (index, run_index)
            if run_index >= len(actual_runs):
                problems.append("%s missing (actual runs=%d)" % (label, len(actual_runs)))
                continue
            actual = actual_runs[run_index]
            problems.extend(_compare_text(run_spec, actual, label))
            props = actual["properties"]
            for key, field in (("bold", "b"), ("italic", "i"), ("strike", "strike")):
                if key not in run_spec:
                    continue
                expected_value = run_spec[key]
                node = props.get(field) or {"present": False, "val": None, "effective": None}
                if expected_value is None:
                    # 期望"**没有**该元素"（继承样式）——与显式关闭不同（合同 R118）
                    if node["present"]:
                        problems.append("%s.%s expected=ABSENT actual=<%s w:val=%r>"
                                        % (label, key, field, node["val"]))
                elif expected_value is False:
                    if not node["present"] or node["effective"]:
                        problems.append("%s.%s expected=explicit-off actual=present:%r effective=%r"
                                        % (label, key, node["present"], node["effective"]))
                else:
                    if not (node["present"] and node["effective"]):
                        problems.append("%s.%s expected=on actual=present:%r effective=%r"
                                        % (label, key, node["present"], node["effective"]))
            if "underline" in run_spec:
                expected_value = run_spec["underline"]
                node = props.get("u") or {"present": False, "val": None}
                if expected_value is None:
                    if node["present"]:
                        problems.append("%s.underline expected=ABSENT actual=%r" % (label, node["val"]))
                elif node.get("val") != expected_value:
                    problems.append("%s.underline expected=%r actual=%r"
                                    % (label, expected_value, node.get("val")))
            if run_spec.get("size_pt") is not None:
                want_sz = half_points(run_spec["size_pt"])
                if props.get("sz") != want_sz:
                    problems.append("%s.sz expected=%r (~%rpt) actual=%r"
                                    % (label, want_sz, run_spec["size_pt"], props.get("sz")))
            if run_spec.get("size_half_points") is not None:
                if props.get("sz") != run_spec["size_half_points"]:
                    problems.append("%s.sz expected=%r actual=%r"
                                    % (label, run_spec["size_half_points"], props.get("sz")))
            if "fonts" in run_spec:
                expected_fonts = run_spec["fonts"]
                actual_fonts = props.get("rFonts")
                if actual_fonts is None:
                    problems.append("%s.rFonts missing (expected=%r)" % (label, expected_fonts))
                else:
                    for slot, value in expected_fonts.items():
                        if actual_fonts.get(slot) != value:
                            problems.append("%s.rFonts.%s expected=%r actual=%r"
                                            % (label, slot, value, actual_fonts.get(slot)))
            if "color" in run_spec:
                expected_color = run_spec["color"]
                actual_color = (props.get("color") or {}).get("val")
                if expected_color is None:
                    if props.get("color") is not None:
                        problems.append("%s.color expected=ABSENT actual=%r" % (label, actual_color))
                elif actual_color != expected_color:
                    problems.append("%s.color expected=%r actual=%r"
                                    % (label, expected_color, actual_color))
            if "highlight" in run_spec:
                expected_hl = run_spec["highlight"]
                actual_hl = (props.get("highlight") or {}).get("val")
                if expected_hl is None:
                    if props.get("highlight") is not None:
                        problems.append("%s.highlight expected=ABSENT actual=%r" % (label, actual_hl))
                elif actual_hl != expected_hl:
                    problems.append("%s.highlight expected=%r actual=%r"
                                    % (label, expected_hl, actual_hl))
            if "shading" in run_spec:
                expected_shd = run_spec["shading"]
                actual_shd = props.get("shd")
                if expected_shd is None:
                    if actual_shd is not None:
                        problems.append("%s.shd expected=ABSENT actual=%r" % (label, actual_shd))
                else:
                    for key in ("val", "color", "fill"):
                        if key in expected_shd and (actual_shd or {}).get(key) != expected_shd[key]:
                            problems.append("%s.shd.%s expected=%r actual=%r"
                                            % (label, key, expected_shd[key], (actual_shd or {}).get(key)))
    return (not problems), "; ".join(problems) if problems else "ok"


def _expect_tables(format_data: dict, expectation: dict) -> tuple:
    want = expectation.get("tables")
    if want is None:
        return None
    problems = []
    got = format_data["tables"]
    if len(got) != len(want):
        problems.append("table count expected=%d actual=%d" % (len(want), len(got)))
    for index, expected in enumerate(want):
        if index >= len(got):
            continue
        actual = got[index]
        if expected.get("grid") is not None and actual["grid"] != expected["grid"]:
            problems.append("table[%d].grid expected=%r actual=%r"
                            % (index, expected["grid"], actual["grid"]))
        if expected.get("cell_texts") is not None:
            texts = [[cell["text"] for cell in row] for row in actual["rows"]]
            if texts != expected["cell_texts"]:
                problems.append("table[%d].cell_texts expected=%r actual=%r"
                                % (index, expected["cell_texts"], texts))
    return (not problems), "; ".join(problems) if problems else "ok"


def _expect_units_recompute(format_data: dict, expectation: dict) -> tuple:
    """**独立复算**判据（合同 R128）：原文件的原始属性必须等于本工具按规范算出的值。

    与本工具其余判据不同，这里对照的不是"期望文件声明的数字"，而是**由语义量现算**的
    数字——例如期望写 `size_pt=12`，这里验的是文件里的 `w:sz` 恰好是 `2*12`。
    生产实现若把 12pt 写成 `w:sz=12` 或把 1.5 倍行距写成 `w:line=240`，会被这条抓住。
    """
    want = expectation.get("paragraphs")
    if want is None:
        return None
    problems = []
    got = format_data["paragraphs"]
    for expected in want:
        index = expected.get("index")
        if index is None or index >= len(got):
            continue
        props = got[index]["properties"]
        spacing = props.get("spacing")
        spec = expected.get("line_spacing")
        if spec is not None and spacing is not None:
            line, rule = _semantic_line_spacing(spec)
            if line is not None and spacing.get("line") != line:
                problems.append("p[%d] line: 规范复算 %r != 文件 %r" % (index, line, spacing.get("line")))
            if rule is not None and spacing.get("lineRule") != rule:
                problems.append("p[%d] lineRule: 规范复算 %r != 文件 %r"
                                % (index, rule, spacing.get("lineRule")))
        indent = props.get("indent")
        spec_indent = expected.get("indent")
        if spec_indent is not None and spec_indent.get("first_line_chars") is not None and indent is not None:
            want_chars = first_line_chars(spec_indent["first_line_chars"])
            if indent.get("firstLineChars") != want_chars:
                problems.append("p[%d] firstLineChars: 规范复算 %r != 文件 %r"
                                % (index, want_chars, indent.get("firstLineChars")))
        for run_index, run_spec in enumerate(expected.get("runs", [])):
            if run_index >= len(got[index]["runs"]):
                continue
            actual_sz = got[index]["runs"][run_index]["properties"].get("sz")
            for key, fn in (("size_pt", half_points),):
                if run_spec.get(key) is not None and actual_sz != fn(run_spec[key]):
                    problems.append("p[%d].r[%d].sz: 规范复算 %r != 文件 %r"
                                    % (index, run_index, fn(run_spec[key]), actual_sz))
    return (not problems), "; ".join(problems) if problems else "ok"


def _expect_part_content_types(parts: dict, expectation: dict) -> tuple:
    """判据：声明部件在包内的**有效内容类型**必须等于声明值。

    有效类型的求法按 OPC：先看 `<Override PartName=...>` 精确匹配，否则回落到
    `<Default Extension=...>` 按扩展名匹配。

    **这条抓的正是**"关系指向一个部件、但该部件只靠 Default 拿到一个与关系类型不符的 MIME"
    这类残缺包——它是真实 Word 拒绝打开（24601）的根因，本轮就是被它绊倒的，
    所以补成常驻判据。
    """
    want = expectation.get("content_types")
    if want is None:
        return None
    raw = parts.get(CONTENT_TYPES_PART)
    if raw is None:
        return False, "缺少 %s" % CONTENT_TYPES_PART
    try:
        root = ET.fromstring(raw)
    except Exception as exc:  # noqa: BLE001
        return False, "解析 %s 失败：%s" % (CONTENT_TYPES_PART, exc)

    overrides = {}
    defaults = {}
    for node in root:
        local = _tag_local(node.tag)
        if local == "Override":
            overrides[(node.get("PartName") or "").lstrip("/")] = node.get("ContentType")
        elif local == "Default":
            defaults[(node.get("Extension") or "").lower()] = node.get("ContentType")

    problems = []
    for part, declared in want.items():
        name = part.lstrip("/")
        extension = name.rsplit(".", 1)[-1].lower() if "." in name else ""
        effective = overrides.get(name, defaults.get(extension))
        if effective != declared:
            problems.append("%s effective=%r declared=%r (override=%r default=%r)"
                            % (part, effective, declared, overrides.get(name),
                               defaults.get(extension)))
    return (not problems), "; ".join(problems) if problems else "ok"


# ---------------------------------------------------------------------------
# 引用/审阅判据（WCF-D71）
# ---------------------------------------------------------------------------

def _expect_bookmarks(references: dict, expectation: dict) -> tuple:
    """书签判据：`w:id` 配对（有 start 必须有同 id 的 end）、名称、重复 id。"""
    want = expectation.get("bookmarks")
    if want is None:
        return None
    got = references.get("bookmarks") or {}
    problems = []
    for key in ("paired", "unpaired_start_ids", "unpaired_end_ids", "duplicate_start_ids"):
        if key in want and got.get(key) != want[key]:
            problems.append("bookmarks.%s expected=%r actual=%r" % (key, want[key], got.get(key)))
    if "names" in want and sorted(got.get("names") or []) != sorted(want["names"]):
        problems.append("bookmarks.names expected=%r actual=%r" % (sorted(want["names"]),
                                                                   sorted(got.get("names") or [])))
    if "starts" in want:
        actual = [(item.get("id"), item.get("name")) for item in got.get("starts") or []]
        expected = [(item.get("id"), item.get("name")) for item in want["starts"]]
        if actual != expected:
            problems.append("bookmarks.starts expected=%r actual=%r" % (expected, actual))
    if "end_count" in want and len(got.get("ends") or []) != want["end_count"]:
        problems.append("bookmarks.end_count expected=%r actual=%r"
                        % (want["end_count"], len(got.get("ends") or [])))
    return (not problems), "; ".join(problems) if problems else "ok"


def _expect_hyperlinks(references: dict, expectation: dict) -> tuple:
    """超链接判据：内/外分流、外部目标如实记录、内部锚点**必须对上书签**。"""
    want = expectation.get("hyperlinks")
    if want is None:
        return None
    got = references.get("hyperlinks") or []
    problems = []
    if len(got) != len(want):
        problems.append("hyperlinks count expected=%d actual=%d" % (len(want), len(got)))
    for index, expected in enumerate(want):
        if index >= len(got):
            continue
        actual = got[index]
        for key in ("kind", "relationship_id", "anchor", "anchor_resolves", "target",
                    "target_mode", "tooltip"):
            if key in expected and actual.get(key) != expected[key]:
                problems.append("hyperlink[%d].%s expected=%r actual=%r"
                                % (index, key, expected[key], actual.get(key)))
    if "dangling_anchors" in want:
        actual_dangling = sorted(references.get("dangling_anchors") or [])
        if actual_dangling != sorted(want["dangling_anchors"]):
            problems.append("dangling_anchors expected=%r actual=%r"
                            % (sorted(want["dangling_anchors"]), actual_dangling))
    if "unbound_hyperlinks" in want:
        actual_unbound = sorted(references.get("unbound_hyperlinks") or [])
        if actual_unbound != sorted(want["unbound_hyperlinks"]):
            problems.append("unbound_hyperlinks expected=%r actual=%r"
                            % (sorted(want["unbound_hyperlinks"]), actual_unbound))
    if "external_targets" in want:
        actual_external = sorted((item.get("relationship_id"), item.get("target"))
                                 for item in references.get("external_targets") or [])
        expected_external = sorted((item.get("relationship_id"), item.get("target"))
                                   for item in want["external_targets"])
        if actual_external != expected_external:
            problems.append("external_targets expected=%r actual=%r"
                            % (expected_external, actual_external))
    return (not problems), "; ".join(problems) if problems else "ok"


def _expect_fields(references: dict, expectation: dict) -> tuple:
    """域判据：**「有指令」/「有缓存」/「已刷新」三态分开**（R158），并核对复杂域配对。"""
    want = expectation.get("fields")
    pairing_want = expectation.get("field_pairing")
    if want is None and pairing_want is None:
        return None
    got = references.get("fields") or []
    problems = []
    if want is not None:
        if len(got) != len(want):
            problems.append("fields count expected=%d actual=%d" % (len(want), len(got)))
        for index, expected in enumerate(want):
            if index >= len(got):
                continue
            actual = got[index]
            for key in ("kind", "instruction", "has_instruction", "cached_text",
                        "has_cache", "dirty", "refreshed", "state"):
                if key in expected and actual.get(key) != expected[key]:
                    problems.append("field[%d].%s expected=%r actual=%r"
                                    % (index, key, expected[key], actual.get(key)))
    if pairing_want is not None:
        actual_pairing = references.get("field_pairing") or {}
        for key, value in pairing_want.items():
            if actual_pairing.get(key) != value:
                problems.append("field_pairing.%s expected=%r actual=%r"
                                % (key, value, actual_pairing.get(key)))
    return (not problems), "; ".join(problems) if problems else "ok"


def _expect_note_parts(references: dict, expectation: dict) -> tuple:
    """脚注/尾注判据：部件存在性 + 关系 + 引用 id 与注 id 的对账。"""
    want = expectation.get("notes")
    if want is None:
        return None
    problems = []
    for group in ("footnotes", "endnotes"):
        expected = want.get(group)
        if expected is None:
            continue
        actual = (references.get("notes") or {}).get(group) or {}
        for key in ("present", "relationship", "has_separators", "reference_ids",
                    "dangling_reference_ids", "unreferenced_note_ids"):
            if key in expected and actual.get(key) != expected[key]:
                problems.append("%s.%s expected=%r actual=%r"
                                % (group, key, expected[key], actual.get(key)))
    return (not problems), "; ".join(problems) if problems else "ok"


def _expect_comments(references: dict, expectation: dict) -> tuple:
    """批注判据：范围配对 + 部件/关系存在性 + 引用 id 与批注 id 的对账。"""
    want = expectation.get("comments")
    if want is None:
        return None
    actual = references.get("comments") or {}
    problems = []
    for key in ("part_present", "relationship", "range_start_ids", "range_end_ids",
                "reference_ids", "paired_range_ids", "unpaired_range_start_ids",
                "unpaired_range_end_ids", "dangling_reference_ids", "unreferenced_comment_ids"):
        if key in want and actual.get(key) != want[key]:
            problems.append("comments.%s expected=%r actual=%r" % (key, want[key], actual.get(key)))
    return (not problems), "; ".join(problems) if problems else "ok"


def _expect_revisions(references: dict, expectation: dict) -> tuple:
    """修订判据：`w:ins`/`w:del`/`w:delText` 计数、作者、日期。"""
    want = expectation.get("revisions")
    if want is None:
        return None
    actual = references.get("revisions") or {}
    problems = []
    for key in ("ins", "del", "del_text", "del_without_del_text", "authors"):
        if key in want:
            value = actual.get(key)
            if key == "authors" and value is not None:
                value = sorted(value)
            if value != (sorted(want[key]) if key == "authors" else want[key]):
                problems.append("revisions.%s expected=%r actual=%r" % (key, want[key], value))
    if "entry_dates" in want:
        dates = [item.get("date") for item in actual.get("entries") or []]
        if dates != want["entry_dates"]:
            problems.append("revisions.entry_dates expected=%r actual=%r"
                            % (want["entry_dates"], dates))
    return (not problems), "; ".join(problems) if problems else "ok"


def _expect_math_structure(references: dict, expectation: dict) -> tuple:
    """公式判据：**能读出分子分母 / 次数与被开方数**，而不是一团纯文本（结构可读性）。"""
    want = expectation.get("math")
    if want is None:
        return None
    actual = references.get("math") or {}
    problems = []
    if "count" in want and actual.get("count") != want["count"]:
        problems.append("math.count expected=%r actual=%r" % (want["count"], actual.get("count")))
    if "structures" in want:
        expected_structures = want["structures"]
        actual_structures = actual.get("structures") or []
        if len(actual_structures) != len(expected_structures):
            problems.append("math.structures count expected=%d actual=%d"
                            % (len(expected_structures), len(actual_structures)))
        for index, expected in enumerate(expected_structures):
            if index >= len(actual_structures):
                continue
            got = actual_structures[index]
            for key, value in expected.items():
                if got.get(key) != value:
                    problems.append("math.structures[%d].%s expected=%r actual=%r"
                                    % (index, key, value, got.get(key)))
    return (not problems), "; ".join(problems) if problems else "ok"


def _expect_chart_parts(references: dict, expectation: dict) -> tuple:
    """图表判据：`word/charts/*.xml` 存在性、关系、系列与数据点数量。"""
    want = expectation.get("charts")
    if want is None:
        return None
    actual = references.get("charts") or []
    problems = []
    if len(actual) != len(want):
        problems.append("charts count expected=%d actual=%d" % (len(want), len(actual)))
    for index, expected in enumerate(want):
        if index >= len(actual):
            continue
        got = actual[index]
        for key in ("part", "relationship", "relationship_id", "series", "points"):
            if key in expected and got.get(key) != expected[key]:
                problems.append("chart[%d].%s expected=%r actual=%r"
                                % (index, key, expected[key], got.get(key)))
    return (not problems), "; ".join(problems) if problems else "ok"


def _expect_unparsed_elements(coverage: dict, expectation: dict) -> tuple:
    """**未解析元素显式判据**：声明"我知道这些元素没被语义解析"，多一个都算红。

    这条把"没报错所以没问题"变成"边界写在纸面上、且一旦扩大就报警"。
    """
    want = expectation.get("unparsed_elements")
    if want is None:
        return None
    problems = []
    # 两边的键都要看：声明 `{}` 意味着"任何部件都不许有未解析元素"——
    # 只比对 declared 的键会让"新元素悄悄冒出来"逃掉。
    for part in sorted(set(want) | set(coverage)):
        expected = want.get(part) or []
        actual = coverage.get(part) or []
        if sorted(actual) != sorted(expected):
            problems.append("%s unparsed expected=%r actual=%r"
                            % (part, sorted(expected), sorted(actual)))
    return (not problems), "; ".join(problems) if problems else "ok"


_REFERENCE_CHECKS = (
    ("expect_bookmarks", _expect_bookmarks),
    ("expect_hyperlinks", _expect_hyperlinks),
    ("expect_fields", _expect_fields),
    ("expect_note_parts", _expect_note_parts),
    ("expect_comments", _expect_comments),
    ("expect_revisions", _expect_revisions),
    ("expect_math_structure", _expect_math_structure),
    ("expect_chart_parts", _expect_chart_parts),
)

_REFERENCE_CHECK_NAMES = frozenset(name for name, _ in _REFERENCE_CHECKS)


_EXPECTATION_CHECKS = (
    ("expect_sha256", _expect_sha256),
    ("expect_required_parts", _expect_required_parts),
    ("expect_deflate", _expect_deflate),
    ("expect_relationships", _expect_relationships),
    ("expect_part_content_types", _expect_part_content_types),
    ("expect_sections", _expect_sections),
    ("expect_paragraph_text", _expect_paragraph_text),
    ("expect_paragraph_spacing", _expect_paragraph_spacing),
    ("expect_paragraph_indent", _expect_paragraph_indent),
    ("expect_run_properties", _expect_run_properties),
    ("expect_tables", _expect_tables),
    ("expect_units_recompute", _expect_units_recompute),
    ("expect_unparsed_elements", _expect_unparsed_elements),
) + _REFERENCE_CHECKS


# ---------------------------------------------------------------------------
# 读回主体
# ---------------------------------------------------------------------------

def _extract_paragraphs(xml_bytes: bytes) -> list:
    """从 `word/document.xml` 字节里按文档顺序抽取每个 `w:p` 的纯文本。

    只认 `w:t` 的文本节点；不执行任何样式/域代码/嵌入对象。
    """
    if ET is None:
        raise RuntimeError("xml.etree 不可用：Python 标准库损坏")
    root = ET.fromstring(xml_bytes)
    paragraphs = []
    for para in root.iter():
        if _tag_local(para.tag) != "p":
            continue
        chunks = []
        for node in para.iter():
            if _tag_local(node.tag) == "t" and node.text:
                chunks.append(node.text)
        paragraphs.append("".join(chunks))
    return paragraphs


def verify(path: str, expectation: "dict | None" = None,
           expectation_source: "str | None" = None) -> dict:
    result: dict = {
        "ok": False,
        "path": os.path.abspath(path),
        "error": None,
        "checks": [],
        "zip": None,
        "xml_problems": [],
        "parts": [],
        "document": None,
        "format": None,
        "references": None,
        "coverage": {},
        "coverage_notes": list(_COVERAGE_NOTES),
        "expectation": {"source": expectation_source, "label": (expectation or {}).get("label")}
        if expectation is not None else None,
    }

    def check(name: str, passed: bool, detail: str = "") -> None:
        result["checks"].append({"name": name, "passed": bool(passed), "detail": detail})

    # 1. 路径存在
    if not os.path.exists(path):
        result["error"] = _err("file_missing", "文件不存在：%s" % path)
        check("path_exists", False, result["error"]["message"])
        return result
    if not os.path.isfile(path):
        result["error"] = _err("not_a_file", "不是普通文件：%s" % path)
        check("path_exists", False, result["error"]["message"])
        return result
    byte_length = os.path.getsize(path)
    result["byteLength"] = byte_length
    check("path_exists", True, "byteLength=%d" % byte_length)

    if byte_length == 0:
        result["error"] = _err("empty_file", "文件长度为 0")
        check("non_empty", False, result["error"]["message"])
        return result
    check("non_empty", True, "")

    # 2/3. 合法 ZIP + 逐条目 CRC
    try:
        zf = zipfile.ZipFile(path)
    except zipfile.BadZipFile as exc:
        result["error"] = _err("not_a_zip", "不是合法 ZIP：%s" % exc)
        check("is_zip", False, result["error"]["message"])
        return result
    except Exception as exc:  # noqa: BLE001 - 读回工具要如实报告任何读失败
        result["error"] = _err("zip_open_failed", "打开 ZIP 失败：%s" % exc)
        check("is_zip", False, result["error"]["message"])
        return result

    with zf:
        names = zf.namelist()
        check("is_zip", True, "entries=%d" % len(names))

        bad_entry = zf.testzip()
        check("crc_self_check", bad_entry is None, "bad_entry=%s" % (bad_entry,))
        if bad_entry is not None:
            result["zip"] = {"entries": names, "bad_entry": bad_entry}
            result["error"] = _err("corrupt_entry", "CRC 自校验失败，首个坏条目：%s" % bad_entry)
            return result

        entry_details = {}
        for info in zf.infolist():
            method = _COMPRESSION_NAMES.get(info.compress_type, "other:%d" % info.compress_type)
            entry_details[info.filename] = method
        result["zip"] = {
            "entries": sorted(names),
            "bad_entry": None,
            "entry_details": entry_details,
        }
        result["parts"] = sorted(names)

        if MAIN_PART not in names:
            result["error"] = _err("missing_main_part", "缺少主部件 %s" % MAIN_PART)
            check("main_part_present", False, result["error"]["message"])
            return result
        check("main_part_present", True, MAIN_PART)

        if CONTENT_TYPES_PART not in names:
            result["error"] = _err(
                "missing_content_types", "缺少包级部件 %s" % CONTENT_TYPES_PART
            )
            check("content_types_present", False, result["error"]["message"])
            return result
        check("content_types_present", True, CONTENT_TYPES_PART)

        # 全部条目原始字节（含二进制媒体——关系目标存在性判据要用）
        parts: "dict[str, bytes]" = {name: zf.read(name) for name in names}
        # 5. 全部 XML/rels 部件可独立解析
        for name in names:
            if not (name.endswith(".xml") or name.endswith(".rels")):
                continue
            raw = parts[name]
            if raw.startswith(b"\xef\xbb\xbf"):
                result["xml_problems"].append(
                    {"name": name, "error": "部件以 UTF-8 BOM 开头"}
                )
                continue
            try:
                ET.fromstring(raw)
            except Exception as exc:  # noqa: BLE001
                result["xml_problems"].append({"name": name, "error": str(exc)})
        check(
            "xml_parses",
            len(result["xml_problems"]) == 0,
            "problems=%d" % len(result["xml_problems"]),
        )
        if result["xml_problems"]:
            first = result["xml_problems"][0]
            result["error"] = _err(
                "xml_parse_error", "部件 %s 无法解析：%s" % (first["name"], first["error"])
            )
            return result

        # 6. 抽取标题与段落
        doc_bytes = zf.read(MAIN_PART)
        try:
            paragraphs = _extract_paragraphs(doc_bytes)
        except Exception as exc:  # noqa: BLE001
            result["error"] = _err("main_part_parse_error", "解析 %s 失败：%s" % (MAIN_PART, exc))
            check("paragraphs_extracted", False, result["error"]["message"])
            return result

        # 格式读回（不改变任何既有判据的结论）
        try:
            result["format"] = _parse_format(ET.fromstring(doc_bytes))
            check("format_parsed", True, "paragraphs=%d tables=%d sections=%d" % (
                len(result["format"]["paragraphs"]),
                len(result["format"]["tables"]),
                len(result["format"]["sections"]),
            ))
        except Exception as exc:  # noqa: BLE001
            result["format"] = None
            check("format_parsed", False, "解析格式失败：%s" % exc)

        # 引用与审阅读回（WCF-D71）：书签/超链接/域/注记/批注/修订/公式/图表 + 未解析清单
        try:
            doc_root = ET.fromstring(doc_bytes)
            result["references"] = _parse_references(parts, doc_root)
            result["coverage"] = _collect_unparsed(parts)
            refs = result["references"]
            check("references_parsed", True,
                  "bookmarks=%d hyperlinks=%d fields=%d comments=%d revisions=%d math=%d charts=%d unparsed_parts=%d"
                  % (len(refs["bookmarks"]["starts"]), len(refs["hyperlinks"]), len(refs["fields"]),
                     len(refs["comments"]["reference_ids"]), refs["revisions"]["ins"] + refs["revisions"]["del"],
                     refs["math"]["count"], len(refs["charts"]), len(result["coverage"])))
        except Exception as exc:  # noqa: BLE001
            result["references"] = None
            result["coverage"] = {}
            check("references_parsed", False, "解析引用/审阅元素失败：%s" % exc)

        non_empty = [p for p in paragraphs if p.strip()]
        presentation = None
        if CUSTOM_PART in names:
            custom = ET.fromstring(zf.read(CUSTOM_PART))
            # 先按标记名识别，再校验结构。错误的根/属性命名空间不能让新版退回旧版。
            matching = [p for p in custom.iter()
                        if _tag_local(p.tag) == "property"
                        and p.get("name") == PRESENTATION_PROPERTY]
            if len(matching) > 1:
                result["error"] = _err("duplicate_presentation", "文档呈现版本属性重复")
                check("presentation_properties", False, result["error"]["message"])
                return result
            if matching:
                properties_valid = (
                    custom.tag == "{%s}Properties" % CUSTOM_NS
                    and matching[0].tag == "{%s}property" % CUSTOM_NS
                    and matching[0] in list(custom)
                )
                check("presentation_properties", properties_valid, CUSTOM_PART)
                if not properties_valid:
                    result["error"] = _err(
                        "invalid_presentation_properties", "文档呈现版本属性的根或命名空间不正确"
                    )
                    return result

                content_types = ET.fromstring(zf.read(CONTENT_TYPES_PART))
                overrides = [entry for entry in content_types
                             if entry.get("PartName") == "/" + CUSTOM_PART]
                content_type_valid = (
                    content_types.tag == "{%s}Types" % CONTENT_TYPES_NS
                    and len(overrides) == 1
                    and overrides[0].tag == "{%s}Override" % CONTENT_TYPES_NS
                    and overrides[0].get("ContentType") == CUSTOM_MIME
                )
                check("presentation_content_type", content_type_valid, CUSTOM_PART)
                if not content_type_valid:
                    result["error"] = _err(
                        "invalid_presentation_content_type", "文档呈现版本部件缺少唯一正确的内容类型声明"
                    )
                    return result

                relationships = (ET.fromstring(zf.read(PACKAGE_RELS_PART))
                                 if PACKAGE_RELS_PART in names else None)
                custom_rels = ([entry for entry in relationships
                                if entry.get("Type") == CUSTOM_REL]
                               if relationships is not None else [])
                relationship_valid = (
                    relationships is not None
                    and relationships.tag == "{%s}Relationships" % PACKAGE_RELS_NS
                    and len(custom_rels) == 1
                    and custom_rels[0].tag == "{%s}Relationship" % PACKAGE_RELS_NS
                    and custom_rels[0].get("Target") in (CUSTOM_PART, "/" + CUSTOM_PART)
                    and custom_rels[0].get("TargetMode", "Internal") == "Internal"
                )
                check("presentation_relationship", relationship_valid, CUSTOM_PART)
                if not relationship_valid:
                    result["error"] = _err(
                        "invalid_presentation_relationship", "文档呈现版本部件缺少唯一正确的包级内部关系"
                    )
                    return result

                value = matching[0].find("{%s}lpwstr" % VALUE_NS)
                presentation = value.text if value is not None and value.text else "invalid"
        result["document"] = {
            "part": MAIN_PART,
            "paragraphs": paragraphs,
            "non_empty_count": len(non_empty),
            "title": non_empty[0] if non_empty else None,
            "body": non_empty[1:] if non_empty else [],
            "presentation": presentation,
        }
        check("paragraphs_extracted", len(non_empty) > 0, "non_empty=%d" % len(non_empty))
        if not non_empty:
            result["error"] = _err("no_text", "%s 中没有任何非空段落文本" % MAIN_PART)
            return result

        # 期望判据（**只在给了 --expect 时**参与结论，老调用方结论不变）
        if expectation is not None:
            format_data = result["format"] or {"paragraphs": [], "tables": [], "sections": []}
            file_bytes = b""
            with open(path, "rb") as handle:
                file_bytes = handle.read()
            for name, checker in _EXPECTATION_CHECKS:
                if name == "expect_sha256":
                    outcome = checker(file_bytes, expectation)
                elif name == "expect_required_parts":
                    outcome = checker(names, expectation)
                elif name == "expect_deflate":
                    outcome = checker(entry_details, expectation)
                elif name == "expect_relationships":
                    outcome = checker(parts, expectation)
                elif name == "expect_part_content_types":
                    outcome = checker(parts, expectation)
                elif name == "expect_sections":
                    outcome = checker(format_data, expectation)
                elif name == "expect_unparsed_elements":
                    outcome = checker(result["coverage"] or {}, expectation)
                elif name in _REFERENCE_CHECK_NAMES:
                    if result["references"] is None:
                        outcome = (False, "引用/审阅元素未能解析（references_parsed 判据为假）")
                    else:
                        outcome = checker(result["references"], expectation)
                else:
                    outcome = checker(format_data, expectation)
                if outcome is None:
                    continue
                passed, detail = outcome
                check(name, passed, detail)
            failed = [item for item in result["checks"] if not item["passed"]]
            if failed:
                result["error"] = _err(
                    "expectation_mismatch",
                    "未满足期望判据：%s" % ", ".join(item["name"] for item in failed),
                )

    result["ok"] = all(item["passed"] for item in result["checks"]) and result["error"] is None
    return result


# ---------------------------------------------------------------------------
# 变异（判别力证据来源；TS 侧对真实语料复用同一实现）
# ---------------------------------------------------------------------------

class MutationError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


_BASE_PARTS = frozenset({CONTENT_TYPES_PART, PACKAGE_RELS_PART, MAIN_PART})
_UNKNOWN_PART_PREFERENCE = ("customXml/", "docProps/custom.xml", "theme/", "word/embeddings/")


def read_parts(path: str) -> "list[tuple[str, bytes]]":
    with zipfile.ZipFile(path) as zf:
        return [(info.filename, zf.read(info.filename)) for info in zf.infolist()]


def write_parts(path: str, parts: "list[tuple[str, bytes]]",
                compress_type: int = zipfile.ZIP_DEFLATED) -> None:
    """确定性打包（固定时间戳），保证同一份输入每次写出**逐字节相同**。"""
    with zipfile.ZipFile(path, "w", compress_type) as zf:
        for name, data in parts:
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = compress_type
            info.external_attr = (0o600 & 0xFFFF) << 16
            zf.writestr(info, data)


def _replace_part(parts: "list[tuple[str, bytes]]", name: str, data: bytes) -> "list[tuple[str, bytes]]":
    return [(key, data if key == name else value) for key, value in parts]


def _ppr_spans(raw: bytes) -> "list[tuple[int, int]]":
    """`<w:pPr>…</w:pPr>` 的字节区间。

    **为什么需要它**：真实 Word 会把**段落标记**的字符格式写在 `<w:pPr><w:rPr>…</w:rPr></w:pPr>`
    里，于是文档里的**第一个 `<w:rPr>` 往往不是正文 run 的**。按"第一个 rPr"去变异，会打在
    段落标记上、正文格式纹丝不动——读回器当然抓不到。所以变异必须**跳过 pPr 里的 rPr**，
    瞄准真正的正文 run（这条是被真实 Word 语料逼出来的修正）。
    """
    return [(m.start(), m.end()) for m in re.finditer(rb"<w:pPr\b[^>]*>.*?</w:pPr>", raw, re.S)]


def _inside(spans: "list[tuple[int, int]]", position: int) -> bool:
    return any(start <= position < end for start, end in spans)


def _mutate_drop_rpr(parts):
    """删掉**正文 run** 的首个 `<w:rPr>`（跳过段落标记的 `w:pPr/w:rPr`）。"""
    raw = dict(parts).get(MAIN_PART)
    if raw is None:
        raise MutationError("mutation_not_applicable", "缺少 %s" % MAIN_PART)
    spans = _ppr_spans(raw)
    for pattern in (rb"<w:rPr\b[^>]*>.*?</w:rPr>", rb"<w:rPr\s*/>"):
        for match in re.finditer(pattern, raw, re.S):
            if _inside(spans, match.start()):
                continue
            new = raw[:match.start()] + raw[match.end():]
            return _replace_part(parts, MAIN_PART, new)
    raise MutationError(
        "mutation_not_applicable",
        "%s 中没有正文 run 的 <w:rPr>（段落标记的 w:pPr/w:rPr 不算）" % MAIN_PART)


def _mutate_resize_font(parts):
    """改**正文 run** 的首个 `w:sz` 半点值（跳过段落标记的 `w:pPr/w:rPr`）。"""
    raw = dict(parts).get(MAIN_PART)
    if raw is None:
        raise MutationError("mutation_not_applicable", "缺少 %s" % MAIN_PART)
    spans = _ppr_spans(raw)
    for match in re.finditer(rb"<w:sz\s+w:val=\"(\d+)\"", raw):
        if _inside(spans, match.start()):
            continue
        value = int(match.group(1))
        new_value = value - 4 if value > 4 else value + 4
        new = raw[:match.start(1)] + str(new_value).encode("ascii") + raw[match.end(1):]
        return _replace_part(parts, MAIN_PART, new)
    raise MutationError(
        "mutation_not_applicable",
        "%s 中没有正文 run 的 <w:sz w:val=...>（段落标记的 w:pPr/w:rPr 不算）" % MAIN_PART)


def _mutate_indent_unit_swap(parts):
    raw = dict(parts).get(MAIN_PART)
    if raw is None:
        raise MutationError("mutation_not_applicable", "缺少 %s" % MAIN_PART)
    match = re.search(rb"<w:ind\b[^>]*>", raw)
    if match is None:
        raise MutationError("mutation_not_applicable", "%s 中没有 <w:ind>" % MAIN_PART)
    element = match.group(0)
    chars = re.search(rb'\sw:firstLineChars="(\d+)"', element)
    if chars is None:
        raise MutationError("mutation_not_applicable", "<w:ind> 上没有 w:firstLineChars")
    new_element = re.sub(rb'\sw:firstLine="\d+"', b"", element)
    new_element = new_element.replace(
        b'w:firstLineChars="' + chars.group(1) + b'"',
        b'w:firstLine="' + chars.group(1) + b'"',
    )
    new = raw[:match.start()] + new_element + raw[match.end():]
    return _replace_part(parts, MAIN_PART, new)


def _mutate_break_relationship(parts):
    mapping = dict(parts)
    raw = mapping.get(DOC_RELS_PART)
    if raw is None:
        raise MutationError("mutation_not_applicable", "缺少 %s" % DOC_RELS_PART)
    for match in re.finditer(rb"<Relationship\b[^>]*/>", raw):
        element = match.group(0)
        target = re.search(rb'Target="([^"]*)"', element)
        if target is None:
            continue
        if b'TargetMode="External"' in element:
            continue
        resolved = _resolve_target("word/document.xml", target.group(1).decode("utf-8"))
        if resolved not in mapping:
            continue
        new_element = (element[:target.start(1)] + b"media/__missing_part__.png"
                       + element[target.end(1):])
        new = raw[:match.start()] + new_element + raw[match.end():]
        return _replace_part(parts, DOC_RELS_PART, new)
    raise MutationError("mutation_not_applicable", "没有可指向的内部关系")


def _mutate_drop_unknown_part(parts):
    mapping = dict(parts)
    candidate = None
    for prefix in _UNKNOWN_PART_PREFERENCE:
        for name, _ in parts:
            if name.startswith(prefix) and name in mapping:
                candidate = name
                break
        if candidate:
            break
    if candidate is None:
        for name, _ in parts:
            if name not in _BASE_PARTS and not name.endswith(".rels"):
                candidate = name
                break
    if candidate is None:
        raise MutationError("mutation_not_applicable", "包里没有可丢弃的非基础部件")
    return [(name, value) for name, value in parts if name != candidate]


def _mutate_tamper_hash(parts):
    raw = dict(parts).get(MAIN_PART)
    if raw is None:
        raise MutationError("mutation_not_applicable", "缺少 %s" % MAIN_PART)
    if b"<w:body>" not in raw:
        raise MutationError("mutation_not_applicable", "%s 中没有 <w:body>" % MAIN_PART)
    # 语义中性：插一条 XML 注释（ElementTree 默认忽略注释；文本、属性、关系全不变）
    new = raw.replace(b"<w:body>", b"<w:body><!--tamper-->", 1)
    return _replace_part(parts, MAIN_PART, new)


def _main_part(parts):
    raw = dict(parts).get(MAIN_PART)
    if raw is None:
        raise MutationError("mutation_not_applicable", "缺少 %s" % MAIN_PART)
    return raw


def _require_match(pattern: bytes, raw: bytes, message: str):
    match = re.search(pattern, raw, re.S)
    if match is None:
        raise MutationError("mutation_not_applicable", message)
    return match


def _mutate_drop_bookmark_end(parts):
    """删掉首个 `w:bookmarkEnd` —— 配对性判据必须抓住。"""
    raw = _main_part(parts)
    match = _require_match(rb"<w:bookmarkEnd\b[^>]*/>", raw, "%s 中没有 <w:bookmarkEnd>" % MAIN_PART)
    new = raw[:match.start()] + raw[match.end():]
    return _replace_part(parts, MAIN_PART, new)


def _mutate_dangling_anchor(parts):
    """把 `w:anchor` 改成不存在的书签名 —— 内部链接判据必须抓住悬空锚点。"""
    raw = _main_part(parts)
    match = _require_match(rb'\sw:anchor="([^"]+)"', raw, "%s 中没有 w:anchor" % MAIN_PART)
    new = (raw[:match.start(1)] + b"__missing_bookmark__" + raw[match.end(1):])
    return _replace_part(parts, MAIN_PART, new)


def _drop_part_mutation(part_name: str):
    def mutate(parts):
        if part_name not in dict(parts):
            raise MutationError("mutation_not_applicable", "包里没有 %s" % part_name)
        return [(name, value) for name, value in parts if name != part_name]
    return mutate


def _mutate_unpair_comment_range(parts):
    """把 `w:commentRangeEnd@w:id` 改成另一个 id —— 批注范围配对判据必须抓住。"""
    raw = _main_part(parts)
    match = _require_match(rb'<w:commentRangeEnd\b[^>]*\sw:id="(\d+)"', raw,
                           "%s 中没有 <w:commentRangeEnd w:id=...>" % MAIN_PART)
    value = int(match.group(1)) + 1
    new = raw[:match.start(1)] + str(value).encode("ascii") + raw[match.end(1):]
    return _replace_part(parts, MAIN_PART, new)


def _mutate_strip_field_cache(parts):
    """删掉 `w:fldSimple` 的缓存内容（指令还在）—— 「有指令 / 有缓存」三态判据必须抓住。"""
    raw = _main_part(parts)
    match = _require_match(rb"<w:fldSimple\b[^>]*>.*?</w:fldSimple>", raw,
                           "%s 中没有 <w:fldSimple>" % MAIN_PART)
    element = match.group(0)
    open_end = element.index(b">") + 1
    close_start = element.rindex(b"</w:fldSimple>")
    new_element = element[:open_end] + element[close_start:]
    new = raw[:match.start()] + new_element + raw[match.end():]
    return _replace_part(parts, MAIN_PART, new)


def _mutate_mark_field_refreshed(parts):
    """摘掉 `w:dirty="true"`（缓存没变，却声称已刷新）—— 「已刷新」三态判据必须抓住。"""
    raw = _main_part(parts)
    match = _require_match(rb'\sw:dirty="true"', raw, "%s 中没有 w:dirty=\"true\"" % MAIN_PART)
    new = raw[:match.start()] + raw[match.end():]
    return _replace_part(parts, MAIN_PART, new)


def _mutate_flatten_math(parts):
    """把 `m:f`（分式）换成纯文本 `1/2` —— 公式结构可读性判据必须抓住。"""
    raw = _main_part(parts)
    match = _require_match(rb"<m:f>.*?</m:f>", raw, "%s 中没有 <m:f>" % MAIN_PART)
    new = raw[:match.start()] + b"<m:r><m:t>1/2</m:t></m:r>" + raw[match.end():]
    return _replace_part(parts, MAIN_PART, new)


def _mutate_tamper_revision_author(parts):
    """改 `w:ins` / `w:del` 的作者 —— 修订判据必须抓住（**只动主部件**，不碰 comments.xml）。"""
    raw = _main_part(parts)
    match = _require_match(rb'(<w:(?:ins|del)\b[^>]*?)\sw:author="[^"]*"', raw,
                           "%s 中没有带 w:author 的 w:ins / w:del" % MAIN_PART)
    new = raw[:match.start(1)] + match.group(1) + b' w:author="forge-x"' + raw[match.end():]
    return _replace_part(parts, MAIN_PART, new)


def _mutate_drop_field_separate(parts):
    """删掉复杂域的 `w:fldChar w:fldCharType="separate"`。

    没 separate，`instrText` 之后的 `w:t` 就不再计入**缓存**，于是 `has_cache` 由真变假、
    `field_pairing.separate` 由 1 变 0 —— 域的「有指令 / 有缓存 / 已刷新」三态判据必须抓住（R158）。
    """
    raw = _main_part(parts)
    match = _require_match(rb'<w:fldChar\b[^>]*w:fldCharType="separate"[^>]*/>', raw,
                           '%s 中没有 w:fldCharType="separate"' % MAIN_PART)
    new = raw[:match.start()] + raw[match.end():]
    return _replace_part(parts, MAIN_PART, new)


def _mutate_del_text_as_t(parts):
    """把 `w:del` 里的 `w:delText` 全部换成 `w:t`（**换元素而非换文本**）。

    删除内容应写在 `w:delText`；误用 `w:t` 是真实的合规瑕疵。`del_text` 计数由 1 变 0、
    `del_without_del_text` 由 0 变 1 —— 修订判据必须抓住。
    """
    raw = _main_part(parts)
    if b"<w:delText" not in raw:
        raise MutationError("mutation_not_applicable", "%s 中没有 <w:delText>" % MAIN_PART)
    new = raw.replace(b"<w:delText", b"<w:t").replace(b"</w:delText>", b"</w:t>")
    return _replace_part(parts, MAIN_PART, new)


def _mutate_break_external_relationship(parts):
    """删掉一条 `TargetMode="External"` 关系（**只动关系表，不抓取任何网络目标**，R161）。

    关系没了，引用它的 `w:hyperlink r:id=...` 就从 `external` 退化为 `dangling_relationship`
    （`target` / `target_mode` 由有变无）—— 超链接的内/外分流判据必须抓住。
    """
    mapping = dict(parts)
    raw = mapping.get(DOC_RELS_PART)
    if raw is None:
        raise MutationError("mutation_not_applicable", "缺少 %s" % DOC_RELS_PART)
    match = _require_match(rb'<Relationship\b[^>]*TargetMode="External"[^>]*/>', raw,
                           '%s 中没有 TargetMode="External" 的关系' % DOC_RELS_PART)
    new = raw[:match.start()] + raw[match.end():]
    return _replace_part(parts, DOC_RELS_PART, new)


_MUTATION_FUNCS = {
    "drop-rpr": _mutate_drop_rpr,
    "resize-font": _mutate_resize_font,
    "indent-unit-swap": _mutate_indent_unit_swap,
    "break-relationship": _mutate_break_relationship,
    "drop-unknown-part": _mutate_drop_unknown_part,
    "tamper-hash": _mutate_tamper_hash,
    # 引用/审阅组（WCF-D71）
    "drop-bookmark-end": _mutate_drop_bookmark_end,
    "dangling-anchor": _mutate_dangling_anchor,
    "drop-footnotes-part": _drop_part_mutation(FOOTNOTES_PART),
    "drop-comments-part": _drop_part_mutation(COMMENTS_PART),
    "unpair-comment-range": _mutate_unpair_comment_range,
    "strip-field-cache": _mutate_strip_field_cache,
    "mark-field-refreshed": _mutate_mark_field_refreshed,
    "flatten-math": _mutate_flatten_math,
    "drop-chart-part": _drop_part_mutation(CHARTS_DIR + "chart1.xml"),
    "tamper-revision-author": _mutate_tamper_revision_author,
    # FA-V 补的 3 个
    "drop-field-separate": _mutate_drop_field_separate,
    "del-text-as-t": _mutate_del_text_as_t,
    "break-external-relationship": _mutate_break_external_relationship,
}


def apply_mutation(kind: str, parts: "list[tuple[str, bytes]]") -> "list[tuple[str, bytes]]":
    func = _MUTATION_FUNCS.get(kind)
    if func is None or kind not in ALL_MUTATIONS:
        raise MutationError("unknown_mutation", "未知变异：%s" % kind)
    return func(parts)


# ---------------------------------------------------------------------------
# 自检样本（合成、非 potbot 生成器）
# ---------------------------------------------------------------------------

_XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
_REL_BASE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

CORPUS_DOCUMENT = (
    _XML_DECL
    + '<w:document xmlns:w="%s"><w:body>' % W_NS
    + '<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:jc w:val="center"/>'
      '<w:outlineLvl w:val="0"/></w:pPr>'
      '<w:r><w:rPr><w:b/>'
      '<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="黑体" w:cs="Arial"/>'
      '<w:color w:val="1F3864"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr>'
      '<w:t>年度报告</w:t></w:r></w:p>'
    + '<w:p><w:pPr><w:spacing w:line="360" w:lineRule="auto" w:before="240" w:after="120"/>'
      '<w:ind w:firstLineChars="200" w:firstLine="480"/></w:pPr>'
      '<w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" '
      'w:eastAsia="宋体" w:cs="Times New Roman"/><w:sz w:val="24"/>'
      '<w:szCs w:val="24"/><w:highlight w:val="yellow"/></w:rPr>'
      '<w:t>第一段正文，首行缩进两个字符。</w:t></w:r>'
      '<w:r><w:rPr><w:i/><w:u w:val="single"/><w:sz w:val="24"/></w:rPr>'
      '<w:t>斜体下划线补充。</w:t></w:r></w:p>'
    + '<w:p><w:pPr><w:jc w:val="distribute"/><w:spacing w:line="400" w:lineRule="exact"/></w:pPr>'
      '<w:r><w:rPr><w:sz w:val="21"/>'
      '<w:shd w:val="clear" w:color="auto" w:fill="FFF2CC"/></w:rPr>'
      '<w:t>分散对齐固定行距段落。</w:t></w:r></w:p>'
    + '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:jc w:val="center"/></w:tblPr>'
      '<w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="3000"/></w:tblGrid>'
      '<w:tr><w:tc><w:p><w:r><w:t>指标</w:t></w:r></w:p></w:tc>'
      '<w:tc><w:p><w:r><w:t>数值</w:t></w:r></w:p></w:tc></w:tr>'
      '<w:tr><w:tc><w:p><w:r><w:t>人数</w:t></w:r></w:p></w:tc>'
      '<w:tc><w:p><w:r><w:t>8</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
      '<w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" w:gutter="0"/>'
      '<w:cols w:num="1"/></w:sectPr>'
    + '</w:body></w:document>'
)

CORPUS_STYLES = (
    _XML_DECL
    + '<w:styles xmlns:w="%s">' % W_NS
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
    + '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>'
      '<w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>'
    + '</w:styles>'
)

CORPUS_DOC_RELS = (
    _XML_DECL
    + '<Relationships xmlns="%s">' % _REL_NS
    + '<Relationship Id="rId10" Type="%s/styles" Target="styles.xml"/>' % _REL_BASE
    + '<Relationship Id="rId11" Type="%s/image" Target="media/image1.png"/>' % _REL_BASE
    + '<Relationship Id="rId12" Type="%s/customXml" Target="../customXml/item1.xml"/>' % _REL_BASE
    + '</Relationships>'
)

CORPUS_CONTENT_TYPES = (
    _XML_DECL
    + '<Types xmlns="%s">' % CONTENT_TYPES_NS
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Default Extension="png" ContentType="image/png"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-'
      'officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-'
      'officedocument.wordprocessingml.styles+xml"/>'
    # 被 `_rels/.rels` 的 core-properties 关系引用的部件**必须**声明它自己的内容类型；
    # 只靠 `<Default Extension="xml">` 会让类型与关系不符，**真实 Word 会拒绝整个包（24601）**。
    # 早先这里漏了这一行，语料因此是**残缺包**，并把这个缺陷通过导出链路传染给了产物。
    + '<Override PartName="/docProps/core.xml" ContentType="%s"/>' % CORE_PROPS_MIME
    + '</Types>'
)

CORPUS_PACKAGE_RELS = (
    _XML_DECL
    + '<Relationships xmlns="%s">' % _REL_NS
    + '<Relationship Id="rId1" Type="%s/officeDocument" Target="word/document.xml"/>' % _REL_BASE
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/'
      'relationships/metadata/core-properties" Target="docProps/core.xml"/>'
    + '</Relationships>'
)

CORPUS_CORE = (
    _XML_DECL
    + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/'
      'metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">'
      '<dc:title>独立验收自检样本</dc:title></cp:coreProperties>'
)

CORPUS_OPAQUE = (
    _XML_DECL
    + '<root xmlns="urn:potbot:selftest:opaque"><note>opaque part preserved</note></root>'
)

CORPUS_PNG = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"


def corpus_parts() -> "list[tuple[str, bytes]]":
    return [
        (CONTENT_TYPES_PART, CORPUS_CONTENT_TYPES.encode("utf-8")),
        (PACKAGE_RELS_PART, CORPUS_PACKAGE_RELS.encode("utf-8")),
        (MAIN_PART, CORPUS_DOCUMENT.encode("utf-8")),
        ("word/_rels/document.xml.rels", CORPUS_DOC_RELS.encode("utf-8")),
        ("word/styles.xml", CORPUS_STYLES.encode("utf-8")),
        ("word/media/image1.png", CORPUS_PNG),
        ("customXml/item1.xml", CORPUS_OPAQUE.encode("utf-8")),
        ("docProps/core.xml", CORPUS_CORE.encode("utf-8")),
    ]


# --- 引用/审阅合成样本（WCF-D71 自检用；与 potbot 生成器无关）-------------------------

REFERENCE_DOCUMENT = (
    _XML_DECL
    + '<w:document xmlns:w="%s" xmlns:r="%s" xmlns:m="%s"><w:body>' % (W_NS, R_NS, M_NS)
    + '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>'
      '<w:bookmarkStart w:id="1" w:name="bm1"/><w:r><w:t>第一章</w:t></w:r>'
      '<w:bookmarkEnd w:id="1"/></w:p>'
    + '<w:p><w:hyperlink r:id="rId20" w:tooltip="外部"><w:r><w:t>外链</w:t></w:r></w:hyperlink>'
      '<w:hyperlink w:anchor="bm1"><w:r><w:t>内链</w:t></w:r></w:hyperlink></w:p>'
    + '<w:p><w:fldSimple w:instr=" REF bm1 \\h " w:dirty="true">'
      '<w:r><w:t>第一章</w:t></w:r></w:fldSimple></w:p>'
    + '<w:p><w:r><w:fldChar w:fldCharType="begin" w:dirty="true"/></w:r>'
      '<w:r><w:instrText xml:space="preserve">TOC \\o "1-3"</w:instrText></w:r>'
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r></w:p>'
    + '<w:p><w:r><w:t>第一章</w:t></w:r></w:p>'
    + '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
    + '<w:p><w:r><w:t>正文</w:t></w:r>'
      '<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="1"/></w:r>'
      '<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:endnoteReference w:id="1"/></w:r></w:p>'
    + '<w:p><w:commentRangeStart w:id="1"/>'
      '<w:ins w:id="1" w:author="reviewer" w:date="2026-10-03T00:00:00Z"><w:r><w:t>新增</w:t></w:r></w:ins>'
      '<w:commentRangeEnd w:id="1"/><w:r><w:commentReference w:id="1"/></w:r></w:p>'
    + '<w:p><w:del w:id="2" w:author="reviewer" w:date="2026-10-03T00:00:00Z">'
      '<w:r><w:delText xml:space="preserve">删除</w:delText></w:r></w:del>'
      '<w:r><w:t>保留</w:t></w:r></w:p>'
    + '<w:p><m:oMath><m:f><m:num><m:r><m:t>1</m:t></m:r></m:num>'
      '<m:den><m:r><m:t>2</m:t></m:r></m:den></m:f></m:oMath></w:p>'
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
      '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:gutter="0"/>'
      '<w:cols w:num="1"/></w:sectPr>'
    + '</w:body></w:document>'
)

REFERENCE_FOOTNOTES = (
    _XML_DECL
    + '<w:footnotes xmlns:w="%s"><w:footnote w:type="separator" w:id="-1"><w:p><w:r>'
      '<w:separator/></w:r></w:p></w:footnote>'
      '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r>'
      '<w:continuationSeparator/></w:r></w:p></w:footnote>'
      '<w:footnote w:id="1"><w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr>'
      '<w:footnoteRef/></w:r><w:r><w:t>脚注正文</w:t></w:r></w:p></w:footnote></w:footnotes>'
) % W_NS

REFERENCE_ENDNOTES = (
    _XML_DECL
    + '<w:endnotes xmlns:w="%s"><w:endnote w:type="separator" w:id="-1"><w:p><w:r>'
      '<w:separator/></w:r></w:p></w:endnote>'
      '<w:endnote w:type="continuationSeparator" w:id="0"><w:p><w:r>'
      '<w:continuationSeparator/></w:r></w:p></w:endnote>'
      '<w:endnote w:id="1"><w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr>'
      '<w:endnoteRef/></w:r><w:r><w:t>尾注正文</w:t></w:r></w:p></w:endnote></w:endnotes>'
) % W_NS

REFERENCE_COMMENTS = (
    _XML_DECL
    + '<w:comments xmlns:w="%s"><w:comment w:id="1" w:author="审阅人">'
      '<w:p><w:r><w:t>这里要改</w:t></w:r></w:p></w:comment></w:comments>' % W_NS
)

REFERENCE_CHART = (
    _XML_DECL
    + '<c:chartSpace xmlns:c="%s" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
      '<c:chart><c:plotArea><c:barChart><c:ser><c:idx val="0"/><c:val><c:numRef><c:numCache>'
      '<c:ptCount val="3"/>'
      '<c:pt idx="0"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>2</c:v></c:pt>'
      '<c:pt idx="2"><c:v>3</c:v></c:pt>'
      '</c:numCache></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>'
) % C_NS

REFERENCE_CONTENT_TYPES = (
    _XML_DECL
    + '<Types xmlns="%s">' % CONTENT_TYPES_NS
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-'
      'officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-'
      'officedocument.wordprocessingml.styles+xml"/>'
    + '<Override PartName="/docProps/core.xml" ContentType="%s"/>' % CORE_PROPS_MIME
    + '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-'
      'officedocument.wordprocessingml.footnotes+xml"/>'
    + '<Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-'
      'officedocument.wordprocessingml.endnotes+xml"/>'
    + '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-'
      'officedocument.wordprocessingml.comments+xml"/>'
    + '<Override PartName="/word/charts/chart1.xml" ContentType="application/vnd.openxmlformats-'
      'officedocument.drawingml.chart+xml"/>'
    + '</Types>'
)

REFERENCE_DOC_RELS = (
    _XML_DECL
    + '<Relationships xmlns="%s">' % _REL_NS
    + '<Relationship Id="rId10" Type="%s/styles" Target="styles.xml"/>' % REL_BASE
    + '<Relationship Id="rId20" Type="%s/hyperlink" Target="https://example.com/ref" TargetMode="External"/>' % REL_BASE
    + '<Relationship Id="rId21" Type="%s/chart" Target="charts/chart1.xml"/>' % REL_BASE
    + '<Relationship Id="rId22" Type="%s/footnotes" Target="footnotes.xml"/>' % REL_BASE
    + '<Relationship Id="rId23" Type="%s/endnotes" Target="endnotes.xml"/>' % REL_BASE
    + '<Relationship Id="rId24" Type="%s/comments" Target="comments.xml"/>' % REL_BASE
    + '</Relationships>'
)


def reference_corpus_parts() -> "list[tuple[str, bytes]]":
    return [
        (CONTENT_TYPES_PART, REFERENCE_CONTENT_TYPES.encode("utf-8")),
        (PACKAGE_RELS_PART, CORPUS_PACKAGE_RELS.encode("utf-8")),
        (MAIN_PART, REFERENCE_DOCUMENT.encode("utf-8")),
        ("word/_rels/document.xml.rels", REFERENCE_DOC_RELS.encode("utf-8")),
        ("word/styles.xml", CORPUS_STYLES.encode("utf-8")),
        (FOOTNOTES_PART, REFERENCE_FOOTNOTES.encode("utf-8")),
        (ENDNOTES_PART, REFERENCE_ENDNOTES.encode("utf-8")),
        (COMMENTS_PART, REFERENCE_COMMENTS.encode("utf-8")),
        ("word/charts/chart1.xml", REFERENCE_CHART.encode("utf-8")),
        ("docProps/core.xml", CORPUS_CORE.encode("utf-8")),
    ]


def reference_corpus_expectation() -> dict:
    """**手写**：引用/审阅元素的语义预期（不是从文件反推）。"""
    return {
        "label": "verify-docx-selftest-reference-corpus",
        "required_parts": sorted(name for name, _ in reference_corpus_parts()),
        "deflate_parts": [MAIN_PART],
        "bookmarks": {
            "starts": [{"id": 1, "name": "bm1"}],
            "names": ["bm1"],
            "paired": True,
            "unpaired_start_ids": [],
            "unpaired_end_ids": [],
            "duplicate_start_ids": [],
        },
        "hyperlinks": [
            {"kind": "external", "relationship_id": "rId20", "anchor": None,
             "target": "https://example.com/ref", "target_mode": "External"},
            {"kind": "internal", "relationship_id": None, "anchor": "bm1",
             "anchor_resolves": True},
        ],
        "external_targets": [{"relationship_id": "rId20", "target": "https://example.com/ref"}],
        "dangling_anchors": [],
        "unbound_hyperlinks": [],
        "fields": [
            {"kind": "simple", "instruction": ' REF bm1 \\h ', "has_instruction": True,
             "cached_text": "第一章", "has_cache": True, "refreshed": False,
             "state": "cached_not_refreshed"},
            {"kind": "complex", "instruction": 'TOC \\o "1-3"', "has_instruction": True,
             "cached_text": "第一章", "has_cache": True, "refreshed": False,
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
        "revisions": {"ins": 1, "del": 1, "del_text": 1, "del_without_del_text": 0,
                      "authors": ["reviewer"]},
        "math": {"count": 1, "structures": [
            {"kind": "fraction", "numerator": "1", "denominator": "2"},
        ]},
        "charts": [{"part": "word/charts/chart1.xml", "relationship": True,
                    "relationship_id": "rId21", "series": 1, "points": 3}],
    }


def corpus_expectation() -> dict:
    """**手写**预期（不是从文件反推）：语义量按 ECMA-376 声明，原始属性由本工具复算。"""
    return {
        "label": "verify-docx-selftest-corpus",
        "required_parts": sorted(name for name, _ in corpus_parts()),
        "deflate_parts": [MAIN_PART],
        # 有效内容类型：两条走 Override，两条走 Default 扩展名——两条路径都被判据覆盖。
        "content_types": {
            "/word/document.xml": "application/vnd.openxmlformats-officedocument."
                                  "wordprocessingml.document.main+xml",
            "/word/styles.xml": "application/vnd.openxmlformats-officedocument."
                                "wordprocessingml.styles+xml",
            "/docProps/core.xml": CORE_PROPS_MIME,
            "customXml/item1.xml": "application/xml",
            "word/media/image1.png": "image/png",
        },
        "relationships": [
            {"owner_part_path": "word/document.xml", "id": "rId10",
             "type": _REL_BASE + "/styles", "target": "styles.xml", "target_mode": "Internal"},
            {"owner_part_path": "word/document.xml", "id": "rId11",
             "type": _REL_BASE + "/image", "target": "media/image1.png", "target_mode": "Internal"},
            {"owner_part_path": "word/document.xml", "id": "rId12",
             "type": _REL_BASE + "/customXml", "target": "../customXml/item1.xml",
             "target_mode": "Internal"},
            {"owner_part_path": None, "id": "rId1", "type": _REL_BASE + "/officeDocument",
             "target": "word/document.xml", "target_mode": "Internal"},
        ],
        # 3 个正文段落 + 表格 2 行 × 2 格 = 4 个单元格段落，按文档顺序共 7 段
        "paragraph_count": 7,
        "sections": [{
            "page_size": {"w": 11906, "h": 16838},
            "margins": {"top": 1440, "right": 1800, "bottom": 1440, "left": 1800, "gutter": 0},
            "columns": 1,
        }],
        "paragraphs": [
            {
                "index": 0,
                "text": "年度报告",
                "style": "Heading1",
                "align": "center",
                "outline_level": 0,
                "runs": [{
                    "text": "年度报告",
                    "bold": True,
                    "italic": None,
                    "underline": None,
                    "size_pt": 16,
                    "fonts": {"ascii": "Arial", "hAnsi": "Arial", "eastAsia": "黑体",
                              "cs": "Arial"},
                    "color": "1F3864",
                    "highlight": None,
                }],
            },
            {
                "index": 1,
                "line_spacing": {"multiple": 1.5},
                "indent": {"first_line_chars": 2},
                "runs": [
                    {"text": "第一段正文，首行缩进两个字符。",
                     "size_pt": 12,
                     "fonts": {"ascii": "Times New Roman", "eastAsia": "宋体"},
                     "highlight": "yellow"},
                    {"text": "斜体下划线补充。",
                     "italic": True, "underline": "single", "size_pt": 12},
                ],
            },
            {
                "index": 2,
                "align": "distribute",
                "line_spacing": {"exact_pt": 20},
                "runs": [{"size_pt": 10.5, "shading": {"val": "clear", "color": "auto",
                                                       "fill": "FFF2CC"}}],
            },
        ],
        "tables": [{
            "grid": [2000, 3000],
            "cell_texts": [["指标", "数值"], ["人数", "8"]],
        }],
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _usage() -> int:
    sys.stderr.write(
        "用法：\n"
        "  verify-docx.py <path-to.docx> [--expect <expect.json>] [--pretty]\n"
        "  verify-docx.py --self-test [--pretty]\n"
        "  verify-docx.py --mutate <kind> <in.docx> <out.docx>\n"
        "  verify-docx.py --list-mutations\n"
    )
    return 2


def _dump(payload: dict, pretty: bool) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=True, sort_keys=True,
                                indent=2 if pretty else None) + "\n")


def _self_test(pretty: bool) -> int:
    import shutil
    import tempfile

    report: dict = {"ok": False, "kind": "verify-docx-self-test", "checks": [],
                    "mutations": [], "reference_mutations": []}
    workdir = tempfile.mkdtemp(prefix="verify-docx-selftest-")
    try:
        expectation = corpus_expectation()
        control_path = os.path.join(workdir, "control.docx")
        parts = corpus_parts()
        write_parts(control_path, parts)

        with open(control_path, "rb") as handle:
            control_bytes = handle.read()
        expectation["sha256"] = hashlib.sha256(control_bytes).hexdigest()

        control = verify(control_path, expectation=expectation)
        report["checks"].append({
            "name": "control_passes",
            "passed": bool(control["ok"]),
            "detail": "exit-ok=%s failing=%s" % (
                control["ok"],
                sorted(item["name"] for item in control["checks"] if not item["passed"])),
        })
        report["checks"].append({
            "name": "control_is_deflate",
            "passed": control["zip"]["entry_details"].get(MAIN_PART) == "deflate",
            "detail": control["zip"]["entry_details"].get(MAIN_PART),
        })
        report["checks"].append({
            "name": "control_format_parsed",
            "passed": bool(control["format"]) and len(control["format"]["tables"]) == 1,
            "detail": "tables=%d sections=%d paragraphs=%d" % (
                len((control["format"] or {}).get("tables", [])),
                len((control["format"] or {}).get("sections", [])),
                len((control["format"] or {}).get("paragraphs", [])),
            ),
        })

        all_caught = True
        for kind in MUTATIONS:
            entry = {"kind": kind, "expected_check": MUTATIONS[kind]}
            try:
                mutated = apply_mutation(kind, parts)
            except MutationError as exc:
                entry.update({"caught": False, "error": {"code": exc.code, "message": exc.message}})
                all_caught = False
                report["mutations"].append(entry)
                continue
            mutated_path = os.path.join(workdir, "mutated-%s.docx" % kind)
            write_parts(mutated_path, mutated)
            outcome = verify(mutated_path, expectation=expectation)
            failed = sorted(item["name"] for item in outcome["checks"] if not item["passed"])
            entry.update({
                "caught": (not outcome["ok"]) and MUTATIONS[kind] in failed,
                "ok": outcome["ok"],
                "failed_checks": failed,
                "error": outcome["error"],
            })
            if not entry["caught"]:
                all_caught = False
            report["mutations"].append(entry)

        # --- 引用/审阅合成样本的对照与变异（WCF-D71）---------------------------
        ref_expectation = reference_corpus_expectation()
        ref_parts = reference_corpus_parts()
        ref_control_path = os.path.join(workdir, "reference-control.docx")
        write_parts(ref_control_path, ref_parts)
        with open(ref_control_path, "rb") as handle:
            ref_expectation["sha256"] = hashlib.sha256(handle.read()).hexdigest()
        ref_control = verify(ref_control_path, expectation=ref_expectation)
        ref_control_check = {
            "name": "reference_control_passes",
            "passed": bool(ref_control["ok"]),
            "detail": "exit-ok=%s failing=%s" % (
                ref_control["ok"],
                sorted(item["name"] for item in ref_control["checks"] if not item["passed"])),
        }
        report["checks"].append(ref_control_check)
        ref_all_caught = bool(ref_control_check["passed"])
        for kind in REFERENCE_MUTATIONS:
            entry = {"kind": kind, "expected_check": REFERENCE_MUTATIONS[kind]}
            try:
                mutated = apply_mutation(kind, ref_parts)
            except MutationError as exc:
                entry.update({"caught": False, "error": {"code": exc.code, "message": exc.message}})
                ref_all_caught = False
                report["reference_mutations"].append(entry)
                continue
            mutated_path = os.path.join(workdir, "reference-mutated-%s.docx" % kind)
            write_parts(mutated_path, mutated)
            outcome = verify(mutated_path, expectation=ref_expectation)
            failed = sorted(item["name"] for item in outcome["checks"] if not item["passed"])
            entry.update({
                "caught": (not outcome["ok"]) and REFERENCE_MUTATIONS[kind] in failed,
                "ok": outcome["ok"],
                "failed_checks": failed,
                "error": outcome["error"],
            })
            if not entry["caught"]:
                ref_all_caught = False
            report["reference_mutations"].append(entry)

        # 对照与变异都必须判对，且变异必须真的改变了字节
        report["ok"] = bool(all(item["passed"] for item in report["checks"])
                            and all_caught and ref_all_caught)
    finally:
        shutil.rmtree(workdir, ignore_errors=True)
    _dump(report, pretty)
    return 0 if report["ok"] else 1


def _mutate_cli(kind: str, source: str, destination: str) -> int:
    payload: dict = {"ok": False, "kind": kind, "source": os.path.abspath(source),
                     "destination": os.path.abspath(destination), "error": None}
    try:
        parts = read_parts(source)
        mutated = apply_mutation(kind, parts)
        if [value for _, value in mutated] == [value for _, value in parts]:
            payload["error"] = _err("mutation_noop", "变异没有改变任何字节")
            _dump(payload, False)
            return 3
        write_parts(destination, mutated)
        payload["ok"] = True
        payload["parts"] = [name for name, _ in mutated]
    except MutationError as exc:
        payload["error"] = _err(exc.code, exc.message)
        _dump(payload, False)
        return 3
    except (OSError, zipfile.BadZipFile) as exc:
        payload["error"] = _err("io_error", "%s" % exc)
        _dump(payload, False)
        return 1
    _dump(payload, False)
    return 0


def main(argv: "list[str]") -> int:
    args = argv[1:]
    pretty = "--pretty" in args
    args = [item for item in args if item != "--pretty"]

    if "--list-mutations" in args:
        # `mutations` 键**保持原有 6 项不变**（老调用方逐条比对）；引用/审阅组另开一键。
        _dump({
            "mutations": [{"kind": kind, "expected_check": MUTATIONS[kind]} for kind in MUTATIONS],
            "reference_mutations": [{"kind": kind, "expected_check": REFERENCE_MUTATIONS[kind]}
                                    for kind in REFERENCE_MUTATIONS],
        }, pretty)
        return 0
    if "--self-test" in args:
        return _self_test(pretty)
    if "--mutate" in args:
        rest = [item for item in args if item != "--mutate"]
        if len(rest) != 3:
            return _usage()
        return _mutate_cli(rest[0], rest[1], rest[2])

    expectation_path = None
    positional: "list[str]" = []
    index = 0
    while index < len(args):
        item = args[index]
        if item == "--expect":
            index += 1
            if index >= len(args):
                return _usage()
            expectation_path = args[index]
        elif item.startswith("--expect="):
            expectation_path = item[len("--expect="):]
        else:
            positional.append(item)
        index += 1
    if len(positional) != 1:
        return _usage()

    expectation = None
    if expectation_path is not None:
        if not os.path.isfile(expectation_path):
            sys.stderr.write("期望文件不存在：%s\n" % expectation_path)
            return 2
        try:
            with open(expectation_path, "r", encoding="utf-8") as handle:
                expectation = json.load(handle)
        except (OSError, ValueError) as exc:
            sys.stderr.write("期望文件无法读取：%s\n" % exc)
            return 2
        if not isinstance(expectation, dict):
            sys.stderr.write("期望文件必须是 JSON 对象\n")
            return 2

    payload = verify(positional[0], expectation=expectation, expectation_source=expectation_path)
    _dump(payload, pretty)
    return 0 if payload["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
