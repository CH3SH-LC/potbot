/**
 * X10 / XLS-01：`xlsxDeliverableAdapter` 的**加宽接线**与**既有边界不破** —— 定向套件。
 *
 * 加宽：区域读写 / 行列增删 / 排序去重替换 现在产品入口可用。
 * 不破：`apps/demo/server/format-structure-e2e.test.ts` 断言的"merge / move 等未接线"
 *      与既有具名失败文案（最后一张表 / 没有工作表 / 已存在）保持不变。
 */
import { describe, expect, it } from 'vitest';

import { emptyWorkbook, xlsxDeliverableAdapter } from '../../../../src/session/adapters/xlsx.js';
import { getSheet } from '../../../../src/spreadsheets/workbook.js';
import { getCellValue } from '../../../../src/spreadsheets/sheet.js';
import type { CellValue } from '../../../../src/spreadsheets/value.js';

const text = (value: string): CellValue => ({ kind: 'text', value });
const num = (value: number): CellValue => ({ kind: 'number', value });

function readCell(source: ReturnType<typeof emptyWorkbook>, sheetName: string, ref: string): CellValue {
  const sheet = getSheet(source.workbook, sheetName);
  if (sheet === undefined) throw new Error(`没有工作表 ${sheetName}`);
  return getCellValue(sheet, ref);
}

describe('加宽的 op 经产品适配器可达', () => {
  it('set_range / clear_range 生效', () => {
    const base = emptyWorkbook('Sheet1');
    const written = xlsxDeliverableAdapter.applyEdit(base, {
      op: 'set_range',
      sheet: 'Sheet1',
      top_left: 'A1',
      rows: [[num(1), num(2)]],
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(readCell(written.source, 'Sheet1', 'A2')).toEqual({ kind: 'blank' });
    expect(readCell(written.source, 'Sheet1', 'B1')).toEqual(num(2));

    const cleared = xlsxDeliverableAdapter.applyEdit(written.source, {
      op: 'clear_range',
      sheet: 'Sheet1',
      range: 'A1:B1',
    });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(readCell(cleared.source, 'Sheet1', 'A1')).toEqual({ kind: 'blank' });
  });

  it('insert_rows / delete_rows 经适配器可达并迁移引用', () => {
    const base = emptyWorkbook('Sheet1');
    const one = xlsxDeliverableAdapter.applyEdit(base, {
      op: 'set_cell',
      sheet: 'Sheet1',
      address: 'A1',
      value: text('a'),
    });
    expect(one.ok).toBe(true);
    if (!one.ok) return;
    const inserted = xlsxDeliverableAdapter.applyEdit(one.source, {
      op: 'insert_rows',
      sheet: 'Sheet1',
      at: 1,
      count: 1,
    });
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    expect(readCell(inserted.source, 'Sheet1', 'A2')).toEqual(text('a'));
  });

  it('sort_range / dedupe_rows / replace_in_range 经适配器可达', () => {
    let source = emptyWorkbook('Sheet1');
    for (const [address, value] of [
      ['A1', text('b')],
      ['A2', text('a')],
    ] as const) {
      const step = xlsxDeliverableAdapter.applyEdit(source, {
        op: 'set_cell',
        sheet: 'Sheet1',
        address,
        value,
      });
      if (!step.ok) throw new Error(step.detail);
      source = step.source;
    }
    const sorted = xlsxDeliverableAdapter.applyEdit(source, {
      op: 'sort_range',
      sheet: 'Sheet1',
      range: 'A1:A2',
      keys: [{ column: 1, direction: 'asc' }],
    });
    expect(sorted.ok).toBe(true);
    if (!sorted.ok) return;
    expect(readCell(sorted.source, 'Sheet1', 'A1')).toEqual(text('a'));
  });
});

describe('既有边界：未接线 op 仍具名拒绝', () => {
  it('merge / unmerge / move / 冻结窗格 仍是 unsupported_op（文案含「不支持的表格操作」）', () => {
    const base = emptyWorkbook('Sheet1');
    const gapOps: readonly Record<string, unknown>[] = [
      { op: 'merge_cells', sheet: 'Sheet1', range: 'A1:B2' },
      { op: 'unmerge_cells', sheet: 'Sheet1', range: 'A1:B2' },
      { op: 'move_sheet', name: 'Sheet1', to_index: 0 },
      { op: 'set_frozen_panes', sheet: 'Sheet1', rows: 1, columns: 1 },
    ];
    for (const edit of gapOps) {
      const result = xlsxDeliverableAdapter.applyEdit(base, edit);
      expect(result.ok, JSON.stringify(edit)).toBe(false);
      if (result.ok) continue;
      expect(result.kind).toBe('unsupported_op');
      expect(result.detail).toContain('不支持的表格操作');
    }
  });

  it('既有具名失败文案保持不变（最后一张工作表 / 没有工作表 / 已存在）', () => {
    const bare = emptyWorkbook('Sheet1');

    const last = xlsxDeliverableAdapter.applyEdit(bare, { op: 'remove_sheet', name: 'Sheet1' });
    expect(last.ok).toBe(false);
    if (!last.ok) {
      expect(last.kind).toBe('last_sheet');
      expect(last.detail).toContain('最后一张工作表');
    }

    const unknown = xlsxDeliverableAdapter.applyEdit(bare, { op: 'remove_sheet', name: '不存在的表' });
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

describe('导出仍是真实字节', () => {
  it('exportBytes 产出非空 xlsx 容器与 64 位 sha256 摘要', () => {
    const source = emptyWorkbook('Sheet1');
    const bytes = xlsxDeliverableAdapter.exportBytes(source);
    expect(bytes.ok).toBe(true);
    if (!bytes.ok) return;
    expect(bytes.bytes.length).toBeGreaterThan(0);
    expect(bytes.entry_count).toBeGreaterThan(0);
    expect(bytes.digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
