/**
 * 表格域：**受限子集**的确定性公式求值（design-06-P8 / XLS-08；合同 R248、R250）。
 *
 * ## 为什么自建而不是引第三方引擎
 *
 * FA-E 的能力探针（`.task-manifest/outputs/FA-E/probe-xlsx-library.md`）已实测：唯一成熟的
 * 公式引擎 `hyperformula` 是 **GPL-3.0-only ⇒ 授权阻塞**；MIT 侧只有"函数库"没有"解析 + 求值"。
 * 因此本仓走"零依赖的受限子集"路线。这不是妥协，而是**把边界画清楚**：
 * 支持的语法 / 函数是**白名单**，白名单之外**一律阻塞**，绝不猜。
 *
 * ## XLS-08 的两条硬约束，以及它们在本文件的形状
 *
 * 1. **"不支持的公式保留原文并阻塞，不得返回伪造结果"** ⇒ 本模块的唯一出口是
 *    {@link EvalOutcome} 的**二值**：要么 `ok: true` 给出一个**确定的**单元格取值，
 *    要么 `ok: false` 给出**阻塞原因与证据**。**没有任何"看起来像结果"的第三态**——
 *    想返回一个猜测值，在这里连类型都构造不出来。
 * 2. **R248「缺失不当零」** ⇒
 *    - 空白格参与**标量**运算（`A1+1`、`A1>0`、`-A1`）⇒ 阻塞（`blank_operand`），**永不当作 0**；
 *    - 聚合函数（`SUM` 等）**跳过**空白格（既不贡献、也不计入 `AVERAGE` 的分母）——
 *      这是 Excel 语义，且"跳过"不等于"当作 0"；
 *    - 聚合的数值贡献数为 **0** ⇒ 阻塞（`empty_aggregate`）而**不返回 0**，
 *      与 `quantity.ts` 的空列表求和返回 `empty` 同口径。
 *
 * ## 与 Excel 的**有意偏离**（如实登记，不静默）
 *
 * | 场景 | Excel | 本仓 | 理由 |
 * |---|---|---|---|
 * | 空白格参与标量运算 | 当作 0 | **阻塞** | R248 |
 * | 数字文本参与算术（`"3"+1`） | 4 | **阻塞** | 文本→数依赖格式与 locale，不做隐式转换 |
 * | 日期值参与算术 / 聚合 | 按序列号 | **阻塞** | 不做隐式 日期→序列号 转换（`DateValue` 与 `NumberValue` 是两类） |
 * | 混合类型比较（`1<"a"`） | 有全序 | **阻塞** | Excel 的跨类型全序冷僻且易错，不猜 |
 * | 空区域求和 | 0 | **阻塞** | R248（同 `quantity.ts` 的 `empty`） |
 *
 * 其余（运算符优先级、`^` 右结合、一元负号比 `^` 结合更紧即 `-2^2 = 4`、`#DIV/0!` / `#NUM!`
 * 错误值、`&` 连接、`IF` 惰性分支）**与 Excel 一致**，并有对应用例。
 */

import { ValidationError } from '../protocol/index.js';
import { formatDecimal } from '../artifacts/ooxml/xml.js';
import { getSheet, type WorkbookState } from './workbook.js';
import { getCellValue } from './sheet.js';
import { FormulaParseError, parseFormula, type BinaryOp, type FormulaNode } from './formula-parse.js';
import type { CellAddress } from './reference.js';
import {
  booleanValue,
  errorValue,
  numberValue,
  textValue,
  type BooleanValue,
  type CellValue,
  type ErrorValue,
  type NumberValue,
  type TextValue,
} from './value.js';

/** 一个确定的标量结果（**永远不是 `blank`**：空白不参与求值，见文件头）。 */
export type ScalarValue = NumberValue | TextValue | BooleanValue | ErrorValue;

/** 公式求值被阻塞的原因（封闭枚举）。 */
export type FormulaEvalBlockReason =
  /** 词法 / 语法超出支持的子集。 */
  | 'parse_error'
  /** 函数名不在白名单内。 */
  | 'unsupported_function'
  /** 用到了本仓未建模的构造（裸区域当标量、跨表区域、命名区域……）。 */
  | 'unsupported_construct'
  /** 引用了工作簿里不存在的工作表。 */
  | 'unknown_sheet'
  /** 引用指向本工作表之外的越界地址（如 XFE1）。 */
  | 'invalid_reference'
  /** **空白格参与标量运算**——R248：缺失必须显式失败，绝不当 0。 */
  | 'blank_operand'
  /** 非数值（文本 / 日期）参与数值运算。 */
  | 'non_numeric_operand'
  /** 聚合函数没有任何数值贡献（**不返回 0**，R248）。 */
  | 'empty_aggregate'
  /** 混合类型比较（本仓不给跨类型全序）。 */
  | 'incomparable_operands'
  /** 函数收到的实参个数 / 类型不对。 */
  | 'invalid_arguments'
  /** 公式自引用或互相引用成环。 */
  | 'circular_reference';

/** 求值结果：**确定的标量**，或**阻塞**。没有第三态。 */
export type EvalOutcome =
  | { readonly ok: true; readonly value: ScalarValue }
  | { readonly ok: false; readonly reason: FormulaEvalBlockReason; readonly detail: string };

/** 单元格解析结果：可能是任意 `CellValue`（**含 `blank`**），或阻塞。 */
export type CellResolution =
  | { readonly kind: 'value'; readonly value: CellValue }
  | { readonly kind: 'blocked'; readonly reason: FormulaEvalBlockReason; readonly detail: string };

/**
 * 求值上下文：把"读某个单元格"抽象出来。
 *
 * 这样求值器**不依赖** `WorkbookState` 的具体形状，也就便于用极小夹具做单测；
 * 工作簿级的组合（跨表解析 + 记忆化 + 环检测）由 {@link evaluateWorkbookCell} 提供。
 */
export interface FormulaContext {
  /** 本表的表名（无前缀引用 `A1` 即指向它）。 */
  readonly current_sheet: string;
  /** 该工作表是否存在。 */
  hasSheet(name: string): boolean;
  /** 解析一个单元格引用（`sheet === null` ⇒ 本表）。 */
  resolveCell(sheet: string | null, address: CellAddress): CellResolution;
}

/**
 * 本仓**确定支持**的函数白名单（大写）。
 *
 * 白名单外的任何函数 ⇒ `unsupported_function` 阻塞（**不求值、不猜**）。
 * 每个函数的语义都有对应用例，见 `evaluate.test.ts`。
 */
export const SUPPORTED_FUNCTIONS: readonly string[] = Object.freeze([
  'SUM',
  'AVERAGE',
  'MIN',
  'MAX',
  'COUNT',
  'COUNTA',
  'IF',
  'AND',
  'OR',
  'NOT',
  'ABS',
  'ROUND',
  'SQRT',
]);

const SUPPORTED_SET: ReadonlySet<string> = new Set(SUPPORTED_FUNCTIONS);

/** `ROUND` 支持的位数范围（与 `formatDecimal` 同界，负位数不做——见文件头）。 */
const ROUND_MIN_DIGITS = 0;
const ROUND_MAX_DIGITS = 20;

// ---------------------------------------------------------------------------
// 内部中间值
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

type Step = { readonly ok: true; readonly box: Box } | { readonly ok: false; readonly reason: FormulaEvalBlockReason; readonly detail: string };

function blocked(reason: FormulaEvalBlockReason, detail: string): Step {
  return { ok: false, reason, detail };
}

function scalar(value: ScalarValue): Step {
  return { ok: true, box: { kind: 'scalar', value } };
}

function numberResult(value: number): Step {
  if (!Number.isFinite(value)) {
    return scalar(errorValue('#NUM!'));
  }
  return scalar(numberValue(value));
}

// ---------------------------------------------------------------------------
// 标量强制转换（每一条都显式，不做隐式 coercion）
// ---------------------------------------------------------------------------

/** 数值位置上的取值：`number` ✅、`boolean` ✅（Excel 语义 TRUE=1）、其余阻塞。 */
function numericOperand(value: ScalarValue, where: string): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly step: Step } {
  switch (value.kind) {
    case 'number':
      return { ok: true, value: value.value };
    case 'boolean':
      return { ok: true, value: value.value ? 1 : 0 };
    case 'error':
      return { ok: false, step: scalar(value) };
    default:
      return {
        ok: false,
        step: blocked('non_numeric_operand', `${where} 需要数值，收到 ${value.kind}（不隐式转换）`),
      };
  }
}

/** 连接位置上的取值（`&`）：数 / 文本 / 布尔都可，错误值传播。 */
function textOperand(value: ScalarValue, where: string): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly step: Step } {
  switch (value.kind) {
    case 'text':
      return { ok: true, value: value.value };
    case 'number':
      return { ok: true, value: numberToText(value.value) };
    case 'boolean':
      return { ok: true, value: value.value ? 'TRUE' : 'FALSE' };
    default:
      return { ok: false, step: scalar(value) };
  }
}

/** 数值 → 文本（Excel `General` 口径的确定性近似：最短可往返十进制，不经 locale）。 */
function numberToText(value: number): string {
  return String(value);
}

/** 布尔位置上的取值。空白 / 文本 / 日期都不隐式转换。 */
function booleanOperand(value: ScalarValue, where: string): { readonly ok: true; readonly value: boolean } | { readonly ok: false; readonly step: Step } {
  switch (value.kind) {
    case 'boolean':
      return { ok: true, value: value.value };
    case 'number':
      return { ok: true, value: value.value !== 0 };
    case 'error':
      return { ok: false, step: scalar(value) };
    default:
      return {
        ok: false,
        step: blocked('non_numeric_operand', `${where} 需要布尔值，收到 ${value.kind}（不隐式转换）`),
      };
  }
}

// ---------------------------------------------------------------------------
// 区域展开
// ---------------------------------------------------------------------------

function rangeLength(box: RangeBox): number {
  const rows = Math.abs(box.end.row - box.start.row) + 1;
  const columns = Math.abs(box.end.column - box.start.column) + 1;
  return rows * columns;
}

/** 单次区域展开的格数上限（挡住 `A1:XFD1048576` 这类"合法但荒谬"的区域）。 */
export const MAX_RANGE_CELLS = 1_048_576;

interface RangeCell {
  readonly value: CellValue;
}

function expandRange(box: RangeBox, context: FormulaContext): { readonly ok: true; readonly cells: readonly RangeCell[] } | { readonly ok: false; readonly step: Step } {
  if (rangeLength(box) > MAX_RANGE_CELLS) {
    return {
      ok: false,
      step: blocked(
        'invalid_arguments',
        `区域 ${describeRange(box)} 超过 ${String(MAX_RANGE_CELLS)} 格上限，拒绝展开`,
      ),
    };
  }
  const rowStart = Math.min(box.start.row, box.end.row);
  const rowEnd = Math.max(box.start.row, box.end.row);
  const columnStart = Math.min(box.start.column, box.end.column);
  const columnEnd = Math.max(box.start.column, box.end.column);
  const cells: RangeCell[] = [];
  for (let row = rowStart; row <= rowEnd; row += 1) {
    for (let column = columnStart; column <= columnEnd; column += 1) {
      const resolved = context.resolveCell(box.sheet, { column, row });
      if (resolved.kind === 'blocked') {
        return { ok: false, step: blocked(resolved.reason, resolved.detail) };
      }
      cells.push({ value: resolved.value });
    }
  }
  return { ok: true, cells };
}

function describeRange(box: RangeBox): string {
  return `${box.sheet === null ? '' : `${box.sheet}!`}${box.start.column},${box.start.row}:${box.end.column},${box.end.row}`;
}

// ---------------------------------------------------------------------------
// 求值
// ---------------------------------------------------------------------------

/**
 * 对一段公式文本求值。**纯函数**（同一 `(text, context)` ⇒ 同一结果）。
 *
 * @throws {ValidationError} `text` 不是非空字符串
 */
export function evaluateFormula(text: string, context: FormulaContext): EvalOutcome {
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

function evalNode(node: FormulaNode, context: FormulaContext): Step {
  switch (node.kind) {
    case 'number':
      return scalar(numberValue(node.value));
    case 'text':
      return scalar(textValue(node.value));
    case 'boolean':
      return scalar(booleanValue(node.value));
    case 'reference':
      return evalReference(node.sheet, node.reference, context);
    case 'range':
      return { ok: true, box: { kind: 'range', sheet: node.sheet, start: node.start, end: node.end } };
    case 'unary':
      return evalUnary(node.op, node.operand, context);
    case 'binary':
      return evalBinary(node.op, node.left, node.right, context);
    case 'call':
      return evalCall(node.name, node.args, context);
    default: {
      const never: never = node;
      throw new ValidationError(`求值器未覆盖的节点：${JSON.stringify(never)}`);
    }
  }
}

function resolveSheet(sheet: string | null, context: FormulaContext): { readonly ok: true; readonly name: string } | { readonly ok: false; readonly step: Step } {
  if (sheet === null) {
    return { ok: true, name: context.current_sheet };
  }
  if (!context.hasSheet(sheet)) {
    return { ok: false, step: blocked('unknown_sheet', `工作簿里没有工作表 ${JSON.stringify(sheet)}`) };
  }
  return { ok: true, name: sheet };
}

function evalReference(sheet: string | null, address: CellAddress, context: FormulaContext): Step {
  const resolved = resolveSheet(sheet, context);
  if (!resolved.ok) return resolved.step;
  if (address.column < 1 || address.row < 1) {
    return blocked('invalid_reference', `引用越界：列 ${String(address.column)} / 行 ${String(address.row)}`);
  }
  const cell = context.resolveCell(sheet, address);
  if (cell.kind === 'blocked') {
    return blocked(cell.reason, cell.detail);
  }
  return scalarFromCell(cell.value, `引用 ${describeAddress(sheet, address)}`);
}

function describeAddress(sheet: string | null, address: CellAddress): string {
  return `${sheet === null ? '' : `${sheet}!`}${String(address.column)}:${String(address.row)}`;
}

/** 单元格取值 → 标量。**空白格在这里阻塞**（R248 的执行点之一）。 */
function scalarFromCell(value: CellValue, where: string): Step {
  switch (value.kind) {
    case 'number':
      return scalar(value);
    case 'text':
      return scalar(value);
    case 'boolean':
      return scalar(value);
    case 'error':
      return scalar(value);
    case 'date':
      return blocked(
        'non_numeric_operand',
        `${where} 是日期值：本仓不做隐式 日期→序列号 转换，数值位置上使用日期一律阻塞`,
      );
    case 'formula':
      /* c8 ignore next 2 -- 驱动层会先把公式格算成缓存值；此处是防御性分支 */
      return blocked('unsupported_construct', `${where} 是未求值的公式格`);
    case 'blank':
      return blocked('blank_operand', `${where} 是空白格：缺失不得当作 0（R248）`);
    default: {
      const never: never = value;
      throw new ValidationError(`求值器未覆盖的取值：${JSON.stringify(never)}`);
    }
  }
}

function evalUnary(op: '-' | '+', operand: FormulaNode, context: FormulaContext): Step {
  const inner = evalNode(operand, context);
  if (!inner.ok) return inner;
  if (inner.box.kind !== 'scalar') {
    return blocked('unsupported_construct', '一元运算不能作用于区域');
  }
  const numeric = numericOperand(inner.box.value, `一元 ${op}`);
  if (!numeric.ok) return numeric.step;
  return numberResult(op === '-' ? -numeric.value : numeric.value);
}

function evalBinary(op: BinaryOp, leftNode: FormulaNode, rightNode: FormulaNode, context: FormulaContext): Step {
  const left = evalNode(leftNode, context);
  if (!left.ok) return left;
  const right = evalNode(rightNode, context);
  if (!right.ok) return right;
  if (left.box.kind !== 'scalar' || right.box.kind !== 'scalar') {
    return blocked('unsupported_construct', `运算符 ${op} 的运算数必须是标量（区域只能作为函数实参）`);
  }
  return applyBinary(op, left.box.value, right.box.value);
}

function applyBinary(op: BinaryOp, left: ScalarValue, right: ScalarValue): Step {
  if (op === '&') {
    const a = textOperand(left, '& 的左操作数');
    if (!a.ok) return a.step;
    const b = textOperand(right, '& 的右操作数');
    if (!b.ok) return b.step;
    return scalar(textValue(a.value + b.value));
  }
  if (op === '=' || op === '<>' || op === '<' || op === '<=' || op === '>' || op === '>=') {
    return applyComparison(op, left, right);
  }
  const a = numericOperand(left, `运算符 ${op} 的左操作数`);
  if (!a.ok) return a.step;
  const b = numericOperand(right, `运算符 ${op} 的右操作数`);
  if (!b.ok) return b.step;
  switch (op) {
    case '+':
      return numberResult(a.value + b.value);
    case '-':
      return numberResult(a.value - b.value);
    case '*':
      return numberResult(a.value * b.value);
    case '/':
      /* c8 ignore next -- 除法零是**确定**的 Excel 结果 #DIV/0!，不是伪造 */
      if (b.value === 0) return scalar(errorValue('#DIV/0!'));
      return numberResult(a.value / b.value);
    case '^':
      return numberResult(a.value ** b.value);
    default: {
      const never: never = op;
      throw new ValidationError(`求值器未覆盖的运算符：${JSON.stringify(never)}`);
    }
  }
}

function applyComparison(
  op: '=' | '<>' | '<' | '<=' | '>' | '>=',
  left: ScalarValue,
  right: ScalarValue,
): Step {
  if (left.kind === 'error') return scalar(left);
  if (right.kind === 'error') return scalar(right);
  let ordering: number;
  if (left.kind === 'number' && right.kind === 'number') {
    ordering = compareNumbers(left.value, right.value);
  } else if (left.kind === 'text' && right.kind === 'text') {
    ordering = compareText(left.value, right.value);
  } else if (left.kind === 'boolean' && right.kind === 'boolean') {
    ordering = compareNumbers(left.value ? 1 : 0, right.value ? 1 : 0);
  } else {
    return blocked(
      'incomparable_operands',
      `比较 ${op} 的两端类型不同（${left.kind} 与 ${right.kind}）：本仓不给跨类型全序，显式阻塞`,
    );
  }
  switch (op) {
    case '=':
      return scalar(booleanValue(ordering === 0));
    case '<>':
      return scalar(booleanValue(ordering !== 0));
    case '<':
      return scalar(booleanValue(ordering < 0));
    case '<=':
      return scalar(booleanValue(ordering <= 0));
    case '>':
      return scalar(booleanValue(ordering > 0));
    case '>=':
      return scalar(booleanValue(ordering >= 0));
    default: {
      const never: never = op;
      throw new ValidationError(`比较运算未覆盖：${JSON.stringify(never)}`);
    }
  }
}

function compareNumbers(a: number, b: number): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** 文本比较：Excel 为**大小写不敏感**，此处跟随。 */
function compareText(a: string, b: string): number {
  const left = a.toUpperCase();
  const right = b.toUpperCase();
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// 函数
// ---------------------------------------------------------------------------

function evalCall(name: string, args: readonly FormulaNode[], context: FormulaContext): Step {
  const upper = name.toUpperCase();
  if (!SUPPORTED_SET.has(upper)) {
    return blocked(
      'unsupported_function',
      `函数 ${JSON.stringify(name)} 不在本仓白名单内（支持：${SUPPORTED_FUNCTIONS.join(' / ')}），保留原文并阻塞`,
    );
  }
  // 惰性 / 可带区域的函数单独走：`IF` 只求值被选中的分支；
  // 聚合函数**必须**拿到未展开的实参（区域只能作为聚合实参，不能被预先降成标量）。
  if (upper === 'IF') {
    return evalIf(args, context);
  }
  if (upper === 'AND' || upper === 'OR') {
    return evalLogical(upper, args, context);
  }
  if (upper === 'SUM' || upper === 'AVERAGE' || upper === 'MIN' || upper === 'MAX' || upper === 'COUNT' || upper === 'COUNTA') {
    return aggregate(upper, args, context);
  }
  const evaluated: ScalarValue[] = [];
  for (const arg of args) {
    const step = evalNode(arg, context);
    if (!step.ok) return step;
    if (step.box.kind !== 'scalar') {
      return blocked('unsupported_construct', `${upper} 的实参必须是标量（区域不在其参数形状内）`);
    }
    evaluated.push(step.box.value);
  }
  switch (upper) {
    case 'NOT':
      return evalNot(evaluated, upper);
    case 'ABS':
      return evalAbs(evaluated, upper);
    case 'ROUND':
      return evalRound(evaluated, upper);
    case 'SQRT':
      return evalSqrt(evaluated, upper);
    /* c8 ignore next 3 -- 上面的白名单分派已覆盖全部函数名，此处只为穷尽性 */
    default:
      throw new ValidationError(`求值器未覆盖的函数：${JSON.stringify(upper)}`);
  }
}

/**
 * 从实参列表里收集数值贡献。
 *
 * 空白**跳过**（既不贡献、也不计入 `AVERAGE` 的分母，**不是**当作 0）；
 * 文本 / 区域内的布尔跳过（Excel 语义）；直接实参里的布尔按 1/0 计入；
 * 日期值标记（上层据此阻塞，不做隐式序列号转换）；错误值传播；
 * 任一实参求值阻塞 ⇒ 整体阻塞（**不静默丢弃**）。
 */
function collectAggregate(args: readonly FormulaNode[], context: FormulaContext): AggregateTally {
  const tally: AggregateTally = {
    numbers: [],
    nonBlank: 0,
    error: null,
    date_seen: false,
    blocked: null,
  };

  for (const arg of args) {
    const step = evalNode(arg, context);
    if (!step.ok) {
      tally.blocked ??= step;
      continue;
    }
    if (step.box.kind === 'scalar') {
      tallyScalar(tally, step.box.value, true);
      continue;
    }
    const expanded = expandRange(step.box, context);
    if (!expanded.ok) {
      tally.blocked ??= expanded.step;
      continue;
    }
    for (const cell of expanded.cells) {
      tallyScalar(tally, cell.value, false);
    }
  }
  return tally;
}

interface AggregateTally {
  readonly numbers: number[];
  nonBlank: number;
  error: ErrorValue | null;
  date_seen: boolean;
  blocked: Step | null;
}

function tallyScalar(tally: AggregateTally, value: CellValue, direct: boolean): void {
  switch (value.kind) {
    case 'number':
      tally.numbers.push(value.value);
      tally.nonBlank += 1;
      return;
    case 'boolean':
      // Excel：区域里的布尔被 SUM 忽略；直接实参的布尔按 1/0 计入。
      if (direct) tally.numbers.push(value.value ? 1 : 0);
      tally.nonBlank += 1;
      return;
    case 'text':
      tally.nonBlank += 1;
      return;
    case 'date':
      tally.date_seen = true;
      tally.nonBlank += 1;
      return;
    case 'error':
      tally.error ??= value;
      return;
    case 'blank':
      return; // 跳过：既不贡献，也不计入分母（**不是**当作 0）
    case 'formula':
      /* c8 ignore next 2 -- 驱动层已把公式格算成缓存值 */
      tally.blocked ??= blocked('unsupported_construct', '聚合遇到未求值的公式格');
      return;
    default: {
      const never: never = value;
      throw new ValidationError(`聚合未覆盖的取值：${JSON.stringify(never)}`);
    }
  }
}

function aggregate(name: string, args: readonly FormulaNode[], context: FormulaContext): Step {
  if (args.length === 0) {
    return blocked('invalid_arguments', `${name} 至少需要一个实参`);
  }
  const tally = collectAggregate(args, context);
  if (tally.blocked !== null) return tally.blocked;
  if (tally.error !== null) return scalar(tally.error);
  if (tally.date_seen) {
    return blocked(
      'non_numeric_operand',
      `${name} 的实参里出现日期值：本仓不做隐式 日期→序列号 转换`,
    );
  }
  if (name === 'COUNT') {
    // 计数是**计数**，不是"缺失的值"——0 个数值就是 0，不是伪造。
    return scalar(numberValue(tally.numbers.length));
  }
  if (name === 'COUNTA') {
    return scalar(numberValue(tally.nonBlank));
  }
  if (tally.numbers.length === 0) {
    return blocked(
      'empty_aggregate',
      `${name} 没有任何数值贡献：按 R248 阻塞而不返回 0（与 quantity.ts 的空求和口径一致）`,
    );
  }
  switch (name) {
    case 'SUM':
      return numberResult(tally.numbers.reduce((total, value) => total + value, 0));
    case 'AVERAGE':
      return numberResult(tally.numbers.reduce((total, value) => total + value, 0) / tally.numbers.length);
    case 'MIN':
      return numberResult(Math.min(...tally.numbers));
    case 'MAX':
      return numberResult(Math.max(...tally.numbers));
    /* c8 ignore next 3 -- 上面的分派已限定六个函数名 */
    default:
      throw new ValidationError(`聚合未覆盖的函数：${JSON.stringify(name)}`);
  }
}

/** `IF(cond, then, [else])`：**只求值被选中的那一支**（Excel 惰性语义）。 */
function evalIf(args: readonly FormulaNode[], context: FormulaContext): Step {
  if (args.length !== 2 && args.length !== 3) {
    return blocked('invalid_arguments', `IF 需要 2 或 3 个实参，收到 ${String(args.length)}`);
  }
  const conditionNode = args[0];
  /* c8 ignore next -- args.length 已保证存在 */
  if (conditionNode === undefined) {
    return blocked('invalid_arguments', 'IF 缺少条件实参');
  }
  const condition = evalNode(conditionNode, context);
  if (!condition.ok) return condition;
  if (condition.box.kind !== 'scalar') {
    return blocked('unsupported_construct', 'IF 的条件必须是标量');
  }
  const truth = booleanOperand(condition.box.value, 'IF 的条件');
  if (!truth.ok) return truth.step;
  const branch = truth.value ? args[1] : args[2];
  if (branch === undefined) {
    return scalar(booleanValue(false)); // Excel：省略 else 且条件为假 ⇒ FALSE
  }
  return evalNode(branch, context);
}

function evalLogical(name: 'AND' | 'OR', args: readonly FormulaNode[], context: FormulaContext): Step {
  if (args.length === 0) {
    return blocked('invalid_arguments', `${name} 至少需要一个实参`);
  }
  const values: boolean[] = [];
  for (const arg of args) {
    const step = evalNode(arg, context);
    if (!step.ok) return step;
    if (step.box.kind !== 'scalar') {
      return blocked('unsupported_construct', `${name} 的实参必须是标量`);
    }
    const truth = booleanOperand(step.box.value, `${name} 的实参`);
    if (!truth.ok) return truth.step;
    values.push(truth.value);
  }
  return scalar(booleanValue(name === 'AND' ? values.every(Boolean) : values.some(Boolean)));
}

function evalNot(args: readonly ScalarValue[], name: string): Step {
  const only = args[0];
  if (args.length !== 1 || only === undefined) {
    return blocked('invalid_arguments', `${name} 需要恰好 1 个实参，收到 ${String(args.length)}`);
  }
  const truth = booleanOperand(only, `${name} 的实参`);
  if (!truth.ok) return truth.step;
  return scalar(booleanValue(!truth.value));
}

function evalAbs(args: readonly ScalarValue[], name: string): Step {
  const only = args[0];
  if (args.length !== 1 || only === undefined) {
    return blocked('invalid_arguments', `${name} 需要恰好 1 个实参，收到 ${String(args.length)}`);
  }
  const numeric = numericOperand(only, `${name} 的实参`);
  if (!numeric.ok) return numeric.step;
  return numberResult(Math.abs(numeric.value));
}

function evalSqrt(args: readonly ScalarValue[], name: string): Step {
  const only = args[0];
  if (args.length !== 1 || only === undefined) {
    return blocked('invalid_arguments', `${name} 需要恰好 1 个实参，收到 ${String(args.length)}`);
  }
  const numeric = numericOperand(only, `${name} 的实参`);
  if (!numeric.ok) return numeric.step;
  if (numeric.value < 0) {
    return scalar(errorValue('#NUM!'));
  }
  return numberResult(Math.sqrt(numeric.value));
}

function evalRound(args: readonly ScalarValue[], name: string): Step {
  if (args.length !== 1 && args.length !== 2) {
    return blocked('invalid_arguments', `${name} 需要 1 或 2 个实参，收到 ${String(args.length)}`);
  }
  const numberArg = args[0];
  /* c8 ignore next -- args.length 已保证 */
  if (numberArg === undefined) return blocked('invalid_arguments', `${name} 缺少实参`);
  const numeric = numericOperand(numberArg, `${name} 的数值实参`);
  if (!numeric.ok) return numeric.step;

  let digits = 0;
  const digitsArg = args[1];
  if (digitsArg !== undefined) {
    const digitsNumeric = numericOperand(digitsArg, `${name} 的位数实参`);
    if (!digitsNumeric.ok) return digitsNumeric.step;
    digits = Math.trunc(digitsNumeric.value);
  }
  if (digits < ROUND_MIN_DIGITS || digits > ROUND_MAX_DIGITS) {
    return blocked(
      'invalid_arguments',
      `${name} 的位数 ${String(digits)} 超出本仓支持范围 ${String(ROUND_MIN_DIGITS)}…${String(ROUND_MAX_DIGITS)}（负位数 / 超大位数不做）`,
    );
  }
  // 复用 W-A 的定点格式化（BigInt 进位、half away from zero），保证与 Excel 的 ROUND 同口径。
  return numberResult(Number(formatDecimal(numeric.value, digits)));
}

// ---------------------------------------------------------------------------
// 工作簿级驱动：跨表解析 + 记忆化 + 环检测
// ---------------------------------------------------------------------------

interface DriverFrame {
  readonly workbook: WorkbookState;
  readonly memo: Map<string, CellResolution>;
  readonly visiting: Set<string>;
}

function cellKey(sheet: string, address: CellAddress): string {
  return `${sheet}!${String(address.column)}:${String(address.row)}`;
}

function resolveForDriver(frame: DriverFrame, sheetName: string, address: CellAddress): CellResolution {
  const key = cellKey(sheetName, address);
  const cached = frame.memo.get(key);
  if (cached !== undefined) {
    return cached;
  }
  if (frame.visiting.has(key)) {
    return { kind: 'blocked', reason: 'circular_reference', detail: `公式引用成环，落点 ${key}` };
  }
  const sheet = getSheet(frame.workbook, sheetName);
  if (sheet === undefined) {
    return { kind: 'blocked', reason: 'unknown_sheet', detail: `工作簿里没有工作表 ${JSON.stringify(sheetName)}` };
  }
  const value = getCellValue(sheet, address);
  if (value.kind !== 'formula') {
    frame.memo.set(key, { kind: 'value', value });
    return { kind: 'value', value };
  }
  frame.visiting.add(key);
  let resolution: CellResolution;
  try {
    const outcome = evaluateCellFormula(frame, sheetName, value.text);
    resolution = outcome.ok
      ? { kind: 'value', value: outcome.value }
      : { kind: 'blocked', reason: outcome.reason, detail: outcome.detail };
  } finally {
    frame.visiting.delete(key);
  }
  frame.memo.set(key, resolution);
  return resolution;
}

function evaluateCellFormula(frame: DriverFrame, sheetName: string, text: string): EvalOutcome {
  const context: FormulaContext = {
    current_sheet: sheetName,
    hasSheet: (name) => getSheet(frame.workbook, name) !== undefined,
    resolveCell: (sheet, address) =>
      resolveForDriver(frame, sheet ?? sheetName, address),
  };
  return evaluateFormula(text, context);
}

/**
 * 求值工作簿里某个单元格。**非公式格直接返回其取值**；公式格返回求值结果。
 *
 * 记忆化 + 环检测在同一帧内共享，因此互相引用的公式链只算一次；成环则相关落点
 * 一律返回 `circular_reference` 阻塞（**不返回部分结果**）。
 *
 * @throws {ValidationError} 工作表不存在
 */
export function evaluateWorkbookCell(
  workbook: WorkbookState,
  sheetName: string,
  address: CellAddress,
): EvalOutcome {
  const sheet = getSheet(workbook, sheetName);
  if (sheet === undefined) {
    throw new ValidationError(`evaluateWorkbookCell：工作簿里没有工作表 ${JSON.stringify(sheetName)}`);
  }
  const frame: DriverFrame = { workbook, memo: new Map(), visiting: new Set() };
  return toOutcome(resolveForDriver(frame, sheetName, address));
}

/** 单元格解析结果 → 求值结果。**空白格在这里阻塞**（R248）。 */
function toOutcome(resolution: CellResolution): EvalOutcome {
  if (resolution.kind === 'blocked') {
    return { ok: false, reason: resolution.reason, detail: resolution.detail };
  }
  if (resolution.value.kind === 'blank') {
    return { ok: false, reason: 'blank_operand', detail: '该单元格是空白格，没有可求的值（R248）' };
  }
  if (resolution.value.kind === 'formula') {
    /* c8 ignore next -- resolveForDriver 不会把公式格原样返回 */
    return { ok: false, reason: 'unsupported_construct', detail: '公式格未被求值' };
  }
  if (resolution.value.kind === 'date') {
    return {
      ok: false,
      reason: 'unsupported_construct',
      detail: '该单元格是日期值：日期不是求值层的标量，本仓不做隐式 日期→序列号 转换',
    };
  }
  return { ok: true, value: resolution.value };
}

/**
 * 求值工作簿里**每一个**公式单元格，返回逐格结果。
 *
 * 这是序列化层需要的入口：写 `<v>` 缓存前，先知道哪些公式算得出来、哪些必须阻塞。
 */
export function evaluateWorkbookFormulas(
  workbook: WorkbookState,
): readonly { readonly sheet: string; readonly address: CellAddress; readonly text: string; readonly outcome: EvalOutcome }[] {
  const results: { sheet: string; address: CellAddress; text: string; outcome: EvalOutcome }[] = [];
  for (const sheet of workbook.sheets) {
    for (const [ref, value] of sheet.cells) {
      if (value.kind !== 'formula') continue;
      const address = parseAddress(ref);
      const frame: DriverFrame = { workbook, memo: new Map(), visiting: new Set() };
      const resolution = resolveForDriver(frame, sheet.name, address);
      results.push({ sheet: sheet.name, address, text: value.text, outcome: toOutcome(resolution) });
    }
  }
  return Object.freeze(results.map((entry) => Object.freeze(entry)));
}

/** A1 文本 → 地址（本模块内部用；不走 `sheet.ts` 以免循环依赖）。 */
function parseAddress(ref: string): CellAddress {
  const match = /^([A-Za-z]{1,3})(\d{1,7})$/.exec(ref);
  /* c8 ignore next -- sheet.ts 只往 cells 里写规范化地址 */
  if (match === null || match[1] === undefined || match[2] === undefined) {
    throw new ValidationError(`evaluateWorkbookFormulas 收到非法地址 ${JSON.stringify(ref)}`);
  }
  let column = 0;
  for (const ch of match[1].toUpperCase()) {
    column = column * 26 + (ch.charCodeAt(0) - 0x40);
  }
  return { column, row: Number.parseInt(match[2], 10) };
}
