/**
 * **行盒 → 页盒**：真实分页 + 页眉页脚占位带。
 *
 * ## 页数只能由布局算出
 *
 * 页数 = 返回的 `PageBox[]` 的长度；它只由「行高之和 vs 内容区高」与分页约束决定。
 * 本模块**没有**任何"先猜页数再填内容"的路径。`PageBox.index` 是真实页序（0 起）。
 *
 * ## 分页规则（明确写入 README）
 *
 * - 内容区 = `[margins.top + headerHeight, height − margins.bottom − footerHeight] ×[margins.left, width − margins.right]`。
 * - 行放不下（y + height > contentBottom）⇒ 换页；**页顶抑制段前距**（Word 既有行为）。
 * - `pageBreakBefore` ⇒ 段前换页（页空时不重复换）。
 * - `keepWithNext`：连续被同页约束的段构成 **keep 组**，整组必须同页；组高超过整页时
 *   **不静默容忍**，改走正常流并发 `keep_group_overflow`（如实报告做不到）。
 * - `band_overflow`：页眉 / 页脚内容高超过其预留带时如实报告（不裁不藏）。
 *
 * ## 统一分页：段落流与表格流共用一条 y 游标
 *
 * `paginate` 只处理段落（W09 首轮的段落流）。`paginateBlocks` 是**统一的分页器**：
 * 按文档顺序接收**段落块**与**已由 `layoutTable` 排版好的表格块**，二者共享同一条页内
 * y 游标——段落之后的表格从段落底部起排，表格之后的段落从表格底部起排，不再各排各的。
 * 表格按**行边界**切片：跨页时在续页**重复前导表头行**；表格连「表头 + 首行」都放不下时
 * 整表移到下一页（不把表头丢到页脚外）。单行高超过整页发 `table_row_overflow`
 * （不裁切、不死循环）。表格跨页发 `table_split`。
 *
 * `paginate` 现**委托**给 `paginateBlocks`（段落流只有一条实现，杜绝两套判据漂移）。
 */

import type { MeasuredLine, MeasuredParagraph } from './line-break.js';
import type { TableBorderSegment, TableBox, TableRowBox } from './tables.js';
import type {
  HeaderFooterBox,
  LayoutDiagnostic,
  LineBox,
  PageBox,
  PageGeometry,
  Twips,
} from './types.js';

export interface ContentBox {
  leftTwips: Twips;
  topTwips: Twips;
  widthTwips: Twips;
  heightTwips: Twips;
}

export interface PaginateInput {
  paragraphs: readonly MeasuredParagraph[];
  geometry: PageGeometry;
  content: ContentBox;
  header: MeasuredParagraph | null;
  footer: MeasuredParagraph | null;
  diagnostics: LayoutDiagnostic[];
}

export interface PaginateOutput {
  pages: PageBox[];
}

function linesHeight(para: MeasuredParagraph): Twips {
  return para.lines.reduce((sum, line) => sum + line.heightTwips, 0);
}

/**
 * 把一行摆到页面上（含对齐、首行缩进、justify 伸展量）。
 *
 * 导出给 `tables.ts` 复用：表格单元格里的段落行与文档流里的段落行**必须**用同一套摆放
 * 判据，否则对齐/缩进会出现两套语义。传入的 `content` 的 `leftTwips` 既作为"本列左边界"，
 * 返回的 `offsetXTwips` 也相对该值。
 */
export function placeLine(
  line: MeasuredLine,
  para: MeasuredParagraph,
  lineIndex: number,
  content: ContentBox,
  pageIndex: number,
  top: Twips,
): LineBox {
  const isFirst = lineIndex === 0;
  const isLast = lineIndex === para.lines.length - 1;
  const firstInset = isFirst ? para.indentFirstLineTwips : 0;
  const columnLeft = content.leftTwips + para.indentLeftTwips + firstInset;
  const columnWidth = Math.max(
    0,
    content.widthTwips - para.indentLeftTwips - para.indentRightTwips - firstInset,
  );

  let offset = 0;
  let stretch = 0;
  switch (para.alignment) {
    case 'center':
      offset = Math.max(0, (columnWidth - line.widthTwips) / 2);
      break;
    case 'right':
      offset = Math.max(0, columnWidth - line.widthTwips);
      break;
    case 'justify': {
      const spaces = countSpaces(line.text);
      if (!isLast && spaces > 0) {
        stretch = Math.max(0, (columnWidth - line.widthTwips) / spaces);
      }
      break;
    }
    case 'left':
    default:
      offset = 0;
  }

  return {
    paragraphIndex: para.paragraphIndex,
    lineIndexInParagraph: lineIndex,
    text: line.text,
    widthTwips: line.widthTwips,
    offsetXTwips: columnLeft + offset,
    topTwips: top,
    heightTwips: line.heightTwips,
    baselineTwips: top + line.ascentTwips,
    spaceStretchTwips: stretch,
    pageIndex,
    runs: line.runs,
  };
}

function countSpaces(text: string): number {
  let n = 0;
  for (const ch of text) if (ch === ' ' || ch === '\t' || ch === '　') n += 1;
  return n;
}

/**
 * keep 组划分：`i` 起点向后吞掉所有 `keepWithNext` 为真且仍有后继的段落，
 * 直到某个 `keepWithNext` 为假的段落（该段落属于本组）。
 */
function buildKeepGroups(paragraphs: readonly MeasuredParagraph[]): Array<{ start: number; end: number }> {
  const groups: Array<{ start: number; end: number }> = [];
  let i = 0;
  while (i < paragraphs.length) {
    let end = i;
    while (end < paragraphs.length - 1 && paragraphs[end]?.keepWithNext === true) end += 1;
    groups.push({ start: i, end });
    i = end + 1;
  }
  return groups;
}

// ---------------------------------------------------------------------------
// 统一分页：段落流与表格流共用一条 y 游标
// ---------------------------------------------------------------------------

/** 段落块。 */
export interface ParagraphBlock {
  readonly kind: 'paragraph';
  readonly paragraph: MeasuredParagraph;
}

/**
 * 表格块。表格**必须**先由 `layoutTable` 排版成 `TableBox`（行列网格与单元格行盒已算好），
 * 本分页器只做**行级切片摆放**，不在这里重新解算网格。
 */
export interface TableBlock {
  readonly kind: 'table';
  readonly table: TableBox;
}

/** 文档块：段落或表格。数组顺序 = 文档顺序；两类块共享同一条页内 y 游标。 */
export type DocumentBlock = ParagraphBlock | TableBlock;

/**
 * 摆放到某一页上的一个表格切片（坐标相对**页面**左上角）。
 *
 * 行盒与线段都已平移到页面坐标系（含 `content.leftTwips` 的水平偏移）；续页重复的表头行
 * 也在 `rows` 内、且是 `rows[0]`。
 */
export interface PlacedTable {
  /** 表格块在 `blocks` 数组中的下标。 */
  readonly blockIndex: number;
  /** 第几个表格块（0 起，按文档顺序），用于区分同页多表。 */
  readonly tableIndex: number;
  readonly pageIndex: number;
  /** 表格左边界（= 内容区左边），表格内所有 x 以此为基准。 */
  readonly leftTwips: Twips;
  readonly topTwips: Twips;
  readonly heightTwips: Twips;
  readonly widthTwips: Twips;
  readonly columnEdgesTwips: readonly Twips[];
  /** 本切片的行（含续页重复的表头行），已平移到页面坐标。 */
  readonly rows: readonly TableRowBox[];
  /** 本切片的图形线段（页面坐标）。 */
  readonly borders: readonly TableBorderSegment[];
  /** 本切片顶部重复的表头行数（首页为 0，续页为前导表头行数）。 */
  readonly repeatedHeaderRowCount: number;
  /** 是否为本表格的续切片（true ⇒ 由上一页不完整延续而来）。 */
  readonly isContinuation: boolean;
  /** 本表格在本切片之后是否还有续切片。 */
  readonly continuesOnNextPage: boolean;
}

/** 统一分页的一页：段落行盒 + 摆放到本页的表格切片 + 页眉页脚带。 */
export interface UnifiedPageBox {
  readonly index: number;
  /** 本页的**段落**行盒；表格单元格的行盒在 `tables[].rows[].cells[].lines` 内，不重复计入。 */
  readonly lines: readonly LineBox[];
  readonly tables: readonly PlacedTable[];
  readonly header: HeaderFooterBox;
  readonly footer: HeaderFooterBox;
}

export interface PaginateBlocksInput {
  readonly blocks: readonly DocumentBlock[];
  readonly geometry: PageGeometry;
  readonly content: ContentBox;
  readonly header: MeasuredParagraph | null;
  readonly footer: MeasuredParagraph | null;
  readonly diagnostics: LayoutDiagnostic[];
  /** 表格续页是否重复前导表头行；默认 true（与 `paginateTable` 一致）。 */
  readonly repeatTableHeaderRows?: boolean;
}

export interface PaginateBlocksOutput {
  readonly pages: UnifiedPageBox[];
}

interface PageAccumulator {
  lines: LineBox[];
  tables: PlacedTable[];
}

type BlockGroup =
  | { kind: 'paragraphs'; members: MeasuredParagraph[]; firstBlockIndex: number }
  | { kind: 'table'; blockIndex: number };

/**
 * 把块序列切成可分页的组：连续的段落块按 `keepWithNext` 归并成 keep 组（复用
 * `buildKeepGroups` 的判据）；表格块自成一界——**keep 组不跨表格边界**（表格不是段落，
 * 段落的 `keepWithNext` 只与**紧随其后的段落**同页；表格在中间时该约束不作跨表延展）。
 */
function buildBlockGroups(blocks: readonly DocumentBlock[]): BlockGroup[] {
  const groups: BlockGroup[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    if (block === undefined) break;
    if (block.kind === 'table') {
      groups.push({ kind: 'table', blockIndex: i });
      i += 1;
      continue;
    }
    // 连成一段连续段落块，再按 keepWithNext 归并。
    let runEnd = i;
    while (runEnd + 1 < blocks.length && (blocks[runEnd + 1] as DocumentBlock).kind === 'paragraph') {
      runEnd += 1;
    }
    const paras: MeasuredParagraph[] = [];
    for (let k = i; k <= runEnd; k += 1) {
      const b = blocks[k] as DocumentBlock;
      if (b.kind === 'paragraph') paras.push(b.paragraph);
    }
    for (const group of buildKeepGroups(paras)) {
      groups.push({
        kind: 'paragraphs',
        members: paras.slice(group.start, group.end + 1),
        firstBlockIndex: i + group.start,
      });
    }
    i = runEnd + 1;
  }
  return groups;
}

/** 把一个行盒平移到页面坐标：纵向按 `topTwips` 对齐，横向整体偏移 `leftTwips`。 */
function placeRowAt(row: TableRowBox, pageIndex: number, topTwips: Twips, leftTwips: Twips): TableRowBox {
  const dy = topTwips - row.topTwips;
  return {
    rowIndex: row.rowIndex,
    header: row.header,
    topTwips,
    heightTwips: row.heightTwips,
    cells: row.cells.map((cell) => ({
      ...cell,
      leftTwips: cell.leftTwips + leftTwips,
      textLeftTwips: cell.textLeftTwips + leftTwips,
      topTwips: cell.topTwips + dy,
      lines: cell.lines.map((line) => ({
        ...line,
        offsetXTwips: line.offsetXTwips + leftTwips,
        topTwips: line.topTwips + dy,
        baselineTwips: line.baselineTwips + dy,
        pageIndex,
      })),
    })),
  };
}

/** 由已摆放的行盒重算图形线段（页面坐标）：每条行边界一条横线、每条列边界一条竖线。 */
function bordersForPlacedRows(
  rows: readonly TableRowBox[],
  widthTwips: Twips,
  columnEdges: readonly Twips[],
  leftTwips: Twips,
): TableBorderSegment[] {
  const out: TableBorderSegment[] = [];
  if (rows.length === 0) return out;
  const first = rows[0] as TableRowBox;
  const last = rows[rows.length - 1] as TableRowBox;
  const top = first.topTwips;
  const bottom = last.topTwips + last.heightTwips;
  for (const row of rows) {
    out.push({
      x1Twips: leftTwips,
      y1Twips: row.topTwips,
      x2Twips: leftTwips + widthTwips,
      y2Twips: row.topTwips,
      orientation: 'horizontal',
    });
  }
  out.push({
    x1Twips: leftTwips,
    y1Twips: bottom,
    x2Twips: leftTwips + widthTwips,
    y2Twips: bottom,
    orientation: 'horizontal',
  });
  for (const ex of columnEdges) {
    out.push({
      x1Twips: leftTwips + ex,
      y1Twips: top,
      x2Twips: leftTwips + ex,
      y2Twips: bottom,
      orientation: 'vertical',
    });
  }
  return out;
}

/**
 * **统一分页器**：段落块与表格块共享一条页内 y 游标。
 *
 * 段落部分与 `paginate` 完全同判据（keep 组、`pageBreakBefore`、页顶抑制段前距）；
 * 表格部分做**行级切片 + 续页表头重复**，并把表格行盒/线段平移到页面坐标。
 *
 * 已知边界（如实标出，不假装完整）：`rowSpan` 跨行单元格若正好落在切片边界，本实现与
 * `paginateTable` 一样**不拆行也不续排跨行单元格**（切片只在整行边界发生）。需要时由调用方
 * 避免在跨行处切页。
 */
export function paginateBlocks(input: PaginateBlocksInput): PaginateBlocksOutput {
  const { blocks, geometry, content, diagnostics } = input;
  const repeatTableHeaderRows = input.repeatTableHeaderRows ?? true;
  const contentBottom = content.topTwips + content.heightTwips;
  const pageHeight = content.heightTwips;

  const pages: PageAccumulator[] = [{ lines: [], tables: [] }];
  let y = content.topTwips;

  const currentPage = (): PageAccumulator => pages[pages.length - 1] as PageAccumulator;
  const pageIndex = (): number => pages.length - 1;
  const pageHasContent = (): boolean => {
    const cur = currentPage();
    return cur.lines.length > 0 || cur.tables.length > 0;
  };
  const startPage = (): void => {
    pages.push({ lines: [], tables: [] });
    y = content.topTwips;
  };

  let tableOrdinal = 0;

  const placeTableBlock = (blockIndex: number, table: TableBox, tableIndex: number): void => {
    const headerRows = table.rows.slice(0, table.headerRowCount);
    const bodyRows = table.rows.slice(table.headerRowCount);
    const headerHeight = headerRows.reduce((sum, r) => sum + r.heightTwips, 0);
    const firstBodyHeight = bodyRows.length > 0 ? (bodyRows[0] as TableRowBox).heightTwips : 0;

    // 当前页已有内容，且连「表头 + 首行」都放不下 ⇒ 整表移到下一页（不把表头留在页脚外）。
    if (pageHasContent() && y + headerHeight + firstBodyHeight > contentBottom) {
      startPage();
    }

    for (const row of bodyRows) {
      if (row.heightTwips > pageHeight) {
        diagnostics.push({
          code: 'table_row_overflow',
          severity: 'warning',
          message: `表格第 ${row.rowIndex} 行高 ${row.heightTwips} twips 超过整页内容区 ${pageHeight} twips，独占一页（不裁切）`,
        });
      }
    }

    let sliceCount = 0;

    const placeSlice = (bodyStart: number, bodyEnd: number, isContinuation: boolean, sliceTop: Twips): void => {
      const page = pageIndex();
      let cursor = sliceTop;
      const placedRows: TableRowBox[] = [];
      const includeHeader = !isContinuation || repeatTableHeaderRows;
      if (includeHeader) {
        for (const header of headerRows) {
          placedRows.push(placeRowAt(header, page, cursor, content.leftTwips));
          cursor += header.heightTwips;
        }
      }
      for (let k = bodyStart; k < bodyEnd; k += 1) {
        const row = bodyRows[k] as TableRowBox;
        placedRows.push(placeRowAt(row, page, cursor, content.leftTwips));
        cursor += row.heightTwips;
      }
      currentPage().tables.push({
        blockIndex,
        tableIndex,
        pageIndex: page,
        leftTwips: content.leftTwips,
        topTwips: sliceTop,
        heightTwips: cursor - sliceTop,
        widthTwips: table.widthTwips,
        columnEdgesTwips: table.columnEdgesTwips,
        rows: placedRows,
        borders: bordersForPlacedRows(placedRows, table.widthTwips, table.columnEdgesTwips, content.leftTwips),
        repeatedHeaderRowCount: isContinuation && repeatTableHeaderRows ? headerRows.length : 0,
        isContinuation,
        continuesOnNextPage: bodyEnd < bodyRows.length,
      });
      y = cursor;
      sliceCount += 1;
    };

    // 一页从 `from` 起能放下的正文行数；至少放 1 行（保证推进，不死循环）。
    const takeRows = (sliceTop: Twips, isContinuation: boolean, from: number): number => {
      const headerOnSlice = !isContinuation || repeatTableHeaderRows ? headerHeight : 0;
      const avail = contentBottom - sliceTop - headerOnSlice;
      let count = 0;
      let used = 0;
      while (from + count < bodyRows.length) {
        const row = bodyRows[from + count] as TableRowBox;
        if (count > 0 && used + row.heightTwips > avail) break;
        used += row.heightTwips;
        count += 1;
      }
      return count;
    };

    let bodyIndex = 0;
    let isContinuation = false;
    let firstSlice = true;
    while (firstSlice || bodyIndex < bodyRows.length) {
      if (!firstSlice) startPage();
      const sliceTop = y;
      const count = takeRows(sliceTop, isContinuation, bodyIndex);
      placeSlice(bodyIndex, bodyIndex + count, isContinuation, sliceTop);
      bodyIndex += count;
      isContinuation = true;
      firstSlice = false;
    }

    if (sliceCount > 1) {
      diagnostics.push({
        code: 'table_split',
        severity: 'warning',
        message: `表格跨 ${sliceCount} 页（在行边界拆分${repeatTableHeaderRows && table.headerRowCount > 0 ? '，续页重复表头' : ''}）`,
      });
    }
  };

  for (const group of buildBlockGroups(blocks)) {
    if (group.kind === 'paragraphs') {
      const members = group.members;
      if (members.length > 1) {
        const span = members.reduce((sum, para, index) => {
          const before = index === 0 && !pageHasContent() ? 0 : para.spaceBeforeTwips;
          return sum + before + linesHeight(para) + para.spaceAfterTwips;
        }, 0);
        if (span > pageHeight) {
          diagnostics.push({
            code: 'keep_group_overflow',
            severity: 'warning',
            message: `keep 组（第 ${group.firstBlockIndex} 块起）高 ${span} twips 超过整页 ${pageHeight} twips，改走正常流`,
            paragraphIndex: members[0]?.paragraphIndex,
          });
        } else if (y + span > contentBottom && pageHasContent()) {
          startPage();
        }
      }

      for (const para of members) {
        if (para.pageBreakBefore && pageHasContent()) startPage();
        if (pageHasContent()) y += para.spaceBeforeTwips;

        para.lines.forEach((line, lineIndex) => {
          if (y + line.heightTwips > contentBottom && pageHasContent()) startPage();
          currentPage().lines.push(placeLine(line, para, lineIndex, content, pageIndex(), y));
          y += line.heightTwips;
        });

        y += para.spaceAfterTwips;
      }
    } else {
      const block = blocks[group.blockIndex] as DocumentBlock;
      if (block.kind === 'table') placeTableBlock(group.blockIndex, block.table, tableOrdinal);
      tableOrdinal += 1;
    }
  }

  const headerBox = buildBand('header', input.header, geometry, content, diagnostics);
  const footerBox = buildBand('footer', input.footer, geometry, content, diagnostics);

  return {
    pages: pages.map((page, index) => ({
      index,
      lines: page.lines,
      tables: page.tables,
      header: headerBox(index),
      footer: footerBox(index),
    })),
  };
}

/**
 * 段落流分页（W09 首轮入口）。**委托**给 {@link paginateBlocks}——段落只有一条实现，
 * 表格路径与段落路径不会出现两套摆放判据。表格请改用 `paginateBlocks`。
 */
export function paginate(input: PaginateInput): PaginateOutput {
  const { pages } = paginateBlocks({
    blocks: input.paragraphs.map((paragraph): DocumentBlock => ({ kind: 'paragraph', paragraph })),
    geometry: input.geometry,
    content: input.content,
    header: input.header,
    footer: input.footer,
    diagnostics: input.diagnostics,
  });

  return {
    pages: pages.map((page): PageBox => ({
      index: page.index,
      lines: page.lines,
      header: page.header,
      footer: page.footer,
    })),
  };
}

/**
 * 构造页眉 / 页脚带：
 * - 页眉带 = `[margins.top, margins.top + headerHeightTwips)`
 * - 页脚带 = `[height − margins.bottom − footerHeightTwips, height − margins.bottom)`
 * 内容按带顶摆放；内容高超过带宽发 `band_overflow`（**不裁不藏**）。
 */
function buildBand(
  kind: 'header' | 'footer',
  para: MeasuredParagraph | null,
  geometry: PageGeometry,
  content: ContentBox,
  diagnostics: LayoutDiagnostic[],
): (pageIndex: number) => HeaderFooterBox {
  const reserved = kind === 'header' ? geometry.headerHeightTwips : geometry.footerHeightTwips;
  const top =
    kind === 'header'
      ? geometry.marginsTwips.top
      : geometry.heightTwips - geometry.marginsTwips.bottom - reserved;

  const hasContent = para !== null && para.lines.some((line) => line.text.length > 0);
  const lines: LineBox[] = [];
  let total = 0;
  if (para !== null) {
    let y = top;
    para.lines.forEach((line, lineIndex) => {
      lines.push(placeLine(line, para, lineIndex, content, 0, y));
      y += line.heightTwips;
      total += line.heightTwips;
    });
    if (total > reserved) {
      diagnostics.push({
        code: 'band_overflow',
        severity: 'warning',
        message: `${kind === 'header' ? '页眉' : '页脚'}内容高 ${total} twips 超过预留带 ${reserved} twips`,
      });
    }
  }

  return (pageIndex: number): HeaderFooterBox => ({
    kind,
    reservedHeightTwips: reserved,
    topTwips: top,
    hasContent,
    lines: lines.map((line) => ({ ...line, pageIndex })),
  });
}
