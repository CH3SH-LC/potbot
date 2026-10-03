/**
 * `sort-filter.ts` 的验收用例（design-06-P8 / XLS-09）。
 *
 * **核心判据不是"函数返回了东西"，而是"整行记录还对不对得上"**：
 * 每个会动行的用例都会把 (标签列, 数值列) 成对读回，断言它们仍然同行——
 * 只移动一列的实现会在这些用例里立刻变红。
 */

import { describe, expect, it } from 'vitest';

import { createSheet, getCellValue, hasCell, setCellValue, type SheetState } from './sheet.js';
import { blank, numberValue, textValue, type CellValue } from './value.js';
import {
  applyFilter,
  compareCellValues,
  countBlankCells,
  dedupeRows,
  dropBlankRows,
  filterRowIndices,
  findCells,
  isBlankRow,
  replaceInCells,
  sortRange,
  type FilterGroup,
} from './sort-filter.js';

/** 用二维字面量建表：第 1 行是数据的第一行（不做标题行假设）。 */
function buildSheet(rows: readonly (readonly CellValue[])[]): SheetState {
  let sheet = createSheet('S', { row_count: Math.max(rows.length, 1), column_count: 8 });
  rows.forEach((row, rowIndex) => {
    row.forEach((value, columnIndex) => {
      sheet = setCellValue(sheet, { column: columnIndex + 1, row: rowIndex + 1 }, value);
    });
  });
  return sheet;
}

/** 读回区域内某一列（按行序）的取值。 */
function columnOf(sheet: SheetState, column: number, rows: number): readonly CellValue[] {
  const out: CellValue[] = [];
  for (let row = 1; row <= rows; row += 1) out.push(getCellValue(sheet, { column, row }));
  return out;
}

/** 断言"标签列与数值列成对同行"——即 (A3,B3) 里的标签确实是那行原本的标签。 */
function assertPairs(
  sheet: SheetState,
  expected: readonly (readonly [string, number | CellValue])[],
  rowCount: number,
): void {
  for (let index = 0; index < expected.length; index += 1) {
    const pair = expected[index];
    if (pair === undefined) continue;
    const [label, score] = pair;
    expect(getCellValue(sheet, { column: 1, row: index + 1 })).toEqual(textValue(label));
    expect(getCellValue(sheet, { column: 2, row: index + 1 })).toEqual(
      typeof score === 'number' ? numberValue(score) : score,
    );
  }
  // 多出来的行必须是空白，避免"多留了行"被漏判
  for (let row = expected.length + 1; row <= rowCount; row += 1) {
    expect(getCellValue(sheet, { column: 1, row })).toBe(blank);
  }
}

describe('XLS-09 排序：整行保持对应', () => {
  const rows: readonly (readonly CellValue[])[] = [
    [textValue('甲'), numberValue(90), textValue('一班')],
    [textValue('乙'), numberValue(50), textValue('二班')],
    [textValue('丙'), numberValue(70), textValue('一班')],
    [textValue('丁'), numberValue(50), textValue('三班')],
  ];

  it('单键升序：整行一起搬，标签与数值绝不错配', () => {
    const sorted = sortRange(buildSheet(rows), 'A1:C4', [{ column: 2, direction: 'asc' }]);
    assertPairs(sorted, [['乙', 50], ['丁', 50], ['丙', 70], ['甲', 90]], 4);
    // 第三列也跟着走了：说明搬的是整行而不是某一列
    expect(getCellValue(sorted, 'C1')).toEqual(textValue('二班'));
    expect(getCellValue(sorted, 'C4')).toEqual(textValue('一班'));
  });

  it('多键：先按分数升序，分数相同再按名称升序', () => {
    const sorted = sortRange(buildSheet(rows), 'A1:C4', [
      { column: 2, direction: 'asc' },
      { column: 1, direction: 'asc' },
    ]);
    assertPairs(sorted, [['丁', 50], ['乙', 50], ['丙', 70], ['甲', 90]], 4);
  });

  it('降序 = 升序的镜像（反向对照）', () => {
    const asc = sortRange(buildSheet(rows), 'A1:C4', [{ column: 2, direction: 'asc' }]);
    const desc = sortRange(buildSheet(rows), 'A1:C4', [{ column: 2, direction: 'desc' }]);
    expect(columnOf(asc, 2, 4)).toEqual([numberValue(50), numberValue(50), numberValue(70), numberValue(90)]);
    expect(columnOf(desc, 2, 4)).toEqual([numberValue(90), numberValue(70), numberValue(50), numberValue(50)]);
  });

  it('标题行不参与排序', () => {
    let sheet = buildSheet([
      [textValue('姓名'), textValue('分数')],
      [textValue('甲'), numberValue(90)],
      [textValue('乙'), numberValue(50)],
    ]);
    sheet = sortRange(sheet, 'A1:B3', [{ column: 2, direction: 'asc' }], { header: true });
    expect(getCellValue(sheet, 'A1')).toEqual(textValue('姓名'));
    expect(getCellValue(sheet, 'A2')).toEqual(textValue('乙'));
    expect(getCellValue(sheet, 'A3')).toEqual(textValue('甲'));
  });

  it('空白默认排最后；显式 blanks:first 时排最前（反向对照）', () => {
    const mixed = buildSheet([
      [textValue('甲'), numberValue(2)],
      [textValue('乙'), blank as CellValue],
      [textValue('丙'), numberValue(1)],
    ]);
    const last = sortRange(mixed, 'A1:B3', [{ column: 2, direction: 'asc' }]);
    expect(getCellValue(last, 'A3')).toEqual(textValue('乙'));
    const first = sortRange(mixed, 'A1:B3', [{ column: 2, direction: 'asc' }], { blanks: 'first' });
    expect(getCellValue(first, 'A1')).toEqual(textValue('乙'));
  });

  it('反向对照：已经有序时排序结果与原表逐格相同', () => {
    const already = buildSheet([
      [textValue('甲'), numberValue(1)],
      [textValue('乙'), numberValue(2)],
    ]);
    const sorted = sortRange(already, 'A1:B2', [{ column: 2, direction: 'asc' }]);
    expect(getCellValue(sorted, 'A1')).toEqual(textValue('甲'));
    expect(getCellValue(sorted, 'B2')).toEqual(numberValue(2));
  });

  it('拒绝空键表与越界列', () => {
    const sheet = buildSheet(rows);
    expect(() => sortRange(sheet, 'A1:C4', [])).toThrow(/至少需要一个排序键/);
    expect(() => sortRange(sheet, 'A1:C4', [{ column: 9, direction: 'asc' }])).toThrow(/不在区域/);
  });

  it('比较函数：数值 / 日期同数值序，文本按码元序，类别不同不冒充', () => {
    expect(compareCellValues(numberValue(1), numberValue(2))).toBeLessThan(0);
    expect(compareCellValues(textValue('1'), numberValue(1))).toBeGreaterThan(0); // 数值 < 文本
    expect(compareCellValues(blank as CellValue, numberValue(1))).toBeGreaterThan(0); // 空白默认最后
    expect(compareCellValues(blank as CellValue, numberValue(1), true)).toBeLessThan(0);
  });
});

describe('XLS-09 筛选与条件组合', () => {
  const rows: readonly (readonly CellValue[])[] = [
    [textValue('甲'), numberValue(90), textValue('北京')],
    [textValue('乙'), numberValue(50), textValue('上海')],
    [textValue('丙'), numberValue(70), textValue('北京')],
    [textValue('丁'), blank as CellValue, textValue('广州')],
  ];

  it('and 组：两个条件都要成立', () => {
    const group: FilterGroup = {
      op: 'and',
      conditions: [
        { column: 2, operator: 'greaterThanOrEqual', value: numberValue(70) },
        { column: 3, operator: 'contains', text: '北京' },
      ],
    };
    expectsRows(filterRowIndices(buildSheet(rows), 'A1:C4', group), [1, 3]);
  });

  it('or 组：任一条件成立即可（反向对照：or 命中集 ⊇ and 命中集）', () => {
    const base = [
      { column: 2 as const, operator: 'greaterThanOrEqual' as const, value: numberValue(90) },
      { column: 3 as const, operator: 'contains' as const, text: '广州' },
    ];
    const andRows = filterRowIndices(buildSheet(rows), 'A1:C4', { op: 'and', conditions: base });
    const orRows = filterRowIndices(buildSheet(rows), 'A1:C4', { op: 'or', conditions: base });
    expectsRows(andRows, []);
    expectsRows(orRows, [1, 4]);
  });

  it('嵌套组合：or(and(...), 单条件)', () => {
    const group: FilterGroup = {
      op: 'or',
      conditions: [
        {
          op: 'and',
          conditions: [
            { column: 2, operator: 'lessThan', value: numberValue(60) },
            { column: 3, operator: 'equals', value: textValue('上海') },
          ],
        },
        { column: 1, operator: 'equals', value: textValue('丙') },
      ],
    };
    expectsRows(filterRowIndices(buildSheet(rows), 'A1:C4', group), [2, 3]);
  });

  it('isEmpty 命中空白；空白不参与数值比较（R248：不隐式当 0）', () => {
    expect(filterRowIndices(buildSheet(rows), 'A1:C4', { op: 'and', conditions: [{ column: 2, operator: 'isEmpty' }] })).toEqual([4]);
    // 反向对照：lessThan 100 不会把空白行算成 0 而命中
    expect(
      filterRowIndices(buildSheet(rows), 'A1:C4', { op: 'and', conditions: [{ column: 2, operator: 'lessThan', value: numberValue(100) }] }),
    ).toEqual([1, 2, 3]);
  });

  it('文本算子只认文本单元格（类别不互相冒充）', () => {
    const sheet = buildSheet([[numberValue(12), textValue('12')]]);
    expect(filterRowIndices(sheet, 'A1:B1', { op: 'and', conditions: [{ column: 1, operator: 'contains', text: '12' }] })).toEqual([]);
    expect(filterRowIndices(sheet, 'A1:B1', { op: 'and', conditions: [{ column: 2, operator: 'contains', text: '12' }] })).toEqual([1]);
  });

  it('between 命中闭区间，且与 min/max 顺序无关', () => {
    const group: FilterGroup = { op: 'and', conditions: [{ column: 2, operator: 'between', min: 80, max: 60 }] };
    expectsRows(filterRowIndices(buildSheet(rows), 'A1:C4', group), [3]);
  });

  it('applyFilter 删除不命中的行：整行删除、下方上移、标签与数值仍成对', () => {
    const filtered = applyFilter(buildSheet(rows), 'A1:C4', {
      op: 'and',
      conditions: [{ column: 2, operator: 'greaterThanOrEqual', value: numberValue(70) }],
    });
    // 原第 2 行（乙/50）与第 4 行（丁/空白，不满足 ≥70）被**整行**删除，第 3 行上移
    expect(getCellValue(filtered, 'A1')).toEqual(textValue('甲'));
    expect(getCellValue(filtered, 'B1')).toEqual(numberValue(90));
    expect(getCellValue(filtered, 'C1')).toEqual(textValue('北京'));
    expect(getCellValue(filtered, 'A2')).toEqual(textValue('丙'));
    expect(getCellValue(filtered, 'B2')).toEqual(numberValue(70));
    expect(getCellValue(filtered, 'C2')).toEqual(textValue('北京'));
    expect(getCellValue(filtered, 'A3')).toBe(blank);
  });

  it('反向对照：空 and 组恒真 ⇒ 逐格不变（含空白行）', () => {
    const sheet = buildSheet(rows);
    const same = applyFilter(sheet, 'A1:C4', { op: 'and', conditions: [] });
    assertPairs(same, [['甲', 90], ['乙', 50], ['丙', 70], ['丁', blank]], 4);
  });
});

function expectsRows(actual: readonly number[], expected: readonly number[]): void {
  expect([...actual]).toEqual(expected);
}

describe('XLS-09 去重', () => {
  const rows: readonly (readonly CellValue[])[] = [
    [textValue('甲'), numberValue(1), textValue('x')],
    [textValue('乙'), numberValue(2), textValue('y')],
    [textValue('甲'), numberValue(1), textValue('x')],
    [textValue('丙'), numberValue(2), textValue('z')],
  ];

  it('全列判重：保留首次出现，整行删除重复行', () => {
    const deduped = dedupeRows(buildSheet(rows), 'A1:C4');
    assertPairs(deduped, [['甲', 1], ['乙', 2], ['丙', 2]], 4);
    expect(getCellValue(deduped, 'C1')).toEqual(textValue('x'));
    expect(getCellValue(deduped, 'C3')).toEqual(textValue('z'));
  });

  it('指定 key_columns 时只看这些列（反向对照：全列判重保留 3 行，按列 B 判重只留 2 行）', () => {
    const allColumns = dedupeRows(buildSheet(rows), 'A1:C4');
    const byScore = dedupeRows(buildSheet(rows), 'A1:C4', { key_columns: [2] });
    expect(columnOf(allColumns, 1, 4).filter((value) => value.kind === 'text').length).toBe(3);
    assertPairs(byScore, [['甲', 1], ['乙', 2]], 4);
  });

  it('判重是类型感知的：number 1 与 text "1" 不是同一条记录', () => {
    const typed = buildSheet([[numberValue(1), textValue('a')], [textValue('1'), textValue('b')]]);
    const deduped = dedupeRows(typed, 'A1:B2', { key_columns: [1] });
    expect(getCellValue(deduped, 'A1')).toEqual(numberValue(1));
    expect(getCellValue(deduped, 'A2')).toEqual(textValue('1'));
  });

  it('标题行不参与判重', () => {
    const withHeader = buildSheet([
      [textValue('名称'), textValue('值')],
      [textValue('甲'), numberValue(1)],
      [textValue('甲'), numberValue(1)],
    ]);
    const deduped = dedupeRows(withHeader, 'A1:B3', { header: true });
    expect(getCellValue(deduped, 'A1')).toEqual(textValue('名称'));
    expect(getCellValue(deduped, 'A2')).toEqual(textValue('甲'));
    expect(getCellValue(deduped, 'A3')).toBe(blank);
  });
});

describe('XLS-09 查找 / 替换', () => {
  const rows: readonly (readonly CellValue[])[] = [
    [textValue('Apple'), numberValue(1)],
    [textValue('apple pie'), textValue('APPLE')],
  ];

  it('默认不区分大小写，且不碰非文本单元格', () => {
    const found = findCells(buildSheet(rows), 'A1:B2', 'apple');
    expect(found.map((cell) => cell.ref)).toEqual(['A1', 'A2', 'B2']);
  });

  it('反向对照：match_case 时只命中精确大小写', () => {
    const found = findCells(buildSheet(rows), 'A1:B2', 'apple', { match_case: true });
    expect(found.map((cell) => cell.ref)).toEqual(['A2']);
  });

  it('替换全部出现处，并如实登记改动的格子（没改就没登记）', () => {
    const result = replaceInCells(buildSheet(rows), 'A1:B2', 'apple', '梨');
    expect([...result.refs]).toEqual(['A1', 'A2', 'B2']);
    expect(getCellValue(result.sheet, 'A1')).toEqual(textValue('梨'));
    expect(getCellValue(result.sheet, 'A2')).toEqual(textValue('梨 pie'));
    expect(getCellValue(result.sheet, 'B2')).toEqual(textValue('梨'));
    expect(getCellValue(result.sheet, 'B1')).toEqual(numberValue(1));
  });

  it('反向对照：没有命中时返回原状态与空登记', () => {
    const sheet = buildSheet(rows);
    const result = replaceInCells(sheet, 'A1:B2', '香蕉', '梨');
    expect([...result.refs]).toEqual([]);
    expect(getCellValue(result.sheet, 'A1')).toEqual(textValue('Apple'));
  });

  it('查找串为空 ⇒ 抛错（不静默返回空）', () => {
    expect(() => findCells(buildSheet(rows), 'A1:B2', '')).toThrow(/查找串不能为空/);
  });
});

describe('XLS-09 空值处理', () => {
  it('countBlankCells 只数区域内的空白（未设置 = 空白，不是 0）', () => {
    const sheet = buildSheet([
      [numberValue(1), blank as CellValue],
      [blank as CellValue, textValue('x')],
    ]);
    expect(countBlankCells(sheet, 'A1:B2')).toBe(2);
    expect(countBlankCells(sheet, 'A1:A2')).toBe(1);
  });

  it('isBlankRow 全空才算空行', () => {
    const sheet = buildSheet([
      [blank as CellValue, blank as CellValue],
      [blank as CellValue, numberValue(0)],
    ]);
    expect(isBlankRow(sheet, 'A1:B2', 1)).toBe(true);
    expect(isBlankRow(sheet, 'A1:B2', 2)).toBe(false); // 显式 0 不是空白（R248 反向对照）
  });

  it('dropBlankRows 删整行全空的行，其余行对齐上移', () => {
    const sheet = buildSheet([
      [textValue('甲'), numberValue(1)],
      [blank as CellValue, blank as CellValue],
      [textValue('丙'), numberValue(3)],
    ]);
    const dropped = dropBlankRows(sheet, 'A1:B3');
    assertPairs(dropped, [['甲', 1], ['丙', 3]], 3);
    expect(hasCell(dropped, 'A3')).toBe(false);
  });
});
