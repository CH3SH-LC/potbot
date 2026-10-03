/**
 * X10 / XLS-01 集成：操作注册表补齐 X05 数据操作（filter / dropBlankRows）与
 * X02 结构复制移动（copy_rows / move_rows / copy_columns / move_columns）。
 *
 * 断言的是**真实工作簿取值 / 公式文本**（转发既有模块后的结果），不是"调用了函数"。
 */
import { describe, expect, it } from 'vitest';

import { emptyWorkbook, type XlsxDeliverableSource } from '../../../../src/session/adapters/xlsx.js';
import {
  applySpreadsheetOperation,
  isPhoneOperation,
  PHONE_OPERATION_NAMES,
  type SpreadsheetOperation,
} from '../../../../src/mobile-plugins/spreadsheets/session/operations.js';
import { DATA_OPERATION_KINDS } from '../../../../src/spreadsheets/data-ops/operations.js';
import { getSheet } from '../../../../src/spreadsheets/workbook.js';
import { getCellValue } from '../../../../src/spreadsheets/sheet.js';
import type { CellValue } from '../../../../src/spreadsheets/value.js';

const text = (value: string): CellValue => ({ kind: 'text', value });
const num = (value: number): CellValue => ({ kind: 'number', value });
const formula = (value: string): CellValue => ({ kind: 'formula', text: value });

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

function expectFailure(op: unknown): { kind: string; detail: string } {
  const result = applySpreadsheetOperation(emptyWorkbook('S'), op);
  if (result.ok) throw new Error('预期失败，实际成功');
  return { kind: result.kind, detail: result.detail };
}

describe('X05 数据操作：五个 kind 都从注册表可达', () => {
  it('sort / filter / dedupe / dropBlankRows / findReplace 各有对应 op', () => {
    // X05 的封闭枚举每个 kind → 注册表里承载它的 op 名（本批补齐 filter / dropBlankRows）。
    const coverage: Record<(typeof DATA_OPERATION_KINDS)[number], string> = {
      sort: 'sort_range',
      filter: 'filter',
      dedupe: 'dedupe_rows',
      dropBlankRows: 'drop_blank_rows',
      findReplace: 'replace_in_range',
    };
    for (const kind of DATA_OPERATION_KINDS) {
      expect(isPhoneOperation(coverage[kind])).toBe(true);
      expect(PHONE_OPERATION_NAMES).toContain(coverage[kind]);
    }
  });

  it('filter：不命中的数据行整行删除，标题行保留', () => {
    let source = emptyWorkbook('S');
    source = applyAll(source, [
      { op: 'set_cell', sheet: 'S', address: 'A1', value: text('name') },
      { op: 'set_cell', sheet: 'S', address: 'B1', value: text('n') },
      { op: 'set_cell', sheet: 'S', address: 'A2', value: text('a') },
      { op: 'set_cell', sheet: 'S', address: 'B2', value: num(1) },
      { op: 'set_cell', sheet: 'S', address: 'A3', value: text('b') },
      { op: 'set_cell', sheet: 'S', address: 'B3', value: num(2) },
      { op: 'set_cell', sheet: 'S', address: 'A4', value: text('c') },
      { op: 'set_cell', sheet: 'S', address: 'B4', value: num(3) },
    ]);
    const filtered = apply(source, {
      op: 'filter',
      sheet: 'S',
      range: 'A1:B4',
      header: true,
      group: { op: 'and', conditions: [{ column: 2, operator: 'greaterThan', value: num(1) }] },
    });
    // 标题行 + B>1 的两行留下；B=1 的 'a' 行被整行删除，其后上移。
    expect(read(filtered, 'S', 'A1')).toEqual(text('name'));
    expect(read(filtered, 'S', 'A2')).toEqual(text('b'));
    expect(read(filtered, 'S', 'B2')).toEqual(num(2));
    expect(read(filtered, 'S', 'A3')).toEqual(text('c'));
    expect(read(filtered, 'S', 'A4')).toEqual({ kind: 'blank' });
  });

  it('filter：嵌套 or 组与文本算子按类别匹配（数值不冒充文本）', () => {
    let source = emptyWorkbook('S');
    source = applyAll(source, [
      { op: 'set_cell', sheet: 'S', address: 'A1', value: text('apple') },
      { op: 'set_cell', sheet: 'S', address: 'A2', value: text('banana') },
      { op: 'set_cell', sheet: 'S', address: 'A3', value: num(42) },
      { op: 'set_cell', sheet: 'S', address: 'A4', value: text('cherry') },
    ]);
    const filtered = apply(source, {
      op: 'filter',
      sheet: 'S',
      range: 'A1:A4',
      group: {
        op: 'or',
        conditions: [
          { column: 1, operator: 'startsWith', text: 'ba' },
          { column: 1, operator: 'endsWith', text: 'rry' },
        ],
      },
    });
    // banana / cherry 命中；apple 不命中；数值 42 不参与文本算子（不隐式字符串化）。
    expect(read(filtered, 'S', 'A1')).toEqual(text('banana'));
    expect(read(filtered, 'S', 'A2')).toEqual(text('cherry'));
    expect(read(filtered, 'S', 'A3')).toEqual({ kind: 'blank' });
  });

  it('drop_blank_rows：整行全空的行删除', () => {
    let source = emptyWorkbook('S');
    source = applyAll(source, [
      { op: 'set_cell', sheet: 'S', address: 'A1', value: text('h') },
      { op: 'set_cell', sheet: 'S', address: 'A2', value: text('x') },
      { op: 'set_cell', sheet: 'S', address: 'A4', value: text('y') },
    ]);
    const dropped = apply(source, { op: 'drop_blank_rows', sheet: 'S', range: 'A1:A4', header: true });
    expect(read(dropped, 'S', 'A1')).toEqual(text('h'));
    expect(read(dropped, 'S', 'A2')).toEqual(text('x'));
    expect(read(dropped, 'S', 'A3')).toEqual(text('y'));
    expect(read(dropped, 'S', 'A4')).toEqual({ kind: 'blank' });
  });

  it('filter / drop_blank_rows 的非法输入结构化成 invalid_edit（不写半个表）', () => {
    const badOperator = expectFailure({
      op: 'filter',
      sheet: 'S',
      range: 'A1:A3',
      group: { op: 'and', conditions: [{ column: 1, operator: 'nope' }] },
    });
    expect(badOperator.kind).toBe('invalid_edit');

    const badHeader = expectFailure({ op: 'filter', sheet: 'S', range: 'A1:A3', header: 'yes', group: { op: 'and', conditions: [] } });
    expect(badHeader.kind).toBe('invalid_edit');

    const badDropHeader = expectFailure({ op: 'drop_blank_rows', sheet: 'S', range: 'A1:A3', header: 1 });
    expect(badDropHeader.kind).toBe('invalid_edit');

    const unknownSheet = expectFailure({ op: 'drop_blank_rows', sheet: '无', range: 'A1:A3' });
    expect(unknownSheet.kind).toBe('invalid_edit');
  });
});

describe('X02 结构操作：复制 / 移动行与列从注册表可达', () => {
  it('copy_rows：源保留、副本插入、副本公式按复制语义平移', () => {
    let source = emptyWorkbook('S');
    source = applyAll(source, [
      { op: 'set_cell', sheet: 'S', address: 'A1', value: num(1) },
      { op: 'set_cell', sheet: 'S', address: 'B1', value: formula('=A1') },
      { op: 'set_cell', sheet: 'S', address: 'A2', value: text('a') },
      { op: 'set_cell', sheet: 'S', address: 'A3', value: text('b') },
    ]);
    const copied = apply(source, { op: 'copy_rows', sheet: 'S', at: 1, count: 1, insert_at: 3 });
    // 源（第 1 行）保留。
    expect(read(copied, 'S', 'A1')).toEqual(num(1));
    // 原第 3 行下移到第 4 行；副本落在第 3 行。
    expect(read(copied, 'S', 'A3')).toEqual(num(1));
    expect(read(copied, 'S', 'A4')).toEqual(text('b'));
    // 副本公式相对引用平移 A1 -> A3（复制语义）。
    expect(read(copied, 'S', 'B3')).toEqual(formula('=A3'));
  });

  it('move_rows：引用分段映射，移动后区间内容前移', () => {
    let source = emptyWorkbook('S');
    source = applyAll(source, [
      { op: 'set_cell', sheet: 'S', address: 'A1', value: text('x') },
      { op: 'set_cell', sheet: 'S', address: 'A2', value: text('a') },
      { op: 'set_cell', sheet: 'S', address: 'A3', value: text('b') },
      { op: 'set_cell', sheet: 'S', address: 'A4', value: text('c') },
    ]);
    const moved = apply(source, { op: 'move_rows', sheet: 'S', at: 1, count: 1, to: 4 });
    expect(read(moved, 'S', 'A1')).toEqual(text('a'));
    expect(read(moved, 'S', 'A2')).toEqual(text('b'));
    expect(read(moved, 'S', 'A3')).toEqual(text('x'));
    expect(read(moved, 'S', 'A4')).toEqual(text('c'));
  });

  it('copy_columns / move_columns：列方向同构', () => {
    let source = emptyWorkbook('S');
    source = applyAll(source, [
      { op: 'set_cell', sheet: 'S', address: 'A1', value: text('x') },
      { op: 'set_cell', sheet: 'S', address: 'B1', value: text('a') },
      { op: 'set_cell', sheet: 'S', address: 'C1', value: text('b') },
    ]);
    const copied = apply(source, { op: 'copy_columns', sheet: 'S', at: 1, count: 1, insert_at: 3 });
    expect(read(copied, 'S', 'A1')).toEqual(text('x'));
    expect(read(copied, 'S', 'C1')).toEqual(text('x'));
    expect(read(copied, 'S', 'D1')).toEqual(text('b'));

    const moved = apply(source, { op: 'move_columns', sheet: 'S', at: 1, count: 1, to: 3 });
    expect(read(moved, 'S', 'A1')).toEqual(text('a'));
    expect(read(moved, 'S', 'B1')).toEqual(text('x'));
    expect(read(moved, 'S', 'C1')).toEqual(text('b'));
  });

  it('恒等移动（to === at）不产生新版本（changed=false）', () => {
    let source = emptyWorkbook('S');
    source = apply(source, { op: 'set_cell', sheet: 'S', address: 'A1', value: text('x') });
    const result = applySpreadsheetOperation(source, { op: 'move_rows', sheet: 'S', at: 1, count: 1, to: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(false);
  });

  it('自重叠 / 越界显式拒绝（invalid_edit，不猜）', () => {
    let source = emptyWorkbook('S');
    source = apply(source, { op: 'set_cell', sheet: 'S', address: 'A1', value: text('x') });
    const overlap = applySpreadsheetOperation(source, { op: 'copy_rows', sheet: 'S', at: 1, count: 3, insert_at: 2 });
    expect(overlap.ok).toBe(false);
    if (!overlap.ok) expect(overlap.kind).toBe('invalid_edit');

    const moveInside = applySpreadsheetOperation(source, { op: 'move_rows', sheet: 'S', at: 1, count: 3, to: 2 });
    expect(moveInside.ok).toBe(false);
    if (!moveInside.ok) expect(moveInside.kind).toBe('invalid_edit');

    const outOfRange = applySpreadsheetOperation(source, { op: 'copy_columns', sheet: 'S', at: 1, count: 99, insert_at: 1 });
    expect(outOfRange.ok).toBe(false);
    if (!outOfRange.ok) expect(outOfRange.kind).toBe('invalid_edit');

    const nonInteger = applySpreadsheetOperation(source, { op: 'move_columns', sheet: 'S', at: 1, count: 1, to: 1.5 });
    expect(nonInteger.ok).toBe(false);
    if (!nonInteger.ok) expect(nonInteger.kind).toBe('invalid_edit');
  });
});
