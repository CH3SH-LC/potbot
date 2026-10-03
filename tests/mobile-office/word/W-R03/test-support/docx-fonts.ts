/**
 * **W-I25 — 从真实 DOCX 读 `w:rFonts`，投影成 W-R03 的 `FontSlotSet`**（测试支撑，纯只读）。
 *
 * ## 补的是哪个缺口
 *
 * W-R03 的 `resolveCjkFonts` 需要一个 `FontSlotSet`（`w:rFonts` 的 ascii/hAnsi/eastAsia/cs 四槽）。
 * 此前测试里的槽集合都是**手写的对象字面量**——它能证明策略正确，却证明不了"这份槽集合是从
 * 真文件里读出来的"。本模块把这一环接上：**真实 DOCX 字节 → `importDocx`（W01/WCF-D02 的真实导入器）
 * → `DocumentModel` → 取每个 run 的 `RunProperties.fonts`/`size` → `FontSlotSet` + 字号（pt）**。
 *
 * ## 纪律（沿用本包与 W09 的口径）
 *
 * - **不发明**：run 不在直接格式里写 `w:sz`（或只写了 `w:rFonts w:hint`）时，本层**不猜**字号与字体，
 *   如实给 `sizePt: null` / 四槽全 `null`；继承级联（样式默认）是 W03 的职责，本层不越权。
 * - **不读文件系统**：只接受 `Uint8Array`；调用方负责读盘。
 * - **不静默**：`hasRFontsElement` 区分"没有 `w:rFonts` 元素"与"有元素但四槽皆空"（典型是
 *   只有 `w:hint="eastAsia"` 的 Word 原生文件），两者都映射到四槽全 `null`，但语义不同。
 *
 * ## 位置串（`location`）
 *
 * 便于断言与排障的稳定路径：正文块 `body/p{块序号}`，表格内 `body/t{块}r{行}c{列}/p{段}`，
 * run 再追加 `/r{行内序号}`。**不是**模型节点 id（那是 `NodeId`），只是本测试支撑的定位串。
 */

import { importDocx } from '../../../../../src/documents/docx/import.js';
import type {
  BlockNode,
  DocumentModel,
  FontSet,
  ParagraphNode,
  RunNode,
  ValuedState,
} from '../../../../../src/documents/model/types.js';
import { fontSizeToPt } from '../../../../../src/documents/units/font-size.js';
import type { CjkRunInput, FontSlotSet } from '../cjk/index.js';

/** 四槽皆空的槽集合（**冻结**，避免调用方误改共享对象）。 */
const NO_SLOTS: FontSlotSet = Object.freeze({ ascii: null, hAnsi: null, eastAsia: null, cs: null });

/** 从真实 DOCX 读出的一个 run：文本 + 槽集合 + 直接字号 + 位置。 */
export interface DocxRunFonts {
  /** 稳定定位串（见文件头）；不是模型 `NodeId`。 */
  readonly location: string;
  readonly text: string;
  /** `w:rFonts` 四槽；`null` = 该槽未直接指定（继承级联归 W03）。 */
  readonly fonts: FontSlotSet;
  /**
   * 该 run 的直接格式里**是否存在** `w:rFonts` 元素。
   * `false` ⇒ 元素缺失；`true` ⇒ 元素存在（哪怕四槽全空，例如只有 `w:hint="eastAsia"`）。
   */
  readonly hasRFontsElement: boolean;
  /** 直接格式字号（pt）；run 未直接写 `w:sz` 时为 `null`（**不发明**继承值）。 */
  readonly sizePt: number | null;
}

/**
 * `RunProperties.fonts`（三态）→ `FontSlotSet`。
 * `unspecified` / `inherit` 都映射到四槽全 `null`（`inherit` = 清除直接格式，回落到样式级联）。
 */
export function fontSlotSetOf(fonts: ValuedState<FontSet>): FontSlotSet {
  if (fonts.state !== 'set') return { ...NO_SLOTS };
  return {
    ascii: fonts.value.ascii,
    hAnsi: fonts.value.hAnsi,
    eastAsia: fonts.value.eastAsia,
    cs: fonts.value.cs,
  };
}

/** 单个 `RunNode` → `DocxRunFonts`（位置由调用方给出）。 */
export function runFontsOf(run: RunNode, location: string): DocxRunFonts {
  const size = run.properties.size;
  return {
    location,
    text: run.text,
    fonts: fontSlotSetOf(run.properties.fonts),
    hasRFontsElement: run.properties.fonts.state === 'set',
    sizePt: size.state === 'set' ? fontSizeToPt(size.value) : null,
  };
}

/**
 * 把整份 `DocumentModel` 里的**所有文本 run**（含表格单元格内的段落）按文档顺序投影出来。
 * 只收 `kind === 'run'` 的内联节点；软换行 / 域 / 图形 / 公式不是文本 run，跳过。
 */
export function extractRunFonts(model: DocumentModel): readonly DocxRunFonts[] {
  const out: DocxRunFonts[] = [];
  walkBlocks(model.blocks, 'body/', out);
  return out;
}

function walkBlocks(blocks: readonly BlockNode[], prefix: string, out: DocxRunFonts[]): void {
  blocks.forEach((block, blockIndex) => {
    if (block.kind === 'paragraph') {
      collectParagraphRuns(block, `${prefix}p${blockIndex}`, out);
      return;
    }
    block.rows.forEach((row, rowIndex) => {
      row.cells.forEach((cell, cellIndex) => {
        walkBlocks(cell.blocks, `${prefix}t${blockIndex}r${rowIndex}c${cellIndex}/`, out);
      });
    });
  });
}

function collectParagraphRuns(paragraph: ParagraphNode, base: string, out: DocxRunFonts[]): void {
  paragraph.inlines.forEach((inline, inlineIndex) => {
    if (inline.kind !== 'run') return;
    out.push(runFontsOf(inline, `${base}/r${inlineIndex}`));
  });
}

/** 字节 → 真实导入 → run 槽集合。`importDocx` 会做 ZIP/关系/内容类型的完整校验。 */
export function readDocxRunFonts(bytes: Uint8Array): readonly DocxRunFonts[] {
  return extractRunFonts(importDocx(bytes));
}

/**
 * `DocxRunFonts` → W-R03 的 `CjkRunInput`。
 *
 * @throws 当 run 无直接字号且未给 `sizePtOverride` 时抛错——本层**不发明**继承字号，
 *         调用方必须显式给一个（例如从样式级联算出的值）。
 */
export function asCjkRun(run: DocxRunFonts, sizePtOverride?: number): CjkRunInput {
  const sizePt = run.sizePt ?? sizePtOverride;
  if (sizePt === undefined) {
    throw new Error(
      `run ${run.location} 没有直接字号（w:sz），且未提供覆盖值：本层不发明继承字号`,
    );
  }
  return { text: run.text, sizePt, fonts: run.fonts };
}
