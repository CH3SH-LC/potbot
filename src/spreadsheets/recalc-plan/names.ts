/**
 * 表格域：重算计划（X04）的**命名引用**展开。
 *
 * ## 为什么必须自己展开，而不是交给解析器
 *
 * `formula-parse.ts` 是**受限子集**解析器，它明确把命名区域挡在门外：
 * 裸标识符（`Tax`）走到值位时抛「不支持的标识符」。让解析器直接吃 `=Tax*2`
 * 只会得到一条"依赖未知"的解析失败——命名引用就**永远建不出边**，
 * 依赖图和重算顺序会漏掉整条命名链路。
 *
 * 因此本模块在解析**之前**做一次文本替换：把定义好的名字换成它的目标区域
 * （跨表名替换成 `'表名'!A1`）。替换是**词法级**的，不是全局 `replace`——
 * 字符串字面量、单引号工作表名里的同形文本一律不动。
 *
 * ## 三条"绝不动手"的守卫（都是被真实踩过的坑）
 *
 * | 场景 | 不设守卫的后果 |
 * |---|---|
 * | `="Tax"&B1` 里的 `"Tax"` | 引号内文本被替换，公式语义被改写 |
 * | `'Tax'!B1` 里的表名 `Tax` | 表名被替换，指向另一张表 |
 * | `TAXRate1` 里的前缀 `TAX` | 子串命中，长名字被截断（`TaxRate` ≠ `Tax`） |
 *
 * 守卫分别是：跳过双引号字面量、跳过单引号工作表名、**整词**匹配（不得是更长词的前缀）。
 * 另有两条：`Name!` 是表名前缀、`Name(` 是函数调用，两种情形都不替换。
 *
 * ## 名字大小写
 *
 * Excel 的命名是大小写不敏感的（`tax` 与 `Tax` 是同一个名字）。查表按大写键，
 * 但报出来的 `used` 保留**定义时的原始拼写**，便于把结果对回定义。
 */

import { ValidationError } from '../../protocol/index.js';
import { formatRange, parseCellAddress, parseRange } from '../reference.js';

/** 命名引用定义：名字 + 目标区域。`sheet === null` 表示「在**使用该名字的那张表**上解析」。 */
export interface NamedReference {
  readonly name: string;
  readonly sheet: string | null;
  /** A1 记法的单格或区域（`"B1"` / `"B1:B3"`）。 */
  readonly ref: string;
}

/** 名字（大写）→ 归一化后的定义。 */
export type NamedReferenceTable = ReadonlyMap<string, NamedReference>;

/**
 * 名字的词法形状：字母（含中文等 Unicode 字母）/ 下划线开头，后跟字母数字下划线点。
 * 与解析器的标识符同形，但**放宽到 Unicode**——名字会在解析前被替换掉，
 * 解析器根本看不到它，因此中文名字是安全的（`Tax` 与 `税额` 都能用）。
 */
const NAME_PATTERN = /^[\p{L}_][\p{L}\p{N}_.]*$/u;

/**
 * 把定义列表归一化成查表结构。
 *
 * @throws {ValidationError} 名字为空 / 形状非法 / **长得像单元格地址**（`A1`、`TAX1`）/ 重名
 * @throws {ValidationError} `ref` 不是合法单格或区域；`sheet` 既不是 `null` 也不是非空字符串
 */
export function normalizeNamedReferences(
  definitions: readonly NamedReference[],
): NamedReferenceTable {
  if (!Array.isArray(definitions)) {
    throw new ValidationError('normalizeNamedReferences 只接受数组');
  }
  const table = new Map<string, NamedReference>();
  for (const definition of definitions) {
    const name = definition.name;
    if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
      throw new ValidationError(`命名引用的名字非法（须为标识符形状）：${JSON.stringify(name)}`);
    }
    if (looksLikeCellAddress(name)) {
      // Excel 同样禁止：`A1` 这种名字与单元格地址歧义。
      throw new ValidationError(`命名引用的名字与单元格地址歧义，Excel 也不允许：${JSON.stringify(name)}`);
    }
    const sheet = definition.sheet;
    if (sheet !== null && (typeof sheet !== 'string' || sheet.length === 0)) {
      throw new ValidationError(`命名引用 ${name} 的 sheet 必须是 null 或非空字符串`);
    }
    const range = parseRange(definition.ref);
    const normalized = formatRange(range);
    const key = name.toUpperCase();
    if (table.has(key)) {
      throw new ValidationError(`命名引用重名（大小写不敏感）：${JSON.stringify(name)}`);
    }
    table.set(key, Object.freeze({ name, sheet, ref: normalized }));
  }
  return table;
}

/** 名字是否与单元格地址歧义（`A1` / `$A$1` / `TAX1`）。 */
function looksLikeCellAddress(name: string): boolean {
  try {
    parseCellAddress(name);
    return true;
  } catch {
    return false;
  }
}

/** 单引号工作表名（内部 `'` 记两个）。始终加引号——解析器对 `'…'!A1` 一律接受。 */
function quoteSheetName(name: string): string {
  return `'${name.replaceAll("'", "''")}'`;
}

/** 一个名字替换成什么文本。 */
function replacementFor(definition: NamedReference): string {
  return definition.sheet === null
    ? definition.ref
    : `${quoteSheetName(definition.sheet)}!${definition.ref}`;
}

/** 展开结果。 */
export interface NamedExpansion {
  /** 替换后的公式文本（无可替换名字时**逐字**等于输入）。 */
  readonly text: string;
  /** 本次真正用到的名字（定义时原始拼写，按字典序去重）。 */
  readonly used: readonly string[];
}

/** 词字符：与「整词匹配」有关，含 Unicode 字母数字（表名 / 函数名可能是中文）。 */
function isWordChar(ch: string): boolean {
  return /[\p{L}\p{N}_$.]/u.test(ch);
}

/**
 * 双引号字符串字面量的结束位置（独占）。未闭合时返回文本长度（交给解析器报错，不在此处猜）。
 */
function endOfStringLiteral(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    if (text.charAt(index) === '"') {
      if (text.charAt(index + 1) === '"') {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return text.length;
}

/** 单引号工作表名段的结束位置（独占）；未闭合返回文本长度。 */
function endOfQuotedSheet(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    if (text.charAt(index) === "'") {
      if (text.charAt(index + 1) === "'") {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return text.length;
}

/**
 * 把 `text` 里的命名引用替换成它的目标区域。
 *
 * 纯文本替换，**不改**传入的 `table`，也不碰工作表状态。
 */
export function expandNamedReferences(
  text: string,
  table: NamedReferenceTable,
  defaultSheet: string,
): NamedExpansion {
  if (typeof text !== 'string') {
    throw new ValidationError('expandNamedReferences 只接受字符串');
  }
  if (typeof defaultSheet !== 'string' || defaultSheet.length === 0) {
    throw new ValidationError('expandNamedReferences 的 defaultSheet 必须是非空字符串');
  }

  const pieces: string[] = [];
  const used = new Set<string>();
  let index = 0;

  while (index < text.length) {
    const ch = text.charAt(index);
    if (ch === '"') {
      const end = endOfStringLiteral(text, index);
      pieces.push(text.slice(index, end));
      index = end;
      continue;
    }
    if (ch === "'") {
      const end = endOfQuotedSheet(text, index);
      pieces.push(text.slice(index, end));
      index = end;
      continue;
    }
    if (isWordChar(ch)) {
      let end = index;
      while (end < text.length && isWordChar(text.charAt(end))) {
        end += 1;
      }
      const word = text.slice(index, end);
      const following = text.charAt(end);
      const definition = table.get(word.toUpperCase());
      if (definition !== undefined && following !== '!' && following !== '(') {
        pieces.push(replacementFor(definition));
        used.add(definition.name);
      } else {
        pieces.push(word);
      }
      index = end;
      continue;
    }
    pieces.push(ch);
    index += 1;
  }

  return Object.freeze({
    text: pieces.join(''),
    used: Object.freeze([...used].sort()),
  });
}
