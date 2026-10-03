/**
 * 表格域：公式**词法 / 语法**分析（design-06-P8 / XLS-08）。
 *
 * ## 这个文件与 `formula.ts` 的分工
 *
 * `formula.ts` 回答的是"**能不能安全改写**这段公式文本"（行列增删时的引用迁移），
 * 它刻意**不做**完整词法分析——只在能证明安全时才动手，否则整体阻塞。
 * 本文件回答的是**另一个问题**："这段公式到底是什么意思"，即把公式原文变成一棵可求值的语法树。
 * 二者都被 XLS-08 需要，但**互不依赖**：迁移是保守的字符串改写，求值是精确的树遍历。
 *
 * ## 为什么用**递归下降**而不是正则
 *
 * 正则改公式在 `formula.ts` 的注释里已经说明过危险（`LOG10(100)` 里的 `LOG10` 完全符合
 * "列 LOG + 行 10"的形状）。求值必须区分"函数名"与"引用"、区分运算符优先级、
 * 处理嵌套括号——这些都是**上下文相关**的，正则做不到。因此这里是一个玩具级但**完整**的
 * 递归下降解析器：分词 → 按优先级下降 → 产出 AST。
 *
 * ## 支持的语法子集（**白名单之外一律解析失败 ⇒ 上层阻塞**）
 *
 * | 构造 | 例子 |
 * |---|---|
 * | 数值 / 文本 / 布尔字面量 | `1.5` `.5` `1e3` `"是"` `TRUE` `FALSE` |
 * | 相对 / 绝对引用 | `A1` `$A$1` `$A1` `A$1` |
 * | 跨表引用（**裸名不限 ASCII**） | `Sheet1!A1` `明细!A1` `'预算 表'!B2` |
 * | 区域 | `A1:B3` `Sheet1!A1:B3` |
 * | 函数调用 | `SUM(A1:A3, B1)` |
 * | 一元 | `-A1` `+A1` |
 * | 二元 | `+ - * / ^ & = <> < <= > >=` |
 * | 括号 | `(A1+B1)*2` |
 *
 * **不支持**（解析失败 ⇒ 阻塞，**不猜**）：数组常量 `{1,2}`、百分比后缀 `%`、
 * 三维引用 `Sheet1:Sheet3!A1`、结构化引用 `表1[列]`、命名区域、`#` 溢出引用、日期字面量。
 *
 * ## 裸表名为什么必须支持非 ASCII（**X-I06 的决定**）
 *
 * Excel 的表名引用规则不是"非 ASCII 就必须加引号"：只有当表名**含空格 / 标点 / 以数字或 `.` 开头 /
 * 形如单元格引用或 `TRUE`/`FALSE`** 时才必须加单引号；**纯字母（含汉字等非 ASCII 字母）的表名可以裸写**，
 * `=明细!A1` 在真实 Excel 里完全合法。因此本词法器把非 ASCII 字母也算作标识符的起始字符，
 * 让 `明细!A1` 走与 `Sheet1!A1` 完全相同的"ident + `!` ⇒ 跨表前缀"路径。
 *
 * **仍然解析失败**的是真正需要引号的表名：`预算 表!A1`（含空格）在词法上就是两个标识符，
 * 会在语法层报"不支持的标识符"，调用方应写成 `'预算 表'!A1`（{@link ./formula-model.js} 的
 * `formatSheetQualifier` 会按 Excel 口径补引号）。
 */

import { ValidationError } from '../protocol/index.js';
import { parseCellReference, type CellReference } from './reference.js';

/** 二元运算符（封闭枚举）。 */
export type BinaryOp = '+' | '-' | '*' | '/' | '^' | '&' | '=' | '<>' | '<' | '<=' | '>' | '>=';

/** 数值字面量。 */
export interface NumberNode {
  readonly kind: 'number';
  readonly value: number;
}

/** 文本字面量（双引号字符串，内部 `""` 表示一个 `"`）。 */
export interface TextNode {
  readonly kind: 'text';
  readonly value: string;
}

/** 布尔字面量（`TRUE` / `FALSE`）。 */
export interface BooleanNode {
  readonly kind: 'boolean';
  readonly value: boolean;
}

/** 单元格引用；`sheet` 为 `null` 表示"本表"。 */
export interface ReferenceNode {
  readonly kind: 'reference';
  readonly sheet: string | null;
  readonly reference: CellReference;
}

/** 区域引用（含两端）；`sheet` 为 `null` 表示"本表"。 */
export interface RangeNode {
  readonly kind: 'range';
  readonly sheet: string | null;
  readonly start: CellReference;
  readonly end: CellReference;
}

/** 函数调用；`name` 原样保留大小写（求值层按大写匹配白名单）。 */
export interface CallNode {
  readonly kind: 'call';
  readonly name: string;
  readonly args: readonly FormulaNode[];
}

/** 一元运算（`-x` / `+x`）。 */
export interface UnaryNode {
  readonly kind: 'unary';
  readonly op: '-' | '+';
  readonly operand: FormulaNode;
}

/** 二元运算。 */
export interface BinaryNode {
  readonly kind: 'binary';
  readonly op: BinaryOp;
  readonly left: FormulaNode;
  readonly right: FormulaNode;
}

/** 公式语法树节点。 */
export type FormulaNode =
  | NumberNode
  | TextNode
  | BooleanNode
  | ReferenceNode
  | RangeNode
  | CallNode
  | UnaryNode
  | BinaryNode;

/**
 * 公式解析失败。
 *
 * **这是一个可预期的结果**（XLS-08 明说"不支持的公式保留或阻塞"），因此它不叫 `ValidationError`：
 * `ValidationError` 表示"调用方给了非法参数"，而解析失败表示"这段公式超出本仓支持的子集"——
 * 上层要做的不是抛给用户，而是**保留原文并登记阻塞**。
 */
export class FormulaParseError extends Error {
  /** 出错处相对公式文本起点的字符偏移。 */
  readonly position: number;

  constructor(position: number, message: string) {
    super(`公式解析失败（偏移 ${String(position)}）：${message}`);
    this.name = 'FormulaParseError';
    this.position = position;
  }
}

// ---------------------------------------------------------------------------
// 词法
// ---------------------------------------------------------------------------

type TokenKind =
  | 'number'
  | 'text'
  | 'boolean'
  | 'ident'
  | 'reference'
  | 'quoted_sheet'
  | 'op'
  | 'eof';

interface Token {
  readonly kind: TokenKind;
  /** 语义值：number ⇒ 数字文本；ident/reference ⇒ 原文；op ⇒ 运算符；boolean ⇒ `TRUE`/`FALSE`。 */
  readonly raw: string;
  readonly start: number;
}

/** 数值字面量：`1` `1.5` `.5` `1.` `1e3` `1.5E-2`（**不含**正负号，符号归一元运算）。 */
const NUMBER_PATTERN = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;

/** 单元格引用（可带 `$`）：`A1` `$A$1`。 */
const CELL_REFERENCE_PATTERN = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})(?![A-Za-z0-9_])/;

/** 普通标识符（函数名 / 工作表名 / TRUE / FALSE）：起始为字母 / 下划线，后续可含字母、数字、`_`、`.`。
 *
 * **含非 ASCII 字母**（汉字等）：Excel 对纯字母表名不强制加引号（`=明细!A1` 合法），
 * 因此这里用 Unicode 属性类而不是 `[A-Za-z]`。 */
const IDENT_PATTERN = /^[\p{L}_][\p{L}\p{N}_.]*/u;

/** 双字符运算符优先于单字符运算符。 */
const TWO_CHAR_OPERATORS: readonly string[] = Object.freeze(['<>', '<=', '>=']);
const ONE_CHAR_OPERATORS: readonly string[] = Object.freeze([
  '+', '-', '*', '/', '^', '&', '=', '<', '>', '(', ')', ',', ':', '!',
]);

function isSpace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isReferenceStart(ch: string): boolean {
  return /[A-Za-z$]/.test(ch);
}

/**
 * 标识符 / 裸表名的起始字符：ASCII 或**非 ASCII** 字母、下划线。
 *
 * 与 {@link isReferenceStart} 分开是有意的：引用必须以 ASCII 列字母或 `$` 开头
 * （`CELL_REFERENCE_PATTERN` 只认 `[A-Za-z]`），而非 ASCII 只可能是表名 / 函数名，
 * 绝不能被当成单元格引用。
 *
 * 注：逐 UTF-16 码元判定，覆盖 BMP 内的字母（CJK、拉丁扩展等）。辅音平面（astral）字母
 * 不在本仓支持范围——这类表名请加单引号，走 `quoted_sheet` 词法。
 */
const IDENTIFIER_START_PATTERN = /[\p{L}_]/u;

function readQuotedSheet(text: string, start: number): Token {
  // `'` 开头：单引号内的 `''` 表示一个字面单引号。
  let value = '';
  let index = start + 1;
  for (;;) {
    if (index >= text.length) {
      throw new FormulaParseError(start, '未闭合的工作表名（缺少收尾单引号）');
    }
    const ch = text.charAt(index);
    if (ch === "'") {
      if (text.charAt(index + 1) === "'") {
        value += "'";
        index += 2;
        continue;
      }
      index += 1;
      break;
    }
    value += ch;
    index += 1;
  }
  if (value.length === 0) {
    throw new FormulaParseError(start, '工作表名不能是空串');
  }
  return { kind: 'quoted_sheet', raw: value, start };
}

function tokenize(text: string): readonly Token[] {
  if (typeof text !== 'string') {
    throw new ValidationError('公式文本必须是字符串');
  }
  const tokens: Token[] = [];
  let position = 0;
  while (position < text.length) {
    const ch = text.charAt(position);
    if (isSpace(ch)) {
      position += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      let index = position + 1;
      for (;;) {
        if (index >= text.length) {
          throw new FormulaParseError(position, '未闭合的字符串字面量');
        }
        const current = text.charAt(index);
        if (current === '"') {
          if (text.charAt(index + 1) === '"') {
            value += '"';
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        value += current;
        index += 1;
      }
      tokens.push({ kind: 'text', raw: value, start: position });
      position = index;
      continue;
    }
    if (ch === "'") {
      const token = readQuotedSheet(text, position);
      tokens.push(token);
      position = token.start + rawLengthOfQuotedSheet(text, token.start);
      continue;
    }
    // 数值字面量：以数字开头，或以 `.` 开头但紧跟数字（`.5`）。正则已锚定 `^`，
    // 因此字母开头一定不匹配，不需要额外的首字符守卫。
    const numeric = NUMBER_PATTERN.exec(text.slice(position));
    if (numeric !== null) {
      tokens.push({ kind: 'number', raw: numeric[0], start: position });
      position += numeric[0].length;
      continue;
    }
    if (isReferenceStart(ch) || IDENTIFIER_START_PATTERN.test(ch)) {
      const reference = CELL_REFERENCE_PATTERN.exec(text.slice(position));
      if (reference !== null) {
        tokens.push({ kind: 'reference', raw: reference[0], start: position });
        position += reference[0].length;
        continue;
      }
      const ident = IDENT_PATTERN.exec(text.slice(position));
      if (ident !== null) {
        const raw = ident[0];
        const upper = raw.toUpperCase();
        const kind: TokenKind = upper === 'TRUE' || upper === 'FALSE' ? 'boolean' : 'ident';
        tokens.push({ kind, raw, start: position });
        position += raw.length;
        continue;
      }
    }
    const two = text.slice(position, position + 2);
    const operator = TWO_CHAR_OPERATORS.find((candidate) => candidate === two);
    if (operator !== undefined) {
      tokens.push({ kind: 'op', raw: operator, start: position });
      position += operator.length;
      continue;
    }
    if (ONE_CHAR_OPERATORS.includes(ch)) {
      tokens.push({ kind: 'op', raw: ch, start: position });
      position += 1;
      continue;
    }
    throw new FormulaParseError(position, `不认识的字符 ${JSON.stringify(ch)}（本仓只支持受限子集）`);
  }
  tokens.push({ kind: 'eof', raw: '', start: text.length });
  return tokens;
}

/** 单引号工作表名的原始文本长度（含两端引号，`''` 记两个字符）。 */
function rawLengthOfQuotedSheet(text: string, start: number): number {
  let index = start + 1;
  for (;;) {
    if (index >= text.length) return text.length - start;
    const ch = text.charAt(index);
    if (ch === "'") {
      if (text.charAt(index + 1) === "'") {
        index += 2;
        continue;
      }
      return index + 1 - start;
    }
    index += 1;
  }
}

// ---------------------------------------------------------------------------
// 语法
// ---------------------------------------------------------------------------

/**
 * 解析公式文本（**不含前缀 `=`**，与 `value.ts` 的 `FormulaValue.text` 同口径）。
 *
 * 只做**语法**，不做语义（函数是否支持、引用是否越界留给求值层）。解析失败抛
 * {@link FormulaParseError}——调用方应把它转成"阻塞"结局，而不是向上抛给用户。
 *
 * @throws {FormulaParseError} 超出支持的语法子集
 * @throws {ValidationError} `text` 不是字符串
 */
export function parseFormula(text: string): FormulaNode {
  const tokens = tokenize(text);
  const parser = new Parser(text, tokens);
  const node = parser.parseExpression();
  const tail = parser.peek();
  if (tail.kind !== 'eof') {
    throw new FormulaParseError(tail.start, `公式尾部有多余内容 ${JSON.stringify(tail.raw)}`);
  }
  return node;
}

class Parser {
  private index = 0;

  constructor(
    private readonly text: string,
    private readonly tokens: readonly Token[],
  ) {}

  peek(offset = 0): Token {
    const token = this.tokens[this.index + offset];
    /* c8 ignore next -- tokenize 保证末尾有一个 eof，越界不可达 */
    return token ?? { kind: 'eof', raw: '', start: this.text.length };
  }

  private next(): Token {
    const token = this.peek();
    this.index += 1;
    return token;
  }

  private expectOperator(value: string): Token {
    const token = this.peek();
    if (token.kind !== 'op' || token.raw !== value) {
      throw new FormulaParseError(token.start, `期望 ${JSON.stringify(value)}，实际是 ${JSON.stringify(token.raw)}`);
    }
    return this.next();
  }

  private matchOperator(values: readonly string[]): string | null {
    const token = this.peek();
    if (token.kind === 'op' && values.includes(token.raw)) {
      this.next();
      return token.raw;
    }
    return null;
  }

  parseExpression(): FormulaNode {
    return this.parseComparison();
  }

  private parseComparison(): FormulaNode {
    const left = this.parseConcat();
    const op = this.matchOperator(['=', '<>', '<', '<=', '>', '>=']);
    if (op === null) return left;
    const right = this.parseConcat();
    return { kind: 'binary', op: op as BinaryOp, left, right };
  }

  private parseConcat(): FormulaNode {
    let node = this.parseAdditive();
    while (this.matchOperator(['&']) !== null) {
      node = { kind: 'binary', op: '&', left: node, right: this.parseAdditive() };
    }
    return node;
  }

  private parseAdditive(): FormulaNode {
    let node = this.parseMultiplicative();
    for (;;) {
      const op = this.matchOperator(['+', '-']);
      if (op === null) return node;
      node = { kind: 'binary', op: op as BinaryOp, left: node, right: this.parseMultiplicative() };
    }
  }

  private parseMultiplicative(): FormulaNode {
    let node = this.parsePower();
    for (;;) {
      const op = this.matchOperator(['*', '/']);
      if (op === null) return node;
      node = { kind: 'binary', op: op as BinaryOp, left: node, right: this.parsePower() };
    }
  }

  /**
   * `^` 右结合。
   *
   * **注意 Excel 的怪癖被如实复刻**：Excel 里一元负号**比 `^` 结合得更紧**，
   * 因此 `-2^2` = **4**（`(-2)^2`），与数学惯例 `-(2^2) = -4` 不同。本仓跟随 Excel，
   * 因为求值器的产物的消费端是 Excel（写进 `<v>` 缓存的那个数）。
   */
  private parsePower(): FormulaNode {
    const base = this.parseUnary();
    if (this.matchOperator(['^']) !== null) {
      return { kind: 'binary', op: '^', left: base, right: this.parsePower() };
    }
    return base;
  }

  private parseUnary(): FormulaNode {
    const op = this.matchOperator(['-', '+']);
    if (op !== null) {
      return { kind: 'unary', op: op as '-' | '+', operand: this.parseUnary() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): FormulaNode {
    const token = this.peek();
    if (token.kind === 'number') {
      this.next();
      return { kind: 'number', value: Number(token.raw) };
    }
    if (token.kind === 'text') {
      this.next();
      return { kind: 'text', value: token.raw };
    }
    if (token.kind === 'boolean') {
      this.next();
      return { kind: 'boolean', value: token.raw.toUpperCase() === 'TRUE' };
    }
    if (token.kind === 'op' && token.raw === '(') {
      this.next();
      const inner = this.parseExpression();
      this.expectOperator(')');
      return inner;
    }
    if (token.kind === 'quoted_sheet') {
      this.next();
      this.expectOperator('!');
      return this.parseReferenceBody(token.raw);
    }
    if (token.kind === 'ident' || token.kind === 'reference') {
      // `NAME(` ⇒ 函数调用；`NAME!` ⇒ 跨表引用前缀；否则是引用本身。
      const following = this.peek(1);
      if (following.kind === 'op' && following.raw === '(') {
        this.next();
        return this.parseCall(token.raw);
      }
      if (following.kind === 'op' && following.raw === '!') {
        this.next();
        this.next();
        return this.parseReferenceBody(token.raw);
      }
      if (token.kind === 'reference') {
        this.next();
        return this.finishReference(null, token.raw);
      }
      throw new FormulaParseError(
        token.start,
        `不支持的标识符 ${JSON.stringify(token.raw)}（命名区域 / 结构化引用不在本仓子集内）`,
      );
    }
    throw new FormulaParseError(token.start, `期望一个值，实际是 ${JSON.stringify(token.raw)}`);
  }

  private parseCall(name: string): FormulaNode {
    this.expectOperator('(');
    const args: FormulaNode[] = [];
    if (!(this.peek().kind === 'op' && this.peek().raw === ')')) {
      args.push(this.parseExpression());
      while (this.matchOperator([',']) !== null) {
        args.push(this.parseExpression());
      }
    }
    this.expectOperator(')');
    return { kind: 'call', name, args };
  }

  private parseReferenceBody(sheet: string): FormulaNode {
    const token = this.next();
    if (token.kind !== 'reference') {
      throw new FormulaParseError(token.start, `工作表 ${JSON.stringify(sheet)} 后应当是单元格引用`);
    }
    return this.finishReference(sheet, token.raw);
  }

  private finishReference(sheet: string | null, raw: string): FormulaNode {
    const start = parseCellReference(raw);
    if (this.matchOperator([':']) !== null) {
      const token = this.next();
      let endSheet = sheet;
      let endRaw: string;
      if (token.kind === 'quoted_sheet') {
        this.expectOperator('!');
        endSheet = token.raw;
        const reference = this.next();
        if (reference.kind !== 'reference') {
          throw new FormulaParseError(reference.start, '区域右端应当是单元格引用');
        }
        endRaw = reference.raw;
      } else if (token.kind === 'reference') {
        endRaw = token.raw;
      } else {
        throw new FormulaParseError(token.start, '区域右端应当是单元格引用');
      }
      if (endSheet !== sheet) {
        throw new FormulaParseError(
          token.start,
          '区域两端指向不同工作表：本仓不支持三维 / 跨表区域，显式阻塞',
        );
      }
      const end = parseCellReference(endRaw);
      return { kind: 'range', sheet, start, end };
    }
    return { kind: 'reference', sheet, reference: start };
  }
}
