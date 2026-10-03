/**
 * **X-R02 独立参考矩阵**（Excel 备用包；公式/函数参考矩阵、日期体系、舍入、错误值）。
 *
 * ## 为什么是"独立参考"，而不是"再抄一遍实现"
 *
 * 本仓的求值层（`src/spreadsheets/evaluate.ts`、`functions.ts`）已经带**自身**单元测试。
 * 那些用例与实现共享同一套语义假设，因此**实现错了、用例也跟着错**（"自身缓存"证自身），
 * 这是 X04 验收明文禁止的失效模式："手机实际算，使用**独立预期值**，不只验证自身缓存"。
 *
 * 本模块（位于 `tests/mobile-office/spreadsheets/X-R02/` 且**不 import 任何 `src/` 代码**）
 * 用**另一条路径**独立算出预期值，供 `reference-matrix.test.ts` 与被测内核逐例比对：
 *
 * 1. **日期体系**：用 Howard Hinnant 的 `days_from_civil` / `civil_from_days` 整数算法
 *    （以 1970-01-01 为 0）独立算"某公历日到今天的天数"，再加 Excel 常数 `25569` 得到
 *    1900 日期系统序列号。这与 `excel-date.ts` 的"epoch 毫秒差除以一天毫秒数"是**两套
 *    完全不同的算式**（整数日历 vs 浮点毫秒），二者的吻合才是有意义的交叉验证。
 * 2. **舍入**：`roundHalfAwayFromZero` 以**精确十进制串 + BigInt 进位**独立实现
 *    "四舍五入远离零"，并另备一张**手写 Excel 真值表**（不经任何算法），双保险。
 * 3. **错误值**：封闭枚举 + 传播规则表，独立于 `value.ts` 的常量。
 * 4. **函数参考矩阵**：每个受支持函数的**元数据**（最小/最大实参、类别）与**示例期望**
 *    （期望值由 Excel 语义手工推导，不取内核返回值）。
 *
 * ## 覆盖/边界（如实登记，不假装完整）
 *
 * - 已覆盖：日期序列号（正/负/带时刻、1900 闰年边界、往返）、ROUND（正负、随机位数、
 *   越界位数）、7 个错误码及其构造/传播、23 个受支持函数的元数据与点样本。
 * - **未覆盖**（不在本包，留给 X03/X04 及主包）：数组/动态数组函数、日期/时间**显示**
 *   格式渲染、区域级聚合的完整边界、跨表命名引用、循环引用。
 *
 * 本文件零 `src/` 依赖、零墙钟、零随机：同一输入必得同一输出。
 */

// ---------------------------------------------------------------------------
// (b) 操作 schema / 类型
// ---------------------------------------------------------------------------

/** 参考矩阵一行的**期望结果**（判别联合；`blocked` 表示本仓有意阻塞，不是"算出个近似值"）。 */
export type ReferenceExpectation =
  | { readonly outcome: 'number'; readonly value: number }
  | { readonly outcome: 'text'; readonly value: string }
  | { readonly outcome: 'boolean'; readonly value: boolean }
  | { readonly outcome: 'error'; readonly code: SpreadsheetErrorCodeRef }
  | { readonly outcome: 'blocked'; readonly reason: string };

/** 电子表格错误值代码（**封闭枚举**；与 Excel / 本仓 `value.ts` 同一集合）。 */
export type SpreadsheetErrorCodeRef =
  | '#NULL!'
  | '#DIV/0!'
  | '#VALUE!'
  | '#REF!'
  | '#NAME?'
  | '#NUM!'
  | '#N/A';

/** 与错误值交集无关的独立枚举（顺序无关，只用于"集合相等"判定）。 */
export const REF_ERROR_CODES: readonly SpreadsheetErrorCodeRef[] = Object.freeze([
  '#NULL!',
  '#DIV/0!',
  '#VALUE!',
  '#REF!',
  '#NAME?',
  '#NUM!',
  '#N/A',
]);

/** 一个受支持函数的参考行。 */
export interface FunctionReferenceRow {
  readonly name: string;
  /** 本仓声明的**最小**实参数（独立记录，供与内核 spec 交叉核对）。 */
  readonly min_args: number;
  /** 本仓声明的**最大**实参数；`Number.POSITIVE_INFINITY` = 可变长。 */
  readonly max_args: number;
  /** 核心白名单（evaluate.ts）还是扩展（functions.ts）。 */
  readonly kind: 'core' | 'extended';
  readonly category: string;
  /** 点样本公式（**不含**前导 `=`）。 */
  readonly example: string;
  /** 该样本的独立期望（`blocked` 也在此登记，例如 TODAY() 缺 today_serial）。 */
  readonly expected: ReferenceExpectation;
}

// ---------------------------------------------------------------------------
// 1. 日期体系：Hinnant 整数日历算法（独立于 excel-date.ts 的毫秒算式）
// ---------------------------------------------------------------------------

/** 1970-01-01 的 Excel 1900 日期系统序列号（Excel 常量，可查证）。 */
export const EXCEL_SERIAL_EPOCH_1970 = 25569;

/**
 * `days_from_civil`：公历 (y, m, d) → 距 1970-01-01 的天数（1970-01-01 = 0）。
 *
 * Howard Hinnant 的经典算法（*chrono-Compatible Low-Level Date Algorithms*），
 * 纯整数、有效范围 `-32768..32767` 年，且对**本仓语义之外**的 1900-02-29 也有确定结果
 * （它按真实公历，1900 非闰年）。这正是我们要的：一台"真日历"用来和 Excel 的怪历对照。
 */
export function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400; // [0, 399]
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1; // [0, 365]
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy; // [0, 146096]
  return era * 146097 + doe - 719468;
}

/** 公历日 → Excel 1900 日期系统序列号（**整数**，Excel 语义；1900-03-01 起与 Excel 逐日一致）。 */
export function excelSerialFromCivil(y: number, m: number, d: number): number {
  return daysFromCivil(y, m, d) + EXCEL_SERIAL_EPOCH_1970;
}

/**
 * 公历日期 **+ 当天时刻** → Excel 序列号（含小数）。
 *
 * `hourMs` 为当日 0 点起的毫秒数；`fraction = hourMs / 86400000`。
 * 独立日期 + 独立时刻换算，不经过任何 `Date` 对象。
 */
export function excelSerialFromCivilTime(y: number, m: number, d: number, hourMs: number): number {
  return excelSerialFromCivil(y, m, d) + hourMs / 86_400_000;
}

/**
 * 独立日历日 → epoch 毫秒（UTC），用于与 `fromExcelSerial` 交叉核对。
 * 与 `excel-date.ts` 的"原点 1899-12-30 + 秒数乘回"是**不同算式**。
 */
export function epochMsFromCivil(y: number, m: number, d: number, hourMs = 0): number {
  return daysFromCivil(y, m, d) * 86_400_000 + hourMs;
}

/**
 * 本仓（以及 Excel 现代部分）日期序列号的**有效下界**：1900-03-01 = 序列号 61。
 *
 * 序列号 < 61 落在 Excel 那个著名的"1900 闰年 bug"窗口（Excel 把 1900-02-29 也排了一天），
 * 本仓已**文档化**为有意偏离：不伪造差 1 天的序列号。因此参考矩阵只在该窗口之外要求逐日一致。
 */
export const EXCEL_LEAP_BUG_BOUNDARY = excelSerialFromCivil(1900, 3, 1); // === 61

// ---------------------------------------------------------------------------
// 2. 舍入：精确十进制 + BigInt 进位，独立实现 half-away-from-zero
// ---------------------------------------------------------------------------

/** 把 `Number.prototype.toString` 的最短往返十进制串展开成"纯十进制"（无指数）。 */
function expandPlainDecimal(input: string): { negative: boolean; integer: string; fraction: string } {
  let s = input;
  let negative = false;
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  let mantissa = s;
  let exponent = 0;
  const e = s.indexOf('e');
  if (e !== -1) {
    mantissa = s.slice(0, e);
    exponent = Number.parseInt(s.slice(e + 1), 10);
  }
  let [integerPart = '', fractionPart = ''] = mantissa.split('.');
  // 指数把小数点右移 / 左移；统一成"整数部分 + 小数部分"。
  if (exponent > 0) {
    const move = Math.min(exponent, fractionPart.length);
    integerPart += fractionPart.slice(0, move);
    fractionPart = fractionPart.slice(move);
    integerPart += '0'.repeat(exponent - move);
  } else if (exponent < 0) {
    const shift = -exponent;
    const move = Math.min(shift, integerPart.length);
    fractionPart = integerPart.slice(integerPart.length - move) + fractionPart;
    integerPart = integerPart.slice(0, integerPart.length - move);
    fractionPart = '0'.repeat(shift - move) + fractionPart;
  }
  if (integerPart === '') integerPart = '0';
  return { negative, integer: integerPart, fraction: fractionPart };
}

/**
 * `roundHalfAwayFromZero(value, digits)`：按**十进制字面量**四舍五入远离零，返回数值。
 *
 * 与 `src/.../xml.ts::formatDecimal` 是**并列的独立实现**（不 import 它）：先用
 * 最短往返十进制串拿到精确展开，再用 BigInt 判"被丢弃部分是否 ≥ 半个单位"，进位。
 * 关键点与 Excel 的 ROUND 同口径：末位恰为 5 时**远离零**（2.5→3、-2.5→-3），
 * 而不是 IEEE-754 默认的"银行家舍入"（2.5 会变 2）。
 *
 * @param digits 小数位数，`0…20`。
 */
export function roundHalfAwayFromZero(value: number, digits: number): number {
  if (!Number.isFinite(value)) throw new Error(`roundHalfAwayFromZero 只接受有限数：${String(value)}`);
  if (!Number.isInteger(digits) || digits < 0 || digits > 20) {
    throw new Error(`位数必须是 0…20 的整数：${String(digits)}`);
  }
  const { negative, integer, fraction } = expandPlainDecimal(String(value));
  const keptFraction = fraction.slice(0, digits).padEnd(digits, '0');
  const dropped = fraction.slice(digits);
  let scaled = BigInt(integer + keptFraction); // 已缩放到 digits 位的整数（非负）
  // 被丢弃部分：首位 ≥ 5 ⇒ 进位（这就是 half away from zero 的判定点，只看字面量）。
  const firstDropped = dropped.charAt(0);
  if (firstDropped !== '' && Number(firstDropped) >= 5) {
    scaled += 1n;
  }
  const sign = negative && scaled !== 0n ? -1 : 1;
  const result = sign * Number(scaled) / 10 ** digits;
  return result === 0 ? 0 : result; // 消除 -0
}

// ---------------------------------------------------------------------------
// 3. 错误值传播规则（独立表格）
// ---------------------------------------------------------------------------

/** 算术错误值传播：任一操作数是错误值 ⇒ 该错误值原样成为结果（Excel 语义）。 */
export function propagateArithmetic(left: SpreadsheetErrorCodeRef | null, right: SpreadsheetErrorCodeRef | null): SpreadsheetErrorCodeRef | null {
  return left ?? right ?? null;
}

// ---------------------------------------------------------------------------
// 4. 函数参考矩阵（元数据 + 手工推导的点样本）
// ---------------------------------------------------------------------------

/**
 * 函数参考矩阵。**每个受支持函数一行**；`expected` 是 Excel 语义下的手工预期，
 * 不是从内核读回来的值。测试会：
 *   (a) 断言该矩阵覆盖 `ALL_SUPPORTED_FUNCTIONS`（集合相等，无遗漏、无多余）；
 *   (b) 断言扩展函数的 `min_args`/`max_args` 与内核 `EXTENDED_FUNCTION_SPECS` 一致；
 *   (c) 逐个求值 `example` 并与 `expected` 比对。
 */
export const FUNCTION_REFERENCE_MATRIX: readonly FunctionReferenceRow[] = Object.freeze([
  // --- 核心白名单（evaluate.ts） ---
  { name: 'SUM', min_args: 1, max_args: Number.POSITIVE_INFINITY, kind: 'core', category: 'aggregate', example: 'SUM(1,2,3)', expected: { outcome: 'number', value: 6 } },
  { name: 'AVERAGE', min_args: 1, max_args: Number.POSITIVE_INFINITY, kind: 'core', category: 'aggregate', example: 'AVERAGE(2,4,6)', expected: { outcome: 'number', value: 4 } },
  { name: 'MIN', min_args: 1, max_args: Number.POSITIVE_INFINITY, kind: 'core', category: 'aggregate', example: 'MIN(3,1,2)', expected: { outcome: 'number', value: 1 } },
  { name: 'MAX', min_args: 1, max_args: Number.POSITIVE_INFINITY, kind: 'core', category: 'aggregate', example: 'MAX(3,1,2)', expected: { outcome: 'number', value: 3 } },
  { name: 'COUNT', min_args: 1, max_args: Number.POSITIVE_INFINITY, kind: 'core', category: 'aggregate', example: 'COUNT(1,"x",3)', expected: { outcome: 'number', value: 2 } },
  { name: 'COUNTA', min_args: 1, max_args: Number.POSITIVE_INFINITY, kind: 'core', category: 'aggregate', example: 'COUNTA(1,"x",3)', expected: { outcome: 'number', value: 3 } },
  { name: 'IF', min_args: 2, max_args: 3, kind: 'core', category: 'logic', example: 'IF(1=1,"yes","no")', expected: { outcome: 'text', value: 'yes' } },
  { name: 'AND', min_args: 1, max_args: Number.POSITIVE_INFINITY, kind: 'core', category: 'logic', example: 'AND(TRUE,1)', expected: { outcome: 'boolean', value: true } },
  { name: 'OR', min_args: 1, max_args: Number.POSITIVE_INFINITY, kind: 'core', category: 'logic', example: 'OR(FALSE,1)', expected: { outcome: 'boolean', value: true } },
  { name: 'NOT', min_args: 1, max_args: 1, kind: 'core', category: 'logic', example: 'NOT(FALSE)', expected: { outcome: 'boolean', value: true } },
  { name: 'ABS', min_args: 1, max_args: 1, kind: 'core', category: 'math', example: 'ABS(-3)', expected: { outcome: 'number', value: 3 } },
  { name: 'ROUND', min_args: 1, max_args: 2, kind: 'core', category: 'math', example: 'ROUND(2.675,2)', expected: { outcome: 'number', value: 2.68 } },
  { name: 'SQRT', min_args: 1, max_args: 1, kind: 'core', category: 'math', example: 'SQRT(-1)', expected: { outcome: 'error', code: '#NUM!' } },
  // --- 扩展（functions.ts） ---
  { name: 'IFERROR', min_args: 2, max_args: 2, kind: 'extended', category: 'logic', example: 'IFERROR(1/0,"fallback")', expected: { outcome: 'text', value: 'fallback' } },
  { name: 'SUMIF', min_args: 2, max_args: 3, kind: 'extended', category: 'conditional', example: 'SUMIF(C1:C3,"x",A1:A3)', expected: { outcome: 'number', value: 4 } },
  { name: 'SUMIFS', min_args: 3, max_args: Number.POSITIVE_INFINITY, kind: 'extended', category: 'conditional', example: 'SUMIFS(A1:A3,C1:C3,"x")', expected: { outcome: 'number', value: 4 } },
  { name: 'COUNTIF', min_args: 2, max_args: 2, kind: 'extended', category: 'conditional', example: 'COUNTIF(C1:C3,"x")', expected: { outcome: 'number', value: 2 } },
  { name: 'COUNTIFS', min_args: 2, max_args: Number.POSITIVE_INFINITY, kind: 'extended', category: 'conditional', example: 'COUNTIFS(C1:C3,"x",A1:A3,">0")', expected: { outcome: 'number', value: 2 } },
  { name: 'VLOOKUP', min_args: 3, max_args: 4, kind: 'extended', category: 'lookup', example: 'VLOOKUP(2,A1:B3,2,FALSE)', expected: { outcome: 'number', value: 20 } },
  { name: 'INDEX', min_args: 2, max_args: 3, kind: 'extended', category: 'lookup', example: 'INDEX(A1:B3,2,2)', expected: { outcome: 'number', value: 20 } },
  { name: 'MATCH', min_args: 2, max_args: 3, kind: 'extended', category: 'lookup', example: 'MATCH(2,A1:A3,0)', expected: { outcome: 'number', value: 2 } },
  { name: 'LEFT', min_args: 1, max_args: 2, kind: 'extended', category: 'text', example: 'LEFT("hello",2)', expected: { outcome: 'text', value: 'he' } },
  { name: 'RIGHT', min_args: 1, max_args: 2, kind: 'extended', category: 'text', example: 'RIGHT("hello",2)', expected: { outcome: 'text', value: 'lo' } },
  { name: 'MID', min_args: 3, max_args: 3, kind: 'extended', category: 'text', example: 'MID("hello",2,3)', expected: { outcome: 'text', value: 'ell' } },
  { name: 'LEN', min_args: 1, max_args: 1, kind: 'extended', category: 'text', example: 'LEN("hello")', expected: { outcome: 'number', value: 5 } },
  { name: 'CONCAT', min_args: 1, max_args: Number.POSITIVE_INFINITY, kind: 'extended', category: 'text', example: 'CONCAT("a",1,"b")', expected: { outcome: 'text', value: 'a1b' } },
  { name: 'TEXT', min_args: 2, max_args: 2, kind: 'extended', category: 'text', example: 'TEXT(1234.5,"#,##0.00")', expected: { outcome: 'text', value: '1,234.50' } },
  { name: 'YEAR', min_args: 1, max_args: 1, kind: 'extended', category: 'date', example: 'YEAR(43831)', expected: { outcome: 'number', value: 2020 } },
  { name: 'MONTH', min_args: 1, max_args: 1, kind: 'extended', category: 'date', example: 'MONTH(43831)', expected: { outcome: 'number', value: 1 } },
  { name: 'DAY', min_args: 1, max_args: 1, kind: 'extended', category: 'date', example: 'DAY(43831)', expected: { outcome: 'number', value: 1 } },
  { name: 'DATE', min_args: 3, max_args: 3, kind: 'extended', category: 'date', example: 'DATE(2020,1,1)', expected: { outcome: 'number', value: 43831 } },
  { name: 'TODAY', min_args: 0, max_args: 0, kind: 'extended', category: 'date', example: 'TODAY()', expected: { outcome: 'blocked', reason: 'unsupported_construct' } },
] as readonly FunctionReferenceRow[]);

/**
 * 手写 Excel 真值表（不经任何算法，纯查表）。
 *
 * 来源：Excel 的 ROUND 采用"四舍五入远离零"，且**按十进制字面量**判定，
 * 因此 `ROUND(2.675,2)=2.68`、`ROUND(1.005,2)=1.01`（不是二进制近似会得到的 2.67 / 1.00）。
 * 这是与 `roundHalfAwayFromZero` 并列的第二条独立通道（一个是算法、一个是常量表）。
 */
export const ROUND_TRUTH_TABLE: readonly (readonly [number, number, number])[] = Object.freeze([
  [2.5, 0, 3],
  [-2.5, 0, -3],
  [0.5, 0, 1],
  [-0.5, 0, -1],
  [1.5, 0, 2],
  [3.5, 0, 4],
  [2.4, 0, 2],
  [2.6, 0, 3],
  [2.675, 2, 2.68],
  [1.005, 2, 1.01],
  [3.14159, 2, 3.14],
  [3.14159, 4, 3.1416],
  [123.456, 1, 123.5],
  [-123.456, 1, -123.5],
  [0.049, 1, 0],
  [0.05, 1, 0.1],
]);

/** 日期锚点真值表（Excel 序列号；可查证）。`[y,m,d,serial]`。 */
export const DATE_ANCHORS: readonly (readonly [number, number, number, number])[] = Object.freeze([
  [1970, 1, 1, 25569],
  [2000, 1, 1, 36526],
  [2020, 1, 1, 43831],
  [2023, 1, 1, 44927],
  [1900, 3, 1, 61],
  [2099, 12, 31, 73050], // 与 Excel 的已知锚点一致（1900 系统）
]);
