/**
 * 表格域：公式文本与引用迁移（design-06-P8 / XLS-06、XLS-08；合同 R250）。
 *
 * ## 本模块存在的理由：**宁阻塞，不伪造**
 *
 * XLS-08 的原文是「不支持的公式保留或阻塞，**不能返回伪造结果**」。公式是一段**文本**，
 * 对它做引用迁移本质上是一次**源代码改写**——而朴素正则改写公式是危险的：
 *
 * - `LOG10(100)` 里的 `LOG10` 完全符合"列 `LOG` + 行 `10`"的形状（`LOG` = 第 8509 列，
 *   在 Excel 上限 16384 之内），朴素实现会把它当成单元格引用**改坏**；
 * - `"A1"` 是字符串字面量，里面的 `A1` 不是引用。
 *
 * 因此本模块的做法是：**只在能证明安全时才改写，否则整体阻塞并说明原因**。
 * 阻塞是合法结局（XLS-08 明说"保留或阻塞"），伪造不是。
 *
 * ## 安全改写的判定
 *
 * 一个候选 token 可被改写，当且仅当：
 * 1. 整个公式**不含双引号**（一旦有字符串字面量，逐字符扫描不足以证明 token 不在字面量内）；
 * 2. 候选前面**不紧邻**标识符字符（`[A-Za-z0-9_.]`）——否则它是更长名字的一部分；
 * 3. 候选后面**不紧邻** `(` 或标识符字符——否则它是函数名（如 `LOG10(`）或更长名字；
 * 4. 候选本身能被 {@link parseCellReference} 解析成合法引用。
 *
 * 任一条不满足 ⇒ `ok: false`。**不猜测、不部分改写**。
 */

import { ValidationError } from '../protocol/index.js';
import {
  formatCellReference,
  mapReferenceOnColumnDelete,
  mapReferenceOnColumnInsert,
  mapReferenceOnRowDelete,
  mapReferenceOnRowInsert,
  parseCellReference,
  type CellReference,
  type ReferenceMapResult,
} from './reference.js';

/** 公式迁移被阻塞的原因（封闭枚举）。 */
export type FormulaBlockReason =
  /** 公式含双引号字符串字面量，无法安全区分引用与字面量内容。 */
  | 'string_literal'
  /** 候选 token 与相邻字符构成更长标识符或函数调用，改它会改坏公式。 */
  | 'ambiguous_token'
  /** 候选引用指向被本次删除命中的位置（迁移后应为 `#REF!`，本模块不替调用方伪造）。 */
  | 'reference_deleted';

/** 公式迁移结果：要么给出新公式文本，要么给出**阻塞原因与证据**。 */
export type FormulaMapResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: FormulaBlockReason; readonly detail: string };

type ScannedReference = { readonly token: string; readonly start: number; readonly end: number };

type ScanResult =
  | { readonly ok: true; readonly references: readonly ScannedReference[] }
  | { readonly ok: false; readonly reason: FormulaBlockReason; readonly detail: string };

const REFERENCE_TOKEN_PATTERN = /\$?[A-Za-z]{1,3}\$?\d{1,7}/g;

/**
 * 扫描公式文本里的引用候选。**只做保守判定**：拿不准就阻塞。
 */
function scanReferenceTokens(text: string): ScanResult {
  if (typeof text !== 'string' || text.length === 0) {
    throw new ValidationError('公式文本必须是非空字符串');
  }
  if (text.includes('"')) {
    return {
      ok: false,
      reason: 'string_literal',
      detail: '公式含双引号字符串字面量，无法安全区分引用与字面量内容，整体阻塞',
    };
  }
  const references: ScannedReference[] = [];
  const pattern = new RegExp(REFERENCE_TOKEN_PATTERN.source, 'g');
  let match = pattern.exec(text);
  while (match !== null) {
    const token = match[0];
    const start = match.index;
    const end = start + token.length;
    const before = start > 0 ? text.charAt(start - 1) : '';
    const after = end < text.length ? text.charAt(end) : '';
    if (before !== '' && /[A-Za-z0-9_.]/.test(before)) {
      return {
        ok: false,
        reason: 'ambiguous_token',
        detail: `候选 ${token} 紧跟在标识符字符 ${JSON.stringify(before)} 之后，可能是更长名字的一部分`,
      };
    }
    if (after !== '' && /[A-Za-z0-9_(]/.test(after)) {
      return {
        ok: false,
        reason: 'ambiguous_token',
        detail: `候选 ${token} 紧跟 ${JSON.stringify(after)}，可能是函数名或更长名字的一部分`,
      };
    }
    try {
      parseCellReference(token);
    } catch {
      return {
        ok: false,
        reason: 'ambiguous_token',
        detail: `候选 ${token} 不是合法单元格引用（可能超出 Excel 行列上限）`,
      };
    }
    references.push({ token, start, end });
    match = pattern.exec(text);
  }
  return { ok: true, references };
}

function applyMapper(
  text: string,
  map: (reference: CellReference) => ReferenceMapResult,
  axis: 'row' | 'column',
): FormulaMapResult {
  const scanned = scanReferenceTokens(text);
  if (!scanned.ok) {
    return { ok: false, reason: scanned.reason, detail: scanned.detail };
  }
  let output = '';
  let last = 0;
  for (const found of scanned.references) {
    const mapped = map(parseCellReference(found.token));
    if (!mapped.ok) {
      return {
        ok: false,
        reason: 'reference_deleted',
        detail: `引用 ${found.token} 指向本次删除命中的${axis === 'row' ? '行' : '列'}，按 XLS-08 保留原公式并阻塞，不伪造新引用`,
      };
    }
    output += text.slice(last, found.start) + formatCellReference(mapped.reference);
    last = found.end;
  }
  output += text.slice(last);
  return { ok: true, text: output };
}

function assertMutation(at: number, count: number, where: string): void {
  if (!Number.isInteger(at) || at < 1) {
    throw new ValidationError(`${where} 的 at 必须是 ≥1 的整数，收到 ${String(at)}`);
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new ValidationError(`${where} 的 count 必须是 ≥1 的整数，收到 ${String(count)}`);
  }
}

/** 在第 `at` 行前插入 / 从第 `at` 行删除 `count` 行后，迁移公式里的行引用。 */
export function mapFormulaRows(
  text: string,
  at: number,
  count: number,
  mode: 'insert' | 'delete',
): FormulaMapResult {
  assertMutation(at, count, 'mapFormulaRows');
  return applyMapper(
    text,
    mode === 'insert'
      ? (reference) => mapReferenceOnRowInsert(reference, at, count)
      : (reference) => mapReferenceOnRowDelete(reference, at, count),
    'row',
  );
}

/** 在第 `at` 列前插入 / 从第 `at` 列删除 `count` 列后，迁移公式里的列引用。 */
export function mapFormulaColumns(
  text: string,
  at: number,
  count: number,
  mode: 'insert' | 'delete',
): FormulaMapResult {
  assertMutation(at, count, 'mapFormulaColumns');
  return applyMapper(
    text,
    mode === 'insert'
      ? (reference) => mapReferenceOnColumnInsert(reference, at, count)
      : (reference) => mapReferenceOnColumnDelete(reference, at, count),
    'column',
  );
}

/**
 * 抽取公式里的全部引用。**无法安全解析 ⇒ 返回 `null`**（不是空数组——空数组意为"确实没有引用"，
 * 与"读不懂"是两件事；把后者写成前者会让调用方以为公式里没有引用）。
 */
export function extractFormulaReferences(text: string): readonly CellReference[] | null {
  const scanned = scanReferenceTokens(text);
  if (!scanned.ok) {
    return null;
  }
  return Object.freeze(scanned.references.map((found) => parseCellReference(found.token)));
}
