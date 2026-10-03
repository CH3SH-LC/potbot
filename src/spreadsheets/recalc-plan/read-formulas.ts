/**
 * 表格域：重算计划（X04）的**读入侧公式还原**——共享公式与数组公式。
 *
 * ## 这一层补上的缺口
 *
 * `planInputFromWorkbook` 只认 `WorkbookState` 里**已经是一格一公式**的取值。
 * 但工作表 XML 里，公式有两种**成组**写法，一格里读不出、或根本读不到：
 *
 * | 写法 | XML 形状 | 不一格一公式会怎样 |
 * |---|---|---|
 * | **共享公式** | 主格 `<f t="shared" ref="范围" si="N">文本</f>`，从属格 `<f t="shared" si="N"/>`（无文本） | 从属格被当成**空白**，依赖链断裂 |
 * | **数组公式** | 锚格 `<f t="array" ref="范围">文本</f>` | 范围里其余格被当成**空白**，且锚格被当**普通标量**公式 |
 *
 * 本模块把这两类**按 OOXML 语义还原成一格一公式**，再交给计划层：
 *
 * - **共享**：从属格继承同一 `si` 主格的文本，并把相对引用按「主格 → 从属格」的偏移**复制平移**
 *   （`$` 锁定的那半不动，字符串字面量 / 表名 / 函数名不动）——与 Excel 复制一致；
 * - **数组**：`ref` 范围里的每一格都承载同一段数组公式文本。本仓求值器是**标量**语义，
 *   因此范围里用区域参与标量运算的数组公式会自然**阻塞**（`unsupported_construct`），
 *   而单格 / 标量值的数组公式照常算出——绝不静默把多格数组算成一个错值。
 *
 * ## 为什么自己实现平移，而不是复用 `xlsx-read.ts`
 *
 * `xlsx-read.ts` 的共享公式平移是**私有实现**（未导出），且属 X01/X-I03 写权。
 * X04 需要一个**读模型入口**：接受工作表的 `<f>` 声明（`WorksheetFormulaDecl`），
 * 而不是整包字节。两者共享同一套 OOXML 语义判据，实现各自在写权内，互不越界。
 * 平移数学复用 `reference.ts` 的 {@link shiftReference}（`$` 语义 / 越界报错都在那里）。
 *
 * ## 显式拒绝（宁可失败，不静默降级）
 *
 * - 从属格的 `si` 找不到主格、或落在主格 `ref` 范围外 ⇒ **抛 `ValidationError`**；
 * - 两个格子归一化后撞同一 `ref`（范围重叠）⇒ **抛 `ValidationError`**；
 * - 平移越界（列 > `XFD` / 行 < 1）⇒ **抛 `ValidationError`**。
 */

import { ValidationError } from '../../protocol/index.js';
import { SPREADSHEETML_NAMESPACE } from '../../artifacts/templates/xlsx.js';
import {
  attributeValue,
  childElements,
  directText,
  parseXml,
  type ParsedXmlElement,
} from '../../documents/docx/xml-parse.js';
import {
  MAX_COLUMN_NUMBER,
  MAX_ROW_NUMBER,
  columnLettersToNumber,
  columnNumberToLetters,
  formatCellAddress,
  formatCellReference,
  parseCellReference,
  parseRange,
  shiftReference,
  type CellReference,
} from '../reference.js';
import type { PlanCell } from './graph.js';

/** 一个工作表里某格的 `<f>` 声明（读模型；`text === null` 只可能是共享公式从属格）。 */
export interface WorksheetFormulaDecl {
  /** 该格 A1 地址。 */
  readonly ref: string;
  readonly type: 'normal' | 'shared' | 'array';
  /** 公式原文；共享公式从属格为 `null`。 */
  readonly text: string | null;
  /** 共享公式的 `si` 下标（`type === 'shared'` 时非空）。 */
  readonly si: string | null;
  /** 共享 / 数组公式的 `ref` 覆盖范围（`A1:B3` 形状），无则 `null`。 */
  readonly range: string | null;
}

/** 还原后的一格一公式。 */
export interface ResolvedWorksheetFormula {
  readonly ref: string;
  readonly text: string;
  readonly origin: 'normal' | 'shared-master' | 'shared-dependent' | 'array';
}

/** 数组范围展开上限（防手滑把整列当数组公式的范围）。 */
const ARRAY_RANGE_CELL_LIMIT = 1_000_000;

// ---------------------------------------------------------------------------
// 公式引用平移（复制语义）
// ---------------------------------------------------------------------------

const CELL_REFERENCE = /(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})/y;
const COLUMN_REFERENCE = /(\$?)([A-Za-z]{1,3})/y;
const ROW_REFERENCE = /(\$?)(\d{1,7})/y;
const SHEET_NAME = /'(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_.]*/y;
const STRING_LITERAL_MASK = '~';

function isIdentifierChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_.]/.test(ch);
}

/** 把字符串字面量按位替换成占位符（等长），使引用扫描不会命中引号内的文本。 */
function maskStringLiterals(text: string): string {
  let masked = '';
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text.charAt(index);
    if (ch === '"') {
      if (inString && text.charAt(index + 1) === '"') {
        masked += STRING_LITERAL_MASK + STRING_LITERAL_MASK;
        index += 1;
        continue;
      }
      inString = !inString;
      masked += STRING_LITERAL_MASK;
      continue;
    }
    masked += inString ? STRING_LITERAL_MASK : ch;
  }
  return masked;
}

type ReferencePart =
  | { readonly kind: 'cell'; readonly end: number; readonly cell: CellReference }
  | { readonly kind: 'column'; readonly end: number; readonly abs: boolean; readonly column: number }
  | { readonly kind: 'row'; readonly end: number; readonly abs: boolean; readonly row: number };

/** 列字母 → 列号；超出 Excel 上限（>XFD）返回 `null`（不抛，交给调用方跳过）。 */
function tryColumnNumber(letters: string): number | null {
  try {
    return columnLettersToNumber(letters);
  } catch {
    return null;
  }
}

/** 从 `start` 识别一个引用片段（单元格 / 整列 / 整行）；识别不到返回 `null`。 */
function parseReferencePart(masked: string, start: number): ReferencePart | null {
  CELL_REFERENCE.lastIndex = start;
  const cell = CELL_REFERENCE.exec(masked);
  if (cell !== null) {
    const column = tryColumnNumber(cell[2] ?? '');
    const row = Number.parseInt(cell[4] ?? '', 10);
    if (column !== null && row >= 1 && row <= MAX_ROW_NUMBER) {
      return {
        kind: 'cell',
        end: start + cell[0].length,
        cell: { column, row, abs_column: cell[1] === '$', abs_row: cell[3] === '$' },
      };
    }
  }
  COLUMN_REFERENCE.lastIndex = start;
  const wholeColumn = COLUMN_REFERENCE.exec(masked);
  if (wholeColumn !== null) {
    const column = tryColumnNumber(wholeColumn[2] ?? '');
    if (column !== null) {
      return {
        kind: 'column',
        end: start + wholeColumn[0].length,
        abs: wholeColumn[1] === '$',
        column,
      };
    }
  }
  ROW_REFERENCE.lastIndex = start;
  const wholeRow = ROW_REFERENCE.exec(masked);
  if (wholeRow !== null) {
    const row = Number.parseInt(wholeRow[2] ?? '', 10);
    if (row >= 1 && row <= MAX_ROW_NUMBER) {
      return { kind: 'row', end: start + wholeRow[0].length, abs: wholeRow[1] === '$', row };
    }
  }
  return null;
}

/** 匹配开头（下标 `start` 起）的表名限定直到 `!`；命中返回 `!` 之后的下标，否则 `-1`。 */
function matchSheetQualifier(masked: string, start: number): number {
  SHEET_NAME.lastIndex = start;
  const first = SHEET_NAME.exec(masked);
  if (first === null) return -1;
  let cursor = start + first[0].length;
  if (masked.charAt(cursor) === ':') {
    SHEET_NAME.lastIndex = cursor + 1;
    const second = SHEET_NAME.exec(masked);
    if (second === null) return -1;
    cursor += 1 + second[0].length;
  }
  return masked.charAt(cursor) === '!' ? cursor + 1 : -1;
}

interface TranslatedSpan {
  readonly end: number;
  readonly replacement: string;
}

function shiftPart(
  part: ReferencePart,
  deltaRow: number,
  deltaColumn: number,
  where: string,
): string {
  switch (part.kind) {
    case 'cell': {
      try {
        return formatCellReference(shiftReference(part.cell, { column: deltaColumn, row: deltaRow }));
      } catch {
        throw new ValidationError(`${where} 的引用 ${formatCellReference(part.cell)} 复制平移后越界`);
      }
    }
    case 'column': {
      const next = part.abs ? part.column : part.column + deltaColumn;
      if (next < 1 || next > MAX_COLUMN_NUMBER) {
        throw new ValidationError(`${where} 的整列引用复制平移后列越界`);
      }
      return `${part.abs ? '$' : ''}${columnNumberToLetters(next)}`;
    }
    case 'row': {
      const next = part.abs ? part.row : part.row + deltaRow;
      if (next < 1 || next > MAX_ROW_NUMBER) {
        throw new ValidationError(`${where} 的整行引用复制平移后行越界`);
      }
      return `${part.abs ? '$' : ''}${String(next)}`;
    }
    /* c8 ignore next */
    default:
      return '';
  }
}

/** 识别 `start` 处的引用（可含 `:` 区间）并平移；识别不到返回 `null`。 */
function translateReferenceSpan(
  masked: string,
  start: number,
  deltaRow: number,
  deltaColumn: number,
  where: string,
): TranslatedSpan | null {
  const first = parseReferencePart(masked, start);
  if (first === null) return null;
  const parts: ReferencePart[] = [first];
  let end = first.end;
  if (masked.charAt(end) === ':') {
    const second = parseReferencePart(masked, end + 1);
    if (second !== null && second.kind === first.kind) {
      parts.push(second);
      end = second.end;
    }
  }
  // 整列 / 整行必须成区间才算引用（裸 `A` / `1` 是名字）。
  if (parts.length === 1 && first.kind !== 'cell') return null;
  const after = end < masked.length ? masked.charAt(end) : undefined;
  if (isIdentifierChar(after) || after === '(') return null;
  return {
    end,
    replacement: parts.map((part) => shiftPart(part, deltaRow, deltaColumn, where)).join(':'),
  };
}

/**
 * 共享公式从属格：把主格文本的相对引用按 `(deltaRow, deltaColumn)` **复制平移**。
 *
 * @throws {ValidationError} 平移后越界
 */
export function shiftFormulaText(
  text: string,
  deltaRow: number,
  deltaColumn: number,
  where = '共享公式',
): string {
  if (typeof text !== 'string') {
    throw new ValidationError('shiftFormulaText 只接受字符串');
  }
  if (deltaRow === 0 && deltaColumn === 0) return text;
  const masked = maskStringLiterals(text);
  let result = '';
  let last = 0;
  let index = 0;
  while (index < masked.length) {
    const before = index > 0 ? masked.charAt(index - 1) : undefined;
    if (isIdentifierChar(before) || before === '$') {
      index += 1;
      continue;
    }
    const qualified = matchSheetQualifier(masked, index);
    const start = qualified === -1 ? index : qualified;
    const span =
      start < masked.length
        ? translateReferenceSpan(masked, start, deltaRow, deltaColumn, where)
        : null;
    if (span === null) {
      index += 1;
      continue;
    }
    result += text.slice(last, start) + span.replacement;
    last = span.end;
    index = span.end;
  }
  return result + text.slice(last);
}

// ---------------------------------------------------------------------------
// 还原
// ---------------------------------------------------------------------------

/** 展开 `A1:B3` 范围内的全部 A1 地址（行优先，左上→右下）。 */
function cellsInRange(range: string, where: string): readonly string[] {
  const parsed = parseRange(range);
  const minColumn = Math.min(parsed.start.column, parsed.end.column);
  const maxColumn = Math.max(parsed.start.column, parsed.end.column);
  const minRow = Math.min(parsed.start.row, parsed.end.row);
  const maxRow = Math.max(parsed.start.row, parsed.end.row);
  const count = (maxColumn - minColumn + 1) * (maxRow - minRow + 1);
  if (count > ARRAY_RANGE_CELL_LIMIT) {
    throw new ValidationError(`${where} 的范围 ${JSON.stringify(range)} 有 ${String(count)} 格，超过数组展开上限`);
  }
  const refs: string[] = [];
  for (let row = minRow; row <= maxRow; row += 1) {
    for (let column = minColumn; column <= maxColumn; column += 1) {
      refs.push(formatCellAddress({ column, row }));
    }
  }
  return refs;
}

interface SharedMaster {
  readonly text: string;
  readonly ref: string;
  readonly range: string | null;
}

/**
 * 把 `<f>` 声明序列还原成一格一公式（共享从属格继承 + 平移；数组范围逐格展开）。
 *
 * @throws {ValidationError} 声明形状非法、`si` 悬空、从属格越出主格范围、范围重叠
 */
export function resolveWorksheetFormulas(
  decls: readonly WorksheetFormulaDecl[],
): readonly ResolvedWorksheetFormula[] {
  if (!Array.isArray(decls)) {
    throw new ValidationError('resolveWorksheetFormulas 的 decls 必须是数组');
  }
  const masters = new Map<string, SharedMaster>();
  for (const decl of decls) {
    if (decl.type !== 'shared' || decl.text === null) continue;
    if (decl.si === null) {
      throw new ValidationError(`共享公式主格 ${decl.ref} 缺少 si，无法作为继承源`);
    }
    if (masters.has(decl.si)) {
      throw new ValidationError(`共享公式 si=${decl.si} 有多个主格，无法确定继承哪一条`);
    }
    masters.set(decl.si, { text: decl.text, ref: decl.ref, range: decl.range });
  }

  const resolved: ResolvedWorksheetFormula[] = [];
  const seen = new Set<string>();
  const push = (ref: string, text: string, origin: ResolvedWorksheetFormula['origin']): void => {
    const key = formatCellAddress(parseCellReference(ref));
    if (seen.has(key)) {
      throw new ValidationError(`还原后单元格 ${key} 出现多条公式：范围重叠，无法确定哪条为准`);
    }
    seen.add(key);
    resolved.push(Object.freeze({ ref: key, text, origin }));
  };

  for (const decl of decls) {
    const where = `共享公式从属格 ${decl.ref}`;
    switch (decl.type) {
      case 'normal': {
        if (decl.text === null) {
          throw new ValidationError(`${decl.ref} 的 normal 公式缺少文本`);
        }
        push(decl.ref, decl.text, 'normal');
        break;
      }
      case 'shared': {
        if (decl.text !== null) {
          push(decl.ref, decl.text, 'shared-master');
          break;
        }
        if (decl.si === null) {
          throw new ValidationError(`${decl.ref} 是无文本的共享公式，但缺少 si`);
        }
        const master = masters.get(decl.si);
        if (master === undefined) {
          throw new ValidationError(
            `${where}：找不到 si=${decl.si} 的主格公式，无法确定继承哪条`,
          );
        }
        const target = parseCellReference(decl.ref);
        const anchor = parseCellReference(master.ref);
        if (master.range !== null) {
          const bounds = parseRange(master.range);
          const minColumn = Math.min(bounds.start.column, bounds.end.column);
          const maxColumn = Math.max(bounds.start.column, bounds.end.column);
          const minRow = Math.min(bounds.start.row, bounds.end.row);
          const maxRow = Math.max(bounds.start.row, bounds.end.row);
          if (
            target.column < minColumn ||
            target.column > maxColumn ||
            target.row < minRow ||
            target.row > maxRow
          ) {
            throw new ValidationError(
              `${where} 落在主格 si=${decl.si} 的范围 ${JSON.stringify(master.range)} 之外，无法确定偏移`,
            );
          }
        }
        const shifted = shiftFormulaText(
          master.text,
          target.row - anchor.row,
          target.column - anchor.column,
          where,
        );
        push(decl.ref, shifted, 'shared-dependent');
        break;
      }
      case 'array': {
        if (decl.text === null) {
          throw new ValidationError(`${decl.ref} 的数组公式缺少文本`);
        }
        const extent = decl.range ?? decl.ref;
        for (const cellRef of cellsInRange(extent, `数组公式 ${decl.ref}`)) {
          push(cellRef, decl.text, 'array');
        }
        break;
      }
      /* c8 ignore next 2 */
      default:
        break;
    }
  }
  return Object.freeze(resolved);
}

// ---------------------------------------------------------------------------
// 工作表 XML → 声明
// ---------------------------------------------------------------------------

/** 从一个 `<worksheet>` 根（或工作表 XML 文本）解析 `<sheetData>` 里每格的 `<f>` 声明。 */
export function parseWorksheetFormulaDecls(worksheetXml: string): readonly WorksheetFormulaDecl[] {
  if (typeof worksheetXml !== 'string' || worksheetXml.length === 0) {
    throw new ValidationError('parseWorksheetFormulaDecls 需要非空的工作表 XML 文本');
  }
  const root = parseXml(worksheetXml);
  const sheetData = locateSheetData(root);
  if (sheetData === null) return Object.freeze([]);

  const decls: WorksheetFormulaDecl[] = [];
  let fallbackRow = 0;
  for (const row of childElements(sheetData)) {
    if (row.localName !== 'row') continue;
    const rowAttr = attributeValue(row, '', 'r');
    const parsedRow = rowAttr === null ? fallbackRow + 1 : Number.parseInt(rowAttr, 10);
    const rowNumber = Number.isSafeInteger(parsedRow) && parsedRow > 0 ? parsedRow : fallbackRow + 1;
    fallbackRow = rowNumber;
    let fallbackColumn = 0;
    for (const cell of childElements(row)) {
      if (cell.localName !== 'c') continue;
      const declared = attributeValue(cell, '', 'r');
      const column = declared === null ? fallbackColumn + 1 : columnNumberOf(declared);
      fallbackColumn = column;
      const ref = declared ?? formatCellAddress({ column, row: rowNumber });
      const formula = findFormula(cell);
      if (formula === null) continue;
      const text = directText(formula);
      const rawType = attributeValue(formula, '', 't');
      const si = attributeValue(formula, '', 'si');
      const range = attributeValue(formula, '', 'ref');
      let type: WorksheetFormulaDecl['type'];
      if (rawType === 'shared') {
        type = 'shared';
      } else if (rawType === 'array') {
        type = 'array';
      } else {
        type = 'normal';
      }
      if (text.length === 0) {
        // 无文本只允许共享公式从属格（其余是坏数据，不能静默当空白）。
        if (type === 'shared' && si !== null) {
          decls.push(Object.freeze({ ref, type, text: null, si, range }));
          continue;
        }
        throw new ValidationError(`工作表 ${ref} 有一个无文本的 <f>：既不是共享公式从属格，也无公式可读`);
      }
      decls.push(Object.freeze({ ref, type, text, si, range }));
    }
  }
  return Object.freeze(decls);
}

/** 便捷桥：工作表 XML → 每格公式的 {@link PlanCell}（只含公式格，供计划层叠加）。 */
export function worksheetFormulaPlanCells(worksheetXml: string): readonly PlanCell[] {
  const resolved = resolveWorksheetFormulas(parseWorksheetFormulaDecls(worksheetXml));
  return Object.freeze(
    resolved.map((cell) => Object.freeze({ ref: cell.ref, formula: cell.text })),
  );
}

function locateSheetData(root: ParsedXmlElement): ParsedXmlElement | null {
  if (root.localName === 'sheetData') return root;
  for (const child of childElements(root)) {
    if (child.localName === 'sheetData' && child.namespace === SPREADSHEETML_NAMESPACE) {
      return child;
    }
  }
  for (const child of childElements(root)) {
    if (child.localName === 'sheetData') return child;
  }
  return null;
}

function findFormula(cell: ParsedXmlElement): ParsedXmlElement | null {
  for (const child of childElements(cell)) {
    if (child.localName === 'f') return child;
  }
  return null;
}

/** 从 A1 地址取列号的宽容版本（越界 / 非法时回落到 1，仅用于读取定位）。 */
function columnNumberOf(ref: string): number {
  const match = /^[A-Za-z]{1,3}/.exec(ref);
  if (match === null) return 1;
  try {
    return columnLettersToNumber(match[0]);
  } catch {
    return 1;
  }
}
