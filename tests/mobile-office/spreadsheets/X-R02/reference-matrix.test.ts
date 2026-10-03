/**
 * **X-R02**：公式/函数参考矩阵 —— 日期体系、舍入、错误值的**独立**交叉验证（Excel 线备用包）。
 *
 * 判据来源：Excel 语义 + 独立算法（见 `reference-oracle.ts`），**不是**内核返回值。
 * 五组，每组都带反面对照（"咬得住"的负例）：
 *
 * 1. **日期体系**：Hinnant 整数日历（独立）算出的 Excel 序列号 vs `excel-date.ts` 的
 *    毫秒算式；锚点表、带时刻、往返、以及**已文档化的 1900 闰年边界偏离**（< 1900-03-01 差 1，
 *    这是本仓明确登记的有意偏离，用例把它钉成"差 1"而不是假装一致）。
 * 2. **舍入**：`ROUND` 必须是 **half away from zero** 且按十进制字面量判定
 *    (`ROUND(2.675,2)=2.68`)，两条独立通道（手写真值表 + BigInt 算法）彼此印证，再与内核比。
 *    负例：负位数 / 超大位数必须**阻塞**，不得返回近似值。
 * 3. **错误值**：封闭枚举（7 个）集合相等、非法码拒绝、算式内传播。
 * 4. **函数参考矩阵**：覆盖 `ALL_SUPPORTED_FUNCTIONS`（集合相等，不遗漏/不多余）、
 *    扩展函数元数据与内核 `EXTENDED_FUNCTION_SPECS` 一致、逐行示例求值与独立期望比对。
 * 5. **差分对照**：纯核心公式上 `evaluateWithFunctions` 必须与 `evaluateFormula` 逐例同结论
 *    （扩展层不得悄悄改写核心语义）。
 *
 * 第二次增量（`reference-matrix-ext.ts`，§6–§9）：
 *
 * 6. **数组 / 动态数组 / SUMPRODUCT 区域语义**：本仓求值器**没有**任何数组函数，故把
 *    Excel 有、本仓缺席的名字**冻结**成清单，逐个断言内核 `unsupported_function` 阻塞，
 *    并用独立 `SUMPRODUCT` 语义把"Excel 应得的 140"与"内核阻塞"并排摆出；缺口可见。
 * 7. **日期显示格式（numFmt）**：独立 Hinnant 日历 + 手写真值表渲染日期显示文本，
 *    与样式层 `renderNumberDisplay` 逐例比对；原值与显示值分开；图案→numFmt id 独立登记。
 * 8. **区域聚合边界矩阵**：blank/error/boolean/text/date 落在 SUM/AVERAGE/MIN/MAX/COUNT/COUNTA
 *    的分子与分母上逐类登记（手工表 == 独立算法 == 内核，三通道）。
 * 9. **有意偏离 Excel 的口径**：把本仓 R248 与 Excel 不同的几处**如实登记**并断言偏离确实存在。
 */

import { describe, expect, it } from 'vitest';

import { ValidationError } from '../../../../src/protocol/index.js';
import {
  SUPPORTED_FUNCTIONS,
  evaluateFormula,
  type CellResolution,
  type EvalOutcome,
  type FormulaContext,
} from '../../../../src/spreadsheets/evaluate.js';
import {
  ALL_SUPPORTED_FUNCTIONS,
  EXTENDED_FUNCTION_SPECS,
  evaluateWithFunctions,
  type SpreadsheetFormulaContext,
} from '../../../../src/spreadsheets/functions.js';
import { columnNumberToLetters } from '../../../../src/spreadsheets/reference.js';
import {
  fromExcelSerial,
  isBuiltinDateFormatId,
  toExcelSerial,
} from '../../../../src/spreadsheets/excel-date.js';
import {
  BUILTIN_NUMFMT_CODES,
  FIRST_CUSTOM_NUMFMT_ID,
  describeNumberFormat,
  renderNumberDisplay,
} from '../../../../src/spreadsheets/style-parts/index.js';
import {
  MODERN_EXCEL_ERROR_CODES,
  SPREADSHEET_ERROR_CODES,
  blank,
  booleanValue,
  dateValue,
  errorValue,
  numberValue,
  textValue,
  type CellValue,
} from '../../../../src/spreadsheets/value.js';
import {
  ABSENT_ARRAY_FUNCTIONS,
  DATE_DISPLAY_TRUTH,
  DATE_PATTERN_NUMFMT_TRUTH,
  EXCEL_DIVERGENCE_CASES,
  RANGE_AGGREGATE_MATRIX,
  SUMPRODUCT_TRUTH,
  aggregateOracleR248,
  renderDateDisplayIndependent,
  sumProductElementwise,
  type AggName,
  type AggOracleOutcome,
  type AggSpec,
} from './reference-matrix-ext.js';
import {
  DATE_ANCHORS,
  EXCEL_LEAP_BUG_BOUNDARY,
  EXCEL_SERIAL_EPOCH_1970,
  FUNCTION_REFERENCE_MATRIX,
  REF_ERROR_CODES,
  ROUND_TRUTH_TABLE,
  daysFromCivil,
  epochMsFromCivil,
  excelSerialFromCivil,
  excelSerialFromCivilTime,
  propagateArithmetic,
  roundHalfAwayFromZero,
} from './reference-oracle.js';

// ---------------------------------------------------------------------------
// 夹具：独立求值上下文（引用查表；日期不参与本包数值断言，只作单元格值）
// ---------------------------------------------------------------------------

/** 用 { "A1": 取值 } 的字典搭一个求值上下文；引用直接查表，缺失即 blank。 */
function makeContext(
  sheets: Record<string, Record<string, CellValue>>,
  current = 'S',
  today_serial?: number,
): SpreadsheetFormulaContext {
  const base: SpreadsheetFormulaContext = {
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
  return today_serial === undefined ? base : { ...base, today_serial };
}

/** 参考矩阵 / 条件函数用的固定夹具：数值列 A、B，标记列 C。 */
const FIXTURE = makeContext({
  S: {
    A1: numberValue(1),
    A2: numberValue(2),
    A3: numberValue(3),
    B1: numberValue(10),
    B2: numberValue(20),
    B3: numberValue(30),
    C1: textValue('x'),
    C2: textValue('y'),
    C3: textValue('x'),
  },
});

const EMPTY = makeContext({ S: {} });

function evalFn(text: string, context: SpreadsheetFormulaContext = FIXTURE): EvalOutcome {
  return evaluateWithFunctions(text, context);
}

// ---------------------------------------------------------------------------
// 1. 日期体系
// ---------------------------------------------------------------------------

describe('X-R02 §1 日期体系：独立整数日历 ⟷ 内核毫秒算式', () => {
  it('锚点表：独立算出的序列号与可查证的 Excel 常量一致', () => {
    for (const [y, m, d, serial] of DATE_ANCHORS) {
      expect(excelSerialFromCivil(y, m, d), `${y}-${m}-${d} 独立序列号`).toBe(serial);
    }
    // 1970-01-01 的 Excel 常量本身也要对。
    expect(EXCEL_SERIAL_EPOCH_1970).toBe(25569);
  });

  it('内核 toExcelSerial 与独立日历算法在 [{2000..2100}] 上逐日一致', () => {
    // 只在 1900-03-01 之后的现代区间比对（窗口内是本仓文档化的有意偏离）。
    let checked = 0;
    for (let y = 2000; y <= 2100; y += 1) {
      for (const [m, d] of [[1, 1], [3, 15], [6, 30], [12, 31]] as const) {
        const serialIndep = excelSerialFromCivil(y, m, d);
        const serialKernel = toExcelSerial(epochMsFromCivil(y, m, d));
        expect(serialKernel, `${y}-${m}-${d}`).toBe(serialIndep);
        checked += 1;
      }
    }
    expect(checked).toBe(101 * 4);
  });

  it('带时刻：小数部分 = 当日毫秒 / 一天毫秒', () => {
    const noon = 12 * 3_600_000;
    expect(excelSerialFromCivilTime(1970, 1, 1, noon)).toBe(25569.5);
    expect(toExcelSerial(epochMsFromCivil(1970, 1, 1, noon))).toBe(25569.5);
    expect(toExcelSerial(epochMsFromCivil(2020, 1, 1, noon))).toBe(43831.5);
  });

  it('往返：序列号 → 毫秒 → 序列号，在整毫秒上无损', () => {
    for (const [y, m, d] of [[1970, 1, 1], [2000, 2, 29], [2020, 1, 1], [2099, 12, 31]] as const) {
      const ms = epochMsFromCivil(y, m, d, 13 * 3_600_000 + 45 * 60_000);
      const serial = toExcelSerial(ms);
      expect(fromExcelSerial(serial)).toBe(ms);
      expect(toExcelSerial(fromExcelSerial(serial))).toBe(serial);
    }
  });

  it('反面对照：1900 闰年窗口内本仓与"真日历 Excel 值"差 1（文档化偏离，不是静默错误）', () => {
    // 真实 Excel：1900-02-28 = 59。本仓原点取 1899-12-30，越过假闰日，故本仓 = 60。
    const serialKernel = toExcelSerial(epochMsFromCivil(1900, 2, 28));
    expect(serialKernel).toBe(60);
    expect(serialKernel - 59).toBe(1); // 与 Excel 的偏离恰为 1，如实登记
    // 边界当天（1900-03-01 = 61）起恢复与 Excel 一致。
    expect(toExcelSerial(epochMsFromCivil(1900, 3, 1))).toBe(EXCEL_LEAP_BUG_BOUNDARY);
    expect(EXCEL_LEAP_BUG_BOUNDARY).toBe(61);
  });

  it('反面对照：DATE(1900,1,1) 落在窗口内 ⇒ 阻塞，不伪造序列号', () => {
    const outcome = evalFn('DATE(1900,1,1)');
    expect(outcome.ok).toBe(false);
  });

  it('独立算法自身自洽：daysFromCivil 的相邻差恒为 1（跨闰年）', () => {
    expect(daysFromCivil(2020, 3, 1) - daysFromCivil(2020, 2, 29)).toBe(1);
    expect(daysFromCivil(2020, 3, 1) - daysFromCivil(2020, 2, 28)).toBe(2); // 2020 是闰年
    expect(daysFromCivil(1900, 3, 1) - daysFromCivil(1900, 2, 28)).toBe(1); // 1900 不是闰年
  });
});

// ---------------------------------------------------------------------------
// 2. 舍入
// ---------------------------------------------------------------------------

describe('X-R02 §2 舍入：ROUND = half away from zero（十进制字面量判定）', () => {
  it('两条独立通道一致：手写真值表 == BigInt 算法', () => {
    for (const [value, digits, expected] of ROUND_TRUTH_TABLE) {
      expect(roundHalfAwayFromZero(value, digits), `oracle(${value},${digits})`).toBe(expected);
    }
  });

  it('内核 ROUND 与真值表逐例一致（含 2.675→2.68 这一"二进制会算错"的经典例）', () => {
    for (const [value, digits, expected] of ROUND_TRUTH_TABLE) {
      const outcome = evalFn(`ROUND(${String(value)},${String(digits)})`);
      expect(outcome.ok, `ROUND(${value},${digits}) 期望成功`).toBe(true);
      if (!outcome.ok) continue;
      expect(outcome.value, `ROUND(${value},${digits})`).toEqual(numberValue(expected));
    }
  });

  it('咬得住：half away from zero ≠ 银行家舍入（否则会红）', () => {
    // 银行家舍入会给 ROUND(2.5,0)=2、ROUND(-2.5,0)=-2；Excel/本仓是 3 / -3。
    expect(evalFn('ROUND(2.5,0)')).toEqual({ ok: true, value: numberValue(3) });
    expect(evalFn('ROUND(-2.5,0)')).toEqual({ ok: true, value: numberValue(-3) });
    expect(evalFn('ROUND(-2.5,0)')).not.toEqual({ ok: true, value: numberValue(-2) });
  });

  it('咬得住：ROUND(2.675,2) 是 2.68 而不是 2.67（按十进制字面量进位）', () => {
    expect(evalFn('ROUND(2.675,2)')).toEqual({ ok: true, value: numberValue(2.68) });
    expect(evalFn('ROUND(1.005,2)')).toEqual({ ok: true, value: numberValue(1.01) });
    // 若实现改成"先乘 100 再 Math.round"，2.675*100=267.4999… → 267 → 2.67，会被这一条抓住。
    expect(evalFn('ROUND(2.675,2)')).not.toEqual({ ok: true, value: numberValue(2.67) });
  });

  it('缺省位数 = 0', () => {
    expect(evalFn('ROUND(2.5)')).toEqual({ ok: true, value: numberValue(3) });
  });

  it('反面对照：负位数 / 超大位数必须阻塞（本仓边界），不得返回近似值', () => {
    const negative = evalFn('ROUND(1.23,-1)');
    expect(negative.ok).toBe(false);
    if (!negative.ok) expect(negative.reason).toBe('invalid_arguments');
    const huge = evalFn('ROUND(1.23,21)');
    expect(huge.ok).toBe(false);
    if (!huge.ok) expect(huge.reason).toBe('invalid_arguments');
    // 上界内仍可算：20 位。
    expect(evalFn('ROUND(1.23,20)')).toEqual({ ok: true, value: numberValue(1.23) });
  });
});

// ---------------------------------------------------------------------------
// 3. 错误值
// ---------------------------------------------------------------------------

describe('X-R02 §3 错误值：封闭枚举、构造、传播', () => {
  it('错误码集合与独立枚举逐元素相等（且恰 7 个）', () => {
    const kernel = [...SPREADSHEET_ERROR_CODES].sort();
    const independent = [...REF_ERROR_CODES].sort();
    expect(kernel).toEqual(independent);
    expect(SPREADSHEET_ERROR_CODES.length).toBe(7);
  });

  it('每个合法错误码都能构造为错误值', () => {
    for (const code of REF_ERROR_CODES) {
      const v = errorValue(code);
      expect(v.kind).toBe('error');
      expect(v.code).toBe(code);
    }
  });

  it('反面对照：非法错误码必须抛 ValidationError，不得静默接受', () => {
    // @ts-expect-error 故意传非法码
    expect(() => errorValue('#FOO!')).toThrow(ValidationError);
  });

  it('传播：算术表达式里的错误值原样传播（不吞成 0 或空白）', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['1/0', '#DIV/0!'],
      ['1/0+1', '#DIV/0!'],
      ['SQRT(-1)', '#NUM!'],
      ['ABS(1/0)', '#DIV/0!'],
      ['1/0*2', '#DIV/0!'],
    ];
    for (const [text, code] of cases) {
      const outcome = evalFn(text);
      expect(outcome.ok, `${text} 期望返回错误值`).toBe(true);
      if (outcome.ok) {
        expect(outcome.value.kind, text).toBe('error');
        if (outcome.value.kind === 'error') expect(outcome.value.code, text).toBe(code);
      }
    }
  });

  it('传播：引用到错误单元格时比较运算原样传播', () => {
    const ctx = makeContext({ S: { D1: errorValue('#N/A') } });
    const outcome = evaluateFormula('D1=1', ctx);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.value).toEqual(errorValue('#N/A'));
  });

  it('独立传播表：左优先，无错误则 null', () => {
    expect(propagateArithmetic('#DIV/0!', '#N/A')).toBe('#DIV/0!');
    expect(propagateArithmetic(null, '#N/A')).toBe('#N/A');
    expect(propagateArithmetic(null, null)).toBeNull();
  });

  it('IFERROR 只吞错误值，不吞阻塞：不认识的功能仍阻塞', () => {
    expect(evalFn('IFERROR(1/0,"fb")')).toEqual({ ok: true, value: textValue('fb') });
    const unsupported = evalFn('IFERROR(FOOBAR(1),"fb")');
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) expect(unsupported.reason).toBe('unsupported_function');
  });
});

// ---------------------------------------------------------------------------
// 4. 函数参考矩阵
// ---------------------------------------------------------------------------

describe('X-R02 §4 函数参考矩阵：覆盖、元数据、点样本', () => {
  it('覆盖：矩阵函数名集合 == ALL_SUPPORTED_FUNCTIONS（无遗漏/无多余）', () => {
    const matrixNames = [...FUNCTION_REFERENCE_MATRIX.map((r) => r.name)].sort();
    const supported = [...ALL_SUPPORTED_FUNCTIONS].sort();
    expect(matrixNames).toEqual(supported);
    // 白名单并集本身也要自洽。
    expect([...SUPPORTED_FUNCTIONS, ...matrixNames.filter((n) => !SUPPORTED_FUNCTIONS.includes(n))].sort()).toEqual(supported);
  });

  it('元数据：扩展函数的 min/max 实参与内核 EXTENDED_FUNCTION_SPECS 一致', () => {
    const specByName = new Map(EXTENDED_FUNCTION_SPECS.map((s) => [s.name, s]));
    let checked = 0;
    for (const row of FUNCTION_REFERENCE_MATRIX) {
      if (row.kind !== 'extended') continue;
      const spec = specByName.get(row.name);
      expect(spec, `扩展函数 ${row.name} 应有 spec`).toBeDefined();
      if (spec !== undefined) {
        expect(spec.min_args, `${row.name} min_args`).toBe(row.min_args);
        expect(spec.max_args, `${row.name} max_args`).toBe(row.max_args);
        checked += 1;
      }
    }
    expect(checked).toBe(EXTENDED_FUNCTION_SPECS.length);
  });

  it('核心函数：都在 SUPPORTED_FUNCTIONS 内，且矩阵没有把它们标成 extended', () => {
    for (const row of FUNCTION_REFERENCE_MATRIX) {
      if (row.kind === 'core') {
        expect(SUPPORTED_FUNCTIONS, `${row.name} 应在核心白名单`).toContain(row.name);
      } else {
        expect(SUPPORTED_FUNCTIONS, `${row.name} 不应在核心白名单`).not.toContain(row.name);
      }
    }
  });

  it('逐行点样本：内核求值 == 独立期望', () => {
    for (const row of FUNCTION_REFERENCE_MATRIX) {
      const outcome = evalFn(row.example, FIXTURE);
      const exp = row.expected;
      switch (exp.outcome) {
        case 'number':
          expect(outcome, `${row.example}`).toEqual({ ok: true, value: numberValue(exp.value) });
          break;
        case 'text':
          expect(outcome, `${row.example}`).toEqual({ ok: true, value: textValue(exp.value) });
          break;
        case 'boolean':
          expect(outcome, `${row.example}`).toEqual({ ok: true, value: booleanValue(exp.value) });
          break;
        case 'error':
          expect(outcome.ok, `${row.example} 期望错误值`).toBe(true);
          if (outcome.ok) expect(outcome.value, `${row.example}`).toEqual(errorValue(exp.code));
          break;
        case 'blocked':
          expect(outcome.ok, `${row.example} 期望阻塞`).toBe(false);
          if (!outcome.ok) expect(outcome.reason, `${row.example}`).toBe(exp.reason);
          break;
        default: {
          const never: never = exp;
          throw new Error(`未覆盖的期望类型：${JSON.stringify(never)}`);
        }
      }
    }
  });

  it('TODAY 注入 today_serial 时返回该序列号（唯一"当前日期"来源，不读墙钟）', () => {
    const ctx = makeContext({ S: {} }, 'S', 44927);
    expect(evalFn('TODAY()', ctx)).toEqual({ ok: true, value: numberValue(44927) });
    // 未注入即阻塞，且阻塞，不是返回 0 或某个"今天"。
    expect(evalFn('TODAY()', EMPTY).ok).toBe(false);
  });

  it('反面对照：白名单外的函数名必须阻塞（矩阵外不得猜）', () => {
    const outcome = evalFn('XLOOKUP(1,A1:A3,B1:B3)');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('unsupported_function');
  });
});

// ---------------------------------------------------------------------------
// 5. 差分对照：扩展层不得改写核心语义
// ---------------------------------------------------------------------------

describe('X-R02 §5 差分对照：evaluateWithFunctions ≈ evaluateFormula（纯核心公式）', () => {
  const CORE_FORMULAS: readonly string[] = [
    '1+2*3',
    '10-4',
    '10/4',
    '1/0',
    '-2^2',
    '2^3^2',
    '(1<2)',
    '(1="1")',
    '1&"a"',
    'SUM(1,2,3)',
    'AVERAGE(2,4,6)',
    'MIN(3,1,2)',
    'MAX(3,1,2)',
    'COUNT(1,"x",3)',
    'COUNTA(1,"x",3)',
    'IF(1=1,"a","b")',
    'AND(TRUE,1)',
    'OR(FALSE,1)',
    'NOT(FALSE)',
    'ABS(-3)',
    'ROUND(2.675,2)',
    'ROUND(-2.5,0)',
    'SQRT(16)',
    'SQRT(-1)',
  ];

  it('逐例逐字同结论（值同、错误同、阻塞同）', () => {
    for (const text of CORE_FORMULAS) {
      const core = evaluateFormula(text, FIXTURE);
      const ext = evaluateWithFunctions(text, FIXTURE);
      expect(ext, `${text}`).toEqual(core);
    }
  });
});

// ---------------------------------------------------------------------------
// 6. 数组 / 动态数组 / SUMPRODUCT 区域语义（本仓缺席的部分，如实钉住）
// ---------------------------------------------------------------------------

/** 把一个独立 `AggSpec` 变成真实单元格取值（六类判别联合）。 */
function specToCell(spec: AggSpec): CellValue {
  switch (spec.kind) {
    case 'number':
      return numberValue(spec.num ?? 0);
    case 'text':
      return textValue(spec.text ?? '');
    case 'boolean':
      return booleanValue(spec.bool ?? false);
    case 'blank':
      return blank;
    case 'error':
      return errorValue(spec.code ?? '#N/A');
    case 'date':
      return dateValue(spec.epoch_ms ?? 0);
  }
}

/** 把一串 `AggSpec` 放进 A1..An（单列）建上下文。 */
function rangeContext(specs: readonly AggSpec[]): SpreadsheetFormulaContext {
  const grid: Record<string, CellValue> = {};
  specs.forEach((spec, index) => {
    grid[`A${String(index + 1)}`] = specToCell(spec);
  });
  return makeContext({ S: grid });
}

/** 单列区域引用。 */
function singleColumn(count: number): string {
  return `A1:A${String(count)}`;
}

/** 内核求值结果 → 独立期望的可比形状（只有 number / error / blocked 三种出口）。 */
function toComparable(outcome: EvalOutcome): AggOracleOutcome {
  if (!outcome.ok) {
    return { outcome: 'blocked', reason: outcome.reason };
  }
  const value = outcome.value;
  if (value.kind === 'number') return { outcome: 'number', value: value.value };
  if (value.kind === 'error') return { outcome: 'error', code: value.code };
  return { outcome: 'blocked', reason: `unexpected_${value.kind}` };
}

describe('X-R02 §6 数组 / 动态数组 / SUMPRODUCT 区域语义', () => {
  it('缺席清单与受支持函数集合不相交（参考矩阵不得声称支持数组函数）', () => {
    const supported = new Set(ALL_SUPPORTED_FUNCTIONS);
    for (const name of ABSENT_ARRAY_FUNCTIONS) {
      expect(supported.has(name), `${name} 不应出现在 ALL_SUPPORTED_FUNCTIONS`).toBe(false);
    }
    // 清单规模固定，防止"悄悄删几个名字让断言变空"。
    expect(ABSENT_ARRAY_FUNCTIONS.length).toBe(22);
  });

  it('反面对照：每个数组函数内核都阻塞 unsupported_function（不猜、不算成 0）', () => {
    for (const name of ABSENT_ARRAY_FUNCTIONS) {
      const outcome = evalFn(`${name}(A1:A3)`, FIXTURE);
      expect(outcome.ok, `${name} 应阻塞而不是求值`).toBe(false);
      if (!outcome.ok) expect(outcome.reason, name).toBe('unsupported_function');
    }
  });

  it('独立 SUMPRODUCT 语义：逐元素乘加真值表 == 算法', () => {
    for (const [a, b, expected] of SUMPRODUCT_TRUTH) {
      expect(sumProductElementwise(a, b), `SUMPRODUCT(${a.join(',')};${b.join(',')})`).toBe(expected);
    }
  });

  it('缺口可见：内核阻塞 SUMPRODUCT，独立语义给出 Excel 应得的 140', () => {
    const ctx = makeContext({
      S: {
        A1: numberValue(1),
        A2: numberValue(2),
        A3: numberValue(3),
        B1: numberValue(10),
        B2: numberValue(20),
        B3: numberValue(30),
      },
    });
    // 先证明区域本身可解析（SUM 读得到），排除"因为区域坏了才阻塞"。
    expect(evalFn('SUM(A1:A3)', ctx)).toEqual({ ok: true, value: numberValue(6) });
    expect(evalFn('SUM(B1:B3)', ctx)).toEqual({ ok: true, value: numberValue(60) });
    const outcome = evalFn('SUMPRODUCT(A1:A3,B1:B3)', ctx);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('unsupported_function');
    // Excel 应得 1*10+2*20+3*30 = 140；本仓没有这个能力——这是"有意的缺席"。
    expect(sumProductElementwise([1, 2, 3], [10, 20, 30])).toBe(140);
  });

  it('反面对照：SUMPRODUCT 数组长度不等（Excel 返回 #VALUE!）独立实现直接拒绝', () => {
    expect(() => sumProductElementwise([1, 2], [1, 2, 3])).toThrow();
  });

  it('动态数组错误值 #SPILL!：取值模型可"读"它，但求值器仍不会"产生"它', () => {
    // 实况（X-I03 已把读侧现代错误码并入取值模型）：#SPILL! 现在可构造为一等错误值，
    // 供"读真实文件"用；但经典 7 码枚举不得因此扩容（§3 的集合相等与长度 7 仍成立）。
    const spill = errorValue('#SPILL!');
    expect(spill.kind).toBe('error');
    expect(spill.code).toBe('#SPILL!');
    expect(MODERN_EXCEL_ERROR_CODES).toContain('#SPILL!');
    // 现代码与经典 7 码不相交，且经典集仍是 7 个。
    for (const modern of MODERN_EXCEL_ERROR_CODES) {
      expect(SPREADSHEET_ERROR_CODES as readonly string[]).not.toContain(modern);
    }
    expect(SPREADSHEET_ERROR_CODES.length).toBe(7);
    // 求值器没有数组能力 ⇒ #SPILL! 只可能来自"读文件"，不可能来自"算公式"。
    const outcome = evalFn('SUMPRODUCT(A1:A3,B1:B3)', FIXTURE);
    expect(outcome.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. 日期 / 时间显示格式（numFmt）：独立渲染 ⟷ 样式层
// ---------------------------------------------------------------------------

describe('X-R02 §7 日期显示格式：独立渲染 ⟷ 样式层 renderNumberDisplay', () => {
  it('手写真值表 == 独立算法（两条独立通道彼此印证）', () => {
    for (const [serial, pattern, expected] of DATE_DISPLAY_TRUTH) {
      expect(renderDateDisplayIndependent(serial, pattern), `oracle ${serial} ${pattern}`).toBe(expected);
    }
  });

  it('内核 renderNumberDisplay == 手写真值表（显示文本逐例一致）', () => {
    for (const [serial, pattern, expected] of DATE_DISPLAY_TRUTH) {
      const shown = renderNumberDisplay(serial, { kind: 'date', pattern });
      expect(shown.display, `kernel ${serial} ${pattern}`).toBe(expected);
    }
  });

  it('原值与显示值分开：value 原样带回，display 不改写数值', () => {
    const shown = renderNumberDisplay(43831, { kind: 'date', pattern: 'yyyy-mm-dd' });
    expect(shown.value).toBe(43831);
    expect(shown.display).toBe('2020-01-01');
    expect(shown.display).not.toBe(String(shown.value));
  });

  it('时间小数被显示层丢弃（图案集不含时刻），数值本身保留', () => {
    const shown = renderNumberDisplay(43831.5, { kind: 'date', pattern: 'yyyy-mm-dd' });
    expect(shown.display).toBe('2020-01-01');
    expect(shown.value).toBe(43831.5);
    expect(renderDateDisplayIndependent(43831.5, 'yyyy-mm-dd')).toBe('2020-01-01');
  });

  it('numFmt 层：图案 → 内建 id / 自定义格式码（独立登记 == describeNumberFormat）', () => {
    for (const [pattern, numFmtId, formatCode] of DATE_PATTERN_NUMFMT_TRUTH) {
      const parsed = describeNumberFormat({ kind: 'date', pattern });
      expect(parsed.numFmtId, `${pattern} numFmtId`).toBe(numFmtId);
      expect(parsed.formatCode, `${pattern} formatCode`).toBe(formatCode);
      expect(parsed.applyNumberFormat).toBe(true);
    }
    // m/d/yyyy 用的是真实 ECMA-376 内建日期 id 14（可查证）。
    expect(BUILTIN_NUMFMT_CODES[14]).toBe('m/d/yyyy');
    expect(isBuiltinDateFormatId(14)).toBe(true);
    expect(FIRST_CUSTOM_NUMFMT_ID).toBe(164);
  });

  it('反面对照：时刻图案（h:mm）不在封闭图案集内，describeNumberFormat 抛 ValidationError', () => {
    // @ts-expect-error h:mm 不属于受支持日期图案
    expect(() => describeNumberFormat({ kind: 'date', pattern: 'h:mm' })).toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// 8. 区域聚合边界矩阵（R248：空白不当零、不进分母）
// ---------------------------------------------------------------------------

describe('X-R02 §8 区域聚合边界：blank/error/boolean/text/date 的分子与分母', () => {
  it('手工矩阵 == 独立算法 == 内核（三通道一致，逐行逐函数）', () => {
    let checked = 0;
    for (const row of RANGE_AGGREGATE_MATRIX) {
      const ctx = rangeContext(row.specs);
      const ref = singleColumn(row.specs.length);
      const entries = Object.entries(row.expected) as readonly (readonly [AggName, AggOracleOutcome])[];
      expect(entries.length, `${row.label} 至少一条期望`).toBeGreaterThan(0);
      for (const [fn, expected] of entries) {
        // 通道 A：独立算法重现手工期望。
        expect(aggregateOracleR248(row.specs, fn), `oracle ${row.label} ${fn}`).toEqual(expected);
        // 通道 B：内核与期望一致。
        expect(toComparable(evalFn(`${fn}(${ref})`, ctx)), `kernel ${row.label} ${fn}`).toEqual(expected);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(40);
  });

  it('直接实参布尔按 1/0 计入（与区域布尔被忽略形成对照）', () => {
    expect(evalFn('SUM(TRUE,2)')).toEqual({ ok: true, value: numberValue(3) });
    expect(evalFn('AVERAGE(TRUE,TRUE)')).toEqual({ ok: true, value: numberValue(1) });
    // 区域里的布尔 SUM 忽略 ⇒ 全布尔区域无贡献 ⇒ 阻塞（见矩阵行 bool,bool）。
    const bools = makeContext({ S: { A1: booleanValue(true), A2: booleanValue(false) } });
    const blocked = evalFn('SUM(A1:A2)', bools);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.reason).toBe('empty_aggregate');
  });

  it('R248：空白的两种口径都不得"当 0"——不入 SUM、不进 AVERAGE 分母、不算非空', () => {
    const ctx = rangeContext([{ kind: 'number', num: 1 }, { kind: 'blank' }, { kind: 'blank' }, { kind: 'number', num: 3 }]);
    expect(evalFn('SUM(A1:A4)', ctx)).toEqual({ ok: true, value: numberValue(4) });
    expect(evalFn('AVERAGE(A1:A4)', ctx)).toEqual({ ok: true, value: numberValue(2) }); // 除以 2，不是 4
    expect(evalFn('COUNT(A1:A4)', ctx)).toEqual({ ok: true, value: numberValue(2) });
    expect(evalFn('COUNTA(A1:A4)', ctx)).toEqual({ ok: true, value: numberValue(2) }); // 空白不计非空
  });
});

// ---------------------------------------------------------------------------
// 9. 与 Excel 的**有意偏离**（登记表；偏离必须被看见，不能被"全绿"掩盖）
// ---------------------------------------------------------------------------

describe('X-R02 §9 本仓有意偏离 Excel 的聚合口径（如实登记）', () => {
  it('每条：内核 == 登记的本仓口径，且 ≠ 登记的 Excel 值（偏离确实存在）', () => {
    for (const item of EXCEL_DIVERGENCE_CASES) {
      const ctx = rangeContext(item.specs);
      const ref = singleColumn(item.specs.length);
      const kernel = evalFn(`${item.fn}(${ref})`, ctx);
      expect(toComparable(kernel), `kernel ${item.label}`).toEqual(item.kernel);
      expect(aggregateOracleR248(item.specs, item.fn), `oracle ${item.label}`).toEqual(item.kernel);
      expect(item.excel, `${item.label} 的 Excel 值应与本仓口径不同`).not.toEqual(item.kernel);
    }
  });

  it('COUNT 的直接布尔实参：本仓计入，Excel 忽略（登记的第二处偏离）', () => {
    // 本仓：直接布尔实参按 1/0 计入 numbers，故 COUNT=2。
    expect(evalFn('COUNT(TRUE,2)')).toEqual({ ok: true, value: numberValue(2) });
    // Excel：COUNT 忽略逻辑值 ⇒ 1；两者不同，故显式 not.toEqual，偏离可见。
    expect(evalFn('COUNT(TRUE,2)')).not.toEqual({ ok: true, value: numberValue(1) });
  });
});
