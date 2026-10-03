/**
 * 表格用例（design-06 P9 / PPT-08）。
 *
 * 判据：
 *
 * - **合并格产出真 XML**：`gridSpan` / `rowSpan` / `hMerge` / `vMerge` 由**真解析器**读回校验，
 *   不是"字符串里看着有"；
 * - **增删行列不静默破坏合并**：删一列若落在合并区域内 ⇒ 具名报错；
 * - **格式跟着格子走**：插一行之后，原来的格子格式必须落在新索引上（重映射），不错位；
 * - **数据来源与共享事实一致**：单元格里的 `fact` 引用与文本框走同一个 `resolveRunText`，
 *   缺失 ⇒ 占位文本（**不是** `0`）。
 */

import { describe, expect, it } from 'vitest';

import {
  MISSING_FACT_PLACEHOLDER,
  literalText,
  transform,
  type FactSnapshot,
  type Shape,
  type TableShape,
  type TextBody,
} from './model.js';
import { addShape, addSlide } from './operations.js';
import { emptyPresentation } from './render.js';
import {
  DEFAULT_ROW_HEIGHT_EMU,
  PresentationTableError,
  addTable,
  cellFormat,
  cellKey,
  clearCellFormat,
  insertColumn,
  insertRow,
  mergeCells,
  planTableGrid,
  readTableFrameSpans,
  removeColumn,
  removeRow,
  renderTableFrameXml,
  requireTable,
  resolveCellText,
  resolveTableText,
  setCellFormat,
  setCellText,
  splitCell,
  tableMergeRegions,
  verifyTableMergeRoundTrip,
  wrapTableInSlideDocument,
} from './tables.js';
import { attributeOf, childElements, parseXmlDocument, type XmlElementNode } from './xml-parse.js';

const SNAPSHOT: FactSnapshot = [
  { fact_key: 'budget', value: { type: 'number', amount: 1200.5, unit: '元', currency: null } },
];

function deckWithSlides(count: number) {
  let deck = emptyPresentation('p1', '表格测试');
  for (let i = 0; i < count; i += 1) {
    deck = addSlide(deck).presentation;
  }
  return deck;
}

function elements(node: XmlElementNode, name: string, out: XmlElementNode[] = []): XmlElementNode[] {
  if (node.name === name) out.push(node);
  for (const child of childElements(node)) elements(child, name, out);
  return out;
}

function factCellRuns(text: string): TextBody {
  return { paragraphs: [{ runs: [{ source: { kind: 'literal', text } }], level: 0, alignment: 'left', bullet: false }] };
}

function grid(rows: number, columns: number) {
  const added = addTable(deckWithSlides(1), 1, {
    transform: transform(838200, 457200, 4000000, 2000000),
    rows,
    columns,
  });
  return { presentation: added.presentation, table_id: added.shape_id };
}

describe('PPT-08：表格结构（网格规划 + 合并的真实 XML）', () => {
  it('3×3 表格：gridCol 三个、a:tr 三行，每行 a:tc 三格', () => {
    const { presentation, table_id } = grid(3, 3);
    const table = requireTable(presentation, 1, table_id);
    const frame = renderTableFrameXml(table);

    const root = parseXmlDocument(wrapTableInSlideDocument(frame));
    expect(elements(root, 'p:graphicFrame')).toHaveLength(1);
    expect(elements(root, 'a:gridCol')).toHaveLength(3);
    expect(elements(root, 'a:tr')).toHaveLength(3);
    for (const tr of elements(root, 'a:tr')) {
      expect(attributeOf(tr, 'h')).toBe(String(DEFAULT_ROW_HEIGHT_EMU));
      expect(childElements(tr, 'a:tc')).toHaveLength(3);
    }
  });

  it('合并 2 列：源格带 gridSpan，右侧一格是 hMerge 延续格，且延续格文本为空', () => {
    const { presentation, table_id } = grid(2, 3);
    let deck = setCellText(presentation, 1, table_id, 0, 0, factCellRuns('合并标题'));
    deck = mergeCells(deck, 1, table_id, { row: 0, col: 0, row_span: 1, col_span: 2 });

    const table = requireTable(deck, 1, table_id);
    const plan = planTableGrid(table);
    expect(plan[0]?.[0]).toMatchObject({ grid_span: 2, row_span: 1, h_merge: false });
    expect(plan[0]?.[1]).toMatchObject({ grid_span: 1, h_merge: true });
    expect(plan[0]?.[2]).toMatchObject({ h_merge: false });

    const root = parseXmlDocument(wrapTableInSlideDocument(renderTableFrameXml(table)));
    const firstRow = elements(root, 'a:tr')[0];
    const cells = childElements(firstRow, 'a:tc');
    expect(attributeOf(cells[0], 'gridSpan')).toBe('2');
    expect(attributeOf(cells[1], 'hMerge')).toBe('1');
    expect(attributeOf(cells[2], 'hMerge')).toBeUndefined();
    // 源格的文本在产物里（合并后的标题仍是可编辑文本）。
    const originText = elements(cells[0] as XmlElementNode, 'a:t')[0];
    expect(originText?.children[0]).toMatchObject({ kind: 'text', text: '合并标题' });

    // 延续格**不能**再被写文本（写在该合并的源格上）。
    try {
      setCellText(deck, 1, table_id, 0, 1, factCellRuns('不该在这'));
      throw new Error('应当报错');
    } catch (error) {
      expect((error as PresentationTableError).reason).toBe('merge_conflict');
    }
    // 拆开之后又能写。
    const split = splitCell(deck, 1, table_id, 0, 0);
    expect(planTableGrid(requireTable(split, 1, table_id))[0]?.[0]).toMatchObject({ grid_span: 1, row_span: 1 });
  });

  it('纵向合并 2 行：源格 rowSpan，下一行同列是 vMerge 延续格', () => {
    const { presentation, table_id } = grid(3, 2);
    const deck = mergeCells(presentation, 1, table_id, { row: 1, col: 0, row_span: 2, col_span: 1 });
    const root = parseXmlDocument(wrapTableInSlideDocument(renderTableFrameXml(requireTable(deck, 1, table_id))));
    const rows = elements(root, 'a:tr');
    expect(attributeOf(childElements(rows[1], 'a:tc')[0], 'rowSpan')).toBe('2');
    expect(attributeOf(childElements(rows[2], 'a:tc')[0], 'vMerge')).toBe('1');
    // 该行另一列不受影响。
    expect(attributeOf(childElements(rows[2], 'a:tc')[1], 'vMerge')).toBeUndefined();
  });

  it('网格与合并表示对不上 ⇒ grid_mismatch / grid_overflow（不产出半张表）', () => {
    const { presentation, table_id } = grid(2, 3);
    const table = requireTable(presentation, 1, table_id);

    // 第一行只剩 1 格（另外两格"消失"）⇒ 行内网格列数对不上。
    const tooFew: TableShape = { ...table, rows: [{ cells: [table.rows[0]?.cells[0] as never] }, ...table.rows.slice(1)] };
    try {
      planTableGrid(tooFew);
      throw new Error('应当报错');
    } catch (error) {
      expect((error as PresentationTableError).reason).toBe('grid_mismatch');
    }

    // 第一行多出一格 ⇒ 超出网格列数。
    const tooMany: TableShape = {
      ...table,
      rows: [
        { cells: [...(table.rows[0]?.cells ?? []), { text: null, col_span: 1, row_span: 1 }] },
        ...table.rows.slice(1),
      ],
    };
    try {
      planTableGrid(tooMany);
      throw new Error('应当报错');
    } catch (error) {
      expect((error as PresentationTableError).reason).toBe('grid_overflow');
    }

    // 横向合并跨出网格 ⇒ 也是 grid_overflow。
    const overflow: TableShape = {
      ...table,
      rows: [{ cells: [{ text: null, col_span: 4, row_span: 1 }, ...(table.rows[0]?.cells.slice(1) ?? [])] }, ...table.rows.slice(1)],
    };
    try {
      planTableGrid(overflow);
      throw new Error('应当报错');
    } catch (error) {
      expect((error as PresentationTableError).reason).toBe('grid_overflow');
    }
  });
});

describe('PPT-08：增删行列（不可变；与合并冲突时具名报错）', () => {
  it('插入 / 删除行：行数与内容随之变化，且不改入参', () => {
    const { presentation, table_id } = grid(2, 2);
    const inserted = insertRow(presentation, 1, table_id, 0);
    expect(requireTable(inserted.presentation, 1, table_id).rows).toHaveLength(3);
    expect(requireTable(presentation, 1, table_id).rows).toHaveLength(2);

    const removed = removeRow(inserted.presentation, 1, table_id, 0);
    expect(requireTable(removed.presentation, 1, table_id).rows).toHaveLength(2);
    expect(() => removeRow(removed.presentation, 1, table_id, 99)).toThrow(PresentationTableError);
  });

  it('插入 / 删除列：列宽数组同步变化', () => {
    const { presentation, table_id } = grid(2, 2);
    const inserted = insertColumn(presentation, 1, table_id, 1, { width_emu: 1000 });
    const table = requireTable(inserted.presentation, 1, table_id);
    expect(table.column_widths_emu).toEqual([1828800, 1000, 1828800]);
    for (const row of table.rows) {
      expect(row.cells).toHaveLength(3);
    }

    const removed = removeColumn(inserted.presentation, 1, table_id, 1);
    expect(requireTable(removed.presentation, 1, table_id).column_widths_emu).toEqual([1828800, 1828800]);
  });

  it('删除落在合并区域内的行 / 列 ⇒ merge_conflict（不静默拆掉合并）', () => {
    const { presentation, table_id } = grid(3, 3);
    const merged = mergeCells(presentation, 1, table_id, { row: 0, col: 0, row_span: 2, col_span: 2 });

    for (const call of [
      () => removeRow(merged, 1, table_id, 0),
      () => removeRow(merged, 1, table_id, 1),
      () => removeColumn(merged, 1, table_id, 0),
      () => removeColumn(merged, 1, table_id, 1),
    ]) {
      try {
        call();
        throw new Error('应当报错');
      } catch (error) {
        expect((error as PresentationTableError).reason).toBe('merge_conflict');
      }
    }
    // 合并之外的第三行/第三列可以删。
    expect(requireTable(removeRow(merged, 1, table_id, 2).presentation, 1, table_id).rows).toHaveLength(2);
  });

  it('与已有合并重叠的合并请求 ⇒ merge_conflict；单格"合并" ⇒ merge_conflict', () => {
    const { presentation, table_id } = grid(3, 3);
    const merged = mergeCells(presentation, 1, table_id, { row: 0, col: 0, row_span: 1, col_span: 2 });
    try {
      mergeCells(merged, 1, table_id, { row: 0, col: 1, row_span: 1, col_span: 2 });
      throw new Error('应当报错');
    } catch (error) {
      expect((error as PresentationTableError).reason).toBe('merge_conflict');
    }
    try {
      mergeCells(merged, 1, table_id, { row: 2, col: 0, row_span: 1, col_span: 1 });
      throw new Error('应当报错');
    } catch (error) {
      expect((error as PresentationTableError).reason).toBe('merge_conflict');
    }
  });

  it('越界与非表格对象 ⇒ 具名报错', () => {
    const { presentation, table_id } = grid(2, 2);
    const box: Shape = {
      kind: 'text_box',
      shape_id: 9,
      name: 'Box',
      transform: transform(0, 0, 100, 100),
      text: literalText('不是表格'),
    };
    const deck = addShape(presentation, 1, box);
    try {
      requireTable(deck, 1, 9);
      throw new Error('应当报错');
    } catch (error) {
      expect((error as PresentationTableError).reason).toBe('not_a_table');
    }
    try {
      insertRow(deck, 1, table_id, 99);
      throw new Error('应当报错');
    } catch (error) {
      expect((error as PresentationTableError).reason).toBe('out_of_bounds');
    }
    expect(() => addTable(deck, 1, { transform: transform(0, 0, 1, 1), rows: 0, columns: 2 })).toThrow(
      PresentationTableError,
    );
  });
});

describe('PPT-08：单元格排版（底纹 / 边框 / 字体 / 对齐）', () => {
  it('格式表跨行列**重映射**：插一行后原来的格式跟到新索引', () => {
    const { presentation, table_id } = grid(2, 2);
    let formats = setCellFormat(new Map(), table_id, 1, 0, { fill: 'FFF2CC' });
    expect(cellFormat(formats, table_id, 1, 0).fill).toBe('FFF2CC');

    const inserted = insertRow(presentation, 1, table_id, 0, formats);
    formats = inserted.formats;
    // 原 (1,0) 变成 (2,0)。
    expect(cellFormat(formats, table_id, 2, 0).fill).toBe('FFF2CC');
    expect(formats.has(cellKey(table_id, 1, 0))).toBe(false);

    const removed = removeRow(inserted.presentation, 1, table_id, 0, formats);
    formats = removed.formats;
    expect(cellFormat(formats, table_id, 1, 0).fill).toBe('FFF2CC');

    const withCol = insertColumn(removed.presentation, 1, table_id, 0, { formats });
    expect(cellFormat(withCol.formats, table_id, 1, 1).fill).toBe('FFF2CC');
    expect(cellFormat(clearCellFormat(withCol.formats, table_id, 1, 1), table_id, 1, 1).fill).toBeNull();
  });

  it('底纹 / 四边边框 / 粗体字 / 居中对齐都写进 a:tcPr 与 a:rPr', () => {
    const { presentation, table_id } = grid(1, 1);
    let deck = setCellText(presentation, 1, table_id, 0, 0, factCellRuns('项目'));
    const formats = setCellFormat(new Map(), table_id, 0, 0, {
      fill: 'D9E2F3',
      borders: { top: 'FF0000', bottom: '00FF00', left: '0000FF', right: null },
      font: { bold: true, size_pt: 14, color: '1F3864' },
      alignment: 'center',
    });
    deck = setCellText(deck, 1, table_id, 0, 0, factCellRuns('项目'));

    const frame = renderTableFrameXml(requireTable(deck, 1, table_id), { formats });
    const root = parseXmlDocument(wrapTableInSlideDocument(frame));
    const tcPr = elements(root, 'a:tcPr')[0];
    // 底纹是 `a:tcPr` 的**直接**子元素 `a:solidFill`（边框里的 solidFill 在 a:lnX 内，不算）。
    const cellFill = childElements(childElements(tcPr, 'a:solidFill')[0], 'a:srgbClr')[0];
    expect(attributeOf(cellFill, 'val')).toBe('D9E2F3');
    for (const [tag, color] of [
      ['a:lnT', 'FF0000'],
      ['a:lnB', '00FF00'],
      ['a:lnL', '0000FF'],
    ] as const) {
      const line = elements(root, tag)[0];
      expect(attributeOf(elements(line as XmlElementNode, 'a:srgbClr')[0], 'val')).toBe(color);
      expect(attributeOf(line, 'w')).toBe('12700');
    }
    expect(elements(root, 'a:lnR')).toHaveLength(0);

    const rPr = elements(root, 'a:rPr')[0];
    expect(attributeOf(rPr, 'b')).toBe('1');
    expect(attributeOf(rPr, 'sz')).toBe('1400');
    const pPr = elements(root, 'a:pPr')[0];
    expect(attributeOf(pPr, 'algn')).toBe('ctr');
  });

  it('XML 文本被正确转义（不是裸拼字符串）', () => {
    const { presentation, table_id } = grid(1, 1);
    const deck = setCellText(presentation, 1, table_id, 0, 0, factCellRuns('A & B <C> "D"'));
    const root = parseXmlDocument(wrapTableInSlideDocument(renderTableFrameXml(requireTable(deck, 1, table_id))));
    const text = elements(root, 'a:t')[0];
    expect(text?.children[0]).toMatchObject({ kind: 'text', text: 'A & B <C> "D"' });
  });
});

describe('PPT-08：数据来源与共享事实一致', () => {
  it('同一份快照：表格单元格与文本框里的同一个 fact 解析出同一串文本', () => {
    const { presentation, table_id } = grid(1, 1);
    const factRun: TextBody = {
      paragraphs: [
        { runs: [{ source: { kind: 'fact', fact_key: 'budget' } }], level: 0, alignment: 'left', bullet: false },
      ],
    };
    let deck = setCellText(presentation, 1, table_id, 0, 0, factRun);
    const box: Shape = {
      kind: 'text_box',
      shape_id: 20,
      name: 'FactBox',
      transform: transform(0, 0, 100, 100),
      text: factRun,
    };
    deck = addShape(deck, 1, box);

    const fromCell = resolveTableText(requireTable(deck, 1, table_id), SNAPSHOT)[0]?.[0];
    expect(fromCell).toBe('1200.50 元');
    const resolvedBox = resolveCellText(factRun, SNAPSHOT);
    expect(fromCell).toBe(resolvedBox);
    expect(resolveCellText(factRun, [])).toBe(MISSING_FACT_PLACEHOLDER);

    // 渲染产物里是**解析后的值**（表格与文本框同一个口径）。
    const frame = renderTableFrameXml(requireTable(deck, 1, table_id), { snapshot: SNAPSHOT });
    expect(frame).toContain('<a:t>1200.50 元</a:t>');
    // 缺事实 ⇒ 占位文本，**不是** 0、也不是空串。
    const withoutFact = renderTableFrameXml(requireTable(deck, 1, table_id));
    expect(withoutFact).toContain(MISSING_FACT_PLACEHOLDER);
    expect(withoutFact).not.toContain('<a:t>0</a:t>');
  });

  it('合并格的文本网格：只有源格出文本，延续格为空串', () => {
    const { presentation, table_id } = grid(2, 2);
    let deck = setCellText(presentation, 1, table_id, 0, 0, factCellRuns('跨两列'));
    deck = mergeCells(deck, 1, table_id, { row: 0, col: 0, row_span: 1, col_span: 2 });
    const gridText = resolveTableText(requireTable(deck, 1, table_id));
    expect(gridText[0]).toEqual(['跨两列', '']);
    expect(gridText[1]).toEqual(['', '']);
  });
});

// ---------------------------------------------------------------------------
// P-I17：合并表 render → import 往返（span 真读回）
// ---------------------------------------------------------------------------

/** 逐格比对读回网格与模型规划（只看 span 字段，不看文本）。 */
function expectSpansMatchPlan(table: TableShape): void {
  const frame = renderTableFrameXml(table);
  const imported = readTableFrameSpans(frame);
  const plan = planTableGrid(table);
  expect(imported.row_count).toBe(plan.length);
  expect(imported.column_count).toBe(table.column_widths_emu.length);
  plan.forEach((plannedRow, rowIndex) => {
    const importedRow = imported.cells[rowIndex] ?? [];
    expect(importedRow).toHaveLength(plannedRow.length);
    plannedRow.forEach((planned, col) => {
      expect(importedRow[col]).toMatchObject({
        grid_span: planned.grid_span,
        row_span: planned.row_span,
        h_merge: planned.h_merge,
        v_merge: planned.v_merge,
      });
    });
  });
}

describe('P-I17：合并表 render → import 往返（gridSpan/rowSpan/hMerge/vMerge 真读回）', () => {
  it('2×2 合并：源格 gridSpan=2/rowSpan=2，右侧与下方是 hMerge/vMerge 延续格', () => {
    const { presentation, table_id } = grid(3, 3);
    const deck = mergeCells(presentation, 1, table_id, { row: 0, col: 0, row_span: 2, col_span: 2 });
    const table = requireTable(deck, 1, table_id);
    expectSpansMatchPlan(table);

    const report = verifyTableMergeRoundTrip(table);
    expect(report.row_count).toBe(3);
    expect(report.column_count).toBe(3);
    expect(report.merge_count).toBe(1);
    expect(report.merges).toEqual([{ row: 0, col: 0, row_span: 2, col_span: 2 }]);
  });

  it('多个不重叠合并：读回的合并区列表与模型逐区相等', () => {
    const { presentation, table_id } = grid(4, 4);
    let deck = mergeCells(presentation, 1, table_id, { row: 0, col: 0, row_span: 1, col_span: 2 });
    deck = mergeCells(deck, 1, table_id, { row: 2, col: 2, row_span: 2, col_span: 1 });
    const table = requireTable(deck, 1, table_id);
    expectSpansMatchPlan(table);

    const modelMerges = tableMergeRegions(table);
    expect(modelMerges).toEqual([
      { row: 0, col: 0, row_span: 1, col_span: 2 },
      { row: 2, col: 2, row_span: 2, col_span: 1 },
    ]);
    const report = verifyTableMergeRoundTrip(table);
    expect(report.merges).toEqual(modelMerges);
  });

  it('无合并的表也往返：全部 span=1、无延续格、零合并区', () => {
    const { presentation, table_id } = grid(2, 3);
    const table = requireTable(presentation, 1, table_id);
    const report = verifyTableMergeRoundTrip(table);
    expect(report.merge_count).toBe(0);
    expect(report.merges).toEqual([]);
    expectSpansMatchPlan(table);
  });

  it('反向对照：篡改渲染 XML 的 hMerge ⇒ verifyTableMergeRoundTrip 具名 merge_readback_mismatch', () => {
    const { presentation, table_id } = grid(1, 2);
    const deck = mergeCells(presentation, 1, table_id, { row: 0, col: 0, row_span: 1, col_span: 2 });
    const table = requireTable(deck, 1, table_id);
    // 原件往返通过。
    expect(verifyTableMergeRoundTrip(table).merge_count).toBe(1);

    // 把延续格的 hMerge 抹掉：网格几何仍合法，但该格不再被吞 ⇒ 与模型不符。
    const frame = renderTableFrameXml(table);
    expect(frame).toContain('hMerge="1"');
    const tampered = frame.replace('hMerge="1"', 'hMerge="0"');
    try {
      verifyTableMergeRoundTrip(table, { frame_xml: tampered });
      throw new Error('应当报错');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationTableError);
      expect((error as PresentationTableError).reason).toBe('merge_readback_mismatch');
    }
  });

  it('非表格 XML / 缺 a:tbl ⇒ invalid_table_frame（不返回半张网格）', () => {
    try {
      readTableFrameSpans('<p:graphicFrame/>');
      throw new Error('应当报错');
    } catch (error) {
      expect((error as PresentationTableError).reason).toBe('invalid_table_frame');
    }
  });
});
