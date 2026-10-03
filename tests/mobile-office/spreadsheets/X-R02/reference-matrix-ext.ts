/**
 * **X-R02 独立参考矩阵 · 第二次增量**：数组/SUMPRODUCT 区域语义、日期**显示**格式、
 * 区域聚合边界矩阵。零 `src/` 依赖、零墙钟、零随机。
 *
 * ## 为什么还要一个"独立参考"
 *
 * 第一增量（`reference-oracle.ts`）覆盖了日期体系 / 舍入 / 错误值 / 函数矩阵 / 差分。
 * 本文件补上它**明确登记为未覆盖**的三块，并沿用同一原则——预期值由 Excel 语义
 * **独立推导**，不取内核返回值（否则实现错了用例也跟着绿）：
 *
 * 1. **数组 / 动态数组 / SUMPRODUCT 区域语义**
 *    本仓求值器**没有任何**数组或动态数组函数（无 SUMPRODUCT / TRANSPOSE / FILTER / SPILL…）。
 *    与其假装支持，本模块把"Excel 有、本仓没有"的清单**冻结**成
 *    {@link ABSENT_ARRAY_FUNCTIONS}，并独立实现 `SUMPRODUCT` 的**逐元素乘加**语义
 *    ({@link sumProductElementwise})，用来证明：内核对该函数的阻塞是**有意的缺席**，
 *    而不是"算错了的 0"。区域聚合里真正落地的 SUMPRODUCT 式语义由 SUMIF/COUNTIF 覆盖。
 * 2. **日期 / 时间显示格式（numFmt）**
 *    与 `style-parts/descriptor.ts` 的 `renderNumberDisplay` 是**两条独立通道**：
 *    本模块用自己写的 Hinnant `civil_from_days` 把序列号还原成公历再拼串，并另备一张
 *    **手写真值表** {@link DATE_DISPLAY_TRUTH}；{@link DATE_PATTERN_NUMFMT_TRUTH}
 *    独立登记"图案 → ECMA-376 内建 id / 自定义格式码"。
 * 3. **区域聚合完整边界矩阵**
 *    blank / error / boolean / text / date 落在 SUM / AVERAGE / MIN / MAX / COUNT / COUNTA
 *    的分子与分母上分别怎么算，逐类登记（{@link RANGE_AGGREGATE_MATRIX}），并把
 *    "本仓有意偏离 Excel"的几处**如实登记**在 {@link EXCEL_DIVERGENCE_CASES}——
 *    偏离要被看见，不能被当成一致。
 *
 * 判据口径：R248「缺失不当零」——空白既不贡献也不进分母，空聚合**阻塞**而非返回 0。
 */

import type { SpreadsheetErrorCodeRef } from './reference-oracle.js';

/**
 * 现代 Excel 错误码（动态数组 / `#SPILL!` 家族）。独立登记，供聚合边界与偏离表使用；
 * 与 `value.ts::MODERN_EXCEL_ERROR_CODES`（X-I03 读侧口径）是同一集合的**独立**副本。
 */
export type ModernExcelErrorCodeRef =
  | '#SPILL!'
  | '#CALC!'
  | '#GETTING_DATA'
  | '#FIELD!'
  | '#UNKNOWN!'
  | '#CONNECT!'
  | '#BLOCKED!'
  | '#BUSY!'
  | '#PYTHON!';

/** 本模块认得的全部错误码（经典 7 + 现代 9）。 */
export type AnyErrorCodeRef = SpreadsheetErrorCodeRef | ModernExcelErrorCodeRef;

// ===========================================================================
// (1) 数组 / 动态数组：缺席清单 + 独立 SUMPRODUCT 语义
// ===========================================================================

/**
 * Excel 有、**本仓求值器没有**的数组 / 动态数组函数（冻结清单）。
 *
 * 用途：断言这些名字**一个都不在** `ALL_SUPPORTED_FUNCTIONS` 里——参考矩阵不得把它
 * 声称支持的函数矩阵与"实际支持的 32 个"混为一谈。清单本身可查证（都是 Excel 真名）。
 */
export const ABSENT_ARRAY_FUNCTIONS: readonly string[] = Object.freeze([
  // 经典数组函数
  'SUMPRODUCT',
  'TRANSPOSE',
  'MMULT',
  'MDETERM',
  'MINVERSE',
  'FREQUENCY',
  // 动态数组（365/2021 的溢出函数）
  'FILTER',
  'SORT',
  'SORTBY',
  'UNIQUE',
  'SEQUENCE',
  'RANDARRAY',
  // 现代查抄 / 数组包裹
  'XLOOKUP',
  'XMATCH',
  'TEXTJOIN',
  'LET',
  'LAMBDA',
  'MAP',
  'REDUCE',
  'SCAN',
  'BYROW',
  'BYCOL',
]);

/**
 * 独立实现 `SUMPRODUCT(a, b) = Σ aᵢ·bᵢ`（**逐元素乘加**，Excel 语义）。
 *
 * 这是本仓求值器**没有**的能力，因此这份实现只用于：(a) 给出手工可验证的期望值，
 * (b) 让测试把"内核阻塞"与"Excel 应得的数"并排摆出来，缺口可见。
 *
 * @throws 数组长度不等（Excel 会返回 `#VALUE!`，本模块直接拒绝，因为它是**参考实现**）
 */
export function sumProductElementwise(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`SUMPRODUCT 两个数组长度必须相同，收到 ${String(a.length)} 与 ${String(b.length)}`);
  }
  let total = 0;
  for (let i = 0; i < a.length; i += 1) {
    total += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return total;
}

/**
 * `SUMPRODUCT` 手写真值表（不经任何算法，纯查表）。
 * 每一项：`[数组A, 数组B, 独立期望 Σ aᵢ·bᵢ]`。
 */
export const SUMPRODUCT_TRUTH: readonly (readonly [readonly number[], readonly number[], number])[] =
  Object.freeze([
    [[1, 2, 3], [10, 20, 30], 140],
    [[2, 4], [0.5, 0.25], 2],
    [[-1, 2, -3], [4, -5, 6], -32],
    [[0, 0, 0], [9, 9, 9], 0],
  ]);

// ===========================================================================
// (2) 日期 / 时间显示格式：独立日历 + 手写真值表 + numFmt 层
// ===========================================================================

/** 本仓支持的日期显示图案（与 `styles.ts::DateDisplayPattern` 同集合，**独立登记**）。 */
export type DateDisplayPatternRef = 'yyyy-mm-dd' | 'yyyy/mm/dd' | 'm/d/yyyy' | 'dd/mm/yyyy';

/** 1970-01-01 的 Excel 1900 日期系统序列号（Excel 常量）。 */
const REF_EXCEL_EPOCH_1970 = 25569;

/**
 * Howard Hinnant `civil_from_days`：距 1970-01-01 的整数天数 → 公历年月日。
 * 纯整数、与内核 `styles.ts::civilFromDays` 是**并列实现**（本文件零 `src/` 导入）。
 */
export function civilFromDaysIndep(days: number): { readonly year: number; readonly month: number; readonly day: number } {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097; // [0, 146096]
  const yoe = Math.floor((doe - Math.floor(doe / 1_460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const yearOfEra = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  const year = yearOfEra + (month <= 2 ? 1 : 0);
  return { year, month, day };
}

/**
 * Excel 序列号 → 公历年月日（**整数部分**即天数；小数部分=当天时刻，本图案集不含时刻，故丢弃）。
 *
 * 与 `descriptor.ts` 的 `renderNumberDisplay`（走 `fromExcelSerial` 的毫秒算式 + `floor(ms/天)`）
 * 是两条路径：这里直接 `floor(serial) − 25569` 得到"距 1970 的天数"。
 */
export function dateSerialToCivil(serial: number): { readonly year: number; readonly month: number; readonly day: number } {
  const daysSince1970 = Math.floor(serial) - REF_EXCEL_EPOCH_1970;
  return civilFromDaysIndep(daysSince1970);
}

function pad2(value: number): string {
  return value < 10 ? `0${String(value)}` : String(value);
}

/** 独立日期显示渲染：序列号 + 图案 → 显示文本（与样式层无关）。 */
export function renderDateDisplayIndependent(serial: number, pattern: DateDisplayPatternRef): string {
  const { year, month, day } = dateSerialToCivil(serial);
  switch (pattern) {
    case 'yyyy-mm-dd':
      return `${String(year)}-${pad2(month)}-${pad2(day)}`;
    case 'yyyy/mm/dd':
      return `${String(year)}/${pad2(month)}/${pad2(day)}`;
    case 'm/d/yyyy':
      return `${String(month)}/${String(day)}/${String(year)}`;
    case 'dd/mm/yyyy':
      return `${pad2(day)}/${pad2(month)}/${String(year)}`;
    default: {
      const never: never = pattern;
      throw new Error(`未覆盖的日期图案：${JSON.stringify(never)}`);
    }
  }
}

/**
 * 日期显示**手写真值表**（不经算法；与 {@link renderDateDisplayIndependent} 并列的第二条通道）。
 * `[序列号, 图案, 期望显示文本]`。
 */
export const DATE_DISPLAY_TRUTH: readonly (readonly [number, DateDisplayPatternRef, string])[] =
  Object.freeze([
    [25569, 'yyyy-mm-dd', '1970-01-01'],
    [25569, 'm/d/yyyy', '1/1/1970'],
    [36526, 'yyyy-mm-dd', '2000-01-01'],
    [43831, 'yyyy-mm-dd', '2020-01-01'],
    [43831, 'm/d/yyyy', '1/1/2020'],
    [43831, 'dd/mm/yyyy', '01/01/2020'],
    [43831, 'yyyy/mm/dd', '2020/01/01'],
    [43841, 'yyyy-mm-dd', '2020-01-11'],
    [43841, 'm/d/yyyy', '1/11/2020'],
    [43841, 'dd/mm/yyyy', '11/01/2020'],
    [44927, 'yyyy-mm-dd', '2023-01-01'],
    [45000, 'yyyy-mm-dd', '2023-03-15'],
    [45000, 'dd/mm/yyyy', '15/03/2023'],
    [73050, 'yyyy-mm-dd', '2099-12-31'],
  ]);

/**
 * 日期图案 → numFmt 层（`numFmtId` 内建 / `formatCode` 自定义）的**独立登记**。
 *
 * `numFmtId===null` 表示"需在 `<numFmts>` 自定义声明（id 从 164 起）"；`formatCode===null`
 * 表示"直接引用内建 id，不必声明格式码"。判据来自 ECMA-376 §18.8.30 内建清单。
 */
export const DATE_PATTERN_NUMFMT_TRUTH: readonly (readonly [DateDisplayPatternRef, number | null, string | null])[] =
  Object.freeze([
    ['m/d/yyyy', 14, null],
    ['yyyy-mm-dd', null, 'yyyy-mm-dd'],
    ['yyyy/mm/dd', null, 'yyyy/mm/dd'],
    ['dd/mm/yyyy', null, 'dd/mm/yyyy'],
  ]);

// ===========================================================================
// (3) 区域聚合边界矩阵（SUM / AVERAGE / MIN / MAX / COUNT / COUNTA）
// ===========================================================================

/** 聚合函数名。 */
export type AggName = 'SUM' | 'AVERAGE' | 'MIN' | 'MAX' | 'COUNT' | 'COUNTA';

/** 一个"待放进区域"的取值描述（不含任何 `src/` 类型，独立表达六类）。 */
export interface AggSpec {
  readonly kind: 'number' | 'text' | 'boolean' | 'blank' | 'error' | 'date';
  readonly num?: number;
  readonly text?: string;
  readonly bool?: boolean;
  readonly code?: AnyErrorCodeRef;
  readonly epoch_ms?: number;
}

/** 聚合的独立期望结果（判别联合）。 */
export type AggOracleOutcome =
  | { readonly outcome: 'number'; readonly value: number }
  | { readonly outcome: 'error'; readonly code: AnyErrorCodeRef }
  | { readonly outcome: 'blocked'; readonly reason: string };

/** 便捷构造：数值结果。 */
export const aggNum = (value: number): AggOracleOutcome => Object.freeze({ outcome: 'number', value });
/** 便捷构造：错误值结果。 */
export const aggErr = (code: AnyErrorCodeRef): AggOracleOutcome => Object.freeze({ outcome: 'error', code });
/** 便捷构造：阻塞结果。 */
export const aggBlk = (reason: string): AggOracleOutcome => Object.freeze({ outcome: 'blocked', reason });

/**
 * 独立实现本仓 **R248 聚合口径**（与 `evaluate.ts::aggregate` 是并列实现）：
 *
 * - 错误值优先：任一格是错误值 ⇒ 整体传播该错误（**含 COUNT / COUNTA**）；
 * - 日期值 ⇒ 阻塞 `non_numeric_operand`（本仓不做隐式日期→序列号）；
 * - 区域里的布尔 / 文本**不贡献数值**，但计入 COUNTA 的非空计数；
 * - 空白**既不贡献也不计非空**（R248：缺失不当零，也不占位）；
 * - `COUNT` = 数值格数（0 是合法计数）；`COUNTA` = 非空格数；
 * - 一个数值都没有 ⇒ SUM/AVERAGE/MIN/MAX **阻塞** `empty_aggregate`（不返回 0）。
 */
export function aggregateOracleR248(specs: readonly AggSpec[], name: AggName): AggOracleOutcome {
  let errorCode: AnyErrorCodeRef | null = null;
  let dateSeen = false;
  const numbers: number[] = [];
  let nonBlank = 0;
  for (const spec of specs) {
    switch (spec.kind) {
      case 'number':
        numbers.push(spec.num ?? 0);
        nonBlank += 1;
        break;
      case 'boolean':
        nonBlank += 1;
        break;
      case 'text':
        nonBlank += 1;
        break;
      case 'date':
        dateSeen = true;
        nonBlank += 1;
        break;
      case 'error':
        errorCode ??= spec.code ?? '#N/A';
        break;
      case 'blank':
        break;
    }
  }
  if (errorCode !== null) return aggErr(errorCode);
  if (dateSeen) return aggBlk('non_numeric_operand');
  if (name === 'COUNT') return aggNum(numbers.length);
  if (name === 'COUNTA') return aggNum(nonBlank);
  if (numbers.length === 0) return aggBlk('empty_aggregate');
  const total = numbers.reduce((sum, value) => sum + value, 0);
  switch (name) {
    case 'SUM':
      return aggNum(total);
    case 'AVERAGE':
      return aggNum(total / numbers.length);
    case 'MIN':
      return aggNum(Math.min(...numbers));
    case 'MAX':
      return aggNum(Math.max(...numbers));
    default: {
      const never: never = name;
      throw new Error(`未覆盖的聚合函数：${JSON.stringify(never)}`);
    }
  }
}

/** 矩阵一行：区域内容 + 手工推导的期望（只列需要盯的函数）。 */
export interface RangeAggregateRow {
  readonly label: string;
  readonly specs: readonly AggSpec[];
  readonly expected: Readonly<Partial<Record<AggName, AggOracleOutcome>>>;
}

/** 简写构造器（仅本文件与测试使用）。 */
const N = (num: number): AggSpec => ({ kind: 'number', num });
const TX: AggSpec = { kind: 'text', text: 'x' };
const BL: AggSpec = { kind: 'blank' };
const DT: AggSpec = { kind: 'date', epoch_ms: 0 };
const B = (bool: boolean): AggSpec => ({ kind: 'boolean', bool });
const ER = (code: SpreadsheetErrorCodeRef): AggSpec => ({ kind: 'error', code });

/**
 * 区域聚合**手工推导**边界矩阵（第一条通道；`aggregateOracleR248` 是第二条）。
 * 覆盖 R248 的每一类取值落在分子（贡献）与分母（计数）上的行为。
 */
export const RANGE_AGGREGATE_MATRIX: readonly RangeAggregateRow[] = Object.freeze([
  {
    label: 'n,n,n',
    specs: [N(1), N(2), N(3)],
    expected: { SUM: aggNum(6), AVERAGE: aggNum(2), MIN: aggNum(1), MAX: aggNum(3), COUNT: aggNum(3), COUNTA: aggNum(3) },
  },
  {
    label: 'n,blank,n',
    specs: [N(1), BL, N(3)],
    expected: { SUM: aggNum(4), AVERAGE: aggNum(2), COUNT: aggNum(2), COUNTA: aggNum(2) },
  },
  {
    label: 'n,text,n',
    specs: [N(1), TX, N(3)],
    expected: { SUM: aggNum(4), AVERAGE: aggNum(2), COUNT: aggNum(2), COUNTA: aggNum(3) },
  },
  {
    label: 'n,bool,n',
    specs: [N(1), B(true), N(3)],
    expected: { SUM: aggNum(4), AVERAGE: aggNum(2), COUNT: aggNum(2), COUNTA: aggNum(3) },
  },
  {
    label: 'n,blank,text,n',
    specs: [N(1), BL, TX, N(3)],
    expected: { SUM: aggNum(4), AVERAGE: aggNum(2), COUNT: aggNum(2), COUNTA: aggNum(3) },
  },
  {
    label: 'n,blank,blank,n,n（空白不进分母）',
    specs: [N(1), BL, BL, N(2), N(3)],
    expected: { SUM: aggNum(6), AVERAGE: aggNum(2), COUNT: aggNum(3), COUNTA: aggNum(3) },
  },
  {
    label: 'blank,blank,blank（空聚合阻塞）',
    specs: [BL, BL, BL],
    expected: {
      SUM: aggBlk('empty_aggregate'),
      AVERAGE: aggBlk('empty_aggregate'),
      MIN: aggBlk('empty_aggregate'),
      MAX: aggBlk('empty_aggregate'),
      COUNT: aggNum(0),
      COUNTA: aggNum(0),
    },
  },
  {
    label: 'text,text,text（无数值贡献）',
    specs: [TX, TX, TX],
    expected: { SUM: aggBlk('empty_aggregate'), AVERAGE: aggBlk('empty_aggregate'), COUNT: aggNum(0), COUNTA: aggNum(3) },
  },
  {
    label: 'bool,bool（区域布尔被 SUM 忽略）',
    specs: [B(true), B(false)],
    expected: { SUM: aggBlk('empty_aggregate'), COUNT: aggNum(0), COUNTA: aggNum(2) },
  },
  {
    label: 'bool,blank,n',
    specs: [B(true), BL, N(2)],
    expected: { SUM: aggNum(2), AVERAGE: aggNum(2), COUNT: aggNum(1), COUNTA: aggNum(2) },
  },
  {
    label: 'n,error,n（错误值传播，含 COUNT/COUNTA）',
    specs: [N(1), ER('#N/A'), N(3)],
    expected: { SUM: aggErr('#N/A'), AVERAGE: aggErr('#N/A'), COUNT: aggErr('#N/A'), COUNTA: aggErr('#N/A') },
  },
  {
    label: 'n,date,n（日期值不隐式转换 ⇒ 阻塞）',
    specs: [N(1), DT, N(3)],
    expected: {
      SUM: aggBlk('non_numeric_operand'),
      AVERAGE: aggBlk('non_numeric_operand'),
      MIN: aggBlk('non_numeric_operand'),
      COUNT: aggBlk('non_numeric_operand'),
      COUNTA: aggBlk('non_numeric_operand'),
    },
  },
]);

/**
 * 本仓**有意偏离 Excel** 的聚合用例（如实登记；每条都断言"内核得 kernel、Excel 应得 excel"）。
 *
 * 这些不是 bug 的隐藏处，而是被**看见**的边界：偏离要被摆出来，不能被"参考矩阵全绿"掩盖。
 */
export interface ExcelDivergenceCase {
  readonly label: string;
  readonly specs: readonly AggSpec[];
  readonly fn: AggName;
  /** 本仓实测口径（R248）。 */
  readonly kernel: AggOracleOutcome;
  /** 真 Excel 的值（独立推导）。 */
  readonly excel: AggOracleOutcome;
  readonly note: string;
}

export const EXCEL_DIVERGENCE_CASES: readonly ExcelDivergenceCase[] = Object.freeze([
  {
    label: 'COUNT(区域含错误值)',
    specs: [N(1), ER('#N/A'), N(3)],
    fn: 'COUNT',
    kernel: aggErr('#N/A'),
    excel: aggNum(2),
    note: 'Excel 的 COUNT 忽略区域里的错误值，只数数值格（=2）；本仓把错误值向上传播。',
  },
  {
    label: 'COUNTA(区域含错误值)',
    specs: [N(1), ER('#N/A'), N(3)],
    fn: 'COUNTA',
    kernel: aggErr('#N/A'),
    excel: aggNum(3),
    note: 'Excel 的 COUNTA 把错误格算作"非空"（=3）；本仓传播错误。',
  },
  {
    label: 'SUM(全空白区域)',
    specs: [BL, BL, BL],
    fn: 'SUM',
    kernel: aggBlk('empty_aggregate'),
    excel: aggNum(0),
    note: 'Excel 的空区 SUM = 0；本仓按 R248 阻塞（有意偏离，`evaluate.ts` 已登记）。',
  },
  {
    label: 'SUMMARY(区域含日期)',
    specs: [N(1), DT, N(3)],
    fn: 'SUM',
    kernel: aggBlk('non_numeric_operand'),
    excel: aggNum(25_573),
    note: 'Excel 里日期就是数字序列号（1970-01-01=25569 ⇒ 1+25569+3=25573）；本仓 DateValue 与 NumberValue 不同类，不隐式转换，阻塞。',
  },
]);
