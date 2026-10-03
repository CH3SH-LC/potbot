/**
 * 表格域：**常用函数库**（design-06-P8 / XLS-07）。
 *
 * ## 与 `evaluate.ts` 的分工：**复用，不分叉**
 *
 * `evaluate.ts` 已经是一个**完整的受限子集求值器**（词法 → 语法 → 求值 + 工作簿级驱动），
 * 但它的函数白名单是**封闭常量**（`SUPPORTED_FUNCTIONS`，13 个）。XLS-07 要求在
 * SUM/AVERAGE/…/IF 之外再覆盖：条件聚合（SUMIF(S) / COUNTIF(S)）、常用查找
 * （VLOOKUP / INDEX / MATCH）、文本（LEFT/RIGHT/MID/LEN/CONCAT/TEXT）、日期
 * （YEAR/MONTH/DAY/DATE/TODAY）、以及 IFERROR。
 *
 * 本文件**不复制** `evaluate.ts` 的任何语义。做法是：
 *
 * 1. 用 `parseFormula`（`formula-parse.ts`，与 `evaluate.ts` 同一棵树）拿 AST；
 * 2. 对**不含扩展函数**的子树，把它按**保序括号化**打印回文本，交给
 *    `evaluateFormula` 求值——运算符优先级、`^` 右结合、一元负号怪癖、
 *    `#DIV/0!`、`#NUM!`、`&` 连接、比较、聚合跳过空白、R248「缺失不当零」、
 *    错误值传播、乃至 `unsupported_function` 阻塞，**全部来自 `evaluate.ts` 本身**；
 * 3. 只有**扩展到的那几个函数**由本文件实现。
 *
 * 保序括号化（`binary → (左 OP 右)`、`unary → (OP 操作数)`）之所以安全，是因为
 * **每个复合节点都被括号包住**：AST 的结构在文本里被完整钉死，不会因优先级或
 * 结合性改变含义。`-2^2` 解析成 `binary(^, unary(-,2), 2)`，打印成 `((-2)^(2))`，
 * 回代后仍是同一个树、同一个结果（4）。本文件对此有专门用例，并且有一条
 * **差分对照**用例：对一批纯核心公式，`evaluateWithFunctions` 必须与
 * `evaluateFormula` 逐字同结论。
 *
 * ## XLS-07 的硬约束：**边界要写清，不支持的不得伪造**
 *
 * 每个扩展函数在 {@link EXTENDED_FUNCTION_SPECS} 里都有 `support`（支持什么）
 * 与 `boundary`（**不支持什么**）两句话。凡不在支持范围内的一律走
 * {@link EvalOutcome} 的 `ok: false`（阻塞）或 Excel 的**错误值**（`#N/A` / `#REF!` /
 * `#VALUE!` / `#NUM!`）——**没有任何"看起来像结果"的第三态**。
 *
 * 特别地：
 * - `VLOOKUP` **只做精确匹配**：第 4 参数缺省（Excel 默认近似匹配）或为 TRUE ⇒ 阻塞，
 *   **不降级成精确匹配**（那会把"没找到"变成"找到错的"）；
 * - `MATCH` **只支持 match_type = 0**（精确），缺省同样阻塞（Excel 缺省是 1 升序近似）；
 * - `TODAY()` 只有在调用方**显式注入当前日期**（`today_serial`）时才求值——
 *   内核纪律禁止读墙钟，读不到就阻塞，**不拿一个不确定的"今天"冒充结果**；
 * - `IFERROR` 只接**错误值**，**不吞阻塞**：一个"本仓不支持"的公式不会因为被
 *   IFERROR 包住就悄悄变成 fallback 值。
 *
 * ## 与 Excel 的**有意偏离**（如实登记，不静默）
 *
 * | 场景 | Excel | 本仓 | 理由 |
 * |---|---|---|---|
 * | `SUMIF`/`SUMIFS` 无匹配 | 0 | **阻塞** `empty_aggregate` | 与 `evaluate.ts` 的 `SUM` 空聚合同口径（R248） |
 * | `VLOOKUP`/`INDEX` 命中空白格 | 0 | **阻塞** `blank_operand` | R248：缺失不得当作 0 |
 * | `DATE` 落在 1900-03-01 之前 | 有值 | **阻塞** | `excel-date.ts` 已文档化的 1900 闰年边界，不伪造差 1 天的序列号 |
 * | `COUNTIF` 区域内含错误值 | 跳过 | 跳过（**登记为有意选择**） | 计数不因一个坏格制造错误；`SUMIF` 的**求和区**出错仍然传播 |
 * | 扩展函数出现在 `IF` 未选中的分支 | 不求值 | **不求值**（同上，`IF` 保持惰性） | 与 `evaluate.ts` 的 `IF` 同语义 |
 */

import { ValidationError } from '../protocol/index.js';
import { formatDecimal } from '../artifacts/ooxml/xml.js';
import {
  MAX_RANGE_CELLS,
  SUPPORTED_FUNCTIONS,
  evaluateFormula,
  type EvalOutcome,
  type FormulaContext,
  type FormulaEvalBlockReason,
  type ScalarValue,
} from './evaluate.js';
import { MS_PER_DAY, fromExcelSerial, toExcelSerial } from './excel-date.js';
import { FormulaParseError, parseFormula, type FormulaNode } from './formula-parse.js';
import { formatCellReference, type CellAddress } from './reference.js';
import { booleanValue, errorValue, numberValue, textValue, type CellValue, type ErrorValue } from './value.js';

/**
 * 扩展求值上下文：在 `evaluate.ts` 的 {@link FormulaContext} 之上，多一个**可选的显式当前日期**。
 *
 * 结构上仍是 `FormulaContext`（`evaluate.ts` 原样接受它），因此复用路径不需要任何适配。
 * `today_serial` 缺席 ⇒ `TODAY()` 阻塞（本仓不读墙钟）。
 */
export interface SpreadsheetFormulaContext extends FormulaContext {
  /** 当前日期的 Excel 序列号（**显式注入**，不读墙钟）。 */
  readonly today_serial?: number;
}

/** 一个扩展函数的能力声明：支持什么、**不支持什么**（XLS-07「明确边界」的机器可读形态）。 */
export interface ExtendedFunctionSpec {
  readonly name: string;
  readonly min_args: number;
  /** `Number.POSITIVE_INFINITY` 表示可变实参。 */
  readonly max_args: number;
  /** 一句话说明支持什么。 */
  readonly support: string;
  /** 一句话说明**不支持什么**（越界即阻塞或 Excel 错误值，绝不猜）。 */
  readonly boundary: string;
}

/**
 * 本文件新增的函数（**数值 / 语义与 `evaluate.ts` 的白名单互补，不重叠**）。
 *
 * 与 `SUPPORTED_FUNCTIONS` 的并集即 {@link ALL_SUPPORTED_FUNCTIONS}。
 */
export const EXTENDED_FUNCTIONS: readonly string[] = Object.freeze([
  'IFERROR',
  'SUMIF',
  'SUMIFS',
  'COUNTIF',
  'COUNTIFS',
  'VLOOKUP',
  'INDEX',
  'MATCH',
  'LEFT',
  'RIGHT',
  'MID',
  'LEN',
  'CONCAT',
  'TEXT',
  'YEAR',
  'MONTH',
  'DAY',
  'DATE',
  'TODAY',
]);

/** 全部支持函数（核心白名单 ∪ 扩展），排序后冻结，供诊断与文档。 */
export const ALL_SUPPORTED_FUNCTIONS: readonly string[] = Object.freeze(
  [...SUPPORTED_FUNCTIONS, ...EXTENDED_FUNCTIONS].sort(),
);

const EXTENDED_SET: ReadonlySet<string> = new Set(EXTENDED_FUNCTIONS);
const ALL_SUPPORTED_SET: ReadonlySet<string> = new Set(ALL_SUPPORTED_FUNCTIONS);

/** 逐函数的能力 / 边界声明（XLS-07 的"写清边界"落点）。 */
export const EXTENDED_FUNCTION_SPECS: readonly ExtendedFunctionSpec[] = Object.freeze([
  Object.freeze({
    name: 'IFERROR',
    min_args: 2,
    max_args: 2,
    support: '第一个实参求值为**错误值**时给出第二个实参的值；否则给出第一个实参的值。',
    boundary: '**不吞阻塞**：第一个实参若是"本仓不支持"的阻塞，阻塞照样向上传播，不会变成 fallback。',
  }),
  Object.freeze({
    name: 'SUMIF',
    min_args: 2,
    max_args: 3,
    support: '区间按条件筛选后对求和区（缺省即自身）求和；条件支持 = <> > >= < <=、数字、文本（大小写不敏感，支持 * ? 通配与 ~ 转义）。',
    boundary: '求和区必须与条件区**同尺寸**；无任何数值贡献时**阻塞**（不返回 0，与 SUM 空聚合同口径）。',
  }),
  Object.freeze({
    name: 'SUMIFS',
    min_args: 3,
    max_args: Number.POSITIVE_INFINITY,
    support: '多条件 AND：SUMIFS(求和区, 条件区1, 条件1, …)，实参个数为奇数且 ≥3。',
    boundary: '所有区间必须与求和区同尺寸；条件组必须是成对的区间+条件；无贡献时阻塞。',
  }),
  Object.freeze({
    name: 'COUNTIF',
    min_args: 2,
    max_args: 2,
    support: '数区间内满足条件的格子数；条件语义同 SUMIF。0 个匹配是**合法计数**（返回 0，不是"缺失的值"）。',
    boundary: '区域内错误值被跳过（不传播、不计入）；日期值不参与匹配。',
  }),
  Object.freeze({
    name: 'COUNTIFS',
    min_args: 2,
    max_args: Number.POSITIVE_INFINITY,
    support: '多条件 AND 计数：COUNTIFS(条件区1, 条件1, …)，实参个数为偶数且 ≥2。',
    boundary: '所有区间必须同尺寸；错误值被跳过；日期值不参与匹配。',
  }),
  Object.freeze({
    name: 'VLOOKUP',
    min_args: 3,
    max_args: 4,
    support: '**精确匹配**查表：在表格首列自上而下找第一个相等的值，返回该行第 col_index 列的值。第 4 参数须显式为 FALSE 或 0。',
    boundary: '**只支持精确匹配**——第 4 参数缺省或为 TRUE 一律阻塞（Excel 的近似匹配需要有序表与二分语义，本仓不猜）；文本匹配大小写不敏感并支持 * ? 通配；未找到返回 #N/A；col_index 超宽返回 #REF!；命中空白格阻塞（R248）。',
  }),
  Object.freeze({
    name: 'INDEX',
    min_args: 2,
    max_args: 3,
    support: 'INDEX(区间, 行号[, 列号])，1 起计数；单行 / 单列区间可只给一个下标。',
    boundary: '不支持下标 0（Excel 的"整行/整列"返回数组，本仓无数组）；二维区间必须显式给列号；越界返回 #REF!，下标 <1 返回 #VALUE!；命中空白格阻塞。',
  }),
  Object.freeze({
    name: 'MATCH',
    min_args: 2,
    max_args: 3,
    support: '**精确匹配**定位：MATCH(查找值, 单行或单列区间, 0) 返回 1 起的相对位置。',
    boundary: '**只支持 match_type = 0**——缺省（Excel 缺省为 1 升序近似）或 ±1 一律阻塞；区间必须是单行或单列；未找到返回 #N/A。',
  }),
  Object.freeze({
    name: 'LEFT',
    min_args: 1,
    max_args: 2,
    support: 'LEFT(文本[, 个数])，按 Unicode 码点取左起若干字符，个数缺省为 1，超过长度即全串。',
    boundary: '负个数返回 #VALUE!（自本仓的确定规则，不截断成 0 字）；个数按整数截断；非文本实参按 `&` 的同一套强制转换。',
  }),
  Object.freeze({
    name: 'RIGHT',
    min_args: 1,
    max_args: 2,
    support: 'RIGHT(文本[, 个数])，按 Unicode 码点取右起若干字符。',
    boundary: '同 LEFT：负个数 #VALUE!、整数截断、非文本按 `&` 口径转换。',
  }),
  Object.freeze({
    name: 'MID',
    min_args: 3,
    max_args: 3,
    support: 'MID(文本, 起始位置, 字符数)，位置 1 起，按 Unicode 码点截取；越界部分按可用长度返回。',
    boundary: '起始位置 <1 或字符数 <0 返回 #VALUE!；不做"越界自动纠正"。',
  }),
  Object.freeze({
    name: 'LEN',
    min_args: 1,
    max_args: 1,
    support: '文本长度，按 **Unicode 码点**计数（代理对记 1）。',
    boundary: '非文本实参按 `&` 口径转换；不接受区间。',
  }),
  Object.freeze({
    name: 'CONCAT',
    min_args: 1,
    max_args: Number.POSITIVE_INFINITY,
    support: '把全部实参（含区间展平）按 `&` 的口径转成文本后连接。',
    boundary: '实参里的空白格**阻塞**（与 `evaluate.ts` 的 `&` 同口径，R248）；错误值传播。',
  }),
  Object.freeze({
    name: 'TEXT',
    min_args: 2,
    max_args: 2,
    support: '按**数值格式**格式化：`0`、`0.0…`、`#,##0`、`#,##0.0…` 及其 `%` 变体（百分号版本自动 ×100）。',
    boundary: '**不支持日期/时间格式、多段（`;`）格式、颜色/条件段、`@` 文本段、`E+` 科学计数**——不在白名单的格式一律阻塞，不近似。',
  }),
  Object.freeze({
    name: 'YEAR',
    min_args: 1,
    max_args: 1,
    support: 'Excel 序列号 → 年（与 `excel-date.ts` 同一套序列号语义）。',
    boundary: '只接受**数值序列号**（本仓的求值层标量不含日期类型）；支持范围 1900-03-01…9999-12-31，越界返回 #NUM!。',
  }),
  Object.freeze({
    name: 'MONTH',
    min_args: 1,
    max_args: 1,
    support: 'Excel 序列号 → 月（1–12）。',
    boundary: '同 YEAR（范围与越界口径一致）。',
  }),
  Object.freeze({
    name: 'DAY',
    min_args: 1,
    max_args: 1,
    support: 'Excel 序列号 → 日（1–31）。',
    boundary: '同 YEAR（范围与越界口径一致）。',
  }),
  Object.freeze({
    name: 'DATE',
    min_args: 3,
    max_args: 3,
    support: 'DATE(年, 月, 日) → Excel 序列号（**数值**）；年 0–1899 按 Excel 规则加 1900；月 / 日溢出按下标滚动。',
    boundary: '结果是**序列号数值**（不产生日期类型，求值层标量里没有日期）；年 <0 或 >9999 返回 #NUM!；落点早于 1900-03-01 阻塞（`excel-date.ts` 已文档化的 1900 闰年边界）。',
  }),
  Object.freeze({
    name: 'TODAY',
    min_args: 0,
    max_args: 0,
    support: '返回调用方**显式注入**的当前日期序列号（`context.today_serial`）。',
    boundary: '未注入 ⇒ **阻塞**（本仓不读墙钟：内核纪律要求 `src/**` 零墙钟，读不到就不伪造"今天"）。',
  }),
]);

const SPEC_BY_NAME: ReadonlyMap<string, ExtendedFunctionSpec> = new Map(
  EXTENDED_FUNCTION_SPECS.map((spec) => [spec.name, spec]),
);

/** 查一个函数的支持 / 边界声明；核心函数返回 `undefined`（其语义在 `evaluate.ts`）。 */
export function functionSpec(name: string): ExtendedFunctionSpec | undefined {
  return SPEC_BY_NAME.get(name.toUpperCase());
}

/** 该函数名是否在**全部**支持清单内（核心 ∪ 扩展）。 */
export function isSupportedFunction(name: string): boolean {
  return ALL_SUPPORTED_SET.has(name.toUpperCase());
}

// ---------------------------------------------------------------------------
// 内部步进值（与 evaluate.ts 同构，但**不复用其内部类型**——那些未导出）
// ---------------------------------------------------------------------------

interface ScalarBox {
  readonly kind: 'scalar';
  readonly value: ScalarValue;
}

interface RangeBox {
  readonly kind: 'range';
  readonly sheet: string | null;
  readonly start: CellAddress;
  readonly end: CellAddress;
}

type Box = ScalarBox | RangeBox;

type Step =
  | { readonly ok: true; readonly box: Box }
  | { readonly ok: false; readonly reason: FormulaEvalBlockReason; readonly detail: string };

function blocked(reason: FormulaEvalBlockReason, detail: string): Step {
  return { ok: false, reason, detail };
}

function scalar(value: ScalarValue): Step {
  return { ok: true, box: { kind: 'scalar', value } };
}

/** 数值结果：非有限数（NaN / ±Infinity）→ `#NUM!`（与 `evaluate.ts` 的 `numberResult` 同口径）。 */
function numberResult(value: number): Step {
  return Number.isFinite(value) ? scalar(numberValue(value)) : scalar(errorValue('#NUM!'));
}

// ---------------------------------------------------------------------------
// 保序括号化打印（AST → 文本）
// ---------------------------------------------------------------------------

function quoteSheetName(name: string): string {
  return `'${name.split("'").join("''")}'`;
}

/**
 * AST → 文本。**每个复合节点都加括号**，因此打印结果与源树的语义严格相同。
 *
 * 这不是"美化输出"，而是复用 `evaluate.ts` 的桥：只有把子树还原成**无歧义**的文本，
 * 才能安全地把它交给 `evaluateFormula` 求值。
 */
function printNode(node: FormulaNode): string {
  switch (node.kind) {
    case 'number':
      return String(node.value);
    case 'text':
      return `"${node.value.split('"').join('""')}"`;
    case 'boolean':
      return node.value ? 'TRUE' : 'FALSE';
    case 'reference':
      return `${node.sheet === null ? '' : `${quoteSheetName(node.sheet)}!`}${formatCellReference(node.reference)}`;
    case 'range':
      return `${node.sheet === null ? '' : `${quoteSheetName(node.sheet)}!`}${formatCellReference(node.start)}:${formatCellReference(node.end)}`;
    case 'call':
      return `${node.name}(${node.args.map(printNode).join(',')})`;
    case 'unary':
      return `(${node.op}${printNode(node.operand)})`;
    case 'binary':
      return `(${printNode(node.left)}${node.op}${printNode(node.right)})`;
    default: {
      const never: never = node;
      throw new ValidationError(`打印器未覆盖的节点：${JSON.stringify(never)}`);
    }
  }
}

/** 标量 → 可回代解析的字面量文本（错误值**不能**这样表示，另行处理）。 */
function literalText(value: ScalarValue): string {
  switch (value.kind) {
    case 'number':
      return `(${String(value.value)})`;
    case 'text':
      return `("${value.value.split('"').join('""')}")`;
    case 'boolean':
      return value.value ? 'TRUE' : 'FALSE';
    case 'error':
      // 错误值无法写成字面量（`#N/A` 通不过本仓词法）⇒ `renderStep` 已把它分流成 `kind: 'error'`。
      /* c8 ignore next -- renderStep 保证不会带错误值走到这里 */
      throw new ValidationError(`错误值不该走到字面量打印：${value.code}`);
    default: {
      const never: never = value;
      throw new ValidationError(`字面量打印未覆盖：${JSON.stringify(never)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 扩展调用检测
// ---------------------------------------------------------------------------

function containsExtendedCall(node: FormulaNode): boolean {
  switch (node.kind) {
    case 'call':
      return EXTENDED_SET.has(node.name.toUpperCase()) || node.args.some(containsExtendedCall);
    case 'unary':
      return containsExtendedCall(node.operand);
    case 'binary':
      return containsExtendedCall(node.left) || containsExtendedCall(node.right);
    case 'range':
    case 'reference':
    case 'number':
    case 'text':
    case 'boolean':
      return false;
    default: {
      const never: never = node;
      throw new ValidationError(`扩展检测未覆盖的节点：${JSON.stringify(never)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 标量强制转换（与 `evaluate.ts` 的同名内部函数逐条对齐）
// ---------------------------------------------------------------------------

/** 数值位置：`number` ✅、`boolean` ✅（TRUE=1）、错误值传播、其余阻塞。 */
function requireNumber(
  value: ScalarValue,
  where: string,
): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly step: Step } {
  switch (value.kind) {
    case 'number':
      return { ok: true, value: value.value };
    case 'boolean':
      return { ok: true, value: value.value ? 1 : 0 };
    case 'error':
      return { ok: false, step: scalar(value) };
    default:
      return { ok: false, step: blocked('non_numeric_operand', `${where} 需要数值，收到 ${value.kind}（不隐式转换）`) };
  }
}

/** 布尔位置：`boolean` ✅、`number` ✅（0 为假）、错误值传播、其余阻塞。 */
function requireBoolean(
  value: ScalarValue,
  where: string,
): { readonly ok: true; readonly value: boolean } | { readonly ok: false; readonly step: Step } {
  switch (value.kind) {
    case 'boolean':
      return { ok: true, value: value.value };
    case 'number':
      return { ok: true, value: value.value !== 0 };
    case 'error':
      return { ok: false, step: scalar(value) };
    default:
      return { ok: false, step: blocked('non_numeric_operand', `${where} 需要布尔值，收到 ${value.kind}（不隐式转换）`) };
  }
}

/** 文本位置（`&` 口径）：`text` / `number` / `boolean` 可转，错误值传播。 */
function requireText(
  value: ScalarValue,
  where: string,
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly step: Step } {
  switch (value.kind) {
    case 'text':
      return { ok: true, value: value.value };
    case 'number':
      return { ok: true, value: String(value.value) };
    case 'boolean':
      return { ok: true, value: value.value ? 'TRUE' : 'FALSE' };
    default:
      // 错误值**传播**（与 `evaluate.ts` 的 `textOperand` 逐条对齐），不转成阻塞。
      return { ok: false, step: scalar(value) };
  }
}

// ---------------------------------------------------------------------------
// 区域展开 / 单元格取值 → 标量
// ---------------------------------------------------------------------------

function rangeShape(box: RangeBox): { readonly rows: number; readonly columns: number; readonly row_start: number; readonly column_start: number } {
  return {
    rows: Math.abs(box.end.row - box.start.row) + 1,
    columns: Math.abs(box.end.column - box.start.column) + 1,
    row_start: Math.min(box.start.row, box.end.row),
    column_start: Math.min(box.start.column, box.end.column),
  };
}

function describeRangeBox(box: RangeBox): string {
  const prefix = box.sheet === null ? '' : `${box.sheet}!`;
  return `${prefix}${box.start.column},${box.start.row}:${box.end.column},${box.end.row}`;
}

function expandRange(
  box: RangeBox,
  context: SpreadsheetFormulaContext,
): { readonly ok: true; readonly cells: readonly CellValue[] } | { readonly ok: false; readonly step: Step } {
  const shape = rangeShape(box);
  if (shape.rows * shape.columns > MAX_RANGE_CELLS) {
    return {
      ok: false,
      step: blocked('invalid_arguments', `区域 ${describeRangeBox(box)} 超过 ${String(MAX_RANGE_CELLS)} 格上限，拒绝展开`),
    };
  }
  const cells: CellValue[] = [];
  for (let row = shape.row_start; row < shape.row_start + shape.rows; row += 1) {
    for (let column = shape.column_start; column < shape.column_start + shape.columns; column += 1) {
      const resolved = context.resolveCell(box.sheet, { column, row });
      if (resolved.kind === 'blocked') {
        return { ok: false, step: blocked(resolved.reason, resolved.detail) };
      }
      cells.push(resolved.value);
    }
  }
  return { ok: true, cells };
}

/** 单元格取值 → 标量。空白 / 日期在这里阻塞（R248 + 不做隐式日期→序列号）。 */
function scalarFromCellValue(value: CellValue, where: string): Step {
  switch (value.kind) {
    case 'number':
    case 'text':
    case 'boolean':
    case 'error':
      return scalar(value);
    case 'date':
      return blocked('non_numeric_operand', `${where} 是日期值：本仓不做隐式 日期→序列号 转换`);
    case 'blank':
      return blocked('blank_operand', `${where} 是空白格：缺失不得当作 0（R248）`);
    case 'formula':
      return blocked('unsupported_construct', `${where} 是未求值的公式格`);
    default: {
      const never: never = value;
      throw new ValidationError(`取值转换未覆盖：${JSON.stringify(never)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 求值：核心子树交给 evaluate.ts，扩展调用留在本文件
// ---------------------------------------------------------------------------

type RenderOutcome =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'error'; readonly value: ErrorValue }
  | { readonly kind: 'blocked'; readonly step: Step };

/** 一个已求值的标量步 → 可回代文本（错误值单独成支，因为它无法写成字面量）。 */
function renderStep(step: Step, where: string): RenderOutcome {
  if (!step.ok) {
    return { kind: 'blocked', step };
  }
  if (step.box.kind !== 'scalar') {
    return {
      kind: 'blocked',
      step: blocked('unsupported_construct', `${where} 的结果是一个区域；本仓不接受区域参与表达式`),
    };
  }
  if (step.box.value.kind === 'error') {
    return { kind: 'error', value: step.box.value };
  }
  return { kind: 'text', text: literalText(step.box.value) };
}

/**
 * 把一个**含扩展调用**的子树渲染成可回代文本：扩展调用先算成标量字面量，
 * 其余结构原样保留（交给 `evaluate.ts`）。
 *
 * 错误值无法写成字面量（`#N/A` 通不过本仓的词法），因此以 `kind: 'error'` 冒泡，
 * 由上层按 Excel 的**错误传播**规则处理（左操作数优先）。
 */
function renderNode(node: FormulaNode, context: SpreadsheetFormulaContext): RenderOutcome {
  if (node.kind === 'call' && EXTENDED_SET.has(node.name.toUpperCase())) {
    return renderStep(evalExtendedCall(node.name, node.args, context), node.name);
  }
  if (node.kind === 'call' && node.name.toUpperCase() === 'IF') {
    // `IF` 必须保持惰性：未选中的分支**不求值**（同 evaluate.ts）。
    return renderStep(evalIfLazy(node.args, context), 'IF');
  }
  switch (node.kind) {
    case 'number':
    case 'text':
    case 'boolean':
    case 'reference':
    case 'range':
      return { kind: 'text', text: printNode(node) };
    case 'unary': {
      const inner = renderNode(node.operand, context);
      if (inner.kind !== 'text') return inner;
      return { kind: 'text', text: `(${node.op}${inner.text})` };
    }
    case 'binary': {
      const left = renderNode(node.left, context);
      if (left.kind !== 'text') return left;
      const right = renderNode(node.right, context);
      if (right.kind !== 'text') return right;
      return { kind: 'text', text: `(${left.text}${node.op}${right.text})` };
    }
    case 'call': {
      const parts: string[] = [];
      for (const arg of node.args) {
        const rendered = renderNode(arg, context);
        if (rendered.kind !== 'text') return rendered;
        parts.push(rendered.text);
      }
      return { kind: 'text', text: `${node.name}(${parts.join(',')})` };
    }
    default: {
      const never: never = node;
      throw new ValidationError(`渲染器未覆盖的节点：${JSON.stringify(never)}`);
    }
  }
}

function evalNode(node: FormulaNode, context: SpreadsheetFormulaContext): Step {
  if (node.kind === 'range') {
    return { ok: true, box: { kind: 'range', sheet: node.sheet, start: node.start, end: node.end } };
  }
  if (!containsExtendedCall(node)) {
    // **复用路径**：整棵子树不含扩展调用 ⇒ 原样交给 evaluate.ts（语义零复制）。
    const outcome = evaluateFormula(printNode(node), context);
    return outcome.ok ? scalar(outcome.value) : blocked(outcome.reason, outcome.detail);
  }
  if (node.kind === 'call' && node.name.toUpperCase() === 'IF') {
    return evalIfLazy(node.args, context);
  }
  const rendered = renderNode(node, context);
  if (rendered.kind === 'error') return scalar(rendered.value);
  if (rendered.kind === 'blocked') return rendered.step;
  const outcome = evaluateFormula(rendered.text, context);
  return outcome.ok ? scalar(outcome.value) : blocked(outcome.reason, outcome.detail);
}

/** `IF(cond, then, [else])`：只求值被选中的一支（逐字对齐 `evaluate.ts` 的 `evalIf`）。 */
function evalIfLazy(args: readonly FormulaNode[], context: SpreadsheetFormulaContext): Step {
  if (args.length !== 2 && args.length !== 3) {
    return blocked('invalid_arguments', `IF 需要 2 或 3 个实参，收到 ${String(args.length)}`);
  }
  const conditionNode = args[0];
  if (conditionNode === undefined) {
    return blocked('invalid_arguments', 'IF 缺少条件实参');
  }
  const condition = evalNode(conditionNode, context);
  if (!condition.ok) return condition;
  if (condition.box.kind !== 'scalar') {
    return blocked('unsupported_construct', 'IF 的条件必须是标量');
  }
  const truth = requireBoolean(condition.box.value, 'IF 的条件');
  if (!truth.ok) return truth.step;
  const branch = truth.value ? args[1] : args[2];
  if (branch === undefined) {
    return scalar(booleanValue(false));
  }
  return evalNode(branch, context);
}

/**
 * 求值一段公式，**在 `evaluate.ts` 的核心子集之上叠加 XLS-07 的扩展函数**。
 *
 * 纯函数：同一 `(text, context)` 必得同一结果（无墙钟、无随机、无 locale）。
 *
 * @throws {ValidationError} `text` 不是非空字符串
 */
export function evaluateWithFunctions(text: string, context: SpreadsheetFormulaContext): EvalOutcome {
  if (typeof text !== 'string' || text.length === 0) {
    throw new ValidationError('公式文本必须是非空字符串');
  }
  let node: FormulaNode;
  try {
    node = parseFormula(text);
  } catch (error) {
    if (error instanceof FormulaParseError) {
      return { ok: false, reason: 'parse_error', detail: error.message };
    }
    throw error;
  }
  const step = evalNode(node, context);
  if (!step.ok) {
    return { ok: false, reason: step.reason, detail: step.detail };
  }
  if (step.box.kind === 'range') {
    return {
      ok: false,
      reason: 'unsupported_construct',
      detail: `公式 ${JSON.stringify(text)} 的结果是一个区域，本仓不接受区域作为公式结果`,
    };
  }
  return { ok: true, value: step.box.value };
}

/**
 * 列出公式里**本仓完全不认识**的函数名（核心白名单与扩展清单都不含），按出现顺序去重。
 *
 * `null` = 公式连语法都过不去（与 `extractFormulaReferences` 返回 `null` 同口径：
 * "读不懂"与"确实没有"是两件事）。
 */
export function listUnknownFunctions(text: string): readonly string[] | null {
  let node: FormulaNode;
  try {
    node = parseFormula(text);
  } catch (error) {
    if (error instanceof FormulaParseError) {
      return null;
    }
    throw error;
  }
  const found: string[] = [];
  const walk = (current: FormulaNode): void => {
    switch (current.kind) {
      case 'call': {
        if (!isSupportedFunction(current.name)) {
          const upper = current.name.toUpperCase();
          if (!found.includes(upper)) found.push(upper);
        }
        current.args.forEach(walk);
        return;
      }
      case 'unary':
        walk(current.operand);
        return;
      case 'binary':
        walk(current.left);
        walk(current.right);
        return;
      default:
        return;
    }
  };
  walk(node);
  return Object.freeze(found);
}

// ---------------------------------------------------------------------------
// 扩展函数：实参取值小工具
// ---------------------------------------------------------------------------

/** 取一个实参的标量取值（区域 ⇒ 阻塞：除聚合类外不接受区域）。 */
function evalScalarArg(
  node: FormulaNode,
  context: SpreadsheetFormulaContext,
  where: string,
): { readonly ok: true; readonly value: ScalarValue } | { readonly ok: false; readonly step: Step } {
  const step = evalNode(node, context);
  if (!step.ok) return { ok: false, step };
  if (step.box.kind !== 'scalar') {
    return { ok: false, step: blocked('invalid_arguments', `${where} 需要标量实参，收到区域`) };
  }
  return { ok: true, value: step.box.value };
}

/** 取一个实参的**区域**（裸单元格引用按 1×1 区域处理，与 Excel 的引用语义一致）。 */
function evalRangeArg(
  node: FormulaNode,
  context: SpreadsheetFormulaContext,
  where: string,
): { readonly ok: true; readonly box: RangeBox } | { readonly ok: false; readonly step: Step } {
  if (node.kind === 'reference') {
    if (node.sheet !== null && !context.hasSheet(node.sheet)) {
      return { ok: false, step: blocked('unknown_sheet', `工作簿里没有工作表 ${JSON.stringify(node.sheet)}`) };
    }
    return { ok: true, box: { kind: 'range', sheet: node.sheet, start: node.reference, end: node.reference } };
  }
  const step = evalNode(node, context);
  if (!step.ok) return { ok: false, step };
  if (step.box.kind !== 'range') {
    return { ok: false, step: blocked('invalid_arguments', `${where} 需要区域实参，收到标量`) };
  }
  return { ok: true, box: step.box };
}

// ---------------------------------------------------------------------------
// 条件（criteria）：SUMIF / COUNTIF 家族共用
// ---------------------------------------------------------------------------

type CriteriaOp = '=' | '<>' | '<' | '<=' | '>' | '>=';

type Criteria =
  | { readonly kind: 'number'; readonly op: CriteriaOp; readonly value: number }
  | { readonly kind: 'text'; readonly op: CriteriaOp; readonly value: string; readonly pattern: RegExp | null }
  | { readonly kind: 'boolean'; readonly op: CriteriaOp; readonly value: boolean }
  | { readonly kind: 'blank'; readonly op: '=' | '<>' };

const CRITERIA_OPERATOR_PATTERN = /^(<=|>=|<>|=|<|>)([\s\S]*)$/;
const NUMERIC_LITERAL_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * 文本通配 → 正则（Excel 口径：`*` 任意串、`?` 任意单字符、`~` 转义下一个字符）。
 * 不含通配符时返回 `null`（走纯文本比较）。
 */
function buildWildcardPattern(text: string): RegExp | null {
  if (!/[*?]/.test(text)) {
    return null;
  }
  let body = '';
  for (let index = 0; index < text.length; index += 1) {
    const ch = text.charAt(index);
    if (ch === '~') {
      const next = text.charAt(index + 1);
      if (next === '' ) {
        body += '~';
        continue;
      }
      body += next.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      index += 1;
      continue;
    }
    if (ch === '*') {
      body += '.*';
      continue;
    }
    if (ch === '?') {
      body += '.';
      continue;
    }
    body += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${body}$`, 'i');
}

function parseCriteria(value: ScalarValue): { readonly ok: true; readonly criteria: Criteria } | { readonly ok: false; readonly step: Step } {
  if (value.kind === 'number') {
    return { ok: true, criteria: { kind: 'number', op: '=', value: value.value } };
  }
  if (value.kind === 'boolean') {
    return { ok: true, criteria: { kind: 'boolean', op: '=', value: value.value } };
  }
  if (value.kind === 'error') {
    return { ok: false, step: scalar(value) };
  }
  const match = CRITERIA_OPERATOR_PATTERN.exec(value.value);
  const op = (match === null ? '=' : match[1]) as CriteriaOp;
  const rest = match === null ? value.value : (match[2] ?? '');
  if (rest.length === 0) {
    if (op === '=' || op === '<>') {
      return { ok: true, criteria: { kind: 'blank', op } };
    }
    return {
      ok: false,
      step: blocked('invalid_arguments', `条件 ${JSON.stringify(value.value)} 的比较符后缺少操作数，本仓不猜`),
    };
  }
  if (NUMERIC_LITERAL_PATTERN.test(rest)) {
    return { ok: true, criteria: { kind: 'number', op, value: Number(rest) } };
  }
  const wildcard = op === '=' || op === '<>' ? buildWildcardPattern(rest) : null;
  return { ok: true, criteria: { kind: 'text', op, value: rest, pattern: wildcard } };
}

function applyOrdering(op: CriteriaOp, ordering: number): boolean {
  switch (op) {
    case '=':
      return ordering === 0;
    case '<>':
      return ordering !== 0;
    case '<':
      return ordering < 0;
    case '<=':
      return ordering <= 0;
    case '>':
      return ordering > 0;
    case '>=':
      return ordering >= 0;
    default: {
      const never: never = op;
      throw new ValidationError(`条件比较符未覆盖：${JSON.stringify(never)}`);
    }
  }
}

function compareNumbers(a: number, b: number): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** 文本比较：大小写不敏感（与 `evaluate.ts` 的比较口径一致）。 */
function compareText(a: string, b: string): number {
  const left = a.toUpperCase();
  const right = b.toUpperCase();
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** 一个格子是否满足条件。**错误值由调用方先行处理**（SUMIF 传播、COUNTIF 跳过）。 */
function criteriaMatches(cell: CellValue, criteria: Criteria): boolean {
  if (criteria.kind === 'blank') {
    const isBlank = cell.kind === 'blank';
    return criteria.op === '=' ? isBlank : !isBlank;
  }
  switch (criteria.kind) {
    case 'number':
      return cell.kind === 'number' ? applyOrdering(criteria.op, compareNumbers(cell.value, criteria.value)) : false;
    case 'boolean':
      return cell.kind === 'boolean' ? applyOrdering(criteria.op, compareNumbers(cell.value ? 1 : 0, criteria.value ? 1 : 0)) : false;
    case 'text':
      if (cell.kind !== 'text') return false;
      if (criteria.pattern !== null) {
        return criteria.op === '=' ? criteria.pattern.test(cell.value) : !criteria.pattern.test(cell.value);
      }
      return applyOrdering(criteria.op, compareText(cell.value, criteria.value));
    default: {
      const never: never = criteria;
      throw new ValidationError(`条件未覆盖：${JSON.stringify(never)}`);
    }
  }
}

interface CriteriaPair {
  readonly box: RangeBox;
  readonly cells: readonly CellValue[];
  readonly criteria: Criteria;
}

function buildCriteriaPair(
  rangeNode: FormulaNode,
  criteriaNode: FormulaNode,
  context: SpreadsheetFormulaContext,
  index: number,
): { readonly ok: true; readonly pair: CriteriaPair } | { readonly ok: false; readonly step: Step } {
  const range = evalRangeArg(rangeNode, context, `第 ${String(index)} 个条件区`);
  if (!range.ok) return range;
  const expanded = expandRange(range.box, context);
  if (!expanded.ok) return expanded;
  const raw = evalScalarArg(criteriaNode, context, `第 ${String(index)} 个条件`);
  if (!raw.ok) return raw;
  const parsed = parseCriteria(raw.value);
  if (!parsed.ok) return parsed;
  return { ok: true, pair: { box: range.box, cells: expanded.cells, criteria: parsed.criteria } };
}

function sameShape(a: RangeBox, b: RangeBox): boolean {
  const left = rangeShape(a);
  const right = rangeShape(b);
  return left.rows === right.rows && left.columns === right.columns;
}

// ---------------------------------------------------------------------------
// 扩展函数实现
// ---------------------------------------------------------------------------

function evalExtendedCall(name: string, args: readonly FormulaNode[], context: SpreadsheetFormulaContext): Step {
  const upper = name.toUpperCase();
  const spec = SPEC_BY_NAME.get(upper);
  if (spec === undefined) {
    return blocked(
      'unsupported_function',
      `函数 ${JSON.stringify(name)} 不在本仓清单内（支持：${ALL_SUPPORTED_FUNCTIONS.join(' / ')}），保留原文并阻塞`,
    );
  }
  if (args.length < spec.min_args || args.length > spec.max_args) {
    return blocked(
      'invalid_arguments',
      `${upper} 需要 ${String(spec.min_args)}…${spec.max_args === Number.POSITIVE_INFINITY ? '∞' : String(spec.max_args)} 个实参，收到 ${String(args.length)}`,
    );
  }
  switch (upper) {
    case 'IFERROR':
      return evalIfError(args, context);
    case 'SUMIF':
      return evalSumIf(args, context);
    case 'SUMIFS':
      return evalSumIfs(args, context);
    case 'COUNTIF':
      return evalCountIf(args, context);
    case 'COUNTIFS':
      return evalCountIfs(args, context);
    case 'VLOOKUP':
      return evalVLookup(args, context);
    case 'INDEX':
      return evalIndex(args, context);
    case 'MATCH':
      return evalMatch(args, context);
    case 'LEFT':
      return evalLeftRight(args, context, 'LEFT');
    case 'RIGHT':
      return evalLeftRight(args, context, 'RIGHT');
    case 'MID':
      return evalMid(args, context);
    case 'LEN':
      return evalLen(args, context);
    case 'CONCAT':
      return evalConcat(args, context);
    case 'TEXT':
      return evalText(args, context);
    case 'YEAR':
      return evalDatePart('YEAR', args, context);
    case 'MONTH':
      return evalDatePart('MONTH', args, context);
    case 'DAY':
      return evalDatePart('DAY', args, context);
    case 'DATE':
      return evalDate(args, context);
    case 'TODAY':
      return evalToday(context);
    default:
      throw new ValidationError(`扩展求值器未覆盖的函数：${JSON.stringify(upper)}`);
  }
}

/** `IFERROR(value, fallback)`：只接**错误值**；**阻塞照样传播**（不吞）。 */
function evalIfError(args: readonly FormulaNode[], context: SpreadsheetFormulaContext): Step {
  const firstNode = args[0];
  const secondNode = args[1];
  if (firstNode === undefined || secondNode === undefined) {
    return blocked('invalid_arguments', 'IFERROR 需要恰好 2 个实参');
  }
  const first = evalNode(firstNode, context);
  if (!first.ok) {
    // **关键**：IFERROR 不把"本仓不支持"变成 fallback——那会让阻塞静默消失。
    return first;
  }
  if (first.box.kind !== 'scalar') {
    return blocked('unsupported_construct', 'IFERROR 的第一个实参必须是标量');
  }
  if (first.box.value.kind !== 'error') {
    return first;
  }
  return evalNode(secondNode, context);
}

/** SUMIF 家族共用的"条件区 + 求和区"求和。 */
function sumByCriteria(
  name: string,
  sumCells: readonly CellValue[],
  pairs: readonly CriteriaPair[],
): Step {
  let total = 0;
  let contributions = 0;
  for (let index = 0; index < sumCells.length; index += 1) {
    let matched = true;
    for (const pair of pairs) {
      const cell = pair.cells[index];
      if (cell === undefined) {
        return blocked('invalid_arguments', `${name} 的条件区尺寸与求和区不一致`);
      }
      if (cell.kind === 'error') {
        return scalar(cell); // 条件区里的错误值传播（Excel 同此）
      }
      if (!criteriaMatches(cell, pair.criteria)) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    const cell = sumCells[index];
    if (cell === undefined) {
      return blocked('invalid_arguments', `${name} 的求和区尺寸与条件区不一致`);
    }
    if (cell.kind === 'error') {
      return scalar(cell); // 求和区的错误值传播
    }
    if (cell.kind === 'number') {
      total += cell.value;
      contributions += 1;
    }
    // 文本 / 布尔 / 空白：不贡献（Excel 的 SUMIF 也不把它们算进和）
  }
  if (contributions === 0) {
    return blocked(
      'empty_aggregate',
      `${name} 没有任何数值贡献：按 R248 阻塞而不返回 0（与 SUM 空聚合同口径；这是与 Excel 的有意偏离，已登记）`,
    );
  }
  return numberResult(total);
}

function countByCriteria(name: string, pairs: readonly CriteriaPair[]): Step {
  const length = pairs[0]?.cells.length ?? 0;
  let count = 0;
  for (let index = 0; index < length; index += 1) {
    let matched = true;
    for (const pair of pairs) {
      const cell = pair.cells[index];
      if (cell === undefined) {
        return blocked('invalid_arguments', `${name} 的各个条件区尺寸不一致`);
      }
      if (cell.kind === 'error') {
        // 计数不因一个坏格制造错误（**登记为有意选择**；与 SUMIF 的求和区不同）。
        matched = false;
        break;
      }
      if (!criteriaMatches(cell, pair.criteria)) {
        matched = false;
        break;
      }
    }
    if (matched) count += 1;
  }
  return numberResult(count);
}

function evalSumIf(args: readonly FormulaNode[], context: SpreadsheetFormulaContext): Step {
  const rangeNode = args[0];
  const criteriaNode = args[1];
  if (rangeNode === undefined || criteriaNode === undefined) {
    return blocked('invalid_arguments', 'SUMIF 缺少实参');
  }
  const pair = buildCriteriaPair(rangeNode, criteriaNode, context, 1);
  if (!pair.ok) return pair.step;

  let sumBox = pair.pair.box;
  let sumCells = pair.pair.cells;
  const sumRangeNode = args[2];
  if (sumRangeNode !== undefined) {
    const sumRange = evalRangeArg(sumRangeNode, context, 'SUMIF 的求和区');
    if (!sumRange.ok) return sumRange.step;
    if (!sameShape(pair.pair.box, sumRange.box)) {
      return blocked('invalid_arguments', 'SUMIF 的求和区必须与条件区同尺寸（Excel 的"按左上角外扩"语义本仓不做）');
    }
    const expanded = expandRange(sumRange.box, context);
    if (!expanded.ok) return expanded.step;
    sumBox = sumRange.box;
    sumCells = expanded.cells;
  }
  return sumByCriteria('SUMIF', sumCells, [pair.pair]);
}

function evalSumIfs(args: readonly FormulaNode[], context: SpreadsheetFormulaContext): Step {
  if (args.length % 2 === 0) {
    return blocked('invalid_arguments', `SUMIFS 需要奇数个实参（求和区 + 成对的条件区/条件），收到 ${String(args.length)}`);
  }
  const sumRangeNode = args[0];
  if (sumRangeNode === undefined) {
    return blocked('invalid_arguments', 'SUMIFS 缺少求和区');
  }
  const sumRange = evalRangeArg(sumRangeNode, context, 'SUMIFS 的求和区');
  if (!sumRange.ok) return sumRange.step;
  const sumExpanded = expandRange(sumRange.box, context);
  if (!sumExpanded.ok) return sumExpanded.step;

  const pairs: CriteriaPair[] = [];
  for (let index = 1; index + 1 < args.length; index += 2) {
    const rangeNode = args[index];
    const criteriaNode = args[index + 1];
    if (rangeNode === undefined || criteriaNode === undefined) {
      return blocked('invalid_arguments', 'SUMIFS 的条件组不完整');
    }
    const pair = buildCriteriaPair(rangeNode, criteriaNode, context, (index + 1) / 2);
    if (!pair.ok) return pair.step;
    if (!sameShape(sumRange.box, pair.pair.box)) {
      return blocked('invalid_arguments', 'SUMIFS 的每个条件区都必须与求和区同尺寸');
    }
    pairs.push(pair.pair);
  }
  return sumByCriteria('SUMIFS', sumExpanded.cells, pairs);
}

function evalCountIf(args: readonly FormulaNode[], context: SpreadsheetFormulaContext): Step {
  const rangeNode = args[0];
  const criteriaNode = args[1];
  if (rangeNode === undefined || criteriaNode === undefined) {
    return blocked('invalid_arguments', 'COUNTIF 缺少实参');
  }
  const pair = buildCriteriaPair(rangeNode, criteriaNode, context, 1);
  if (!pair.ok) return pair.step;
  return countByCriteria('COUNTIF', [pair.pair]);
}

function evalCountIfs(args: readonly FormulaNode[], context: SpreadsheetFormulaContext): Step {
  if (args.length % 2 !== 0) {
    return blocked('invalid_arguments', `COUNTIFS 需要偶数个实参（成对的条件区/条件），收到 ${String(args.length)}`);
  }
  const pairs: CriteriaPair[] = [];
  for (let index = 0; index + 1 < args.length; index += 2) {
    const rangeNode = args[index];
    const criteriaNode = args[index + 1];
    if (rangeNode === undefined || criteriaNode === undefined) {
      return blocked('invalid_arguments', 'COUNTIFS 的条件组不完整');
    }
    const pair = buildCriteriaPair(rangeNode, criteriaNode, context, index / 2 + 1);
    if (!pair.ok) return pair.step;
    const first = pairs[0];
    if (first !== undefined && !sameShape(first.box, pair.pair.box)) {
      return blocked('invalid_arguments', 'COUNTIFS 的各个条件区必须同尺寸');
    }
    pairs.push(pair.pair);
  }
  return countByCriteria('COUNTIFS', pairs);
}

/** 精确匹配（VLOOKUP / MATCH 共用）：文本大小写不敏感并支持 * ? 通配，数字/布尔按类比对。 */
function matchesExactly(cell: CellValue, lookup: ScalarValue): boolean {
  switch (lookup.kind) {
    case 'number':
      return cell.kind === 'number' && cell.value === lookup.value;
    case 'boolean':
      return cell.kind === 'boolean' && cell.value === lookup.value;
    case 'text': {
      if (cell.kind !== 'text') return false;
      const pattern = buildWildcardPattern(lookup.value);
      if (pattern !== null) return pattern.test(cell.value);
      return compareText(cell.value, lookup.value) === 0;
    }
    case 'error':
      return false;
    default: {
      const never: never = lookup;
      throw new ValidationError(`精确匹配未覆盖的查找值：${JSON.stringify(never)}`);
    }
  }
}

function evalVLookup(args: readonly FormulaNode[], context: SpreadsheetFormulaContext): Step {
  const lookupNode = args[0];
  const tableNode = args[1];
  const columnNode = args[2];
  if (lookupNode === undefined || tableNode === undefined || columnNode === undefined) {
    return blocked('invalid_arguments', 'VLOOKUP 缺少实参');
  }
  const lookup = evalScalarArg(lookupNode, context, 'VLOOKUP 的查找值');
  if (!lookup.ok) return lookup.step;
  if (lookup.value.kind === 'error') return scalar(lookup.value);

  const table = evalRangeArg(tableNode, context, 'VLOOKUP 的表格区');
  if (!table.ok) return table.step;
  const expanded = expandRange(table.box, context);
  if (!expanded.ok) return expanded.step;
  const shape = rangeShape(table.box);

  const column = evalScalarArg(columnNode, context, 'VLOOKUP 的列号');
  if (!column.ok) return column.step;
  const columnNumber = requireNumber(column.value, 'VLOOKUP 的列号');
  if (!columnNumber.ok) return columnNumber.step;
  const columnIndex = Math.trunc(columnNumber.value);

  // 第 4 参数：**只接受精确匹配**。缺省（Excel 默认近似）也算"没说要精确"⇒ 阻塞。
  const rangeLookupNode = args[3];
  if (rangeLookupNode === undefined) {
    return blocked(
      'unsupported_construct',
      'VLOOKUP 第 4 参数缺省时 Excel 默认**近似匹配**（要求首列升序、二分语义）；本仓只支持精确匹配 ⇒ 阻塞，不降级猜测',
    );
  }
  const flag = evalScalarArg(rangeLookupNode, context, 'VLOOKUP 的第 4 参数');
  if (!flag.ok) return flag.step;
  if (flag.value.kind === 'error') return scalar(flag.value);
  const exact = requireBoolean(flag.value, 'VLOOKUP 的第 4 参数');
  if (!exact.ok) return exact.step;
  if (exact.value) {
    return blocked(
      'unsupported_construct',
      'VLOOKUP 第 4 参数为 TRUE（近似匹配）：本仓不做近似匹配（需要有序表与二分语义），显式阻塞',
    );
  }

  if (columnIndex < 1) {
    return scalar(errorValue('#VALUE!')); // Excel：列号 <1 ⇒ #VALUE!
  }
  if (columnIndex > shape.columns) {
    return scalar(errorValue('#REF!')); // Excel：列号超出表格宽度 ⇒ #REF!
  }

  for (let offset = 0; offset < shape.rows; offset += 1) {
    const cell = expanded.cells[offset * shape.columns];
    if (cell === undefined) {
      /* c8 ignore next -- 展开保证长度 = rows × columns */
      return blocked('invalid_arguments', 'VLOOKUP 的表格区展开异常');
    }
    if (!matchesExactly(cell, lookup.value)) continue;
    const target = expanded.cells[offset * shape.columns + (columnIndex - 1)];
    if (target === undefined) {
      /* c8 ignore next -- 上面已保证 columnIndex ≤ columns */
      return blocked('invalid_arguments', 'VLOOKUP 的目标格越界');
    }
    return scalarFromCellValue(target, `VLOOKUP 命中行第 ${String(columnIndex)} 列`);
  }
  return scalar(errorValue('#N/A')); // 未找到：Excel 的确定错误值，不是伪造
}

function evalIndex(args: readonly FormulaNode[], context: SpreadsheetFormulaContext): Step {
  const arrayNode = args[0];
  const rowNode = args[1];
  if (arrayNode === undefined || rowNode === undefined) {
    return blocked('invalid_arguments', 'INDEX 缺少实参');
  }
  const array = evalRangeArg(arrayNode, context, 'INDEX 的区间');
  if (!array.ok) return array.step;
  const expanded = expandRange(array.box, context);
  if (!expanded.ok) return expanded.step;
  const shape = rangeShape(array.box);

  const row = evalScalarArg(rowNode, context, 'INDEX 的行号');
  if (!row.ok) return row.step;
  const rowNumber = requireNumber(row.value, 'INDEX 的行号');
  if (!rowNumber.ok) return rowNumber.step;
  const rowIndex = Math.trunc(rowNumber.value);

  const columnNode = args[2];
  if (columnNode === undefined) {
    if (shape.rows === 1) {
      // 单行区间：唯一的下标就是列号（Excel 语义）。
      return indexIntoCell(expanded.cells, shape, 1, rowIndex);
    }
    if (shape.columns === 1) {
      return indexIntoCell(expanded.cells, shape, rowIndex, 1);
    }
    return blocked(
      'unsupported_construct',
      '二维区间必须显式给出列号（Excel 在省略列号时返回整行，是一个数组结果，本仓不建模数组）',
    );
  }
  const column = evalScalarArg(columnNode, context, 'INDEX 的列号');
  if (!column.ok) return column.step;
  const columnNumber = requireNumber(column.value, 'INDEX 的列号');
  if (!columnNumber.ok) return columnNumber.step;
  return indexIntoCell(expanded.cells, shape, rowIndex, Math.trunc(columnNumber.value));
}

function indexIntoCell(
  cells: readonly CellValue[],
  shape: { readonly rows: number; readonly columns: number },
  rowIndex: number,
  columnIndex: number,
): Step {
  if (rowIndex < 1 || columnIndex < 1) {
    return scalar(errorValue('#VALUE!')); // Excel：下标 <1 ⇒ #VALUE!
  }
  if (rowIndex > shape.rows || columnIndex > shape.columns) {
    return scalar(errorValue('#REF!')); // Excel：越界 ⇒ #REF!
  }
  const cell = cells[(rowIndex - 1) * shape.columns + (columnIndex - 1)];
  if (cell === undefined) {
    /* c8 ignore next -- 上面已保证下标在界内 */
    return blocked('invalid_arguments', 'INDEX 的区间展开异常');
  }
  return scalarFromCellValue(cell, `INDEX(${String(rowIndex)},${String(columnIndex)}) 命中格`);
}

function evalMatch(args: readonly FormulaNode[], context: SpreadsheetFormulaContext): Step {
  const lookupNode = args[0];
  const arrayNode = args[1];
  if (lookupNode === undefined || arrayNode === undefined) {
    return blocked('invalid_arguments', 'MATCH 缺少实参');
  }
  const lookup = evalScalarArg(lookupNode, context, 'MATCH 的查找值');
  if (!lookup.ok) return lookup.step;
  if (lookup.value.kind === 'error') return scalar(lookup.value);

  const array = evalRangeArg(arrayNode, context, 'MATCH 的区间');
  if (!array.ok) return array.step;
  const expanded = expandRange(array.box, context);
  if (!expanded.ok) return expanded.step;
  const shape = rangeShape(array.box);
  if (shape.rows !== 1 && shape.columns !== 1) {
    return blocked('invalid_arguments', 'MATCH 的区间必须是单行或单列（本仓不做二维 MATCH）');
  }

  const matchTypeNode = args[2];
  if (matchTypeNode === undefined) {
    return blocked(
      'unsupported_construct',
      'MATCH 缺省 match_type 时 Excel 默认 1（升序近似查找）；本仓只支持 0（精确）⇒ 阻塞，不降级猜测',
    );
  }
  const matchType = evalScalarArg(matchTypeNode, context, 'MATCH 的 match_type');
  if (!matchType.ok) return matchType.step;
  const typeNumber = requireNumber(matchType.value, 'MATCH 的 match_type');
  if (!typeNumber.ok) return typeNumber.step;
  if (Math.trunc(typeNumber.value) !== 0) {
    return blocked(
      'unsupported_construct',
      `MATCH 的 match_type = ${String(Math.trunc(typeNumber.value))}（±1 为有序近似查找）：本仓只支持 0（精确），显式阻塞`,
    );
  }

  for (let offset = 0; offset < expanded.cells.length; offset += 1) {
    const cell = expanded.cells[offset];
    if (cell === undefined) {
      /* c8 ignore next -- 展开保证长度 = rows × columns */
      continue;
    }
    if (matchesExactly(cell, lookup.value)) {
      return numberResult(offset + 1); // 1 起的相对位置（Excel 语义）
    }
  }
  return scalar(errorValue('#N/A'));
}

function codePoints(text: string): readonly string[] {
  return [...text];
}

function evalLeftRight(args: readonly FormulaNode[], context: SpreadsheetFormulaContext, name: 'LEFT' | 'RIGHT'): Step {
  const textNode = args[0];
  if (textNode === undefined) {
    return blocked('invalid_arguments', `${name} 缺少实参`);
  }
  const raw = evalScalarArg(textNode, context, `${name} 的文本实参`);
  if (!raw.ok) return raw.step;
  const text = requireText(raw.value, `${name} 的文本实参`);
  if (!text.ok) return text.step;

  let count = 1;
  const countNode = args[1];
  if (countNode !== undefined) {
    const rawCount = evalScalarArg(countNode, context, `${name} 的个数实参`);
    if (!rawCount.ok) return rawCount.step;
    const numeric = requireNumber(rawCount.value, `${name} 的个数实参`);
    if (!numeric.ok) return numeric.step;
    count = Math.trunc(numeric.value);
  }
  if (count < 0) {
    return scalar(errorValue('#VALUE!')); // Excel：负个数 ⇒ #VALUE!
  }
  const characters = codePoints(text.value);
  if (count >= characters.length) {
    return scalar(textValue(text.value));
  }
  const slice = name === 'LEFT' ? characters.slice(0, count) : characters.slice(characters.length - count);
  return scalar(textValue(slice.join('')));
}

function evalMid(args: readonly FormulaNode[], context: SpreadsheetFormulaContext): Step {
  const textNode = args[0];
  const startNode = args[1];
  const countNode = args[2];
  if (textNode === undefined || startNode === undefined || countNode === undefined) {
    return blocked('invalid_arguments', 'MID 需要 3 个实参');
  }
  const raw = evalScalarArg(textNode, context, 'MID 的文本实参');
  if (!raw.ok) return raw.step;
  const text = requireText(raw.value, 'MID 的文本实参');
  if (!text.ok) return text.step;

  const rawStart = evalScalarArg(startNode, context, 'MID 的起始位置');
  if (!rawStart.ok) return rawStart.step;
  const start = requireNumber(rawStart.value, 'MID 的起始位置');
  if (!start.ok) return start.step;

  const rawCount = evalScalarArg(countNode, context, 'MID 的字符数');
  if (!rawCount.ok) return rawCount.step;
  const count = requireNumber(rawCount.value, 'MID 的字符数');
  if (!count.ok) return count.step;

  const startIndex = Math.trunc(start.value);
  const length = Math.trunc(count.value);
  if (startIndex < 1 || length < 0) {
    return scalar(errorValue('#VALUE!'));
  }
  return scalar(textValue(codePoints(text.value).slice(startIndex - 1, startIndex - 1 + length).join('')));
}

function evalLen(args: readonly FormulaNode[], context: SpreadsheetFormulaContext): Step {
  const textNode = args[0];
  if (textNode === undefined) {
    return blocked('invalid_arguments', 'LEN 需要 1 个实参');
  }
  const raw = evalScalarArg(textNode, context, 'LEN 的实参');
  if (!raw.ok) return raw.step;
  const text = requireText(raw.value, 'LEN 的实参');
  if (!text.ok) return text.step;
  return numberResult(codePoints(text.value).length);
}

function evalConcat(args: readonly FormulaNode[], context: SpreadsheetFormulaContext): Step {
  let output = '';
  for (const arg of args) {
    const step = evalNode(arg, context);
    if (!step.ok) return step;
    if (step.box.kind === 'scalar') {
      const text = requireText(step.box.value, 'CONCAT 的实参');
      if (!text.ok) return text.step;
      output += text.value;
      continue;
    }
    const expanded = expandRange(step.box, context);
    if (!expanded.ok) return expanded.step;
    for (const cell of expanded.cells) {
      const converted = scalarFromCellValue(cell, 'CONCAT 的区域内格子');
      if (!converted.ok) return converted; // 空白 ⇒ blank_operand（与 `&` 同口径）；错误值 ⇒ 传播
      if (converted.box.kind !== 'scalar') {
        /* c8 ignore next -- scalarFromCellValue 只产出标量 */
        return blocked('unsupported_construct', 'CONCAT 的区域内格子异常');
      }
      const text = requireText(converted.box.value, 'CONCAT 的区域内格子');
      if (!text.ok) return text.step;
      output += text.value;
    }
  }
  return scalar(textValue(output));
}

interface NumberFormatSpec {
  readonly scale: number;
  readonly grouping: boolean;
  readonly percent: boolean;
}

/** 白名单数值格式：`0` / `0.0…` / `#,##0` / `#,##0.0…`，各自可带尾部 `%`。 */
function parseNumberFormat(format: string): NumberFormatSpec | null {
  const match = /^(#,##0|0)(\.0+)?(%?)$/.exec(format);
  if (match === null) {
    return null;
  }
  const decimals = match[2];
  return {
    scale: decimals === undefined ? 0 : decimals.length - 1,
    grouping: match[1] === '#,##0',
    percent: match[3] === '%',
  };
}

function groupThousands(integerPart: string): string {
  let output = '';
  let counter = 0;
  for (let index = integerPart.length - 1; index >= 0; index -= 1) {
    output = integerPart.charAt(index) + output;
    counter += 1;
    if (counter % 3 === 0 && index > 0) {
      output = `,${output}`;
    }
  }
  return output;
}

function evalText(args: readonly FormulaNode[], context: SpreadsheetFormulaContext): Step {
  const valueNode = args[0];
  const formatNode = args[1];
  if (valueNode === undefined || formatNode === undefined) {
    return blocked('invalid_arguments', 'TEXT 需要 2 个实参');
  }
  const raw = evalScalarArg(valueNode, context, 'TEXT 的数值实参');
  if (!raw.ok) return raw.step;
  const numeric = requireNumber(raw.value, 'TEXT 的数值实参');
  if (!numeric.ok) return numeric.step;

  const rawFormat = evalScalarArg(formatNode, context, 'TEXT 的格式实参');
  if (!rawFormat.ok) return rawFormat.step;
  if (rawFormat.value.kind !== 'text') {
    return blocked('invalid_arguments', 'TEXT 的格式实参必须是文本字面量');
  }
  const spec = parseNumberFormat(rawFormat.value.value);
  if (spec === null) {
    return blocked(
      'invalid_arguments',
      `TEXT 的格式 ${JSON.stringify(rawFormat.value.value)} 不在白名单内（支持：0 / 0.0… / #,##0 / #,##0.0… 及其 % 变体）；日期格式与多段格式本仓不做，显式阻塞`,
    );
  }

  const scaled = spec.percent ? numeric.value * 100 : numeric.value;
  if (!Number.isFinite(scaled)) {
    return scalar(errorValue('#NUM!'));
  }
  const formatted = formatDecimal(scaled, spec.scale);
  const negative = formatted.startsWith('-');
  const body = negative ? formatted.slice(1) : formatted;
  const dot = body.indexOf('.');
  const integerPart = dot === -1 ? body : body.slice(0, dot);
  const fractionPart = dot === -1 ? '' : body.slice(dot);
  const integerOut = spec.grouping ? groupThousands(integerPart) : integerPart;
  const sign = negative && /[1-9]/.test(body) ? '-' : '';
  return scalar(textValue(`${sign}${integerOut}${fractionPart}${spec.percent ? '%' : ''}`));
}

// ---------------------------------------------------------------------------
// 日期：与 `excel-date.ts` 共用同一套序列号语义
// ---------------------------------------------------------------------------

/**
 * 天数（相对 1970-01-01）→ 公历 (年, 月, 日)。
 *
 * Howard Hinnant 的 `civil_from_days`（纯整数运算）。**不用任何日期库、不读墙钟**：
 * 内核纪律要求 `src/**` 无 `Date`。日历口径为**前推格里高利历、UTC**——
 * 与 `excel-date.ts` 的 `EXCEL_EPOCH_MS`（1899-12-30T00:00:00Z）是同一个时间轴。
 */
function civilFromDays(days: number): { readonly year: number; readonly month: number; readonly day: number } {
  const shifted = days + 719468;
  const era = Math.floor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365,
  );
  const year = yearOfEra + era * 400;
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPrime = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPrime + 2) / 5) + 1;
  const month = monthPrime + (monthPrime < 10 ? 3 : -9);
  return { year: year + (month <= 2 ? 1 : 0), month, day };
}

/** 公历 (年, 月, 日) → 天数（相对 1970-01-01）。Hinnant 的 `days_from_civil`。 */
function daysFromCivil(year: number, month: number, day: number): number {
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** 支持的日期下界：1900-03-01（`excel-date.ts` 明说 1900-03-01 之前与 Excel 差 1 天）。 */
const DATE_MIN_SERIAL = toExcelSerial(daysFromCivil(1900, 3, 1) * MS_PER_DAY);
/** 支持的日期上界：9999-12-31。 */
const DATE_MAX_SERIAL = toExcelSerial(daysFromCivil(9999, 12, 31) * MS_PER_DAY);

/** 序列号 → 天序号（相对 1970-01-01）。**换算式全部来自 `excel-date.ts`**。 */
function serialToDayNumber(serial: number): number {
  return Math.floor(fromExcelSerial(serial) / MS_PER_DAY);
}

function dayNumberOfSerialOrError(
  serial: number,
): { readonly ok: true; readonly days: number } | { readonly ok: false; readonly step: Step } {
  if (serial < DATE_MIN_SERIAL || serial > DATE_MAX_SERIAL) {
    return { ok: false, step: scalar(errorValue('#NUM!')) };
  }
  return { ok: true, days: serialToDayNumber(serial) };
}

function evalDatePart(
  name: 'YEAR' | 'MONTH' | 'DAY',
  args: readonly FormulaNode[],
  context: SpreadsheetFormulaContext,
): Step {
  const serialNode = args[0];
  if (serialNode === undefined) {
    return blocked('invalid_arguments', `${name} 需要 1 个实参`);
  }
  const raw = evalScalarArg(serialNode, context, `${name} 的序列号实参`);
  if (!raw.ok) return raw.step;
  const numeric = requireNumber(raw.value, `${name} 的序列号实参`);
  if (!numeric.ok) return numeric.step;
  if (!Number.isFinite(numeric.value)) {
    return scalar(errorValue('#NUM!'));
  }
  const days = dayNumberOfSerialOrError(numeric.value);
  if (!days.ok) return days.step;
  const civil = civilFromDays(days.days);
  switch (name) {
    case 'YEAR':
      return numberResult(civil.year);
    case 'MONTH':
      return numberResult(civil.month);
    case 'DAY':
      return numberResult(civil.day);
    default: {
      const never: never = name;
      throw new ValidationError(`日期分量函数未覆盖：${JSON.stringify(never)}`);
    }
  }
}

function evalDate(args: readonly FormulaNode[], context: SpreadsheetFormulaContext): Step {
  const parts: number[] = [];
  for (const node of args) {
    const raw = evalScalarArg(node, context, 'DATE 的实参');
    if (!raw.ok) return raw.step;
    const numeric = requireNumber(raw.value, 'DATE 的实参');
    if (!numeric.ok) return numeric.step;
    if (!Number.isFinite(numeric.value)) {
      return scalar(errorValue('#NUM!'));
    }
    parts.push(Math.trunc(numeric.value));
  }
  const [rawYear, rawMonth, rawDay] = parts;
  if (rawYear === undefined || rawMonth === undefined || rawDay === undefined) {
    /* c8 ignore next -- 实参个数已由 spec 校验 */
    return blocked('invalid_arguments', 'DATE 需要 3 个实参');
  }
  if (rawYear < 0 || rawYear > 9999) {
    return scalar(errorValue('#NUM!')); // Excel：年超出 0…9999 ⇒ #NUM!
  }
  const year = rawYear < 1900 ? rawYear + 1900 : rawYear; // Excel 的 0…1899 ⇒ +1900 规则
  const monthIndex = rawMonth - 1;
  const normalizedYear = year + Math.floor(monthIndex / 12);
  const normalizedMonth = ((monthIndex % 12) + 12) % 12 + 1;
  const days = daysFromCivil(normalizedYear, normalizedMonth, 1) + (rawDay - 1);
  const serial = toExcelSerial(days * MS_PER_DAY);
  if (serial < DATE_MIN_SERIAL) {
    return blocked(
      'unsupported_construct',
      `DATE(${String(rawYear)},${String(rawMonth)},${String(rawDay)}) 落在 1900-03-01 之前：excel-date.ts 已文档化该区间与 Excel 差 1 天，本仓不伪造序列号，显式阻塞`,
    );
  }
  if (serial > DATE_MAX_SERIAL) {
    return scalar(errorValue('#NUM!'));
  }
  return numberResult(serial);
}

function evalToday(context: SpreadsheetFormulaContext): Step {
  const serial = context.today_serial;
  if (serial === undefined) {
    return blocked(
      'unsupported_construct',
      'TODAY() 需要调用方显式注入当前日期（context.today_serial）：本仓不读墙钟（内核纪律要求 src/** 零墙钟），读不到就阻塞，不伪造"今天"',
    );
  }
  if (typeof serial !== 'number' || !Number.isFinite(serial)) {
    throw new ValidationError(`today_serial 必须是有限数，收到 ${String(serial)}`);
  }
  return numberResult(serial);
}
