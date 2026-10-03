/**
 * `functions.ts` 的单元测试（design-06-P8 / XLS-07）。
 *
 * 三类用例：
 * 1. **复用对照**：纯核心公式上，`evaluateWithFunctions` 必须与 `evaluateFormula`
 *    **逐字段同结论**——这是"复用 evaluate.ts 而不是复制一份语义"的机器化证据；
 * 2. **正例**：每个扩展函数在其声明边界内必须算得准；
 * 3. **反向对照**：边界之外、以及"看起来像结果其实是伪造"的形态，必须被断言抓住
 *    （未知函数不返回 0、近似匹配不返回结果、循环/错误不变成数、IFERROR 不吞阻塞……）。
 */

import { describe, expect, it } from 'vitest';

import { SUPPORTED_FUNCTIONS, evaluateFormula } from './evaluate.js';
import {
  ALL_SUPPORTED_FUNCTIONS,
  EXTENDED_FUNCTION_SPECS,
  EXTENDED_FUNCTIONS,
  evaluateWithFunctions,
  functionSpec,
  isSupportedFunction,
  listUnknownFunctions,
  type SpreadsheetFormulaContext,
} from './functions.js';
import { columnNumberToLetters } from './reference.js';
import {
  booleanValue,
  errorValue,
  numberValue,
  textValue,
  type CellValue,
} from './value.js';

/** 用一张 `{ "A1": 取值 }` 的字典搭上下文（引用直接查表；未设置的格是**空白**）。 */
function makeContext(
  sheets: Record<string, Record<string, CellValue>>,
  current = 'Sheet1',
  todaySerial?: number,
): SpreadsheetFormulaContext {
  const base: SpreadsheetFormulaContext = {
    current_sheet: current,
    hasSheet: (name) => Object.prototype.hasOwnProperty.call(sheets, name),
    resolveCell: (sheet, address) => {
      const name = sheet ?? current;
      const grid = sheets[name];
      if (grid === undefined) {
        return { kind: 'blocked', reason: 'unknown_sheet', detail: `no sheet ${name}` };
      }
      const ref = `${columnNumberToLetters(address.column)}${String(address.row)}`;
      const value = grid[ref];
      return { kind: 'value', value: value ?? { kind: 'blank' } };
    },
  };
  return todaySerial === undefined ? base : { ...base, today_serial: todaySerial };
}

function ok(text: string, context: SpreadsheetFormulaContext): CellValue {
  const outcome = evaluateWithFunctions(text, context);
  expect(
    outcome.ok,
    `期望 ${text} 求值成功，实际阻塞：${outcome.ok ? '' : `${outcome.reason} ${outcome.detail}`}`,
  ).toBe(true);
  if (!outcome.ok) throw new Error('unreachable');
  return outcome.value;
}

function blocked(text: string, context: SpreadsheetFormulaContext): string {
  const outcome = evaluateWithFunctions(text, context);
  expect(
    outcome.ok,
    `期望 ${text} 被阻塞，实际算出了 ${JSON.stringify(outcome.ok ? outcome.value : '')}`,
  ).toBe(false);
  if (outcome.ok) throw new Error('unreachable');
  return outcome.reason;
}

const EMPTY = makeContext({ Sheet1: {} });

/** 主夹具：一列数、一列权重、一列水果名。 */
const GRID = makeContext({
  Sheet1: {
    A1: numberValue(1),
    A2: numberValue(2),
    A3: numberValue(3),
    A4: numberValue(4),
    A5: numberValue(5),
    B1: numberValue(10),
    B2: numberValue(20),
    B3: numberValue(30),
    B4: numberValue(40),
    B5: numberValue(50),
    C1: textValue('苹果'),
    C2: textValue('香蕉'),
    C3: textValue('苹果'),
    D1: numberValue(1),
    D2: numberValue(2),
    D3: numberValue(3),
  },
  Sheet2: { A1: numberValue(7), A2: numberValue(8), A3: numberValue(1) },
});

// ---------------------------------------------------------------------------
// 1. 复用对照：核心子集必须与 evaluate.ts 逐字段同结论
// ---------------------------------------------------------------------------

describe('functions：复用对照（核心子集不复制语义）', () => {
  const CORPUS: readonly string[] = [
    '1+2',
    '2+3*4',
    '(2+3)*4',
    '2^3^2',
    '-2^2',
    '1/0',
    '1/0+1',
    'SQRT(-1)',
    '"a"&"b"',
    '"合计："&1950.5',
    'TRUE&""',
    '1<2',
    '"a"="A"',
    'SUM(A1:A3)',
    'AVERAGE(A1:A2)',
    'MIN(A1:A3, B1)',
    'MAX(A1:A3, B1)',
    'COUNT(A1:D1)',
    'COUNTA(A1:E1)',
    'COUNT(A1:A3)',
    'IF(A1>0, "正", "负")',
    'IF(FALSE, NOSUCHFUNCTION(1), "负")',
    'IF(FALSE, 1)',
    'AND(TRUE, 1)',
    'OR(FALSE, 0)',
    'NOT(TRUE)',
    'ABS(-5)',
    'ROUND(2.675, 2)',
    'A1+1',
    '$A$1*2',
    'Sheet2!A1*2',
    'A1:B2+1',
    '"3"+1',
    '1<"a"',
    'A1',
    'SUM(A1:A3, B1)',
    'MYNAME',
    '1+',
    'SUM(A1',
    '{1,2,3}',
    'Nope!A1',
    'LOG10(100)',
  ];

  it('对同一批公式，两者逐字段同结论（含 ok / reason / detail / value）', () => {
    for (const text of CORPUS) {
      const mine = evaluateWithFunctions(text, GRID);
      const theirs = evaluateFormula(text, GRID);
      expect(mine, `公式 ${text} 的结论与 evaluate.ts 不一致`).toEqual(theirs);
    }
    // 对照：语料确实非空且确实覆盖了成功与阻塞两种结局。
    expect(CORPUS.length).toBeGreaterThan(30);
  });

  it('空白格求值：两条路径同样阻塞（R248 不被绕过）', () => {
    const blankContext = makeContext({ Sheet1: {} });
    expect(blocked('Z9', blankContext)).toBe('blank_operand');
    expect(evaluateFormula('Z9', blankContext)).toEqual(evaluateWithFunctions('Z9', blankContext));
  });

  it('保序括号化不改变语义：`-2^2` 仍是 4（Excel 怪癖被带过桥）', () => {
    expect(ok('-2^2', EMPTY)).toEqual(numberValue(4));
    expect(ok('2^3^2', EMPTY)).toEqual(numberValue(512));
    expect(ok('-(2^2)', EMPTY)).toEqual(numberValue(-4));
  });

  it('跨表引用（含引号表名）打印回文本后语义不变', () => {
    const quoted = makeContext({ "it's": { A1: numberValue(1), A2: numberValue(2) } }, "it's");
    expect(ok("'it''s'!A1", quoted)).toEqual(numberValue(1));
    expect(ok("'it''s'!A1+1", quoted)).toEqual(numberValue(2));
    expect(evaluateWithFunctions("'it''s'!A1+1", quoted)).toEqual(evaluateFormula("'it''s'!A1+1", quoted));
    // 含扩展函数的表达式里，跨表区域也必须正确带过桥。
    expect(ok("SUMIF('it''s'!A1:A2, \">0\")", quoted)).toEqual(numberValue(3));
    expect(ok("SUM('it''s'!A1:A2) & \"\"", quoted)).toEqual(textValue('3'));
  });
});

// ---------------------------------------------------------------------------
// 2. 清单与边界声明
// ---------------------------------------------------------------------------

describe('functions：清单与边界声明', () => {
  it('扩展清单与核心白名单**不重叠**，并集排序后可枚举', () => {
    const overlap = EXTENDED_FUNCTIONS.filter((name) => SUPPORTED_FUNCTIONS.includes(name));
    expect(overlap).toEqual([]);
    expect([...ALL_SUPPORTED_FUNCTIONS]).toEqual(
      [...new Set([...SUPPORTED_FUNCTIONS, ...EXTENDED_FUNCTIONS])].sort(),
    );
    expect(ALL_SUPPORTED_FUNCTIONS.length).toBe(SUPPORTED_FUNCTIONS.length + EXTENDED_FUNCTIONS.length);
  });

  it('每个扩展函数都有"支持什么 / 不支持什么"两句话（XLS-07「明确边界」）', () => {
    expect(EXTENDED_FUNCTION_SPECS.length).toBe(EXTENDED_FUNCTIONS.length);
    for (const spec of EXTENDED_FUNCTION_SPECS) {
      expect(spec.support.length, `${spec.name} 缺少 support`).toBeGreaterThan(4);
      expect(spec.boundary.length, `${spec.name} 缺少 boundary`).toBeGreaterThan(4);
      expect(spec.min_args).toBeLessThanOrEqual(spec.max_args);
      expect(functionSpec(spec.name.toLowerCase())).toEqual(spec);
      expect(isSupportedFunction(spec.name)).toBe(true);
    }
    expect(isSupportedFunction('VLOOKUP')).toBe(true);
    expect(isSupportedFunction('HYPERFORMULA_ONLY')).toBe(false);
  });

  it('listUnknownFunctions：不认识的函数列出来，读不懂的公式返回 null', () => {
    expect(listUnknownFunctions('SUM(A1)+NOSUCH(1)+ALSOBAD(2)')).toEqual(['NOSUCH', 'ALSOBAD']);
    expect(listUnknownFunctions('SUMIF(A1:A3, ">1", B1:B3)')).toEqual([]);
    expect(listUnknownFunctions('1+')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. IFERROR
// ---------------------------------------------------------------------------

describe('functions：IFERROR', () => {
  it('错误值被兜住', () => {
    expect(ok('IFERROR(1/0, "兜底")', EMPTY)).toEqual(textValue('兜底'));
    expect(ok('IFERROR(INDEX(A1:A3, 9), 0)', GRID)).toEqual(numberValue(0));
    expect(ok('IFERROR(VLOOKUP("z", A1:B3, 2, FALSE), "无")', GRID)).toEqual(textValue('无'));
  });

  it('没有错误时原样返回，且**惰性**（fallback 不求值）', () => {
    expect(ok('IFERROR(A1+A2, NOSUCHFUNCTION(1))', GRID)).toEqual(numberValue(3));
  });

  it('**不吞阻塞**：本仓不支持的公式不会因为被 IFERROR 包住就变成 fallback', () => {
    // 反向对照：若实现"吞阻塞"，这条会算出 0 —— 那正是伪造。
    const outcome = evaluateWithFunctions('IFERROR(NOSUCHFUNCTION(1), 0)', EMPTY);
    expect(outcome.ok).toBe(false);
    expect(outcome).not.toEqual({ ok: true, value: numberValue(0) });
    expect(blocked('IFERROR(NOSUCHFUNCTION(1), 0)', EMPTY)).toBe('unsupported_function');
    expect(blocked('IFERROR(A1, "x")', makeContext({ Sheet1: {} }))).toBe('blank_operand');
  });
});

// ---------------------------------------------------------------------------
// 4. 条件聚合
// ---------------------------------------------------------------------------

describe('functions：SUMIF / SUMIFS / COUNTIF / COUNTIFS', () => {
  it('SUMIF：按条件筛选后求和（缺省求和区即自身）', () => {
    expect(ok('SUMIF(A1:A5, ">3")', GRID)).toEqual(numberValue(9));
    expect(ok('SUMIF(A1:A5, ">=3")', GRID)).toEqual(numberValue(12));
    expect(ok('SUMIF(A1:A5, "<3")', GRID)).toEqual(numberValue(3));
    expect(ok('SUMIF(A1:A5, 3)', GRID)).toEqual(numberValue(3));
    expect(ok('SUMIF(A1:A5, ">3", B1:B5)', GRID)).toEqual(numberValue(90));
    expect(ok('SUMIF(C1:C3, "苹果", D1:D3)', GRID)).toEqual(numberValue(4));
    expect(ok('SUMIF(C1:C3, "*果", D1:D3)', GRID)).toEqual(numberValue(4));
    expect(ok('SUMIF(C1:C3, "<>苹果", D1:D3)', GRID)).toEqual(numberValue(2));
    expect(ok('SUMIF(Sheet2!A1:A3, ">5")', GRID)).toEqual(numberValue(15));
  });

  it('SUMIFS：多条件 AND', () => {
    expect(ok('SUMIFS(B1:B5, A1:A5, ">2", A1:A5, "<5")', GRID)).toEqual(numberValue(70));
    expect(ok('SUMIFS(B1:B5, A1:A5, ">2", B1:B5, "<40")', GRID)).toEqual(numberValue(30));
  });

  it('COUNTIF / COUNTIFS：0 个匹配是合法计数（不是"缺失的值"）', () => {
    expect(ok('COUNTIF(A1:A5, ">3")', GRID)).toEqual(numberValue(2));
    expect(ok('COUNTIF(A1:A5, ">99")', GRID)).toEqual(numberValue(0));
    expect(ok('COUNTIF(C1:C3, "苹果")', GRID)).toEqual(numberValue(2));
    expect(ok('COUNTIF(C1:C3, "苹?")', GRID)).toEqual(numberValue(2));
    expect(ok('COUNTIF(C1:C3, "~*")', GRID)).toEqual(numberValue(0));
    expect(ok('COUNTIFS(A1:A5, ">1", B1:B5, "<50")', GRID)).toEqual(numberValue(3));
    expect(ok('COUNTIFS(A1:A5, ">1", B1:B5, ">99")', GRID)).toEqual(numberValue(0));
  });

  it('空白条件：`""` / `"="` 数空白格，`"<>"` 数非空白格', () => {
    expect(ok('COUNTIF(A1:E1, "=")', GRID)).toEqual(numberValue(1)); // E1 未设置 ⇒ 空白
    expect(ok('COUNTIF(A1:E1, "<>")', GRID)).toEqual(numberValue(4));
    expect(ok('COUNTIF(A1:C1, "<>")', GRID)).toEqual(numberValue(3));
  });

  it('**无匹配 ⇒ 阻塞**（有意偏离 Excel 的 0，与 SUM 空聚合同口径）', () => {
    expect(blocked('SUMIF(A1:A5, ">99")', GRID)).toBe('empty_aggregate');
    expect(blocked('SUMIF(A1:A5, ">99", B1:B5)', GRID)).toBe('empty_aggregate');
    // 反向对照：绝不以 0 冒充"没有数值贡献"。
    expect(evaluateWithFunctions('SUMIF(A1:A5, ">99")', GRID)).not.toEqual({
      ok: true,
      value: numberValue(0),
    });
  });

  it('尺寸不符 / 实参个数不对 / 比较符后缺操作数 ⇒ invalid_arguments', () => {
    expect(blocked('SUMIF(A1:A5, ">1", B1:B3)', GRID)).toBe('invalid_arguments');
    expect(blocked('SUMIFS(B1:B5, A1:A5, ">1", B1:B5)', GRID)).toBe('invalid_arguments'); // 4 实参（偶数）
    expect(blocked('COUNTIFS(A1:A5, ">1", B1:B5)', GRID)).toBe('invalid_arguments'); // 3 实参（奇数）
    expect(blocked('SUMIF(A1:A5)', GRID)).toBe('invalid_arguments');
    expect(blocked('SUMIF(A1:A5, ">")', GRID)).toBe('invalid_arguments');
    expect(blocked('SUMIF(1, ">0")', GRID)).toBe('invalid_arguments');
    // 对照：3 个实参的 SUMIFS 是**合法**的（一条条件），不该被误伤。
    expect(ok('SUMIFS(B1:B5, A1:A5, ">1")', GRID)).toEqual(numberValue(140));
  });

  it('求和区里的错误值传播；计数区里的错误值被跳过（有意选择，已登记）', () => {
    const context = makeContext({
      Sheet1: {
        A1: numberValue(1),
        A2: errorValue('#DIV/0!'),
        A3: numberValue(3),
        B1: numberValue(10),
        B2: numberValue(20),
        B3: numberValue(30),
      },
    });
    // 求和区出错 ⇒ 传播错误值（不是阻塞、更不是跳过）。
    expect(ok('SUMIF(B1:B3, ">0", A1:A3)', context)).toEqual(errorValue('#DIV/0!'));
    // 计数区出错 ⇒ 跳过（不制造错误、也不计数）。
    expect(ok('COUNTIF(A1:A3, ">0")', context)).toEqual(numberValue(2));
    expect(ok('COUNTIFS(A1:A3, ">0", B1:B3, ">0")', context)).toEqual(numberValue(2));
  });
});

// ---------------------------------------------------------------------------
// 5. 查找
// ---------------------------------------------------------------------------

describe('functions：VLOOKUP / INDEX / MATCH', () => {
  const TABLE = makeContext({
    Sheet1: {
      D1: textValue('a'),
      E1: numberValue(1),
      D2: textValue('b'),
      E2: numberValue(2),
      D3: textValue('c'),
      E3: numberValue(3),
      A1: numberValue(1),
      A2: numberValue(2),
      B1: numberValue(10),
      B2: numberValue(20),
      C1: textValue('苹果'),
      C2: textValue('香蕉'),
    },
  });

  it('VLOOKUP：精确匹配（FALSE / 0 两种写法）', () => {
    expect(ok('VLOOKUP("b", D1:E3, 2, FALSE)', TABLE)).toEqual(numberValue(2));
    expect(ok('VLOOKUP("B", D1:E3, 2, 0)', TABLE)).toEqual(numberValue(2)); // 大小写不敏感
    expect(ok('VLOOKUP("b*", D1:E3, 1, FALSE)', TABLE)).toEqual(textValue('b')); // 通配
    expect(ok('VLOOKUP("b", D1:E3, 1, FALSE)', TABLE)).toEqual(textValue('b'));
  });

  it('VLOOKUP：未找到 ⇒ #N/A；列号越界 ⇒ #REF!；列号 <1 ⇒ #VALUE!', () => {
    expect(ok('VLOOKUP("z", D1:E3, 2, FALSE)', TABLE)).toEqual(errorValue('#N/A'));
    expect(ok('VLOOKUP("b", D1:E3, 3, FALSE)', TABLE)).toEqual(errorValue('#REF!'));
    expect(ok('VLOOKUP("b", D1:E3, 0, FALSE)', TABLE)).toEqual(errorValue('#VALUE!'));
  });

  it('**近似匹配不实现、也不降级**（缺省或 TRUE 都阻塞）', () => {
    // 反向对照：若"缺省就当精确匹配"，这里会算出 2 —— 那是把"没要求精确"偷换成"要求精确"。
    expect(blocked('VLOOKUP("b", D1:E3, 2)', TABLE)).toBe('unsupported_construct');
    expect(blocked('VLOOKUP("b", D1:E3, 2, TRUE)', TABLE)).toBe('unsupported_construct');
    expect(evaluateWithFunctions('VLOOKUP("b", D1:E3, 2)', TABLE)).not.toEqual({
      ok: true,
      value: numberValue(2),
    });
  });

  it('VLOOKUP 命中空白格 ⇒ 阻塞（R248：缺失不当 0）', () => {
    const holed = makeContext({
      Sheet1: { D1: textValue('a'), E1: numberValue(1), D2: textValue('b'), D3: textValue('c'), E3: numberValue(3) },
    });
    expect(blocked('VLOOKUP("b", D1:E3, 2, FALSE)', holed)).toBe('blank_operand');
    expect(evaluateWithFunctions('VLOOKUP("b", D1:E3, 2, FALSE)', holed)).not.toEqual({
      ok: true,
      value: numberValue(0),
    });
  });

  it('INDEX：单列 / 单行 / 二维', () => {
    expect(ok('INDEX(B1:B2, 2)', TABLE)).toEqual(numberValue(20));
    expect(ok('INDEX(B1:C1, 2)', TABLE)).toEqual(textValue('苹果'));
    expect(ok('INDEX(A1:B2, 2, 1)', TABLE)).toEqual(numberValue(2));
    expect(ok('INDEX(A1:B2, 2, 2)', TABLE)).toEqual(numberValue(20));
    expect(ok('INDEX(A1:B2, 9, 1)', TABLE)).toEqual(errorValue('#REF!'));
    expect(ok('INDEX(A1:B2, 0, 1)', TABLE)).toEqual(errorValue('#VALUE!'));
    expect(blocked('INDEX(A1:B2, 2)', TABLE)).toBe('unsupported_construct'); // 二维缺列号
  });

  it('MATCH：只支持精确（match_type = 0）', () => {
    expect(ok('MATCH(3, A1:A5, 0)', GRID)).toEqual(numberValue(3));
    expect(ok('MATCH("香蕉", C1:C3, 0)', GRID)).toEqual(numberValue(2));
    expect(ok('MATCH("苹*", C1:C3, 0)', GRID)).toEqual(numberValue(1));
    expect(ok('MATCH(99, A1:A5, 0)', GRID)).toEqual(errorValue('#N/A'));
    expect(blocked('MATCH(3, A1:A5)', GRID)).toBe('unsupported_construct');
    expect(blocked('MATCH(3, A1:A5, 1)', GRID)).toBe('unsupported_construct');
    expect(blocked('MATCH(3, A1:A5, -1)', GRID)).toBe('unsupported_construct');
    expect(blocked('MATCH(3, A1:B2, 0)', GRID)).toBe('invalid_arguments'); // 二维
  });
});

// ---------------------------------------------------------------------------
// 6. 文本
// ---------------------------------------------------------------------------

describe('functions：文本函数', () => {
  it('LEFT / RIGHT / MID / LEN', () => {
    expect(ok('LEFT("abcdef", 3)', EMPTY)).toEqual(textValue('abc'));
    expect(ok('LEFT("abcdef")', EMPTY)).toEqual(textValue('a'));
    expect(ok('LEFT("abc", 99)', EMPTY)).toEqual(textValue('abc'));
    expect(ok('RIGHT("abcdef", 2)', EMPTY)).toEqual(textValue('ef'));
    expect(ok('MID("abcdef", 2, 3)', EMPTY)).toEqual(textValue('bcd'));
    expect(ok('MID("abcdef", 5, 99)', EMPTY)).toEqual(textValue('ef'));
    expect(ok('LEN("")', EMPTY)).toEqual(numberValue(0));
    expect(ok('LEN("abc")', EMPTY)).toEqual(numberValue(3));
    expect(ok('LEN(1234)', EMPTY)).toEqual(numberValue(4)); // 数字按 `&` 口径转文本
  });

  it('负个数 / 非法起点 ⇒ #VALUE!（不是 0 字、不是空串）', () => {
    expect(ok('LEFT("abc", -1)', EMPTY)).toEqual(errorValue('#VALUE!'));
    expect(ok('RIGHT("abc", -1)', EMPTY)).toEqual(errorValue('#VALUE!'));
    expect(ok('MID("abc", 0, 1)', EMPTY)).toEqual(errorValue('#VALUE!'));
    expect(ok('MID("abc", 1, -1)', EMPTY)).toEqual(errorValue('#VALUE!'));
  });

  it('按 Unicode 码点计数（代理对记 1）', () => {
    expect(ok('LEN("😀a")', EMPTY)).toEqual(numberValue(2));
    expect(ok('LEFT("😀a", 1)', EMPTY)).toEqual(textValue('😀'));
  });

  it('CONCAT：标量与区间都能连；空白阻塞（与 `&` 同口径）', () => {
    expect(ok('CONCAT("a", 1, TRUE)', EMPTY)).toEqual(textValue('a1TRUE'));
    expect(ok('CONCAT(A1:A3)', GRID)).toEqual(textValue('123'));
    expect(ok('CONCAT(A1:C1)', GRID)).toEqual(textValue('110苹果'));
    expect(blocked('CONCAT(A1:E1)', GRID)).toBe('blank_operand'); // E1 未设置 ⇒ 空白
  });

  it('TEXT：白名单数值格式', () => {
    expect(ok('TEXT(1234.5678, "0")', EMPTY)).toEqual(textValue('1235'));
    expect(ok('TEXT(1234.5678, "0.00")', EMPTY)).toEqual(textValue('1234.57'));
    expect(ok('TEXT(1234.5678, "#,##0.00")', EMPTY)).toEqual(textValue('1,234.57'));
    expect(ok('TEXT(1234567.891, "#,##0.00")', EMPTY)).toEqual(textValue('1,234,567.89'));
    expect(ok('TEXT(0.5, "0%")', EMPTY)).toEqual(textValue('50%'));
    expect(ok('TEXT(0.1234, "0.00%")', EMPTY)).toEqual(textValue('12.34%'));
    expect(ok('TEXT(-1234.5, "#,##0.00")', EMPTY)).toEqual(textValue('-1,234.50'));
  });

  it('**不在白名单的格式一律阻塞**（日期 / 多段 / 科学计数不近似）', () => {
    expect(blocked('TEXT(45366, "yyyy-mm-dd")', EMPTY)).toBe('invalid_arguments');
    expect(blocked('TEXT(1, "0.00;0.0")', EMPTY)).toBe('invalid_arguments');
    expect(blocked('TEXT(1, "0.0E+00")', EMPTY)).toBe('invalid_arguments');
    expect(blocked('TEXT(1, "@")', EMPTY)).toBe('invalid_arguments');
    expect(blocked('TEXT("abc", "0")', EMPTY)).toBe('non_numeric_operand');
    expect(evaluateWithFunctions('TEXT(45366, "yyyy-mm-dd")', EMPTY)).not.toEqual({
      ok: true,
      value: textValue('2024-03-15'),
    });
  });
});

// ---------------------------------------------------------------------------
// 7. 日期（锚在 excel-date.ts 的序列号语义上）
// ---------------------------------------------------------------------------

describe('functions：日期函数', () => {
  it('DATE 的序列号与已知 Excel 常量**逐点吻合**（交叉锚定 excel-date.ts）', () => {
    // 25569 = excel-date.ts 文档里写明的 1970-01-01；61 = 1900-03-01；2958465 = 9999-12-31。
    expect(ok('DATE(1970,1,1)', EMPTY)).toEqual(numberValue(25569));
    expect(ok('DATE(1900,3,1)', EMPTY)).toEqual(numberValue(61));
    expect(ok('DATE(9999,12,31)', EMPTY)).toEqual(numberValue(2958465));
    expect(ok('DATE(2024,1,1)', EMPTY)).toEqual(numberValue(45292));
    expect(ok('DATE(2024,3,15)', EMPTY)).toEqual(numberValue(45366));
    expect(ok('DATE(2000,2,29)', EMPTY)).toEqual(numberValue(36585));
  });

  it('年 0–1899 按 Excel 规则 +1900；月 / 日溢出滚动', () => {
    expect(ok('DATE(124,1,1)', EMPTY)).toEqual(ok('DATE(2024,1,1)', EMPTY));
    expect(ok('DATE(2024,13,1)', EMPTY)).toEqual(ok('DATE(2025,1,1)', EMPTY));
    expect(ok('DATE(2024,0,1)', EMPTY)).toEqual(ok('DATE(2023,12,1)', EMPTY));
    expect(ok('DATE(2023,2,29)', EMPTY)).toEqual(ok('DATE(2023,3,1)', EMPTY));
    expect(ok('DATE(2024,1,32)', EMPTY)).toEqual(ok('DATE(2024,2,1)', EMPTY));
  });

  it('YEAR / MONTH / DAY 从序列号还原（含小数序列号）', () => {
    expect(ok('YEAR(45366)', EMPTY)).toEqual(numberValue(2024));
    expect(ok('MONTH(45366)', EMPTY)).toEqual(numberValue(3));
    expect(ok('DAY(45366)', EMPTY)).toEqual(numberValue(15));
    expect(ok('YEAR(45366.75)', EMPTY)).toEqual(numberValue(2024));
    expect(ok('YEAR(25569)', EMPTY)).toEqual(numberValue(1970));
    expect(ok('MONTH(DATE(2000,2,29))', EMPTY)).toEqual(numberValue(2));
    expect(ok('DAY(DATE(2000,2,29))', EMPTY)).toEqual(numberValue(29));
    expect(ok('YEAR(DATE(2024,3,15))', EMPTY)).toEqual(numberValue(2024));
  });

  it('越界序列号 ⇒ #NUM!（不猜一个日期）', () => {
    expect(ok('YEAR(0)', EMPTY)).toEqual(errorValue('#NUM!'));
    expect(ok('YEAR(-5)', EMPTY)).toEqual(errorValue('#NUM!'));
    expect(ok('DAY(3000000)', EMPTY)).toEqual(errorValue('#NUM!'));
    expect(ok('DATE(10000,1,1)', EMPTY)).toEqual(errorValue('#NUM!'));
    expect(ok('DATE(-1,1,1)', EMPTY)).toEqual(errorValue('#NUM!'));
  });

  it('1900-03-01 之前阻塞（excel-date.ts 已文档化的差 1 天边界）', () => {
    expect(blocked('DATE(1900,1,1)', EMPTY)).toBe('unsupported_construct');
    expect(evaluateWithFunctions('DATE(1900,1,1)', EMPTY)).not.toEqual({
      ok: true,
      value: numberValue(1),
    });
    expect(ok('DATE(1900,3,1)', EMPTY)).toEqual(numberValue(61));
  });

  it('TODAY 只有**显式注入**才求值（本仓不读墙钟）', () => {
    // 反向对照：未注入时若返回"今天"，这条会失败——那正是伪造。
    expect(blocked('TODAY()', EMPTY)).toBe('unsupported_construct');
    expect(evaluateWithFunctions('TODAY()', EMPTY).ok).toBe(false);
    const injected = makeContext({ Sheet1: {} }, 'Sheet1', 45366);
    expect(ok('TODAY()', injected)).toEqual(numberValue(45366));
    expect(ok('TODAY()+1-1', injected)).toEqual(numberValue(45366));
    expect(ok('YEAR(TODAY())', injected)).toEqual(numberValue(2024));
  });

  it('日期函数只吃数值序列号：日期类型的格子阻塞（不做隐式日期→序列号）', () => {
    const withDate = makeContext({ Sheet1: { A1: { kind: 'date', epoch_ms: 0 } } });
    expect(blocked('YEAR(A1)', withDate)).toBe('non_numeric_operand');
  });
});

// ---------------------------------------------------------------------------
// 8. 桥（核心 ⊗ 扩展）与错误传播
// ---------------------------------------------------------------------------

describe('functions：核心与扩展混用（渲染桥）', () => {
  it('扩展函数可以嵌在核心函数里，运算符优先级不变', () => {
    expect(ok('SUM(SUMIF(A1:A5, ">3", B1:B5), 1)', GRID)).toEqual(numberValue(91));
    expect(ok('SUMIF(A1:A5, ">3", B1:B5) + SUM(A1:A5)', GRID)).toEqual(numberValue(105));
    expect(ok('SUMIF(A1:A5, ">3") * 2', GRID)).toEqual(numberValue(18));
    expect(ok('SUMIF(A1:A5, ">3", B1:B5) / 2', GRID)).toEqual(numberValue(45));
    expect(ok('IF(SUMIF(A1:A5, ">3") > 0, "有", "无")', GRID)).toEqual(textValue('有'));
    expect(ok('AND(SUMIF(A1:A5, ">3") > 0, TRUE)', GRID)).toEqual(booleanValue(true));
    expect(ok('CONCAT("合计", SUMIF(A1:A5, ">3"))', GRID)).toEqual(textValue('合计9'));
  });

  it('`IF` 保持惰性：未选中分支里的扩展调用**不求值**', () => {
    const table = makeContext({
      Sheet1: { D1: textValue('a'), E1: numberValue(1) },
    });
    // 未选中分支会算出 #N/A；惰性 ⇒ 结果必须是"安全"，不是 #N/A。
    expect(ok('IF(FALSE, VLOOKUP("z", D1:E1, 2, FALSE), "安全")', table)).toEqual(textValue('安全'));
    expect(ok('IF(1>2, SUMIF(D1:E1, ">99"), "兜底")', table)).toEqual(textValue('兜底'));
  });

  it('错误值穿过渲染桥**传播**（不是变成 0，也不是阻塞）', () => {
    expect(ok('INDEX(B1:B5, 9) + 1', GRID)).toEqual(errorValue('#REF!'));
    expect(ok('VLOOKUP("z", A1:B5, 2, FALSE) + 1', GRID)).toEqual(errorValue('#N/A'));
    expect(ok('SUMIF(A1:A5, ">3") / 0', GRID)).toEqual(errorValue('#DIV/0!'));
    expect(ok('INDEX(B1:B5, 9) & "x"', GRID)).toEqual(errorValue('#REF!'));
    expect(ok('SUM(INDEX(B1:B5, 9))', GRID)).toEqual(errorValue('#REF!'));
  });

  it('阻塞也穿过渲染桥传播（不静默丢弃）', () => {
    // 引用一张不存在的表：无论包在哪一层，结论都是 unknown_sheet。
    expect(blocked('SUMIF(Nope!A1:A3, ">0") + 1', GRID)).toBe('unknown_sheet');
    expect(blocked('IFERROR(Nope!A1, 0)', GRID)).toBe('unknown_sheet');
    expect(blocked('INDEX(B1:B5, 1) + Z9', GRID)).toBe('blank_operand');
  });

  it('空公式文本抛 ValidationError（与 evaluate.ts 同口径）', () => {
    expect(() => evaluateWithFunctions('', EMPTY)).toThrowError();
  });
});
