/**
 * `evaluate.ts` 的单元测试（design-06-P8 / XLS-08）。
 *
 * 两类用例同等重要：
 * - **正例**：白名单内、语义确定的东西必须算得**准**（含 Excel 的怪癖：`-2^2 = 4`）；
 * - **反例**：白名单外 / 缺失 / 类型不符的东西必须**阻塞**，且**不得返回任何像结果的东西**。
 *
 * 反例是这份用例的主体，因为 XLS-08 的硬约束是"**不得返回伪造结果**"——
 * 一个"看起来对"的返回值，比一次显式阻塞危险得多。
 */

import { describe, expect, it } from 'vitest';

import {
  SUPPORTED_FUNCTIONS,
  evaluateFormula,
  evaluateWorkbookCell,
  type CellResolution,
  type EvalOutcome,
  type FormulaContext,
} from './evaluate.js';
import { columnNumberToLetters } from './reference.js';
import { createSheet, setCellValue } from './sheet.js';
import { createWorkbook } from './workbook.js';
import {
  blank,
  booleanValue,
  dateValue,
  errorValue,
  formulaValue,
  numberValue,
  textValue,
  type CellValue,
} from './value.js';

/** 用一张 { "A1": 取值 } 的字典搭一个求值上下文（引用直接查表）。 */
function makeContext(
  sheets: Record<string, Record<string, CellValue>>,
  current = 'Sheet1',
): FormulaContext {
  return {
    current_sheet: current,
    hasSheet: (name) => Object.prototype.hasOwnProperty.call(sheets, name),
    resolveCell: (sheet, address): CellResolution => {
      const name = sheet ?? current;
      const grid = sheets[name];
      if (grid === undefined) {
        return { kind: 'blocked', reason: 'unknown_sheet', detail: `no sheet ${name}` };
      }
      const ref = `${columnNumberToLetters(address.column)}${String(address.row)}`;
      const value = grid[ref];
      return { kind: 'value', value: value === undefined ? blank : value };
    },
  };
}

/** 求值并断言成功，返回取值本身。 */
function ok(text: string, context: FormulaContext): CellValue {
  const outcome = evaluateFormula(text, context);
  expect(outcome.ok, `期望 ${text} 求值成功，实际阻塞：${outcome.ok ? '' : `${outcome.reason} ${outcome.detail}`}`).toBe(true);
  if (!outcome.ok) throw new Error('unreachable');
  return outcome.value;
}

/** 求值并断言阻塞，返回阻塞原因。 */
function blocked(text: string, context: FormulaContext): string {
  const outcome = evaluateFormula(text, context);
  expect(outcome.ok, `期望 ${text} 被阻塞，实际算出了 ${JSON.stringify(outcome.ok ? outcome.value : '')}`).toBe(false);
  if (outcome.ok) throw new Error('unreachable');
  return outcome.reason;
}

const EMPTY = makeContext({ Sheet1: {} });

describe('evaluate：四则与优先级', () => {
  it('加减乘除', () => {
    expect(ok('1+2', EMPTY)).toEqual(numberValue(3));
    expect(ok('10-4', EMPTY)).toEqual(numberValue(6));
    expect(ok('3*4', EMPTY)).toEqual(numberValue(12));
    expect(ok('10/4', EMPTY)).toEqual(numberValue(2.5));
  });

  it('乘除优先于加减，括号最高', () => {
    expect(ok('2+3*4', EMPTY)).toEqual(numberValue(14));
    expect(ok('(2+3)*4', EMPTY)).toEqual(numberValue(20));
    expect(ok('2*(3+4)-5', EMPTY)).toEqual(numberValue(9));
  });

  it('幂是右结合：2^3^2 = 2^(3^2) = 512', () => {
    expect(ok('2^3^2', EMPTY)).toEqual(numberValue(512));
  });

  it('复刻 Excel 的一元负号怪癖：-2^2 = (-2)^2 = 4（与数学惯例相反）', () => {
    expect(ok('-2^2', EMPTY)).toEqual(numberValue(4));
    expect(ok('2^-1', EMPTY)).toEqual(numberValue(0.5));
  });

  it('除以零给出**确定的** Excel 错误值 #DIV/0!（不是伪造的 0 或 NaN）', () => {
    expect(ok('1/0', EMPTY)).toEqual(errorValue('#DIV/0!'));
  });

  it('负数开偶次根 → #NUM!', () => {
    expect(ok('SQRT(-1)', EMPTY)).toEqual(errorValue('#NUM!'));
  });
});

describe('evaluate：文本、布尔、比较', () => {
  it('& 连接：数字按最短十进制转文本', () => {
    expect(ok('"a"&"b"', EMPTY)).toEqual(textValue('ab'));
    expect(ok('"合计："&1950.5', EMPTY)).toEqual(textValue('合计：1950.5'));
    expect(ok('TRUE&""', EMPTY)).toEqual(textValue('TRUE'));
  });

  it('比较返回布尔；文本比较大小写不敏感（Excel 口径）', () => {
    expect(ok('1<2', EMPTY)).toEqual(booleanValue(true));
    expect(ok('2<=2', EMPTY)).toEqual(booleanValue(true));
    expect(ok('3<>3', EMPTY)).toEqual(booleanValue(false));
    expect(ok('"a"="A"', EMPTY)).toEqual(booleanValue(true));
  });
});

describe('evaluate：引用与区域', () => {
  const context = makeContext({
    Sheet1: { A1: numberValue(5), A2: numberValue(7), A3: textValue('不是数'), B1: numberValue(2) },
    Sheet2: { A1: numberValue(100) },
  });

  it('相对引用与绝对引用等价（$ 只影响**填充**，不影响求值）', () => {
    expect(ok('A1+1', context)).toEqual(numberValue(6));
    expect(ok('$A$1+1', context)).toEqual(numberValue(6));
    expect(ok('$A1+A$1', context)).toEqual(numberValue(10));
  });

  it('跨表引用 Sheet2!A1', () => {
    expect(ok('Sheet2!A1*2', context)).toEqual(numberValue(200));
  });

  it('区域求和跳过文本与空白，但**不把它们当作 0**', () => {
    // A1=5, A2=7, A3=文本 ⇒ 只累加两个数
    expect(ok('SUM(A1:A3)', context)).toEqual(numberValue(12));
    // 空白格不贡献、也不计入分母：AVERAGE 只除 2
    expect(ok('AVERAGE(A1:A2)', context)).toEqual(numberValue(6));
  });

  it('把空白格算进分母才是错的：AVERAGE 覆盖到空白格时结果不变', () => {
    const withBlank = makeContext({ Sheet1: { A1: numberValue(4), A2: numberValue(8) } });
    expect(ok('AVERAGE(A1:A5)', withBlank)).toEqual(numberValue(6));
  });
});

describe('evaluate：白名单函数', () => {
  const context = makeContext({
    Sheet1: {
      A1: numberValue(1),
      A2: numberValue(2),
      A3: numberValue(3),
      B1: numberValue(-5),
      C1: numberValue(2.675),
      D1: textValue('标签'),
    },
  });

  it('白名单本身是可枚举的（供文档与诊断）', () => {
    expect([...SUPPORTED_FUNCTIONS].sort()).toEqual(
      ['ABS', 'AND', 'AVERAGE', 'COUNTA', 'COUNT', 'IF', 'MAX', 'MIN', 'NOT', 'OR', 'ROUND', 'SQRT', 'SUM'].sort(),
    );
  });

  it('SUM / MIN / MAX', () => {
    expect(ok('SUM(A1:A3)', context)).toEqual(numberValue(6));
    expect(ok('MIN(A1:A3, B1)', context)).toEqual(numberValue(-5));
    expect(ok('MAX(A1:A3, B1)', context)).toEqual(numberValue(3));
  });

  it('COUNT 只数数值；COUNTA 数非空', () => {
    expect(ok('COUNT(A1:D1)', context)).toEqual(numberValue(3)); // D1 是文本，COUNT 不数它
    expect(ok('COUNTA(A1:D1)', context)).toEqual(numberValue(4)); // A1..D1 全部有值
    expect(ok('COUNTA(A1:E1)', context)).toEqual(numberValue(4)); // E1 空白
  });

  it('COUNT 在空区域上是 0——**计数**不是"缺失的值"，这是唯一允许返回 0 的聚合', () => {
    expect(ok('COUNT(A1:A3)', makeContext({ Sheet1: {} }))).toEqual(numberValue(0));
  });

  it('IF 惰性求值：没被选中的分支不求值', () => {
    const partial = makeContext({ Sheet1: { A1: numberValue(1) } });
    // 假分支里的函数不在白名单，但它**不会**被求值
    expect(ok('IF(A1>0, "正", NOSUCHFUNCTION(1))', partial)).toEqual(textValue('正'));
    expect(ok('IF(FALSE, NOSUCHFUNCTION(1), "负")', partial)).toEqual(textValue('负'));
  });

  it('IF 省略 else 且条件为假 ⇒ FALSE（Excel 语义）', () => {
    expect(ok('IF(FALSE, 1)', EMPTY)).toEqual(booleanValue(false));
  });

  it('AND / OR / NOT', () => {
    expect(ok('AND(TRUE, 1)', EMPTY)).toEqual(booleanValue(true));
    expect(ok('OR(FALSE, 0)', EMPTY)).toEqual(booleanValue(false));
    expect(ok('NOT(TRUE)', EMPTY)).toEqual(booleanValue(false));
  });

  it('ABS / SQRT / ROUND', () => {
    expect(ok('ABS(-5)', EMPTY)).toEqual(numberValue(5));
    expect(ok('SQRT(9)', EMPTY)).toEqual(numberValue(3));
    // ROUND 走 W-A 的 BigInt 定点格式化：2.675 按字面十进制进到 2.68（不经浮点误差）
    expect(ok('ROUND(2.675, 2)', EMPTY)).toEqual(numberValue(2.68));
    expect(ok('ROUND(1234.5, 0)', EMPTY)).toEqual(numberValue(1235));
  });
});

describe('evaluate：**阻塞**（XLS-08「不得返回伪造结果」）', () => {
  it('空白格参与**标量**运算 ⇒ 阻塞，绝不当作 0（R248）', () => {
    const context = makeContext({ Sheet1: {} });
    expect(blocked('A1+1', context)).toBe('blank_operand');
    expect(blocked('A1>0', context)).toBe('blank_operand');
    expect(blocked('-A1', context)).toBe('blank_operand');
  });

  it('聚合的数值贡献为 0 ⇒ 阻塞，**不返回 0**（与 quantity.ts 的空求和口径一致）', () => {
    const context = makeContext({ Sheet1: { A1: textValue('甲') } });
    expect(blocked('SUM(A1:A3)', makeContext({ Sheet1: {} }))).toBe('empty_aggregate');
    expect(blocked('SUM(A1:A3)', context)).toBe('empty_aggregate');
    expect(blocked('AVERAGE(A1:A3)', makeContext({ Sheet1: {} }))).toBe('empty_aggregate');
  });

  it('白名单外的函数 ⇒ 阻塞（经典陷阱：LOG10 不合规地像"列 LOG + 行 10"）', () => {
    expect(blocked('LOG10(100)', EMPTY)).toBe('unsupported_function');
    expect(blocked('VLOOKUP(1,A1:B3,2,FALSE)', EMPTY)).toBe('unsupported_function');
    expect(blocked('TODAY()', EMPTY)).toBe('unsupported_function');
  });

  it('数字文本参与算术 ⇒ 阻塞（不隐式把文本当数）', () => {
    expect(blocked('"3"+1', EMPTY)).toBe('non_numeric_operand');
    expect(blocked('"3"*2', EMPTY)).toBe('non_numeric_operand');
  });

  it('日期值参与算术 / 聚合 ⇒ 阻塞（不做隐式 日期→序列号 转换）', () => {
    const context = makeContext({ Sheet1: { A1: dateValue(0) } });
    expect(blocked('A1+1', context)).toBe('non_numeric_operand');
    expect(blocked('SUM(A1:A2)', context)).toBe('non_numeric_operand');
  });

  it('混合类型比较 ⇒ 阻塞（本仓不给跨类型全序）', () => {
    expect(blocked('1<"a"', EMPTY)).toBe('incomparable_operands');
    expect(blocked('TRUE=1', EMPTY)).toBe('incomparable_operands');
  });

  it('引用不存在的工作表 ⇒ 阻塞', () => {
    expect(blocked('Nope!A1', EMPTY)).toBe('unknown_sheet');
    expect(blocked("'不存在表'!A1", EMPTY)).toBe('unknown_sheet');
  });

  it('含非 ASCII 的工作表名必须加单引号（Excel 口径，不加则连词法都过不去）', () => {
    const context = makeContext({ 预算表: { A1: numberValue(9) } }, '预算表');
    expect(ok("'预算表'!A1+1", context)).toEqual(numberValue(10));
    // 内嵌单引号写成两个单引号
    const quoted = makeContext({ "it's": { A1: numberValue(1) } }, "it's");
    expect(ok("'it''s'!A1", quoted)).toEqual(numberValue(1));
  });

  it('裸区域当标量 ⇒ 阻塞', () => {
    expect(blocked('A1:B2+1', EMPTY)).toBe('unsupported_construct');
  });

  it('语法超出子集（命名区域、尾部多余、未闭合）⇒ parse_error', () => {
    expect(blocked('MYNAME', EMPTY)).toBe('parse_error');
    expect(blocked('1+', EMPTY)).toBe('parse_error');
    expect(blocked('SUM(A1', EMPTY)).toBe('parse_error');
    expect(blocked('{1,2,3}', EMPTY)).toBe('parse_error');
  });

  it('错误值沿引用传播（不是"变成 0"）', () => {
    const context = makeContext({ Sheet1: { A1: errorValue('#DIV/0!'), A2: numberValue(1) } });
    expect(ok('A1', context)).toEqual(errorValue('#DIV/0!'));
    expect(ok('A1+A2', context)).toEqual(errorValue('#DIV/0!'));
  });

  it('空白单元格单独求值 ⇒ 阻塞（没有可求的值）', () => {
    const workbook = createWorkbook([createSheet('Sheet1')]);
    const outcome = evaluateWorkbookCell(workbook, 'Sheet1', { column: 1, row: 1 });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok ? '' : outcome.reason).toBe('blank_operand');
  });
});

describe('evaluate：工作簿级驱动（记忆化 + 环检测）', () => {
  function sheetWith(cells: Record<string, CellValue>) {
    let sheet = createSheet('Sheet1');
    for (const [ref, value] of Object.entries(cells)) {
      sheet = setCellValue(sheet, ref, value);
    }
    return sheet;
  }

  it('引用另一个公式格会递归求值', () => {
    const workbook = createWorkbook([
      sheetWith({ A1: numberValue(2), A2: formulaValue('A1*3'), A3: formulaValue('A2+1') }),
    ]);
    const outcome = evaluateWorkbookCell(workbook, 'Sheet1', { column: 1, row: 3 });
    expect(outcome).toEqual({ ok: true, value: numberValue(7) });
  });

  it('成环 ⇒ 相关落点全部 circular_reference 阻塞，**不返回部分结果**', () => {
    const workbook = createWorkbook([
      sheetWith({ A1: formulaValue('B1+1'), B1: formulaValue('A1+1') }),
    ]);
    const first = evaluateWorkbookCell(workbook, 'Sheet1', { column: 1, row: 1 });
    const second = evaluateWorkbookCell(workbook, 'Sheet1', { column: 2, row: 1 });
    expect(first.ok).toBe(false);
    expect(first.ok ? '' : first.reason).toBe('circular_reference');
    expect(second.ok ? '' : second.reason).toBe('circular_reference');
  });

  it('自引用也是环', () => {
    const workbook = createWorkbook([sheetWith({ A1: formulaValue('A1+1') })]);
    const outcome = evaluateWorkbookCell(workbook, 'Sheet1', { column: 1, row: 1 });
    expect(outcome.ok ? '' : outcome.reason).toBe('circular_reference');
  });

  it('跨表公式链', () => {
    let first = createSheet('Sheet1');
    first = setCellValue(first, 'A1', numberValue(10));
    let second = createSheet('Sheet2');
    second = setCellValue(second, 'B1', formulaValue('Sheet1!A1*2'));
    const workbook = createWorkbook([first, second]);
    const outcome: EvalOutcome = evaluateWorkbookCell(workbook, 'Sheet2', { column: 2, row: 1 });
    expect(outcome).toEqual({ ok: true, value: numberValue(20) });
  });

  it('非公式格求值直接给出其取值', () => {
    const workbook = createWorkbook([sheetWith({ A1: textValue('甲') })]);
    expect(evaluateWorkbookCell(workbook, 'Sheet1', { column: 1, row: 1 })).toEqual({
      ok: true,
      value: textValue('甲'),
    });
  });
});
