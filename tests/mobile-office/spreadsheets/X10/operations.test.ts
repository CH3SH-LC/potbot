/**
 * X10 / XLS-01：完整操作工具接入 —— 定向套件。
 *
 * 断言的是**真实工作簿取值**（转发既有模块后的结果），不是"调用了函数"。
 */
import { describe, expect, it } from 'vitest';

import { emptyWorkbook, type XlsxDeliverableSource } from '../../../../src/session/adapters/xlsx.js';
import {
  applySpreadsheetOperation,
  isPhoneOperation,
  PHONE_OPERATION_NAMES,
  workbooksEquivalent,
  type SpreadsheetOperation,
} from '../../../../src/mobile-plugins/spreadsheets/session/operations.js';
import { getSheet } from '../../../../src/spreadsheets/workbook.js';
import { getCellValue } from '../../../../src/spreadsheets/sheet.js';
import type { CellValue } from '../../../../src/spreadsheets/value.js';

const text = (value: string): CellValue => ({ kind: 'text', value });
const num = (value: number): CellValue => ({ kind: 'number', value });

function read(source: XlsxDeliverableSource, sheetName: string, ref: string): CellValue {
  const sheet = getSheet(source.workbook, sheetName);
  if (sheet === undefined) throw new Error(`没有工作表 ${sheetName}`);
  return getCellValue(sheet, ref);
}

function apply(source: XlsxDeliverableSource, op: SpreadsheetOperation): XlsxDeliverableSource {
  const result = applySpreadsheetOperation(source, op);
  if (!result.ok) throw new Error(`操作 ${op.op} 意外失败：${result.kind} / ${result.detail}`);
  return result.source;
}

function applyAll(source: XlsxDeliverableSource, ops: readonly SpreadsheetOperation[]): XlsxDeliverableSource {
  return ops.reduce((current, op) => apply(current, op), source);
}

describe('操作注册表：词汇', () => {
  it('24 个 op 名都在集合内，未知名不在', () => {
    expect(PHONE_OPERATION_NAMES.length).toBe(24);
    expect(isPhoneOperation('set_range')).toBe(true);
    expect(isPhoneOperation('merge_cells')).toBe(true);
    expect(isPhoneOperation('not_a_real_op')).toBe(false);
  });

  it('原有 18 个 op 名一个不少（向后兼容）', () => {
    const original = [
      'set_cell',
      'clear_cell',
      'set_range',
      'clear_range',
      'insert_rows',
      'delete_rows',
      'insert_columns',
      'delete_columns',
      'merge_cells',
      'unmerge_cells',
      'sort_range',
      'dedupe_rows',
      'replace_in_range',
      'add_sheet',
      'remove_sheet',
      'rename_sheet',
      'set_active_sheet',
      'move_sheet',
    ];
    for (const name of original) expect(isPhoneOperation(name)).toBe(true);
    // 新增：X05 数据操作 filter / dropBlankRows + X02 结构复制移动。
    for (const name of ['filter', 'drop_blank_rows', 'copy_rows', 'move_rows', 'copy_columns', 'move_columns']) {
      expect(isPhoneOperation(name)).toBe(true);
    }
  });
});

describe('取值与区域', () => {
  it('set_cell 写入；同值重设 changed=false（幂等空转不产生新版本）', () => {
    const base = emptyWorkbook('S');
    const first = applySpreadsheetOperation(base, { op: 'set_cell', sheet: 'S', address: 'A1', value: text('x') });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.changed).toBe(true);
    expect(read(first.source, 'S', 'A1')).toEqual(text('x'));

    const same = applySpreadsheetOperation(first.source, { op: 'set_cell', sheet: 'S', address: 'A1', value: text('x') });
    expect(same.ok).toBe(true);
    if (!same.ok) return;
    expect(same.changed).toBe(false);
    expect(workbooksEquivalent(first.source.workbook, same.source.workbook)).toBe(true);
  });

  it('set_range 从左上角写入二维矩阵', () => {
    const source = apply(emptyWorkbook('S'), {
      op: 'set_range',
      sheet: 'S',
      top_left: 'B2',
      rows: [
        [num(1), num(2)],
        [num(3), num(4)],
      ],
    });
    expect(read(source, 'S', 'B2')).toEqual(num(1));
    expect(read(source, 'S', 'C2')).toEqual(num(2));
    expect(read(source, 'S', 'B3')).toEqual(num(3));
    expect(read(source, 'S', 'C3')).toEqual(num(4));
  });

  it('clear_range 只清区域内的格', () => {
    let source = apply(emptyWorkbook('S'), {
      op: 'set_range',
      sheet: 'S',
      top_left: 'A1',
      rows: [[num(1), num(2), num(3)]],
    });
    source = apply(source, { op: 'clear_range', sheet: 'S', range: 'A1:B1' });
    expect(read(source, 'S', 'A1')).toEqual({ kind: 'blank' });
    expect(read(source, 'S', 'B1')).toEqual({ kind: 'blank' });
    expect(read(source, 'S', 'C1')).toEqual(num(3));
  });

  it('非法取值形状 ⇒ 结构化成 invalid_value（不写半个表）', () => {
    const result = applySpreadsheetOperation(emptyWorkbook('S'), {
      op: 'set_cell',
      sheet: 'S',
      address: 'A1',
      value: { kind: 'number', value: 'nope' },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('invalid_value');
  });
});

describe('行列增删：引用随之迁移', () => {
  it('insert_rows 下沉其后行；delete_rows 复原', () => {
    let source = emptyWorkbook('S');
    source = apply(source, { op: 'set_cell', sheet: 'S', address: 'A1', value: text('a') });
    source = apply(source, { op: 'set_cell', sheet: 'S', address: 'A2', value: text('c') });

    const inserted = apply(source, { op: 'insert_rows', sheet: 'S', at: 1, count: 1 });
    expect(read(inserted, 'S', 'A2')).toEqual(text('a'));
    expect(read(inserted, 'S', 'A3')).toEqual(text('c'));
    expect(read(inserted, 'S', 'A1')).toEqual({ kind: 'blank' });

    const deleted = apply(inserted, { op: 'delete_rows', sheet: 'S', at: 1, count: 1 });
    expect(read(deleted, 'S', 'A1')).toEqual(text('a'));
    expect(read(deleted, 'S', 'A2')).toEqual(text('c'));
  });

  it('insert_columns 右移其后列', () => {
    let source = apply(emptyWorkbook('S'), { op: 'set_cell', sheet: 'S', address: 'A1', value: text('a') });
    source = apply(source, { op: 'insert_columns', sheet: 'S', at: 1, count: 1 });
    expect(read(source, 'S', 'B1')).toEqual(text('a'));
    expect(read(source, 'S', 'A1')).toEqual({ kind: 'blank' });
  });
});

describe('合并 / 拆分', () => {
  it('merge_cells 保留左上角、清掉其余格，并把区域记进 merged', () => {
    let source = emptyWorkbook('S');
    source = apply(source, { op: 'set_cell', sheet: 'S', address: 'A1', value: text('top') });
    source = apply(source, { op: 'set_cell', sheet: 'S', address: 'B1', value: text('x') });
    source = apply(source, { op: 'set_cell', sheet: 'S', address: 'A2', value: text('y') });

    const merged = apply(source, { op: 'merge_cells', sheet: 'S', range: 'A1:B2' });
    const sheet = getSheet(merged.workbook, 'S');
    expect(sheet?.merged.length).toBe(1);
    expect(read(merged, 'S', 'A1')).toEqual(text('top'));
    expect(read(merged, 'S', 'B1')).toEqual({ kind: 'blank' });
    expect(read(merged, 'S', 'A2')).toEqual({ kind: 'blank' });

    const unmerged = apply(merged, { op: 'unmerge_cells', sheet: 'S', range: 'A1:B2' });
    expect(getSheet(unmerged.workbook, 'S')?.merged.length).toBe(0);
  });
});

describe('排序 / 去重 / 替换', () => {
  it('sort_range 整行随键列搬迁', () => {
    let source = emptyWorkbook('S');
    source = applyAll(source, [
      { op: 'set_cell', sheet: 'S', address: 'A1', value: text('b') },
      { op: 'set_cell', sheet: 'S', address: 'B1', value: num(2) },
      { op: 'set_cell', sheet: 'S', address: 'A2', value: text('a') },
      { op: 'set_cell', sheet: 'S', address: 'B2', value: num(1) },
      { op: 'set_cell', sheet: 'S', address: 'A3', value: text('c') },
      { op: 'set_cell', sheet: 'S', address: 'B3', value: num(3) },
    ]);
    const sorted = apply(source, {
      op: 'sort_range',
      sheet: 'S',
      range: 'A1:B3',
      keys: [{ column: 2, direction: 'asc' }],
    });
    expect(read(sorted, 'S', 'A1')).toEqual(text('a'));
    expect(read(sorted, 'S', 'B1')).toEqual(num(1));
    expect(read(sorted, 'S', 'A2')).toEqual(text('b'));
    expect(read(sorted, 'S', 'A3')).toEqual(text('c'));
  });

  it('dedupe_rows 按列判重、保留首次', () => {
    let source = emptyWorkbook('S');
    source = applyAll(source, [
      { op: 'set_cell', sheet: 'S', address: 'A1', value: text('x') },
      { op: 'set_cell', sheet: 'S', address: 'A2', value: text('x') },
      { op: 'set_cell', sheet: 'S', address: 'A3', value: text('y') },
    ]);
    const deduped = apply(source, { op: 'dedupe_rows', sheet: 'S', range: 'A1:A3', key_columns: [1] });
    const sheet = getSheet(deduped.workbook, 'S');
    // 保留下来的行：x、y（重复的第二个 x 被删除，其后 y 上移）
    expect(sheet?.cells.size).toBe(2);
    expect(read(deduped, 'S', 'A1')).toEqual(text('x'));
    expect(read(deduped, 'S', 'A2')).toEqual(text('y'));
  });

  it('replace_in_range 只改文本格', () => {
    let source = emptyWorkbook('S');
    source = applyAll(source, [
      { op: 'set_cell', sheet: 'S', address: 'A1', value: text('foo') },
      { op: 'set_cell', sheet: 'S', address: 'A2', value: num(1) },
    ]);
    const replaced = apply(source, { op: 'replace_in_range', sheet: 'S', range: 'A1:A2', find: 'o', replacement: '0' });
    expect(read(replaced, 'S', 'A1')).toEqual(text('f00'));
    expect(read(replaced, 'S', 'A2')).toEqual(num(1));
  });
});

describe('工作表操作与错误面', () => {
  it('未知 op 具名拒绝', () => {
    const result = applySpreadsheetOperation(emptyWorkbook('S'), { op: 'totally_unknown' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('unsupported_op');
    expect(result.detail).toContain('不支持的表格操作');
  });

  it('删除最后一张工作表 / 未知表 / 重名新增都有具名失败', () => {
    const bare = emptyWorkbook('S');
    const last = applySpreadsheetOperation(bare, { op: 'remove_sheet', name: 'S' });
    expect(last.ok).toBe(false);
    if (!last.ok) expect(last.kind).toBe('last_sheet');

    const unknown = applySpreadsheetOperation(bare, { op: 'rename_sheet', from: '无', to: 'x' });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.kind).toBe('unknown_sheet');

    const dup = applySpreadsheetOperation(bare, { op: 'add_sheet', name: 'S' });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.kind).toBe('duplicate_sheet');
  });

  it('move_sheet 改变表顺序', () => {
    let source = apply(emptyWorkbook('A'), { op: 'add_sheet', name: 'B' });
    source = apply(source, { op: 'add_sheet', name: 'C' });
    expect(source.workbook.sheets.map((sheet) => sheet.name)).toEqual(['A', 'B', 'C']);
    const moved = apply(source, { op: 'move_sheet', name: 'A', to_index: 2 });
    expect(moved.workbook.sheets.map((sheet) => sheet.name)).toEqual(['B', 'C', 'A']);
  });
});
