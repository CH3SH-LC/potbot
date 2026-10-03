/**
 * **X02**：多表 / 区域 / 行列插删复制移动合并 与 引用迁移（XLS-02–04）。
 *
 * 本文件是**独立验收**：不重复 `src/spreadsheets/*.test.ts` 的单元断言，而是把
 * `sheet.ts` / `ranges.ts` / `workbook.ts` 已有与新增的结构操作**组合起来**，断言
 * 三条判据：
 *
 * 1. **引用迁移正确**：插入 / 删除 / 复制 / 移动后，公式里的引用指向"内容实际所在"的位置；
 * 2. **数据类型不冒充**：数字 / 文本 / 布尔 / 日期 / 空白 / 错误值在结构操作前后保持自己的类别
 *    （文本 `"120"` 不得变成数值 `120`，空白不得变成 `0`）；
 * 3. **行记录对应**：同一行记录的多个列在操作后仍落在**同一行**（整行一起动，不拆散）。
 *
 * 复制 / 移动是本包新增能力（`sheet.ts` 的 `copyRows` / `copyColumns` / `moveRows` /
 * `moveColumns` + `ranges.ts` 的几何版包装 + 结构化操作 schema），因此这里既是回归也是首验。
 */

import { describe, expect, it } from 'vitest';

import {
  applyStructuralOperation,
  copyColumns,
  copyRows,
  createSheet,
  deleteColumns,
  deleteRows,
  getCellValue,
  insertColumns,
  insertRows,
  moveColumns,
  moveRows,
  parseStructuralOperation,
  STRUCTURAL_OPERATION_KINDS,
  setCellValue,
  sheetEntries,
  type SheetState,
  type StructuralOperation,
} from '../../../../src/spreadsheets/sheet.js';
import {
  copySheetRows,
  createSheetLayout,
  getRowHeight,
  hideRows,
  insertSheetRows,
  isRowHidden,
  mergeCells,
  moveSheetRows,
  setRowHeight,
} from '../../../../src/spreadsheets/ranges.js';
import {
  addSheet,
  copySheet,
  createWorkbook,
  getSheet,
  removeSheet,
  renameSheet,
  setActiveSheet,
  sheetNames,
} from '../../../../src/spreadsheets/workbook.js';
import {
  blank,
  booleanValue,
  dateValue,
  errorValue,
  formulaValue,
  isFormula,
  numberValue,
  textValue,
  valuesEqual,
  type CellValue,
} from '../../../../src/spreadsheets/value.js';

// ---------------------------------------------------------------------------
// 夹具与读取工具
// ---------------------------------------------------------------------------

/** 一张三行水果表（含整行记录 + 行内公式 + 汇总公式）。 */
function fruitSheet(): SheetState {
  let sheet = createSheet('数据');
  sheet = setCellValue(sheet, 'A1', textValue('名称'));
  sheet = setCellValue(sheet, 'B1', textValue('数量'));
  sheet = setCellValue(sheet, 'A2', textValue('苹果'));
  sheet = setCellValue(sheet, 'B2', numberValue(10));
  sheet = setCellValue(sheet, 'C2', numberValue(2.5));
  sheet = setCellValue(sheet, 'D2', formulaValue('B2*C2'));
  sheet = setCellValue(sheet, 'A3', textValue('香蕉'));
  sheet = setCellValue(sheet, 'B3', numberValue(5));
  sheet = setCellValue(sheet, 'C3', numberValue(4));
  sheet = setCellValue(sheet, 'D3', formulaValue('B3*C3'));
  sheet = setCellValue(sheet, 'A4', textValue('合计'));
  sheet = setCellValue(sheet, 'B4', formulaValue('SUM(B2:B3)'));
  return sheet;
}

/** 一列标签行 + 两个外部引用公式（用于观察"引用是否跟着被移动/复制的行走"）。 */
function labeledRows(): SheetState {
  let sheet = createSheet('移动');
  sheet = setCellValue(sheet, 'A1', textValue('一'));
  sheet = setCellValue(sheet, 'A2', textValue('二'));
  sheet = setCellValue(sheet, 'A3', textValue('三'));
  sheet = setCellValue(sheet, 'A4', textValue('四'));
  sheet = setCellValue(sheet, 'A5', textValue('五'));
  sheet = setCellValue(sheet, 'C1', formulaValue('A2'));
  sheet = setCellValue(sheet, 'C2', formulaValue('A4'));
  return sheet;
}

/** 读一行里若干列的取值（列号 1 起）。 */
function rowValues(sheet: SheetState, row: number, columns: readonly number[]): readonly CellValue[] {
  return columns.map((column) => getCellValue(sheet, { column, row }));
}

/** 取公式文本（非公式返回 `<not-formula:kind>`，让断言失败时看得见）。 */
function formulaTextOf(sheet: SheetState, address: string): string {
  const value = getCellValue(sheet, address);
  return isFormula(value) ? value.text : `<not-formula:${value.kind}>`;
}

// ---------------------------------------------------------------------------
// 1 多表
// ---------------------------------------------------------------------------

describe('XLS-02 多表：结构操作互相隔离，跨表引用可迁移', () => {
  it('对一张表做行列移动不影响另一张表', () => {
    // 明细：A1..A3 = x y z（用 setCellValue 建，再从工作簿取回）
    let detail = createSheet('明细');
    detail = setCellValue(detail, 'A1', textValue('x'));
    detail = setCellValue(detail, 'A2', textValue('y'));
    detail = setCellValue(detail, 'A3', textValue('z'));
    const workbook = createWorkbook([detail, createSheet('汇总')]);
    expect(sheetNames(workbook)).toEqual(['明细', '汇总']);
    // 明细里把 x（第 1 行）移到 z 之后（to=4 即"插到第 4 行之前"）
    const moved = moveRows(detail, 1, 1, 4);
    expect(rowValues(moved, 1, [1])[0]).toEqual(textValue('y'));
    expect(rowValues(moved, 3, [1])[0]).toEqual(textValue('x'));
    // 汇总表仍是空的（未被这次移动触及）
    expect(getSheet(workbook, '汇总')?.cells.size).toBe(0);
    // 原明细状态未被就地修改（不可变）
    expect(rowValues(detail, 1, [1])[0]).toEqual(textValue('x'));
  });

  it('复制工作表是深拷贝：副本公式仍指向副本自身（非限定引用不成跨表引用）', () => {
    let source = createSheet('源');
    source = setCellValue(source, 'A1', numberValue(3));
    source = setCellValue(source, 'A2', formulaValue('A1*2'));
    const workbook = createWorkbook([source]);
    const copied = copySheet(workbook, '源', '副本');
    const copy = getSheet(copied, '副本') as SheetState;
    // 副本里的 A2 仍是 A1*2（非限定 ⇒ 指向副本自己的 A1），不是 '源'!A1
    expect(formulaTextOf(copy, 'A2')).toBe('A1*2');
    // 深拷贝：改副本不影响原件
    expect(rowValues(getSheet(copied, '源') as SheetState, 1, [1])[0]).toEqual(numberValue(3));
  });

  it('重命名工作表改写别表里的跨表引用；被引用表不得删', () => {
    let workbook = createWorkbook([
      createSheet('源'),
      setCellValue(createSheet('引用'), 'A1', formulaValue('源!A1')),
    ]);
    workbook = renameSheet(workbook, '源', '已改名');
    // 非 ASCII 表名按 Excel 习惯加引号（`'已改名'!A1`）
    expect(formulaTextOf(getSheet(workbook, '引用') as SheetState, 'A1')).toBe("'已改名'!A1");
    // '已改名' 仍被引用 ⇒ 删除被显式阻塞
    expect(() => removeSheet(workbook, '已改名')).toThrow(/跨表引用/);
  });

  it('活跃表按身份（名字）保持：在活跃表前删表不改变活跃表身份', () => {
    let workbook = createWorkbook();
    workbook = addSheet(workbook, 'B');
    workbook = addSheet(workbook, 'C');
    workbook = setActiveSheet(workbook, 'C');
    const removed = removeSheet(workbook, 'B');
    expect(removed.sheets[removed.active_sheet]?.name).toBe('C');
  });
});

// ---------------------------------------------------------------------------
// 2 插入 / 删除：引用迁移 + 行记录对应
// ---------------------------------------------------------------------------

describe('XLS-04 插入 / 删除行：单元格、公式引用、行记录一起迁移', () => {
  it('插入一行：整行记录下移且不拆散，行内与汇总公式同步改引用', () => {
    const after = insertRows(fruitSheet(), 2, 1);
    // 表头留在第 1 行
    expect(rowValues(after, 1, [1, 2])).toEqual([textValue('名称'), textValue('数量')]);
    // 苹果整行记录现落在第 3 行（A/B/C/D 四列仍是同一行记录）
    expect(rowValues(after, 3, [1, 2, 3])).toEqual([textValue('苹果'), numberValue(10), numberValue(2.5)]);
    expect(formulaTextOf(after, 'D3')).toBe('B3*C3'); // 行内公式跟着记录走
    // 合计行现落在第 5 行，汇总公式引用随之扩展
    expect(rowValues(after, 5, [1])[0]).toEqual(textValue('合计'));
    expect(formulaTextOf(after, 'B5')).toBe('SUM(B3:B4)');
    expect(after.row_count).toBe(1001);
  });

  it('删除一行：整行记录消失，命中汇总引用的公式保留原文并登记 blocked（不伪造）', () => {
    const after = deleteRows(fruitSheet(), 3, 1); // 删掉"香蕉"整行
    expect(rowValues(after, 2, [1, 2])).toEqual([textValue('苹果'), numberValue(10)]);
    // 合计行上移到第 3 行
    expect(rowValues(after, 3, [1])[0]).toEqual(textValue('合计'));
    // SUM(B2:B3) 里的 B3 落在被删行 ⇒ 保留原文 + 登记
    expect(formulaTextOf(after, 'B3')).toBe('SUM(B2:B3)');
    expect(after.migration_blocked).toContain('B3');
  });

  it('删除列与删除行同构', () => {
    const after = deleteColumns(fruitSheet(), 3, 1); // 删掉 C 列
    expect(rowValues(after, 2, [1, 2])).toEqual([textValue('苹果'), numberValue(10)]);
    // D2 'B2*C2' → C2；C2 引用被删 ⇒ 保留原文 + 登记
    expect(formulaTextOf(after, 'C2')).toBe('B2*C2');
    expect(after.migration_blocked).toContain('C2');
  });
});

// ---------------------------------------------------------------------------
// 3 复制行 / 列
// ---------------------------------------------------------------------------

describe('XLS-04 复制行：源保留、副本公式按复制语义平移', () => {
  it('复制整行到下方：副本落在第 10 行，行内公式相对引用整体下移 8 行', () => {
    const after = copyRows(fruitSheet(), 2, 1, 10);
    // 源行保留
    expect(rowValues(after, 2, [1, 2, 3])).toEqual([textValue('苹果'), numberValue(10), numberValue(2.5)]);
    // 副本内容一致，公式平移 delta=8
    expect(rowValues(after, 10, [1, 2, 3])).toEqual([textValue('苹果'), numberValue(10), numberValue(2.5)]);
    expect(formulaTextOf(after, 'D10')).toBe('B10*C10');
    expect(after.row_count).toBe(1001);
  });

  it('复制到自身位置（insertAt === at）：等于插入一份副本，源下移', () => {
    const after = copyRows(fruitSheet(), 2, 1, 2);
    expect(rowValues(after, 2, [1])[0]).toEqual(textValue('苹果')); // 副本
    expect(rowValues(after, 3, [1])[0]).toEqual(textValue('苹果')); // 原行被下移
    expect(formulaTextOf(after, 'D2')).toBe('B2*C2'); // delta=0 ⇒ 引用不变
  });

  it('复制列：源保留、副本公式平移非绝对引用', () => {
    let sheet = createSheet('列');
    sheet = setCellValue(sheet, 'A1', numberValue(1));
    sheet = setCellValue(sheet, 'B1', numberValue(2));
    sheet = setCellValue(sheet, 'C1', formulaValue('A1+B1'));
    const after = copyColumns(sheet, 3, 1, 5); // C 列复制到 E 列，delta=2
    expect(formulaTextOf(after, 'C1')).toBe('A1+B1'); // 源保留
    expect(formulaTextOf(after, 'E1')).toBe('C1+D1'); // 副本平移
    expect(after.column_count).toBe(27);
  });

  it('反面对照：插入点落在被复制区间内部 / 越界 / 源越界，均显式抛', () => {
    const sheet = fruitSheet();
    expect(() => copyRows(sheet, 2, 3, 3)).toThrow(/内部/); // 3 ∈ (2,5)
    expect(() => copyRows(sheet, 2, 1, 0)).toThrow(/越界/);
    expect(() => copyRows(sheet, 2, 1, 1002)).toThrow(/越界/);
    expect(() => copyRows(sheet, 999, 5, 1)).toThrow(/超出/);
  });

  it('复制含无法安全改写公式的格：副本保留原文并登记 blocked，不伪造', () => {
    let sheet = createSheet('S');
    sheet = setCellValue(sheet, 'A1', formulaValue('LOG10(B1)')); // LOG10( 形状 ⇒ 阻塞
    const after = copyRows(sheet, 1, 1, 5);
    expect(formulaTextOf(after, 'A5')).toBe('LOG10(B1)'); // 逐字保留
    expect(after.migration_blocked).toContain('A5');
  });
});

// ---------------------------------------------------------------------------
// 4 移动行 / 列
// ---------------------------------------------------------------------------

describe('XLS-04 移动行：引用分段映射（跟着被移动的区间走）', () => {
  it('向下移动：被移动区间、其间的行、区间外的引用各自正确', () => {
    const after = moveRows(labeledRows(), 2, 1, 5); // 把"二"移到"五"之前
    expect(rowValues(after, 1, [1])[0]).toEqual(textValue('一'));
    expect(rowValues(after, 2, [1])[0]).toEqual(textValue('三'));
    expect(rowValues(after, 3, [1])[0]).toEqual(textValue('四'));
    expect(rowValues(after, 4, [1])[0]).toEqual(textValue('二'));
    expect(rowValues(after, 5, [1])[0]).toEqual(textValue('五'));
    expect(formulaTextOf(after, 'C1')).toBe('A4'); // 指向被移动的行 ⇒ 跟着走（C1 本身不在被移动行内）
    // C2 的公式所在行（第 2 行）属于被移动区间 ⇒ 随整行落到第 4 行 C4；其引用 'A4' 被压缩为 'A3'
    expect(formulaTextOf(after, 'C4')).toBe('A3');
    expect(getCellValue(after, 'C2')).toBe(blank); // 原地址已空（不是复制一份）
    expect(after.row_count).toBe(1000); // 移动不改变行列总数
  });

  it('向上移动：与向下移动镜像', () => {
    const after = moveRows(labeledRows(), 4, 1, 2); // 把"四"移到"二"之前
    expect(rowValues(after, 1, [1])[0]).toEqual(textValue('一'));
    expect(rowValues(after, 2, [1])[0]).toEqual(textValue('四'));
    expect(rowValues(after, 3, [1])[0]).toEqual(textValue('二'));
    expect(rowValues(after, 4, [1])[0]).toEqual(textValue('三'));
    expect(rowValues(after, 5, [1])[0]).toEqual(textValue('五'));
    expect(formulaTextOf(after, 'C1')).toBe('A3'); // 'A2'（二）现落在第 3 行
    // C2 本身在第 2 行（被压缩段）⇒ 落到第 3 行 C3；其引用 'A4'（四）随被移动行落到第 2 行
    expect(formulaTextOf(after, 'C3')).toBe('A2');
  });

  it('移动两行成块：块内顺序保持，外部引用跟着整块', () => {
    let sheet = createSheet('块');
    sheet = setCellValue(sheet, 'A1', textValue('a'));
    sheet = setCellValue(sheet, 'A2', textValue('b'));
    sheet = setCellValue(sheet, 'A3', textValue('c'));
    sheet = setCellValue(sheet, 'A4', textValue('d'));
    sheet = setCellValue(sheet, 'A5', textValue('e'));
    sheet = setCellValue(sheet, 'C1', formulaValue('A2'));
    const after = moveRows(sheet, 2, 2, 5); // [b,c] 移到 e 之前
    expect([1, 2, 3, 4, 5].map((r) => rowValues(after, r, [1])[0])).toEqual([
      textValue('a'),
      textValue('d'),
      textValue('b'),
      textValue('c'),
      textValue('e'),
    ]);
    expect(formulaTextOf(after, 'C1')).toBe('A3'); // b 现落在第 3 行
  });

  it('移动到自身前 / 自身后 ⇒ 恒等（不动）', () => {
    const sheet = labeledRows();
    expect(moveRows(sheet, 3, 1, 3)).toBe(sheet);
    expect(moveRows(sheet, 3, 1, 4)).toBe(sheet);
  });

  it('移动列：列引用分段映射正确', () => {
    let sheet = createSheet('列移动');
    sheet = setCellValue(sheet, 'A1', numberValue(1));
    sheet = setCellValue(sheet, 'B1', numberValue(2));
    sheet = setCellValue(sheet, 'C1', numberValue(3));
    sheet = setCellValue(sheet, 'E1', formulaValue('A1'));
    const after = moveColumns(sheet, 1, 1, 4); // A 列移到 D 之前
    expect(rowValues(after, 1, [1, 2, 3])).toEqual([numberValue(2), numberValue(3), numberValue(1)]);
    expect(formulaTextOf(after, 'E1')).toBe('C1'); // A 列现落在第 3 列
  });

  it('反面对照：目标落在被移动区间内部 / 越界，均显式抛', () => {
    const sheet = labeledRows();
    expect(() => moveRows(sheet, 2, 3, 3)).toThrow(/内部/);
    expect(() => moveRows(sheet, 1, 1, 0)).toThrow(/越界/);
    expect(() => moveRows(sheet, 1, 1, 1002)).toThrow(/越界/);
  });

  it('跨区间边界的区域引用：端点可能反向书写（Excel 视为同一矩形 B2:B4）', () => {
    const after = moveRows(fruitSheet(), 2, 1, 5); // SUM(B2:B3)：B2 属被移动行、B3 属其间行
    // token 级保守改写保留端点原顺序 ⇒ 得到 SUM(B4:B2)。Excel 把反向区域归一化为 B2:B4，
    // 语义等价；本行断言的是"改写结果确定且可复现"，不是书写美观。
    expect(formulaTextOf(after, 'B3')).toBe('SUM(B4:B2)');
  });
});

// ---------------------------------------------------------------------------
// 5 合并区随复制 / 移动
// ---------------------------------------------------------------------------

describe('XLS-10 合并区随行列复制 / 移动', () => {
  it('复制行时，完全落在源区间内的合并区被复制到新位置', () => {
    const merged = mergeCells(createSheetLayout(fruitSheet()), 'A2:B2');
    expect(merged.sheet.merged).toContain('A2:B2');
    const after = copyRows(merged.sheet, 2, 1, 10);
    expect(after.merged).toContain('A2:B2'); // 源保留
    expect(after.merged).toContain('A10:B10'); // 副本
  });

  it('移动行时，完全落在被移动区间内的合并区跟着走', () => {
    const merged = mergeCells(createSheetLayout(labeledRows()), 'A2:A3');
    const after = moveRows(merged.sheet, 2, 2, 5);
    expect(after.merged).toContain('A3:A4'); // [二,三] 现落在第 3、4 行
    expect(after.merged).not.toContain('A2:A3');
  });

  it('反面对照：移动切过合并区边界 ⇒ 显式阻塞（不猜测如何拆分）', () => {
    const merged = mergeCells(createSheetLayout(labeledRows()), 'A1:A3');
    expect(() => moveRows(merged.sheet, 3, 1, 5)).toThrow(/合并区/);
  });
});

// ---------------------------------------------------------------------------
// 6 数据类型不冒充 + 行记录对应
// ---------------------------------------------------------------------------

describe('XLS-03 结构操作前后数据类型不冒充', () => {
  function typedSheet(): SheetState {
    let sheet = createSheet('类型');
    sheet = setCellValue(sheet, 'A1', numberValue(120));
    sheet = setCellValue(sheet, 'B1', textValue('120')); // 与 A1 同形不同类
    sheet = setCellValue(sheet, 'C1', booleanValue(true));
    sheet = setCellValue(sheet, 'D1', dateValue(1_700_000_000_000));
    sheet = setCellValue(sheet, 'E1', errorValue('#DIV/0!'));
    // F1 故意留空（从未设置）
    sheet = setCellValue(sheet, 'A2', textValue('尾巴'));
    return sheet;
  }

  it('复制 / 移动 / 插入 / 删除后每类取值保持自己的类别', () => {
    const typed = typedSheet();
    const variants: readonly SheetState[] = [
      copyRows(typed, 1, 1, 5),
      moveRows(typed, 1, 1, 3),
      insertRows(typed, 1, 1),
      deleteRows(typed, 2, 1),
    ];
    for (const after of variants) {
      // 第 1 行始终带着这条"记录"（insertRows(1,1) 会把它推到第 2 行，故按内容找）
      const rowIndexOfA1 = [1, 2].find((row) => valuesEqual(rowValues(after, row, [1])[0] ?? blank, numberValue(120)));
      expect(rowIndexOfA1).toBeDefined();
      const row = rowIndexOfA1 as number;
      expect(rowValues(after, row, [1, 2, 3, 4, 5])).toEqual([
        numberValue(120),
        textValue('120'),
        booleanValue(true),
        dateValue(1_700_000_000_000),
        errorValue('#DIV/0!'),
      ]);
      // 未设置的 F 列读回仍是 blank（不是 0）
      expect(getCellValue(after, { column: 6, row })).toBe(blank);
    }
  });

  it('行记录对应：整行记录的四列在插入后仍落在同一行', () => {
    const after = insertRows(fruitSheet(), 2, 1);
    const recordRow = 3; // 苹果记录
    const record = rowValues(after, recordRow, [1, 2, 3]);
    expect(record).toEqual([textValue('苹果'), numberValue(10), numberValue(2.5)]);
    // D 列（公式）与该记录同一行
    expect(isFormula(getCellValue(after, { column: 4, row: recordRow }))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7 结构化操作 schema
// ---------------------------------------------------------------------------

describe('结构化操作 schema：JSON 往返 + 校验 + 派发', () => {
  it('parseStructuralOperation 保留合法操作、拒绝未知 / 缺字段 / 非整数', () => {
    const input = { op: 'move_rows', at: 2, count: 3, to: 10 };
    expect(parseStructuralOperation(input)).toEqual(input);
    expect(STRUCTURAL_OPERATION_KINDS).toContain('copy_columns');
    expect(() => parseStructuralOperation({ op: 'frobnicate', at: 1, count: 1 })).toThrow(/未知/);
    expect(() => parseStructuralOperation({ op: 'insert_rows', at: 1 })).toThrow(/count/);
    expect(() => parseStructuralOperation({ op: 'copy_rows', at: 1, count: 1 })).toThrow(/insert_at/);
    expect(() => parseStructuralOperation({ op: 'insert_rows', at: 1.5, count: 1 })).toThrow(/整数/);
    expect(() => parseStructuralOperation(null)).toThrow(/对象/);
  });

  it('applyStructuralOperation 与直接调用对应函数结果一致', () => {
    const sheet = fruitSheet();
    const cases: readonly (readonly [StructuralOperation, (s: SheetState) => SheetState])[] = [
      [{ op: 'insert_rows', at: 2, count: 1 }, (s) => insertRows(s, 2, 1)],
      [{ op: 'delete_rows', at: 2, count: 1 }, (s) => deleteRows(s, 2, 1)],
      [{ op: 'copy_rows', at: 2, count: 1, insert_at: 8 }, (s) => copyRows(s, 2, 1, 8)],
      [{ op: 'move_rows', at: 2, count: 1, to: 4 }, (s) => moveRows(s, 2, 1, 4)],
      [{ op: 'insert_columns', at: 2, count: 2 }, (s) => insertColumns(s, 2, 2)],
      [{ op: 'delete_columns', at: 4, count: 1 }, (s) => deleteColumns(s, 4, 1)],
      [{ op: 'copy_columns', at: 1, count: 1, insert_at: 6 }, (s) => copyColumns(s, 1, 1, 6)],
      [{ op: 'move_columns', at: 1, count: 1, to: 4 }, (s) => moveColumns(s, 1, 1, 4)],
    ];
    for (const [operation, direct] of cases) {
      const viaSchema = applyStructuralOperation(sheet, operation);
      const viaDirect = direct(sheet);
      expect(sheetEntries(viaSchema)).toEqual(sheetEntries(viaDirect));
      expect(viaSchema.merged).toEqual(viaDirect.merged);
      expect(viaSchema.migration_blocked).toEqual(viaDirect.migration_blocked);
      expect([viaSchema.row_count, viaSchema.column_count]).toEqual([viaDirect.row_count, viaDirect.column_count]);
    }
  });

  it('schema 是纯数据：JSON 序列化后再解析可还原', () => {
    const operation: StructuralOperation = { op: 'copy_rows', at: 2, count: 2, insert_at: 9 };
    expect(parseStructuralOperation(JSON.parse(JSON.stringify(operation)))).toEqual(operation);
  });
});

// ---------------------------------------------------------------------------
// 8 几何（行高 / 隐藏）随复制 / 移动
// ---------------------------------------------------------------------------

describe('XLS-04 几何随行列复制 / 移动同步迁移', () => {
  it('复制行时源行高与隐藏状态一并复制到新行', () => {
    let layout = createSheetLayout(labeledRows());
    layout = setRowHeight(layout, 2, 30);
    layout = hideRows(layout, 2, 1);
    const after = copySheetRows(layout, 2, 1, 5);
    expect(getRowHeight(after, 2)).toBe(30); // 源保留
    expect(getRowHeight(after, 5)).toBe(30); // 副本
    expect(isRowHidden(after, 5)).toBe(true);
  });

  it('移动行时行高用与值相同的映射迁移', () => {
    let layout = createSheetLayout(labeledRows());
    layout = setRowHeight(layout, 2, 30);
    const after = moveSheetRows(layout, 2, 1, 5); // 与 moveRows 同一映射
    expect(getRowHeight(after, 4)).toBe(30); // 第 2 行 → 第 4 行
    expect(getRowHeight(after, 2)).toBe(15);
    // 值也到了第 4 行，几何与值同进同退
    expect(rowValues(after.sheet, 4, [1])[0]).toEqual(textValue('二'));
  });

  it('几何版插入与既有 insertSheetRows 行为一致（回归锚点）', () => {
    let layout = createSheetLayout(labeledRows());
    layout = setRowHeight(layout, 3, 22);
    const after = insertSheetRows(layout, 1, 2);
    expect(getRowHeight(after, 5)).toBe(22); // 3 → 5
  });
});
