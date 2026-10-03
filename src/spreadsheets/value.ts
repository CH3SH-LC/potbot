/**
 * 表格域：单元格取值模型（design-06-P8 / XLS-03；合同 R248、R250）。
 *
 * ## 这个文件要回答的唯一问题
 *
 * **"一个单元格里到底是什么？"** XLS-03 要求数值 / 文本 / 日期 / 布尔 / 空值 / 错误值**互相不冒充**。
 * 这里用**判别联合**把这件事变成类型系统的事：`CellValue` 的六个分支各有自己的判别标签，
 * 因此"把文本当数值"或"把缺失当零"在本模块里**连写都写不出来**，而不是靠调用方自觉。
 *
 * ## R248「缺失不当零」在本模块的形状
 *
 * `BlankValue` 是**六类之一**，不是"null 或 0 的口头约定"。想从空白格取一个数，唯一入口是
 * {@link requireNumericValue}——它对空白格**抛 `ValidationError`**，永不返回 0。
 * 这是与 `src/artifacts/templates/xlsx.ts` 单元格级纵深防御同口径的做法：**缺失必须显式失败**。
 *
 * ## 关于日期
 *
 * `DateValue` 只存 **epoch 毫秒（数字）**，本模块不做任何日历换算、不读墙钟。
 * 这是确定性要求（同一输入必得同一结果）与内核纪律（`src/**` 零墙钟）的直接后果。
 * 日期值之所以与数值值**不同类**，是因为 Excel 里二者虽同为"数"，但显示、比较与
 * 序列化口径不同（XLS-05「显示值与实际值分别验收」）——分类信息必须活到序列化为止。
 */

import { ValidationError } from '../protocol/index.js';

/**
 * 电子表格的错误值（XLS-08「错误值」的封闭枚举）。
 *
 * 与"空白"是**两回事**：空白是"没有值"，错误值是"有值，但那个值是错误"。
 * 混同二者会把一次失败的计算静默变成一格空白。
 */
export type SpreadsheetErrorCode =
  | '#NULL!'
  | '#DIV/0!'
  | '#VALUE!'
  | '#REF!'
  | '#NAME?'
  | '#NUM!'
  | '#N/A';

/** 全部错误值代码（供校验与用例遍历，顺序即枚举顺序）。 */
export const SPREADSHEET_ERROR_CODES: readonly SpreadsheetErrorCode[] = Object.freeze([
  '#NULL!',
  '#DIV/0!',
  '#VALUE!',
  '#REF!',
  '#NAME?',
  '#NUM!',
  '#N/A',
]);

/**
 * **现代** Excel（动态数组 / `_xlfn` 家族）写出的错误值代码（X-I03 / X-R01）。
 *
 * 这九个代码是"读真实世界文件"的能力边界：一个只含 `#SPILL!` 的工作表若被当作未知枚举拒绝，
 * 整份工作簿就读不进来。它们与上面的 7 个经典代码**分属两个名字**，不是一件事：
 *
 * - {@link SPREADSHEET_ERROR_CODES} 保持**恰好 7 个经典代码**——X-R02 的「封闭枚举集合相等」判据
 *   直接依赖这个长度，**不得扩容**；
 * - {@link MODERN_EXCEL_ERROR_CODES} 是读侧额外认得的现代代码；
 * - {@link ALL_SPREADSHEET_ERROR_CODES} 是两者的并集，是"本模块认得哪些错误码"的**唯一口径**。
 *
 * 注意：`SpreadsheetErrorCode`（7 个经典）作为**类型名**保持不变；能装下现代码的宽类型是
 * {@link AnySpreadsheetErrorCode}。这是"保留旧名、另加宽口径"而不是"改旧名"。
 */
export type ModernSpreadsheetErrorCode =
  | '#SPILL!'
  | '#CALC!'
  | '#GETTING_DATA'
  | '#FIELD!'
  | '#UNKNOWN!'
  | '#CONNECT!'
  | '#BLOCKED!'
  | '#BUSY!'
  | '#PYTHON!';

/** 全部现代错误值代码（供校验与用例遍历，顺序即枚举顺序）。 */
export const MODERN_EXCEL_ERROR_CODES: readonly ModernSpreadsheetErrorCode[] = Object.freeze([
  '#SPILL!',
  '#CALC!',
  '#GETTING_DATA',
  '#FIELD!',
  '#UNKNOWN!',
  '#CONNECT!',
  '#BLOCKED!',
  '#BUSY!',
  '#PYTHON!',
]);

/** 本模块认得的**全部**错误码：7 个经典 + 现代码（并集，是"认得哪些"的唯一口径）。 */
export type AnySpreadsheetErrorCode = SpreadsheetErrorCode | ModernSpreadsheetErrorCode;

/** 全部错误码（经典 + 现代）。校验一律走这个并集，不要只查 7 个经典。 */
export const ALL_SPREADSHEET_ERROR_CODES: readonly AnySpreadsheetErrorCode[] = Object.freeze([
  ...SPREADSHEET_ERROR_CODES,
  ...MODERN_EXCEL_ERROR_CODES,
]);

/** 是否是现代（读侧）错误码。 */
export function isModernSpreadsheetErrorCode(code: unknown): code is ModernSpreadsheetErrorCode {
  return typeof code === 'string' && (MODERN_EXCEL_ERROR_CODES as readonly string[]).includes(code);
}

/** 是否是本模块认得（经典或现代）的错误码。 */
export function isSpreadsheetErrorCode(code: unknown): code is AnySpreadsheetErrorCode {
  return typeof code === 'string' && (ALL_SPREADSHEET_ERROR_CODES as readonly string[]).includes(code);
}

/** 数值单元格。 */
export interface NumberValue {
  readonly kind: 'number';
  readonly value: number;
}

/** 文本单元格。 */
export interface TextValue {
  readonly kind: 'text';
  readonly value: string;
}

/** 布尔单元格。 */
export interface BooleanValue {
  readonly kind: 'boolean';
  readonly value: boolean;
}

/** 日期单元格（epoch 毫秒；本模块不做时区/日历换算）。 */
export interface DateValue {
  readonly kind: 'date';
  readonly epoch_ms: number;
}

/** 空白单元格（无值）。**不是零，也不是空字符串。** */
export interface BlankValue {
  readonly kind: 'blank';
}

/**
 * 错误值单元格。
 *
 * `code` 是 {@link AnySpreadsheetErrorCode}（经典 7 + 现代 9）：读侧从真实文件读到的 `#SPILL!`
 * 等现代代码**也是一等错误值**，不再靠"绕过枚举的类型断言"硬塞进来。
 */
export interface ErrorValue {
  readonly kind: 'error';
  readonly code: AnySpreadsheetErrorCode;
}

/**
 * 公式单元格（XLS-06：**保存的是可编辑公式**）。
 *
 * `text` 是公式原文（不含前缀 `=`）。**本模块不缓存求值结果、不做重算**——
 * XLS-08 的「缓存和公式一致」属后续增量；在那之前，"公式的当前值"这件事在本模块里
 * **不存在**，因此不存在"用一个过期的缓存冒充结果"的可能。
 */
export interface FormulaValue {
  readonly kind: 'formula';
  readonly text: string;
}

/** 单元格取值：六类（外加公式）判别联合。 */
export type CellValue =
  | NumberValue
  | TextValue
  | BooleanValue
  | DateValue
  | BlankValue
  | ErrorValue
  | FormulaValue;

/** 单元格取值的类别名（用于诊断与用例断言）。 */
export type CellValueKind = CellValue['kind'];

/** 空白单元格单例（冻结；空白没有状态，不需要每次新建）。 */
export const blank: BlankValue = Object.freeze({ kind: 'blank' as const });

/** 构造数值单元格。@throws {ValidationError} 非有限数（NaN / ±Infinity 无法写进电子表格）。 */
export function numberValue(value: number): NumberValue {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`numberValue 只接受有限数，收到 ${String(value)}`);
  }
  return Object.freeze({ kind: 'number' as const, value });
}

/** 构造文本单元格。 */
export function textValue(value: string): TextValue {
  if (typeof value !== 'string') {
    throw new ValidationError('textValue 只接受字符串');
  }
  return Object.freeze({ kind: 'text' as const, value });
}

/** 构造布尔单元格。 */
export function booleanValue(value: boolean): BooleanValue {
  if (typeof value !== 'boolean') {
    throw new ValidationError('booleanValue 只接受布尔值');
  }
  return Object.freeze({ kind: 'boolean' as const, value });
}

/** 构造日期单元格（epoch 毫秒）。@throws {ValidationError} 非有限数。 */
export function dateValue(epochMs: number): DateValue {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) {
    throw new ValidationError(`dateValue 只接受有限毫秒数，收到 ${String(epochMs)}`);
  }
  return Object.freeze({ kind: 'date' as const, epoch_ms: epochMs });
}

/**
 * 构造错误值单元格。接受经典与现代代码（{@link ALL_SPREADSHEET_ERROR_CODES} 的并集）。
 * @throws {ValidationError} 未知错误码（既不在经典 7 个，也不在现代 9 个之内）
 */
export function errorValue(code: AnySpreadsheetErrorCode): ErrorValue {
  if (!(ALL_SPREADSHEET_ERROR_CODES as readonly string[]).includes(code as string)) {
    throw new ValidationError(`未知的电子表格错误值：${JSON.stringify(code)}`);
  }
  return Object.freeze({ kind: 'error' as const, code });
}

/** 构造公式单元格。空公式文本非法。@throws {ValidationError} */
export function formulaValue(text: string): FormulaValue {
  if (typeof text !== 'string' || text.length === 0) {
    throw new ValidationError('formulaValue 的公式文本不能为空');
  }
  return Object.freeze({ kind: 'formula' as const, text });
}

/** 类别名（诊断 / 用例断言用）。 */
export function cellTypeName(value: CellValue): CellValueKind {
  return value.kind;
}

/** 是否空白单元格。 */
export function isBlank(value: CellValue): value is BlankValue {
  return value.kind === 'blank';
}

/** 是否错误值单元格。 */
export function isError(value: CellValue): value is ErrorValue {
  return value.kind === 'error';
}

/** 是否公式单元格。 */
export function isFormula(value: CellValue): value is FormulaValue {
  return value.kind === 'formula';
}

/** 是否数值单元格（**公式不算**：公式的当前值在本模块里不存在）。 */
export function isNumericCell(value: CellValue): value is NumberValue {
  return value.kind === 'number';
}

/**
 * 取一个单元格的**数值**，用于计算。**这是"缺失不当零"的执行点。**
 *
 * - `number` ⇒ 返回其数值；
 * - `blank` ⇒ **抛 `ValidationError`**（R248：缺失必须显式失败，**绝不返回 0**）；
 * - `error` ⇒ 抛（错误值不是数）；
 * - `text` / `boolean` / `date` / `formula` ⇒ 抛（不得冒充数值；日期与布尔的强制转换
 *   属后续增量的显式规则，不在模型骨架里偷偷做）。
 *
 * @throws {ValidationError}
 */
export function requireNumericValue(value: CellValue, where?: string): number {
  if (value.kind === 'number') {
    return value.value;
  }
  const at = where === undefined ? '' : `（${where}）`;
  if (value.kind === 'blank') {
    throw new ValidationError(
      `空白单元格${at}不得当作 0：缺失必须显式失败（R248），不得静默取默认值`,
    );
  }
  if (value.kind === 'error') {
    throw new ValidationError(`单元格${at}是错误值 ${value.code}，不是数值`);
  }
  throw new ValidationError(`单元格${at}的类别是 ${value.kind}，不得冒充数值`);
}

/**
 * 单元格取值的严格相等：**类别不同即不等**，即使字面量看起来一样。
 *
 * `number 1` ≠ `text "1"` ≠ `boolean true`；`blank` 只等于 `blank`；
 * 两个 `error` 相等当且仅当错误码相同；两个 `date` 按毫秒数相等。
 * 这正是不用 `===` / `==` 而单独提供本函数的原因：JS 的宽松相等会把
 * `"1" == 1` 判真，那会让"类型区分"这条判据在用例里假绿。
 */
export function valuesEqual(a: CellValue, b: CellValue): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  switch (a.kind) {
    case 'number':
      return a.value === (b as NumberValue).value;
    case 'text':
      return a.value === (b as TextValue).value;
    case 'boolean':
      return a.value === (b as BooleanValue).value;
    case 'date':
      return a.epoch_ms === (b as DateValue).epoch_ms;
    case 'error':
      return a.code === (b as ErrorValue).code;
    case 'formula':
      return a.text === (b as FormulaValue).text;
    case 'blank':
      return true;
    default: {
      // 穷尽性检查：新增类别而漏改本函数时这里会编译失败。
      const never: never = a;
      throw new ValidationError(`valuesEqual 未覆盖的类别：${JSON.stringify(never)}`);
    }
  }
}
