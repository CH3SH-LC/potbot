/**
 * 表格域：公式**引用模型**（design-06-P8 / XLS-06、XLS-08）。
 *
 * ## 这个文件补的是哪块空白
 *
 * | 既有文件 | 它回答的问题 | 它**不**回答的 |
 * |---|---|---|
 * | `reference.ts` | 一个 **A1 地址**指向哪、行列增删后指向哪 | 相对 / 绝对 / 混合引用的**模型**；工作表限定；命名区域 |
 * | `formula.ts` | 一段公式文本**能不能安全改写**（保守字符串改写） | 引用的**结构化表示**、复制 / 填充语义 |
 * | `formula-parse.ts` | 一段公式的**语法树** | 引用模型的规范化、跨表前缀的书写规则 |
 *
 * 本文件把三者之上缺的那一层**显式建模**：一个引用到底是
 * 「单元格 / 区域 / 命名区域」哪一种，带不带工作表限定，哪些轴是 `$` 固定的。
 * 有了这层，**平移**（复制 / 填充时相对引用随位移）与**规范化**（同一引用的唯一书写）
 * 才是可断言的两条纯函数，而不是散落在字符串改写里的隐式行为。
 *
 * ## XLS-06「保存的是可编辑公式，不是结果数值」在本文件的形状
 *
 * 模型里**没有承载缓存值的字段**：{@link CellReferenceModel} / {@link RangeReferenceModel} /
 * {@link NamedRegionReference} 只有坐标与名字。因此"写公式的时候顺手把结果塞进去"在这里
 * **类型上就写不出来**；{@link buildEditableFormulaCellXml} 产出的是 `<c r="A1"><f>原文</f></c>`，
 * **没有 `<v>`**。带缓存的写法（`<f>` + `<v>`）在 `formula-cache.ts`，且那里的 `<v>` 只能来自
 * 重算结论，不能来自调用方的一个数。
 *
 * ## 平移到什么程度、阻塞到什么程度
 *
 * - **单引用级**（{@link shiftReferenceModel}）：能平移就平移，越界抛 `ValidationError`
 *   （与 `reference.ts` 的 `shiftReference` 同口径）。
 * - **公式级**（{@link shiftFormula} / {@link normalizeFormula}）：走 `formula-parse.ts` 的 AST，
 *   **语法过不去就整体阻塞并保留原文**（`{ ok: false, original }`）。命名区域正落在这一档：
 *   本仓的解析子集不含命名区域（见 `formula-parse.ts` 文件头），所以含命名区域的公式
 *   **平移请求一律阻塞**——**不会**"看起来平移成功、实则原样返回"。这是 XLS-08
 *   「不支持的公式**保留或阻塞**」在平移这条路径上的执行点。
 *
 * ## 一个刻意的偏离：区域两端**不重排**
 *
 * `reference.ts` 的 `parseRange` 会把区域归一化成左上 / 右下；本文件**保留原文顺序**
 * （`A3:A1` 就是 `A3:A1`）。理由是这里做的是**代码改写**：重排会改变公式"看起来的样子"，
 * 而改写一条本意的公式不是本模块的职责。规范化只做**书写层**的事
 * （列字母大小写、`$` 位置、工作表前缀的引号）。
 *
 * ## 与 Excel 的一致性边界（如实登记）
 *
 * | 语义 | Excel | 本模块 |
 * |---|---|---|
 * | `$` 固定的是**复制 / 填充**的位移 | 是 | 是（`shiftReferenceModel` 只动非绝对轴） |
 * | `$` **不**固定行 / 列插入删除的位移 | 是 | 是（那是 `reference.ts` 的迁移，与本模块无关） |
 * | 跨表引用的相对轴在复制时同样位移 | 是 | 是（表前缀只是限定词，不参与"要不要位移"的判断） |
 * | 命名区域不随复制位移 | 是 | 是（{@link shiftReferenceModel} 原样返回） |
 * | 命名区域大小写不敏感 | 是 | 是（{@link resolveNamedRegion} 按大写查） |
 * | 名称形如**越界**引用（`XFE1`） | 允许作名字 | **拒绝**（`looksLikeCellReference`） | 那种输入几乎总是拼错的引用；静默当名字会把错误藏起来 |
 *
 * 本模块**不做** IO、不读时钟、不用 locale；同一输入必得同一输出。
 */

import { attr, el, serializeXmlNode, type XmlElement } from '../artifacts/ooxml/index.js';
import { ValidationError } from '../protocol/index.js';
import { FormulaParseError, parseFormula, type BinaryOp, type FormulaNode } from './formula-parse.js';
import {
  formatCellAddress,
  formatCellReference,
  parseCellAddress,
  parseCellReference,
  shiftReference,
  type CellReference,
  type ReferenceDelta,
} from './reference.js';
import { isValidSheetName } from './sheet.js';

// ---------------------------------------------------------------------------
// 引用模型
// ---------------------------------------------------------------------------

/** 命名的区域 / 常量（没有坐标，也没有 `$`）。 */
export interface NamedRegionReference {
  readonly kind: 'name';
  readonly name: string;
}

/** 单元格引用（可带工作表限定）。`sheet === null` ⇒ 本表（无前缀）。 */
export interface CellReferenceModel {
  readonly kind: 'cell';
  readonly sheet: string | null;
  readonly reference: CellReference;
}

/**
 * 矩形区域引用（含两端，**按原文顺序保留**）。
 *
 * 两端必须同表：`Sheet1!A1:Sheet2!B2` 这类三维 / 跨表区域本模块**显式拒绝**
 * （与 `formula-parse.ts` 同口径，不猜调用方意图）。
 */
export interface RangeReferenceModel {
  readonly kind: 'range';
  readonly sheet: string | null;
  readonly start: CellReference;
  readonly end: CellReference;
}

/** 引用模型：单元格 / 区域 / 命名区域，三类互不冒充。 */
export type ReferenceModel = CellReferenceModel | RangeReferenceModel | NamedRegionReference;

/** Excel 定义的名称：首字符是字母 / 下划线 / 反斜杠 / 汉字，后续可含数字、点、下划线。 */
const NAMED_REGION_PATTERN = /^[\p{L}_\\][\p{L}\p{N}._]*$/u;

/** Excel 名称长度上限。 */
export const MAX_NAMED_REGION_LENGTH = 255;

/** Excel 中不可用作名称的保留词（`R` / `C` 是 R1C1 记法的列 / 行标识，`TRUE` / `FALSE` 是字面量）。 */
const RESERVED_NAMES: readonly string[] = Object.freeze(['R', 'C', 'TRUE', 'FALSE']);

/** 记忆化一份合法名称（避免每次 `parseReferenceModel` 都重跑正则）。 */
const CELL_REFERENCE_SHAPED_CACHE = new Map<string, boolean>();

/**
 * **形状**像单元格引用（`$` 可选、1–3 个字母 + 1–7 位数字），**不管是否越界**。
 *
 * 为什么要把"形状"与"合法"分开：`XFE1`（第 16385 列）与 `A1048577` 越出了 Excel 网格，
 * 它们**不是**合法引用；但把它们当成命名区域是危险的——那种输入几乎总是"拼错的引用"，
 * 静默解释成一个名字会让错误藏起来。因此本模块对这类输入**显式失败**。
 */
const LOOKS_LIKE_CELL_REFERENCE = /^\$?[A-Za-z]{1,3}\$?[0-9]{1,7}$/;

/** 这段文本**是不是**一个合法单元格引用（`A1` / `$A$1`；越界如 `XFE1` 不算）。 */
export function isCellReferenceShaped(text: unknown): boolean {
  if (typeof text !== 'string' || text.length === 0) {
    return false;
  }
  const cached = CELL_REFERENCE_SHAPED_CACHE.get(text);
  if (cached !== undefined) {
    return cached;
  }
  let shaped: boolean;
  try {
    parseCellReference(text);
    shaped = true;
  } catch {
    shaped = false;
  }
  CELL_REFERENCE_SHAPED_CACHE.set(text, shaped);
  return shaped;
}

/** 这段文本的形状**像**单元格引用（含越界形状如 `XFE1` / `A1048577`）。 */
export function looksLikeCellReference(text: unknown): boolean {
  return typeof text === 'string' && LOOKS_LIKE_CELL_REFERENCE.test(text);
}

/**
 * 一个合法命名区域名。
 *
 * 拒绝的四类（**每一类都对应一次真实的撞车**）：
 * 1. 形状 / 长度不合 Excel 名称规则；
 * 2. **长得像单元格引用**（`A1`、`XFD1048576`）——否则定义名会与引用二义；
 * 3. 保留词 `R` / `C` / `TRUE` / `FALSE`；
 * 4. 非字符串 / 空串。
 */
export function isValidNamedRegionName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAMED_REGION_LENGTH) {
    return false;
  }
  if (!NAMED_REGION_PATTERN.test(name)) {
    return false;
  }
  // 形状像引用就拒绝（含越界形状）——见 {@link looksLikeCellReference}。
  if (looksLikeCellReference(name)) {
    return false;
  }
  return !RESERVED_NAMES.includes(name.toUpperCase());
}

/** 名称的**规范书写**（Excel 名称大小写不敏感，本模块统一按大写作键）。@throws {ValidationError} */
export function normalizeNamedRegionName(name: string): string {
  if (!isValidNamedRegionName(name)) {
    throw new ValidationError(
      `不是合法的命名区域名：${JSON.stringify(name)}（不得为空、不得超过 ${String(MAX_NAMED_REGION_LENGTH)} 字符、` +
        '不得与单元格引用的形状相同、不得是 R / C / TRUE / FALSE）',
    );
  }
  return name.toUpperCase();
}

/**
 * 工作表前缀的书写形式：`Sheet1!` 或 `'预算 表'!`（内部单引号写成两个）。
 *
 * 引号的必要性不是审美问题：`预算 表!A1` 在 Excel / 本仓解析器里都是**解析不了的**
 * （空格会成为公式里的空白），所以含空格、含标点、以数字或 `.` 开头、看起来像单元格引用
 * 或布尔字面量的表名**必须**加引号。
 *
 * **纯字母（含汉字等非 ASCII 字母）的表名不加引号**：Excel 对其不强制加引号，
 * 解析器（`formula-parse.ts`）也已支持裸名（`=明细!A1`）。因此
 * `formatReferenceModel(parseReferenceModel('明细!A1'))` 逐字回到 `明细!A1`。
 *
 * @throws {ValidationError} 表名非法（复用 `sheet.ts` 的合法名约定）
 */
export function formatSheetQualifier(name: string): string {
  if (!isValidSheetName(name)) {
    throw new ValidationError(`工作表前缀的表名非法：${JSON.stringify(name)}`);
  }
  const simple = /^[\p{L}_][\p{L}\p{N}_.]*$/u.test(name);
  const needsQuote =
    !simple || isCellReferenceShaped(name) || /^(TRUE|FALSE)$/i.test(name) || name.includes('!');
  if (!needsQuote) {
    return `${name}!`;
  }
  return `'${name.replace(/'/g, "''")}'!`;
}

function requireBodyText(body: string, original: string, where: string): string {
  if (body.length === 0) {
    throw new ValidationError(`${where}：${JSON.stringify(original)} 的工作表前缀后没有引用`);
  }
  if (body.includes('!')) {
    throw new ValidationError(
      `${where}：${JSON.stringify(original)} 含有第二个 "!"（跨表 / 三维区域），本仓显式拒绝，不猜调用方意图`,
    );
  }
  return body;
}

/** 拆出工作表前缀与引用主体。无前缀 ⇒ `sheet === null`。@throws {ValidationError} */
function splitSheetQualifier(text: string, where: string): { readonly sheet: string | null; readonly body: string } {
  if (text.startsWith("'")) {
    let name = '';
    let index = 1;
    for (;;) {
      if (index >= text.length) {
        throw new ValidationError(`${where}：${JSON.stringify(text)} 的单引号未闭合`);
      }
      const ch = text.charAt(index);
      if (ch === "'") {
        if (text.charAt(index + 1) === "'") {
          name += "'";
          index += 2;
          continue;
        }
        index += 1;
        break;
      }
      name += ch;
      index += 1;
    }
    if (name.length === 0) {
      throw new ValidationError(`${where}：${JSON.stringify(text)} 的工作表名是空串`);
    }
    if (text.charAt(index) !== '!') {
      throw new ValidationError(`${where}：${JSON.stringify(text)} 的单引号闭合后应当是 "!"`);
    }
    return { sheet: name, body: requireBodyText(text.slice(index + 1), text, where) };
  }
  // 无引号：按**最后一个** `!` 切分（与 `recalc.ts` 的 `parseCellKey` 同口径，
  // 表名里出现 `!` 这种少见情形也不会把前缀切错）。
  const separator = text.lastIndexOf('!');
  if (separator === -1) {
    return { sheet: null, body: text };
  }
  if (separator === 0) {
    throw new ValidationError(`${where}：${JSON.stringify(text)} 的 "!" 之前没有工作表名`);
  }
  const prefix = text.slice(0, separator);
  if (prefix.includes('!')) {
    // 前缀里还有 `!` ⇒ 这其实是跨表 / 三维引用（`Sheet1!A1!B2`），或表名自身需要加引号。
    // 本仓**显式拒绝**，不把 `Sheet1!A1` 当成一个表名。
    throw new ValidationError(
      `${where}：${JSON.stringify(text)} 含有第二个 "!"（跨表 / 三维引用），本仓显式拒绝，不猜调用方意图`,
    );
  }
  return { sheet: prefix, body: requireBodyText(text.slice(separator + 1), text, where) };
}

function parseBodyWithSheet(sheet: string | null, body: string, original: string, where: string): ReferenceModel {
  if (body.includes(':')) {
    const parts = body.split(':');
    const startText = parts[0];
    const endText = parts[1];
    if (parts.length !== 2 || startText === undefined || endText === undefined || startText === '' || endText === '') {
      throw new ValidationError(`${where}：无法解析区域 ${JSON.stringify(original)}`);
    }
    return {
      kind: 'range',
      sheet,
      start: parseCellReference(startText),
      end: parseCellReference(endText),
    };
  }
  try {
    return { kind: 'cell', sheet, reference: parseCellReference(body) };
  } catch (error) {
    if (sheet !== null) {
      throw new ValidationError(
        `${where}：${JSON.stringify(original)} 的工作表前缀后不是单元格引用` +
          '（跨表命名区域不在本仓子集内，显式拒绝）',
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * 解析一个引用（`A1` / `$A$1` / `A$1` / `$A1` / `A1:B2` / `Sheet1!A1` / `'预算 表'!B2` / `TaxRate`）。
 *
 * 三类结果互不冒充；读不懂就抛 `ValidationError`（**不回落成命名区域**）——
 * 把一个读不懂的东西当成命名区域，会让"名字拼错了"看起来像"引用了某个名字"。
 *
 * @throws {ValidationError} 文本非法 / 越界 / 跨表区域 / 空串
 */
export function parseReferenceModel(text: string): ReferenceModel {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new ValidationError('引用文本必须是非空字符串');
  }
  const trimmed = text.trim();
  const { sheet, body } = splitSheetQualifier(trimmed, 'parseReferenceModel');
  if (sheet !== null) {
    return parseBodyWithSheet(sheet, body, trimmed, 'parseReferenceModel');
  }
  try {
    return parseBodyWithSheet(null, body, trimmed, 'parseReferenceModel');
  } catch (error) {
    if (!(error instanceof ValidationError)) {
      throw error;
    }
    if (isValidNamedRegionName(trimmed)) {
      return { kind: 'name', name: trimmed };
    }
    if (looksLikeCellReference(trimmed)) {
      throw new ValidationError(
        `无法解析引用 ${JSON.stringify(trimmed)}：形状像单元格引用但越出 Excel 网格` +
          `（列 ≤ XFD、行 ≤ 1048576），显式失败而**不**回落成命名区域`,
        { cause: error },
      );
    }
    throw new ValidationError(
      `无法解析引用 ${JSON.stringify(trimmed)}：既不是合法单元格引用 / 区域，也不是合法命名区域`,
      { cause: error },
    );
  }
}

/** 格式化引用模型（**规范书写**：列字母大写、`$` 保留、表名前缀按需加引号）。@throws {ValidationError} */
export function formatReferenceModel(model: ReferenceModel): string {
  switch (model.kind) {
    case 'name':
      return model.name;
    case 'cell':
      return `${model.sheet === null ? '' : formatSheetQualifier(model.sheet)}${formatCellReference(model.reference)}`;
    case 'range':
      return (
        `${model.sheet === null ? '' : formatSheetQualifier(model.sheet)}` +
        `${formatCellReference(model.start)}:${formatCellReference(model.end)}`
      );
    default: {
      const never: never = model;
      throw new ValidationError(`formatReferenceModel 未覆盖的模型：${JSON.stringify(never)}`);
    }
  }
}

function assertDelta(delta: ReferenceDelta, where: string): void {
  if (!Number.isInteger(delta.column) || !Number.isInteger(delta.row)) {
    throw new ValidationError(
      `${where} 的位移必须是整数行列增量，收到 ${JSON.stringify(delta)}`,
    );
  }
}

/**
 * 按**复制 / 填充**语义平移一个引用模型：只有**非绝对**的轴跟着动。
 *
 * - 单元格 / 区域：逐端走 `reference.ts` 的 `shiftReference`（越界 ⇒ `ValidationError`）；
 * - **命名区域：原样返回**（名字没有坐标可平移）。
 *
 * 跨表引用的相对轴同样平移——表前缀只是限定词，不是"冻结"。
 *
 * @throws {ValidationError} 位移非整数 / 平移结果越出 Excel 网格
 */
export function shiftReferenceModel(model: ReferenceModel, delta: ReferenceDelta): ReferenceModel {
  assertDelta(delta, 'shiftReferenceModel');
  switch (model.kind) {
    case 'name':
      return model;
    case 'cell':
      return { kind: 'cell', sheet: model.sheet, reference: shiftReference(model.reference, delta) };
    case 'range':
      return {
        kind: 'range',
        sheet: model.sheet,
        start: shiftReference(model.start, delta),
        end: shiftReference(model.end, delta),
      };
    default: {
      const never: never = model;
      throw new ValidationError(`shiftReferenceModel 未覆盖的模型：${JSON.stringify(never)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 命名区域表
// ---------------------------------------------------------------------------

/** 一条定义：名字 + 它指向的引用（**不允许再指另一个名字**，即定义不能链式引用）。 */
export interface NamedRegionDefinition {
  readonly name: string;
  readonly target: string;
}

/**
 * 命名区域表：键是**大写**名字（Excel 名称大小写不敏感），值是解析好的引用模型（冻结）。
 */
export type NamedRegionTable = ReadonlyMap<string, CellReferenceModel | RangeReferenceModel>;

/**
 * 建表。**逐条校验**：名字非法（含与单元格引用同形）⇒ 抛；目标非法或指向另一个名字 ⇒ 抛。
 *
 * 为什么不静默跳过非法条目：一个"悄悄少了一条"的名字表，会让后续 `#NAME?` 的定位
 * 指向错误的方向（看起来是公式写错了，实际是定义表被吞了）。
 *
 * @throws {ValidationError}
 */
export function createNamedRegionTable(
  definitions: readonly NamedRegionDefinition[],
): NamedRegionTable {
  if (!Array.isArray(definitions)) {
    throw new ValidationError('createNamedRegionTable 需要定义数组');
  }
  const table = new Map<string, CellReferenceModel | RangeReferenceModel>();
  for (const definition of definitions) {
    const key = normalizeNamedRegionName(definition.name);
    if (table.has(key)) {
      throw new ValidationError(`命名区域重复定义：${JSON.stringify(definition.name)}（名称大小写不敏感）`);
    }
    const target = parseReferenceModel(definition.target);
    if (target.kind === 'name') {
      throw new ValidationError(
        `命名区域 ${JSON.stringify(definition.name)} 的目标 ${JSON.stringify(definition.target)} 又是一个名字：` +
          '定义链不在本仓子集内，显式拒绝',
      );
    }
    table.set(key, Object.freeze(target));
  }
  return table;
}

/**
 * 查名字。**找不到返回 `undefined`**（不是 `null`，也不是一个空区域）——
 * "没定义"与"定义成空"是两件事，后者会让 `#NAME?` 看起来像一次成功的解析。
 */
export function resolveNamedRegion(
  table: NamedRegionTable,
  name: string,
): CellReferenceModel | RangeReferenceModel | undefined {
  if (!isValidNamedRegionName(name)) {
    return undefined;
  }
  return table.get(normalizeNamedRegionName(name));
}

// ---------------------------------------------------------------------------
// 公式级：规范化与平移（AST 重写）
// ---------------------------------------------------------------------------

/**
 * 公式重写的阻塞原因（封闭枚举）。
 *
 * `parse_error` 里含命名区域与其它超子集构造——本仓的解析子集不含它们，
 * 因此"含命名区域的平移"在这里**必然**是阻塞，而不是静默返回原文。
 */
export type FormulaRewriteBlockReason =
  /** 语法 / 词法超出本仓子集（命名区域、结构化引用、数组常量……）。 */
  | 'parse_error'
  /** 平移后的引用越出 Excel 网格（列 > XFD 或行 > 1048576，或减成 ≤ 0）。 */
  | 'shifted_out_of_bounds';

/** 公式重写结果：要么给出新公式文本，要么**保留原文**并给出阻塞原因。 */
export type FormulaRewriteResult =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false;
      readonly reason: FormulaRewriteBlockReason;
      readonly detail: string;
      /** 原文（**逐字**，已去掉显示用的 `=` 前缀）——阻塞时调用方手里必须还有它。 */
      readonly original: string;
    };

/**
 * 公式文本的**口径统一**：去空白、去前缀 `=`（OOXML 的 `<f>` 里不写 `=`，见 `xlsx-read.ts`）。
 *
 * @throws {ValidationError} 非字符串 / 空串
 */
export function normalizeFormulaText(text: string): string {
  if (typeof text !== 'string') {
    throw new ValidationError('公式文本必须是字符串');
  }
  const trimmed = text.trim();
  const body = trimmed.startsWith('=') ? trimmed.slice(1).trim() : trimmed;
  if (body.length === 0) {
    throw new ValidationError(`公式文本不能为空（收到 ${JSON.stringify(text)}）`);
  }
  return body;
}

function binaryPrecedence(op: BinaryOp): number {
  switch (op) {
    case '=':
    case '<>':
    case '<':
    case '<=':
    case '>':
    case '>=':
      return 1;
    case '&':
      return 2;
    case '+':
    case '-':
      return 3;
    case '*':
    case '/':
      return 4;
    case '^':
      return 5;
    default: {
      const never: never = op;
      throw new ValidationError(`binaryPrecedence 未覆盖的运算符：${JSON.stringify(never)}`);
    }
  }
}

const UNARY_PRECEDENCE = 6;
const ATOM_PRECEDENCE = 7;

function isComparison(op: BinaryOp): boolean {
  return binaryPrecedence(op) === 1;
}

function nodePrecedence(node: FormulaNode): number {
  switch (node.kind) {
    case 'binary':
      return binaryPrecedence(node.op);
    case 'unary':
      return UNARY_PRECEDENCE;
    default:
      return ATOM_PRECEDENCE;
  }
}

/**
 * 打印子节点，**按需补最小必要括号**。
 *
 * 括号规则不是装饰：`(a-b)-c` 与 `a-(b-c)` 不同，而 AST → 文本必然要做这个决定。
 * 规则按运算符结合性给出：
 * - `^` **右结合** ⇒ 左子同优先级要括号（`(a^b)^c`），右子不要（`a^b^c`）；
 * - 比较运算符**不可链**（`formula-parse.ts` 只匹配一次）⇒ 同优先级子节点一律括号；
 * - 其余一元 / 二元都是左结合 ⇒ 右子同优先级要括号。
 */
function printOperand(
  child: FormulaNode,
  parentPrecedence: number,
  parentOp: BinaryOp | null,
  side: 'left' | 'right',
): string {
  const precedence = nodePrecedence(child);
  let wrap = precedence < parentPrecedence;
  if (!wrap && precedence === parentPrecedence && child.kind === 'binary' && parentOp !== null) {
    if (parentOp === '^') {
      wrap = side === 'left';
    } else if (isComparison(parentOp)) {
      wrap = true;
    } else {
      wrap = side === 'right';
    }
  }
  const text = printFormulaNode(child);
  return wrap ? `(${text})` : text;
}

/**
 * 把语法树打印回公式文本（**规范书写**：无多余空白、无多余括号、引用按模型格式化）。
 *
 * 数字用 `String(value)`（规范定义的最短往返表示，与 locale 无关）；
 * 文本里的 `"` 写成 `""`（Excel 的转义约定）。
 */
export function printFormulaNode(node: FormulaNode): string {
  switch (node.kind) {
    case 'number':
      return String(node.value);
    case 'text':
      return `"${node.value.replace(/"/g, '""')}"`;
    case 'boolean':
      return node.value ? 'TRUE' : 'FALSE';
    case 'reference':
      return formatReferenceModel({ kind: 'cell', sheet: node.sheet, reference: node.reference });
    case 'range':
      return formatReferenceModel({ kind: 'range', sheet: node.sheet, start: node.start, end: node.end });
    case 'call':
      return `${node.name}(${node.args.map((argument) => printFormulaNode(argument)).join(',')})`;
    case 'unary':
      return `${node.op}${printOperand(node.operand, UNARY_PRECEDENCE, null, 'right')}`;
    case 'binary': {
      const precedence = binaryPrecedence(node.op);
      const left = printOperand(node.left, precedence, node.op, 'left');
      const right = printOperand(node.right, precedence, node.op, 'right');
      return `${left}${node.op}${right}`;
    }
    default: {
      const never: never = node;
      throw new ValidationError(`printFormulaNode 未覆盖的节点：${JSON.stringify(never)}`);
    }
  }
}

function shiftNode(node: FormulaNode, delta: ReferenceDelta): FormulaNode {
  switch (node.kind) {
    case 'reference':
      return { kind: 'reference', sheet: node.sheet, reference: shiftReference(node.reference, delta) };
    case 'range':
      return {
        kind: 'range',
        sheet: node.sheet,
        start: shiftReference(node.start, delta),
        end: shiftReference(node.end, delta),
      };
    case 'call':
      return { kind: 'call', name: node.name, args: node.args.map((argument) => shiftNode(argument, delta)) };
    case 'unary':
      return { kind: 'unary', op: node.op, operand: shiftNode(node.operand, delta) };
    case 'binary':
      return { kind: 'binary', op: node.op, left: shiftNode(node.left, delta), right: shiftNode(node.right, delta) };
    default:
      return node;
  }
}

function rewriteFormula(text: string, delta: ReferenceDelta, where: string): FormulaRewriteResult {
  assertDelta(delta, where);
  const body = normalizeFormulaText(text);
  let node: FormulaNode;
  try {
    node = parseFormula(body);
  } catch (error) {
    if (error instanceof FormulaParseError) {
      return { ok: false, reason: 'parse_error', detail: error.message, original: body };
    }
    throw error;
  }
  let shifted: FormulaNode;
  try {
    shifted = shiftNode(node, delta);
  } catch (error) {
    if (error instanceof ValidationError) {
      return { ok: false, reason: 'shifted_out_of_bounds', detail: error.message, original: body };
    }
    throw error;
  }
  return { ok: true, text: printFormulaNode(shifted) };
}

/**
 * 按**复制 / 填充**语义平移公式里的全部引用（相对轴动、绝对轴与命名区域不动）。
 *
 * 返回的 `text` 是**公式**（可直接写进 `<f>`），不是结果数值。
 *
 * @throws {ValidationError} `delta` 非整数 / 文本非法（**公式本身读不懂不是异常**，是 `ok: false`）
 */
export function shiftFormula(text: string, delta: ReferenceDelta): FormulaRewriteResult {
  return rewriteFormula(text, delta, 'shiftFormula');
}

/** 规范化一段公式（= 零位移重写）：引用书写统一、去多余空白与括号、保留全部引用目标。 */
export function normalizeFormula(text: string): FormulaRewriteResult {
  return rewriteFormula(text, { column: 0, row: 0 }, 'normalizeFormula');
}

/**
 * 公式里的引用操作数（AST 遍历；**命名区域不在其中**——它压根解析不出来）。
 *
 * 解析失败返回 `null`（不是空数组：**"读不懂"与"确实没有引用"是两件事**，
 * 与 `formula.ts` 的 `extractFormulaReferences` 同口径）。
 */
export function formulaReferenceOperands(text: string): readonly ReferenceModel[] | null {
  const body = normalizeFormulaText(text);
  let node: FormulaNode;
  try {
    node = parseFormula(body);
  } catch (error) {
    if (error instanceof FormulaParseError) {
      return null;
    }
    throw error;
  }
  const found: ReferenceModel[] = [];
  const visit = (current: FormulaNode): void => {
    switch (current.kind) {
      case 'reference':
        found.push({ kind: 'cell', sheet: current.sheet, reference: current.reference });
        return;
      case 'range':
        found.push({ kind: 'range', sheet: current.sheet, start: current.start, end: current.end });
        return;
      case 'call':
        current.args.forEach(visit);
        return;
      case 'unary':
        visit(current.operand);
        return;
      case 'binary':
        visit(current.left);
        visit(current.right);
        return;
      default:
        return;
    }
  };
  visit(node);
  return Object.freeze(found);
}

// ---------------------------------------------------------------------------
// XML 片段：**只写 `<f>`，写不出 `<v>`**
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// `<f>` 的形状：普通 / 共享主格 / 共享从属格 / 数组（**读侧**建模）
// ---------------------------------------------------------------------------

/**
 * 公式格 `<f>` 的结构类别（**读侧**，与 `evaluate.ts` 的语法树无关）。
 *
 * - `normal`：`<f>原文</f>`（既有渲染口径，缺省形状即此类）；
 * - `shared_master`：`<f t="shared" [ref="范围"] si="N">原文</f>`——一组共享公式的**主格**，带原文；
 * - `shared_dependent`：`<f t="shared" si="N"/>`——无文本的**从属格**，语义是"继承同一 `si` 主格的原文
 *   并按相对偏移平移"（这一点由 `xlsx-read.ts` 在读入时完成，本模型只记住"它是从属格"）；
 * - `array`：`<f t="array" ref="范围">原文</f>`——数组公式，`ref` 声明它覆盖的矩形区域。
 *
 * 为什么把它建到模型里（而不是读的时候丢掉）：写回一个"读进来的工作簿"时，若把共享从属格
 * 塌缩成普通 `<f>原文</f>`，文件的**共享结构就被抹掉了**——同一段公式 N 份拷贝。保留形状
 * 才能"读到什么形状、写回什么形状"。
 */
export type FormulaElementKind = 'normal' | 'shared_master' | 'shared_dependent' | 'array';

/**
 * 一个 `<f>` 元素的**结构描述**（不含公式原文——原文单独由调用方持有）。
 *
 * 不变量（由 {@link ./formula-cache.js} 的 `classifyFormulaElement` 与下面的渲染函数共同保证）：
 * - `normal`：三个字段全 `null`；
 * - `shared_master` / `shared_dependent`：`shared_index !== null`；
 * - `shared_dependent`：`shared_range === null`（从属格不自带 `ref`）；
 * - `array`：`array_range !== null`。
 */
export interface FormulaElementShape {
  readonly kind: FormulaElementKind;
  /** 共享公式的 `si`（同组主格与从属格一致）；非 shared 为 `null`。 */
  readonly shared_index: number | null;
  /** 共享**主格** `ref` 声明的覆盖范围；非主格 / 未声明为 `null`。 */
  readonly shared_range: string | null;
  /** 数组公式 `ref` 声明的覆盖范围；非数组为 `null`。 */
  readonly array_range: string | null;
}

function requireSharedIndex(shape: FormulaElementShape, where: string): number {
  if (shape.shared_index === null) {
    throw new ValidationError(`${where}：共享公式形状缺少 si`);
  }
  return shape.shared_index;
}

/**
 * 公式元素 `<f>`。
 *
 * - `shape` 缺省 ⇒ `<f>原文</f>`（**既有口径不变**）；
 * - `shape.kind === 'shared_dependent'` ⇒ 自闭合 `<f t="shared" si="N"/>`，此时 `text` **必须**为空串
 *   （从属格按 OOXML 语义不携带原文；原文在主格上）。
 *
 * @throws {ValidationError} 文本非法 / 形状与其原文不自洽（例如从属格带原文、数组缺 `ref`）
 */
export function formulaElementXml(text: string, shape?: FormulaElementShape): XmlElement {
  if (shape === undefined || shape.kind === 'normal') {
    if (shape !== undefined && (shape.shared_index !== null || shape.shared_range !== null || shape.array_range !== null)) {
      throw new ValidationError('普通公式的形状不得携带 si / ref 字段');
    }
    return el('f', [], [normalizeFormulaText(text)]);
  }
  switch (shape.kind) {
    case 'shared_master': {
      const si = requireSharedIndex(shape, 'formulaElementXml');
      const attributes = [attr('t', 'shared')];
      if (shape.shared_range !== null) {
        attributes.push(attr('ref', shape.shared_range));
      }
      attributes.push(attr('si', String(si)));
      return el('f', attributes, [normalizeFormulaText(text)]);
    }
    case 'shared_dependent': {
      const si = requireSharedIndex(shape, 'formulaElementXml');
      if (shape.shared_range !== null) {
        throw new ValidationError('共享公式从属格不得携带 ref 范围（ref 只在主格上）');
      }
      if (text.length !== 0) {
        throw new ValidationError(
          '共享公式从属格不得携带原文（原文在主格上，从属格按 OOXML 只写 si）',
        );
      }
      return el('f', [attr('t', 'shared'), attr('si', String(si))], []);
    }
    case 'array': {
      if (shape.array_range === null) {
        throw new ValidationError('数组公式必须声明 ref 范围');
      }
      return el('f', [attr('t', 'array'), attr('ref', shape.array_range)], [normalizeFormulaText(text)]);
    }
    default: {
      const never: never = shape.kind;
      throw new ValidationError(`formulaElementXml 未覆盖的形状：${JSON.stringify(never)}`);
    }
  }
}

/**
 * **可编辑公式格**的 XML 片段：`<c r="A1"><f>原文</f></c>`。
 *
 * 这是 XLS-06「保存的是可编辑公式，不是结果数值」在字节层的执行点：本函数
 * **没有**任何参数能让调用方传入一个值，因此"把结果固化进 `<v>` 再丢掉公式"
 * 这条路径在这里**不可表达**。带缓存的写法在 `formula-cache.ts`
 * （`<f>` + `<v>`，且 `<v>` 只能来自重算结论）。
 *
 * @throws {ValidationError} 地址非法 / 公式文本非法
 */
export function buildEditableFormulaCellXml(ref: string, text: string): string {
  const address = formatCellAddress(parseCellAddress(ref));
  return serializeXmlNode(el('c', [attr('r', address)], [formulaElementXml(text)]));
}
