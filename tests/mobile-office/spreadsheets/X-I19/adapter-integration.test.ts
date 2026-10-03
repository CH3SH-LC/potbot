/**
 * **X-I19 集成验收**：`src/session/adapters/xlsx.ts` 的三项接线。
 *
 * 本轮集成请求（wave-1 交付方留下）：
 * - **X05**：把 `data-ops` 的五个操作（`sort` / `filter` / `dedupe` / `dropBlankRows` /
 *   `findReplace`）+ 结构化表格（`sortTable` / `appendTableRow`）注册进会话适配器操作面；
 * - **X07**：交付**前**对写出的字节跑关系审计（`assertRelationshipsClean`）作门禁；
 * - **X09**：把 `buildPrintPreview` 的真实分页计划在巡检面上暴露出来。
 *
 * 判据不是"函数有返回值"，而是：
 * 1. 每个新 op 经适配器**真的改到了工作表**（读回取值断言），并配一条**反向对照**
 *    （no-op ⇒ `changed:false`；表操作把标题行 / 汇总行钉住）；
 * 2. 6 个 legacy op 的代码路径与**具名失败文案**原样保留，合并 / 移动 / 冻结 / 列宽行高
 *    仍是具名 `unsupported_op`（`format-structure-e2e.test.ts` 依赖这条边界）；
 * 3. 门禁**真的会拦**：正常写出的包拿到审计回执，构造一个"声明了却没人引用"的关系
 *    ⇒ `exportBytes` 结构化失败（`relationship_audit_failed`），不是"写出来就算数"；
 * 4. 巡检面返回的 `total_pages` 由几何**真实算出**（100 行 / 45 行每页 = 3 页），
 *    且 `total_pages === preview.totalPages`（页码单一来源）。
 *
 * 全部断言基于**真实调用**与真实 .xlsx 字节；无 mock。未验证层（真机 / 真实 Excel 打开 /
 * PDF 出纸）不在本包范围，见 lane 台账。
 */

import { describe, expect, it } from 'vitest';

import { emptyWorkbook, inspectXlsxDeliverable, xlsxDeliverableAdapter } from '../../../../src/session/adapters/xlsx.js';
import { getSheet } from '../../../../src/spreadsheets/workbook.js';
import { getCellValue } from '../../../../src/spreadsheets/sheet.js';
import type { CellValue } from '../../../../src/spreadsheets/value.js';

const text = (value: string): CellValue => ({ kind: 'text', value });
const num = (value: number): CellValue => ({ kind: 'number', value });

type Source = ReturnType<typeof emptyWorkbook>;

/** 用 `[ref, value]` 列表覆盖一张表（表名固定 Sheet1）。 */
function withCells(cells: readonly (readonly [string, CellValue])[]): Source {
  let source = emptyWorkbook('Sheet1');
  for (const [address, value] of cells) {
    const step = xlsxDeliverableAdapter.applyEdit(source, {
      op: 'set_cell',
      sheet: 'Sheet1',
      address,
      value,
    });
    if (!step.ok) throw new Error(step.detail);
    source = step.source;
  }
  return source;
}

function readCell(source: Source, ref: string, sheetName = 'Sheet1'): CellValue {
  const sheet = getSheet(source.workbook, sheetName);
  if (sheet === undefined) throw new Error(`没有工作表 ${sheetName}`);
  return getCellValue(sheet, ref);
}

/** 应用一次编辑并断言成功了，返回新源。 */
function apply(source: Source, edit: Record<string, unknown>): { source: Source; changed: boolean; notes: readonly string[] } {
  const result = xlsxDeliverableAdapter.applyEdit(source, edit);
  if (!result.ok) throw new Error(`编辑本应成功：${result.kind} ${result.detail}`);
  return { source: result.source, changed: result.changed, notes: result.notes };
}

// ---------------------------------------------------------------------------
// 1. X05 数据操作经适配器可达
// ---------------------------------------------------------------------------

describe('X-I19 / X05：数据操作（sort / filter / dedupe / dropBlankRows / findReplace）', () => {
  it('sort：整行按 B 列升序，标签与键仍成对', () => {
    const base = withCells([
      ['A1', text('甲')], ['B1', num(3)],
      ['A2', text('乙')], ['B2', num(1)],
      ['A3', text('丙')], ['B3', num(2)],
    ]);
    const { source, changed } = apply(base, {
      op: 'sort',
      sheet: 'Sheet1',
      range: 'A1:B3',
      keys: [{ column: 2, direction: 'asc' }],
    });
    expect(changed).toBe(true);
    expect(readCell(source, 'A1')).toEqual(text('乙'));
    expect(readCell(source, 'B1')).toEqual(num(1));
    expect(readCell(source, 'A3')).toEqual(text('甲'));
    expect(readCell(source, 'B3')).toEqual(num(3));
  });

  it('filter：不命中的整行删除（>=20 保留 2 行）', () => {
    const base = withCells([
      ['A1', text('甲')], ['B1', num(10)],
      ['A2', text('乙')], ['B2', num(20)],
      ['A3', text('丙')], ['B3', num(30)],
      ['A4', text('丁')], ['B4', num(5)],
    ]);
    const { source, changed } = apply(base, {
      op: 'filter',
      sheet: 'Sheet1',
      range: 'A1:B4',
      group: { op: 'and', conditions: [{ column: 2, operator: 'greaterThanOrEqual', value: num(20) }] },
    });
    expect(changed).toBe(true);
    expect(readCell(source, 'A1')).toEqual(text('乙'));
    expect(readCell(source, 'A2')).toEqual(text('丙'));
    expect(readCell(source, 'A3')).toEqual({ kind: 'blank' });
  });

  it('dedupe：按 A 列判重、保留首次出现；再跑一次是 no-op（changed:false）', () => {
    const base = withCells([
      ['A1', text('甲')], ['B1', num(1)],
      ['A2', text('甲')], ['B2', num(2)],
      ['A3', text('乙')], ['B3', num(3)],
    ]);
    const first = apply(base, { op: 'dedupe', sheet: 'Sheet1', range: 'A1:B3', key_columns: [1] });
    expect(first.changed).toBe(true);
    expect(readCell(first.source, 'B1')).toEqual(num(1));
    expect(readCell(first.source, 'B2')).toEqual(num(3)); // 乙 上移到第 2 行
    // 反向对照：已判重 ⇒ 无改动，不产生新版本
    const again = apply(first.source, { op: 'dedupe', sheet: 'Sheet1', range: 'A1:B3', key_columns: [1] });
    expect(again.changed).toBe(false);
  });

  it('dropBlankRows：整行空行删除，后续行上移', () => {
    // 第 2 行（A2/B2）刻意不设 —— 在 A1:B3 区域内是整行空
    const base = withCells([
      ['A1', text('甲')], ['B1', num(1)],
      ['A3', text('丙')], ['B3', num(3)],
    ]);
    const { source, changed } = apply(base, { op: 'dropBlankRows', sheet: 'Sheet1', range: 'A1:B3' });
    expect(changed).toBe(true);
    expect(readCell(source, 'A1')).toEqual(text('甲'));
    expect(readCell(source, 'A2')).toEqual(text('丙'));
    expect(readCell(source, 'A3')).toEqual({ kind: 'blank' });
  });

  it('findReplace：只动文本格，命中才登记；数值格不受影响', () => {
    const base = withCells([
      ['A1', text('apple pie')], ['B1', num(1)],
      ['A2', text('APPLE')], ['B2', text('banana')],
    ]);
    const { source, changed } = apply(base, {
      op: 'findReplace',
      sheet: 'Sheet1',
      range: 'A1:B2',
      find: 'apple',
      replacement: '梨',
    });
    expect(changed).toBe(true);
    expect(readCell(source, 'A1')).toEqual(text('梨 pie'));
    expect(readCell(source, 'A2')).toEqual(text('梨')); // 默认不区分大小写
    expect(readCell(source, 'B1')).toEqual(num(1)); // 数值格不动
    expect(readCell(source, 'B2')).toEqual(text('banana'));
  });

  it('反向对照：未知 kind / 缺 sheet / 未知表 一律结构化失败（源零改动）', () => {
    const base = withCells([['A1', text('甲')]]);
    const unknownKind = xlsxDeliverableAdapter.applyEdit(base, { op: 'pivotTable', sheet: 'Sheet1' });
    expect(unknownKind.ok).toBe(false);
    if (!unknownKind.ok) expect(unknownKind.kind).toBe('unsupported_op');

    const noSheet = xlsxDeliverableAdapter.applyEdit(base, {
      op: 'sort',
      range: 'A1:B2',
      keys: [{ column: 1, direction: 'asc' }],
    });
    expect(noSheet.ok).toBe(false);
    if (!noSheet.ok) expect(noSheet.kind).toBe('invalid_edit');

    const badTable = xlsxDeliverableAdapter.applyEdit(base, { op: 'filter', sheet: '不存在' });
    expect(badTable.ok).toBe(false);
    if (!badTable.ok) expect(badTable.kind).toBe('unknown_sheet');
  });
});

// ---------------------------------------------------------------------------
// 2. X05 结构化表格操作经适配器可达
// ---------------------------------------------------------------------------

const COST_TABLE = {
  name: '费用表',
  range: 'B3:C7',
  columns: ['项目', { name: '金额', totals_function: 'min' }],
  totals_row: true,
} as const;

function costSource(): Source {
  return withCells([
    ['B3', text('项目')], ['C3', text('金额')],
    ['B4', text('餐饮')], ['C4', num(300)],
    ['B5', text('交通')], ['C5', num(100)],
    ['B6', text('住宿')], ['C6', num(200)],
    ['B7', text('合计')], ['C7', num(100)],
  ]);
}

describe('X-I19 / X05：结构化表格（sortTable / appendTableRow）', () => {
  it('sortTable：只排数据体，标题行与汇总行钉住', () => {
    const { source, changed } = apply(costSource(), {
      op: 'sortTable',
      sheet: 'Sheet1',
      table: COST_TABLE,
      keys: [{ column: 3, direction: 'asc' }],
    });
    expect(changed).toBe(true);
    // 标题行不动
    expect(readCell(source, 'B3')).toEqual(text('项目'));
    // 数据体已按金额升序
    expect(readCell(source, 'B4')).toEqual(text('交通'));
    expect(readCell(source, 'C4')).toEqual(num(100));
    expect(readCell(source, 'B6')).toEqual(text('餐饮'));
    expect(readCell(source, 'C6')).toEqual(num(300));
    // 汇总行仍在末行
    expect(readCell(source, 'B7')).toEqual(text('合计'));
  });

  it('appendTableRow：数据体长一行，汇总行随之下移', () => {
    const { source, changed } = apply(costSource(), {
      op: 'appendTableRow',
      sheet: 'Sheet1',
      table: COST_TABLE,
      values: [text('打车'), num(50)],
    });
    expect(changed).toBe(true);
    expect(readCell(source, 'B7')).toEqual(text('打车'));
    expect(readCell(source, 'C7')).toEqual(num(50));
    expect(readCell(source, 'B8')).toEqual(text('合计')); // 汇总行被表长大挤到第 8 行
  });

  it('反向对照：值个数 != 表列数 ⇒ 结构化失败', () => {
    const result = xlsxDeliverableAdapter.applyEdit(costSource(), {
      op: 'appendTableRow',
      sheet: 'Sheet1',
      table: COST_TABLE,
      values: [text('打车')],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.kind).toBe('invalid_edit');
      expect(result.detail).toContain('需要 2 个值');
    }
  });
});

// ---------------------------------------------------------------------------
// 3. 既有边界：6 个 legacy op 与具名失败文案原样保留
// ---------------------------------------------------------------------------

describe('X-I19：既有边界不破（legacy 6 op + 未接线结构面）', () => {
  it('merge / unmerge / move / 冻结 / 列宽 / 行高 仍是具名 unsupported_op', () => {
    const base = emptyWorkbook('Sheet1');
    const gapOps: readonly Record<string, unknown>[] = [
      { op: 'merge_cells', sheet: 'Sheet1', range: 'A1:B2' },
      { op: 'unmerge_cells', sheet: 'Sheet1', range: 'A1:B2' },
      { op: 'move_sheet', name: 'Sheet1', to_index: 0 },
      { op: 'set_frozen_panes', sheet: 'Sheet1', rows: 1, columns: 1 },
      { op: 'set_column_width', sheet: 'Sheet1', column: 0, width: 30 },
      { op: 'set_row_height', sheet: 'Sheet1', row: 0, height: 20 },
      { op: 'duplicate_sheet', name: 'Sheet1' },
      { op: 'hide_sheet', name: 'Sheet1' },
    ];
    for (const edit of gapOps) {
      const result = xlsxDeliverableAdapter.applyEdit(base, edit);
      expect(result.ok, JSON.stringify(edit)).toBe(false);
      if (result.ok) continue;
      expect(result.kind).toBe('unsupported_op');
      expect(result.detail).toContain('不支持的表格操作');
    }
  });

  it('legacy op 的具名失败文案保持不变（最后一张表 / 没有工作表 / 已存在）', () => {
    const bare = emptyWorkbook('Sheet1');
    const last = xlsxDeliverableAdapter.applyEdit(bare, { op: 'remove_sheet', name: 'Sheet1' });
    expect(last.ok).toBe(false);
    if (!last.ok) {
      expect(last.kind).toBe('last_sheet');
      expect(last.detail).toContain('最后一张工作表');
    }
    const unknown = xlsxDeliverableAdapter.applyEdit(bare, { op: 'remove_sheet', name: '不存在' });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.kind).toBe('unknown_sheet');
      expect(unknown.detail).toContain('没有工作表');
    }
    const dup = xlsxDeliverableAdapter.applyEdit(bare, { op: 'add_sheet', name: 'Sheet1' });
    expect(dup.ok).toBe(false);
    if (!dup.ok) {
      expect(dup.kind).toBe('duplicate_sheet');
      expect(dup.detail).toContain('已存在');
    }
  });
});

// ---------------------------------------------------------------------------
// 4. X07 交付前关系门禁：真的会拦
// ---------------------------------------------------------------------------

const CUSTOM_XML_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXml';

describe('X-I19 / X07：exportBytes 交付前关系门禁', () => {
  it('正常写出的多表工作簿过门禁并产出真实字节', () => {
    const base = withCells([['A1', text('标题')], ['B2', num(42)]]);
    // 再加一张表，确认多表也过
    const added = apply(base, { op: 'add_sheet', name: '汇总' });
    const exported = xlsxDeliverableAdapter.exportBytes(added.source);
    expect(exported.ok).toBe(true);
    if (!exported.ok) return;
    expect(exported.bytes.length).toBeGreaterThan(0);
    expect(exported.entry_count).toBeGreaterThan(0);
    expect(exported.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('反向对照：残留里声明了一条"没人引用"的关系 ⇒ 拒绝交付，kind=relationship_audit_failed', () => {
    const base = emptyWorkbook('Sheet1');
    const source = {
      workbook: base.workbook,
      residual: {
        parts: [
          { path: 'customXml/item1.xml', content_type: 'application/xml', data: new Uint8Array([60, 97, 47, 62]) },
        ],
        content_type_defaults: [],
        relationships: [
          {
            owner_part_path: 'xl/workbook.xml',
            declarations: [{ type: CUSTOM_XML_REL, target: '../customXml/item1.xml' }],
          },
        ],
      },
    };
    const exported = xlsxDeliverableAdapter.exportBytes(source as unknown as Source);
    expect(exported.ok).toBe(false);
    if (exported.ok) return;
    expect(exported.kind).toBe('relationship_audit_failed');
    expect(exported.detail).toContain('孤儿关系');
    // 巡检面同样拦下（它复用 exportBytes 的门禁），且不带任何预览
    const inspected = inspectXlsxDeliverable(source as unknown as Source);
    expect(inspected.ok).toBe(false);
    if (!inspected.ok) expect(inspected.kind).toBe('relationship_audit_failed');
  });
});

// ---------------------------------------------------------------------------
// 5. X09 巡检面：真实分页计划 + 唯一页码来源
// ---------------------------------------------------------------------------

describe('X-I19 / X09：inspectXlsxDeliverable 暴露真实分页计划', () => {
  it('空表：审计回执 ok，预览至少 1 页，total_pages === preview.totalPages', () => {
    const inspected = inspectXlsxDeliverable(emptyWorkbook('Sheet1'));
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.sheet).toBe('Sheet1');
    expect(inspected.relationships.ok).toBe(true);
    expect(inspected.relationships.parts).toBeGreaterThan(0);
    expect(inspected.total_pages).toBe(inspected.preview.totalPages);
    expect(inspected.preview.pages.length).toBe(inspected.total_pages);
  });

  it('100 行数据：几何算出 3 页（45 行/页），不是"只截首屏"', () => {
    const cells: (readonly [string, CellValue])[] = [];
    for (let row = 1; row <= 100; row += 1) cells.push([`A${row}`, num(row)]);
    const inspected = inspectXlsxDeliverable(withCells(cells));
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    // 默认列宽 8.43 字符 ⇒ 10 列/页；默认行高 15pt ⇒ 45 行/页 ⇒ ceil(100/45)=3
    expect(inspected.total_pages).toBe(3);
    expect(inspected.preview.plan.pages[2]?.rows.end).toBe(100);
    // 页码单一来源：&P 逐页递增，不重算
    expect(inspected.preview.pages.map((page) => page.pageNumber)).toEqual([1, 2, 3]);
  });

  it('maxPages 透传：截断后 total_pages 用截断值', () => {
    const cells: (readonly [string, CellValue])[] = [];
    for (let row = 1; row <= 200; row += 1) cells.push([`A${row}`, num(row)]);
    const inspected = inspectXlsxDeliverable(withCells(cells), { maxPages: 2 });
    expect(inspected.ok).toBe(true);
    if (!inspected.ok) return;
    expect(inspected.preview.plan.truncated).toBe(true);
    expect(inspected.total_pages).toBe(2);
  });

  it('sheet 选项指向存在的表；不存在的表结构化失败', () => {
    let source = emptyWorkbook('甲', '乙');
    source = apply(source, { op: 'add_sheet', name: '丙' }).source;
    const got = inspectXlsxDeliverable(source, { sheet: '乙' });
    expect(got.ok).toBe(true);
    if (got.ok) expect(got.sheet).toBe('乙');
    const missing = inspectXlsxDeliverable(source, { sheet: '没有' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.kind).toBe('unknown_sheet');
  });
});
