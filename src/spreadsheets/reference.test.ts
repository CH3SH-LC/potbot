import { describe, expect, it } from 'vitest';

import {
  MAX_COLUMN_NUMBER,
  columnLettersToNumber,
  columnNumberToLetters,
  formatCellAddress,
  formatCellReference,
  formatRange,
  mapReferenceOnColumnDelete,
  mapReferenceOnColumnInsert,
  mapReferenceOnRowDelete,
  mapReferenceOnRowInsert,
  normalizeSheetName,
  parseCellAddress,
  parseCellReference,
  parseRange,
  parseSheetQualifiedReference,
  rangeContainsAddress,
  sheetNameKey,
  shiftReference,
  type CellReference,
} from './reference.js';

function ref(text: string): CellReference {
  return parseCellReference(text);
}

describe('列字母 ↔ 列号', () => {
  it('边界与进位', () => {
    expect(columnNumberToLetters(1)).toBe('A');
    expect(columnNumberToLetters(26)).toBe('Z');
    expect(columnNumberToLetters(27)).toBe('AA');
    expect(columnNumberToLetters(52)).toBe('AZ');
    expect(columnNumberToLetters(MAX_COLUMN_NUMBER)).toBe('XFD');
    expect(columnLettersToNumber('a')).toBe(1);
    expect(columnLettersToNumber('AA')).toBe(27);
    expect(columnLettersToNumber('XFD')).toBe(MAX_COLUMN_NUMBER);
  });

  it('超出 Excel 列上限显式失败（不静默回绕）', () => {
    expect(() => columnNumberToLetters(0)).toThrow(/列号/);
    expect(() => columnNumberToLetters(MAX_COLUMN_NUMBER + 1)).toThrow(/列号/);
    expect(() => columnLettersToNumber('ZZZ')).toThrow(/列上限/);
    expect(() => columnLettersToNumber('A1')).toThrow(/列字母/);
  });
});

describe('引用解析与格式化', () => {
  it('保留 $ 标记往返一致', () => {
    for (const text of ['A1', '$A1', 'A$1', '$A$1', 'XFD1048576']) {
      expect(formatCellReference(ref(text))).toBe(text);
    }
  });

  it('parseCellReference 读得出绝对标记', () => {
    expect(ref('$B$3')).toEqual({ column: 2, row: 3, abs_column: true, abs_row: true });
    expect(ref('B3')).toEqual({ column: 2, row: 3, abs_column: false, abs_row: false });
    expect(ref('$B3').abs_column).toBe(true);
    expect(ref('B$3').abs_row).toBe(true);
  });

  it('非法引用显式抛（不猜）', () => {
    for (const bad of ['', '1A', 'A', 'A0', 'AAAA1', 'A 1', '#REF!', 'A1:B2']) {
      expect(() => parseCellReference(bad)).toThrow();
    }
  });

  it('parseCellAddress 拒绝绝对标记', () => {
    expect(parseCellAddress('B3')).toEqual({ column: 2, row: 3 });
    expect(() => parseCellAddress('$B$3')).toThrow(/绝对引用标记/);
  });

  it('区域两端归一化为左上 / 右下', () => {
    expect(formatRange(parseRange('B3:A1'))).toBe('A1:B3');
    expect(formatRange(parseRange('A1:C3'))).toBe('A1:C3');
    expect(formatRange(parseRange('A1'))).toBe('A1');
    expect(() => parseRange('A1:B2:C3')).toThrow(/无法解析区域/);
  });

  it('rangeContainsAddress 含边界', () => {
    const range = parseRange('B2:C3');
    expect(rangeContainsAddress(range, { column: 2, row: 2 })).toBe(true);
    expect(rangeContainsAddress(range, { column: 3, row: 3 })).toBe(true);
    expect(rangeContainsAddress(range, { column: 1, row: 2 })).toBe(false);
    expect(rangeContainsAddress(range, { column: 3, row: 4 })).toBe(false);
  });
});

describe('复制 / 填充语义的位移：只有非绝对轴动', () => {
  it('相对引用两轴都动，绝对引用不动', () => {
    expect(formatCellReference(shiftReference(ref('B3'), { column: 1, row: 2 }))).toBe('C5');
    expect(formatCellReference(shiftReference(ref('$B3'), { column: 1, row: 2 }))).toBe('$B5');
    expect(formatCellReference(shiftReference(ref('B$3'), { column: 1, row: 2 }))).toBe('C$3');
    expect(formatCellReference(shiftReference(ref('$B$3'), { column: 1, row: 2 }))).toBe('$B$3');
  });

  it('位移越界显式抛', () => {
    expect(() => shiftReference(ref('A1'), { column: -1, row: 0 })).toThrow(/column 越界/);
  });
});

describe('XLS-04：行增删后的引用迁移', () => {
  it('插入点及其下方的引用整体下移，且**绝对引用同样下移**', () => {
    expect(mapReferenceOnRowInsert(ref('A3'), 2, 5)).toEqual({
      ok: true,
      reference: ref('A8'),
    });
    expect(mapReferenceOnRowInsert(ref('A1'), 2, 5)).toEqual({ ok: true, reference: ref('A1') });
    // $ 固定的是复制语义，不固定插入：Excel 里 $A$3 也变 $A$8
    expect(mapReferenceOnRowInsert(ref('$A$3'), 2, 5)).toEqual({ ok: true, reference: ref('$A$8') });
  });

  it('删除命中区间 ⇒ deleted（不伪造新行号）', () => {
    expect(mapReferenceOnRowDelete(ref('A3'), 2, 5)).toEqual({ ok: false, reason: 'deleted' });
    expect(mapReferenceOnRowDelete(ref('A6'), 2, 5)).toEqual({ ok: false, reason: 'deleted' });
    expect(mapReferenceOnRowDelete(ref('A2'), 2, 5)).toEqual({ ok: false, reason: 'deleted' });
  });

  it('删除区间之后的引用上移，之前的引用不动', () => {
    expect(mapReferenceOnRowDelete(ref('A9'), 2, 5)).toEqual({ ok: true, reference: ref('A4') });
    expect(mapReferenceOnRowDelete(ref('A1'), 2, 5)).toEqual({ ok: true, reference: ref('A1') });
    expect(mapReferenceOnRowDelete(ref('$A$9'), 2, 5)).toEqual({ ok: true, reference: ref('$A$4') });
  });

  it('列轴的迁移与行轴同构', () => {
    expect(mapReferenceOnColumnInsert(ref('C1'), 2, 3)).toEqual({ ok: true, reference: ref('F1') });
    expect(mapReferenceOnColumnDelete(ref('D1'), 2, 3)).toEqual({ ok: false, reason: 'deleted' });
    expect(mapReferenceOnColumnDelete(ref('F1'), 2, 3)).toEqual({ ok: true, reference: ref('C1') });
  });

  it('参数非法与越界插入显式抛', () => {
    expect(() => mapReferenceOnRowInsert(ref('A1'), 0, 1)).toThrow(/at/);
    expect(() => mapReferenceOnRowInsert(ref('A1'), 1, 0)).toThrow(/count/);
    expect(() => mapReferenceOnRowInsert(ref('A1048576'), 1, 1)).toThrow(/超过 Excel 上限/);
  });

  it('formatCellAddress 供区域文本使用', () => {
    expect(formatCellAddress({ column: 27, row: 3 })).toBe('AA3');
  });
});

describe('X-I20：工作表名的规范化（引号只是书写层）', () => {
  it('normalizeSheetName：裸名原样、带引号去引号、内部 \'\' 还原为一个 \'  ', () => {
    expect(normalizeSheetName('明细')).toBe('明细');
    expect(normalizeSheetName('Sheet1')).toBe('Sheet1');
    expect(normalizeSheetName("'预算 表'")).toBe('预算 表');
    expect(normalizeSheetName("'it''s'")).toBe("it's");
    expect(() => normalizeSheetName('')).toThrow(/不能为空/);
    expect(() => normalizeSheetName("'未闭合")).toThrow(/引号不成对/);
  });

  it('sheetNameKey：大小写不敏感（Excel 表名不区分大小写）', () => {
    expect(sheetNameKey('Sheet1')).toBe(sheetNameKey('sheet1'));
    expect(sheetNameKey("'明细'")).toBe(sheetNameKey('明细'));
    expect(sheetNameKey('A')).not.toBe(sheetNameKey('B'));
  });

  it('parseSheetQualifiedReference：裸名与引号名解出**同一个**表名', () => {
    expect(parseSheetQualifiedReference('明细!A1')).toEqual({
      sheet: '明细',
      reference: { column: 1, row: 1, abs_column: false, abs_row: false },
    });
    // 关键：引号只是书写层——两条结果逐字段相同（与 formula-parse 的口径一致）
    expect(parseSheetQualifiedReference("'明细'!A1")).toEqual(parseSheetQualifiedReference('明细!A1'));
    expect(parseSheetQualifiedReference("'预算 表'!$B$2")).toEqual({
      sheet: '预算 表',
      reference: { column: 2, row: 2, abs_column: true, abs_row: true },
    });
  });

  it('parseSheetQualifiedReference：无 ! 是本表引用（sheet = null）', () => {
    expect(parseSheetQualifiedReference('A1')).toEqual({
      sheet: null,
      reference: { column: 1, row: 1, abs_column: false, abs_row: false },
    });
  });

  it('parseSheetQualifiedReference：非法输入显式失败（区域 / 空体 / 坏引用）', () => {
    expect(() => parseSheetQualifiedReference('')).toThrow(/无法解析跨表引用/);
    expect(() => parseSheetQualifiedReference('明细!')).toThrow(/之后没有单元格引用/);
    expect(() => parseSheetQualifiedReference('明细!A1:B2')).toThrow();
    expect(() => parseSheetQualifiedReference('明细!nope')).toThrow();
  });
});
