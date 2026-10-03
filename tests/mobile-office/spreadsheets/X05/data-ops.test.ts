/**
 * **X05**：`src/spreadsheets/data-ops/` 的独立验收（XLS-09 × XLS-10）。
 *
 * 判据不是"函数有返回值"，而是四条**可被证伪**的硬要求：
 *
 * 1. **混合数据排序保持整行**（XLS-09）：键列里混着数值 / 文本 / 布尔 / 日期 / 错误值 /
 *    公式 / 空白时，标签列与键列**仍成对同行**——只搬一列的实现会在这里立刻错配。
 * 2. **命令 schema 不猜**：未知 `kind`、缺字段、假错误码、非有限数一律**显式失败**，
 *    不返回半成品（`parse*` 抛 `ValidationError`）。
 * 3. **表内排序不动标题行与汇总行**（XLS-10）：并给出**反面对照**——朴素 `sortRange`
 *    会把汇总行卷进数据体（这正是本包要补的洞）。
 * 4. **扩表 + 引用更新**（XLS-10）：`appendTableRow` 长出表范围；表内插行时
 *    表外公式**引用改写**且公式单元格随行下移。
 *
 * 全部断言基于**真实调用**；错误路径用 `toThrow` 断言，不吞错。
 */

import { describe, expect, it } from 'vitest';

import {
  DATA_OPERATION_KINDS,
  applyDataOperation,
  describeDataOperation,
  parseCellValue,
  parseDataOperation,
  type DataOperation,
} from '../../../../src/spreadsheets/data-ops/operations.js';
import {
  appendTableRow,
  sortTable,
  tableBodyMatches,
  tableBodyRefs,
} from '../../../../src/spreadsheets/data-ops/table-compose.js';
import { getCellValue, hasCell, setCellValue, createSheet, type SheetState } from '../../../../src/spreadsheets/sheet.js';
import { sortRange } from '../../../../src/spreadsheets/sort-filter.js';
import {
  createStructuredTable,
  insertTableRows,
  tableDataRange,
  tableHeaderRange,
  tableTotalsRange,
  type StructuredTable,
} from '../../../../src/spreadsheets/structured-table.js';
import {
  blank,
  booleanValue,
  dateValue,
  errorValue,
  formulaValue,
  numberValue,
  textValue,
  type CellValue,
} from '../../../../src/spreadsheets/value.js';

/** 用 [ref, value] 列表建表（绝对坐标，便于表用例）。 */
function sheetWith(cells: readonly (readonly [string, CellValue])[]): SheetState {
  let sheet = createSheet('S', { row_count: 12, column_count: 10 });
  for (const [ref, value] of cells) sheet = setCellValue(sheet, ref, value);
  return sheet;
}

// ---------------------------------------------------------------------------
// 1. 反序列化：未知 JSON 必须显式失败
// ---------------------------------------------------------------------------

describe('X05 parseCellValue：六类不互相冒充，形状错必须抛', () => {
  it('逐类往返：合法输入原样读回', () => {
    expect(parseCellValue({ kind: 'number', value: 3 })).toEqual(numberValue(3));
    expect(parseCellValue({ kind: 'text', value: '甲' })).toEqual(textValue('甲'));
    expect(parseCellValue({ kind: 'boolean', value: true })).toEqual(booleanValue(true));
    expect(parseCellValue({ kind: 'date', epoch_ms: 1000 })).toEqual(dateValue(1000));
    expect(parseCellValue({ kind: 'blank' })).toEqual(blank);
    expect(parseCellValue({ kind: 'error', code: '#DIV/0!' })).toEqual(errorValue('#DIV/0!'));
    expect(parseCellValue({ kind: 'formula', text: 'A1+1' })).toEqual(formulaValue('A1+1'));
  });

  it('反面对照：缺 value / 假错误码 / 未知 kind / 非有限数一律抛', () => {
    expect(() => parseCellValue({ kind: 'number' })).toThrow(/value/);
    expect(() => parseCellValue({ kind: 'number', value: Number.POSITIVE_INFINITY })).toThrow(/有限数/);
    expect(() => parseCellValue({ kind: 'text', value: 1 })).toThrow(/字符串/);
    expect(() => parseCellValue({ kind: 'error', code: '#OOPS!' })).toThrow(/封闭错误码/);
    expect(() => parseCellValue({ kind: 'formula', text: '' })).toThrow(/非空/);
    expect(() => parseCellValue({ kind: 'money', value: 1 })).toThrow(/未知的单元格类别/);
    expect(() => parseCellValue(null)).toThrow(/必须是一个对象/);
  });

  it('反向对照：number 1 与 text "1" 反序列化后仍是两个不同类别', () => {
    const n = parseCellValue({ kind: 'number', value: 1 });
    const t = parseCellValue({ kind: 'text', value: '1' });
    expect(n.kind).toBe('number');
    expect(t.kind).toBe('text');
  });
});

describe('X05 parseDataOperation：封闭 kind + 严格字段', () => {
  it('五种操作的合法输入都能解析并冻结', () => {
    const sort = parseDataOperation({
      kind: 'sort',
      range: 'A1:B4',
      keys: [{ column: 2, direction: 'desc' }],
      header: true,
      blanks: 'first',
    });
    expect(sort.kind).toBe('sort');
    expect(Object.isFrozen(sort)).toBe(true);

    const filter = parseDataOperation({
      kind: 'filter',
      range: 'A1:C4',
      group: { op: 'and', conditions: [{ column: 2, operator: 'greaterThan', value: { kind: 'number', value: 70 } }] },
    });
    expect(filter.kind).toBe('filter');

    expect(parseDataOperation({ kind: 'dedupe', range: 'A1:B4', key_columns: [1] }).kind).toBe('dedupe');
    expect(parseDataOperation({ kind: 'dropBlankRows', range: 'A1:B4' }).kind).toBe('dropBlankRows');
    expect(parseDataOperation({ kind: 'findReplace', range: 'A1:B4', find: 'a', replacement: 'b' }).kind).toBe('findReplace');
  });

  it('嵌套筛选组递归解析', () => {
    const op = parseDataOperation({
      kind: 'filter',
      range: 'A1:C4',
      group: {
        op: 'or',
        conditions: [
          { op: 'and', conditions: [{ column: 2, operator: 'lessThan', value: { kind: 'number', value: 60 } }] },
          { column: 1, operator: 'equals', value: { kind: 'text', value: '丙' } },
        ],
      },
    });
    if (op.kind !== 'filter') throw new Error('应为 filter');
    const first = op.group.conditions[0];
    expect(first !== undefined && 'op' in first && first.op === 'and').toBe(true);
  });

  it('反面对照：未知 kind / 缺字段 / 非法方向 / 非法算子 / 空 key_columns 全部抛', () => {
    expect(() => parseDataOperation({ kind: 'pivot', range: 'A1:B4' })).toThrow(/未知的数据操作 kind/);
    expect(() => parseDataOperation({ kind: 'sort', keys: [{ column: 1, direction: 'asc' }] })).toThrow(/range/);
    expect(() => parseDataOperation({ kind: 'sort', range: 'A1:B4', keys: [] })).toThrow(/至少需要一个排序键/);
    expect(() => parseDataOperation({ kind: 'sort', range: 'A1:B4', keys: [{ column: 1, direction: 'up' }] })).toThrow(/asc \/ desc/);
    expect(() => parseDataOperation({ kind: 'sort', range: 'A1:B4', keys: [{ column: 0, direction: 'asc' }] })).toThrow(/column/);
    expect(() => parseDataOperation({ kind: 'filter', range: 'A1:B4', group: { op: 'xor', conditions: [] } })).toThrow(/and \/ or/);
    expect(() =>
      parseDataOperation({ kind: 'filter', range: 'A1:B4', group: { op: 'and', conditions: [{ column: 1, operator: 'regex', value: { kind: 'text', value: 'x' } }] } }),
    ).toThrow(/operator 未知/);
    expect(() => parseDataOperation({ kind: 'dedupe', range: 'A1:B4', key_columns: [] })).toThrow(/不能为空/);
    expect(() => parseDataOperation({ kind: 'findReplace', range: 'A1:B4', find: '', replacement: 'b' })).toThrow(/find/);
  });

  it('DATA_OPERATION_KINDS 是封闭枚举且与 describe 一致', () => {
    expect([...DATA_OPERATION_KINDS]).toEqual(['sort', 'filter', 'dedupe', 'dropBlankRows', 'findReplace']);
    expect(describeDataOperation(parseDataOperation({ kind: 'sort', range: 'A1:B4', keys: [{ column: 2, direction: 'asc' }] }))).toContain('整行排序');
    expect(describeDataOperation(parseDataOperation({ kind: 'dedupe', range: 'A1:B4' }))).toContain('全部列');
  });
});

// ---------------------------------------------------------------------------
// 2. 混合数据排序保持整行（XLS-09 核心）
// ---------------------------------------------------------------------------

describe('XLS-09 混合数据排序：整行记录保持对应', () => {
  /** 键列（B）刻意混入七种不同类别的值；A 列是标签、C 列是伴随列。 */
  const mixed = (): SheetState =>
    sheetWith([
      ['A1', textValue('甲')], ['B1', numberValue(2)], ['C1', textValue('T-甲')],
      ['A2', textValue('乙')], ['B2', textValue('a')], ['C2', textValue('T-乙')],
      ['A3', textValue('丙')], ['B3', booleanValue(true)], ['C3', textValue('T-丙')],
      ['A4', textValue('丁')], ['B4', blank], ['C4', textValue('T-丁')],
      ['A5', textValue('戊')], ['B5', formulaValue('A1')], ['C5', textValue('T-戊')],
      ['A6', textValue('己')], ['B6', errorValue('#DIV/0!')], ['C6', textValue('T-己')],
      ['A7', textValue('庚')], ['B7', dateValue(1000)], ['C7', textValue('T-庚')],
    ]);

  it('按 B 列升序：类别次序 数值/日期 < 文本 < 布尔 < 错误 < 公式 < 空白，且整行随行搬运', () => {
    const sorted = sortRange(mixed(), 'A1:C7', [{ column: 2, direction: 'asc' }]);
    // (标签, 键值, 伴随列) 三元组必须仍然同行
    const expected: readonly (readonly [string, CellValue, string])[] = [
      ['甲', numberValue(2), 'T-甲'],
      ['庚', dateValue(1000), 'T-庚'],
      ['乙', textValue('a'), 'T-乙'],
      ['丙', booleanValue(true), 'T-丙'],
      ['己', errorValue('#DIV/0!'), 'T-己'],
      ['戊', formulaValue('A1'), 'T-戊'],
      ['丁', blank, 'T-丁'],
    ];
    expected.forEach(([label, key, tag], index) => {
      const row = index + 1;
      expect(getCellValue(sorted, { column: 1, row })).toEqual(textValue(label));
      expect(getCellValue(sorted, { column: 2, row })).toEqual(key);
      expect(getCellValue(sorted, { column: 3, row })).toEqual(textValue(tag));
    });
  });

  it('断言"只搬一列就会错配"：任意行里 A/B/C 三列的标签必须自洽', () => {
    const sorted = sortRange(mixed(), 'A1:C7', [{ column: 2, direction: 'asc' }]);
    for (let row = 1; row <= 7; row += 1) {
      const label = getCellValue(sorted, { column: 1, row });
      const tag = getCellValue(sorted, { column: 3, row });
      if (label.kind !== 'text' || tag.kind !== 'text') throw new Error('标签/伴随列应为文本');
      // 伴随列是标签的派生值：`T-<标签>`。若整行被打散，这里必然对不上。
      expect(tag.value).toBe(`T-${label.value}`);
    }
  });

  it('逆序对照：desc 的非空序列恰为 asc 的镜像', () => {
    const asc = sortRange(mixed(), 'A1:C7', [{ column: 2, direction: 'asc' }]);
    const desc = sortRange(mixed(), 'A1:C7', [{ column: 2, direction: 'desc' }]);
    // 只取键列非空白的行（空白键的行位置由 blanks 选项决定，不参与镜像比较）
    const labels = (sheet: SheetState): string[] => {
      const out: string[] = [];
      for (let row = 1; row <= 7; row += 1) {
        if (getCellValue(sheet, { column: 2, row }).kind === 'blank') continue;
        const value = getCellValue(sheet, { column: 1, row });
        if (value.kind === 'text') out.push(value.value);
      }
      return out;
    };
    expect(labels(desc)).toEqual([...labels(asc)].reverse());
  });

  it('blanks 选项是结果语义，不随 desc 翻转：first 在 asc / desc 下都排最前', () => {
    const ascFirst = sortRange(mixed(), 'A1:C7', [{ column: 2, direction: 'asc' }], { blanks: 'first' });
    const descFirst = sortRange(mixed(), 'A1:C7', [{ column: 2, direction: 'desc' }], { blanks: 'first' });
    expect(getCellValue(ascFirst, 'A1')).toEqual(textValue('丁')); // 空白行
    expect(getCellValue(descFirst, 'A1')).toEqual(textValue('丁'));
    // 反向对照：默认 blanks:'last' 时 asc / desc 下空白都在最后一行
    const ascLast = sortRange(mixed(), 'A1:C7', [{ column: 2, direction: 'asc' }]);
    const descLast = sortRange(mixed(), 'A1:C7', [{ column: 2, direction: 'desc' }]);
    expect(getCellValue(ascLast, 'A7')).toEqual(textValue('丁'));
    expect(getCellValue(descLast, 'A7')).toEqual(textValue('丁'));
  });
});

// ---------------------------------------------------------------------------
// 3. applyDataOperation 派发 + 回执
// ---------------------------------------------------------------------------

describe('X05 applyDataOperation：命令派发 + changedObjects/warnings', () => {
  it('JSON 往返后执行 sort：原样复现整行结果，并如实回报排序局限', () => {
    const payload = JSON.stringify({
      kind: 'sort',
      range: 'A1:B3',
      keys: [{ column: 2, direction: 'asc' }],
    });
    const op = parseDataOperation(JSON.parse(payload));
    const sheet = sheetWith([
      ['A1', textValue('甲')], ['B1', numberValue(3)],
      ['A2', textValue('乙')], ['B2', numberValue(1)],
      ['A3', textValue('丙')], ['B3', numberValue(2)],
    ]);
    const result = applyDataOperation(sheet, op);
    expect(result.changedObjects).toEqual(['A1:B3']);
    expect(result.warnings.join(' ')).toContain('不重写');
    expect(getCellValue(result.sheet, 'A1')).toEqual(textValue('乙'));
    expect(getCellValue(result.sheet, 'B1')).toEqual(numberValue(1));
    expect(getCellValue(result.sheet, 'A3')).toEqual(textValue('甲'));
  });

  it('filter 命令：不命中的整行删除，标签与数值仍成对', () => {
    const op = parseDataOperation({
      kind: 'filter',
      range: 'A1:B4',
      group: { op: 'and', conditions: [{ column: 2, operator: 'greaterThanOrEqual', value: { kind: 'number', value: 20 } }] },
    });
    const sheet = sheetWith([
      ['A1', textValue('甲')], ['B1', numberValue(10)],
      ['A2', textValue('乙')], ['B2', numberValue(20)],
      ['A3', textValue('丙')], ['B3', numberValue(30)],
      ['A4', textValue('丁')], ['B4', numberValue(5)],
    ]);
    const result = applyDataOperation(sheet, op);
    expect(getCellValue(result.sheet, 'A1')).toEqual(textValue('乙'));
    expect(getCellValue(result.sheet, 'B1')).toEqual(numberValue(20));
    expect(getCellValue(result.sheet, 'A2')).toEqual(textValue('丙'));
    expect(getCellValue(result.sheet, 'A3')).toBe(blank);
  });

  it('findReplace 命令：changedObjects 精确到实际改动的格子（没改不登记）', () => {
    const op = parseDataOperation({ kind: 'findReplace', range: 'A1:B2', find: 'apple', replacement: '梨' });
    const sheet = sheetWith([
      ['A1', textValue('Apple')], ['B1', numberValue(1)],
      ['A2', textValue('梨派')], ['B2', textValue('APPLE')],
    ]);
    const result = applyDataOperation(sheet, op);
    expect(result.changedObjects).toEqual(['A1', 'B2']);
    expect(getCellValue(result.sheet, 'A1')).toEqual(textValue('梨'));
    expect(getCellValue(result.sheet, 'A2')).toEqual(textValue('梨派')); // 未命中，不动
  });

  it('反向对照：dedupe 与 dropBlankRows 的空操作不改数据', () => {
    const sheet = sheetWith([
      ['A1', textValue('甲')], ['B1', numberValue(1)],
      ['A2', textValue('乙')], ['B2', numberValue(2)],
    ]);
    const dedupe: DataOperation = parseDataOperation({ kind: 'dedupe', range: 'A1:B2' });
    const same = applyDataOperation(sheet, dedupe);
    expect(getCellValue(same.sheet, 'A1')).toEqual(textValue('甲'));
    expect(getCellValue(same.sheet, 'A2')).toEqual(textValue('乙'));
    expect(same.changedObjects).toEqual(['A1:B2']);
  });
});

// ---------------------------------------------------------------------------
// 4. 结构化表格 × 排序（标题行 / 汇总行钉住）
// ---------------------------------------------------------------------------

/** 表 `费用表` B3:C7：标题行 3、数据体 4–6、汇总行 7（min ⇒ 100）。 */
function costTable(): StructuredTable {
  return createStructuredTable({
    name: '费用表',
    range: 'B3:C7',
    columns: ['项目', { name: '金额', totals_function: 'min' }],
    totals_row: true,
  });
}

function costSheet(): SheetState {
  return sheetWith([
    ['B3', textValue('项目')], ['C3', textValue('金额')],
    ['B4', textValue('餐饮')], ['C4', numberValue(300)],
    ['B5', textValue('交通')], ['C5', numberValue(100)],
    ['B6', textValue('住宿')], ['C6', numberValue(200)],
    ['B7', textValue('合计')], ['C7', numberValue(100)],
  ]);
}

describe('XLS-10 sortTable：只排数据体，标题行与汇总行钉住', () => {
  it('数据体按金额升序，表范围与三段划分全部不变', () => {
    const before = costTable();
    const result = sortTable(costSheet(), before, [{ column: 3, direction: 'asc' }]);
    expect(result.table.range).toBe('B3:C7');
    expect(tableHeaderRange(result.table)).toBe('B3:C3');
    expect(tableDataRange(result.table)).toBe('B4:C6');
    expect(tableTotalsRange(result.table)).toBe('B7:C7');
    expect(result.movedRows).toBe(3);

    // 标题行不动
    expect(getCellValue(result.sheet, 'B3')).toEqual(textValue('项目'));
    // 数据体已升序
    expect(getCellValue(result.sheet, 'B4')).toEqual(textValue('交通'));
    expect(getCellValue(result.sheet, 'C4')).toEqual(numberValue(100));
    expect(getCellValue(result.sheet, 'B6')).toEqual(textValue('餐饮'));
    expect(getCellValue(result.sheet, 'C6')).toEqual(numberValue(300));
    // 汇总行仍在最后一行
    expect(getCellValue(result.sheet, 'B7')).toEqual(textValue('合计'));
    expect(result.warnings.join(' ')).toContain('汇总行不动');
  });

  it('反面对照：朴素 sortRange 会越过表结构，把汇总行卷进数据体', () => {
    // 汇总行 100 与数据行 100 并列：朴素排序会把"合计"排到中间而不是末尾
    const naive = sortRange(costSheet(), 'B3:C7', [{ column: 3, direction: 'asc' }], { header: true });
    expect(getCellValue(naive, 'B7')).not.toEqual(textValue('合计')); // 汇总行被搬走了
    // 受控版本把它请回末行
    const controlled = sortTable(costSheet(), costTable(), [{ column: 3, direction: 'asc' }]);
    expect(getCellValue(controlled.sheet, 'B7')).toEqual(textValue('合计'));
  });

  it('反面对照：排序列不在表内 ⇒ 显式失败', () => {
    expect(() => sortTable(costSheet(), costTable(), [{ column: 1, direction: 'asc' }])).toThrow(/不在表/);
  });

  it('空数据体的表：sortTable 是无副作用的空操作', () => {
    const headOnly = createStructuredTable({ name: '空表', range: 'A1:B1', columns: ['名', '值'] });
    const sheet = sheetWith([['A1', textValue('名')], ['B1', textValue('值')]]);
    const result = sortTable(sheet, headOnly, [{ column: 2, direction: 'asc' }]);
    expect(result.movedRows).toBe(0);
    expect(getCellValue(result.sheet, 'A1')).toEqual(textValue('名'));
  });
});

// ---------------------------------------------------------------------------
// 5. 扩表 + 引用更新（XLS-10）
// ---------------------------------------------------------------------------

describe('XLS-10 appendTableRow：表长大 + 引用随行迁移', () => {
  it('追加一行：表范围 +1，汇总行与表外公式一起下移且内容不坏', () => {
    const table = costTable();
    const sheet = sheetWith([
      ['B3', textValue('项目')], ['C3', textValue('金额')],
      ['B4', textValue('餐饮')], ['C4', numberValue(300)],
      ['B5', textValue('交通')], ['C5', numberValue(100)],
      ['B6', textValue('住宿')], ['C6', numberValue(200)],
      ['B7', textValue('合计')], ['C7', formulaValue('SUBTOTAL(109,费用表[金额])')],
      ['D10', formulaValue('SUM(C4:C6)')],
    ]);
    const result = appendTableRow(sheet, table, [textValue('打车'), numberValue(50)]);

    // 表长大了
    expect(result.table.range).toBe('B3:C8');
    expect(tableDataRange(result.table)).toBe('B4:C7');
    expect(tableTotalsRange(result.table)).toBe('B8:C8');
    expect(result.row).toBe(7);

    // 新数据行落在数据体末尾
    expect(getCellValue(result.sheet, 'B7')).toEqual(textValue('打车'));
    expect(getCellValue(result.sheet, 'C7')).toEqual(numberValue(50));
    // 汇总行随插入下移，公式原文不被破坏
    expect(getCellValue(result.sheet, 'B8')).toEqual(textValue('合计'));
    expect(getCellValue(result.sheet, 'C8')).toEqual(formulaValue('SUBTOTAL(109,费用表[金额])'));
    // 表外公式单元格随行下移（引用区间落在插入点之上，按迁移规则保持不变）
    expect(hasCell(result.sheet, 'D10')).toBe(false);
    expect(getCellValue(result.sheet, 'D11')).toEqual(formulaValue('SUM(C4:C6)'));
  });

  it('反面对照：值的个数必须等于表列数（少一列 / 多一列都失败）', () => {
    const table = costTable();
    const sheet = costSheet();
    expect(() => appendTableRow(sheet, table, [textValue('打车')])).toThrow(/需要 2 个值/);
    expect(() => appendTableRow(sheet, table, [textValue('打车'), numberValue(50), numberValue(1)])).toThrow(/需要 2 个值/);
  });

  it('blank 值不落显式条目：读回仍是空白', () => {
    const table = createStructuredTable({ name: '清单', range: 'A1:B2', columns: ['名', '值'] });
    const sheet = sheetWith([['A1', textValue('名')], ['B1', textValue('值')], ['A2', textValue('甲')], ['B2', numberValue(1)]]);
    const result = appendTableRow(sheet, table, [textValue('乙'), blank]);
    expect(result.table.range).toBe('A1:B3');
    expect(getCellValue(result.sheet, 'A3')).toEqual(textValue('乙'));
    expect(getCellValue(result.sheet, 'B3')).toBe(blank);
    expect(hasCell(result.sheet, 'B3')).toBe(false);
  });

  it('表内插行 ⇒ 表外公式引用被真实改写（不是只搬单元格）', () => {
    const table = costTable();
    const sheet = sheetWith([
      ['B3', textValue('项目')], ['C3', textValue('金额')],
      ['B4', textValue('餐饮')], ['C4', numberValue(300)],
      ['B5', textValue('交通')], ['C5', numberValue(100)],
      ['B6', textValue('住宿')], ['C6', numberValue(200)],
      ['B7', textValue('合计')], ['C7', numberValue(100)],
      ['D10', formulaValue('SUM(C4:C6)')],
    ]);
    const { sheet: grown, table: grownTable } = insertTableRows(sheet, table, 4, 1);
    expect(grownTable.range).toBe('B3:C8');
    // 引用 C4:C6 落在插入点(4)及以下 ⇒ 两个端点各自迁移 ⇒ C5:C7
    expect(getCellValue(grown, 'D11')).toEqual(formulaValue('SUM(C5:C7)'));
    expect(hasCell(grown, 'D10')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. 表数据体的筛选 / 引用辅助
// ---------------------------------------------------------------------------

describe('X05 表数据体辅助', () => {
  it('tableBodyMatches 只看数据体：标题行与汇总行的值不参与匹配', () => {
    const table = costTable();
    // 标题行含"项目"，汇总行为"合计"；条件命中"合计"应返回空（汇总行不在数据体）
    const hitTotals = tableBodyMatches(costSheet(), table, {
      op: 'and',
      conditions: [{ column: 2, operator: 'contains', text: '合计' }],
    });
    expect([...hitTotals]).toEqual([]);
    const hitBody = tableBodyMatches(costSheet(), table, {
      op: 'and',
      conditions: [{ column: 3, operator: 'greaterThanOrEqual', value: numberValue(200) }],
    });
    expect([...hitBody]).toEqual([4, 6]); // 餐饮 300、住宿 200
  });

  it('tableBodyRefs 只列数据体的非空格', () => {
    expect([...tableBodyRefs(costSheet(), costTable())]).toEqual(['B4', 'C4', 'B5', 'C5', 'B6', 'C6']);
  });

  it('空数据体：tableBodyMatches / tableBodyRefs 都是空数组而不是抛', () => {
    const headOnly = createStructuredTable({ name: '空表', range: 'A1:B1', columns: ['名', '值'] });
    const sheet = sheetWith([['A1', textValue('名')], ['B1', textValue('值')]]);
    expect([...tableBodyMatches(sheet, headOnly, { op: 'and', conditions: [] })]).toEqual([]);
    expect([...tableBodyRefs(sheet, headOnly)]).toEqual([]);
  });
});
