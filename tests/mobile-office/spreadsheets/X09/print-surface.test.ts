/**
 * **X09 集成硬化（X-I16）——多区域打印区域 + 页码单一来源**。
 *
 * 本波不重写既有 34 条判据（`pagination.test.ts`），而是补两块**接线级**能力：
 *
 * 1. **多区域打印区域**（OOXML `_xlnm.Print_Area` 的逗号分隔形态，含 X-R05 读回的
 *    `'预算'!$A$1:$D$12` 工作表前缀）：每个区域**独立分页**、跨区域**连续编号**；
 *    某区域被重复标题带吃光只**警告跳过**，不连累其它区域。
 * 2. **页码字段一致性**：`PagePlan.totalPages` / `PagePlanPage.pageNumber` 是**唯一来源**，
 *    `&P` / `&N` 展开直接取它，绝不另算一处。配反向对照证明"重算会怎样不一致"。
 *
 * 手算口径同 `pagination.test.ts`：Letter 纵向内容区 10224×13680 twips；960 twips/列
 * ⇒ 10 列/页；300 twips/行 ⇒ 45 行/页。
 *
 * **未验证（需真机 / 消费端）**：真实 PDF 字节、打印机出纸、Android 侧像素映射。
 */

import { describe, expect, it } from 'vitest';

import { EMPTY_PRINT_LAYOUT, createPrintLayout } from '../../../../src/spreadsheets/print-layout.js';
import type { CellRange } from '../../../../src/spreadsheets/reference.js';
import {
  buildPrintPreview,
  computePagePlan,
  excelColumnWidthToTwips,
  excelRowHeightToTwips,
  headerFooterForPlanPage,
  parsePrintAreaList,
  resolvePrintSettings,
  type PagePlanInput,
  type ResolvedPrintSettings,
  type RowSpan,
  type SheetGridGeometry,
} from '../../../../src/mobile-plugins/spreadsheets/rendering/index.js';

// ---------------------------------------------------------------------------
// 助手（与 pagination.test.ts 同口径）
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
    margins: { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
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
// 1. 多区域打印区域解析
// ---------------------------------------------------------------------------

describe('X09 打印区域解析（单区域 / 工作表前缀 / 多区域）', () => {
  it('单区域：一段返回长度 1 的数组，坐标语义正确', () => {
    const areas = parsePrintAreaList('$A$1:$H$10');
    expect(areas).toHaveLength(1);
    expect(areas[0]?.start).toMatchObject({ row: 1, column: 1 });
    expect(areas[0]?.end).toMatchObject({ row: 10, column: 8 });
  });

  it('工作表前缀（X-R05 读回的 definedName 正文）被剥离后解析', () => {
    const areas = parsePrintAreaList("'预算'!$A$1:$D$12");
    expect(areas).toHaveLength(1);
    expect(areas[0]?.start).toMatchObject({ row: 1, column: 1 });
    expect(areas[0]?.end).toMatchObject({ row: 12, column: 4 });
  });

  it('多区域：逗号分隔的多个 表!区域 各成一段', () => {
    const areas = parsePrintAreaList("'S'!$A$1:$H$10,'S'!$A$20:$H$30");
    expect(areas).toHaveLength(2);
    expect(areas[0]?.start).toMatchObject({ row: 1, column: 1 });
    expect(areas[0]?.end).toMatchObject({ row: 10, column: 8 });
    expect(areas[1]?.start).toMatchObject({ row: 20, column: 1 });
    expect(areas[1]?.end).toMatchObject({ row: 30, column: 8 });
  });

  it('工作表名里的逗号不当作区域分隔（引号感知）', () => {
    const areas = parsePrintAreaList("'S,1'!$A$1:$B$2,'S,1'!$D$1:$E$2");
    expect(areas).toHaveLength(2);
    expect(areas[1]?.start).toMatchObject({ row: 1, column: 4 });
  });

  it('空文本 → 空数组；非法区域显式抛 RenderingError（不静默）', () => {
    expect(parsePrintAreaList('   ')).toHaveLength(0);
    expect(() => parsePrintAreaList('A1:B2:C3')).toThrow(/print_area/);
  });
});

// ---------------------------------------------------------------------------
// 2. resolvePrintSettings 的单/多区域分派
// ---------------------------------------------------------------------------

describe('X09 resolvePrintSettings：单区域走 printArea，多区域走 printAreas', () => {
  it('单区域：printArea 设置，printAreas 为 null', () => {
    const settings = resolvePrintSettings({ ...EMPTY_PRINT_LAYOUT, print_area: '$A$1:$H$10' });
    expect(settings.printArea).not.toBeNull();
    expect(settings.printArea?.end).toMatchObject({ row: 10, column: 8 });
    expect(settings.printAreas ?? null).toBeNull();
  });

  it('多区域：printArea 为 null，printAreas 承载全部区域', () => {
    const settings = resolvePrintSettings({
      ...EMPTY_PRINT_LAYOUT,
      print_area: "'S'!$A$1:$H$10,'S'!$A$20:$H$30",
    });
    expect(settings.printArea).toBeNull();
    expect(settings.printAreas).toHaveLength(2);
    expect(settings.printAreas?.[1]?.start.row).toBe(20);
  });

  it('未设打印区域：两者都为 null（= 用整个已用区域）', () => {
    const settings = resolvePrintSettings(EMPTY_PRINT_LAYOUT);
    expect(settings.printArea).toBeNull();
    expect(settings.printAreas ?? null).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. 多区域分页：每个区域独立、跨区域连续编号
// ---------------------------------------------------------------------------

describe('X09 多区域分页', () => {
  it('两个区域各自分页：1 页 + 2 页 = 3 页，行范围归属正确', () => {
    const result = plan(makeGrid(120, 20), {
      printAreas: [range(1, 1, 40, 8), range(50, 1, 120, 8)],
    });
    expect(result.pages).toHaveLength(3);
    expect(result.totalPages).toBe(3);
    expect(result.areas).toHaveLength(2);

    // 反向对照：若忽略多区域（只按第一区域排），只会有 1 页、末行只到 40。
    expect(result.pages.length).toBeGreaterThan(1);
    expect(result.pages[2]?.rows.end).toBe(120);

    expect(result.pages[0]).toMatchObject({ areaIndex: 0, rows: span(1, 40), columns: span(1, 8) });
    expect(result.pages[1]).toMatchObject({ areaIndex: 1, rows: span(50, 94), columns: span(1, 8) });
    expect(result.pages[2]).toMatchObject({ areaIndex: 1, rows: span(95, 120), columns: span(1, 8) });

    expect(result.areas[0]).toMatchObject({ index: 0, pageStart: 0, pageEnd: 1 });
    expect(result.areas[1]).toMatchObject({ index: 1, pageStart: 1, pageEnd: 3 });
    expect(result.areas[1]?.rowStrips).toEqual([span(50, 94), span(95, 120)]);
  });

  it('多区域各自的列带独立（横向两个区域）', () => {
    const result = plan(makeGrid(5, 30), {
      printAreas: [range(1, 1, 5, 10), range(1, 14, 5, 23)],
    });
    expect(result.pages).toHaveLength(2);
    expect(result.pages[0]?.columns).toEqual(span(1, 10));
    expect(result.pages[1]?.columns).toEqual(span(14, 23));
    expect(result.areas[0]?.columnStrips).toEqual([span(1, 10)]);
    expect(result.areas[1]?.columnStrips).toEqual([span(14, 23)]);
  });

  it('区域宽于整页时在其内部继续切列带（11 列 → 10 + 1）', () => {
    const result = plan(makeGrid(5, 30), { printAreas: [range(1, 14, 5, 24)] });
    expect(result.pages).toHaveLength(2);
    expect(result.areas[0]?.columnStrips).toEqual([span(14, 23), span(24, 24)]);
    expect(result.pages.map((page) => page.areaIndex)).toEqual([0, 0]);
  });

  it('重复标题带对每个区域生效，且从各自正文流剔除', () => {
    const result = plan(makeGrid(30, 8), {
      repeatRows: span(1, 2),
      printAreas: [range(1, 1, 10, 8), range(20, 1, 30, 8)],
    });
    expect(result.pages).toHaveLength(2);
    // 区域 1：1..10 剔除 1..2 ⇒ 3..10
    expect(result.pages[0]?.rows).toEqual(span(3, 10));
    // 区域 2：20..30 与标题 1..2 不相交 ⇒ 原样
    expect(result.pages[1]?.rows).toEqual(span(20, 30));
    // 每页都带同一标题带
    expect(result.pages.every((page) => page.titleRows?.start === 1 && page.titleRows?.end === 2)).toBe(true);
  });

  it('fit_to_pages 对**每个**区域都收敛到目标（不只压第一个）', () => {
    const result = plan(makeGrid(400, 8), {
      scaling: { kind: 'fit_to_pages', width: 1, height: 1 },
      printAreas: [range(1, 1, 100, 8), range(150, 1, 400, 8)],
    });
    expect(result.scale).toBeLessThan(1);
    for (const area of result.areas) {
      expect(area.rowStrips).toHaveLength(1);
      expect(area.columnStrips).toHaveLength(1);
    }
    expect(result.pages).toHaveLength(2);
  });

  it('单区域：顶层分带 === areas[0] 的分带（向后兼容），areas[0].area 为 null 表示用已用区域', () => {
    const result = plan(makeGrid(100, 5));
    expect(result.areas).toHaveLength(1);
    expect(result.areas[0]?.area).toBeNull();
    expect(result.columnStrips).toEqual(result.areas[0]?.columnStrips);
    expect(result.rowStrips).toEqual(result.areas[0]?.rowStrips);
  });

  it('area 元数据回填传入的区域对象', () => {
    const a1 = range(1, 1, 40, 8);
    const a2 = range(50, 1, 120, 8);
    const result = plan(makeGrid(120, 20), { printAreas: [a1, a2] });
    expect(result.areas[0]?.area).toEqual(a1);
    expect(result.areas[1]?.area).toEqual(a2);
  });
});

// ---------------------------------------------------------------------------
// 4. 多区域里的退化区域：警告跳过，不连累好区域
// ---------------------------------------------------------------------------

describe('X09 多区域退化输入', () => {
  it('一个区域被重复标题带吃光 ⇒ 警告跳过，其它区域照排（ok 仍为 true）', () => {
    const result = plan(makeGrid(50, 8), {
      repeatRows: span(1, 2),
      printAreas: [range(1, 1, 2, 8), range(10, 1, 30, 8)],
    });
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.rows).toEqual(span(10, 30));
    expect(result.ok).toBe(true);
    const warning = result.diagnostics.find((diagnostic) => diagnostic.code === 'empty_print_area');
    expect(warning?.severity).toBe('warning');
  });

  it('所有区域都被吃光 ⇒ empty_content（error），无页', () => {
    const result = plan(makeGrid(50, 8), {
      repeatRows: span(1, 2),
      printAreas: [range(1, 1, 2, 8), range(3, 1, 2, 8)],
    });
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain('empty_content');
    expect(result.ok).toBe(false);
    expect(result.pages).toHaveLength(0);
    expect(result.areas).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. 页码字段一致性：&P / &N 只从 plan 来
// ---------------------------------------------------------------------------

describe('X09 页码单一来源（&P / &N 不重算）', () => {
  it('plan.totalPages === pages.length；pageNumber === index + 1 且跨区域连续', () => {
    const result = plan(makeGrid(120, 20), {
      printAreas: [range(1, 1, 40, 8), range(50, 1, 120, 8)],
    });
    expect(result.totalPages).toBe(result.pages.length);
    result.pages.forEach((page, index) => {
      expect(page.pageNumber).toBe(index + 1);
    });
    // 第 2、3 页落在区域 1，但页码继续 2、3（不因换区域归零）
    expect(result.pages.map((page) => page.pageNumber)).toEqual([1, 2, 3]);
  });

  it('页眉页脚 &P/&N 展开 === plan 的 pageNumber/totalPages（逐页核对）', () => {
    const layout = createPrintLayout({ header_footer: { odd_footer: '&C第 &P 页 / 共 &N 页' } });
    const settings = resolvePrintSettings(layout);
    const preview = buildPrintPreview({ grid: makeGrid(200, 8), settings });

    expect(preview.totalPages).toBe(preview.plan.totalPages);
    expect(preview.totalPages).toBe(5); // 200 行 / 45 行每页 = 5 页
    preview.pages.forEach((page, index) => {
      expect(page.pageNumber).toBe(preview.plan.pages[index]?.pageNumber);
      expect(page.footer?.center).toBe(`第 ${index + 1} 页 / 共 5 页`);
    });
    // &N 在每页相同（唯一来源），&P 逐页递增且互异
    const totals = new Set(preview.pages.map((page) => page.footer?.center?.split('/ 共 ')[1]));
    expect(totals.size).toBe(1);
    expect(new Set(preview.pages.map((page) => page.pageNumber)).size).toBe(preview.totalPages);
  });

  it('多区域预览：页码跨区域连续，&N 覆盖全部区域', () => {
    const layout = createPrintLayout({ header_footer: { odd_header: '&L区域&P&C共&N页' } });
    const settings = resolvePrintSettings(layout);
    const preview = buildPrintPreview({
      grid: makeGrid(120, 20),
      settings: { ...settings, printAreas: [range(1, 1, 40, 8), range(50, 1, 120, 8)] },
    });
    expect(preview.totalPages).toBe(3);
    expect(preview.pages.map((page) => page.areaIndex)).toEqual([0, 1, 1]);
    expect(preview.pages[1]?.header?.left).toBe('区域2');
    expect(preview.pages[1]?.header?.center).toBe('共3页');
    expect(preview.pages[2]?.header?.center).toBe('共3页');
  });

  it('headerFooterForPlanPage 与 buildPrintPreview 逐页一致（适配器可直接用 plan）', () => {
    const layout = createPrintLayout({ header_footer: { odd_footer: '&R&P/&N' } });
    const settings = resolvePrintSettings(layout);
    const preview = buildPrintPreview({ grid: makeGrid(100, 5), settings });
    for (let index = 0; index < preview.pages.length; index += 1) {
      const viaPlan = headerFooterForPlanPage(settings.headerFooter, preview.plan, index);
      expect(viaPlan.footer).toEqual(preview.pages[index]?.footer);
    }
    // 越界返回空，不抛
    expect(headerFooterForPlanPage(settings.headerFooter, preview.plan, 99)).toEqual({ header: null, footer: null });
  });

  it('反向对照：截断时 &N 用**截断后**的 totalPages，且每页一致（不会一页一个数）', () => {
    const layout = createPrintLayout({ header_footer: { odd_footer: '&C&P/&N' } });
    const settings = resolvePrintSettings(layout);
    const preview = buildPrintPreview({ grid: makeGrid(200, 8), settings, maxPages: 2 });
    expect(preview.plan.truncated).toBe(true);
    expect(preview.totalPages).toBe(2);
    expect(preview.plan.totalPages).toBe(2);
    expect(preview.pages.map((page) => page.footer?.center)).toEqual(['1/2', '2/2']);
  });

  it('反向对照：页内 &P 互不相同，若重算（都写 1）会立刻不一致', () => {
    const preview = buildPrintPreview({
      grid: makeGrid(200, 8),
      settings: makeSettings({ headerFooter: { odd_footer: '&P' } }),
    });
    const rendered = preview.pages.map((page) => page.footer?.center);
    expect(rendered).toEqual(['1', '2', '3', '4', '5']);
    expect(new Set(rendered).size).toBe(rendered.length);
  });
});
