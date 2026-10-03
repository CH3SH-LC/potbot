/**
 * **W09 独立验证 §表**：表格图形排版（`tables.ts`）——列网格、合并跨度、行高、
 * 单元格内真实排版行、图形线段、行级分页与表头重复。
 *
 * ## 反向对照
 *
 * - 列宽 +1 twip ⇒ 单元格宽度 +1（证明几何是**算出来的**，不是常量表）；
 * - 行高由**真实内容行数**驱动（40 个 'A' ⇒ 3 行 ⇒ 高 700）；
 * - 分页切片里**不拆行**：每行整行落在某一页。
 */

import { describe, expect, it } from 'vitest';

import { LayoutError } from '../../../../src/mobile-plugins/word/rendering/errors.js';
import {
  layoutTable,
  paginateTable,
  type LayoutDiagnostic,
  type ParagraphSpec,
  type TableSpec,
} from '../../../../src/mobile-plugins/word/rendering/index.js';
import { createFixtureFontPort } from './fixtures/font-port.js';

const port = createFixtureFontPort();

/** Test Serif 10pt：拉丁 100 twips/字，汉字 200 twips/字；行高 200。 */
function p(text: string): ParagraphSpec {
  return { runs: [{ text, fontFamily: 'Test Serif', sizePt: 10 }] };
}

const PAD = { top: 50, bottom: 50, left: 100, right: 100 };

function table(rows: TableSpec['rows'], columnWidthsTwips: readonly number[], extra: Partial<TableSpec> = {}): TableSpec {
  return { rows, columnWidthsTwips, cellPaddingTwips: PAD, ...extra };
}

function expectLayoutError(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(LayoutError);
  expect((caught as LayoutError).code).toBe(code);
}

// ---------------------------------------------------------------------------
// §A 基本网格
// ---------------------------------------------------------------------------

describe('§A 基本网格几何', () => {
  const spec = table(
    [
      { cells: [{ blocks: [p('AAAA')] }, { blocks: [p('A')] }] },
      { cells: [{ blocks: [p('A')] }, { blocks: [p('AAAA')] }] },
    ],
    [2000, 3000],
  );

  it('列边界 = [0, 2000, 5000]；总宽 5000', () => {
    const t = layoutTable(spec, port);
    expect(t.columnEdgesTwips).toEqual([0, 2000, 5000]);
    expect(t.widthTwips).toBe(5000);
  });

  it('单元格：left/width 由列边界定，textWidth = 列宽 − 左右 padding', () => {
    const t = layoutTable(spec, port);
    const c0 = t.rows[0]?.cells[0];
    const c1 = t.rows[0]?.cells[1];
    expect(c0?.leftTwips).toBe(0);
    expect(c0?.widthTwips).toBe(2000);
    expect(c0?.textLeftTwips).toBe(100);
    expect(c0?.textWidthTwips).toBe(1800);
    expect(c1?.leftTwips).toBe(2000);
    expect(c1?.widthTwips).toBe(3000);
    expect(c1?.textWidthTwips).toBe(2800);
  });

  it('行高由内容驱动（1 行 ⇒ 200 + 上下 padding 100 = 300）', () => {
    const t = layoutTable(spec, port);
    expect(t.rows[0]?.heightTwips).toBe(300);
    expect(t.rows[1]?.topTwips).toBe(300);
    expect(t.heightTwips).toBe(600);
  });

  it('图形线段：每条行边界 1 横线（2 行 ⇒ 3 条），每条列边界 1 竖线（2 列 ⇒ 3 条）', () => {
    const t = layoutTable(spec, port);
    const h = t.borders.filter((b) => b.orientation === 'horizontal');
    const v = t.borders.filter((b) => b.orientation === 'vertical');
    expect(h).toHaveLength(3);
    expect(v).toHaveLength(3);
    // 横线 y 分别落在行顶/底
    expect(h.map((b) => b.y1Twips)).toEqual([0, 300, 600]);
    // 竖线 x 落在列边界
    expect(v.map((b) => b.x1Twips)).toEqual([0, 2000, 5000]);
  });

  it('反向对照：第一列宽 +1 twip ⇒ 该列单元格宽度 +1、第二列左边界 +1', () => {
    const t1 = layoutTable(spec, port);
    const t2 = layoutTable(table(spec.rows, [2001, 3000]), port);
    expect(t2.rows[0]?.cells[0]?.widthTwips).toBe((t1.rows[0]?.cells[0]?.widthTwips as number) + 1);
    expect(t2.rows[0]?.cells[1]?.leftTwips).toBe(2001);
  });
});

// ---------------------------------------------------------------------------
// §B 合并跨度
// ---------------------------------------------------------------------------

describe('§B colSpan / rowSpan', () => {
  it('colSpan=2：单元格宽 = 两列之和，覆盖列不再产出单元格', () => {
    const spec = table([{ cells: [{ blocks: [p('A')], colSpan: 2 }] }], [2000, 3000]);
    const t = layoutTable(spec, port);
    expect(t.rows[0]?.cells).toHaveLength(1);
    expect(t.rows[0]?.cells[0]?.widthTwips).toBe(5000);
    expect(t.rows[0]?.cells[0]?.textWidthTwips).toBe(5000 - 200);
    expect(t.rows[0]?.cells[0]?.colSpan).toBe(2);
  });

  it('rowSpan=2：单元格高 = 跨行行高之和；续行只填剩余列', () => {
    const spec = table(
      [
        { cells: [{ blocks: [p('中')], rowSpan: 2 }, { blocks: [p('A')] }] },
        { cells: [{ blocks: [p('A')] }] }, // 自动落到第 1 列（第 0 列被跨行占）
      ],
      [2000, 3000],
    );
    const t = layoutTable(spec, port);
    const spanning = t.rows[0]?.cells[0];
    expect(spanning?.rowSpan).toBe(2);
    expect(spanning?.heightTwips).toBe((t.rows[0]?.heightTwips as number) + (t.rows[1]?.heightTwips as number));
    // 第二行只有 1 个单元格，且在第 1 列
    expect(t.rows[1]?.cells).toHaveLength(1);
    expect(t.rows[1]?.cells[0]?.colIndex).toBe(1);
    expect(t.rows[1]?.cells[0]?.leftTwips).toBe(2000);
  });

  it('rowSpan 内容超出跨行高 ⇒ 均摊并产 table_rowspan_distributed', () => {
    // 第 0 列窄（300 twips ⇒ 文本 100），'中'× 多字换多行，跨 2 行时内容更高。
    const spec = table(
      [
        { cells: [{ blocks: [p('中中中中中中中中')], rowSpan: 2 }, { blocks: [p('A')] }], minHeightTwips: 100 },
        { cells: [{ blocks: [p('A')] }], minHeightTwips: 100 },
      ],
      [300, 3000],
    );
    const t = layoutTable(spec, port);
    expect(t.diagnostics.map((d) => d.code)).toContain('table_rowspan_distributed');
    // 跨行单元格高度至少等于其内容高（不裁切内容）
    const spanning = t.rows[0]?.cells[0];
    expect(spanning?.heightTwips as number).toBeGreaterThanOrEqual(spanning?.contentHeightTwips as number);
  });
});

// ---------------------------------------------------------------------------
// §C 行高由真实内容行数驱动
// ---------------------------------------------------------------------------

describe('§C 行高 ∝ 内容行数', () => {
  it("40 个 'A'（列宽 2000 ⇒ 每行 18 字）⇒ 3 行 ⇒ 行高 700", () => {
    const spec = table([{ cells: [{ blocks: [p('A'.repeat(40))] }] }], [2000]);
    const t = layoutTable(spec, port);
    const cell = t.rows[0]?.cells[0];
    expect(cell?.lines).toHaveLength(3);
    expect(t.rows[0]?.heightTwips).toBe(700); // 3×200 + 上下 padding 100
  });

  it('反向对照：35 个 A 仍是 2 行 ⇒ 行高 500', () => {
    const spec = table([{ cells: [{ blocks: [p('A'.repeat(35))] }] }], [2000]);
    const t = layoutTable(spec, port);
    expect(t.rows[0]?.cells[0]?.lines).toHaveLength(2);
    expect(t.rows[0]?.heightTwips).toBe(500);
  });

  it('单元格内行盒坐标相对表格左上角（含 padding 偏移）', () => {
    const spec = table([{ cells: [{ blocks: [p('AAAA')] }] }], [2000]);
    const t = layoutTable(spec, port);
    const line = t.rows[0]?.cells[0]?.lines[0];
    expect(line?.topTwips).toBe(50); // padding.top
    expect(line?.offsetXTwips).toBe(100); // padding.left
  });
});

// ---------------------------------------------------------------------------
// §D 行级分页 + 表头重复
// ---------------------------------------------------------------------------

describe('§D 分页', () => {
  /** 5 行各高 300：1 表头 + 4 正文。 */
  const rows: TableSpec['rows'] = [
    { cells: [{ blocks: [p('H')] }], header: true },
    ...Array.from({ length: 4 }, () => ({ cells: [{ blocks: [p('A')] }] })),
  ];

  it('每页内容高 700 ⇒ 4 切片；续页重复 1 行表头', () => {
    const t = layoutTable(table(rows, [2000]), port);
    const diags: LayoutDiagnostic[] = [];
    const slices = paginateTable(t, { contentHeightTwips: 700, diagnostics: diags });
    expect(slices).toHaveLength(4);
    expect(slices[0]?.repeatedHeaderRowCount).toBe(0);
    expect(slices[1]?.repeatedHeaderRowCount).toBe(1);
    expect(slices[1]?.rows[0]?.rowIndex).toBe(0); // 表头重复
    expect(slices[1]?.rows[0]?.topTwips).toBe(0);
    for (const s of slices) {
      expect(s.heightTwips).toBeLessThanOrEqual(700);
    }
    expect(diags.map((d) => d.code)).toContain('table_split');
  });

  it('不拆行：每行的 top/height 完整落在唯一一个切片里', () => {
    const t = layoutTable(table(rows, [2000]), port);
    const slices = paginateTable(t, { contentHeightTwips: 700 });
    const bodyRowIds = new Set<number>();
    for (const s of slices) {
      for (const r of s.rows) {
        // 行顶为正、行底 ≤ 切片高 ⇒ 整行在本切片内
        expect(r.topTwips).toBeGreaterThanOrEqual(0);
        expect(r.topTwips + r.heightTwips).toBeLessThanOrEqual(s.heightTwips + 1);
        if (r.rowIndex > 0) bodyRowIds.add(r.rowIndex);
      }
    }
    // 4 个正文行各出现一次
    expect([...bodyRowIds].sort((a, b) => a - b)).toEqual([1, 2, 3, 4]);
  });

  it('无表头且每页只放 1 行 ⇒ 5 切片，无重复表头', () => {
    const plain = table(Array.from({ length: 5 }, () => ({ cells: [{ blocks: [p('A')] }] })), [2000]);
    const t = layoutTable(plain, port);
    const slices = paginateTable(t, { contentHeightTwips: 300 });
    expect(slices).toHaveLength(5);
    expect(slices.every((s) => s.repeatedHeaderRowCount === 0)).toBe(true);
  });

  it('单行高 > 每页内容高 ⇒ table_row_overflow，且该行独占一页（不裁切、不死循环）', () => {
    const tall = table([{ cells: [{ blocks: [p('A'.repeat(40))] }] }], [2000]); // 行高 700
    const t = layoutTable(tall, port);
    const diags: LayoutDiagnostic[] = [];
    const slices = paginateTable(t, { contentHeightTwips: 400, diagnostics: diags });
    expect(slices).toHaveLength(1);
    expect(diags.map((d) => d.code)).toContain('table_row_overflow');
    expect(slices[0]?.rows[0]?.heightTwips).toBe(700); // 不裁切
  });

  it('每页内容高 ≤ 0 ⇒ 抛 invalid_page_geometry', () => {
    const t = layoutTable(table([{ cells: [{ blocks: [p('A')] }] }], [2000]), port);
    expectLayoutError(() => paginateTable(t, { contentHeightTwips: 0 }), 'invalid_page_geometry');
  });
});

// ---------------------------------------------------------------------------
// §E fail-closed 网格校验
// ---------------------------------------------------------------------------

describe('§E 网格校验 fail-closed', () => {
  it('列宽为空 ⇒ table_no_columns', () => {
    expectLayoutError(() => layoutTable(table([{ cells: [{ blocks: [p('A')] }] }], []), port), 'table_no_columns');
  });

  it('无行 ⇒ table_empty', () => {
    expectLayoutError(() => layoutTable(table([], [2000]), port), 'table_empty');
  });

  it('某行跨度和 ≠ 列数 ⇒ table_column_mismatch', () => {
    expectLayoutError(
      () => layoutTable(table([{ cells: [{ blocks: [p('A')] }] }], [2000, 3000]), port),
      'table_column_mismatch',
    );
  });

  it('colSpan 越界 ⇒ table_span_out_of_range', () => {
    expectLayoutError(
      () => layoutTable(table([{ cells: [{ blocks: [p('A')], colSpan: 3 }] }], [2000, 3000]), port),
      'table_span_out_of_range',
    );
  });

  it('与跨行占用冲突 ⇒ table_span_out_of_range（不静默叠单元格）', () => {
    const spec = table(
      [
        { cells: [{ blocks: [p('中')], rowSpan: 2 }, { blocks: [p('A')] }] },
        { cells: [{ blocks: [p('A')], colSpan: 2 }] }, // 第 0 列已被占，找不到 2 连空列
      ],
      [2000, 3000],
    );
    expectLayoutError(() => layoutTable(spec, port), 'table_span_out_of_range');
  });

  it('rowSpan 越界（跨出行数）⇒ table_span_out_of_range', () => {
    const spec = table([{ cells: [{ blocks: [p('A')], rowSpan: 2 }] }], [2000]);
    expectLayoutError(() => layoutTable(spec, port), 'table_span_out_of_range');
  });
});
