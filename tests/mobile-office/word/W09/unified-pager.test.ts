/**
 * **W09 独立验证 §统一分页**：`paginateBlocks` —— 段落流与表格流**共用一条 y 游标**。
 *
 * 这是 W09 首轮 `nextIncrement` 第 1 项：`paginate`（只处理段落）与 `paginateTable`
 * （只处理表格）各自分页，混排文档无法一次排完。本测试断言统一分页器**真的把它们排到一条游标上**：
 *
 * - 段落之后的表格从**段落底部**起排；表格之后的段落从**表格底部**起排（不是各自从页顶重来）；
 * - 表格按行边界切片，**续页重复前导表头行**；
 * - 表格连「表头 + 首行」都放不下时**整表移到下一页**，不把表头留在页脚外；
 * - 单行高超过整页发 `table_row_overflow`（不裁切、不死循环）。
 *
 * ## 反向对照（防"断言是空壳"）
 *
 * - **加高一行会把后续段落推到下一页**：短表时尾段落留在第 0 页，加高表格后尾段落跑到第 1 页；
 * - **`repeatTableHeaderRows:false`**：续页不再重复表头（对照组为默认 true，续页首行是表头）；
 * - 表格只有 1 个切片时**不得**发 `table_split`（对照组为跨页时必发）。
 *
 * 字体度量用 W09 自带的夹具端口（`fixtures/font-port.ts`），与 W-R03 刻意分开、可独立跑。
 */

import { describe, expect, it } from 'vitest';

import {
  FontResolver,
  measureParagraph,
  type LayoutDiagnostic,
  type MeasuredParagraph,
  type PageGeometry,
  type ParagraphSpec,
} from '../../../../src/mobile-plugins/word/rendering/index.js';
import {
  paginateBlocks,
  type ContentBox,
  type DocumentBlock,
  type UnifiedPageBox,
} from '../../../../src/mobile-plugins/word/rendering/paginate.js';
import {
  layoutTable,
  type TableRowSpec,
  type TableSpec,
} from '../../../../src/mobile-plugins/word/rendering/tables.js';
import { createFixtureFontPort } from './fixtures/font-port.js';

const port = createFixtureFontPort();

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 窄页：内容区宽 1000 twips / 高 `h` twips，无页眉页脚带（内容区 100..100+h）。 */
function geometry(contentHeightTwips: number): PageGeometry {
  return {
    widthTwips: 1200,
    heightTwips: contentHeightTwips + 200,
    marginsTwips: { top: 100, bottom: 100, left: 100, right: 100 },
    headerHeightTwips: 0,
    footerHeightTwips: 0,
  };
}

function contentBoxOf(g: PageGeometry): ContentBox {
  return {
    leftTwips: g.marginsTwips.left,
    topTwips: g.marginsTwips.top,
    widthTwips: g.widthTwips - g.marginsTwips.left - g.marginsTwips.right,
    heightTwips: g.heightTwips - g.marginsTwips.top - g.marginsTwips.bottom,
  };
}

function p(text: string, extra: Partial<ParagraphSpec> = {}): ParagraphSpec {
  return { runs: [{ text, fontFamily: 'Test Serif', sizePt: 10 }], ...extra };
}

/** Test Serif 10pt：拉丁 100 twips/字，行高 200。（内容宽 1000） */
function measureParas(paras: readonly ParagraphSpec[], contentWidthTwips = 1000): MeasuredParagraph[] {
  const diagnostics: LayoutDiagnostic[] = [];
  const resolver = new FontResolver(port, undefined, diagnostics);
  return paras.map((para, index) =>
    measureParagraph(para, index, { port, resolver, diagnostics, contentWidthTwips }),
  );
}

function paraBlocks(texts: readonly string[]): DocumentBlock[] {
  return measureParas(texts.map((text) => p(text))).map((paragraph) => ({ kind: 'paragraph', paragraph }));
}

const PAD = { top: 50, bottom: 50, left: 100, right: 100 }; // 1 行行高 200 + 100 = 300
const PAD_TIGHT = { top: 0, bottom: 0, left: 100, right: 100 }; // 1 行行高 200

/** 前导 `headerCount` 个表头行 + `bodyCount` 个正文行；列宽 2000（文本宽 1800 ⇒ 每行 18 字）。 */
function table(headerCount: number, bodyCount: number, pad: typeof PAD, bodyText = 'A'): TableSpec {
  const rows: TableRowSpec[] = [];
  for (let i = 0; i < headerCount; i += 1) rows.push({ cells: [{ blocks: [p('H')] }], header: true });
  for (let i = 0; i < bodyCount; i += 1) rows.push({ cells: [{ blocks: [p(bodyText)] }] });
  return { rows, columnWidthsTwips: [2000], cellPaddingTwips: pad };
}

function tableBlock(spec: TableSpec): DocumentBlock {
  return { kind: 'table', table: layoutTable(spec, port) };
}

function run(
  blocks: readonly DocumentBlock[],
  g: PageGeometry,
  extra: { repeatTableHeaderRows?: boolean } = {},
): { pages: readonly UnifiedPageBox[]; diagnostics: LayoutDiagnostic[] } {
  const diagnostics: LayoutDiagnostic[] = [];
  const { pages } = paginateBlocks({
    blocks,
    geometry: g,
    content: contentBoxOf(g),
    header: null,
    footer: null,
    diagnostics,
    ...extra,
  });
  return { pages, diagnostics };
}

function pageIndexOfLine(pages: readonly UnifiedPageBox[], text: string): number {
  return pages.findIndex((page) => page.lines.some((line) => line.text === text));
}

function codesOf(diagnostics: readonly LayoutDiagnostic[]): string[] {
  return diagnostics.map((d) => d.code);
}

// ---------------------------------------------------------------------------
// §A 段落 / 表格 / 段落 共享一条 y 游标
// ---------------------------------------------------------------------------

describe('§A 混排共享一条 y 游标', () => {
  it('表格从段落底部起排、后续段落从表格底部起排（同一页）', () => {
    const g = geometry(1000); // 内容区 100..1100
    const { pages, diagnostics } = run(
      [...paraBlocks(['AAAA']), tableBlock(table(1, 1, PAD)), ...paraBlocks(['BBBB'])],
      g,
    );

    expect(pages).toHaveLength(1);
    const page = pages[0] as UnifiedPageBox;
    expect(page.lines.map((l) => l.text)).toEqual(['AAAA', 'BBBB']);
    expect(page.tables).toHaveLength(1);

    const placed = page.tables[0];
    expect(placed?.topTwips).toBe(300); // 段落 100 → 300
    expect(placed?.heightTwips).toBe(600); // 表头 300 + 正文 300
    expect(placed?.rows).toHaveLength(2);
    expect(placed?.isContinuation).toBe(false);
    expect(placed?.continuesOnNextPage).toBe(false);

    // 表格之后的段落顶 = 表格底 = 300 + 600 = 900（证明共用游标，而非从页顶重排）
    expect(page.lines[1]?.topTwips).toBe(900);
    expect((placed?.topTwips as number) + (placed?.heightTwips as number)).toBe(900);

    // 单切片 ⇒ 不发 table_split
    expect(codesOf(diagnostics)).not.toContain('table_split');
  });

  it('单元格行盒被平移到页面坐标：x 含内容区左边，pageIndex 与所在页一致', () => {
    const g = geometry(1000);
    const { pages } = run([...paraBlocks(['AAAA']), tableBlock(table(1, 1, PAD))], g);
    const placed = (pages[0] as UnifiedPageBox).tables[0];
    const headerLine = placed?.rows[0]?.cells[0]?.lines[0];
    // content.left(100) + padding.left(100)
    expect(headerLine?.offsetXTwips).toBe(200);
    expect(headerLine?.pageIndex).toBe(0);
    // 表头行顶 = 表格顶（300）
    expect(placed?.rows[0]?.topTwips).toBe(300);
    // 正文行顶 = 表格顶 + 表头高
    expect(placed?.rows[1]?.topTwips).toBe(600);
  });

  it('两个表格按文档顺序编号（tableIndex 递增，blockIndex 正确）', () => {
    const g = geometry(1000);
    const { pages } = run(
      [tableBlock(table(0, 1, PAD_TIGHT)), ...paraBlocks(['AAAA']), tableBlock(table(0, 1, PAD_TIGHT))],
      g,
    );
    expect(pages).toHaveLength(1);
    const tables = (pages[0] as UnifiedPageBox).tables;
    expect(tables).toHaveLength(2);
    expect(tables.map((t) => t.tableIndex)).toEqual([0, 1]);
    expect(tables.map((t) => t.blockIndex)).toEqual([0, 2]);
  });
});

// ---------------------------------------------------------------------------
// §B 表格行级切片 + 续页表头重复
// ---------------------------------------------------------------------------

describe('§B 表格跨页：行边界切片 + 续页重复表头', () => {
  it('每页 700：表头 + 4 正文 ⇒ 4 切片，续页重复 1 行表头', () => {
    const g = geometry(700); // 内容区 100..800
    const { pages, diagnostics } = run([tableBlock(table(1, 4, PAD))], g);

    expect(pages).toHaveLength(4);
    const slices = pages.map((page) => page.tables[0]);
    for (const page of pages) expect(page.tables).toHaveLength(1);

    expect(slices.map((s) => s?.repeatedHeaderRowCount)).toEqual([0, 1, 1, 1]);
    // 续页首行是**重复的表头**
    expect(slices[1]?.rows[0]?.rowIndex).toBe(0);
    expect(slices[1]?.rows[0]?.header).toBe(true);
    expect(slices[1]?.isContinuation).toBe(true);
    expect(slices[0]?.isContinuation).toBe(false);

    // 正文行 1..4 各出现一次（不丢行、不重复正文）
    const bodyIds: number[] = [];
    for (const s of slices) for (const r of s?.rows ?? []) if (r.rowIndex > 0) bodyIds.push(r.rowIndex);
    expect(bodyIds.sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);

    // 每个切片都不越过内容区底（800）
    for (const s of slices) {
      expect((s?.topTwips as number) + (s?.heightTwips as number)).toBeLessThanOrEqual(800);
    }
    expect(codesOf(diagnostics)).toContain('table_split');
  });

  it('反向对照：repeatTableHeaderRows:false ⇒ 续页不再重复表头', () => {
    const g = geometry(400); // 内容区 100..500
    const spec = table(1, 2, PAD_TIGHT); // 表头 200 + 2×正文 200 = 600

    const withRepeat = run([tableBlock(spec)], g);
    const without = run([tableBlock(spec)], g, { repeatTableHeaderRows: false });

    expect(withRepeat.pages).toHaveLength(2);
    expect(without.pages).toHaveLength(2);

    // 默认：续页首行是重复表头
    const contWith = withRepeat.pages[1]?.tables[0];
    expect(contWith?.repeatedHeaderRowCount).toBe(1);
    expect(contWith?.rows[0]?.rowIndex).toBe(0);

    // 关闭：续页只有正文、无任何重复表头行
    const contWithout = without.pages[1]?.tables[0];
    expect(contWithout?.repeatedHeaderRowCount).toBe(0);
    expect(contWithout?.rows.every((r) => !r.header)).toBe(true);
    expect(contWithout?.rows.map((r) => r.rowIndex)).toEqual([2]);
  });
});

// ---------------------------------------------------------------------------
// §C 反向对照：加高一行把后续段落推到下一页
// ---------------------------------------------------------------------------

describe('§C 反向对照：表格变高把后续段落推走', () => {
  it('短表 ⇒ 尾段落留在第 0 页；加高表格 ⇒ 尾段落跑到第 1 页', () => {
    const g = geometry(1000); // 内容区 100..1100

    // 短表：表头 200 + 1 正文 200 = 400
    const short = run([...paraBlocks(['AAAA']), tableBlock(table(1, 1, PAD_TIGHT)), ...paraBlocks(['BBBB'])], g);
    // 高表：表头 300 + 2 正文 300 = 900（前缀段落 + 首行仍放得下，但整表把尾段落顶到下一页）
    const tall = run([...paraBlocks(['AAAA']), tableBlock(table(1, 2, PAD)), ...paraBlocks(['BBBB'])], g);

    expect(pageIndexOfLine(short.pages, 'BBBB')).toBe(0);
    expect(short.pages).toHaveLength(1);

    expect(pageIndexOfLine(tall.pages, 'BBBB')).toBe(1);
    expect(tall.pages).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// §D 表格放不下时整表移到下一页（不把表头留在页脚外）
// ---------------------------------------------------------------------------

describe('§D 表头 + 首行放不下 ⇒ 整表移页', () => {
  it('剩余空间不足 ⇒ 表格整体落到第 1 页顶部，不越过内容区底', () => {
    const g = geometry(600); // 内容区 100..700
    const { pages } = run([...paraBlocks(['AAAA']), tableBlock(table(1, 1, PAD))], g);

    expect(pages).toHaveLength(2);
    expect((pages[0] as UnifiedPageBox).lines.map((l) => l.text)).toEqual(['AAAA']);
    expect((pages[0] as UnifiedPageBox).tables).toHaveLength(0);

    const page1 = pages[1] as UnifiedPageBox;
    expect(page1.tables).toHaveLength(1);
    const placed = page1.tables[0];
    expect(placed?.topTwips).toBe(100); // 新页内容区顶
    // 100 + 600 = 700 == 内容区底，未越界
    expect((placed?.topTwips as number) + (placed?.heightTwips as number)).toBe(700);
  });
});

// ---------------------------------------------------------------------------
// §E 边界：只有表头 / 空文档 / 单行溢出
// ---------------------------------------------------------------------------

describe('§E 边界与 fail-honest', () => {
  it('只有表头行的表格：1 个切片、0 重复、无正文行', () => {
    const g = geometry(1000);
    const { pages } = run([...paraBlocks(['AAAA']), tableBlock(table(1, 0, PAD)), ...paraBlocks(['BBBB'])], g);
    expect(pages).toHaveLength(1);
    const placed = (pages[0] as UnifiedPageBox).tables[0];
    expect(placed?.rows).toHaveLength(1);
    expect(placed?.rows[0]?.header).toBe(true);
    expect(placed?.repeatedHeaderRowCount).toBe(0);
    expect(placed?.continuesOnNextPage).toBe(false);
    // 表格之后的段落仍在同一页（表头 300 高：300 → 600，段落在 600）
    expect((pages[0] as UnifiedPageBox).lines[1]?.topTwips).toBe(600);
  });

  it('空块列表 ⇒ 1 页空页（真页数由分页算出）', () => {
    const g = geometry(1000);
    const { pages } = run([], g);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.lines).toEqual([]);
    expect(pages[0]?.tables).toEqual([]);
    expect(pages[0]?.index).toBe(0);
  });

  it('单行高 > 整页内容区 ⇒ table_row_overflow，该行不裁切、不死循环', () => {
    const g = geometry(400); // 内容区 100..500
    // 40 个 A（文本宽 1800 ⇒ 每行 18 字 ⇒ 3 行）行高 3×200 + 100 = 700 > 400
    const tall = table(0, 1, PAD, 'A'.repeat(40));
    const { pages, diagnostics } = run([tableBlock(tall)], g);

    expect(codesOf(diagnostics)).toContain('table_row_overflow');
    expect(pages).toHaveLength(1);
    const row = (pages[0] as UnifiedPageBox).tables[0]?.rows[0];
    expect(row?.heightTwips).toBe(700); // 不裁切
  });

  it('反向对照：同样夹具行高 ≤ 内容区 ⇒ 无 table_row_overflow', () => {
    const g = geometry(400);
    const ok = table(0, 1, PAD, 'A'.repeat(9)); // 9 字 ⇒ 1 行 ⇒ 高 300 ≤ 400
    const { diagnostics } = run([tableBlock(ok)], g);
    expect(codesOf(diagnostics)).not.toContain('table_row_overflow');
  });
});
