/**
 * **X09 独立验收——大表分页 / 打印预览**。
 *
 * 判据不是"函数返回了东西"，而是**由几何真实算出的页数、每页行列、重复标题、手工分页**，
 * 每个能力配一条**反向对照**（"只截首屏"会怎样）。
 *
 * 单位口径（便于手算核对）：Letter 纵向 = 12240 × 15840 twips；Excel 默认边距
 * (0.7/0.7/0.75/0.75 英寸) ⇒ 内容区 **10224 × 13680** twips；默认列宽 8.43 字符 ⇒ **960**
 * twips/列；默认行高 15 pt ⇒ **300** twips/行。于是纵向每页 10 列（10×960=9600 ≤ 10224，
 * 11 列超）、45 行（45×300=13500 ≤ 13680，46 行超）。
 *
 * **未验证（需真机 / 消费端）**：真实 PDF 字节 / 打印机出纸；非默认字体下的列宽像素。
 */

import { describe, expect, it } from 'vitest';

import { ValidationError } from '../../../../src/protocol/index.js';
import {
  DEFAULT_MARGINS,
  buildPageSetupElement,
  createPrintLayout,
  isDefaultPrintLayout,
  setPageBreaks,
  setPageOrder,
  setPaperSize,
  setOrientation,
} from '../../../../src/spreadsheets/print-layout.js';
import { attributeValue, parseXml, type ParsedXmlElement } from '../../../../src/documents/docx/xml-parse.js';
import { serializeXmlDocument } from '../../../../src/artifacts/ooxml/index.js';
import type { CellRange } from '../../../../src/spreadsheets/reference.js';
import {
  buildPrintPreview,
  computePagePlan,
  excelColumnWidthToTwips,
  excelRowHeightToTwips,
  expandHeaderFooterCodes,
  headerFooterForPage,
  inchesToTwips,
  paperSizeTwips,
  resolvePrintSettings,
  splitHeaderFooterSections,
  type PagePlanInput,
  type ResolvedPrintSettings,
  type RowSpan,
  type SheetGridGeometry,
} from '../../../../src/mobile-plugins/spreadsheets/rendering/index.js';

// ---------------------------------------------------------------------------
// 助手
// ---------------------------------------------------------------------------

const COL = excelColumnWidthToTwips(8.43); // 960
const ROW = excelRowHeightToTwips(15); // 300

function makeGrid(
  rows: number,
  columns: number,
  extra: Partial<Pick<SheetGridGeometry, 'columnWidths' | 'rowHeights'>> = {},
): SheetGridGeometry {
  return {
    firstRow: 1,
    firstColumn: 1,
    lastRow: rows,
    lastColumn: columns,
    defaultColumnWidthTwips: COL,
    defaultRowHeightTwips: ROW,
    ...extra,
  };
}

function range(startRow: number, startColumn: number, endRow: number, endColumn: number): CellRange {
  return {
    start: { row: startRow, column: startColumn, abs_row: true, abs_column: true },
    end: { row: endRow, column: endColumn, abs_row: true, abs_column: true },
  };
}

function makeSettings(overrides: Partial<ResolvedPrintSettings> = {}): ResolvedPrintSettings {
  return {
    orientation: 'portrait',
    paperSize: 'letter',
    margins: DEFAULT_MARGINS,
    scaling: null,
    printArea: null,
    repeatRows: null,
    repeatColumns: null,
    manualRowBreaks: [],
    manualColumnBreaks: [],
    headerFooter: null,
    pageOrder: 'down_then_over',
    ...overrides,
  };
}

function plan(grid: SheetGridGeometry, overrides: Partial<ResolvedPrintSettings> = {}, maxPages?: number): ReturnType<typeof computePagePlan> {
  const settings = makeSettings(overrides);
  const input: PagePlanInput = maxPages === undefined ? { grid, settings } : { grid, settings, maxPages };
  return computePagePlan(input);
}

function span(start: number, end: number): RowSpan {
  return { start, end };
}

// ---------------------------------------------------------------------------
// 单位与纸张
// ---------------------------------------------------------------------------

describe('X09 单位与纸张几何', () => {
  it('默认列宽/行高换算到 twips', () => {
    expect(COL).toBe(960);
    expect(ROW).toBe(300);
    expect(inchesToTwips(0.7)).toBeCloseTo(1008, 9);
    expect(excelColumnWidthToTwips(8.43, 7)).toBe(960);
  });

  it('Letter 纵向 12240×15840；横向交换宽高', () => {
    expect(paperSizeTwips('letter', 'portrait')).toEqual({ widthTwips: 12240, heightTwips: 15840 });
    expect(paperSizeTwips('letter', 'landscape')).toEqual({ widthTwips: 15840, heightTwips: 12240 });
  });
});

// ---------------------------------------------------------------------------
// 分页：不能只截首屏
// ---------------------------------------------------------------------------

describe('X09 大表分页（不只截首屏）', () => {
  it('小表落一页，内容区 10224×13680', () => {
    const result = plan(makeGrid(10, 5));
    expect(result.contentBoxTwips).toEqual({ widthTwips: 10224, heightTwips: 13680 });
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.rows).toEqual(span(1, 10));
    expect(result.pages[0]?.columns).toEqual(span(1, 5));
    expect(result.ok).toBe(true);
  });

  it('100 行 → 3 页，末页覆盖第 100 行；反向：首屏只有 45 行', () => {
    const result = plan(makeGrid(100, 5));
    expect(result.rowStrips).toEqual([span(1, 45), span(46, 90), span(91, 100)]);
    expect(result.pages).toHaveLength(3);
    expect(result.pages[2]?.rows).toEqual(span(91, 100));
    // 反向对照：首屏导出只到第 45 行，绝不是全部
    expect(result.pages[0]?.rows.end).toBe(45);
    expect(result.pages[0]?.rows.end).not.toBe(100);
    expect(result.pages.length).toBeGreaterThan(1);
  });

  it('行同时向右溢出：100 行 × 20 列 → 3 行带 × 2 列带 = 6 页', () => {
    const result = plan(makeGrid(100, 20));
    expect(result.columnStrips).toEqual([span(1, 10), span(11, 20)]);
    expect(result.rowStrips).toHaveLength(3);
    expect(result.pages).toHaveLength(6);
    // down_then_over：先纵向打完第一列带
    expect(result.pages[3]?.columnStripIndex).toBe(1);
    expect(result.pages[3]?.rowStripIndex).toBe(0);
    expect(result.pages[3]?.columns).toEqual(span(11, 20));
  });

  it('列带覆盖到最后一列（不丢右侧）', () => {
    const result = plan(makeGrid(5, 23));
    // 10 + 10 + 3
    expect(result.columnStrips).toEqual([span(1, 10), span(11, 20), span(21, 23)]);
    expect(result.pages).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 手工分页符
// ---------------------------------------------------------------------------

describe('X09 手工分页符', () => {
  it('行分页符在指定行之后断页', () => {
    const result = plan(makeGrid(20, 3), { manualRowBreaks: [7] });
    expect(result.rowStrips).toEqual([span(1, 7), span(8, 20)]);
    expect(result.pages).toHaveLength(2);
  });

  it('列分页符在指定列之后断列', () => {
    const result = plan(makeGrid(5, 8), { manualColumnBreaks: [3] });
    expect(result.columnStrips).toEqual([span(1, 3), span(4, 8)]);
    expect(result.pages).toHaveLength(2);
  });

  it('反向对照：范围外的手工分页符被忽略，不凭空造页', () => {
    const result = plan(makeGrid(20, 3), { manualRowBreaks: [999] });
    expect(result.rowStrips).toEqual([span(1, 20)]);
    expect(result.pages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 重复标题行 / 列
// ---------------------------------------------------------------------------

describe('X09 重复标题（Print_Titles）', () => {
  it('重复标题行出现在每页，且从正文流剔除', () => {
    const result = plan(makeGrid(50, 8), { printArea: range(1, 1, 50, 8), repeatRows: span(1, 2) });
    expect(result.titleRows).toEqual(span(1, 2));
    expect(result.pages).toHaveLength(2);
    // 每页都有标题带
    expect(result.pages[0]?.titleRows).toEqual(span(1, 2));
    expect(result.pages[1]?.titleRows).toEqual(span(1, 2));
    // 正文从第 3 行开始（标题未在第 1 页正文里重复）
    expect(result.pages[0]?.rows.start).toBe(3);
    expect(result.pages[0]?.rows).toEqual(span(3, 45));
    expect(result.pages[1]?.rows).toEqual(span(46, 50));
  });

  it('重复标题列出现在每页，正文列从标题列之后开始', () => {
    const result = plan(makeGrid(50, 20), { printArea: range(1, 1, 50, 20), repeatColumns: span(1, 2) });
    expect(result.titleColumns).toEqual(span(1, 2));
    expect(result.columnStrips).toEqual([span(3, 10), span(11, 18), span(19, 20)]);
    expect(result.pages.every((page) => page.titleColumns?.start === 1 && page.titleColumns?.end === 2)).toBe(true);
    expect(result.pages[0]?.columns.start).toBe(3);
  });

  it('反向对照：标题带撑满整页 ⇒ 显式报错并不排正文', () => {
    const result = plan(makeGrid(200, 8), { printArea: range(1, 1, 200, 8), repeatRows: span(1, 50) });
    expect(result.diagnostics.map((d) => d.code)).toContain('title_band_too_tall');
    expect(result.ok).toBe(false);
    expect(result.pages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 方向 / 缩放
// ---------------------------------------------------------------------------

describe('X09 方向与缩放改变容量', () => {
  it('横向比纵向每页放更多列', () => {
    const portrait = plan(makeGrid(100, 12), { orientation: 'portrait' });
    const landscape = plan(makeGrid(100, 12), { orientation: 'landscape' });
    expect(portrait.columnStrips).toHaveLength(2); // 10 + 2
    expect(landscape.columnStrips).toHaveLength(1); // 12 全放得下
    expect(landscape.contentBoxTwips).toEqual({ widthTwips: 13824, heightTwips: 10080 });
  });

  it('百分比缩放 50% 让每页容量翻倍', () => {
    const result = plan(makeGrid(100, 12), { scaling: { kind: 'percent', percent: 50 } });
    expect(result.scale).toBe(0.5);
    expect(result.columnStrips).toHaveLength(1); // 12 列在半倍宽下全放下
    expect(result.rowStrips).toHaveLength(2); // 91 + 9
  });

  it('适配页宽 1 页：列带收敛到 1', () => {
    const result = plan(makeGrid(100, 12), { scaling: { kind: 'fit_to_pages', width: 1, height: 0 } });
    expect(result.columnStrips).toHaveLength(1);
    expect(result.scale).toBeLessThanOrEqual(1);
  });

  it('适配 1×1 页：行列带都不超过 1', () => {
    const result = plan(makeGrid(100, 12), { scaling: { kind: 'fit_to_pages', width: 1, height: 1 } });
    expect(result.columnStrips).toHaveLength(1);
    expect(result.rowStrips).toHaveLength(1);
    expect(result.pages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 打印顺序 / 上限 / 确定性
// ---------------------------------------------------------------------------

describe('X09 打印顺序、页数上限、确定性', () => {
  it('over_then_down 与 down_then_over 的页序不同', () => {
    const down = plan(makeGrid(100, 20), { pageOrder: 'down_then_over' });
    const over = plan(makeGrid(100, 20), { pageOrder: 'over_then_down' });
    // 第 2 页（index 1）
    expect(down.pages[1]?.rowStripIndex).toBe(1);
    expect(down.pages[1]?.columnStripIndex).toBe(0);
    expect(over.pages[1]?.rowStripIndex).toBe(0);
    expect(over.pages[1]?.columnStripIndex).toBe(1);
    expect(down.pages).toHaveLength(6);
    expect(over.pages).toHaveLength(6);
  });

  it('超过 maxPages 上限 ⇒ 截断 + 诊断 + ok=false', () => {
    const result = plan(makeGrid(100, 20), {}, 4);
    expect(result.truncated).toBe(true);
    expect(result.pages).toHaveLength(4);
    expect(result.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain('page_limit_exceeded');
  });

  it('确定性：同一输入两次结果逐字节相同', () => {
    const grid = makeGrid(100, 20);
    const a = JSON.stringify(plan(grid, { repeatRows: span(1, 1) }));
    const b = JSON.stringify(plan(grid, { repeatRows: span(1, 1) }));
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// 退化输入：诊断，不静默
// ---------------------------------------------------------------------------

describe('X09 退化输入给出诊断', () => {
  it('单列比整页还宽 ⇒ 警告但保留该列', () => {
    const result = plan(makeGrid(3, 2, { columnWidths: [[1, 20000]] }));
    expect(result.diagnostics.some((d) => d.code === 'column_wider_than_page')).toBe(true);
    expect(result.columnStrips[0]?.start).toBe(1);
    expect(result.ok).toBe(true); // 警告不翻转 ok
  });

  it('单行比整页还高 ⇒ 警告', () => {
    const result = plan(makeGrid(2, 2, { rowHeights: [[1, 20000]] }));
    expect(result.diagnostics.some((d) => d.code === 'row_taller_than_page')).toBe(true);
  });

  it('打印区域被标题带完全吃掉 ⇒ empty_content 且无页', () => {
    const result = plan(makeGrid(50, 8), { printArea: range(1, 1, 2, 8), repeatRows: span(1, 2) });
    expect(result.diagnostics.map((d) => d.code)).toContain('empty_content');
    expect(result.ok).toBe(false);
    expect(result.pages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 页眉页脚展开
// ---------------------------------------------------------------------------

describe('X09 页眉页脚', () => {
  it('拆左/中/右三段；无区码归中', () => {
    expect(splitHeaderFooterSections('&L左&C中&R右')).toEqual({ left: '左', center: '中', right: '右' });
    expect(splitHeaderFooterSections('纯文本')).toEqual({ left: '', center: '纯文本', right: '' });
  });

  it('展开 &P / &N / &&；未知 &x 原样保留', () => {
    expect(expandHeaderFooterCodes('第 &P 页 / 共 &N 页', { page: 2, totalPages: 5 })).toBe('第 2 页 / 共 5 页');
    expect(expandHeaderFooterCodes('A&&B', { page: 1, totalPages: 1 })).toBe('A&B');
    expect(expandHeaderFooterCodes('&D', { page: 1, totalPages: 1 })).toBe('&D');
  });

  it('奇偶页不同：偶页取 even_*，页码用真实分页数', () => {
    const layout = createPrintLayout({
      header_footer: {
        different_odd_even: true,
        odd_footer: '&C第 &P 页 / 共 &N 页',
        even_footer: '&R偶页',
      },
    });
    const preview = buildPrintPreview({ grid: makeGrid(100, 5), settings: resolvePrintSettings(layout) });
    expect(preview.totalPages).toBe(3);
    expect(preview.pages[0]?.footer?.center).toBe('第 1 页 / 共 3 页');
    expect(preview.pages[1]?.isOddPage).toBe(false);
    expect(preview.pages[1]?.footer?.right).toBe('偶页');
    expect(preview.pages[2]?.footer?.center).toBe('第 3 页 / 共 3 页');
  });

  it('首页不同：第 1 页取 first_*', () => {
    const layout = createPrintLayout({
      header_footer: { different_first: true, odd_header: '&C奇页', first_header: '&C首页' },
    });
    const preview = buildPrintPreview({ grid: makeGrid(100, 5), settings: resolvePrintSettings(layout) });
    expect(preview.pages[0]?.header?.center).toBe('首页');
    expect(preview.pages[1]?.header?.center).toBe('奇页');
  });

  it('headerFooterForPage 对 null 返回空', () => {
    expect(headerFooterForPage(null, 1, 1)).toEqual({ header: null, footer: null });
  });
});

// ---------------------------------------------------------------------------
// 与 print-layout.ts 的对接（解析真实 PrintLayout）
// ---------------------------------------------------------------------------

describe('X09 从 PrintLayout 解析并分页', () => {
  it('resolvePrintSettings 解析打印区域 / 重复标题 / 分页符 / 顺序', () => {
    const layout = createPrintLayout({
      orientation: 'landscape',
      paper_size: 'letter',
      print_area: 'A1:H50',
      repeat_rows: '1:2',
      row_breaks: [10],
      page_order: 'over_then_down',
    });
    const settings = resolvePrintSettings(layout);
    expect(settings.orientation).toBe('landscape');
    expect(settings.paperSize).toBe('letter');
    // parseRange 会带绝对标记（abs_row/abs_column），这里只核对坐标语义
    expect(settings.printArea?.start).toMatchObject({ row: 1, column: 1 });
    expect(settings.printArea?.end).toMatchObject({ row: 50, column: 8 });
    expect(settings.repeatRows).toEqual(span(1, 2));
    expect(settings.manualRowBreaks).toEqual([10]);
    expect(settings.pageOrder).toBe('over_then_down');

    const result = computePagePlan({ grid: makeGrid(50, 8), settings });
    expect(result.ok).toBe(true);
    expect(result.titleRows).toEqual(span(1, 2));
    // 手工分页符 10 落进正文后强制断页
    expect(result.rowStrips[0]?.end).toBe(10);
  });

  it('缺省设置等价纵向 Letter + 默认边距', () => {
    const settings = resolvePrintSettings(createPrintLayout());
    expect(settings.orientation).toBe('portrait');
    expect(settings.margins).toEqual(DEFAULT_MARGINS);
    expect(settings.pageOrder).toBe('down_then_over');
  });
});

// ---------------------------------------------------------------------------
// print-layout.ts 的 pageOrder 扩展（我拥有的文件）
// ---------------------------------------------------------------------------

describe('X09 print-layout pageOrder 落进 pageSetup 字节', () => {
  function pageSetupAttr(layout: ReturnType<typeof createPrintLayout>): string | null {
    const element = buildPageSetupElement(layout);
    if (element === null) return null;
    const parsed = parseXml(serializeXmlDocument(element)) as ParsedXmlElement;
    return attributeValue(parsed, '', 'pageOrder');
  }

  it('over_then_down 写 overThenDown', () => {
    expect(pageSetupAttr(setPageOrder(createPrintLayout(), 'over_then_down'))).toBe('overThenDown');
  });

  it('down_then_over 写 downThenOver', () => {
    expect(pageSetupAttr(setPageOrder(createPrintLayout(), 'down_then_over'))).toBe('downThenOver');
  });

  it('未设置不写 pageOrder，且仍算默认布局', () => {
    const layout = createPrintLayout();
    expect(pageSetupAttr(layout)).toBeNull();
    expect(isDefaultPrintLayout(layout)).toBe(true);
    expect(isDefaultPrintLayout(setPageOrder(layout, 'over_then_down'))).toBe(false);
  });

  it('非法顺序显式抛错', () => {
    expect(() => setPageOrder(createPrintLayout(), 'diagonal' as never)).toThrow(ValidationError);
  });

  it('与方向/纸张/边距共存时序列化仍合法（读回不抛）', () => {
    let layout = setOrientation(createPrintLayout(), 'landscape');
    layout = setPaperSize(layout, 'a4');
    layout = setPageOrder(layout, 'over_then_down');
    layout = setPageBreaks(layout, { rows: [5] });
    const element = buildPageSetupElement(layout);
    expect(element).not.toBeNull();
    expect(() => parseXml(serializeXmlDocument(element as never))).not.toThrow();
  });
});
